import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildCronBlock, mergeCronBlock, stripCronBlock, CRON_BLOCK_START, CRON_BLOCK_END, isZombie,
} from './service';
import * as os from 'os';
import { claimObserverLock, releaseObserverLock } from './service';

const EP = { command: '/root/.provian/node/bin/node', args: ['/root/.provian/agent.js', 'observe'] };

describe('cron supervision (D) — a box with no systemctl --user', () => {
  it('@reboot + every-minute tick, both idempotent via --if-not-running, logged to observer.log', () => {
    const block = buildCronBlock(EP, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' }, '/root');
    const lines = block.split('\n');
    expect(lines[0]).toBe(CRON_BLOCK_START);
    expect(lines[lines.length - 1]).toBe(CRON_BLOCK_END);
    expect(lines[1].startsWith('@reboot ')).toBe(true);
    expect(lines[2].startsWith('* * * * * ')).toBe(true);
    for (const l of lines.slice(1, 3)) {
      expect(l).toContain("'/root/.provian/agent.js' 'observe' '--if-not-running'");
      expect(l).toContain(">> '/root/.provian/observer.log' 2>&1");
      expect(l).toContain("OTEL_EXPORTER_OTLP_ENDPOINT='http://localhost:4318'");
    }
  });

  it('quotes a path with a quote or space so cron\'s /bin/sh cannot split or inject', () => {
    const block = buildCronBlock({ command: "/home/o'brien/node", args: ['/home/a b/agent.js', 'observe'] }, {}, '/home/a b');
    expect(block).toContain(`'/home/o'\\''brien/node'`);
    expect(block).toContain("'/home/a b/agent.js'");
  });

  it('merging keeps the user\'s own entries and replaces (never duplicates) the Provian block', () => {
    const user = '0 3 * * * /usr/local/bin/backup\n';
    const once = mergeCronBlock(user, buildCronBlock(EP, {}, '/root'));
    const twice = mergeCronBlock(once, buildCronBlock(EP, {}, '/root'));
    expect(twice).toBe(once);
    expect(twice.startsWith('0 3 * * * /usr/local/bin/backup\n')).toBe(true);
    expect(twice.split(CRON_BLOCK_START).length - 1).toBe(1);
    expect(stripCronBlock(twice)).toBe('0 3 * * * /usr/local/bin/backup');
  });

  it('the systemd unit restarts on exit(0) (self-update relaunch), not only on failure', () => {
    const src = fs.readFileSync(path.join(__dirname, 'service.ts'), 'utf8');
    expect(src).toMatch(/^Restart=always$/m);
    expect(src).not.toMatch(/^Restart=on-failure$/m);
  });
});

describe('one daemon per machine, atomically', () => {
  const dirs: string[] = [];
  const lockIn = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-lock-')); dirs.push(d); return path.join(d, 'observer.lock'); };
  it('the first claimant holds it; a second concurrent claimant sees the live holder (the @reboot + tick race)', () => {
    const lockDir = lockIn();
    expect(claimObserverLock({ pid: 100, ppid: 1, env: {}, lockDir, alive: () => true })).toEqual({ held: true });
    expect(claimObserverLock({ pid: 200, ppid: 1, env: {}, lockDir, alive: () => true })).toEqual({ held: false, holder: 100 });
  });
  it('the loser\'s cleanup cannot delete the winner\'s claim', () => {
    const lockDir = lockIn();
    claimObserverLock({ pid: 100, ppid: 1, env: {}, lockDir, alive: () => true });
    releaseObserverLock(200, lockDir);
    expect(claimObserverLock({ pid: 300, ppid: 1, env: {}, lockDir, alive: () => true })).toEqual({ held: false, holder: 100 });
  });
  it('a dead (or zombie) holder is replaced; the owner can release', () => {
    const lockDir = lockIn();
    claimObserverLock({ pid: 100, ppid: 1, env: {}, lockDir, alive: () => true });
    expect(claimObserverLock({ pid: 200, ppid: 1, env: {}, lockDir, alive: () => false })).toEqual({ held: true });
    releaseObserverLock(200, lockDir);
    expect(fs.existsSync(lockDir)).toBe(false);
  });
  it('a re-exec\'d child takes over from its waiting parent; without the guard it does not', () => {
    const lockDir = lockIn();
    claimObserverLock({ pid: 99, ppid: 1, env: {}, lockDir, alive: () => true });
    expect(claimObserverLock({ pid: 100, ppid: 99, env: {}, lockDir, alive: () => true })).toEqual({ held: false, holder: 99 });
    expect(claimObserverLock({ pid: 100, ppid: 99, env: { PROVIAN_RUNTIME_ENV_REEXEC: '1' }, lockDir, alive: () => true })).toEqual({ held: true });
  });
  it('2 race: A reclaims a STALE lock while B is judging it → B must NOT also hold it', () => {
    const lockDir = lockIn();
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), '4000'); // left by the previous boot (dead)
    let aResult: unknown = null;
    let firstProbe = true;
    const aliveForB = (p: number): boolean => {
      if (firstProbe && p === 4000) {
        firstProbe = false;
        // A runs its whole claim inside B's liveness probe of the stale holder.
        aResult = claimObserverLock({ pid: 100, ppid: 1, env: {}, lockDir, alive: (x) => x === 100 });
        return false;
      }
      return p === 100;
    };
    const b = claimObserverLock({ pid: 200, ppid: 1, env: {}, lockDir, alive: aliveForB });
    expect(aResult).toEqual({ held: true });
    expect(b.held).toBe(false);
    expect(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')).toBe('100');
  });

  it('a lock dir with no pid yet is a claim in progress (not stale) until the grace passes', () => {
    const lockDir = lockIn();
    fs.mkdirSync(lockDir);
    expect(claimObserverLock({ pid: 5, ppid: 1, env: {}, lockDir, alive: () => true })).toEqual({ held: false, holder: null });
    expect(claimObserverLock({ pid: 5, ppid: 1, env: {}, lockDir, alive: () => true, nowMs: () => Date.now() + 60_000 })).toEqual({ held: true });
  });
});

describe('cron quoting — crontab turns a bare % into a newline', () => {
  it('every % is escaped for cron', () => {
    const block = buildCronBlock({ command: '/home/a%b/node', args: ['/home/a%b/.provian/agent.js', 'observe'] }, {}, '/home/a%b');
    for (const line of block.split('\n').slice(1, 3)) expect(line).not.toMatch(/(^|[^\\])%/);
    expect(block).toContain('/home/a\\%b/node');
  });
});

describe('install persists the LIVE env, never a stale file value', () => {
  it('bootstrap.ts calls persistRuntimeEnv before applyRuntimeEnvAtEntry', () => {
    const src = fs.readFileSync(path.join(__dirname, '../scripts/bootstrap.ts'), 'utf8');
    const persist = src.indexOf('persistRuntimeEnv(process.env)');
    const apply = src.indexOf('applyRuntimeEnvAtEntry();');
    expect(persist).toBeGreaterThan(0);
    expect(persist).toBeLessThan(apply);
  });

  // onboard writes only after the code check, so it keeps the same rule by never reading the
  // file on an install. scripts/onboard.clean-home.test.ts proves that on a real process.
  it('onboard.ts applies its own shell in place of the file', () => {
    const src = fs.readFileSync(path.join(__dirname, '../scripts/onboard.ts'), 'utf8');
    expect(src).toContain('{ recorded: computeRuntimeEnv(process.env) }');
  });
});

describe('zombie daemon — kill(pid,0) succeeds on a zombie; it is not running', () => {
  it('state Z / X → zombie; S / R → alive; a comm with spaces and parens parses', () => {
    expect(isZombie(5, () => '5 (node) Z 1 5 5 0 -1')).toBe(true);
    expect(isZombie(5, () => '5 (node) X 1 5 5 0 -1')).toBe(true);
    expect(isZombie(5, () => '5 (node) S 1 5 5 0 -1')).toBe(false);
    expect(isZombie(5, () => '5 (my (odd) name) Z 1')).toBe(true);
  });
  it('RED control: no /proc (macOS, Windows) → never treated as a zombie', () => {
    expect(isZombie(5, () => { throw new Error('ENOENT'); })).toBe(false);
  });
});

describe('self-update handoff (F) — who relaunches the daemon after exit(0)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  it(' follow-up: with execve the new bytes run IN PLACE — same pid, no spawn, no exit, whoever supervises', async () => {
    const { selfUpdateReExec } = await import('./run-daemon.js');
    for (const env of [{}, { PROVIAN_SUPERVISOR: 'detached' }, { PROVIAN_SUPERVISOR: 'cron' }, { XPC_SERVICE_NAME: 'ai.provian.observer' }] as NodeJS.ProcessEnv[]) {
      const calls: Array<{ file: string; args: string[] }> = [];
      const spawned: unknown[] = [];
      const reExec = selfUpdateReExec(env, {
        execve: ((file: string, args: string[]) => { calls.push({ file, args }); throw new Error('replaced'); }) as never,
        spawnDetached: () => { spawned.push(1); },
        exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
        argv: ['/node', '/home/box/.provian/agent.js', 'observe'], execArgv: ['--no-warnings'], execPath: '/node', log: () => {}, executable: () => true,
      });
      // The injected execve "fails" after recording, so the fallback path runs too — assert the attempt.
      try { reExec(); } catch { /* fallback exit */ }
      expect(calls).toEqual([{ file: '/node', args: ['/node', '--no-warnings', '/home/box/.provian/agent.js', 'observe'] }]);
    }
    // A working execve never returns: nothing after it runs.
    const spawned: unknown[] = [];
    const reExec = selfUpdateReExec({}, {
      execve: (() => { throw Object.assign(new Error('image replaced'), { replaced: true }); }) as never,
      spawnDetached: () => { spawned.push(1); },
      exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
      argv: ['/node', '/a.js', 'observe'], execPath: '/node', pid: 7, log: () => {}, executable: () => true,
    });
    expect(() => reExec()).toThrow('exit 0');
    expect(spawned).toHaveLength(1); // an execve that throws falls back to a successor, never to "stopped"
  });
  it('no execve, no proven relauncher (the Grok bot: started by an agent shell, marker unset) — it starts its own successor', async () => {
    const { selfUpdateReExec, WAIT_FOR_PID_ENV } = await import('./run-daemon.js');
    for (const env of [{}, { PROVIAN_SUPERVISOR: 'detached' }] as NodeJS.ProcessEnv[]) {
      const spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
      const reExec = selfUpdateReExec(env, {
        execve: null,
        spawnDetached: (command, args, e) => { spawned.push({ command, args, env: e }); },
        exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
        argv: ['/node', '/root/.provian/agent.js', 'observe'], execPath: '/node', pid: 4242, log: () => {}, executable: () => true,
      });
      expect(() => reExec()).toThrow('exit 0');
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args).toEqual(['/root/.provian/agent.js', 'observe', '--if-not-running']);
      expect(spawned[0].env[WAIT_FOR_PID_ENV]).toBe('4242');
      expect(spawned[0].env.PROVIAN_SUPERVISOR).toBe('detached');
    }
  });
  it('RED (Grok bot down 11 days): on a no-supervisor box the successor is queued BEFORE execve, so an aborted execve syscall cannot orphan the daemon', async () => {
    const { selfUpdateReExec, WAIT_FOR_PID_ENV } = await import('./run-daemon.js');
    for (const env of [{}, { PROVIAN_SUPERVISOR: 'detached' }] as NodeJS.ProcessEnv[]) {
      const order: string[] = [];
      const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
      const reExec = selfUpdateReExec(env, {
        // A REAL execve syscall abort kills the process with no JS throw; we can only model the
        // ordering. The point: `spawn` must come FIRST, so even if execve never returns the
        // successor is already on its way. (The injected execve throws so the test can continue.)
        execve: (() => { order.push('execve'); throw Object.assign(new Error('image replaced'), { replaced: true }); }) as never,
        spawnDetached: (_command, args, e) => { order.push('spawn'); spawned.push({ args, env: e }); },
        exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
        argv: ['/node', '/home/box/.provian/agent.js', 'observe'], execPath: '/node', pid: 99, log: () => {}, executable: () => true,
      });
      try { reExec(); } catch { /* execve 'replaced' / exit 0 */ }
      expect(order[0]).toBe('spawn');                 // BEFORE execve — the whole fix
      expect(order).toContain('execve');              // execve still attempted (in-place is the happy path)
      expect(spawned).toHaveLength(1);                // exactly one — no double on the JS-throw fallthrough
      expect(spawned[0].args).toEqual(['/home/box/.provian/agent.js', 'observe', '--if-not-running']);
      expect(spawned[0].env[WAIT_FOR_PID_ENV]).toBe('99');
    }
  });
  it('no execve under a PROVEN relauncher (cron / launchd / systemd) it only exits — the supervisor relaunches (no second daemon)', async () => {
    const { selfUpdateReExec, provenRelauncher } = await import('./run-daemon.js');
    const cases: Array<[NodeJS.ProcessEnv, string]> = [
      [{ PROVIAN_SUPERVISOR: 'cron' }, 'cron'],
      [{ XPC_SERVICE_NAME: 'ai.provian.observer' }, 'launchd'],
      [{ INVOCATION_ID: 'a1b2c3' }, 'systemd'],
    ];
    const ourUnit = () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/provian-observer.service\n';
    for (const [env, who] of cases) {
      expect(provenRelauncher(env, ourUnit)).toBe(who);
      const spawned: unknown[] = [];
      const reExec = selfUpdateReExec(env, {
        execve: null,
        spawnDetached: () => { spawned.push(1); },
        exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
        log: () => {}, executable: () => true,
      });
      if (who === 'systemd') continue; // the cgroup reader is the real one inside selfUpdateReExec
      expect(() => reExec()).toThrow('exit 0');
      expect(spawned).toHaveLength(0);
    }
    // Review r1 #3 RED control: INVOCATION_ID inherited from SOMEONE ELSE's unit (an agent harness
    // running as a service started us from its shell) is not our relauncher.
    expect(provenRelauncher({ INVOCATION_ID: 'a1b2c3' }, () => '0::/system.slice/grok-harness.service\n')).toBeNull();
    expect(provenRelauncher({ INVOCATION_ID: 'a1b2c3' }, () => '')).toBeNull();
    // RED control: an unset marker is NOT a proven relauncher (the old code assumed one and left the observer stopped).
    expect(provenRelauncher({})).toBeNull();
    expect(provenRelauncher({ XPC_SERVICE_NAME: 'com.apple.Terminal' })).toBeNull();
  });
  it('review r1 #2: a failed execve SYSCALL aborts node, so the binary is checked first — a vanished execPath hands over to the private runtime, never to an abort', async () => {
    const { selfUpdateReExec, handoverNode } = await import('./run-daemon.js');
    const exists = new Set(['/home/box/.provian/node/bin/node', '/home/box/.provian/agent.js']);
    expect(handoverNode('/opt/homebrew/Cellar/node/26.0.0/bin/node', { executable: (p) => exists.has(p), home: '/home/box', pathEnv: '' })).toBe('/home/box/.provian/node/bin/node');
    // Review r2 #3: no private runtime (an npm/Mac install) — the upgraded node on PATH takes over.
    expect(handoverNode('/opt/homebrew/Cellar/node/26.0.0/bin/node', {
      executable: (p) => p === '/opt/homebrew/bin/node', home: '/Users/x', pathEnv: '/usr/bin:/opt/homebrew/bin',
    })).toBe('/opt/homebrew/bin/node');
    // RED control: nothing anywhere → null (the caller exits so the next start runs the bytes).
    expect(handoverNode('/gone/node', { executable: () => false, home: '/Users/x', pathEnv: '/usr/bin' })).toBeNull();
    const calls: string[] = [];
    const reExec = selfUpdateReExec({}, {
      execve: ((file: string) => { calls.push(file); throw new Error('replaced'); }) as never,
      spawnDetached: () => {}, exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
      argv: ['/opt/homebrew/Cellar/node/26.0.0/bin/node', '/home/box/.provian/agent.js', 'observe'],
      execPath: '/opt/homebrew/Cellar/node/26.0.0/bin/node', log: () => {}, executable: (p) => exists.has(p) || p === `${require('os').homedir()}/.provian/node/bin/node`,
    });
    try { reExec(); } catch { /* fallback */ }
    expect(calls[0]).not.toBe('/opt/homebrew/Cellar/node/26.0.0/bin/node'); // RED: the old code exec'd the missing path
    // No node at all: nothing is exec'd or spawned onto a missing binary; exit so the next start runs it.
    const spawned: unknown[] = [];
    const none = selfUpdateReExec({}, {
      execve: (() => { throw new Error('must not be called'); }) as never,
      spawnDetached: () => { spawned.push(1); }, exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
      argv: ['/gone/node', '/a.js', 'observe'], execPath: '/gone/node', log: () => {}, executable: () => false,
    });
    expect(() => none()).toThrow('exit 0');
    expect(spawned).toHaveLength(0);
  });
  it('the successor waits until the predecessor is gone (bounded)', async () => {
    const { waitForPidExit } = await import('./run-daemon.js');
    let calls = 0;
    const t0 = Date.now();
    await waitForPidExit(1, 5_000, () => ++calls < 3);
    expect(calls).toBe(3);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('self-update successor never runs beside its predecessor (follow-up: two daemons on the Grok bot, 89 → 90)', () => {
  const lockIn2 = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provian-lock-')), 'observer.lock');
  it('the successor\'s environment carries no re-exec marker (RED: the predecessor\'s did)', async () => {
    const { selfUpdateReExec, successorEnv, WAIT_FOR_PID_ENV } = await import('./run-daemon.js');
    const predecessor: NodeJS.ProcessEnv = { PROVIAN_RUNTIME_ENV_REEXEC: '1', PROVIAN_NODE_SELFHEAL_REEXEC: '1', HTTPS_PROXY: 'http://p:1', KEEP: 'x' };
    const spawned: NodeJS.ProcessEnv[] = [];
    const reExec = selfUpdateReExec(predecessor, {
      execve: null, spawnDetached: (_c, _a, e) => { spawned.push(e); },
      exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
      argv: ['/node', '/home/box/.provian/agent.js', 'observe'], execPath: '/node', pid: 412985, log: () => {}, executable: () => true,
    });
    expect(() => reExec()).toThrow('exit 0');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].PROVIAN_RUNTIME_ENV_REEXEC).toBeUndefined();
    expect(spawned[0].PROVIAN_NODE_SELFHEAL_REEXEC).toBeUndefined();
    expect(spawned[0].HTTPS_PROXY).toBe('http://p:1');
    expect(spawned[0][WAIT_FOR_PID_ENV]).toBe('412985');
    expect(predecessor.PROVIAN_RUNTIME_ENV_REEXEC).toBe('1');                        // the predecessor's own env is untouched
    expect(successorEnv({ KEEP: 'x' }, 1).KEEP).toBe('x');
  });
  it('a successor never takes the lock from its live parent, marker or not (RED: a re-exec handing over to its child does)', () => {
    for (const env of [{ PROVIAN_RUNTIME_ENV_REEXEC: '1' }, { PROVIAN_NODE_SELFHEAL_REEXEC: '1' }, {}] as NodeJS.ProcessEnv[]) {
      const lockDir = lockIn2();
      expect(claimObserverLock({ pid: 412985, ppid: 53, env: {}, lockDir, alive: () => true })).toEqual({ held: true });
      expect(claimObserverLock({ pid: 413090, ppid: 412985, env, parentHandover: false, lockDir, alive: () => true })).toEqual({ held: false, holder: 412985 });
    }
    const lockDir = lockIn2();
    claimObserverLock({ pid: 412985, ppid: 53, env: {}, lockDir, alive: () => true });
    expect(claimObserverLock({ pid: 413090, ppid: 412985, env: { PROVIAN_RUNTIME_ENV_REEXEC: '1' }, lockDir, alive: () => true })).toEqual({ held: true });
  });
  it('the daemon\'s own claim passes the successor flag through (RED: a non-successor re-exec may hand over)', async () => {
    const { claimDaemonLock } = await import('./run-daemon.js');
    const seen: Array<boolean | undefined> = [];
    const claim = ((o: { parentHandover?: boolean }) => { seen.push(o.parentHandover); return { held: true } as const; }) as never;
    claimDaemonLock(true, { claim, env: {} });
    claimDaemonLock(false, { claim, env: {} });
    expect(seen).toEqual([false, true]);
  });
  it('the daemon\'s start wires both: a successor waits, stands down if its predecessor runs, else claims as a successor (RED: a plain start claims as a non-successor without waiting)', async () => {
    const { claimMachineAtStart, WAIT_FOR_PID_ENV } = await import('./run-daemon.js');
    const calls: string[] = [];
    const claim = ((successor: boolean) => { calls.push(`claim:${successor}`); return { held: true } as const; }) as never;
    const env1: NodeJS.ProcessEnv = { [WAIT_FOR_PID_ENV]: '412985' };
    expect(await claimMachineAtStart({ env: env1, awaitPredecessor: async (p) => { calls.push(`wait:${p}`); return 'stand_down'; }, claim })).toBe('stand_down');
    expect(env1[WAIT_FOR_PID_ENV]).toBeUndefined();
    expect(calls).toEqual(['wait:412985']);
    calls.length = 0;
    expect(await claimMachineAtStart({ env: { [WAIT_FOR_PID_ENV]: '412985' }, awaitPredecessor: async () => 'proceed', claim })).toEqual({ held: true });
    expect(calls).toEqual(['claim:true']);
    calls.length = 0;
    expect(await claimMachineAtStart({ env: {}, awaitPredecessor: async () => { calls.push('wait'); return 'stand_down'; }, claim })).toEqual({ held: true });
    expect(calls).toEqual(['claim:false']);
  });
  it('the default predecessor check: a live observer process stands the successor down; a gone one does not (RED: a live process that is not an observer)', async () => {
    const { awaitPredecessor } = await import('./run-daemon.js');
    const { spawn } = await import('child_process');
    const observer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'observe'], { stdio: 'ignore' });
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const noWait = async (): Promise<void> => {};
      expect(await awaitPredecessor(observer.pid!, { wait: noWait })).toBe('stand_down');
      expect(await awaitPredecessor(other.pid!, { wait: noWait })).toBe('proceed');
      observer.kill('SIGKILL');
      await new Promise((r) => observer.once('exit', r));
      expect(await awaitPredecessor(observer.pid!, { wait: noWait })).toBe('proceed');
    } finally { observer.kill('SIGKILL'); other.kill('SIGKILL'); }
  });
  it('a successor whose predecessor still runs (it ran the new bytes in place) stands down; one whose predecessor is gone starts', async () => {
    const { awaitPredecessor } = await import('./run-daemon.js');
    let waited = 0;
    const wait = async (): Promise<void> => { waited += 1; };
    expect(await awaitPredecessor(412985, { wait, alive: () => true })).toBe('stand_down');
    expect(await awaitPredecessor(412985, { wait, alive: () => false })).toBe('proceed');
    expect(waited).toBe(2);
  });
});

describe('a running daemon stands down when the machine lock names another live observer (an older release\'s pair converges)', () => {
  it('another live holder → stand down; itself, none, or a dead holder → keep (RED)', async () => {
    const { lockStandDownCheck } = await import('./run-daemon.js');
    expect(lockStandDownCheck({ pid: 412985, holder: () => 413090, alive: () => true })).toBe('stand_down');
    expect(lockStandDownCheck({ pid: 413090, holder: () => 413090, alive: () => true })).toBe('keep');
    expect(lockStandDownCheck({ pid: 412985, holder: () => null, alive: () => true })).toBe('keep');
    expect(lockStandDownCheck({ pid: 412985, holder: () => 413090, alive: () => false })).toBe('keep');
  });
  it('reads the real lock and the real liveness by default (RED: a lock naming a live non-observer is no reason to stand down)', async () => {
    const { lockStandDownCheck } = await import('./run-daemon.js');
    const { observerLockHolder } = await import('./service.js');
    const { spawn } = await import('child_process');
    const lockDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'provian-lock-')), 'observer.lock');
    const observer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'observe'], { stdio: 'ignore' });
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      claimObserverLock({ pid: observer.pid!, ppid: 1, env: {}, lockDir, alive: () => true });
      expect(lockStandDownCheck({ pid: process.pid, holder: () => observerLockHolder(lockDir) })).toBe('stand_down');
      fs.writeFileSync(path.join(lockDir, 'pid'), String(other.pid));
      expect(lockStandDownCheck({ pid: process.pid, holder: () => observerLockHolder(lockDir) })).toBe('keep');
    } finally { observer.kill('SIGKILL'); other.kill('SIGKILL'); }
  });
  it('the guard checks every minute and stands down once (RED: while it keeps, nothing happens)', async () => {
    const { startLockGuard, LOCK_RECHECK_MS } = await import('./run-daemon.js');
    let tick: (() => void) | null = null; let period = 0; let stopped = 0; let stoodDown = 0;
    let verdict: 'keep' | 'stand_down' = 'keep';
    startLockGuard(() => { stoodDown += 1; }, {
      check: () => verdict, every: (fn, ms) => { tick = fn; period = ms; return {}; }, stop: () => { stopped += 1; },
      holdsLock: () => false,
    });
    expect(period).toBe(LOCK_RECHECK_MS);
    tick!(); tick!();
    expect(stoodDown).toBe(0);
    verdict = 'stand_down';
    tick!();
    expect(stoodDown).toBe(1);
    expect(stopped).toBe(1);
  });
});

describe('the daemon starts the lock guard (wiring)', () => {
  it('runDaemon arms startLockGuard right after its signal handlers, standing down through the same shutdown (RED: a source without the call fails)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'run-daemon.ts'), 'utf8');
    const wired = (s: string): boolean => /process\.on\('SIGHUP'[^\n]*\n[\s\S]{0,400}?startLockGuard\(\(\) => \{[\s\S]{0,200}?shutdown\('lock_held_elsewhere'\)/.test(s);
    expect(wired(src)).toBe(true);
    expect(wired(src.replace('startLockGuard(() => {', 'void (() => {'))).toBe(false);
  });
});

describe('the lock holder stops an older release\'s daemon left beside it ( : a 90 daemon has no guard of its own)', () => {
  const ENTRY = '/home/box/.provian/agent.js';
  const proc = (pid: number, ppid: number, ageMs: number, command: string, pgid = pid) => ({ pid, ppid, pgid, ageMs, command });
  it('strays: an older observer of this install only — never itself, a wrapper waiting on it, a young start, another install, or a non-observer (RED)', async () => {
    const { strayObservers, STRAY_MIN_AGE_MS } = await import('./run-daemon.js');
    const old = STRAY_MIN_AGE_MS + 1;
    const procs = [
      proc(53, 1, 9e9, 'sandbox-keeper'),
      proc(412985, 53, old, `/home/box/.provian/node/bin/node\0${ENTRY}\0observe\0--if-not-running`),   // the 90 daemon beside us
      proc(413000, 53, old, `/home/box/.provian/node/bin/node\0${ENTRY}\0observe`, 413000),               // a runtime-env wrapper waiting on us
      proc(413090, 413000, old, `/home/box/.provian/node/bin/node\0${ENTRY}\0observe\0--if-not-running`, 413000), // us, in its group
      proc(413500, 413090, 1_000, `/home/box/.provian/node/bin/node\0${ENTRY}\0observe\0--if-not-running`), // a young successor
      proc(414000, 53, old, `/usr/bin/node\0/home/other/.provian/agent.js\0observe`),                    // another install
      proc(414100, 53, old, `/home/box/.provian/node/bin/node\0${ENTRY}\0doctor`),                        // not an observer
      proc(414200, 53, old, `/home/box/.provian/node/bin/node /home/box/.provian/agent.js observe`),        // ps form (spaces)
      proc(414300, 53, old, `sh\0-c\0/home/box/.provian/node/bin/node ${ENTRY} observe >> log 2>&1`),     // a shell wrapper
    ];
    expect(strayObservers(procs, { pid: 413090, entry: ENTRY })).toEqual([412985, 414200]);
    expect(strayObservers(procs.map((p) => ({ ...p, ageMs: 1_000 })), { pid: 413090, entry: ENTRY })).toEqual([]);
  });
  it('strays: the predecessor that queued this daemon as a detached successor is NOT exempt — the Grok bot pair (RED: its group test)', async () => {
    const { strayObservers, STRAY_MIN_AGE_MS } = await import('./run-daemon.js');
    const old = STRAY_MIN_AGE_MS + 1;
    // 89 → 90 on the Grok bot: 412985 (the live predecessor) spawned 413090 detached; 413090 held the lock.
    const pair = [
      proc(53, 1, 9e9, 'sandbox-keeper', 53),
      proc(412985, 53, old, `/home/box/.provian/node/bin/node\0${ENTRY}\0observe\0--if-not-running`, 53),
      proc(413090, 412985, old, `/home/box/.provian/node/bin/node\0${ENTRY}\0observe\0--if-not-running`, 413090),
    ];
    expect(strayObservers(pair, { pid: 413090, entry: ENTRY })).toEqual([412985]);
    // The same parent, not detached from (same group): a waiting wrapper — left alone.
    expect(strayObservers(pair.map((p) => (p.pid === 413090 ? { ...p, pgid: 53 } : p)), { pid: 413090, entry: ENTRY })).toEqual([]);
  });
  it('the guard, as the holder, stops each stray and then has the lanes take their ports back; not the holder, or no strays, neither (RED)', async () => {
    const { startLockGuard } = await import('./run-daemon.js');
    for (const [holds, found] of [[true, [412985]], [false, [412985]], [true, []]] as const) {
      let tick: (() => void) | null = null; const signalled: number[] = []; let rebinds = 0;
      startLockGuard(() => { throw new Error('no stand-down expected'); }, {
        check: () => 'keep', every: (fn) => { tick = fn; return {}; }, stop: () => {},
        holdsLock: () => holds, strays: () => [...found], signal: (p) => { signalled.push(p); }, log: () => {},
        onStraysStopped: () => { rebinds += 1; },
      });
      tick!();
      expect(signalled).toEqual(holds ? [...found] : []);
      expect(rebinds).toBe(holds && found.length > 0 ? 1 : 0);
    }
  });
  it('the daemon wires the stray stop to both lanes\' rebind', async () => {
    const fsm = await import('fs'); const pathm = await import('path');
    const src = fsm.readFileSync(pathm.join(__dirname, 'run-daemon.ts'), 'utf8');
    expect(src).toMatch(/onStraysStopped: \(\) => \{ modelProxyPlugin\?\.rebindIfWaiting\(\); otelPlugin\?\.rebindIfWaiting\(\); \}/);
  });
  it('the real process table lists this process with its age; ps elapsed times parse (RED: an unreadable one is 0)', async () => {
    const { listOwnProcesses, parseEtime } = await import('./service.js');
    const listed = listOwnProcesses();
    const me = listed.find((p) => p.pid === process.pid);
    // Something of this user's started before this test run (its shell, the runner): ages are read.
    expect(Math.max(...listed.map((p) => p.ageMs))).toBeGreaterThan(5_000);
    expect(me).toBeDefined();
    expect(me!.ppid).toBe(process.ppid);
    expect(me!.pgid).toBeGreaterThan(1);
    expect(me!.ageMs).toBeGreaterThanOrEqual(0);
    expect(me!.command).toContain('node');
    expect(parseEtime('05:55')).toBe(355_000);
    expect(parseEtime('01:02:03')).toBe(3_723_000);
    expect(parseEtime('2-01:00:00')).toBe(2 * 86_400_000 + 3_600_000);
    expect(parseEtime('garbage')).toBe(0);
  });
});

describe('the guard\'s own defaults ( : injected in every other test)', () => {
  const ENTRY = '/home/box/.provian/agent.js';
  const proc = (pid: number, ppid: number, ageMs: number, command: string, pgid = pid) => ({ pid, ppid, pgid, ageMs, command });
  const run = async (lockPid: number | null, opts: { self?: { pid: number; entry: string }; argv1?: string } = {}) => {
    const { startLockGuard, STRAY_MIN_AGE_MS } = await import('./run-daemon.js');
    const fsm = await import('fs'); const osm = await import('os'); const pathm = await import('path');
    const lockDir = pathm.join(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'lg-')), 'observer.lock');
    if (lockPid !== null) { fsm.mkdirSync(lockDir); fsm.writeFileSync(pathm.join(lockDir, 'pid'), String(lockPid)); }
    const me = opts.self?.pid ?? process.pid;
    const entry = process.argv[1];                         // the stray runs THIS process's entry file
    const table = [
      proc(me, 1, STRAY_MIN_AGE_MS + 5, `node\0${entry}\0observe`),
      proc(777001, 1, STRAY_MIN_AGE_MS + 5, `node\0${entry}\0observe\0--if-not-running`),
    ];
    let tick: (() => void) | null = null; const signalled: number[] = [];
    startLockGuard(() => { throw new Error('no stand-down expected'); }, {
      check: () => 'keep', every: (fn) => { tick = fn; return {}; }, stop: () => {},
      signal: (p) => { signalled.push(p); }, log: () => {},
      lockDir, listProcesses: () => table, ...(opts.self ? { self: opts.self } : {}),
    });
    tick!();
    return signalled;
  };
  it('holds the lock only when the lock names this daemon: then it stops the stray; otherwise (absent, another pid) it stops nothing (RED)', async () => {
    expect(await run(process.pid)).toEqual([777001]);
    expect(await run(null)).toEqual([]);
    expect(await run(777001)).toEqual([]);
    expect(await run(process.pid + 1)).toEqual([]);
  });
  it('by default matches strays on this process\'s own entry file (RED: another entry is no stray of ours)', async () => {
    expect(await run(process.pid)).toEqual([777001]);
    expect(await run(4242, { self: { pid: 4242, entry: '/elsewhere/agent.js' } })).toEqual([]);
    expect(await run(4242, { self: { pid: 4242, entry: process.argv[1] } })).toEqual([777001]);
  });
  it('/proc stat: parent, group and age from the fields after the command — even one with spaces and parentheses (RED: any off-by-one field reads differently)', async () => {
    const { parseProcStat } = await import('./service.js');
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime vsize
    const stat = '4321 (node (my) agent) S 53 4300 4299 0 -1 4194560 11 12 13 14 15 16 17 18 20 7 9 0 50000 123456789 99';
    expect(parseProcStat(stat, 1000)).toEqual({ ppid: 53, pgid: 4300, ageMs: 500_000 });
  });
});

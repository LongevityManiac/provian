/**
 * §3 item 4 — the shell-startup restart hook. Every guard here ships with its RED control:
 * the stale-pid case runs against a live process that is NOT our daemon (and must start one), the
 * "ours" case against a live process whose command line IS our daemon's (and must not), and the rc
 * edits are checked against a symlinked file, a mode, a missing ~/.bash_profile and foreign content.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { CRON_BLOCK_START, cronStartLabel } from './service';
import {
  CRON_BLOCK_MARK,
  RESTART_HOOK_BEGIN,
  RESTART_HOOK_END,
  ensureScriptContent,
  ensureScriptPath,
  healRestartHook,
  installRestartHook,
  mergeRestartHookBlock,
  restartHookBlock,
  restartHookInstalled,
  restartHookRcTargets,
  restartHookWanted,
  restartHookOptedOut,
  resolveRestartHookOptOut,
  restartHookOptOutPath,
  runningObserverEntry,
  stripRestartHookBlock,
  uninstallRestartHook,
} from './restart-hook';

let home: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provian-restart-hook-')));
  fs.mkdirSync(path.join(home, '.provian'), { recursive: true });
});
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(home, { recursive: true, force: true });
});

/** A fake "node": records its argv and env marker to a file, then exits. */
function fakeNode(): { bin: string; record: string } {
  const bin = path.join(home, 'fake-node.sh');
  const record = path.join(home, 'started.txt');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s|%s\\n' "$PROVIAN_SUPERVISOR" "$*" >> '${record}'\n`, { mode: 0o755 });
  return { bin, record };
}

function entryFor(bin: string) {
  return { command: bin, args: [path.join(home, '.provian', 'agent.js'), 'observe'] };
}

async function waitFor(p: string, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8').length > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function runEnsure(): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('/bin/sh', [ensureScriptPath(home)], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home }, encoding: 'utf8', timeout: 10_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('the rc guard block', () => {
  it('is marker-delimited, silent and guarded on the ensure script being executable', () => {
    const b = restartHookBlock();
    expect(b.startsWith(`${RESTART_HOOK_BEGIN}\n`)).toBe(true);
    expect(b.endsWith(`${RESTART_HOOK_END}\n`)).toBe(true);
    expect(b).toContain('if [ -x "$HOME/.provian/bin/provian-ensure" ]');
    expect(b).toContain('>/dev/null 2>&1 </dev/null');
    expect(spawnSync('sh', ['-n'], { input: b }).status).toBe(0);
  });

  it('merges at the TOP (before a stock ~/.bashrc non-interactive return), idempotently, keeping foreign content byte-identical', () => {
    const stock = '# ~/.bashrc\ncase $- in *i*) ;; *) return;; esac\nalias ll="ls -l"\n';
    const once = mergeRestartHookBlock(stock);
    expect(once.indexOf(RESTART_HOOK_BEGIN)).toBe(0);
    expect(once.endsWith(stock)).toBe(true);
    expect(mergeRestartHookBlock(once)).toBe(once);
    expect(stripRestartHookBlock(once)).toBe(stock);
  });

  it('RED control: an unterminated (hand-edited) block is left untouched rather than eating the rest of the file', () => {
    const broken = `${RESTART_HOOK_BEGIN}\nuser line 1\nuser line 2\n`;
    expect(stripRestartHookBlock(broken)).toBe(broken);
  });

  it('targets ~/.bashrc and ~/.profile (created), ~/.bash_profile and ~/.bash_login only when present, ~/.zshenv only with zsh', () => {
    const t = restartHookRcTargets(home, false);
    expect(t.map((x) => [path.basename(x.path), x.create])).toEqual([
      ['.bashrc', true], ['.profile', true], ['.bash_profile', false], ['.bash_login', false],
    ]);
    expect(restartHookRcTargets(home, true).map((x) => path.basename(x.path))).toContain('.zshenv');
  });
});

describe('installRestartHook / uninstallRestartHook', () => {
  it('creates ~/.bashrc and ~/.profile, never creates ~/.bash_profile, writes an executable ensure script', () => {
    const { bin } = fakeNode();
    const r = installRestartHook({ home, entry: entryFor(bin), zshPresent: false });
    expect(r.script).toBe('installed');
    expect(r.rc[path.join(home, '.bashrc')]).toBe('created');
    expect(r.rc[path.join(home, '.profile')]).toBe('created');
    expect(r.rc[path.join(home, '.bash_profile')]).toBe('skipped');
    expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false);
    expect(fs.statSync(ensureScriptPath(home)).mode & 0o111).not.toBe(0);
    expect(restartHookInstalled(home)).toBe(true);
    // Second run: nothing rewritten.
    const again = installRestartHook({ home, entry: entryFor(bin), zshPresent: false });
    expect(again.script).toBe('unchanged');
    expect(Object.values(again.rc).filter((o) => o === 'current')).toHaveLength(2);
  });

  it('edits an existing ~/.bash_profile, and edits a SYMLINKED ~/.bashrc through the link keeping its mode', () => {
    const { bin } = fakeNode();
    const dotfiles = path.join(home, 'dotfiles');
    fs.mkdirSync(dotfiles);
    const target = path.join(dotfiles, 'bashrc');
    fs.writeFileSync(target, 'export FOO=1\n', { mode: 0o640 });
    fs.chmodSync(target, 0o640);
    fs.symlinkSync(target, path.join(home, '.bashrc'));
    fs.writeFileSync(path.join(home, '.bash_profile'), '. ~/.bashrc\n');
    installRestartHook({ home, entry: entryFor(bin), zshPresent: false });
    expect(fs.lstatSync(path.join(home, '.bashrc')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(`${restartHookBlock()}export FOO=1\n`);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8')).toBe(`${restartHookBlock()}. ~/.bashrc\n`);

    const u = uninstallRestartHook({ home });
    expect(u.script).toBe('removed');
    expect(fs.lstatSync(path.join(home, '.bashrc')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('export FOO=1\n');
    expect(fs.readFileSync(path.join(home, '.bash_profile'), 'utf8')).toBe('. ~/.bashrc\n');
    expect(restartHookInstalled(home)).toBe(false);
  });

  it('refuses a non-absolute node (never a PATH lookup baked into the hook)', () => {
    const r = installRestartHook({ home, entry: { command: 'node', args: ['/x/agent.js', 'observe'] } });
    expect(r.script).toBe('error');
    expect(fs.existsSync(ensureScriptPath(home))).toBe(false);
  });
});

describe('the ensure script (run under /bin/sh)', () => {
  it('is valid POSIX sh', () => {
    const { bin } = fakeNode();
    expect(spawnSync('sh', ['-n'], { input: ensureScriptContent(entryFor(bin)) }).status).toBe(0);
  });

  it('starts `observe --if-not-running` detached, as PROVIAN_SUPERVISOR=detached, silently, when no daemon runs', async () => {
    const { bin, record } = fakeNode();
    installRestartHook({ home, entry: entryFor(bin), zshPresent: false });
    const r = runEnsure();
    expect(r).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(await waitFor(record)).toBe(true);
    expect(fs.readFileSync(record, 'utf8').trim()).toBe(`detached|${path.join(home, '.provian', 'agent.js')} observe --if-not-running`);
  });

  it('PID REUSE (RED control for the identity check): a pidfile naming a LIVE process that is not our daemon still starts one', async () => {
    const { bin, record } = fakeNode();
    installRestartHook({ home, entry: entryFor(bin), zshPresent: false });
    // A live, unrelated process (what a pid that survived a reboot may now be).
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    children.push(stranger);
    fs.writeFileSync(path.join(home, '.provian', 'observer.pid'), String(stranger.pid));
    fs.mkdirSync(path.join(home, '.provian', 'observer.lock'));
    fs.writeFileSync(path.join(home, '.provian', 'observer.lock', 'pid'), String(stranger.pid));
    expect(runEnsure().status).toBe(0);
    expect(await waitFor(record)).toBe(true);
  });

  it('a pidfile naming our live daemon exits at once and starts nothing (no node spawn)', async () => {
    const { bin, record } = fakeNode();
    installRestartHook({ home, entry: entryFor(bin), zshPresent: false });
    // A live process whose command line IS our daemon's: `<node> <home>/.provian/agent.js observe`.
    const ours = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', path.join(home, '.provian', 'agent.js'), 'observe'], { stdio: 'ignore' });
    children.push(ours);
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(home, '.provian', 'observer.pid'), String(ours.pid));
    expect(runEnsure().status).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(record)).toBe(false);
  });

  it('throttles to one start attempt a minute (a daemon that cannot start never costs every shell a node)', async () => {
    const { bin, record } = fakeNode();
    installRestartHook({ home, entry: entryFor(bin), zshPresent: false });
    runEnsure();
    expect(await waitFor(record)).toBe(true);
    runEnsure();
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.readFileSync(record, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('PROVIAN_RESTART_HOOK=0 in the shell makes the STARTUP-FILE trigger a no-op', async () => {
    const { bin, record } = fakeNode();
    installRestartHook({ home, entry: entryFor(bin), zshPresent: false });
    spawnSync('/bin/sh', [ensureScriptPath(home), 'rc'], { env: { PATH: process.env.PATH, HOME: home, PROVIAN_RESTART_HOOK: '0' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(record)).toBe(false);
  });

  it('review r5 #5: the startup-file trigger honours every opt-out spelling the daemon does', async () => {
    const { bin, record } = fakeNode();
    installRestartHook({ home, entry: entryFor(bin), zshPresent: false });
    for (const v of ['0', 'false', 'OFF', ' No ', 'no']) {
      expect(restartHookOptedOut({ PROVIAN_RESTART_HOOK: v })).toBe(true);
      spawnSync('/bin/sh', [ensureScriptPath(home), 'rc'], { env: { PATH: process.env.PATH, HOME: home, PROVIAN_RESTART_HOOK: v, PROVIAN_ENSURE_NOW: '1' } });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(record)).toBe(false);
    // RED control: a value that is not an opt-out (and the daemon agrees) starts it.
    expect(restartHookOptedOut({ PROVIAN_RESTART_HOOK: 'yes' })).toBe(false);
    spawnSync('/bin/sh', [ensureScriptPath(home), 'rc'], { env: { PATH: process.env.PATH, HOME: home, PROVIAN_RESTART_HOOK: 'yes', PROVIAN_ENSURE_NOW: '1' } });
    expect(await waitFor(record)).toBe(true);
  });

  it('review r3 #1: with the opt-out exported, the agent\'s direct run (`observe --if-not-running`, act verbs) STILL starts the observer', async () => {
    const { bin, record } = fakeNode();
    installRestartHook({ home, entry: entryFor(bin), zshPresent: false, rc: false });
    spawnSync('/bin/sh', [ensureScriptPath(home)], { env: { PATH: process.env.PATH, HOME: home, PROVIAN_RESTART_HOOK: '0', PROVIAN_ENSURE_NOW: '1' } });
    // RED control is the test above: the same env through the rc trigger starts nothing.
    expect(await waitFor(record)).toBe(true);
  });
});

describe('the daemon-start heal (self-updated daemons get it with no user action)', () => {
  it('the ensure script\'s crontab marker is the start of the observer\'s real crontab block', () => {
    expect(CRON_BLOCK_START.startsWith(CRON_BLOCK_MARK)).toBe(true);
  });

  it('review r12: installCron itself starts its daemon with the live-checked label — never a hard-coded cron', () => {
    const src = fs.readFileSync(path.join(__dirname, 'service.ts'), 'utf8');
    const start = src.indexOf('function installCron(');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const judge = (b: string): boolean => {
      const call = b.slice(b.indexOf('startDetached('));
      const args = call.slice(0, call.indexOf(');'));
      return args.includes('cronStartLabel(probeCronDaemon())') && !/,\s*'cron'\s*,?\s*$/.test(args);
    };
    expect(body.includes('startDetached(')).toBe(true);
    expect(judge(body)).toBe(true);
    // RED control: the pre-r11 call site (a literal 'cron' label) is caught.
    const reverted = body.replace('cronStartLabel(probeCronDaemon())', "'cron'");
    expect(reverted).not.toBe(body);
    expect(judge(reverted)).toBe(false);
  });

  it('review r11 #1: the install-time daemon beside a fresh crontab block is labelled cron ONLY when crond runs', () => {
    expect(cronStartLabel(true)).toBe('cron');
    expect(cronStartLabel(false)).toBe('detached'); // crontab present, crond not running
    expect(cronStartLabel(null)).toBe('detached'); // cannot tell → never claim a supervisor
  });

  it('review r9 #1 / r10 #1: the script labels the daemon it starts `cron` ONLY when our crontab block is installed AND a cron daemon runs — else `detached`', async () => {
    const { bin, record } = fakeNode();
    installRestartHook({ home, entry: entryFor(bin), zshPresent: false, rc: false });
    // A fake `crontab -l` that lists our block, and a fake /proc.
    const fakeBin = path.join(home, 'fakebin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'crontab'), `#!/bin/sh\necho '${CRON_BLOCK_START}'\n`, { mode: 0o755 });
    const proc = path.join(home, 'proc');
    fs.mkdirSync(path.join(proc, '42'), { recursive: true });
    fs.writeFileSync(path.join(proc, '42', 'comm'), 'bash\n');
    const run = async (): Promise<string> => {
      try { fs.unlinkSync(record); } catch { /* none */ }
      try { fs.unlinkSync(path.join(home, '.provian', 'restart-hook.stamp')); } catch { /* none */ }
      spawnSync('/bin/sh', [ensureScriptPath(home)], { env: { PATH: `${fakeBin}:${process.env.PATH}`, HOME: home, PROVIAN_ENSURE_NOW: '1', PROVIAN_PROC_ROOT: proc } });
      expect(await waitFor(record)).toBe(true);
      return fs.readFileSync(record, 'utf8').split('|')[0];
    };
    // crontab block present, NO cron daemon (the Docker-cell case): detached.
    expect(await run()).toBe('detached');
    // A cron daemon now runs: cron.
    fs.mkdirSync(path.join(proc, '7'));
    fs.writeFileSync(path.join(proc, '7', 'comm'), 'cron\n');
    expect(await run()).toBe('cron');
    // busybox crond (comm `busybox`, `crond` in its cmdline) counts; a look-alike argument does not.
    fs.rmSync(path.join(proc, '7'), { recursive: true });
    fs.mkdirSync(path.join(proc, '9'));
    fs.writeFileSync(path.join(proc, '9', 'comm'), 'busybox\n');
    fs.writeFileSync(path.join(proc, '9', 'cmdline'), 'busybox\0crondx\0');
    expect(await run()).toBe('detached');
    fs.writeFileSync(path.join(proc, '9', 'cmdline'), '/bin/busybox\0crond\0-f\0');
    expect(await run()).toBe('cron');
    // RED control: crond runs but our block is NOT in the crontab: detached.
    fs.writeFileSync(path.join(fakeBin, 'crontab'), '#!/bin/sh\necho "0 * * * * other"\n', { mode: 0o755 });
    expect(await run()).toBe('detached');
  });

  it('review r9 #2: the opt-out is RECORDED — a later daemon started without the variable (cron, @reboot, the agent\'s command) never writes the startup files back', async () => {
    const { bin, record } = fakeNode();
    healRestartHook({ method: 'detached', entry: entryFor(bin), platform: 'linux', home, env: { PROVIAN_RESTART_HOOK: '0' } });
    expect(fs.existsSync(restartHookOptOutPath(home))).toBe(true);
    expect(restartHookInstalled(home)).toBe(false);
    // The next daemon: no variable at all.
    healRestartHook({ method: 'detached', entry: entryFor(bin), platform: 'linux', home, env: {} });
    expect(restartHookInstalled(home)).toBe(false);
    expect(resolveRestartHookOptOut({}, home)).toBe(true);
    // A startup file that still ran the script (e.g. an old block) finds it a no-op, with no variable.
    spawnSync('/bin/sh', [ensureScriptPath(home), 'rc'], { env: { PATH: process.env.PATH, HOME: home, PROVIAN_ENSURE_NOW: '1' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(record)).toBe(false);
    // RED control: an explicit opt-in clears the record and the blocks come back.
    healRestartHook({ method: 'detached', entry: entryFor(bin), platform: 'linux', home, env: { PROVIAN_RESTART_HOOK: '1' } });
    expect(fs.existsSync(restartHookOptOutPath(home))).toBe(false);
    expect(restartHookInstalled(home)).toBe(true);
    // Uninstall removes the record too.
    resolveRestartHookOptOut({ PROVIAN_RESTART_HOOK: 'off' }, home);
    uninstallRestartHook({ home });
    expect(fs.existsSync(restartHookOptOutPath(home))).toBe(false);
  });

  it('installs on Linux detached and cron; nothing elsewhere; opted out it removes the startup-file blocks and KEEPS the ensure script (review r2 #5)', () => {
    expect(restartHookWanted('detached', 'linux')).toBe(true);
    expect(restartHookWanted('cron', 'linux')).toBe(true);
    // follow-up: `unknown` (a daemon an agent's shell started — the operator’s pre- Grok bot) is
    // the box nothing restarts, so it gets the hook; before this it got nothing and stranded.
    expect(restartHookWanted('unknown', 'linux')).toBe(true);
    for (const m of ['systemd', 'launchd', 'scheduled_task']) expect(restartHookWanted(m, 'linux')).toBe(false);
    expect(restartHookWanted('detached', 'darwin')).toBe(false);

    const { bin } = fakeNode();
    expect(healRestartHook({ method: 'systemd', entry: entryFor(bin), platform: 'linux', home, env: {} })).toBeNull();
    expect(restartHookInstalled(home)).toBe(false);
    const done = healRestartHook({ method: 'detached', entry: entryFor(bin), platform: 'linux', home, env: {} });
    expect(done?.script).toBe('installed');
    expect(restartHookInstalled(home)).toBe(true);
    const removed = healRestartHook({ method: 'detached', entry: entryFor(bin), platform: 'linux', home, env: { PROVIAN_RESTART_HOOK: '0' } });
    expect(restartHookInstalled(home)).toBe(false); // no startup file carries the block: the hook is not in effect
    for (const [, v] of Object.entries(removed?.rc ?? {})) expect(['removed', 'absent']).toContain(v);
    // …but the ensure script stays, so the agent's `observe --if-not-running` (the `agent`
    // mechanism this box now resolves to) can still start the observer.
    expect(fs.statSync(ensureScriptPath(home)).mode & 0o111).not.toBe(0);
    // RED control: a full uninstall removes the script too — then there is nothing to run.
    uninstallRestartHook({ home });
    expect(fs.existsSync(ensureScriptPath(home))).toBe(false);
  });

  it('reads the running daemon entry from its own argv (bundle `observe`, or the npm script)', () => {
    expect(runningObserverEntry(['/n', '/h/.provian/agent.js', 'observe', '--if-not-running'], '/n'))
      .toEqual({ command: '/n', args: ['/h/.provian/agent.js', 'observe'] });
    expect(runningObserverEntry(['/n', '/p/dist/scripts/start-observer.js'], '/n'))
      .toEqual({ command: '/n', args: ['/p/dist/scripts/start-observer.js'] });
    expect(runningObserverEntry(['/n', 'relative.js'], '/n')).toBeNull();
  });
});

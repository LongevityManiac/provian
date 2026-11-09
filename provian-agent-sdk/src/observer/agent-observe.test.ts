/**
 * follow-up : `provian observe --if-not-running` starts the observer on any
 * registered box where nothing else will — a missing restart script is the reason to start, never to
 * refuse. the operator’s pre- Grok bot refused twice ("no restart script on this machine").
 */
import { describe, it, expect } from 'vitest';
import { agentObserve, buildAgentObserveDeps, type AgentObserveDeps } from './agent-observe';
import type { installRestartHook } from './restart-hook';

interface World {
  script?: boolean; installWorks?: boolean; service?: boolean;
  /** What each start step does to the daemon: 'up' | 'nothing' | 'dies' (up, then gone). */
  serviceDoes?: 'up' | 'nothing' | 'handover'; ensureDoes?: 'up' | 'nothing' | 'dies'; spawnDoes?: 'up' | 'nothing' | 'dies' | 'handover';
  running?: number | null;
}

function world(o: World) {
  const calls: string[] = [];
  let pid: number | null = o.running ?? null;
  let dying = false;
  let script = o.script ?? false;
  let handover = false;
  const act = (what: 'up' | 'nothing' | 'dies' | 'handover' | undefined, id: number) => {
    if (what === 'nothing') return;
    pid = id; dying = what === 'dies'; handover = what === 'handover';
  };
  const deps: AgentObserveDeps = {
    // A dying child is seen once (its pidfile), then gone; a self-heal handover moves to a new pid.
    running: () => {
      const p = pid;
      if (dying) { pid = null; dying = false; }
      if (handover) { pid = (pid ?? 0) + 1; handover = false; }
      return p;
    },
    startService: () => { calls.push('service'); if (!o.service) return false; act(o.serviceDoes ?? 'up', 11); return true; },
    runEnsure: () => { calls.push('ensure'); if (!script) return false; act(o.ensureDoes ?? 'up', 4242); return true; },
    installEnsure: () => { calls.push('install'); if (o.installWorks === false) return false; script = true; return true; },
    spawnDetached: () => { calls.push('spawn'); act(o.spawnDoes ?? 'up', 777); },
    sleep: async () => {},
    log: () => {}, error: () => {},
    waitMs: 300, serviceWaitMs: 300, settleMs: 0,
  };
  return { deps, calls };
}

describe('agentObserve', () => {
  it('a pre- box with NO restart script: writes the script, runs it, the observer starts (never refuses)', async () => {
    const w = world({ script: false });
    expect(await agentObserve(w.deps)).toBe('started');
    expect(w.calls).toEqual(['service', 'ensure', 'install', 'ensure']);
  });

  it('a supervised box starts its SERVICE and writes nothing (review r1 #1)', async () => {
    const w = world({ service: true });
    expect(await agentObserve(w.deps)).toBe('started');
    expect(w.calls).toEqual(['service']);
  });

  it('review r1 #2: a script that exists but starts nothing falls through to the direct start', async () => {
    const w = world({ script: true, ensureDoes: 'nothing' });
    expect(await agentObserve(w.deps)).toBe('started');
    expect(w.calls).toEqual(['service', 'ensure', 'install', 'ensure', 'spawn']);
  });

  it('the script cannot be written: it starts the daemon detached itself', async () => {
    const w = world({ installWorks: false });
    expect(await agentObserve(w.deps)).toBe('started');
    expect(w.calls).toEqual(['service', 'ensure', 'install', 'spawn']);
  });

  it('review r2 #1: a service that took the start but is slow / never up — NOTHING else is started beside it', async () => {
    const w = world({ service: true, serviceDoes: 'nothing', script: true, installWorks: true });
    expect(await agentObserve(w.deps)).toBe('failed');
    expect(w.calls).toEqual(['service']); // RED: the r1 code went on to ensure/install/spawn
  });

  it('review r2 #2: a self-heal handover to a new pid inside the settle counts as up', async () => {
    const svc = world({ service: true, serviceDoes: 'handover' });
    expect(await agentObserve(svc.deps)).toBe('started');
    const direct = world({ installWorks: false, spawnDoes: 'handover' });
    expect(await agentObserve(direct.deps)).toBe('started');
  });

  it('already running: nothing is started', async () => {
    const w = world({ script: true, running: 99 });
    expect(await agentObserve(w.deps)).toBe('already_running');
    expect(w.calls).toEqual([]);
  });

  it('RED control (review r1 #2): a child that dies at once is NOT "started" — every step tried, failure reported', async () => {
    const w = world({ installWorks: false, spawnDoes: 'dies' });
    expect(await agentObserve(w.deps)).toBe('failed');
  });
});

describe('buildAgentObserveDeps — the production wiring (review r1 #3)', () => {
  function wire(o: { platform?: NodeJS.Platform; service?: boolean; optedOut?: boolean }) {
    const installs: Array<Parameters<typeof installRestartHook>[0]> = [];
    const spawned: Array<{ command: string; args: string[] }> = [];
    const deps = buildAgentObserveDeps({
      entryScript: '/home/box/.provian/agent.js',
      node: '/home/box/.provian/node/bin/node',
      platform: o.platform ?? 'linux',
      running: () => null,
      serviceInstalled: () => o.service === true,
      startInstalledService: () => true,
      startDetached: (e) => { spawned.push(e); },
      install: ((opts: Parameters<typeof installRestartHook>[0]) => { installs.push(opts); return { script: 'installed', rc: {} }; }) as typeof installRestartHook,
      runEnsure: () => false,
      optedOut: () => o.optedOut === true,
    });
    return { deps, installs, spawned };
  }

  it('the ensure script execs the bundle\'s observe verb with a node that exists; the direct start adds --if-not-running', () => {
    const w = wire({});
    expect(w.deps.installEnsure()).toBe(true);
    expect(w.installs[0].entry).toEqual({ command: '/home/box/.provian/node/bin/node', args: ['/home/box/.provian/agent.js', 'observe'] });
    expect(w.installs[0].rc).toBe(true);
    w.deps.spawnDetached();
    expect(w.spawned[0]).toEqual({ command: '/home/box/.provian/node/bin/node', args: ['/home/box/.provian/agent.js', 'observe', '--if-not-running'] });
  });

  it('opted out: the script is written, the startup-file blocks are not', () => {
    const w = wire({ optedOut: true });
    w.deps.installEnsure();
    expect(w.installs[0].rc).toBe(false);
  });

  it('RED control: a supervised box, a Mac or Windows never gets the script or startup-file blocks from this command', () => {
    for (const o of [{ service: true }, { platform: 'darwin' as const }, { platform: 'win32' as const }]) {
      const w = wire(o);
      expect(w.deps.installEnsure()).toBe(false);
      expect(w.installs).toHaveLength(0);
    }
    expect(wire({ service: false }).deps.startService()).toBe(false);
    expect(wire({ service: true }).deps.startService()).toBe(true);
  });

  it('review r2 #1, end to end: a supervised box whose service started but whose daemon never shows — the real wiring never calls startDetached', async () => {
    let detached = 0;
    const deps = buildAgentObserveDeps({
      entryScript: '/home/box/.provian/agent.js', node: '/usr/bin/node', platform: 'linux',
      running: () => null, serviceInstalled: () => true, startInstalledService: () => true,
      startDetached: () => { detached += 1; },
      install: (() => { throw new Error('must not install'); }) as unknown as typeof installRestartHook,
      runEnsure: () => { throw new Error('must not run the ensure script'); },
      optedOut: () => false, sleep: async () => {}, log: () => {}, error: () => {},
    });
    expect(await agentObserve({ ...deps, serviceWaitMs: 300, settleMs: 0 })).toBe('failed');
    expect(detached).toBe(0);
  });
});

describe('observe --if-not-running prints what the observer is waiting for (a Grok Bot computer reads no startup file)', () => {
  const NOTICE = { instruction: 'Re-describe the changed session format.', file: '/h/.provian/witness-action-required.json' };
  const MAIL = { unread: 2, from: ['Ada'], read_with: 'provian threads --unread' };
  const run = async (o: World, notice: unknown, mail: unknown) => {
    const w = world(o);
    const out: string[] = [];
    w.deps.log = (l) => { out.push(l); };
    w.deps.actionNotice = () => notice as ReturnType<NonNullable<AgentObserveDeps['actionNotice']>>;
    w.deps.mailNotice = () => mail as ReturnType<NonNullable<AgentObserveDeps['mailNotice']>>;
    return { outcome: await agentObserve(w.deps), out };
  };

  it('a running observer: the pid line, then the notice and the mail', async () => {
    const r = await run({ running: 55 }, NOTICE, MAIL);
    expect(r.outcome).toBe('already_running');
    expect(r.out[0]).toBe('  Provian observer is running (pid 55).');
    expect(r.out).toContain(`  witness_action_required: ${JSON.stringify(NOTICE)}`);
    expect(r.out).toContain(`  commons_mail: ${JSON.stringify(MAIL)}`);
  });

  it('a start prints them too, and a failed start still does', async () => {
    expect((await run({ script: true }, NOTICE, null)).out).toContain(`  witness_action_required: ${JSON.stringify(NOTICE)}`);
    const failed = await run({ script: false, installWorks: false, spawnDoes: 'nothing' }, NOTICE, null);
    expect(failed.outcome).toBe('failed');
    expect(failed.out).toContain(`  witness_action_required: ${JSON.stringify(NOTICE)}`);
  });

  it('RED control: with nothing waiting, only the pid line prints', async () => {
    expect((await run({ running: 55 }, null, null)).out).toEqual(['  Provian observer is running (pid 55).']);
  });

  it('a notice that cannot be read never changes the outcome', async () => {
    const w = world({ running: 9 });
    w.deps.actionNotice = () => { throw new Error('unreadable'); };
    w.deps.mailNotice = () => { throw new Error('unreadable'); };
    expect(await agentObserve(w.deps)).toBe('already_running');
  });

  it('the production deps read the real notice and mailbox files under the box\'s home', async () => {
    const fs = await import('fs'); const os = await import('os'); const path = await import('path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'provian-observe-notice-'));
    try {
      const deps = buildAgentObserveDeps({
        entryScript: '/x/agent.js', node: '/x/node', platform: 'linux', home,
        running: () => 1, serviceInstalled: () => false, startInstalledService: () => false, startDetached: () => {},
      });
      // RED: nothing on disk, nothing to print.
      expect(deps.actionNotice?.()).toBeNull();
      expect(deps.mailNotice?.()).toBeNull();
      fs.mkdirSync(path.join(home, '.provian'), { recursive: true });
      fs.writeFileSync(path.join(home, '.provian', 'witness-action-required.json'), JSON.stringify({ instruction: 'x' }));
      expect(deps.actionNotice?.()).toEqual({ instruction: 'x', file: path.join(home, '.provian', 'witness-action-required.json') });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

/**
 * the restart mechanism a box actually has, stated truthfully —
 * and the Grok Bot box's exact shell shape (exec-daemon → `/usr/bin/bash -O extglob -c`,
 * $- = hBHc, no startup file sourced) resolves to `agent`.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRestartMechanism, probeInstallShellSourcesRc, ensureScriptContent, restartHookBlock, type ProcFacts,
} from './restart-hook';

const chain = (procs: Array<Omit<ProcFacts, 'ppid'>>): ((pid: number) => ProcFacts | null) =>
  (pid) => {
    const p = procs[pid - 100];
    if (!p) return null;
    return { ...p, ppid: pid - 100 + 1 < procs.length ? pid + 1 : null };
  };

describe('probeInstallShellSourcesRc', () => {
  it("the Grok Bot box: curl|sh's sh ← bash -O extglob -c ← exec-daemon → NO startup file is read", () => {
    const read = chain([
      { argv: ['sh'], stdinTty: false },                                        // the piped install script
      { argv: ['/usr/bin/bash', '-O', 'extglob', '-c', 'wrapper'], stdinTty: false }, // the agent's shell
      { argv: ['/exec-daemon/node', '/exec-daemon/index.js', 'serve'], stdinTty: false },
    ]);
    expect(probeInstallShellSourcesRc(100, read)).toBe(false);
  });

  it('a human pasting the line into an interactive terminal: bash with a tty and no -c → read', () => {
    const read = chain([{ argv: ['sh'], stdinTty: false }, { argv: ['bash'], stdinTty: true }]);
    expect(probeInstallShellSourcesRc(100, read)).toBe(true);
  });

  it('a login shell (-bash, --login, -l) or -i → read', () => {
    for (const argv of [['-bash'], ['bash', '--login', '-c', 'x'], ['bash', '-lc', 'x'], ['bash', '-ic', 'x']]) {
      expect(probeInstallShellSourcesRc(100, chain([{ argv, stdinTty: false }]))).toBe(true);
    }
  });

  it('no shell ancestor at all → unknown (null), never a guess', () => {
    expect(probeInstallShellSourcesRc(100, chain([{ argv: ['/usr/bin/node', 'x.js'], stdinTty: false }]))).toBeNull();
  });
});

describe('resolveRestartMechanism', () => {
  const base = { cronAlive: null, hookInstalled: true, rcFired: false, installShellSourcesRc: false as boolean | null };
  it('service managers are the mechanism', () => {
    expect(resolveRestartMechanism({ ...base, method: 'systemd' })).toBe('systemd');
    expect(resolveRestartMechanism({ ...base, method: 'launchd' })).toBe('launchd');
  });
  it('cron only when a cron daemon is running', () => {
    expect(resolveRestartMechanism({ ...base, method: 'cron', cronAlive: true })).toBe('cron');
    expect(resolveRestartMechanism({ ...base, method: 'cron', cronAlive: false })).toBe('agent');
  });
  it('shell_rc only when a startup file is really sourced (the hook fired, or the install shell reads them)', () => {
    expect(resolveRestartMechanism({ ...base, method: 'detached', rcFired: true })).toBe('shell_rc');
    expect(resolveRestartMechanism({ ...base, method: 'detached', installShellSourcesRc: true })).toBe('shell_rc');
  });
  it('the Grok Bot box — detached, hook written but never sourced — is `agent` (RED: a written hook alone is not a mechanism)', () => {
    expect(resolveRestartMechanism({ ...base, method: 'detached' })).toBe('agent');
    expect(resolveRestartMechanism({ ...base, method: 'detached', hookInstalled: false, rcFired: true })).toBe('agent');
  });
});

describe('ensure script', () => {
  const s = ensureScriptContent({ command: '/n/node', args: ['/h/.provian/agent.js', 'observe'] });
  it('a run from a startup file records that the file is sourced; the agent asking is unthrottled; the wrapper marker never reaches the daemon', () => {
    expect(restartHookBlock()).toContain('provian-ensure" rc');
    expect(s).toContain('[ "$1" = rc ] && : > "$P/restart-hook.fired"');
    expect(s).toContain('"${PROVIAN_ENSURE_NOW:-0}" != 1');
    expect(s).toContain('unset PROVIAN_VIA_SHIM');
  });
});

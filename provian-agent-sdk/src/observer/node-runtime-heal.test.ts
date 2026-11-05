/**
 * node-runtime-heal — keeping the observer off a Node that cannot read the store
 * (item 3, correction 2).
 *
 * Negative-control doctrine: every heal branch has its RED. The loop guard, the
 * "no candidate", the "candidate is the current dark node", and the "candidate is
 * ALSO dark" cases each assert NO re-exec — so the one GREEN re-exec path cannot
 * pass by accident. The driver's re-exec is verified behaviorally (spawnSync gets
 * the capable node + the same argv + the guard env; exit gets the child status).
 */

import { describe, it, expect, vi } from 'vitest';
import type { SpawnSyncReturns } from 'child_process';
import {
  decideNodeSelfHeal,
  resolveStoreCapableNodeBin,
  selfHealNodeRuntimeIfNeeded,
  nodeBinaryCanReadStore,
  SELFHEAL_GUARD_ENV,
  STORE_CAPABILITY_PROBE_JS,
} from './node-runtime-heal';

const DARK = '/usr/local/bin/node'; // stands in for a dark Node 20
const CAPABLE = '/home/a/.provian/node/bin/node';

function spawnResult(status: number): SpawnSyncReturns<Buffer> {
  return { pid: 1, output: [], stdout: Buffer.from(''), stderr: Buffer.from(''), status, signal: null } as SpawnSyncReturns<Buffer>;
}

describe('decideNodeSelfHeal (pure core)', () => {
  it('moves capable system Node26 to the installer runtime', () => {
    expect(decideNodeSelfHeal({currentCanRead: true, currentExecPath: DARK, alreadyReexeced: false, candidateBin: CAPABLE, candidateCanRead: true}).action).toBe('reexec');
  });
  it('does NOT heal when the current runtime can read the store', () => {
    const d = decideNodeSelfHeal({
      currentCanRead: true, currentExecPath: CAPABLE, alreadyReexeced: false,
      candidateBin: CAPABLE, candidateCanRead: true,
    });
    expect(d.action).toBe('none');
  });

  it('RE-EXECS onto a capable, different ~/.provian/node when the current runtime is dark', () => {
    const d = decideNodeSelfHeal({
      currentCanRead: false, currentExecPath: DARK, alreadyReexeced: false,
      candidateBin: CAPABLE, candidateCanRead: true,
    });
    expect(d.action).toBe('reexec');
    expect(d.nodeBin).toBe(CAPABLE);
  });

  it('RED (loop guard): does NOT re-exec again if it already re-exec\'d once', () => {
    const d = decideNodeSelfHeal({
      currentCanRead: false, currentExecPath: DARK, alreadyReexeced: true,
      candidateBin: CAPABLE, candidateCanRead: true,
    });
    expect(d.action).toBe('none');
    expect(d.reason).toContain('already');
  });

  it('RED (no candidate): dark runtime with no ~/.provian/node → none, actionable reason', () => {
    const d = decideNodeSelfHeal({
      currentCanRead: false, currentExecPath: DARK, alreadyReexeced: false,
      candidateBin: null, candidateCanRead: false,
    });
    expect(d.action).toBe('none');
    expect(d.reason).toMatch(/re-run the Provian setup/i);
  });

  it('RED (candidate is the current dark node): → none', () => {
    const d = decideNodeSelfHeal({
      currentCanRead: false, currentExecPath: DARK, alreadyReexeced: false,
      candidateBin: DARK, candidateCanRead: false,
    });
    expect(d.action).toBe('none');
  });

  it('RED (candidate ALSO dark): a candidate that fails the probe → none', () => {
    const d = decideNodeSelfHeal({
      currentCanRead: false, currentExecPath: DARK, alreadyReexeced: false,
      candidateBin: CAPABLE, candidateCanRead: false,
    });
    expect(d.action).toBe('none');
  });
});

describe('resolveStoreCapableNodeBin (bake selection)', () => {
  it('bakes the installer runtime even when system Node can read the store', () => {
    const r = resolveStoreCapableNodeBin({ currentExecPath: DARK, currentCanRead: true, candidateBin: CAPABLE, exists: () => true, probeBinary: () => true });
    expect(r).toBe(CAPABLE);
  });

  it('prefers a fetched ~/.provian/node when the current runtime is dark', () => {
    const r = resolveStoreCapableNodeBin({
      currentExecPath: DARK, currentCanRead: false, candidateBin: CAPABLE,
      exists: () => true, probeBinary: () => true,
    });
    expect(r).toBe(CAPABLE);
  });

  it('RED (no fetched node): dark runtime, no candidate on disk → falls back to current (alarm reports it)', () => {
    const r = resolveStoreCapableNodeBin({
      currentExecPath: DARK, currentCanRead: false, candidateBin: CAPABLE,
      exists: () => false, probeBinary: () => true,
    });
    expect(r).toBe(CAPABLE);
  });

  it('RED (candidate also dark): dark runtime, candidate exists but fails probe → falls back to current', () => {
    const r = resolveStoreCapableNodeBin({
      currentExecPath: DARK, currentCanRead: false, candidateBin: CAPABLE,
      exists: () => true, probeBinary: () => false,
    });
    expect(r).toBe(CAPABLE);
  });
});

describe('nodeBinaryCanReadStore', () => {
  it('runs the store-capability probe against the given binary and reads its exit', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawn = vi.fn((cmd: string, args: string[]) => { calls.push({ cmd, args }); return spawnResult(0); });
    expect(nodeBinaryCanReadStore(CAPABLE, spawn as never)).toBe(true);
    expect(calls[0].cmd).toBe(CAPABLE);
    expect(calls[0].args).toEqual(['-e', STORE_CAPABILITY_PROBE_JS]);
  });

  it('RED: a non-zero probe exit → not capable', () => {
    const spawn = vi.fn(() => spawnResult(1));
    expect(nodeBinaryCanReadStore(CAPABLE, spawn as never)).toBe(false);
  });

  it('RED: a thrown spawn → not capable (never crashes the daemon)', () => {
    const spawn = vi.fn(() => { throw new Error('ENOENT'); });
    expect(nodeBinaryCanReadStore(CAPABLE, spawn as never)).toBe(false);
  });
});

describe('selfHealNodeRuntimeIfNeeded (driver)', () => {
  it('re-exec wiring: capable node, argv, guard env, exit status', () => {
    const spawned: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    let exitCode = -1;
    const run = () => selfHealNodeRuntimeIfNeeded({
      currentCanRead: false,
      currentExecPath: DARK,
      argv: ['/home/a/.provian/agent.js', 'observe'],
      env: { EXISTING: 'x' },
      candidateBin: CAPABLE,
      exists: () => true,
      probeBinary: () => true,
      spawnSync: ((cmd: string, args: string[], opts: Record<string, unknown>) => {
        spawned.push({ cmd, args, env: opts.env as NodeJS.ProcessEnv });
        return spawnResult(7);
      }) as never,
      exit: ((code: number) => { exitCode = code; throw new Error('__exit__'); }) as never,
      log: () => {},
    });
    expect(run).toThrow('__exit__');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cmd).toBe(CAPABLE);
    expect(spawned[0].args).toEqual(['/home/a/.provian/agent.js', 'observe']);
    expect(spawned[0].env[SELFHEAL_GUARD_ENV]).toBe('1');
    expect(spawned[0].env.EXISTING).toBe('x'); // preserves existing env
    expect(exitCode).toBe(7); // exits with the child's status
  });

  it('does NOTHING when the current runtime can read the store (no spawn, no exit)', () => {
    const spawn = vi.fn(() => spawnResult(0));
    const exit = vi.fn();
    selfHealNodeRuntimeIfNeeded({
      currentCanRead: true, currentExecPath: CAPABLE,
      candidateBin: CAPABLE, exists: () => true, probeBinary: () => true,
      spawnSync: spawn as never, exit: exit as never, log: () => {},
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('RED (loop guard): already re-exec\'d → no second re-exec even while dark with a capable candidate', () => {
    const spawn = vi.fn(() => spawnResult(0));
    const exit = vi.fn();
    selfHealNodeRuntimeIfNeeded({
      currentCanRead: false, currentExecPath: DARK,
      env: { [SELFHEAL_GUARD_ENV]: '1' },
      candidateBin: CAPABLE, exists: () => true, probeBinary: () => true,
      spawnSync: spawn as never, exit: exit as never, log: () => {},
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('RED (no candidate on disk): dark runtime, nothing to heal onto → no spawn, no exit', () => {
    const spawn = vi.fn(() => spawnResult(0));
    const exit = vi.fn();
    selfHealNodeRuntimeIfNeeded({
      currentCanRead: false, currentExecPath: DARK,
      candidateBin: CAPABLE, exists: () => false, probeBinary: () => true,
      spawnSync: spawn as never, exit: exit as never, log: () => {},
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

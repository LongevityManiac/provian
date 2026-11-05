/**
 * Grok's SessionStart ensure-running hook body: fast when the shim is up, starts
 * the daemon and waits (bounded ≤ 4 s) when it is down, always fail-open.
 */
import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { ensureDaemonRunning, probeLoopbackPort, ENSURE_RUNNING_MAX_WAIT_MS, type EnsureDeps } from './ensure-running';

function fakeDeps(listeningAfterStartMs: number | null, opts: { upFromStart?: boolean; startThrows?: boolean } = {}) {
  let t = 0;
  let startedAt: number | null = null;
  const calls = { starts: 0, probes: 0 };
  const deps: EnsureDeps = {
    probe: async () => {
      calls.probes += 1;
      if (opts.upFromStart) return true;
      return startedAt !== null && listeningAfterStartMs !== null && t - startedAt >= listeningAfterStartMs;
    },
    start: () => {
      calls.starts += 1;
      if (opts.startThrows) throw new Error('boom');
      startedAt = t;
      return 'detached';
    },
    now: () => t,
    sleep: async (ms) => { t += ms; },
  };
  return { deps, calls, elapsed: () => t };
}

describe('ensureDaemonRunning', () => {
  it('shim already listening → returns at once, never starts anything', async () => {
    const f = fakeDeps(null, { upFromStart: true });
    expect(await ensureDaemonRunning(4320, f.deps)).toBe('already_listening');
    expect(f.calls.starts).toBe(0);
    expect(f.elapsed()).toBe(0);
  });

  it('daemon down → starts it and waits until the shim listens', async () => {
    const f = fakeDeps(900);
    expect(await ensureDaemonRunning(4320, f.deps)).toBe('started_listening');
    expect(f.calls.starts).toBe(1);
    expect(f.elapsed()).toBeGreaterThanOrEqual(900);
    expect(f.elapsed()).toBeLessThan(ENSURE_RUNNING_MAX_WAIT_MS);
  });

  it('never waits past the 4 s bound, even when asked for longer (Grok\'s hook timeout is 5 s)', async () => {
    const f = fakeDeps(null);
    expect(await ensureDaemonRunning(4320, f.deps, 60_000)).toBe('started_timeout');
    expect(f.elapsed()).toBeLessThanOrEqual(ENSURE_RUNNING_MAX_WAIT_MS);
    expect(ENSURE_RUNNING_MAX_WAIT_MS).toBeLessThanOrEqual(4_000);
  });

  it('fail-open: a start that throws is an outcome, never an exception', async () => {
    const f = fakeDeps(null, { startThrows: true });
    expect(await ensureDaemonRunning(4320, f.deps)).toBe('start_failed');
  });
});

describe('probeLoopbackPort', () => {
  it('true for a listening port, false for a closed one', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    expect(await probeLoopbackPort(port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probeLoopbackPort(port)).toBe(false);
  });
});

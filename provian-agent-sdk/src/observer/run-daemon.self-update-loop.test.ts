/**
 * startSelfUpdateLoop cadence ((1B)) — a fail-closed update must RETRY on the
 * daemon's own next tick, not rest on an old release for a full 6 h poll.
 *
 * The loop is self-scheduling: a TRANSIENT outcome (pending_bundle / bundle_hash_
 * mismatch / bundle_fetch_failed / apply_failed) schedules the next tick on the FAST
 * retry cadence with a bounded backoff; a TERMINAL outcome returns to the slow poll.
 * These tests drive only NON-applying outcomes (pending_bundle, no_manifest) so the
 * real apply/re-exec path (process.exit(0)) is never reached.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startSelfUpdateLoop, type SelfUpdateLoopHandle } from './run-daemon';
import { RELEASE_RETRY_INTERVAL_MS } from './self-update';

const SLOW = 6 * 60 * 60 * 1000;

function observerWith(fetchManifest: () => Promise<{ body: unknown; bytes: number; pending?: boolean }>) {
  return {
    fetchReleaseManifest: fetchManifest,
    fetchReleaseBundle: async () => Buffer.from('unused'),
    log: () => {},
  } as never;
}

describe('startSelfUpdateLoop cadence ((1B))', () => {
  let dir: string;
  let target: string;
  let handle: SelfUpdateLoopHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-update-loop-'));
    target = path.join(dir, 'agent.js');
    fs.writeFileSync(target, Buffer.from('OLD BYTES'));
  });
  afterEach(() => {
    handle?.stop();
    handle = null;
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('transient -> FAST retry (with bounded backoff); terminal -> SLOW poll', async () => {
    // tick 1: pending (transient), tick 2: pending (transient), tick 3+: no_manifest (terminal)
    const manifest = vi.fn<() => Promise<{ body: unknown; bytes: number; pending?: boolean }>>()
      .mockResolvedValueOnce({ body: null, bytes: 0, pending: true })
      .mockResolvedValueOnce({ body: null, bytes: 0, pending: true })
      .mockRejectedValue(new Error('ECONNREFUSED')); // -> no_manifest (terminal)

    handle = startSelfUpdateLoop(observerWith(manifest), { targetPath: target, pollIntervalMs: SLOW });

    // Initial tick runs immediately (not via a timer).
    await vi.advanceTimersByTimeAsync(0);
    expect(manifest).toHaveBeenCalledTimes(1);

    // Transient -> fast retry at RELEASE_RETRY_INTERVAL_MS. Not before.
    await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS - 1);
    expect(manifest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(manifest).toHaveBeenCalledTimes(2); // tick 2 — the daemon RETRIED on its own next tick

    // Second consecutive transient -> backoff DOUBLED (2 × fast). It must NOT fire at the
    // single fast interval (that would be red — the backoff isn't bounding retries).
    await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS);
    expect(manifest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS);
    expect(manifest).toHaveBeenCalledTimes(3); // tick 3 fired at 2 × fast

    // tick 3 was TERMINAL (no_manifest) -> next tick is on the SLOW cadence. A fast
    // interval (even many) must NOT fire it — the CONTROL that terminal != fast.
    await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS * 10);
    expect(manifest).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(SLOW);
    expect(manifest).toHaveBeenCalledTimes(4); // slow poll fired
  });

  it('stop() cancels the pending tick — no further polls', async () => {
    const manifest = vi.fn<() => Promise<{ body: unknown; bytes: number; pending?: boolean }>>()
      .mockResolvedValue({ body: null, bytes: 0, pending: true });
    handle = startSelfUpdateLoop(observerWith(manifest), { targetPath: target, pollIntervalMs: SLOW });
    await vi.advanceTimersByTimeAsync(0);
    expect(manifest).toHaveBeenCalledTimes(1);
    handle.stop();
    await vi.advanceTimersByTimeAsync(RELEASE_RETRY_INTERVAL_MS * 5 + SLOW);
    expect(manifest).toHaveBeenCalledTimes(1); // stopped — never ticked again
  });
});

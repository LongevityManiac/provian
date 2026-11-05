/**
 * the verifier scheduler. It only decides WHEN the verifier is asked; these tests pin that
 * it wakes just before the 12th block (finality) or at the first (acceptance at inclusion, ),
 * keeps probing while the burn is invisible, treats probe errors as "not yet", and always returns by
 * the deadline.
 */
import { describe, it, expect } from '@jest/globals';
import { waitForFinalityWindow, type FinalityProbe } from './burn-finality-wait';

function fakeClock(start = 1_000_000) {
  let t = start;
  const naps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { naps.push(ms); t += ms; },
    naps,
    elapsed: () => t - start,
  };
}

/** A chain whose head advances one block per 2 s of fake time; the tx lands in `includedAt`. */
function chainProbe(clock: ReturnType<typeof fakeClock>, opts: { head0: number; includedAt: number | null; visibleAfterMs?: number; blockMs?: number }): FinalityProbe & { calls: number } {
  const start = clock.now();
  const probe = {
    calls: 0,
    async receiptBlock() {
      probe.calls += 1;
      if (opts.includedAt === null) return null;
      return clock.now() - start >= (opts.visibleAfterMs ?? 0) ? opts.includedAt : null;
    },
    async headBlock() {
      probe.calls += 1;
      return opts.head0 + Math.floor((clock.now() - start) / (opts.blockMs ?? 2000));
    },
  };
  return probe;
}

describe('waitForFinalityWindow', () => {
  it('RED: observes 12 inclusive confirmations on a 200ms chain without a 20s sleep', async () => {
    const c = fakeClock();
    const probe = chainProbe(c, { head0: 100, includedAt: 100, blockMs: 200 });
    expect(await waitForFinalityWindow('0xab', { deadlineAtMs: c.now() + 5000, probe, sleep: c.sleep, now: c.now })).toBe(true);
    expect(c.elapsed()).toBeGreaterThanOrEqual(2200);
    expect(c.elapsed()).toBeLessThanOrEqual(2450);
  });
  it('returns at once when the head is already at finality depth', async () => {
    const c = fakeClock();
    const probe = chainProbe(c, { head0: 111, includedAt: 100 });
    await expect(waitForFinalityWindow('0xab', { deadlineAtMs: c.now() + 90_000, probe, sleep: c.sleep, now: c.now })).resolves.toBe(true);
    expect(c.naps).toEqual([]);
  });

  it('uses seconds-based probes until the unchanged confirmation count arrives', async () => {
    const c = fakeClock();
    const probe = chainProbe(c, { head0: 100, includedAt: 100 });
    await expect(waitForFinalityWindow('0xab', { deadlineAtMs: c.now() + 90_000, probe, sleep: c.sleep, now: c.now })).resolves.toBe(true);
    // Neither the delay nor the finality floor assumes a block duration.
    expect(c.naps[0]).toBe(250);
    expect(c.naps.slice(1).every((n) => n === 250)).toBe(true);
    // Seen within one probe interval of the block landing (22 s after inclusion here).
    expect(c.elapsed()).toBeGreaterThanOrEqual(22_000);
    expect(c.elapsed()).toBeLessThanOrEqual(22_000 + 250);
    expect(probe.calls).toBeLessThanOrEqual(180);
  });

  it('keeps probing every 250 ms while the burn is not yet visible', async () => {
    const c = fakeClock();
    const probe = chainProbe(c, { head0: 100, includedAt: 101, visibleAfterMs: 1_000 });
    await expect(waitForFinalityWindow('0xab', { deadlineAtMs: c.now() + 90_000, probe, sleep: c.sleep, now: c.now })).resolves.toBe(true);
    expect(c.naps.slice(0, 4)).toEqual([250, 250, 250, 250]);
  });

  it('gives up at the deadline — never past it — when the burn never becomes final', async () => {
    const c = fakeClock();
    const probe = chainProbe(c, { head0: 100, includedAt: null });
    await expect(waitForFinalityWindow('0xab', { deadlineAtMs: c.now() + 5_000, probe, sleep: c.sleep, now: c.now })).resolves.toBe(false);
    expect(c.elapsed()).toBe(5_000);
  });

  it('treats a probe error as "not yet" and still honours the deadline', async () => {
    const c = fakeClock();
    const probe: FinalityProbe = {
      async receiptBlock() { throw new Error('rate limited'); },
      async headBlock() { return 0; },
    };
    await expect(waitForFinalityWindow('0xab', { deadlineAtMs: c.now() + 1_000, probe, sleep: c.sleep, now: c.now })).resolves.toBe(false);
    expect(c.elapsed()).toBe(1_000);
  });

  it(' at depth 1 it returns the moment the burn is MINED (acceptance), not 12 blocks later', async () => {
    const c = fakeClock();
    const probe = chainProbe(c, { head0: 100, includedAt: 100, visibleAfterMs: 1_500 });
    await expect(waitForFinalityWindow('0xab', { deadlineAtMs: c.now() + 90_000, probe, sleep: c.sleep, now: c.now, confirmations: 1 })).resolves.toBe(true);
    expect(c.elapsed()).toBeGreaterThanOrEqual(1_500);
    expect(c.elapsed()).toBeLessThanOrEqual(1_500 + 250);
  });

  it(' a never-mined burn at depth 1 waits out the deadline and reports false', async () => {
    const c = fakeClock();
    const probe = chainProbe(c, { head0: 100, includedAt: null });
    await expect(waitForFinalityWindow('0xab', { deadlineAtMs: c.now() + 4_000, probe, sleep: c.sleep, now: c.now, confirmations: 1 })).resolves.toBe(false);
    expect(c.elapsed()).toBe(4_000);
  });
});

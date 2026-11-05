/**
 * The capture-health heartbeat is the only thing that wakes an idle agent's Commons poll: when the
 * relay says mail waits, the observer polls now instead of at its hourly safety poll.
 * RED controls: an answer without waiting mail, or no answer at all, wakes nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ProvianObserver } from './ProvianObserver';

const signal = vi.hoisted(() => vi.fn());
vi.mock('../commons-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../commons-events')>()),
  signalCommonsMailWaiting: signal,
}));
import { startCaptureHealthHeartbeat } from './run-daemon';

describe('heartbeat → Commons poll wake', () => {
  it.each([
    [{ deviceRegisteredAtMs: null, commonsMailWaiting: true }, 1],
    [{ deviceRegisteredAtMs: null, commonsMailWaiting: false }, 0],
    [null, 0],
  ])('answer %j wakes the poll %i time(s)', async (answer, wakes) => {
    signal.mockReset();
    const observer = { reportCaptureHealth: vi.fn().mockResolvedValue(answer), getLastWorkPeAtMs: () => null } as unknown as ProvianObserver;
    const timer = startCaptureHealthHeartbeat(observer, null);
    try {
      await vi.waitFor(() => expect(observer.reportCaptureHealth).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 0));
      expect(signal).toHaveBeenCalledTimes(wakes);
    } finally { clearInterval(timer); }
  });
});

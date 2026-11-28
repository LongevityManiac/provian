/**
 * IDLE CHECK-IN CADENCE.
 *
 * A daemon whose agent has captured no work for `IDLE_AFTER_MS` slows its periodic check-ins with
 * the relay (the capture-health heartbeat, the meter mailbox check and the Commons mail poll) to
 * `IDLE_CHECK_IN_INTERVAL_MS`. The moment it captures work again (a work PE is sealed), every
 * check-in returns to its normal cadence: the heartbeat reports at once, the mail poll asks at
 * once, and the mailbox check comes due within its normal interval.
 *
 * Capture itself never slows: the lanes watch locally, and every act reaches the relay on its own
 * schedule. The heartbeat declares the interval until its next report, so the relay and the console
 * judge a quiet device by the cadence it promised (an idle device that misses its own check-in is
 * still dark).
 *
 * Starting the daemon counts as activity, so a freshly started daemon checks in at the normal
 * cadence for its first `IDLE_AFTER_MS`.
 */

/** No captured work for this long makes the daemon idle. */
export const IDLE_AFTER_MS = 60 * 60 * 1000;
/** An idle daemon's check-in interval. */
export const IDLE_CHECK_IN_INTERVAL_MS = 6 * 60 * 60 * 1000;

let startedAtMs = Date.now();
let lastWorkAtMs: number | null = null;
const resumeListeners = new Set<() => void>();

/** Whether the daemon is idle at `nowMs`. */
export function isIdle(nowMs: number = Date.now()): boolean {
  const since = lastWorkAtMs === null ? startedAtMs : Math.max(lastWorkAtMs, startedAtMs);
  return nowMs - since >= IDLE_AFTER_MS;
}

/** The interval a check-in whose normal cadence is `activeMs` waits now. */
export function checkInInterval(activeMs: number, nowMs: number = Date.now()): number {
  return isIdle(nowMs) ? Math.max(activeMs, IDLE_CHECK_IN_INTERVAL_MS) : activeMs;
}

/** A work PE was sealed. When the daemon was idle, every check-in resumes its normal cadence now. */
export function noteCapturedWork(atMs: number = Date.now()): void {
  const wasIdle = isIdle(atMs);
  if (lastWorkAtMs === null || atMs > lastWorkAtMs) lastWorkAtMs = atMs;
  if (!wasIdle) return;
  for (const listener of [...resumeListeners]) {
    try { listener(); } catch { /* a check-in's wake never stops the others */ }
  }
}

/** Called each time captured work ends an idle stretch. Returns the unsubscribe. */
export function onWorkResumed(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => { resumeListeners.delete(listener); };
}

/** Test seam: start the clock over with no captured work (listeners stay registered). */
export function resetIdleCadenceForTests(nowMs: number = Date.now()): void {
  startedAtMs = nowMs;
  lastWorkAtMs = null;
}

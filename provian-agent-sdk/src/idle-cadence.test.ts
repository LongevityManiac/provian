/**
 * Idle check-ins: a daemon whose agent captures nothing for an hour slows its heartbeat, mailbox
 * check and Commons poll to the idle cadence, declares the interval in its report, and returns to
 * the normal cadence the moment it captures work. RED controls: an active daemon keeps the normal
 * cadence, and a drain poll is never stretched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IDLE_AFTER_MS,
  IDLE_CHECK_IN_INTERVAL_MS,
  checkInInterval,
  isIdle,
  noteCapturedWork,
  onWorkResumed,
  resetIdleCadenceForTests,
} from './idle-cadence';
import { CAPTURE_HEALTH_INTERVAL_MS, startCaptureHealthHeartbeat } from './observer/run-daemon';
import type { ProvianObserver } from './observer/ProvianObserver';

const T0 = 1_800_000_000_000;

describe('idle cadence', () => {
  beforeEach(() => resetIdleCadenceForTests(T0));

  it('a daemon is idle after an hour without captured work, counted from its start', () => {
    expect(isIdle(T0 + IDLE_AFTER_MS - 1)).toBe(false);
    expect(isIdle(T0 + IDLE_AFTER_MS)).toBe(true);
    expect(checkInInterval(10 * 60_000, T0 + IDLE_AFTER_MS)).toBe(IDLE_CHECK_IN_INTERVAL_MS);
    // RED: an active daemon keeps each check-in's own cadence.
    expect(checkInInterval(10 * 60_000, T0)).toBe(10 * 60_000);
    noteCapturedWork(T0 + 2 * IDLE_AFTER_MS);
    expect(isIdle(T0 + 2 * IDLE_AFTER_MS + 1)).toBe(false);
  });

  it('captured work wakes every check-in only when it ends an idle stretch', () => {
    const wake = vi.fn();
    const off = onWorkResumed(wake);
    try {
      noteCapturedWork(T0 + 1_000);
      expect(wake).not.toHaveBeenCalled();
      noteCapturedWork(T0 + 1_000 + IDLE_AFTER_MS);
      expect(wake).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });
});

describe('capture-health heartbeat', () => {
  beforeEach(() => { vi.useFakeTimers({ now: T0 }); resetIdleCadenceForTests(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports every 10 minutes while active, every 6 hours while idle, and at once when work resumes', async () => {
    const reportCaptureHealth = vi.fn().mockResolvedValue({});
    const observer = { reportCaptureHealth, getLastWorkPeAtMs: () => null } as unknown as ProvianObserver;
    const timer = startCaptureHealthHeartbeat(observer, null);
    const intervals = () => reportCaptureHealth.mock.calls.map((c) => (c[0] as { report_interval_ms: number }).report_interval_ms);
    try {
      expect(intervals()).toEqual([CAPTURE_HEALTH_INTERVAL_MS]);
      await vi.advanceTimersByTimeAsync(IDLE_AFTER_MS);
      // Six active reports in the first hour; the one at the hour declares the idle interval.
      expect(intervals()).toEqual([...Array(6).fill(CAPTURE_HEALTH_INTERVAL_MS), IDLE_CHECK_IN_INTERVAL_MS]);
      // RED for "slows": nothing more for the next six hours (an active daemon would send 35).
      await vi.advanceTimersByTimeAsync(IDLE_CHECK_IN_INTERVAL_MS - 60_000);
      expect(reportCaptureHealth).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reportCaptureHealth).toHaveBeenCalledTimes(8);
      // Captured work: a report at once, declaring the normal cadence, and the normal cadence after it.
      noteCapturedWork(Date.now());
      expect(reportCaptureHealth).toHaveBeenCalledTimes(9);
      expect(intervals().at(-1)).toBe(CAPTURE_HEALTH_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(CAPTURE_HEALTH_INTERVAL_MS);
      expect(reportCaptureHealth).toHaveBeenCalledTimes(10);
    } finally { clearInterval(timer); }
  });
});

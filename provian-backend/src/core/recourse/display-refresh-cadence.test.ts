import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { RECOURSE_RATIO_COLLECTION } from './pool-ratio';
import {
  checkpointDue, refreshRecourseDisplays, RECOURSE_DISPLAY_REFRESH_MS, utcCalendarMonth,
} from './display-refresh-cadence';

const pool = `0x${'ab'.repeat(20)}`;
const now = Date.UTC(2026, 10, 27, 16, 0, 0);
const month = utcCalendarMonth(now);

function setup(rows: { display?: Record<string, unknown>; ratio?: Record<string, unknown> }) {
  const fake = createFakeFirestore();
  if (rows.display) fake.store.set(`${RECOURSE_RATIO_COLLECTION}/display`, rows.display);
  if (rows.ratio) fake.store.set(`${RECOURSE_RATIO_COLLECTION}/${pool}`, rows.ratio);
  const calls = { ratio: 0, display: 0, monthlyApprovals: 0 };
  const refresh = {
    ratio: async () => { calls.ratio++; },
    display: async () => { calls.display++; },
    monthlyApprovals: async () => { calls.monthlyApprovals++; },
  };
  return { db: fake as unknown as Firestore, calls, refresh };
}

describe('Recourse display refresh cadence', () => {
  test('matches the pool contract calendar month, including year boundaries', () => {
    // The contract's calendarMonth: year * 12 + month - 1, from the UTC date.
    expect(utcCalendarMonth(now)).toBe(String(2026 * 12 + 10));
    expect(utcCalendarMonth(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe(String(2026 * 12 + 11));
    expect(utcCalendarMonth(Date.UTC(2027, 0, 1, 0, 0, 0))).toBe(String(2027 * 12));
    expect(utcCalendarMonth(Date.UTC(2028, 1, 29, 12))).toBe(String(2028 * 12 + 1));
  });

  test('a checkpoint younger than 10 minutes is fresh; at 10 minutes it is due', () => {
    expect(checkpointDue({ observedAtMs: now - RECOURSE_DISPLAY_REFRESH_MS + 1 }, now)).toBe(false);
    expect(checkpointDue({ observedAtMs: now - RECOURSE_DISPLAY_REFRESH_MS }, now)).toBe(true);
  });

  test('missing, malformed and future-dated checkpoints are due', () => {
    for (const row of [undefined, null, [], {}, { observedAtMs: '1' }, { observedAtMs: -1 }, { observedAtMs: 1.5 },
      { observedAtMs: now + 1 }]) expect(checkpointDue(row, now)).toBe(true);
  });

  test('the display is due on every run while its month is not the current month', () => {
    const fresh = { observedAtMs: now - 60_000 };
    expect(checkpointDue({ ...fresh, month }, now, { month: true })).toBe(false);
    expect(checkpointDue({ ...fresh, month: String(Number(month) - 1) }, now, { month: true })).toBe(true);
    expect(checkpointDue({ ...fresh }, now, { month: true })).toBe(true);
    // The ratio row carries no month and is not held to one.
    expect(checkpointDue({ ...fresh }, now)).toBe(false);
  });

  test('fresh checkpoints skip both chain refreshes; the approval queue still runs', async () => {
    const { db, calls, refresh } = setup({
      display: { pool, month, observedAtMs: now - 6 * 60_000 },
      ratio: { observedAtMs: now - 6 * 60_000 },
    });
    await expect(refreshRecourseDisplays(db, now, refresh)).resolves.toEqual({ ratio: 'fresh', display: 'fresh' });
    expect(calls).toEqual({ ratio: 0, display: 0, monthlyApprovals: 1 });
  });

  test('stale checkpoints refresh (RED control for the skip above)', async () => {
    const { db, calls, refresh } = setup({
      display: { pool, month, observedAtMs: now - 16 * 60_000 },
      ratio: { observedAtMs: now - 16 * 60_000 },
    });
    await expect(refreshRecourseDisplays(db, now, refresh)).resolves.toEqual({ ratio: 'refreshed', display: 'refreshed' });
    expect(calls).toEqual({ ratio: 1, display: 1, monthlyApprovals: 1 });
  });

  test('each checkpoint is judged on its own', async () => {
    const { db, calls, refresh } = setup({
      display: { pool, month, observedAtMs: now - 60_000 },
      ratio: { observedAtMs: now - 20 * 60_000 },
    });
    await expect(refreshRecourseDisplays(db, now, refresh)).resolves.toEqual({ ratio: 'refreshed', display: 'fresh' });
    expect(calls).toEqual({ ratio: 1, display: 0, monthlyApprovals: 1 });
  });

  test('no display row (so no pool to find the ratio row) refreshes both', async () => {
    const { db, calls, refresh } = setup({ ratio: { observedAtMs: now - 60_000 } });
    await refreshRecourseDisplays(db, now, refresh);
    expect(calls).toEqual({ ratio: 1, display: 1, monthlyApprovals: 1 });
  });

  test('an unreadable store refreshes both', async () => {
    const calls = { ratio: 0, display: 0, monthlyApprovals: 0 };
    const db = { collection: () => { throw new Error('firestore_unavailable'); } } as unknown as Firestore;
    await refreshRecourseDisplays(db, now, {
      ratio: async () => { calls.ratio++; }, display: async () => { calls.display++; },
      monthlyApprovals: async () => { calls.monthlyApprovals++; },
    });
    expect(calls).toEqual({ ratio: 1, display: 1, monthlyApprovals: 1 });
  });

  test('a ratio failure fails the run; display and queue failures do not', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const failing = setup({});
      await expect(refreshRecourseDisplays(failing.db, now, { ...failing.refresh,
        ratio: async () => { throw new Error('recourse_pool_reorg'); } })).rejects.toThrow('recourse_pool_reorg');
      const quiet = setup({});
      await expect(refreshRecourseDisplays(quiet.db, now, {
        ratio: async () => undefined,
        display: async () => { throw new Error('display_down'); },
        monthlyApprovals: async () => { throw new Error('queue_down'); },
      })).resolves.toEqual({ ratio: 'refreshed', display: 'refreshed' });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });
});

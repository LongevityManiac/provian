/**
 * Agent activity-streak regression test.
 *
 * Proves the reputation-only streak is maintained from real day-over-day
 * activity:
 *   - increment: consecutive active UTC days grow streak_days
 *   - reset:     a gap of 2+ days restarts the streak at 1
 *
 * No Genesis reward consumes this value; sustained-activity Genesis is retired.
 * Same-day PEs do not inflate the streak; an out-of-order older PE never
 * decrements; humans and test wallets are skipped.
 */

import { describe, it, expect } from '@jest/globals';
import { computeNextStreak, recordAgentStreak } from './pvt-accrual';

// --- minimal where-capable in-memory Firestore (the ops recordAgentStreak + the
//     sustained scanner query actually use: where('==' / '>='), limit, get, doc,
//     runTransaction with tx.get/tx.update). ---
type Doc = Record<string, unknown>;

function makeFake() {
  const store = new Map<string, Doc>(); // key = `${col}/${id}`
  const ref = (col: string, id: string) => ({ col, id });
  const snapOf = (col: string, id: string) => ({
    id,
    ref: ref(col, id),
    exists: store.has(`${col}/${id}`),
    data: () => store.get(`${col}/${id}`),
  });
  const queryDocs = (col: string, preds: Array<(d: Doc) => boolean>) =>
    [...store.entries()]
      .filter(([k]) => k.startsWith(`${col}/`))
      .filter(([, d]) => preds.every((p) => p(d)))
      .map(([k]) => snapOf(col, k.slice(col.length + 1)));

  const collection = (col: string) => {
    const build = (preds: Array<(d: Doc) => boolean>): Record<string, unknown> => ({
      where(field: string, op: string, val: unknown) {
        const p = (d: Doc) =>
          op === '=='
            ? d[field] === val
            : op === '>='
              ? typeof d[field] === 'number' && (d[field] as number) >= (val as number)
              : false;
        return build([...preds, p]);
      },
      limit(n: number) {
        return { async get() { const docs = queryDocs(col, preds).slice(0, n); return { empty: docs.length === 0, docs }; } };
      },
      async get() { const docs = queryDocs(col, preds); return { empty: docs.length === 0, docs }; },
    });
    return {
      ...build([]),
      doc(id: string) {
        return { ref: ref(col, id), async get() { return snapOf(col, id); } };
      },
    };
  };

  return {
    store,
    collection,
    async runTransaction(fn: (tx: { get: (r: { col: string; id: string }) => Promise<unknown>; update: (r: { col: string; id: string }, data: Doc) => void }) => Promise<void>) {
      await fn({
        async get(r) { return snapOf(r.col, r.id); },
        update(r, data) { store.set(`${r.col}/${r.id}`, { ...(store.get(`${r.col}/${r.id}`) ?? {}), ...data }); },
      });
    },
  };
}

const DAY = 86_400_000;
const D0 = Date.parse('2026-03-01T12:00:00Z'); // fixed noon-UTC anchor
const day = (n: number) => D0 + n * DAY;
const streakOf = (fake: ReturnType<typeof makeFake>, id: string) =>
  (fake.store.get(`agent_wallets/${id}`) as { streak_days?: number }).streak_days;

describe('computeNextStreak (pure day math)', () => {
  it('first active day starts the streak at 1', () => {
    expect(computeNextStreak(null, '2026-03-01', 0)).toBe(1);
  });
  it('a consecutive UTC day increments', () => {
    expect(computeNextStreak('2026-03-01', '2026-03-02', 1)).toBe(2);
    expect(computeNextStreak('2026-03-06', '2026-03-07', 6)).toBe(7);
  });
  it('the same UTC day does not change the streak (no inflation)', () => {
    expect(computeNextStreak('2026-03-02', '2026-03-02', 2)).toBeNull();
  });
  it('a gap of 2+ days resets the streak to 1', () => {
    expect(computeNextStreak('2026-03-02', '2026-03-05', 5)).toBe(1);
  });
  it('an out-of-order (older) PE never decrements', () => {
    expect(computeNextStreak('2026-03-05', '2026-03-03', 7)).toBeNull();
  });
});

describe('recordAgentStreak - reputation increment and reset', () => {
  it('builds a 7-day reputation streak, then a gap resets it', async () => {
    const fake = makeFake();
    fake.store.set('agent_wallets/aw_1', {
      agent_id: 'agent_1', wallet_id: 'aw_1', platform: 'mobile', streak_days: 0, last_pe_date: null,
    });

    // Day 0: first PE -> streak 1. A second PE the same day must NOT inflate it.
    await recordAgentStreak(fake as never, 'agent_1', 'agent', day(0));
    await recordAgentStreak(fake as never, 'agent_1', 'agent', day(0) + 3 * 3_600_000);
    expect(streakOf(fake, 'aw_1')).toBe(1);

    // INCREMENT: days 1..6 consecutive -> streak climbs to 7.
    for (let d = 1; d <= 6; d++) await recordAgentStreak(fake as never, 'agent_1', 'agent', day(d));
    expect(streakOf(fake, 'aw_1')).toBe(7);

    // RESET: a multi-day gap breaks the reputation streak.
    await recordAgentStreak(fake as never, 'agent_1', 'agent', day(9)); // skipped days 7 and 8
    expect(streakOf(fake, 'aw_1')).toBe(1);
  });

  it('skips test wallets and humans (no streak accrual, no throw)', async () => {
    const fake = makeFake();
    fake.store.set('agent_wallets/aw_test', {
      agent_id: 'agent_test', platform: 'test', streak_days: 0, last_pe_date: null,
    });
    await recordAgentStreak(fake as never, 'agent_test', 'agent', day(0)); // test wallet -> skipped
    expect(streakOf(fake, 'aw_test')).toBe(0);
    await recordAgentStreak(fake as never, 'a_human', 'human', day(0));     // human -> no query, no-op
    expect(fake.store.has('agent_wallets/a_human')).toBe(false);
  });
});

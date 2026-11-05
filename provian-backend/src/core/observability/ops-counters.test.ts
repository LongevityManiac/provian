import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  bumpOpsCounter,
  flushOpsCounters,
  __resetOpsCountersForTest,
  OPS_COUNTERS_COLLECTION,
} from './ops-counters';

function db(): Firestore {
  return createFakeFirestore() as unknown as Firestore;
}

/** A recording Firestore stub for the write assertions: it counts `.set()` calls, captures
 *  the last payload + merge flag, and can be told to reject. (Used instead of the shared
 *  fake, whose `.set(...,{merge})` does a plain spread and does NOT apply increment sentinels —
 *  and which is money-path-covered, so it must not be edited to teach it that.) */
function recordingDb(opts?: { reject?: boolean }): {
  db: Firestore; setCalls: number; lastPayload: Record<string, unknown> | null; lastMerge: boolean | undefined;
} {
  const state = { setCalls: 0, lastPayload: null as Record<string, unknown> | null, lastMerge: undefined as boolean | undefined };
  const stub = {
    collection: () => ({
      doc: () => ({
        set: async (data: Record<string, unknown>, o?: { merge?: boolean }) => {
          state.setCalls += 1;
          state.lastPayload = data;
          state.lastMerge = o?.merge;
          if (opts?.reject) throw new Error('firestore unavailable');
        },
      }),
    }),
  };
  return {
    db: stub as unknown as Firestore,
    get setCalls() { return state.setCalls; },
    get lastPayload() { return state.lastPayload; },
    get lastMerge() { return state.lastMerge; },
  };
}

/** Decode a FieldValue.increment sentinel's operand — the same field the repo's fake reads
 *  (`NumericIncrementTransform.operand`), so this stays bound to the real Firestore contract. */
function incOperand(v: unknown): number | null {
  return v && typeof v === 'object' && typeof (v as { operand?: unknown }).operand === 'number'
    ? (v as { operand: number }).operand : null;
}

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0); // 2026-09-06T12:00:00Z

describe('ops-counters', () => {
  afterEach(() => __resetOpsCountersForTest());

  it('flushes accumulated bumps as ONE merged increment write, summed per key', async () => {
    const rec = recordingDb();
    bumpOpsCounter('push.sent', 2);
    bumpOpsCounter('push.sent', 3);
    bumpOpsCounter('email.failed'); // default delta 1
    await flushOpsCounters(rec.db, NOW);
    expect(rec.setCalls).toBe(1);
    expect(rec.lastMerge).toBe(true);
    const payload = rec.lastPayload!;
    expect(payload.day).toBe('2026-09-06');
    // Each bumped key is a summed increment sentinel; 2+3 collapsed to one operand of 5.
    expect(incOperand(payload['push.sent'])).toBe(5);
    expect(incOperand(payload['email.failed'])).toBe(1);
    expect(Object.keys(payload).sort()).toEqual(['day', 'email.failed', 'push.sent']);
  });

  // RED negative control (, empty population): a flush with NOTHING buffered must write
  // NO document. If flush wrote an (empty/day-only) doc unconditionally, setCalls would be 1.
  it('RED control: flushing an empty buffer performs zero writes', async () => {
    const rec = recordingDb();
    await flushOpsCounters(rec.db, NOW);
    expect(rec.setCalls).toBe(0);
  });

  it('performs exactly ONE merged write per flush regardless of key count', async () => {
    const rec = recordingDb();
    bumpOpsCounter('a', 1);
    bumpOpsCounter('b', 2);
    bumpOpsCounter('c', 3);
    await flushOpsCounters(rec.db, NOW);
    expect(rec.setCalls).toBe(1);
  });

  // RED control: a rejecting write must be SWALLOWED (never throw on a background timer),
  // and must still have drained the buffer (so it is not retried forever).
  it('swallows a write failure and drains the buffer', async () => {
    const rec = recordingDb({ reject: true });
    bumpOpsCounter('rpc.error.base', 1);
    await expect(flushOpsCounters(rec.db, NOW)).resolves.toBeUndefined();
    expect(rec.setCalls).toBe(1);
    // buffer was swapped out before the (failed) write → a second flush is a no-op.
    await flushOpsCounters(rec.db, NOW);
    expect(rec.setCalls).toBe(1);
  });

  it('bump ignores empty keys, zero, and non-finite deltas (no NaN in a durable counter)', async () => {
    const rec = recordingDb();
    bumpOpsCounter('', 5);
    bumpOpsCounter('zero', 0);
    bumpOpsCounter('nan', Number.NaN);
    bumpOpsCounter('good', 4);
    await flushOpsCounters(rec.db, NOW);
    const payload = rec.lastPayload!;
    // Only 'good' survived; no '', 'zero', or 'nan' key reaches the durable doc.
    expect(Object.keys(payload).sort()).toEqual(['day', 'good']);
    expect(incOperand(payload.good)).toBe(4);
  });
});

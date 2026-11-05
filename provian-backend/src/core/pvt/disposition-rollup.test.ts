/**
 * Operator-console disposition rollup — write routing, guards, and read summing.
 *
 * The write helpers' JOB is routing (which day/shard bucket) and refusing to
 * touch the rollup on a no-op or an invalid disposition; the arithmetic itself
 * is Firestore's `FieldValue.increment`, which is not re-implemented here. Each
 * guard ships with its RED control (a violating input that MUST fire it).
 */

import {
  CONSOLE_ROLLUP_COLLECTION,
  CONSOLE_ROLLUP_SHARDS,
  adjustConsoleDispositionRollupInTransaction,
  consoleRollupDay,
  consoleRollupDocId,
  consoleRollupShard,
  incrementConsoleDispositionRollupInTransaction,
} from './disposition-rollup';

interface SetCall {
  col: string;
  id: string;
  data: Record<string, unknown>;
  merge: boolean | undefined;
}

function spyTxnDb(): {
  calls: SetCall[];
  db: { collection(name: string): { doc(id: string): { col: string; id: string } } };
  txn: { set(ref: { col: string; id: string }, data: Record<string, unknown>, opts?: { merge?: boolean }): void };
} {
  const calls: SetCall[] = [];
  const db = {
    collection: (col: string) => ({ doc: (id: string) => ({ col, id }) }),
  };
  const txn = {
    set: (ref: { col: string; id: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      calls.push({ col: ref.col, id: ref.id, data, merge: opts?.merge });
    },
  };
  return { calls, db, txn };
}

describe('pvt-console-rollup — pure helpers', () => {
  it('consoleRollupDay is UTC yyyy-mm-dd', () => {
    expect(consoleRollupDay(Date.UTC(2026, 8, 5, 23, 59))).toBe('2026-09-05');
    expect(consoleRollupDay(Date.UTC(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });

  it('consoleRollupShard is deterministic and in range', () => {
    for (const key of ['pe_a', 'pe_b', 'pe_zzz', '', 'x']) {
      const shard = consoleRollupShard(key);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(CONSOLE_ROLLUP_SHARDS);
      expect(consoleRollupShard(key)).toBe(shard); // stable
    }
  });
});

describe('pvt-console-rollup — increment (seal-time)', () => {
  it('writes one blind merge to the sealed disposition on the seal-day/shard bucket', () => {
    const { calls, db, txn } = spyTxnDb();
    const sealMs = Date.UTC(2026, 8, 5, 10);
    incrementConsoleDispositionRollupInTransaction(txn, db, {
      disposition: 'record_only',
      sealMs,
      peId: 'pe_seal_1',
    });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.col).toBe(CONSOLE_ROLLUP_COLLECTION);
    expect(c.id).toBe(consoleRollupDocId('2026-09-05', consoleRollupShard('pe_seal_1')));
    expect(c.merge).toBe(true);
    expect(c.data.day).toBe('2026-09-05');
    expect(c.data.total).toBeDefined(); // FieldValue.increment(1) sentinel
    expect((c.data.counts as Record<string, unknown>).record_only).toBeDefined();
    // Only the sealed disposition is touched.
    expect(Object.keys(c.data.counts as Record<string, unknown>)).toEqual(['record_only']);
  });
});

describe('pvt-console-rollup — adjust (post-seal change) + guards', () => {
  it('moves the count -old/+new on the ORIGINAL seal-day bucket', () => {
    const { calls, db, txn } = spyTxnDb();
    const sealMs = Date.UTC(2026, 8, 1, 10); // sealed on the 1st...
    adjustConsoleDispositionRollupInTransaction(txn, db, {
      fromDisposition: 'pending_evidence',
      toDisposition: 'eligible',
      sealMs, //...adjusted later, but bucket is the seal day
      peId: 'pe_promote_1',
    });
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.id).toBe(consoleRollupDocId('2026-09-01', consoleRollupShard('pe_promote_1')));
    const counts = c.data.counts as Record<string, unknown>;
    expect(Object.keys(counts).sort()).toEqual(['eligible', 'pending_evidence']);
  });

  it('RED CONTROL — no-op when from === to (writes nothing)', () => {
    const { calls, db, txn } = spyTxnDb();
    adjustConsoleDispositionRollupInTransaction(txn, db, {
      fromDisposition: 'eligible',
      toDisposition: 'eligible',
      sealMs: Date.UTC(2026, 8, 1),
      peId: 'pe_x',
    });
    expect(calls).toHaveLength(0);
  });

  it('RED CONTROL — no-op when a side is not a valid disposition (mint_status leaked in)', () => {
    const { calls, db, txn } = spyTxnDb();
    // A caller that accidentally passed mint_status ('minted') or undefined must
    // NOT corrupt the rollup with a bogus bucket key.
    adjustConsoleDispositionRollupInTransaction(txn, db, {
      fromDisposition: 'eligible',
      toDisposition: 'minted',
      sealMs: Date.UTC(2026, 8, 1),
      peId: 'pe_x',
    });
    adjustConsoleDispositionRollupInTransaction(txn, db, {
      fromDisposition: undefined,
      toDisposition: 'eligible',
      sealMs: Date.UTC(2026, 8, 1),
      peId: 'pe_x',
    });
    expect(calls).toHaveLength(0);
  });

  it('RED CONTROL — no-op when sealMs is not finite', () => {
    const { calls, db, txn } = spyTxnDb();
    adjustConsoleDispositionRollupInTransaction(txn, db, {
      fromDisposition: 'pending_evidence',
      toDisposition: 'eligible',
      sealMs: NaN,
      peId: 'pe_x',
    });
    expect(calls).toHaveLength(0);
  });
});

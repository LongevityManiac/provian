/**
 * PE METER cost pass — the applied-batch finality sweep reads from an INDEX
 * (`listFinalitySweepCandidates`): batches still open (`finality_open`) or not covered by the
 * chain's cursor (`cursor_end_n`), never every cycle and batch the signer ever settled.
 *
 * RED control: on the first (unindexed) run the pre-meter full scan DOES read an old, final,
 * covered batch; once indexed, the same old batch is never read — while the open batch, an
 * uncovered batch, and nothing of another signer's, still come back.
 */
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  FINALITY_SWEEP_STATE_COLLECTION,
  SETTLEMENT_BATCHES_COLLECTION,
  SETTLEMENT_BATCH_SCHEMA,
  SETTLEMENT_CYCLES_COLLECTION,
  listFinalitySweepCandidates,
  markBatchFinalityVerified,
  type SettlementDb,
} from './durable-settlement-store';

const SIGNER = '0x' + 'be'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);

function batchDoc(id: string, cycle: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: SETTLEMENT_BATCH_SCHEMA, batch_id: id, cycle_id: cycle, lane: 'standard', epoch: 1,
    policy_hash: '0x' + '0'.repeat(64), cursor_start: '0', cursor_end: '10', recipient_count: 1, claim_count: 1,
    total_minted_atomic: '1', reserved_nonce: 0, calldata: '0x', members: [], status: 'confirmed', dead_reason: null,
    attempts: [], confirmed_tx_hash: '0xabc', confirmed_fee_wei: '1', applied: true, writebacks_complete: true,
    created_at: 1, updated_at: 1, ...fields,
  };
}

/** Wrap a fake so every document a query or point read RETURNS is recorded by id. */
function tracking(fs: ReturnType<typeof createFakeFirestore>): { db: SettlementDb; read: Set<string> } {
  const read = new Set<string>();
  const wrapQuery = (q: unknown): unknown => new Proxy(q as object, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (prop === 'get') {
        return async () => {
          const snap = await (v as () => Promise<{ docs?: { id: string }[]; id?: string; exists?: boolean }>).call(target);
          for (const d of snap.docs ?? []) read.add(d.id);
          if (snap.docs === undefined && snap.exists && typeof snap.id === 'string') read.add(snap.id);
          return snap;
        };
      }
      if (typeof v === 'function' && ['where', 'orderBy', 'limit', 'startAfter', 'doc'].includes(String(prop))) {
        return (...args: unknown[]) => wrapQuery((v as (...a: unknown[]) => unknown).apply(target, args));
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const db = new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'collection') return (name: string) => wrapQuery(target.collection(name));
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as SettlementDb;
  return { db, read };
}

async function seed(fs: ReturnType<typeof createFakeFirestore>, opts: { stamped: boolean }): Promise<void> {
  await fs.collection(SETTLEMENT_CYCLES_COLLECTION).doc('c_old').set({ cycle_id: 'c_old', signer: SIGNER });
  await fs.collection(SETTLEMENT_CYCLES_COLLECTION).doc('c_new').set({ cycle_id: 'c_new', signer: SIGNER });
  await fs.collection(SETTLEMENT_CYCLES_COLLECTION).doc('c_other').set({ cycle_id: 'c_other', signer: OTHER });
  const stamp = (open: boolean, end: number): Record<string, unknown> => (opts.stamped ? { finality_open: open, cursor_end_n: end } : {});
  // An old batch, final and covered: the sweep has nothing to do with it, ever again.
  await fs.collection(SETTLEMENT_BATCHES_COLLECTION).doc('b_old_final')
    .set(batchDoc('b_old_final', 'c_old', { cursor_end: '10', finality_verified: true, ...stamp(false, 10) }));
  // Applied but not yet verified final.
  await fs.collection(SETTLEMENT_BATCHES_COLLECTION).doc('b_open')
    .set(batchDoc('b_open', 'c_new', { cursor_start: '10', cursor_end: '20', ...stamp(true, 20) }));
  // Verified final, but beyond the chain's cursor (what a reorg of it looks like).
  await fs.collection(SETTLEMENT_BATCHES_COLLECTION).doc('b_uncovered')
    .set(batchDoc('b_uncovered', 'c_new', { cursor_start: '20', cursor_end: '30', finality_verified: true, ...stamp(false, 30) }));
  // Another signer's open batch is never this sweep's.
  await fs.collection(SETTLEMENT_BATCHES_COLLECTION).doc('b_other')
    .set(batchDoc('b_other', 'c_other', { finality_verified: false, ...stamp(true, 5) }));
}

const ids = (list: { batch_id: string }[]): string[] => list.map((b) => b.batch_id).sort();
/** Every seeded batch was last touched at t=1; the sweeps below run a month later. */
const LATER = 30 * 24 * 3_600_000;

describe('finality sweep — indexed candidates', () => {
  it('RED: the first (unindexed) run reads the old final batch, then stamps every batch', async () => {
    const fs = createFakeFirestore();
    await seed(fs, { stamped: false });
    const { db, read } = tracking(fs);
    const got = await listFinalitySweepCandidates(db, { signer: SIGNER, chainCursor: 20n, nowMs: LATER });
    expect(ids(got)).toEqual(['b_open', 'b_uncovered']);
    expect(read.has('b_old_final')).toBe(true);
    const old = (await fs.collection(SETTLEMENT_BATCHES_COLLECTION).doc('b_old_final').get()).data();
    expect(old?.finality_open).toBe(false);
    expect(old?.cursor_end_n).toBe(10);
    expect((await fs.collection(FINALITY_SWEEP_STATE_COLLECTION).doc(SIGNER).get()).data()?.indexed).toBe(true);
  });

  it('once indexed: the old final batch is never read; open + uncovered still come back; not another signer\'s', async () => {
    const fs = createFakeFirestore();
    await seed(fs, { stamped: false });
    await listFinalitySweepCandidates(fs as unknown as SettlementDb, { signer: SIGNER, chainCursor: 20n, nowMs: LATER });
    const { db, read } = tracking(fs);
    const got = await listFinalitySweepCandidates(db, { signer: SIGNER, chainCursor: 20n, nowMs: LATER + 1 });
    expect(ids(got)).toEqual(['b_open', 'b_uncovered']);
    expect(read.has('b_old_final')).toBe(false);
    expect(read.size).toBeGreaterThan(0); // it did read (the open batch) — not a vacuous pass
  });

  it('a batch leaves the index when verified final', async () => {
    const fs = createFakeFirestore();
    await seed(fs, { stamped: true });
    await fs.collection(FINALITY_SWEEP_STATE_COLLECTION).doc(SIGNER).set({ indexed: true });
    const db = fs as unknown as SettlementDb;
    await markBatchFinalityVerified(db, { batchId: 'b_open', nowMs: 3, blockNumber: 7, blockHash: '0x' + '1'.repeat(64) });
    const { db: tracked, read } = tracking(fs);
    const got = await listFinalitySweepCandidates(tracked, { signer: SIGNER, chainCursor: 30n, nowMs: LATER });
    expect(ids(got)).toEqual([]);
    expect(read.has('b_open')).toBe(false);
    expect(read.has('b_old_final')).toBe(false);
  });

  it('a batch touched inside the recent window is judged from its own fields even if its index is stale', async () => {
    const fs = createFakeFirestore();
    await seed(fs, { stamped: true });
    await fs.collection(FINALITY_SWEEP_STATE_COLLECTION).doc(SIGNER).set({ indexed: true });
    // Out-of-band edit: verification stripped, index left saying closed, touched just now.
    await fs.collection(SETTLEMENT_BATCHES_COLLECTION).doc('b_old_final')
      .set(batchDoc('b_old_final', 'c_old', { finality_open: false, cursor_end_n: 10, updated_at: LATER - 60_000 }));
    const got = await listFinalitySweepCandidates(fs as unknown as SettlementDb, { signer: SIGNER, chainCursor: 30n, nowMs: LATER });
    expect(ids(got)).toEqual(['b_old_final', 'b_open']);
  });
});

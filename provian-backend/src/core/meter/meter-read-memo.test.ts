/**
 * PE METER cost pass — a batch reads its invariant registry once (`batchPricingReadDb`), and
 * nothing that guards money is ever memoized.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { BATCH_INVARIANT_READ_COLLECTIONS, batchPricingReadDb, memoizedReadDb } from './meter-ingest';
import { METER_ACT_KEYS_COLLECTION, METER_HELD_ACTS_COLLECTION, METER_PENDING_CLAIMS_COLLECTION, METER_DEVICE_TIPS_COLLECTION } from './meter-store';
import { CLAIM_LEDGER_COLLECTION } from '../pvt/wp4/durable-settlement-store';
import { COUNTERPARTY_PAIRS_COLLECTION } from './counterparty-pairs';

/** A store that counts every point read and query it serves. */
function countingDb(): { db: Firestore; reads: () => number } {
  let reads = 0;
  const query = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {
      where: () => q,
      limit: () => q,
      orderBy: () => q,
      get: async () => { reads += 1; return { docs: [], size: 0, empty: true }; },
    };
    return q;
  };
  const db = {
    collection: (name: string) => ({
      ...query(),
      doc: (id: string) => ({ id, path: `${name}/${id}`, get: async () => { reads += 1; return { exists: false, data: () => undefined }; } }),
    }),
    // Like the SDK: a transaction reads through its own reader, never through `ref.get`.
    runTransaction: async <T>(fn: (txn: { get: (r: unknown) => Promise<unknown> }) => Promise<T>) =>
      fn({ get: async () => { reads += 1; return { exists: false, data: () => undefined }; } }),
  };
  return { db: db as unknown as Firestore, reads: () => reads };
}

describe('per-batch pricing read memo', () => {
  it('an invariant registry doc and query are read once per batch, however many acts read them', async () => {
    const { db, reads } = countingDb();
    const memo = batchPricingReadDb(db);
    for (let i = 0; i < 8; i += 1) {
      await memo.collection('agent_wallets').doc('wallet_aw_1').get();
      await memo.collection('service_installs').where('user_id', '==', 'u').get();
      await memo.collection('agent_wallets').where('agent_id', '==', 'a').limit(2).get();
    }
    expect(reads()).toBe(3);
  });

  it('RED: a collection outside the set is read live every time', async () => {
    const { db, reads } = countingDb();
    const memo = batchPricingReadDb(db);
    for (let i = 0; i < 8; i += 1) await memo.collection(METER_ACT_KEYS_COLLECTION).doc('pe_1').get();
    expect(reads()).toBe(8);
  });

  it('a new batch reads afresh (the memo never outlives its batch)', async () => {
    const { db, reads } = countingDb();
    await batchPricingReadDb(db).collection('wallets').doc('w').get();
    await batchPricingReadDb(db).collection('wallets').doc('w').get();
    expect(reads()).toBe(2);
  });

  it('a transactional read is never memoized', async () => {
    const { db, reads } = countingDb();
    const memo = memoizedReadDb(db, () => true);
    const ref = memo.collection('agent_wallets').doc('w');
    await ref.get();
    await ref.get();
    await memo.runTransaction(async (txn) => {
      await txn.get(ref);
      await txn.get(ref);
      return null;
    });
    // One memoized point read, and both transactional reads live.
    expect(reads()).toBe(3);
  });

  it('nothing that guards money is in the memoized set', () => {
    const guarded = [
      METER_ACT_KEYS_COLLECTION, METER_HELD_ACTS_COLLECTION, METER_PENDING_CLAIMS_COLLECTION, METER_DEVICE_TIPS_COLLECTION,
      CLAIM_LEDGER_COLLECTION, COUNTERPARTY_PAIRS_COLLECTION, 'artifact_novelty_claims', 'device_occurrence_mint_claims',
      'commit_mint_claims', 'completion_mint_claims', 'financial_settlement_mint_claims', 'occurrence_mint_claims',
      'x402_tx_mint_claims', 'pe_economic_aggregates', 'actor_stats_v1', 'device_session_lineage_v1', 'devices',
      'origin_reference_graph_v1', 'meter_pair_counts_v1', 'output_digest_index_v1',
    ];
    for (const c of guarded) expect(BATCH_INVARIANT_READ_COLLECTIONS.has(c)).toBe(false);
    expect(BATCH_INVARIANT_READ_COLLECTIONS.size).toBeGreaterThan(0);
  });
});

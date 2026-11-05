/**
 * Test support: an in-memory PE store whose PEs went out in one accepted batch, optionally with
 * that batch's anchor proof filed (the state a device reaches once its day is anchored).
 */

import {
  actRecordOf,
  actsRootOf,
  batchLeafOf,
  MemoryPeStore,
  METER_GENESIS_PREV_HASH,
  peHashOf,
  PE_V2_SCHEMA,
  type PeV2,
  type StoredPeV2,
} from '@provian/agent-sdk';

export const STORE_DEVICE_ID = 'dev_' + 'c3'.repeat(32);
export const STORE_ACTOR_ID = 'wallet_aw_presenter';

export async function anchoredMemoryStore(options: { readonly anchored?: boolean } = {}): Promise<{ store: MemoryPeStore; pes: StoredPeV2[] }> {
  const store = new MemoryPeStore(STORE_DEVICE_ID);
  const pes: StoredPeV2[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  for (let i = 0; i < 2; i++) {
    const base: PeV2 = {
      schema: PE_V2_SCHEMA, pe_id: `pe_cli_${i}`, device_id: STORE_DEVICE_ID, prev_hash: prev,
      timestamp: 1_790_000_000_000 + i, action_type: 'coding_session', metadata: { commit_sha: String(i).repeat(40) },
    };
    const pe: StoredPeV2 = { ...base, pe_hash: peHashOf(base) };
    const r = await store.append(pe);
    if (!r.ok) throw new Error('append failed');
    pes.push(pe);
    prev = pe.pe_hash;
  }
  const actsRoot = actsRootOf(pes.map(actRecordOf));
  const batchHash = 'd4'.repeat(32);
  await store.recordBatch({
    seq: 1, batch_hash: batchHash, prev_batch_hash: METER_GENESIS_PREV_HASH, acts_root: actsRoot, first_index: 0,
    count: pes.length, last_pe_hash: prev, created_at_ms: 1, accepted_at_ms: 1_790_003_600_000, actor_id: STORE_ACTOR_ID,
    totals: { eligible_points_atomic: '2000000000000000000', acts: 2, eligible: 2 },
  }, null);
  if (options.anchored !== false) {
    await store.recordProof({
      seq: 1, batch_hash: batchHash, acts_root: actsRoot, actor_id: STORE_ACTOR_ID,
      batch_leaf: batchLeafOf({ device_id: STORE_DEVICE_ID, actor_id: STORE_ACTOR_ID, seq: 1, batch_hash: batchHash, acts_root: actsRoot }),
      anchor: {
        day: '2026-10-02', anchor_batch_id: '0x' + '9'.repeat(64), leaf_index: 0, leaf_count: 1, leaf_hash: '0x' + '8'.repeat(64),
        proof: ['0x' + '7'.repeat(64)], merkle_root: '0x' + '6'.repeat(64), anchor_tx_hash: null, anchored_at_ms: 2,
      },
      fetched_at_ms: 3,
      verified: true,
    });
  }
  return { store, pes };
}

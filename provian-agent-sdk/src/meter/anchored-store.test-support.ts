/**
 * Test support: a MemoryPeStore holding PEs in one accepted batch, optionally with that batch's
 * anchor proof filed — the state a device is in once its day is anchored and proofs are fetched.
 */

import { actRecordOf, actsRootOf, batchLeafOf, METER_GENESIS_PREV_HASH, peHashOf, PE_V2_SCHEMA, type PeV2 } from '../meter-wire';
import { MemoryPeStore, type StoredPeV2 } from './pe-store';

export const ANCHORED_DEVICE_ID = 'dev_' + 'a1'.repeat(32);
export const ANCHORED_ACTOR_ID = 'wallet_aw_presenter';

export async function anchoredStore(options: { readonly pes?: number; readonly anchored?: boolean; readonly batched?: boolean } = {}): Promise<{
  store: MemoryPeStore;
  pes: StoredPeV2[];
  batchHash: string;
  actsRoot: string;
}> {
  const store = new MemoryPeStore(ANCHORED_DEVICE_ID);
  const pes: StoredPeV2[] = [];
  let prev = METER_GENESIS_PREV_HASH;
  for (let i = 0; i < (options.pes ?? 2); i++) {
    const base: PeV2 = {
      schema: PE_V2_SCHEMA, pe_id: `pe_anchored_${i}`, device_id: ANCHORED_DEVICE_ID, prev_hash: prev,
      timestamp: 1_790_000_000_000 + i * 60_000, action_type: 'agent_tool_orchestration',
      description: `turn ${i}`, metadata: { tool_count: i + 1, turn_id: `tc:${i}` }, compute: null,
    };
    const pe: StoredPeV2 = { ...base, pe_hash: peHashOf(base) };
    const appended = await store.append(pe);
    if (!appended.ok) throw new Error(`append failed: ${appended.reason}`);
    pes.push(pe);
    prev = pe.pe_hash;
  }
  const actsRoot = actsRootOf(pes.map(actRecordOf));
  const batchHash = 'b0'.repeat(32);
  if (options.batched === false) return { store, pes, batchHash, actsRoot };
  await store.recordBatch({
    seq: 1, batch_hash: batchHash, prev_batch_hash: METER_GENESIS_PREV_HASH, acts_root: actsRoot,
    first_index: 0, count: pes.length, last_pe_hash: prev, created_at_ms: 1, accepted_at_ms: 2,
    actor_id: ANCHORED_ACTOR_ID, totals: null,
  }, null);
  if (options.anchored !== false) {
    await store.recordProof({
      seq: 1, batch_hash: batchHash, acts_root: actsRoot, actor_id: ANCHORED_ACTOR_ID,
      batch_leaf: batchLeafOf({ device_id: ANCHORED_DEVICE_ID, actor_id: ANCHORED_ACTOR_ID, seq: 1, batch_hash: batchHash, acts_root: actsRoot }),
      anchor: {
        day: '2026-10-02', anchor_batch_id: '0x' + '9'.repeat(64), leaf_index: 0, leaf_count: 1,
        leaf_hash: '0x' + '8'.repeat(64), proof: ['0x' + '7'.repeat(64)], merkle_root: '0x' + '6'.repeat(64),
        anchor_tx_hash: '0x' + '5'.repeat(64), anchored_at_ms: 3,
      },
      fetched_at_ms: 4,
      verified: true,
    });
  }
  return { store, pes, batchHash, actsRoot };
}

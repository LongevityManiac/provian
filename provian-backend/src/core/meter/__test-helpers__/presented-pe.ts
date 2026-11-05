/**
 * Test helper: a metered PE its owner holds, with the two-hop inclusion proof the device fetched
 * once its day was anchored, and a fake PEAnchor that "anchored" exactly that batch leaf.
 *
 * Built from the production wire functions (act record, acts root, batch leaf, the anchor leaf
 * rule), so a proof that verifies here verifies in `proveMeterFactInclusion` for the real reason.
 */

import { hashEnvelopeHashLeaf } from '../../pvt/merkle';
import { meterAnchorBatchId } from '../meter-anchor';
import {
  actLeafOf,
  actRecordOf,
  actsRootOf,
  batchLeafOf,
  merkleProofOf,
  peHashOf,
  PE_V2_SCHEMA,
  type PeV2,
} from '../meter-wire';

export const PRESENTED_DAY = '2026-08-01';

export interface PresentedPeFixture {
  readonly pe: PeV2;
  readonly peHash: string;
  readonly inclusion: Record<string, unknown>;
  /** A PEAnchor read contract that knows exactly this batch leaf under the day's meter batch id. */
  readonly anchorContract: { verifyPE(batchId: string, leaf: string, proof: string[]): Promise<boolean> };
  /** The presented-proof entry as a request body carries it. */
  readonly proof: { pe_id: string; envelope_hash: string; pe: PeV2; inclusion: Record<string, unknown> };
}

export function presentedPeFixture(input: {
  readonly actorId: string;
  readonly deviceId?: string;
  readonly peId?: string;
  readonly actionType?: string;
  readonly fields?: Record<string, unknown>;
}): PresentedPeFixture {
  const deviceId = input.deviceId ?? 'dev_presented';
  const pe: PeV2 = {
    ...(input.fields ?? {}),
    schema: PE_V2_SCHEMA,
    pe_id: input.peId ?? 'pe_client_1',
    device_id: deviceId,
    prev_hash: '0'.repeat(64),
    timestamp: Date.parse(`${PRESENTED_DAY}T12:00:00.000Z`),
    action_type: input.actionType ?? 'coding_session',
  };
  const sibling: PeV2 = { ...pe, pe_id: `${pe.pe_id}_sibling`, prev_hash: peHashOf(pe) };
  const acts = [actRecordOf(pe), actRecordOf(sibling)];
  const actsRoot = actsRootOf(acts);
  const batch = { device_id: deviceId, actor_id: input.actorId, seq: 1, batch_hash: 'b'.repeat(64) };
  const batchLeaf = batchLeafOf({ ...batch, acts_root: actsRoot });
  const anchoredLeaf = hashEnvelopeHashLeaf(batchLeaf);
  const batchId = meterAnchorBatchId(PRESENTED_DAY);
  const inclusion = {
    act_index: 0,
    act_proof: merkleProofOf(acts.map(actLeafOf), 0),
    acts_root: actsRoot,
    batch,
    anchor: { day: PRESENTED_DAY, proof: [] as string[] },
  };
  const peHash = peHashOf(pe);
  return {
    pe,
    peHash,
    inclusion,
    anchorContract: {
      verifyPE: async (id: string, leaf: string) => id === batchId && leaf.toLowerCase() === anchoredLeaf.toLowerCase(),
    },
    proof: { pe_id: pe.pe_id, envelope_hash: peHash, pe, inclusion },
  };
}

/**
 * A received batch proof anchored in an intra-day SEGMENT (2026-10-10) is kept when its id is the
 * segment's; the day's id under a segment, or a non-positive segment, is refused.
 */
import { describe, it, expect } from 'vitest';
import { receivedProofOf } from './received-proofs';
import { batchLeafOf, merkleRootOf } from '../meter-wire';
import { anchoredLeafOf, meterAnchorBatchIdOf } from '../pe-export-wire';

const DAY = '2026-10-10';
const identity = { device_id: 'dev_seg', actor_id: 'actor_seg', seq: 1, batch_hash: 'b'.repeat(64), acts_root: merkleRootOf(['c'.repeat(64)]) };
const batchLeaf = batchLeafOf(identity);
const raw = (anchor: Record<string, unknown>) => ({
  ...identity, batch_leaf: batchLeaf, anchored: true, day: DAY, accepted_at_ms: 1,
  anchor: { day: DAY, leaf_index: 0, leaf_count: 1, leaf_hash: anchoredLeafOf(batchLeaf), proof: [], merkle_root: anchoredLeafOf(batchLeaf), anchor_tx_hash: null, anchored_at_ms: 1, ...anchor },
});

describe('receivedProofOf — anchor segments', () => {
  it('GREEN: a segment-1 proof under the segment id is kept with its segment', () => {
    const r = receivedProofOf(raw({ anchor_batch_id: meterAnchorBatchIdOf(DAY, 1), segment: 1 }), 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proof.anchor?.segment).toBe(1);
  });
  it('the day anchor still verifies with no segment', () => {
    const r = receivedProofOf(raw({ anchor_batch_id: meterAnchorBatchIdOf(DAY) }), 5);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proof.anchor?.segment).toBeUndefined();
  });
  it('RED: segment 1 under the DAY id is a batch-id mismatch', () => {
    const r = receivedProofOf(raw({ anchor_batch_id: meterAnchorBatchIdOf(DAY), segment: 1 }), 5);
    expect(r).toEqual({ ok: false, reason: 'anchor_batch_id_mismatch' });
  });
  it('RED: the day id claimed by a segment-1 proof is a batch-id mismatch', () => {
    const r = receivedProofOf(raw({ anchor_batch_id: meterAnchorBatchIdOf(DAY, 1) }), 5);
    expect(r).toEqual({ ok: false, reason: 'anchor_batch_id_mismatch' });
  });
  it('RED: a non-positive segment is malformed', () => {
    const r = receivedProofOf(raw({ anchor_batch_id: meterAnchorBatchIdOf(DAY, 1), segment: 0 }), 5);
    expect(r).toEqual({ ok: false, reason: 'anchor_malformed' });
  });
});

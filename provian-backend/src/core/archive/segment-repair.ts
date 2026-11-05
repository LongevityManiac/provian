import { meterAnchorBatchId } from '../meter/meter-anchor';
import {batchLeafOf} from '../meter/meter-wire';
import { hashEnvelopeHashLeaf, verifyMerkleProof } from '../pvt/merkle';
import type { ArchiveDayDoc, ArchivePartRecord } from './archive-service';

export interface ArchiveSegmentVerifier {
  verifyPE(batchId: string, leaf: string, proof: string[]): Promise<boolean>;
}

/** Repairs index metadata only. The archived ciphertext, PE hashes and accounting stay exact. */
export async function repairArchiveDaySegments(day: ArchiveDayDoc, catalog: Record<string, unknown>, anchor: ArchiveSegmentVerifier) {
  let found = 0;
  let repaired = 0;
  let verified = 0;
  let affectedPes = 0;
  const parts: ArchivePartRecord[] = [];
  for (const part of day.parts) {
    const batches = [];
    for (const batch of part.batches) {
      const original = batch.anchor;
      let segment = original.segment;
      if (original.day !== day.day) throw new Error('archive_anchor_wrong_day');
      const id = original.anchor_batch_id.toLowerCase();
      if (segment === undefined && id !== meterAnchorBatchId(day.day)) {
        found++;
        const match = Object.entries(catalog).find(([key, value]) => /^segment_[1-9][0-9]*$/.test(key)
          && value !== null && typeof value === 'object'
          && (value as Record<string, unknown>).anchor_batch_id === original.anchor_batch_id);
        if (!match) throw new Error(`archive_segment_not_in_catalog:${batch.seq}`);
        segment = Number(match[0].slice('segment_'.length));
        const entry = match[1] as Record<string, unknown>;
        if (typeof entry.merkle_root !== 'string' || entry.merkle_root.toLowerCase() !== original.merkle_root.toLowerCase()) throw new Error('archive_segment_catalog_root_differs');
      }
      if (meterAnchorBatchId(day.day, segment) !== id) throw new Error('archive_anchor_id_mismatch');
      const leaf=batchLeafOf({device_id:part.device_id,actor_id:batch.actor_id,seq:batch.seq,batch_hash:batch.batch_hash,acts_root:batch.acts_root});
      if(leaf!==batch.batch_leaf) throw new Error('archive_batch_identity_mismatch');
      if(!verifyMerkleProof(hashEnvelopeHashLeaf(leaf),[...original.proof],original.merkle_root)) throw new Error('archive_anchor_proof_invalid');
      // Existing correct segments are checked too, making the post-write pass an independent read.
      if (segment !== undefined) {
        if (!await anchor.verifyPE(id, hashEnvelopeHashLeaf(batch.batch_leaf), [...original.proof])) throw new Error(`archive_anchor_not_verified:${batch.seq}`);
        verified++;
      }
      if (segment !== original.segment) { repaired++; affectedPes += batch.count; }
      batches.push(segment === original.segment ? batch : { ...batch, anchor: { ...original, segment } });
    }
    parts.push({ ...part, batches });
  }
  return { parts, found, repaired, verified, affectedPes };
}

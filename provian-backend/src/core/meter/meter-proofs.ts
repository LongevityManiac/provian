/**
 * PE METER — a device's proofs. After the daily anchor, each accepted batch record carries its
 * inclusion proof in that day's on-chain root for 30 days. The device fetches them by sequence
 * number and keeps each with its PEs: an act is then provable by anyone holding the PE, the
 * act's path to its batch's `acts_root` (the device builds it from its own acts), and this proof.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { METER_BATCHES_COLLECTION } from './meter-store';
import type { MeterAnchorProof } from './meter-anchor';

export interface MeterBatchProof {
  /** Where the anchored root is: Base mainnet, the deployed PEAnchor (null when unconfigured). */
  readonly chain_id: 8453;
  readonly anchor_contract: string | null;
  readonly seq: number;
  readonly batch_hash: string;
  readonly batch_leaf: string;
  readonly acts_root: string;
  readonly actor_id: string;
  readonly anchor: MeterAnchorProof;
}

/** The deployed PEAnchor the daily meter root is written to (null when unconfigured or malformed). */
export function anchorContractAddress(): string | null {
  const address = process.env.PE_ANCHOR_CONTRACT_ADDRESS;
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) ? address : null;
}

export function selectedProofHashes(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new Error('batch_hashes_invalid');
  const hashes = raw === '' ? [] : raw.split(',');
  if (hashes.length > 32 || hashes.some(h => !/^[a-f0-9]{64}$/.test(h)) || new Set(hashes).size !== hashes.length) throw new Error('batch_hashes_invalid');
  return hashes;
}

export async function listMeterProofs(
  db: Firestore,
  deviceId: string,
  afterSeq: number,
  limit = 200,
  hashes?: readonly string[],
): Promise<{ readonly proofs: MeterBatchProof[]; readonly next_after_seq: number | null }> {
  const docs = hashes !== undefined
    ? (hashes.length ? await db.getAll(...hashes.map(hash => db.collection(METER_BATCHES_COLLECTION).doc(hash))) : [])
      .filter(doc => doc.exists && doc.data()?.device_id === deviceId && Number(doc.data()?.seq) > afterSeq)
      .sort((a, b) => Number(a.data()?.seq) - Number(b.data()?.seq))
    : (await db.collection(METER_BATCHES_COLLECTION).where('device_id', '==', deviceId)
      .where('seq', '>', afterSeq).orderBy('seq', 'asc').limit(limit).get()).docs;
  const proofs: MeterBatchProof[] = [];
  let last: number | null = null;
  for (const doc of docs) {
    const d = doc.data();
    if (!d) continue;
    last = d.seq as number;
    // Stop at the first unanchored batch: proofs are handed out in sequence, so `after_seq`
    // never skips a batch whose day has not been anchored yet.
    if (d.anchored !== true || d.anchor === null || d.anchor === undefined) {
      return { proofs, next_after_seq: proofs.length > 0 ? proofs[proofs.length - 1].seq : null };
    }
    proofs.push({
      chain_id: 8453,
      anchor_contract: anchorContractAddress(),
      seq: d.seq as number,
      batch_hash: doc.id,
      batch_leaf: d.batch_leaf as string,
      acts_root: d.acts_root as string,
      actor_id: d.actor_id as string,
      anchor: d.anchor as MeterAnchorProof,
    });
  }
  return { proofs, next_after_seq: (hashes !== undefined ? hashes.length === 32 : docs.length === limit) ? last : null };
}

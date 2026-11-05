/**
 * PE METER — proving one act from this device's own store.
 *
 * An act is proven in two hops, both recomputable by anyone holding the PE: the act leaf to its
 * batch's `acts_root` (built here from the batch's own PEs — the relay never had them), then the
 * batch leaf to the day's root anchored on Base (the relay's proof, fetched and kept with the
 * batch). `verifyActInclusion` in `meter-wire.ts` checks the first hop and returns the batch
 * leaf; the second is `PEAnchor.verifyPE(anchor_batch_id, keccak256(0x00 ‖ batch_leaf), proof)`.
 */

import {
  actLeafOf,
  actRecordOf,
  batchLeafOf,
  merkleProofOf,
  merkleRootOf,
  type ActInclusionProof,
  type PeV2,
} from '../meter-wire';
import { PROVIAN_BASE_PE_ANCHOR } from '../presentation-verify';
import type { ArchiveEntry } from '../pe-archive-wire';
import type { PeStore } from './pe-store';

/**
 * Where a PE dropped after its day was confirmed in the paid PE Archive comes back from (
 * B2): `ArchiveKeeper.findArchivedPe` pulls the day, opens it with the owner's key here and
 * verifies the PE against the pointer the store kept.
 */
export interface ArchivedPeSource {
  findArchivedPe(peId: string): Promise<{ ok: true; entry: ArchiveEntry } | { ok: false; reason: string }>;
}

export const BASE_MAINNET_CHAIN_ID = 8453;

export type ActProofResult =
  | { readonly ok: true; readonly proof: ActInclusionProof; readonly anchored: boolean }
  | { readonly ok: false; readonly reason: 'pe_not_found' | 'not_batched_yet' | 'batch_composition_unknown' | 'acts_root_mismatch' };

/** Build the inclusion proof for one of this device's own PEs. */
export async function actInclusionProofFor(
  store: PeStore,
  peId: string,
  options: { readonly chainId?: number; readonly contract?: string } = {},
): Promise<ActProofResult> {
  const stored = await store.findPe(peId);
  if (stored === null) return { ok: false, reason: 'pe_not_found' };
  const covering = (await store.listBatches()).filter(b => stored.index >= b.first_index && stored.index < b.first_index + b.count);
  if (covering.length === 0) return { ok: false, reason: 'not_batched_yet' };
  const complete = covering.filter(b => !b.adopted && b.acts_root !== null && b.actor_id !== null);
  if (complete.length === 0) return { ok: false, reason: 'batch_composition_unknown' };
  const proofs = await store.listProofs();
  let selected: {batch: typeof complete[number]; leaves: string[]; anchor: typeof proofs[number] | undefined} | undefined;
  for (const candidate of complete) {
    const pes = await store.readPes(candidate.first_index, candidate.count);
    const leaves = pes.map(p => actLeafOf(actRecordOf(p.pe)));
    if (merkleRootOf(leaves) !== candidate.acts_root) continue;
    const batchLeaf = batchLeafOf({device_id:store.deviceId,actor_id:candidate.actor_id!,seq:candidate.seq,batch_hash:candidate.batch_hash,acts_root:candidate.acts_root!});
    const anchor = proofs.find(p => p.verified && p.seq === candidate.seq && p.batch_hash === candidate.batch_hash
      && p.acts_root === candidate.acts_root && p.actor_id === candidate.actor_id && p.batch_leaf === batchLeaf);
    if (!selected || anchor) selected = {batch:candidate,leaves,anchor};
    if (anchor) break;
  }
  if (!selected) return { ok: false, reason: 'acts_root_mismatch' };
  const {batch, leaves, anchor} = selected;
  const proof: ActInclusionProof = {
    act_index: stored.index - batch.first_index,
    act_proof: merkleProofOf(leaves, stored.index - batch.first_index),
    acts_root: batch.acts_root!,
    batch: {
      device_id: store.deviceId,
      actor_id: batch.actor_id!,
      seq: batch.seq,
      batch_hash: batch.batch_hash,
    },
    ...(anchor ? {
      anchor: {
        chain_id: options.chainId ?? BASE_MAINNET_CHAIN_ID,
        contract: options.contract ?? PROVIAN_BASE_PE_ANCHOR,
        anchor_batch_id: anchor.anchor.anchor_batch_id,
        day: anchor.anchor.day,
        ...(anchor.anchor.segment !== undefined ? { segment: anchor.anchor.segment } : {}),
        leaf_index: anchor.anchor.leaf_index,
        proof: anchor.anchor.proof,
        merkle_root: anchor.anchor.merkle_root,
        tx_hash: anchor.anchor.anchor_tx_hash,
      },
    } : {}),
  };
  return { ok: true, proof, anchored: anchor !== undefined };
}

/** One pe_fact entry built from this device's store: the PE, its pe_hash and its anchored proof. */
export interface StorePeFact {
  readonly peId: string;
  readonly envelopeHash: string;
  readonly pe: PeV2;
  readonly inclusion: ActInclusionProof;
}

type ActProofFailure = Extract<ActProofResult, { ok: false }>['reason'];
export type StorePeFactFailure = ActProofFailure | 'envelope_hash_mismatch' | 'not_anchored_yet' | 'archived_unavailable';

export type StorePeFactResult =
  | { readonly ok: true; readonly fact: StorePeFact }
  | { readonly ok: false; readonly reason: StorePeFactFailure; readonly detail: string };

const PE_FACT_FAILURE_DETAIL: Readonly<Record<StorePeFactFailure, string>> = {
  pe_not_found: 'is not in this machine\'s PE store (PEs live with the device that recorded them; present it from that device)',
  not_batched_yet: 'has not been sent in a batch yet (batches go hourly; `doctor` shows the store)',
  batch_composition_unknown: 'is in a batch this store adopted from the relay tip, so its proof cannot be rebuilt here',
  acts_root_mismatch: 'does not rebuild its batch\'s acts_root from this store (the store was altered)',
  envelope_hash_mismatch: 'has a different pe_hash in this store than the one given',
  not_anchored_yet: 'is batched but its day is not anchored on Base yet (the daily anchor runs after the UTC day closes; proofs are fetched daily)',
  archived_unavailable: 'was dropped from this machine after its day was confirmed in the PE Archive, and the day could not be pulled back and opened here (the owner key and the relay are both needed)',
};

/**
 * Resolve `<pe_id>` or `<pe_id>:<envelope_hash>` to a presentable pe_fact from this device's own
 * store. The relay keeps no PE, so a pe_fact presentation carries the PE and its two-hop proof;
 * only an anchored act can be presented. A given hash must equal the stored PE's pe_hash.
 */
export async function peFactFromStore(store: PeStore, token: string, archive?: ArchivedPeSource): Promise<StorePeFactResult> {
  const i = token.indexOf(':');
  const peId = i === -1 ? token : token.slice(0, i);
  const claimed = i === -1 ? null : token.slice(i + 1).toLowerCase().replace(/^0x/, '');
  const fail = (reason: StorePeFactFailure, extra = ''): StorePeFactResult => ({
    ok: false, reason, detail: `PE ${peId} ${PE_FACT_FAILURE_DETAIL[reason]}${extra}`,
  });
  const stored = await store.findPe(peId);
  if (stored === null) {
    // Dropped here after its day was confirmed in the PE Archive: pull it back transparently. It
    // presents exactly like a local PE (the archived entry carries the PE and its two-hop proof).
    const pointer = await store.findArchived?.(peId);
    if (!pointer) return fail('pe_not_found');
    if (claimed !== null && claimed !== pointer.pe_hash) return fail('envelope_hash_mismatch');
    if (archive === undefined) return fail('archived_unavailable', ` (archived day ${pointer.day})`);
    const pulled = await archive.findArchivedPe(peId);
    if (!pulled.ok) return fail('archived_unavailable', ` (archived day ${pointer.day}: ${pulled.reason})`);
    const entry = pulled.entry;
    if (entry.inclusion.anchor === undefined) return fail('not_anchored_yet');
    const inclusion: ActInclusionProof = {
      ...entry.inclusion,
      anchor: { ...entry.inclusion.anchor, contract: entry.inclusion.anchor.contract || PROVIAN_BASE_PE_ANCHOR },
    };
    return { ok: true, fact: { peId, envelopeHash: entry.pe.pe_hash, pe: entry.pe, inclusion } };
  }
  if (claimed !== null && claimed !== stored.pe.pe_hash) return fail('envelope_hash_mismatch');
  const built = await actInclusionProofFor(store, peId);
  if (!built.ok) return fail(built.reason);
  if (!built.anchored || built.proof.anchor === undefined) return fail('not_anchored_yet');
  return { ok: true, fact: { peId, envelopeHash: stored.pe.pe_hash, pe: stored.pe, inclusion: built.proof } };
}

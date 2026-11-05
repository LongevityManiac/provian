/**
 * PE METER (app) — proving one of this person's acts from the phone's own store (the relay keeps
 * no PE,), for a `pe_fact` presentation.
 *
 * An act is proven in two hops, both recomputable by anyone holding the PE: the act leaf to its
 * batch's `acts_root` (built here from the batch's own PEs), then the batch leaf to the day's root
 * anchored on Base (the relay's proof, fetched daily and kept with the batch). A PE dropped here
 * after its day was confirmed in the person's PE Archive is pulled back (`phoneArchive.ts`),
 * opened on this phone and checked against the pointer the store kept, then presented the same way.
 * Mirrors `provian-agent-sdk/src/meter/prove.ts`.
 */

import {
    actLeafOf,
    actRecordOf,
    merkleProofOf,
    merkleRootOf,
    type ActInclusionProof,
    type PeV2,
} from './meter-wire';
import type { ArchiveEntry } from './pe-archive-wire';
import type { DeviceChainStore, PhonePeStore } from './phonePeStore';

export const BASE_MAINNET_CHAIN_ID = 8453;

/** Where a PE dropped to the PE Archive comes back from. */
export interface ArchivedPeSource {
    findArchivedPe(peId: string): Promise<{ ok: true; entry: ArchiveEntry } | { ok: false; reason: string }>;
}

export interface PhonePeFact {
    readonly peId: string;
    readonly envelopeHash: string;
    readonly pe: PeV2 & { readonly pe_hash: string };
    readonly inclusion: ActInclusionProof;
}

export type PhonePeFactFailure =
    | 'pe_not_found'
    | 'not_batched_yet'
    | 'batch_composition_unknown'
    | 'acts_root_mismatch'
    | 'envelope_hash_mismatch'
    | 'not_anchored_yet'
    | 'archived_unavailable';

export type PhonePeFactResult =
    | { readonly ok: true; readonly fact: PhonePeFact }
    | { readonly ok: false; readonly reason: PhonePeFactFailure; readonly detail: string | null };

async function chainHolding(store: PhonePeStore, peId: string): Promise<{ chain: DeviceChainStore; archived: boolean } | null> {
    for (const deviceId of store.deviceIds()) {
        const chain = await store.chain(deviceId);
        if ((await chain.findPe(peId)) !== null) return { chain, archived: false };
        if ((await chain.findArchived(peId)) !== null) return { chain, archived: true };
    }
    return null;
}

/** Build the two-hop inclusion proof for one PE this phone holds in full. */
async function inclusionFromChain(chain: DeviceChainStore, peId: string): Promise<{ ok: true; pe: PeV2 & { pe_hash: string }; inclusion: ActInclusionProof } | { ok: false; reason: PhonePeFactFailure }> {
    const stored = await chain.findPe(peId);
    if (stored === null) return { ok: false, reason: 'pe_not_found' };
    const batch = (await chain.listBatches()).find((b) => stored.index >= b.first_index && stored.index < b.first_index + b.count);
    if (!batch) return { ok: false, reason: 'not_batched_yet' };
    if (batch.adopted === true || batch.acts_root === null || batch.actor_id === null) return { ok: false, reason: 'batch_composition_unknown' };
    const pes = await chain.readPes(batch.first_index, batch.count);
    if (pes.length !== batch.count) return { ok: false, reason: 'batch_composition_unknown' };
    const leaves = pes.map((p) => actLeafOf(actRecordOf(p.pe)));
    if (merkleRootOf(leaves) !== batch.acts_root) return { ok: false, reason: 'acts_root_mismatch' };
    const anchor = (await chain.listProofs()).find((p) => p.seq === batch.seq && p.batch_hash === batch.batch_hash && p.verified);
    if (anchor === undefined) return { ok: false, reason: 'not_anchored_yet' };
    const at = stored.index - batch.first_index;
    return {
        ok: true,
        pe: stored.pe,
        inclusion: {
            act_index: at,
            act_proof: merkleProofOf(leaves, at),
            acts_root: batch.acts_root,
            batch: { device_id: chain.deviceId, actor_id: batch.actor_id, seq: batch.seq, batch_hash: batch.batch_hash },
            anchor: {
                chain_id: anchor.chain_id ?? BASE_MAINNET_CHAIN_ID,
                contract: anchor.anchor_contract ?? '',
                anchor_batch_id: anchor.anchor.anchor_batch_id,
                day: anchor.anchor.day,
                ...(anchor.anchor.segment !== undefined ? { segment: anchor.anchor.segment } : {}),
                leaf_index: anchor.anchor.leaf_index,
                proof: anchor.anchor.proof,
                merkle_root: anchor.anchor.merkle_root,
                tx_hash: anchor.anchor.anchor_tx_hash,
            },
        },
    };
}

/**
 * Resolve one of this person's PEs to a presentable pe_fact `{pe, pe_hash, inclusion}`. A given
 * hash must equal the held (or pointed-to) pe_hash. Only an anchored act can be presented.
 */
export async function phonePeFact(store: PhonePeStore, peId: string, envelopeHash: string | null, archive?: ArchivedPeSource): Promise<PhonePeFactResult> {
    const want = envelopeHash === null ? null : envelopeHash.toLowerCase().replace(/^0x/, '');
    const held = await chainHolding(store, peId);
    if (held === null) return { ok: false, reason: 'pe_not_found', detail: null };
    if (held.archived) {
        const pointer = await held.chain.findArchived(peId);
        if (pointer === null) return { ok: false, reason: 'pe_not_found', detail: null };
        if (want !== null && want !== pointer.archived.pe_hash) return { ok: false, reason: 'envelope_hash_mismatch', detail: null };
        if (archive === undefined) return { ok: false, reason: 'archived_unavailable', detail: pointer.archived.day };
        const pulled = await archive.findArchivedPe(peId);
        if (!pulled.ok) return { ok: false, reason: 'archived_unavailable', detail: `${pointer.archived.day}: ${pulled.reason}` };
        if (pulled.entry.inclusion.anchor === undefined) return { ok: false, reason: 'not_anchored_yet', detail: null };
        return { ok: true, fact: { peId, envelopeHash: pulled.entry.pe.pe_hash, pe: pulled.entry.pe, inclusion: pulled.entry.inclusion } };
    }
    const built = await inclusionFromChain(held.chain, peId);
    if (!built.ok) return { ok: false, reason: built.reason, detail: null };
    if (want !== null && want !== built.pe.pe_hash) return { ok: false, reason: 'envelope_hash_mismatch', detail: null };
    return { ok: true, fact: { peId, envelopeHash: built.pe.pe_hash, pe: built.pe, inclusion: built.inclusion } };
}

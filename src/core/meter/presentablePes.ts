/**
 * PE METER (app) — which of this person's PEs a `pe_fact` presentation can carry, and resolving
 * the chosen ones to `{pe, inclusion}` BEFORE any burn (the relay keeps no PE,).
 *
 * The list comes from the phone's own store, not the relay: this phone's chains (and chains
 * restored from a previous phone) — PEs held in full, and PEs dropped here after their day was
 * confirmed in the person's PE Archive (pulled back when chosen; ). Copies of a linked
 * agent's PEs are the agent's to present, not this person's, so they are not listed.
 */

import type { PeFact, DisclosedPeRecord } from '../presentation/humanPresentation';
import type { CanonicalDisclosureRequest } from '../presentation/disclosureRequest';
import type { PhonePeStore } from './phonePeStore';
import { phonePeFact, type ArchivedPeSource, type PhonePeFactFailure } from './phoneProve';

export interface PresentablePeRow {
    readonly peId: string;
    readonly hash: string;
    /** null for a PE whose day lives in the Archive (its content is not on this phone). */
    readonly actionType: string | null;
    readonly timestamp: number;
    /** The Archive day this PE is pulled from when presented; null when held here. */
    readonly archivedDay: string | null;
}

/** Newest first. */
export async function listPresentablePes(store: PhonePeStore, limit = 200): Promise<PresentablePeRow[]> {
    const rows: PresentablePeRow[] = [];
    for (const deviceId of store.deviceIds()) {
        const chain = await store.chain(deviceId);
        for (const p of await chain.allPes()) {
            if (p.detail?.hidden === true) continue;
            rows.push({ peId: p.pe.pe_id, hash: p.pe.pe_hash, actionType: p.pe.action_type, timestamp: p.pe.timestamp, archivedDay: null });
        }
        for (const a of await chain.listArchived()) {
            rows.push({ peId: a.archived.pe_id, hash: a.archived.pe_hash, actionType: null, timestamp: a.recorded_at_ms, archivedDay: a.archived.day });
        }
    }
    rows.sort((x, y) => y.timestamp - x.timestamp || (x.peId < y.peId ? -1 : 1));
    return rows.slice(0, limit);
}

export class PeFactUnavailableError extends Error {
    constructor(readonly peId: string, readonly reason: PhonePeFactFailure, readonly detail: string | null) {
        super(`pe_fact_unavailable:${reason}`);
        this.name = 'PeFactUnavailableError';
    }
}

/** Resolve every chosen PE to a complete pe_fact, or throw for the first that cannot be presented. */
export async function resolvePresentedPeFacts(
    store: PhonePeStore,
    chosen: readonly { readonly peId: string; readonly hash: string }[],
    archive: ArchivedPeSource | undefined,
): Promise<PeFact[]> {
    const out: PeFact[] = [];
    for (const c of chosen) {
        const r = await phonePeFact(store, c.peId, c.hash, archive);
        if (!r.ok) throw new PeFactUnavailableError(c.peId, r.reason, r.detail);
        out.push({
            peId: r.fact.peId,
            envelopeHash: r.fact.envelopeHash,
            pe: r.fact.pe as unknown as Record<string, unknown>,
            inclusion: r.fact.inclusion as unknown as Record<string, unknown>,
        });
    }
    return out;
}

// ─── Requester-named disclosure (2026-10-10): what this phone holds for a request ───────────────

const HEX64 = /^[0-9a-f]{64}$/;
/** The pinned hardware roots the relay admits, by sha256 fingerprint → scheme (mirrors the relay's roots). */
export const PINNED_ROOT_SCHEME: Readonly<Record<string, string>> = Object.freeze({
    '594759594b9b61524f6c8ef668f7177f7b9066bc0674f2f49fe9e052be78beb2': 'tpm2_quote',
    '1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932': 'apple_app_attest',
    '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b': 'aws_nitro',
    '102bf659d5419614c9d8e6aecebc80454eb26b1df6a769ac720b9a690b167b48': 'nvidia_cc',
});

function rec(v: unknown): Record<string, unknown> | null {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function digestsOf(pe: Record<string, unknown>): string[] {
    const out: string[] = [];
    const list = pe.output_digests;
    if (!Array.isArray(list)) return out;
    for (const e of list) {
        const raw = rec(e)?.hash;
        const h = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/^sha256:/, '').replace(/^0x/, '') : '';
        if (HEX64.test(h)) out.push(h);
    }
    return out;
}
function isChainVerified(pe: Record<string, unknown>): boolean {
    const md = rec(pe.metadata);
    if (!md || md.verified !== true) return false;
    const ev = rec(md.economic_evidence);
    return [md.tx_hash, md.txHash, ev?.txHash, ev?.tx_hash].some((c) => typeof c === 'string' && /^0x[0-9a-fA-F]{64}$/.test(c));
}

/** Does a held PE plausibly answer the request? The relay verifies and refuses a mismatch; this only selects. */
export function heldPeMatches(pe: Record<string, unknown>, deviceId: string, request: CanonicalDisclosureRequest): boolean {
    const hw = rec(pe.hardware_witness);
    const scheme = typeof hw?.scheme === 'string' ? hw.scheme : null;
    if (request.kind === 'pe') {
        const own = typeof pe.pe_hash === 'string' ? pe.pe_hash.toLowerCase() : '';
        if (!digestsOf(pe).includes(request.output_digest) && own !== request.output_digest) return false;
        if (request.issuer !== undefined) {
            const wanted = PINNED_ROOT_SCHEME[request.issuer];
            if (wanted !== undefined) return scheme === wanted;
            if (request.issuer === 'chain:base') return isChainVerified(pe);
            return false;
        }
        return true;
    }
    if (request.issuer !== undefined) {
        const wanted = PINNED_ROOT_SCHEME[request.issuer];
        if (wanted !== undefined) { if (scheme !== wanted) return false; }
        else if (request.issuer === 'chain:base') { if (!isChainVerified(pe)) return false; }
        else return false;
    }
    if (request.signer !== undefined) {
        if (request.signer === deviceId.toLowerCase()) { if (hw !== null) return false; }
        else if (HEX64.test(request.signer)) { if (hw === null) return false; }
        else return false;
    }
    return true;
}

export interface DisclosureCandidate {
    readonly peId: string;
    readonly hash: string;
    readonly actionType: string;
    readonly timestamp: number;
    readonly deviceId: string;
}

/** The held PEs that answer `request`, newest first, up to its limit (1 for a `pe` request). Archived PEs are not scanned (their content is not here). */
export async function findDisclosureCandidates(store: PhonePeStore, request: CanonicalDisclosureRequest): Promise<DisclosureCandidate[]> {
    const limit = request.kind === 'witness' ? request.limit : 1;
    const rows: DisclosureCandidate[] = [];
    for (const deviceId of store.deviceIds()) {
        const chain = await store.chain(deviceId);
        for (const p of await chain.allPes()) {
            if (p.detail?.hidden === true) continue;
            if (!heldPeMatches(p.pe as unknown as Record<string, unknown>, deviceId, request)) continue;
            rows.push({ peId: p.pe.pe_id, hash: p.pe.pe_hash, actionType: p.pe.action_type, timestamp: p.pe.timestamp, deviceId });
        }
    }
    rows.sort((x, y) => y.timestamp - x.timestamp || (x.peId < y.peId ? -1 : 1));
    return rows.slice(0, limit);
}

/** Resolve chosen candidates to disclosed records (each with its two-hop proof), or throw for the first that cannot be presented. */
export async function resolveDisclosedRecords(
    store: PhonePeStore,
    chosen: readonly { readonly peId: string; readonly hash: string }[],
    archive: ArchivedPeSource | undefined,
): Promise<DisclosedPeRecord[]> {
    const facts = await resolvePresentedPeFacts(store, chosen, archive);
    return facts.map((f) => ({ peId: f.peId, envelopeHash: f.envelopeHash, pe: f.pe ?? {}, inclusion: f.inclusion ?? {} }));
}

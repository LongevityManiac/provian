/**
 * PE METER (app) — the inclusion proofs of PEs OTHER parties sealed to this person (a linked
 * agent's PEs, another device's, the relay's), fetched daily and KEPT WITH THE RECEIVED ROW.
 *
 * Why daily: the relay keeps a batch record only until 30 days after its anchor. A proof that is
 * not fetched by then can never be rebuilt by this phone, so the meter's daily proofs step asks for
 * every held received PE that has none yet, and the complete PE export asks once more for anything
 * still missing.
 *
 *   POST /v1/meter/mobile/batch-proofs   (wallet auth)  {batch_hashes: string[]}  (1..200, hex64)
 *   → { batches: [{ batch_hash, device_id, actor_id, seq, acts_root, batch_leaf, day, accepted_at_ms,
 *                   anchored, chain_id, anchor_contract, anchor|null, act_leaves|null }], missing: [] }
 *
 * Each proof is BUILT and CHECKED here before it is kept: the act's leaf is found among the batch's
 * act leaves (whose root must be the batch's `acts_root`) — or, for an older batch the relay keeps
 * no leaves for, the batch's acts are rebuilt from the copies this person holds, in chain order — the
 * batch leaf must recompute to the relay's, and the batch leaf must fold up to the anchored day root
 * on PEAnchor (chain 8453). Only an anchored, fully checked proof is attached to a row.
 */

import {
    actLeafOf,
    actRecordOf,
    merkleRootOf,
    merkleTreeOf,
    verifyActInclusion,
    type ActInclusionProof,
} from './meter-wire';
import { cpuBudget, type CpuBudget } from './cpuBudget';
import {
    anchoredLeafOf,
    chainOrderOf,
    foldAnchorProof,
    inclusionFromLeaves,
    meterAnchorBatchIdOf,
    PE_EXPORT_BASE_CHAIN_ID,
    PE_EXPORT_PE_ANCHOR,
    withPinnedContract,
    type ExportBatchAnchor,
    type ExportPeStatus,
    type PeV2WithHash,
} from './pe-export-wire';
import { METER_BATCH_PROOFS_PATH, type MeterAnswer } from './meterTransport';
import { isArchivedReceived, type PhonePeStore, type ReceivedPe, type ReceivedRow } from './phonePeStore';

export const BATCH_PROOFS_PATH = METER_BATCH_PROOFS_PATH;
/** The relay answers at most this many batch hashes per call. */
export const BATCH_PROOFS_MAX = 200;

/**
 * `POST /v1/meter/mobile/batch-proofs` (wallet auth): up to 200 batch hashes, and/or one-act
 * `acts_roots` for relay-authored PEs handed over directly (their batch hash is not known here).
 */
export type BatchProofsCall = (batchHashes: readonly string[], actsRoots?: readonly string[]) => Promise<MeterAnswer>;

/** One batch as the relay recorded it, with its anchor proof once its day is anchored. */
export interface RelayBatchProof {
    readonly batch_hash: string;
    readonly device_id: string;
    readonly actor_id: string;
    readonly seq: number;
    readonly acts_root: string;
    readonly batch_leaf: string;
    readonly day: string | null;
    readonly accepted_at_ms: number | null;
    readonly anchored: boolean;
    readonly chain_id: number | null;
    readonly anchor_contract: string | null;
    readonly anchor: ExportBatchAnchor | null;
    /** The batch's act leaves in batch order; null for a batch older than the relay's leaf record. */
    readonly act_leaves: readonly string[] | null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
}

const HEX64 = /^[0-9a-f]{64}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function hex64(v: unknown): v is string {
    return typeof v === 'string' && HEX64.test(v);
}

function parseAnchor(raw: unknown): ExportBatchAnchor | null {
    if (!isRecord(raw)) return null;
    if (typeof raw.day !== 'string' || typeof raw.anchor_batch_id !== 'string' || typeof raw.merkle_root !== 'string') return null;
    if (!(raw.segment === undefined || (typeof raw.segment === 'number' && Number.isSafeInteger(raw.segment) && raw.segment >= 1))) return null;
    if (!Array.isArray(raw.proof) || !raw.proof.every((p) => typeof p === 'string' && BYTES32.test(p))) return null;
    if (typeof raw.leaf_index !== 'number' || !Number.isSafeInteger(raw.leaf_index)) return null;
    return {
        day: raw.day,
        anchor_batch_id: raw.anchor_batch_id,
        ...(raw.segment !== undefined ? { segment: raw.segment as number } : {}),
        leaf_index: raw.leaf_index,
        leaf_count: typeof raw.leaf_count === 'number' ? raw.leaf_count : 0,
        leaf_hash: typeof raw.leaf_hash === 'string' ? raw.leaf_hash : '',
        proof: raw.proof as string[],
        merkle_root: raw.merkle_root,
        tx_hash: typeof raw.anchor_tx_hash === 'string' ? raw.anchor_tx_hash : null,
    };
}

/** Read the relay's answer defensively. Null when it is not the documented shape at all. */
export function parseBatchProofs(body: unknown): { batches: RelayBatchProof[]; missing: string[] } | null {
    if (!isRecord(body) || !Array.isArray(body.batches)) return null;
    const batches: RelayBatchProof[] = [];
    for (const b of body.batches) {
        if (!isRecord(b) || !hex64(b.batch_hash) || !hex64(b.acts_root) || !hex64(b.batch_leaf)) continue;
        if (typeof b.device_id !== 'string' || typeof b.actor_id !== 'string' || typeof b.seq !== 'number' || !Number.isSafeInteger(b.seq)) continue;
        const leaves = Array.isArray(b.act_leaves) && b.act_leaves.every(hex64) ? (b.act_leaves as string[]) : null;
        batches.push({
            batch_hash: b.batch_hash,
            device_id: b.device_id,
            actor_id: b.actor_id,
            seq: b.seq,
            acts_root: b.acts_root,
            batch_leaf: b.batch_leaf,
            day: typeof b.day === 'string' ? b.day : null,
            accepted_at_ms: typeof b.accepted_at_ms === 'number' ? b.accepted_at_ms : null,
            anchored: b.anchored === true,
            chain_id: typeof b.chain_id === 'number' ? b.chain_id : null,
            anchor_contract: typeof b.anchor_contract === 'string' ? b.anchor_contract : null,
            anchor: parseAnchor(b.anchor),
            act_leaves: leaves,
        });
    }
    const missing = Array.isArray(body.missing) ? body.missing.filter((m): m is string => typeof m === 'string') : [];
    return { batches, missing };
}

export interface BatchProofLookup {
    /** Every call answered with the documented shape. */
    readonly ok: boolean;
    readonly found: ReadonlyMap<string, RelayBatchProof>;
    /** Batch hashes the relay answered it does not hold (never accepted, or dropped 30 days after its anchor). */
    readonly missing: ReadonlySet<string>;
}

/** Ask the relay for these batches, at most 200 per call. Never throws. */
export async function lookupBatchProofs(call: BatchProofsCall, hashes: readonly string[]): Promise<BatchProofLookup> {
    const unique = [...new Set(hashes.filter(hex64))].sort();
    const found = new Map<string, RelayBatchProof>();
    const missing = new Set<string>();
    let ok = true;
    for (let i = 0; i < unique.length; i += BATCH_PROOFS_MAX) {
        const slice = unique.slice(i, i + BATCH_PROOFS_MAX);
        let answer: MeterAnswer;
        try {
            answer = await call(slice);
        } catch {
            ok = false;
            continue;
        }
        const parsed = answer.status === 200 ? parseBatchProofs(answer.body) : null;
        if (parsed === null) {
            ok = false;
            continue;
        }
        const asked = new Set(slice);
        for (const b of parsed.batches) if (asked.has(b.batch_hash)) found.set(b.batch_hash, b);
        for (const m of parsed.missing) if (asked.has(m) && !found.has(m)) missing.add(m);
    }
    return { ok, found, missing };
}

/**
 * The root of the one-act batch a relay-authored PE was priced in: a relay batch holds exactly that
 * act, so its `acts_root` is the root of a one-leaf tree over the PE's act leaf.
 */
export function oneActRootOf(pe: PeV2WithHash): string {
    return merkleRootOf([actLeafOf(actRecordOf(pe))]);
}

/** Ask the relay for relay-authored one-act batches by their root, at most 200 per call. Never throws. */
export async function lookupRelayBatchesByRoot(call: BatchProofsCall, roots: readonly string[]): Promise<BatchProofLookup> {
    const unique = [...new Set(roots.filter(hex64))].sort();
    const found = new Map<string, RelayBatchProof>();
    const missing = new Set<string>();
    let ok = true;
    for (let i = 0; i < unique.length; i += BATCH_PROOFS_MAX) {
        const slice = unique.slice(i, i + BATCH_PROOFS_MAX);
        let answer: MeterAnswer;
        try {
            answer = await call([], slice);
        } catch {
            ok = false;
            continue;
        }
        const parsed = answer.status === 200 ? parseBatchProofs(answer.body) : null;
        if (parsed === null) {
            ok = false;
            continue;
        }
        const asked = new Set(slice);
        // Keyed by the root asked: only a relay device's one-act batch answers a root.
        for (const b of parsed.batches) if (asked.has(b.acts_root) && b.device_id.startsWith('relay:')) found.set(b.acts_root, b);
        const body = answer.body as { missing_acts_roots?: unknown };
        if (Array.isArray(body.missing_acts_roots)) {
            for (const m of body.missing_acts_roots) if (typeof m === 'string' && asked.has(m) && !found.has(m)) missing.add(m);
        }
    }
    return { ok, found, missing };
}

export type InclusionCheck =
    | { readonly ok: true; readonly anchored: boolean; readonly inclusion: ActInclusionProof; readonly batch_leaf: string }
    | { readonly ok: false; readonly reason: string };

/**
 * Check an inclusion proof the way a verifier of the export will: the act to its `acts_root`, and —
 * when an anchor is present — the batch leaf up to the day root, the day's anchor batch id, and the
 * pinned PEAnchor contract on chain 8453. Returns the proof with the contract filled.
 */
export function checkInclusionToRoot(pe: PeV2WithHash, inclusion: ActInclusionProof): InclusionCheck {
    let hop: ReturnType<typeof verifyActInclusion>;
    try {
        hop = verifyActInclusion(pe, inclusion);
    } catch {
        return { ok: false, reason: 'inclusion_malformed' };
    }
    if (!hop.ok) return { ok: false, reason: hop.reason };
    if (inclusion.anchor === undefined) return { ok: true, anchored: false, inclusion, batch_leaf: hop.batch_leaf };
    const pinned = withPinnedContract(inclusion);
    const a = pinned.anchor;
    if (a === undefined) return { ok: true, anchored: false, inclusion: pinned, batch_leaf: hop.batch_leaf };
    if (a.contract.toLowerCase() !== PE_EXPORT_PE_ANCHOR.toLowerCase()) return { ok: false, reason: 'anchor_contract_untrusted' };
    if (a.chain_id !== PE_EXPORT_BASE_CHAIN_ID) return { ok: false, reason: 'anchor_chain_untrusted' };
    try {
        if (meterAnchorBatchIdOf(a.day, a.segment) !== a.anchor_batch_id.toLowerCase()) return { ok: false, reason: 'anchor_batch_id_mismatch' };
        if (foldAnchorProof(anchoredLeafOf(hop.batch_leaf), a.proof) !== a.merkle_root.toLowerCase()) return { ok: false, reason: 'anchor_proof_mismatch' };
    } catch {
        return { ok: false, reason: 'anchor_malformed' };
    }
    return { ok: true, anchored: true, inclusion: pinned, batch_leaf: hop.batch_leaf };
}

export interface ReceivedProofOutcome {
    readonly status: ExportPeStatus;
    readonly inclusion: ActInclusionProof | null;
    /** Why there is no complete proof (null when anchored). */
    readonly reason: string | null;
}

/**
 * Each batch's tree, built once and shared by every received PE of that batch. Proving the PEs of a
 * batch one by one used to rebuild its whole tree per PE — on the phone (interpreted SHA-256) that
 * was minutes of one unbroken block for a few thousand PEs (live, 2026-10-23).
 */
export interface BatchTrees {
    readonly relay: Map<string, { readonly rootOk: boolean; readonly at: ReadonlyMap<string, number>; readonly proofOf: (i: number) => string[] }>;
    readonly copies: Map<string, {
        readonly ordered: readonly { readonly pe: PeV2WithHash }[] | null;
        readonly at: ReadonlyMap<string, number>;
        readonly rootOk: boolean;
        readonly proofOf: (i: number) => string[];
    }>;
}

export function newBatchTrees(): BatchTrees {
    return { relay: new Map(), copies: new Map() };
}

function relayTreeOf(trees: BatchTrees, record: RelayBatchProof & { readonly act_leaves: readonly string[] }) {
    let t = trees.relay.get(record.batch_hash);
    if (t === undefined) {
        const tree = merkleTreeOf(record.act_leaves);
        const at = new Map<string, number>();
        record.act_leaves.forEach((leaf, i) => { if (!at.has(leaf)) at.set(leaf, i); });
        t = { rootOk: tree.root === record.acts_root, at, proofOf: tree.proofOf };
        trees.relay.set(record.batch_hash, t);
    }
    return t;
}

function copiesTreeOf(trees: BatchTrees, key: string, record: RelayBatchProof, copies: readonly { readonly pe: PeV2WithHash }[]) {
    let t = trees.copies.get(key);
    if (t === undefined) {
        const ordered = chainOrderOf(copies);
        if (ordered === null) {
            t = { ordered: null, at: new Map(), rootOk: false, proofOf: () => [] };
        } else {
            const tree = merkleTreeOf(ordered.map((c) => actLeafOf(actRecordOf(c.pe))));
            const at = new Map<string, number>();
            ordered.forEach((c, i) => { if (!at.has(c.pe.pe_hash)) at.set(c.pe.pe_hash, i); });
            t = { ordered, at, rootOk: tree.root === record.acts_root, proofOf: tree.proofOf };
        }
        trees.copies.set(key, t);
    }
    return t;
}

/** A held received PE v2 and the copies of the same batch this person holds (for an older batch). */
export function receivedInclusionOf(
    row: { readonly pe: PeV2WithHash; readonly from_device: string; readonly batch_hash: string },
    record: RelayBatchProof,
    batchCopies: readonly { readonly pe: PeV2WithHash }[],
    trees: BatchTrees = newBatchTrees(),
): ReceivedProofOutcome {
    const { pe } = row;
    if (record.batch_hash !== row.batch_hash || record.device_id !== row.from_device || pe.device_id !== row.from_device) {
        return { status: 'proof_unavailable', inclusion: null, reason: 'relay_batch_does_not_match_row' };
    }
    const contractOk = record.anchor_contract === null || record.anchor_contract === ''
        || record.anchor_contract.toLowerCase() === PE_EXPORT_PE_ANCHOR.toLowerCase();
    const chainOk = record.chain_id === null || record.chain_id === PE_EXPORT_BASE_CHAIN_ID;
    const anchor = record.anchored && contractOk && chainOk ? record.anchor : null;
    const identity = { device_id: record.device_id, actor_id: record.actor_id, seq: record.seq, batch_hash: record.batch_hash, acts_root: record.acts_root, anchor };
    let inclusion: ActInclusionProof;
    if (record.act_leaves !== null) {
        const tree = relayTreeOf(trees, { ...record, act_leaves: record.act_leaves });
        if (!tree.rootOk) return { status: 'acts_root_mismatch', inclusion: null, reason: 'relay_act_leaves_do_not_match_acts_root' };
        const at = tree.at.get(actLeafOf(actRecordOf(pe))) ?? -1;
        if (at < 0) return { status: 'proof_unavailable', inclusion: null, reason: 'act_not_in_relay_batch' };
        inclusion = inclusionFromLeaves({ ...identity, leaves: record.act_leaves, at, act_proof: tree.proofOf(at) });
    } else {
        const key = `${row.from_device}|${row.batch_hash}|${record.acts_root}`;
        const tree = copiesTreeOf(trees, key, record, batchCopies.filter((c) => c.pe.device_id === row.from_device));
        if (tree.ordered === null) return { status: 'batch_composition_unknown', inclusion: null, reason: 'batch_copies_not_one_chain' };
        const at = tree.at.get(pe.pe_hash) ?? -1;
        if (at < 0) return { status: 'batch_composition_unknown', inclusion: null, reason: 'act_not_among_batch_copies' };
        if (!tree.rootOk) return { status: 'acts_root_mismatch', inclusion: null, reason: 'batch_copies_do_not_rebuild_acts_root' };
        inclusion = inclusionFromLeaves({ ...identity, leaves: [], at, act_proof: tree.proofOf(at) });
    }
    const checked = checkInclusionToRoot(pe, inclusion);
    if (!checked.ok) return { status: 'proof_unavailable', inclusion: null, reason: checked.reason };
    if (checked.batch_leaf !== record.batch_leaf) return { status: 'proof_unavailable', inclusion: null, reason: 'batch_leaf_mismatch' };
    if (!checked.anchored) {
        // The relay says anchored but names no usable anchor (another contract or chain, or none):
        // the act's own hop is kept, the proof to Base is not available.
        return record.anchored
            ? { status: 'proof_unavailable', inclusion: checked.inclusion, reason: 'relay_anchor_unusable' }
            : { status: 'not_anchored_yet', inclusion: checked.inclusion, reason: null };
    }
    return { status: 'anchored', inclusion: checked.inclusion, reason: null };
}

function heldV2(row: ReceivedRow): row is ReceivedPe & { readonly pe: PeV2WithHash } {
    return !isArchivedReceived(row) && row.format !== 'v1_envelope';
}

export interface ReceivedProofsReport {
    readonly ok: boolean;
    /** Rows this run looked at (held received PE v2 with no inclusion yet). */
    readonly considered: number;
    readonly attached: number;
    readonly notAnchoredYet: number;
    /** By mailbox id: what each considered row resolved to. */
    readonly outcomes: ReadonlyMap<string, ReceivedProofOutcome>;
}

/**
 * For every held received PE v2 with no inclusion proof yet, ask the relay for its batch, build and
 * check the proof, and keep every ANCHORED one with its row (rewritten in place and marked for the
 * cloud backup). A row with no batch hash (a relay-authored PE handed over directly) is found by its
 * one-act root and takes its batch from the proof. Never throws.
 */
/** Proven rows are kept in groups this size, so a run cut short keeps what it already proved. */
export const RECEIVED_PROOFS_ATTACH_EVERY = 250;

export async function attachMissingReceivedProofs(
    store: PhonePeStore,
    call: BatchProofsCall,
    options: { readonly budget?: CpuBudget; readonly attachEvery?: number } = {},
): Promise<ReceivedProofsReport> {
    const budget = options.budget ?? cpuBudget();
    const attachEvery = Math.max(1, options.attachEvery ?? RECEIVED_PROOFS_ATTACH_EVERY);
    const rows = (await store.listReceivedRows()).filter(heldV2);
    const wanting = rows.filter((r) => r.inclusion === undefined);
    const outcomes = new Map<string, ReceivedProofOutcome>();
    if (wanting.length === 0) return { ok: true, considered: 0, attached: 0, notAnchoredYet: 0, outcomes };
    const lookup = await lookupBatchProofs(call, wanting.map((r) => r.batch_hash));
    // A relay-authored PE handed over directly has no batch hash here: find its one-act batch by root.
    const direct = wanting.filter((r) => !hex64(r.batch_hash));
    const byRoot = direct.length > 0
        ? await lookupRelayBatchesByRoot(call, direct.map((r) => oneActRootOf(r.pe)))
        : { ok: true, found: new Map<string, RelayBatchProof>(), missing: new Set<string>() };
    const byBatch = new Map<string, (ReceivedPe & { readonly pe: PeV2WithHash })[]>();
    for (const r of rows) {
        const key = `${r.from_device}|${r.batch_hash}`;
        const group = byBatch.get(key);
        if (group === undefined) byBatch.set(key, [r]);
        else group.push(r);
    }
    // One tree per batch, shared by all its rows; rows walked batch by batch so each tree is built once.
    const trees = newBatchTrees();
    const ordered = [...wanting].sort((x, y) => (x.batch_hash < y.batch_hash ? -1 : x.batch_hash > y.batch_hash ? 1 : 0));
    let pending: { mailbox_id: string; pe_hash: string; inclusion: ActInclusionProof }[] = [];
    let attached = 0;
    let notAnchoredYet = 0;
    const flush = async (): Promise<void> => {
        if (pending.length === 0) return;
        const group = pending;
        pending = [];
        attached += (await store.attachReceivedInclusions(group, { budget })).attached;
    };
    const take = (row: ReceivedPe, outcome: ReceivedProofOutcome): void => {
        outcomes.set(row.mailbox_id, outcome);
        if (outcome.status === 'anchored' && outcome.inclusion !== null) pending.push({ mailbox_id: row.mailbox_id, pe_hash: row.pe_hash, inclusion: outcome.inclusion });
        else if (outcome.status === 'not_anchored_yet') notAnchoredYet += 1;
    };
    let current: string | null = null;
    for (const row of ordered) {
        await budget.pace();
        if (row.batch_hash !== current) {
            // Rows are walked batch by batch: a finished batch's tree is not needed again.
            current = row.batch_hash;
            trees.relay.clear();
            trees.copies.clear();
        }
        if (!hex64(row.batch_hash)) {
            const root = oneActRootOf(row.pe);
            const rec = byRoot.found.get(root);
            if (rec === undefined) {
                outcomes.set(row.mailbox_id, {
                    status: 'proof_unavailable',
                    inclusion: null,
                    reason: byRoot.missing.has(root) ? 'relay_holds_no_batch_for_direct_pe' : 'relay_unreachable',
                });
                continue;
            }
            take(row, receivedInclusionOf({ ...row, batch_hash: rec.batch_hash }, rec, [row]));
        } else {
            const record = lookup.found.get(row.batch_hash);
            if (record === undefined) {
                outcomes.set(row.mailbox_id, {
                    status: 'proof_unavailable',
                    inclusion: null,
                    reason: lookup.missing.has(row.batch_hash) ? 'relay_no_longer_holds_batch' : 'relay_unreachable',
                });
                continue;
            }
            take(row, receivedInclusionOf(row, record, byBatch.get(`${row.from_device}|${row.batch_hash}`) ?? [], trees));
        }
        if (pending.length >= attachEvery) await flush();
    }
    await flush();
    return { ok: lookup.ok && byRoot.ok, considered: wanting.length, attached, notAnchoredYet, outcomes };
}

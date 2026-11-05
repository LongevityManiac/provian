/**
 * PE METER (app) — "Export all my PEs": every PE this person owns, in ONE file, in the documented
 * format `provian.pe-export.v1` (docs/PE_PROTOCOL_SPEC.md §14; executable definition `pe-export-wire.ts`).
 *
 * One action collects, in this order:
 *   1. the PE Archive: every day of the person's own that the relay lists, every linked agent's
 *      day sealed to them, and every day a pointer on this phone names — each pulled ONCE and opened
 *      here with the person's own key (the relay serves ciphertext only);
 *   2. `pe` lines: every device chain this phone holds (this phone's own first, then restored
 *      chains of previous phones), each PE with its committed private `detail` and its two-hop
 *      inclusion proof (act → acts_root → anchored day root). A position dropped to the Archive is
 *      filled from the pulled day, checked against the pointer kept here (index, id, hash, link);
 *      PEs of the person's own Archive days that no chain here holds are added from the Archive;
 *   3. `batch` lines: each chain's accepted batches with the relay's receipt and anchor proof;
 *   4. `received` lines: PEs linked agents, other devices and the relay sealed to the person, with
 *      the proof kept with each row (or fetched now through `POST /v1/meter/mobile/batch-proofs`
 *      and kept), plus the copies dropped to a linked agent's Archive and every other PE of the
 *      linked days, pulled back;
 *   5. `legacy` lines: the relay's pre-meter records handed back to the person, and the app's own
 *      activity records that no PE carries as its detail (pre-meter, or not metered yet).
 *
 * Before any of that (`PhoneMeter.exportAllPes`), the relay mailbox is drained: PEs sealed to the
 * person that this phone had not filed yet are fetched, opened and filed (`drainMailboxForPhoneExport`),
 * so they are `received` lines; whatever stays on the relay is counted and named.
 *
 * Nothing that could not be included in full is silently dropped: it is named in the end line's
 * `incomplete` list (and the summary). The finished file is parsed and verified offline here before
 * it is handed over, so the summary states exactly what the file proves. No step needs Provian to
 * VERIFY the file afterwards: only Base (PEAnchor.getBatch) for each day root.
 */

import {
    actLeafOf,
    actRecordOf,
    batchLeafOf,
    merkleRootOf,
    peHashOf,
    type ActInclusionProof,
} from './meter-wire';
import {
    PE_EXPORT_ANCHOR_RULES,
    PE_EXPORT_BASE_CHAIN_ID,
    PE_EXPORT_PE_ANCHOR,
    PE_EXPORT_SCHEMA,
    PE_EXPORT_SPEC_URL,
    anchoredLeafOf,
    exportVerdictOf,
    foldAnchorProof,
    inclusionFromLeaves,
    meterAnchorBatchIdOf,
    parseExport,
    recordHashOf,
    detailMatchesPe,
    serializeExport,
    verifyExportOffline,
    type ExportArchiveDay,
    type ExportBatchAnchor,
    type ExportBatchLine,
    type ExportBodyLine,
    type ExportHeader,
    type ExportLegacyLine,
    type ExportOfflineReport,
    type ExportPeLine,
    type ExportPeStatus,
    type ExportReceivedLine,
    type ExportVerdict,
    type PeV2WithHash,
} from './pe-export-wire';
import type { ArchiveEntry, ArchivePayload } from './pe-archive-wire';
import {
    isArchivedReceived,
    type AcceptedBatch,
    type ArchivedChainRow,
    type PhonePeStore,
    type ReceivedPe,
    type StoredBatchProof,
    type StoredPe,
} from './phonePeStore';
import { attachMissingReceivedProofs, checkInclusionToRoot, type BatchProofsCall, type ReceivedProofOutcome } from './receivedProofs';
import type { ProvenanceEnvelope } from '../provenance/types';
import type { MeterAnswer } from './meterTransport';

/** The PE Archive surface the export needs (`PhoneArchiveKeeper`). */
export interface PhonePeExportArchive {
    readStatus(): Promise<{ readonly wallet: string; readonly on: boolean } | null>;
    listDayKeys(scope: 'own' | 'linked', ownWallet: string): Promise<{ wallet: string; day: string }[] | null>;
    pullDay(
        wallet: string,
        day: string,
        partyId: string,
        options?: { readonly remember?: boolean; readonly fill?: boolean },
    ): Promise<{ ok: true; payloads: ArchivePayload[] } | { ok: false; reason: string }>;
}

/** The app's v1 activity records (the hot tier and this device's month archives). */
export interface PhonePeExportActivity {
    hot(): Promise<ProvenanceEnvelope[]>;
    archived(options: { readonly allowPrompt: boolean }): Promise<ProvenanceEnvelope[] | null>;
}

export type PhonePeExportStage = 'archive' | 'chains' | 'received' | 'legacy' | 'verify';

export interface PhonePeExportProgress {
    readonly stage: PhonePeExportStage;
    /** For `archive`: days pulled so far and how many there are. */
    readonly done?: number;
    readonly total?: number;
}

export interface PhonePeExportDeps {
    /** The phone's PE store, open. */
    readonly store: PhonePeStore;
    /** The PE Archive keeper; null on a build without the Archive. */
    readonly archive: PhonePeExportArchive | null;
    /** `POST /v1/meter/mobile/batch-proofs`; null when unavailable. */
    readonly batchProofs: BatchProofsCall | null;
    readonly activity: PhonePeExportActivity;
    /** When the meter started on this install: earlier activity records are pre-meter. */
    readonly cutoverMs: number | null;
    /** The person's relay wallet id and their wallet's EVM address. */
    readonly owner: { readonly walletId: string | null; readonly address: string | null };
    readonly appVersion: string;
    /**
     * The relay mailbox after the drain that ran just before this export. Absent → the mailbox was
     * not checked, and the export names that.
     */
    readonly mailbox?: PhonePeExportMailbox | null;
    readonly now?: () => number;
    readonly onProgress?: (progress: PhonePeExportProgress) => void;
}

/** The relay mailbox after the export's drain: PEs sealed to the person and not filed on this phone. */
export interface PhonePeExportMailbox {
    /** Items still on the relay that this phone has not filed (null: could not be counted). */
    readonly waiting: number | null;
    /** More pages remained than were read: `waiting` is a lower bound. */
    readonly truncated: boolean;
    /** Why they stay there (`no_message_key`, `unopenable`, `mailbox_unreachable`, …), or null. */
    readonly reason: string | null;
}

export interface PhonePeExportResult {
    /** The file's text (NDJSON, every line canonical, ending in a newline). */
    readonly text: string;
    /** `provian-pe-export-<owner>-<UTC timestamp>.jsonl` */
    readonly fileName: string;
    readonly header: ExportHeader;
    readonly counts: { readonly pe: number; readonly batch: number; readonly received: number; readonly legacy: number };
    /** The file, verified offline here (every hash, link and proof up to each day root). */
    readonly report: ExportOfflineReport;
    /** Gaps in a chain this phone holds (the export left out PEs it should carry). */
    readonly gapsInHeldChains: number;
    readonly incomplete: readonly { readonly what: string; readonly reason: string }[];
    /** Nothing incomplete, no failure, no gap in a held chain. Pending (not yet anchored) lines are allowed. */
    readonly complete: boolean;
    /**
     * The phone's own offline verdict on the file (`exportVerdictOf`, the same rule as
     * `provian verify-export --offline`): `offline_ok` only when nothing is named missing;
     * `offline_incomplete` when the file verifies but names what it does not carry; `failed`.
     */
    readonly verdict: ExportVerdict;
}

type Incomplete = { what: string; reason: string };
type Payloads = readonly ArchivePayload[];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(x: unknown): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function asRecord(x: object): Readonly<Record<string, unknown>> {
    return x as unknown as Readonly<Record<string, unknown>>;
}

/** A PE whose carried hash recomputes (with the hash set from the recomputation when absent). */
function withOwnHash(pe: object, expected: string): PeV2WithHash | null {
    const candidate = { ...(pe as PeV2WithHash), pe_hash: expected };
    try {
        return peHashOf(candidate) === expected ? candidate : null;
    } catch {
        return null;
    }
}

function contractOk(contract: string | null): boolean {
    return contract === null || contract === '' || contract.toLowerCase() === PE_EXPORT_PE_ANCHOR.toLowerCase();
}

/** A stored proof's anchor, only when it folds from this batch leaf to its day root on the pinned contract. */
function checkedBatchAnchor(proof: StoredBatchProof | undefined, batchLeaf: string | null): ExportBatchAnchor | null {
    if (proof === undefined || batchLeaf === null || proof.batch_leaf !== batchLeaf) return null;
    if (!contractOk(proof.anchor_contract) || (proof.chain_id !== null && proof.chain_id !== PE_EXPORT_BASE_CHAIN_ID)) return null;
    const a = proof.anchor;
    try {
        if (meterAnchorBatchIdOf(a.day, a.segment) !== a.anchor_batch_id.toLowerCase()) return null;
        if (foldAnchorProof(anchoredLeafOf(batchLeaf), a.proof) !== a.merkle_root.toLowerCase()) return null;
    } catch {
        return null;
    }
    return {
        day: a.day,
        anchor_batch_id: a.anchor_batch_id,
        ...(a.segment !== undefined ? { segment: a.segment } : {}),
        leaf_index: a.leaf_index,
        leaf_count: a.leaf_count,
        leaf_hash: a.leaf_hash,
        proof: [...a.proof],
        merkle_root: a.merkle_root,
        tx_hash: a.anchor_tx_hash,
    };
}

function batchLeafOfBatch(deviceId: string, b: AcceptedBatch): string | null {
    if (b.adopted === true || b.acts_root === null || b.actor_id === null) return null;
    try {
        return batchLeafOf({ device_id: deviceId, actor_id: b.actor_id, seq: b.seq, batch_hash: b.batch_hash, acts_root: b.acts_root });
    } catch {
        return null;
    }
}

/** `20261006T120000Z` */
function utcStamp(ms: number): string {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function peExportFileName(owner: string | null, nowMs: number): string {
    const who = (owner ?? 'wallet').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'wallet';
    return `provian-pe-export-${who}-${utcStamp(nowMs)}.jsonl`;
}

/** Build the complete export of everything this person holds. Throws only when the store is not open. */
export async function buildPhonePeExport(deps: PhonePeExportDeps): Promise<PhonePeExportResult> {
    const now = deps.now ?? Date.now;
    const progress = (p: PhonePeExportProgress): void => {
        try { deps.onProgress?.(p); } catch { /* progress never breaks the export */ }
    };
    const { store } = deps;
    const incomplete: Incomplete[] = [];
    const ownId = store.ownDeviceId();
    const devices = [ownId, ...store.deviceIds().filter((d) => d !== ownId)];

    // ─── 1. the PE Archive ─────────────────────────────────────────────────────
    progress({ stage: 'archive', done: 0, total: 0 });
    let archiveState: 'on' | 'off' | 'unknown' = 'unknown';
    let walletId = deps.owner.walletId;
    const status = deps.archive ? await deps.archive.readStatus().catch(() => null) : null;
    if (status !== null) {
        archiveState = status.on ? 'on' : 'off';
        walletId = status.wallet;
    }
    const targets = new Map<string, { wallet: string; day: string; kind: 'own' | 'linked' }>();
    const addTarget = (wallet: string, day: string, kind: 'own' | 'linked'): void => {
        if (wallet.length === 0 || !DAY_RE.test(day)) return;
        const key = `${wallet}/${day}`;
        if (!targets.has(key)) targets.set(key, { wallet, day, kind });
    };
    if (deps.archive !== null && walletId !== null) {
        const own = await deps.archive.listDayKeys('own', walletId).catch(() => null);
        if (own === null) incomplete.push({ what: 'archive: the list of your days', reason: 'archive_days_unreadable' });
        else for (const d of own) addTarget(d.wallet, d.day, 'own');
        const linked = await deps.archive.listDayKeys('linked', walletId).catch(() => null);
        if (linked === null) incomplete.push({ what: 'archive: the list of your linked agents\' days', reason: 'linked_days_unreadable' });
        else for (const d of linked) addTarget(d.wallet, d.day, 'linked');
    }
    const chainRows = new Map<string, { held: Map<number, StoredPe>; pointers: Map<number, ArchivedChainRow>; count: number }>();
    for (const device of devices) {
        const chain = await store.chain(device);
        const held = new Map((await chain.allPes()).map((p) => [p.index, p]));
        const pointers = new Map((await chain.listArchived()).map((p) => [p.index, p]));
        chainRows.set(device, { held, pointers, count: (await chain.head()).count });
        for (const p of pointers.values()) addTarget(p.archived.wallet, p.archived.day, 'own');
    }
    const receivedRows = await store.listReceivedRows();
    for (const r of receivedRows) if (isArchivedReceived(r)) addTarget(r.archived.wallet, r.archived.day, 'linked');

    const pulled = new Map<string, Payloads>();
    const dayReasons = new Map<string, string>();
    const archiveDays: ExportArchiveDay[] = [];
    const ordered = [...targets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    let blocked: string | null = null;
    for (let i = 0; i < ordered.length; i++) {
        const [key, t] = ordered[i];
        progress({ stage: 'archive', done: i, total: ordered.length });
        let reason: string | null = null;
        if (deps.archive === null) reason = 'archive_not_available_on_this_build';
        else if (walletId === null) reason = 'owner_wallet_unknown';
        else if (blocked !== null) reason = blocked;
        else {
            // Own days are sealed to the wallet that owns them; a linked agent's days to its linked human.
            const party = t.kind === 'own' ? t.wallet : walletId;
            const r = await deps.archive.pullDay(t.wallet, t.day, party, { remember: false, fill: false })
                .catch((err: unknown): { ok: false; reason: string } => ({ ok: false, reason: `archive_pull_failed:${err instanceof Error ? err.message : String(err)}` }));
            if (r.ok) pulled.set(key, r.payloads);
            else {
                reason = r.reason;
                // Without the person's key no further day can be opened: do not ask again for each one.
                if (r.reason === 'owner_key_unavailable') blocked = r.reason;
            }
        }
        archiveDays.push({ wallet: t.wallet, day: t.day, pulled: reason === null, reason });
        if (reason !== null) {
            dayReasons.set(key, reason);
            incomplete.push({ what: `archive day ${t.wallet} ${t.day}`, reason });
        }
    }
    progress({ stage: 'archive', done: ordered.length, total: ordered.length });
    // Each pulled day indexed once: by (device, position) and by PE hash.
    const byPosition = new Map<string, Map<string, ArchiveEntry>>();
    const byHash = new Map<string, Map<string, ArchiveEntry>>();
    const positionIndex = (key: string): Map<string, ArchiveEntry> => {
        let m = byPosition.get(key);
        if (m === undefined) {
            m = new Map();
            for (const payload of pulled.get(key) ?? []) for (const e of payload.entries) m.set(`${payload.device_id}#${e.index}`, e);
            byPosition.set(key, m);
        }
        return m;
    };
    const hashIndex = (key: string): Map<string, ArchiveEntry> => {
        let m = byHash.get(key);
        if (m === undefined) {
            m = new Map();
            for (const payload of pulled.get(key) ?? []) for (const e of payload.entries) m.set(e.pe.pe_hash, e);
            byHash.set(key, m);
        }
        return m;
    };

    // ─── the relay mailbox (drained before this export) ─────────────────────────
    incomplete.push(...phoneMailboxIncompleteOf(deps.mailbox));

    // ─── the person's activity records (details of PEs, and legacy lines) ────────
    progress({ stage: 'legacy' });
    const activity = new Map<string, { record: ProvenanceEnvelope; preMeter: boolean }>();
    const keep = (envs: readonly ProvenanceEnvelope[], preMeter: boolean): void => {
        for (const e of envs) {
            if (!e || typeof e.envelope_id !== 'string' || activity.has(e.envelope_id)) continue;
            activity.set(e.envelope_id, { record: e, preMeter });
        }
    };
    keep(await store.listLegacy(), true);
    const hot = await deps.activity.hot().catch(() => null);
    if (hot === null) incomplete.push({ what: 'activity records on this phone', reason: 'activity_records_unreadable' });
    else keep(hot, false);
    const warm = await deps.activity.archived({ allowPrompt: true }).catch(() => null);
    if (warm === null) incomplete.push({ what: 'activity records in this phone\'s month archives', reason: 'archive_key_unavailable' });
    else keep(warm, false);
    const detailOf = (pe: PeV2WithHash): Readonly<Record<string, unknown>> | undefined => {
        const rec = activity.get(pe.pe_id)?.record;
        if (rec === undefined || typeof pe.detail_hash !== 'string') return undefined;
        const r = asRecord(rec);
        return detailMatchesPe(r,pe) ? r : undefined;
    };

    // ─── 2. pe lines ───────────────────────────────────────────────────────────
    progress({ stage: 'chains' });
    const peLines: ExportPeLine[] = [];
    const batchLines: ExportBatchLine[] = [];
    const metered = new Set<string>();
    const positions = new Set<string>(); // `${device}#${index}` held here (in full or as a pointer)
    const emitted = new Set<string>();
    for (const device of devices) {
        const rows = chainRows.get(device);
        if (rows === undefined) continue;
        const chain = await store.chain(device);
        for (const p of rows.held.values()) metered.add(p.pe.pe_id);
        for (const p of rows.pointers.values()) metered.add(p.archived.pe_id);
        for (let i = 0; i < rows.count; i++) positions.add(`${device}#${i}`);

        // Positions dropped to the Archive, filled from the pulled day and checked against the pointer.
        const filled = new Map<number, ArchiveEntry>();
        for (const p of rows.pointers.values()) {
            const key = `${p.archived.wallet}/${p.archived.day}`;
            if (!pulled.has(key)) {
                incomplete.push({ what: `pe ${device}#${p.index}`, reason: dayReasons.get(key) ?? 'archive_day_not_pulled' });
                continue;
            }
            const entry = positionIndex(key).get(`${device}#${p.index}`);
            const pe = entry === undefined ? null : withOwnHash(entry.pe, p.archived.pe_hash);
            if (entry === undefined || pe === null || entry.pe.pe_id !== p.archived.pe_id || entry.pe.pe_hash !== p.archived.pe_hash
                || entry.pe.prev_hash !== p.archived.prev_hash || entry.pe.device_id !== device) {
                incomplete.push({ what: `pe ${device}#${p.index}`, reason: 'archive_entry_does_not_match_pointer' });
                continue;
            }
            filled.set(p.index, { ...entry, pe });
        }

        const batches = await chain.listBatches();
        const proofs = (await chain.listProofs()).filter((p) => p.verified);
        const proofOf = (b: AcceptedBatch): StoredBatchProof | undefined =>
            proofs.find((p) => p.seq === b.seq && p.batch_hash === b.batch_hash && p.acts_root === b.acts_root && p.actor_id === b.actor_id);
        const peAt = (i: number): PeV2WithHash | null => rows.held.get(i)?.pe ?? filled.get(i)?.pe ?? null;
        const perBatch = new Map<number, { leaves: string[] | null; status: ExportPeStatus | null; anchor: ExportBatchAnchor | null }>();
        const batchView = (b: AcceptedBatch): { leaves: string[] | null; status: ExportPeStatus | null; anchor: ExportBatchAnchor | null } => {
            const cached = perBatch.get(b.seq);
            if (cached) return cached;
            let view: { leaves: string[] | null; status: ExportPeStatus | null; anchor: ExportBatchAnchor | null };
            const leaf = batchLeafOfBatch(device, b);
            if (leaf === null || b.acts_root === null) view = { leaves: null, status: 'batch_composition_unknown', anchor: null };
            else {
                const pes: PeV2WithHash[] = [];
                for (let i = b.first_index; i < b.first_index + b.count; i++) {
                    const pe = peAt(i);
                    if (pe !== null) pes.push(pe);
                }
                const leaves = pes.length === b.count ? pes.map((p) => actLeafOf(actRecordOf(p))) : null;
                if (leaves === null) view = { leaves: null, status: 'batch_composition_unknown', anchor: null };
                else if (merkleRootOf(leaves) !== b.acts_root) view = { leaves: null, status: 'acts_root_mismatch', anchor: null };
                else {
                    const proof = proofOf(b);
                    const anchor = checkedBatchAnchor(proof, leaf);
                    if (proof !== undefined && anchor === null) incomplete.push({ what: `batch ${device}#${b.seq}`, reason: 'anchor_proof_does_not_check' });
                    view = { leaves, status: anchor === null ? (proof === undefined ? 'not_anchored_yet' : 'proof_unavailable') : 'anchored', anchor };
                }
            }
            perBatch.set(b.seq, view);
            return view;
        };
        const inclusionAt = (i: number): { status: ExportPeStatus; inclusion: ActInclusionProof | null } => {
            const b = batches.find((x) => i >= x.first_index && i < x.first_index + x.count);
            if (b === undefined) return { status: 'not_batched_yet', inclusion: null };
            const view = batchView(b);
            if (view.leaves === null || b.acts_root === null || b.actor_id === null || view.status === null) return { status: view.status ?? 'batch_composition_unknown', inclusion: null };
            const inclusion = inclusionFromLeaves({
                leaves: view.leaves, at: i - b.first_index, device_id: device, actor_id: b.actor_id, seq: b.seq,
                batch_hash: b.batch_hash, acts_root: b.acts_root, anchor: view.anchor,
            });
            return { status: view.status, inclusion };
        };

        for (let i = 0; i < rows.count; i++) {
            const held = rows.held.get(i);
            const fill = filled.get(i);
            const pe = held?.pe ?? fill?.pe;
            if (pe === undefined) continue; // a pointer that could not be filled: named in `incomplete`
            let { status, inclusion } = inclusionAt(i);
            if (fill !== undefined && status !== 'anchored') {
                // The day's own proof, as archived (the batch record here may be gone or partial).
                const own = checkInclusionToRoot(pe, fill.inclusion);
                if (own.ok && own.anchored && own.inclusion.batch.device_id === device) {
                    status = 'anchored';
                    inclusion = own.inclusion;
                }
            }
            let detail: Readonly<Record<string, unknown>> | undefined;
            if (held?.detail !== undefined) {
                const d = asRecord(held.detail);
                if (typeof pe.detail_hash === 'string' && detailMatchesPe(d,pe)) detail = d;
                else incomplete.push({ what: `detail of pe ${device}#${i}`, reason: 'detail_does_not_match_detail_hash' });
            } else detail = detailOf(pe);
            peLines.push({
                type: 'pe', source: fill !== undefined ? 'archive' : 'device', device_id: device, index: i, pe,
                ...(detail !== undefined ? { detail } : {}), status, inclusion,
            });
            emitted.add(`${device}#${i}`);
        }

        // ─── 3. batch lines ────────────────────────────────────────────────────
        for (const b of batches) {
            const leaf = batchLeafOfBatch(device, b);
            const view = leaf === null ? null : batchView(b);
            const receipt = await chain.readReceipt(b.seq);
            batchLines.push({
                type: 'batch', device_id: device, seq: b.seq, batch_hash: b.batch_hash, prev_batch_hash: b.prev_batch_hash,
                acts_root: b.acts_root, actor_id: b.actor_id, first_index: b.first_index, count: b.count, last_pe_hash: b.last_pe_hash,
                created_at_ms: b.created_at_ms, accepted_at_ms: b.accepted_at_ms, adopted: b.adopted === true, batch_leaf: leaf,
                receipt: receipt === null ? null : asRecord(receipt),
                anchor: view?.anchor ?? checkedBatchAnchor(proofOf(b), leaf),
            });
        }
    }

    // PEs of the person's own Archive days that no chain here holds (another device's days, positions
    // a restored chain never carried).
    for (const [key, t] of ordered) {
        if (t.kind !== 'own') continue;
        const payloads = pulled.get(key);
        if (payloads === undefined) continue;
        for (const payload of payloads) {
            for (const entry of payload.entries) {
                const pos = `${payload.device_id}#${entry.index}`;
                if (emitted.has(pos) || positions.has(pos)) continue;
                const pe = withOwnHash(entry.pe, entry.pe.pe_hash);
                if (pe === null || pe.device_id !== payload.device_id) {
                    incomplete.push({ what: `pe ${pos} in archive day ${t.day}`, reason: 'archived_pe_hash_mismatch' });
                    continue;
                }
                const checked = checkInclusionToRoot(pe, entry.inclusion);
                const ok = checked.ok && checked.inclusion.batch.device_id === payload.device_id;
                if (!ok) incomplete.push({ what: `proof of pe ${pos} in archive day ${t.day}`, reason: checked.ok ? 'inclusion_device_mismatch' : checked.reason });
                const detail = detailOf(pe);
                peLines.push({
                    type: 'pe', source: 'archive', device_id: payload.device_id, index: entry.index, pe,
                    ...(detail !== undefined ? { detail } : {}),
                    status: ok ? (checked.anchored ? 'anchored' : 'not_anchored_yet') : 'proof_unavailable',
                    inclusion: ok ? checked.inclusion : null,
                });
                emitted.add(pos);
                metered.add(pe.pe_id);
            }
        }
    }
    const rank = new Map(devices.map((d, i) => [d, i]));
    peLines.sort((a, b) => {
        const ra = rank.get(a.device_id) ?? devices.length;
        const rb = rank.get(b.device_id) ?? devices.length;
        if (ra !== rb) return ra - rb;
        if (a.device_id !== b.device_id) return a.device_id < b.device_id ? -1 : 1;
        return a.index - b.index;
    });

    // ─── 4. received lines ─────────────────────────────────────────────────────
    progress({ stage: 'received' });
    const receivedLines: ExportReceivedLine[] = [];
    const legacyLines: ExportLegacyLine[] = [];
    let outcomes: ReadonlyMap<string, ReceivedProofOutcome> = new Map();
    if (deps.batchProofs !== null) {
        const report = await attachMissingReceivedProofs(store, deps.batchProofs).catch(() => null);
        if (report !== null) outcomes = report.outcomes;
    }
    const receivedHashes = new Set<string>();
    const proofFor = (pe: PeV2WithHash, batchHash: string, kept: ActInclusionProof | undefined, fallback: ActInclusionProof | undefined): { status: ExportPeStatus; inclusion: ActInclusionProof | null; reason: string | null } => {
        let reason: string | null = null;
        for (const candidate of [kept, fallback]) {
            if (candidate === undefined) continue;
            if (candidate.batch.batch_hash !== batchHash || candidate.batch.device_id !== pe.device_id) {
                reason = 'inclusion_names_another_batch';
                continue;
            }
            const checked = checkInclusionToRoot(pe, candidate);
            if (!checked.ok) {
                reason = checked.reason;
                continue;
            }
            return { status: checked.anchored ? 'anchored' : 'not_anchored_yet', inclusion: checked.inclusion, reason: null };
        }
        return { status: 'proof_unavailable', inclusion: null, reason: reason ?? 'no_proof' };
    };
    for (const row of receivedRows) {
        if (row.format === 'v1_envelope') {
            if (isArchivedReceived(row)) {
                incomplete.push({ what: `handed-back record ${row.pe_id}`, reason: 'not_held_on_this_phone' });
                continue;
            }
            const record = isRecord(row.pe) ? row.pe : null;
            if (record === null) continue;
            legacyLines.push({
                type: 'legacy', source: 'handed_back', id: row.pe_id,
                hash: typeof record.hash === 'string' ? record.hash : null, record, status: 'pre_meter',
            });
            continue;
        }
        if (isArchivedReceived(row)) {
            const key = `${row.archived.wallet}/${row.archived.day}`;
            if (!pulled.has(key)) {
                incomplete.push({ what: `received ${row.pe_id}`, reason: dayReasons.get(key) ?? 'archive_day_not_pulled' });
                continue;
            }
            const entry = hashIndex(key).get(row.pe_hash);
            const pe = entry === undefined ? null : withOwnHash(entry.pe, row.pe_hash);
            if (entry === undefined || pe === null || (row.from_device !== '' && pe.device_id !== row.from_device)) {
                incomplete.push({ what: `received ${row.pe_id}`, reason: 'archive_entry_does_not_match_row' });
                continue;
            }
            const batchHash = row.batch_hash !== '' ? row.batch_hash : entry.inclusion.batch.batch_hash;
            const proof = proofFor(pe, batchHash, row.inclusion, entry.inclusion);
            if (proof.reason !== null) incomplete.push({ what: `proof of received ${row.pe_id}`, reason: proof.reason });
            receivedLines.push({
                type: 'received', source: 'archive', mailbox_id: row.mailbox_id, from_actor: row.from_actor, from_device: pe.device_id,
                batch_hash: batchHash, received_at_ms: row.received_at_ms, pe, status: proof.status, inclusion: proof.inclusion,
            });
            receivedHashes.add(row.pe_hash);
            continue;
        }
        const held = row as ReceivedPe;
        const pe = withOwnHash(held.pe, held.pe_hash);
        if (pe === null) {
            incomplete.push({ what: `received ${held.pe_id}`, reason: 'received_pe_hash_mismatch' });
            continue;
        }
        let status: ExportPeStatus;
        let inclusion: ActInclusionProof | null;
        if (held.inclusion !== undefined) {
            const proof = proofFor(pe, held.batch_hash, held.inclusion, undefined);
            status = proof.status;
            inclusion = proof.inclusion;
            if (proof.reason !== null) incomplete.push({ what: `proof of received ${held.pe_id}`, reason: proof.reason });
        } else {
            const outcome = outcomes.get(held.mailbox_id) ?? {
                status: 'proof_unavailable' as const,
                inclusion: null,
                reason: deps.batchProofs === null ? 'proof_route_unavailable' : 'relay_unreachable',
            };
            status = outcome.status;
            inclusion = outcome.inclusion;
            if (status !== 'anchored' && status !== 'not_anchored_yet') incomplete.push({ what: `proof of received ${held.pe_id}`, reason: outcome.reason ?? status });
        }
        receivedLines.push({
            type: 'received', source: 'device', mailbox_id: held.mailbox_id, from_actor: held.from_actor, from_device: pe.device_id,
            // A row filed with no batch hash (a relay-authored PE handed over directly) is named by
            // the batch its proof was found in.
            batch_hash: held.batch_hash !== '' ? held.batch_hash : inclusion?.batch.batch_hash ?? '', received_at_ms: held.received_at_ms, pe, status, inclusion,
        });
        receivedHashes.add(held.pe_hash);
    }
    // Every other PE of the linked agents' days sealed to this person.
    for (const [key, t] of ordered) {
        if (t.kind !== 'linked') continue;
        const payloads = pulled.get(key);
        if (payloads === undefined) continue;
        for (const entry of payloads.flatMap((p) => p.entries)) {
            if (receivedHashes.has(entry.pe.pe_hash)) continue;
            const pe = withOwnHash(entry.pe, entry.pe.pe_hash);
            if (pe === null) {
                incomplete.push({ what: `received ${entry.pe.pe_id} in archive day ${t.wallet} ${t.day}`, reason: 'archived_pe_hash_mismatch' });
                continue;
            }
            const batchHash = entry.inclusion.batch.batch_hash;
            const proof = proofFor(pe, batchHash, entry.inclusion, undefined);
            if (proof.reason !== null) incomplete.push({ what: `proof of received ${pe.pe_id}`, reason: proof.reason });
            receivedLines.push({
                type: 'received', source: 'archive', mailbox_id: null, from_actor: t.wallet, from_device: pe.device_id,
                batch_hash: batchHash, received_at_ms: null, pe, status: proof.status, inclusion: proof.inclusion,
            });
            receivedHashes.add(pe.pe_hash);
        }
    }

    // ─── 5. legacy lines: activity records no PE carries ─────────────────────────
    progress({ stage: 'legacy' });
    for (const [id, { record, preMeter }] of activity) {
        if (metered.has(id)) continue;
        const r = asRecord(record);
        const ts = typeof record.timestamp === 'number' ? record.timestamp : 0;
        const status: ExportLegacyLine['status'] = preMeter || (deps.cutoverMs !== null && ts < deps.cutoverMs) ? 'pre_meter' : 'not_yet_metered';
        legacyLines.push({ type: 'legacy', source: 'device_history', id, hash: recordHashOf(r), record: r, status });
    }

    // ─── header, file, and the offline check of the finished file ──────────────
    progress({ stage: 'verify' });
    const exportedAt = now();
    const header: ExportHeader = {
        type: 'header',
        schema: PE_EXPORT_SCHEMA,
        spec: PE_EXPORT_SPEC_URL,
        exported_at_ms: exportedAt,
        producer: { kind: 'app', version: deps.appVersion },
        owner: { kind: 'human', wallet_id: walletId, address: deps.owner.address },
        anchor: PE_EXPORT_ANCHOR_RULES,
        devices,
        archive: { state: archiveState, days: archiveDays },
    };
    const uniqueIncomplete: Incomplete[] = [];
    const seen = new Set<string>();
    for (const x of incomplete) {
        const k = `${x.what}\u0000${x.reason}`;
        if (!seen.has(k)) {
            seen.add(k);
            uniqueIncomplete.push(x);
        }
    }
    const body: ExportBodyLine[] = [...peLines, ...batchLines, ...receivedLines, ...legacyLines];
    const text = serializeExport(header, body, uniqueIncomplete);
    const parsed = parseExport(text);
    if (!parsed.ok) throw new Error(`pe_export_unparseable:${parsed.error}`);
    const report = verifyExportOffline(parsed.body);
    const held = new Set(devices);
    const gapsInHeldChains = report.gaps.filter((g) => held.has(g.device_id)).length;
    return {
        text,
        fileName: peExportFileName(walletId ?? deps.owner.address, exportedAt),
        header,
        counts: parsed.end.counts,
        report,
        gapsInHeldChains,
        incomplete: uniqueIncomplete,
        complete: uniqueIncomplete.length === 0 && report.failures.length === 0 && gapsInHeldChains === 0,
        verdict: exportVerdictOf({
            parsed: true,
            failures: report.failures.length,
            gapsInListedDevices: gapsInHeldChains,
            incomplete: parsed.end.incomplete.length,
            anchorsConfirmed: null, // the phone never reads Base itself: `provian verify-export` does
        }),
    };
}

// ─── the relay mailbox ──────────────────────────────────────────────────────────

/** The `incomplete` entries for the mailbox state (none when the drain left nothing waiting). */
export function phoneMailboxIncompleteOf(state: PhonePeExportMailbox | null | undefined): Incomplete[] {
    const what = 'mailbox: PEs sealed to you waiting on the relay';
    if (state === undefined || state === null) {
        return [{ what, reason: 'mailbox_not_checked: this export did not drain the relay mailbox, so PEs sealed to you and not filed on this phone may be missing' }];
    }
    if (state.waiting === null) return [{ what, reason: `mailbox_not_counted: ${state.reason ?? 'the relay mailbox could not be read'}` }];
    if (state.waiting === 0 && !state.truncated) return [];
    return [{
        what: `mailbox: ${state.truncated ? 'at least ' : ''}${state.waiting} PE(s) sealed to you still waiting on the relay`,
        reason: state.reason ?? 'not_filed_on_this_phone',
    }];
}

export interface PhoneMailboxDrainDeps {
    /** One drain into the store, filing every page (`PhoneBatcher.drainMailbox({ fileWithoutBackup: true })`). */
    readonly drain: () => Promise<{ readonly ok: boolean; readonly received: number; readonly skipped: 'no_key' | 'not_backed_up' | null; readonly refused: number }>;
    /** One page of the mailbox (`GET /v1/meter/mobile/mailbox`). */
    readonly getMailbox: (after: string | null, limit: number) => Promise<MeterAnswer>;
    /** Every mailbox id this phone has filed. */
    readonly filedIds: () => Promise<ReadonlySet<string>>;
    /** Pages read when counting what is left (default 500 × 100 items). */
    readonly maxPages?: number;
    /** Drains run while each one files something (default 20). */
    readonly maxDrains?: number;
}

/**
 * Drain the relay mailbox before the export — file every PE sealed to the person that their key
 * opens — then count what is still there and not filed on this phone. Never throws.
 */
export async function drainMailboxForPhoneExport(deps: PhoneMailboxDrainDeps): Promise<PhonePeExportMailbox> {
    let reason: string | null = null;
    let refused = 0;
    try {
        for (let i = 0; i < (deps.maxDrains ?? 20); i++) {
            const report = await deps.drain();
            if (!report.ok) {
                reason = 'mailbox_unreachable: the relay mailbox could not be read';
                break;
            }
            if (report.skipped === 'no_key') {
                reason = 'no_message_key: your message key was not available (Face ID / passcode declined, or the wallet is locked), so PEs sealed to you could not be opened';
                break;
            }
            refused = report.refused;
            if (report.received === 0) break;
        }
    } catch (err) {
        reason = `mailbox_drain_failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    let filed: ReadonlySet<string>;
    try {
        filed = await deps.filedIds();
    } catch (err) {
        return { waiting: null, truncated: false, reason: `local_store_unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
    let waiting = 0;
    let after: string | null = null;
    let truncated = true;
    try {
        for (let page = 0; page < (deps.maxPages ?? 500); page++) {
            const answer = await deps.getMailbox(after, 100);
            const body = isRecord(answer.body) ? answer.body : null;
            if (answer.status !== 200 || body === null || !Array.isArray(body.items)) {
                return { waiting: null, truncated: false, reason: reason ?? `mailbox_unreachable: the relay answered ${answer.status ?? answer.error ?? 'nothing'}` };
            }
            for (const raw of body.items) {
                if (isRecord(raw) && typeof raw.id === 'string' && !filed.has(raw.id)) waiting += 1;
            }
            if (typeof body.next !== 'string' || body.next.length === 0) {
                truncated = false;
                break;
            }
            after = body.next;
        }
    } catch (err) {
        return { waiting: null, truncated: false, reason: reason ?? `mailbox_unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (reason === null && waiting > 0) {
        reason = refused > 0
            ? `unopenable: ${refused} item(s) your key cannot open, or whose opened PE is not the PE it names, were left on the relay`
            : 'not_filed_on_this_phone';
    }
    return { waiting, truncated, reason };
}

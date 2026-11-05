/**
 * PE METER (app) — the phone's own PE store (: the relay stops storing
 * PEs; a PE lives with its owner and is never deleted by any lifecycle).
 *
 * The phone builds each PE v2 itself (`phonePeBuilder.ts`), chains it per device (`prev_hash` =
 * the previous PE's `peHashOf`, starting at 'genesis'), keeps it here, and sends the relay only the
 * act record inside one daily batch, plus immediately before a presentation or on-demand payout
 * (`phoneBatcher.ts`). Every file below is mirrored, encrypted,
 * to the person's own iCloud / Google Drive (`peCloudBackup.ts`), and restored on wallet recovery.
 *
 * LAYOUT (all JSON, every record file is an append-only chunk rewritten atomically):
 * own.json { device_id } — the chain this phone batches
 * chains/<dev>/meta.json { device_id, created_at_ms }
 * chains/<dev>/pes/<NNNNNN>.json StoredPe[] (CHAIN_CHUNK per file, chain order)
 * chains/<dev>/batches/<NNNNNN>.json { batch: AcceptedBatch; receipt }[] (accepted, in order)
 * chains/<dev>/proofs/<NNNNNN>.json StoredBatchProof[]
 * chains/<dev>/inflight.json the batch being sent (transient; never backed up)
 * chains/<dev>/state.json { halt, flags }
 * received/<dev>/<NNNNNN>.json ReceivedPe[] — PEs agents / other devices sealed to this person
 * legacy/<dev>/<YYYY-MM>.json pre-meter v1 envelopes (history; never re-chained)
 * dirty.json record files written since their last cloud upload
 * schedule.json when the daily batch / mailbox / proofs are next due
 * (local only; never backed up — a recovered phone does all three at once)
 *
 * Restored chains of OTHER devices (a previous phone) live beside this phone's own chain; they are
 * history and are never batched again (a batch is accepted only from the device that built it).
 *
 * NOTHING HERE DELETES A RECORD. `MeterFiles.removeTransient` refuses any path that is not the
 * in-flight marker or a `.tmp` file, and this module only ever calls it for `inflight.json`.
 *
 * THE ONE EXCEPTION (the paid PE Archive, ,): once a day's PEs are
 * confirmed in the person's Archive with their proofs (or, for copies held for a linked agent, in
 * that agent's Archive), and the day is more than 30 days old, `DeviceChainStore.dropArchivedDay` /
 * `PhonePeStore.dropReceivedArchived` replace exactly those PEs with a POINTER (day, wallet, pe_id,
 * pe_hash, prev_hash) in their chunk, after checking each against the PE held. The pointer keeps
 * the chain position; the chunk is marked dirty, so the cloud backup's copy of it is rewritten
 * the same way. The PE comes back from the Archive when it is needed (`phoneArchive.ts`). The
 * caller pulls the day back and matches every PE before it asks for a drop.
 */

import { Mutex } from 'async-mutex';
import {
    METER_GENESIS_PREV_HASH,
    PE_V2_SCHEMA,
    peHashOf,
    batchLeafOf,
    verifyActInclusion,
    type ActInclusionProof,
    type PeBatch,
    type PeV2,
} from './meter-wire';
import type { MeterFiles } from './meterFiles';
import { UNPACED, type CpuBudget } from './cpuBudget';
import type { ProvenanceEnvelope } from '../provenance/types';

export const CHAIN_CHUNK = 64;
export const RECEIVED_CHUNK = 64;
export const BATCH_CHUNK = 100;
export const PROOF_CHUNK = 100;

// ─── records ────────────────────────────────────────────────────────────────────

/** A PE as the phone keeps it: complete, with its own hash. */
export type StoredPeV2 = PeV2 & { readonly pe_hash: string };

export interface StoredPe {
    /** 0-based position in this device's chain. */
    readonly index: number;
    readonly pe: StoredPeV2;
    readonly recorded_at_ms: number;
    /**
     * The full on-phone record of the act (the v1 envelope the app's screens read), committed to
     * by the PE's `detail_hash`. Never sent to the relay.
     */
    readonly detail?: ProvenanceEnvelope;
}

/**
 * Where a PE dropped after its day was confirmed in the PE Archive lives now: the Archive's object
 * for `wallet`'s `day`. Its id and hash stay here, so the chain still links and the PE is verified
 * when it is pulled back.
 */
export interface ArchivePointer {
    readonly day: string;
    readonly wallet: string;
    readonly pe_id: string;
    readonly pe_hash: string;
    readonly prev_hash: string;
}

/** A chain position whose PE was dropped here after the Archive confirmed its day. */
export interface ArchivedChainRow {
    readonly index: number;
    readonly recorded_at_ms: number;
    readonly archived: ArchivePointer;
}

export type ChainRow = StoredPe | ArchivedChainRow;

export function isArchivedRow(row: ChainRow): row is ArchivedChainRow {
    return (row as ArchivedChainRow).archived !== undefined && (row as StoredPe).pe === undefined;
}

/** What to drop from one chain: exactly these PEs (each checked against the one held first). */
export interface ArchiveDropPlan {
    readonly day: string;
    readonly wallet: string;
    readonly pes: readonly { readonly index: number; readonly pe_id: string; readonly pe_hash: string }[];
}

/** The relay's per-act answer (`provian.pe-batch-receipt.v1`). */
export interface MeterActReceiptWire {
    readonly pe_id: string;
    readonly pe_hash: string;
    readonly relay_pe_id: string;
    readonly leaf_index: number;
    readonly disposition: string;
    readonly reason: string;
    readonly note?: string;
    readonly record_points_atomic: string;
    readonly mint_status: string | null;
}

export interface MeterReceiptTotals {
    readonly eligible_points_atomic: string;
    readonly acts: number;
    readonly eligible: number;
}

export interface MeterBatchReceiptWire {
    readonly schema: string;
    readonly device_id: string;
    readonly actor_id: string;
    readonly seq: number;
    readonly batch_hash: string;
    readonly acts_root: string;
    readonly batch_leaf: string;
    readonly accepted_at_ms: number;
    readonly acts: readonly MeterActReceiptWire[];
    readonly totals: MeterReceiptTotals;
}

/** One batch the relay accepted (compact; the full receipt is kept beside it). */
export interface AcceptedBatch {
    readonly seq: number;
    readonly batch_hash: string;
    readonly prev_batch_hash: string;
    /** null when the position was adopted from the relay's tip (see `adopted`). */
    readonly acts_root: string | null;
    readonly first_index: number;
    readonly count: number;
    readonly last_pe_hash: string;
    readonly created_at_ms: number | null;
    readonly accepted_at_ms: number | null;
    readonly actor_id: string | null;
    readonly totals: MeterReceiptTotals | null;
    /** The relay already held batches this store had no record of; its tip was adopted (no PE changed). */
    readonly adopted?: boolean;
}

/** The batch being sent. Re-sent byte for byte until the relay answers definitively. */
/**
 * When this phone next sends its daily batch, checks its mailbox and fetches its proofs. Kept so a
 * cold start of the app does not do them early (: once a day). Local only.
 */
export interface MeterSchedule {
    readonly send_at_ms: number;
    readonly mailbox_at_ms: number;
    readonly proofs_at_ms: number;
}

export interface InFlightBatch {
    readonly batch: PeBatch;
    /** The exact request body sent (and re-sent): the auth token binds its hash. */
    readonly body: string;
    readonly batch_hash: string;
    readonly first_index: number;
    readonly count: number;
    readonly last_pe_hash: string;
    readonly persisted_at_ms: number;
}

/** The relay's anchor proof for one batch leaf (path to the day's on-chain root). */
export interface MeterAnchorProofWire {
    readonly day: string;
    readonly anchor_batch_id: string;
    /** 2026-10-10: the intra-day anchor segment (`<day>:<n>`) the batch was anchored in; absent for the day's close anchor. */
    readonly segment?: number;
    readonly leaf_index: number;
    readonly leaf_count: number;
    readonly leaf_hash: string;
    readonly proof: readonly string[];
    readonly merkle_root: string;
    readonly anchor_tx_hash: string | null;
    readonly anchored_at_ms?: number;
}

export interface StoredBatchProof {
    readonly seq: number;
    readonly batch_hash: string;
    readonly batch_leaf: string;
    readonly acts_root: string;
    readonly actor_id: string;
    readonly chain_id: number | null;
    readonly anchor_contract: string | null;
    readonly anchor: MeterAnchorProofWire;
    readonly fetched_at_ms: number;
    /** The batch leaf recomputed from this device's own batch record matched the relay's. */
    readonly verified: boolean;
}

/** A PE an agent or another device sealed to this person, opened and filed here. */
/**
 * A pre-meter PE the relay hands back through the mailbox (the -era history migration): the
 * relay's v1 envelope, kept VERBATIM. It has no `schema`; it is keyed by `id` and carries its own
 * `hash`, `prev_hash`, `timestamp`, `action_type`, ….
 */
export type ReceivedV1Envelope = Readonly<Record<string, unknown>>;

export interface ReceivedPe {
    readonly mailbox_id: string;
    /** The PE's id: `pe_id` of a PE v2, `id` of a v1 envelope. */
    readonly pe_id: string;
    /** Absent = 'pe_v2' (files written before v1 envelopes were accepted). */
    readonly format?: 'pe_v2' | 'v1_envelope';
    readonly pe: PeV2 | ReceivedV1Envelope;
    /**
     * PE v2: peHashOf(pe), recomputed here. v1 envelope: its own `hash` when it carries one, else
     * the sha256 of its canonical JSON (an identity for de-duplication, not a chain claim).
     */
    readonly pe_hash: string;
    readonly from_device: string;
    readonly from_actor: string;
    readonly batch_hash: string;
    readonly created_at_ms: number;
    readonly received_at_ms: number;
    /**
     * PE v2 only: the act's two-hop inclusion proof up to its anchored day root, fetched once the day
     * is anchored and kept here (the relay drops a batch record 30 days after its anchor, so this
     * copy is what makes the PE provable later). Kept on a pointer row too.
     */
    readonly inclusion?: ActInclusionProof;
}

/**
 * A received PE (a linked agent's) dropped here after that agent's Archive confirmed its day. The
 * mailbox identity stays (so the relay's mailbox can never file it twice); the PE is in the agent's
 * Archive, sealed to this person too.
 */
export type ArchivedReceivedRow = Omit<ReceivedPe, 'pe'> & { readonly archived: { readonly day: string; readonly wallet: string } };

export type ReceivedRow = ReceivedPe | ArchivedReceivedRow;

export function isArchivedReceived(row: ReceivedRow): row is ArchivedReceivedRow {
    return (row as ArchivedReceivedRow).archived !== undefined && (row as ReceivedPe).pe === undefined;
}

/** Batching stopped for a device: the relay's chain cannot be continued from this store. */
export interface MeterHalt {
    readonly reason: string;
    readonly detail: string;
    readonly at_ms: number;
}

export interface StoreHead {
    readonly count: number;
    readonly last_pe_hash: string;
}

export type AppendResult =
    | { readonly ok: true; readonly stored: StoredPe; readonly replay: boolean }
    | { readonly ok: false; readonly reason: 'head_moved'; readonly head: StoreHead }
    | { readonly ok: false; readonly reason: 'invalid'; readonly detail: string };

/** The checks every PE passes before it joins a chain. Null when it may. */
export function appendRefusal(head: StoreHead, deviceId: string, pe: StoredPeV2): string | null {
    if (pe.schema !== PE_V2_SCHEMA) return 'bad_schema';
    if (pe.device_id !== deviceId) return 'device_mismatch';
    if (typeof pe.pe_id !== 'string' || pe.pe_id.length === 0 || pe.pe_id.length > 200) return 'bad_pe_id';
    if (typeof pe.action_type !== 'string' || pe.action_type.length === 0 || pe.action_type.length > 128) return 'bad_action_type';
    if (!Number.isSafeInteger(pe.timestamp) || pe.timestamp <= 0) return 'bad_timestamp';
    if (pe.prev_hash !== head.last_pe_hash) return 'prev_hash_mismatch';
    let hash: string;
    try {
        hash = peHashOf(pe);
    } catch (err) {
        return `unhashable:${(err as Error).message}`;
    }
    return hash === pe.pe_hash ? null : 'pe_hash_mismatch';
}

/** Verify one device's chain from genesis: every link and every PE's own hash. */
export function verifyDeviceChain(deviceId: string, entries: readonly StoredPe[]): { ok: true } | { ok: false; index: number; reason: string } {
    let head: StoreHead = { count: 0, last_pe_hash: METER_GENESIS_PREV_HASH };
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.index !== i) return { ok: false, index: i, reason: 'index_gap' };
        const refusal = appendRefusal(head, deviceId, e.pe);
        if (refusal !== null) return { ok: false, index: i, reason: refusal };
        head = { count: i + 1, last_pe_hash: e.pe.pe_hash };
    }
    return { ok: true };
}

export class PeStoreCorruptError extends Error {
    constructor(detail: string) {
        super(`pe_store_corrupt: ${detail}`);
        this.name = 'PeStoreCorruptError';
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────────

function pad(n: number, width = 6): string {
    return String(n).padStart(width, '0');
}

/** A device id as one safe path segment (device ids are `device_<hex>` or `relay:<id>`). */
export function deviceDirName(deviceId: string): string {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(deviceId) || deviceId === '.' || deviceId === '..') {
        throw new Error('pe_store_device_id_invalid');
    }
    return deviceId.replace(/:/g, '_');
}

export function monthKeyOf(timestampMs: number): string {
    const d = new Date(timestampMs);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseArray<T>(text: string | null, what: string): T[] {
    if (text === null) return [];
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!Array.isArray(parsed)) throw new Error('not an array');
        return parsed as T[];
    } catch (err) {
        throw new PeStoreCorruptError(`${what}: ${(err as Error).message}`);
    }
}

function parseObject<T>(text: string | null): T | null {
    if (text === null) return null;
    try {
        const parsed = JSON.parse(text) as unknown;
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : null;
    } catch {
        return null;
    }
}

/**
 * An append-only log split into fixed-size chunk files `<dir>/<NNNNNN>.json`. Only the last chunk
 * is ever rewritten (to append); a full chunk is never touched again.
 */
class ChunkedLog<T> {
    private countValue = 0;
    private lastChunk: T[] = [];
    private readonly cache = new Map<number, T[]>();

    constructor(
        private readonly files: MeterFiles,
        readonly dir: string,
        private readonly chunkSize: number,
        private readonly onWrite: (path: string) => void,
    ) {}

    chunkPath(chunk: number): string {
        return `${this.dir}/${pad(chunk)}.json`;
    }

    async load(): Promise<void> {
        const names = (await this.files.list(this.dir)).filter((n) => /^\d{6}\.json$/.test(n)).sort();
        if (names.length === 0) {
            this.countValue = 0;
            this.lastChunk = [];
            return;
        }
        const last = Number(names[names.length - 1].slice(0, 6));
        for (let c = 0; c < last; c++) {
            if (!names.includes(`${pad(c)}.json`)) throw new PeStoreCorruptError(`${this.dir}: chunk ${c} missing`);
        }
        this.lastChunk = parseArray<T>(await this.files.read(this.chunkPath(last)), this.chunkPath(last));
        if (this.lastChunk.length > this.chunkSize) throw new PeStoreCorruptError(`${this.dir}: chunk ${last} overfull`);
        // A full last chunk with no successor: the next append opens a new chunk.
        this.countValue = last * this.chunkSize + this.lastChunk.length;
        this.cache.clear();
    }

    count(): number {
        return this.countValue;
    }

    async append(items: readonly T[]): Promise<void> {
        let pending = [...items];
        while (pending.length > 0) {
            const chunk = Math.floor(this.countValue / this.chunkSize);
            const offset = this.countValue % this.chunkSize;
            const base = offset === 0 ? [] : this.lastChunk;
            const room = this.chunkSize - offset;
            const next = [...base, ...pending.slice(0, room)];
            const path = this.chunkPath(chunk);
            await this.files.writeAtomic(path, JSON.stringify(next));
            this.onWrite(path);
            this.lastChunk = next;
            this.cache.set(chunk, next);
            this.countValue = chunk * this.chunkSize + next.length;
            pending = pending.slice(room);
        }
    }

    private async readChunk(chunk: number): Promise<T[]> {
        const lastIndex = Math.floor(Math.max(0, this.countValue - 1) / this.chunkSize);
        if (chunk === lastIndex && this.countValue > 0 && this.countValue % this.chunkSize !== 0) return this.lastChunk;
        const hit = this.cache.get(chunk);
        if (hit) return hit;
        const rows = parseArray<T>(await this.files.read(this.chunkPath(chunk)), this.chunkPath(chunk));
        if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value as number);
        this.cache.set(chunk, rows);
        return rows;
    }

    async read(from: number, limit: number): Promise<T[]> {
        const out: T[] = [];
        let i = Math.max(0, from);
        const end = Math.min(this.countValue, i + Math.max(0, limit));
        while (i < end) {
            const chunk = Math.floor(i / this.chunkSize);
            const rows = await this.readChunk(chunk);
            const offset = i % this.chunkSize;
            const take = rows.slice(offset, offset + (end - i));
            if (take.length === 0) throw new PeStoreCorruptError(`${this.dir}: short chunk ${chunk}`);
            out.push(...take);
            i += take.length;
        }
        return out;
    }

    async all(): Promise<T[]> {
        return this.read(0, this.countValue);
    }

    /**
     * Replace rows in place (the PE Archive drop only — see the header). Each chunk touched is
     * rewritten atomically and marked for upload, so the cloud copy is rewritten the same way.
     */
    async replace(rows: ReadonlyMap<number, T>): Promise<void> {
        const byChunk = new Map<number, Map<number, T>>();
        for (const [i, row] of rows) {
            if (!Number.isSafeInteger(i) || i < 0 || i >= this.countValue) throw new PeStoreCorruptError(`${this.dir}: replace outside the log (${i})`);
            const chunk = Math.floor(i / this.chunkSize);
            const m = byChunk.get(chunk) ?? new Map<number, T>();
            m.set(i % this.chunkSize, row);
            byChunk.set(chunk, m);
        }
        const lastIndex = Math.floor(Math.max(0, this.countValue - 1) / this.chunkSize);
        for (const [chunk, m] of [...byChunk.entries()].sort((a, b) => a[0] - b[0])) {
            const current = await this.readChunk(chunk);
            const next = current.map((r, offset) => m.get(offset) ?? r);
            const path = this.chunkPath(chunk);
            await this.files.writeAtomic(path, JSON.stringify(next));
            this.onWrite(path);
            this.cache.set(chunk, next);
            if (chunk === lastIndex) this.lastChunk = next;
        }
    }

    /** Every chunk path this log has written (for a full backup). */
    paths(): string[] {
        const chunks = this.countValue === 0 ? 0 : Math.floor((this.countValue - 1) / this.chunkSize) + 1;
        return Array.from({ length: chunks }, (_, c) => this.chunkPath(c));
    }
}

// ─── one device's chain ─────────────────────────────────────────────────────────

interface ChainState {
    readonly halt: MeterHalt | null;
    readonly flags: readonly string[];
}

export class DeviceChainStore {
    readonly dir: string;
    private readonly pes: ChunkedLog<ChainRow>;
    private readonly batchLog: ChunkedLog<{ batch: AcceptedBatch; receipt: MeterBatchReceiptWire | null }>;
    private readonly proofLog: ChunkedLog<StoredBatchProof>;
    private headValue: StoreHead = { count: 0, last_pe_hash: METER_GENESIS_PREV_HASH };
    private readonly peIds = new Map<string, number>();
    /** pe_id → pointer, for PEs dropped here after their day was confirmed in the Archive. */
    private readonly archivedIds = new Map<string, ArchivedChainRow>();
    private batches: { batch: AcceptedBatch; receipt: MeterBatchReceiptWire | null }[] = [];
    private proofs: StoredBatchProof[] = [];
    private state: ChainState = { halt: null, flags: [] };
    private readonly mutex = new Mutex();
    private readonly metadataMutex = new Mutex();

    constructor(private readonly files: MeterFiles, readonly deviceId: string, private readonly markDirty: (path: string) => void) {
        this.dir = `chains/${deviceDirName(deviceId)}`;
        this.pes = new ChunkedLog(files, `${this.dir}/pes`, CHAIN_CHUNK, markDirty);
        this.batchLog = new ChunkedLog(files, `${this.dir}/batches`, BATCH_CHUNK, markDirty);
        this.proofLog = new ChunkedLog(files, `${this.dir}/proofs`, PROOF_CHUNK, markDirty);
    }

    get location(): string {
        return this.dir;
    }

    async load(): Promise<void> {
        const metaPath = `${this.dir}/meta.json`;
        if ((await this.files.read(metaPath)) === null) {
            await this.files.writeAtomic(metaPath, JSON.stringify({ device_id: this.deviceId, created_at_ms: Date.now() }));
            this.markDirty(metaPath);
        }
        await this.pes.load();
        this.peIds.clear();
        this.archivedIds.clear();
        const all = await this.pes.all();
        let head: StoreHead = { count: 0, last_pe_hash: METER_GENESIS_PREV_HASH };
        for (let i = 0; i < all.length; i++) {
            const e = all[i];
            const link = isArchivedRow(e) ? e.archived : e.pe;
            // A complete record that does not continue the chain is corruption: refuse to append
            // (loudly) rather than guess. Nothing is rewritten. An archived pointer keeps its link.
            if (e.index !== i || link.prev_hash !== head.last_pe_hash) {
                throw new PeStoreCorruptError(`${this.dir}: PE ${i} does not continue the chain`);
            }
            if (isArchivedRow(e)) this.archivedIds.set(e.archived.pe_id, e);
            else this.peIds.set(e.pe.pe_id, i);
            head = { count: i + 1, last_pe_hash: link.pe_hash };
        }
        this.headValue = head;
        await this.batchLog.load();
        this.batches = await this.batchLog.all();
        await this.proofLog.load();
        this.proofs = await this.proofLog.all();
        this.state = parseObject<ChainState>(await this.files.read(`${this.dir}/state.json`)) ?? { halt: null, flags: [] };
    }

    async head(): Promise<StoreHead> {
        return this.headValue;
    }

    async findPe(peId: string): Promise<StoredPe | null> {
        const i = this.peIds.get(peId);
        if (i === undefined) return null;
        const [row] = await this.pes.read(i, 1);
        return row !== undefined && !isArchivedRow(row) ? row : null;
    }

    /** The pointer left for a PE dropped here after its day was confirmed in the PE Archive. */
    async findArchived(peId: string): Promise<ArchivedChainRow | null> {
        return this.archivedIds.get(peId) ?? null;
    }

    /** Every pointer this chain holds (PEs whose days live in the Archive now). */
    async listArchived(): Promise<ArchivedChainRow[]> {
        return [...this.archivedIds.values()].sort((a, b) => a.index - b.index);
    }

    /**
     * THE ONLY LIFECYCLE THAT REMOVES A PE'S CONTENT : replace exactly the planned
     * PEs with archive pointers, after checking each (index, id, hash) against the PE held — any
     * mismatch throws and NOTHING changes. Pointers already in place are skipped (idempotent).
     */
    async dropArchivedDay(plan: ArchiveDropPlan): Promise<{ dropped: number }> {
        return this.mutex.runExclusive(async () => {
            const seen = new Set<number>();
            const replacements = new Map<number, ChainRow>();
            for (const want of plan.pes) {
                if (seen.has(want.index)) throw new Error('pe_store_archive_drop_duplicate_index');
                seen.add(want.index);
                if (want.index >= this.headValue.count) throw new Error(`pe_store_archive_drop_mismatch: PE ${want.index} is not in this chain`);
                const [held] = await this.pes.read(want.index, 1);
                if (held === undefined) throw new Error(`pe_store_archive_drop_mismatch: PE ${want.index} is not in this chain`);
                if (isArchivedRow(held)) {
                    if (held.archived.pe_hash !== want.pe_hash) throw new Error(`pe_store_archive_drop_mismatch: pointer ${want.index} is not ${want.pe_hash}`);
                    continue;
                }
                if (held.pe.pe_id !== want.pe_id || held.pe.pe_hash !== want.pe_hash) {
                    throw new Error(`pe_store_archive_drop_mismatch: PE ${want.index} is not ${want.pe_id}/${want.pe_hash}`);
                }
                replacements.set(want.index, {
                    index: held.index,
                    recorded_at_ms: held.recorded_at_ms,
                    archived: { day: plan.day, wallet: plan.wallet, pe_id: held.pe.pe_id, pe_hash: held.pe.pe_hash, prev_hash: held.pe.prev_hash },
                });
            }
            if (replacements.size === 0) return { dropped: 0 };
            await this.pes.replace(replacements);
            for (const row of replacements.values()) {
                if (!isArchivedRow(row)) continue;
                this.peIds.delete(row.archived.pe_id);
                this.archivedIds.set(row.archived.pe_id, row);
            }
            return { dropped: replacements.size };
        });
    }

    /**
     * Append one PE. It must extend the current head (`prev_hash`), carry this chain's device id
     * and its own correct `pe_hash`. A PE id already recorded answers with that PE (idempotent).
     */
    async append(pe: StoredPeV2, options: { readonly recordedAtMs?: number; readonly detail?: ProvenanceEnvelope } = {}): Promise<AppendResult> {
        return this.mutex.runExclusive(() => this.appendLocked(pe, options));
    }

    /** Run `fn` while no other append can move the head (the builder reads the head inside it). */
    async withAppendLock<T>(fn: () => Promise<T>): Promise<T> {
        return this.mutex.runExclusive(fn);
    }

    /** Append without taking the lock (only from inside `withAppendLock`, or via `append`). */
    async appendLocked(pe: StoredPeV2, options: { readonly recordedAtMs?: number; readonly detail?: ProvenanceEnvelope } = {}): Promise<AppendResult> {
        const existing = this.peIds.get(pe.pe_id);
        if (existing !== undefined) {
            const [stored] = await this.pes.read(existing, 1);
            if (stored !== undefined && !isArchivedRow(stored)) return { ok: true, stored, replay: true };
        }
        if (this.archivedIds.has(pe.pe_id)) return { ok: false, reason: 'invalid', detail: 'pe_id_archived' };
        const head = this.headValue;
        if (pe.prev_hash !== head.last_pe_hash) return { ok: false, reason: 'head_moved', head };
        const refusal = appendRefusal(head, this.deviceId, pe);
        if (refusal !== null) return { ok: false, reason: 'invalid', detail: refusal };
        const stored: StoredPe = {
            index: head.count,
            pe: JSON.parse(JSON.stringify(pe)) as StoredPeV2,
            recorded_at_ms: options.recordedAtMs ?? Date.now(),
            ...(options.detail ? { detail: JSON.parse(JSON.stringify(options.detail)) as ProvenanceEnvelope } : {}),
        };
        await this.pes.append([stored]);
        this.peIds.set(pe.pe_id, stored.index);
        this.headValue = { count: stored.index + 1, last_pe_hash: pe.pe_hash };
        return { ok: true, stored, replay: false };
    }

    /** PEs held here in chain order from `fromIndex` (positions dropped to the Archive are skipped). */
    async readPes(fromIndex: number, limit: number): Promise<StoredPe[]> {
        return (await this.pes.read(fromIndex, limit)).filter((r): r is StoredPe => !isArchivedRow(r));
    }

    /** Every PE held here (positions dropped to the Archive are skipped). */
    async allPes(): Promise<StoredPe[]> {
        return (await this.pes.all()).filter((r): r is StoredPe => !isArchivedRow(r));
    }

    /**
     * Restore: append PEs recovered from the cloud. Each must continue this chain exactly (index,
     * link, own hash). Entries already held are checked byte-for-byte by hash and skipped.
     */
    async importPes(entries: readonly ChainRow[]): Promise<{ imported: number }> {
        return this.mutex.runExclusive(async () => {
            const sorted = [...entries].sort((a, b) => a.index - b.index);
            const fresh: ChainRow[] = [];
            let head = this.headValue;
            for (const e of sorted) {
                const hash = isArchivedRow(e) ? e.archived.pe_hash : e.pe.pe_hash;
                if (e.index < head.count) {
                    const [held] = await this.pes.read(e.index, 1);
                    const heldHash = held === undefined ? null : isArchivedRow(held) ? held.archived.pe_hash : held.pe.pe_hash;
                    if (heldHash !== hash) {
                        throw new PeStoreCorruptError(`${this.dir}: restored PE ${e.index} differs from the one held`);
                    }
                    continue;
                }
                if (e.index !== head.count) throw new PeStoreCorruptError(`${this.dir}: restored chain has a gap at ${head.count}`);
                if (isArchivedRow(e)) {
                    // A position dropped to the Archive: it must continue the chain; its PE is verified
                    // against this hash whenever it is pulled back.
                    if (e.archived.prev_hash !== head.last_pe_hash || !/^[0-9a-f]{64}$/.test(e.archived.pe_hash)) {
                        throw new PeStoreCorruptError(`${this.dir}: restored archive pointer ${e.index} does not continue the chain`);
                    }
                } else {
                    const refusal = appendRefusal(head, this.deviceId, e.pe);
                    if (refusal !== null) throw new PeStoreCorruptError(`${this.dir}: restored PE ${e.index} refused (${refusal})`);
                }
                fresh.push(e);
                head = { count: e.index + 1, last_pe_hash: hash };
            }
            if (fresh.length > 0) {
                await this.pes.append(fresh);
                for (const e of fresh) {
                    if (isArchivedRow(e)) this.archivedIds.set(e.archived.pe_id, e);
                    else this.peIds.set(e.pe.pe_id, e.index);
                }
                this.headValue = head;
            }
            return { imported: fresh.length };
        });
    }

    // batches ------------------------------------------------------------------

    async lastBatch(): Promise<AcceptedBatch | null> {
        return this.batches.reduce<AcceptedBatch | null>((tip, row) => tip === null || row.batch.seq > tip.seq ? row.batch : tip, null);
    }

    async listBatches(): Promise<AcceptedBatch[]> {
        return this.batches.map((b) => b.batch).sort((a, b) => a.seq - b.seq);
    }

    async listReceipts(): Promise<MeterBatchReceiptWire[]> {
        return this.batches.map((b) => b.receipt).filter((r): r is MeterBatchReceiptWire => r !== null);
    }

    async recordBatch(batch: AcceptedBatch, receipt: MeterBatchReceiptWire | null): Promise<void> {
        return this.metadataMutex.runExclusive(async () => {
        const row = { batch, receipt };
        await this.batchLog.append([row]);
        this.batches.push(row);
        });
    }

    async readReceipt(seq: number): Promise<MeterBatchReceiptWire | null> {
        return this.batches.find((b) => b.batch.seq === seq)?.receipt ?? null;
    }

    async importBatches(rows: readonly { batch: AcceptedBatch; receipt: MeterBatchReceiptWire | null }[]): Promise<void> {
        return this.metadataMutex.runExclusive(() => this.importBatchesLocked(rows));
    }

    private async importBatchesLocked(rows: readonly { batch: AcceptedBatch; receipt: MeterBatchReceiptWire | null }[]): Promise<void> {
        const merged = new Map<number, typeof rows[number]>();
        for (const row of [...this.batches, ...rows]) {
            const held = merged.get(row.batch.seq);
            if (!held) { merged.set(row.batch.seq, row); continue; }
            if (held.batch.batch_hash !== row.batch.batch_hash) throw new PeStoreCorruptError(`${this.dir}: conflicting batch ${row.batch.seq}`);
            const complete = (r: typeof row): boolean => !r.batch.adopted && r.batch.acts_root !== null && r.batch.actor_id !== null;
            if (complete(held) && complete(row) && ['acts_root', 'actor_id', 'first_index', 'count', 'last_pe_hash', 'prev_batch_hash'].some(k => held.batch[k as keyof AcceptedBatch] !== row.batch[k as keyof AcceptedBatch])) {
                throw new PeStoreCorruptError(`${this.dir}: conflicting batch composition ${row.batch.seq}`);
            }
            const chosen = complete(row) && !complete(held) ? row : held;
            merged.set(row.batch.seq, { batch: chosen.batch, receipt: chosen.receipt ?? held.receipt ?? row.receipt });
        }
        const replacements = new Map<number, typeof rows[number]>();
        this.batches.forEach((row, index) => { const next = merged.get(row.batch.seq)!; if (JSON.stringify(next) !== JSON.stringify(row)) replacements.set(index, next); });
        const heldSeqs = new Set(this.batches.map(row => row.batch.seq));
        const fresh = [...merged.values()].filter(row => !heldSeqs.has(row.batch.seq)).sort((a, b) => a.batch.seq - b.batch.seq);
        if (replacements.size) await this.batchLog.replace(replacements);
        if (fresh.length) await this.batchLog.append(fresh);
        this.batches = this.batches.map(row => merged.get(row.batch.seq)!).concat(fresh);
    }

    // in flight ----------------------------------------------------------------

    async inFlight(): Promise<InFlightBatch | null> {
        return parseObject<InFlightBatch>(await this.files.read(`${this.dir}/inflight.json`));
    }

    async setInFlight(batch: InFlightBatch | null): Promise<void> {
        const path = `${this.dir}/inflight.json`;
        if (batch === null) await this.files.removeTransient(path);
        else await this.files.writeAtomic(path, JSON.stringify(batch));
    }

    // proofs -------------------------------------------------------------------

    async listProofs(): Promise<StoredBatchProof[]> {
        // Verification is derived from the metadata held NOW, not the state at download/backup.
        // This also heals foreign-device chains restored from cloud without contacting the relay.
        return this.proofs.map(proof => {
            if (proof.verified) return proof;
            const batch = this.batches.find(b => b.batch.seq === proof.seq && b.batch.batch_hash === proof.batch_hash)?.batch;
            if (!batch || batch.adopted || batch.acts_root !== proof.acts_root || batch.actor_id !== proof.actor_id) return proof;
            const leaf = batchLeafOf({ device_id: this.deviceId, actor_id: proof.actor_id,
                seq: proof.seq, batch_hash: proof.batch_hash, acts_root: proof.acts_root });
            return leaf === proof.batch_leaf ? { ...proof, verified: true } : proof;
        });
    }

    async recordProof(proof: StoredBatchProof): Promise<void> {
        return this.metadataMutex.runExclusive(async () => {
        await this.proofLog.append([proof]);
        this.proofs.push(proof);
        });
    }

    async importProofs(rows: readonly StoredBatchProof[]): Promise<void> {
        return this.metadataMutex.runExclusive(() => this.importProofsLocked(rows));
    }

    private async importProofsLocked(rows: readonly StoredBatchProof[]): Promise<void> {
        const merged = new Map<number, StoredBatchProof>();
        for (const row of [...this.proofs, ...rows]) {
            const held = merged.get(row.seq);
            if (!held) { merged.set(row.seq, row); continue; }
            if (held.batch_hash !== row.batch_hash || held.acts_root !== row.acts_root) throw new PeStoreCorruptError(`${this.dir}: conflicting proof ${row.seq}`);
            if (held.verified && row.verified && (held.anchor.anchor_batch_id !== row.anchor.anchor_batch_id || held.anchor.merkle_root !== row.anchor.merkle_root)) throw new PeStoreCorruptError(`${this.dir}: conflicting anchor ${row.seq}`);
            const chosen = row.verified && !held.verified || row.verified === held.verified && row.fetched_at_ms > held.fetched_at_ms ? row : held;
            const other = chosen === row ? held : row;
            merged.set(row.seq, { ...chosen, chain_id: chosen.chain_id ?? other.chain_id, anchor_contract: chosen.anchor_contract ?? other.anchor_contract,
                anchor: { ...chosen.anchor, anchor_tx_hash: chosen.anchor.anchor_tx_hash ?? other.anchor.anchor_tx_hash } });
        }
        const replacements = new Map<number, StoredBatchProof>();
        this.proofs.forEach((row, index) => { const next = merged.get(row.seq)!; if (JSON.stringify(next) !== JSON.stringify(row)) replacements.set(index, next); });
        const heldSeqs = new Set(this.proofs.map(row => row.seq));
        const fresh = [...merged.values()].filter(row => !heldSeqs.has(row.seq));
        if (replacements.size) await this.proofLog.replace(replacements);
        if (fresh.length) await this.proofLog.append(fresh);
        this.proofs = this.proofs.map(row => merged.get(row.seq)!).concat(fresh);
    }

    // halt / flags -------------------------------------------------------------

    async halt(): Promise<MeterHalt | null> {
        return this.state.halt;
    }

    async setHalt(halt: MeterHalt | null): Promise<void> {
        this.state = { ...this.state, halt };
        await this.writeState();
    }

    async flag(name: string): Promise<boolean> {
        return this.state.flags.includes(name);
    }

    async setFlag(name: string): Promise<void> {
        if (this.state.flags.includes(name)) return;
        this.state = { ...this.state, flags: [...this.state.flags, name] };
        await this.writeState();
    }

    private async writeState(): Promise<void> {
        const path = `${this.dir}/state.json`;
        await this.files.writeAtomic(path, JSON.stringify(this.state));
        this.markDirty(path);
    }

    /** Every record file of this chain (a full backup uploads all of them). */
    recordPaths(): string[] {
        return [`${this.dir}/meta.json`, ...this.pes.paths(), ...this.batchLog.paths(), ...this.proofLog.paths(), `${this.dir}/state.json`];
    }
}

// ─── the whole store ────────────────────────────────────────────────────────────

interface DirtyFile {
    /** path → generation of its latest write */
    readonly paths: Record<string, number>;
    readonly gen: number;
}

/**
 * Received (mailbox) PEs and legacy v1 history are kept per device directory, like the chains:
 * two phones of the same person each file into their own directory, so their backups never write
 * the same cloud file. Every directory is read (display, de-duplication); only this phone's own
 * directory is appended to.
 */
export class PhonePeStore {
    private ownId: string | null = null;
    private readonly chains = new Map<string, DeviceChainStore>();
    private readonly receivedLogs = new Map<string, ChunkedLog<ReceivedRow>>();
    private readonly receivedIds = new Map<string, string>();
    /** Received rows whose PE was dropped here because the agent's Archive holds the day. */
    private receivedArchived = 0;
    private readonly receivedHashPaths = new Map<string, string>();
    private readonly legacyIds = new Map<string, string>();
    /** legacy file paths (`legacy/<dir>/<YYYY-MM>.json`) */
    private legacyPaths = new Set<string>();
    private dirty: DirtyFile = { paths: {}, gen: 0 };
    private dirtyWrite: Promise<void> = Promise.resolve();
    private readonly receivedMutex = new Mutex();
    private readonly legacyMutex = new Mutex();
    private opened = false;

    constructor(readonly files: MeterFiles) {}

    /** Load everything this phone holds. Safe to call again (reloads). */
    async open(ownDeviceId: string): Promise<void> {
        deviceDirName(ownDeviceId);
        this.dirty = parseObject<DirtyFile>(await this.files.read('dirty.json')) ?? { paths: {}, gen: 0 };
        const own = parseObject<{ device_id?: string }>(await this.files.read('own.json'));
        if (!own || own.device_id !== ownDeviceId) {
            // A new install (or a new relay device id) starts its own chain at genesis; any chain held
            // under a previous id stays as that device's history.
            await this.files.writeAtomic('own.json', JSON.stringify({ device_id: ownDeviceId }));
        }
        this.ownId = ownDeviceId;
        this.chains.clear();
        for (const dir of await this.files.list('chains')) {
            const meta = parseObject<{ device_id?: string }>(await this.files.read(`chains/${dir}/meta.json`));
            if (!meta || typeof meta.device_id !== 'string') continue;
            const chain = new DeviceChainStore(this.files, meta.device_id, (p) => this.markDirty(p));
            await chain.load();
            this.chains.set(meta.device_id, chain);
        }
        if (!this.chains.has(ownDeviceId)) {
            const chain = new DeviceChainStore(this.files, ownDeviceId, (p) => this.markDirty(p));
            await chain.load();
            this.chains.set(ownDeviceId, chain);
        }
        this.receivedLogs.clear();
        this.receivedIds.clear();
        this.receivedHashPaths.clear();
        this.receivedArchived = 0;
        const receivedDirs = new Set(await this.files.list('received'));
        receivedDirs.add(deviceDirName(ownDeviceId));
        for (const dir of receivedDirs) {
            const log = this.receivedLog(dir);
            await log.load();
            (await log.all()).forEach((r, i) => {
                if (isArchivedReceived(r)) this.receivedArchived += 1;
                this.receivedIds.set(r.mailbox_id, log.chunkPath(Math.floor(i / RECEIVED_CHUNK)));
                for (const k of PhonePeStore.dedupeKeys(r)) this.receivedHashPaths.set(k, log.chunkPath(Math.floor(i / RECEIVED_CHUNK)));
            });
        }
        this.legacyIds.clear();
        this.legacyPaths = new Set();
        for (const dir of await this.files.list('legacy')) {
            for (const name of await this.files.list(`legacy/${dir}`)) {
                if (!/^\d{4}-\d{2}\.json$/.test(name)) continue;
                const path = `legacy/${dir}/${name}`;
                this.legacyPaths.add(path);
                for (const env of parseArray<ProvenanceEnvelope>(await this.files.read(path), path)) {
                    this.legacyIds.set(env.envelope_id, path);
                }
            }
        }
        this.opened = true;
    }

    isOpen(): boolean {
        return this.opened;
    }

    ownDeviceId(): string {
        if (!this.ownId) throw new Error('pe_store_not_open');
        return this.ownId;
    }

    own(): DeviceChainStore {
        const chain = this.chains.get(this.ownDeviceId());
        if (!chain) throw new Error('pe_store_not_open');
        return chain;
    }

    deviceIds(): string[] {
        return [...this.chains.keys()].sort();
    }

    async chain(deviceId: string): Promise<DeviceChainStore> {
        let chain = this.chains.get(deviceId);
        if (!chain) {
            chain = new DeviceChainStore(this.files, deviceId, (p) => this.markDirty(p));
            await chain.load();
            this.chains.set(deviceId, chain);
        }
        return chain;
    }

    /** True when any chain this phone holds already carries a PE with this id. */
    async hasPeIdAnywhere(peId: string): Promise<boolean> {
        for (const chain of this.chains.values()) {
            if ((await chain.findPe(peId)) !== null) return true;
        }
        return false;
    }

    // received (mailbox) -------------------------------------------------------

    private receivedLog(dir: string): ChunkedLog<ReceivedRow> {
        let log = this.receivedLogs.get(dir);
        if (!log) {
            log = new ChunkedLog<ReceivedRow>(this.files, `received/${dir}`, RECEIVED_CHUNK, (p) => this.markDirty(p));
            this.receivedLogs.set(dir, log);
        }
        return log;
    }

    /** Received PEs held here (copies dropped after their agent's Archive confirmed them are skipped). */
    async listReceived(): Promise<ReceivedPe[]> {
        return (await this.listReceivedRows()).filter((r): r is ReceivedPe => !isArchivedReceived(r));
    }

    /** Every received row, including pointers left for copies dropped to a linked agent's Archive. */
    async listReceivedRows(): Promise<ReceivedRow[]> {
        const out: ReceivedRow[] = [];
        for (const dir of [...this.receivedLogs.keys()].sort()) {
            const log = this.receivedLogs.get(dir);
            if (log) out.push(...await log.all());
        }
        return out;
    }

    /**
     * Drop the copies this person holds of a linked agent's PEs whose day that agent's Archive
     * confirmed ( — "including copies a human holds for a linked agent"). Each named
     * item must be held with exactly this hash; any mismatch throws and NOTHING changes. Copies
     * already dropped are skipped. The caller has pulled the day and matched every PE.
     */
    async dropReceivedArchived(day: string, wallet: string, items: readonly { readonly mailbox_id: string; readonly pe_hash: string }[]): Promise<{ dropped: number }> {
        return this.receivedMutex.runExclusive(async () => {
            const want = new Map(items.map((i) => [i.mailbox_id, i.pe_hash]));
            const plans: { log: ChunkedLog<ReceivedRow>; rows: Map<number, ReceivedRow> }[] = [];
            const found = new Set<string>();
            for (const log of this.receivedLogs.values()) {
                const rows = new Map<number, ReceivedRow>();
                (await log.all()).forEach((row, i) => {
                    const hash = want.get(row.mailbox_id);
                    if (hash === undefined) return;
                    found.add(row.mailbox_id);
                    if (row.pe_hash !== hash) throw new Error(`pe_store_archive_drop_mismatch: received ${row.mailbox_id} is not ${hash}`);
                    if (isArchivedReceived(row)) return;
                    const { pe: _dropped, ...rest } = row;
                    void _dropped;
                    rows.set(i, { ...rest, archived: { day, wallet } });
                });
                if (rows.size > 0) plans.push({ log, rows });
            }
            if (found.size !== want.size) throw new Error('pe_store_archive_drop_mismatch: a planned received PE is not held here');
            let dropped = 0;
            for (const plan of plans) {
                await plan.log.replace(plan.rows);
                dropped += plan.rows.size;
                this.receivedArchived += plan.rows.size;
            }
            return { dropped };
        });
    }

    /**
     * Keep the inclusion proof of received PEs with their rows (the meter's daily proofs step). Each
     * named row must be held with exactly this hash, be a PE v2 whose batch and device the proof
     * names, and — when its PE is held here — the proof must carry the act to its `acts_root`. Any
     * mismatch throws and NOTHING changes. Rows that already carry a proof are left as they are. The
     * rewritten chunks are marked for upload, so the cloud backup carries the proofs too.
     */
    async attachReceivedInclusions(
        items: readonly { readonly mailbox_id: string; readonly pe_hash: string; readonly inclusion: ActInclusionProof }[],
        options: { readonly budget?: CpuBudget } = {},
    ): Promise<{ attached: number }> {
        return this.receivedMutex.runExclusive(async () => {
            const want = new Map(items.map((i) => [i.mailbox_id, i]));
            if (want.size !== items.length) throw new Error('pe_store_inclusion_mismatch: a mailbox id is named twice');
            const found = new Set<string>();
            const attached = await this.rewriteReceivedLocked((row) => {
                const item = want.get(row.mailbox_id);
                if (item === undefined) return null;
                found.add(row.mailbox_id);
                const refusal = PhonePeStore.inclusionRefusal(row, item.pe_hash, item.inclusion);
                if (refusal !== null) throw new Error(`pe_store_inclusion_mismatch: received ${row.mailbox_id} (${refusal})`);
                return row.inclusion === undefined
                    ? { ...row, batch_hash: row.batch_hash !== '' ? row.batch_hash : item.inclusion.batch.batch_hash, inclusion: JSON.parse(JSON.stringify(item.inclusion)) as ActInclusionProof }
                    : null;
            }, () => {
                if (found.size !== want.size) throw new Error('pe_store_inclusion_mismatch: a named received PE is not held here');
            }, options.budget);
            return { attached };
        });
    }

    /** Why a proof may not be kept with a row (null = it may). */
    private static inclusionRefusal(row: ReceivedRow, peHash: string, inclusion: ActInclusionProof): string | null {
        if (row.pe_hash !== peHash) return 'pe_hash_differs';
        if (row.format === 'v1_envelope') return 'v1_envelope';
        // A row filed with no batch hash (a relay-authored PE handed over directly) takes its batch
        // from the proof; the act's own hop below still has to hold.
        if ((row.batch_hash !== '' && inclusion.batch.batch_hash !== row.batch_hash) || inclusion.batch.device_id !== row.from_device) return 'batch_differs';
        if (!isArchivedReceived(row)) {
            try {
                if (!verifyActInclusion(row.pe as PeV2, inclusion).ok) return 'act_not_in_batch';
            } catch {
                return 'inclusion_malformed';
            }
        }
        return null;
    }

    /**
     * Rewrite received rows in place: `fn` returns the replacement row, or null to keep a row. Every
     * row is visited first (so `fn` may throw before anything is written), then `beforeWrite` runs,
     * then each touched chunk is rewritten and marked for upload. Call with the received mutex held.
     * `budget` paces the walk so a large store never holds the JS thread past one slice.
     */
    private async rewriteReceivedLocked(
        fn: (row: ReceivedRow) => ReceivedRow | null,
        beforeWrite: () => void = () => undefined,
        budget: CpuBudget = UNPACED,
    ): Promise<number> {
        const plans: { log: ChunkedLog<ReceivedRow>; rows: Map<number, ReceivedRow> }[] = [];
        for (const log of this.receivedLogs.values()) {
            const rows = new Map<number, ReceivedRow>();
            const all = await log.all();
            for (let i = 0; i < all.length; i += 1) {
                await budget.pace();
                const next = fn(all[i]);
                if (next !== null) rows.set(i, next);
            }
            if (rows.size > 0) plans.push({ log, rows });
        }
        beforeWrite();
        let n = 0;
        for (const plan of plans) {
            await budget.pace();
            await plan.log.replace(plan.rows);
            n += plan.rows.size;
        }
        return n;
    }

    receivedCount(): number {
        let n = 0;
        for (const log of this.receivedLogs.values()) n += log.count();
        return n;
    }

    /** Of `receivedCount()`, the rows dropped here and kept in the agent's Archive (a pointer each). */
    receivedArchivedCount(): number {
        return this.receivedArchived;
    }

    hasReceivedPeHash(peHash: string): boolean {
        return this.receivedHashPaths.has(peHash);
    }

    /** File a received PE in this phone's own directory. `filed: false` when already filed. */
    async recordReceived(item: ReceivedPe): Promise<{ filed: boolean; path: string }> {
        return this.fileReceived(deviceDirName(this.ownDeviceId()), item);
    }

    private async fileReceived(dir: string, item: ReceivedPe): Promise<{ filed: boolean; path: string }> {
        const [result] = await this.fileReceivedMany(dir, [item]);
        return { filed: result.filed, path: result.path };
    }

    /** De-duplication keys of a received PE: its hash, and for a v1 envelope also its id. */
    private static dedupeKeys(item: ReceivedRow): string[] {
        return item.format === 'v1_envelope' ? [item.pe_hash, `v1:${item.pe_id}`] : [item.pe_hash];
    }

    /**
     * File many received PEs with ONE append (a page of thousands of mailbox items costs a handful
     * of chunk writes, not one per item). Idempotent by mailbox id, by PE hash, and for a v1
     * envelope by its id.
     */
    private async fileReceivedMany(dir: string, items: readonly ReceivedRow[]): Promise<{ mailbox_id: string; filed: boolean; path: string }[]> {
        return this.receivedMutex.runExclusive(async () => {
            const log = this.receivedLog(dir);
            const results: { mailbox_id: string; filed: boolean; path: string | null }[] = [];
            const fresh: ReceivedRow[] = [];
            const pendingKeys = new Map<string, number>();
            for (const item of items) {
                const existing = this.receivedIds.get(item.mailbox_id);
                if (existing !== undefined) {
                    results.push({ mailbox_id: item.mailbox_id, filed: false, path: existing });
                    continue;
                }
                // The same PE delivered twice (handed directly, then again through the mailbox; or
                // the same v1 envelope in two items) is kept once.
                const keys = PhonePeStore.dedupeKeys(item);
                const held = keys.map((k) => this.receivedHashPaths.get(k)).find((p) => p !== undefined);
                if (held !== undefined) {
                    this.receivedIds.set(item.mailbox_id, held);
                    results.push({ mailbox_id: item.mailbox_id, filed: false, path: held });
                    continue;
                }
                const inPage = keys.map((k) => pendingKeys.get(k)).find((i) => i !== undefined);
                if (inPage !== undefined) {
                    results.push({ mailbox_id: item.mailbox_id, filed: false, path: null });
                    continue;
                }
                const index = log.count() + fresh.length;
                for (const k of keys) pendingKeys.set(k, index);
                fresh.push(item);
                results.push({ mailbox_id: item.mailbox_id, filed: true, path: null });
            }
            const base = log.count();
            if (fresh.length > 0) await log.append(fresh);
            fresh.forEach((item, i) => {
                if (isArchivedReceived(item)) this.receivedArchived += 1;
                const path = log.chunkPath(Math.floor((base + i) / RECEIVED_CHUNK));
                this.receivedIds.set(item.mailbox_id, path);
                for (const k of PhonePeStore.dedupeKeys(item)) this.receivedHashPaths.set(k, path);
            });
            return results.map((r, i) => {
                if (r.path !== null) return { ...r, path: r.path };
                const path = this.receivedIds.get(r.mailbox_id)
                    ?? PhonePeStore.dedupeKeys(items[i]).map((k) => this.receivedHashPaths.get(k)).find((p) => p !== undefined)
                    ?? '';
                if (!this.receivedIds.has(r.mailbox_id) && path) this.receivedIds.set(r.mailbox_id, path);
                return { ...r, path };
            });
        });
    }

    /** File a page of received PEs (the mailbox drain) in this phone's own directory. */
    async recordReceivedMany(items: readonly ReceivedPe[]): Promise<{ mailbox_id: string; filed: boolean; path: string }[]> {
        return this.fileReceivedMany(deviceDirName(this.ownDeviceId()), items);
    }

    /** The chunk file a filed mailbox item lives in (null when it was never filed). */
    receivedPathOf(mailboxId: string): string | null {
        return this.receivedIds.get(mailboxId) ?? null;
    }

    /**
     * Restore: file received PEs under the directory they were backed up from. A restored row that
     * carries an inclusion proof the row held here lacks (the same PE, by hash) gives it its proof:
     * once the relay has dropped the batch, the backup's copy is the only one left.
     */
    async importReceived(dir: string, items: readonly ReceivedRow[]): Promise<number> {
        const filed = (await this.fileReceivedMany(dir, items)).filter((r) => r.filed).length;
        const proofs = new Map<string, ActInclusionProof>();
        for (const item of items) if (item.inclusion !== undefined && item.format !== 'v1_envelope') proofs.set(item.pe_hash, item.inclusion);
        if (proofs.size > 0) {
            await this.receivedMutex.runExclusive(() => this.rewriteReceivedLocked((row) => {
                const inclusion = proofs.get(row.pe_hash);
                if (inclusion === undefined || row.inclusion !== undefined) return null;
                return PhonePeStore.inclusionRefusal(row, row.pe_hash, inclusion) === null ? { ...row, inclusion } : null;
            }));
        }
        return filed;
    }

    // legacy (pre-meter v1 history) -------------------------------------------

    hasLegacy(envelopeId: string): boolean {
        return this.legacyIds.has(envelopeId);
    }

    legacyCount(): number {
        return this.legacyIds.size;
    }

    /**
     * Keep pre-meter v1 envelopes as history (grouped by month, under `dir` — this phone's own
     * directory unless restoring another's). Idempotent by envelope_id. Never re-chained.
     */
    async addLegacy(envelopes: readonly ProvenanceEnvelope[], dir: string = deviceDirName(this.ownDeviceId())): Promise<number> {
        return this.legacyMutex.runExclusive(async () => {
            const byPath = new Map<string, ProvenanceEnvelope[]>();
            for (const env of envelopes) {
                if (!env || typeof env.envelope_id !== 'string' || this.legacyIds.has(env.envelope_id)) continue;
                const path = `legacy/${dir}/${monthKeyOf(typeof env.timestamp === 'number' ? env.timestamp : 0)}.json`;
                const list = byPath.get(path) ?? [];
                if (!list.some((e) => e.envelope_id === env.envelope_id)) list.push(env);
                byPath.set(path, list);
            }
            let added = 0;
            for (const [path, fresh] of byPath) {
                const held = parseArray<ProvenanceEnvelope>(await this.files.read(path), path);
                const ids = new Set(held.map((e) => e.envelope_id));
                const toAdd = fresh.filter((e) => !ids.has(e.envelope_id));
                if (toAdd.length === 0) continue;
                const next = [...held, ...toAdd]
                    .sort((a, b) => a.timestamp - b.timestamp || (a.envelope_id < b.envelope_id ? -1 : 1));
                await this.files.writeAtomic(path, JSON.stringify(next));
                this.markDirty(path);
                this.legacyPaths.add(path);
                for (const e of toAdd) this.legacyIds.set(e.envelope_id, path);
                added += toAdd.length;
            }
            return added;
        });
    }

    async listLegacy(): Promise<ProvenanceEnvelope[]> {
        const out: ProvenanceEnvelope[] = [];
        for (const path of [...this.legacyPaths].sort()) out.push(...parseArray<ProvenanceEnvelope>(await this.files.read(path), path));
        return out;
    }

    // backup bookkeeping -------------------------------------------------------

    private markDirty(path: string): void {
        const gen = this.dirty.gen + 1;
        this.dirty = { gen, paths: { ...this.dirty.paths, [path]: gen } };
        const snapshot = JSON.stringify(this.dirty);
        this.dirtyWrite = this.dirtyWrite
            .catch(() => undefined)
            .then(() => this.files.writeAtomic('dirty.json', snapshot));
    }

    /** Wait until the dirty set is durable. */
    async flushDirty(): Promise<void> {
        await this.dirtyWrite;
    }

    /** Record files written since their last upload, with the generation of their latest write. */
    dirtyPaths(): { path: string; gen: number }[] {
        return Object.entries(this.dirty.paths).map(([path, gen]) => ({ path, gen })).sort((a, b) => a.gen - b.gen);
    }

    isDirty(path: string): boolean {
        return this.dirty.paths[path] !== undefined;
    }

    pendingUploadCount(): number {
        return Object.keys(this.dirty.paths).length;
    }

    /** The generation a path would be uploaded under: its dirty generation, or 0 when clean. */
    genOf(path: string): number {
        return this.dirty.paths[path] ?? 0;
    }

    /** Clear `path` from the dirty set iff it was not written again after `gen` was uploaded. */
    async markUploaded(uploads: readonly { path: string; gen: number }[]): Promise<void> {
        const paths = { ...this.dirty.paths };
        for (const u of uploads) {
            if (paths[u.path] === u.gen) delete paths[u.path];
        }
        this.dirty = { gen: this.dirty.gen, paths };
        const snapshot = JSON.stringify(this.dirty);
        this.dirtyWrite = this.dirtyWrite.catch(() => undefined).then(() => this.files.writeAtomic('dirty.json', snapshot));
        await this.dirtyWrite;
    }

    // schedule ----------------------------------------------------------------

    async readSchedule(): Promise<MeterSchedule | null> {
        const s = parseObject<MeterSchedule>(await this.files.read('schedule.json'));
        if (s === null) return null;
        const valid = [s.send_at_ms, s.mailbox_at_ms, s.proofs_at_ms].every((v) => typeof v === 'number' && Number.isFinite(v));
        return valid ? s : null;
    }

    /** Never marked dirty: the schedule is this phone's, not a record, and never reaches the cloud. */
    async writeSchedule(schedule: MeterSchedule): Promise<void> {
        await this.files.writeAtomic('schedule.json', JSON.stringify(schedule));
    }

    /** Every record file this phone holds (never `inflight.json`, `own.json`, `dirty.json`, `schedule.json`). */
    allRecordPaths(): string[] {
        const out: string[] = [];
        for (const chain of this.chains.values()) out.push(...chain.recordPaths());
        for (const log of this.receivedLogs.values()) out.push(...log.paths());
        out.push(...[...this.legacyPaths].sort());
        return out;
    }

    /** Counts for the Settings / Abundance surface. */
    async summary(): Promise<{ own: number; otherDevices: number; received: number; receivedArchived: number; legacy: number; batches: number; proofs: number }> {
        let otherDevices = 0;
        for (const [id, chain] of this.chains) {
            if (id !== this.ownId) otherDevices += (await chain.head()).count;
        }
        const own = this.own();
        return {
            own: (await own.head()).count,
            otherDevices,
            received: this.receivedCount(),
            receivedArchived: this.receivedArchived,
            legacy: this.legacyIds.size,
            batches: (await own.listBatches()).length,
            proofs: (await own.listProofs()).length,
        };
    }
}

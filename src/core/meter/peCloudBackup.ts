import type { BiometricAction } from '../security/biometricAction';
/**
 * PE METER (app) — the encrypted backup of every PE this phone holds, in the person's own
 * iCloud / Google Drive, and its restore on wallet recovery (: "make this
 * work rather than assume it does").
 *
 * WHAT IS UPLOADED. The PE store (`phonePeStore.ts`) is a set of small append-only record files:
 * each device chain's PE chunks, its accepted batches + receipts, its proofs, received (mailbox)
 * PEs, and pre-meter v1 history. Each backup publishes an independent encrypted snapshot. Changed
 * files get fresh immutable object names; unchanged objects may be shared between snapshots.
 * Objects referenced by a successful snapshot are never overwritten by another backup.
 *
 * ENCRYPTION. AES-256-GCM, the key derived from the wallet seed exactly as the PE archive key always
 * was: HKDF-SHA256(ikm = mnemonic, salt = the archive salt, info = 'provian-pe-archive-v2', 32 bytes)
 * the same key `PECloudSync` caches — so a recovered wallet derives it again. Every cloud file:
 *
 * { "v" 1, "alg" "AES-256-GCM", "nonce" <base64 12 bytes>, "data" <base64 ciphertext+tag> }
 *
 * with the cloud file NAME as associated data (a file cannot be swapped for another). Cloud file
 * names are opaque random identifiers. Each `pe_snapshot_<random>` manifest maps object names to
 * store paths, plaintext sha256 and sizes — itself encrypted; only the KDF salt and info are clear
 * (a salt is not secret, and a recovering phone needs it to derive the key):
 *
 * { "schema" "provian.pe-backup-index.v2", "kdf" { "salt" <hex>, "info"... }, "nonce", "data" }
 *
 * No PE, receipt, address, amount or description is ever written in clear.
 *
 * ORDER. Record objects first, the unique manifest last. The legacy v1 `pe_index` and its objects
 * remain readable and untouched. Restore lists and merges every committed snapshot, so concurrent
 * devices and restored foreign chains cannot replace or hide another device's successful records.
 * A file is marked uploaded only after its write returned; a write interrupted mid-way stays dirty
 * and goes again next time. The index entry carries the plaintext hash, so restore refuses a file
 * whose decrypted bytes are not the version the index names.
 *
 * RESTORE rebuilds the store by IMPORTING, never by copying files over: each device chain is
 * re-verified link by link and hash by hash from genesis before any of it is accepted
 * (`DeviceChainStore.importPes`), receipts and proofs are filed beside it, received PEs and legacy
 * history are filed under the directory they came from. It never asks the relay for a PE.
 */

import { gcm } from '@noble/ciphers/aes';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import type { CloudFileTransport, CloudKind } from './cloudFiles';
import type {
    AcceptedBatch,
    ChainRow,
    MeterBatchReceiptWire,
    PhonePeStore,
    ReceivedRow,
    StoredBatchProof,
} from './phonePeStore';
import { isArchivedRow, isArchivedReceived, PeStoreCorruptError } from './phonePeStore';
import type { ProvenanceEnvelope } from '../provenance/types';
import { cpuBudget, type CpuBudget } from './cpuBudget';
import { registerSeedDerivedCache } from '../security/seedDerivedCache';

export const PE_BACKUP_INDEX_NAME = 'pe_index';
export const PE_BACKUP_INDEX_SCHEMA = 'provian.pe-backup-index.v1';
export const PE_BACKUP_MANIFEST_PREFIX = 'pe_snapshot_';
export const PE_BACKUP_MANIFEST_SCHEMA = 'provian.pe-backup-index.v2';
export const PE_ARCHIVE_KDF_INFO = 'provian-pe-archive-v2';

export interface BackupKey {
    readonly saltHex: string;
    readonly key: Uint8Array;
}

/** Where the backup key comes from (`PECloudSync`'s seed-derived archive key in production). */
export interface BackupKeyProvider {
    /**
     * The key for this phone's current archive salt. `allowPrompt: false` must not show any OS
     * prompt; return null when the key is not obtainable silently right now.
     */
    current(options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction }): Promise<BackupKey | null>;
    /** The key for another salt (restore / a backup written by another phone). Null when not obtainable. */
    forSalt(saltHex: string, options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction }): Promise<Uint8Array | null>;
    /** From now on use this salt + key (so this phone keeps writing the same backup). */
    adopt(key: BackupKey): Promise<void>;
}

export interface CloudIndexEntry {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly written_at_ms: number;
}

export interface CloudIndex {
    readonly files: Record<string, CloudIndexEntry>;
    readonly updated_at_ms: number;
}

export type BackupState =
    | 'never'
    | 'ok'
    | 'waiting_for_unlock'
    | 'cloud_unavailable'
    | 'failed';

export interface BackupStatus {
    readonly state: BackupState;
    readonly cloud: CloudKind;
    readonly last_success_at_ms: number | null;
    readonly last_attempt_at_ms: number | null;
    readonly files_in_cloud: number;
    readonly pending_files: number;
    readonly error: string | null;
}

export interface BackupReport {
    readonly ok: boolean;
    readonly uploaded: number;
    readonly skippedUnchanged: number;
    readonly state: BackupState;
    readonly error: string | null;
}

export interface RestoreReport {
    readonly found: boolean;
    readonly devices: { readonly deviceId: string; readonly pes: number; readonly imported: number }[];
    readonly received: number;
    readonly legacy: number;
    readonly refusedFiles: string[];
    /** Every full on-phone record (v1 envelope) restored, for rebuilding the app's activity screens. */
    readonly envelopes: ProvenanceEnvelope[];
}

// ─── bytes ──────────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function sha256HexOfUtf8(text: string): string {
    return bytesToHex(sha256(utf8ToBytes(text)));
}

/** A one-way tag of a backup key: which key opened a cached snapshot (never the key itself). */
function keyIdOf(key: Uint8Array): string {
    return bytesToHex(sha256(utf8ToBytes(`provian.pe-backup.key-id.v1:${bytesToHex(key)}`)));
}

/** The opaque cloud name of a store path. */
export function cloudNameOf(path: string): string {
    return `pe_${sha256HexOfUtf8(`provian.pe-backup.path.v1\n${path}`).slice(0, 24)}`;
}

/** HKDF-SHA256(mnemonic, salt, 'provian-pe-archive-v2') — the PE archive key, exactly as PECloudSync derives it. */
export async function deriveArchiveKey(mnemonic: string, saltHex: string): Promise<Uint8Array> {
    const { hkdf } = await import('@noble/hashes/hkdf');
    return hkdf(sha256, utf8ToBytes(mnemonic), hexToBytes(saltHex), utf8ToBytes(PE_ARCHIVE_KDF_INFO), 32);
}

export function encryptFile(key: Uint8Array, name: string, plaintext: string, nonce: Uint8Array): string {
    if (key.length !== 32) throw new Error('backup_key_must_be_32_bytes');
    if (nonce.length !== 12) throw new Error('backup_nonce_must_be_12_bytes');
    const data = gcm(key, nonce, utf8ToBytes(name)).encrypt(utf8ToBytes(plaintext));
    return JSON.stringify({ v: 1, alg: 'AES-256-GCM', nonce: bytesToBase64(nonce), data: bytesToBase64(data) });
}

/** Decrypt one cloud file. Throws on a wrong key, a tampered byte, or a file stored under another name. */
export function decryptFile(key: Uint8Array, name: string, wire: string): string {
    const parsed = JSON.parse(wire) as { v?: unknown; alg?: unknown; nonce?: unknown; data?: unknown };
    if (parsed.v !== 1 || parsed.alg !== 'AES-256-GCM' || typeof parsed.nonce !== 'string' || typeof parsed.data !== 'string') {
        throw new Error('backup_file_malformed');
    }
    const plain = gcm(key, base64ToBytes(parsed.nonce), utf8ToBytes(name)).decrypt(base64ToBytes(parsed.data));
    return new TextDecoder().decode(plain);
}

interface IndexWire {
    readonly schema: string;
    readonly kdf: { readonly salt: string; readonly info: string };
    readonly nonce: string;
    readonly data: string;
}

function encryptIndex(key: BackupKey, index: CloudIndex, nonce: Uint8Array, name = PE_BACKUP_INDEX_NAME): string {
    const box = JSON.parse(encryptFile(key.key, name, JSON.stringify(index), nonce)) as { nonce: string; data: string };
    const wire: IndexWire = {
        schema: name === PE_BACKUP_INDEX_NAME ? PE_BACKUP_INDEX_SCHEMA : PE_BACKUP_MANIFEST_SCHEMA,
        kdf: { salt: key.saltHex, info: PE_ARCHIVE_KDF_INFO },
        nonce: box.nonce,
        data: box.data,
    };
    return JSON.stringify(wire);
}

function parseIndexWire(text: string, name = PE_BACKUP_INDEX_NAME): IndexWire {
    const w = JSON.parse(text) as Partial<IndexWire>;
    if (w.schema !== (name === PE_BACKUP_INDEX_NAME ? PE_BACKUP_INDEX_SCHEMA : PE_BACKUP_MANIFEST_SCHEMA) || !w.kdf || typeof w.kdf.salt !== 'string' || !/^[0-9a-f]{2,128}$/.test(w.kdf.salt)
        || w.kdf.info !== PE_ARCHIVE_KDF_INFO || typeof w.nonce !== 'string' || typeof w.data !== 'string') {
        throw new Error('backup_index_malformed');
    }
    return w as IndexWire;
}

function decryptIndex(key: Uint8Array, wire: IndexWire, name = PE_BACKUP_INDEX_NAME): CloudIndex {
    const text = decryptFile(key, name, JSON.stringify({ v: 1, alg: 'AES-256-GCM', nonce: wire.nonce, data: wire.data }));
    const index = JSON.parse(text) as CloudIndex;
    if (index === null || typeof index !== 'object' || typeof index.files !== 'object' || index.files === null) {
        throw new Error('backup_index_malformed');
    }
    return index;
}

// ─── the backup ─────────────────────────────────────────────────────────────────

export interface PeCloudBackupOptions {
    readonly store: PhonePeStore;
    readonly cloud: CloudFileTransport;
    readonly keys: BackupKeyProvider;
    readonly randomBytes: (n: number) => Uint8Array;
    readonly now?: () => number;
    /** Persist / read the status line (AsyncStorage in production; never a PE). */
    readonly statusStore?: { read(): Promise<BackupStatus | null>; write(status: BackupStatus): Promise<void> };
    readonly log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
    /**
     * SHA-256 (lowercase hex) of a file's UTF-8 text. Production passes the platform's native digest,
     * which runs off the JS thread: hashing every record file in JS held the thread for seconds per
     * run on a large store (findings, 2026-10-23). Must equal `sha256HexOfUtf8`.
     */
    readonly hashText?: (text: string) => Promise<string>;
    /** Paces each run's walk over the store (a fresh budget per run). */
    readonly budget?: () => CpuBudget;
}

/**
 * A native SHA-256 for `hashText`, checked once against the JS digest on a known text; on any
 * disagreement or failure the JS digest is used (the backup's hashes must never differ by platform).
 */
export function checkedTextHash(native: (text: string) => Promise<string>): (text: string) => Promise<string> {
    const probe = 'provian.pe-backup.hash-check.v1\n{"a":"é✓"}';
    let ok: Promise<boolean> | null = null;
    return async (text) => {
        ok ??= native(probe).then((h) => h === sha256HexOfUtf8(probe)).catch(() => false);
        if (await ok) {
            try {
                const h = await native(text);
                if (/^[0-9a-f]{64}$/.test(h)) return h;
            } catch { /* fall through to the JS digest */ }
        }
        return sha256HexOfUtf8(text);
    };
}

export class PeCloudBackup {
    private running: Promise<BackupReport> | null = null;
    private statusValue: BackupStatus;
    private readonly now: () => number;
    private readonly hashText: (text: string) => Promise<string>;
    /**
     * Snapshot manifests already read, by name. A `pe_snapshot_*` object is written once and never
     * replaced, so each is fetched and decrypted once per session, not on every run.
     */
    private readonly snapshotCache = new Map<string, { index: CloudIndex; salt: string; keyId: string }>();

    constructor(private readonly options: PeCloudBackupOptions) {
        this.now = options.now ?? Date.now;
        this.hashText = options.hashText ?? (async (text) => sha256HexOfUtf8(text));
        // A seed change (another wallet restored, Delete All Data) forgets every snapshot read so far.
        registerSeedDerivedCache(() => this.snapshotCache.clear());
        this.statusValue = {
            state: 'never',
            cloud: options.cloud.kind,
            last_success_at_ms: null,
            last_attempt_at_ms: null,
            files_in_cloud: 0,
            pending_files: 0,
            error: null,
        };
    }

    async loadStatus(): Promise<BackupStatus> {
        const saved = await this.options.statusStore?.read().catch(() => null);
        if (saved) this.statusValue = { ...saved, cloud: this.options.cloud.kind };
        return this.status();
    }

    status(): BackupStatus {
        return { ...this.statusValue, pending_files: this.options.store.isOpen() ? this.pendingPaths().length : this.statusValue.pending_files };
    }

    private pendingPaths(): string[] {
        return this.options.store.dirtyPaths().map((d) => d.path);
    }

    private async setStatus(patch: Partial<BackupStatus>): Promise<void> {
        this.statusValue = { ...this.statusValue, ...patch, cloud: this.options.cloud.kind };
        await this.options.statusStore?.write(this.status()).catch(() => undefined);
    }

    /** Interactive cloud sign-in belongs before the wallet biometric scope. */
    async prepareCloud(): Promise<boolean> {
        try { await this.options.cloud.prepare?.(); } catch { /* wallet recovery may still proceed offline */ }
        return this.options.cloud.available().catch(() => false);
    }

    /** Prime another phone's archive salt during unlock; authenticate the index before adoption. */
    async primeKey(biometricAction: BiometricAction): Promise<void> {
        const { cloud, keys } = this.options;
        if (!(await cloud.available())) return;
        const snapshots = await this.readIndexes({ allowPrompt: false, biometricAction });
        const latest = snapshots.indexes.sort((a, b) => b.index.updated_at_ms - a.index.updated_at_ms)[0];
        if (latest) await keys.adopt({ saltHex: latest.salt, key: latest.key });
    }

    /** Upload every record file not yet in the cloud. Single-flight; never throws. */
    async backup(options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction; readonly fresh?: boolean } = { allowPrompt: false }): Promise<BackupReport> {
        if (this.running) {
            const earlier = this.running;
            if (!options.biometricAction && !options.fresh) return earlier;
            // A user operation must run with its own approval after an earlier scheduled backup. A
            // `fresh` caller (the mailbox drain) needs files it filed after `earlier` started: wait it
            // out, then a run that starts now includes them.
            await earlier.catch(() => undefined);
            if (!options.biometricAction && this.running && this.running !== earlier) return this.running;
        }
        this.running = this.backupOnce(options)
            .catch(async (err): Promise<BackupReport> => {
                const error = (err as Error).message;
                await this.setStatus({ state: 'failed', error, last_attempt_at_ms: this.now() });
                this.options.log?.('warn', 'pe backup failed; it is retried', { error });
                return { ok: false, uploaded: 0, skippedUnchanged: 0, state: 'failed', error };
            })
            .finally(() => { this.running = null; });
        return this.running;
    }

    private async backupOnce(options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction }): Promise<BackupReport> {
        const { store, cloud, keys } = this.options;
        const startedAt = this.now();
        await store.flushDirty();
        if (!(await cloud.available())) {
            await this.setStatus({ state: 'cloud_unavailable', last_attempt_at_ms: startedAt, error: null });
            return { ok: false, uploaded: 0, skippedUnchanged: 0, state: 'cloud_unavailable', error: null };
        }
        let key = await keys.current(options);
        if (key === null) {
            await this.setStatus({ state: 'waiting_for_unlock', last_attempt_at_ms: startedAt, error: null });
            return { ok: false, uploaded: 0, skippedUnchanged: 0, state: 'waiting_for_unlock', error: null };
        }

        // The cloud's index (another phone of this wallet, or this phone's last run).
        let index: CloudIndex = { files: {}, updated_at_ms: 0 };
        const rawIndex = await cloud.read(PE_BACKUP_INDEX_NAME);
        if (rawIndex !== null) {
            const wire = parseIndexWire(rawIndex);
            if (wire.kdf.salt !== key.saltHex) {
                // The backup was started under another salt (an earlier phone of this wallet). Join it.
                const other = await keys.forSalt(wire.kdf.salt, options);
                if (other === null) {
                    await this.setStatus({ state: 'waiting_for_unlock', last_attempt_at_ms: startedAt, error: null });
                    return { ok: false, uploaded: 0, skippedUnchanged: 0, state: 'waiting_for_unlock', error: null };
                }
                key = { saltHex: wire.kdf.salt, key: other };
                await keys.adopt(key);
            }
            index = decryptIndex(key.key, wire);
        }

        // Immutable versions and independently discoverable commits. Never replace the legacy
        // index or any object it names; it remains a valid recovery source during migration.
        const committed = await this.readIndexes(options);
        if (committed.indexes[0] && committed.indexes[0].salt !== key.saltHex) {
            key = { key: committed.indexes[0].key, saltHex: committed.indexes[0].salt };
            await keys.adopt(key);
        }
        const known = new Map<string, string>();
        for (const snapshot of committed.indexes) {
            if (snapshot.salt !== key.saltHex) continue;
            for (const [name, entry] of Object.entries(snapshot.index.files)) {
                known.set(`${entry.path}:${entry.sha256}`, name);
            }
        }
        const dirty = new Map(store.dirtyPaths().map((d) => [d.path, d.gen]));
        const files: Record<string, CloudIndexEntry> = {};
        const uploaded: { path: string; gen: number }[] = [];
        let skippedUnchanged = 0;
        let written = 0;
        const budget = this.options.budget?.() ?? cpuBudget();
        for (const path of store.allRecordPaths()) {
            await budget.pace();
            // Capture the generation BEFORE reading; a concurrent append remains dirty.
            const gen = dirty.get(path) ?? store.genOf(path);
            const text = await store.files.read(path);
            if (text === null) continue;
            const sha = await this.hashText(text);
            let name = known.get(`${path}:${sha}`);
            if (name === undefined) {
                name = `pe_object_${bytesToHex(this.options.randomBytes(24))}`;
                await cloud.write(name, encryptFile(key.key, name, text, this.options.randomBytes(12)));
                written += 1;
            } else if (dirty.has(path)) skippedUnchanged += 1;
            files[name] = { path, sha256: sha, bytes: utf8ToBytes(text).length, written_at_ms: this.now() };
            if (dirty.has(path)) uploaded.push({ path, gen });
        }
        const nextIndex: CloudIndex = { files, updated_at_ms: this.now() };
        // Publish last. A crash before this point leaves only unreachable new objects, never
        // damages a successful backup. Each phone/attempt has its own name (no lost update).
        if (written > 0 || dirty.size > 0 || committed.indexes.length === 0) {
            const name = `${PE_BACKUP_MANIFEST_PREFIX}${bytesToHex(this.options.randomBytes(24))}`;
            await cloud.write(name, encryptIndex(key, nextIndex, this.options.randomBytes(12), name));
            // This session wrote it, so it never needs reading back.
            this.snapshotCache.set(name, { index: nextIndex, salt: key.saltHex, keyId: keyIdOf(key.key) });
        }
        // Only now — every file and the index that names it are in the cloud.
        await store.markUploaded(uploaded);
        const pending = store.pendingUploadCount();
        await this.setStatus({
            state: 'ok',
            last_success_at_ms: this.now(),
            last_attempt_at_ms: startedAt,
            files_in_cloud: Object.keys(files).length,
            pending_files: pending,
            error: null,
        });
        if (written > 0) this.options.log?.('info', 'pe backup: files written to the cloud', { written, pending });
        return { ok: pending === 0, uploaded: written, skippedUnchanged, state: 'ok', error: null };
    }

    private async readIndexes(options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction }): Promise<{
        indexes: { index: CloudIndex; key: Uint8Array; salt: string }[]; refused: string[];
    }> {
        const { cloud, keys } = this.options;
        const names = (await cloud.list()).filter((n) => n === PE_BACKUP_INDEX_NAME || /^pe_snapshot_[0-9a-f]{48}$/.test(n));
        const indexes: { index: CloudIndex; key: Uint8Array; salt: string }[] = [];
        const refused: string[] = [];
        let keyUnavailable = false;
        // Older transports may not list the legacy index (it used Keychain). Read it explicitly.
        if (!names.includes(PE_BACKUP_INDEX_NAME)) names.unshift(PE_BACKUP_INDEX_NAME);
        const saltKeys = new Map<string, Uint8Array | null>();
        const keyFor = async (salt: string): Promise<Uint8Array | null> => {
            if (!saltKeys.has(salt)) saltKeys.set(salt, await keys.forSalt(salt, options));
            return saltKeys.get(salt) ?? null;
        };
        const budget = this.options.budget?.() ?? cpuBudget();
        for (const name of names) {
            await budget.pace();
            try {
                const cached = name === PE_BACKUP_INDEX_NAME ? undefined : this.snapshotCache.get(name);
                if (cached !== undefined) {
                    const key = await keyFor(cached.salt);
                    if (key === null) { keyUnavailable = true; throw new Error('backup_key_unavailable'); }
                    // Only the key that opened it may reuse it; any other key reads it again (and the
                    // AEAD check refuses it if that key cannot open it).
                    if (keyIdOf(key) === cached.keyId) {
                        indexes.push({ index: cached.index, key, salt: cached.salt });
                        continue;
                    }
                    this.snapshotCache.delete(name);
                }
                const raw = await cloud.read(name);
                if (raw === null) continue;
                const wire = parseIndexWire(raw, name);
                const key = await keyFor(wire.kdf.salt);
                if (key === null) { keyUnavailable = true; throw new Error('backup_key_unavailable'); }
                const index = decryptIndex(key, wire, name);
                // Only a snapshot that decrypted under its key is remembered; the legacy index is read each time.
                if (name !== PE_BACKUP_INDEX_NAME) this.snapshotCache.set(name, { index, salt: wire.kdf.salt, keyId: keyIdOf(key) });
                indexes.push({ index, key, salt: wire.kdf.salt });
            } catch {
                // An interrupted new commit or damaged manifest must not hide older good commits.
                refused.push(`${name}:undecryptable`);
            }
        }
        if (indexes.length === 0 && refused.length > 0) throw new Error(keyUnavailable ? 'backup_key_unavailable' : 'backup_indexes_unreadable');
        return { indexes, refused };
    }

    /**
     * Restore everything the cloud holds into the (open) store. Requires the seed-derived key
     * (`forSalt` with a live biometric session). Never asks the relay for anything.
     */
    async restore(biometricAction?: BiometricAction): Promise<RestoreReport> {
        const { store, cloud, keys } = this.options;
        const empty: RestoreReport = { found: false, devices: [], received: 0, legacy: 0, refusedFiles: [], envelopes: [] };
        // Explicit callers prepare cloud sign-in before authenticating. Legacy/injected callers
        // without a capability retain their preparation behavior.
        if (!biometricAction) await cloud.prepare?.();
        if (!(await cloud.available())) throw new Error('cloud_unavailable');
        const snapshots = await this.readIndexes({ allowPrompt: true, biometricAction });
        if (snapshots.indexes.length === 0) return empty;
        const latest = [...snapshots.indexes].sort((a, b) => b.index.updated_at_ms - a.index.updated_at_ms)[0];
        await keys.adopt({ saltHex: latest.salt, key: latest.key });
        const refusedFiles: string[] = [...snapshots.refused];
        const chains = new Map<string, { pes: ChainRow[]; batches: { batch: AcceptedBatch; receipt: MeterBatchReceiptWire | null }[]; proofs: StoredBatchProof[] }>();
        const received = new Map<string, ReceivedRow[]>();
        const legacy = new Map<string, ProvenanceEnvelope[]>();
        const deviceOfDir = new Map<string, string>();

        const entries = snapshots.indexes.flatMap((s) => Object.entries(s.index.files).map(([name, entry]) => ({ name, entry, key: s.key })));
        const seenObjects = new Set<string>();
        for (const { name, entry, key } of entries) {
            if (seenObjects.has(name)) continue;
            seenObjects.add(name);
            let raw: string | null;
            try { raw = await cloud.read(name); }
            catch { refusedFiles.push(`${entry.path}:unreadable`); continue; }
            if (raw === null) {
                refusedFiles.push(`${entry.path}:missing`);
                continue;
            }
            let text: string;
            try {
                text = decryptFile(key, name, raw);
            } catch {
                refusedFiles.push(`${entry.path}:undecryptable`);
                continue;
            }
            if (sha256HexOfUtf8(text) !== entry.sha256) {
                refusedFiles.push(`${entry.path}:not_the_indexed_version`);
                continue;
            }
            const parts = entry.path.split('/');
            try {
                if (parts[0] === 'chains' && parts.length >= 3) {
                    const dir = parts[1];
                    const slot = chains.get(dir) ?? { pes: [], batches: [], proofs: [] };
                    chains.set(dir, slot);
                    if (parts[2] === 'meta.json') {
                        const meta = JSON.parse(text) as { device_id?: unknown };
                        if (typeof meta.device_id === 'string') deviceOfDir.set(dir, meta.device_id);
                    } else if (parts[2] === 'pes') slot.pes.push(...(JSON.parse(text) as ChainRow[]));
                    else if (parts[2] === 'batches') slot.batches.push(...(JSON.parse(text) as { batch: AcceptedBatch; receipt: MeterBatchReceiptWire | null }[]));
                    else if (parts[2] === 'proofs') slot.proofs.push(...(JSON.parse(text) as StoredBatchProof[]));
                } else if (parts[0] === 'received' && parts.length === 3) {
                    received.set(parts[1], [...(received.get(parts[1]) ?? []), ...(JSON.parse(text) as ReceivedRow[])]);
                } else if (parts[0] === 'legacy' && parts.length === 3) {
                    legacy.set(parts[1], [...(legacy.get(parts[1]) ?? []), ...(JSON.parse(text) as ProvenanceEnvelope[])]);
                }
            } catch {
                refusedFiles.push(`${entry.path}:unparseable`);
            }
        }

        const devices: RestoreReport['devices'] = [];
        const envelopes: ProvenanceEnvelope[] = [];
        for (const [dir, slot] of chains) {
            const first = slot.pes.find((e) => !isArchivedRow(e));
            const deviceId = deviceOfDir.get(dir) ?? (first !== undefined && !isArchivedRow(first) ? first.pe.device_id : undefined);
            if (typeof deviceId !== 'string') {
                refusedFiles.push(`chains/${dir}:no_device_id`);
                continue;
            }
            const chain = await store.chain(deviceId);
            try {
                // Re-verified link by link from genesis; one bad PE refuses the whole device's chain.
                const rows = new Map<number, ChainRow>();
                for (const row of slot.pes) {
                    const held = rows.get(row.index);
                    const hash = isArchivedRow(row) ? row.archived.pe_hash : row.pe.pe_hash;
                    const heldHash = held && (isArchivedRow(held) ? held.archived.pe_hash : held.pe.pe_hash);
                    if (held && hash !== heldHash) throw new PeStoreCorruptError(`${dir}: conflicting backup position ${row.index}`);
                    // A confirmed Archive pointer is an intentional local-content drop, not a
                    // shorter chain. An old full snapshot must not undo it on ordinary restore.
                    if (!held || isArchivedRow(row)) rows.set(row.index, row);
                }
                const { imported } = await chain.importPes([...rows.values()]);
                await chain.importBatches(slot.batches);
                await chain.importProofs(slot.proofs);
                devices.push({ deviceId, pes: rows.size, imported });
                for (const e of rows.values()) if (!isArchivedRow(e) && e.detail) envelopes.push(e.detail);
            } catch (err) {
                if (!(err instanceof PeStoreCorruptError)) throw err;
                refusedFiles.push(`chains/${dir}:${err.message}`);
            }
        }
        let receivedCount = 0;
        // Received copies deduplicate globally by hash, across phone directories. Select confirmed
        // Archive pointers before importing, so an old full copy cannot win the first-write fence.
        const receivedByHash = new Map<string, { dir: string; row: ReceivedRow }>();
        for (const [dir, items] of received) for (const row of items) {
            const held = receivedByHash.get(row.pe_hash);
            const chosen = !held || isArchivedReceived(row) ? { dir, row } : held;
            if (held && !chosen.row.inclusion && held.row.inclusion) chosen.row = { ...chosen.row, inclusion: held.row.inclusion };
            if (!chosen.row.inclusion && row.inclusion) chosen.row = { ...chosen.row, inclusion: row.inclusion };
            receivedByHash.set(row.pe_hash, chosen);
        }
        const mergedReceived = new Map<string, ReceivedRow[]>();
        for (const { dir, row } of receivedByHash.values()) mergedReceived.set(dir, [...(mergedReceived.get(dir) ?? []), row]);
        for (const [dir, items] of mergedReceived) receivedCount += await store.importReceived(dir, items);
        let legacyCount = 0;
        for (const [dir, envs] of legacy) {
            legacyCount += await store.addLegacy(envs, dir);
            envelopes.push(...envs);
        }
        await this.setStatus({ state: 'ok', last_success_at_ms: latest.index.updated_at_ms || null, files_in_cloud: entries.length, error: null });
        return { found: true, devices, received: receivedCount, legacy: legacyCount, refusedFiles, envelopes };
    }
}

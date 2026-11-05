import type { BiometricAction } from '../security/biometricAction';
/**
 * PE METER (app) — the phone's meter: one object that records every PE v2, batches it daily,
 * files proofs and receipts, drains the mailbox, and keeps the encrypted cloud backup current
 *. Dependencies are injected so the whole loop runs under Vitest;
 * `phoneMeterRuntime.ts` wires the real ones.
 *
 * RECORDING. The app's `ProvenanceEnvelopeManager` still builds and signs the full on-phone
 * record of each act (the envelope its screens show). Once that record is durable, the meter
 * builds the act's PE v2 (`phonePeBuilder.ts`) at the head of THIS device's chain and appends it,
 * with the record kept beside it as its committed detail. Recording is serial (one queue), so the
 * chain order is the order the acts were recorded.
 *
 * MIGRATION. Envelopes that existed before the meter started on this install are history: they
 * are copied, unchanged, into the store's legacy section (and so into the backup) and are NEVER
 * re-chained into the device chain or metered. The cut-over is the first start on this install.
 * Envelopes recorded after the cut-over that are missing from the chain (the app stopped between
 * the record and its PE v2) are caught up at the next start.
 */

import type { ArchiveObjectCache } from './archiveObjectCache';
import { preflightPresentationProofs, type EthCall, type PresentationProofInput } from './pe-export-wire';
import type { ProvenanceEnvelope } from '../provenance/types';
import { buildPhonePeV2, type HardwareWitnessProvider, type PeSigner } from './phonePeBuilder';
import { PhonePeStore, type MeterBatchReceiptWire, type MeterHalt } from './phonePeStore';
import { backupCompleted, PhoneBatcher, type MailboxProgress, type MeterLog } from './phoneBatcher';
import { PeCloudBackup, type BackupKeyProvider, type BackupReport, type BackupStatus, type RestoreReport } from './peCloudBackup';
import type { CloudFileTransport } from './cloudFiles';
import type { MeterFiles } from './meterFiles';
import type { MeterTransport } from './meterTransport';
import { drainRelayAuthoredInbox } from './relayAuthoredInbox';
import { PhoneArchiveKeeper, type PhoneArchiveLocalState, type PhoneArchiveTransport } from './phoneArchive';
import { buildPhonePeExport, drainMailboxForPhoneExport, type PhonePeExportProgress, type PhonePeExportResult } from './phoneExport';

export const METER_CUTOVER_KEY = 'provian_meter_cutover_ms_v1';
export const METER_LEGACY_HOT_KEY = 'provian_meter_legacy_hot_migrated_v1';
export const METER_LEGACY_ARCHIVES_KEY = 'provian_meter_legacy_archives_migrated_v1';
export const METER_BACKUP_STATUS_KEY = 'provian_meter_backup_status_v1';
/** The PE Archive keeper's last status line (never a PE). */
export const METER_ARCHIVE_STATUS_KEY = 'provian_meter_archive_status_v1';
/** Retry lists of the retired single-PE submit (never PEs — the envelopes stay in history). */
export const RETIRED_SUBMIT_KEYS: readonly string[] = ['provian_pe_submit_queue', 'provian_pe_backfill_cursor'];

/** The meter ticks this often while the app is in the foreground; each part keeps its own schedule. */
export const METER_TICK_MS = 5 * 60 * 1000;
export const METER_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
/** With nothing backed up for this long, a foreground backup may ask for Face ID / the passcode once. */
export const METER_BACKUP_PROMPT_AFTER_MS = 24 * 60 * 60 * 1000;

export interface KeyValue {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/** The app's v1 activity records (PELifecycleManager / PECloudSync). */
export interface ActivityRecords {
    /** Every envelope in the hot tier (cheap; no key needed). */
    hot(): Promise<ProvenanceEnvelope[]>;
    /** Every envelope in this device's month archives. Needs the archive key; null when not obtainable silently. */
    archived(options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction }): Promise<ProvenanceEnvelope[] | null>;
    /** Put restored envelopes back where the app's screens read them. Returns how many were new. */
    restore(envelopes: readonly ProvenanceEnvelope[], biometricAction?: BiometricAction): Promise<number>;
}

export interface PhoneMeterDeps {
    readonly files: MeterFiles;
    readonly cloud: CloudFileTransport;
    readonly transport: MeterTransport;
    /** Per-operation transports; the singleton never retains a user approval. */
    readonly actionTransport?: (action: BiometricAction) => MeterTransport;
    readonly actionArchiveTransport?: (action: BiometricAction) => PhoneArchiveTransport;
    /** The paid PE Archive's wallet-auth surface . Absent = no Archive on this build. */
    readonly archiveTransport?: PhoneArchiveTransport;
    /** The local window for confirmed Archive days : unset = the ruled 30; may only shorten. */
    readonly archiveKeepDays?: number;
    /** Where pulled Archive days are kept so one pull serves repeated use. */
    readonly archiveObjectCache?: ArchiveObjectCache;
    /** Read-only Base `eth_call` for the Archive's on-chain anchor check. */
    readonly archiveEthCall?: EthCall;
    readonly backupKeys: BackupKeyProvider;
    readonly kv: KeyValue;
    readonly activity: ActivityRecords;
    /** The relay device id this phone's wallet-auth token carries. */
    deviceId(): Promise<string>;
    /** Canonical hash of a full on-phone record (the envelope chain hash). */
    detailHash(envelope: ProvenanceEnvelope): Promise<string>;
    privacySecret?(): Promise<string>;
    readonly witness?: HardwareWitnessProvider;
    readonly sign?: PeSigner;
    /** The person's x25519 message secret; `allowPrompt` false must not prompt. */
    messageSecretKey(options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction }): Promise<Uint8Array | null>;
    openBox(secret: Uint8Array, boxB64u: string): string | null;
    /** Publish the person's message key if it has not been (so PEs can be sealed to them). */
    ensureMessageKeyPublished?(options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction }): Promise<boolean>;
    randomBytes(n: number): Uint8Array;
    /** SHA-256 hex of a backup file's text, off the JS thread (see `PeCloudBackupOptions.hashText`). */
    readonly hashText?: (text: string) => Promise<string>;
    isForeground(): boolean;
    /** The person has unlocked the wallet this run. No prompt is ever shown before that. Absent = unlocked. */
    isUnlocked?(): boolean;
    readonly now?: () => number;
    readonly log?: MeterLog;
}

export interface PhoneMeterStatus {
    readonly started: boolean;
    readonly deviceId: string | null;
    readonly ownPes: number;
    readonly unsentPes: number;
    readonly otherDevicePes: number;
    readonly receivedPes: number;
    /** Of `receivedPes`, the ones dropped from this phone and kept in the agent's Archive. */
    readonly receivedArchivedPes: number;
    readonly legacyRecords: number;
    readonly batches: number;
    readonly proofs: number;
    readonly halt: MeterHalt | null;
    readonly backup: BackupStatus;
}

export class PhoneMeter {
    readonly store: PhonePeStore;
    readonly backup: PeCloudBackup;
    /** The paid PE Archive keeper (upload, drop confirmed days older than 30 days, pull). */
    readonly archive: PhoneArchiveKeeper | null;
    batcher: PhoneBatcher | null = null;
    private ready: Promise<void> | null = null;
    private recordQueue: Promise<void> = Promise.resolve();
    private cutoverMs = 0;
    private lastBackupAttemptMs = 0;
    private lastPromptedBackupMs = 0;
    private readonly listeners = new Set<() => void>();
    private filingValue: MailboxProgress | null = null;
    private readonly now: () => number;
    private readonly log: MeterLog;

    constructor(private readonly deps: PhoneMeterDeps) {
        this.now = deps.now ?? Date.now;
        this.log = deps.log ?? (() => undefined);
        this.store = new PhonePeStore(deps.files);
        this.backup = new PeCloudBackup({
            store: this.store,
            cloud: deps.cloud,
            keys: deps.backupKeys,
            randomBytes: deps.randomBytes,
            now: this.now,
            ...(deps.hashText ? { hashText: deps.hashText } : {}),
            statusStore: {
                read: async () => {
                    const raw = await deps.kv.getItem(METER_BACKUP_STATUS_KEY);
                    return raw ? JSON.parse(raw) as BackupStatus : null;
                },
                write: (status) => deps.kv.setItem(METER_BACKUP_STATUS_KEY, JSON.stringify(status)),
            },
            log: (level, msg, extra) => this.log(level, msg, extra),
        });
        this.archive = deps.archiveTransport
            ? new PhoneArchiveKeeper({
                store: this.store,
                transport: deps.archiveTransport,
                localKeepDays: deps.archiveKeepDays,
                ...(deps.archiveObjectCache ? { objectCache: deps.archiveObjectCache } : {}),
                ...(deps.archiveEthCall ? { ethCall: deps.archiveEthCall } : {}),
                // The same rule as the mailbox: Face ID may be asked for only with the app in front and
                // the wallet unlocked, never on the lock screen. A person's phone derives the key only on
                // a prompt (unlocking does not open the seed), so a keeper that never prompted could not
                // verify and drop a confirmed day (, found live).
                messageSecretKey: () => deps.messageSecretKey({ allowPrompt: deps.isForeground() && this.unlocked() }),
                randomBytes: deps.randomBytes,
                now: this.now,
                log: (level, msg, extra) => this.log(level, msg, extra),
                stateStore: {
                    read: async () => {
                        const raw = await deps.kv.getItem(METER_ARCHIVE_STATUS_KEY);
                        return raw ? JSON.parse(raw) as PhoneArchiveLocalState : null;
                    },
                    write: (state) => deps.kv.setItem(METER_ARCHIVE_STATUS_KEY, JSON.stringify(state)),
                },
            })
            : null;
    }

    /**
     * Records from the person's agents and devices being filed right now (the home screen's quiet
     * "Filing N records" line), or null when nothing is being filed.
     */
    filing(): MailboxProgress | null {
        return this.filingValue;
    }

    /** Subscribe to changes (a batch accepted, a PE recorded, a backup finished, filing progress). */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const l of this.listeners) {
            try { l(); } catch { /* a listener never breaks the meter */ }
        }
    }

    /** Open the store, set the cut-over, migrate history, catch up. Idempotent. */
    start(): Promise<void> {
        if (!this.ready) {
            this.ready = this.startOnce().catch((err) => {
                this.ready = null;
                throw err;
            });
        }
        return this.ready;
    }

    private async startOnce(): Promise<void> {
        const { kv } = this.deps;
        const deviceId = await this.deps.deviceId();
        await this.store.open(deviceId);
        await this.backup.loadStatus();
        const savedCutover = Number(await kv.getItem(METER_CUTOVER_KEY));
        if (Number.isSafeInteger(savedCutover) && savedCutover > 0) {
            this.cutoverMs = savedCutover;
        } else {
            this.cutoverMs = this.now();
            await kv.setItem(METER_CUTOVER_KEY, String(this.cutoverMs));
        }
        for (const key of RETIRED_SUBMIT_KEYS) await kv.removeItem(key).catch(() => undefined);
        this.batcher = new PhoneBatcher({
            store: this.store,
            transport: this.deps.transport,
            log: this.log,
            now: this.now,
            messageSecretKey: () => this.deps.messageSecretKey({ allowPrompt: this.deps.isForeground() && this.unlocked() }),
            openBox: (secret, box) => this.deps.openBox(secret, box),
            // fresh: the drain acknowledges only what this backup carried, so it must include the page just filed.
            backupNow: async () => backupCompleted(await this.backupNow({ allowPrompt: false, fresh: true })),
            onMailboxProgress: (progress) => {
                this.filingValue = progress;
                this.emit();
            },
            onAccepted: (receipt: MeterBatchReceiptWire) => {
                this.log('info', 'pe meter: batch accepted', { seq: receipt.seq, acts: receipt.acts.length });
                void this.backupNow({ allowPrompt: false });
                this.emit();
            },
        });
        await this.fileRelayAuthoredNow();
        await this.migrateLegacyHot();
        await this.catchUp();
    }

    /**
     * File PEs the relay handed over directly (registration's `firstEnvelope`) into the store, then
     * back them up. Callable any time; does nothing before the store is open.
     */
    async fileRelayAuthored(): Promise<number> {
        await this.start();
        const filed = await this.fileRelayAuthoredNow();
        if (filed > 0) {
            this.emit();
            await this.backupNow({ allowPrompt: false });
        }
        return filed;
    }

    private async fileRelayAuthoredNow(): Promise<number> {
        try {
            return await drainRelayAuthoredInbox(this.store, this.deps.kv, this.now());
        } catch (err) {
            this.log('warn', 'pe meter: could not file a relay-returned PE yet', { error: (err as Error).message });
            return 0;
        }
    }

    /** Pre-cut-over hot-tier envelopes become legacy history (once). */
    private async migrateLegacyHot(): Promise<void> {
        if ((await this.deps.kv.getItem(METER_LEGACY_HOT_KEY)) === '1') return;
        const hot = await this.deps.activity.hot();
        const legacy = hot.filter((e) => e.timestamp < this.cutoverMs);
        const added = await this.store.addLegacy(legacy);
        await this.deps.kv.setItem(METER_LEGACY_HOT_KEY, '1');
        if (added > 0) this.log('info', 'pe meter: pre-meter activity kept as history', { added });
    }

    /** Pre-cut-over month archives become legacy history (once the archive key is at hand). */
    async migrateLegacyArchives(options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction }): Promise<boolean> {
        if ((await this.deps.kv.getItem(METER_LEGACY_ARCHIVES_KEY)) === '1') return true;
        const archived = await this.deps.activity.archived(options);
        if (archived === null) return false;
        await this.store.addLegacy(archived.filter((e) => e.timestamp < this.cutoverMs));
        await this.deps.kv.setItem(METER_LEGACY_ARCHIVES_KEY, '1');
        return true;
    }

    /** Post-cut-over envelopes with no PE v2 yet (the app stopped in between) get theirs now. */
    private async catchUp(): Promise<void> {
        const hot = await this.deps.activity.hot();
        const missing = hot
            .filter((e) => e.timestamp >= this.cutoverMs)
            .sort((a, b) => a.timestamp - b.timestamp || (a.envelope_id < b.envelope_id ? -1 : 1));
        // Directly, not through the queue: a queued record waits for start(), and this runs inside it.
        if (missing.length > 0) await this.recordNow(missing);
    }

    /**
     * Record the PE v2 of each durable on-phone record, in order. Never throws (a failure is
     * logged and caught up at the next start). An envelope any chain already carries, or that is
     * pre-meter history, is skipped — so a restored envelope is never metered a second time.
     */
    record(envelopes: readonly ProvenanceEnvelope[]): Promise<void> {
        const run = async (): Promise<void> => {
            await this.start();
            await this.recordNow(envelopes);
        };
        const next = this.recordQueue.then(run, run);
        this.recordQueue = next.catch((err) => {
            this.log('warn', 'pe meter: recording failed; it is caught up at the next start', { error: (err as Error).message });
        });
        return this.recordQueue;
    }

    private async recordNow(envelopes: readonly ProvenanceEnvelope[]): Promise<void> {
        let recorded = 0;
        for (const env of envelopes) {
            if (!env || typeof env.envelope_id !== 'string') continue;
            if (this.store.hasLegacy(env.envelope_id) || (await this.store.hasPeIdAnywhere(env.envelope_id))) continue;
            if (env.timestamp < this.cutoverMs) continue;
            const chain = this.store.own();
            const detailHash = await this.deps.detailHash(env);
            const privacySecret=await this.deps.privacySecret?.();
            const result = await chain.withAppendLock(async () => {
                const head = await chain.head();
                const pe = await buildPhonePeV2({
                    envelope: env,
                    detailHash,
                    privacySecret,
                    deviceId: chain.deviceId,
                    prevHash: head.last_pe_hash,
                    witness: this.deps.witness,
                    sign: this.deps.sign,
                });
                return chain.appendLocked(pe, { recordedAtMs: this.now(), detail: env });
            });
            if (!result.ok) {
                this.log('error', 'pe meter: a PE could not join this device\'s chain', {
                    envelope_id: env.envelope_id, reason: result.reason, ...(result.reason === 'invalid' ? { detail: result.detail } : {}),
                });
                continue;
            }
            if (!result.replay) recorded += 1;
        }
        if (recorded > 0) this.emit();
    }

    /** Verify the selected proof roots on Base before authorizing a presentation burn. */
    async preflightPresentation(facts: readonly PresentationProofInput[]): Promise<void> {
        if (facts.length === 0) return;
        if (!this.deps.archiveEthCall) throw new Error('presentation_proof_invalid:anchor_check_unavailable');
        await preflightPresentationProofs(facts, this.deps.archiveEthCall);
    }

    /**
     * Send the latest acts now, right before a presentation or an on-demand payout (the operator,
     * 2026-10-04). Never throws: a presentation or payout the relay cannot serve fails on its own.
     */
    async sendBeforeUse(): Promise<'sent' | 'nothing_to_send' | 'not_sent'> {
        try {
            await this.start();
            const report = await this.batcher?.flushBeforeUse();
            this.emit();
            if (!report) return 'not_sent';
            return report.outcome === 'sent' || report.outcome === 'nothing_to_send' ? report.outcome : 'not_sent';
        } catch (err) {
            this.log('warn', 'pe meter: could not send before use', { error: (err as Error).message });
            return 'not_sent';
        }
    }

    /** Foreground / timer tick: batch, mailbox, proofs, message key, backup — each on its schedule. */
    async tick(reason: 'timer' | 'foreground'): Promise<void> {
        try {
            await this.start();
        } catch (err) {
            this.log('warn', 'pe meter could not start', { error: (err as Error).message });
            return;
        }
        const foreground = this.deps.isForeground();
        if (this.deps.ensureMessageKeyPublished) {
            await this.deps.ensureMessageKeyPublished({ allowPrompt: false }).catch(() => false);
        }
        await this.fileRelayAuthoredNow();
        await this.batcher?.tick(reason);
        await this.migrateLegacyArchives({ allowPrompt: false }).catch(() => false);
        // Before the backup: a day dropped here marks its chunks for upload, so the cloud copy drops it too.
        if (this.store.isOpen()) await this.archive?.tick();
        const now = this.now();
        const status = this.backup.status();
        if (status.pending_files > 0 || status.state === 'never') {
            const longOverdue = now - (status.last_success_at_ms ?? 0) >= METER_BACKUP_PROMPT_AFTER_MS
                && now - this.lastPromptedBackupMs >= METER_BACKUP_PROMPT_AFTER_MS;
            const due = reason === 'foreground' || now - this.lastBackupAttemptMs >= METER_BACKUP_INTERVAL_MS;
            if (due || longOverdue) {
                // A prompt only when it can achieve something and the person is in the app with the
                // wallet unlocked: never on the lock screen, never when the cloud is off.
                const allowPrompt = foreground && longOverdue && this.unlocked() && (await this.cloudAvailable());
                if (allowPrompt) this.lastPromptedBackupMs = now;
                await this.backupNow({ allowPrompt });
            }
        }
        this.emit();
    }

    /**
     * Right after the wallet unlocks: file the mailbox with the key the unlock just cached (no prompt
     * of its own;), then re-run the PE Archive keeper if it last stopped for want
     * of the key.
     */
    async afterUnlock(): Promise<void> {
        try {
            await this.start();
        } catch {
            return;
        }
        if (this.batcher) {
            const report = await this.batcher.drainAfterUnlock();
            if (report.received > 0 || report.acked > 0) this.emit();
        }
        if (this.archive?.keyAvailable()) await this.tick('foreground');
    }

    /** Back up using derived caches or the current explicit user approval. */
    async backupNow(options: { readonly allowPrompt: boolean; readonly biometricAction?: BiometricAction; readonly fresh?: boolean }): Promise<BackupReport> {
        await this.start();
        this.lastBackupAttemptMs = this.now();
        // Nothing to unlock a key for when the cloud is off: never prompt for a backup that cannot run.
        const allowPrompt = options.allowPrompt && this.unlocked() && (await this.cloudAvailable());
        if (allowPrompt) await this.migrateLegacyArchives({ allowPrompt, biometricAction: options.biometricAction }).catch(() => false);
        const report = await this.backup.backup({ allowPrompt, biometricAction: options.biometricAction, fresh: options.fresh });
        // Publish under the same approval, or from the existing message-key cache. Scheduling
        // permission alone never opens a native prompt.
        if (this.deps.ensureMessageKeyPublished) {
            const keyPrompt = options.allowPrompt && this.unlocked();
            await this.deps.ensureMessageKeyPublished({ allowPrompt: keyPrompt, biometricAction: options.biometricAction }).catch(() => false);
        }
        this.emit();
        return report;
    }

    private unlocked(): boolean {
        try {
            return this.deps.isUnlocked ? this.deps.isUnlocked() : true;
        } catch {
            return false;
        }
    }

    private async cloudAvailable(): Promise<boolean> {
        try {
            return await this.deps.cloud.available();
        } catch {
            return false;
        }
    }

    /**
     * Wallet recovery: pull every backed-up PE from the person's cloud, verify each device chain,
     * rebuild the store, and put the full records back where the app's screens read them. Never
     * asks the relay for a PE.
     */
    async restoreAfterRecovery(biometricAction?: BiometricAction): Promise<RestoreReport & { readonly activityRestored: number }> {
        await this.start();
        const report = await this.backup.restore(biometricAction);
        const activityRestored = report.envelopes.length > 0 ? await this.deps.activity.restore(report.envelopes, biometricAction) : 0;
        if (this.deps.ensureMessageKeyPublished) await this.deps.ensureMessageKeyPublished({ allowPrompt: true, biometricAction }).catch(() => false);
        this.emit();
        return { ...report, activityRestored };
    }

    /**
     * "Export all my PEs" (Settings → Storage): every PE this person holds — every chain here, the
     * batch receipts and anchor proofs, the PEs sealed to them, every Archive day they can open
     * (pulled back now) and their legacy records — as one `provian.pe-export.v1` file. May ask for
     * Face ID / the passcode (the person's message key opens Archive days; the archive key opens the
     * month archives of the activity records); the person started it, in the app.
     */
    async exportAllPes(input: {
        readonly owner: { readonly walletId: string | null; readonly address: string | null };
        readonly appVersion: string;
        readonly onProgress?: (progress: PhonePeExportProgress) => void;
        readonly biometricAction?: BiometricAction;
    }): Promise<PhonePeExportResult> {
        await this.start();
        const action = input.biometricAction;
        const transport = action && this.deps.actionTransport ? this.deps.actionTransport(action) : this.deps.transport;
        // First the relay mailbox: PEs sealed to the person that this phone has not filed yet are
        // fetched, opened and filed now, so they are in the file. Whatever stays there is named.
        try { input.onProgress?.({ stage: 'received' }); } catch { /* progress never breaks the export */ }
        const batcher = action ? new PhoneBatcher({
            store: this.store, transport, log: this.log, now: this.now,
            messageSecretKey: () => this.deps.messageSecretKey({ allowPrompt: false, biometricAction: action }),
            openBox: this.deps.openBox,
        }) : this.batcher;
        const mailbox = batcher === null
            ? { waiting: null, truncated: false, reason: 'meter_not_started: the mailbox could not be drained' }
            : await drainMailboxForPhoneExport({
                drain: () => batcher.drainMailbox({ fileWithoutBackup: true }),
                getMailbox: (after, limit) => transport.getMailbox(after, limit),
                filedIds: async () => new Set((await this.store.listReceivedRows()).map((r) => r.mailbox_id)),
            });
        this.emit();
        return buildPhonePeExport({
            store: this.store,
            archive: action && this.archive && this.deps.actionArchiveTransport
                ? this.archive.forOperation(this.deps.actionArchiveTransport(action), () => this.deps.messageSecretKey({ allowPrompt: false, biometricAction: action }))
                : this.archive,
            batchProofs: transport.getBatchProofs?.bind(transport) ?? null,
            activity: { ...this.deps.activity, archived: options => this.deps.activity.archived({ ...options, biometricAction: action }) },
            cutoverMs: this.cutoverMs > 0 ? this.cutoverMs : null,
            owner: input.owner,
            appVersion: input.appVersion,
            mailbox,
            now: this.now,
            onProgress: input.onProgress,
        });
    }

    async status(): Promise<PhoneMeterStatus> {
        if (!this.store.isOpen()) {
            return {
                started: false, deviceId: null, ownPes: 0, unsentPes: 0, otherDevicePes: 0, receivedPes: 0, receivedArchivedPes: 0,
                legacyRecords: 0, batches: 0, proofs: 0, halt: null, backup: this.backup.status(),
            };
        }
        const own = this.store.own();
        const summary = await this.store.summary();
        const last = await own.lastBatch();
        const sent = last ? last.first_index + last.count : 0;
        return {
            started: true,
            deviceId: own.deviceId,
            ownPes: summary.own,
            unsentPes: Math.max(0, summary.own - sent),
            otherDevicePes: summary.otherDevices,
            receivedPes: summary.received,
            receivedArchivedPes: summary.receivedArchived,
            legacyRecords: summary.legacy,
            batches: summary.batches,
            proofs: summary.proofs,
            halt: await own.halt(),
            backup: this.backup.status(),
        };
    }
}

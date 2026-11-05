/**
 * PE METER (app) — the phone's batcher (: every act mints once, from one
 * signed batch per day since 2026-10-04 — was hourly). The reference client is the SDK's `provian-agent-sdk/src/meter/batcher.ts`;
 * this is the same protocol for the phone, under wallet auth.
 *
 * Once a day — and immediately before any presentation or on-demand payout, so those always reflect
 * the latest acts (`flushBeforeUse`) — the phone takes its unsent PEs in chain order, builds ONE batch of their act records
 * (identity + pricing inputs + pe_hash, never free text), and sends it. The relay prices the acts,
 * keeps running totals and answers with a receipt, which is filed beside the PEs (the app's PE list
 * reads each act's disposition and points from it).
 *
 * THE INVARIANTS (identical to the SDK batcher)
 * - PEs are immutable. A batch never changes a PE; the chain is never re-linked to suit the
 * relay. When the relay's chain cannot be continued from this store, batching STOPS for this
 * device (a persisted halt) until a person resolves it.
 * - The batch being sent is persisted BEFORE it is sent, and re-sent byte for byte until the
 * relay answers definitively. A crash after the relay accepted it re-sends the SAME bytes, which
 * the relay answers 200 with the stored receipt — never a second batch.
 * - A batch is rebuilt only after a DEFINITIVE refusal (a 4xx the relay sends before committing
 * anything), never after an unknown outcome (no answer, 5xx, 401).
 * - Offline → nothing is lost: PEs keep accumulating and go in the next batch.
 *
 * Also on schedule: the daily proofs (each accepted batch's path into that day's on-chain root,
 * kept with the batch) and the mailbox (PEs a linked agent, another device, or the relay sealed to
 * this person) — opened, verified, filed, backed up to the person's own cloud, and only THEN
 * acknowledged so the relay drops its ciphertext.
 */

import {
    batchHashOf,
    batchLeafOf,
    buildBatch,
    canonicalJson,
    MAX_ACTS_PER_BATCH,
    METER_GENESIS_PREV_HASH,
    peHashOf,
    PE_V2_SCHEMA,
    sha256HexOfText,
    validateBatchShape,
    type PeBatch,
    type PeV2,
} from './meter-wire';
import type {
    AcceptedBatch,
    DeviceChainStore,
    InFlightBatch,
    MeterAnchorProofWire,
    MeterBatchReceiptWire,
    MeterHalt,
    PhonePeStore,
    ReceivedPe,
    ReceivedV1Envelope,
    StoredBatchProof,
} from './phonePeStore';
import type { MeterAnswer, MeterTransport } from './meterTransport';
import { attachMissingReceivedProofs } from './receivedProofs';
import { cpuBudget, type CpuBudget } from './cpuBudget';

export type MeterLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type MeterLog = (level: MeterLogLevel, msg: string, extra?: Record<string, unknown>) => void;

/** One signed batch per day (: was hourly). */
export const METER_BATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const METER_PROOFS_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The mailbox is checked once a day too, on the batch's cadence (: was hourly). */
export const METER_MAILBOX_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * A drain that could not finish — no key (the wallet was still locked), the backup not caught up, or
 * the relay unreadable — tries again within the hour instead of waiting a day (:
 * a skipped drain never consumes the day; the 3-day lag of was each skip booking a full day).
 */
export const METER_MAILBOX_RETRY_MS = 60 * 60 * 1000;

/** When the mailbox is next due after a drain: a day after a complete one, within the hour otherwise. */
export function mailboxDelayAfter(report: MailboxReport): number {
    return report.ok && report.skipped === null ? METER_MAILBOX_INTERVAL_MS : METER_MAILBOX_RETRY_MS;
}
/** How soon to retry the daily proof read when the relay could not be read. */
export const METER_PROOFS_RETRY_MS = 60 * 60 * 1000;
/** The relay lands at most one batch per 5 minutes per device unless the previous one was full. */
export const METER_RELAY_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const METER_RETRY_BASE_MS = 5 * 60 * 1000;
export const METER_RETRY_MAX_MS = 60 * 60 * 1000;
/** The relay's batch route takes a 2 MB body; a batch is kept under this. */
export const METER_DEFAULT_MAX_BATCH_BYTES = 1_900_000;
const CONCURRENT_RESENDS = 3;

export interface PhoneBatcherOptions {
    readonly store: PhonePeStore;
    readonly transport: MeterTransport;
    readonly log?: MeterLog;
    readonly now?: () => number;
    readonly maxBatchBytes?: number;
    /** Pause between same-batch re-sends after `batch_concurrent` / `batch_retry` (tests: 0). */
    readonly resendDelayMs?: number;
    /**
     * This person's x25519 message secret (HKDF over the seed), for opening mailbox items. Asked for
     * only when the mailbox holds something. Null → the items stay on the relay (it drops them after
     * 30 days) and are tried again next time.
     */
    readonly messageSecretKey?: () => Promise<Uint8Array | null>;
    /** Open one sealed box (thread-crypto format). Returns null on a wrong key / tamper. */
    readonly openBox?: (secret: Uint8Array, boxB64u: string) => string | null;
    /**
     * Back the store up to the person's cloud now. True only when a backup run COMPLETED
     * ({@link backupCompleted}): a completed run uploads every record file whose contents no
     * committed snapshot holds, dirty-marked or not, and publishes the snapshot naming them. Mailbox
     * items are acknowledged only after such a run, and only those whose own file is not pending.
     */
    readonly backupNow?: () => Promise<boolean>;
    /**
     * Paces the meter's long walks (the mailbox drain, received proofs) by elapsed time so they never
     * hold the JS thread past one slice (default `cpuBudget()`, a fresh budget per walk). Tests may inject.
     */
    readonly budget?: () => CpuBudget;
    /** The mailbox drain's progress, for the home screen's "Filing N records" line. */
    readonly onMailboxProgress?: (progress: MailboxProgress | null) => void;
    /** Called after each accepted batch (the service schedules a backup and refreshes the UI). */
    readonly onAccepted?: (receipt: MeterBatchReceiptWire) => void;
}

export type SendOutcome = 'nothing_to_send' | 'sent' | 'deferred' | 'halted';

export interface SendReport {
    readonly outcome: SendOutcome;
    readonly batchesAccepted: number;
    readonly actsAccepted: number;
    readonly retryAtMs: number | null;
    readonly lastStatus: number | null;
    readonly halt: MeterHalt | null;
}

export interface ProofsReport {
    readonly ok: boolean;
    readonly fetched: number;
    readonly unverified: number;
}

export interface MailboxReport {
    readonly ok: boolean;
    readonly received: number;
    readonly acked: number;
    readonly skipped: 'no_key' | 'not_backed_up' | null;
    readonly refused: number;
}

/** A drain in progress: items still to file (null when the relay did not say how many wait). */
export interface MailboxProgress {
    readonly remaining: number | null;
}

export interface DrainMailboxOptions {
    /**
     * File every page even when the cloud backup has not caught up (the PE export: the person asked
     * for everything they hold, now). Items filed but not backed up are still NOT acknowledged, so
     * the relay keeps its copy until the backup holds them — nothing is lost either way.
     */
    readonly fileWithoutBackup?: boolean;
}

interface Position {
    readonly seq: number;
    readonly batch_hash: string;
    readonly last_pe_hash: string;
    readonly next_index: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorOf(answer: MeterAnswer): string | null {
    return isRecord(answer.body) && typeof answer.body.error === 'string' ? answer.body.error : null;
}

function hex64(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function utf8Length(text: string): number {
    return new TextEncoder().encode(text).length;
}

/** A receipt the relay sent, read defensively (only the fields this phone acts on are required). */
export function parseBatchReceipt(body: unknown): MeterBatchReceiptWire | null {
    if (!isRecord(body) || body.schema !== 'provian.pe-batch-receipt.v1') return null;
    if (typeof body.seq !== 'number' || typeof body.batch_hash !== 'string' || !Array.isArray(body.acts)) return null;
    if (!isRecord(body.totals)) return null;
    return body as unknown as MeterBatchReceiptWire;
}

export class PhoneBatcher {
    private readonly store: PhonePeStore;
    private readonly transport: MeterTransport;
    private readonly log: MeterLog;
    private readonly now: () => number;
    private maxBatchBytes: number;
    private sending: Promise<SendReport> | null = null;
    private draining: Promise<MailboxReport> | null = null;
    private ticking = false;
    private consecutiveFailures = 0;
    private nextSendAtMs = 0;
    private nextProofsAtMs = 0;
    private nextMailboxAtMs = 0;
    private scheduleLoaded = false;
    private lastSendAttemptMs = 0;

    constructor(private readonly options: PhoneBatcherOptions) {
        this.store = options.store;
        this.transport = options.transport;
        this.log = options.log ?? (() => undefined);
        this.now = options.now ?? Date.now;
        this.maxBatchBytes = options.maxBatchBytes ?? METER_DEFAULT_MAX_BATCH_BYTES;
    }

    private chain(): DeviceChainStore {
        return this.store.own();
    }

    // ─── schedule ─────────────────────────────────────────────────────────────────

    /**
     * Run whatever is due: the daily batch (sooner when a retry or a backlog is scheduled), the
     * daily mailbox check, the daily proofs. Coming to the foreground runs only what is due — it
     * neither sends nor checks the mailbox early (a batch goes once a day, or right before a
     * presentation or payout; the mailbox is checked once a day). Never overlaps itself; never
     * throws.
     */
    async tick(reason: 'timer' | 'foreground' = 'timer'): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            await this.loadSchedule();
            const now = this.now();
            const sendDue = now >= this.nextSendAtMs;
            if (sendDue) {
                const report = await this.sendPending();
                this.nextSendAtMs = report.retryAtMs ?? this.now() + METER_BATCH_INTERVAL_MS;
            }
            if (now >= this.nextMailboxAtMs) {
                const mailbox = await this.drainMailbox();
                this.nextMailboxAtMs = this.now() + mailboxDelayAfter(mailbox);
            }
            if (now >= this.nextProofsAtMs) {
                const proofs = await this.fetchProofs();
                // The same daily step keeps the proofs of PEs sealed TO this person: the relay drops a
                // batch record 30 days after its anchor, so a proof not fetched by then is gone.
                const received = await this.fetchReceivedProofs();
                this.nextProofsAtMs = this.now() + (proofs.ok && received.ok ? METER_PROOFS_INTERVAL_MS : METER_PROOFS_RETRY_MS);
            }
            await this.saveSchedule();
        } catch (err) {
            this.log('warn', 'pe meter tick failed', { error: (err as Error).message });
        } finally {
            this.ticking = false;
        }
    }

    /**
     * Right after the wallet unlocks, when the unlock's Face ID has just cached the message key:
     * drain the mailbox whatever the schedule says, so filing rides the unlock the person already
     * did — never a prompt of its own. The schedule then counts from here.
     */
    async drainAfterUnlock(): Promise<MailboxReport> {
        await this.loadSchedule();
        const report = await this.drainMailbox();
        this.nextMailboxAtMs = this.now() + mailboxDelayAfter(report);
        await this.saveSchedule();
        return report;
    }

    /** Send now regardless of the schedule (Settings "send now", tests). */
    async flush(): Promise<SendReport> {
        await this.loadSchedule();
        const report = await this.sendPending();
        this.nextSendAtMs = report.retryAtMs ?? this.now() + METER_BATCH_INTERVAL_MS;
        await this.saveSchedule();
        return report;
    }

    /**
     * Pick up the due times the app's previous run left, so a cold start neither sends, checks the
     * mailbox nor fetches proofs early: once a day means once a day across restarts, not once per
     * launch. A saved time more than one interval ahead (the clock moved back) is pulled in to one
     * interval from now. No saved schedule (first run, a recovered phone) = everything due now.
     */
    private async loadSchedule(): Promise<void> {
        if (this.scheduleLoaded) return;
        this.scheduleLoaded = true;
        const saved = await this.store.readSchedule().catch(() => null);
        if (saved === null) return;
        const now = this.now();
        this.nextSendAtMs = Math.max(this.nextSendAtMs, Math.min(saved.send_at_ms, now + METER_BATCH_INTERVAL_MS));
        this.nextMailboxAtMs = Math.max(this.nextMailboxAtMs, Math.min(saved.mailbox_at_ms, now + METER_MAILBOX_INTERVAL_MS));
        this.nextProofsAtMs = Math.max(this.nextProofsAtMs, Math.min(saved.proofs_at_ms, now + METER_PROOFS_INTERVAL_MS));
    }

    private async saveSchedule(): Promise<void> {
        await this.store
            .writeSchedule({ send_at_ms: this.nextSendAtMs, mailbox_at_ms: this.nextMailboxAtMs, proofs_at_ms: this.nextProofsAtMs })
            .catch((err: unknown) => this.log('warn', 'pe meter schedule not saved', { error: (err as Error).message }));
    }

    /**
     * Send everything recorded so far, right before a presentation or an on-demand payout (the operator,
     * 2026-10-04), so the relay's totals and pending claims include the latest acts. When the relay
     * holds this device to its 5-minute rule, wait that out once and send again.
     */
    async flushBeforeUse(options: { readonly sleep?: (ms: number) => Promise<void> } = {}): Promise<SendReport> {
        const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
        let report = await this.flush();
        if (report.outcome === 'deferred' && report.lastStatus === 429 && report.retryAtMs !== null) {
            const wait = report.retryAtMs - this.now();
            if (wait > 0 && wait <= METER_RELAY_MIN_INTERVAL_MS + 10_000) {
                await sleep(wait);
                report = await this.flush();
            }
        }
        return report;
    }

    // ─── position ─────────────────────────────────────────────────────────────────

    private async position(): Promise<Position> {
        const last = await this.chain().lastBatch();
        if (last === null) return { seq: 0, batch_hash: METER_GENESIS_PREV_HASH, last_pe_hash: METER_GENESIS_PREV_HASH, next_index: 0 };
        return { seq: last.seq, batch_hash: last.batch_hash, last_pe_hash: last.last_pe_hash, next_index: last.first_index + last.count };
    }

    private async haltWith(reason: string, detail: string, extra: Record<string, unknown> = {}): Promise<MeterHalt> {
        const halt: MeterHalt = { reason, detail, at_ms: this.now() };
        await this.chain().setHalt(halt);
        this.log('error', `PE METER HALTED for device ${this.chain().deviceId}: ${reason} — ${detail}. `
            + 'PEs keep being recorded on this phone, but no batch is sent until this is resolved. '
            + 'PEs are never rewritten to suit the relay.', extra);
        return halt;
    }

    private retryAfterFailure(): number {
        this.consecutiveFailures += 1;
        const exp = Math.min(this.consecutiveFailures - 1, 10);
        return this.now() + Math.min(METER_RETRY_BASE_MS * 2 ** exp, METER_RETRY_MAX_MS);
    }

    // ─── building ─────────────────────────────────────────────────────────────────

    private async buildNext(position: Position): Promise<InFlightBatch | MeterHalt | null> {
        const chain = this.chain();
        const pes = await chain.readPes(position.next_index, MAX_ACTS_PER_BATCH);
        if (pes.length === 0) return null;
        let prev = position.last_pe_hash;
        for (let i = 0; i < pes.length; i++) {
            if (pes[i].index !== position.next_index + i || pes[i].pe.prev_hash !== prev) {
                return this.haltWith('local_chain_gap', `PE ${position.next_index + i} does not continue the batched chain`);
            }
            prev = pes[i].pe.pe_hash;
        }
        let count = pes.length;
        for (;;) {
            const slice = pes.slice(0, count);
            const batch: PeBatch = buildBatch({
                device_id: chain.deviceId,
                seq: position.seq + 1,
                prev_batch_hash: position.batch_hash,
                created_at_ms: this.now(),
                pes: slice.map((p) => p.pe),
            });
            const body = JSON.stringify(batch);
            const bytes = utf8Length(body);
            if (bytes > this.maxBatchBytes && count > 1) {
                count = Math.max(1, Math.min(count - 1, Math.floor(count * (this.maxBatchBytes / bytes) * 0.95)));
                continue;
            }
            const shape = validateBatchShape(JSON.parse(body));
            if (!shape.ok) {
                return this.haltWith('local_batch_invalid', `the batch built from PEs ${position.next_index}..${position.next_index + count - 1} fails the wire check (${shape.error}${shape.index !== undefined ? ` at act ${shape.index}` : ''})`);
            }
            return {
                batch,
                body,
                batch_hash: batchHashOf(batch),
                first_index: position.next_index,
                count,
                last_pe_hash: slice[slice.length - 1].pe.pe_hash,
                persisted_at_ms: this.now(),
            };
        }
    }

    // ─── sending ──────────────────────────────────────────────────────────────────

    /** Send every unsent PE that can go now. Single-flight; never throws. */
    async sendPending(): Promise<SendReport> {
        if (this.sending) return this.sending;
        this.lastSendAttemptMs = this.now();
        this.sending = this.sendPendingOnce()
            .catch(async (err): Promise<SendReport> => {
                this.log('warn', 'pe meter send failed', { error: (err as Error).message });
                return { outcome: 'deferred', batchesAccepted: 0, actsAccepted: 0, retryAtMs: this.retryAfterFailure(), lastStatus: null, halt: null };
            })
            .finally(() => { this.sending = null; });
        return this.sending;
    }

    private async sendPendingOnce(): Promise<SendReport> {
        const chain = this.chain();
        let batchesAccepted = 0;
        let actsAccepted = 0;
        let lastStatus: number | null = null;
        let concurrentResends = 0;
        let rebuilds = 0;
        const report = (outcome: SendOutcome, retryAtMs: number | null, halt: MeterHalt | null = null): SendReport =>
            ({ outcome, batchesAccepted, actsAccepted, retryAtMs, lastStatus, halt });

        for (let guard = 0; guard < 1000; guard++) {
            const halted = await chain.halt();
            if (halted !== null) return report('halted', null, halted);
            const position = await this.position();

            let inflight = await chain.inFlight();
            if (inflight !== null && inflight.batch.seq <= position.seq) {
                // Its receipt was filed before a crash cleared it: already accepted.
                await chain.setInFlight(null);
                inflight = null;
            }
            if (inflight !== null && (inflight.batch.seq !== position.seq + 1 || inflight.batch.prev_batch_hash !== position.batch_hash
                || inflight.first_index !== position.next_index || typeof inflight.body !== 'string')) {
                const halt = await this.haltWith('inflight_inconsistent', `the persisted in-flight batch (seq ${inflight.batch.seq}) does not extend the last accepted batch (seq ${position.seq})`);
                return report('halted', null, halt);
            }
            if (inflight === null) {
                const built = await this.buildNext(position);
                if (built === null) {
                    this.consecutiveFailures = 0;
                    return report(batchesAccepted > 0 ? 'sent' : 'nothing_to_send', null);
                }
                if (!('batch' in built)) return report('halted', null, built);
                // Durable BEFORE it is sent: a crash from here on re-sends exactly these bytes.
                await chain.setInFlight(built);
                inflight = built;
            }

            const openings:Record<string,string>={};
            for(const stored of await chain.readPes(inflight.first_index,inflight.count)) {
                if(stored.pe.private_pricing!==undefined) {
                    if(typeof stored.pe.private_commitment!=='string')throw new Error('private pricing opening missing on owner device');
                    openings[stored.pe.pe_id]=stored.pe.private_commitment;
                }
            }
            const answer = await this.transport.postBatch(inflight.body,openings);
            lastStatus = answer.status;
            const error = errorOf(answer);

            if (answer.status === 201 || answer.status === 200) {
                const receipt = parseBatchReceipt(answer.body);
                if (receipt === null || receipt.batch_hash !== inflight.batch_hash || receipt.seq !== inflight.batch.seq) {
                    const halt = await this.haltWith('receipt_mismatch', `the relay answered ${answer.status} with a receipt for a different batch than seq ${inflight.batch.seq}`);
                    return report('halted', null, halt);
                }
                await this.accept(inflight, receipt);
                batchesAccepted += 1;
                actsAccepted += inflight.count;
                concurrentResends = 0;
                this.consecutiveFailures = 0;
                if (inflight.count >= MAX_ACTS_PER_BATCH) continue; // a full batch: the relay takes the next at once
                const head = await chain.head();
                const more = head.count > inflight.first_index + inflight.count;
                // A size-capped batch is not "full" to the relay, so the next one waits out its 5-minute rule.
                return report('sent', more ? this.now() + METER_RELAY_MIN_INTERVAL_MS + 5_000 : null);
            }

            if (answer.status === 409 && (error === 'batch_concurrent' || error === 'batch_retry')) {
                // The relay committed nothing for THIS attempt; the same batch is re-sent unchanged.
                if (concurrentResends < CONCURRENT_RESENDS) {
                    concurrentResends += 1;
                    const delay = this.options.resendDelayMs ?? 1_000;
                    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                return report(batchesAccepted > 0 ? 'sent' : 'deferred', this.retryAfterFailure());
            }

            if (answer.status === 409 && (error === 'batch_replay' || error === 'batch_chain_broken')) {
                const resync = await this.resync(answer, inflight);
                if (resync === 'adopted') continue;
                return report('halted', null, resync);
            }

            if (answer.status === 409 && error === 'act_chain_broken') {
                // Read the tip and apply the same catch-up rule; anything it cannot explain without
                // touching a PE stops batching (never re-chain).
                const resync = await this.resync(answer, inflight, 'act_chain_broken');
                if (resync === 'adopted') continue;
                return report('halted', null, resync);
            }

            if (answer.status === 429) {
                const body = isRecord(answer.body) ? answer.body : {};
                const afterMs = typeof body.retry_after_ms === 'number' ? body.retry_after_ms
                    : typeof body.retry_after === 'number' ? body.retry_after * 1000 : METER_RELAY_MIN_INTERVAL_MS;
                this.consecutiveFailures = Math.max(1, this.consecutiveFailures);
                return report(batchesAccepted > 0 ? 'sent' : 'deferred', this.now() + Math.max(1_000, afterMs));
            }

            if (answer.status === 413) {
                // Definitive: nothing was committed. Rebuild smaller (a PE is never changed).
                await chain.setInFlight(null);
                if (inflight.count <= 1 || rebuilds >= 8) {
                    const halt = await this.haltWith('pe_too_large', `PE ${inflight.first_index} alone exceeds the relay's request-size limit`);
                    return report('halted', null, halt);
                }
                rebuilds += 1;
                this.maxBatchBytes = Math.max(1_000, Math.min(this.maxBatchBytes, Math.floor(utf8Length(inflight.body) / 2)));
                continue;
            }

            if (answer.status === 400 && error === 'batch_invalid') {
                const body = isRecord(answer.body) ? answer.body : {};
                const halt = await this.haltWith('batch_invalid', `the relay refused the batch's shape (${String(body.code)}${body.act_index !== undefined ? ` at act ${String(body.act_index)}` : ''})`);
                return report('halted', null, halt);
            }

            if (answer.status === 403 && (error === 'batch_device_mismatch')) {
                const halt = await this.haltWith('batch_device_mismatch', `the relay authenticated a different device than ${chain.deviceId}`);
                return report('halted', null, halt);
            }

            // No answer, 5xx, 401 (a credential mid-recovery), anything unrecognised: the outcome may
            // be unknown, so the SAME batch stays in flight and is re-sent later.
            this.log('warn', 'pe meter: batch not accepted yet; it stays queued and is re-sent', {
                status: answer.status, error: error ?? answer.error, seq: inflight.batch.seq,
            });
            return report(batchesAccepted > 0 ? 'sent' : 'deferred', this.retryAfterFailure());
        }
        return report('deferred', this.retryAfterFailure());
    }

    /** File an accepted batch and its receipt, then clear the in-flight copy. */
    private async accept(inflight: InFlightBatch, receipt: MeterBatchReceiptWire): Promise<void> {
        const chain = this.chain();
        const record: AcceptedBatch = {
            seq: inflight.batch.seq,
            batch_hash: inflight.batch_hash,
            prev_batch_hash: inflight.batch.prev_batch_hash,
            acts_root: inflight.batch.acts_root,
            first_index: inflight.first_index,
            count: inflight.count,
            last_pe_hash: inflight.last_pe_hash,
            created_at_ms: inflight.batch.created_at_ms,
            accepted_at_ms: typeof receipt.accepted_at_ms === 'number' ? receipt.accepted_at_ms : null,
            actor_id: typeof receipt.actor_id === 'string' ? receipt.actor_id : null,
            totals: receipt.totals,
        };
        // ORDER: receipt + cursor first, then the in-flight copy goes. A crash between the two leaves
        // an in-flight batch at or below the cursor, which the next cycle recognises and clears.
        await chain.recordBatch(record, receipt);
        await chain.setInFlight(null);
        this.log('info', 'pe batch accepted', { seq: record.seq, acts: record.count, eligible: receipt.totals.eligible });
        try {
            this.options.onAccepted?.(receipt);
        } catch {
            // a listener never breaks batching
        }
    }

    /**
     * The relay refused the batch's position (`batch_replay` / `batch_chain_broken`) or its first act's
     * link (`act_chain_broken`). Read the tip
     * and decide WITHOUT touching a PE (the SDK's catch-up rule):
     *   - the relay's last accepted PE is one of THIS device's own PEs past the local cursor (the
     *     local record of some accepted batches was lost): adopt the relay's tip as the cursor — the
     *     PEs are unchanged, only the bookkeeping catches up — and continue from there;
     *   - anything else (the relay is behind this store, or holds a PE this store never made):
     *     halt. Re-chaining would mean rewriting PEs, which is never allowed.
     */
    private async resync(answer: MeterAnswer, inflight: InFlightBatch, refusal?: 'act_chain_broken'): Promise<'adopted' | MeterHalt> {
        const chain = this.chain();
        const tipAnswer = await this.transport.getTip();
        let relay: { seq: number; batch_hash: string; last_pe_hash: string } | null = null;
        if (tipAnswer.status === 200 && isRecord(tipAnswer.body) && typeof tipAnswer.body.seq === 'number'
            && typeof tipAnswer.body.batch_hash === 'string' && typeof tipAnswer.body.last_pe_hash === 'string') {
            relay = { seq: tipAnswer.body.seq, batch_hash: tipAnswer.body.batch_hash, last_pe_hash: tipAnswer.body.last_pe_hash };
        } else if (isRecord(answer.body) && typeof answer.body.expected_seq === 'number'
            && typeof answer.body.expected_prev_batch_hash === 'string' && typeof answer.body.last_pe_hash === 'string') {
            relay = { seq: answer.body.expected_seq - 1, batch_hash: answer.body.expected_prev_batch_hash, last_pe_hash: answer.body.last_pe_hash };
        }
        if (relay === null) {
            return this.haltWith('relay_tip_unreadable', `the relay refused batch seq ${inflight.batch.seq} (${String(errorOf(answer))}) and its tip could not be read`);
        }
        const local = await this.position();
        if (relay.seq > local.seq && hex64(relay.last_pe_hash)) {
            const head = await chain.head();
            for (let i = local.next_index; i < head.count; i += MAX_ACTS_PER_BATCH) {
                const pes = await chain.readPes(i, MAX_ACTS_PER_BATCH);
                const target = relay.last_pe_hash;
                const hit = pes.find((p) => p.pe.pe_hash === target);
                if (hit) {
                    const adopted: AcceptedBatch = {
                        seq: relay.seq,
                        batch_hash: relay.batch_hash,
                        prev_batch_hash: local.batch_hash,
                        acts_root: null,
                        first_index: local.next_index,
                        count: hit.index - local.next_index + 1,
                        last_pe_hash: relay.last_pe_hash,
                        created_at_ms: null,
                        accepted_at_ms: null,
                        actor_id: null,
                        totals: null,
                        adopted: true,
                    };
                    await chain.recordBatch(adopted, null);
                    await chain.setInFlight(null);
                    this.log('warn', 'pe meter: the relay already held batches this phone had no record of; resynced to its tip (no PE changed)', {
                        relay_seq: relay.seq, local_seq: local.seq, pes_covered: adopted.count,
                    });
                    return 'adopted';
                }
            }
        }
        return this.haltWith(
            refusal ?? (relay.seq < local.seq ? 'relay_behind_local' : 'relay_chain_diverged'),
            `relay tip seq ${relay.seq} / last PE ${relay.last_pe_hash}; this phone's last accepted seq ${local.seq} / last PE ${local.last_pe_hash}, and the relay's last PE is not one of this device's unbatched PEs`,
        );
    }

    // ─── proofs ───────────────────────────────────────────────────────────────────

    /**
     * Fetch every anchored batch's proof after the last one held, and file it with the batch. A proof
     * whose batch leaf does not recompute from this phone's own batch record is kept as
     * `verified: false` — kept, never trusted.
     */
    async fetchProofs(): Promise<ProofsReport> {
        const chain = this.chain();
        const held = await chain.listProofs();
        const heldSeqs = new Set(held.map((p) => p.seq));
        let after = held.reduce((m, p) => Math.max(m, p.seq), 0);
        const batches = new Map((await chain.listBatches()).map((b) => [b.seq, b]));
        let fetched = 0;
        let unverified = 0;
        for (let page = 0; page < 100; page++) {
            const selected = [...batches.values()].filter(b => b.seq > after).sort((a, b) => a.seq - b.seq).slice(0, 32).map(b => b.batch_hash);
            if (selected.length === 0) break;
            const answer = await this.transport.getProofs(after, selected);
            if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.proofs)) {
                return { ok: false, fetched, unverified };
            }
            const proofs = answer.body.proofs;
            for (const raw of proofs) {
                if (!isRecord(raw) || typeof raw.seq !== 'number' || !hex64(raw.batch_hash) || !hex64(raw.batch_leaf)
                    || !hex64(raw.acts_root) || typeof raw.actor_id !== 'string' || !isRecord(raw.anchor)) continue;
                if (heldSeqs.has(raw.seq)) continue;
                const own = batches.get(raw.seq);
                const leaf = batchLeafOf({
                    device_id: chain.deviceId, actor_id: raw.actor_id, seq: raw.seq, batch_hash: raw.batch_hash, acts_root: raw.acts_root,
                });
                const verified = own !== undefined && own.adopted !== true && own.batch_hash === raw.batch_hash
                    && own.acts_root === raw.acts_root && leaf === raw.batch_leaf;
                if (!verified) unverified += 1;
                const proof: StoredBatchProof = {
                    seq: raw.seq,
                    batch_hash: raw.batch_hash,
                    batch_leaf: raw.batch_leaf,
                    acts_root: raw.acts_root,
                    actor_id: raw.actor_id,
                    chain_id: typeof raw.chain_id === 'number' ? raw.chain_id : null,
                    anchor_contract: typeof raw.anchor_contract === 'string' ? raw.anchor_contract : null,
                    anchor: raw.anchor as unknown as MeterAnchorProofWire,
                    fetched_at_ms: this.now(),
                    verified,
                };
                await chain.recordProof(proof);
                heldSeqs.add(raw.seq);
                fetched += 1;
                after = Math.max(after, raw.seq);
            }
            const next = answer.body.next_after_seq;
            if (proofs.length === 0 || typeof next !== 'number') break;
            after = Math.max(after, next);
        }
        if (unverified > 0) this.log('warn', 'pe meter: relay proofs that do not match this phone\'s batch records were kept as unverified', { unverified });
        return { ok: true, fetched, unverified };
    }

    /**
     * Fetch, check and keep the inclusion proof of every received PE this phone holds without one
     * (`receivedProofs.ts`). Only anchored, fully checked proofs are kept. Never throws.
     */
    async fetchReceivedProofs(): Promise<{ ok: boolean; attached: number }> {
        const call = this.transport.getBatchProofs?.bind(this.transport);
        if (!call) return { ok: true, attached: 0 };
        try {
            const report = await attachMissingReceivedProofs(this.store, call, { budget: this.newBudget() });
            if (report.attached > 0) this.log('info', 'pe meter: proofs of received PEs kept', { attached: report.attached });
            return { ok: report.ok, attached: report.attached };
        } catch (err) {
            this.log('warn', 'pe meter: proofs of received PEs not kept yet', { error: (err as Error).message });
            return { ok: false, attached: 0 };
        }
    }

    // ─── mailbox ──────────────────────────────────────────────────────────────────

    /**
     * File PEs sealed to this person (by a linked agent, another device, or the relay), back them up
     * to the person's own cloud, THEN acknowledge them so the relay drops its ciphertext. An item this
     * key cannot open, or whose opened PE is not the PE it names, is neither filed nor acknowledged.
     * Single-flight; never throws.
     */
    async drainMailbox(options: DrainMailboxOptions = {}): Promise<MailboxReport> {
        if (this.draining) {
            if (options.fileWithoutBackup !== true) return this.draining;
            // A scheduled drain may stop at the first page the backup has not caught up with: let it
            // finish, then run the export's own drain.
            await this.draining.catch(() => undefined);
            if (this.draining) return this.draining;
        }
        this.draining = this.drainOnce(options)
            .catch((err): MailboxReport => {
                this.log('warn', 'pe meter mailbox drain failed', { error: (err as Error).message });
                return { ok: false, received: 0, acked: 0, skipped: null, refused: 0 };
            })
            .finally(() => {
                this.draining = null;
                this.progress(null);
            });
        return this.draining;
    }

    private newBudget(): CpuBudget {
        return this.options.budget?.() ?? cpuBudget();
    }

    private progress(p: MailboxProgress | null): void {
        try { this.options.onMailboxProgress?.(p); } catch { /* the line never breaks the drain */ }
    }

    private async drainOnce(options: DrainMailboxOptions = {}): Promise<MailboxReport> {
        let received = 0;
        let acked = 0;
        let refused = 0;
        let skipped: MailboxReport['skipped'] = null;
        let secret: Uint8Array | null = null;
        let after: string | null = null;
        const open = this.options.openBox;
        // Every item is opened, checked and filed under one time budget: the screens get the thread
        // back whenever a slice has run its course, however large the backlog (findings).
        const budget = this.newBudget();
        // Items still to file, from the relay's count on the first page; null when it gave none.
        let remaining: number | null = null;
        // Filed but not yet acknowledged: backed up and acknowledged together, once per
        // MAILBOX_BACKUP_EVERY_ITEMS and at the end — a backup re-reads every record file, so one per
        // page made a large backlog crawl and starved the screens (live, 2026-10-23).
        let unacked: { mailbox_id: string; path: string }[] = [];
        const settle = async (): Promise<boolean> => {
            if (unacked.length === 0) return true;
            const batch = unacked;
            unacked = [];
            // Back up FIRST: the relay's copy is dropped only once the person's cloud holds it. Only a
            // completed run proves that (a clean mark alone does not: a mark lost to a crash reads
            // clean); within it each filed item is judged by its own file, so another record still
            // pending elsewhere in the store (one written during this backup) does not hold the batch back.
            const completed = this.options.backupNow ? await this.options.backupNow().catch(() => false) : false;
            const ackIds = completed ? batch.filter((f) => f.path !== '' && !this.store.isDirty(f.path)).map((f) => f.mailbox_id) : [];
            if (ackIds.length < batch.length) skipped = 'not_backed_up';
            for (let i = 0; i < ackIds.length; i += MAILBOX_ACK_PAGE_SIZE) {
                const slice = ackIds.slice(i, i + MAILBOX_ACK_PAGE_SIZE);
                const ack = await this.transport.ackMailbox(slice);
                if (ack.status === 200) acked += slice.length;
            }
            return ackIds.length === batch.length;
        };
        // The mailbox may hold thousands of items (a migrated history): page through ALL of it.
        // Bounded per drain; the next drain continues.
        for (let page = 0; page < MAILBOX_MAX_PAGES_PER_DRAIN; page++) {
            const answer = await this.transport.getMailbox(after, MAILBOX_PAGE_SIZE);
            if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.items)) {
                await settle();
                return { ok: false, received, acked, skipped, refused };
            }
            const items = answer.body.items.filter(isRecord);
            if (items.length > 0 && secret === null) {
                // The key is asked for only when there is something to open.
                secret = this.options.messageSecretKey ? await this.options.messageSecretKey().catch(() => null) : null;
                if (secret === null || !open) {
                    await settle();
                    return { ok: true, received, acked, skipped: 'no_key', refused };
                }
            }
            if (page === 0) {
                const waiting = answer.body.waiting;
                remaining = typeof waiting === 'number' && Number.isSafeInteger(waiting) && waiting >= 0 ? Math.max(waiting, items.length) : null;
            }
            if (items.length > 0) this.progress({ remaining });
            const toFile: ReceivedPe[] = [];
            for (const raw of items) {
                await budget.pace();
                if (typeof raw.id !== 'string' || typeof raw.box !== 'string' || typeof raw.pe_id !== 'string') continue;
                const opened = openMailboxItem(secret as Uint8Array, open as NonNullable<typeof open>, raw);
                if (opened === null) {
                    refused += 1;
                    continue;
                }
                toFile.push({
                    mailbox_id: raw.id,
                    pe_id: opened.id,
                    format: opened.format,
                    pe: opened.record,
                    pe_hash: opened.hash,
                    from_device: typeof raw.from_device === 'string' ? raw.from_device : '',
                    from_actor: typeof raw.from_actor === 'string' ? raw.from_actor : '',
                    batch_hash: typeof raw.batch_hash === 'string' ? raw.batch_hash : '',
                    created_at_ms: typeof raw.created_at_ms === 'number' ? raw.created_at_ms : 0,
                    received_at_ms: this.now(),
                });
            }
            if (toFile.length > 0) {
                await budget.pace();
                const filed = await this.store.recordReceivedMany(toFile);
                received += filed.filter((f) => f.filed).length;
                unacked.push(...filed.map((f) => ({ mailbox_id: f.mailbox_id, path: f.path })));
            }
            if (remaining !== null) remaining = Math.max(0, remaining - items.length);
            this.progress(remaining === 0 ? null : { remaining });
            await budget.pace();
            const next = answer.body.next;
            const last = typeof next !== 'string' || next.length === 0;
            if (unacked.length >= MAILBOX_BACKUP_EVERY_ITEMS || last) {
                if (!(await settle()) && options.fileWithoutBackup !== true) {
                    // Not in the cloud yet: stop here, the rest waits for the next drain (nothing is lost —
                    // every item is filed on this phone and still held by the relay).
                    break;
                }
            }
            if (last) break;
            after = next as string;
        }
        await settle();
        if (refused > 0) this.log('warn', 'pe meter: mailbox items that could not be opened, were not JSON, or did not match the PE they name were left on the relay', { refused });
        return { ok: true, received, acked, skipped, refused };
    }
}

/** A backup run finished: every record file is in the cloud under a published snapshot. */
export function backupCompleted(report: { readonly state: string }): boolean {
    return report.state === 'ok';
}

export const MAILBOX_PAGE_SIZE = 100;
/** Items filed between backups (and acknowledgements) within one drain. */
export const MAILBOX_BACKUP_EVERY_ITEMS = 1000;
export const MAILBOX_ACK_PAGE_SIZE = 200;
export const MAILBOX_MAX_PAGES_PER_DRAIN = 500;

export interface OpenedMailboxItem {
    readonly format: 'pe_v2' | 'v1_envelope';
    readonly id: string;
    readonly record: PeV2 | ReceivedV1Envelope;
    readonly hash: string;
}

/**
 * Open one mailbox item. Null = refuse (never filed, never acknowledged): the box does not open
 * with this key, its contents are not a JSON object, or it claims to be a PE v2 and is not exactly
 * the PE it names (hash, id, device). Anything else that opens to a JSON object is kept:
 *   - a PE v2 (`schema: 'provian.pe.v2'`) — verified, keyed by `pe_id`;
 *   - anything without the v2 schema — a pre-meter v1 envelope handed back by the history
 *     migration — kept VERBATIM, keyed by its `id` (falling back to the item's `pe_id`).
 */
export function openMailboxItem(
    secret: Uint8Array,
    open: (secret: Uint8Array, boxB64u: string) => string | null,
    raw: Record<string, unknown>,
): OpenedMailboxItem | null {
    const text = open(secret, raw.box as string);
    if (text === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) return null;
    if (parsed.schema === PE_V2_SCHEMA) {
        if (parsed.pe_id !== raw.pe_id) return null;
        const pe = parsed as unknown as PeV2;
        let hash: string;
        try {
            hash = peHashOf(pe);
        } catch {
            return null;
        }
        // The hash the item names (or, for a PE that carries its own, that one) must be this PE's.
        const named = typeof raw.pe_hash === 'string' ? raw.pe_hash : null;
        if (named !== null && named !== hash) return null;
        if (typeof pe.pe_hash === 'string' && pe.pe_hash !== hash) return null;
        // A PE is filed under the device that sealed it.
        if (typeof raw.from_device === 'string' && raw.from_device.length > 0 && pe.device_id !== raw.from_device) return null;
        return { format: 'pe_v2', id: pe.pe_id, record: pe, hash };
    }
    const id = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : (raw.pe_id as string);
    let hash: string;
    if (typeof parsed.hash === 'string' && parsed.hash.length > 0) {
        hash = parsed.hash;
    } else {
        try {
            hash = sha256HexOfText(canonicalJson(parsed));
        } catch {
            hash = sha256HexOfText(text);
        }
    }
    return { format: 'v1_envelope', id, record: parsed as ReceivedV1Envelope, hash };
}

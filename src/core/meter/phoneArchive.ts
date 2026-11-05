/**
 * PE METER (app) — the phone side of the paid PE Archive .
 *
 * "Your PEs stay yours: the Archive keeps encrypted days you choose to pay for." $5 USDC per GB,
 * paid from this wallet at turn-on and each time another GB is reached, kept permanently. With the
 * person's Archive ON, once a day (the meter's tick):
 *
 * 1. UPLOAD every closed day of this phone's own chain since turn-on whose batches are all
 * anchored (this phone holds each batch's anchor proof): its PEs with their inclusion proofs,
 * sealed ON THIS PHONE to the person's own message key (`pe-archive-wire.ts`). The relay stores
 * ciphertext. A 402 `archive_space_exhausted` stops uploading and raises the "Archive full —
 * add 1 GB for $5" prompt: every day not stored stays on this phone and in its cloud backup;
 * nothing is deleted.
 * 2. DROP every one of its days the relay reports CONFIRMED (object matches the index, every
 * batch anchored) that is 30+ days old — only after pulling the day back, finding this phone's
 * parts byte-identical to what the relay confirmed, opening them with the person's key here,
 * and matching every PE it drops, field for field. The chunk is rewritten with pointers and
 * marked dirty, so the cloud backup's copy is rewritten the same way on its next run.
 *
 * And whatever the person's own Archive state, the COPIES this person holds of a linked agent's PEs
 * (sealed to them through the mailbox) drop once that agent's Archive confirmed the day and it is
 * 30+ days old — after the same pull, open (the agent's days are sealed to its linked human too)
 * and match. When the agent's Archive is off or full, nothing of its days drops here either.
 *
 * A PE dropped here is pulled back when it is needed (`findArchivedPe`, used by presentations).
 *
 * ONE PULL SERVES REPEATED USE. Every read of an Archive-class object pays a retrieval
 * fee and egress, so a pulled day's object (ciphertext, exactly as the relay served it — opening it
 * still takes the person's key) is kept in an optional `objectCache` (the app's purgeable cache
 * directory) and used again for later presentations and for the Archive screen's "Pull back". The
 * drop checks use a cached copy only when its parts match the relay's confirmed index, and never put
 * a dropped day's ciphertext back on the phone.
 */

import { x25519 } from '@noble/curves/ed25519';
import {
    ARCHIVE_LOCAL_KEEP_DAYS,
    archiveDayAgeDays,
    archiveDayOf,
    buildArchiveEntries,
    bytesToB64u,
    findArchivedEntry,
    openArchivePart,
    parseArchivePart,
    planArchiveParts,
    sealArchivePart,
    splitArchiveObject,
    type ArchiveBatchInput,
    type ArchiveEntry,
    type ArchivePartHeader,
    type ArchivePayload,
    type ArchiveRecipient,
} from './pe-archive-wire';
import { canonicalJson, utf8Bytes } from './meter-wire';
import { anchoredLeafOf, foldAnchorProof, verifyAnchorsOnChain, archivePayloadNeedsSegmentRepair, repairArchivePayloadSegments, type EthCall, type ExportAnchorClaim } from './pe-export-wire';
import type { ArchiveBatchRef } from './pe-archive-wire';
import type { ArchiveObjectCache } from './archiveObjectCache';
import type { ArchiveRandomBytes } from './pe-archive-crypto';
import type { MeterAnswer } from './meterTransport';
import { isArchivedReceived, type DeviceChainStore, type PhonePeStore, type ReceivedPe, type StoredPe } from './phonePeStore';
import type { ArchivedPeSource } from './phoneProve';

export const PHONE_ARCHIVE_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The local window: the ruled 30 days unless an integer 0..30 shortens it (never lengthens). */
export function keepDaysOf(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= ARCHIVE_LOCAL_KEEP_DAYS
        ? value
        : ARCHIVE_LOCAL_KEEP_DAYS;
}
export const PHONE_ARCHIVE_RETRY_MS = 60 * 60 * 1000;

/** The wallet-auth `/v1/archive/mobile/*` surface. */
export interface PhoneArchiveTransport {
    getDayProofs?(wallet: string, day: string): Promise<MeterAnswer>;
    getStatus(): Promise<MeterAnswer>;
    uploadPart(line: string): Promise<MeterAnswer>;
    /** `wallet` null = this person's own days. */
    listDays(wallet: string | null, after: string | null): Promise<MeterAnswer>;
    listLinkedDays(after: string | null): Promise<MeterAnswer>;
    /** The day object's text (NDJSON of sealed parts), or null with the HTTP status. */
    getDayObject(wallet: string, day: string): Promise<{ status: number | null; text: string | null }>;
}

/** The relay calls the transport needs (RelayAPIService). */
export interface PhoneArchiveRelayClient {
    meterRequest(method: 'GET' | 'POST', path: string, body?: string): Promise<MeterAnswer>;
    archiveObjectText(path: string): Promise<{ status: number | null; text: string | null }>;
}

export function createRelayArchiveTransport(relay: PhoneArchiveRelayClient): PhoneArchiveTransport {
    const q = (after: string | null): string => (after ? `&after=${encodeURIComponent(after)}` : '');
    return {
        getDayProofs: (wallet, day) => relay.meterRequest('GET', `/v1/archive/mobile/days?wallet=${encodeURIComponent(wallet)}&day=${encodeURIComponent(day)}`),
        getStatus: () => relay.meterRequest('GET', '/v1/archive/mobile'),
        uploadPart: (line) => relay.meterRequest('POST', '/v1/archive/mobile/parts', JSON.stringify({ part: line })),
        listDays: (wallet, after) => relay.meterRequest('GET', `/v1/archive/mobile/days?limit=200${wallet ? `&wallet=${encodeURIComponent(wallet)}` : ''}${q(after)}`),
        listLinkedDays: (after) => relay.meterRequest('GET', `/v1/archive/mobile/linked?limit=200${q(after)}`),
        getDayObject: (wallet, day) => relay.archiveObjectText(`/v1/archive/mobile/days/${encodeURIComponent(wallet)}/${encodeURIComponent(day)}/object`),
    };
}

// ─── relay answers ──────────────────────────────────────────────────────────────

export interface PhoneArchiveStatus {
    readonly wallet: string;
    readonly on: boolean;
    readonly paid_bytes: number;
    readonly used_bytes: number;
    readonly space_exhausted: boolean;
    readonly next_gb_purchasable: boolean;
    readonly turned_on_at_ms: number | null;
    readonly recipients: readonly { party_id: string; role: string; pubkey_b64u: string }[];
}

interface RelayDayPart {
    readonly device_id: string;
    readonly part: number;
    readonly sha256: string;
    readonly confirmed: boolean;
    readonly state: string;
    readonly batches: readonly { seq: number; batch_hash: string; first_index: number; count: number }[];
}

interface RelayDay {
    readonly wallet: string;
    readonly day: string;
    readonly confirmed: boolean;
    readonly parts: readonly RelayDayPart[];
    readonly bytes: number;
    readonly pe_count: number;
    readonly rejected_reason: string | null;
}

/** An archived day as the Archive screen lists it. */
export interface ArchivedDayView {
    readonly wallet: string;
    readonly day: string;
    readonly confirmed: boolean;
    readonly bytes: number;
    readonly peCount: number;
    readonly rejectedReason: string | null;
    /** The stored parts' sha256s the relay checked (what a pulled copy must match). */
    readonly partShas: readonly string[];
}

/**
 * What "Pull back" found: the relay had checked the day, every PE opened with the reader's key and
 * hash-checked, every batch folded to its day root, and every day root read back from PEAnchor on
 * Base — never the copy checked only against roots it carries itself.
 */
export type DayIntegrity =
    | { readonly ok: true; readonly peCount: number; readonly parts: number; readonly anchors: number; readonly fromCache: boolean }
    | { readonly ok: false; readonly reason: string };

function isRecord(x: unknown): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** The same PE, field for field (its carried `pe_hash`, if any, aside — it is checked separately). */
function samePe(a: unknown, b: unknown): boolean {
    if (!isRecord(a) || !isRecord(b)) return false;
    const { pe_hash: _ah, ...ra } = a;
    const { pe_hash: _bh, ...rb } = b;
    void _ah; void _bh;
    return canonicalJson(ra) === canonicalJson(rb);
}

export function parseArchiveStatus(body: unknown): PhoneArchiveStatus | null {
    if (!isRecord(body) || typeof body.wallet !== 'string' || !isRecord(body.archive)) return null;
    const a = body.archive;
    const recipients = Array.isArray(body.recipients)
        ? body.recipients.filter((r): r is { party_id: string; role: string; pubkey_b64u: string } => isRecord(r)
            && typeof r.party_id === 'string' && typeof r.role === 'string' && typeof r.pubkey_b64u === 'string')
        : [];
    return {
        wallet: body.wallet,
        on: a.on === true,
        paid_bytes: typeof a.paid_bytes === 'number' ? a.paid_bytes : 0,
        used_bytes: typeof a.used_bytes === 'number' ? a.used_bytes : 0,
        space_exhausted: a.space_exhausted === true,
        next_gb_purchasable: a.next_gb_purchasable === true,
        turned_on_at_ms: typeof a.turned_on_at_ms === 'number' ? a.turned_on_at_ms : null,
        recipients,
    };
}

function parseDays(body: unknown, fallbackWallet: string): RelayDay[] | null {
    if (!isRecord(body) || !Array.isArray(body.days)) return null;
    const out: RelayDay[] = [];
    for (const d of body.days) {
        if (!isRecord(d) || typeof d.day !== 'string' || !Array.isArray(d.parts)) continue;
        out.push({
            wallet: typeof d.wallet === 'string' ? d.wallet : fallbackWallet,
            day: d.day,
            confirmed: d.confirmed === true,
            parts: d.parts as RelayDayPart[],
            bytes: typeof d.bytes === 'number' ? d.bytes : 0,
            pe_count: typeof d.pe_count === 'number' ? d.pe_count : 0,
            rejected_reason: typeof d.rejected_reason === 'string' ? d.rejected_reason : null,
        });
    }
    return out;
}

// ─── the keeper ─────────────────────────────────────────────────────────────────

export interface PhoneArchiveLocalState {
    readonly on: boolean;
    readonly wallet: string | null;
    readonly paid_bytes: number;
    readonly used_bytes: number;
    /** The paid space is used up and the next GB is not paid: new days stay on this phone. */
    readonly space_exhausted: boolean;
    readonly next_gb_purchasable: boolean;
    readonly days_dropped: number;
    readonly linked_copies_dropped: number;
    readonly last_run_at_ms: number;
    readonly last_error: string | null;
}

export interface PhoneArchiveRunReport {
    readonly state: 'off' | 'ran' | 'error';
    readonly uploaded_days: number;
    readonly dropped_days: number;
    readonly dropped_pes: number;
    readonly dropped_linked_copies: number;
    readonly space_exhausted: boolean;
    readonly detail: string | null;
}

export interface PhoneArchiveKeeperOptions {
    readonly store: PhonePeStore;
    readonly transport: PhoneArchiveTransport;
    /** The person's x25519 message secret (HKDF over the seed). Null = not obtainable silently now. */
    readonly messageSecretKey: () => Promise<Uint8Array | null>;
    readonly now?: () => number;
    /**
     * How many recent days stay on this phone. Defaults to the ruled 30; may only SHORTEN it
     * (an integer 0..30), so a proof build can drop a confirmed day now instead of in 30 days. Any
     * other value is ignored. Dropping still requires the day CONFIRMED in the Archive and pulled
     * back and matched PE by PE first.
     */
    readonly localKeepDays?: number;
    readonly randomBytes?: ArchiveRandomBytes;
    /** Where a pulled day's ciphertext is kept so a later use does not pull it again (optional). */
    readonly objectCache?: ArchiveObjectCache;
    /**
     * A read-only `eth_call` on Base (production: the public Base RPC). "Check it's intact" reads
     * each day root from PEAnchor through it; without it a day is never reported intact.
     */
    readonly ethCall?: EthCall;
    readonly log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
    /** Persist the status line (AsyncStorage in production; never a PE). */
    readonly stateStore?: { read(): Promise<PhoneArchiveLocalState | null>; write(state: PhoneArchiveLocalState): Promise<void> };
}

export interface OpenedDay {
    readonly payloads: ArchivePayload[];
    readonly parts: { sha256: string; device_id: string; part: number }[];
}

export class PhoneArchiveKeeper implements ArchivedPeSource {
    private readonly now: () => number;
    private readonly keepDays: number;
    private nextRunAtMs = 0;
    private keyBlocked = false;
    private running: Promise<PhoneArchiveRunReport> | null = null;
    private readonly outbox = new Map<string, string>();
    private readonly pulled = new Map<string, ArchivePayload[]>();
    private stateValue: PhoneArchiveLocalState | null = null;

    constructor(private readonly options: PhoneArchiveKeeperOptions) {
        this.now = options.now ?? Date.now;
        this.keepDays = keepDaysOf(options.localKeepDays);
    }

    /** A temporary export view shares storage/cache but holds no ambient authorization. */
    forOperation(transport: PhoneArchiveTransport, messageSecretKey: () => Promise<Uint8Array | null>): PhoneArchiveKeeper {
        return new PhoneArchiveKeeper({ ...this.options, transport, messageSecretKey });
    }

    /** A confirmed day leaves this phone once it is older than the local window. */
    private droppable(day: string): boolean {
        return archiveDayAgeDays(day, this.now()) >= this.keepDays;
    }

    private log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
        this.options.log?.(level, msg, extra);
    }

    async state(): Promise<PhoneArchiveLocalState | null> {
        if (this.stateValue === null) this.stateValue = (await this.options.stateStore?.read().catch(() => null)) ?? null;
        return this.stateValue;
    }

    private async saveState(patch: Partial<PhoneArchiveLocalState>): Promise<void> {
        const prior = await this.state();
        const next: PhoneArchiveLocalState = {
            on: false, wallet: null, paid_bytes: 0, used_bytes: 0, space_exhausted: false, next_gb_purchasable: false,
            days_dropped: 0, linked_copies_dropped: 0, last_error: null,
            ...(prior ?? {}),
            ...patch,
            last_run_at_ms: this.now(),
        };
        this.stateValue = next;
        await this.options.stateStore?.write(next).catch(() => undefined);
    }

    /** The meter's schedule: once a day (sooner after a failure). Never throws. */
    async tick(): Promise<PhoneArchiveRunReport | null> {
        if (this.now() < this.nextRunAtMs) return null;
        const report = await this.run();
        this.nextRunAtMs = this.now() + (report.state === 'error' ? PHONE_ARCHIVE_RETRY_MS : PHONE_ARCHIVE_RUN_INTERVAL_MS);
        this.keyBlocked = report.detail === 'owner_key_unavailable';
        return report;
    }

    /**
     * The person just unlocked (their message key is at hand): a run that stopped for want of the
     * key is due again now, not a day later. A cold start runs the keeper before Face ID, so without
     * this a person's phone would almost never verify and drop a day (, found live). Returns
     * whether a run was made due.
     */
    keyAvailable(): boolean {
        if (!this.keyBlocked) return false;
        this.keyBlocked = false;
        this.nextRunAtMs = 0;
        return true;
    }

    /** Run now (single-flight). `history` also uploads days from before the Archive was turned on. */
    async run(options: { readonly history?: boolean } = {}): Promise<PhoneArchiveRunReport> {
        if (this.running) return this.running;
        this.running = this.runOnce(options.history === true)
            .catch((err): PhoneArchiveRunReport => {
                this.log('warn', 'pe archive run failed; it is retried', { error: (err as Error).message });
                return { state: 'error', uploaded_days: 0, dropped_days: 0, dropped_pes: 0, dropped_linked_copies: 0, space_exhausted: false, detail: (err as Error).message };
            })
            .finally(() => { this.running = null; });
        return this.running;
    }

    /** Upload every day this phone still holds that the Archive does not, including days before turn-on. */
    async uploadHistory(): Promise<PhoneArchiveRunReport> {
        return this.run({ history: true });
    }

    private async withSecret<T>(fn: (secret: Uint8Array) => T | Promise<T>): Promise<T | null> {
        const secret = await this.options.messageSecretKey().catch(() => null);
        if (secret === null) return null;
        const copy = new Uint8Array(secret);
        try {
            return await fn(copy);
        } finally {
            copy.fill(0);
        }
    }

    private async allDays(list: (after: string | null) => Promise<MeterAnswer>, fallbackWallet: string): Promise<RelayDay[] | null> {
        const out: RelayDay[] = [];
        let after: string | null = null;
        for (let page = 0; page < 200; page++) {
            const answer = await list(after);
            if (answer.status !== 200) return null;
            const days = parseDays(answer.body, fallbackWallet);
            if (days === null) return null;
            out.push(...days);
            const next = isRecord(answer.body) && typeof answer.body.next_after === 'string' ? answer.body.next_after : null;
            if (days.length < 200 || next === null) break;
            after = next;
        }
        return out;
    }

    private async runOnce(history: boolean): Promise<PhoneArchiveRunReport> {
        const { store, transport } = this.options;
        const statusAnswer = await transport.getStatus();
        const status = statusAnswer.status === 200 ? parseArchiveStatus(statusAnswer.body) : null;
        if (status === null) {
            await this.saveState({ last_error: `status_unreadable:${statusAnswer.status ?? statusAnswer.error ?? 'no answer'}` });
            return { state: 'error', uploaded_days: 0, dropped_days: 0, dropped_pes: 0, dropped_linked_copies: 0, space_exhausted: false, detail: 'status_unreadable' };
        }
        // Copies held for linked agents follow THEIR Archives, whatever this person's own state.
        const linked = await this.dropLinkedCopies(status.wallet);
        if (!status.on) {
            // Off: nothing of this person's own days is uploaded and NOTHING of them is dropped.
            await this.saveState({
                on: false, wallet: status.wallet, paid_bytes: status.paid_bytes, used_bytes: status.used_bytes,
                space_exhausted: false, next_gb_purchasable: status.next_gb_purchasable,
                linked_copies_dropped: ((await this.state())?.linked_copies_dropped ?? 0) + linked.dropped, last_error: linked.error,
            });
            return { state: 'off', uploaded_days: 0, dropped_days: 0, dropped_pes: 0, dropped_linked_copies: linked.dropped, space_exhausted: false, detail: linked.error };
        }
        const own = store.own();
        const days = await this.allDays((after) => transport.listDays(null, after), status.wallet);
        if (days === null) {
            await this.saveState({ last_error: 'days_unreadable' });
            return { state: 'error', uploaded_days: 0, dropped_days: 0, dropped_pes: 0, dropped_linked_copies: linked.dropped, space_exhausted: false, detail: 'days_unreadable' };
        }
        const recipients = await this.recipientsFor(status);
        let uploaded = 0;
        let exhausted = status.space_exhausted;
        let error: string | null = null;
        if (recipients === null) {
            error = 'owner_key_unavailable';
        } else {
            const up = await this.uploadReadyDays(own, status, days, recipients, history);
            uploaded = up.uploaded;
            exhausted = exhausted || up.exhausted;
            error = up.error;
        }
        const after = (await this.allDays((a) => transport.listDays(null, a), status.wallet)) ?? days;
        const drop = await this.dropConfirmedDays(own, status.wallet, after);
        await this.saveState({
            on: true, wallet: status.wallet, paid_bytes: status.paid_bytes, used_bytes: status.used_bytes,
            space_exhausted: exhausted, next_gb_purchasable: status.next_gb_purchasable || exhausted,
            days_dropped: new Set((await own.listArchived()).map((p) => p.archived.day)).size,
            linked_copies_dropped: ((await this.state())?.linked_copies_dropped ?? 0) + linked.dropped,
            last_error: error ?? drop.error ?? linked.error,
        });
        if (exhausted) this.log('warn', 'pe archive: Archive full — add 1 GB for $5. Until then new days stay on this phone and in its cloud backup; nothing is deleted.');
        return {
            state: 'ran', uploaded_days: uploaded, dropped_days: drop.days, dropped_pes: drop.pes,
            dropped_linked_copies: linked.dropped, space_exhausted: exhausted, detail: error ?? drop.error ?? linked.error,
        };
    }

    /** Seal to the person's own published key, checked against the key this phone derives. */
    private async recipientsFor(status: PhoneArchiveStatus): Promise<ArchiveRecipient[] | null> {
        const own = await this.withSecret((secret) => bytesToB64u(x25519.getPublicKey(secret)));
        const published = status.recipients.find((r) => r.role === 'owner');
        if (own === null || published === undefined) return null;
        if (published.pubkey_b64u !== own) {
            this.log('error', 'pe archive: the key the relay publishes for this wallet is not this phone\'s; nothing is uploaded until they match');
            return null;
        }
        return [{ party_id: status.wallet, pubkey_b64u: own }];
    }

    /** Closed days of this phone's own chain whose every batch it holds with a verified anchor proof. */
    async readyDays(chain: DeviceChainStore): Promise<{ day: string; batches: ArchiveBatchInput[]; contract: string }[]> {
        const proofs = new Map((await chain.listProofs()).filter((p) => p.verified).map((p) => [p.seq, p]));
        const byDay = new Map<string, { ready: boolean; batches: ArchiveBatchInput[]; contract: string }>();
        for (const b of await chain.listBatches()) {
            if (b.adopted === true || b.acts_root === null || b.actor_id === null || b.accepted_at_ms === null) continue;
            const day = archiveDayOf(b.accepted_at_ms);
            const slot = byDay.get(day) ?? { ready: true, batches: [], contract: '' };
            byDay.set(day, slot);
            const proof = proofs.get(b.seq);
            if (proof === undefined || proof.batch_hash !== b.batch_hash || proof.anchor.day !== day) {
                slot.ready = false;
                continue;
            }
            const pes: StoredPe[] = await chain.readPes(b.first_index, b.count);
            if (pes.length !== b.count || pes.some((p, i) => p.index !== b.first_index + i)) {
                slot.ready = false; // some of its PEs are already dropped here: never re-archived from here
                continue;
            }
            if (proof.anchor_contract) slot.contract = proof.anchor_contract;
            slot.batches.push({
                device_id: chain.deviceId,
                actor_id: b.actor_id,
                seq: b.seq,
                batch_hash: b.batch_hash,
                acts_root: b.acts_root,
                batch_leaf: proof.batch_leaf,
                first_index: b.first_index,
                pes: pes.map((p) => p.pe),
                anchor: {
                    day: proof.anchor.day,
                    ...(proof.anchor.segment !== undefined ? { segment: proof.anchor.segment } : {}),
                    anchor_batch_id: proof.anchor.anchor_batch_id,
                    leaf_index: proof.anchor.leaf_index,
                    proof: [...proof.anchor.proof],
                    merkle_root: proof.anchor.merkle_root,
                    tx_hash: proof.anchor.anchor_tx_hash,
                },
            });
        }
        return [...byDay.entries()]
            .filter(([, v]) => v.ready && v.batches.length > 0)
            .map(([day, v]) => ({ day, batches: v.batches.sort((a, b) => a.seq - b.seq), contract: v.contract }))
            .sort((a, b) => (a.day < b.day ? -1 : 1));
    }

    private async uploadReadyDays(
        chain: DeviceChainStore,
        status: PhoneArchiveStatus,
        relayDays: readonly RelayDay[],
        recipients: readonly ArchiveRecipient[],
        history: boolean,
    ): Promise<{ uploaded: number; exhausted: boolean; error: string | null }> {
        const held = new Map(relayDays.map((d) => [d.day, d]));
        const turnedOnDay = status.turned_on_at_ms !== null ? archiveDayOf(status.turned_on_at_ms) : null;
        const today = archiveDayOf(this.now());
        let uploaded = 0;
        let error: string | null = null;
        for (const plan of await this.readyDays(chain)) {
            if (plan.day >= today) continue; // a day is archived once it has closed
            if (!history && turnedOnDay !== null && plan.day < turnedOnDay) continue;
            const mine = held.get(plan.day)?.parts.filter((p) => p.device_id === chain.deviceId) ?? [];
            const archivedSeqs = new Set(mine.flatMap((p) => p.batches.map((b) => b.seq)));
            if (plan.batches.every((b) => archivedSeqs.has(b.seq))) continue;
            const parts = planArchiveParts(plan.batches);
            let dayFailed = false;
            for (let n = 0; n < parts.length; n++) {
                const key = `${plan.day}.${n}`;
                if (mine.some((p) => p.part === n && p.state === 'stored')) {
                    this.outbox.delete(key);
                    continue;
                }
                let line = this.outbox.get(key) ?? null;
                if (line === null) {
                    const { entries, refs } = buildArchiveEntries(plan.day, parts[n], plan.contract);
                    line = sealArchivePart({
                        wallet: status.wallet, day: plan.day, device_id: chain.deviceId, part: n, entries, refs, recipients,
                        ...(this.options.randomBytes ? { randomBytes: this.options.randomBytes } : {}),
                    }).line;
                    this.outbox.set(key, line);
                }
                const answer = await this.options.transport.uploadPart(line);
                if (answer.status === 200 || answer.status === 201) {
                    this.outbox.delete(key);
                    continue;
                }
                const code = isRecord(answer.body) && typeof answer.body.error === 'string' ? answer.body.error : `http_${answer.status ?? 'none'}`;
                if (answer.status === 402) {
                    return { uploaded, exhausted: code === 'archive_space_exhausted' || code === 'archive_not_on', error: code };
                }
                if (code === 'archive_part_conflict') {
                    this.outbox.delete(key);
                    continue;
                }
                error = code;
                dayFailed = true;
                this.log('warn', 'pe archive: a part was not stored; it is retried on the next run', { day: plan.day, part: n, error: code });
                break;
            }
            if (!dayFailed) uploaded += 1;
        }
        return { uploaded, exhausted: false, error };
    }

    /** The relay's Archive status for this person (wallet id, on/off). Null when it cannot be read. */
    async readStatus(): Promise<PhoneArchiveStatus | null> {
        try {
            const answer = await this.options.transport.getStatus();
            return answer.status === 200 ? parseArchiveStatus(answer.body) : null;
        } catch {
            return null;
        }
    }

    /**
     * Every Archive day this person can open: `own` = their own days (every device's parts), `linked`
     * = their linked agents' days sealed to them too. Null when the list cannot be read in full.
     */
    async listDayKeys(scope: 'own' | 'linked', ownWallet: string): Promise<{ wallet: string; day: string }[] | null> {
        const { transport } = this.options;
        const days = scope === 'own'
            ? await this.allDays((after) => transport.listDays(null, after), ownWallet).catch(() => null)
            : await this.allDays((after) => transport.listLinkedDays(after), '').catch(() => null);
        if (days === null) return null;
        return days.filter((d) => d.wallet !== '').map((d) => ({ wallet: d.wallet, day: d.day }));
    }

    /**
     * The day's object text: the cached copy unless `fresh`, or one whose parts differ from
     * `expectShas` (then the relay's copy); a fresh copy is cached unless `fill` is false.
     */
    private async dayText(wallet: string, day: string, opts: { readonly fresh?: boolean; readonly expectShas?: readonly string[]; readonly fill?: boolean }): Promise<{ ok: true; text: string; fromCache: boolean } | { ok: false; reason: string }> {
        const key = `${wallet}/${day}`;
        const cache = this.options.objectCache;
        if (cache && opts.fresh !== true) {
            const cached = await cache.get(key).catch(() => null);
            if (cached !== null && (opts.expectShas === undefined || sameShaSet(shasOfText(cached), opts.expectShas))) {
                return { ok: true, text: cached, fromCache: true };
            }
        }
        const answer = await this.options.transport.getDayObject(wallet, day);
        if (answer.status !== 200 || answer.text === null) return { ok: false, reason: `archive_day_unreadable:${answer.status ?? 'none'}` };
        if (cache && opts.fill !== false) await cache.put(key, answer.text).catch(() => undefined);
        return { ok: true, text: answer.text, fromCache: false };
    }

    private openDayText(text: string, wallet: string, day: string, secret: Uint8Array, partyId: string): ({ ok: true; headers: ArchivePartHeader[] } & OpenedDay) | { ok: false; reason: string } {
        let lines: Uint8Array[];
        try {
            lines = splitArchiveObject(utf8Bytes(text));
        } catch {
            return { ok: false, reason: 'archive_object_torn' };
        }
        const payloads: ArchivePayload[] = [];
        const parts: { sha256: string; device_id: string; part: number }[] = [];
        const headers: ArchivePartHeader[] = [];
        for (const line of lines) {
            const parsed = parseArchivePart(line);
            if (!parsed.ok) return { ok: false, reason: `archive_part_invalid:${parsed.error}` };
            if (parsed.header.wallet !== wallet || parsed.header.day !== day) return { ok: false, reason: 'archive_part_wrong_day' };
            parts.push({ sha256: parsed.sha256, device_id: parsed.header.device_id, part: parsed.header.part });
            headers.push(parsed.header);
            const open = openArchivePart(parsed.header, secret, partyId);
            if (!open.ok) return { ok: false, reason: `archive_part_unopenable:${open.error}` };
            payloads.push(open.payload);
        }
        return { ok: true, payloads, parts, headers };
    }

    /**
     * Pull a day of `wallet` (this person's own, or a linked agent's) and open every part with this
     * person's key. `remember: false` (the export) does not keep the opened day in memory afterwards.
     * A cached copy is used unless `fresh`; a cached copy that will not open is replaced by the relay's.
     */
    async pullDay(
        wallet: string,
        day: string,
        partyId: string,
        options: { readonly remember?: boolean; readonly fresh?: boolean; readonly expectShas?: readonly string[]; readonly fill?: boolean } = {},
    ): Promise<({ ok: true; fromCache: boolean; headers: ArchivePartHeader[] } & OpenedDay) | { ok: false; reason: string }> {
        // No key, no point fetching the day: the object cannot be opened without it.
        if ((await this.withSecret(() => true)) === null) return { ok: false, reason: 'owner_key_unavailable' };
        let loaded = await this.dayText(wallet, day, options);
        if (!loaded.ok) return loaded;
        let opened = await this.withSecret((secret) => this.openDayText((loaded as { text: string }).text, wallet, day, secret, partyId));
        if (opened !== null && !opened.ok && loaded.fromCache) {
            loaded = await this.dayText(wallet, day, { ...options, fresh: true });
            if (!loaded.ok) return loaded;
            opened = await this.withSecret((secret) => this.openDayText((loaded as { text: string }).text, wallet, day, secret, partyId));
        }
        if (opened === null) return { ok: false, reason: 'owner_key_unavailable' };
        if (!opened.ok) return opened;
        if (opened.payloads.some(archivePayloadNeedsSegmentRepair) && this.options.transport.getDayProofs) {
            try {
                const answer = await this.options.transport.getDayProofs(wallet, day);
                if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.days)) throw new Error('archive_proof_metadata_unavailable');
                const index = answer.body.days.find((d: unknown) => isRecord(d) && d.day === day && d.wallet === wallet);
                if (!isRecord(index) || !Array.isArray(index.proof_repairs)) throw new Error('archive_proof_metadata_unavailable');
                opened = { ...opened, payloads: opened.payloads.map(p => repairArchivePayloadSegments(p, index.proof_repairs as ArchiveBatchRef[])) };
            } catch (err) { return { ok: false, reason: err instanceof Error ? err.message : 'archive_proof_repair_failed' }; }
        }
        if (options.remember !== false) this.pulled.set(`${wallet}/${day}`, opened.payloads);
        return { ...opened, fromCache: loaded.fromCache };
    }

    /** A PE of this person's dropped here after its day was archived: pulled back, checked against its pointer. */
    async findArchivedPe(peId: string): Promise<{ ok: true; entry: ArchiveEntry } | { ok: false; reason: string }> {
        const { store } = this.options;
        for (const deviceId of store.deviceIds()) {
            const chain = await store.chain(deviceId);
            const pointer = await chain.findArchived(peId);
            if (pointer === null) continue;
            const key = `${pointer.archived.wallet}/${pointer.archived.day}`;
            const matches = (payloads: readonly ArchivePayload[]): ArchiveEntry | null => {
                const entry = findArchivedEntry(payloads.filter((p) => p.device_id === deviceId), peId);
                return entry !== null && entry.pe.pe_hash === pointer.archived.pe_hash && entry.index === pointer.index ? entry : null;
            };
            const held = this.pulled.get(key);
            if (held !== undefined) {
                const entry = matches(held);
                if (entry !== null) return { ok: true, entry };
            }
            let pulled = await this.pullDay(pointer.archived.wallet, pointer.archived.day, pointer.archived.wallet);
            if (!pulled.ok) return pulled;
            let entry = matches(pulled.payloads);
            if (entry === null && pulled.fromCache) {
                pulled = await this.pullDay(pointer.archived.wallet, pointer.archived.day, pointer.archived.wallet, { fresh: true });
                if (!pulled.ok) return pulled;
                entry = matches(pulled.payloads);
            }
            if (entry === null) return { ok: false, reason: 'archive_entry_mismatch' };
            return { ok: true, entry };
        }
        return { ok: false, reason: 'not_archived' };
    }

    /**
     * Every archived day this person can open, with what the relay recorded about it: `own` = their
     * own days, `linked` = their linked agents' days (sealed to them too). Null when unreadable.
     */
    async archivedDays(scope: 'own' | 'linked', ownWallet: string): Promise<ArchivedDayView[] | null> {
        const { transport } = this.options;
        const days = scope === 'own'
            ? await this.allDays((after) => transport.listDays(null, after), ownWallet).catch(() => null)
            : await this.allDays((after) => transport.listLinkedDays(after), '').catch(() => null);
        if (days === null) return null;
        return days.filter((d) => d.wallet !== '').map((d) => ({
            wallet: d.wallet,
            day: d.day,
            confirmed: d.confirmed,
            bytes: d.bytes,
            peCount: d.pe_count,
            rejectedReason: d.rejected_reason,
            partShas: d.parts.filter((p) => p.state === 'stored').map((p) => p.sha256),
        }));
    }

    /**
     * "Pull back": bring an archived day to this phone (once — a cached copy matching the relay's
     * checked parts is used again) and confirm it is intact: its parts are exactly the ones the relay
     * checked, every part opens with this person's key, every PE's hash recomputes and it sits in its
     * batch (`openArchivePart`), every batch folds up to the day's anchored root, and the PE count is
     * the one the relay recorded.
     */
    async verifyDay(day: ArchivedDayView, partyId: string): Promise<DayIntegrity> {
        // Only a day the relay has checked (object = index, every batch anchored) can be intact.
        if (day.rejectedReason !== null) return { ok: false, reason: day.rejectedReason };
        if (!day.confirmed) return { ok: false, reason: 'day_not_yet_checked' };
        const { ethCall } = this.options;
        if (ethCall === undefined) return { ok: false, reason: 'anchor_check_unavailable' };
        const pulled = await this.pullDay(day.wallet, day.day, partyId, { expectShas: day.partShas });
        if (!pulled.ok) return pulled;
        if (!sameShaSet(pulled.parts.map((p) => p.sha256), day.partShas)) return { ok: false, reason: 'parts_differ_from_checked_index' };
        const roots = new Map<string, ExportAnchorClaim>();
        for (const header of pulled.headers) {
            for (const b of header.batches) {
                const root = foldAnchorProof(anchoredLeafOf(b.batch_leaf), b.anchor.proof).toLowerCase();
                if (root !== normHex(b.anchor.merkle_root)) return { ok: false, reason: `batch_not_in_anchored_root:${b.seq}` };
                const known = roots.get(b.anchor.anchor_batch_id);
                if (known !== undefined && known.merkle_root !== root) return { ok: false, reason: `two_roots_for_one_anchor:${b.anchor.anchor_batch_id}` };
                roots.set(b.anchor.anchor_batch_id, { anchor_batch_id: b.anchor.anchor_batch_id, day: b.anchor.day, merkle_root: root, lines: (known?.lines ?? 0) + 1 });
            }
        }
        if (roots.size === 0) return { ok: false, reason: 'no_anchored_batches' };
        const count = pulled.payloads.reduce((n, p) => n + p.entries.length, 0);
        if (day.peCount > 0 && count !== day.peCount) return { ok: false, reason: `pe_count_mismatch:${count}/${day.peCount}` };
        // The roots the copy carries mean nothing until Base says they are the roots it anchored.
        const checks = await verifyAnchorsOnChain([...roots.values()], ethCall);
        const bad = checks.find((c) => !c.ok);
        if (bad !== undefined) return { ok: false, reason: `anchor_${bad.reason ?? 'not_confirmed'}:${bad.anchor_batch_id}` };
        return { ok: true, peCount: count, parts: pulled.parts.length, anchors: roots.size, fromCache: pulled.fromCache };
    }

    private async dropConfirmedDays(chain: DeviceChainStore, wallet: string, days: readonly RelayDay[]): Promise<{ days: number; pes: number; error: string | null }> {
        let droppedDays = 0;
        let droppedPes = 0;
        let error: string | null = null;
        for (const d of days) {
            const mine = d.parts.filter((p) => p.device_id === chain.deviceId);
            if (mine.length === 0 || !mine.every((p) => p.confirmed && p.state === 'stored')) continue;
            if (!this.droppable(d.day)) continue;
            const planned: StoredPe[] = [];
            for (const part of mine) {
                for (const b of part.batches) {
                    for (const p of await chain.readPes(b.first_index, b.count)) {
                        if (p.index >= b.first_index && p.index < b.first_index + b.count) planned.push(p);
                    }
                }
            }
            if (planned.length === 0) continue;
            const pulled = await this.pullDay(wallet, d.day, wallet, {
                expectShas: d.parts.filter((p) => p.state === 'stored').map((p) => p.sha256),
                fill: false,
            });
            if (!pulled.ok) {
                if (pulled.reason === 'owner_key_unavailable') return { days: droppedDays, pes: droppedPes, error: 'owner_key_unavailable' };
                error = pulled.reason;
                continue;
            }
            const confirmed = new Set(mine.map((p) => p.sha256));
            const inObject = new Set(pulled.parts.filter((p) => p.device_id === chain.deviceId).map((p) => p.sha256));
            if (confirmed.size !== inObject.size || [...confirmed].some((s) => !inObject.has(s))) {
                error = 'archive_object_differs_from_confirmed_index';
                continue;
            }
            const archived = new Map<number, ArchiveEntry>();
            for (const payload of pulled.payloads) {
                if (payload.device_id !== chain.deviceId) continue;
                for (const e of payload.entries) archived.set(e.index, e);
            }
            const intact = planned.every((p) => {
                const e = archived.get(p.index);
                return e !== undefined && e.pe.pe_hash === p.pe.pe_hash && samePe(e.pe, p.pe);
            });
            if (!intact) {
                error = 'archive_day_does_not_match_local_pes';
                this.log('error', 'pe archive: an archived day does not match the PEs on this phone; nothing dropped', { day: d.day });
                continue;
            }
            const result = await chain.dropArchivedDay({
                day: d.day, wallet, pes: planned.map((p) => ({ index: p.index, pe_id: p.pe.pe_id, pe_hash: p.pe.pe_hash })),
            });
            droppedDays += 1;
            droppedPes += result.dropped;
        }
        if (droppedDays > 0) this.log('info', 'pe archive: confirmed days dropped from this phone (kept in the Archive; the recent days stay here)', { days: droppedDays, pes: droppedPes, keep_days: this.keepDays });
        return { days: droppedDays, pes: droppedPes, error };
    }

    /**
     * Drop the copies this person holds of linked agents' PEs whose days those agents' Archives
     * confirmed (30+ days old), after pulling each day, opening it with this person's key (agents
     * seal their days to their linked human too) and matching every copy by hash and content.
     */
    private async dropLinkedCopies(humanWallet: string): Promise<{ dropped: number; error: string | null }> {
        const { store, transport } = this.options;
        const rows = (await store.listReceivedRows()).filter((r): r is ReceivedPe => !isArchivedReceived(r));
        if (rows.length === 0) return { dropped: 0, error: null };
        const days = await this.allDays((after) => transport.listLinkedDays(after), '');
        if (days === null) return { dropped: 0, error: 'linked_days_unreadable' };
        let dropped = 0;
        let error: string | null = null;
        for (const d of days) {
            if (!d.confirmed || d.wallet === '' || !this.droppable(d.day)) continue;
            if (!d.parts.every((p) => p.confirmed && p.state === 'stored')) continue;
            const batchKeys = new Set(d.parts.flatMap((p) => p.batches.map((b) => `${p.device_id}|${b.batch_hash}`)));
            const copies = rows.filter((r) => batchKeys.has(`${r.from_device}|${r.batch_hash}`));
            if (copies.length === 0) continue;
            const pulled = await this.pullDay(d.wallet, d.day, humanWallet, {
                expectShas: d.parts.map((p) => p.sha256),
                fill: false,
            });
            if (!pulled.ok) {
                if (pulled.reason === 'owner_key_unavailable') return { dropped, error: 'owner_key_unavailable' };
                error = pulled.reason;
                continue;
            }
            const confirmed = new Set(d.parts.map((p) => p.sha256));
            if (pulled.parts.length !== confirmed.size || pulled.parts.some((p) => !confirmed.has(p.sha256))) {
                error = 'archive_object_differs_from_confirmed_index';
                continue;
            }
            const byHash = new Map<string, ArchiveEntry>();
            for (const payload of pulled.payloads) for (const e of payload.entries) byHash.set(e.pe.pe_hash, e);
            const matched = copies.filter((c) => {
                const e = byHash.get(c.pe_hash);
                return e !== undefined && c.format !== 'v1_envelope' && samePe(e.pe, c.pe);
            });
            if (matched.length !== copies.length) {
                // A copy the archived day does not carry exactly: keep every copy of this day.
                error = 'archive_day_does_not_match_held_copies';
                continue;
            }
            const r = await store.dropReceivedArchived(d.day, d.wallet, matched.map((c) => ({ mailbox_id: c.mailbox_id, pe_hash: c.pe_hash })));
            dropped += r.dropped;
        }
        if (dropped > 0) this.log('info', 'pe archive: copies of linked agents\' archived days dropped from this phone', { dropped });
        return { dropped, error };
    }
}

function normHex(h: string): string {
    const x = h.toLowerCase();
    return x.startsWith('0x') ? x : `0x${x}`;
}

/** The part sha256s of an object's text (empty when it does not parse). */
function shasOfText(text: string): string[] {
    try {
        const out: string[] = [];
        for (const line of splitArchiveObject(utf8Bytes(text))) {
            const parsed = parseArchivePart(line);
            if (!parsed.ok) return [];
            out.push(parsed.sha256);
        }
        return out;
    } catch {
        return [];
    }
}

function sameShaSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length || a.length === 0) return false;
    const x = [...a].sort();
    const y = [...b].sort();
    return x.every((v, i) => v === y[i]);
}

/** Bytes of a sealed part line. */
export function phoneArchiveLineBytes(line: string): number {
    return utf8Bytes(line).length;
}

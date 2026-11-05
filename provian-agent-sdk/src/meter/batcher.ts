/**
 * PE METER — the daily batcher (; daily since 2026-10-04).
 *
 * Once a day — and immediately before any presentation or on-demand payout, so those always
 * reflect the latest acts (`flushBeforeUse`), at shutdown (best-effort), and on demand — the daemon
 * takes this device's
 * unsent PEs in chain order, builds ONE signed batch of their act records (identity + pricing
 * inputs + pe_hash, never free text), seals each PE to whoever the relay names (the linked human
 * of an agent), and sends it. The relay prices the acts in memory, mints, keeps running totals
 * and answers with a receipt, which is filed beside the PEs.
 *
 * THE INVARIANTS
 * - PEs are immutable. A batch is built from the store and never changes a PE; the chain is
 * never re-linked to suit the relay. When the relay's chain cannot be continued from this
 * store, batching STOPS for this device (a persisted halt, reported loudly) until a human
 * resolves it.
 * - The batch being sent is persisted BEFORE it is sent, and re-sent byte for byte until the
 * relay answers definitively. A crash after the relay accepted it therefore re-sends the SAME
 * batch, which the relay answers 200 with the stored receipt — never a second batch.
 * - A batch is rebuilt only after a DEFINITIVE refusal (a 4xx the relay sends before committing
 * anything), never after an unknown outcome (no answer, 5xx).
 * - Offline → nothing is lost: PEs keep accumulating in the store and go in the next batch.
 *
 * Also on schedule: the seal targets (hourly), the daily proofs (each accepted batch's path into
 * that day's on-chain root, plus the kept anchoring record of each batch a received PE came in),
 * and the mailbox (PEs other devices or the relay sealed to this agent).
 */

import * as fs from 'fs';
import * as path from 'path';
import { tryAcquireFileLock } from './file-lock';
import { performance } from 'node:perf_hooks';
import { openThreadMessage, sealThreadMessage } from '../thread-crypto';
import {
  batchHashOf,
  batchLeafOf,
  buildBatch,
  canonicalJson,
  MAX_ACTS_PER_BATCH,
  METER_GENESIS_PREV_HASH,
  peHashOf,
  PE_V2_SCHEMA,
  validateBatchShape,
  type PeBatch,
  type PeV2,
  type SealedCopy,
} from '../meter-wire';
import type {
  AcceptedBatch,
  InFlightBatch,
  MeterAnchorProofWire,
  MeterBatchReceiptWire,
  MeterHalt,
  PeStore,
  StoredBatchProof,
  StoredPe,
} from './pe-store';
import type { MeterAnswer, MeterTransport } from './transport';
import { keepReceivedProofs } from './received-proofs';

export type MeterLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type MeterLog = (level: MeterLogLevel, msg: string, extra?: Record<string, unknown>) => void;

/** One signed batch per day (: was hourly). */
export const METER_BATCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** When another process on this machine is sending, the daemon looks again this soon. */
export const METER_SEND_LOCK_RETRY_MS = 60 * 1000;
/** How long a pre-presentation / pre-payout flush waits for a running send to finish. */
export const METER_FLUSH_LOCK_WAIT_MS = 2 * 60 * 1000;
export const METER_PROOFS_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const METER_MAILBOX_INTERVAL_MS = 60 * 60 * 1000;
export const METER_SEAL_TARGETS_TTL_MS = 60 * 60 * 1000;
/** The relay lands at most one batch per 5 minutes per device unless the previous one was full. */
export const METER_RELAY_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const METER_RETRY_BASE_MS = 5 * 60 * 1000;
export const METER_RETRY_MAX_MS = 60 * 60 * 1000;
/**
 * A `relay_chain_diverged` halt is the one halt that can be stale (an equal-tip false positive), so
 * it is re-checked against the live relay tip: on the failure backoff when the tip cannot be read,
 * and this often while the tip reads but still differs. Never the 24-hour batch cadence — a stale
 * halt that missed one re-check must not wait a day for the next.
 */
export const METER_STALE_HALT_RECHECK_MS = 60 * 60 * 1000;
/**
 * Wire-size budget for one batch. The relay's batch routes take a 2 MB body; a batch over it is
 * refused 413 before the meter sees it (the batcher then splits smaller). A batch therefore
 * carries fewer than MAX_ACTS_PER_BATCH acts only when its PEs (and sealed copies) are very large.
 */
export const METER_DEFAULT_MAX_BATCH_BYTES = 1_900_000;
/** The relay's per-copy limit on a sealed box (validateBatchShape). */
const MAX_SEALED_BOX_CHARS = 262_144;
const CONCURRENT_RESENDS = 3;

export interface SealTarget {
  readonly to: string;
  readonly party_id: string;
  readonly pubkey_b64u: string;
  readonly key_version: number;
}

export interface MeterBatcherOptions {
  readonly store: PeStore;
  readonly transport: MeterTransport;
  readonly log?: MeterLog;
  readonly now?: () => number;
  /** resync hook (see `deliverLineageNotes`). */
  readonly onSessionLineageRejected?: (info: { code: string; expectedOrdinal: number | null }) => void;
  readonly maxBatchBytes?: number;
  /**
   * This agent's x25519 message secret (`deriveMessageKeyPair(walletKey).secretKey`), for opening
   * mailbox items. Called per drain; the returned key is zeroed after use. Absent / null → the
   * mailbox is left on the relay until the recipient acknowledges them and that is logged once.
   */
  readonly messageSecretKey?: () => Promise<Uint8Array | null>;
  /** Sealed-box randomness (tests only). */
  readonly sealRandomBytes?: (n: number) => Uint8Array;
  /** Pause between same-batch re-sends after `batch_concurrent` / `batch_retry` (tests: 0). */
  readonly resendDelayMs?: number;
}

export type SendOutcome =
  | 'nothing_to_send'
  | 'sent'
  | 'deferred'
  | 'halted'
  | 'busy';

export interface SendReport {
  readonly outcome: SendOutcome;
  readonly batchesAccepted: number;
  readonly actsAccepted: number;
  /** When the next attempt should run (deferred, or a size-capped backlog behind the relay's 5-minute rule). */
  readonly retryAtMs: number | null;
  readonly lastStatus: number | null;
  readonly halt: MeterHalt | null;
}

export interface ProofsReport {
  readonly ok: boolean;
  readonly fetched: number;
  readonly unverified: number;
  /**
   * Anchoring records kept for batches received PEs came in (`POST /v1/meter/batch-proofs`).
   * Fetched in the same daily step and KEPT: the relay drops a batch record 30 days after its
   * anchor. A failure here never fails `ok` (it is asked again on the next daily run).
   */
  readonly receivedKept?: number;
}

export interface MailboxReport {
  readonly ok: boolean;
  readonly received: number;
  readonly acked: number;
  readonly skipped: 'no_key' | null;
  readonly unopenable: number;
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

/** A receipt the relay sent, read defensively (only the fields this device acts on are required). */
export function parseBatchReceipt(body: unknown): MeterBatchReceiptWire | null {
  if (!isRecord(body) || body.schema !== 'provian.pe-batch-receipt.v1') return null;
  if (typeof body.seq !== 'number' || typeof body.batch_hash !== 'string' || !Array.isArray(body.acts)) return null;
  if (!isRecord(body.totals)) return null;
  return body as unknown as MeterBatchReceiptWire;
}

/** `lineage_rejected:<reason>[:expected_ordinal=N]` → its parts, or null for any other note. */
export function parseLineageNote(note: string | undefined): { code: string; expectedOrdinal: number | null } | null {
  if (typeof note !== 'string' || !note.startsWith('lineage_rejected:')) return null;
  const rest = note.slice('lineage_rejected:'.length);
  const marker = rest.indexOf(':expected_ordinal=');
  if (marker === -1) return { code: rest.length > 0 ? rest : 'unknown', expectedOrdinal: null };
  const ordinalText = rest.slice(marker + ':expected_ordinal='.length);
  const ordinal = /^\d+$/.test(ordinalText) ? Number(ordinalText) : null;
  return {
    code: rest.slice(0, marker) || 'unknown',
    expectedOrdinal: ordinal !== null && Number.isSafeInteger(ordinal) ? ordinal : null,
  };
}

export class MeterBatcher {
  private readonly store: PeStore;
  private readonly transport: MeterTransport;
  private readonly log: MeterLog;
  private readonly now: () => number;
  private maxBatchBytes: number;
  private sending: Promise<SendReport> | null = null;
  private ticking = false;
  private consecutiveFailures = 0;
  /** The last non-clearing stale-halt re-check outcome logged (each distinct outcome logs once). */
  private staleHaltLogged: string | null = null;
  /** Whether a held send lock has been logged since the lock was last acquired. */
  private sendLockHeldLogged = false;
  private sealTargets: SealTarget[] | null = null;
  private sealTargetsAtMs = 0;
  private noKeyLogged = false;
  private nextSendAtMs = 0;
  private nextProofsAtMs = 0;
  private nextMailboxAtMs = 0;
  private lastMailboxVersion: string | null = null;
  private nextTransitHash: string | null = null;

  constructor(private readonly options: MeterBatcherOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.maxBatchBytes = options.maxBatchBytes ?? METER_DEFAULT_MAX_BATCH_BYTES;
  }

  // ─── schedule ─────────────────────────────────────────────────────────────────

  /**
   * Run whatever is due: the daily batch (sooner when a retry or a backlog is scheduled), the
   * hourly mailbox, the daily proofs. Never overlaps itself; never throws.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (now >= this.nextSendAtMs) {
        const release = this.acquireSendLock();
        if (release === null) {
          // Another process on this machine (a pre-presentation flush) is sending this chain.
          if (!this.sendLockHeldLogged) {
            this.sendLockHeldLogged = true;
            this.log('warn', 'pe meter: another process holds this device\'s send lock; looking again every minute');
          }
          this.nextSendAtMs = this.now() + METER_SEND_LOCK_RETRY_MS;
        } else {
          this.sendLockHeldLogged = false;
          try {
            await this.resendUnacknowledged();
            const report = await this.sendPending();
            this.nextSendAtMs = report.retryAtMs ?? this.now() + METER_BATCH_INTERVAL_MS;
          } finally {
            release();
          }
        }
      }
      if (now >= this.nextMailboxAtMs) {
        await this.checkMailbox();
        this.nextMailboxAtMs = this.now() + METER_MAILBOX_INTERVAL_MS;
      }
      if (now >= this.nextProofsAtMs) {
        const proofs = await this.fetchProofs();
        this.nextProofsAtMs = this.now() + (proofs.ok ? METER_PROOFS_INTERVAL_MS : METER_MAILBOX_INTERVAL_MS);
      }
    } catch (err) {
      this.log('warn', 'pe meter tick failed', { error: (err as Error).message });
    } finally {
      this.ticking = false;
    }
  }

  /** Send now regardless of the schedule (shutdown, `doctor`, tests). */
  async flush(): Promise<SendReport> {
    const release = await this.waitForSendLock(METER_FLUSH_LOCK_WAIT_MS);
    try {
      const report = await this.sendPending();
      this.nextSendAtMs = report.retryAtMs ?? this.now() + METER_BATCH_INTERVAL_MS;
      return report;
    } finally {
      release();
    }
  }

  /**
   * Send everything recorded so far, right before a presentation or an on-demand payout (the operator,
   * 2026-10-04), so the relay's totals and pending claims include the latest acts. When the relay
   * holds this device to its 5-minute rule (a batch landed moments ago), wait that out once and
   * send again. Returns the last report; the caller proceeds either way (a presentation or payout
   * that the relay cannot serve fails on its own terms).
   */
  async flushBeforeUse(options: { readonly sleep?: (ms: number) => Promise<void> } = {}): Promise<SendReport> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    let report = await this.flush();
    if (report.outcome === 'deferred' && report.lastStatus === 429 && report.retryAtMs !== null) {
      const wait = report.retryAtMs - this.now();
      if (wait > 0 && wait <= METER_RELAY_MIN_INTERVAL_MS + 10_000) {
        this.log('info', 'pe meter: waiting out the relay\'s 5-minute rule before sending the latest acts', { wait_ms: wait });
        await sleep(wait);
        report = await this.flush();
      }
    }
    return report;
  }

  // ─── cross-process send lock ─────────────────────────────────────────────────

  /**
   * The daemon and a CLI flush are separate processes over one chain; only one may build and send
   * the next batch at a time. A lock file beside the store (a store without a directory, e.g. in
   * memory, needs none). Returns a release function, or null while another live process sends.
   */
  private acquireSendLock(): (() => void) | null {
    const location = this.store.location;
    let isDir = false;
    try { isDir = typeof location === 'string' && fs.statSync(location).isDirectory(); } catch { isDir = false; }
    if (!isDir) return () => {};
    return tryAcquireFileLock(path.join(location, 'send.lock'), { timeoutMs: 0, staleMs: 15 * 60 * 1000, syncOnly: false, ownPidBeforeMs: performance.timeOrigin });
  }

  private async waitForSendLock(maxWaitMs: number): Promise<() => void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const release = this.acquireSendLock();
      if (release !== null) return release;
      if (Date.now() >= deadline) throw new Error('pe meter: another process has been sending this device\'s batch for too long');
      await new Promise<void>((resolve) => { setTimeout(resolve, 1_000); });
    }
  }

  // ─── position ─────────────────────────────────────────────────────────────────

  private async position(): Promise<Position> {
    const last = await this.store.lastBatch();
    if (last === null) return { seq: 0, batch_hash: METER_GENESIS_PREV_HASH, last_pe_hash: METER_GENESIS_PREV_HASH, next_index: 0 };
    return { seq: last.seq, batch_hash: last.batch_hash, last_pe_hash: last.last_pe_hash, next_index: last.first_index + last.count };
  }

  private async haltWith(reason: string, detail: string, extra: Record<string, unknown> = {}): Promise<MeterHalt> {
    const halt: MeterHalt = { reason, detail, at_ms: this.now() };
    await this.store.setHalt(halt);
    this.log('error', `PE METER HALTED for device ${this.store.deviceId}: ${reason} — ${detail}. `
      + 'PEs keep being recorded on this machine, but no batch is sent until this is resolved. '
      + 'PEs are never rewritten to suit the relay.', { ...extra, store: this.store.location });
    return halt;
  }

  private retryAfterFailure(): number {
    this.consecutiveFailures += 1;
    const exp = Math.min(this.consecutiveFailures - 1, 10);
    return this.now() + Math.min(METER_RETRY_BASE_MS * 2 ** exp, METER_RETRY_MAX_MS);
  }

  // ─── seal targets ─────────────────────────────────────────────────────────────

  /**
   * Whom to seal each PE to (cached; refreshed at most hourly). `null` = the relay could not be
   * asked and nothing is cached, so the batch waits (sealing is the linked human's copy).
   */
  async refreshSealTargets(force = false): Promise<SealTarget[] | null> {
    if (!force && this.sealTargets !== null && this.now() - this.sealTargetsAtMs < METER_SEAL_TARGETS_TTL_MS) return this.sealTargets;
    const answer = await this.transport.getSealTargets();
    if (answer.status === 200 && isRecord(answer.body) && Array.isArray(answer.body.targets)) {
      const targets: SealTarget[] = [];
      for (const t of answer.body.targets) {
        if (isRecord(t) && typeof t.to === 'string' && typeof t.party_id === 'string' && typeof t.pubkey_b64u === 'string') {
          targets.push({ to: t.to, party_id: t.party_id, pubkey_b64u: t.pubkey_b64u, key_version: typeof t.key_version === 'number' ? t.key_version : 0 });
        }
      }
      this.sealTargets = targets;
      this.sealTargetsAtMs = this.now();
      return targets;
    }
    if (answer.status !== null && answer.status >= 400 && answer.status < 500 && answer.status !== 401 && answer.status !== 429) {
      // The relay answered and has no targets route / nothing for us: send without sealed copies.
      this.sealTargets = [];
      this.sealTargetsAtMs = this.now();
      return this.sealTargets;
    }
    return this.sealTargets; // transport failure: keep what is cached (null when nothing is)
  }

  private sealCopies(pes: readonly StoredPe[], targets: readonly SealTarget[]): SealedCopy[] {
    const sealed: SealedCopy[] = [];
    for (const target of targets) {
      for (const { pe } of pes) {
        let box: string;
        try {
          const out = sealThreadMessage(
            canonicalJson(pe),
            { [target.party_id]: target.pubkey_b64u },
            this.options.sealRandomBytes,
          );
          box = out.ciphertexts[target.party_id];
        } catch (err) {
          this.log('warn', 'pe meter: could not seal to a target key; sending without that copy', {
            to: target.to, error: (err as Error).message,
          });
          break;
        }
        if (box.length > MAX_SEALED_BOX_CHARS) {
          this.log('warn', 'pe meter: PE too large to seal within the relay limit; its sealed copy is skipped', { pe_id: pe.pe_id, to: target.to });
          continue;
        }
        sealed.push({ to: target.to, pe_id: pe.pe_id, box });
      }
    }
    return sealed;
  }

  // ─── building ─────────────────────────────────────────────────────────────────

  private async buildNext(position: Position, targets: readonly SealTarget[]): Promise<InFlightBatch | MeterHalt | null> {
    const pes = await this.store.readPes(position.next_index, MAX_ACTS_PER_BATCH);
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
        device_id: this.store.deviceId,
        seq: position.seq + 1,
        prev_batch_hash: position.batch_hash,
        created_at_ms: this.now(),
        pes: slice.map((p) => p.pe),
        sealed: this.sealCopies(slice, targets),
      });
      const bytes = Buffer.byteLength(JSON.stringify(batch), 'utf8');
      if (bytes > this.maxBatchBytes && count > 1) {
        count = Math.max(1, Math.min(count - 1, Math.floor(count * (this.maxBatchBytes / bytes) * 0.95)));
        continue;
      }
      const shape = validateBatchShape(JSON.parse(JSON.stringify(batch)));
      if (!shape.ok) {
        return this.haltWith('local_batch_invalid', `the batch built from PEs ${position.next_index}..${position.next_index + count - 1} fails the wire check (${shape.error}${shape.index !== undefined ? ` at act ${shape.index}` : ''})`);
      }
      return {
        batch,
        batch_hash: batchHashOf(batch),
        first_index: position.next_index,
        count,
        last_pe_hash: slice[slice.length - 1].pe.pe_hash,
        persisted_at_ms: this.now(),
        transit_parties: Object.fromEntries(targets.map(t => [t.to, t.party_id])),
      };
    }
  }

  // ─── sending ──────────────────────────────────────────────────────────────────

  /** Send every unsent PE that can go now. Single-flight; never throws. */
  async sendPending(): Promise<SendReport> {
    if (this.sending) return this.sending;
    this.sending = this.sendPendingOnce()
      .catch(async (err): Promise<SendReport> => {
        this.log('warn', 'pe meter send failed', { error: (err as Error).message });
        return { outcome: 'deferred', batchesAccepted: 0, actsAccepted: 0, retryAtMs: this.retryAfterFailure(), lastStatus: null, halt: null };
      })
      .finally(() => { this.sending = null; });
    return this.sending;
  }

  private async sendPendingOnce(): Promise<SendReport> {
    let batchesAccepted = 0;
    let actsAccepted = 0;
    let lastStatus: number | null = null;
    let concurrentResends = 0;
    let rebuilds = 0;
    const report = (outcome: SendOutcome, retryAtMs: number | null, halt: MeterHalt | null = null): SendReport =>
      ({ outcome, batchesAccepted, actsAccepted, retryAtMs, lastStatus, halt });

    for (let guard = 0; guard < 1000; guard++) {
      const halted = await this.store.halt();
      if (halted !== null) {
        // A relay_chain_diverged halt can be a stale false positive (recorded before the
        // matching-tips fix, or from a benign replay): the relay's tip actually equals this
        // device's position. Re-check once against the live tip and clear ONLY on an exact match
        // — a real divergence keeps the device halted. This lets a wrongly-halted daemon resume
        // its queued records with nothing run on its box.
        // A stale-halt re-check that could not clear is scheduled again soon (never the 24-hour
        // cadence): on the failure backoff when the tip was unreadable, hourly while it differs.
        const check = await this.tryClearStaleDivergenceHalt(halted);
        if (check !== 'cleared') {
          const retryAtMs = check === 'tip_unreadable' ? this.retryAfterFailure()
            : check === 'mismatch' ? this.now() + METER_STALE_HALT_RECHECK_MS
              : null;
          return report('halted', retryAtMs, halted);
        }
      }
      const position = await this.position();

      let inflight = await this.store.inFlight();
      if (inflight !== null && inflight.batch.seq <= position.seq) {
        // Its receipt was filed before a crash cleared it: already accepted.
        await this.store.setInFlight(null);
        inflight = null;
      }
      if (inflight !== null && (inflight.batch.seq !== position.seq + 1 || inflight.batch.prev_batch_hash !== position.batch_hash
        || inflight.first_index !== position.next_index)) {
        const halt = await this.haltWith('inflight_inconsistent', `the persisted in-flight batch (seq ${inflight.batch.seq}) does not extend the last accepted batch (seq ${position.seq})`);
        return report('halted', null, halt);
      }
      if (inflight === null) {
        const targets = await this.refreshSealTargets();
        if (targets === null) {
          this.log('warn', 'pe meter: relay unreachable (seal targets); PEs stay queued on this machine');
          return report(batchesAccepted > 0 ? 'sent' : 'deferred', this.retryAfterFailure());
        }
        const built = await this.buildNext(position, targets);
        if (built === null) {
          this.consecutiveFailures = 0;
          return report(batchesAccepted > 0 ? 'sent' : 'nothing_to_send', null);
        }
        if (!('batch' in built)) return report('halted', null, built);
        // Durable BEFORE it is sent: a crash from here on re-sends exactly this batch.
        await this.store.setInFlight(built);
        inflight = built;
      }

      const openings:Record<string,string>={};
      for(const stored of await this.store.readPes(inflight.first_index,inflight.count)) {
        if(stored.pe.private_pricing!==undefined) {
          if(typeof stored.pe.private_commitment!=='string')throw new Error('private pricing opening missing on owner device');
          openings[stored.pe.pe_id]=stored.pe.private_commitment;
        }
      }
      const answer = await this.transport.postBatch(inflight.batch,openings);
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
        if (inflight.count >= MAX_ACTS_PER_BATCH) continue; // a full batch: the relay takes the next one at once
        const head = await this.store.head();
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
        const body = isRecord(answer.body) ? answer.body : {};
        const halt = await this.haltWith('act_chain_broken', `the relay's last accepted PE for this device is ${String(body.last_pe_hash)}, but this device's batch continues from ${inflight.batch.acts[0]?.prev_hash ?? '?'}`);
        return report('halted', null, halt);
      }

      if (answer.status === 429) {
        const body = isRecord(answer.body) ? answer.body : {};
        const afterMs = typeof body.retry_after_ms === 'number' ? body.retry_after_ms
          : typeof body.retry_after === 'number' ? body.retry_after * 1000 : METER_RELAY_MIN_INTERVAL_MS;
        return report(batchesAccepted > 0 ? 'sent' : 'deferred', this.now() + Math.max(1_000, afterMs));
      }

      if (answer.status === 413) {
        // Definitive: nothing was committed. Rebuild smaller (a PE is never changed).
        await this.store.setInFlight(null);
        if (inflight.count <= 1 || rebuilds >= 8) {
          const halt = await this.haltWith('pe_too_large', `PE ${inflight.first_index} alone exceeds the relay's request-size limit`);
          return report('halted', null, halt);
        }
        rebuilds += 1;
        const bytes = Buffer.byteLength(JSON.stringify(inflight.batch), 'utf8');
        this.maxBatchBytes = Math.max(1_000, Math.min(this.maxBatchBytes, Math.floor(bytes / 2)));
        this.log('warn', 'pe meter: batch too large for the relay; rebuilding smaller', { bytes, budget: this.maxBatchBytes });
        continue;
      }

      if (answer.status === 400 && error === 'batch_invalid') {
        const body = isRecord(answer.body) ? answer.body : {};
        const halt = await this.haltWith('batch_invalid', `the relay refused the batch's shape (${String(body.code)}${body.act_index !== undefined ? ` at act ${String(body.act_index)}` : ''})`);
        return report('halted', null, halt);
      }

      if (answer.status === 403 && error === 'batch_device_mismatch') {
        const halt = await this.haltWith('batch_device_mismatch', `the relay authenticated a different device than ${this.store.deviceId}`);
        return report('halted', null, halt);
      }

      // No answer, 5xx, 401/407 (a proxy or a credential mid-rotation), anything unrecognised:
      // the outcome may be unknown, so the SAME batch stays in flight and is re-sent later.
      this.log('warn', 'pe meter: batch not accepted yet; it stays queued and is re-sent', {
        status: answer.status, error: error ?? answer.error, seq: inflight.batch.seq,
      });
      return report(batchesAccepted > 0 ? 'sent' : 'deferred', this.retryAfterFailure());
    }
    return report('deferred', this.retryAfterFailure());
  }

  /** File an accepted batch and its receipt, clear the in-flight copy, then act on its notes. */
  private async accept(inflight: InFlightBatch, receipt: MeterBatchReceiptWire): Promise<void> {
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
      ...(receipt.transit_receipt ? { transit_receipt: receipt.transit_receipt } : {}),
      ...(receipt.transit_recipients ? { transit_recipients: receipt.transit_recipients } : {}),
      ...(inflight.batch.sealed?.length ? {
        transit: inflight.batch.sealed,
        transit_parties: inflight.transit_parties ?? Object.fromEntries((this.sealTargets ?? []).map(t => [t.to, t.party_id])),
      } : {}),
    };
    // ORDER: receipt + cursor first, then the in-flight copy goes. A crash between the two leaves
    // an in-flight batch at or below the cursor, which the next cycle recognises and clears.
    await this.store.recordBatch(record, receipt);
    await this.store.setInFlight(null);
    this.log('info', 'pe batch accepted', {
      seq: record.seq, acts: record.count, eligible: receipt.totals.eligible,
      eligible_points_atomic: receipt.totals.eligible_points_atomic,
    });
    await this.deliverLineageNotes(inflight, receipt);
  }

  /** Storage redelivery is separate from pricing: it never builds another earning batch. */
  async resendUnacknowledged(): Promise<{ resent: number; acknowledged: number }> {
    const send = this.transport.resendTransit;
    if (!send) return { resent: 0, acknowledged: 0 };
    const acked = await this.store.transitAcknowledged?.() ?? new Set<string>();
    const targets = await this.refreshSealTargets();
    if (targets === null) return { resent: 0, acknowledged: 0 };
    let resent = 0, acknowledged = 0;
    const batches = (await this.store.listBatches()).filter(batch => !acked.has(batch.batch_hash) && batch.transit?.length);
    const cursor = await this.store.transitCursor?.() ?? this.nextTransitHash;
    const start = Math.max(0, batches.findIndex(batch => batch.batch_hash === cursor));
    for (let offset = 0; offset < batches.length; offset++) {
      const index = (start + offset) % batches.length, batch = batches[index];
      // A changed beneficiary must not receive ciphertext intended for the old beneficiary.
      if (batch.transit!.some(s => !targets.some(t => t.to === s.to
        && t.party_id === batch.transit_parties?.[s.to]))) continue;
      const result = await send(batch.batch_hash, batch.transit!, batch.transit_receipt, batch.transit_recipients);
      // A global rate limit resumes at this unsent batch; other failures move to the next
      // batch so one bad copy cannot starve the rest. The failed copy remains in the outbox.
      this.nextTransitHash = result.status === 429 ? batch.batch_hash : batches[(index + 1) % batches.length].batch_hash;
      await this.store.setTransitCursor?.(this.nextTransitHash);
      if (result.status !== 200 || !isRecord(result.body)) break;
      resent++;
      if (result.body.complete === true) {
        await this.store.acknowledgeTransit?.(batch.batch_hash);
        acknowledged++;
      }
    }
    return { resent, acknowledged };
  }

  /**
   * A refused lineage claim still records the priced act and reports the next
   * expected ordinal. Only deliver the last refusal when no later PE has its
   * own lineage claim: a refusal for an older session must not roll a newer
   * session backwards into a fork. Outbox replay does not identify live state.
   */
  private async deliverLineageNotes(inflight: InFlightBatch, receipt: MeterBatchReceiptWire): Promise<void> {
    const callback = this.options.onSessionLineageRejected;
    if (!callback) return;
    let lastIndex = -1;
    let lastNote: { code: string; expectedOrdinal: number | null } | null = null;
    receipt.acts.forEach((act, i) => {
      const parsed = parseLineageNote(act.note);
      if (parsed !== null) { lastIndex = i; lastNote = parsed; }
    });
    if (lastNote === null || lastIndex < 0) return;
    const note: { code: string; expectedOrdinal: number | null } = lastNote;
    this.log('warn', `session lineage rejected by the relay (${note.code}); that act was recorded without it`, {
      pe_id: receipt.acts[lastIndex].pe_id,
    });
    const head = await this.store.head();
    const from = inflight.first_index + lastIndex + 1;
    for (let i = from; i < head.count; i += MAX_ACTS_PER_BATCH) {
      const later = await this.store.readPes(i, MAX_ACTS_PER_BATCH);
      if (later.some((p) => p.pe.economic_session_lineage !== undefined && p.pe.economic_session_lineage !== null)) return;
    }
    try { callback(note); } catch { /* the observer's resync must never break batching */ }
  }

  /**
   * The relay refused the batch's position (`batch_replay` / `batch_chain_broken`). Read the
   * relay's tip and decide WITHOUT touching a PE:
   *   - the relay's last accepted PE is one of THIS device's own PEs past the local cursor (the
   *     local record of some accepted batches was lost): adopt the relay's tip as the cursor —
   *     the PEs are unchanged, only the bookkeeping catches up — and continue from there;
   *   - anything else (the relay is behind this store, or holds a PE this store never made):
   *     halt. Re-chaining would mean rewriting PEs, which is never allowed.
   */
  /**
   * Clear a stale `relay_chain_diverged` halt when the live relay tip proves there is no
   * divergence after all — its accepted position is byte-identical to this device's (same seq,
   * batch_hash and last PE). ONLY this one halt reason is self-clearing, and ONLY on an exact
   * match; every other halt, an unreadable tip, and any genuine mismatch keep the device halted.
   * This is what lets a daemon that was wrongly halted (an equal-seq replay recorded as a
   * divergence) resume its queued records with nothing run on its box. No PE is touched.
   */
  private async tryClearStaleDivergenceHalt(halt: MeterHalt): Promise<'cleared' | 'not_self_clearing' | 'tip_unreadable' | 'mismatch'> {
    if (halt.reason !== 'relay_chain_diverged') return 'not_self_clearing';
    const tipAnswer = await this.transport.getTip();
    if (!(tipAnswer.status === 200 && isRecord(tipAnswer.body)
      && typeof tipAnswer.body.seq === 'number'
      && typeof tipAnswer.body.batch_hash === 'string'
      && typeof tipAnswer.body.last_pe_hash === 'string')) {
      this.logStaleHaltOnce(`unreadable:${String(tipAnswer.status)}`,
        'pe meter: halted (relay_chain_diverged) and the relay tip could not be read to re-check it; retrying soon', {
          status: tipAnswer.status, error: tipAnswer.error ?? null,
        });
      return 'tip_unreadable';
    }
    const relay = { seq: tipAnswer.body.seq, batch_hash: tipAnswer.body.batch_hash, last_pe_hash: tipAnswer.body.last_pe_hash };
    const local = await this.position();
    if (relay.seq === local.seq && relay.batch_hash === local.batch_hash && relay.last_pe_hash === local.last_pe_hash) {
      await this.store.setInFlight(null);
      await this.store.setHalt(null);
      this.staleHaltLogged = null;
      this.consecutiveFailures = 0;
      this.log('warn', 'pe meter: cleared a stale relay_chain_diverged halt — relay tip matches this device; resuming', {
        seq: local.seq, last_pe_hash: local.last_pe_hash,
      });
      return 'cleared';
    }
    this.logStaleHaltOnce(`mismatch:${relay.seq}:${relay.batch_hash}:${relay.last_pe_hash}:${local.seq}:${local.batch_hash}:${local.last_pe_hash}`,
      'pe meter: halted (relay_chain_diverged); the relay tip still differs from this device — re-checking hourly', {
        relay_seq: relay.seq, relay_batch_hash: relay.batch_hash, relay_last_pe_hash: relay.last_pe_hash,
        local_seq: local.seq, local_batch_hash: local.batch_hash, local_last_pe_hash: local.last_pe_hash,
      });
    return 'mismatch';
  }

  /** Log a non-clearing stale-halt re-check once per distinct outcome (a re-check runs often). */
  private logStaleHaltOnce(key: string, msg: string, extra: Record<string, unknown>): void {
    if (this.staleHaltLogged === key) return;
    this.staleHaltLogged = key;
    this.log('warn', msg, extra);
  }


  private async resync(answer: MeterAnswer, inflight: InFlightBatch): Promise<'adopted' | MeterHalt> {
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
    // Matching tips are NOT a divergence. When the relay's accepted position IS this device's
    // position (same seq, batch_hash and last PE), the refusal that brought us here was a benign
    // replay — an already-accepted batch re-sent. Clear the in-flight and resume from next_index;
    // no PE is rewritten. Without this, an equal-seq match falls through to a false
    // relay_chain_diverged halt below.
    if (relay.seq === local.seq
      && relay.batch_hash === local.batch_hash
      && relay.last_pe_hash === local.last_pe_hash) {
      await this.store.setInFlight(null);
      this.log('info', 'pe meter: relay tip matches this device; the refused batch was a replay — resuming (no divergence)', {
        seq: local.seq, last_pe_hash: local.last_pe_hash,
      });
      return 'adopted';
    }
    if (relay.seq > local.seq && hex64(relay.last_pe_hash)) {
      const head = await this.store.head();
      for (let i = local.next_index; i < head.count; i += MAX_ACTS_PER_BATCH) {
        const pes = await this.store.readPes(i, MAX_ACTS_PER_BATCH);
        const hit = pes.find((p) => p.pe.pe_hash === relay!.last_pe_hash);
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
          await this.store.recordBatch(adopted, null);
          await this.store.setInFlight(null);
          this.log('warn', 'pe meter: the relay already held batches this machine had no record of; resynced to its tip (no PE changed)', {
            relay_seq: relay.seq, local_seq: local.seq, pes_covered: adopted.count,
          });
          return 'adopted';
        }
      }
    }
    return this.haltWith(
      relay.seq < local.seq ? 'relay_behind_local' : 'relay_chain_diverged',
      `relay tip seq ${relay.seq} / last PE ${relay.last_pe_hash}; this machine's last accepted seq ${local.seq} / last PE ${local.last_pe_hash}, and the relay's last PE is not one of this device's unbatched PEs`,
      { relay_batch_hash: relay.batch_hash, local_batch_hash: local.batch_hash },
    );
  }

  // ─── proofs ───────────────────────────────────────────────────────────────────

  /**
   * Fetch every anchored batch's proof after the last one held, and file it with the batch. A
   * proof whose batch leaf does not recompute from this device's own batch record is filed as
   * `verified: false` (and logged) — kept, never trusted.
   */
  async fetchProofs(): Promise<ProofsReport> {
    const held = await this.store.listProofs();
    const heldSeqs = new Set(held.map((p) => p.seq));
    let after = held.reduce((m, p) => Math.max(m, p.seq), 0);
    const batches = new Map((await this.store.listBatches()).map((b) => [b.seq, b]));
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
          device_id: this.store.deviceId, actor_id: raw.actor_id, seq: raw.seq, batch_hash: raw.batch_hash, acts_root: raw.acts_root,
        });
        const verified = own !== undefined && own.adopted !== true && own.batch_hash === raw.batch_hash
          && own.acts_root === raw.acts_root && leaf === raw.batch_leaf;
        if (!verified) {
          unverified += 1;
          this.log('warn', 'pe meter: a relay proof does not match this machine\'s batch record; kept as unverified', { seq: raw.seq });
        }
        const proof: StoredBatchProof = {
          seq: raw.seq,
          batch_hash: raw.batch_hash,
          batch_leaf: raw.batch_leaf,
          acts_root: raw.acts_root,
          actor_id: raw.actor_id,
          anchor: raw.anchor as unknown as MeterAnchorProofWire,
          fetched_at_ms: this.now(),
          verified,
        };
        await this.store.recordProof(proof);
        heldSeqs.add(raw.seq);
        fetched += 1;
        after = Math.max(after, raw.seq);
      }
      const next = answer.body.next_after_seq;
      if (proofs.length === 0 || typeof next !== 'number') break;
      after = Math.max(after, next);
    }
    if (fetched > 0) this.log('info', 'pe meter: proofs filed', { fetched, unverified });
    const receivedKept = await this.keepReceivedProofs();
    return { ok: true, fetched, unverified, receivedKept };
  }

  /**
   * The anchoring record of each batch a received PE came in, kept once its day is anchored (PE
   * export needs it to prove received PEs; the relay drops a record 30 days after its anchor).
   * Never throws; a failure is logged and the step runs again tomorrow.
   */
  async keepReceivedProofs(): Promise<number> {
    try {
      const report = await keepReceivedProofs(this.store, this.transport, this.now());
      if (report.kept > 0) this.log('info', 'pe meter: received-PE batch proofs kept', { kept: report.kept, pending: report.pending });
      if (report.refused > 0) this.log('warn', 'pe meter: a relay batch-proofs answer failed its checks; not kept', { refused: report.refused });
      if (!report.ok && report.fetch?.error) this.log('debug', 'pe meter: received-PE batch proofs not fetched; retried tomorrow', { error: report.fetch.error });
      return report.kept;
    } catch (err) {
      this.log('warn', 'pe meter: received-PE batch proofs step failed; retried tomorrow', { error: (err as Error).message });
      return 0;
    }
  }

  // ─── mailbox ──────────────────────────────────────────────────────────────────

  /**
   * File PEs sealed to this agent (from its other devices or the relay) in the local store, then
   * acknowledge them so the relay drops its ciphertext. An item this key cannot open, or whose
   * opened PE does not match what it claims, is neither filed nor acknowledged.
   */
  /** Compare the head seen BEFORE draining; a concurrent arrival remains visible next hour. */
  async checkMailbox(): Promise<void> {
    if (!this.transport.peekMailbox || !this.options.messageSecretKey) { await this.drainMailbox(); return; }
    let peek: MeterAnswer;
    try { peek = await this.transport.peekMailbox(); } catch { await this.drainMailbox(); return; }
    if (peek.status !== 200 || !isRecord(peek.body) || typeof peek.body.version !== 'string' || peek.body.version.length === 0 || peek.body.version.length > 128) {
      await this.drainMailbox(); return; // an unavailable check never means an empty mailbox
    }
    const version = peek.body.version;
    if (version === this.lastMailboxVersion) return;
    const report = await this.drainMailbox();
    if (report.ok && report.skipped === null && report.unopenable === 0) this.lastMailboxVersion = version;
  }

  async drainMailbox(): Promise<MailboxReport> {
    const provider = this.options.messageSecretKey;
    const secret = provider ? await provider().catch(() => null) : null;
    if (secret === null) {
      if (!this.noKeyLogged) {
        this.noKeyLogged = true;
        this.log('info', 'pe meter: no access to this agent\'s wallet key here; mailbox items stay on the relay until they are acknowledged');
      }
      return { ok: true, received: 0, acked: 0, skipped: 'no_key', unopenable: 0 };
    }
    let received = 0;
    let acked = 0;
    let unopenable = 0;
    let after: string | null = null;
    let complete = false, acknowledgementsOk = true;
    try {
      for (let page = 0; page < 50; page++) {
        const answer = await this.transport.getMailbox(after, 100);
        if (answer.status !== 200 || !isRecord(answer.body) || !Array.isArray(answer.body.items)) {
          return { ok: false, received, acked, skipped: null, unopenable };
        }
        const ackIds: string[] = [];
        for (const raw of answer.body.items) {
          if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.box !== 'string' || typeof raw.pe_id !== 'string') { unopenable += 1; continue; }
          let pe: PeV2;
          let opened: unknown;
          try {
            opened = JSON.parse(openThreadMessage(secret, raw.box)) as unknown;
          } catch {
            unopenable += 1;
            continue;
          }
          // A pre-meter (v1) PE the relay handed back when it stopped storing PEs: no `schema`,
          // keyed by `id`. Filed verbatim beside the v2 PEs.
          if (isRecord(opened) && opened.schema === undefined && opened.id === raw.pe_id && typeof opened.hash === 'string') {
            const filedLegacy = await this.store.recordLegacy({
              mailbox_id: raw.id,
              pe_id: raw.pe_id,
              envelope: opened,
              received_at_ms: this.now(),
            });
            if (filedLegacy) received += 1;
            ackIds.push(raw.id);
            continue;
          }
          if (!isRecord(opened) || opened.schema !== PE_V2_SCHEMA || opened.pe_id !== raw.pe_id) {
            unopenable += 1;
            continue;
          }
          pe = opened as unknown as PeV2;
          const hash = peHashOf(pe);
          if (typeof pe.pe_hash === 'string' && pe.pe_hash !== hash) {
            unopenable += 1;
            continue;
          }
          const filed = await this.store.recordReceived({
            mailbox_id: raw.id,
            pe_id: raw.pe_id,
            pe,
            pe_hash: hash,
            hash_checked: typeof pe.pe_hash === 'string',
            from_device: typeof raw.from_device === 'string' ? raw.from_device : '',
            from_actor: typeof raw.from_actor === 'string' ? raw.from_actor : '',
            batch_hash: typeof raw.batch_hash === 'string' ? raw.batch_hash : '',
            created_at_ms: typeof raw.created_at_ms === 'number' ? raw.created_at_ms : 0,
            received_at_ms: this.now(),
          });
          if (filed) received += 1;
          ackIds.push(raw.id); // filed now or already filed earlier: either way it is ours to drop
        }
        if (ackIds.length > 0) {
          const ack = await this.transport.ackMailbox(ackIds);
          if (ack.status === 200) acked += ackIds.length; else acknowledgementsOk = false;
        }
        const next = answer.body.next;
        if (typeof next !== 'string' || next.length === 0) { complete = true; break; }
        after = next;
      }
    } finally {
      secret.fill(0);
    }
    if (unopenable > 0) this.log('warn', 'pe meter: mailbox items this agent\'s key cannot open were left on the relay', { unopenable });
    if (received > 0) this.log('info', 'pe meter: mailbox PEs filed', { received });
    return { ok: complete && acknowledgementsOk, received, acked, skipped: null, unopenable };
  }
}

/**
 * PE METER — the device's own PE store (: the relay is a meter, not an
 * archive).
 *
 * A PE lives with its owner. This device builds each PE itself (PE v2,
 * hashed and chained here), keeps it here, and sends the relay only the act record inside one
 * signed daily batch, plus immediately before a presentation or on-demand payout. The relay
 * prices it in memory, keeps running totals and returns a
 * receipt; the daily on-chain anchor covers every batch and the device fetches its proof. Proving
 * an act later requires the PE — which is why this store is append-only and never deletes.
 *
 * WHAT IT HOLDS (one directory per device id):
 * pes.jsonl this device's own PEs, in chain order — one line per PE, each with its
 * pe_hash; appended + fsynced; never rewritten
 * head.json { count, last_pe_hash, bytes } — the chain head (atomic replace)
 * idem/<key>.json a lane's idempotency key → the PE it already recorded (a resubmission
 * after a restart answers with that PE instead of chaining a second one)
 * batches.jsonl every batch the relay accepted (compact: seq, hashes, PE range, totals)
 * receipts.jsonl the relay's full receipt for each accepted batch
 * batch-head.json the latest accepted batch (atomic replace) — the batcher's cursor
 * inflight.json the batch being sent; a crash re-sends THIS batch, which the relay
 * answers 200 with the same receipt
 * proofs.jsonl each batch's inclusion proof in its day's on-chain root
 * received.jsonl PEs other devices / the relay sealed to this agent (mailbox) — not part
 * of this device's chain
 * legacy.jsonl this agent's pre-meter (v1) PEs the relay handed back when it stopped
 * storing PEs (PE meter, 2026-10-03), filed verbatim
 * state.json a batching halt (a relay chain this device cannot continue) and one-time
 * notices
 * archived.jsonl days dropped after the paid PE Archive confirmed them
 * archive.json the Archive keeper's last status (for `doctor` / `pes status`)
 * received-proofs.jsonl the anchoring record of each batch a received PE came in (fetched
 * daily from `POST /v1/meter/batch-proofs` once the batch is anchored, and
 * KEPT: the relay drops a batch record 30 days after settlement, anchoring and delivery complete). A PE export
 * builds each received PE's inclusion proof from it.
 *
 * THE ONE EXCEPTION TO "NEVER DELETED" : with the paid PE Archive
 * on, once a day's PEs are confirmed in the Archive with their proofs (and this device has read the
 * day back and verified every PE in it), that day's PEs are replaced in pes.jsonl by one-line
 * pointers (`{"i", "at", "a" {day, wallet, pe_id, pe_hash, prev_hash}}`) — the chain stays
 * continuous and the device knows which day to pull — keeping the most recent 30 days in full.
 * `dropArchivedDay` is the ONLY path that removes a PE's content; nothing else rewrites a PE line.
 *
 * CRASH SAFETY. A PE line is written in one `write` and fsynced before `append` returns; the
 * head, idempotency index and batch cursor are atomically replaced (temp → fsync → rename → dir
 * fsync). A line without its trailing newline is an append that never returned, and is the only
 * thing ever truncated. A complete line that does not continue the chain is corruption: the store
 * refuses to append (loudly) rather than guess.
 *
 * Operators may supply their own `PeStore` (`ProvianClientConfig.peStore`) — e.g. a database —
 * or relocate this one (`PROVIAN_PE_STORE_DIR`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { atomicReplacePrivateFile } from '../durable-private-file';
import { withFileLockSync } from './file-lock';
import {
  METER_GENESIS_PREV_HASH,
  PE_V2_SCHEMA,
  peHashOf,
  batchLeafOf,
  type PeBatch,
  type PeV2,
  type SealedCopy,
} from '../meter-wire';

export const PE_STORE_DIR_ENV = 'PROVIAN_PE_STORE_DIR';

/** The root under which each device keeps its own directory. */
export function defaultPeStoreRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const fromEnv = env[PE_STORE_DIR_ENV];
  return fromEnv && fromEnv.trim().length > 0 ? path.resolve(fromEnv.trim()) : path.join(home, '.provian', 'pe-store');
}

/** A device id as a single safe path segment. */
export function deviceDirName(deviceId: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(deviceId) || deviceId === '.' || deviceId === '..') {
    throw new Error('pe_store_device_id_invalid');
  }
  return deviceId.replace(/:/g, '_');
}

// ─── records ────────────────────────────────────────────────────────────────────

/** A PE as this device keeps it: complete, with its own hash. */
export type StoredPeV2 = PeV2 & { readonly pe_hash: string };

export interface StoredPe {
  /** 0-based position in this device's chain. */
  readonly index: number;
  readonly pe: StoredPeV2;
  readonly recorded_at_ms: number;
  readonly idempotency_key?: string;
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
  readonly transit_receipt?: string;
  readonly transit_recipients?: Readonly<Record<string, string>>;
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
  readonly transit_pending?: boolean;
  readonly transit_receipt?: string;
  readonly transit_recipients?: Readonly<Record<string, string>>;
  /** Exact ciphertext retained locally for redelivery until the recipient acknowledges it. */
  readonly transit?: readonly SealedCopy[];
  readonly transit_parties?: Readonly<Record<string, string>>;
  readonly seq: number;
  readonly batch_hash: string;
  readonly prev_batch_hash: string;
  /** null when the position was adopted from the relay's tip (see `adopted`). */
  readonly acts_root: string | null;
  readonly first_index: number;
  readonly count: number;
  /** pe_hash of the last PE this batch carried — what the next batch's first act links to. */
  readonly last_pe_hash: string;
  readonly created_at_ms: number | null;
  readonly accepted_at_ms: number | null;
  readonly actor_id: string | null;
  readonly totals: MeterReceiptTotals | null;
  /**
   * True when the relay already held batches this store had no record of (a lost local write):
   * the store adopted the relay's tip because the relay's last PE is one of this device's own,
   * unchanged. Such a range may span several relay batches, so no per-batch receipt exists.
   */
  readonly adopted?: boolean;
}

/** The batch being sent. Re-sent byte for byte until the relay answers definitively. */
export interface InFlightBatch {
  readonly transit_parties?: Readonly<Record<string, string>>;
  readonly batch: PeBatch;
  readonly batch_hash: string;
  readonly first_index: number;
  readonly count: number;
  readonly last_pe_hash: string;
  readonly persisted_at_ms: number;
}

/** The relay's anchor proof for one batch leaf (keccak path to the day's on-chain root). */
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
  readonly anchored_at_ms: number;
}

export interface StoredBatchProof {
  readonly seq: number;
  readonly batch_hash: string;
  readonly batch_leaf: string;
  readonly acts_root: string;
  readonly actor_id: string;
  readonly anchor: MeterAnchorProofWire;
  readonly fetched_at_ms: number;
  /** The batch leaf recomputed from this device's own batch record matched the relay's. */
  readonly verified: boolean;
}

/** A PE another party sealed to this agent, opened and filed here. Not part of this chain. */
export interface ReceivedPe {
  readonly mailbox_id: string;
  readonly pe_id: string;
  readonly pe: PeV2;
  /** peHashOf(pe), recomputed here. */
  readonly pe_hash: string;
  /** The opened PE carried a `pe_hash` and it matched. False when it carried none. */
  readonly hash_checked: boolean;
  readonly from_device: string;
  readonly from_actor: string;
  readonly batch_hash: string;
  readonly created_at_ms: number;
  readonly received_at_ms: number;
}

/**
 * A pre-meter (v1) PE handed back through the mailbox when the relay stopped storing PEs. Filed
 * verbatim: its v1 hash recipe varied by the path that wrote it, so it is kept, not re-derived.
 */
export interface LegacyPe {
  readonly mailbox_id: string;
  readonly pe_id: string;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly received_at_ms: number;
}

/**
 * A PE whose content was dropped locally after its day was confirmed in the paid PE Archive
 * . Its chain position, id and hash stay; the PE itself is pulled from the Archive.
 */
export interface ArchivedPeStub {
  readonly index: number;
  readonly day: string;
  readonly wallet: string;
  readonly pe_id: string;
  readonly pe_hash: string;
  readonly prev_hash: string;
  readonly recorded_at_ms: number;
}

/**
 * The relay's anchoring record of a batch another device (or the relay) sealed PEs from to this
 * agent (`POST /v1/meter/batch-proofs`), kept once its day is anchored. `act_leaves` (every act's
 * leaf in batch order) is null for a batch accepted before the relay recorded them; the path is
 * then rebuilt from the received copies themselves.
 */
export interface ReceivedBatchProof {
  readonly batch_hash: string;
  readonly device_id: string;
  readonly actor_id: string;
  readonly seq: number;
  readonly acts_root: string;
  readonly batch_leaf: string;
  readonly day: string | null;
  readonly accepted_at_ms: number | null;
  readonly anchored: boolean;
  readonly chain_id: number;
  readonly anchor_contract: string | null;
  readonly anchor: MeterAnchorProofWire | null;
  readonly act_leaves: readonly string[] | null;
  readonly fetched_at_ms: number;
}

/**
 * One line of this device's chain file, as a PE export reads it: a PE held here, the pointer left
 * for a PE dropped after its day was archived, or a line the store cannot read (corruption, reported
 * — never skipped silently).
 */
export type PeChainRow =
  | { readonly kind: 'pe'; readonly index: number; readonly stored: StoredPe }
  | { readonly kind: 'pointer'; readonly index: number; readonly stub: ArchivedPeStub }
  | { readonly kind: 'unreadable'; readonly index: number; readonly detail: string };

/** One day this device dropped after the Archive confirmed it. */
export interface ArchivedDayRecord {
  readonly day: string;
  readonly wallet: string;
  readonly first_index: number;
  readonly last_index: number;
  readonly dropped: number;
  /** sha256 of each of this device's parts of the day, as the Archive confirmed them. */
  readonly part_sha256s: readonly string[];
  readonly dropped_at_ms: number;
}

/** What to drop: exactly these PEs (each checked against its hash before anything changes). */
export interface ArchiveDropPlan {
  readonly day: string;
  readonly wallet: string;
  readonly pes: readonly { readonly index: number; readonly pe_id: string; readonly pe_hash: string }[];
  readonly part_sha256s: readonly string[];
}

/** The Archive keeper's last known status, for `doctor` and `pes status`. */
export interface ArchiveLocalState {
  readonly on: boolean;
  readonly wallet: string | null;
  readonly paid_bytes: number;
  readonly used_bytes: number;
  /** The paid space is used up and the next GB is not paid: new days stay here. */
  readonly space_exhausted: boolean;
  readonly days_uploaded: number;
  readonly days_confirmed: number;
  readonly days_dropped: number;
  readonly last_run_at_ms: number;
  readonly last_error: string | null;
}

/** Batching stopped for this device: the relay's chain cannot be continued from this store. */
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

/** Where a device's PEs live. Every method may be backed by remote storage, hence async. */
export interface PeStore {
  readonly deviceId: string;
  /** Human-readable location (a path for the filesystem store). */
  readonly location: string;
  head(): Promise<StoreHead>;
  findByIdempotencyKey(key: string): Promise<StoredPe | null>;
  /**
   * Append one PE. It must extend the current head (`prev_hash`), carry this store's device id
   * and its own correct `pe_hash`. A known idempotency key answers with the PE already recorded.
   */
  append(pe: StoredPeV2, options?: { readonly idempotencyKey?: string; readonly recordedAtMs?: number }): Promise<AppendResult>;
  /** PEs in chain order starting at `fromIndex`. */
  readPes(fromIndex: number, limit: number): Promise<StoredPe[]>;
  findPe(peId: string): Promise<StoredPe | null>;
  lastBatch(): Promise<AcceptedBatch | null>;
  listBatches(): Promise<AcceptedBatch[]>;
  recordBatch(batch: AcceptedBatch, receipt: MeterBatchReceiptWire | null): Promise<void>;
  transitAcknowledged?(): Promise<ReadonlySet<string>>;
  acknowledgeTransit?(batchHash: string): Promise<void>;
  transitCursor?(): Promise<string | null>;
  setTransitCursor?(batchHash: string): Promise<void>;
  readReceipt(seq: number): Promise<MeterBatchReceiptWire | null>;
  inFlight(): Promise<InFlightBatch | null>;
  setInFlight(batch: InFlightBatch | null): Promise<void>;
  listProofs(): Promise<StoredBatchProof[]>;
  recordProof(proof: StoredBatchProof): Promise<void>;
  listReceived(): Promise<ReceivedPe[]>;
  /** False when this mailbox item was already filed. */
  recordReceived(item: ReceivedPe): Promise<boolean>;
  listLegacy(): Promise<LegacyPe[]>;
  /** False when this PE (by mailbox item or pe id) was already filed. */
  recordLegacy(item: LegacyPe): Promise<boolean>;
  halt(): Promise<MeterHalt | null>;
  setHalt(halt: MeterHalt | null): Promise<void>;
  flag(name: string): Promise<boolean>;
  setFlag(name: string): Promise<void>;
  // ── paid PE Archive . Optional: a store without them never drops a PE. ──
  /** The pointer left for a PE dropped after its day was confirmed in the Archive. */
  findArchived?(peId: string): Promise<ArchivedPeStub | null>;
  listArchivedDays?(): Promise<ArchivedDayRecord[]>;
  /**
   * THE ONLY LIFECYCLE THAT REMOVES A PE'S CONTENT : replace exactly the planned
   * PEs with pointers, after checking each against its planned hash (any mismatch changes nothing).
   * The caller has verified the day is confirmed in the Archive and read it back.
   */
  dropArchivedDay?(plan: ArchiveDropPlan): Promise<{ readonly dropped: number }>;
  archiveState?(): Promise<ArchiveLocalState | null>;
  setArchiveState?(state: ArchiveLocalState): Promise<void>;
  // ── PE export. Optional: a store without them exports what the required methods expose. ──
  /** Every line of this device's chain in index order: PEs, archive pointers and unreadable lines. */
  listChainRows?(): Promise<PeChainRow[]>;
  /** The anchoring records kept for batches received PEs came in. */
  listReceivedProofs?(): Promise<ReceivedBatchProof[]>;
  /** Keep one (anchored) batch record. False when one is already kept for this batch hash. */
  recordReceivedProof?(proof: ReceivedBatchProof): Promise<boolean>;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** The checks every store runs before a PE joins the chain. Null when it may. */
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

export function archivedDayRecordOf(plan: ArchiveDropPlan, nowMs: number): ArchivedDayRecord {
  const indices = plan.pes.map((p) => p.index);
  return {
    day: plan.day,
    wallet: plan.wallet,
    first_index: indices.length > 0 ? Math.min(...indices) : -1,
    last_index: indices.length > 0 ? Math.max(...indices) : -1,
    dropped: plan.pes.length,
    part_sha256s: [...plan.part_sha256s],
    dropped_at_ms: nowMs,
  };
}

// ─── in-memory store (tests, and embedders that keep PEs elsewhere) ───────────────

function revalidateStoredProofs(deviceId: string, proofs: StoredBatchProof[], batches: readonly AcceptedBatch[]): StoredBatchProof[] {
  return proofs.map(proof => {
    if (proof.verified) return proof;
    const batch = batches.find(b => b.seq === proof.seq && b.batch_hash === proof.batch_hash
      && !b.adopted && b.acts_root === proof.acts_root && b.actor_id === proof.actor_id);
    if (!batch) return proof;
    const leaf = batchLeafOf({ device_id: deviceId, actor_id: proof.actor_id, seq: proof.seq,
      batch_hash: proof.batch_hash, acts_root: proof.acts_root });
    return leaf === proof.batch_leaf ? { ...proof, verified: true } : proof;
  });
}

/**
 * A store held in memory. NOT durable: PEs are lost with the process. For tests and for an
 * embedder whose own `peMirror` is the durable copy.
 */
export class MemoryPeStore implements PeStore {
  readonly location: string;
  private readonly pes: StoredPe[] = [];
  /** index → pointer, for PEs dropped after the Archive confirmed their day. */
  private readonly stubs = new Map<number, ArchivedPeStub>();
  private readonly archivedDays: ArchivedDayRecord[] = [];
  private archiveStateValue: ArchiveLocalState | null = null;
  private readonly idem = new Map<string, number>();
  private readonly batches: { batch: AcceptedBatch; receipt: MeterBatchReceiptWire | null }[] = [];
  private inflight: InFlightBatch | null = null;
  private readonly proofs: StoredBatchProof[] = [];
  private readonly received: ReceivedPe[] = [];
  private readonly legacy: LegacyPe[] = [];
  private readonly receivedProofs: ReceivedBatchProof[] = [];
  private haltState: MeterHalt | null = null;
  private readonly flags = new Set<string>();
  private readonly transitAcks = new Set<string>();
  private nextTransit: string | null = null;

  constructor(readonly deviceId: string, location = 'memory') {
    this.location = location;
  }

  async head(): Promise<StoreHead> {
    const last = this.pes[this.pes.length - 1];
    return { count: this.pes.length, last_pe_hash: last ? last.pe.pe_hash : METER_GENESIS_PREV_HASH };
  }

  async findByIdempotencyKey(key: string): Promise<StoredPe | null> {
    const i = this.idem.get(key);
    return i === undefined ? null : this.pes[i];
  }

  async append(pe: StoredPeV2, options: { idempotencyKey?: string; recordedAtMs?: number } = {}): Promise<AppendResult> {
    const key = options.idempotencyKey !== undefined && IDEMPOTENCY_KEY.test(options.idempotencyKey) ? options.idempotencyKey : undefined;
    if (key !== undefined) {
      const hit = this.idem.get(key);
      if (hit !== undefined) return { ok: true, stored: this.pes[hit], replay: true };
    }
    const head = await this.head();
    if (pe.prev_hash !== head.last_pe_hash) return { ok: false, reason: 'head_moved', head };
    const refusal = appendRefusal(head, this.deviceId, pe);
    if (refusal !== null) return { ok: false, reason: 'invalid', detail: refusal };
    const stored: StoredPe = {
      index: head.count,
      pe: structuredClone(pe),
      recorded_at_ms: options.recordedAtMs ?? Date.now(),
      ...(key !== undefined ? { idempotency_key: key } : {}),
    };
    this.pes.push(stored);
    if (key !== undefined) this.idem.set(key, stored.index);
    return { ok: true, stored, replay: false };
  }

  async readPes(fromIndex: number, limit: number): Promise<StoredPe[]> {
    return this.pes.slice(Math.max(0, fromIndex)).filter((p) => !this.stubs.has(p.index)).slice(0, Math.max(0, limit));
  }

  async findPe(peId: string): Promise<StoredPe | null> {
    return this.pes.find((p) => p.pe.pe_id === peId && !this.stubs.has(p.index)) ?? null;
  }

  async findArchived(peId: string): Promise<ArchivedPeStub | null> {
    for (const stub of this.stubs.values()) if (stub.pe_id === peId) return stub;
    return null;
  }

  async listArchivedDays(): Promise<ArchivedDayRecord[]> {
    return [...this.archivedDays];
  }

  async dropArchivedDay(plan: ArchiveDropPlan): Promise<{ dropped: number }> {
    for (const want of plan.pes) {
      const held = this.pes[want.index];
      if (held === undefined || held.pe.pe_id !== want.pe_id || held.pe.pe_hash !== want.pe_hash) {
        throw new Error(`pe_store_archive_drop_mismatch: PE ${want.index} is not ${want.pe_id}/${want.pe_hash}`);
      }
    }
    let dropped = 0;
    for (const want of plan.pes) {
      if (this.stubs.has(want.index)) continue;
      const held = this.pes[want.index];
      this.stubs.set(want.index, {
        index: want.index, day: plan.day, wallet: plan.wallet, pe_id: held.pe.pe_id, pe_hash: held.pe.pe_hash,
        prev_hash: held.pe.prev_hash, recorded_at_ms: held.recorded_at_ms,
      });
      dropped += 1;
    }
    if (!this.archivedDays.some((d) => d.day === plan.day && d.wallet === plan.wallet && d.first_index === Math.min(...plan.pes.map((x) => x.index)))) {
      this.archivedDays.push(archivedDayRecordOf(plan, Date.now()));
    }
    return { dropped };
  }

  async archiveState(): Promise<ArchiveLocalState | null> {
    return this.archiveStateValue;
  }

  async setArchiveState(state: ArchiveLocalState): Promise<void> {
    this.archiveStateValue = state;
  }

  async listChainRows(): Promise<PeChainRow[]> {
    return this.pes.map((p): PeChainRow => {
      const stub = this.stubs.get(p.index);
      return stub !== undefined ? { kind: 'pointer', index: p.index, stub } : { kind: 'pe', index: p.index, stored: p };
    });
  }

  async listReceivedProofs(): Promise<ReceivedBatchProof[]> {
    return [...this.receivedProofs];
  }

  async recordReceivedProof(proof: ReceivedBatchProof): Promise<boolean> {
    if (this.receivedProofs.some((p) => p.batch_hash === proof.batch_hash)) return false;
    this.receivedProofs.push(proof);
    return true;
  }

  async lastBatch(): Promise<AcceptedBatch | null> {
    return this.batches.length > 0 ? this.batches[this.batches.length - 1].batch : null;
  }

  async listBatches(): Promise<AcceptedBatch[]> {
    return this.batches.map((b) => b.batch);
  }
  async transitAcknowledged(): Promise<ReadonlySet<string>> { return new Set(this.transitAcks); }
  async transitCursor(): Promise<string | null> { return this.nextTransit; }
  async setTransitCursor(hash: string): Promise<void> { this.nextTransit = hash; }
  async acknowledgeTransit(batchHash: string): Promise<void> {
    this.transitAcks.add(batchHash);
    for (const entry of this.batches) if (entry.batch.batch_hash === batchHash) {
      const { transit: _copy, ...rest } = entry.batch;
      entry.batch = rest;
    }
  }

  async recordBatch(batch: AcceptedBatch, receipt: MeterBatchReceiptWire | null): Promise<void> {
    this.batches.push({ batch, receipt });
  }

  async readReceipt(seq: number): Promise<MeterBatchReceiptWire | null> {
    return this.batches.find((b) => b.batch.seq === seq)?.receipt ?? null;
  }

  async inFlight(): Promise<InFlightBatch | null> {
    return this.inflight;
  }

  async setInFlight(batch: InFlightBatch | null): Promise<void> {
    this.inflight = batch;
  }

  async listProofs(): Promise<StoredBatchProof[]> {
    return revalidateStoredProofs(this.deviceId, this.proofs, await this.listBatches());
  }

  async recordProof(proof: StoredBatchProof): Promise<void> {
    this.proofs.push(proof);
  }

  async listReceived(): Promise<ReceivedPe[]> {
    return [...this.received];
  }

  async recordReceived(item: ReceivedPe): Promise<boolean> {
    if (this.received.some((r) => r.mailbox_id === item.mailbox_id)) return false;
    this.received.push(item);
    return true;
  }

  async listLegacy(): Promise<LegacyPe[]> {
    return [...this.legacy];
  }

  async recordLegacy(item: LegacyPe): Promise<boolean> {
    if (this.legacy.some((r) => r.mailbox_id === item.mailbox_id || r.pe_id === item.pe_id)) return false;
    this.legacy.push(item);
    return true;
  }

  async halt(): Promise<MeterHalt | null> {
    return this.haltState;
  }

  async setHalt(halt: MeterHalt | null): Promise<void> {
    this.haltState = halt;
  }

  async flag(name: string): Promise<boolean> {
    return this.flags.has(name);
  }

  async setFlag(name: string): Promise<void> {
    this.flags.add(name);
  }
}

// ─── filesystem store ───────────────────────────────────────────────────────────

interface HeadFile {
  readonly count: number;
  readonly last_pe_hash: string;
  /** Byte length of pes.jsonl covered by `count`. */
  readonly bytes: number;
}

interface PeLine {
  readonly i: number;
  readonly at: number;
  readonly k?: string;
  /** Absent on an archived pointer line. */
  readonly pe?: StoredPeV2;
  /** Present only on an archived pointer line : the PE itself is in the Archive. */
  readonly a?: { readonly day: string; readonly wallet: string; readonly pe_id: string; readonly pe_hash: string; readonly prev_hash: string };
}

interface IdemFile {
  readonly index: number;
  readonly pe_id: string;
  readonly offset: number;
}

interface StateFile {
  readonly halt: MeterHalt | null;
  readonly flags: readonly string[];
}

interface BatchHeadFile {
  readonly batch: AcceptedBatch;
  /** pes.jsonl byte offset of the first PE after this batch (store-private seek hint). */
  readonly next_offset: number | null;
}

/** A PE store corrupt in a way only a human should resolve. Appends stop; nothing is rewritten. */
export class PeStoreCorruptError extends Error {
  constructor(detail: string) {
    super(`pe_store_corrupt: ${detail}`);
    this.name = 'PeStoreCorruptError';
  }
}

const APPEND_LOCK_OPTIONS = { timeoutMs: 10_000, staleMs: 60_000, syncOnly: true } as const;
const READ_CHUNK = 1 << 20;
/** Keep a seek hint every this many PEs (bounded memory on a long chain). */
const OFFSET_CHECKPOINT_EVERY = 256;

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Append one line and fsync it before returning (the record is durable once this returns). */
function appendLineDurable(file: string, line: string): void {
  const existed = fs.existsSync(file);
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existed) {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }
}

/** Read the complete (newline-terminated) lines of a JSONL file, tolerating a torn final line. */
function readJsonlLines<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  const lines = text.split('\n');
  // The last element is '' after a final newline, or a torn line never acknowledged: skip it.
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].length === 0) continue;
    try { out.push(JSON.parse(lines[i]) as T); } catch { /* a corrupt sidecar line is skipped, never fatal */ }
  }
  return out;
}

/** Make a sidecar JSONL safe to append to: drop a torn final line (never a complete one). */
function healJsonlTail(file: string): void {
  const size = fileSize(file);
  if (size === 0) return;
  const fd = fs.openSync(file, 'r+');
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    // Find the last newline and truncate after it.
    let pos = size - 1;
    const buf = Buffer.alloc(4096);
    let cut = 0;
    while (pos > 0) {
      const start = Math.max(0, pos - buf.length);
      const n = fs.readSync(fd, buf, 0, pos - start, start);
      const idx = buf.subarray(0, n).lastIndexOf(0x0a);
      if (idx !== -1) { cut = start + idx + 1; break; }
      pos = start;
    }
    fs.ftruncateSync(fd, cut);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export class FsPeStore implements PeStore {
  readonly location: string;
  private readonly pesPath: string;
  private readonly headPath: string;
  private readonly idemDir: string;
  private readonly batchesPath: string;
  private readonly receiptsPath: string;
  private readonly batchHeadPath: string;
  private readonly inflightPath: string;
  private readonly proofsPath: string;
  private readonly receivedPath: string;
  private readonly legacyPath: string;
  private readonly archivedPath: string;
  private readonly archiveStatePath: string;
  private readonly receivedProofsPath: string;
  private readonly compactPath: string;
  /** Filed mailbox ids (received + legacy) and legacy pe ids, loaded once per process. */
  private filedIds: Set<string> | null = null;
  private readonly statePath: string;
  private readonly lockPath: string;
  /** index → byte offset seek hints (checkpoints + the latest read frontier). */
  private readonly offsets = new Map<number, number>();

  constructor(readonly deviceId: string, root: string = defaultPeStoreRoot()) {
    this.location = path.join(root, deviceDirName(deviceId));
    this.pesPath = path.join(this.location, 'pes.jsonl');
    this.headPath = path.join(this.location, 'head.json');
    this.idemDir = path.join(this.location, 'idem');
    this.batchesPath = path.join(this.location, 'batches.jsonl');
    this.receiptsPath = path.join(this.location, 'receipts.jsonl');
    this.batchHeadPath = path.join(this.location, 'batch-head.json');
    this.inflightPath = path.join(this.location, 'inflight.json');
    this.proofsPath = path.join(this.location, 'proofs.jsonl');
    this.receivedPath = path.join(this.location, 'received.jsonl');
    this.legacyPath = path.join(this.location, 'legacy.jsonl');
    this.archivedPath = path.join(this.location, 'archived.jsonl');
    this.archiveStatePath = path.join(this.location, 'archive.json');
    this.receivedProofsPath = path.join(this.location, 'received-proofs.jsonl');
    this.compactPath = path.join(this.location, 'pes.jsonl.compact');
    this.statePath = path.join(this.location, 'state.json');
    this.lockPath = path.join(this.location, 'append.lock');
  }

  /** The PE file itself (for status output). */
  get pesFile(): string {
    return this.pesPath;
  }

  private ensureDir(): void {
    fs.mkdirSync(this.location, { recursive: true, mode: 0o700 });
  }

  private noteOffset(index: number, offset: number): void {
    if (index % OFFSET_CHECKPOINT_EVERY === 0) this.offsets.set(index, offset);
  }

  /** Keep only checkpoints and the furthest frontier, so a long-lived daemon's hints stay small. */
  private trimOffsets(): void {
    let frontier = -1;
    for (const i of this.offsets.keys()) if (i > frontier) frontier = i;
    for (const i of [...this.offsets.keys()]) {
      if (i !== frontier && i % OFFSET_CHECKPOINT_EVERY !== 0) this.offsets.delete(i);
    }
  }

  /**
   * Visit complete PE lines from (index, offset) forward. `visit` returns false to stop. Lines
   * past the last newline (an append in progress in another process) are not visited. An archived
   * pointer line is skipped (its index still counts): only PEs this machine holds are visited.
   */
  private scan(startIndex: number, startOffset: number, visit: (stored: StoredPe, offset: number, nextOffset: number) => boolean): void {
    this.scanLines(startIndex, startOffset, (line, stored, offset, nextOffset) => (stored === null ? true : visit(stored, offset, nextOffset)));
  }

  /** Every complete line, live PE or archived pointer (`stored` null for a pointer). */
  private scanLines(
    startIndex: number,
    startOffset: number,
    visit: (line: PeLine, stored: StoredPe | null, offset: number, nextOffset: number, raw: string) => boolean,
  ): void {
    let fd: number;
    try {
      fd = fs.openSync(this.pesPath, 'r');
    } catch {
      return;
    }
    try {
      let offset = startOffset;
      let index = startIndex;
      let carry = Buffer.alloc(0);
      let carryStart = offset;
      const chunk = Buffer.alloc(READ_CHUNK);
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
        if (n === 0) return;
        offset += n;
        let data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : Buffer.from(chunk.subarray(0, n));
        let lineStart = 0;
        for (;;) {
          const nl = data.indexOf(0x0a, lineStart);
          if (nl === -1) break;
          const lineOffset = carryStart + lineStart;
          const nextOffset = carryStart + nl + 1;
          const text = data.subarray(lineStart, nl).toString('utf8');
          lineStart = nl + 1;
          if (text.length === 0) continue;
          let line: PeLine;
          try {
            line = JSON.parse(text) as PeLine;
          } catch {
            throw new PeStoreCorruptError(`unparseable PE line at byte ${lineOffset} of ${this.pesPath}`);
          }
          if (line.i !== index) throw new PeStoreCorruptError(`PE line at byte ${lineOffset} has index ${line.i}, expected ${index}`);
          this.noteOffset(index, lineOffset);
          if (line.pe === undefined && line.a === undefined) throw new PeStoreCorruptError(`PE line at byte ${lineOffset} carries neither a PE nor an archive pointer`);
          const stored: StoredPe | null = line.pe === undefined ? null : {
            index: line.i,
            pe: line.pe,
            recorded_at_ms: line.at,
            ...(line.k !== undefined ? { idempotency_key: line.k } : {}),
          };
          index += 1;
          if (!visit(line, stored, lineOffset, nextOffset, text)) return;
        }
        carry = data.subarray(lineStart);
        carryStart += lineStart;
        data = Buffer.alloc(0);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * The head, reconciled with the PE file (under the append lock). A crash after a PE line was
   * fsynced but before head.json was replaced leaves the file longer than the head says: the
   * extra complete lines are verified to continue the chain and adopted (and their idempotency
   * entries restored). A torn final line is truncated — it is an append that never returned.
   */
  private reconcileHeadLocked(): HeadFile {
    try {
      return this.reconcileHeadStrictLocked();
    } catch (err) {
      if (!(err instanceof PeStoreCorruptError)) throw err;
      const repaired = this.quarantineForkLocked();
      if (repaired === null) throw err;
      return repaired;
    }
  }

  /**
   * lines past the longest valid chain are a FORK (two appends that each saw the same head),
   * never a PE that can join the chain. Move them, byte for byte, to `quarantine-<ms>.jsonl` beside
   * the store and cut the PE file back to the chain, so the device keeps recording. Nothing is
   * deleted and nothing before the cut is touched. Refused (the store stays stopped for a human)
   * when the cut would drop a PE the head already counts or one a batch already sent, or when
   * there is nothing past the valid chain (a gap or a short file is not a fork).
   */
  private quarantineForkLocked(): HeadFile | null {
    let count = 0;
    let last = METER_GENESIS_PREV_HASH;
    let bytes = 0;
    try {
      this.scanLines(0, 0, (line, stored, _offset, nextOffset) => {
        if (stored !== null) {
          if (appendRefusal({ count, last_pe_hash: last }, this.deviceId, stored.pe) !== null) return false;
          last = stored.pe.pe_hash;
        } else {
          if (line.a === undefined || line.a.prev_hash !== last) return false;
          last = line.a.pe_hash;
        }
        count += 1;
        bytes = nextOffset;
        return true;
      });
    } catch (err) {
      if (!(err instanceof PeStoreCorruptError)) throw err; // the first line that breaks the chain ends the prefix
    }
    const size = fileSize(this.pesPath);
    if (bytes >= size) return null;
    const recorded = readJsonFile<HeadFile>(this.headPath);
    if (recorded !== null && count < recorded.count) return null;
    const sent = readJsonFile<BatchHeadFile>(this.batchHeadPath)?.batch ?? null;
    if (sent !== null && count < sent.first_index + sent.count) return null;
    const fd = fs.openSync(this.pesPath, 'r');
    let tail: Buffer;
    try {
      tail = Buffer.alloc(size - bytes);
      fs.readSync(fd, tail, 0, tail.length, bytes);
    } finally {
      fs.closeSync(fd);
    }
    const quarantine = path.join(this.location, `quarantine-${Date.now()}.jsonl`);
    const qfd = fs.openSync(quarantine, 'wx', 0o600);
    try { fs.writeSync(qfd, tail); fs.fsyncSync(qfd); } finally { fs.closeSync(qfd); }
    // ORDER: quarantine copy (fsynced) → the head names the valid chain → the cut. A crash after the
    // head leaves the fork past it, which the next reconcile quarantines again (never a head that
    // names the quarantined PE over a file that holds the other one).
    const head: HeadFile = { count, last_pe_hash: last, bytes };
    atomicReplacePrivateFile(this.headPath, JSON.stringify(head));
    const pfd = fs.openSync(this.pesPath, 'r+');
    try { fs.ftruncateSync(pfd, bytes); fs.fsyncSync(pfd); } finally { fs.closeSync(pfd); }
    this.offsets.clear();
    process.stderr.write(`[Provian] pe store: ${tail.length} bytes past the chain (a fork) moved to ${quarantine}; the chain continues at PE ${count}\n`);
    return head;
  }

  private reconcileHeadStrictLocked(): HeadFile {
    this.finishCompactionLocked();
    const recorded = readJsonFile<HeadFile>(this.headPath);
    let head: HeadFile = recorded ?? { count: 0, last_pe_hash: METER_GENESIS_PREV_HASH, bytes: 0 };
    let size = fileSize(this.pesPath);
    if (size === head.bytes) return head;
    if (size < head.bytes) {
      throw new PeStoreCorruptError(`${this.pesPath} is ${size} bytes but its head records ${head.bytes}; PEs are missing`);
    }
    // Drop a torn final line first (no trailing newline): never acknowledged to any caller.
    healJsonlTail(this.pesPath);
    size = fileSize(this.pesPath);
    if (size < head.bytes) {
      throw new PeStoreCorruptError(`${this.pesPath} lost acknowledged bytes while healing a torn line`);
    }
    let count = head.count;
    let last = head.last_pe_hash;
    let bytes = head.bytes;
    this.scan(head.count, head.bytes, (stored, offset, nextOffset) => {
      const refusal = appendRefusal({ count, last_pe_hash: last }, this.deviceId, stored.pe);
      if (refusal !== null) throw new PeStoreCorruptError(`PE ${stored.index} does not continue the chain (${refusal})`);
      if (stored.idempotency_key !== undefined) {
        this.writeIdem(stored.idempotency_key, { index: stored.index, pe_id: stored.pe.pe_id, offset });
      }
      count += 1;
      last = stored.pe.pe_hash;
      bytes = nextOffset;
      return true;
    });
    head = { count, last_pe_hash: last, bytes };
    atomicReplacePrivateFile(this.headPath, JSON.stringify(head));
    return head;
  }

  private writeIdem(key: string, entry: IdemFile): void {
    fs.mkdirSync(this.idemDir, { recursive: true, mode: 0o700 });
    atomicReplacePrivateFile(path.join(this.idemDir, `${key}.json`), JSON.stringify(entry));
  }

  private readIdem(key: string): IdemFile | null {
    if (!IDEMPOTENCY_KEY.test(key)) return null;
    return readJsonFile<IdemFile>(path.join(this.idemDir, `${key}.json`));
  }

  /** The stored PE at a known index (seeks via the hint map). */
  private readOne(index: number): StoredPe | null {
    const found = this.readRange(index, 1);
    return found.length === 1 ? found[0] : null;
  }

  private readRange(fromIndex: number, limit: number): StoredPe[] {
    if (limit <= 0) return [];
    let startIndex = 0;
    let startOffset = 0;
    for (const [i, off] of this.offsets) {
      if (i <= fromIndex && i >= startIndex) { startIndex = i; startOffset = off; }
    }
    const hint = readJsonFile<BatchHeadFile>(this.batchHeadPath);
    if (hint && hint.next_offset !== null) {
      const hintIndex = hint.batch.first_index + hint.batch.count;
      if (hintIndex <= fromIndex && hintIndex > startIndex) { startIndex = hintIndex; startOffset = hint.next_offset; }
    }
    const out: StoredPe[] = [];
    try {
      this.scan(startIndex, startOffset, (stored, offset, nextOffset) => {
        if (stored.index < fromIndex) return true;
        out.push(stored);
        this.offsets.set(stored.index + 1, nextOffset);
        if (out.length === 1) this.offsets.set(stored.index, offset);
        return out.length < limit;
      });
    } catch (err) {
      // A stale seek hint (it pointed mid-file at a different line): rescan from the start once.
      if (err instanceof PeStoreCorruptError && startOffset !== 0) {
        this.offsets.clear();
        const retry: StoredPe[] = [];
        this.scan(0, 0, (stored) => {
          if (stored.index < fromIndex) return true;
          retry.push(stored);
          return retry.length < limit;
        });
        return retry;
      }
      throw err;
    }
    this.trimOffsets();
    return out;
  }

  async head(): Promise<StoreHead> {
    const recorded = readJsonFile<HeadFile>(this.headPath);
    const size = fileSize(this.pesPath);
    if (recorded !== null && size === recorded.bytes && !fs.existsSync(this.compactPath)) {
      return { count: recorded.count, last_pe_hash: recorded.last_pe_hash };
    }
    if (recorded === null && size === 0) return { count: 0, last_pe_hash: METER_GENESIS_PREV_HASH };
    // The file moved past the head (another process mid-append, or a crash): reconcile under the lock.
    this.ensureDir();
    const head = withFileLockSync(this.lockPath, APPEND_LOCK_OPTIONS, () => this.reconcileHeadLocked());
    return { count: head.count, last_pe_hash: head.last_pe_hash };
  }

  async findByIdempotencyKey(key: string): Promise<StoredPe | null> {
    const hit = this.readIdem(key);
    if (hit === null) return null;
    const stored = this.readOne(hit.index);
    return stored !== null && stored.index === hit.index && stored.pe.pe_id === hit.pe_id ? stored : null;
  }

  async append(pe: StoredPeV2, options: { idempotencyKey?: string; recordedAtMs?: number } = {}): Promise<AppendResult> {
    const key = options.idempotencyKey !== undefined && IDEMPOTENCY_KEY.test(options.idempotencyKey) ? options.idempotencyKey : undefined;
    this.ensureDir();
    return withFileLockSync(this.lockPath, APPEND_LOCK_OPTIONS, (): AppendResult => {
      const head = this.reconcileHeadLocked();
      if (key !== undefined) {
        const hit = this.readIdem(key);
        if (hit !== null) {
          const stored = this.readOne(hit.index);
          if (stored !== null && stored.pe.pe_id === hit.pe_id) return { ok: true, stored, replay: true };
        }
      }
      if (pe.prev_hash !== head.last_pe_hash) {
        return { ok: false, reason: 'head_moved', head: { count: head.count, last_pe_hash: head.last_pe_hash } };
      }
      const refusal = appendRefusal(head, this.deviceId, pe);
      if (refusal !== null) return { ok: false, reason: 'invalid', detail: refusal };
      const recordedAt = options.recordedAtMs ?? Date.now();
      const line: PeLine = { i: head.count, at: recordedAt, ...(key !== undefined ? { k: key } : {}), pe };
      const text = JSON.stringify(line) + '\n';
      // ORDER: the PE (fsynced) → its idempotency entry → the head. A crash between any two is
      // repaired by the next reconcile, which re-derives both from the PE file.
      appendLineDurable(this.pesPath, text);
      const nextBytes = head.bytes + Buffer.byteLength(text, 'utf8');
      if (key !== undefined) this.writeIdem(key, { index: head.count, pe_id: pe.pe_id, offset: head.bytes });
      atomicReplacePrivateFile(this.headPath, JSON.stringify({ count: head.count + 1, last_pe_hash: pe.pe_hash, bytes: nextBytes }));
      this.noteOffset(head.count, head.bytes);
      this.offsets.set(head.count + 1, nextBytes);
      this.trimOffsets();
      const stored: StoredPe = { index: head.count, pe, recorded_at_ms: recordedAt, ...(key !== undefined ? { idempotency_key: key } : {}) };
      return { ok: true, stored, replay: false };
    });
  }

  async readPes(fromIndex: number, limit: number): Promise<StoredPe[]> {
    const head = await this.head();
    const bounded = Math.min(Math.max(0, limit), Math.max(0, head.count - fromIndex));
    return this.readRange(Math.max(0, fromIndex), bounded);
  }

  async findPe(peId: string): Promise<StoredPe | null> {
    let found: StoredPe | null = null;
    this.scan(0, 0, (stored) => {
      if (stored.pe.pe_id === peId) { found = stored; return false; }
      return true;
    });
    return found;
  }

  async lastBatch(): Promise<AcceptedBatch | null> {
    return readJsonFile<BatchHeadFile>(this.batchHeadPath)?.batch ?? null;
  }

  async listBatches(): Promise<AcceptedBatch[]> {
    const acked = await this.transitAcknowledged();
    return readJsonlLines<AcceptedBatch>(this.batchesPath).map(batch => {
      if (!batch.transit_pending || acked.has(batch.batch_hash)) return batch;
      const transit = readJsonFile<Pick<AcceptedBatch, 'transit' | 'transit_parties'>>(this.transitPath(batch.batch_hash));
      if (!transit) throw new PeStoreCorruptError('transit outbox missing or unreadable');
      return { ...batch, ...transit };
    });
  }
  private transitPath(batchHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(batchHash)) throw new Error('transit_batch_hash_invalid');
    return path.join(this.location, 'transit', batchHash + '.json');
  }
  async transitCursor(): Promise<string | null> {
    const file = path.join(this.location, 'transit-cursor.json');
    if (!fs.existsSync(file)) return null;
    const cursor = readJsonFile<{ next: string }>(file);
    if (!cursor || !/^[a-f0-9]{64}$/.test(cursor.next)) throw new PeStoreCorruptError('transit cursor invalid');
    return cursor.next;
  }
  async setTransitCursor(hash: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('transit_batch_hash_invalid');
    this.ensureDir();
    atomicReplacePrivateFile(path.join(this.location, 'transit-cursor.json'), JSON.stringify({ next: hash }));
  }
  async transitAcknowledged(): Promise<ReadonlySet<string>> {
    return new Set(readJsonlLines<string>(this.batchesPath + '.transit-acks'));
  }
  async acknowledgeTransit(batchHash: string): Promise<void> {
    this.ensureDir();
    const file = this.batchesPath + '.transit-acks';
    healJsonlTail(file);
    appendLineDurable(file, JSON.stringify(batchHash) + '\n');
    const copy = this.transitPath(batchHash);
    try { fs.unlinkSync(copy); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (fs.existsSync(path.dirname(copy))) {
      const dir = fs.openSync(path.dirname(copy), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  }

  async recordBatch(batch: AcceptedBatch, receipt: MeterBatchReceiptWire | null): Promise<void> {
    this.ensureDir();
    const { transit, transit_parties, ...metadata } = batch;
    if (transit?.length) atomicReplacePrivateFile(this.transitPath(batch.batch_hash), JSON.stringify({ transit, transit_parties }));
    const stored = { ...metadata, ...(transit?.length ? { transit_pending: true } : {}) };
    if (receipt !== null) {
      healJsonlTail(this.receiptsPath);
      appendLineDurable(this.receiptsPath, JSON.stringify(receipt) + '\n');
    }
    healJsonlTail(this.batchesPath);
    appendLineDurable(this.batchesPath, JSON.stringify(stored) + '\n');
    const nextIndex = batch.first_index + batch.count;
    const nextOffset = this.offsets.get(nextIndex) ?? null;
    atomicReplacePrivateFile(this.batchHeadPath, JSON.stringify({ batch: stored, next_offset: nextOffset } satisfies BatchHeadFile));
  }

  async readReceipt(seq: number): Promise<MeterBatchReceiptWire | null> {
    const all = readJsonlLines<MeterBatchReceiptWire>(this.receiptsPath);
    for (let i = all.length - 1; i >= 0; i--) if (all[i].seq === seq) return all[i];
    return null;
  }

  async inFlight(): Promise<InFlightBatch | null> {
    return readJsonFile<InFlightBatch>(this.inflightPath);
  }

  async setInFlight(batch: InFlightBatch | null): Promise<void> {
    if (batch === null) {
      try { fs.unlinkSync(this.inflightPath); } catch { /* already gone */ }
      return;
    }
    this.ensureDir();
    atomicReplacePrivateFile(this.inflightPath, JSON.stringify(batch));
  }

  async listProofs(): Promise<StoredBatchProof[]> {
    return revalidateStoredProofs(this.deviceId, readJsonlLines<StoredBatchProof>(this.proofsPath), await this.listBatches());
  }

  async recordProof(proof: StoredBatchProof): Promise<void> {
    this.ensureDir();
    healJsonlTail(this.proofsPath);
    appendLineDurable(this.proofsPath, JSON.stringify(proof) + '\n');
  }

  async listReceived(): Promise<ReceivedPe[]> {
    return readJsonlLines<ReceivedPe>(this.receivedPath);
  }

  async recordReceived(item: ReceivedPe): Promise<boolean> {
    this.ensureDir();
    const filed = await this.filed();
    if (filed.has(`mb:${item.mailbox_id}`)) return false;
    healJsonlTail(this.receivedPath);
    appendLineDurable(this.receivedPath, JSON.stringify(item) + '\n');
    filed.add(`mb:${item.mailbox_id}`);
    return true;
  }

  async listLegacy(): Promise<LegacyPe[]> {
    return readJsonlLines<LegacyPe>(this.legacyPath);
  }

  async recordLegacy(item: LegacyPe): Promise<boolean> {
    this.ensureDir();
    const filed = await this.filed();
    if (filed.has(`mb:${item.mailbox_id}`) || filed.has(`legacy:${item.pe_id}`)) return false;
    healJsonlTail(this.legacyPath);
    appendLineDurable(this.legacyPath, JSON.stringify(item) + '\n');
    filed.add(`mb:${item.mailbox_id}`);
    filed.add(`legacy:${item.pe_id}`);
    return true;
  }

  /** One read of the received/legacy files per process, not one per filed item. */
  private async filed(): Promise<Set<string>> {
    if (this.filedIds === null) {
      const ids = new Set<string>();
      for (const r of await this.listReceived()) ids.add(`mb:${r.mailbox_id}`);
      for (const r of await this.listLegacy()) {
        ids.add(`mb:${r.mailbox_id}`);
        ids.add(`legacy:${r.pe_id}`);
      }
      this.filedIds = ids;
    }
    return this.filedIds;
  }

  // ─── paid PE Archive ──────────────────────────────────────────

  /**
   * A compaction interrupted by a crash (under the append lock): `pes.jsonl.compact` beside the
   * head. If the head already names the compacted size, the rename is finished; otherwise the
   * compaction never committed and the temp file is discarded (pes.jsonl is untouched).
   */
  private finishCompactionLocked(): void {
    if (!fs.existsSync(this.compactPath)) return;
    const recorded = readJsonFile<HeadFile>(this.headPath);
    if (recorded !== null && fileSize(this.compactPath) === recorded.bytes && fileSize(this.pesPath) !== recorded.bytes) {
      fs.renameSync(this.compactPath, this.pesPath);
      const dirFd = fs.openSync(this.location, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } else {
      fs.unlinkSync(this.compactPath);
    }
    this.offsets.clear();
  }

  async findArchived(peId: string): Promise<ArchivedPeStub | null> {
    let found: ArchivedPeStub | null = null;
    this.scanLines(0, 0, (line) => {
      if (line.a !== undefined && line.a.pe_id === peId) {
        found = { index: line.i, recorded_at_ms: line.at, ...line.a };
        return false;
      }
      return true;
    });
    return found;
  }

  async listArchivedDays(): Promise<ArchivedDayRecord[]> {
    return readJsonlLines<ArchivedDayRecord>(this.archivedPath);
  }

  /**
   * Replace exactly the planned PEs with archive pointers. Under the append lock: every planned PE
   * is checked (index, id, hash) against the line it replaces — any mismatch throws and NOTHING
   * changes. The rewrite streams pes.jsonl into `pes.jsonl.compact` (fsynced), records the new
   * size in the head, then renames over pes.jsonl; a crash at any point is finished or discarded
   * by the next reconcile (`finishCompactionLocked`). The newest PEs are never planned (a day must
   * be 30+ days old), so the head never moves.
   */
  async dropArchivedDay(plan: ArchiveDropPlan): Promise<{ dropped: number }> {
    const want = new Map(plan.pes.map((p) => [p.index, p]));
    if (want.size !== plan.pes.length) throw new Error('pe_store_archive_drop_duplicate_index');
    this.ensureDir();
    return withFileLockSync(this.lockPath, APPEND_LOCK_OPTIONS, () => {
      const head = this.reconcileHeadLocked();
      // Pass 1: verify every planned PE against the line it would replace.
      let alreadyDropped = 0;
      const seen = new Set<number>();
      this.scanLines(0, 0, (line) => {
        const w = want.get(line.i);
        if (w === undefined) return true;
        seen.add(line.i);
        if (line.pe !== undefined) {
          if (line.pe.pe_id !== w.pe_id || line.pe.pe_hash !== w.pe_hash) {
            throw new Error(`pe_store_archive_drop_mismatch: PE ${line.i} is not ${w.pe_id}/${w.pe_hash}`);
          }
        } else if (line.a?.pe_hash !== w.pe_hash) {
          throw new Error(`pe_store_archive_drop_mismatch: pointer ${line.i} is not ${w.pe_hash}`);
        } else {
          alreadyDropped += 1;
        }
        return true;
      });
      if (seen.size !== want.size) throw new Error('pe_store_archive_drop_mismatch: a planned PE is not in this store');
      const toDrop = want.size - alreadyDropped;
      if (toDrop > 0) {
        // Pass 2: stream the rewrite.
        const out = fs.openSync(this.compactPath, 'w', 0o600);
        let written = 0;
        try {
          this.scanLines(0, 0, (line, _stored, _offset, _next, raw) => {
            let text: string;
            if (line.pe !== undefined && want.has(line.i)) {
              const stub: PeLine = {
                i: line.i,
                at: line.at,
                a: { day: plan.day, wallet: plan.wallet, pe_id: line.pe.pe_id, pe_hash: line.pe.pe_hash, prev_hash: line.pe.prev_hash },
              };
              text = JSON.stringify(stub) + '\n';
            } else {
              text = raw + '\n'; // every other line is kept byte for byte
            }
            fs.writeSync(out, text);
            written += Buffer.byteLength(text, 'utf8');
            return true;
          });
          fs.fsyncSync(out);
        } finally {
          fs.closeSync(out);
        }
        // Lines past the head (an append in another process) cannot exist: we hold the lock and
        // reconciled. The head's count and last hash are unchanged; only its byte length moves.
        atomicReplacePrivateFile(this.headPath, JSON.stringify({ count: head.count, last_pe_hash: head.last_pe_hash, bytes: written } satisfies HeadFile));
        fs.renameSync(this.compactPath, this.pesPath);
        const dirFd = fs.openSync(this.location, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        this.offsets.clear();
        const hint = readJsonFile<BatchHeadFile>(this.batchHeadPath);
        if (hint !== null && hint.next_offset !== null) {
          atomicReplacePrivateFile(this.batchHeadPath, JSON.stringify({ batch: hint.batch, next_offset: null } satisfies BatchHeadFile));
        }
      }
      const held = readJsonlLines<ArchivedDayRecord>(this.archivedPath);
      const record = archivedDayRecordOf(plan, Date.now());
      if (!held.some((d) => d.day === record.day && d.wallet === record.wallet && d.first_index === record.first_index)) {
        healJsonlTail(this.archivedPath);
        appendLineDurable(this.archivedPath, JSON.stringify(record) + '\n');
      }
      return { dropped: toDrop };
    });
  }

  async archiveState(): Promise<ArchiveLocalState | null> {
    return readJsonFile<ArchiveLocalState>(this.archiveStatePath);
  }

  // ─── PE export ───────────────────────────────────────────────────────────────

  /**
   * Every complete line of pes.jsonl in order, read tolerantly: a line that does not parse, or
   * carries neither a PE nor a pointer, or names the wrong index, is returned as `unreadable` at
   * the position it occupies (the export reports it; the chain checks then show what it broke).
   * Reads only — the append path's strict scan is unchanged.
   */
  async listChainRows(): Promise<PeChainRow[]> {
    let text: string;
    try {
      text = fs.readFileSync(this.pesPath, 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n');
    const rows: PeChainRow[] = [];
    // The last element is '' after a final newline, or an append in progress: never a row.
    for (let n = 0; n < lines.length - 1; n++) {
      if (lines[n].length === 0) continue;
      const index = rows.length;
      let line: PeLine;
      try {
        line = JSON.parse(lines[n]) as PeLine;
      } catch {
        rows.push({ kind: 'unreadable', index, detail: 'line is not JSON' });
        continue;
      }
      if (line === null || typeof line !== 'object' || line.i !== index) {
        rows.push({ kind: 'unreadable', index, detail: `line names index ${String((line as { i?: unknown } | null)?.i)}, expected ${index}` });
        continue;
      }
      if (line.pe !== undefined && line.pe !== null && typeof line.pe === 'object') {
        rows.push({ kind: 'pe', index, stored: { index, pe: line.pe, recorded_at_ms: line.at, ...(line.k !== undefined ? { idempotency_key: line.k } : {}) } });
      } else if (line.a !== undefined && line.a !== null && typeof line.a === 'object') {
        rows.push({ kind: 'pointer', index, stub: { index, recorded_at_ms: line.at, ...line.a } });
      } else {
        rows.push({ kind: 'unreadable', index, detail: 'line carries neither a PE nor an archive pointer' });
      }
    }
    return rows;
  }

  async listReceivedProofs(): Promise<ReceivedBatchProof[]> {
    return readJsonlLines<ReceivedBatchProof>(this.receivedProofsPath);
  }

  async recordReceivedProof(proof: ReceivedBatchProof): Promise<boolean> {
    this.ensureDir();
    if ((await this.listReceivedProofs()).some((p) => p.batch_hash === proof.batch_hash)) return false;
    healJsonlTail(this.receivedProofsPath);
    appendLineDurable(this.receivedProofsPath, JSON.stringify(proof) + '\n');
    return true;
  }

  async setArchiveState(state: ArchiveLocalState): Promise<void> {
    this.ensureDir();
    atomicReplacePrivateFile(this.archiveStatePath, JSON.stringify(state));
  }

  private readState(): StateFile {
    return readJsonFile<StateFile>(this.statePath) ?? { halt: null, flags: [] };
  }

  async halt(): Promise<MeterHalt | null> {
    return this.readState().halt;
  }

  async setHalt(halt: MeterHalt | null): Promise<void> {
    this.ensureDir();
    const state = this.readState();
    atomicReplacePrivateFile(this.statePath, JSON.stringify({ ...state, halt } satisfies StateFile));
  }

  async flag(name: string): Promise<boolean> {
    return this.readState().flags.includes(name);
  }

  async setFlag(name: string): Promise<void> {
    this.ensureDir();
    const state = this.readState();
    if (state.flags.includes(name)) return;
    atomicReplacePrivateFile(this.statePath, JSON.stringify({ ...state, flags: [...state.flags, name] } satisfies StateFile));
  }
}

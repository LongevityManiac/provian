import { singleScanQuery } from '../../provenance/private-store';
/**
 * settlement runtime — durable settlement state: claim ledger, cycle cursor, lease, nonce,
 * and batch reservations (Firestore materialization).
 *
 * This is the durable half the merged planning layer deliberately left
 * abstract: `claim-identity.ts` verifies against an injected
 * `ReadonlyMap<peId, RecordedClaim>`; this module is where that ledger
 * actually lives, plus the cycle state the plan's settlement runtime item 5 requires —
 * "durable cursor, cumulative counters that survive retry, single-worker
 * lease, safe nonce ownership, receipt/replacement reconciliation, and
 * same-cycle crash continuation".
 *
 * AUTHORITY BOUNDARY — nothing here mints or grants settlement authority.
 * These are settler-side bookkeeping records. The kernel remains the only
 * mint authority and is undeployed/unarmed; no code in this module signs,
 * submits, or opens a network connection. The cycle runner
 * (`settlement-cycle-runner.ts`) composes this store with an injected chain
 * adapter, and that runner is NOT mounted on any route or scheduler — activation
 * owns deployment, configuration, arming, and activation.
 *
 * Crash-consistency protocol (reservation-before-send, the same discipline as
 * the minting engine's snapshot and the daily anchor's batch doc):
 *
 * 1. `acquireCycleLease` transactional create-or-take-over of the cycle
 * doc. A live lease held by another worker refuses (single-worker).
 * 2. `reserveBatch` transactional: verifies lease + cursor continuity
 * (`batch.cursor_start === cycle.cursor_next`) + remaining transaction
 * budget, assigns the nonce from the cycle doc, creates the batch doc
 * in state 'reserved'. The nonce counter and the consumed-transaction
 * counter only ever increment — a retry NEVER resets them.
 * 3. `recordAttempt` transactional append of the SIGNED transaction
 * (hash known pre-broadcast) BEFORE the wire send, so a crash straight
 * after broadcast still leaves the attempt on record for receipt
 * reconciliation. Replacements record here too, bound to the SAME nonce
 * as the attempt they replace — that same-nonce rule is what makes two
 * live settlements for one reservation structurally impossible at the
 * chain layer (at most one transaction per nonce can ever be included);
 * the kernel's cursor discontinuity and `claimSettled` map are the
 * second and third nets. A NEW nonce for a batch is permitted only
 * after a MINED-FAILED receipt is recorded for the previous nonce (a
 * mined transaction has consumed its nonce and can never re-execute).
 * 4. `applyConfirmedBatch` transactional, exactly-once (guarded by the
 * batch doc's `applied` flag): advances the durable cursor to
 * `cursor_end`, adds the batch's actual fee and claim/recipient counts
 * to the cycle's cumulative counters, marks the batch 'confirmed'.
 * 5. `writeLedgerSettlement` chunked (non-transactional) writebacks of
 * `settled` onto each claim-ledger row, AFTER apply, repairable via
 * `repairLedgerWritebacks`. The batch doc is the authoritative settled
 * record; ledger `settled` is derived state, and the work source must
 * call the repair before selecting claims so a crash between apply and
 * writeback can never re-propose a settled PE.
 *
 * Firestore doc-size discipline: batch docs carry per-claim membership
 * (pe_id + claim_id), bounded by the runner's `maxClaims` per batch — the
 * same bounded-membership rule as the segmented anchor (never a 1 MB risk).
 */

import { isMeterClaimKey } from '../../meter/meter-claims';
import { settledLedgerRowExpiry, unsettledLedgerRowExpiry } from '../../meter/ledger-retention';
import { PAYEE_SETTLEMENT_CLOCK_COLLECTION } from './payee-settlement-interval';
import { PAYOUT_LEG_ROLES, isClaimKind, type ClaimKind, type PayoutLegRole } from '../wp-ev/payout-legs';
import { mutatePeHistoryRowWithAggregate } from '../policy/economic-aggregate';
import { corroborationLiftedRecordPointsAtomic } from '../policy/economic-projection';
import type { PEHistoryDocument } from '../../../pe-history';
import { PE_SPLIT_COLLECTION, parseFrozenSplit } from './pe-split';


/**
 * PE METER: merge settlement fields onto a legacy `pe_history` row ONLY while it still exists, in
 * one transaction. The legacy migration deletes rows transactionally; a read-then-write outside a
 * transaction could recreate a deleted row as a stub, which the relay no longer keeps. `fields`
 * sees the current row and may return null to write nothing. True when a write was staged.
 */
async function enrichLegacyRowIfPresent(
  db: SettlementDb,
  peId: string,
  fields: (row: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<boolean> {
  const ref = db.collection(PE_HISTORY_COLLECTION).doc(peId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return false;
    const data = fields((snap.data() ?? {}) as Record<string, unknown>);
    if (data === null) return false;
    txn.set(ref, data, { merge: true });
    return true;
  });
}

export const CLAIM_LEDGER_COLLECTION = 'pvt9_claim_ledger_v1';
export const BUG_DEMOTION_COLLECTION = 'pvt9_bug_demotions_v1';
export const SETTLEMENT_CYCLES_COLLECTION = 'pvt9_settlement_cycles_v1';
export const SETTLEMENT_BATCHES_COLLECTION = 'pvt9_settlement_batches_v1';
/**
 * one lease per settlement SIGNER. The kernel has one cursor and the minter has one
 * nonce sequence, so every settlement run on a signer is serial by construction; two runs on
 * two different cycle ids (a manual run at 23:59 and the 00:00 cron, the genesis and the
 * standard route, a scheduler retry, a second instance) would otherwise read the same base
 * nonce and collide. The cross-cycle reconciler runs under this lease too.
 */
export const SETTLEMENT_SIGNER_LEASES_COLLECTION = 'pvt9_settlement_signer_leases_v1';
/**
 * The mutable PE enrichment record (docs keyed by peId verbatim). The standard
 * inlet SELECTS from it (`mint_status == 'eligible'`), which makes it a claim
 * SOURCE: settlement must write the terminal state back or settled work stays
 * in the ready set forever. Single declaration — the inlet imports it.
 */
export const PE_HISTORY_COLLECTION = 'pe_history';

export const CLAIM_LEDGER_SCHEMA = 'pvt9-claim-ledger/v1';
export const SETTLEMENT_CYCLE_SCHEMA = 'pvt9-settlement-cycle/v1';
export const SETTLEMENT_BATCH_SCHEMA = 'pvt9-settlement-batch/v1';

/** Chunk size for non-transactional ledger writebacks (Firestore batch cap 500). */
export const LEDGER_WRITEBACK_CHUNK = 400;

const BYTES32 = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
/** Firestore-safe PE-id shape (also excludes '/' '.' '..' reserved forms). */
const PE_ID = /^[A-Za-z0-9_:-]{1,200}$/;
const ATOMIC = /^\d{1,78}$/;

// ---------------------------------------------------------------------------
// Narrow DB interface (satisfied by admin Firestore and the test fake alike)
// ---------------------------------------------------------------------------

export interface SettlementDocSnap {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface SettlementDocRef {
  get(): Promise<SettlementDocSnap>;
  set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void>;
  create(data: Record<string, unknown>): Promise<void>;
}

export interface SettlementTxn {
  get(ref: SettlementDocRef): Promise<SettlementDocSnap>;
  set(ref: SettlementDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): void;
  create(ref: SettlementDocRef, data: Record<string, unknown>): void;
}

export interface SettlementQuerySnap {
  docs: Array<{ id: string; data(): Record<string, unknown> | undefined }>;
}

export interface SettlementQuery {
  where(field: string, op: '==' | '>=' | '<=', value: unknown): SettlementQuery;
  orderBy(field: string, dir?: 'asc' | 'desc'): SettlementQuery;
  limit(n: number): SettlementQuery;
  startAfter(...values: unknown[]): SettlementQuery;
  get(): Promise<SettlementQuerySnap>;
}

export interface SettlementCollection extends SettlementQuery {
  doc(id: string): SettlementDocRef;
}

export interface SettlementWriteBatch {
  set(ref: SettlementDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): void;
  commit(): Promise<void>;
}

export interface SettlementDb {
  collection(name: string): SettlementCollection;
  batch(): SettlementWriteBatch;
  runTransaction<T>(fn: (txn: SettlementTxn) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Claim ledger
// ---------------------------------------------------------------------------

export type LedgerLane = 'standard' | 'genesis';

/** The durable materialization of the planning layer's `RecordedClaim`. */
export interface ClaimLedgerRow {
  readonly schema_version: typeof CLAIM_LEDGER_SCHEMA;
  readonly pe_id: string;
  /** normalizePeId(pe_id). NOT the document id — see `claim_key`. */
  readonly pe_key: string;
  /**
   * `${pe_key}#${leg}` — the document id AND the pagination sort key.
   *
   * An act with two payees has two ledger rows, so the PE alone can no longer key a row. Keying
   * on the CLAIM rather than the PE is what lets the agent leg and the beneficiary leg exist
   * side by side, settle independently, and be deduped independently — which mirrors the kernel,
   * where `claimSettled` is per claim item and not per PE.
   */
  readonly claim_key: string;
  /** Which payout leg of the act this row is. `sole` for a single-payee act. */
  readonly leg: PayoutLegRole;
  /**
   * which claim of the leg. ABSENT (= `act`) on every row written before
   * and on every act row since; `attestation_topup` on an additive top-up row, whose
   * `claim_key` carries a third `#attestation_topup` segment so it can sit beside the
   * act's row and be deduped independently, exactly as the two legs of one act do.
   */
  readonly claim_kind?: ClaimKind;
  /** Top-up only: the `claim_key` of the act row this top-up adds to. */
  readonly topup_of_claim_key?: string;
  /** Top-up only: the verified attestation tier the delta was computed against. */
  readonly topup_attestation_tier?: string;
  /** Top-up only: `pe_history.corroboration_received_at` at registration. */
  readonly topup_observed_at_ms?: number;
  readonly claim_id: string;
  readonly lane: LedgerLane;
  /** Lowercase EVM contributor address the claim settles to. */
  readonly contributor: string;
  /** Standard lane payload. */
  readonly beneficiary_class?: number;
  readonly record_points_atomic?: string;
  /** Genesis lane payload. */
  readonly genesis_anchor_key?: string;
  readonly wallet_id?: string;
  readonly one_time_anchor?: string;
  readonly grant_type?: number;
  readonly qualified_at?: number;
  readonly reserved_gross_atomic?: string;
  readonly settled: boolean;
  readonly settled_batch_id: string | null;
  readonly settled_tx_hash: string | null;
  readonly created_at: number;
  readonly settled_at: number | null;
  /** Operational coordination only; never part of a claim or settlement digest. */
  readonly reserved_batch_id?: string | null;
  /** Terminal pre-settlement removal proved by a checked-in bug detector. */
  readonly bug_demoted_at_ms?: number | null;
  readonly bug_demotion_id?: string | null;
  /**
   * a claim the runner ISOLATED as the cause of a refused or unsettleable batch. It
   * leaves the head of the queue until `retry_at_ms` so the rest of the backlog settles; it is
   * never dropped (the row stays `settled:false`) and it is retried on the backoff below.
   * Operational coordination only; never part of a claim or settlement digest.
   */
  readonly hold?: ClaimHold | null;
  /** flat mirror of `hold` having been set (queryable); cleared when settled. */
  readonly held?: boolean;
  /** `chain_evidence` when the row was settled from the kernel's own `claimSettled`. */
  readonly settled_via?: 'chain_evidence';
}

export interface ClaimHold {
  readonly reason: string;
  readonly detail: string;
  readonly held_at_ms: number;
  readonly retry_at_ms: number;
  /** How many times this claim has been held; drives the backoff. */
  readonly count: number;
}

export type NewClaimInput = Omit<
  ClaimLedgerRow,
  'schema_version' | 'pe_key' | 'claim_key' | 'settled' | 'settled_batch_id' | 'settled_tx_hash' | 'created_at' | 'settled_at'
>;

/** Normalization mirrors `claim-identity.ts` exactly. */
export function normalizePeId(peId: string): string {
  return peId.trim().toLowerCase();
}

/**
 * The ledger key for one payout leg of one PE — and, since, for one CLAIM of that leg.
 *
 * `#` is not a legal character in a PE id (`PE_ID` admits only `[A-Za-z0-9_:-]`), so the
 * separator cannot appear inside either part and the encoding is unambiguous — two different
 * (pe, leg) pairs can never fold onto one key. The `act` kind (the default, and the only
 * kind that existed before) adds NOTHING, so every existing key is byte-identical;
 * `attestation_topup` appends a third `#attestation_topup` segment, which no leg role can
 * spell (the role set is closed and contains no `#`).
 */
export function claimKeyOf(peId: string, leg: PayoutLegRole, kind: ClaimKind = 'act'): string {
  const base = `${normalizePeId(peId)}#${leg}`;
  return kind === 'act' ? base : `${base}#${kind}`;
}

function isSettleableHash(value: unknown): value is string {
  return typeof value === 'string' && BYTES32.test(value) && value.toLowerCase() !== ZERO_BYTES32;
}

export function validateNewClaim(input: NewClaimInput): string | null {
  if (typeof input.pe_id !== 'string' || !PE_ID.test(normalizePeId(input.pe_id))) {
    return 'invalid_pe_id';
  }
  // M9 round 2: `leg` is HALF THE DOCUMENT ID and was validated nowhere — not here, and not by
  // `assertNoLegacyLedgerRows` (a row with `leg: undefined` yields the non-empty `claim_key`
  // "pe#undefined" and passes cleanly). An unrecognized leg is then dropped by
  // `claim-identity.ts`'s record loop, silently disabling every drift check for that row.
  if (!PAYOUT_LEG_ROLES.includes(input.leg)) return 'invalid_leg';
  if (input.claim_kind !== undefined && !isClaimKind(input.claim_kind)) return 'invalid_claim_kind';
  if (!isSettleableHash(input.claim_id)) return 'invalid_claim_id';
  if (input.lane !== 'standard' && input.lane !== 'genesis') return 'invalid_lane';
  if (input.claim_kind === 'attestation_topup') {
    // a top-up is a STANDARD-lane claim that names the act row it adds to.
    if (input.lane !== 'standard') return 'topup_must_be_standard_lane';
    if (typeof input.topup_of_claim_key !== 'string'
      || input.topup_of_claim_key !== claimKeyOf(input.pe_id, input.leg)) {
      return 'invalid_topup_of_claim_key';
    }
    if (typeof input.topup_attestation_tier !== 'string' || input.topup_attestation_tier === '') {
      return 'invalid_topup_attestation_tier';
    }
    if (typeof input.topup_observed_at_ms !== 'number'
      || !Number.isSafeInteger(input.topup_observed_at_ms) || input.topup_observed_at_ms <= 0) {
      return 'invalid_topup_observed_at';
    }
  } else if (input.topup_of_claim_key !== undefined || input.topup_attestation_tier !== undefined
    || input.topup_observed_at_ms !== undefined) {
    return 'topup_fields_on_act_claim';
  }
  if (typeof input.contributor !== 'string' || !ADDRESS.test(input.contributor)
    || input.contributor !== input.contributor.toLowerCase()) {
    return 'invalid_contributor';
  }
  if (input.lane === 'standard') {
    if (input.genesis_anchor_key !== undefined || input.wallet_id !== undefined
      || input.one_time_anchor !== undefined || input.grant_type !== undefined
      || input.qualified_at !== undefined || input.reserved_gross_atomic !== undefined) {
      return 'genesis_fields_on_standard_claim';
    }
    if (typeof input.record_points_atomic !== 'string' || !ATOMIC.test(input.record_points_atomic)) {
      return 'invalid_record_points';
    }
    if (typeof input.beneficiary_class !== 'number'
      || ![0, 1, 2].includes(input.beneficiary_class)) {
      return 'invalid_beneficiary_class';
    }
  } else {
    if (input.record_points_atomic !== undefined || input.beneficiary_class !== undefined) {
      return 'standard_fields_on_genesis_claim';
    }
    if (!isSettleableHash(input.genesis_anchor_key)) return 'invalid_genesis_anchor_key';
    if (!isSettleableHash(input.wallet_id)) return 'invalid_wallet_id';
    if (!isSettleableHash(input.one_time_anchor)) return 'invalid_one_time_anchor';
    if (typeof input.grant_type !== 'number' || !Number.isInteger(input.grant_type)
      || input.grant_type < 0 || input.grant_type > 255) {
      return 'invalid_grant_type';
    }
    if (typeof input.qualified_at !== 'number' || !Number.isSafeInteger(input.qualified_at)
      || input.qualified_at < 0) {
      return 'invalid_qualified_at';
    }
    if (typeof input.reserved_gross_atomic !== 'string' || !ATOMIC.test(input.reserved_gross_atomic)) {
      return 'invalid_reserved_gross';
    }
  }
  return null;
}

export type RegisterClaimResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'already_registered_identical' }
  | { readonly kind: 'rejected'; readonly reason: string };

export function ledgerRowFromInput(input: NewClaimInput, nowMs: number): ClaimLedgerRow {
  const base = {
    schema_version: CLAIM_LEDGER_SCHEMA,
    pe_id: input.pe_id,
    pe_key: normalizePeId(input.pe_id),
    claim_key: claimKeyOf(input.pe_id, input.leg, input.claim_kind ?? 'act'),
    leg: input.leg,
    // the kind is written only for a top-up, so an act row's bytes are exactly
    // what they were before (no `claim_kind` field) — nothing existing changes.
    ...(input.claim_kind === 'attestation_topup'
      ? {
        claim_kind: 'attestation_topup' as const,
        topup_of_claim_key: input.topup_of_claim_key!,
        topup_attestation_tier: input.topup_attestation_tier!,
        topup_observed_at_ms: input.topup_observed_at_ms!,
      }
      : {}),
    claim_id: input.claim_id.toLowerCase(),
    lane: input.lane,
    contributor: input.contributor,
    settled: false,
    settled_batch_id: null,
    settled_tx_hash: null,
    created_at: nowMs,
    settled_at: null,
  } as const;
  if (input.lane === 'standard') {
    return {
      ...base,
      beneficiary_class: input.beneficiary_class,
      record_points_atomic: input.record_points_atomic,
    };
  }
  return {
    ...base,
    genesis_anchor_key: input.genesis_anchor_key!.toLowerCase(),
    wallet_id: input.wallet_id!.toLowerCase(),
    one_time_anchor: input.one_time_anchor!.toLowerCase(),
    grant_type: input.grant_type,
    qualified_at: input.qualified_at,
    reserved_gross_atomic: input.reserved_gross_atomic,
  };
}

/**
 * Register one claim, transactionally. Idempotent for an IDENTICAL identity
 * (same claim id + lane + anchor); any drift is rejected — never silently
 * overwritten, because claim-id stability is the anti-double-mint property.
 *
 * THE SETTLEMENT ELIGIBILITY RE-CHECK. When `opts.requirePeHistoryStatus`
 * is set, the SAME transaction ALSO reads this PE's `pe_history` enrichment row
 * and refuses to register unless its `mint_status` still equals the pinned value.
 * Both reads (ledger + pe_history) precede the create, so a concurrent
 * dual-witness takeover that DEMOTES `pe_history[pe_id].mint_status` between
 * selection and here forces this transaction to retry and observe the demotion.
 * That is the read/write conflict that serializes the two writers and makes
 * NEITHER arrival order double-mint: the takeover writes `pe_history[incumbent]`
 * and reads `CLAIM_LEDGER[incumbent]`, this registration reads `pe_history` and
 * writes `CLAIM_LEDGER` mutually conflicting sets, so Firestore serializes them
 * (takeover-first ⇒ this retries, sees the demoted status, refuses; registration-
 * first ⇒ the takeover retries, sees the row registered, and the new witness
 * becomes a duplicate).
 *
 * Keyed on the RAW `pe_id`, exactly as every `pe_history` writer keys it (the
 * takeover's demotion and the inlet source's read included) so the re-check and
 * the demotion touch the same document. (`pe_id` is a lowercase `pe_<uuid>` by
 * construction, so this is byte-identical to `normalizePeId(pe_id)` for every
 * real PE, and unlike it can never diverge from how pe_history is actually keyed.)
 */
export async function registerClaim(
  db: SettlementDb,
  input: NewClaimInput,
  nowMs: number,
  opts?: { requirePeHistoryStatus?: string | readonly string[] },
): Promise<RegisterClaimResult> {
  const invalid = validateNewClaim(input);
  if (invalid !== null) return { kind: 'rejected', reason: invalid };
  const kind: ClaimKind = input.claim_kind ?? 'act';
  const docId = claimKeyOf(input.pe_id, input.leg, kind);
  const ref = db.collection(CLAIM_LEDGER_COLLECTION).doc(docId);
  const peHistoryRef = opts?.requirePeHistoryStatus === undefined
    ? null
    : db.collection(PE_HISTORY_COLLECTION).doc(input.pe_id);
  const demotionRef = db.collection(BUG_DEMOTION_COLLECTION).doc(normalizePeId(input.pe_id));
  // a top-up is registered ONLY beside an existing act row for the same leg —
  // read in the SAME transaction, so a top-up can never be created for a leg whose act
  // was never registered (there would be nothing to add to), and the act row's
  // frozen `record_points_atomic` is what the delta was computed against.
  const originalRef = kind === 'attestation_topup'
    ? db.collection(CLAIM_LEDGER_COLLECTION).doc(input.topup_of_claim_key!)
    : null;
  const allowedStatuses: readonly string[] | null = opts?.requirePeHistoryStatus === undefined
    ? null
    : typeof opts.requirePeHistoryStatus === 'string'
      ? [opts.requirePeHistoryStatus]
      : opts.requirePeHistoryStatus;
  // a standard ACT leg of a PE whose split is FROZEN may be registered here only if it
  // IS one of the frozen legs, byte-for-byte. The inlet registers act legs through
  // `registerFrozenSplitClaims` (the whole set in one transaction); this read makes the
  // single-leg path unable to add a leg outside, or disagreeing with, a frozen split.
  const splitRef = input.lane === 'standard' && kind === 'act'
    ? db.collection(PE_SPLIT_COLLECTION).doc(normalizePeId(input.pe_id))
    : null;
  return db.runTransaction<RegisterClaimResult>(async (txn) => {
    const [snap, demotionSnap] = [await txn.get(ref), await txn.get(demotionRef)];
    const splitSnap = splitRef === null ? null : await txn.get(splitRef);
    if (demotionSnap.exists) return { kind: 'rejected', reason: 'pe_bug_demoted' };
    if (splitSnap !== null && splitSnap.exists) {
      const parsed = parseFrozenSplit(splitSnap.data(), normalizePeId(input.pe_id));
      if (parsed.kind !== 'valid') return { kind: 'rejected', reason: 'frozen_split_invalid' };
      const frozenLeg = parsed.split.legs.find((leg) => leg.leg === input.leg);
      if (frozenLeg === undefined || frozenLeg.claim_id !== input.claim_id.toLowerCase()
        || frozenLeg.contributor !== input.contributor
        || frozenLeg.record_points_atomic !== input.record_points_atomic
        || frozenLeg.beneficiary_class !== input.beneficiary_class) {
        return { kind: 'rejected', reason: 'outside_frozen_split' };
      }
    }
    if (peHistoryRef !== null) {
      const peSnap = await txn.get(peHistoryRef);
      const status = peSnap.exists ? (peSnap.data() ?? {}).mint_status : undefined;
      // A missing enrichment row reads `undefined`, which never equals a pinned
      // status — fail-closed, the correct direction for a PE that stopped being
      // settleable out from under selection.
      if (typeof status !== 'string' || !allowedStatuses!.includes(status)) {
        return { kind: 'rejected', reason: 'pe_history_not_settleable' };
      }
    }
    if (originalRef !== null) {
      const original = await txn.get(originalRef);
      const originalRow = original.exists ? (original.data() ?? {}) : null;
      if (originalRow === null || originalRow.lane !== 'standard'
        || originalRow.claim_kind === 'attestation_topup') {
        return { kind: 'rejected', reason: 'topup_original_claim_missing' };
      }
    }
    if (!snap.exists) {
      txn.create(ref, ledgerRowFromInput(input, nowMs) as unknown as Record<string, unknown>);
      return { kind: 'created' };
    }
    const existing = snap.data() ?? {};
    const identical = existing.claim_id === input.claim_id.toLowerCase()
      && existing.lane === input.lane
      && (existing.claim_kind ?? 'act') === kind
      && (input.lane !== 'genesis'
        || existing.genesis_anchor_key === input.genesis_anchor_key!.toLowerCase());
    return identical
      ? { kind: 'already_registered_identical' }
      : { kind: 'rejected', reason: 'claim_identity_drift' };
  });
}

/**
 * Bulk registration for harness seeding: chunked non-transactional creates.
 * Every row is validated first; any invalid row rejects the WHOLE call before
 * a single write. `create` semantics still refuse duplicates per-row.
 */
export async function registerClaimsBulk(
  db: SettlementDb,
  inputs: readonly NewClaimInput[],
  nowMs: number,
  onWrite?: (count: number) => void,
): Promise<{ created: number }> {
  const seen = new Set<string>();
  for (const input of inputs) {
    const invalid = validateNewClaim(input);
    if (invalid !== null) throw new Error(`registerClaimsBulk: ${invalid} (pe ${input.pe_id})`);
    const docId = claimKeyOf(input.pe_id, input.leg, input.claim_kind ?? 'act');
    if (seen.has(docId)) throw new Error(`registerClaimsBulk: duplicate_pe_in_input (pe ${input.pe_id})`);
    seen.add(docId);
  }
  const collection = db.collection(CLAIM_LEDGER_COLLECTION);
  let created = 0;
  for (let start = 0; start < inputs.length; start += LEDGER_WRITEBACK_CHUNK) {
    const chunk = inputs.slice(start, start + LEDGER_WRITEBACK_CHUNK);
    const batch = db.batch();
    for (const input of chunk) {
      // set (not create) is deliberate for the bulk path: WriteBatch.create is
      // not in the narrow interface; the pre-validated duplicate check above
      // plus registerClaim being the online path keeps this harness-only.
      batch.set(collection.doc(claimKeyOf(input.pe_id, input.leg, input.claim_kind ?? 'act')),
        ledgerRowFromInput(input, nowMs) as unknown as Record<string, unknown>);
    }
    await batch.commit();
    created += chunk.length;
    onWrite?.(chunk.length);
  }
  return { created };
}

/** Page through the ledger; never an unbounded single read (discipline). */
/**
 * Refuse to run a cycle while any PRE-M8 ledger row is present.
 *
 * M9 — the M8 rekey moved the doc id and the sort key from `pe_key` to `claim_key`, with no
 * migration and no guard. A real Firestore `orderBy('claim_key')` EXCLUDES documents that lack
 * the field, so a pre-M8 row is invisible to `readLedgerPage` — and therefore to `selectLaneWork`
 * and to the inlet's `claimKeyOf(peId,'sole')` existence check. The PE would be silently
 * re-registered under `pe#sole` with the SAME claim id, no drift detected; and if the orphan had
 * already settled on chain, that re-registration reverts `ClaimAlreadySettled` and wedges the
 * cycle. `writeLedgerSettlement` resuming a pre-M8 batch has the mirror problem: `member.leg` is
 * `undefined`, so the writeback lands on `pe#undefined` and the real row stays `settled:false`.
 *
 * ORDERED AND CURSORED ON `claim_id`. It is unique by this module's central invariant and it is
 * carried by pre-M8 rows as well as post-M8 ones, so it is the one field that is both a safe
 * cursor and visible on exactly the population this guard exists to find. (`pe_id` is NOT unique
 * now that one act owns several rows, and a Firestore single-value cursor positions after ALL
 * documents sharing that value, so a page boundary inside a `pe_id` group skipped the rest of it.)
 *
 * THERE IS NO SIZE CAP, AND THAT IS THE POINT — IT TOOK THREE ATTEMPTS TO GET RIGHT.
 * A `maxScan` row budget treats "the ledger got big" as an error. The ledger is APPEND-ONLY (no
 * delete exists in this module; `writeLedgerSettlement` merges `settled:true` and the row stays)
 * and this scan applies no `settled` filter, so it walks cumulative lifetime claims and a real
 * ledger passes any constant eventually. Both earlier versions therefore turned a healthy ledger
 * into a PERMANENT settlement halt: the throw escapes `selectLaneWork` -> `runSettlementCycle` ->
 * `operator-runtime.ts` uncaught, leaving the cycle active with the lease held and `stop()` never
 * reached, so no batch is ever planned again and every unsettled contributor goes unpaid. The
 * first version threw whenever a full page landed on the budget; the second added a probe and
 * moved the same halt by exactly one row, to `maxScan + 1`.
 *
 * TERMINATION COMES FROM DATA PROGRESS, NOT FROM A ROW BUDGET. The loop ends on a short page, and
 * a full page that fails to ADVANCE the cursor is a genuine anomaly (every row sharing one
 * `claim_id`) rather than a healthy large ledger — so it throws `legacy_ledger_scan_stalled`,
 * which is also what makes the loop provably finite. A clean ledger of ANY size passes.
 *
 * NOT a migration. It converts a silent double-mint/wedge risk into a loud refusal, and any
 * migration is a deliberate operator act. As of 2026-07-27 the production collection holds ZERO
 * documents, so nothing needs migrating today — but "the collection is empty" is a fact with a
 * date on it, and this guard is what makes it not need to stay true.
 */
export async function assertNoLegacyLedgerRows(
  db: SettlementDb,
  options: { pageSize?: number } = {},
): Promise<{ scanned: number }> {
  const pageSize = options.pageSize ?? 500;
  let scanned = 0;
  let cursor: string | undefined;

  const source = singleScanQuery((db.collection(CLAIM_LEDGER_COLLECTION) as SettlementQuery).orderBy('claim_id', 'asc'));
  const page = (after: string | undefined): Promise<SettlementQuerySnap> => {
    let query = source.limit(pageSize);
    if (after !== undefined) query = query.startAfter(after);
    return query.get();
  };

  for (;;) {
    const snap = await page(cursor);
    const before = cursor;
    let previousClaimId: string | undefined;
    for (const doc of snap.docs) {
      const data = doc.data() ?? {};
      if (typeof data.claim_key !== 'string' || data.claim_key === '') {
        throw new Error(`legacy_claim_ledger_row:${doc.id}`);
      }
      const claimId = typeof data.claim_id === 'string' ? data.claim_id : undefined;
      // Rows are ordered BY claim_id, so duplicates are adjacent. A duplicate is both a
      // double-mint precursor in its own right AND the one thing that can make this scan skip
      // rows: `startAfter(value)` positions after ALL documents sharing that value, so a
      // duplicate group straddling a page boundary loses its remainder silently.
      if (claimId !== undefined && claimId === previousClaimId) {
        throw new Error(`legacy_ledger_duplicate_claim_id:${claimId}`);
      }
      previousClaimId = claimId;
      cursor = claimId ?? cursor;
    }
    scanned += snap.docs.length;
    // A short page is the end of the collection. This is the ONLY success exit.
    if (snap.docs.length < pageSize) break;
    // The adjacent check above cannot see a duplicate group split exactly at the page boundary —
    // the page holds only its first member. Ask directly, so the skip cannot happen silently.
    if (cursor !== undefined) {
      const tie = await (db.collection(CLAIM_LEDGER_COLLECTION) as SettlementQuery)
        .where('claim_id', '==', cursor).limit(2).get();
      if (tie.docs.length > 1) {
        throw new Error(`legacy_ledger_duplicate_claim_id:${cursor}`);
      }
    }
    // Termination backstop. With tie-skipping cursor semantics the cursor always advances or the
    // page is short, so this is not expected to fire — it is here so that a store whose
    // `startAfter` does NOT skip ties cannot turn this loop into a spin.
    if (cursor === undefined || cursor === before) {
      throw new Error(`legacy_ledger_scan_stalled:${scanned}`);
    }
  }
  return { scanned };
}

/**
 * PE METER (: no job reads in proportion to history). The legacy-row and
 * duplicate-claim-id audit above reads the WHOLE lifetime ledger; selection used to run it on
 * every settlement run. It now runs in full ONCE, and afterwards only over rows created since the
 * last audited position, each checked directly: it has a `claim_key`, and no other row carries its
 * `claim_id` (an indexed point query). The watermark trails the newest audited row by a margin so
 * a row another process registered concurrently, with a slightly older `created_at`, is re-checked
 * rather than skipped. A missing or unreadable audit state means a full audit (unknown = check).
 */
export const LEDGER_AUDIT_COLLECTION = 'pvt9_ledger_audit_v1';
export const LEDGER_AUDIT_DOC = 'legacy_and_duplicates';
export const LEDGER_AUDIT_OVERLAP_MS = 10 * 60_000;

export async function auditLedgerSinceWatermark(
  db: SettlementDb,
  nowMs: number,
  /**
   * `audited`: the claim keys this RUN has already twin-checked (the caller's set; omitted, every
   * scanned row is checked). Skipping their re-check finds every duplicate it ever found: of two
   * rows sharing a claim id, the one audited second finds the other, and a row already cleared
   * can only gain a twin by a NEW row being registered, which is not in the set and is checked.
   * Every scanned row is still read and still checked for its `claim_key`.
   */
  options: { pageSize?: number; audited?: Set<string> } = {},
): Promise<{ mode: 'full' | 'incremental'; scanned: number; twinChecks?: number }> {
  const pageSize = options.pageSize ?? 500;
  let twinChecks = 0;
  const stateRef = db.collection(LEDGER_AUDIT_COLLECTION).doc(LEDGER_AUDIT_DOC);
  const stateSnap = await stateRef.get();
  const state = stateSnap.exists ? stateSnap.data() ?? {} : null;
  const watermark = state !== null && Number.isSafeInteger(state.watermark_created_at)
    ? state.watermark_created_at as number
    : null;
  const newest = async (): Promise<number> => {
    const top = await (db.collection(CLAIM_LEDGER_COLLECTION) as SettlementQuery)
      .orderBy('created_at', 'desc').limit(1).get();
    const value = top.docs[0]?.data()?.created_at;
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
  };
  if (watermark === null) {
    const full = await assertNoLegacyLedgerRows(db, { pageSize });
    const top = await newest();
    const batch = db.batch();
    batch.set(stateRef as unknown as SettlementDocRef, {
      watermark_created_at: Math.max(0, top - LEDGER_AUDIT_OVERLAP_MS),
      full_audit_at_ms: nowMs,
      full_audit_scanned: full.scanned,
      updated_at_ms: nowMs,
    });
    await batch.commit();
    return { mode: 'full', scanned: full.scanned };
  }
  let scanned = 0;
  let cursor: unknown[] | undefined;
  let highest = watermark;
  const source = singleScanQuery((db.collection(CLAIM_LEDGER_COLLECTION) as SettlementQuery)
    .where('created_at', '>=', watermark).orderBy('created_at', 'asc').orderBy('claim_key', 'asc'));
  for (;;) {
    let query = source.limit(pageSize);
    if (cursor !== undefined) query = query.startAfter(...cursor);
    const snap = await query.get();
    for (const doc of snap.docs) {
      const data = doc.data() ?? {};
      if (typeof data.claim_key !== 'string' || data.claim_key === '') {
        throw new Error(`legacy_claim_ledger_row:${doc.id}`);
      }
      if (typeof data.claim_id === 'string' && options.audited?.has(data.claim_key) !== true) {
        const twins = await (db.collection(CLAIM_LEDGER_COLLECTION) as SettlementQuery)
          .where('claim_id', '==', data.claim_id).limit(2).get();
        twinChecks += 1;
        if (twins.docs.length > 1) throw new Error(`legacy_ledger_duplicate_claim_id:${data.claim_id}`);
        options.audited?.add(data.claim_key);
      }
      if (typeof data.created_at === 'number' && data.created_at > highest) highest = data.created_at;
      cursor = [data.created_at, data.claim_key];
    }
    scanned += snap.docs.length;
    if (snap.docs.length < pageSize) break;
  }
  const next = Math.max(watermark, highest - LEDGER_AUDIT_OVERLAP_MS);
  const batch = db.batch();
  batch.set(stateRef as unknown as SettlementDocRef, { watermark_created_at: next, updated_at_ms: nowMs }, { merge: true });
  await batch.commit();
  return { mode: 'incremental', scanned, ...(options.audited === undefined ? {} : { twinChecks }) };
}

/** A source belongs to exactly one selection sweep, after that sweep's ledger audit. */
function ledgerPageQuery(db: SettlementDb, unsettledOnly: boolean): SettlementQuery {
  let query: SettlementQuery = db.collection(CLAIM_LEDGER_COLLECTION);
  if (unsettledOnly) query = query.where('settled', '==', false);
  return query.orderBy('claim_key', 'asc');
}

/** Explicit bulk traversals share one snapshot; single-page readers retain only their limit. */
export function createLedgerPageSource(db: SettlementDb, unsettledOnly: boolean): SettlementQuery {
  return singleScanQuery(ledgerPageQuery(db, unsettledOnly));
}

export async function readLedgerPage(
  db: SettlementDb,
  options: { pageSize: number; startAfterDocId?: string; unsettledOnly?: boolean; source?: SettlementQuery },
): Promise<{ rows: Array<{ docId: string; row: ClaimLedgerRow }>; lastDocId: string | null }> {
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize <= 0) {
    throw new Error('readLedgerPage: pageSize must be a positive integer');
  }
  // Paged on the explicit `claim_key` field (== doc id) rather than __name__:
  // deterministic on real Firestore and the test fake alike. Production
  // needs the (settled, claim_key) composite index — a deploy input.
  let query = (options.source ?? ledgerPageQuery(db, options.unsettledOnly === true)).limit(options.pageSize);
  if (options.startAfterDocId !== undefined) query = query.startAfter(options.startAfterDocId);
  const snap = await query.get();
  const rows = snap.docs.map((doc) => ({
    docId: doc.id,
    row: (doc.data() ?? {}) as unknown as ClaimLedgerRow,
  }));
  return { rows, lastDocId: rows.length > 0 ? rows[rows.length - 1].docId : null };
}

// ---------------------------------------------------------------------------
// Cycle document — durable cursor, lease, nonce, cumulative counters
// ---------------------------------------------------------------------------

export interface CycleLimits {
  /** Plan §settlement runtime item 4: initial cycle limit of 100 transactions. */
  readonly max_transactions: number;
  /** Plan §settlement runtime item 4: initial cycle limit of 0.1 ETH total fees (wei string). */
  readonly max_fee_wei_total: string;
}

export interface CycleConsumed {
  /** Transactions submitted to the wire (originals + replacements). Never resets. */
  readonly transactions_submitted: number;
  readonly replacements_submitted: number;
  readonly batches_confirmed: number;
  readonly claims_settled: number;
  readonly recipients_settled: number;
  /** Actual fees paid across confirmed transactions (wei, BigInt string). */
  readonly fee_wei_spent: string;
  /** Worst-case fees of submitted-but-unconfirmed attempts (wei, BigInt string). */
  readonly fee_wei_reserved: string;
}

export interface SettlementCycleDoc {
  readonly schema_version: typeof SETTLEMENT_CYCLE_SCHEMA;
  readonly cycle_id: string;
  readonly epoch: number;
  readonly policy_hash: string;
  readonly status: 'active' | 'completed' | 'stopped';
  readonly stop_reason: string | null;
  readonly lease: {
    readonly owner: string;
    readonly acquired_at_ms: number;
    readonly expires_at_ms: number;
  };
  /** The address the cycle's transactions are signed as (nonce owner). */
  readonly signer: string;
  /** Next unused nonce. Assigned at reservation, incremented monotonically. */
  readonly next_nonce: number;
  readonly base_nonce: number;
  readonly limits: CycleLimits;
  readonly consumed: CycleConsumed;
  /** Durable cursor: where the next reservation begins (BigInt strings). */
  readonly cursor_start: string;
  readonly cursor_next: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly completed_at: number | null;
}

export type AcquireLeaseResult =
  | { readonly kind: 'acquired'; readonly cycle: SettlementCycleDoc }
  | { readonly kind: 'refused'; readonly reason: 'lease_held' | 'cycle_closed' | 'config_mismatch' };

function isCycleDoc(value: Record<string, unknown> | undefined): value is
  Record<string, unknown> & { schema_version: typeof SETTLEMENT_CYCLE_SCHEMA } {
  return value !== undefined && value.schema_version === SETTLEMENT_CYCLE_SCHEMA;
}

/**
 * Create the cycle (first caller) or take over an EXPIRED lease. A live lease
 * held by another worker refuses — the single-worker property. Same-worker
 * re-acquire renews (crash-restart with the same worker id resumes its own
 * cycle immediately).
 */
export async function acquireCycleLease(
  db: SettlementDb,
  params: {
    cycleId: string;
    workerId: string;
    nowMs: number;
    leaseTtlMs: number;
    epoch: number;
    policyHash: string;
    signer: string;
    baseNonce: number;
    limits: CycleLimits;
    cursorStart: bigint;
    /**
     * re-seed `next_nonce` on a RENEW. The runner computes it after the cross-cycle
     * reconciler, as max(latest count, pending count, 1 + every nonce an unresolved batch
     * holds or a mined attempt of this cycle consumed), so a reservation that died without
     * ever reaching the wire leaves no gap and a live one is never re-used. Omitted: the
     * renew keeps the durable `next_nonce` exactly as before.
     */
    reseedNonce?: number;
  },
): Promise<AcquireLeaseResult> {
  const ref = db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(params.cycleId);
  return db.runTransaction<AcquireLeaseResult>(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) {
      const fresh: SettlementCycleDoc = {
        schema_version: SETTLEMENT_CYCLE_SCHEMA,
        cycle_id: params.cycleId,
        epoch: params.epoch,
        policy_hash: params.policyHash.toLowerCase(),
        status: 'active',
        stop_reason: null,
        lease: {
          owner: params.workerId,
          acquired_at_ms: params.nowMs,
          expires_at_ms: params.nowMs + params.leaseTtlMs,
        },
        signer: params.signer.toLowerCase(),
        next_nonce: params.baseNonce,
        base_nonce: params.baseNonce,
        limits: params.limits,
        consumed: {
          transactions_submitted: 0,
          replacements_submitted: 0,
          batches_confirmed: 0,
          claims_settled: 0,
          recipients_settled: 0,
          fee_wei_spent: '0',
          fee_wei_reserved: '0',
        },
        cursor_start: params.cursorStart.toString(),
        cursor_next: params.cursorStart.toString(),
        created_at: params.nowMs,
        updated_at: params.nowMs,
        completed_at: null,
      };
      txn.create(ref, fresh as unknown as Record<string, unknown>);
      return { kind: 'acquired', cycle: fresh };
    }

    const data = snap.data();
    if (!isCycleDoc(data)) return { kind: 'refused', reason: 'config_mismatch' };
    const existing = data as unknown as SettlementCycleDoc;
    if (existing.status !== 'active') return { kind: 'refused', reason: 'cycle_closed' };
    // Re-acquire binds to the EXISTING epoch/policy/signer — a worker whose
    // local configuration disagrees with the durable cycle must not adopt it.
    if (existing.epoch !== params.epoch
      || existing.policy_hash !== params.policyHash.toLowerCase()
      || existing.signer !== params.signer.toLowerCase()) {
      return { kind: 'refused', reason: 'config_mismatch' };
    }
    const leaseLive = existing.lease.expires_at_ms > params.nowMs;
    if (leaseLive && existing.lease.owner !== params.workerId) {
      return { kind: 'refused', reason: 'lease_held' };
    }
    const renewed: SettlementCycleDoc = {
      ...existing,
      ...(params.reseedNonce === undefined ? {} : { next_nonce: params.reseedNonce }),
      lease: {
        owner: params.workerId,
        acquired_at_ms: params.nowMs,
        expires_at_ms: params.nowMs + params.leaseTtlMs,
      },
      updated_at: params.nowMs,
    };
    txn.set(ref, renewed as unknown as Record<string, unknown>);
    return { kind: 'acquired', cycle: renewed };
  });
}

/**
 * give up this worker's cycle lease without closing the cycle. Worker ids are
 * unique per invocation, so a lease left standing would refuse the next run (a scheduler
 * retry, the next cron) until the TTL ran out. Only the holder can release; a stranger's
 * call is a no-op.
 */
export async function releaseCycleLease(
  db: SettlementDb,
  params: { cycleId: string; workerId: string; nowMs: number },
): Promise<{ released: boolean }> {
  const ref = db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(params.cycleId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    if (!isCycleDoc(data)) return { released: false };
    const cycle = data as unknown as SettlementCycleDoc;
    if (cycle.lease.owner !== params.workerId || cycle.lease.expires_at_ms <= params.nowMs) {
      return { released: false };
    }
    txn.set(ref, {
      ...cycle,
      lease: { ...cycle.lease, expires_at_ms: params.nowMs },
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { released: true };
  });
}

// ---------------------------------------------------------------------------
// Signer lease — one settlement run per signer at a time
// ---------------------------------------------------------------------------

export interface SignerLeaseDoc {
  readonly signer: string;
  readonly owner: string;
  readonly acquired_at_ms: number;
  readonly expires_at_ms: number;
}

export type AcquireSignerLeaseResult =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'refused'; readonly reason: 'lease_held'; readonly owner: string };

/**
 * Take (or renew) the signer lease. A LIVE lease held by a different worker refuses — the
 * single-flight property every nonce-bearing write depends on. The same worker renews, which
 * is how the operator runtime hands its lease to the cycle it starts.
 */
export async function acquireSignerLease(
  db: SettlementDb,
  params: { signer: string; workerId: string; nowMs: number; leaseTtlMs: number },
): Promise<AcquireSignerLeaseResult> {
  const signer = params.signer.toLowerCase();
  const ref = db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer);
  return db.runTransaction<AcquireSignerLeaseResult>(async (txn) => {
    const snap = await txn.get(ref);
    const existing = snap.exists ? (snap.data() ?? {}) : {};
    const owner = typeof existing.owner === 'string' ? existing.owner : null;
    const expires = typeof existing.expires_at_ms === 'number' ? existing.expires_at_ms : 0;
    if (owner !== null && owner !== params.workerId && expires > params.nowMs) {
      return { kind: 'refused', reason: 'lease_held', owner };
    }
    const lease: SignerLeaseDoc = {
      signer,
      owner: params.workerId,
      acquired_at_ms: params.nowMs,
      expires_at_ms: params.nowMs + params.leaseTtlMs,
    };
    txn.set(ref, lease as unknown as Record<string, unknown>);
    return { kind: 'acquired' };
  });
}

export async function releaseSignerLease(
  db: SettlementDb,
  params: { signer: string; workerId: string; nowMs: number },
): Promise<{ released: boolean }> {
  const ref = db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(params.signer.toLowerCase());
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const existing = snap.exists ? (snap.data() ?? {}) : {};
    if (existing.owner !== params.workerId) return { released: false };
    txn.set(ref, { ...existing, expires_at_ms: params.nowMs }, { merge: true });
    return { released: true };
  });
}

/** True iff `workerId` holds a LIVE lease on `signer` (read inside a transaction). */
async function holdsSignerLease(
  db: SettlementDb,
  txn: SettlementTxn,
  signer: string,
  workerId: string,
  nowMs: number,
): Promise<boolean> {
  const snap = await txn.get(db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.toLowerCase()));
  const lease = snap.exists ? (snap.data() ?? {}) : {};
  return lease.owner === workerId
    && typeof lease.expires_at_ms === 'number' && lease.expires_at_ms > nowMs;
}

export async function readCycle(
  db: SettlementDb,
  cycleId: string,
): Promise<SettlementCycleDoc | null> {
  const snap = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(cycleId).get();
  const data = snap.exists ? snap.data() : undefined;
  return isCycleDoc(data) ? (data as unknown as SettlementCycleDoc) : null;
}

/** Close the cycle. `completed` = backlog exhausted; `stopped` = guardrail. */
export async function closeCycle(
  db: SettlementDb,
  params: { cycleId: string; workerId: string; nowMs: number; status: 'completed' | 'stopped'; stopReason: string | null },
): Promise<{ closed: boolean }> {
  const ref = db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(params.cycleId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const data = snap.exists ? snap.data() : undefined;
    if (!isCycleDoc(data)) return { closed: false };
    const cycle = data as unknown as SettlementCycleDoc;
    if (cycle.status !== 'active' || cycle.lease.owner !== params.workerId) {
      return { closed: false };
    }
    txn.set(ref, {
      ...cycle,
      status: params.status,
      stop_reason: params.stopReason,
      updated_at: params.nowMs,
      completed_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { closed: true };
  });
}

// ---------------------------------------------------------------------------
// Batch reservations
// ---------------------------------------------------------------------------

export interface BatchAttempt {
  readonly nonce: number;
  readonly tx_hash: string;
  /**
   * 'cancel' is a plain self-transfer at the SAME nonce as a stuck attempt
   * whose batch binding has died (epoch crossed) — it resolves the nonce
   * without executing a settlement. A mined-successful cancel must NEVER be
   * applied as a settlement (`applyConfirmedBatch` refuses it by kind).
   */
  readonly kind: 'original' | 'replacement' | 'retry_after_revert' | 'cancel';
  readonly max_fee_per_gas_wei: string;
  readonly max_priority_fee_per_gas_wei: string;
  readonly gas_limit: string;
  readonly submitted_at_ms: number;
  /** Receipt outcome, recorded by reconciliation. Null until observed mined. */
  readonly mined: null | {
    readonly status: 'success' | 'reverted';
    readonly block_number: number;
    /**
     * the block the receipt named. A receipt is only a FACT at the safe-head depth
     * and only while this hash is still canonical at `block_number`. Absent on
     * attempts recorded before; finality re-reads the receipt for those.
     */
    readonly block_hash?: string;
    readonly gas_used: string;
    readonly effective_gas_price_wei: string;
  };
}

/** a settle that was applied at one block and later found non-canonical there. */
export interface BatchReorgRecord {
  readonly tx_hash: string;
  readonly block_number: number | null;
  readonly block_hash: string | null;
  readonly detected_at_ms: number;
  readonly reason: string;
}

export interface BatchMemberRecord {
  readonly pe_id: string;
  /**
   * Which payout leg. Required, because the settlement writeback keys the ledger row by CLAIM
   * and an act can have two. Keying the writeback by PE alone would mark both legs settled when
   * only one was — or, worse, mark the wrong one.
   */
  readonly leg: PayoutLegRole;
  /**
   * which claim of the leg. Absent on every pre- batch doc (= `act`). Required
   * to be carried for a top-up member, because the writeback keys the ledger row by
   * (pe, leg, kind): a top-up written back under the act's key would mark the act's row
   * (already settled) and leave the top-up row `settled:false`, to be re-settled next run
   * and revert `ClaimAlreadySettled` a wedge.
   */
  readonly claim_kind?: ClaimKind;
  readonly claim_id: string;
}

export interface SettlementBatchDoc {
  readonly schema_version: typeof SETTLEMENT_BATCH_SCHEMA;
  readonly batch_id: string;
  readonly cycle_id: string;
  readonly lane: LedgerLane;
  readonly epoch: number;
  readonly policy_hash: string;
  readonly cursor_start: string;
  readonly cursor_end: string;
  readonly recipient_count: number;
  readonly claim_count: number;
  /** Exact issuance this batch mints (BigInt string), for cap accounting. */
  readonly total_minted_atomic: string;
  /** The nonce assigned at reservation — the batch's one nonce until a
   * mined-failed receipt proves it consumed. */
  readonly reserved_nonce: number;
  /** The exact settlement calldata, persisted so a crash-resume can rebuild
   * replacement transactions byte-identically. Bounded by `maxClaims`. */
  readonly calldata: string;
  readonly members: readonly BatchMemberRecord[];
  /**
   * `mined` is a success receipt seen but NOT yet at the safe-head depth. It is an
   * UNRESOLVED status: nothing is applied, written back, or announced until the receipt's
   * block is at or below min(finalizedThroughBlock(head), safeHead) and still canonical.
   */
  readonly status: 'reserved' | 'submitted' | 'mined' | 'confirmed' | 'dead';
  readonly dead_reason: string | null;
  readonly attempts: readonly BatchAttempt[];
  readonly confirmed_tx_hash: string | null;
  readonly confirmed_fee_wei: string | null;
  /** where the applied settle was final. Absent on batches applied before. */
  readonly confirmed_block_number?: number | null;
  readonly confirmed_block_hash?: string | null;
  /**
   * the applied settle has been verified canonical at safe depth (set at apply, which
   * now happens only at that depth, and by the applied-batch sweep for older batches).
   */
  readonly finality_verified?: boolean;
  /** every time an applied settle was found reorged out and returned to the queue. */
  readonly reorgs?: readonly BatchReorgRecord[];
  /**
   * PE METER cost pass — the finality sweep's index: true exactly while the batch is applied and
   * confirmed but not yet finality-verified. Absent on batches written before it (the sweep's
   * one-time scan stamps them; `listFinalitySweepCandidates`).
   */
  readonly finality_open?: boolean;
  /** `cursor_end` as a number, for the sweep's indexed coverage query. Absent before the cost pass. */
  readonly cursor_end_n?: number;
  /** Exactly-once marker for counter application + cursor advance. */
  readonly applied: boolean;
  /** First confirmed application clock; repairs preserve it. */
  readonly settled_at_ms?: number;
  readonly payees?: readonly string[];
  readonly payee_clocks_before?: Readonly<Record<string, Record<string, unknown> | null>>;
  readonly writebacks_complete: boolean;
  readonly created_at: number;
  readonly updated_at: number;
}

function isBatchDoc(value: Record<string, unknown> | undefined): value is
  Record<string, unknown> & { schema_version: typeof SETTLEMENT_BATCH_SCHEMA } {
  return value !== undefined && value.schema_version === SETTLEMENT_BATCH_SCHEMA;
}

export type ReserveBatchResult =
  | { readonly kind: 'reserved'; readonly nonce: number; readonly batch: SettlementBatchDoc }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'lease_not_held'
        | 'cycle_closed'
        | 'transaction_limit'
        | 'cursor_discontinuity'
        | 'batch_exists'
        | 'claim_not_settleable';
      /** for `claim_not_settleable` the member claim keys that were not settleable. */
      readonly claimKeys?: readonly string[];
    };

/**
 * Reserve one batch: verifies the lease, the remaining transaction budget,
 * and cursor continuity against the DURABLE cursor, then creates the batch
 * doc with the next nonce. The durable cursor does NOT advance here — it
 * advances only at `applyConfirmedBatch`, so it always equals the on-chain
 * `nextFinalizedCursor` after every applied batch (serial submission).
 */
export async function reserveBatch(
  db: SettlementDb,
  params: {
    cycleId: string;
    workerId: string;
    nowMs: number;
    batchId: string;
    lane: LedgerLane;
    epoch: number;
    policyHash: string;
    cursorStart: bigint;
    cursorEnd: bigint;
    recipientCount: number;
    claimCount: number;
    totalMintedAtomic: bigint;
    calldata: string;
    members: readonly BatchMemberRecord[];
  },
): Promise<ReserveBatchResult> {
  if (!isSettleableHash(params.batchId)) throw new Error('reserveBatch: invalid batch id');
  if (params.members.length !== params.claimCount) {
    throw new Error('reserveBatch: members must cover every claim');
  }
  const cycleRef = db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(params.cycleId);
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  return db.runTransaction<ReserveBatchResult>(async (txn) => {
    const [cycleSnap, batchSnap] = [await txn.get(cycleRef), await txn.get(batchRef)];
    const memberRefs = params.members.map((member) => db.collection(CLAIM_LEDGER_COLLECTION)
      .doc(claimKeyOf(member.pe_id, member.leg, member.claim_kind ?? 'act')));
    const demotionRefs = [...new Set(params.members.map((member) => normalizePeId(member.pe_id)))]
      .map((peId) => db.collection(BUG_DEMOTION_COLLECTION).doc(peId));
    const memberSnaps: SettlementDocSnap[] = [];
    for (const ref of memberRefs) memberSnaps.push(await txn.get(ref));
    const demotionSnaps = [];
    for (const ref of demotionRefs) demotionSnaps.push(await txn.get(ref));
    const cycleData = cycleSnap.exists ? cycleSnap.data() : undefined;
    if (!isCycleDoc(cycleData)) return { kind: 'refused', reason: 'cycle_closed' };
    const cycle = cycleData as unknown as SettlementCycleDoc;
    if (cycle.status !== 'active') return { kind: 'refused', reason: 'cycle_closed' };
    if (cycle.lease.owner !== params.workerId || cycle.lease.expires_at_ms <= params.nowMs) {
      return { kind: 'refused', reason: 'lease_not_held' };
    }
    if (batchSnap.exists) return { kind: 'refused', reason: 'batch_exists' };
    if (cycle.consumed.transactions_submitted >= cycle.limits.max_transactions) {
      return { kind: 'refused', reason: 'transaction_limit' };
    }
    if (BigInt(cycle.cursor_next) !== params.cursorStart) {
      return { kind: 'refused', reason: 'cursor_discontinuity' };
    }
    const unsettleable = memberSnaps
      .map((snap, index) => {
        const row = snap.exists ? snap.data() ?? {} : {};
        const bad = !snap.exists || row.settled !== false || row.bug_demoted_at_ms != null
          || (typeof row.reserved_batch_id === 'string' && row.reserved_batch_id.length > 0);
        const member = params.members[index];
        return bad ? claimKeyOf(member.pe_id, member.leg, member.claim_kind ?? 'act') : null;
      })
      .filter((key): key is string => key !== null);
    if (demotionSnaps.some((snap) => snap.exists) || unsettleable.length > 0) {
      return { kind: 'refused', reason: 'claim_not_settleable', claimKeys: unsettleable };
    }
    const nonce = cycle.next_nonce;
    const batch: SettlementBatchDoc = {
      schema_version: SETTLEMENT_BATCH_SCHEMA,
      batch_id: params.batchId.toLowerCase(),
      cycle_id: params.cycleId,
      lane: params.lane,
      epoch: params.epoch,
      policy_hash: params.policyHash.toLowerCase(),
      cursor_start: params.cursorStart.toString(),
      cursor_end: params.cursorEnd.toString(),
      recipient_count: params.recipientCount,
      claim_count: params.claimCount,
      total_minted_atomic: params.totalMintedAtomic.toString(),
      reserved_nonce: nonce,
      calldata: params.calldata,
      members: params.members,
      payees: [...new Set(memberSnaps.map(s => s.data()?.contributor).filter((p): p is string => typeof p === 'string'))],
      status: 'reserved',
      dead_reason: null,
      attempts: [],
      confirmed_tx_hash: null,
      confirmed_fee_wei: null,
      applied: false,
      writebacks_complete: false,
      created_at: params.nowMs,
      updated_at: params.nowMs,
      finality_open: false,
      ...cursorEndIndexOf(params.cursorEnd),
    };
    txn.create(batchRef, batch as unknown as Record<string, unknown>);
    for (const ref of memberRefs) {
      txn.set(ref, { reserved_batch_id: batch.batch_id }, { merge: true });
    }
    txn.set(cycleRef, {
      ...cycle,
      next_nonce: nonce + 1,
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { kind: 'reserved', nonce, batch };
  });
}

export type RecordAttemptResult =
  | { readonly kind: 'recorded' }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'batch_not_reserved'
        | 'nonce_rules_violated'
        | 'transaction_limit'
        | 'batch_closed';
    };

/**
 * Record a signed transaction BEFORE broadcasting it. Consumes one unit of
 * the cycle transaction budget and reserves its worst-case fee. Nonce rules:
 *  - 'original': first attempt only, at the reserved nonce.
 *  - 'replacement' / 'cancel': SAME nonce as the latest attempt (fee-bumped
 *    re-send, or a nonce-resolving self-transfer for a dead binding; at most
 *    one of the same-nonce set can ever mine).
 *  - 'retry_after_revert': a NEW nonce, permitted only when the latest
 *    attempt has a recorded MINED-FAILED receipt (its nonce is consumed).
 */
export async function recordAttempt(
  db: SettlementDb,
  params: {
    cycleId: string;
    workerId: string;
    nowMs: number;
    batchId: string;
    attempt: Omit<BatchAttempt, 'mined' | 'submitted_at_ms'>;
    /**
     * ADOPTION. The cross-cycle reconciler drives a batch stranded in a cycle that is
     * closed (or whose crashed owner's lease has lapsed). Such a cycle can never be re-leased,
     * so the fence is the SIGNER lease instead: the writer must hold it, live. The cycle
     * transaction budget is not re-applied — a replacement or cancel resolves a nonce the
     * batch ALREADY holds, which is exactly what a stranded batch needs, and it stays bounded
     * by the runner's per-run replacement budget. Only same-nonce kinds may be adopted.
     */
    adoptSigner?: string;
  },
): Promise<RecordAttemptResult> {
  const cycleRef = db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(params.cycleId);
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  return db.runTransaction<RecordAttemptResult>(async (txn) => {
    const [cycleSnap, batchSnap] = [await txn.get(cycleRef), await txn.get(batchRef)];
    const signerLeaseHeld = params.adoptSigner === undefined
      ? false
      : await holdsSignerLease(db, txn, params.adoptSigner, params.workerId, params.nowMs);
    const cycleData = cycleSnap.exists ? cycleSnap.data() : undefined;
    const batchData = batchSnap.exists ? batchSnap.data() : undefined;
    if (!isCycleDoc(cycleData) || !isBatchDoc(batchData)) {
      return { kind: 'refused', reason: 'batch_not_reserved' };
    }
    const cycle = cycleData as unknown as SettlementCycleDoc;
    const batch = batchData as unknown as SettlementBatchDoc;
    if (batch.cycle_id !== params.cycleId) return { kind: 'refused', reason: 'batch_not_reserved' };
    if (params.adoptSigner !== undefined) {
      if (!signerLeaseHeld || cycle.signer !== params.adoptSigner.toLowerCase()) {
        return { kind: 'refused', reason: 'batch_not_reserved' };
      }
      if (params.attempt.kind !== 'replacement' && params.attempt.kind !== 'cancel') {
        return { kind: 'refused', reason: 'nonce_rules_violated' };
      }
    } else if (cycle.status !== 'active' || cycle.lease.owner !== params.workerId
      || cycle.lease.expires_at_ms <= params.nowMs) {
      return { kind: 'refused', reason: 'batch_not_reserved' };
    }
    if (batch.status !== 'reserved' && batch.status !== 'submitted') {
      return { kind: 'refused', reason: 'batch_closed' };
    }
    if (params.adoptSigner === undefined
      && cycle.consumed.transactions_submitted >= cycle.limits.max_transactions) {
      return { kind: 'refused', reason: 'transaction_limit' };
    }
    const latest = batch.attempts.length > 0 ? batch.attempts[batch.attempts.length - 1] : null;
    const kind = params.attempt.kind;
    if (kind === 'original') {
      if (latest !== null) return { kind: 'refused', reason: 'nonce_rules_violated' };
    } else if (kind === 'replacement' || kind === 'cancel') {
      if (latest === null || latest.nonce !== params.attempt.nonce || latest.mined !== null) {
        return { kind: 'refused', reason: 'nonce_rules_violated' };
      }
    } else {
      // retry_after_revert: previous nonce must be consumed by a mined failure.
      if (latest === null || latest.mined === null || latest.mined.status !== 'reverted'
        || params.attempt.nonce === latest.nonce) {
        return { kind: 'refused', reason: 'nonce_rules_violated' };
      }
    }
    const attempt: BatchAttempt = {
      ...params.attempt,
      submitted_at_ms: params.nowMs,
      mined: null,
    };
    const worstCaseFee = BigInt(params.attempt.max_fee_per_gas_wei) * BigInt(params.attempt.gas_limit);
    txn.set(batchRef, {
      ...batch,
      status: 'submitted',
      attempts: [...batch.attempts, attempt],
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    txn.set(cycleRef, {
      ...cycle,
      consumed: {
        ...cycle.consumed,
        transactions_submitted: cycle.consumed.transactions_submitted + 1,
        replacements_submitted:
          cycle.consumed.replacements_submitted + (kind === 'replacement' ? 1 : 0),
        fee_wei_reserved: (BigInt(cycle.consumed.fee_wei_reserved) + worstCaseFee).toString(),
      },
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { kind: 'recorded' };
  });
}

/**
 * Record a mined receipt (success or revert) onto the matching attempt.
 *
 * a receipt is recorded as SEEN, not as final. A success of a settlement attempt moves
 * the batch to `mined` still unresolved — and nothing is applied until the runner has proven
 * the receipt's block canonical at the safe-head depth (`applyConfirmedBatch`).
 */
export async function recordMinedReceipt(
  db: SettlementDb,
  params: {
    batchId: string;
    txHash: string;
    nowMs: number;
    status: 'success' | 'reverted';
    blockNumber: number;
    blockHash?: string;
    gasUsed: bigint;
    effectiveGasPriceWei: bigint;
  },
): Promise<{ recorded: boolean }> {
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(batchRef);
    const data = snap.exists ? snap.data() : undefined;
    if (!isBatchDoc(data)) return { recorded: false };
    const batch = data as unknown as SettlementBatchDoc;
    const index = batch.attempts.findIndex(
      (attempt) => attempt.tx_hash.toLowerCase() === params.txHash.toLowerCase(),
    );
    if (index === -1) return { recorded: false };
    if (batch.attempts[index].mined !== null) return { recorded: true };
    const attempts = batch.attempts.map((attempt, i) => (i === index
      ? {
          ...attempt,
          mined: {
            status: params.status,
            block_number: params.blockNumber,
            ...(params.blockHash === undefined ? {} : { block_hash: params.blockHash.toLowerCase() }),
            gas_used: params.gasUsed.toString(),
            effective_gas_price_wei: params.effectiveGasPriceWei.toString(),
          },
        }
      : attempt));
    const settles = params.status === 'success' && batch.attempts[index].kind !== 'cancel';
    txn.set(batchRef, {
      ...batch,
      ...(settles && (batch.status === 'submitted' || batch.status === 'reserved')
        ? { status: 'mined' }
        : {}),
      attempts,
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { recorded: true };
  });
}

/**
 * forget a receipt that is no longer canonical (its block was reorged out, or the
 * transaction moved to another block). The attempt is unmined again and the batch returns to
 * `submitted`, so the runner resumes polling, re-broadcasting, and — only once a receipt is
 * final — applying. Refuses on an applied batch: an applied settle is unwound only by
 * `revertReorgedBatch`, which also unwinds the ledger.
 */
export async function clearMinedReceipt(
  db: SettlementDb,
  params: { batchId: string; txHash: string; nowMs: number },
): Promise<{ cleared: boolean }> {
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(batchRef);
    const data = snap.exists ? snap.data() : undefined;
    if (!isBatchDoc(data)) return { cleared: false };
    const batch = data as unknown as SettlementBatchDoc;
    if (batch.applied || batch.status === 'confirmed' || batch.status === 'dead') {
      return { cleared: false };
    }
    const index = batch.attempts.findIndex(
      (attempt) => attempt.tx_hash.toLowerCase() === params.txHash.toLowerCase(),
    );
    if (index === -1 || batch.attempts[index].mined === null) return { cleared: false };
    const attempts = batch.attempts.map((attempt, i) => (i === index ? { ...attempt, mined: null } : attempt));
    const stillSettled = attempts.some((a) => a.mined?.status === 'success' && a.kind !== 'cancel');
    txn.set(batchRef, {
      ...batch,
      status: stillSettled ? 'mined' : 'submitted',
      attempts,
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { cleared: true };
  });
}

export type ApplyBatchResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'already_applied' }
  | {
      readonly kind: 'refused';
      readonly reason: 'batch_unknown' | 'no_successful_attempt' | 'cursor_mismatch' | 'cycle_unknown';
    };

/**
 * Exactly-once application of a CONFIRMED batch: advances the durable cursor
 * to `cursor_end`, converts the attempt's worst-case fee reservation into the
 * actual fee, and adds the batch's claim/recipient counts to the cumulative
 * counters. Idempotent via the `applied` flag — a crash-and-retry can never
 * double-count, which is what "cumulative counters that survive retry" means.
 */
export async function applyConfirmedBatch(
  db: SettlementDb,
  params: {
    cycleId: string;
    batchId: string;
    txHash: string;
    nowMs: number;
    /**
     * the canonical block the runner proved the settle final at (safe-head depth,
     * canonical hash, agreeing re-read). Recorded so a later reorg check has a fixed point to
     * compare against, and marks the batch finality-verified.
     */
    final?: { readonly blockNumber: number; readonly blockHash: string };
  },
): Promise<ApplyBatchResult> {
  const cycleRef = db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(params.cycleId);
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  return db.runTransaction<ApplyBatchResult>(async (txn) => {
    const [cycleSnap, batchSnap] = [await txn.get(cycleRef), await txn.get(batchRef)];
    const cycleData = cycleSnap.exists ? cycleSnap.data() : undefined;
    const batchData = batchSnap.exists ? batchSnap.data() : undefined;
    if (!isBatchDoc(batchData)) return { kind: 'refused', reason: 'batch_unknown' };
    if (!isCycleDoc(cycleData)) return { kind: 'refused', reason: 'cycle_unknown' };
    const batch = batchData as unknown as SettlementBatchDoc;
    const cycle = cycleData as unknown as SettlementCycleDoc;
    if (batch.applied) return { kind: 'already_applied' };
    const attempt = batch.attempts.find(
      (candidate) => candidate.tx_hash.toLowerCase() === params.txHash.toLowerCase()
        && candidate.mined?.status === 'success'
        // A mined cancel resolves a nonce; it is NOT a settlement.
        && candidate.kind !== 'cancel',
    );
    if (attempt === undefined || attempt.mined === null) {
      return { kind: 'refused', reason: 'no_successful_attempt' };
    }
    if (BigInt(cycle.cursor_next) !== BigInt(batch.cursor_start)) {
      return { kind: 'refused', reason: 'cursor_mismatch' };
    }
    const actualFee = BigInt(attempt.mined.gas_used) * BigInt(attempt.mined.effective_gas_price_wei);
    const worstCaseFee = BigInt(attempt.max_fee_per_gas_wei) * BigInt(attempt.gas_limit);
    const reserved = BigInt(cycle.consumed.fee_wei_reserved);
    const clockRefs = batch.lane === 'standard'
      ? (batch.payees ?? []).map(p => db.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(p)) : [];
    const clockSnaps = await Promise.all(clockRefs.map(ref => txn.get(ref)));
    const clocksBefore: Record<string, Record<string, unknown> | null> = {};
    clockRefs.forEach((ref, i) => {
      const payee = (batch.payees ?? [])[i];
      clocksBefore[payee] = clockSnaps[i].data() ?? null;
      txn.set(ref, { payee, batch_id: batch.batch_id, last_settled_at_ms: params.nowMs });
    });
    txn.set(batchRef, {
      ...batch,
      status: 'confirmed',
      confirmed_tx_hash: attempt.tx_hash,
      confirmed_fee_wei: actualFee.toString(),
      ...(params.final === undefined
        ? {}
        : {
            confirmed_block_number: params.final.blockNumber,
            confirmed_block_hash: params.final.blockHash.toLowerCase(),
            finality_verified: true,
          }),
      applied: true,
      settled_at_ms: params.nowMs,
      payee_clocks_before: clocksBefore,
      // Open until verified final (a settle applied at safe depth is verified at apply).
      finality_open: params.final === undefined && batch.finality_verified !== true,
      ...cursorEndIndexOf(BigInt(batch.cursor_end)),
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    txn.set(cycleRef, {
      ...cycle,
      cursor_next: batch.cursor_end,
      consumed: {
        ...cycle.consumed,
        batches_confirmed: cycle.consumed.batches_confirmed + 1,
        claims_settled: cycle.consumed.claims_settled + batch.claim_count,
        recipients_settled: cycle.consumed.recipients_settled + batch.recipient_count,
        fee_wei_spent: (BigInt(cycle.consumed.fee_wei_spent) + actualFee).toString(),
        fee_wei_reserved: (reserved > worstCaseFee ? reserved - worstCaseFee : 0n).toString(),
      },
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { kind: 'applied' };
  });
}

/**
 * Allocate one additional nonce from the cycle's sequence (used by
 * retry-after-revert, whose reverted predecessor consumed its nonce). The
 * cycle doc is the single nonce authority — never `getTransactionCount`,
 * which could race an unrelated transaction from the same signer.
 */
export async function allocateNonce(
  db: SettlementDb,
  params: { cycleId: string; workerId: string; nowMs: number },
): Promise<{ kind: 'allocated'; nonce: number } | { kind: 'refused'; reason: 'lease_not_held' | 'cycle_closed' }> {
  const cycleRef = db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(params.cycleId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(cycleRef);
    const data = snap.exists ? snap.data() : undefined;
    if (!isCycleDoc(data)) return { kind: 'refused' as const, reason: 'cycle_closed' as const };
    const cycle = data as unknown as SettlementCycleDoc;
    if (cycle.status !== 'active') return { kind: 'refused' as const, reason: 'cycle_closed' as const };
    if (cycle.lease.owner !== params.workerId || cycle.lease.expires_at_ms <= params.nowMs) {
      return { kind: 'refused' as const, reason: 'lease_not_held' as const };
    }
    const nonce = cycle.next_nonce;
    txn.set(cycleRef, {
      ...cycle,
      next_nonce: nonce + 1,
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { kind: 'allocated' as const, nonce };
  });
}

/**
 * Return a nonce that was allocated but is provably UNUSED on the wire, so the
 * next reservation reuses it. The guard is common to both sound callers: this
 * must be the HEAD allocation (`next_nonce === nonce + 1`), at or above base.
 * Two callers, two independent soundness proofs:
 * - a 'reserved' batch with ZERO attempts has definitively signed nothing
 * (record-before-broadcast), so the chain has never seen the nonce; or
 * - a 'submitted' batch the CALLER has proven both unmined and
 * un-broadcastable : every attempt unmined with no receipt, the
 * signer's on-chain nonce ('latest') still EQUALS this nonce, and the
 * recorded gasLimit exceeds what the sole RPC will accept — so the signed
 * tx is deterministically rejected, gossiped to no mempool the runner can
 * reach, and cannot mine. `resolveBatch`'s oversized-batch reclaim.
 * The head-of-sequence guard is what makes the release safe regardless of which
 * caller: only the most recent allocation may be returned, and never below base.
 */
export async function releaseUnusedNonce(
  db: SettlementDb,
  params: { cycleId: string; workerId: string; nowMs: number; nonce: number },
): Promise<{ released: boolean }> {
  const cycleRef = db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(params.cycleId);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(cycleRef);
    const data = snap.exists ? snap.data() : undefined;
    if (!isCycleDoc(data)) return { released: false };
    const cycle = data as unknown as SettlementCycleDoc;
    if (cycle.status !== 'active' || cycle.lease.owner !== params.workerId
      || cycle.lease.expires_at_ms <= params.nowMs) {
      return { released: false };
    }
    // Only the most recent allocation may be returned, and never below base.
    if (cycle.next_nonce !== params.nonce + 1 || params.nonce < cycle.base_nonce) {
      return { released: false };
    }
    txn.set(cycleRef, {
      ...cycle,
      next_nonce: params.nonce,
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { released: true };
  });
}

/** Mark a reservation dead (binding died: epoch crossed / policy changed). */
export async function markBatchDead(
  db: SettlementDb,
  params: { batchId: string; nowMs: number; reason: string },
): Promise<{ marked: boolean }> {
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(batchRef);
    const data = snap.exists ? snap.data() : undefined;
    if (!isBatchDoc(data)) return { marked: false };
    const batch = data as unknown as SettlementBatchDoc;
    if (batch.applied || batch.status === 'confirmed') return { marked: false };
    // MONEY-SAFETY: a batch with a SEEN successful settlement receipt is never marked
    // dead — that would return claims to the queue that the chain may already have paid. Such
    // a receipt is cleared (`clearMinedReceipt`) only on positive evidence it is not canonical.
    if (batch.attempts.some((a) => a.mined?.status === 'success' && a.kind !== 'cancel')) {
      return { marked: false };
    }
    const memberRefs = batch.members.map((member) => db.collection(CLAIM_LEDGER_COLLECTION)
      .doc(claimKeyOf(member.pe_id, member.leg, member.claim_kind ?? 'act')));
    const memberSnaps: SettlementDocSnap[] = [];
    for (const ref of memberRefs) memberSnaps.push(await txn.get(ref));
    txn.set(batchRef, {
      ...batch,
      status: 'dead',
      dead_reason: params.reason,
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    memberRefs.forEach((ref, index) => {
      const row = memberSnaps[index].exists ? memberSnaps[index].data() ?? {} : {};
      if (row.reserved_batch_id === batch.batch_id) {
        txn.set(ref, { reserved_batch_id: null }, { merge: true });
      }
    });
    return { marked: true };
  });
}

/**
 * retire every NEVER-BROADCAST reservation stranded in a CLOSED cycle.
 *
 * `sendAttempt` signs, then `recordAttempt`s, then broadcasts — the attempt is durable BEFORE
 * any byte leaves the process. A batch still `reserved` with ZERO recorded attempts therefore
 * never reached the network under any nonce, so none of its claims can have settled through it.
 * When its cycle is closed (completed / stopped), no worker can ever resume it
 * (`acquireCycleLease` refuses a non-`active` cycle forever), yet its members stay reserved, and
 * every later run aborts on them (`claim_not_settleable`) or refuses to supersede the day's
 * cycle. Twice in two days (0x5505…, 0x1af7…) that needed an operator; this retires exactly
 * that provably-dead shape and nothing else.
 *
 * Deliberately NOT retired: a `submitted` batch (an attempt may be live on chain — operator's
 * call), a batch with ANY attempt, an applied batch, and anything in an `active` cycle (the
 * same-cycle continuation owns those, including releasing the nonce so the cycle's sequence
 * keeps no gap). Each retirement is one transaction that re-reads the batch and its cycle, so
 * a concurrent `recordAttempt` either lands first (attempts > 0 → skipped) or finds the batch
 * dead (`batch_closed` → refused before broadcast).
 */
export const NEVER_BROADCAST_ORPHAN_REASON = 'orphaned_reservation_never_broadcast';

export async function retireNeverBroadcastOrphans(
  db: SettlementDb,
  params: { nowMs: number },
): Promise<{ retired: string[] }> {
  const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION).where('status', '==', 'reserved').get();
  const retired: string[] = [];
  for (const data of snap.docs.map((doc) => doc.data()).filter(isBatchDoc)) {
    const batchId = (data as unknown as SettlementBatchDoc).batch_id;
    if (await retireIfNeverBroadcastOrphan(db, { batchId, nowMs: params.nowMs })) retired.push(batchId);
  }
  return { retired };
}

/**
 * One batch, one transaction: re-reads the batch and its cycle, so the query above being stale
 * (an attempt recorded, or the cycle re-leased, since it ran) can never retire a live batch.
 */
export async function retireIfNeverBroadcastOrphan(
  db: SettlementDb,
  params: { batchId: string; nowMs: number },
): Promise<boolean> {
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  return db.runTransaction<boolean>(async (txn) => {
    const batchSnap = await txn.get(batchRef);
    const batchData = batchSnap.exists ? batchSnap.data() : undefined;
    if (!isBatchDoc(batchData)) return false;
    const batch = batchData as unknown as SettlementBatchDoc;
    const cycleSnap = await txn.get(db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(batch.cycle_id));
    const cycleData = cycleSnap.exists ? cycleSnap.data() : undefined;
    if (!isCycleDoc(cycleData)) return false;
    const cycle = cycleData as unknown as SettlementCycleDoc;
    if (batch.status !== 'reserved' || batch.applied || batch.attempts.length !== 0) return false;
    if (cycle.status === 'active') return false;
    const memberRefs = batch.members.map((member) => db.collection(CLAIM_LEDGER_COLLECTION)
      .doc(claimKeyOf(member.pe_id, member.leg, member.claim_kind ?? 'act')));
    const memberSnaps: SettlementDocSnap[] = [];
    for (const ref of memberRefs) memberSnaps.push(await txn.get(ref));
    txn.set(batchRef, {
      ...batch,
      status: 'dead',
      dead_reason: `${NEVER_BROADCAST_ORPHAN_REASON}: 0 attempts in closed cycle ${cycle.cycle_id} (${cycle.status})`,
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    memberRefs.forEach((ref, index) => {
      const row = memberSnaps[index].exists ? memberSnaps[index].data() ?? {} : {};
      if (row.reserved_batch_id === batch.batch_id) {
        txn.set(ref, { reserved_batch_id: null }, { merge: true });
      }
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Ledger writebacks (post-apply, chunked, repairable)
// ---------------------------------------------------------------------------

/**
 * Mark every member claim settled. Chunked non-transactional writes (a batch
 * may exceed the 500-write transaction cap); idempotent and convergent —
 * repeated runs write the same terminal state. Call ONLY for applied batches.
 */
export interface PeHistoryWritebackTally {
  readonly minted: number;
  readonly already_minted: number;
  readonly refused_terminal: number;
  readonly missing: number;
  readonly unexpected_status: number;
  /**
   * a split PE whose PE-level flip was DEFERRED this batch because a sibling leg is
   * still unsettled. Not a refusal and not an error: the flip fires (once) with the batch that
   * settles the PE's LAST leg. Counted so an operator can see partial-settlement in flight.
   */
  readonly deferred_partial: number;
  /** top-up members this batch settled (additive enrichment only; no status flip). */
  readonly topup_settled: number;
}

/**
 * is EVERY ledger leg of this PE settled? The per-leg `settled:true` writes for the
 * current batch commit before this is read, so this observes them. Fail-closed toward
 * DEFERRING the PE-level flip: a PE with no rows (impossible for a member, but guarded) or any
 * unsettled sibling leg returns false, so a partially-paid split act is never marked 'minted'.
 */
/**
 * Have all ACT legs of a PE settled? Top-up rows are EXCLUDED on purpose : a PE's
 * `mint_status` describes the settlement of its act, and an unsettled top-up registered
 * beside an already-settled act must not hold the act's status at `eligible`.
 */
async function allLegsSettled(db: SettlementDb, peId: string): Promise<boolean> {
  const peKey = normalizePeId(peId);
  const rows = await db.collection(CLAIM_LEDGER_COLLECTION)
    .where('pe_key', '==', peKey)
    .get();
  const actRows = rows.docs
    .map((doc) => doc.data() ?? {})
    .filter((row) => row.claim_kind !== 'attestation_topup');
  // THE FROZEN LEG SET decides "fully paid", never "whatever rows exist". A PE whose
  // agent leg was deferred while its beneficiary leg settled has only settled rows, and the
  // pre- rule flipped it `minted` with the agent leg never offered again (a short act).
  const splitSnap = await db.collection(PE_SPLIT_COLLECTION).doc(peKey).get();
  if (splitSnap.exists) {
    const parsed = parseFrozenSplit(splitSnap.data(), peKey);
    // An unreadable split is not "no split": fail closed toward deferring the flip.
    if (parsed.kind !== 'valid') return false;
    return parsed.split.legs.every((leg) => actRows.some((row) => row.leg === leg.leg
      && row.claim_id === leg.claim_id
      && row.settled === true));
  }
  if (actRows.length === 0) return false;
  if (!actRows.every((row) => row.settled === true)) return false;
  // LEGACY (rows registered before, no split doc). The Genesis lane pays one fixed
  // `sole` leg per grant and never splits; its rule is unchanged.
  if (actRows.every((row) => row.lane === 'genesis')) return true;
  return legacyActSetComplete(db, peId, actRows);
}

/**
 * may a PRE- standard act set (no frozen split) be treated as fully paid?
 *
 * Deterministic and fail-safe toward NOT flipping `minted` while short. The legs of such a set
 * were each cut from the PE's settleable total at their own registration — the sealed base
 * (`record_points_atomic`) or, after a recognized corroboration, the lifted total — so a
 * COMPLETE set sums to exactly the base or to at least the lifted total. Anything smaller is a
 * partial set (a crash between legs, or a deferred leg whose sibling settled) and stays
 * `eligible`, where the leg-sum audit (`leg-sum-audit.ts`) finds and repairs it. A set strictly
 * between base and lifted is a MIXED set (legs cut from two totals); it is not flipped either,
 * and the audit reports it. A PE with no enrichment row returns true so the existing `missing`
 * accounting in `writeLedgerSettlement` fires (nothing can be flipped on a missing doc).
 */
async function legacyActSetComplete(
  db: SettlementDb,
  peId: string,
  actRows: readonly Record<string, unknown>[],
): Promise<boolean> {
  const snap = await db.collection(PE_HISTORY_COLLECTION).doc(peId).get();
  if (!snap.exists) return true;
  const history = snap.data() ?? {};
  // Only an `eligible` row can be flipped; any other status is refused and counted by the
  // writeback's own precondition, so completeness is moot and the existing tally stands.
  if (history.mint_status !== 'eligible') return true;
  const base = history.record_points_atomic;
  if (typeof base !== 'string' || !ATOMIC.test(base)) return false;
  const lifted = corroborationLiftedRecordPointsAtomic(history as unknown as PEHistoryDocument);
  let sum = 0n;
  for (const row of actRows) {
    const points = row.record_points_atomic;
    if (typeof points !== 'string' || !ATOMIC.test(points)) return false;
    sum += BigInt(points);
  }
  if (sum === BigInt(base)) return true;
  return ATOMIC.test(lifted) && sum >= BigInt(lifted);
}

export async function writeLedgerSettlement(
  db: SettlementDb,
  params: { batchId: string; nowMs: number },
): Promise<{ written: number; peHistory: PeHistoryWritebackTally }> {
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  const snap = await batchRef.get();
  const data = snap.exists ? snap.data() : undefined;
  if (!isBatchDoc(data)) throw new Error('writeLedgerSettlement: unknown batch');
  const batch = data as unknown as SettlementBatchDoc;
  if (!batch.applied || batch.confirmed_tx_hash === null) {
    throw new Error('writeLedgerSettlement: batch is not applied');
  }
  const ledger = db.collection(CLAIM_LEDGER_COLLECTION);
  let written = 0;
  for (let start = 0; start < batch.members.length; start += LEDGER_WRITEBACK_CHUNK) {
    const chunk = batch.members.slice(start, start + LEDGER_WRITEBACK_CHUNK);
    const writer = db.batch();
    for (const member of chunk) {
      writer.set(ledger.doc(claimKeyOf(member.pe_id, member.leg, member.claim_kind ?? 'act')), {
        settled: true,
        reserved_batch_id: null,
        settled_batch_id: batch.batch_id,
        settled_tx_hash: batch.confirmed_tx_hash,
        settled_at: params.nowMs,
        // PE METER: a settled meter claim's row goes once nothing can re-plan it (ledger-retention.ts).
        ...settledLedgerRowExpiry(member.pe_id, params.nowMs),
      }, { merge: true });
    }
    await writer.commit();
    written += chunk.length;
  }

  // pe_history is a claim SOURCE (the standard inlet selects
  // `mint_status == 'eligible'`), so a settled PE must leave the ready state
  // the same eligibility fence that refuses the 31 legacy 'minted'
  // PEs then refuses these. DERIVED RECORD ONLY: the batch doc stays the
  // authoritative settled state, and this write grants nothing (an
  // `eligible`/`minted` field is never mint authority). Refusals never wedge
  // `writebacks_complete` — a missing enrichment doc must not re-run repair
  // forever — but each is counted and logged; `ineligible` is terminal and is
  // NEVER overwritten, so a settled batch naming one is itself an alarm.
  const tally = {
    minted: 0, already_minted: 0, refused_terminal: 0, missing: 0, unexpected_status: 0,
    deferred_partial: 0, topup_settled: 0,
  };
  const seenPe = new Set<string>();
  const seenTopupPe = new Set<string>();
  // PE METER: a meter claim has no pe_history row; its pending claim and act rows are written back.
  const meterClaimKeys: string[] = [];
  for (const member of batch.members) {
    if (isMeterClaimKey(member.pe_id)) {
      meterClaimKeys.push(member.pe_id);
      continue;
    }
    if (member.claim_kind === 'attestation_topup') {
      // a settled top-up leaves the PE's `mint_status` exactly as it is (the act
      // already minted, or is settling in this same batch under its own member) and
      // records itself as ADDITIVE enrichment only — never a status transition, never a
      // touch on the sealed snapshot. Merge-only, best-effort, once per PE per batch.
      if (seenTopupPe.has(member.pe_id)) continue;
      seenTopupPe.add(member.pe_id);
      try {
        // PE METER: never recreate a row the legacy migration retired (its top-up was settled
        // before it could retire, so a missing row has nothing left to enrich).
        const enriched = await enrichLegacyRowIfPresent(db, member.pe_id, () => ({
          attestation_topup_settled_batch_id: batch.batch_id,
          attestation_topup_settled_tx_hash: batch.confirmed_tx_hash,
          attestation_topup_settled_at: params.nowMs,
        }));
        if (!enriched) continue;
        tally.topup_settled += 1;
      } catch (err) {
        console.error(`[settlement-writeback] top-up enrichment write failed for PE ${member.pe_id} (batch ${batch.batch_id}):`, err);
      }
      continue;
    }
    if (seenPe.has(member.pe_id)) continue;
    seenPe.add(member.pe_id);
    // ROOT-DEFECT FIX — defer the PE-level `mint_status` flip until EVERY leg of this PE
    // is settled. A split act has two ledger legs (agent + beneficiary) that settle in
    // DIFFERENT batches (the planner orders recipients by address, so the two contributors land
    // apart). Flipping the PE to 'minted' after only the FIRST leg confirms is what refused the
    // still-unsettled sibling leg as `already_minted` and stranded the human 80% legs. The
    // per-leg `settled:true` writes for THIS batch committed just above, so `allLegsSettled`
    // sees them; while a sibling leg is unsettled the PE stays 'eligible', which keeps the inlet
    // and the approval gate seeing the remaining leg. The flip (and its aggregate delta) fires
    // once, with the batch that settles the LAST leg — exactly when the PE is fully paid.
    if (!(await allLegsSettled(db, member.pe_id))) {
      tally.deferred_partial += 1;
      continue;
    }
    // M5 — the `eligible` → `minted` flip zeroes this row's settlement
    // projection, so it goes through the aggregate-aware mutation primitive:
    // the row is re-read in a transaction (the status checks below run on THAT
    // read, not a stale one), the aggregate delta is applied, and the patch is
    // written — atomically. The tally semantics are unchanged: only a row that
    // reads `eligible` at commit time is reclassified.
    const { outcome, before } = await mutatePeHistoryRowWithAggregate(db, member.pe_id, {
      mint_status: 'minted',
      settled_batch_id: batch.batch_id,
      settled_tx_hash: batch.confirmed_tx_hash,
      settled_at: params.nowMs,
      minted_via: 'pvt9_settlement',
    }, {
      nowMs: params.nowMs,
      expect: (row) => row.mint_status === 'eligible',
    });
    if (outcome === 'missing') {
      tally.missing += 1;
      console.error(`[settlement-writeback] pe_history doc missing for settled PE ${member.pe_id} (batch ${batch.batch_id})`);
      continue;
    }
    if (outcome === 'precondition_failed') {
      const status = before?.mint_status;
      if (status === 'minted') {
        tally.already_minted += 1;
        continue;
      }
      if (status === 'ineligible') {
        tally.refused_terminal += 1;
        console.error(`[settlement-writeback] settled PE ${member.pe_id} reads terminal mint_status 'ineligible' — refusing to reclassify (batch ${batch.batch_id})`);
        continue;
      }
      tally.unexpected_status += 1;
      console.error(`[settlement-writeback] settled PE ${member.pe_id} reads unexpected mint_status '${String(status)}' — refusing to overwrite (batch ${batch.batch_id})`);
      continue;
    }
    tally.minted += 1;
  }
  if (meterClaimKeys.length > 0) {
    const { settleMeterClaims } = await import('../../meter/meter-settlement');
    const meterTally = await settleMeterClaims(db as unknown as import('firebase-admin/firestore').Firestore, {
      claimKeys: meterClaimKeys,
      batchId: batch.batch_id,
      txHash: batch.confirmed_tx_hash,
      nowMs: params.nowMs,
    });
    if (meterTally.claims_missing > 0) {
      console.error(`[settlement-writeback] meter tally for batch ${batch.batch_id}: ${JSON.stringify(meterTally)}`);
    }
  }
  if (tally.missing > 0 || tally.refused_terminal > 0 || tally.unexpected_status > 0) {
    console.error(`[settlement-writeback] pe_history tally for batch ${batch.batch_id}: ${JSON.stringify(tally)}`);
  }

  await batchRef.set({ writebacks_complete: true, updated_at: params.nowMs }, { merge: true });

  // notify each agent recipient that their PVT landed on-chain (D1 webhook
  // + D2 inbox). Best-effort and fully isolated: dynamic import keeps this money-
  // path file's static deps unchanged, and any failure is swallowed — the mint is
  // already durable, so a missed notice must never fail the write-back.
  try {
    const { enqueueSettlementNotifications } = await import('./settlement-notify');
    await enqueueSettlementNotifications(db as unknown as import('firebase-admin/firestore').Firestore, {
      batch_id: batch.batch_id,
      epoch: batch.epoch,
      lane: batch.lane,
      confirmed_tx_hash: batch.confirmed_tx_hash,
    });
  } catch (err) {
    console.error('[settlement-writeback] settlement notify failed (non-fatal):', err);
  }

  return { written, peHistory: tally };
}

/**
 * Crash repair: finish ledger writebacks for every applied batch that did not
 * complete them. MUST run before work selection — this is what guarantees a
 * crash between apply and writeback can never re-propose a settled PE.
 */
export async function repairLedgerWritebacks(
  db: SettlementDb,
  params: { nowMs: number },
): Promise<{ repairedBatches: number }> {
  const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION)
    .where('applied', '==', true)
    .where('writebacks_complete', '==', false)
    .get();
  let repaired = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!isBatchDoc(data)) continue;
    await writeLedgerSettlement(db, { batchId: (data as unknown as SettlementBatchDoc).batch_id, nowMs: params.nowMs });
    repaired += 1;
  }
  return { repairedBatches: repaired };
}

/**
 * Batches needing resolution on resume: 'submitted' (in-flight attempts to
 * reconcile against receipts), 'mined' (a success receipt seen but not yet at the
 * safe-head depth), and 'reserved' orphans (a crash between reservation and first record —
 * their allocated nonce would otherwise be a permanent gap that wedges every later
 * transaction).
 */
export const UNRESOLVED_BATCH_STATUSES = ['submitted', 'mined', 'reserved'] as const;

function sortUnresolved(batches: SettlementBatchDoc[]): SettlementBatchDoc[] {
  return batches.sort((a, b) => (a.reserved_nonce !== b.reserved_nonce
    ? a.reserved_nonce - b.reserved_nonce
    : BigInt(a.cursor_start) < BigInt(b.cursor_start) ? -1 : 1));
}

export async function listUnresolvedBatches(
  db: SettlementDb,
  cycleId: string,
): Promise<SettlementBatchDoc[]> {
  const out: SettlementBatchDoc[] = [];
  for (const status of UNRESOLVED_BATCH_STATUSES) {
    const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION)
      .where('cycle_id', '==', cycleId)
      .where('status', '==', status)
      .get();
    for (const data of snap.docs.map((doc) => doc.data()).filter(isBatchDoc)) {
      out.push(data as unknown as SettlementBatchDoc);
    }
  }
  return sortUnresolved(out);
}

/**
 * every unresolved batch in EVERY cycle. The per-cycle list above is what let a
 * `submitted` batch strand forever inside a closed cycle: nothing ever looked outside the
 * cycle being run. The cross-cycle reconciler starts here.
 */
export async function listAllUnresolvedBatches(db: SettlementDb): Promise<SettlementBatchDoc[]> {
  const out: SettlementBatchDoc[] = [];
  for (const status of UNRESOLVED_BATCH_STATUSES) {
    const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION).where('status', '==', status).get();
    for (const data of snap.docs.map((doc) => doc.data()).filter(isBatchDoc)) {
      out.push(data as unknown as SettlementBatchDoc);
    }
  }
  return sortUnresolved(out);
}

// ---------------------------------------------------------------------------
// claim holds (poisoned-claim isolation)
// ---------------------------------------------------------------------------

/** First hold: past the next daily run. Doubles per repeat, capped at a week. */
export const CLAIM_HOLD_BASE_MS = 6 * 60 * 60 * 1000;
export const CLAIM_HOLD_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export function claimHoldBackoffMs(count: number): number {
  const exponent = Math.max(0, Math.min(count - 1, 20));
  return Math.min(CLAIM_HOLD_BASE_MS * 2 ** exponent, CLAIM_HOLD_MAX_MS);
}

/** Whether a ledger row is held out of selection at `nowMs`. */
export function isClaimHeld(row: Pick<ClaimLedgerRow, 'hold'>, nowMs: number): boolean {
  return row.hold !== undefined && row.hold !== null && row.hold.retry_at_ms > nowMs;
}

/**
 * Hold claims the runner isolated as the cause of a refused/unsettleable batch, so they leave
 * the head of the queue and the rest settles. Only an UNSETTLED, UNRESERVED row is held — a
 * hold never touches a claim that is paid or in flight. Each row is its own transaction.
 */
export async function holdClaims(
  db: SettlementDb,
  params: {
    nowMs: number;
    holds: ReadonlyArray<{ readonly claimKey: string; readonly reason: string; readonly detail: string }>;
  },
): Promise<{ held: string[] }> {
  const held: string[] = [];
  for (const hold of params.holds) {
    const ref = db.collection(CLAIM_LEDGER_COLLECTION).doc(hold.claimKey);
    const applied = await db.runTransaction<boolean>(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return false;
      const row = (snap.data() ?? {}) as unknown as ClaimLedgerRow;
      if (row.settled !== false) return false;
      if (typeof row.reserved_batch_id === 'string' && row.reserved_batch_id.length > 0) return false;
      const count = (row.hold?.count ?? 0) + 1;
      const next: ClaimHold = {
        reason: hold.reason,
        detail: hold.detail.slice(0, 500),
        held_at_ms: params.nowMs,
        retry_at_ms: params.nowMs + claimHoldBackoffMs(count),
        count,
      };
      // `held` is a flat, equality-queryable mirror of `hold !== null`: the reconciler asks the
      // kernel about every held claim each run (`reconcileHeldClaims`), and a nested-field
      // query would need an index this collection does not carry.
      txn.set(ref, { hold: next, held: true }, { merge: true });
      return true;
    });
    if (applied) held.push(hold.claimKey);
  }
  return { held };
}

/** unsettled rows currently (or formerly) held, for the kernel re-check. Bounded. */
export async function listHeldClaims(db: SettlementDb, limit: number): Promise<ClaimLedgerRow[]> {
  const snap = await db.collection(CLAIM_LEDGER_COLLECTION)
    .where('held', '==', true)
    .where('settled', '==', false)
    .limit(limit)
    .get();
  return snap.docs
    .map((doc) => doc.data())
    .filter((data): data is Record<string, unknown> => data !== undefined)
    .map((data) => data as unknown as ClaimLedgerRow);
}

export interface ChainSettledClaim {
  readonly claimKey: string;
  /** The claim id the kernel was asked about; must equal the row's own `claim_id`. */
  readonly claimId: string;
}

export interface ChainSettlementEvidence {
  /** The safe block at which the kernel's `claimSettled` read true. */
  readonly safe_block: number;
  readonly reason: string;
  /**
   * The batch whose CONCLUSION produced the evidence (a batch concluded dead whose members the
   * kernel reads paid), or null (a held claim, an isolated claim). Context only: it is NEVER
   * written as `settled_batch_id` — no receipt shows that batch paid — and it is the one batch
   * whose own reservation the evidence may clear.
   */
  readonly concluding_batch_id: string | null;
}

export interface ChainEvidenceSettlementResult {
  readonly settled: string[];
  /** Already settled, reserved by another batch, unknown, or a claim-id mismatch. */
  readonly skipped: Array<{ readonly claimKey: string; readonly why: string }>;
  readonly peHistoryMinted: number;
  readonly peHistoryDeferredPartial: number;
}

/**
 * record as SETTLED a claim the KERNEL reads paid at the safe block, when the ledger
 * never learned it (a settle whose receipt a lagging replica never returned; a claim paid by a
 * batch this signer never recorded; a legacy batch concluded without its receipt).
 *
 * The evidence is the kernel's own mint-once map (`claimSettled`) read AT the safe head — the
 * same depth every other settlement conclusion uses — so the claim can never be offered again
 * (the kernel would refuse it anyway) and it never loops in a hold. Nothing is minted here and
 * nothing is sent: this only brings the durable record into line with the chain.
 *
 * Per row, one transaction: only an UNSETTLED row whose `claim_id` is the one the kernel was
 * asked about, and which no OTHER live batch reserves, is written. `pe_history` then follows the
 * writeback's own rule — the act PE flips `eligible` → `minted` (through the aggregate-aware
 * mutator) only once EVERY frozen leg is settled; `minted_via: 'pvt9_chain_evidence'` keeps it
 * distinguishable from a receipt-backed settle (and out of `revertReorgedBatch`'s reach).
 */
export async function settleClaimsFromChainEvidence(
  db: SettlementDb,
  params: {
    nowMs: number;
    claims: ReadonlyArray<ChainSettledClaim>;
    evidence: ChainSettlementEvidence;
  },
): Promise<ChainEvidenceSettlementResult> {
  const settled: string[] = [];
  const skipped: Array<{ claimKey: string; why: string }> = [];
  const settledRows: ClaimLedgerRow[] = [];
  for (const claim of params.claims) {
    const ref = db.collection(CLAIM_LEDGER_COLLECTION).doc(claim.claimKey);
    const outcome = await db.runTransaction<{ ok: true; row: ClaimLedgerRow } | { ok: false; why: string }>(
      async (txn) => {
        const snap = await txn.get(ref);
        if (!snap.exists) return { ok: false, why: 'row_missing' };
        const row = (snap.data() ?? {}) as unknown as ClaimLedgerRow;
        if (row.settled !== false) return { ok: false, why: 'already_settled' };
        if (typeof row.claim_id !== 'string' || row.claim_id.toLowerCase() !== claim.claimId.toLowerCase()) {
          return { ok: false, why: 'claim_id_mismatch' };
        }
        const reservedBy = typeof row.reserved_batch_id === 'string' && row.reserved_batch_id.length > 0
          ? row.reserved_batch_id
          : null;
        if (reservedBy !== null && reservedBy !== params.evidence.concluding_batch_id) {
          return { ok: false, why: `reserved_by:${reservedBy}` };
        }
        txn.set(ref, {
          settled: true,
          reserved_batch_id: null,
          // Truthful attribution: no batch of ours is known to have paid this claim (no receipt),
          // so none is named. The kernel's `claimSettled` at the safe block is the evidence.
          settled_batch_id: null,
          settled_tx_hash: null,
          settled_at: params.nowMs,
          hold: null,
          held: false,
          settled_via: 'chain_evidence',
          ...settledLedgerRowExpiry(row.pe_id, params.nowMs),
          chain_settlement_evidence: {
            safe_block: params.evidence.safe_block,
            reason: params.evidence.reason.slice(0, 500),
            concluding_batch_id: params.evidence.concluding_batch_id,
            recorded_at_ms: params.nowMs,
          },
        }, { merge: true });
        return { ok: true, row };
      },
    );
    if (outcome.ok) {
      settled.push(claim.claimKey);
      settledRows.push(outcome.row);
    } else {
      skipped.push({ claimKey: claim.claimKey, why: outcome.why });
    }
  }

  let peHistoryMinted = 0;
  let peHistoryDeferredPartial = 0;
  const seenAct = new Set<string>();
  const seenTopup = new Set<string>();
  const meterEvidenceKeys = settledRows.filter((row) => isMeterClaimKey(row.pe_id)).map((row) => row.pe_id);
  if (meterEvidenceKeys.length > 0) {
    const { settleMeterClaims } = await import('../../meter/meter-settlement');
    const meterTally = await settleMeterClaims(db as unknown as import('firebase-admin/firestore').Firestore, {
      claimKeys: meterEvidenceKeys, batchId: '', txHash: null, nowMs: params.nowMs, via: 'pvt9_chain_evidence',
    });
    peHistoryMinted += meterTally.acts_minted;
  }
  for (const row of settledRows) {
    if (isMeterClaimKey(row.pe_id)) continue;
    if (row.claim_kind === 'attestation_topup') {
      if (seenTopup.has(row.pe_id)) continue;
      seenTopup.add(row.pe_id);
      try {
        // PE METER: never recreate a row the legacy migration retired (its top-up was settled
        // before it could retire, so a missing row has nothing left to enrich).
        await enrichLegacyRowIfPresent(db, row.pe_id, () => ({
          attestation_topup_settled_batch_id: null,
          attestation_topup_settled_tx_hash: null,
          attestation_topup_settled_at: params.nowMs,
          attestation_topup_settled_via: 'pvt9_chain_evidence',
        }));
      } catch (err) {
        console.error(`[chain-evidence-settlement] top-up enrichment write failed for PE ${row.pe_id}:`, err);
      }
      continue;
    }
    if (seenAct.has(row.pe_id)) continue;
    seenAct.add(row.pe_id);
    if (!(await allLegsSettled(db, row.pe_id))) {
      peHistoryDeferredPartial += 1;
      continue;
    }
    const { outcome } = await mutatePeHistoryRowWithAggregate(db, row.pe_id, {
      mint_status: 'minted',
      settled_batch_id: null,
      settled_evidence_safe_block: params.evidence.safe_block,
      settled_tx_hash: null,
      settled_at: params.nowMs,
      minted_via: 'pvt9_chain_evidence',
    }, {
      nowMs: params.nowMs,
      expect: (history) => history.mint_status === 'eligible',
    });
    if (outcome === 'applied') peHistoryMinted += 1;
  }
  return { settled, skipped, peHistoryMinted, peHistoryDeferredPartial };
}

/**
 * clear a reservation whose batch is DEAD (or gone). `markBatchDead` clears member
 * reservations in the same transaction, so this is a repair path only; a reservation naming a
 * live or confirmed batch is never touched.
 */
export async function clearStaleReservation(
  db: SettlementDb,
  params: { claimKey: string; batchId: string },
): Promise<{ cleared: boolean }> {
  const rowRef = db.collection(CLAIM_LEDGER_COLLECTION).doc(params.claimKey);
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  return db.runTransaction(async (txn) => {
    const [rowSnap, batchSnap] = [await txn.get(rowRef), await txn.get(batchRef)];
    const row = rowSnap.exists ? (rowSnap.data() ?? {}) : null;
    if (row === null || row.reserved_batch_id !== params.batchId) return { cleared: false };
    const batchData = batchSnap.exists ? batchSnap.data() : undefined;
    if (isBatchDoc(batchData) && (batchData as unknown as SettlementBatchDoc).status !== 'dead') {
      return { cleared: false };
    }
    txn.set(rowRef, { reserved_batch_id: null }, { merge: true });
    return { cleared: true };
  });
}

// ---------------------------------------------------------------------------
// applied-batch finality: verification and reorg reversal
// ---------------------------------------------------------------------------

/** Stamp an applied batch as verified canonical at safe depth (the applied-batch sweep). */
export async function markBatchFinalityVerified(
  db: SettlementDb,
  params: { batchId: string; nowMs: number; blockNumber: number; blockHash: string },
): Promise<{ marked: boolean }> {
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(batchRef);
    const data = snap.exists ? snap.data() : undefined;
    if (!isBatchDoc(data)) return { marked: false };
    const batch = data as unknown as SettlementBatchDoc;
    if (!batch.applied || batch.status !== 'confirmed') return { marked: false };
    txn.set(batchRef, {
      ...batch,
      confirmed_block_number: params.blockNumber,
      confirmed_block_hash: params.blockHash.toLowerCase(),
      finality_verified: true,
      finality_open: false,
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { marked: true };
  });
}

/** The numeric cursor index a batch carries (omitted beyond 2^53, where only the full scan covers it). */
function cursorEndIndexOf(cursorEnd: bigint): { cursor_end_n?: number } {
  return cursorEnd >= 0n && cursorEnd <= BigInt(Number.MAX_SAFE_INTEGER) ? { cursor_end_n: Number(cursorEnd) } : {};
}

/** Per signer: whether every pre-existing batch has been stamped with the sweep's index fields. */
export const FINALITY_SWEEP_STATE_COLLECTION = 'pvt9_finality_sweep_v1';
/** Batches touched within this window are always examined from their own fields. */
export const FINALITY_SWEEP_RECENT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * PE METER cost pass (no job reads in proportion to history) — the applied batches the finality
 * sweep must examine, read from an INDEX instead of every cycle and batch the signer ever settled:
 *   - `finality_open == true` — applied, confirmed, not yet finality-verified;
 *   - `cursor_end_n > chainCursor` — any batch whose range the chain's cursor does not cover;
 *   - `updated_at` within the last two days — defense in depth against a stale index.
 * Every set is bounded by work in flight or by a window, never by history. The candidates and their filter are
 * exactly the pre-meter sweep's (applied ∧ confirmed ∧ (unverified ∨ uncovered), this signer's
 * cycles only).
 *
 * The first run for a signer (no state doc) does the pre-meter full scan once, stamping
 * `finality_open` / `cursor_end_n` on every batch of the signer's cycles that lacks them, then
 * records the signer as indexed; every later run reads only the index.
 */
export async function listFinalitySweepCandidates(
  db: SettlementDb,
  params: { readonly signer: string; readonly chainCursor: bigint | null; readonly nowMs: number },
): Promise<SettlementBatchDoc[]> {
  const signer = params.signer.toLowerCase();
  const isCandidate = (batch: SettlementBatchDoc): boolean => {
    if (!batch.applied || batch.status !== 'confirmed') return false;
    const uncovered = params.chainCursor !== null && BigInt(batch.cursor_end) > params.chainCursor;
    return batch.finality_verified !== true || uncovered;
  };
  const stateRef = db.collection(FINALITY_SWEEP_STATE_COLLECTION).doc(signer);
  const state = await stateRef.get();
  if (!state.exists || (state.data() ?? {}).indexed !== true) {
    const candidates: SettlementBatchDoc[] = [];
    const cycles = await db.collection(SETTLEMENT_CYCLES_COLLECTION).where('signer', '==', signer).get();
    for (const cycleDoc of cycles.docs) {
      const data = cycleDoc.data();
      if (data === undefined) continue;
      const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION).where('cycle_id', '==', String(data.cycle_id)).get();
      const stamp = db.batch();
      let stamped = 0;
      for (const doc of snap.docs) {
        const raw = doc.data();
        if (!isBatchDoc(raw)) continue;
        const batch = raw as unknown as SettlementBatchDoc;
        if (isCandidate(batch)) candidates.push(batch);
        if (batch.finality_open === undefined || batch.cursor_end_n === undefined) {
          stamp.set(db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(batch.batch_id), {
            finality_open: batch.applied && batch.status === 'confirmed' && batch.finality_verified !== true,
            ...cursorEndIndexOf(BigInt(batch.cursor_end)),
          }, { merge: true });
          stamped += 1;
        }
      }
      if (stamped > 0) await stamp.commit();
    }
    const done = db.batch();
    done.set(stateRef, { indexed: true, indexed_at_ms: params.nowMs });
    await done.commit();
    return candidates;
  }
  const found = new Map<string, SettlementBatchDoc>();
  const collect = (snap: SettlementQuerySnap): void => {
    for (const doc of snap.docs) {
      const raw = doc.data();
      if (isBatchDoc(raw)) found.set(String(raw.batch_id), raw as unknown as SettlementBatchDoc);
    }
  };
  collect(await (db.collection(SETTLEMENT_BATCHES_COLLECTION) as SettlementQuery).where('finality_open', '==', true).get());
  if (params.chainCursor !== null && params.chainCursor <= BigInt(Number.MAX_SAFE_INTEGER)) {
    collect(await (db.collection(SETTLEMENT_BATCHES_COLLECTION) as SettlementQuery)
      .where('cursor_end_n', '>=', Number(params.chainCursor) + 1).get());
  }
  // Defense in depth against index drift: every batch touched recently is judged from its own
  // fields (a batch a pre-index revision applied during a rolling deploy, or one edited out of
  // band). Bounded by a window, never by history.
  collect(await (db.collection(SETTLEMENT_BATCHES_COLLECTION) as SettlementQuery)
    .where('updated_at', '>=', params.nowMs - FINALITY_SWEEP_RECENT_WINDOW_MS).get());
  const cycleSigner = new Map<string, string | null>();
  const out: SettlementBatchDoc[] = [];
  for (const batch of found.values()) {
    if (!isCandidate(batch)) continue;
    if (!cycleSigner.has(batch.cycle_id)) {
      const c = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(batch.cycle_id).get();
      const data = c.exists ? c.data() : undefined;
      cycleSigner.set(batch.cycle_id, typeof data?.signer === 'string' ? data.signer.toLowerCase() : null);
    }
    if (cycleSigner.get(batch.cycle_id) === signer) out.push(batch);
  }
  return out;
}

export type RevertReorgedResult =
  | { readonly kind: 'reverted'; readonly peHistoryReverted: number }
  | { readonly kind: 'refused'; readonly reason: 'batch_unknown' | 'not_applied' | 'not_cycle_tip' | 'cycle_unknown' };

/**
 * UNWIND an applied settle whose transaction is no longer canonical.
 *
 * Only ever called on POSITIVE evidence (the recorded block hash is not canonical at a height
 * at or below the safe head, and the live kernel reports every member claim unsettled). It:
 * 1. returns every member ledger row to `settled:false`, still RESERVED by this batch, so no
 * other batch can pick the claims while this one's nonce may still carry the transaction;
 * 2. reverts `pe_history` `minted` → `eligible` through the aggregate-aware mutator for every
 * act PE of the batch (one of its legs is unpaid again), and clears top-up enrichment;
 * 3. un-applies the batch (`submitted`, every receipt cleared, a `reorgs` record appended) and
 * rolls its cycle's cursor and counters back — only when this batch is the cycle's TIP,
 * because a later applied batch was built on this one's cursor range.
 * The batch is then an ordinary unresolved batch: the reconciler re-drives its nonce (the same
 * transaction may re-mine, be replaced, or be cancelled). If it dies, `markBatchDead` releases
 * the claims to the queue and they are paid by a new batch. Steps run ledger-first so a crash
 * part-way leaves claims reserved (never selectable) and the next check finishes the unwind.
 */
export async function revertReorgedBatch(
  db: SettlementDb,
  params: { batchId: string; nowMs: number; reason: string },
): Promise<RevertReorgedResult> {
  const batchRef = db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(params.batchId.toLowerCase());
  const first = await batchRef.get();
  const firstData = first.exists ? first.data() : undefined;
  if (!isBatchDoc(firstData)) return { kind: 'refused', reason: 'batch_unknown' };
  const initial = firstData as unknown as SettlementBatchDoc;
  if (!initial.applied || initial.status !== 'confirmed') return { kind: 'refused', reason: 'not_applied' };
  const cycleProbe = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(initial.cycle_id).get();
  const cycleProbeData = cycleProbe.exists ? cycleProbe.data() : undefined;
  if (!isCycleDoc(cycleProbeData)) return { kind: 'refused', reason: 'cycle_unknown' };
  if ((cycleProbeData as unknown as SettlementCycleDoc).cursor_next !== initial.cursor_end) {
    return { kind: 'refused', reason: 'not_cycle_tip' };
  }

  // 1. Ledger first.
  const ledger = db.collection(CLAIM_LEDGER_COLLECTION);
  for (let start = 0; start < initial.members.length; start += LEDGER_WRITEBACK_CHUNK) {
    const writer = db.batch();
    for (const member of initial.members.slice(start, start + LEDGER_WRITEBACK_CHUNK)) {
      writer.set(ledger.doc(claimKeyOf(member.pe_id, member.leg, member.claim_kind ?? 'act')), {
        settled: false,
        reserved_batch_id: initial.batch_id,
        settled_batch_id: null,
        settled_tx_hash: null,
        settled_at: null,
        ...unsettledLedgerRowExpiry(member.pe_id),
      }, { merge: true });
    }
    await writer.commit();
  }

  // 2. pe_history, through the aggregate-aware mutator (the exact inverse of the writeback).
  let peHistoryReverted = 0;
  const seenAct = new Set<string>();
  const seenTopup = new Set<string>();
  const meterReorgKeys = initial.members.filter((m) => isMeterClaimKey(m.pe_id)).map((m) => m.pe_id);
  if (meterReorgKeys.length > 0) {
    const { revertMeterClaimsSettled } = await import('../../meter/meter-settlement');
    const reverted = await revertMeterClaimsSettled(db as unknown as import('firebase-admin/firestore').Firestore, {
      claimKeys: meterReorgKeys, nowMs: params.nowMs,
    });
    peHistoryReverted += reverted.reverted;
  }
  for (const member of initial.members) {
    if (isMeterClaimKey(member.pe_id)) continue;
    if (member.claim_kind === 'attestation_topup') {
      if (seenTopup.has(member.pe_id)) continue;
      seenTopup.add(member.pe_id);
      await enrichLegacyRowIfPresent(db, member.pe_id, (row) => (
        row.attestation_topup_settled_batch_id === initial.batch_id
          ? { attestation_topup_settled_batch_id: null, attestation_topup_settled_tx_hash: null, attestation_topup_settled_at: null }
          : null
      ));
      continue;
    }
    if (seenAct.has(member.pe_id)) continue;
    seenAct.add(member.pe_id);
    const { outcome } = await mutatePeHistoryRowWithAggregate(db, member.pe_id, {
      mint_status: 'eligible',
      settled_batch_id: null,
      settled_tx_hash: null,
      settled_at: null,
      minted_via: null,
      settlement_reorged_at: params.nowMs,
    }, {
      nowMs: params.nowMs,
      expect: (row) => row.mint_status === 'minted' && row.minted_via === 'pvt9_settlement',
    });
    if (outcome === 'applied') peHistoryReverted += 1;
  }

  // 3. The batch and its cycle, together.
  return db.runTransaction<RevertReorgedResult>(async (txn) => {
    const cycleRef = db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(initial.cycle_id);
    const [batchSnap, cycleSnap] = [await txn.get(batchRef), await txn.get(cycleRef)];
    const batchData = batchSnap.exists ? batchSnap.data() : undefined;
    const cycleData = cycleSnap.exists ? cycleSnap.data() : undefined;
    if (!isBatchDoc(batchData)) return { kind: 'refused', reason: 'batch_unknown' };
    if (!isCycleDoc(cycleData)) return { kind: 'refused', reason: 'cycle_unknown' };
    const batch = batchData as unknown as SettlementBatchDoc;
    const cycle = cycleData as unknown as SettlementCycleDoc;
    if (!batch.applied || batch.status !== 'confirmed') return { kind: 'refused', reason: 'not_applied' };
    if (cycle.cursor_next !== batch.cursor_end) return { kind: 'refused', reason: 'not_cycle_tip' };
    const reorg: BatchReorgRecord = {
      tx_hash: batch.confirmed_tx_hash ?? '',
      block_number: batch.confirmed_block_number ?? null,
      block_hash: batch.confirmed_block_hash ?? null,
      detected_at_ms: params.nowMs,
      reason: params.reason,
    };
    const fee = BigInt(batch.confirmed_fee_wei ?? '0');
    const spent = BigInt(cycle.consumed.fee_wei_spent);
    const clockEntries = Object.entries(batch.payee_clocks_before ?? {});
    const clockRefs = clockEntries.map(([payee]) => db.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(payee));
    const clocks = await Promise.all(clockRefs.map(ref => txn.get(ref)));
    clocks.forEach((snap, i) => {
      if (snap.data()?.batch_id !== batch.batch_id) return;
      const [payee, previous] = clockEntries[i];
      txn.set(clockRefs[i], previous ?? { payee, batch_id: null, last_settled_at_ms: null });
    });
    txn.set(batchRef, {
      ...batch,
      status: 'submitted',
      attempts: batch.attempts.map((attempt) => ({ ...attempt, mined: null })),
      applied: false,
      writebacks_complete: false,
      confirmed_tx_hash: null,
      confirmed_fee_wei: null,
      confirmed_block_number: null,
      confirmed_block_hash: null,
      finality_verified: false,
      finality_open: false,
      reorgs: [...(batch.reorgs ?? []), reorg],
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    txn.set(cycleRef, {
      ...cycle,
      cursor_next: batch.cursor_start,
      consumed: {
        ...cycle.consumed,
        batches_confirmed: Math.max(0, cycle.consumed.batches_confirmed - 1),
        claims_settled: Math.max(0, cycle.consumed.claims_settled - batch.claim_count),
        recipients_settled: Math.max(0, cycle.consumed.recipients_settled - batch.recipient_count),
        fee_wei_spent: (spent > fee ? spent - fee : 0n).toString(),
      },
      updated_at: params.nowMs,
    } as unknown as Record<string, unknown>);
    return { kind: 'reverted', peHistoryReverted };
  });
}

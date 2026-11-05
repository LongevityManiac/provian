import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * THE `pending_evidence` RESOLVER. THE ONE ARM THAT PROMOTES.
 *
 * WHAT THIS IS. `pending_evidence` is the one non-terminal hold in the
 * disposition table resolved here. `pending-cache-backfill.ts` handles only
 * `pending_cache`; settlement reads only `mint_status == 'eligible'`.
 * This module sweeps the held rows, runs the verification that
 * ACTUALLY EXISTS for each row's sealed evidence class, and either records a
 * verified resolution or refuses with a named reason. Where no verifier is
 * implementable today, the row STAYS pending carrying that reason. Nothing is
 * rubber-stamped: a class whose runtime is dark resolves to a refusal, never to
 * `eligible`.
 *
 * ── THE POPULATION SPLITS IN TWO, AND THE SPLIT IS THE WHOLE DESIGN ──────────
 * A row's `evidence_resolution_mode` is sealed in its own snapshot, and it
 * decides whether an in-place resolution is legal AT ALL:
 *
 * (a) `linked_evidence_pe_only` every one of the 64 policy rows whose
 * DISPOSITION is `pending_evidence` (see `proposed-action-policy.ts`
 * `entry()` `mintDisposition === 'pending_evidence'` forces this mode).
 * `monetary-accounting.ts::resolveEligibilityProjection` REFUSES an
 * in-place `pending_evidence -> eligible` projection for this mode in as
 * many words: *"This record can become mintable only through a separately
 * linked evidence PE."* So for these rows the resolver DETECTS ARRIVAL of
 * relay-verified linked evidence and records it — it never re-judges the
 * held PE and never flips it. Marking one `eligible` here would build a row
 * the settlement kernel throws on, which is C-2 in a new coat: a surface
 * claiming more than the seal supports.
 *
 * (b) `projection_with_verified_evidence` a row whose POLICY disposition is
 * `eligible` with an evidence requirement, which seals `pending_evidence`
 * operationally because its evidence was still `pending` at record time
 * (`computeRecordSnapshot`, the `evidenceState !== 'verified'` branch).
 * These CAN resolve in place, and this is the only population that can.
 *
 * ── THE ONE ARM THAT PROMOTES, AND WHY EVERY OTHER ARM STILL DOES NOT ──
 * 's established the bar a promotion must clear, and the
 * reason the chain-receipt arm does NOT clear it: `mint_status: 'eligible'` IS
 * mint authority on the live rail (the exact selection predicate of the PVT9
 * standard-lane claim inlet, `wp4/claim-inlet-source.ts`), so a promotion needs
 * a verifier that binds the evidence to the canonical event the PE claims
 * under its supported evidence-resolution mode.
 *
 * `verified_substantive_outcome` supports that resolution: a genuinely
 * completed job earns whether or not an on-chain escrow release exists; the
 * counterparty's confirmation corroborates the deliverer's already-captured
 * work PE — it lifts, it never double-pays; escrow-released jobs keep paying
 * exactly as today. The verifier is `completion-verifier.ts` a
 * `human_job_delivered` row is VERIFIED when the poster's `human_job_completed`
 * confirmation exists and binds to the exact job, poster and delivery, the
 * poster is a DISTINCT OWNER (`detectSameOwnerTransfer`, the record path's own
 * fence — self-dealing mints 0), the job's escrow does not contradict the
 * completion, and the `completion` mint-once slot for this job is not already
 * owned by the on-chain release (`completion-claim.ts`). Every other type in
 * the class refuses BY NAME (the poster's confirmation is corroboration, never
 * a second act; an agent-board job settles via its escrow release; a promise or
 * goal completion has no server-verifiable confirmation today).
 *
 * THE PROMOTION IS EXACTLY-ONCE AND MINT-ONCE. It runs in ONE Firestore
 * transaction that re-reads the held row (still pending, snapshot hash
 * unmoved), CLAIMS the completion slot (the same crash-safe
 * `inspectPreparedMintOnceClaimInTransaction` every record-time claim uses — a
 * slot taken meanwhile by the on-chain witness refuses by name), flips
 * `mint_status` to `eligible` beside an immutable `economic_eligibility_projection`
 * the kernel validates at settlement (`resolveEligibilityProjection`), appends
 * the claim evidence to the row, stamps the confirmation as the row's
 * corroboration (the LIFT: software → corroborated inside the kernel's 72h
 * enhancement window, measured from the delivery's record time —
 * scoping verbatim; a late confirmation still promotes, at the sealed value),
 * and writes its durable resolution record. The sealed `economic_snapshot` is
 * never touched. The settlement inlet then DEFERS the promoted row while its
 * 72h takeover window is open (`completionTakeoverWindowOpen`), so an escrow
 * release landing inside the window takes the slot at the best-supported value
 * instead of finding a registered incumbent — and a release landing after it is
 * refused with the registered value standing, never stranding a settleable
 * claim.
 *
 * ── WHICH VERIFIERS ACTUALLY EXIST ───────────────────────────────────────────
 * - `base_final_chain_receipt` the chain read is LIVE (`core/onchain/
 * tx-verifier.ts`, 12-confirmation Base finality floor). It is NOT sufficient
 * for promotion: `verifyEvmTxFrom` proves a tx exists, succeeded, has 12
 * confirmations, and was sent BY the actor; it says nothing about `to`, the
 * value, the token, or that the transaction is the act the PE describes, so
 * a promotion on it would let any wallet-sent transaction — a zero-value
 * self-send included — satisfy the arm. The check RUNS, its result is
 * RECORDED, and the row stays pending with
 * `refused_promotion_would_create_mint_authority`. Note also that no
 * production path currently writes `pe_history.tx_hash` for these types.
 * - `verified_substantive_outcome` the counterparty-confirmation
 * verifier above. Promotes `human_job_delivered`; refuses the rest by name.
 * - `verified_compute_or_work` these agent-work types are now `eligible`
 * and mint AT RECORD TIME via the sovereign-pe per-occurrence agent-key binding
 * (the route stamps the PE verified before it seals). A BARE row (no binding)
 * seals `pending_evidence` in mode (b) with NO settlement verifier — the binding
 * is a record-time fact settlement cannot supply — so it is refused by name and
 * stays pending, never minting.
 * - `verified_institution_lifecycle` NO verifier here: the institution
 * watchers emit their own verified rows for the canonical on-chain events.
 * Named refusal.
 * - `verified_external_service_witness` NO verifier. The Witness-3 connector
 * is dark. Named refusal.
 * - `operator_policy_review`, `valid_genesis_reservation`, `none` not a
 * resolver concern; named refusal so an unexpected row is never guessed at.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
 * - NOT a settlement path. It submits no transaction and touches no signer;
 * the promoted row is settled by the daily runner when its payee is due like any eligible row.
 * - NOT a repricer. The sealed `economic_snapshot` is never mutated and its
 * hash is re-verified before the row is acted on; the promotion changes the
 * row's DISPOSITION (through the kernel's own projection state machine) and
 * its mutable corroboration fields, nothing sealed.
 * - NOT an expirer. There is deliberately no "held too long -> ineligible"
 * arm: that would be an economic value nobody chose, and destroying a live
 * claim on a number this module invented is exactly the decision that belongs
 * to the operator, not to a sweep.
 */

import crypto from 'crypto';
import type admin from 'firebase-admin';
import {
  hashRecordEconomicSnapshot,
  type ActionEvidenceRequirement,
  type EligibilityProjection,
  type EvidenceResolutionMode,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import type { MintOnceClaimEvidence } from './mint-once-claim';
import {
  verifySubstantiveOutcomeCompletion,
  type CompletionPromotionFacts,
} from './completion-verifier';
import {
  COMPLETION_CONFIRMATION_CORROBORATION_STATUS,
  applyCompletionPromotionInTransaction,
  applyCompletionPromotionToHeldAct,
} from './completion-promotion';
import { readPeHistoryReaderMode, shardPlan, withIndexShard } from './pe-history-index-shard';
import { walkHeldActs } from './held-act-sweep';
import type { HeldActDoc, HeldActRow } from '../meter/held-acts';
import { METER_HELD_ACTS_COLLECTION } from '../meter/meter-store';

/** Per-PE durable resolution record. Separate doc so `pe_history` stays sealed. */
export const PENDING_EVIDENCE_RESOLUTION_COLLECTION = 'pvt_pending_evidence_resolution_v1';

/**
 * THE SWEEP CURSOR — the shape, deliberately copied rather than reinvented.
 *
 * found that a head-pinned query over a collection larger than one page is
 * a sweep that can never reach anything past that page, and that it is
 * INDISTINGUISHABLE FROM A HEALTHY ONE on a backlog smaller than the page. That
 * defect shipped, ran scheduled in production, and reported success. `pe_history`
 * is orders of magnitude larger than the intake collection, so the same query
 * shape here would be wrong on day one rather than eventually.
 *
 * Each pass therefore resumes strictly AFTER the last row the previous pass
 * examined and wraps at the end of the range, and the result carries an explicit
 * `cursor_advanced` health line so a stuck sweep reports as stuck instead of
 * reporting as quiet.
 */
export const PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION = 'pvt_pending_evidence_resolver_cursor_v1';
export const PENDING_EVIDENCE_RESOLVER_CURSOR_DOC = 'sweep';
/**
 * PE METER — the cursor of the second walk, over METERED held acts
 * (`meter_held_acts_v1`, held_reason `pending_evidence`). Same bookkeeping
 * collection, its own document: the two populations are walked independently.
 */
export const PENDING_EVIDENCE_RESOLVER_HELD_CURSOR_DOC = 'held_sweep';

export interface PendingEvidenceResolverCursorDocument {
  readonly schema_version: 'pvt-pending-evidence-resolver-cursor/v1';
  /** `timestamp` of the last row examined, or null at the start of a cycle. */
  readonly last_timestamp_ms: number | null;
  /** `peId` of the last row examined — the tiebreak within one millisecond. */
  readonly last_pe_id: string | null;
  /**
   * H5 — the index shard this cursor sits in (sharded reader mode), or
   * null in legacy mode. A cycle sweeps every shard in order; reaching the end
   * of one shard moves the cursor to the next shard's head, and passing the
   * last shard completes the cycle. Absent on cursors written before H5
   * (read as null → the plan's first shard).
   */
  readonly shard?: number | null;
  readonly updated_at_ms: number;
  readonly cycles_completed: number;
}

/** Re-exported from the sanctioned promoter, which owns the write that uses it. */
export { COMPLETION_CONFIRMATION_CORROBORATION_STATUS };

/**
 * Every terminal answer this module can give, each one named. There is no
 * unnamed outcome and no default-admit: the dispatch is exhaustive over the
 * sealed evidence class, and anything it cannot classify is refused.
 */
export type PendingEvidenceResolutionOutcome =
  /** Already carries a resolution record; this pass did nothing. */
  | 'already_resolved'
  /**
   *. The ONE paying outcome: a verified counterparty confirmation
   * promoted the deliverer's row to `eligible`, claiming the completion slot.
   */
  | 'promoted'
  /**. The delivery is bound and sound but the poster has not confirmed. Stays pending. */
  | 'awaiting_counterparty_confirmation'
  /** The verifier ran and the evidence is not (yet) verifiable. Stays pending. */
  | 'awaiting_verified_evidence'
  /** Mode (a). Relay-verified linked evidence ARRIVED and was recorded. Stays pending. */
  | 'linked_evidence_recorded'
  /** Mode (a). No linked evidence PE has arrived. Stays pending. */
  | 'awaiting_linked_evidence_pe'
  /** The class has no implementable verifier while its runtime is dark. Stays pending. */
  | 'refused_no_verifier_for_class'
  /**. The job/confirmation records do not bind to this delivery. Stays pending. */
  | 'refused_completion_binding'
  /**. The poster shares beneficial ownership with the deliverer. Stays pending, mints 0. */
  | 'refused_completion_self_dealing'
  /**
   * The poster's address is absent or
   * not a well-formed EVM address, so the distinct-owner fence cannot run.
   * Unknown = Block: refused by name, stays pending, never promoted.
   */
  | 'refused_completion_counterparty_unresolvable'
  /** The row cannot be bound to an authoritative on-chain actor. Stays pending. */
  | 'refused_no_authoritative_actor'
  /** Snapshot missing, unreadable, or its hash no longer binds. Stays pending. */
  | 'refused_snapshot_unbound'
  /** Row is not actually held at `pending_evidence` any more. */
  | 'refused_not_pending'
  /** A record-time gate that settlement can never resolve. Stays pending. */
  | 'refused_session_lineage_unresolvable'
  /** The verifier threw. Fail-closed. Stays pending. */
  | 'refused_verifier_error'
  /**
   * the chain-receipt check runs, and its result is
   * deliberately NOT turned into a promotion. See the header.
   */
  | 'refused_promotion_would_create_mint_authority'
  /**
   * B11 / the canonical event this row cites has ALREADY minted
   * through a cross-source mint-once claim (another PE owns the slot: the
   * financial-settlement claim for a chain receipt, the completion claim for a
   * job whose on-chain release paid). The resolver's leg of the exactly-once
   * invariant. Not persisted (the row stays pending like every refusal), and
   * re-judged each pass.
   */
  | 'refused_canonical_event_already_minted';

export interface PendingEvidenceResolutionDocument {
  readonly schema_version: 'pvt-pending-evidence-resolution/v1';
  readonly pe_id: string;
  readonly action_type: string;
  readonly evidence_requirement: ActionEvidenceRequirement;
  readonly evidence_resolution_mode: EvidenceResolutionMode | null;
  readonly outcome: PendingEvidenceResolutionOutcome;
  /** Machine-readable detail behind `outcome`; never free-form at a call site. */
  readonly reason: string;
  readonly resolved_at_ms: number;
  /**
   * The snapshot hash this resolution was computed against. A later reader can
   * prove the resolution was bound to the exact sealed economics.
   */
  readonly bound_snapshot_hash: string;
  /** Present only when a verifier PASSED or linked evidence ARRIVED. */
  readonly evidence?: {
    readonly kind:
      | 'base_final_chain_receipt'
      | 'relay_corroboration_signal'
      | 'counterparty_completion_confirmation';
    readonly evidence_id: string;
    readonly source: string;
    readonly as_of: string;
    readonly canonical_event_id: string | null;
  };
}

export interface PendingEvidenceResolverResult {
  readonly scanned: number;
  readonly already_resolved: number;
  readonly promoted: number;
  readonly awaiting_counterparty_confirmation: number;
  readonly awaiting_verified_evidence: number;
  readonly linked_evidence_recorded: number;
  readonly awaiting_linked_evidence_pe: number;
  readonly refused_no_verifier_for_class: number;
  readonly refused_completion_binding: number;
  readonly refused_completion_self_dealing: number;
  readonly refused_completion_counterparty_unresolvable: number;
  readonly refused_no_authoritative_actor: number;
  readonly refused_snapshot_unbound: number;
  readonly refused_not_pending: number;
  readonly refused_session_lineage_unresolvable: number;
  readonly refused_verifier_error: number;
  readonly refused_promotion_would_create_mint_authority: number;
  readonly refused_canonical_event_already_minted: number;
  /**
   * THE HEALTH LINE — 's lesson made a field.
   *
   * `population` is the number of held rows this pass actually examined, stated
   * separately from every outcome tally so a sweep over ZERO rows is legible as
   * zero rather than as "nothing went wrong". `population_empty` states it in
   * one boolean so an operator reading the scheduler response does not have to
   * infer it, and `cursor_advanced` is the check says must exist: a sweep
   * that examined rows but did not move its cursor is STUCK, and says so.
   */
  readonly population: number;
  readonly population_empty: boolean;
  readonly cursor_advanced: boolean;
  readonly cursor_wrapped: boolean;
  readonly cycles_completed: number;
  /**
   * PE METER — the metered held acts this pass examined (already counted in `scanned`,
   * `population` and the outcome tallies), and whether that walk wrapped / reached its end.
   * `cursor_*` and `cycles_completed` above describe the pre-meter `pe_history` walk.
   */
  readonly held_acts_scanned: number;
  readonly held_acts_cursor_wrapped: boolean;
  readonly held_acts_reached_end: boolean;
}

/** Verified on-chain receipt, or a named refusal. Injected so the sweep is testable. */
export interface ChainReceiptVerification {
  readonly ok: boolean;
  readonly reason?: string;
  readonly blockNumber?: number;
  readonly confirmations?: number;
}

export interface PendingEvidenceResolverDeps {
  readonly db: admin.firestore.Firestore;
  /**
   * Verify a `base_final_chain_receipt`. Injected rather than imported so this
   * module does not pull ethers and a provider into every consumer, and so the
   * suite can drive both verdicts without a network. Production passes a thin
   * wrapper over `core/onchain/tx-verifier.ts::verifyEvmTxFrom`.
   */
  readonly verifyChainReceipt: (params: {
    readonly chainId: number;
    readonly txHash: string;
    readonly expectedFrom: string;
  }) => Promise<ChainReceiptVerification>;
  /**
   * Resolve the authoritative on-chain address for a PE's economic actor.
   * Returns null when no address is registered — which is a REFUSAL, not a
   * pass: verifying that a tx exists without binding it to this PE's actor
   * would let any row cite any stranger's transaction.
   */
  readonly resolveActorAddress: (economicActorId: string) => Promise<string | null>;
  /**
   * B11 : look up the cross-source financial-settlement mint-once claim
   * for (settling address, txHash). Returns the owning PE id when the canonical
   * event is already claimed, null when unclaimed. Injected so the sweep is
   * testable without Firestore; production passes a thin wrapper over
   * `prepareFinancialSettlementMintClaim` (read-only preparation — relation
   * 'duplicate' means another PE owns the event). A lookup that THROWS is
   * treated as a verifier error (fail closed), never as unclaimed.
   */
  readonly lookupFinancialSettlementClaimOwner?: (
    settlingAddress: string,
    txHash: string,
  ) => Promise<string | null>;
}

export interface PendingEvidenceResolverOptions {
  /** Evaluation instant. Required — this module performs no implicit clock read. */
  readonly nowMs: number;
  readonly limit?: number;
  /** Chain the `base_final_chain_receipt` class is settled on. Base mainnet. */
  readonly chainId?: number;
}

/** Base mainnet. The evidence class is named `base_final_chain_receipt`. */
export const PENDING_EVIDENCE_CHAIN_ID = 8453;

/**
 * The corroboration statuses the RELAY itself writes and every mint-side reader
 * already enumerates. `applyClientCorroboration` never writes this field at all
 * (it writes mint-neutral `client_corroboration_*` markers), so membership here
 * means a backend/witness emitter attested it.
 */
export const RELAY_VERIFIED_CORROBORATION_STATUSES: ReadonlySet<string> = new Set([
  'on_chain_verified',
  'merchant_confirmed',
  'peer_verified',
  'service_grant_attested',
]);

/**
 * Classes whose verifier is not implementable today, each with the reason it is
 * not. Stated as data so the refusal message names the dark runtime rather than
 * saying "unsupported", and so adding a runtime is a one-line deletion here plus
 * a real arm rather than an edit buried in a switch. deleted
 * `verified_substantive_outcome` from this table and added its arm
 * (`completion-verifier.ts`).
 */
export const NO_VERIFIER_REASONS: Readonly<Partial<Record<ActionEvidenceRequirement, string>>> = {
  verified_institution_lifecycle:
    'no_verifier_institution_lifecycle_is_watcher_emitted: the institution watchers emit their own '
    + 'verified rows for the canonical on-chain events; a held relay draft has no settlement verifier',
  verified_external_service_witness:
    'no_verifier_witness3_connector_dark: the external-service witness connector is not live',
  // agent-work evidence is the record-time sovereign per-occurrence agent-key
  // binding, supplied at record time by the sovereign-pe route (which stamps the PE
  // verified before it seals). Settlement cannot supply that binding after the fact,
  // so a BARE compute_or_work row (no binding) has no settlement verifier by design
  // and correctly stays pending — it never mints without a record-time binding.
  verified_compute_or_work:
    'no_verifier_compute_or_work_record_time_binding_only: the sovereign per-occurrence '
    + 'agent-key binding is a record-time fact; settlement cannot supply it after the seal',
  operator_policy_review:
    'no_verifier_operator_review_is_manual: this class resolves by operator action, not by a sweep',
  valid_genesis_reservation:
    'no_verifier_genesis_resolves_in_its_own_state_machine',
  // : the witness class is a RECORD-TIME fact the relay assigned from the binding
  // it checked (device body-HMAC, hardware report, chain log, forge HMAC); settlement cannot
  // supply it later, and a class-admitted row seals verified at record time, so none is held.
  verified_witness_class:
    'no_verifier_witness_class_record_time_only: the relay-assigned witness class stamps the '
    + 'record verified at seal; a held row of this class cannot exist',
  none:
    'no_verifier_class_none_should_not_be_held',
};

/**
 * The evidence classes settlement can actually VERIFY-and-promote in place: the
 * on-chain final receipt (the tx_hash arm below) and the counterparty
 * substantive-outcome completion (, `verifySubstantiveOutcomeCompletion`).
 * Kept as a set beside the dispatch so the row→verifier coverage gate
 * (`isEligibleEvidenceClassCovered`, Phase 5 / item 07) binds to the arms
 * this module runs rather than a copy. Adding a live arm means adding its `if`
 * branch below AND its member here.
 */
export const LIVE_SETTLEMENT_ARMS: ReadonlySet<ActionEvidenceRequirement> = new Set<ActionEvidenceRequirement>([
  'base_final_chain_receipt',
  'verified_substantive_outcome',
]);

/**
 * An eligible matrix row's evidence class is COVERED iff settlement can verify it
 * (a live arm) OR it is a declared class verified elsewhere / not held
 * (`NO_VERIFIER_REASONS`: record-time sovereign binding, watcher-emitted rows,
 * the genesis state machine, or manual operator review). A class in NEITHER set
 * is a hole — an eligible row that can never be resolved and would fall through
 * to `no_verifier_unknown_evidence_requirement`, "passing every check and paying
 * zero forever." The row→verifier gate (item 07) asserts no such row exists.
 */
export function isEligibleEvidenceClassCovered(requirement: ActionEvidenceRequirement): boolean {
  return LIVE_SETTLEMENT_ARMS.has(requirement) || requirement in NO_VERIFIER_REASONS;
}

/** The minimal `pe_history` shape this module reads. */
export interface HeldPendingEvidenceRow {
  readonly peId: string;
  readonly userId: string;
  readonly actionType: string;
  readonly timestamp: number;
  readonly mint_status: string;
  readonly economic_snapshot: RecordEconomicSnapshot | null;
  readonly economic_snapshot_hash: string | null;
  readonly tx_hash?: string;
  readonly corroboration_status?: string;
  readonly corroboration_source?: string | null;
  readonly corroboration_received_at?: number | null;
  readonly mint_once_claim_evidence?: MintOnceClaimEvidence[] | null;
}

function isHeldRow(value: unknown): value is HeldPendingEvidenceRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.peId === 'string'
    && typeof row.userId === 'string'
    && typeof row.actionType === 'string'
    && typeof row.timestamp === 'number'
    && typeof row.mint_status === 'string';
}

export interface Verdict {
  readonly outcome: PendingEvidenceResolutionOutcome;
  readonly reason: string;
  readonly evidence?: PendingEvidenceResolutionDocument['evidence'];
  /**. Present ONLY on `promoted` what the promotion transaction commits. */
  readonly promotion?: CompletionPromotionFacts;
}

/**
 * Decide ONE held row. Pure apart from the injected verifier lookups: it
 * performs no writes, so the transition below can apply it transactionally
 * without a verifier running inside a Firestore transaction.
 *
 * `snapshot` is typed as the sealed shape but every field it branches on is
 * re-checked, because the value came out of Firestore as `unknown` and a guard
 * that trusts its own type annotation is a guard that cannot fail.
 */
export async function judgePendingEvidenceRow(
  deps: PendingEvidenceResolverDeps,
  row: HeldPendingEvidenceRow,
  options: PendingEvidenceResolverOptions,
): Promise<Verdict> {
  if (row.mint_status !== 'pending_evidence') {
    return { outcome: 'refused_not_pending', reason: `mint_status_is_${row.mint_status}` };
  }

  const snapshot = row.economic_snapshot;
  if (snapshot === null || typeof snapshot !== 'object') {
    return { outcome: 'refused_snapshot_unbound', reason: 'snapshot_absent' };
  }
  // The binding check, and it runs BEFORE anything is judged: a snapshot that no
  // longer hashes to its sealed commitment was mutated after the seal, and
  // resolving against mutated economics is the exact thing the commitment
  // exists to prevent.
  let recomputed: string;
  try {
    recomputed = hashRecordEconomicSnapshot(snapshot);
  } catch {
    return { outcome: 'refused_snapshot_unbound', reason: 'snapshot_unhashable' };
  }
  if (row.economic_snapshot_hash !== recomputed) {
    return { outcome: 'refused_snapshot_unbound', reason: 'snapshot_hash_mismatch' };
  }
  if (snapshot.mintDisposition !== 'pending_evidence') {
    return {
      outcome: 'refused_not_pending',
      reason: `snapshot_disposition_is_${String(snapshot.mintDisposition)}`,
    };
  }

  const gates = snapshot.recordTimeFactors?.unresolvedRecordGates ?? [];
  if (Array.isArray(gates) && gates.includes('session_lineage')) {
    // `requiredResolutionTypes` THROWS on this gate — "Missing record-time
    // session lineage cannot be resolved at settlement" — so a row carrying it
    // is refused here by name rather than allowed to reach a throw later.
    // `computeRecordSnapshot` forces such a row to `record_only`, so this should
    // be unconstructible through the mainline; it is checked anyway because the
    // input arrives from Firestore, where the mainline's guarantees do not hold.
    return {
      outcome: 'refused_session_lineage_unresolvable',
      reason: 'record_time_session_lineage_gate_cannot_resolve_at_settlement',
    };
  }

  const requirement = snapshot.recordTimeFactors?.evidenceRequirement;
  const mode = snapshot.recordTimeFactors?.evidenceResolutionMode ?? null;

  // ── Mode (a): linked evidence only. Detect arrival; never promote. ─────────
  if (mode === 'linked_evidence_pe_only') {
    const status = row.corroboration_status;
    // an ALLOWLIST, because every sibling reader is one.
    //
    // The first cut accepted any non-empty string other than `'none'`. That is a
    // denylist, and `claim-inlet-source.ts` and `economic-projection.ts` both
    // enumerate the four VERIFIED values instead (as the retired PVTv8
    // `minting-engine.ts` did). A
    // future or legacy `'disputed'`/`'pending'` would have been recorded as
    // "verified linked evidence arrived" — and because the arrival record is the
    // one durable non-promoting outcome, that record would then make every later
    // pass answer `already_resolved` and swallow the real arrival. Unknown =
    // block, not warn.
    // Only the relay-written field counts. `applyClientCorroboration` writes
    // `client_corroboration_*` and deliberately leaves this one alone, so
    // reading it inherits that anti-collusion decision instead of re-making it.
    if (typeof status === 'string' && RELAY_VERIFIED_CORROBORATION_STATUSES.has(status)) {
      return {
        outcome: 'linked_evidence_recorded',
        reason: `linked_evidence_pe_only_arrival_recorded_not_promoted: ${status}`,
        evidence: {
          kind: 'relay_corroboration_signal',
          evidence_id: row.corroboration_source ?? status,
          source: `pe_history.corroboration_status=${status}`,
          as_of: String(row.corroboration_received_at ?? options.nowMs),
          canonical_event_id: snapshot.recordTimeFactors?.canonicalEventId ?? null,
        },
      };
    }
    return {
      outcome: 'awaiting_linked_evidence_pe',
      reason: 'linked_evidence_pe_only_no_relay_verified_signal_yet',
    };
  }

  // ── Mode (b): in-place resolution is legal. Which verifier? ────────────────
  if (mode !== 'projection_with_verified_evidence') {
    return {
      outcome: 'refused_no_verifier_for_class',
      reason: `unsupported_evidence_resolution_mode: ${String(mode)}`,
    };
  }

  // ── the counterparty-confirmation verifier for the outcome class. ──
  if (requirement === 'verified_substantive_outcome') {
    const verification = await verifySubstantiveOutcomeCompletion(deps.db, {
      peId: row.peId,
      userId: row.userId,
      actionType: row.actionType,
      timestamp: row.timestamp,
    }, { nowMs: options.nowMs });
    if (verification.kind === 'awaiting') {
      return { outcome: 'awaiting_counterparty_confirmation', reason: verification.reason };
    }
    if (verification.kind === 'refused') {
      return { outcome: verification.outcome, reason: verification.reason };
    }
    const facts = verification.facts;
    // The confirming PE's origin, by completion type: the poster's
    // `human_job_completed` for a job; the counterparty's own `promise_fulfilled`
    // for a promise. (`goal_envelope_completed` never reaches `promote`.)
    const confirmationSource = row.actionType === 'promise_fulfilled'
      ? 'provenance_envelopes.promise_fulfilled'
      : 'provenance_envelopes.human_job_completed';
    return {
      outcome: 'promoted',
      reason: `counterparty_completion_confirmed_by_${facts.confirmationPeId}`,
      evidence: {
        kind: 'counterparty_completion_confirmation',
        evidence_id: facts.confirmationPeId,
        source: confirmationSource,
        as_of: String(facts.confirmationTimestampMs),
        canonical_event_id: facts.canonicalId,
      },
      promotion: facts,
    };
  }

  if (requirement !== 'base_final_chain_receipt') {
    const named = requirement === undefined
      ? undefined
      : NO_VERIFIER_REASONS[requirement];
    return {
      outcome: 'refused_no_verifier_for_class',
      reason: named ?? `no_verifier_unknown_evidence_requirement: ${String(requirement)}`,
    };
  }

  const txHash = row.tx_hash;
  if (typeof txHash !== 'string' || txHash.length === 0) {
    return {
      outcome: 'awaiting_verified_evidence',
      reason: 'no_settlement_tx_hash_recorded',
    };
  }

  let actor: string | null;
  try {
    actor = await deps.resolveActorAddress(snapshot.economicActorId);
  } catch {
    return { outcome: 'refused_verifier_error', reason: 'actor_address_lookup_threw' };
  }
  if (actor === null || actor.length === 0) {
    return {
      outcome: 'refused_no_authoritative_actor',
      reason: 'no_registered_onchain_address_for_economic_actor',
    };
  }

  let verification: ChainReceiptVerification;
  try {
    verification = await deps.verifyChainReceipt({
      chainId: options.chainId ?? PENDING_EVIDENCE_CHAIN_ID,
      txHash,
      expectedFrom: actor,
    });
  } catch {
    // Fail CLOSED. An RPC that threw is not evidence of anything.
    return { outcome: 'refused_verifier_error', reason: 'chain_receipt_verifier_threw' };
  }
  if (verification === null || typeof verification !== 'object' || verification.ok !== true) {
    return {
      outcome: 'awaiting_verified_evidence',
      reason: `chain_receipt_not_verified: ${verification?.reason ?? 'unknown'}`,
    };
  }

  // B11 — the exactly-once leg: if the canonical event this row cites
  // already minted through the cross-source financial-settlement claim (the
  // watcher's seal, or a future durable self-report), refuse BY NAME before
  // the promotion-refusal below. A future promotion arm cannot be built past
  // this check without deleting it — which is the deliberate act the invariant
  // requires. Lookup errors fail closed as verifier errors.
  if (deps.lookupFinancialSettlementClaimOwner) {
    let claimOwner: string | null;
    try {
      claimOwner = await deps.lookupFinancialSettlementClaimOwner(actor, txHash);
    } catch {
      return { outcome: 'refused_verifier_error', reason: 'financial_settlement_claim_lookup_threw' };
    }
    if (claimOwner !== null && claimOwner !== row.peId) {
      return {
        outcome: 'refused_canonical_event_already_minted',
        reason: `canonical_event_minted_by_${claimOwner}`,
      };
    }
  }

  return {
    outcome: 'refused_promotion_would_create_mint_authority',
    reason: 'chain_receipt_binds_sender_and_finality_only_not_the_canonical_event',
    evidence: {
      kind: 'base_final_chain_receipt',
      evidence_id: txHash,
      source: `base:${options.chainId ?? PENDING_EVIDENCE_CHAIN_ID}:tx_receipt`,
      as_of: String(verification.blockNumber ?? snapshot.recordedAtMs),
      canonical_event_id: txHash,
    },
  };
}

/**
 * The ONE derivation of a resolution-evidence commitment. Defined here rather
 * than injected: an injected hasher is a second implementation waiting to
 * diverge from the one the record is bound to — the tautology.
 *
 * `sha256:` PREFIXED, deliberately. The kernel's own predicate is
 * `SHA256_COMMITMENT = /^sha256:[a-f0-9]{64}$/` (`policy/monetary-accounting.ts`)
 * and the only sibling producer of a resolution commitment,
 * `pending-cache-resolution.ts`, writes the prefixed form. The first cut of this
 * function returned BARE hex and carried its own `/^[0-9a-f]{64}$/` guard — a
 * second, divergent copy of a predicate the kernel already owns, which is
 * exactly the shape warns about. It passed its own guard and would have
 * been refused by the money path.
 *
 * Field order is written out explicitly rather than taken from `Object.keys`, so
 * adding a field cannot silently change every prior commitment.
 */
export function hashResolutionEvidence(
  evidence: NonNullable<PendingEvidenceResolutionDocument['evidence']>,
): string {
  const preimage = JSON.stringify([
    'pvt-pending-evidence-resolution/v1',
    evidence.kind,
    evidence.evidence_id,
    evidence.source,
    evidence.as_of,
    evidence.canonical_event_id,
  ]);
  return `sha256:${crypto.createHash('sha256').update(preimage, 'utf8').digest('hex')}`;
}

/**
 * the immutable eligibility projection a promotion writes beside the
 * untouched seal. The kernel validates it at every settlement read
 * (`resolveEligibilityProjection`): `pending_evidence -> eligible` is a legal
 * transition in mode (b), the held row's unresolved gates (`evidence`, and
 * `canonical_event` for this class) resolve on ONE `evidence` item, and the item
 * must name the canonical event — the completion claim key. Built from the same
 * evidence the resolution record carries, hashed by the one derivation above.
 */
export function buildCompletionEligibilityProjection(
  evidence: NonNullable<PendingEvidenceResolutionDocument['evidence']>,
): EligibilityProjection {
  return {
    mintDisposition: 'eligible',
    mintReasonCode: 'policy_eligible',
    resolutionEvidence: [{
      resolutionType: 'evidence',
      evidenceId: evidence.evidence_id,
      evidenceHash: hashResolutionEvidence(evidence),
      source: 'pending-evidence-resolver:counterparty_completion_confirmation',
      asOf: `observed_at_ms:${evidence.as_of}`,
      canonicalEventId: evidence.canonical_event_id,
    }],
  };
}

function resolutionDocument(
  row: HeldPendingEvidenceRow,
  verdict: Verdict,
  options: PendingEvidenceResolverOptions,
): PendingEvidenceResolutionDocument {
  const snapshot = row.economic_snapshot;
  return {
    schema_version: 'pvt-pending-evidence-resolution/v1',
    pe_id: row.peId,
    action_type: row.actionType,
    evidence_requirement: snapshot?.recordTimeFactors?.evidenceRequirement ?? 'none',
    evidence_resolution_mode: snapshot?.recordTimeFactors?.evidenceResolutionMode ?? null,
    outcome: verdict.outcome,
    reason: verdict.reason,
    resolved_at_ms: options.nowMs,
    bound_snapshot_hash: row.economic_snapshot_hash ?? '',
    ...(verdict.evidence ? { evidence: verdict.evidence } : {}),
  };
}

/**
 * Apply ONE verdict, transactionally and exactly once.
 *
 * The resolution record is create-if-absent INSIDE the transaction, and the
 * `pe_history` transition is conditioned on the row still reading
 * `pending_evidence` in that same transaction. So a second sweep (or two
 * concurrent sweeps) over the same row cannot transition it twice: whichever
 * transaction commits second sees the resolution doc and returns
 * `already_resolved` without writing.
 *
 * Two outcomes persist a durable record: the mode-(a) ARRIVAL of relay-verified
 * linked evidence, and the PROMOTION. Every other outcome is left
 * un-persisted on purpose: the row must stay reachable by a later pass once its
 * evidence arrives or its runtime lights up, and a durable "we looked and
 * refused" doc would make `already_resolved` swallow the real arrival.
 */
export async function applyPendingEvidenceVerdict(
  db: admin.firestore.Firestore,
  row: HeldPendingEvidenceRow,
  verdict: Verdict,
  options: PendingEvidenceResolverOptions,
  evidenceHash: string | null,
): Promise<PendingEvidenceResolutionOutcome> {
  const resolutionRef = db.collection(PENDING_EVIDENCE_RESOLUTION_COLLECTION).doc(row.peId);
  const historyRef = db.collection('pe_history').doc(row.peId);

  return db.runTransaction(async (txn) => {
    const existing = await txn.get(resolutionRef);
    if (existing.exists) return 'already_resolved';

    const snapshot = row.economic_snapshot;
    const doc = resolutionDocument(row, verdict, options);

    // The read of `pe_history` INSIDE the transaction is what makes a recorded
    // arrival or a promotion bind to the row as it stands at commit time rather
    // than to a stale read. Both persisting outcomes run it; every other
    // outcome writes nothing and returns.
    if (verdict.outcome === 'linked_evidence_recorded') {
      const current = await txn.get(historyRef);
      if (!current.exists) return 'refused_not_pending';
      const live = current.data() as { mint_status?: unknown; economic_snapshot_hash?: unknown };
      if (live.mint_status !== 'pending_evidence') return 'refused_not_pending';
      if (live.economic_snapshot_hash !== row.economic_snapshot_hash) {
        return 'refused_snapshot_unbound';
      }
      txn.set(resolutionRef, { ...doc, evidence_hash: evidenceHash });
      return verdict.outcome;
    }

    if (verdict.outcome === 'promoted') {
      const facts = verdict.promotion;
      const evidence = verdict.evidence;
      if (facts === undefined || evidence === undefined || snapshot === null) {
        // A `promoted` verdict without its facts is a construction error, never
        // a promotion. Fail closed: nothing written.
        return 'refused_verifier_error';
      }
      // THE WRITE LIVES IN THE SANCTIONED PROMOTER (`completion-promotion.ts`,
      // named in FC-014's `SANCTIONED_PENDING_EVIDENCE_PROMOTERS` under),
      // never in this sweep: FC-013 keeps proving the sweep can neither destroy
      // nor promote a held row on its own. It re-reads the row, claims the
      // completion slot, flips the disposition beside the projection built here,
      // and stamps the corroboration — all in THIS transaction — and reports.
      // A refusal writes nothing, and this sweep records nothing for it either
      // (the row stays reachable for the next pass).
      const applied = await applyCompletionPromotionInTransaction(db, txn, {
        peId: row.peId,
        economicSnapshotHash: row.economic_snapshot_hash,
        recordPointsAtomic: snapshot.recordPointsAtomic,
        facts,
        projection: buildCompletionEligibilityProjection(evidence),
        nowMs: options.nowMs,
      });
      if (applied !== 'promoted') return applied;
      txn.set(resolutionRef, { ...doc, evidence_hash: evidenceHash });
      return verdict.outcome;
    }

    return verdict.outcome;
  });
}

/**
 * PE METER — apply ONE verdict to a METERED held act (`meter_held_acts_v1/{relay_pe_id}`, held
 * at `pending_evidence`), whose row lives in its held record rather than `pe_history`.
 *
 * The same outcomes, the same durable per-PE resolution record, the same re-checks:
 *  - every outcome first reads the resolution record — present means `already_resolved`;
 *  - a mode-(a) ARRIVAL is recorded in ONE transaction that re-reads the held row (still
 *    `pending_evidence`, snapshot hash unmoved) beside the create-if-absent resolution record;
 *  - a PROMOTION goes through the sanctioned promoter's held-act path
 *    (`applyCompletionPromotionToHeldAct`): it claims the completion slot, then transitions the
 *    act through `resolveHeldAct` with an `expect` re-checking exactly what the pre-meter
 *    transaction re-checks (still `pending_evidence`, snapshot hash unmoved). Only a promotion
 *    that landed writes the resolution record (create-if-absent). The promotion itself is the
 *    exactly-once guard here: it removes the hold, so a second pass can neither find nor promote
 *    the act again, and its claims are created with `create` (a second write fails);
 *  - every other outcome writes nothing.
 */
export async function applyPendingEvidenceVerdictToHeldAct(
  db: admin.firestore.Firestore,
  row: HeldPendingEvidenceRow,
  verdict: Verdict,
  options: PendingEvidenceResolverOptions,
  evidenceHash: string | null,
): Promise<PendingEvidenceResolutionOutcome> {
  const resolutionRef = db.collection(PENDING_EVIDENCE_RESOLUTION_COLLECTION).doc(row.peId);
  const heldRef = privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(row.peId);
  const doc = resolutionDocument(row, verdict, options);

  if (verdict.outcome === 'linked_evidence_recorded') {
    return db.runTransaction(async (txn): Promise<PendingEvidenceResolutionOutcome> => {
      const existing = await txn.get(resolutionRef);
      if (existing.exists) return 'already_resolved';
      const held = await txn.get(heldRef);
      const live = held.exists ? (held.data() as Partial<HeldActDoc> | undefined)?.key?.row : undefined;
      if (live === undefined || live === null || typeof live !== 'object') return 'refused_not_pending';
      if (live.mint_status !== 'pending_evidence') return 'refused_not_pending';
      if (live.economic_snapshot_hash !== row.economic_snapshot_hash) return 'refused_snapshot_unbound';
      txn.set(resolutionRef, { ...doc, evidence_hash: evidenceHash });
      return verdict.outcome;
    });
  }

  const existing = await resolutionRef.get();
  if (existing.exists) return 'already_resolved';

  if (verdict.outcome === 'promoted') {
    const facts = verdict.promotion;
    const evidence = verdict.evidence;
    const snapshot = row.economic_snapshot;
    if (facts === undefined || evidence === undefined || snapshot === null) {
      // A `promoted` verdict without its facts is a construction error, never a promotion.
      return 'refused_verifier_error';
    }
    // THE WRITE LIVES IN THE SANCTIONED PROMOTER (FC-013 / FC-014), exactly as for a pre-meter row.
    const applied = await applyCompletionPromotionToHeldAct(db, {
      peId: row.peId,
      economicSnapshotHash: row.economic_snapshot_hash,
      recordPointsAtomic: snapshot.recordPointsAtomic,
      facts,
      projection: buildCompletionEligibilityProjection(evidence),
      nowMs: options.nowMs,
    });
    if (applied !== 'promoted') return applied;
    await db.runTransaction(async (txn) => {
      const again = await txn.get(resolutionRef);
      if (!again.exists) txn.set(resolutionRef, { ...doc, evidence_hash: evidenceHash });
    });
    return verdict.outcome;
  }

  return verdict.outcome;
}

/** Judge and apply one METERED held act; the row is the held record's copy of its act key row. */
async function resolveHeldPendingEvidenceAct(
  deps: PendingEvidenceResolverDeps,
  held: HeldActRow,
  options: PendingEvidenceResolverOptions,
): Promise<PendingEvidenceResolutionOutcome> {
  const raw: unknown = held.row;
  if (!isHeldRow(raw) || raw.peId !== held.relayPeId) {
    console.error('[PendingEvidenceResolver] malformed metered held act, skipping', {
      relayPeId: held.relayPeId,
    });
    return 'refused_snapshot_unbound';
  }
  try {
    const verdict = await judgePendingEvidenceRow(deps, raw, options);
    const evidenceHash = verdict.evidence ? hashResolutionEvidence(verdict.evidence) : null;
    return await applyPendingEvidenceVerdictToHeldAct(deps.db, raw, verdict, options, evidenceHash);
  } catch (error) {
    // Fail CLOSED on the act, keep sweeping (the pre-meter rule).
    console.error('[PendingEvidenceResolver] held act judgement threw', { relayPeId: held.relayPeId, error });
    return 'refused_verifier_error';
  }
}

export async function readResolverCursor(
  db: admin.firestore.Firestore,
): Promise<PendingEvidenceResolverCursorDocument | null> {
  const snap = await db.collection(PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION)
    .doc(PENDING_EVIDENCE_RESOLVER_CURSOR_DOC)
    .get();
  if (!snap.exists) return null;
  const row = snap.data() as Partial<PendingEvidenceResolverCursorDocument> | undefined;
  if (row === undefined || row.schema_version !== 'pvt-pending-evidence-resolver-cursor/v1') {
    // Fail FORWARD, same direction as the replay cursor and for the same
    // reason: losing our place costs a re-scan of rows that are cheap to
    // re-judge, while refusing to sweep costs the resolution this exists for.
    return null;
  }
  return row as PendingEvidenceResolverCursorDocument;
}

function emptyResult(): {
  -readonly [K in keyof PendingEvidenceResolverResult]: PendingEvidenceResolverResult[K]
} {
  return {
    scanned: 0,
    already_resolved: 0,
    promoted: 0,
    awaiting_counterparty_confirmation: 0,
    awaiting_verified_evidence: 0,
    linked_evidence_recorded: 0,
    awaiting_linked_evidence_pe: 0,
    refused_no_verifier_for_class: 0,
    refused_completion_binding: 0,
    refused_completion_self_dealing: 0,
    refused_completion_counterparty_unresolvable: 0,
    refused_no_authoritative_actor: 0,
    refused_snapshot_unbound: 0,
    refused_not_pending: 0,
    refused_session_lineage_unresolvable: 0,
    refused_verifier_error: 0,
    refused_promotion_would_create_mint_authority: 0,
    refused_canonical_event_already_minted: 0,
    population: 0,
    population_empty: true,
    cursor_advanced: false,
    cursor_wrapped: false,
    cycles_completed: 0,
    held_acts_scanned: 0,
    held_acts_cursor_wrapped: false,
    held_acts_reached_end: false,
  };
}

/**
 * One sweep over the held rows.
 *
 * Ordered oldest-first and resumed from the durable cursor, so successive passes
 * WALK `pe_history` instead of re-reading its head — the defect found in
 * the replay driver, which is the same query shape a naive version of this sweep
 * would use over a much larger collection.
 */
export async function sweepPendingEvidence(
  deps: PendingEvidenceResolverDeps,
  options: PendingEvidenceResolverOptions,
): Promise<PendingEvidenceResolverResult> {
  const result = emptyResult();
  const limit = options.limit ?? 100;

  const cursor = await readResolverCursor(deps.db);

  // H5 — the sweep is ONE query per pass, over ONE index shard at a time
  // in sharded reader mode (served by (index_shard, mint_status, timestamp,
  // peId)); the legacy plan is the single unsharded shard `null`, which makes
  // every branch below read exactly as it did before H5. Reaching the end of a
  // shard moves the cursor to the NEXT shard's head; passing the last shard is
  // what completes a cycle.
  const plan = shardPlan(await readPeHistoryReaderMode(deps.db));
  const cursorShard: number | null = cursor !== null
    && typeof cursor.shard === 'number'
    && plan.includes(cursor.shard)
    ? cursor.shard
    : plan[0];
  const nextShardAfter = (shard: number | null): { shard: number | null; wrapped: boolean } => {
    const index = plan.indexOf(shard);
    const nextIndex = (index + 1) % plan.length;
    return { shard: plan[nextIndex], wrapped: nextIndex === 0 };
  };
  const baseFor = (shard: number | null): admin.firestore.Query => withIndexShard(deps.db.collection('pe_history'), shard)
    .where('mint_status', '==', 'pending_evidence')
    .orderBy('timestamp', 'asc')
    .orderBy('peId', 'asc');

  let shard = cursorShard;
  const resumable = cursor !== null
    && cursor.last_timestamp_ms !== null
    && cursor.last_pe_id !== null;
  let snapshot = await (resumable
    ? baseFor(shard).startAfter(cursor.last_timestamp_ms, cursor.last_pe_id)
    : baseFor(shard)).limit(limit).get();

  let wrapped = false;
  if (snapshot.empty && resumable) {
    // This shard is exhausted past the cursor: walk on to the next shards'
    // heads (at most one full lap), wrapping to the first shard — which in
    // legacy mode is the same single range, i.e. the original head restart.
    for (let hops = 0; hops < plan.length && snapshot.empty; hops += 1) {
      const next = nextShardAfter(shard);
      shard = next.shard;
      if (next.wrapped) wrapped = true;
      snapshot = await baseFor(shard).limit(limit).get();
    }
  }

  let lastTimestampMs: number | null = null;
  let lastPeId: string | null = null;

  for (const doc of snapshot.docs) {
    result.scanned += 1;
    const raw: unknown = doc.data();
    if (!isHeldRow(raw)) {
      // Refuse the ROW, advance the CURSOR. A row we will not act on must never
      // become a permanent occupant of the window — the second half of the
      // defect the cursor exists to fix.
      result.refused_snapshot_unbound += 1;
      const partial = raw as { timestamp?: unknown } | null;
      if (partial !== null && typeof partial.timestamp === 'number') {
        lastTimestampMs = partial.timestamp;
        lastPeId = doc.id;
      }
      console.error('[PendingEvidenceResolver] malformed pe_history row, skipping', {
        peId: doc.id,
      });
      continue;
    }
    lastTimestampMs = raw.timestamp;
    lastPeId = raw.peId;

    let outcome: PendingEvidenceResolutionOutcome;
    try {
      const verdict = await judgePendingEvidenceRow(deps, raw, options);
      const evidenceHash = verdict.evidence ? hashResolutionEvidence(verdict.evidence) : null;
      outcome = await applyPendingEvidenceVerdict(deps.db, raw, verdict, options, evidenceHash);
    } catch (error) {
      // Fail CLOSED on the row, keep sweeping. One bad row must not wedge the
      // pass, and a thrown row is never treated as resolved.
      outcome = 'refused_verifier_error';
      console.error('[PendingEvidenceResolver] row judgement threw', { peId: raw.peId, error });
    }
    result[outcome] += 1;
  }

  result.population = result.scanned;
  result.population_empty = result.scanned === 0;

  const reachedEnd = snapshot.size < limit;
  // At the end of a shard the cursor moves to the NEXT shard's head — in legacy
  // mode the same single range's head, exactly the pre-H5 reset. Passing the
  // last shard (or wrapping above) completes a cycle.
  const advance = reachedEnd ? nextShardAfter(shard) : { shard, wrapped: false };
  const nextShard = advance.shard;
  const cycleCompleted = wrapped || (reachedEnd && advance.wrapped);
  const nextTimestamp = reachedEnd ? null : lastTimestampMs;
  const nextPeId = reachedEnd ? null : lastPeId;

  // THE ADVANCEMENT CHECK. A pass that examined at least one row must leave the
  // cursor somewhere other than where it started. `reachedEnd` counts as
  // advancement because resetting to the head IS movement — it opens the next
  // cycle. A pass that examined rows, did not reach the end, and did not move is
  // the defect, and it is reported rather than inferred.
  result.cursor_advanced = result.scanned === 0
    ? false
    : (reachedEnd || wrapped
      || nextShard !== cursorShard
      || nextTimestamp !== (cursor?.last_timestamp_ms ?? null)
      || nextPeId !== (cursor?.last_pe_id ?? null));
  result.cursor_wrapped = wrapped;
  result.cycles_completed = (cursor?.cycles_completed ?? 0) + (cycleCompleted ? 1 : 0);

  if (result.scanned > 0 && !result.cursor_advanced) {
    console.error('[PendingEvidenceResolver] SWEEP DID NOT ADVANCE — cursor is stuck', {
      scanned: result.scanned,
      lastTimestampMs,
      lastPeId,
    });
  }

  await deps.db.collection(PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION)
    .doc(PENDING_EVIDENCE_RESOLVER_CURSOR_DOC)
    .set({
      schema_version: 'pvt-pending-evidence-resolver-cursor/v1',
      last_timestamp_ms: nextTimestamp,
      last_pe_id: nextPeId,
      shard: nextShard,
      updated_at_ms: options.nowMs,
      cycles_completed: result.cycles_completed,
    } satisfies PendingEvidenceResolverCursorDocument);

  // PE METER — the second population: metered acts held at `pending_evidence`. Same judgement,
  // same outcomes, same tallies; its own resumable cursor and page budget (one page of `limit`
  // per pass, like the pre-meter walk above).
  const held = await walkHeldActs(deps.db, 'pending_evidence', {
    cursor: {
      collection: PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION,
      docId: PENDING_EVIDENCE_RESOLVER_HELD_CURSOR_DOC,
    },
    nowMs: options.nowMs,
    limit,
    maxPages: 1,
  }, async (heldAct) => {
    result.scanned += 1;
    result[await resolveHeldPendingEvidenceAct(deps, heldAct, options)] += 1;
  });
  result.held_acts_scanned = held.scanned;
  result.held_acts_cursor_wrapped = held.wrapped;
  result.held_acts_reached_end = held.reached_end;
  result.population = result.scanned;
  result.population_empty = result.scanned === 0;

  return result;
}

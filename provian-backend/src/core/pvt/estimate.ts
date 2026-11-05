/**
 * PVT pre-submission estimate — the user-facing wrapper over the ONE pricing
 * truth in `policy/record-path-estimate.ts`.
 *
 * WHAT CHANGED AND WHY (C-2). This module used to compute its own answer from
 * `pe-weight-framework::calculatePEWeight` — a float tier table that is not
 * what the rail pays. It now maps the public query onto the kernel-shaped
 * params of `estimateFromRecordPath` and formats the result. It performs NO
 * arithmetic of its own: every number below is read off a
 * `computeRecordSnapshot` snapshot, so the estimate cannot drift from the
 * record path without breaking the parity suite.
 *
 * `pe-weight-framework` is deliberately NOT imported here any more. It is still
 * live for other jobs (attestation-tier reads, delegation tiering, outcome
 * anchors, catalog category seeds, and the accrual's own tier normalization) —
 * it is quarantined from PRICING a user-facing earnings surface, not deleted.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  estimateFromRecordPath,
  computeOrdinaryEstimateSnapshot,
  type RecordPathEstimate,
  type RecordPathEstimateParams,
} from './policy/record-path-estimate';
import {
  computeRecordSnapshot,
  BPS_DENOMINATOR,
  type LinkageState,
  type MintDisposition,
  type MintReasonCode,
} from './policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';
import { PROPOSED_ATTESTATION_MULTIPLIERS_BPS } from './policy/proposed-monetary-policy';

// ---------------------------------------------------------------------------
// Disclaimers — the mint-once language is a launch copy invariant. Never
// return an estimate without it ("every act of work mints once at its
// best-supported value"), and never let a fiat value or price imply itself in.
// ---------------------------------------------------------------------------

export const ELIGIBILITY_DISCLAIMER =
  'Every valid PE is proof its contributor owns; every act of work mints PVT once at its best-supported value.';

const ESTIMATE_DISCLAIMER =
  'Pre-submission estimate at current protocol weights — not a quote, promise, or guarantee. '
  + 'Every act of work mints its base once; evidence quality, novelty, and independent telemetry '
  + 'multiply that value, while duplication checks preserve mint-once. The relay checks actor and recipient country/region from their own authenticated IP sessions and screens wallet addresses against the current OFAC SDN list. Jurisdiction blocks hold acts until policy permits release at their sealed value; only SDN hits are terminal. Unknown location or unavailable screening holds the act for automatic re-evaluation at its sealed value; deferred jurisdictions retain their graduated release path. Scenario estimates do not authorize settlement.';

const QUANTITY_DISCLAIMER =
  'PVT quantities only: nothing in this response states or implies a fiat value, price, or return.';

const LINKAGE_DISCLAIMER =
  'human_linked is scenario input only. Runtime applies the separate 2.0x human-trust factor only after verifying direct-human identity or an agent human-beneficiary relationship; device ownership, signing method, and attestation never create linkage.';

const ATTESTATION_DISCLAIMER =
  'Attestation is a separate evidence factor on the complete configured 0.5x-2.5x range; no attestation tier establishes eligibility.';

const FORMULA_DISCLAIMER =
  'Ordinary accounting is base points times action weight, occurrence-derived novelty, verified linkage, and attestation. There is no daily diminishing multiplier and no per-user volume cap of any kind: an act pays its full rate regardless of same-day volume. Occurrence is not a second multiplier.';

const VOLUME_DISCLAIMER =
  'Volume is never capped or repriced: there is no hourly or daily per-user PE limit and no daily qualification ordinal. Repetition is priced by novelty (exact duplicates mint 0), and per-action identity-based anti-farm caps on financial types still apply.';

const CHAIN_VERIFIED_DISCLAIMER =
  'Financial action types (including x402_payment) mint only when the on-chain event is '
  + 'chain-verified by Provian\'s watchers; self-reported settlements record provenance but mint 0 PVT.';

/**
 * The distinction this endpoint exists to stop blurring: the kernel seals
 * participation units, and only an `eligible` disposition can turn them into
 * PVT. A large record-points figure on a `record_only` PE is worth nothing.
 */
const DISPOSITION_DISCLAIMER =
  'record_points are sealed participation units, NOT PVT. estimated_pvt is zero unless '
  + 'mint_disposition is "eligible": a record_only or ineligible_terminal PE mints 0 no matter how '
  + 'large its record points, and pending_evidence / pending_review must first be resolved by '
  + 'verified evidence.';

/**
 * Attestation tiers this endpoint accepts: every tier the PRICING kernel has a
 * multiplier for, plus the `hardware` alias the wire enum uses. Sourced from
 * the bps table the kernel actually prices with, so a tier can never be
 * accepted here that the kernel would reject at record time.
 */
export const VALID_ESTIMATE_ATTESTATION_TIERS: readonly string[] = Object.freeze([
  ...Object.keys(PROPOSED_ATTESTATION_MULTIPLIERS_BPS),
  'hardware',
]);

export interface PVTEstimateParams {
  /** §2.8 lane the submission would seal under (`witness_class` query); default actor_declared. */
  witnessClass?: string;
  actionType: string;
  /** Attestation tier; defaults to the 'software' baseline. */
  attestationTier?: string;
  /**
   * How many PEs of this action type this identity has ALREADY recorded
   * (drives novelty). 0 = first-ever, the un-decayed base weight.
   */
  novelty?: number;
  /**
   * PEs this identity has already recorded today. Scenario input only —
   * same-day volume neither reprices nor disqualifies an act;
   * it is sealed as the `dailyOrdinal` provenance fact.
   */
  count?: number;
  /** Whether the identity is beneficiary-linked to a verified human. */
  humanLinked?: boolean;
  /**
   * Whether the caller submits through a durable inlet. Defaults to false —
   * the ordinary relay report path is best-effort and seals record_only.
   */
  durableSubmissionPath?: boolean;
  /**
   * Scenario input for a Commons speech action type: whether the speaker holds a live pass
   * (fact-base fixes item 1). Default TRUE — a forum post, reply, vote, flag, want, or job post
   * cannot be written without one, so the quote a caller most needs is the one that mints. Pass
   * false to quote a thread message sent inside an open relationship with no pass (records, 0 PVT).
   */
  speechPass?: boolean;
  /** Test injection only. Production verifies the configured Genesis SSHSIG. */
  genesisApprovalVerifier?: RecordPathEstimateParams['genesisApprovalVerifier'];
}

export interface PVTEstimateResult {
  /** PVT the rail would pay. Zero unless the disposition is `eligible`. */
  estimated_pvt: number;
  estimated_pvt_atomic: string;
  /** Sealed participation units. NOT PVT — see DISPOSITION_DISCLAIMER. */
  record_points: number;
  record_points_atomic: string;
  mint_disposition: RecordPathEstimate['mint_disposition'];
  mint_reason_code: RecordPathEstimate['mint_reason_code'];
  policy_version: string;
  inputs: {
    action_type: string;
    attestation_tier: string;
    novelty: number;
    count: number;
    human_linked: boolean;
    durable_submission_path: boolean;
    category: string | null;
    /** Integer bps, straight off the snapshot — never a float re-derivation. */
    effective_action_weight_bps: number;
    attestation_multiplier_bps: number;
    novelty_bps: number;
    linkage_multiplier_bps: number;
    financial_full_weight: boolean;
    fixed_grant_atomic: string | null;
    unresolved_record_gates: readonly string[];
    breakdown: string;
  };
  genesis: RecordPathEstimate['genesis'];
  assumptions: readonly string[];
  disclaimers: string[];
}

const ATOMIC_SCALE = 10n ** 18n;

/** Exact atomic → display number. Never used for anything economic. */
export function atomicToDisplay(atomic: string): number {
  const value = BigInt(atomic);
  const whole = value / ATOMIC_SCALE;
  const fraction = (value % ATOMIC_SCALE).toString(10).padStart(18, '0').slice(0, 8);
  return Number(`${whole.toString(10)}.${fraction}`);
}

function breakdownFor(estimate: RecordPathEstimate): string {
  const f = estimate.factors;
  if (f.fixed_grant_source === 'genesis_campaign_reservation') {
    return estimate.genesis?.reservable
      ? `Genesis fixed grant ${f.fixed_grant_atomic} atomic, reserved exactly (no time-based reduction).`
      : `Genesis grant not reservable at this instant: ${estimate.genesis?.deny_reason ?? 'unknown'}.`;
  }
  const parts = `${f.base_points_atomic} base x ${f.effective_action_weight_bps}bps action`
    + ` x ${f.novelty_bps}bps novelty x ${f.daily_diminishing_bps}bps daily`
    + ` x ${f.linkage_multiplier_bps}bps linkage x ${f.attestation_multiplier_bps}bps attestation`
    + ` / ${BPS_DENOMINATOR}^5 = ${estimate.record_points_atomic} record points`;
  return `${parts} -> ${estimate.mint_disposition} (${estimate.mint_reason_code})`
    + `${estimate.mint_disposition === 'eligible' ? '' : ', mints 0 PVT'}`;
}

function present(
  estimate: RecordPathEstimate,
  params: PVTEstimateParams,
): PVTEstimateResult {
  const f = estimate.factors;
  const disclaimers = [
    ELIGIBILITY_DISCLAIMER,
    ESTIMATE_DISCLAIMER,
    QUANTITY_DISCLAIMER,
    DISPOSITION_DISCLAIMER,
    LINKAGE_DISCLAIMER,
    ATTESTATION_DISCLAIMER,
    FORMULA_DISCLAIMER,
    VOLUME_DISCLAIMER,
    ...(f.financial_attestation_neutral ? [CHAIN_VERIFIED_DISCLAIMER] : []),
  ];
  return {
    estimated_pvt: atomicToDisplay(estimate.estimated_pvt_atomic),
    estimated_pvt_atomic: estimate.estimated_pvt_atomic,
    record_points: atomicToDisplay(estimate.record_points_atomic),
    record_points_atomic: estimate.record_points_atomic,
    mint_disposition: estimate.mint_disposition,
    mint_reason_code: estimate.mint_reason_code,
    policy_version: estimate.policy_version,
    inputs: {
      action_type: estimate.action_type,
      attestation_tier: f.attestation_tier,
      novelty: params.novelty ?? 0,
      count: params.count ?? 0,
      human_linked: params.humanLinked === true,
      durable_submission_path: estimate.durable_submission_path,
      category: f.category,
      effective_action_weight_bps: f.effective_action_weight_bps,
      attestation_multiplier_bps: f.attestation_multiplier_bps,
      novelty_bps: f.novelty_bps,
      linkage_multiplier_bps: f.linkage_multiplier_bps,
      financial_full_weight: f.financial_attestation_neutral,
      fixed_grant_atomic: f.fixed_grant_atomic,
      unresolved_record_gates: f.unresolved_record_gates,
      breakdown: breakdownFor(estimate),
    },
    genesis: estimate.genesis,
    assumptions: estimate.assumptions,
    disclaimers,
  };
}

/**
 * The public estimator. `humanLinked` maps onto the kernel's `human_linked`
 * linkage state; the runtime independently verifies real linkage before
 * applying it.
 */
export async function estimatePVT(
  db: Firestore,
  params: PVTEstimateParams,
): Promise<PVTEstimateResult> {
  const linkageState: LinkageState = params.humanLinked === true ? 'human_linked' : 'unlinked';
  const estimate = await estimateFromRecordPath(db, {
    actionType: params.actionType,
    attestationTier: params.attestationTier ?? 'software',
    // The accrual submits occurrence = priorCount + 1 (this PE counts itself),
    // and dailyOrdinal = priorToday + 1. Mirrored exactly.
    occurrenceOrdinal: (params.novelty ?? 0) + 1,
    dailyOrdinal: (params.count ?? 0) + 1,
    linkageState,
    durableSubmissionPath: params.durableSubmissionPath === true,
    speechPassLive: params.speechPass !== false,
    ...(params.witnessClass ? { witnessClass: params.witnessClass } : {}),
    ...(params.genesisApprovalVerifier
      ? { genesisApprovalVerifier: params.genesisApprovalVerifier }
      : {}),
  });
  return present(estimate, params);
}

/**
 * What the PE-submission response stamps: the figure AND the disposition that
 * decides whether it can ever be paid. Both, always — a number without its
 * disposition is the C-2 defect.
 */
export interface SubmitTimeEstimate {
  readonly estimated_pvt: number;
  readonly mint_disposition: MintDisposition;
  readonly mint_reason_code: MintReasonCode;
}

/**
 * Synchronous, zero-I/O estimate stamped on the PE-submission response (the
 * number `provian report` prints).
 *
 * IT IS DERIVED, NOT ASSERTED — and is why that mattered. It runs the
 * same disposition resolver and the same kernel as the accrual, so when the
 * mainline agent paths gained a verified durable replay source the response
 * followed on its own. Nothing here was retuned; the caller now passes
 * `durableSubmissionPath: true` because it IS one, and both the figure and the
 * disposition moved because the kernel says so. A hard-coded 0 and a hard-coded
 * `'record_only'` both of which this response used to carry — would have gone
 * on lying at exactly the moment the path started paying.
 *
 * The DISPOSITION is returned beside the number precisely because it is usually
 * not `eligible` a self-reported agent action requires verified compute-or-work
 * evidence, so it seals `pending_evidence` and pays 0 until that evidence is
 * attested. `estimated_pvt` is therefore zero unless the kernel says eligible.
 *
 * Uses the proposed policy template rather than the activation-gated live
 * vintage because it must not perform I/O. That choice cannot inflate the
 * answer: the live vintage is either this same template or the inactive
 * record-only one, and the inactive one can only be MORE restrictive.
 *
 * ── `deviceAnchorPresent: false` IS A FACT ABOUT THESE ROUTES ─────────
 * The generic estimator ASSUMES a device anchor is present unless told
 * otherwise (`record-path-estimate.ts` gates its device arm on an explicit
 * `=== false`), because a generic caller cannot know. This surface is not
 * generic: its only two callers were `POST /v1/relay/action` and
 * `POST /v1/relay/work-product`, both of which reached `sealActionPE`, which
 * passed NO `deviceAttestationId` and NO `deviceId` ever, structurally.
 * (moved both responses off this estimate; both routes are now retired
 * and their handlers deleted — PE meter, 2026-10-03 — so no relay route calls it.)
 *
 * Leaving the assumption in place produced a live over-quote the moment
 * flipped `durableSubmissionPath` to true: `action_type` is permissionless on
 * that route, so an agent posting `wallet_created` was answered
 * `{estimated_pvt: 10, mint_disposition: 'eligible'}` while the very same
 * submission sealed `ineligible_terminal` at 0, because Security Invariant #9's
 * device gate denies a rate-limited setup type with no anchor. Before the
 * response said 0/`record_only` and happened to match. So this is not a new
 * assumption — it is the removal of one that was never true here, and it is the
 * C-2 "ONE PRICING TRUTH" rule applied to the one input the route settles.
 */
export function computeSubmitTimeEstimate(
  actionType: string,
  options: { readonly durableSubmissionPath: boolean },
): SubmitTimeEstimate {
  const policy = materializeProposedMonetaryPolicy(0);
  // Genesis types never reach this surface: they are issued by the reservation
  // state machine, not self-reported, and the kernel throws without a receipt.
  if (policy.actions[actionType]?.fixedGrantSource === 'genesis_campaign_reservation') {
    return {
      estimated_pvt: 0,
      mint_disposition: 'record_only',
      mint_reason_code: 'policy_record_only',
    };
  }
  const snapshot = computeOrdinaryEstimateSnapshot(
    policy,
    {
      actionType,
      durableSubmissionPath: options.durableSubmissionPath,
      // See the docblock: structurally absent on both callers, never a dial.
      deviceAnchorPresent: false,
    },
    0,
  );
  return {
    estimated_pvt: snapshot.mintDisposition === 'eligible'
      ? atomicToDisplay(snapshot.recordPointsAtomic)
      : 0,
    mint_disposition: snapshot.mintDisposition,
    mint_reason_code: snapshot.mintReasonCode,
  };
}

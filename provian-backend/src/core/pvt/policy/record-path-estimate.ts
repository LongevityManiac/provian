import {readGenesisActivation} from '../genesis-activation-store';
/**
 * ONE PRICING TRUTH for every user-facing PVT estimate surface.
 *
 * WHY THIS MODULE EXISTS. `GET /v1/pvt/estimate` and the PE-submit response
 * used to quote `pe-weight-framework::calculatePEWeight` — a float tier table
 * that is NOT what the rail pays. The money path is
 * `monetary-accounting::computeRecordSnapshot`, an integer-bps kernel selected
 * by a signed activation document. Measured, the two disagreed in both
 * directions: `agent_work_product_code` quoted 2.4 against a record path of
 * 0.8, `wallet_created` quoted 1.6 against 10, the three Genesis types quoted
 * 0.8 against fixed grants of 75/75/25, and any permissionless namespaced type
 * quoted 0.8 against 0.
 *
 * So this module does not convert between the two systems and does not keep a
 * parallel table. It CALLS the money path:
 *
 *   resolveActionPolicyAtRecordTime  — the same record-time policy gate
 *   loadRuntimeMonetaryPolicy        — the same activation-gated policy vintage
 *   resolveOperationalDisposition    — the same operational override
 *   computeRecordSnapshot            — the same bps kernel
 *   reserveGenesisCampaignGrant      — the same fixed-grant reservation kernel
 *
 * A mutation on either side therefore breaks the parity suite, which is the
 * only property that makes "what's shown is what's paid" checkable rather than
 * asserted.
 *
 * IT WRITES NOTHING. `resolveActionPolicyAtRecordTime` is the read-only
 * resolver; the queue-writing `resolveAndObserveActionPolicy` is deliberately
 * NOT called. `reserveGenesisCampaignGrant` is a pure function over a manifest,
 * an activation, and a ledger state — the estimate hands it a FRESH empty
 * ledger and discards both the receipt and the returned next-state.
 *
 * RECORD POINTS ARE NOT PVT. The kernel seals participation units; whether they
 * can ever become PVT is the mint DISPOSITION, and on the live best-effort
 * submission path that disposition is `record_only` — which pays zero no matter
 * how large the points are. Quoting the number without the disposition is the
 * defect; both are returned here, and `estimated_pvt_atomic` is zero unless the
 * disposition is `eligible`.
 */

import { accrualEndedAt } from '../accrual-end-line';
import { speechPeNeedsPass } from '../speech-window-budget';
import type { Firestore } from 'firebase-admin/firestore';
import {
  computeRecordSnapshot,
  type EvidenceState,
  type LinkageState,
  type MintDisposition,
  type MintReasonCode,
  type MonetaryPolicyVersion,
  type PolicyReviewReasonCode,
  type PolicyReviewState,
  type RecordCalculationInput,
  type RecordEconomicSnapshot,
} from './monetary-accounting';
import {
  loadRuntimeMonetaryPolicy,
  materializeProposedMonetaryPolicy, withWitnessClassOverride } from './runtime-monetary-policy';
import { normalizeWitnessClass, WITNESSED_CLASSES } from './evidence-class';
import { resolveActionPolicyAtRecordTime } from './action-policy-gate';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';
import {
  createEmptyGenesisLedgerState,
  reserveGenesisCampaignGrant,
  resolveGenesisBountyPolicy,
  verifyGenesisCampaignActivationApproval,
  type GenesisActivationApprovalVerifier,
  type GenesisCampaignActivation,
  type GenesisReservationDenyReason,
} from './genesis-policy-engine';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
} from '../genesis-award-state-machine';
import {
  normalizeEconomicAttestationTier,
  resolveOperationalDisposition,
} from '../../../pvt-accrual';
import { isDeviceRateLimited } from '../../../device-pe-rate-limiter';
import { getActionTypeMintRule } from '../activity-mint-limits';
import { decideFinancialEconomicCaps } from '../economics/financial-economic-authority';
import { isResolvableCounterpartyAddress } from './same-owner-detection';
import { provianServiceFeeApplies } from '../provian-service-wallets';

/**
 * Every estimate-time input the caller cannot know, named once. The estimate
 * states the assumption it made rather than inventing a number for it.
 */
export const ESTIMATE_ASSUMPTIONS = Object.freeze({
  ACCRUAL_ENDED:
    'the accrual end line has passed (shutdown coverage, Terms 24.3): an act the relay receives now '
    + 'is recorded and counted but seals record_only and mints 0 PVT, and Genesis admits no new grant.',
  SCENARIO_ORDINALS:
    'novelty and count are caller-supplied scenario inputs; the runtime reads the actor\'s real '
    + 'occurrence and same-UTC-day ordinals at record time, which can differ.',
  EVIDENCE_PENDING:
    'evidence is assumed UNVERIFIED, the same default the accrual applies to a submission that '
    + 'carries no verified canonical event. An action type whose policy requires evidence cannot '
    + 'seal eligible until a trusted verifier attests the event.',
  BEST_EFFORT_PATH:
    'assumes the ordinary best-effort submission path, which has no durable replay source and is '
    + 'therefore sealed record_only and mints 0 PVT regardless of record points. Only the durable '
    + 'inlets (human wallet registration, device registration, the Genesis award state machine, '
    + 'and the chain-verified USDC watchers) can seal a mintable disposition.',
  DURABLE_PATH:
    'assumes a durable submission inlet. The ordinary relay report path is NOT durable and seals '
    + 'record_only.',
  LINKAGE_SCENARIO:
    'linkage is a scenario input. The runtime independently verifies direct-human identity or an '
    + 'agent human-beneficiary relationship; device ownership, signing method and attestation '
    + 'never create linkage.',
  SETTLEMENT_FACTORS:
    'settlement-time factors are NOT modelled: a verified attestation upgrade inside the 72-hour '
    + 'window and the epoch\'s armed global mint rate both apply after record time.',
  GENESIS_FRESH_LEDGER:
    'assumes the wallet has consumed none of its Genesis lifetime cap. A wallet with prior Genesis '
    + 'reservations receives the remaining headroom instead of the full fixed grant.',
  GENESIS_EVALUATED_AT_WINDOW_START:
    'the Genesis campaign window is not open at this instant, so the grant was evaluated at the '
    + 'window\'s opening instant — the earliest moment a qualifying act could be reserved.',
  BENEFICIARY_ROUTING:
    'record points are gross. A beneficiary-linked contributor receives the configured agent share '
    + 'of them, and the immutable Provian and Foundation treasury rates apply at settlement.',
  NO_SESSION_LINEAGE:
    'assumes the submission carries NO session lineage, matching the live submission paths. An '
    + 'action type whose policy requires session lineage seals record_only without it.',
  DEVICE_ANCHOR_PRESENT:
    'this is a device-rate-limited setup action. The estimate assumes a hardware device anchor is '
    + 'present and its rate-limit window is open. Without an anchor the action records and mints 0 '
    + '(Security Invariant #9), and a repeat inside the window is terminally ineligible.',
  X402_SELF_REPORT:
    'a self-reported x402 settlement mints 0. Only Provian\'s outbound-USDC watcher, which reads '
    + 'the real on-chain Transfer log, is a mintable witness; a client-supplied settlement hash is '
    + 'not evidence.',
  ACTIVITY_CAPS_FRESH:
    'this action type carries a standing per-actor daily mint ceiling (per UTC day). The estimate '
    + 'assumes NO prior usage against it today, which is the most favourable case; an actor already '
    + 'at the ceiling mints 0 for that act, terminally.',
  COUNTERPARTY_UNVERIFIED:
    'this action type requires a verified counterparty to mint. Without one the act is capped '
    + 'unverifiable_counterparty and mints 0 regardless of its record points.',
  OBSERVABLE_OUTPUT:
    'assumes the act produced observable output. An act the observer records with none is '
    + 'terminally ineligible.',
  COMPLETION_COUNTERPARTY_ABSENT:
    'this action type is in the completion family (verified_substantive_outcome): the '
    + 'counterparty IS its anti-self-dealing guarantee. No counterparty address was '
    + 'supplied, so the act holds for review (pending_review) and mints 0 until one is; pass '
    + 'counterpartyAddress (a well-formed EVM address — never a wallet id) to quote the held '
    + 'pending_evidence path the real submission takes.',
  RECEIVE_UNSOLICITED_ASSUMED:
    'a `receive` is assumed UNSOLICITED — no recipient-authored relationship to its counterparty '
    + '(a prior outbound send/x402_payment, an escrow, or a job) — the conservative default, since '
    + 'this estimate performs no live registry read. An unsolicited receive seals record_only and '
    + 'mints 0 regardless of record points; pass receiveAuthored: true only when the caller can '
    + 'assert the relationship actually exists.',
  SPEECH_PASS_LIVE:
    'a Commons speech act mints only while the speaker holds a live pass (a presentation to '
    + '`provian:commons` inside its window) and only inside that pass\'s budget; this quote assumes '
    + 'a live pass with budget left. A forum post, reply, vote, flag, want, or job post cannot be '
    + 'written without one; a thread message sent inside an open relationship without a pass '
    + 'records and mints 0 (speech_no_live_pass_record_only).',
  SPEECH_NO_PASS:
    'a Commons speech act with no live pass records and mints 0 '
    + '(speech_no_live_pass_record_only); this quote assumes no pass.',
});

/** Kernel-shaped estimate inputs. The public route maps its query onto these. */
export interface RecordPathEstimateParams {
  readonly actionType: string;
  /**
   * §2.8: the witness class the submission would seal under (`device_tier` on `/v1/pe/submit`,
   * `actor_declared` for a bare self-report…). Unnamed types earn at the class base, so the
   * estimate must know the lane to quote what the record path seals. Defaults
   * to `actor_declared` — the fail-closed lane, which quotes record_only for an unnamed type.
   */
  readonly witnessClass?: string;
  /** Wire attestation tier; normalized exactly as the accrual normalizes it. */
  readonly attestationTier?: string;
  /** 1-based occurrence ordinal for this action type. Defaults to first-ever. */
  readonly occurrenceOrdinal?: number;
  /** 1-based same-UTC-day ordinal for this actor. Defaults to first today. */
  readonly dailyOrdinal?: number;
  readonly linkageState?: LinkageState;
  /** Omitted means "the accrual's own default for this action's policy". */
  readonly evidenceState?: EvidenceState;
  readonly uniqueArtifact?: boolean;
  /**
   * Session lineage the submission would carry. Defaults to ABSENT, which is
   * what the live submission paths pass; action types whose policy requires it
   * therefore seal record_only unless the caller says otherwise.
   */
  readonly sessionLineageId?: string | null;
  /**
   * For device-rate-limited setup types only. Defaults to true — the estimate
   * answers "what does this pay when done correctly" — and the assumption is
   * stated in the response. Agent-owned `device_register` deliberately passes
   * NO anchor in production and therefore mints 0.
   */
  readonly deviceAnchorPresent?: boolean;
  /**
   * x402 only. Defaults to FALSE: a self-report is not a mintable witness, and
   * assuming otherwise would quote a payment the rail refuses.
   */
  readonly chainVerifiedSettlement?: boolean;
  /**
   * Financial types that require a verified counterparty (`send`,
   * `x402_payment`) only. Defaults to FALSE, which is what an unidentified submission gets:
   * the accrual caps it `unverifiable_counterparty` and suppresses its points.
   */
  readonly counterpartyVerified?: boolean;
  /**
   * Observer gate. The accrual seals a PE with no observable output terminally
   * ineligible; defaults to false (output present).
   */
  readonly noObservableOutput?: boolean;
  /**
   * `receive` only. Defaults to FALSE — the conservative assumption
   * because unlike `sameOwnerUnresolvable`/`cacheUnavailable` below (both
   * hardcoded false: recoverable holds an estimate is safe to assume away),
   * an unauthored `receive` seals TERMINAL `record_only`. Assuming
   * authorship would let this estimate quote `eligible` for an act the rail
   * could permanently zero. The accrual's real check
   * (`core/pvt/policy/receive-authorship.ts`) needs a live DB read this
   * estimate deliberately never performs, so the caller must assert it.
   */
  readonly receiveAuthored?: boolean;
  /**
   * Completion family (`verified_substantive_outcome`) only — * 2 on. The counterparty address the submission would
   * carry. Defaults to ABSENT, which the accrual holds `pending_review` the
   * distinct-owner fence cannot run without a resolvable EVM address, and a
   * non-address (a wallet id) is exactly as unresolvable as none. Quoting the
   * `pending_evidence` path requires the caller to name a real one.
   *
   * Every action type : a counterparty that is one of Provian's own fee / gas /
   * revenue wallets seals `record_only` (`provian_service_fee`) exactly as the accrual seals it —
   * a pure address match, so the quote mirrors it (C-2, one pricing truth).
   */
  readonly counterpartyAddress?: string | null;
  /**
   * The canonical event identifier the submission would carry (a tx hash,
   * artifact hash or commit sha). Only consulted when evidence is verified;
   * absent means absent, exactly as in the accrual.
   */
  readonly canonicalEventId?: string | null;
  /**
   * Whether the caller submits through a DURABLE inlet. Defaults to false,
   * because the ordinary relay report path is best-effort and that is what a
   * caller integrating against `/v1/relay/action` actually gets.
   */
  readonly durableSubmissionPath?: boolean;
  /**
   * Fact-base fixes item 1 (2026-09-23): whether the speaker holds a live pass (a presentation to
   * `provian:commons` within its window). Absent/false for every submit path (none carries a pass),
   * so a speech action type quotes `record_only` exactly as it seals. The public estimator
   * (`GET /v1/pvt/estimate`) takes it as the `speech_pass` scenario input, default true.
   */
  readonly speechPassLive?: boolean;
  /** Evaluation instant. Defaults to now. */
  readonly recordedAtMs?: number;
  /** Test injection only. Production verifies the configured Genesis SSHSIG. */
  readonly genesisApprovalVerifier?: GenesisActivationApprovalVerifier;
}

export interface RecordPathEstimateFactors {
  readonly base_points_atomic: string;
  readonly category: string | null;
  readonly base_action_weight_bps: number;
  readonly policy_override_bps: number | null;
  readonly effective_action_weight_bps: number;
  readonly occurrence_ordinal: number;
  readonly novelty_bps: number;
  readonly daily_ordinal: number;
  readonly daily_diminishing_bps: number;
  readonly attestation_tier: string;
  readonly attestation_multiplier_bps: number;
  readonly financial_attestation_neutral: boolean;
  readonly linkage_state: LinkageState;
  readonly linkage_multiplier_bps: number;
  readonly evidence_state: EvidenceState;
  readonly evidence_requirement: string;
  readonly fixed_grant_source: string;
  readonly fixed_grant_atomic: string | null;
  /**
   * True when a terminal operational verdict (device rate limit, unverified
   * x402, beyond the daily bound) zeroes the points OUTRIGHT. Without this the
   * bps product alone does not explain the sealed number, so it is reported.
   */
  readonly suppress_record_points: boolean;
  readonly unresolved_record_gates: readonly string[];
}

export interface RecordPathEstimate {
  readonly action_type: string;
  readonly policy_version: string;
  readonly evaluated_at_ms: number;
  /** Exactly what `computeRecordSnapshot` would seal, in 18-decimal atomic units. */
  readonly record_points_atomic: string;
  /** Zero unless the disposition is `eligible`. Never a figure the rail won't pay. */
  readonly estimated_pvt_atomic: string;
  readonly mint_disposition: MintDisposition;
  readonly mint_reason_code: MintReasonCode;
  readonly policy_review_state: PolicyReviewState;
  readonly policy_review_reason_code: PolicyReviewReasonCode;
  readonly durable_submission_path: boolean;
  readonly factors: RecordPathEstimateFactors;
  /** Present only for Genesis action types. */
  readonly genesis: {
    readonly canonical_bounty_key: string | null;
    readonly reservable: boolean;
    readonly deny_reason: GenesisReservationDenyReason | null;
  } | null;
  readonly assumptions: readonly string[];
}

const ZERO_ATOMIC = '0';

function factorsFrom(snapshot: RecordEconomicSnapshot): RecordPathEstimateFactors {
  const f = snapshot.recordTimeFactors;
  return Object.freeze({
    base_points_atomic: f.basePointsAtomic,
    category: f.category,
    base_action_weight_bps: f.baseActionWeightBps,
    policy_override_bps: f.policyOverrideBps,
    effective_action_weight_bps: f.effectiveActionWeightBps,
    occurrence_ordinal: f.occurrenceOrdinal,
    novelty_bps: f.noveltyBps,
    daily_ordinal: f.dailyOrdinal,
    daily_diminishing_bps: f.dailyDiminishingBps,
    attestation_tier: f.attestationTier,
    attestation_multiplier_bps: f.attestationMultiplierBps,
    financial_attestation_neutral: f.financialAttestationNeutral,
    linkage_state: f.linkageState,
    linkage_multiplier_bps: f.linkageMultiplierBps,
    evidence_state: f.evidenceState,
    evidence_requirement: f.evidenceRequirement,
    fixed_grant_source: f.fixedGrantSource,
    fixed_grant_atomic: f.fixedGrantAtomic,
    suppress_record_points: f.operationalDispositionOverride?.suppressRecordPoints === true,
    unresolved_record_gates: Object.freeze([...f.unresolvedRecordGates]),
  });
}

/**
 * Build the record-calculation input for an ORDINARY (non fixed-grant) action,
 * mirroring `recordPEAccrual`'s construction field for field. Exported so the
 * parity suite can drive `computeRecordSnapshot` from the SAME input object the
 * estimator uses, rather than declaring its own copy — the
 * redeclared-literal shape.
 */
export function buildOrdinaryEstimateInput(
  policy: MonetaryPolicyVersion,
  params: RecordPathEstimateParams,
  evaluatedAtMs: number,
): RecordCalculationInput {
  const actionPolicy = policy.actions[params.actionType];
  const occurrenceOrdinal = params.occurrenceOrdinal ?? 1;
  const dailyOrdinal = params.dailyOrdinal ?? 1;
  const durableEconomicPath = params.durableSubmissionPath === true;

  // pvt-accrual: an action with no policy entry, or one whose policy is already
  // terminal, is policyRecordOnly — as is EVERY best-effort caller.
  const policyRecordOnly = !durableEconomicPath
    || actionPolicy === undefined
    || actionPolicy.mintDisposition === 'record_only'
    || actionPolicy.mintDisposition === 'ineligible_terminal';

  // pvt-accrual, same two terminal gates, same guard order. Both were missing
  // here at first and the parity suite caught the over-quote: `wallet_created`
  // read 10 PVT against a sealed 0, and `x402_payment` read 2 against 0.
  // `isDeviceRateLimited` is imported rather than re-listed so a new setup type
  // added to DEVICE_RATE_LIMITS is covered here automatically.
  // (the daily qualification gate that used to precede these is
  // removed — volume never disqualifies; `dailyOrdinal` above is sealed
  // provenance evidence only.)
  const deviceRateLimited = !policyRecordOnly
    && isDeviceRateLimited(params.actionType)
    && params.deviceAnchorPresent === false;
  const x402Unverified = params.actionType === 'x402_payment'
    && !policyRecordOnly
    && !deviceRateLimited
    && params.chainVerifiedSettlement !== true;

  // THE FOURTH TERMINAL GATE — the standing anti-farm caps on financial types
  // (`send`, `x402_payment`, `swap`, `receive`: a per-actor daily ceiling, plus
  // the verified-counterparty identity requirement on `send`/`x402_payment`). Missing this made
  // `send` estimate `pending_evidence` / 2.0 PVT against a sealed
  // `ineligible_terminal` / 0, because a `send` with no verified counterparty
  // is capped `unverifiable_counterparty` at record time and its points are
  // suppressed. `decideFinancialEconomicCaps` is the same pure authority the
  // accrual's reservation calls, so the verdict cannot drift from it.
  const activityRule = getActionTypeMintRule(params.actionType);
  // a payment to a Provian service wallet seals record_only
  // (`provian_service_fee`) BEFORE the accrual's cap reservation, which only runs for a
  // potentially mintable row — so the cap never sees it there, and must not here either.
  const provianServiceFee = provianServiceFeeApplies(params.actionType, params.counterpartyAddress);
  const potentiallyMintable = !policyRecordOnly
    && !deviceRateLimited && !x402Unverified && !provianServiceFee;
  const farmCapped = activityRule !== undefined && potentiallyMintable
    && decideFinancialEconomicCaps({
      counterpartyRequired: activityRule.requiresVerifiedCounterparty === true,
      counterpartyVerified: params.counterpartyVerified === true,
      // An estimate has no ledger. Prior usage is unknowable, so it is assumed
      // ZERO — the most favourable case — and stated as an assumption rather
      // than guessed at. Being wrong here can only over-state, never under-, so
      // it is disclosed instead of silently absorbed.
      dailyCount: 0,
      dailyCeiling: activityRule.dailyMintCeiling,
    }).capped;

  const evidenceRequirement = actionPolicy?.evidenceRequirement ?? 'operator_policy_review';
  // pvt-accrual (§2.8): a class-admitted action's evidence IS the relay's own witness class —
  // a witnessed class seals `verified`; the actor-declared class stays pending. Mirrored so the
  // estimate quotes the same disposition the record path seals.
  const witnessClassIsEvidence = evidenceRequirement === 'verified_witness_class'
    && WITNESSED_CLASSES.has(normalizeWitnessClass(params.witnessClass));
  const evidenceState: EvidenceState = witnessClassIsEvidence
    ? 'verified'
    : (params.evidenceState
      ?? (evidenceRequirement === 'none' ? 'not_required' : 'pending'));

  // pvt-accrual only honours an artifact-novelty claim for `compute` actions;
  // for anything else it REFUSES the claim and holds the PE for review. Mirror
  // both halves, or a caller asking about a non-compute type with an artifact
  // gets the unique-artifact novelty curve and no hold — priced high twice.
  const artifactNoveltyRefused = params.uniqueArtifact === true
    && !policyRecordOnly
    && actionPolicy?.category !== 'compute';
  const uniqueArtifact = params.uniqueArtifact === true && !artifactNoveltyRefused;

  // pvt-accrual: a completion-family row whose
  // counterparty is absent or not a resolvable EVM address is held
  // `pending_review` — the same-owner fence cannot run, so it is not passed.
  // Same predicate the fence and the verifier bind to, same default (absent).
  const completionCounterpartyUnresolvable = !policyRecordOnly
    && evidenceRequirement === 'verified_substantive_outcome'
    && !isResolvableCounterpartyAddress(params.counterpartyAddress);

  return {
    peId: 'pe_estimate',
    economicActorId: 'estimate',
    actionType: params.actionType,
    recordedAtMs: evaluatedAtMs,
    occurrenceOrdinal,
    dailyOrdinal,
    exactDuplicate: false,
    uniqueArtifact,
    attestationTier: normalizeEconomicAttestationTier(params.attestationTier ?? 'software'),
    linkageState: params.linkageState ?? 'unlinked',
    evidenceState,
    // The accrual derives this from a real `tx_hash` / `artifact_hash` /
    // `commitSha`, so `evidenceState: 'verified'` with no such identifier
    // yields NULL there. Synthesising an id unconditionally would report
    // `eligible` where the kernel forces `pending_evidence` for every action
    // whose policy sets `canonicalEventRequired`. The caller must name it.
    // §2.8 mirror (pvt-accrual): a class-admitted action's canonical id is `<type>:<peHash>` —
    // the PE's own identity, which every submission has — so it is synthesised here exactly
    // as there, never for a named row (whose id the caller must name).
    canonicalEventId: witnessClassIsEvidence
      ? `${params.actionType}:estimate`
      : (evidenceState === 'verified' && params.canonicalEventId ? params.canonicalEventId : null),
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    // Defaults to ABSENT, matching what the live submission paths actually
    // pass. Assuming the caller has session lineage would be the optimistic
    // direction, and for the action types whose policy REQUIRES it that
    // assumption silently upgrades `missing_session_lineage_record_only` into a
    // mintable disposition — exactly the over-quote this module exists to stop.
    sessionLineageId: params.sessionLineageId ?? null,
    genesisReservation: null,
    beneficiaryAgentShareBps: 10_000,
    operationalDispositionOverride: resolveOperationalDisposition({
      durableEconomicPath,
      policyRecordOnly,
      terminallyIneligible: !policyRecordOnly
        && (deviceRateLimited || x402Unverified || farmCapped
          || params.noObservableOutput === true),
      // pvt-accrual sets `mintClaimUnverifiable` when artifact novelty is
      // claimed for a NON-compute action — the claim is refused and the PE is
      // held for review rather than priced on the unique-artifact curve.
      mintClaimUnverifiable: artifactNoveltyRefused,
      // An estimate has no counterparty registry read and no cache read, so
      // neither hold can be evaluated from a registry. Both are recoverable
      // (pending_review / pending_cache) rather than terminal, so assuming
      // their absence cannot turn an unpayable act into a payable one — unlike
      // the four gates above. The ONE same-owner hold that needs no registry
      // read — a completion-family counterparty the fence cannot resolve — IS
      // mirrored, so the quote and the seal agree on it (C-2, one pricing truth).
      sameOwnerUnresolvable: completionCounterpartyUnresolvable,
      cacheUnavailable: false,
      // `receive` is TERMINAL when unauthored, so — unlike the two
      // recoverable holds just above — this one defaults to the CONSERVATIVE
      // assumption (unsolicited) rather than assuming it away. See
      // `receiveAuthored`'s docstring on `RecordPathEstimateParams`.
      receiveUnsolicited: params.actionType === 'receive' && params.receiveAuthored !== true,
      // the accrual's service-fee rule is a pure address match (no registry
      // read), so it is mirrored here from the SAME predicate the seal reads.
      provianServiceFee,
    }),
  };
}

function assumptionsFor(
  params: RecordPathEstimateParams,
  extra: readonly string[] = [],
  /** The action's policy evidence requirement; null on the Genesis path (never in the completion family). */
  evidenceRequirement: string | null = null,
): readonly string[] {
  return Object.freeze([
    ESTIMATE_ASSUMPTIONS.SCENARIO_ORDINALS,
    params.durableSubmissionPath === true
      ? ESTIMATE_ASSUMPTIONS.DURABLE_PATH
      : ESTIMATE_ASSUMPTIONS.BEST_EFFORT_PATH,
    ...(params.evidenceState === undefined ? [ESTIMATE_ASSUMPTIONS.EVIDENCE_PENDING] : []),
    ...(params.sessionLineageId ? [] : [ESTIMATE_ASSUMPTIONS.NO_SESSION_LINEAGE]),
    ...(isDeviceRateLimited(params.actionType) && params.deviceAnchorPresent !== false
      ? [ESTIMATE_ASSUMPTIONS.DEVICE_ANCHOR_PRESENT]
      : []),
    ...(params.actionType === 'x402_payment' && params.chainVerifiedSettlement !== true
      ? [ESTIMATE_ASSUMPTIONS.X402_SELF_REPORT]
      : []),
    ...(getActionTypeMintRule(params.actionType) === undefined
      ? []
      : [
        ESTIMATE_ASSUMPTIONS.ACTIVITY_CAPS_FRESH,
        ...(getActionTypeMintRule(params.actionType)!.requiresVerifiedCounterparty === true
          && params.counterpartyVerified !== true
          ? [ESTIMATE_ASSUMPTIONS.COUNTERPARTY_UNVERIFIED]
          : []),
      ]),
    ...(params.noObservableOutput === true ? [] : [ESTIMATE_ASSUMPTIONS.OBSERVABLE_OUTPUT]),
    ...(params.actionType === 'receive' && params.receiveAuthored !== true
      ? [ESTIMATE_ASSUMPTIONS.RECEIVE_UNSOLICITED_ASSUMED]
      : []),
    ...(speechPeNeedsPass(params.actionType)
      ? [params.speechPassLive === true
        ? ESTIMATE_ASSUMPTIONS.SPEECH_PASS_LIVE
        : ESTIMATE_ASSUMPTIONS.SPEECH_NO_PASS]
      : []),
    ...(evidenceRequirement === 'verified_substantive_outcome'
      && !isResolvableCounterpartyAddress(params.counterpartyAddress)
      ? [ESTIMATE_ASSUMPTIONS.COMPLETION_COUNTERPARTY_ABSENT]
      : []),
    ESTIMATE_ASSUMPTIONS.LINKAGE_SCENARIO,
    ESTIMATE_ASSUMPTIONS.SETTLEMENT_FACTORS,
    ESTIMATE_ASSUMPTIONS.BENEFICIARY_ROUTING,
    ...extra,
  ]);
}

function assemble(
  params: RecordPathEstimateParams,
  policy: MonetaryPolicyVersion,
  snapshot: RecordEconomicSnapshot,
  evaluatedAtMs: number,
  genesis: RecordPathEstimate['genesis'],
  extraAssumptions: readonly string[],
): RecordPathEstimate {
  return Object.freeze({
    action_type: params.actionType,
    policy_version: policy.policyVersion,
    evaluated_at_ms: evaluatedAtMs,
    record_points_atomic: snapshot.recordPointsAtomic,
    // The accrual's own rule: only an `eligible` snapshot carries PVT value.
    estimated_pvt_atomic: snapshot.mintDisposition === 'eligible'
      ? snapshot.recordPointsAtomic
      : ZERO_ATOMIC,
    mint_disposition: snapshot.mintDisposition,
    mint_reason_code: snapshot.mintReasonCode,
    policy_review_state: snapshot.policyReviewState,
    policy_review_reason_code: snapshot.policyReviewReasonCode,
    durable_submission_path: params.durableSubmissionPath === true,
    factors: factorsFrom(snapshot),
    genesis,
    assumptions: assumptionsFor(
      params,
      extraAssumptions,
      policy.actions[params.actionType]?.evidenceRequirement ?? null,
    ),
  });
}

/**
 * Price a Genesis action by RUNNING the reservation kernel, not by copying its
 * constants. The kernel is pure, so this reserves nothing: it is handed a fresh
 * empty ledger and its receipt and next-state are discarded after the snapshot
 * is computed.
 */
async function estimateGenesis(
  db: Firestore,
  params: RecordPathEstimateParams,
  requestedAtMs: number,
): Promise<RecordPathEstimate> {
  const manifest = PROPOSED_GENESIS_CAMPAIGN_POLICY;
  const bounty = resolveGenesisBountyPolicy(manifest, params.actionType);

  let activation: GenesisCampaignActivation | null = null;
  try {
    const snap = await readGenesisActivation(db);
    const data: unknown = snap.data();
    if (snap.exists && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      activation = data as GenesisCampaignActivation;
    }
  } catch {
    activation = null;
  }

  // The qualifying act has not happened yet, so its instant is unknowable. The
  // earliest instant one could be reserved is the window's opening; evaluating
  // there (and SAYING SO) is honest, where reporting "not started" alone would
  // hide the approved grant entirely.
  const windowStartMs = manifest.window.start_ms;
  const extra: string[] = [ESTIMATE_ASSUMPTIONS.GENESIS_FRESH_LEDGER];
  let evaluatedAtMs = requestedAtMs;
  if (windowStartMs !== null && requestedAtMs < windowStartMs) {
    evaluatedAtMs = windowStartMs;
    extra.push(ESTIMATE_ASSUMPTIONS.GENESIS_EVALUATED_AT_WINDOW_START);
  }

  // A REFUSED Genesis reservation has no kernel snapshot, and must not be given
  // a fake one. `computeRecordSnapshot` throws on a Genesis action type without
  // a reservation receipt by design, so emptying the policy to force a verdict
  // out of it would report `unknown_action_type` for an action the policy knows
  // perfectly well — a fabricated kernel judgement. The refusal is reported as
  // itself: zero points, `record_only`, and the kernel's own deny reason.
  const denied = (reason: GenesisReservationDenyReason): RecordPathEstimate =>
    Object.freeze({
      action_type: params.actionType,
      policy_version: manifest.policy_version,
      evaluated_at_ms: evaluatedAtMs,
      record_points_atomic: ZERO_ATOMIC,
      estimated_pvt_atomic: ZERO_ATOMIC,
      mint_disposition: 'record_only' as const,
      mint_reason_code: 'policy_record_only' as const,
      policy_review_state: 'not_required' as const,
      policy_review_reason_code: 'known_policy_entry' as const,
      durable_submission_path: params.durableSubmissionPath === true,
      factors: Object.freeze({
        base_points_atomic: ZERO_ATOMIC,
        category: null,
        base_action_weight_bps: 0,
        policy_override_bps: null,
        effective_action_weight_bps: 0,
        occurrence_ordinal: 1,
        novelty_bps: 0,
        daily_ordinal: 1,
        daily_diminishing_bps: 0,
        attestation_tier: 'software',
        attestation_multiplier_bps: 0,
        financial_attestation_neutral: false,
        linkage_state: 'unlinked' as const,
        linkage_multiplier_bps: 0,
        evidence_state: 'not_required' as const,
        evidence_requirement: 'valid_genesis_reservation',
        fixed_grant_source: 'genesis_campaign_reservation',
        // The approved grant this act WOULD pay, read from the same manifest
        // the reservation kernel reads. Reported so a refusal explains what is
        // being withheld and why, never as a payable figure: both the points
        // and the PVT above are zero.
        fixed_grant_atomic: bounty?.fixed_grant_atomic ?? null,
        suppress_record_points: true,
        unresolved_record_gates: Object.freeze(['evidence' as const]),
      }),
      genesis: Object.freeze({
        canonical_bounty_key: bounty?.canonical_bounty_key ?? null,
        reservable: false,
        deny_reason: reason,
      }),
      assumptions: assumptionsFor(params, extra),
    });

  if (bounty === null) return denied('unknown_bounty_action');
  // Shutdown coverage: from the accrual end line Genesis admission refuses every act
  // (`shouldPersistGenesisQualification`), as a close at that instant would.
  if (accrualEndedAt(Date.now())) {
    extra.push(ESTIMATE_ASSUMPTIONS.ACCRUAL_ENDED);
    return denied('campaign_closed');
  }
  if (activation === null) return denied('proposal_not_approved');

  const anchorKind = bounty.dedupe.required_anchor;
  const reserved = reserveGenesisCampaignGrant({
    manifest,
    activation,
    state: createEmptyGenesisLedgerState(activation.ledger_namespace),
    input: {
      pe_id: 'pe_estimate',
      action_type: params.actionType,
      wallet_id: 'estimate_wallet',
      economic_actor_id: 'estimate',
      immutable_anchor: { anchor_kind: anchorKind, anchor_id: 'estimate_anchor' },
      qualifying_act_evidence: {
        verification_status: 'verified',
        evidence_id: 'estimate_evidence',
        evidence_hash: `sha256:${'0'.repeat(64)}`,
        subject_wallet_id: 'estimate_wallet',
        canonical_bounty_key: bounty.canonical_bounty_key,
        qualifying_act: bounty.qualifying_act,
        immutable_anchor_kind: anchorKind,
        immutable_anchor_id: 'estimate_anchor',
        qualifying_act_at_ms: evaluatedAtMs,
      },
    },
    observation_context: {
      verification_status: 'verified',
      observed_at_ms: evaluatedAtMs,
      wallet_created: {
        wallet_id: 'estimate_wallet',
        created_at_ms: evaluatedAtMs,
        evidence_id: 'estimate_wallet_evidence',
        evidence_hash: `sha256:${'0'.repeat(64)}`,
        source: 'authoritative_wallet_record',
      },
    },
    activation_approval_verifier:
      params.genesisApprovalVerifier ?? verifyGenesisCampaignActivationApproval,
  });

  if (!reserved.allowed) return denied(reserved.reason);

  const policy = materializeProposedMonetaryPolicy(activation.effective_at_ms ?? 0);
  const snapshot = computeRecordSnapshot(policy, {
    peId: 'pe_estimate',
    economicActorId: 'estimate',
    actionType: params.actionType,
    recordedAtMs: reserved.reservation.reserved_at_ms,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: reserved.reservation.reservation_id,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: reserved.reservation,
    beneficiaryAgentShareBps: 10_000,
    operationalDispositionOverride: null,
  });

  return assemble(params, policy, snapshot, evaluatedAtMs, Object.freeze({
    canonical_bounty_key: bounty.canonical_bounty_key,
    reservable: true,
    deny_reason: null,
  }), extra);
}

/**
 * The single entry point. Returns what the record path would seal for these
 * inputs, together with the disposition that decides whether those points can
 * ever become PVT.
 */
export async function estimateFromRecordPath(
  db: Firestore,
  params: RecordPathEstimateParams,
): Promise<RecordPathEstimate> {
  const requestedAtMs = params.recordedAtMs ?? Date.now();

  const witnessClass = normalizeWitnessClass(params.witnessClass);
  const resolution = await resolveActionPolicyAtRecordTime(db, {
    actionType: params.actionType,
    recordedAtMs: requestedAtMs,
    witnessClass,
  });
  // The SAME two calls the accrual makes (pvt-accrual.ts), in the same order: class admission
  // rides the resolution; the hardware 4.0× override rides the loaded policy.
  const policy = withWitnessClassOverride(
    await loadRuntimeMonetaryPolicy(db, requestedAtMs, resolution),
    params.actionType,
    witnessClass,
  );

  if (policy.actions[params.actionType]?.fixedGrantSource === 'genesis_campaign_reservation') {
    return estimateGenesis(db, params, requestedAtMs);
  }

  const snapshot = computeOrdinaryEstimateSnapshot(policy, params, requestedAtMs);
  return assemble(params, policy, snapshot, requestedAtMs, null,
    accrualEndedAt(Date.now()) ? [ESTIMATE_ASSUMPTIONS.ACCRUAL_ENDED] : []);
}

/**
 * Build + price an ordinary estimate — the ONE path both quote surfaces use
 * (`estimateFromRecordPath` and `estimate.ts::computeSubmitTimeEstimate`).
 *
 * pvt-accrual mirror (fact-base fixes item 1, 2026-09-23): a speech-type PE with no live pass seals
 * `record_only` (`speech_no_live_pass_record_only`) — applied, exactly as the accrual applies it,
 * only over a snapshot that would otherwise still reach a mint. A quote carries no pass unless the
 * caller says one is live, so the quote and the seal agree.
 */
export function computeOrdinaryEstimateSnapshot(
  policy: Parameters<typeof buildOrdinaryEstimateInput>[0],
  params: RecordPathEstimateParams,
  evaluatedAtMs: number,
): ReturnType<typeof computeRecordSnapshot> {
  // pvt-accrual mirror (shutdown coverage): an act the relay receives at or after the accrual end
  // line seals exactly as a non-durable one does (`accrualEndedFor`), so it is quoted that way.
  // Judged by the clock now, since a quoted act would be received now.
  const effective = accrualEndedAt(Date.now()) ? { ...params, durableSubmissionPath: false } : params;
  const input = buildOrdinaryEstimateInput(policy, effective, evaluatedAtMs);
  const snapshot = computeRecordSnapshot(policy, input);
  if (params.speechPassLive !== true
    && speechPeNeedsPass(params.actionType)
    && snapshot.mintDisposition !== 'record_only'
    && snapshot.mintDisposition !== 'ineligible_terminal') {
    return computeRecordSnapshot(policy, {
      ...input,
      operationalDispositionOverride: {
        mintDisposition: 'record_only',
        mintReasonCode: 'speech_no_live_pass_record_only',
        suppressRecordPoints: false,
      },
    });
  }
  return snapshot;
}

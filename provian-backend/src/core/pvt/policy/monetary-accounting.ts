/**
 * Pure, versioned PVT monetary-accounting kernel.
 *
 * This module intentionally has no Firestore, clock, contract, or network
 * dependencies. Record-time economics are closed into a snapshot. Settlement
 * can then apply only a verified attestation upgrade from that record policy's
 * multiplier table plus the disclosed global mint-rate factor. Parity minting
 * is policy: sealed record points times the epoch's armed mint rate is the only
 * transform from a sealed PE to a mint. No supply-indexed or lifetime-indexed
 * scaler exists anywhere in this path.
 *
 * Authoritative quantities are canonical integer strings in 18-decimal atomic
 * units. JavaScript numbers are used only for integer ordinals, timestamps, and
 * integer basis-point policy values; every such input is validated before use.
 */

import crypto from 'crypto';
import { isCaptureLane } from '../capture-lane';
import { isWitnessClass, WITNESS_CLASSES, ordinaryHardwareAttestationTier } from './evidence-class';
import {
  isAuthenticGenesisReservationReceipt,
  type GenesisReservationLedgerEntry,
} from './genesis-policy-engine';

// money layer, PIECE 5 (pricing). The schema version is a FORMULA-version discriminator, and
// bumping it is what moves `hashProposedMonetaryPolicyTemplate()` (which hashes the template's
// `schemaVersion`) and so requires the operator’s fresh SSHSIG over the new monetary digest. `v1` sealed the
// UNMULTIPLIED formula (pieces 1–4 and everything before); `v2` seals the origin-priced formula that
// folds the two multipliers. `validateSnapshot` reconciles BOTH — an already-sealed `v1` snapshot is
// re-derived under the v1 formula and NEVER repriced. New seals carry `v2`.
export const MONETARY_ACCOUNTING_SCHEMA_VERSION_V1 = 'pvt-monetary-accounting/v1' as const;
export const MONETARY_ACCOUNTING_SCHEMA_VERSION_V2 = 'pvt-monetary-accounting/v2' as const;
/** The CURRENT schema version stamped on every new seal + the proposed template (the signed digest). */
export const MONETARY_ACCOUNTING_SCHEMA_VERSION_V3 = 'pvt-monetary-accounting/v3' as const;
export const MONETARY_ACCOUNTING_SCHEMA_VERSION = MONETARY_ACCOUNTING_SCHEMA_VERSION_V3;
/** Any schema version a stored snapshot/policy may legitimately carry (v1 history + v2 current). */
export type MonetaryAccountingSchemaVersion =
  | typeof MONETARY_ACCOUNTING_SCHEMA_VERSION_V1
  | typeof MONETARY_ACCOUNTING_SCHEMA_VERSION_V2
  | typeof MONETARY_ACCOUNTING_SCHEMA_VERSION_V3;
const SUPPORTED_MONETARY_ACCOUNTING_SCHEMA_VERSIONS: readonly string[] = [
  MONETARY_ACCOUNTING_SCHEMA_VERSION_V1,
  MONETARY_ACCOUNTING_SCHEMA_VERSION_V2,
  MONETARY_ACCOUNTING_SCHEMA_VERSION_V3,
];

// independence is unchanged; current v3 pricing has no token factor.
export const INDEPENDENCE_PER_ORIGIN_BPS = 5000;
// Historical v2 validation only; new seals have no volume factor.
const LEGACY_V2_VOLUME_TOKENS_DENOMINATOR = 100000;
export const PVT_ATOMIC_DECIMALS = 18 as const;
export const PVT_ATOMIC_SCALE = 10n ** BigInt(PVT_ATOMIC_DECIMALS);
export const BPS_DENOMINATOR = 10_000 as const;
/**
 * The LEGACY attestation-enhancement window (72 h from record time). It still bounds
 * the settlement-time attestation upgrade for every PE recorded BEFORE
 * `ATTESTATION_HORIZON_CUT_LINE_MS` (kept it; supersedes it prospectively).
 * Read `attestationEnhancementWindowMsFor(recordedAtMs)` never this constant — to
 * know which window a given PE is under.
 */
export const ATTESTATION_ENHANCEMENT_WINDOW_MS = 72 * 60 * 60 * 1000;
/**
 * the corroboration HORIZON: 30 days, measured from each PE's own record-time
 * creation (`recordedAtMs`), never from batch seal or settlement time. Every PE gets an
 * identical window regardless of where in the settlement cycle it was created. Inside
 * it a verified attestation upgrade raises value; after it a late signal is a record,
 * never value. Applies to PEs recorded at or after the cut line below; earlier PEs keep
 * the legacy 72 h window (they are out of scope of the additive top-up mechanism too).
 */
export const ATTESTATION_ENHANCEMENT_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
/** 2026-09-09T00:00:00Z — the instant the 30-day horizon (and the top-up lane) shipped. */
export const ATTESTATION_HORIZON_CUT_LINE_MS = Date.UTC(2026, 8, 9);
/**
 * The CROSS-WITNESS TAKEOVER window (72 h). Decoupled from the corroboration horizon on
 * purpose : the takeover gate defers REGISTRATION of a commit/completion witness so
 * a higher-base witness can still claim the slot, and a 30-day registration deferral
 * would defeat the settlement cadence. Value that arrives after registration is carried by the
 * additive attestation top-up instead, so the deferral no longer needs to equal the
 * horizon. Bound to the legacy window so no third literal exists.
 */
export const CROSS_WITNESS_TAKEOVER_WINDOW_MS = ATTESTATION_ENHANCEMENT_WINDOW_MS;

/**
 * Which enhancement window a PE is under, by its own record time. Pure and total: a
 * non-finite record time falls to the LEGACY window (the narrower, fail-closed side).
 */
export function attestationEnhancementWindowMsFor(recordedAtMs: number): number {
  if (!Number.isFinite(recordedAtMs)) return ATTESTATION_ENHANCEMENT_WINDOW_MS;
  return recordedAtMs >= ATTESTATION_HORIZON_CUT_LINE_MS
    ? ATTESTATION_ENHANCEMENT_HORIZON_MS
    : ATTESTATION_ENHANCEMENT_WINDOW_MS;
}

declare const atomicUnitsBrand: unique symbol;
declare const unsignedIntegerBrand: unique symbol;

/** Canonical non-negative integer expressed in 18-decimal atomic units. */
export type AtomicUnits = string & { readonly [atomicUnitsBrand]: true };

/** Canonical non-negative integer string used for exact rational factors. */
export type UnsignedInteger = string & { readonly [unsignedIntegerBrand]: true };

export const MINT_DISPOSITIONS = [
  'eligible',
  'pending_evidence',
  'pending_review',
  'record_only',
  'ineligible_terminal',
  'pending_cache',
  'pending_compliance',
  'beneficiary_pending',
  'jurisdiction_deferred',
] as const;

export type MintDisposition = (typeof MINT_DISPOSITIONS)[number];

export const POLICY_REVIEW_STATES = [
  'not_required',
  'pending_policy',
  'classified_prospective',
  // : an UNNAMED type admitted at its witness class's base (no named row, not rejected).
  'class_admitted',
  'rejected',
] as const;

export type PolicyReviewState = (typeof POLICY_REVIEW_STATES)[number];

export type ActionEvidenceRequirement =
  | 'none'
  | 'base_final_chain_receipt'
  | 'valid_genesis_reservation'
  | 'verified_institution_lifecycle'
  | 'verified_substantive_outcome'
  | 'verified_compute_or_work'
  | 'verified_external_service_witness'
  // Trust Layer §2.8: the witness CLASS is the evidence (a class-admitted unnamed type, or a
  // hardware-rooted override of a named row): the relay-assigned class stamps the record verified.
  | 'verified_witness_class'
  | 'operator_policy_review';

export type BeneficialOwnershipPolicy =
  | 'record_only_if_self_shared_or_churn'
  | 'not_applicable';

export type SessionLineagePolicy = 'required' | 'optional' | 'not_applicable';
export type FixedGrantSource = 'none' | 'genesis_campaign_reservation';
export type EvidenceResolutionMode =
  | 'projection_with_verified_evidence'
  | 'linked_evidence_pe_only'
  | 'not_applicable';

export type UnresolvedRecordGate =
  | 'evidence'
  | 'canonical_event'
  | 'registry'
  | 'session_lineage';

/**
 * (its zeroing reversed by): which attestation table prices an action.
 *
 * 'standard' actions read `attestationMultipliersBps` (the graded ladder).
 * 'external_proof_priced' actions read `evidencePricedAttestationMultipliersBps`,
 * a table where self-attested work earns a DISCOUNT (software 0.8x, social 0.5x
 * base weight, priced down by novelty decay, never a terminal zero); a
 * self-produced replication pack (software_verified) is CAPPED at the flat 1.0x
 * (the operator’s amendment — parity with proof, not the ladder's 1.2x); and the
 * proven tiers (hardware attestation, chain finality, third-party witness, TEE)
 * are LIFTS at the family's flat 1.0x, deliberately without the ladder's 2.5x/1.4x hardware
 * premiums. reversed 's terminal `self_attested_evidence_record_only`
 * zero on the evidence axis: self-attested/observed work now earns, and
 * corroboration is a lift, never the price of admission. (A 0 remains legal in
 * this table only for validating pre- sealed snapshots; the live table has
 * no zero tier — see the record-time guard in `computeRecordSnapshot`.)
 */
export type AttestationPricing = 'standard' | 'external_proof_priced';

export const MINT_REASON_CODES = [
  'jurisdiction_unknown',
  'jurisdiction_blocked',
  'sdn_unavailable',
  'policy_eligible',
  'awaiting_evidence',
  // `awaiting_review` is the legacy umbrella for a recoverable pending_review hold. It is
  // PRESERVED (older sealed rows carry it, and pe-history's normalizer falls back to it), but
  // NEW holds seal one of the four GRANULAR reasons below so the console can split a parked
  // money-path PE by its actual cause. None of these implies a human money-review gate — a
  // pending_review row is a DEFECT the self-heal sweep promotes on the evidence it has.
  'awaiting_review',
  'same_owner_unresolvable',
  'mint_claim_unverifiable',
  'receive_authorship_unresolvable',
  'registry_hold',
  'policy_record_only',
  'system_accounting_record_only',
  'unknown_action_type',
  'unverifiable_evidence_record_only',
  'self_attested_evidence_record_only',
  'self_or_shared_beneficial_ownership',
  'pair_churn_record_only',
  'missing_session_lineage_record_only',
  'unsolicited_receive_record_only',
  // (Commons communication): a speech PE that would carry the sum of its window's sealed
  // speech record points to or past the burn that opened the window. Recorded, never minted —
  // the speech-budget invariant ("less than the burn") holds by construction.
  'speech_window_budget_exhausted',
  // (fact-base fixes item 1): a speech PE sealed with NO live pass attached —
  // e.g. a thread message sent inside an open relationship (sending needs no pass there) or a
  // speech action type self-reported on a lane that carries no pass. Recorded, never minted: speech
  // mints only under a live pass and only inside that pass's budget.
  'speech_no_live_pass_record_only',
  // ( follow-up): an act whose counterparty is one of Provian's own
  // fee / gas / revenue wallets (`core/pvt/provian-service-wallets.ts`) — a service fee is never a
  // price for PVT. Recorded, never minted, on every lane.
  'provian_service_fee',
  'policy_ineligible',
  'exact_duplicate',
  'cache_unavailable',
  'beneficiary_unresolved',
  'jurisdiction_deferred',
] as const;

export type MintReasonCode = (typeof MINT_REASON_CODES)[number];

export const POLICY_REVIEW_REASON_CODES = [
  'known_policy_entry',
  'unknown_action_type',
  'classification_approved_prospective',
  'classification_rejected',
  'witness_class_admitted',
] as const;

export type PolicyReviewReasonCode = (typeof POLICY_REVIEW_REASON_CODES)[number];

export type EvidenceState =
  | 'not_required'
  | 'pending'
  | 'verified'
  | 'rejected'
  | 'unverifiable';

export type LinkageState =
  | 'unlinked'
  | 'human_linked'
  | 'beneficiary_linked'
  | 'unverifiable';

export interface ActionMonetaryPolicy {
  readonly category: string;
  /** Approved action/category baseline. This is never inferred at record time. */
  readonly baseWeightBps: number;
  /** Versioned prospective override, if the approved policy version has one. */
  readonly policyOverrideBps: number | null;
  readonly mintDisposition: MintDisposition;
  readonly mintReasonCode: MintReasonCode;
  readonly policyReviewState: PolicyReviewState;
  readonly policyReviewReasonCode: PolicyReviewReasonCode;
  readonly financialAttestationNeutral: boolean;
  /**
   *, optional so pre-existing policy objects and prospective
   * classifications remain valid: absence means 'standard'.
   */
  readonly attestationPricing?: AttestationPricing;
  readonly allowVerifiedAttestationUpgrade: boolean;
  readonly evidenceRequirement: ActionEvidenceRequirement;
  readonly canonicalEventRequired: boolean;
  readonly canonicalEventGroup: string;
  readonly beneficialOwnershipPolicy: BeneficialOwnershipPolicy;
  readonly sessionLineagePolicy: SessionLineagePolicy;
  readonly fixedGrantSource: FixedGrantSource;
  readonly evidenceResolutionMode: EvidenceResolutionMode;
}

export interface MonetaryPolicyVersion {
  readonly schemaVersion: MonetaryAccountingSchemaVersion;
  readonly policyVersion: string;
  /** Inclusive start of this prospective policy version. */
  readonly effectiveAtMs: number;
  /** Exclusive end, or null while this version remains current. */
  readonly effectiveUntilMs: number | null;
  readonly basePointsAtomic: AtomicUnits;
  readonly attestationMultipliersBps: Readonly<Record<string, number>>;
  /**
   * (repricing reversed by): the table read by 'external_proof_priced'
   * actions. every LIVE tier is positive — software 0.8x, social 0.5x,
   * and software_verified + proven tiers at the flat 1.0x lift. A 0
   * entry stays legal HERE (and only here) so pre- SEALED snapshots — which
   * carried 0-priced self-attested tiers under still validate; the live
   * table has no zero tier. Optional so pre- policy objects stay
   * valid; a policy that names an external_proof_priced action without carrying
   * this table fails closed at record time.
   */
  readonly evidencePricedAttestationMultipliersBps?: Readonly<Record<string, number>>;
  readonly linkageMultipliersBps: Readonly<Record<LinkageState, number>>;
  /**
   * : the six witness-class BASES (bps). An unnamed action type prices at its
   * class's base; a named `actions` row is an override. Optional so pre-existing sealed policy
   * objects stay valid; a policy without it admits NO unnamed type (fail-closed → record_only).
   */
  readonly evidenceClassBasesBps?: Readonly<Record<string, number>>;
  /** Exact approved entries only (named OVERRIDES of the class bases). Absence of a row falls to the class base when present; otherwise fail-closed. */
  readonly actions: Readonly<Record<string, ActionMonetaryPolicy>>;
}

export interface RecordCalculationInput {
  readonly peId: string;
  /** Canonical wallet/agent economic actor credited by this PE. */
  readonly economicActorId: string;
  readonly actionType: string;
  readonly recordedAtMs: number;
  /** One-based ordinal for this action type in the applicable novelty window. */
  readonly occurrenceOrdinal: number;
  /** One-based ordinal for this PE in the applicable daily window. */
  readonly dailyOrdinal: number;
  readonly exactDuplicate: boolean;
  readonly uniqueArtifact: boolean;
  readonly attestationTier: string;
  readonly linkageState: LinkageState;
  readonly evidenceState: EvidenceState;
  readonly canonicalEventId: string | null;
  readonly selfReferencing: boolean;
  readonly sharedBeneficialOwnership: boolean;
  /** A sealed snapshot field. No producer sets it (: there is no
   * pair-churn rule), so every new record seals false. */
  readonly pairChurnDetected: boolean;
  readonly sessionLineageId: string | null;
  /**
   * Exact immutable receipt returned by the Genesis reservation kernel.
   * A raw caller-supplied amount is intentionally not accepted.
   */
  readonly genesisReservation: GenesisReservationLedgerEntry | null;
  /** Contributor share after record-time beneficiary routing (10,000 = 100%). */
  readonly beneficiaryAgentShareBps?: number | null;
  /**
   * A restrictive operational verdict known at record time (for example a
   * terminal rate-limit or a cache outage). It may only move policy state in a
   * fail-closed direction and is sealed into the economic snapshot.
   */
  readonly operationalDispositionOverride?: {
    readonly mintDisposition: Exclude<MintDisposition, 'eligible'>;
    readonly mintReasonCode: MintReasonCode;
    readonly suppressRecordPoints: boolean;
  } | null;
  /**
   * money layer (Prompt 3), pieces 1–4. The distinct witnessed, independent, non-loop origin
   * owners this PE cited. Resolved by the accrual (`origin-pricing-inputs.ts`) and sealed here.
   * INFORMATIONAL until piece 5 turns pricing on: it does NOT enter the record-points formula, so a
   * PE with origins prices byte-identically to one without at pieces 1–4. Defaults to 0.
   */
  readonly independentOriginCount?: number;
  /**
   * money layer, pieces 1–4. Tokens a WITNESS observed for the act (never the actor-declared
   * body figure). INFORMATIONAL until piece 5; adds nothing to the formula now. Defaults to 0.
   */
  readonly observedComputeTokens?: number;
  /**
   * money layer, pieces 1–4. The per-origin decision detail, sealed for audit/presentation.
   * INFORMATIONAL — never a formula input. Defaults to [].
   */
  readonly originReferences?: readonly SealedOriginReference[];
  /**
   * ops-dashboard build. WHICH capture lane produced this PE (one of the ten `CaptureLane`
   * values, or `'other'`). PURE observability metadata: it does NOT enter the record-points
   * formula, so a PE with a lane prices byte-identically to one without. Resolved by the accrual
   * (`deriveCaptureLane`) and sealed here so the console can break sealed PVT down per lane and
   * catch a lane silently going to zero. Defaults to `'other'` when absent.
   */
  readonly captureLane?: string;
  /**
   * Trust Layer build (§2.8). The emitter-declared witness class (`evidence-class.ts`). Sealed
   * INFORMATIONALLY here — the class-based admission prices through the policy resolution (the
   * synthesized action entry), never by reading this field. Absent ⇒ `'actor_declared'`.
   */
  readonly witnessClass?: string;
}

/**
 * money layer. One origin's sealed decision (structurally the `SealedOriginRef` the accrual
 * produces). Sealed on the snapshot for audit; never a pricing input at pieces 1–4. Defined here so
 * the pricing kernel keeps its minimal-dependency posture (no import of the origin module).
 */
export interface SealedOriginReference {
  readonly origin_identifier: string;
  readonly hash: string;
  readonly owner: string | null;
  readonly witnessed: boolean;
  readonly counted: boolean;
  readonly reason: string | null;
}

export interface ExactIntegerCalculation {
  readonly numerator: UnsignedInteger;
  readonly denominator: UnsignedInteger;
  readonly floorRemainder: UnsignedInteger;
}

export interface RecordTimeFactors {
  readonly basePointsAtomic: AtomicUnits;
  readonly category: string | null;
  readonly baseActionWeightBps: number;
  readonly policyOverrideBps: number | null;
  readonly effectiveActionWeightBps: number;
  readonly occurrenceOrdinal: number;
  readonly exactDuplicate: boolean;
  readonly uniqueArtifact: boolean;
  readonly noveltyBps: number;
  readonly dailyOrdinal: number;
  readonly dailyDiminishingBps: number;
  readonly attestationTier: string;
  readonly attestationMultiplierBps: number;
  readonly attestationMultipliersAtRecordPolicyBps: Readonly<Record<string, number>>;
  /**
   * sealed for external_proof_priced actions so the snapshot names the
   * table it selected. Absent on standard rows and on every pre- seal.
   */
  readonly attestationPricing?: AttestationPricing;
  readonly financialAttestationNeutral: boolean;
  readonly linkageState: LinkageState;
  readonly linkageMultiplierBps: number;
  readonly beneficiaryAgentShareBps: number;
  readonly operationalDispositionOverride: {
    readonly mintDisposition: Exclude<MintDisposition, 'eligible'>;
    readonly mintReasonCode: MintReasonCode;
    readonly suppressRecordPoints: boolean;
  } | null;
  readonly evidenceState: EvidenceState;
  readonly evidenceRequirement: ActionEvidenceRequirement;
  readonly canonicalEventId: string | null;
  readonly canonicalEventRequired: boolean;
  readonly canonicalEventGroup: string | null;
  readonly selfReferencing: boolean;
  readonly sharedBeneficialOwnership: boolean;
  readonly pairChurnDetected: boolean;
  readonly beneficialOwnershipPolicy: BeneficialOwnershipPolicy | null;
  readonly sessionLineageId: string | null;
  readonly sessionLineagePolicy: SessionLineagePolicy | null;
  readonly fixedGrantSource: FixedGrantSource;
  readonly fixedGrantAtomic: AtomicUnits | null;
  readonly genesisReservationId: string | null;
  readonly genesisPolicyManifestHash: string | null;
  readonly genesisCanonicalBountyKey: string | null;
  readonly genesisDedupeKey: string | null;
  readonly genesisStateRevisionAfter: string | null;
  readonly evidenceResolutionMode: EvidenceResolutionMode | null;
  readonly unresolvedRecordGates: readonly UnresolvedRecordGate[];
  /**
   * money layer (Prompt 3). The two pricing inputs plus per-origin detail, sealed for every
   * PE. INFORMATIONAL at pieces 1–4 — they do NOT participate in the record-points formula, so
   * `verifyRecordSnapshotIntegrity` re-derives the same numerator/denominator whatever they hold and
   * a PE with origins prices exactly like one without. Piece 5 (the multipliers) is the ONLY change
   * that folds `independentOriginCount` and `observedComputeTokens` into the formula, in both this
   * kernel and its verifier together. Default 0 / 0 / [] keeps every existing snapshot's meaning.
   */
  readonly independentOriginCount: number;
  /** Historical v2 seals only. Token counts have no authority in v3. */
  readonly observedComputeTokens?: number;
  readonly originReferences: readonly SealedOriginReference[];
  /**
   * ops-dashboard build. The capture lane that produced this PE. INFORMATIONAL — never a
   * pricing input, so `verifyRecordSnapshotIntegrity` re-derives the identical points whatever
   * it holds. Defaults to `'other'`.
   */
  readonly captureLane: string;
  /** Trust Layer build (§2.8) — sealed informational; never a pricing input here. */
  readonly witnessClass: string;
}

export interface AllowedSettlementAdjustments {
  readonly verifiedAttestationUpgrade: boolean;
  readonly globalMintRate: boolean;
}

export interface RecordEconomicSnapshot {
  readonly schemaVersion: MonetaryAccountingSchemaVersion;
  readonly policyVersion: string;
  readonly policyEffectiveAtMs: number;
  readonly policyEffectiveUntilMs: number | null;
  readonly peId: string;
  readonly economicActorId: string;
  readonly actionType: string;
  readonly recordedAtMs: number;
  readonly mintDisposition: MintDisposition;
  readonly mintReasonCode: MintReasonCode;
  readonly policyReviewState: PolicyReviewState;
  readonly policyReviewReasonCode: PolicyReviewReasonCode;
  readonly recordTimeFactors: RecordTimeFactors;
  readonly allowedSettlementAdjustments: AllowedSettlementAdjustments;
  readonly recordPointsAtomic: AtomicUnits;
  readonly recordCalculation: ExactIntegerCalculation;
}

export interface DisclosedRationalFactor {
  readonly numerator: UnsignedInteger;
  readonly denominator: UnsignedInteger;
  /** Human/audit-readable source, for example a contract address and method. */
  readonly source: string;
  /** Immutable observation reference, for example a Base block hash/number. */
  readonly asOf: string;
}

export interface EligibilityProjection {
  readonly mintDisposition: MintDisposition;
  readonly mintReasonCode: MintReasonCode;
  readonly resolutionEvidence?: readonly {
    readonly resolutionType:
      | 'evidence'
      | 'registry'
      | 'cache'
      | 'beneficiary'
      | 'jurisdiction';
    readonly evidenceId: string;
    readonly evidenceHash: string;
    readonly source: string;
    readonly asOf: string;
    readonly canonicalEventId: string | null;
  }[];
}

export interface SettlementContext {
  readonly settlementAtMs: number;
  /**
   * SHA-256 commitment read from the independently verified sealed PE/history
   * record, never recomputed from an untrusted settlement payload.
   */
  readonly authorizedRecordSnapshotHash: string;
  readonly verifiedAttestationTier: string;
  /**
   * Authoritative observation time for an attestation/corroboration enhancement.
   * Required when the requested tier differs from the record-time tier. An
   * observation after the PE's own window (30 days at/after the cut line; 72 h before it) remains provenance but cannot reprice
   * the sealed PE.
   */
  readonly verifiedAttestationObservedAtMs?: number | null;
  readonly globalMintRate: DisclosedRationalFactor;
  /**
   * Optional non-economic gate projection. It must follow the explicit state
   * machine; notably, record_only and ineligible_terminal cannot become eligible.
   */
  readonly eligibilityProjection?: EligibilityProjection;
}

export interface SettlementTimeFactors {
  readonly requestedVerifiedAttestationTier: string;
  readonly verifiedAttestationTier: string;
  readonly verifiedAttestationObservedAtMs: number | null;
  readonly enhancementWindowExpiresAtMs: number;
  readonly enhancementApplied: boolean;
  readonly recordAttestationMultiplierBps: number;
  readonly settlementAttestationMultiplierBps: number;
  readonly attestationAdjustmentNumerator: UnsignedInteger;
  readonly attestationAdjustmentDenominator: UnsignedInteger;
  readonly globalMintRate: DisclosedRationalFactor;
}

export interface SettlementCalculation {
  readonly schemaVersion: MonetaryAccountingSchemaVersion;
  readonly recordPolicyVersion: string;
  readonly peId: string;
  readonly settlementAtMs: number;
  readonly effectiveMintDisposition: MintDisposition;
  readonly effectiveMintReasonCode: MintReasonCode;
  readonly settlementPermitted: boolean;
  readonly recordPointsAtomic: AtomicUnits;
  /** Exact points to submit to a direct-mint contract before its global factors. */
  readonly contractInputPointsAtomic: AtomicUnits;
  /** Exact attestation-adjustment floor that produced contractInputPointsAtomic. */
  readonly contractInputCalculation: ExactIntegerCalculation;
  readonly settlementTimeFactors: SettlementTimeFactors;
  readonly finalPvtAtomic: AtomicUnits;
  readonly finalCalculation: ExactIntegerCalculation;
}

const MINT_REASON_CODES_BY_DISPOSITION: Readonly<
  Record<MintDisposition, readonly MintReasonCode[]>
> = {
  eligible: ['policy_eligible'],
  pending_evidence: ['awaiting_evidence'],
  pending_review: [
    'awaiting_review',
    'same_owner_unresolvable',
    'mint_claim_unverifiable',
    'receive_authorship_unresolvable',
    'registry_hold',
  ],
  record_only: [
    'policy_record_only',
    'system_accounting_record_only',
    'unknown_action_type',
    'unverifiable_evidence_record_only',
    'self_attested_evidence_record_only',
    'self_or_shared_beneficial_ownership',
    'pair_churn_record_only',
    'missing_session_lineage_record_only',
    'unsolicited_receive_record_only',
    'speech_window_budget_exhausted',
    'speech_no_live_pass_record_only',
    'provian_service_fee',
  ],
  ineligible_terminal: ['policy_ineligible', 'exact_duplicate'],
  pending_cache: ['cache_unavailable'],
  pending_compliance: ['jurisdiction_unknown', 'sdn_unavailable', 'jurisdiction_blocked'],
  beneficiary_pending: ['beneficiary_unresolved'],
  jurisdiction_deferred: ['jurisdiction_deferred'],
};

const POLICY_REVIEW_REASON_CODES_BY_STATE: Readonly<
  Record<PolicyReviewState, readonly PolicyReviewReasonCode[]>
> = {
  not_required: ['known_policy_entry'],
  class_admitted: ['witness_class_admitted'],
  pending_policy: ['unknown_action_type'],
  classified_prospective: ['classification_approved_prospective'],
  rejected: ['classification_rejected'],
};

const MINT_DISPOSITION_TRANSITIONS: Readonly<
  Record<MintDisposition, readonly MintDisposition[]>
> = {
  eligible: [
    'pending_review',
    'pending_cache',
    'beneficiary_pending',
    'jurisdiction_deferred',
    'pending_compliance',
    'record_only',
    'ineligible_terminal',
  ],
  pending_evidence: [
    'eligible',
    'pending_review',
    'pending_cache',
    'record_only',
    'ineligible_terminal',
    'beneficiary_pending',
    'jurisdiction_deferred',
    'pending_compliance',
  ],
  pending_review: [
    'eligible',
    'pending_cache',
    'record_only',
    'ineligible_terminal',
    'beneficiary_pending',
    'jurisdiction_deferred',
    'pending_compliance',
  ],
  record_only: [],
  ineligible_terminal: [],
  pending_cache: [
    'eligible',
    'pending_evidence',
    'pending_review',
    'record_only',
    'ineligible_terminal',
    'beneficiary_pending',
    'jurisdiction_deferred',
    'pending_compliance',
  ],
  pending_compliance: ['eligible', 'jurisdiction_deferred', 'record_only', 'ineligible_terminal'],
  beneficiary_pending: ['eligible', 'jurisdiction_deferred', 'ineligible_terminal'],
  jurisdiction_deferred: ['eligible', 'beneficiary_pending', 'ineligible_terminal'],
};

const POLICY_REVIEW_TRANSITIONS: Readonly<
  Record<PolicyReviewState, readonly PolicyReviewState[]>
> = {
  not_required: [],
  pending_policy: ['classified_prospective', 'rejected', 'class_admitted'],
  classified_prospective: [],
  class_admitted: [],
  rejected: [],
};

const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;
const SHA256_COMMITMENT = /^sha256:[a-f0-9]{64}$/;
const RESOLUTION_EVIDENCE_TYPES = Object.freeze([
  'evidence',
  'registry',
  'cache',
  'beneficiary',
  'jurisdiction',
] as const);
const MAX_RESOLUTION_EVIDENCE_ITEMS = RESOLUTION_EVIDENCE_TYPES.length;

function canonicalSnapshotJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Snapshot contains a non-safe integer');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSnapshotJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) {
    throw new Error('Snapshot contains a non-canonical value');
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalSnapshotJson(record[key])}`).join(',')}}`;
}

/** Commitment that must be stored inside/alongside the independently sealed PE. */
export function hashRecordEconomicSnapshot(snapshot: RecordEconomicSnapshot): string {
  return hashCanonicalSnapshotBytes(canonicalSnapshotJson(snapshot));
}

function hashCanonicalSnapshotBytes(canonicalBytes: string): string {
  return `sha256:${crypto.createHash('sha256')
    .update(canonicalBytes, 'utf8')
    .digest('hex')}`;
}

function materializeAuthorizedRecordSnapshot(
  snapshot: RecordEconomicSnapshot,
  authorizedRecordSnapshotHash: string,
): RecordEconomicSnapshot {
  if (!SHA256_COMMITMENT.test(authorizedRecordSnapshotHash)) {
    throw new Error('Authorized record snapshot commitment is missing or invalid');
  }
  // Read the caller object exactly once into canonical bytes. Validation and
  // settlement then use only the inert parsed copy, closing accessor/proxy
  // TOCTOU attacks where a field changes after its commitment is checked.
  const canonicalBytes = canonicalSnapshotJson(snapshot);
  if (hashCanonicalSnapshotBytes(canonicalBytes) !== authorizedRecordSnapshotHash) {
    throw new Error('Record snapshot does not match the independently sealed commitment');
  }
  return JSON.parse(canonicalBytes) as RecordEconomicSnapshot;
}

function materializeSettlementContext(context: SettlementContext): SettlementContext {
  // Settlement factors/projections are also caller-owned objects. Normalize
  // them once so accessors cannot change disposition, evidence, or a rational
  // factor between validation and use.
  return JSON.parse(canonicalSnapshotJson(context)) as SettlementContext;
}

export function atomicUnits(value: bigint | string): AtomicUnits {
  const canonical = typeof value === 'bigint' ? value.toString() : value;
  if (!CANONICAL_UNSIGNED_INTEGER.test(canonical)) {
    throw new Error('Atomic units must be a canonical non-negative integer string');
  }
  return canonical as AtomicUnits;
}

export function unsignedInteger(value: bigint | string): UnsignedInteger {
  const canonical = typeof value === 'bigint' ? value.toString() : value;
  if (!CANONICAL_UNSIGNED_INTEGER.test(canonical)) {
    throw new Error('Value must be a canonical non-negative integer string');
  }
  return canonical as UnsignedInteger;
}

export function disclosedRationalFactor(
  numerator: bigint | string,
  denominator: bigint | string,
  source: string,
  asOf: string,
): DisclosedRationalFactor {
  const normalizedNumerator = unsignedInteger(numerator);
  const normalizedDenominator = unsignedInteger(denominator);
  if (BigInt(normalizedDenominator) === 0n) {
    throw new Error('Rational factor denominator must be greater than zero');
  }
  assertNonEmpty(source, 'Rational factor source');
  assertNonEmpty(asOf, 'Rational factor asOf');
  return Object.freeze({
    numerator: normalizedNumerator,
    denominator: normalizedDenominator,
    source,
    asOf,
  });
}

export function ordinaryNoveltyBps(occurrenceOrdinal: number): number {
  assertPositiveOrdinal(occurrenceOrdinal, 'occurrenceOrdinal');
  if (occurrenceOrdinal === 1) return 10_000;
  if (occurrenceOrdinal === 2) return 7_000;
  if (occurrenceOrdinal === 3) return 4_000;
  return 3_000;
}

export function uniqueArtifactNoveltyBps(occurrenceOrdinal: number): number {
  assertPositiveOrdinal(occurrenceOrdinal, 'occurrenceOrdinal');
  if (occurrenceOrdinal <= 10) return 10_000;
  if (occurrenceOrdinal <= 20) return 8_000;
  if (occurrenceOrdinal <= 50) return 6_000;
  return 3_000;
}

/**
 * money layer. A pricing-input count (independent origins, observed tokens) is a non-negative
 * integer or it is nothing: a non-finite, non-integer, or negative value floors to 0 (Unknown =
 * Block — never a fractional or negative multiplier input). The accrual already guarantees this; the
 * kernel repeats it so a snapshot is self-consistent whatever the caller passed.
 */
function normalizeMoneyLayerCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return 0;
  }
  return value;
}

export function noveltyBps(input: {
  readonly occurrenceOrdinal: number;
  readonly exactDuplicate: boolean;
  readonly uniqueArtifact: boolean;
}): number {
  assertPositiveOrdinal(input.occurrenceOrdinal, 'occurrenceOrdinal');
  if (input.exactDuplicate) return 0;
  return input.uniqueArtifact
    ? uniqueArtifactNoveltyBps(input.occurrenceOrdinal)
    : ordinaryNoveltyBps(input.occurrenceOrdinal);
}

/**
 * the daily qualification ordinal is REMOVED — the
 * DAILY_ORDINAL_QUALIFICATION_LIMIT constant (50,) that succeeded the
 * retired diminishing curve no longer exists, together with the 200/hour and
 * 2000/day per-user PE caps. PVT is an exponential currency: lifetime earning
 * is uncapped by design, and a fixed volume number is a bet against the
 * thesis. Volume never gates qualification and never reprices an act;
 * anti-farming belongs in the evidence layer (mint-once claims, chain
 * verification, per-action identity caps in activity-mint-limits.ts) and in
 * novelty PRICING, never in a ceiling. `dailyOrdinal` remains a sealed
 * provenance FACT on every snapshot (and 's flat constant below remains
 * what every new record seals); only the limit read against it is gone.
 *
 * the daily diminishing-returns rate cut is REMOVED from
 * current policy. A qualified act's price does not depend on how many other
 * PEs its author recorded that day. Every new record seals the constant below.
 */
export function dailyDiminishingBps(dailyOrdinal: number): number {
  assertPositiveOrdinal(dailyOrdinal, 'dailyOrdinal');
  return BPS_DENOMINATOR;
}

/**
 * SEALED-HISTORY RE-DERIVATION ONLY (the pattern, applied to).
 * This is the retired curve exactly as it priced rows sealed BEFORE * full through daily ordinal 50, then halving per ordinal with a 10 bps floor.
 * Removing a rule must not reprice — or wedge — points that are already
 * sealed, so snapshot validation accepts EITHER the current constant or this
 * re-derivation, and nothing reachable from pricing a new record calls it.
 */
export function supersededDailyDiminishingBps(dailyOrdinal: number): number {
  assertPositiveOrdinal(dailyOrdinal, 'dailyOrdinal');
  if (dailyOrdinal <= 50) return 10_000;

  const halvings = dailyOrdinal - 50;
  // 10_000 / 2^10 is below the explicit 10 bps floor. Avoid constructing an
  // enormous bigint for an adversarially large ordinal once the floor is known.
  if (halvings >= 10) return 10;
  const diminished = BigInt(BPS_DENOMINATOR) / (1n << BigInt(halvings));
  return Number(diminished < 10n ? 10n : diminished);
}

export function canTransitionMintDisposition(
  from: MintDisposition,
  to: MintDisposition,
): boolean {
  return from === to || MINT_DISPOSITION_TRANSITIONS[from].includes(to);
}

/**
 * A mint disposition is TERMINAL when it has no outgoing transition: the row can
 * never reach `eligible`, so it will never mint. Derived from the single
 * `MINT_DISPOSITION_TRANSITIONS` source of truth — NOT a redeclared
 * `{record_only, ineligible_terminal}` literal — so a future terminal
 * disposition is classified correctly without editing every caller. Today the
 * terminal set is exactly {record_only, ineligible_terminal}; the deferred
 * (`beneficiary_pending`, `jurisdiction_deferred`) and pending states are all
 * non-terminal because each can still transition to `eligible`.
 */
export function isTerminalMintDisposition(disposition: MintDisposition): boolean {
  return MINT_DISPOSITION_TRANSITIONS[disposition].length === 0;
}

export function canTransitionPolicyReviewState(
  from: PolicyReviewState,
  to: PolicyReviewState,
): boolean {
  return from === to || POLICY_REVIEW_TRANSITIONS[from].includes(to);
}

export function computeRecordSnapshot(
  policy: MonetaryPolicyVersion,
  input: RecordCalculationInput,
): RecordEconomicSnapshot {
  validatePolicyWindow(policy, input.recordedAtMs);
  validateRecordInput(input);
  // only an admitted App Attest class can carry a pricing hardware tier.
  // The boundary also protects callers other than the device mapper. Old sealed snapshots do not enter here.
  if(input.witnessClass!=='hardware_rooted')input={...input,attestationTier:ordinaryHardwareAttestationTier(input.attestationTier)};

  // money layer, pieces 1–4. Normalize the two pricing inputs defensively (Unknown = Block):
  // the accrual already floors these, but the kernel never trusts a non-integer/negative count into
  // a field that piece 5 will multiply. Sealed informational-only here; the formula is untouched.
  const independentOriginCount = normalizeMoneyLayerCount(input.independentOriginCount);
  const originReferences: readonly SealedOriginReference[] = Object.freeze(
    (input.originReferences ?? []).map((o) => Object.freeze({
      origin_identifier: String(o.origin_identifier),
      hash: String(o.hash),
      owner: o.owner === null ? null : String(o.owner),
      witnessed: o.witnessed === true,
      counted: o.counted === true,
      reason: o.reason === null || o.reason === undefined ? null : String(o.reason),
    })),
  );
  // ops-dashboard build. Seal the capture lane (informational). The accrual resolves the exact
  // lane; the kernel only normalizes an untrusted value to one of the ten (or `'other'`), never
  // prices from it. A missing lane seals `'other'` so every snapshot carries the field.
  const captureLane: string = isCaptureLane(input.captureLane) ? input.captureLane : 'other';
  const witnessClass: string = isWitnessClass(input.witnessClass) ? input.witnessClass : 'actor_declared';

  const actionPolicy = policy.actions[input.actionType];
  // an external_proof_priced action reads the evidence-priced table,
  // where self-attested tiers are 0. Selecting the table BEFORE cloning means
  // the sealed snapshot carries exactly the table that priced it, so sealed
  // validation and settlement read the same calibration without re-deriving.
  const attestationPricing: AttestationPricing =
    actionPolicy?.attestationPricing ?? 'standard';
  let attestationTable: Readonly<Record<string, number>>;
  if (attestationPricing === 'external_proof_priced') {
    if (policy.evidencePricedAttestationMultipliersBps === undefined) {
      throw new Error(
        `Policy ${policy.policyVersion} prices ${input.actionType} on external proof but carries no evidence-priced attestation table`,
      );
    }
    attestationTable = cloneAndValidateAttestationTable(
      policy.evidencePricedAttestationMultipliersBps,
      { allowZero: true },
    );
  } else {
    attestationTable = cloneAndValidateAttestationTable(policy.attestationMultipliersBps);
  }
  let category: string | null = null;
  let baseActionWeightBps = 0;
  let policyOverrideBps: number | null = null;
  let effectiveActionWeightBps = 0;
  let financialAttestationNeutral = false;
  let allowVerifiedAttestationUpgrade = false;
  let evidenceRequirement: ActionEvidenceRequirement = 'operator_policy_review';
  let canonicalEventRequired = false;
  let canonicalEventGroup: string | null = null;
  let beneficialOwnershipPolicy: BeneficialOwnershipPolicy | null = null;
  let sessionLineagePolicy: SessionLineagePolicy | null = null;
  let fixedGrantSource: FixedGrantSource = 'none';
  let evidenceResolutionMode: EvidenceResolutionMode | null = null;
  let mintDisposition: MintDisposition = 'record_only';
  let mintReasonCode: MintReasonCode = 'unknown_action_type';
  let policyReviewState: PolicyReviewState = 'pending_policy';
  let policyReviewReasonCode: PolicyReviewReasonCode = 'unknown_action_type';
  const unresolvedRecordGates: UnresolvedRecordGate[] = [];

  if (actionPolicy !== undefined) {
    validateActionPolicy(actionPolicy, input.actionType);
    category = actionPolicy.category;
    baseActionWeightBps = actionPolicy.baseWeightBps;
    policyOverrideBps = actionPolicy.policyOverrideBps;
    effectiveActionWeightBps = policyOverrideBps ?? baseActionWeightBps;
    financialAttestationNeutral = actionPolicy.financialAttestationNeutral;
    allowVerifiedAttestationUpgrade = actionPolicy.allowVerifiedAttestationUpgrade;
    evidenceRequirement = actionPolicy.evidenceRequirement;
    canonicalEventRequired = actionPolicy.canonicalEventRequired;
    canonicalEventGroup = actionPolicy.canonicalEventGroup;
    beneficialOwnershipPolicy = actionPolicy.beneficialOwnershipPolicy;
    sessionLineagePolicy = actionPolicy.sessionLineagePolicy;
    fixedGrantSource = actionPolicy.fixedGrantSource;
    evidenceResolutionMode = actionPolicy.evidenceResolutionMode;
    mintDisposition = actionPolicy.mintDisposition;
    mintReasonCode = actionPolicy.mintReasonCode;
    policyReviewState = actionPolicy.policyReviewState;
    policyReviewReasonCode = actionPolicy.policyReviewReasonCode;
  }

  if (fixedGrantSource === 'none' && input.genesisReservation !== null) {
    throw new Error(`Non-Genesis action cannot carry a Genesis reservation: ${input.actionType}`);
  }
  if (
    fixedGrantSource === 'genesis_campaign_reservation'
    && input.genesisReservation === null
  ) {
    throw new Error(`Genesis action requires an immutable reservation receipt: ${input.actionType}`);
  }
  if (input.genesisReservation !== null) {
    validateGenesisReservationReceipt(
      input.genesisReservation,
      input.peId,
      input.economicActorId,
      input.recordedAtMs,
      input.actionType,
      canonicalEventGroup,
    );
    if (
      input.canonicalEventId !== null
      && input.canonicalEventId !== input.genesisReservation.reservation_id
    ) {
      throw new Error('Genesis canonical event must match the reservation receipt');
    }
  }
  const canonicalEventId = input.genesisReservation?.reservation_id ?? input.canonicalEventId;

  if (
    actionPolicy !== undefined
    && mintDisposition !== 'record_only'
    && mintDisposition !== 'ineligible_terminal'
  ) {
    if (
      mintDisposition === 'pending_evidence'
      || (evidenceRequirement !== 'none' && input.evidenceState === 'pending')
    ) unresolvedRecordGates.push('evidence');
    if (canonicalEventRequired && canonicalEventId === null) {
      unresolvedRecordGates.push('canonical_event');
    }
    if (mintDisposition === 'pending_review' || input.linkageState === 'unverifiable') {
      unresolvedRecordGates.push('registry');
    }
    if (sessionLineagePolicy === 'required' && input.sessionLineageId === null) {
      unresolvedRecordGates.push('session_lineage');
    }
  }

  if (actionPolicy !== undefined) {
    if (mintDisposition === 'eligible' && evidenceRequirement !== 'none') {
      if (input.evidenceState === 'rejected') {
        mintDisposition = 'ineligible_terminal';
        mintReasonCode = 'policy_ineligible';
      } else if (input.evidenceState === 'unverifiable') {
        mintDisposition = 'record_only';
        mintReasonCode = 'unverifiable_evidence_record_only';
      } else if (input.evidenceState !== 'verified') {
        mintDisposition = 'pending_evidence';
        mintReasonCode = 'awaiting_evidence';
      }
    }
    // evidence floor, now DORMANT under on an external_proof_priced
    // action a tier whose multiplier is 0 seals terminal record_only.
    // un-zeroed every self-attested tier in the LIVE table (software 0.8x,
    // software_verified 1.0x, social 0.5x), so this guard never fires for a live
    // record — self-attested/observed work seals eligible at its discount, priced
    // down by novelty, and a bare self-report carrying no server-stamped verified
    // evidence floors earlier as pending_evidence via the evidence gate above.
    // The guard is retained as a fail-safe: were any evidence-priced tier ever
    // set to 0 again, it must fail closed to record_only rather than mint a
    // 0-point "eligible" row. A tier absent from the table stays fail-closed via
    // the throw below.
    if (
      attestationPricing === 'external_proof_priced'
      && fixedGrantSource === 'none'
      && attestationTable[input.attestationTier] === 0
      && mintDisposition !== 'record_only'
      && mintDisposition !== 'ineligible_terminal'
    ) {
      mintDisposition = 'record_only';
      mintReasonCode = 'self_attested_evidence_record_only';
    }
    if (
      mintDisposition === 'eligible'
      && canonicalEventRequired
      && (canonicalEventId === null || canonicalEventId.trim().length === 0)
    ) {
      mintDisposition = 'pending_evidence';
      mintReasonCode = 'awaiting_evidence';
    }
    if (
      unresolvedRecordGates.includes('session_lineage')
      && mintDisposition !== 'record_only'
      && mintDisposition !== 'ineligible_terminal'
    ) {
      // Session lineage is a record-time fact. It cannot be supplied later by
      // settlement evidence without rewriting the PE's causal history.
      mintDisposition = 'record_only';
      mintReasonCode = 'missing_session_lineage_record_only';
    }
    if (
      unresolvedRecordGates.includes('registry')
      && mintDisposition !== 'record_only'
      && mintDisposition !== 'ineligible_terminal'
    ) {
      mintDisposition = 'pending_review';
      mintReasonCode = 'awaiting_review';
    }
    if (
      beneficialOwnershipPolicy === 'record_only_if_self_shared_or_churn'
      && (input.selfReferencing || input.sharedBeneficialOwnership)
    ) {
      mintDisposition = 'record_only';
      mintReasonCode = 'self_or_shared_beneficial_ownership';
    }
    if (
      beneficialOwnershipPolicy === 'record_only_if_self_shared_or_churn'
      && input.pairChurnDetected
    ) {
      mintDisposition = 'record_only';
      mintReasonCode = 'pair_churn_record_only';
    }
    if (input.exactDuplicate) {
      mintDisposition = 'ineligible_terminal';
      mintReasonCode = 'exact_duplicate';
    }
  }

  const operationalOverride = input.operationalDispositionOverride ?? null;
  if (operationalOverride !== null) {
    assertMintReasonMatchesDisposition(
      operationalOverride.mintDisposition,
      operationalOverride.mintReasonCode,
    );
    // A terminal policy verdict (unknown/retired/duplicate) always outranks a
    // recoverable operational hold such as cache failure. The operational
    // suppression remains sealed below for audit and zero-point recomputation,
    // but it may never make terminal policy state more permissive.
    const policyVerdictIsTerminal = mintDisposition === 'record_only'
      || mintDisposition === 'ineligible_terminal';
    if (!policyVerdictIsTerminal
      && !canTransitionMintDisposition(mintDisposition, operationalOverride.mintDisposition)) {
      throw new Error(
        `Invalid record-time operational disposition transition: ${mintDisposition} -> ${operationalOverride.mintDisposition}`,
      );
    }
    if (!policyVerdictIsTerminal) {
      mintDisposition = operationalOverride.mintDisposition;
      mintReasonCode = operationalOverride.mintReasonCode;
    }
  }

  const resolvedNoveltyBps = noveltyBps(input);
  const resolvedDailyDiminishingBps = dailyDiminishingBps(input.dailyOrdinal);
  const rawAttestationMultiplier = attestationTable[input.attestationTier];
  if (rawAttestationMultiplier === undefined) {
    throw new Error(`Unknown attestation tier: ${input.attestationTier}`);
  }
  const isFixedGrant = fixedGrantSource === 'genesis_campaign_reservation';
  const attestationMultiplierBps = financialAttestationNeutral || isFixedGrant
    ? BPS_DENOMINATOR
    : rawAttestationMultiplier;
  const linkageMultiplierBps = isFixedGrant
    ? BPS_DENOMINATOR
    : policy.linkageMultipliersBps[input.linkageState];
  if (linkageMultiplierBps === undefined) {
    throw new Error(`Missing linkage multiplier for state: ${input.linkageState}`);
  }
  assertPositiveBps(linkageMultiplierBps, `linkage multiplier for ${input.linkageState}`);
  const beneficiaryAgentShareBps = isFixedGrant
    ? BPS_DENOMINATOR
    : (input.beneficiaryAgentShareBps ?? BPS_DENOMINATOR);
  assertNonNegativeBps(beneficiaryAgentShareBps, 'beneficiaryAgentShareBps');
  if (beneficiaryAgentShareBps > BPS_DENOMINATOR) {
    throw new Error('beneficiaryAgentShareBps cannot exceed 10000');
  }

  const basePoints = parseAtomicUnits(policy.basePointsAtomic, 'basePointsAtomic');
  const fixedGrant = input.genesisReservation === null
    ? 0n
    : parseAtomicUnits(
      input.genesisReservation.reserved_atomic as AtomicUnits,
      'genesisReservation.reserved_atomic',
    );
  const suppressRecordPoints = operationalOverride?.suppressRecordPoints === true;
  // independence survives unchanged; token volume has no pricing input.
  const independenceMultiplierNumerator =
    BigInt(BPS_DENOMINATOR) + BigInt(INDEPENDENCE_PER_ORIGIN_BPS) * BigInt(independentOriginCount);
  const numerator = suppressRecordPoints
    ? 0n
    : isFixedGrant
    ? (input.exactDuplicate ? 0n : fixedGrant)
    : basePoints
      * BigInt(effectiveActionWeightBps)
      * BigInt(resolvedNoveltyBps)
      * BigInt(resolvedDailyDiminishingBps)
      * BigInt(linkageMultiplierBps)
      * BigInt(attestationMultiplierBps)
      * independenceMultiplierNumerator;
  const denominator = isFixedGrant
    ? 1n
    : BigInt(BPS_DENOMINATOR) ** 5n
      * BigInt(BPS_DENOMINATOR);
  const recordPoints = numerator / denominator;
  const recordRemainder = numerator % denominator;

  const recordTimeFactors: RecordTimeFactors = Object.freeze({
    basePointsAtomic: policy.basePointsAtomic,
    category,
    baseActionWeightBps,
    policyOverrideBps,
    effectiveActionWeightBps,
    occurrenceOrdinal: input.occurrenceOrdinal,
    exactDuplicate: input.exactDuplicate,
    uniqueArtifact: input.uniqueArtifact,
    noveltyBps: resolvedNoveltyBps,
    dailyOrdinal: input.dailyOrdinal,
    dailyDiminishingBps: resolvedDailyDiminishingBps,
    attestationTier: input.attestationTier,
    attestationMultiplierBps,
    attestationMultipliersAtRecordPolicyBps: attestationTable,
    ...(attestationPricing === 'external_proof_priced'
      ? { attestationPricing }
      : {}),
    financialAttestationNeutral: financialAttestationNeutral || isFixedGrant,
    linkageState: input.linkageState,
    linkageMultiplierBps,
    beneficiaryAgentShareBps,
    operationalDispositionOverride: operationalOverride,
    evidenceState: input.evidenceState,
    evidenceRequirement,
    canonicalEventId,
    canonicalEventRequired,
    canonicalEventGroup,
    selfReferencing: input.selfReferencing,
    sharedBeneficialOwnership: input.sharedBeneficialOwnership,
    pairChurnDetected: input.pairChurnDetected,
    beneficialOwnershipPolicy,
    sessionLineageId: input.sessionLineageId,
    sessionLineagePolicy,
    fixedGrantSource,
    fixedGrantAtomic: input.genesisReservation === null
      ? null
      : atomicUnits(input.genesisReservation.reserved_atomic),
    genesisReservationId: input.genesisReservation?.reservation_id ?? null,
    genesisPolicyManifestHash: input.genesisReservation?.policy_manifest_hash ?? null,
    genesisCanonicalBountyKey: input.genesisReservation?.canonical_bounty_key ?? null,
    genesisDedupeKey: input.genesisReservation?.dedupe_key ?? null,
    genesisStateRevisionAfter: input.genesisReservation?.state_revision_after ?? null,
    evidenceResolutionMode,
    unresolvedRecordGates: Object.freeze([...new Set(unresolvedRecordGates)]),
    // money layer — sealed informational (piece 5 folds the two scalars into the formula).
    independentOriginCount,
    originReferences,
    // ops-dashboard build — sealed informational (never a pricing input).
    captureLane,
    // — sealed informational.
    witnessClass,
  });

  const allowedSettlementAdjustments: AllowedSettlementAdjustments = Object.freeze({
    verifiedAttestationUpgrade:
      !isFixedGrant && !financialAttestationNeutral && allowVerifiedAttestationUpgrade,
    globalMintRate: !isFixedGrant,
  });

  return Object.freeze({
    schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION,
    policyVersion: policy.policyVersion,
    policyEffectiveAtMs: policy.effectiveAtMs,
    policyEffectiveUntilMs: policy.effectiveUntilMs,
    peId: input.peId,
    economicActorId: input.economicActorId,
    actionType: input.actionType,
    recordedAtMs: input.recordedAtMs,
    mintDisposition,
    mintReasonCode,
    policyReviewState,
    policyReviewReasonCode,
    recordTimeFactors,
    allowedSettlementAdjustments,
    recordPointsAtomic: atomicUnits(recordPoints),
    recordCalculation: exactCalculation(numerator, denominator, recordRemainder),
  });
}

export function computeSettlement(
  snapshot: RecordEconomicSnapshot,
  context: SettlementContext,
): SettlementCalculation {
  context = materializeSettlementContext(context);
  snapshot = materializeAuthorizedRecordSnapshot(
    snapshot,
    context.authorizedRecordSnapshotHash,
  );
  validateSnapshot(snapshot);
  if(snapshot.schemaVersion===MONETARY_ACCOUNTING_SCHEMA_VERSION_V3&&snapshot.recordTimeFactors.witnessClass!=='hardware_rooted')context={...context,verifiedAttestationTier:ordinaryHardwareAttestationTier(context.verifiedAttestationTier)};
  assertSafeInteger(context.settlementAtMs, 'settlementAtMs');
  if (context.settlementAtMs < snapshot.recordedAtMs) {
    throw new Error('Settlement cannot precede record time');
  }
  assertNonEmpty(context.verifiedAttestationTier, 'verifiedAttestationTier');

  const globalMintRate = snapshot.allowedSettlementAdjustments.globalMintRate
    ? cloneAndValidateFactor(context.globalMintRate, 'globalMintRate')
    : disclosedRationalFactor(1n, 1n, 'record_policy_fixed_grant', snapshot.policyVersion);
  const projection = resolveEligibilityProjection(snapshot, context.eligibilityProjection);
  const recordFactors = snapshot.recordTimeFactors;
  const recordAttestationMultiplierBps = recordFactors.attestationMultiplierBps;
  const targetMultiplierFromRecordPolicy =
    recordFactors.attestationMultipliersAtRecordPolicyBps[context.verifiedAttestationTier];
  if (targetMultiplierFromRecordPolicy === undefined) {
    throw new Error(
      `Attestation tier is absent from record policy ${snapshot.policyVersion}: ${context.verifiedAttestationTier}`,
    );
  }
  assertPositiveBps(targetMultiplierFromRecordPolicy, 'settlement attestation multiplier');

  let settlementAttestationMultiplierBps = recordAttestationMultiplierBps;
  let effectiveAttestationTier = recordFactors.attestationTier;
  let enhancementApplied = false;
  // the window is the PE's OWN — 30 days from its record time at/after the
  // cut line, the legacy 72 h before it. Never measured from batch seal or settlement.
  const enhancementWindowExpiresAtMs = snapshot.recordedAtMs
    + attestationEnhancementWindowMsFor(snapshot.recordedAtMs);
  assertSafeInteger(enhancementWindowExpiresAtMs, 'enhancementWindowExpiresAtMs');
  const observedAt = context.verifiedAttestationObservedAtMs ?? null;
  if (observedAt !== null) {
    assertSafeInteger(observedAt, 'verifiedAttestationObservedAtMs');
    if (observedAt < snapshot.recordedAtMs) {
      throw new Error('Attestation observation cannot predate the PE');
    }
    if (observedAt > context.settlementAtMs) {
      throw new Error('Attestation observation cannot postdate settlement');
    }
  }
  // (DIGEST-NEUTRAL corroboration lift). An external-proof-priced action
  // (VERIFIED_SOVEREIGN_AGENT_WORK / VERIFIED_EXTERNAL_SERVICE_OUTCOME) carries
  // `allowVerifiedAttestationUpgrade === false` by construction — its evidence
  // table is flat proof-or-zero, so `validateActionPolicy` forbids the flag. That
  // left one legitimate upgrade unauthorized: a record-time SELF-attested tier
  // (software 0.8×) whose commit was later CORROBORATED by an independent second
  // witness (the forge↔daemon cross-witness signal) earns the family's flat 1.0×
  // "corroboration is evidence strength", the operator. This carve-out authorizes
  // that ONE upgrade in code (no flag flip, no cell change → the activation-
  // template digest and the action-policy matrix hash both stay still, so it needs
  // no signature): the target tier must be exactly `corroborated`, and the sealed
  // class must be `external_proof_priced`. Every OTHER target (hardware / TEE /
  // software_verified — all self-CLAIMABLE) stays refused; only an externally
  // stamped corroboration lifts. The per-PE observation window below still gates
  // it, so a late signal is a record, not value.
  const externalProofCorroborationLift =
    recordFactors.attestationPricing === 'external_proof_priced'
    && context.verifiedAttestationTier === 'corroborated';
  if (!recordFactors.financialAttestationNeutral) {
    if (targetMultiplierFromRecordPolicy < recordAttestationMultiplierBps) {
      throw new Error('Settlement attestation adjustment cannot downgrade record-time attestation');
    }
    if (
      targetMultiplierFromRecordPolicy !== recordAttestationMultiplierBps
      && !snapshot.allowedSettlementAdjustments.verifiedAttestationUpgrade
      && !externalProofCorroborationLift
    ) {
      throw new Error('Verified attestation upgrade is not authorized by the record snapshot');
    }
    if (targetMultiplierFromRecordPolicy !== recordAttestationMultiplierBps) {
      if (observedAt === null) {
        throw new Error('Attestation enhancement requires an authoritative observation time');
      }
      // Late evidence remains a corroboration record, but the economic value is
      // frozen at the record-time tier after the PE's own window (30 days at/after
      // the cut line; the legacy 72 hours before it).
      if (observedAt <= enhancementWindowExpiresAtMs) {
        settlementAttestationMultiplierBps = targetMultiplierFromRecordPolicy;
        effectiveAttestationTier = context.verifiedAttestationTier;
        enhancementApplied = true;
      }
    } else {
      effectiveAttestationTier = context.verifiedAttestationTier;
    }
  }

  const recordPoints = parseAtomicUnits(snapshot.recordPointsAtomic, 'recordPointsAtomic');
  const settlementPermitted = projection.mintDisposition === 'eligible';
  const eligibleRecordPoints = settlementPermitted ? recordPoints : 0n;
  const contractInputNumerator = eligibleRecordPoints
    * BigInt(settlementAttestationMultiplierBps);
  const contractInputDenominator = BigInt(recordAttestationMultiplierBps);
  const contractInputPoints = contractInputNumerator / contractInputDenominator;
  const contractInputRemainder = contractInputNumerator % contractInputDenominator;
  // The kernel receives the already-floored contractInputPoints and then applies
  // the epoch's armed mint rate. It cannot recover the discarded attestation
  // remainder. Applying the rate to the pre-floor fraction overprojects by
  // atomic units at non-unit rates (for example 10 * 4/3 -> 13). Parity minting:
  // the mint rate is the ONLY settlement factor. No supply/lifetime scaler.
  const numerator = contractInputPoints
    * BigInt(globalMintRate.numerator);
  const denominator = BigInt(globalMintRate.denominator);
  const finalPvt = numerator / denominator;
  const finalRemainder = numerator % denominator;

  const settlementTimeFactors: SettlementTimeFactors = Object.freeze({
    requestedVerifiedAttestationTier: context.verifiedAttestationTier,
    verifiedAttestationTier: effectiveAttestationTier,
    verifiedAttestationObservedAtMs: observedAt,
    enhancementWindowExpiresAtMs,
    enhancementApplied,
    recordAttestationMultiplierBps,
    settlementAttestationMultiplierBps,
    attestationAdjustmentNumerator: unsignedInteger(BigInt(settlementAttestationMultiplierBps)),
    attestationAdjustmentDenominator: unsignedInteger(BigInt(recordAttestationMultiplierBps)),
    globalMintRate,
  });

  return Object.freeze({
    schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION,
    recordPolicyVersion: snapshot.policyVersion,
    peId: snapshot.peId,
    settlementAtMs: context.settlementAtMs,
    effectiveMintDisposition: projection.mintDisposition,
    effectiveMintReasonCode: projection.mintReasonCode,
    settlementPermitted,
    recordPointsAtomic: snapshot.recordPointsAtomic,
    contractInputPointsAtomic: atomicUnits(contractInputPoints),
    contractInputCalculation: exactCalculation(
      contractInputNumerator,
      contractInputDenominator,
      contractInputRemainder,
    ),
    settlementTimeFactors,
    finalPvtAtomic: atomicUnits(finalPvt),
    finalCalculation: exactCalculation(numerator, denominator, finalRemainder),
  });
}

/**
 * recompute a held row's record points at a CORRECTED linkage state, for the
 * registry-hold resolver. The registry chain-reader defect sealed genuinely-linked rows
 * with linkageState 'unverifiable' (1.0x); their true live value uses the linked
 * multiplier. ONLY the linkage factor was wrong, so we rescale the sealed EXACT numerator
 * by correctedBps/sealedBps — an exact integer division, since the sealed numerator carries
 * the sealed linkage multiplier as a factor — and re-floor by the sealed denominator. This
 * reproduces EXACTLY what the live record path would have computed with the corrected
 * linkage (never a floored double). It NEVER mutates the sealed snapshot.
 *
 * Over-mint fences: the seal must be an 'unverifiable', non-fixed-grant, non-suppressed
 * standard row whose sealed linkage multiplier equals the policy's unverifiable value; the
 * corrected multiplier may not exceed 2x the sealed one (beneficiary_linked 20000 vs
 * unverifiable 10000); and the result is hard-capped at 2x+1 of the sealed points.
 */
export function recomputeRecordPointsAtCorrectedLinkage(params: {
  snapshot: RecordEconomicSnapshot;
  correctedLinkageState: LinkageState;
  policy: MonetaryPolicyVersion;
}): { recordPointsAtomic: AtomicUnits; correctedLinkageMultiplierBps: number } {
  const { snapshot, correctedLinkageState, policy } = params;
  const factors = snapshot.recordTimeFactors;
  if (factors.linkageState !== 'unverifiable') {
    throw new Error('recompute_requires_unverifiable_seal');
  }
  if (factors.fixedGrantSource === 'genesis_campaign_reservation') {
    throw new Error('recompute_not_valid_for_fixed_grant');
  }
  if (factors.operationalDispositionOverride?.suppressRecordPoints === true) {
    throw new Error('recompute_not_valid_for_suppressed_points');
  }
  const sealedLinkageBps = BigInt(factors.linkageMultiplierBps);
  if (sealedLinkageBps <= 0n) throw new Error('recompute_invalid_sealed_linkage');
  if (sealedLinkageBps !== BigInt(policy.linkageMultipliersBps.unverifiable)) {
    throw new Error('recompute_sealed_linkage_policy_mismatch');
  }
  const correctedBpsNum = policy.linkageMultipliersBps[correctedLinkageState];
  if (correctedBpsNum === undefined) {
    throw new Error(`recompute_missing_corrected_linkage:${correctedLinkageState}`);
  }
  const correctedBps = BigInt(correctedBpsNum);
  if (correctedBps <= 0n || correctedBps > 2n * sealedLinkageBps) {
    throw new Error('recompute_corrected_linkage_out_of_bounds');
  }
  const numerator = BigInt(snapshot.recordCalculation.numerator);
  const denominator = BigInt(snapshot.recordCalculation.denominator);
  if (denominator <= 0n) throw new Error('recompute_invalid_denominator');
  if (numerator % sealedLinkageBps !== 0n) {
    throw new Error('recompute_numerator_not_linkage_divisible');
  }
  const correctedNumerator = (numerator / sealedLinkageBps) * correctedBps;
  const recomputed = correctedNumerator / denominator;
  const sealed = parseAtomicUnits(snapshot.recordPointsAtomic, 'recordPointsAtomic');
  if (recomputed > 2n * sealed + 1n) {
    throw new Error('recompute_exceeds_over_mint_cap');
  }
  return {
    recordPointsAtomic: atomicUnits(recomputed),
    correctedLinkageMultiplierBps: correctedBpsNum,
  };
}

function resolveEligibilityProjection(
  snapshot: RecordEconomicSnapshot,
  projection: EligibilityProjection | undefined,
): EligibilityProjection {
  if (projection === undefined) {
    return {
      mintDisposition: snapshot.mintDisposition,
      mintReasonCode: snapshot.mintReasonCode,
    };
  }
  assertExactObjectKeys(
    projection,
    ['mintDisposition', 'mintReasonCode'],
    ['resolutionEvidence'],
    'eligibilityProjection',
  );
  assertMintReasonMatchesDisposition(projection.mintDisposition, projection.mintReasonCode);
  const evidenceItems = projection.resolutionEvidence ?? [];
  if (!Array.isArray(evidenceItems)) {
    throw new Error('eligibilityProjection.resolutionEvidence must be an array');
  }
  if (evidenceItems.length > MAX_RESOLUTION_EVIDENCE_ITEMS) {
    throw new Error('Eligibility transition carries too many resolution evidence items');
  }
  for (const evidence of evidenceItems) {
    assertExactObjectKeys(
      evidence,
      [
        'resolutionType',
        'evidenceId',
        'evidenceHash',
        'source',
        'asOf',
        'canonicalEventId',
      ],
      [],
      'resolutionEvidence item',
    );
    if (!RESOLUTION_EVIDENCE_TYPES.includes(evidence.resolutionType)) {
      throw new Error(`Unknown resolution evidence type: ${String(evidence.resolutionType)}`);
    }
    assertNonEmpty(evidence.evidenceId, 'resolutionEvidence.evidenceId');
    if (!SHA256_COMMITMENT.test(evidence.evidenceHash)) {
      throw new Error('resolutionEvidence.evidenceHash must be a SHA-256 commitment');
    }
    assertNonEmpty(evidence.source, 'resolutionEvidence.source');
    assertNonEmpty(evidence.asOf, 'resolutionEvidence.asOf');
    if (evidence.canonicalEventId !== null) {
      assertNonEmpty(evidence.canonicalEventId, 'resolutionEvidence.canonicalEventId');
    }
  }
  if (!canTransitionMintDisposition(snapshot.mintDisposition, projection.mintDisposition)) {
    throw new Error(
      `Invalid mint disposition transition: ${snapshot.mintDisposition} -> ${projection.mintDisposition}`,
    );
  }

  if (snapshot.mintDisposition !== 'eligible' && projection.mintDisposition === 'eligible') {
    const mode = snapshot.recordTimeFactors.evidenceResolutionMode;
    if (mode === 'linked_evidence_pe_only') {
      throw new Error(
        'This record can become mintable only through a separately linked evidence PE',
      );
    }
    if (mode !== 'projection_with_verified_evidence') {
      throw new Error('Record policy does not authorize an eligibility projection');
    }

    if (evidenceItems.length === 0) {
      throw new Error('Eligibility transition requires immutable resolution evidence');
    }
    const requiredTypes = requiredResolutionTypes(snapshot);
    const observedTypes = new Set<ResolutionEvidenceType>();
    for (const evidence of evidenceItems) {
      if (observedTypes.has(evidence.resolutionType)) {
        throw new Error(`Duplicate ${evidence.resolutionType} resolution evidence`);
      }
      observedTypes.add(evidence.resolutionType);
      if (!requiredTypes.has(evidence.resolutionType)) {
        throw new Error(`Unexpected ${evidence.resolutionType} resolution evidence`);
      }
    }
    for (const requiredType of requiredTypes) {
      if (!observedTypes.has(requiredType)) {
        throw new Error(`Eligibility transition requires ${requiredType} resolution evidence`);
      }
    }
    if (snapshot.recordTimeFactors.canonicalEventRequired) {
      const canonicalEvidence = evidenceItems.find((evidence) =>
        evidence.canonicalEventId !== null);
      if (canonicalEvidence === undefined) {
        throw new Error('Eligibility transition requires a canonical event identifier');
      }
      const recordedCanonicalEventId = snapshot.recordTimeFactors.canonicalEventId;
      if (
        recordedCanonicalEventId !== null
        && canonicalEvidence.canonicalEventId !== recordedCanonicalEventId
      ) {
        throw new Error('Resolution evidence does not match the recorded canonical event');
      }
    }
  }
  return projection;
}

type ResolutionEvidenceType = NonNullable<
  EligibilityProjection['resolutionEvidence']
>[number]['resolutionType'];

function requiredResolutionTypes(
  snapshot: RecordEconomicSnapshot,
): Set<ResolutionEvidenceType> {
  const required = new Set<ResolutionEvidenceType>();
  for (const gate of snapshot.recordTimeFactors.unresolvedRecordGates) {
    if (gate === 'evidence' || gate === 'canonical_event') required.add('evidence');
    if (gate === 'registry') required.add('registry');
    if (gate === 'session_lineage') {
      throw new Error('Missing record-time session lineage cannot be resolved at settlement');
    }
  }
  if (required.size === 0) {
    const fallback = resolutionTypeForDisposition(snapshot.mintDisposition);
    if (fallback === null) {
      throw new Error(`No resolution evidence is valid for ${snapshot.mintDisposition}`);
    }
    required.add(fallback);
  }
  return required;
}

function resolutionTypeForDisposition(
  disposition: MintDisposition,
): ResolutionEvidenceType | null {
  switch (disposition) {
    case 'pending_evidence': return 'evidence';
    case 'pending_review': return 'registry';
    case 'pending_cache': return 'cache';
    case 'beneficiary_pending': return 'beneficiary';
    case 'pending_compliance':
    case 'jurisdiction_deferred': return 'jurisdiction';
    case 'eligible':
    case 'record_only':
    case 'ineligible_terminal':
      return null;
  }
}

function validatePolicyWindow(policy: MonetaryPolicyVersion, recordedAtMs: number): void {
  if (policy.schemaVersion !== MONETARY_ACCOUNTING_SCHEMA_VERSION) {
    throw new Error(`Unsupported monetary accounting schema: ${policy.schemaVersion}`);
  }
  assertNonEmpty(policy.policyVersion, 'policyVersion');
  assertSafeInteger(policy.effectiveAtMs, 'effectiveAtMs');
  assertSafeInteger(recordedAtMs, 'recordedAtMs');
  parseAtomicUnits(policy.basePointsAtomic, 'basePointsAtomic');
  for (const state of ['unlinked', 'human_linked', 'beneficiary_linked', 'unverifiable'] as const) {
    const multiplier = policy.linkageMultipliersBps[state];
    if (multiplier === undefined) throw new Error(`Missing linkage multiplier for state: ${state}`);
    assertPositiveBps(multiplier, `linkage multiplier for ${state}`);
  }
  if (policy.evidenceClassBasesBps !== undefined) {
    for (const cls of WITNESS_CLASSES) {
      const base = policy.evidenceClassBasesBps[cls];
      if (base === undefined) throw new Error(`Missing evidence class base for ${cls}`);
      assertNonNegativeBps(base, `evidence class base for ${cls}`);
    }
  }
  if (policy.effectiveUntilMs !== null) {
    assertSafeInteger(policy.effectiveUntilMs, 'effectiveUntilMs');
    if (policy.effectiveUntilMs <= policy.effectiveAtMs) {
      throw new Error('Policy effectiveUntilMs must be after effectiveAtMs');
    }
  }
  if (recordedAtMs < policy.effectiveAtMs) {
    throw new Error('Policy version is not yet effective at record time');
  }
  if (policy.effectiveUntilMs !== null && recordedAtMs >= policy.effectiveUntilMs) {
    throw new Error('Policy version is no longer effective at record time');
  }
}

function validateRecordInput(input: RecordCalculationInput): void {
  assertNonEmpty(input.peId, 'peId');
  assertNonEmpty(input.economicActorId, 'economicActorId');
  assertNonEmpty(input.actionType, 'actionType');
  assertPositiveOrdinal(input.occurrenceOrdinal, 'occurrenceOrdinal');
  assertPositiveOrdinal(input.dailyOrdinal, 'dailyOrdinal');
  assertNonEmpty(input.attestationTier, 'attestationTier');
  assertBoolean(input.exactDuplicate, 'exactDuplicate');
  assertBoolean(input.uniqueArtifact, 'uniqueArtifact');
  if (!isEvidenceState(input.evidenceState)) {
    throw new Error('evidenceState is not a recognized state');
  }
  if (!isLinkageState(input.linkageState)) {
    throw new Error('linkageState is not a recognized state');
  }
  if (input.canonicalEventId !== null) assertNonEmpty(input.canonicalEventId, 'canonicalEventId');
  assertBoolean(input.selfReferencing, 'selfReferencing');
  assertBoolean(input.sharedBeneficialOwnership, 'sharedBeneficialOwnership');
  assertBoolean(input.pairChurnDetected, 'pairChurnDetected');
  if (input.sessionLineageId !== null) assertNonEmpty(input.sessionLineageId, 'sessionLineageId');
  if (input.genesisReservation !== null && typeof input.genesisReservation !== 'object') {
    throw new Error('genesisReservation must be an object or null');
  }
  if (input.operationalDispositionOverride !== undefined
    && input.operationalDispositionOverride !== null
    && (typeof input.operationalDispositionOverride !== 'object'
      || typeof input.operationalDispositionOverride.suppressRecordPoints !== 'boolean')) {
    throw new Error('operationalDispositionOverride is invalid');
  }
  if (input.beneficiaryAgentShareBps !== undefined
    && input.beneficiaryAgentShareBps !== null
    && (!Number.isSafeInteger(input.beneficiaryAgentShareBps)
      || input.beneficiaryAgentShareBps < 0
      || input.beneficiaryAgentShareBps > BPS_DENOMINATOR)) {
    throw new Error('beneficiaryAgentShareBps is invalid');
  }
}

function validateGenesisReservationReceipt(
  receipt: GenesisReservationLedgerEntry,
  peId: string,
  economicActorId: string,
  recordedAtMs: number,
  actionType: string,
  canonicalEventGroup: string | null,
): void {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('Genesis reservation receipt is invalid');
  }
  if (!isAuthenticGenesisReservationReceipt(receipt)) {
    throw new Error('Genesis reservation receipt was not issued by the reservation kernel');
  }
  for (const [label, value] of [
    ['reservation_id', receipt.reservation_id],
    ['dedupe_key', receipt.dedupe_key],
    ['policy_version', receipt.policy_version],
    ['canonical_pvt_manifest_id', receipt.canonical_pvt_manifest_id],
    ['canonical_bounty_key', receipt.canonical_bounty_key],
    ['emitted_action_type', receipt.emitted_action_type],
    ['pe_id', receipt.pe_id],
    ['wallet_id', receipt.wallet_id],
    ['economic_actor_id', receipt.economic_actor_id],
    ['immutable_anchor_kind', receipt.immutable_anchor_kind],
    ['immutable_anchor_id', receipt.immutable_anchor_id],
    ['evidence_id', receipt.evidence_id],
    ['evidence_hash', receipt.evidence_hash],
  ] as const) {
    assertNonEmpty(value, `genesisReservation.${label}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(receipt.policy_manifest_hash)) {
    throw new Error('genesisReservation.policy_manifest_hash is invalid');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(receipt.evidence_hash)) {
    throw new Error('genesisReservation.evidence_hash is invalid');
  }
  if (receipt.emitted_action_type !== actionType) {
    throw new Error('Genesis reservation action does not match the PE action');
  }
  if (receipt.pe_id !== peId) {
    throw new Error('Genesis reservation is bound to a different PE');
  }
  if (receipt.economic_actor_id !== economicActorId) {
    throw new Error('Genesis reservation is bound to a different economic actor');
  }
  const groupPrefix = 'genesis_campaign_reservation:';
  if (
    canonicalEventGroup === null
    || !canonicalEventGroup.startsWith(groupPrefix)
    || receipt.canonical_bounty_key !== canonicalEventGroup.slice(groupPrefix.length)
  ) {
    throw new Error('Genesis reservation bounty does not match the record policy');
  }
  const fixed = parseAtomicUnits(
    receipt.fixed_grant_atomic as AtomicUnits,
    'genesisReservation.fixed_grant_atomic',
  );
  const reserved = parseAtomicUnits(
    receipt.reserved_atomic as AtomicUnits,
    'genesisReservation.reserved_atomic',
  );
  if (reserved <= 0n || reserved > fixed) {
    throw new Error('Genesis reservation amount is outside its fixed-grant bound');
  }
  if (
    !CANONICAL_UNSIGNED_INTEGER.test(receipt.state_revision_before)
    || !CANONICAL_UNSIGNED_INTEGER.test(receipt.state_revision_after)
    || BigInt(receipt.state_revision_after) !== BigInt(receipt.state_revision_before) + 1n
  ) {
    throw new Error('Genesis reservation revision proof is invalid');
  }
  assertSafeInteger(receipt.qualifying_act_at_ms, 'genesisReservation.qualifying_act_at_ms');
  assertSafeInteger(receipt.reserved_at_ms, 'genesisReservation.reserved_at_ms');
  assertNonNegativeBps(receipt.decay_multiplier_bps, 'genesisReservation.decay_multiplier_bps');
  if (
    receipt.decay_multiplier_bps > BPS_DENOMINATOR
    || receipt.reserved_at_ms < receipt.qualifying_act_at_ms
    || receipt.reserved_at_ms > recordedAtMs
  ) {
    throw new Error('Genesis reservation timing or decay proof is invalid');
  }
}

function validateActionPolicy(action: ActionMonetaryPolicy, actionType: string): void {
  assertNonEmpty(action.category, `category for ${actionType}`);
  assertNonNegativeBps(action.baseWeightBps, `baseWeightBps for ${actionType}`);
  if (action.policyOverrideBps !== null) {
    assertNonNegativeBps(action.policyOverrideBps, `policyOverrideBps for ${actionType}`);
  }
  assertMintReasonMatchesDisposition(action.mintDisposition, action.mintReasonCode);
  if (!isActionEvidenceRequirement(action.evidenceRequirement)) {
    throw new Error(`Invalid evidence requirement for ${actionType}`);
  }
  assertNonEmpty(action.canonicalEventGroup, `canonicalEventGroup for ${actionType}`);
  assertBoolean(action.canonicalEventRequired, `canonicalEventRequired for ${actionType}`);
  if (
    action.beneficialOwnershipPolicy !== 'record_only_if_self_shared_or_churn'
    && action.beneficialOwnershipPolicy !== 'not_applicable'
  ) {
    throw new Error(`Invalid beneficial ownership policy for ${actionType}`);
  }
  if (
    action.sessionLineagePolicy !== 'required'
    && action.sessionLineagePolicy !== 'optional'
    && action.sessionLineagePolicy !== 'not_applicable'
  ) {
    throw new Error(`Invalid session lineage policy for ${actionType}`);
  }
  if (action.fixedGrantSource !== 'none' && action.fixedGrantSource !== 'genesis_campaign_reservation') {
    throw new Error(`Invalid fixed grant source for ${actionType}`);
  }
  if (action.financialAttestationNeutral && action.allowVerifiedAttestationUpgrade) {
    throw new Error(`Attestation-neutral action cannot authorize an upgrade for ${actionType}`);
  }
  if (
    action.financialAttestationNeutral
    && action.evidenceRequirement !== 'base_final_chain_receipt'
    && action.evidenceRequirement !== 'verified_institution_lifecycle'
    // : a chain/relay-witnessed CLASS admission is neutral like the families it
    // was derived from; the witness class is its independent evidence.
    && action.evidenceRequirement !== 'verified_witness_class'
    // TIGHTENED the 3b carve-outs back OUT of this list:
    // `verified_external_service_witness` and `verified_compute_or_work` are no
    // longer neutral-compatible evidence classes. The webhook/binding proves
    // the claim is AUTHENTIC, not that the work cost anything to fabricate —
    // those families now price on the evidence-priced attestation table, and a
    // future edit quietly re-neutralizing them must throw here.
    // Exact Genesis grants are independently bound to a module-authenticated
    // reservation receipt and always use a neutral 10,000-BPS multiplier.
    && action.fixedGrantSource !== 'genesis_campaign_reservation'
    // The server-authored, device-rate-limited wallet birth certificate is the
    // one explicit standard-policy exception. Its fixed ~10 PVT base record is
    // intentionally independent of hardware depth and distinct from Genesis.
    && actionType !== 'wallet_created'
  ) {
    throw new Error(`Attestation-neutral action lacks independent settlement evidence for ${actionType}`);
  }
  if (
    action.attestationPricing !== undefined
    && action.attestationPricing !== 'standard'
    && action.attestationPricing !== 'external_proof_priced'
  ) {
    throw new Error(`Invalid attestation pricing for ${actionType}`);
  }
  if (action.attestationPricing === 'external_proof_priced') {
    // Contradiction guards (, retained under). Neutrality bypasses
    // tier selection entirely, so a neutral external_proof_priced row is a gate
    // that can never fire. These families price at RECORD time (the
    // self-attested tier earns a discount, proof is a record-time lift), so a
    // settlement-time verified-attestation upgrade is not authorized for them —
    // matching the matrix, where every gated row carries upgrade=false. The
    // class is approved for exactly the two evidence families — extending it is a
    // policy act, not a code default.
    if (action.financialAttestationNeutral) {
      throw new Error(`External-proof-priced action cannot be attestation-neutral for ${actionType}`);
    }
    if (action.allowVerifiedAttestationUpgrade) {
      throw new Error(`External-proof-priced action cannot authorize an upgrade for ${actionType}`);
    }
    if (
      action.evidenceRequirement !== 'verified_compute_or_work'
      && action.evidenceRequirement !== 'verified_external_service_witness'
      // /§2.9: a hardware-rooted witness is external proof by definition.
      && action.evidenceRequirement !== 'verified_witness_class'
    ) {
      throw new Error(`External-proof pricing is not approved for this evidence class: ${actionType}`);
    }
    if (action.fixedGrantSource !== 'none') {
      throw new Error(`External-proof pricing cannot apply to a fixed grant: ${actionType}`);
    }
  }
  if (
    action.evidenceResolutionMode !== 'projection_with_verified_evidence'
    && action.evidenceResolutionMode !== 'linked_evidence_pe_only'
    && action.evidenceResolutionMode !== 'not_applicable'
  ) {
    throw new Error(`Invalid evidence resolution mode for ${actionType}`);
  }
  if (
    action.mintDisposition === 'pending_evidence'
    && action.evidenceResolutionMode === 'not_applicable'
  ) {
    throw new Error(`Pending-evidence policy needs an explicit resolution mode for ${actionType}`);
  }
  if (action.fixedGrantSource === 'genesis_campaign_reservation') {
    if (action.evidenceRequirement !== 'valid_genesis_reservation') {
      throw new Error(`Genesis fixed grant requires reservation evidence for ${actionType}`);
    }
    if (
      !action.financialAttestationNeutral
      || !action.canonicalEventRequired
      || action.allowVerifiedAttestationUpgrade
    ) {
      throw new Error(`Genesis fixed grant policy is not economically isolated for ${actionType}`);
    }
    if (action.evidenceResolutionMode !== 'linked_evidence_pe_only') {
      throw new Error(`Genesis fixed grant cannot resolve in place for ${actionType}`);
    }
    if (!action.canonicalEventGroup.startsWith('genesis_campaign_reservation:')) {
      throw new Error(`Genesis fixed grant lacks a canonical bounty binding for ${actionType}`);
    }
  }
  const allowedReviewReasons = POLICY_REVIEW_REASON_CODES_BY_STATE[action.policyReviewState];
  if (!allowedReviewReasons.includes(action.policyReviewReasonCode)) {
    throw new Error(
      `Policy review reason ${action.policyReviewReasonCode} is invalid for ${action.policyReviewState}`,
    );
  }
}

function validateSnapshot(snapshot: RecordEconomicSnapshot): void {
  // PIECE 5: v1 (unmultiplied) AND v2 (origin-priced) snapshots both validate; the reconciliation
  // below re-derives each under ITS OWN formula, so a sealed v1 row is never repriced by the v2 fold.
  if (!SUPPORTED_MONETARY_ACCOUNTING_SCHEMA_VERSIONS.includes(snapshot.schemaVersion)) {
    throw new Error(`Unsupported record snapshot schema: ${snapshot.schemaVersion}`);
  }
  assertNonEmpty(snapshot.policyVersion, 'snapshot policyVersion');
  assertNonEmpty(snapshot.peId, 'snapshot peId');
  assertNonEmpty(snapshot.economicActorId, 'snapshot economicActorId');
  assertNonEmpty(snapshot.actionType, 'snapshot actionType');
  assertSafeInteger(snapshot.policyEffectiveAtMs, 'snapshot policyEffectiveAtMs');
  assertSafeInteger(snapshot.recordedAtMs, 'snapshot recordedAtMs');
  if (snapshot.recordedAtMs < snapshot.policyEffectiveAtMs) {
    throw new Error('Snapshot record time precedes its policy version');
  }
  if (snapshot.policyEffectiveUntilMs !== null) {
    assertSafeInteger(snapshot.policyEffectiveUntilMs, 'snapshot policyEffectiveUntilMs');
    if (
      snapshot.policyEffectiveUntilMs <= snapshot.policyEffectiveAtMs
      || snapshot.recordedAtMs >= snapshot.policyEffectiveUntilMs
    ) {
      throw new Error('Snapshot record time is outside its policy window');
    }
  }
  assertMintReasonMatchesDisposition(snapshot.mintDisposition, snapshot.mintReasonCode);
  if (!POLICY_REVIEW_STATES.includes(snapshot.policyReviewState)) {
    throw new Error(`Unknown policy review state: ${snapshot.policyReviewState}`);
  }
  const allowedReviewReasons = POLICY_REVIEW_REASON_CODES_BY_STATE[snapshot.policyReviewState];
  if (!allowedReviewReasons.includes(snapshot.policyReviewReasonCode)) {
    throw new Error(
      `Policy review reason ${snapshot.policyReviewReasonCode} is invalid for ${snapshot.policyReviewState}`,
    );
  }

  const factors = snapshot.recordTimeFactors;
  const basePoints = parseAtomicUnits(factors.basePointsAtomic, 'snapshot basePointsAtomic');
  if (factors.category !== null) assertNonEmpty(factors.category, 'snapshot category');
  assertNonNegativeBps(factors.baseActionWeightBps, 'snapshot baseActionWeightBps');
  if (factors.policyOverrideBps !== null) {
    assertNonNegativeBps(factors.policyOverrideBps, 'snapshot policyOverrideBps');
  }
  const expectedEffectiveWeight = factors.policyOverrideBps ?? factors.baseActionWeightBps;
  if (factors.effectiveActionWeightBps !== expectedEffectiveWeight) {
    throw new Error('Snapshot effective action weight is inconsistent');
  }
  assertPositiveOrdinal(factors.occurrenceOrdinal, 'snapshot occurrenceOrdinal');
  assertBoolean(factors.exactDuplicate, 'snapshot exactDuplicate');
  assertBoolean(factors.uniqueArtifact, 'snapshot uniqueArtifact');
  if (factors.noveltyBps !== noveltyBps(factors)) {
    throw new Error('Snapshot novelty factor is inconsistent');
  }
  assertPositiveOrdinal(factors.dailyOrdinal, 'snapshot dailyOrdinal');
  // new rows seal the constant; rows sealed under the superseded curve
  // re-derive under it (sealed history is never repriced — and never wedged,
  // the defect class closed for Genesis). Exactly these two values are
  // acceptable; anything else is a forgery.
  if (
    factors.dailyDiminishingBps !== dailyDiminishingBps(factors.dailyOrdinal)
    && factors.dailyDiminishingBps !== supersededDailyDiminishingBps(factors.dailyOrdinal)
  ) {
    throw new Error('Snapshot daily diminishing factor is inconsistent');
  }
  assertNonEmpty(factors.attestationTier, 'snapshot attestationTier');
  // Pre- -era sealed evidence-priced tables can legitimately carry 0
  // entries ('s evidence floor). live seals are all-positive, and
  // pre- seals are all-positive too; all validate unchanged. `allowZero`
  // stays so the -era 0-priced seals in history still validate here.
  const attestationTable = cloneAndValidateAttestationTable(
    factors.attestationMultipliersAtRecordPolicyBps,
    { allowZero: true },
  );
  const selectedAttestation = attestationTable[factors.attestationTier];
  if (selectedAttestation === undefined) {
    throw new Error('Snapshot attestation tier is absent from its record policy table');
  }
  if (
    factors.attestationPricing !== undefined
    && factors.attestationPricing !== 'standard'
    && factors.attestationPricing !== 'external_proof_priced'
  ) {
    throw new Error('Snapshot attestation pricing is invalid');
  }
  if (
    factors.attestationPricing === 'external_proof_priced'
    && factors.fixedGrantSource === 'none'
    && selectedAttestation === 0
    && snapshot.mintDisposition !== 'record_only'
    && snapshot.mintDisposition !== 'ineligible_terminal'
  ) {
    // A pre- -era 0-priced external-proof snapshot is terminal by
    // construction: a 0-priced record claiming a payable disposition is a
    // forgery. (live seals carry no 0 tier, so this never fires for them.)
    throw new Error('Zero-priced external-proof snapshot must seal a terminal disposition');
  }
  assertBoolean(factors.financialAttestationNeutral, 'snapshot financialAttestationNeutral');
  if (!isLinkageState(factors.linkageState)) {
    throw new Error('Snapshot linkage state is invalid');
  }
  assertPositiveBps(factors.linkageMultiplierBps, 'snapshot linkage multiplier');
  assertNonNegativeBps(factors.beneficiaryAgentShareBps, 'snapshot beneficiary agent share');
  if (factors.beneficiaryAgentShareBps > BPS_DENOMINATOR) {
    throw new Error('Snapshot beneficiary agent share exceeds 10000 bps');
  }
  if (factors.operationalDispositionOverride !== null) {
    assertMintReasonMatchesDisposition(
      factors.operationalDispositionOverride.mintDisposition,
      factors.operationalDispositionOverride.mintReasonCode,
    );
    assertBoolean(
      factors.operationalDispositionOverride.suppressRecordPoints,
      'snapshot operational suppression flag',
    );
  }
  if (!isEvidenceState(factors.evidenceState)) {
    throw new Error('Snapshot evidence state is invalid');
  }
  if (!isActionEvidenceRequirement(factors.evidenceRequirement)) {
    throw new Error('Snapshot evidence requirement is invalid');
  }
  if (factors.canonicalEventId !== null) {
    assertNonEmpty(factors.canonicalEventId, 'snapshot canonicalEventId');
  }
  assertBoolean(factors.canonicalEventRequired, 'snapshot canonicalEventRequired');
  if (factors.canonicalEventGroup !== null) {
    assertNonEmpty(factors.canonicalEventGroup, 'snapshot canonicalEventGroup');
  }
  assertBoolean(factors.selfReferencing, 'snapshot selfReferencing');
  assertBoolean(factors.sharedBeneficialOwnership, 'snapshot sharedBeneficialOwnership');
  assertBoolean(factors.pairChurnDetected, 'snapshot pairChurnDetected');
  if (
    factors.beneficialOwnershipPolicy !== null
    && factors.beneficialOwnershipPolicy !== 'record_only_if_self_shared_or_churn'
    && factors.beneficialOwnershipPolicy !== 'not_applicable'
  ) throw new Error('Snapshot beneficial-ownership policy is invalid');
  if (factors.sessionLineageId !== null) {
    assertNonEmpty(factors.sessionLineageId, 'snapshot sessionLineageId');
  }
  if (
    factors.sessionLineagePolicy !== null
    && factors.sessionLineagePolicy !== 'required'
    && factors.sessionLineagePolicy !== 'optional'
    && factors.sessionLineagePolicy !== 'not_applicable'
  ) throw new Error('Snapshot session-lineage policy is invalid');
  if (
    factors.evidenceResolutionMode !== null
    && factors.evidenceResolutionMode !== 'projection_with_verified_evidence'
    && factors.evidenceResolutionMode !== 'linked_evidence_pe_only'
    && factors.evidenceResolutionMode !== 'not_applicable'
  ) throw new Error('Snapshot evidence-resolution mode is invalid');

  const unresolved = new Set<UnresolvedRecordGate>();
  for (const gate of factors.unresolvedRecordGates) {
    if (!['evidence', 'canonical_event', 'registry', 'session_lineage'].includes(gate)) {
      throw new Error(`Snapshot contains an unknown unresolved gate: ${gate}`);
    }
    if (unresolved.has(gate)) throw new Error(`Snapshot repeats unresolved gate: ${gate}`);
    unresolved.add(gate);
  }

  assertBoolean(
    snapshot.allowedSettlementAdjustments.verifiedAttestationUpgrade,
    'snapshot verifiedAttestationUpgrade',
  );
  assertBoolean(snapshot.allowedSettlementAdjustments.globalMintRate, 'snapshot globalMintRate');
  // Legacy sealed snapshots may still carry a `supplyScaler` adjustment flag.
  // It is intentionally not asserted or read: parity minting has no scaler, and
  // hashing is byte-exact per record, so old and new snapshots both validate.

  const fixedGrant = factors.fixedGrantSource === 'genesis_campaign_reservation';
  if (!fixedGrant && factors.fixedGrantSource !== 'none') {
    throw new Error('Snapshot fixed-grant source is invalid');
  }
  let expectedNumerator: bigint;
  let expectedDenominator: bigint;
  if (fixedGrant) {
    if (
      factors.fixedGrantAtomic === null
      || factors.genesisReservationId === null
      || factors.genesisPolicyManifestHash === null
      || factors.genesisCanonicalBountyKey === null
      || factors.genesisDedupeKey === null
      || factors.genesisStateRevisionAfter === null
    ) throw new Error('Genesis snapshot is missing reservation metadata');
    const fixed = parseAtomicUnits(factors.fixedGrantAtomic, 'snapshot fixedGrantAtomic');
    for (const [label, value] of [
      ['genesisReservationId', factors.genesisReservationId],
      ['genesisCanonicalBountyKey', factors.genesisCanonicalBountyKey],
      ['genesisDedupeKey', factors.genesisDedupeKey],
    ] as const) assertNonEmpty(value, `snapshot ${label}`);
    if (!SHA256_COMMITMENT.test(factors.genesisPolicyManifestHash)) {
      throw new Error('Genesis snapshot manifest commitment is invalid');
    }
    if (!CANONICAL_UNSIGNED_INTEGER.test(factors.genesisStateRevisionAfter)) {
      throw new Error('Genesis snapshot revision is invalid');
    }
    if (
      !factors.financialAttestationNeutral
      || factors.attestationMultiplierBps !== BPS_DENOMINATOR
      || factors.linkageMultiplierBps !== BPS_DENOMINATOR
      || factors.beneficiaryAgentShareBps !== BPS_DENOMINATOR
      || snapshot.allowedSettlementAdjustments.verifiedAttestationUpgrade
      || snapshot.allowedSettlementAdjustments.globalMintRate
    ) throw new Error('Genesis snapshot permits an unauthorized economic adjustment');
    expectedNumerator = factors.exactDuplicate ? 0n : fixed;
    expectedDenominator = 1n;
  } else {
    if (
      factors.fixedGrantAtomic !== null
      || factors.genesisReservationId !== null
      || factors.genesisPolicyManifestHash !== null
      || factors.genesisCanonicalBountyKey !== null
      || factors.genesisDedupeKey !== null
      || factors.genesisStateRevisionAfter !== null
    ) throw new Error('Non-Genesis snapshot carries Genesis reservation metadata');
    const expectedAttestation = factors.financialAttestationNeutral
      ? BPS_DENOMINATOR
      : selectedAttestation;
    if (factors.attestationMultiplierBps !== expectedAttestation) {
      throw new Error('Snapshot attestation multiplier is inconsistent');
    }
    if (!snapshot.allowedSettlementAdjustments.globalMintRate
      || (factors.financialAttestationNeutral
        && snapshot.allowedSettlementAdjustments.verifiedAttestationUpgrade)) {
      throw new Error('Snapshot settlement-adjustment flags are inconsistent');
    }
    // PIECE 5: re-derive under the snapshot's OWN formula version. A `v2` (origin-priced) seal folds
    // the two multipliers from its sealed count/tokens; a `v1` seal uses neither (multiplier = 1,
    // denominator = BPS^5) — so a pieces-1–4 `v1` row that carries a non-zero
    // `independentOriginCount` is STILL reconciled unmultiplied, exactly as it was sealed, and never
    // repriced. This is the byte-exact mirror of `computeRecordSnapshot`; the two MUST move together.
    const isV2 = snapshot.schemaVersion === MONETARY_ACCOUNTING_SCHEMA_VERSION_V2;
    const hasIndependence = snapshot.schemaVersion !== MONETARY_ACCOUNTING_SCHEMA_VERSION_V1;
    const independenceMultiplierNumerator = hasIndependence
      ? BigInt(BPS_DENOMINATOR)
        + BigInt(INDEPENDENCE_PER_ORIGIN_BPS) * BigInt(normalizeMoneyLayerCount(factors.independentOriginCount))
      : 1n;
    const volumeMultiplierNumerator = isV2
      ? BigInt(LEGACY_V2_VOLUME_TOKENS_DENOMINATOR) + BigInt(normalizeMoneyLayerCount(factors.observedComputeTokens))
      : 1n;
    expectedNumerator = factors.operationalDispositionOverride?.suppressRecordPoints === true
      ? 0n
      : basePoints
      * BigInt(factors.effectiveActionWeightBps)
      * BigInt(factors.noveltyBps)
      * BigInt(factors.dailyDiminishingBps)
      * BigInt(factors.linkageMultiplierBps)
      * BigInt(factors.attestationMultiplierBps)
      * independenceMultiplierNumerator
      * volumeMultiplierNumerator;
    expectedDenominator = isV2
      ? BigInt(BPS_DENOMINATOR) ** 5n * BigInt(BPS_DENOMINATOR) * BigInt(LEGACY_V2_VOLUME_TOKENS_DENOMINATOR)
      : BigInt(BPS_DENOMINATOR) ** (hasIndependence ? 6n : 5n);
  }

  const expectedPoints = expectedNumerator / expectedDenominator;
  const expectedRemainder = expectedNumerator % expectedDenominator;
  const points = parseAtomicUnits(snapshot.recordPointsAtomic, 'recordPointsAtomic');
  const calculationNumerator = parseUnsignedInteger(
    snapshot.recordCalculation.numerator,
    'recordCalculation.numerator',
  );
  const calculationDenominator = parseUnsignedInteger(
    snapshot.recordCalculation.denominator,
    'recordCalculation.denominator',
  );
  const calculationRemainder = parseUnsignedInteger(
    snapshot.recordCalculation.floorRemainder,
    'recordCalculation.floorRemainder',
  );
  if (
    points !== expectedPoints
    || calculationNumerator !== expectedNumerator
    || calculationDenominator !== expectedDenominator
    || calculationRemainder !== expectedRemainder
  ) throw new Error('Record snapshot calculation does not reconcile');
}

function assertMintReasonMatchesDisposition(
  disposition: MintDisposition,
  reasonCode: MintReasonCode,
): void {
  if (!MINT_DISPOSITIONS.includes(disposition)) {
    throw new Error(`Unknown mint disposition: ${disposition}`);
  }
  if (!MINT_REASON_CODES_BY_DISPOSITION[disposition].includes(reasonCode)) {
    throw new Error(`Mint reason ${reasonCode} is invalid for disposition ${disposition}`);
  }
}

function cloneAndValidateAttestationTable(
  table: Readonly<Record<string, number>>,
  // zero entries are legal only in the evidence-priced table (and in a
  // sealed snapshot's copy of it) — a 0 is the evidence floor, never a typo in
  // the standard ladder. At least one tier must stay positive either way; a
  // table that can price nothing is a misconfiguration, not a policy.
  options: { readonly allowZero?: boolean } = {},
): Readonly<Record<string, number>> {
  const clone: Record<string, number> = {};
  const tiers = Object.keys(table).sort();
  if (tiers.length === 0) throw new Error('Attestation multiplier table cannot be empty');
  let positiveTiers = 0;
  for (const tier of tiers) {
    assertNonEmpty(tier, 'attestation tier');
    const multiplier = table[tier];
    if (options.allowZero === true) {
      assertNonNegativeBps(multiplier, `attestation multiplier for ${tier}`);
    } else {
      assertPositiveBps(multiplier, `attestation multiplier for ${tier}`);
    }
    if (multiplier > 0) positiveTiers += 1;
    clone[tier] = multiplier;
  }
  if (positiveTiers === 0) {
    throw new Error('Attestation multiplier table must price at least one tier above zero');
  }
  return Object.freeze(clone);
}

function cloneAndValidateFactor(
  factor: DisclosedRationalFactor,
  label: string,
): DisclosedRationalFactor {
  try {
    return disclosedRationalFactor(
      factor.numerator,
      factor.denominator,
      factor.source,
      factor.asOf,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is invalid: ${detail}`);
  }
}

function exactCalculation(
  numerator: bigint,
  denominator: bigint,
  floorRemainder: bigint,
): ExactIntegerCalculation {
  return Object.freeze({
    numerator: unsignedInteger(numerator),
    denominator: unsignedInteger(denominator),
    floorRemainder: unsignedInteger(floorRemainder),
  });
}

function parseAtomicUnits(value: AtomicUnits, label: string): bigint {
  if (!CANONICAL_UNSIGNED_INTEGER.test(value)) {
    throw new Error(`${label} must be a canonical non-negative integer string`);
  }
  return BigInt(value);
}

function parseUnsignedInteger(value: UnsignedInteger, label: string): bigint {
  if (!CANONICAL_UNSIGNED_INTEGER.test(value)) {
    throw new Error(`${label} must be a canonical non-negative integer string`);
  }
  return BigInt(value);
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertExactObjectKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label} is missing required field: ${key}`);
    }
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
}

function assertBoolean(value: boolean, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
}

function isActionEvidenceRequirement(value: unknown): value is ActionEvidenceRequirement {
  return value === 'none'
    || value === 'base_final_chain_receipt'
    || value === 'valid_genesis_reservation'
    || value === 'verified_institution_lifecycle'
    || value === 'verified_substantive_outcome'
    || value === 'verified_compute_or_work'
    || value === 'verified_external_service_witness'
    || value === 'verified_witness_class'
    || value === 'operator_policy_review';
}

function isEvidenceState(value: unknown): value is EvidenceState {
  return value === 'not_required'
    || value === 'pending'
    || value === 'verified'
    || value === 'rejected'
    || value === 'unverifiable';
}

function isLinkageState(value: unknown): value is LinkageState {
  return value === 'unlinked'
    || value === 'human_linked'
    || value === 'beneficiary_linked'
    || value === 'unverifiable';
}

function assertPositiveOrdinal(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value < 1) throw new Error(`${label} must be one-based and positive`);
}

function assertNonNegativeBps(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value < 0) throw new Error(`${label} must be non-negative integer basis points`);
}

function assertPositiveBps(value: number, label: string): void {
  assertNonNegativeBps(value, label);
  if (value === 0) throw new Error(`${label} must be greater than zero`);
}

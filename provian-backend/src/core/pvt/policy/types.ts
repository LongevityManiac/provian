/**
 * atomic accounting policy proposal types.
 *
 * These types are deliberately isolated from the live accrual path. Gate 1
 * policy approval does not itself supply an effective time, launch dates, or
 * the later cryptographic activation evidence required by runtime consumers.
 */

import type {
  ActionEvidenceRequirement,
  AttestationPricing,
  BeneficialOwnershipPolicy,
  EvidenceResolutionMode,
  MintDisposition,
  SessionLineagePolicy,
} from './monetary-accounting';

export type {
  ActionEvidenceRequirement,
  AttestationPricing,
  BeneficialOwnershipPolicy,
  EvidenceResolutionMode,
  MintDisposition,
  PolicyReviewState,
  SessionLineagePolicy,
} from './monetary-accounting';

export type ProposalStatus =
  | 'gate_1_plain_english_approved'
  | 'requires_frank_approval';

export const ACTION_POLICY_CATEGORIES = [
  'financial',
  'compute',
  'social',
  'governance',
  'security',
  'institutional',
  'infrastructure',
  'uncategorized',
] as const;

export type ActionPolicyCategory = (typeof ACTION_POLICY_CATEGORIES)[number];

export const ACTION_POLICY_REASON_CODES = [
  'VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT',
  'GENESIS_VALID_RESERVATION_FIXED_GRANT',
  'STANDARD_WALLET_BIRTH_CERTIFICATE',
  'VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT',
  'VERIFIED_SUBSTANTIVE_OUTCOME',
  'VERIFIED_EXTERNAL_SERVICE_OUTCOME',
  'RELAY_DRAFT_AWAITS_INDEPENDENT_EVIDENCE',
  'WORK_OR_COMPUTE_AWAITS_VERIFICATION',
  // verified sovereign agent-work — the earning agent's own-key binding
  // over a specific occurrence IS the evidence (attestation-neutral, no
  // session-lineage gate). Distinct from WORK_OR_COMPUTE_AWAITS_VERIFICATION,
  // which is the still-pending (record_only) draft state.
  'VERIFIED_SOVEREIGN_AGENT_WORK',
  'NON_POLICY_REGISTRY_REVIEW_REQUIRED',
  'SYSTEM_BOOKKEEPING_NON_CIRCULAR',
  'PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR',
  'DENIAL_FAILURE_EXPIRY_OR_NOOP',
  'SECURITY_POLICY_OR_IDENTITY_RECORD',
  'SETTLEMENT_SIGNAL_APPLIES_TO_TARGET',
  // `RETIRED_GENESIS_ACTION_UNARMED` was removed with the six retired
  // Genesis-ladder rows it classified (agent/wallet funded/first-transaction/
  // sustained-activity). No entry uses it any longer.
  'INSUFFICIENT_LAUNCH_JUSTIFICATION_RECORD_ONLY',
  // F-A7 : the 31 relay-DRAFT institution-lifecycle types
  // (escrow_created, job_posted, promise_created/offered/accepted, transfer,
  // purchase, spending, proxied_payment_*, onramp, agent_marketplace, …) are
  // pre-value, self-reported drafts with NO sound independent settlement
  // verifier of their own — the value for these acts mints on the
  // funding/completion watcher (escrow_funded/completed, promise_funded/settled,
  // pool_contributed/executed) or the on-chain event, NEVER on the draft.
  // Promoting a draft on the relay's say-so would mint on self-report — the
  // farming vector `pending-evidence-resolver.ts` refuses as
  // `refused_promotion_would_create_mint_authority`. So they are record_only, not
  // "pending" a linked-evidence emitter that soundly cannot exist for them. This
  // replaces the earlier `RELAY_DRAFT_AWAITS_INDEPENDENT_EVIDENCE` framing for
  // these rows; that reason code stays for the resolver machinery + old sealed
  // rows. Moves the matrix + monetary template digest (one re-pin, one SSHSIG).
  'RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY',
] as const;

export type ActionPolicyReasonCode = (typeof ACTION_POLICY_REASON_CODES)[number];

export const POLICY_REJECTION_REASON_CODES = [
  'duplicate_of_existing_type',
  'semantic_collision',
  'insufficient_evidence_model',
  'prohibited_circular_reward',
  'rejected_by_policy_authority',
] as const;

export type PolicyRejectionReasonCode = (typeof POLICY_REJECTION_REASON_CODES)[number];

export interface ProposedActionPolicyEntry {
  readonly action_type: string;
  readonly category: ActionPolicyCategory;
  readonly base_action_weight_bps: number;
  readonly policy_override_bps: null;
  readonly mint_disposition: MintDisposition;
  readonly policy_review_state: 'not_required';
  readonly reason_code: ActionPolicyReasonCode;
  readonly evidence_requirement: ActionEvidenceRequirement;
  readonly financial_attestation_neutral: boolean;
  /**
   * which attestation table prices this action. 'standard' reads the
   * ladder table; 'external_proof_priced' reads the evidence-priced table,
   * where self-attested tiers (software / software_verified / social) are 0
   * and externally-proven tiers (hardware*, TEE, corroborated) stay at the
   * family's flat 1.0x — an unproven claim of work is an assertion, not proof.
   */
  readonly attestation_pricing: AttestationPricing;
  readonly allow_verified_attestation_upgrade: boolean;
  readonly canonical_event_required: boolean;
  readonly canonical_event_group: string;
  readonly beneficial_ownership_policy: BeneficialOwnershipPolicy;
  readonly session_lineage_policy: SessionLineagePolicy;
  readonly linkage_treatment:
    | 'record_time_verified_policy_multiplier'
    | 'genesis_contributor_only_no_linked_beneficiary_routing'
    | 'none_record_only';
  /** Financial and institution rewards are act-based, never value-sized. */
  readonly amount_independent: boolean;
  /** Genesis is the only fixed-grant exception in this launch proposal. */
  readonly fixed_grant_source: 'none' | 'genesis_campaign_reservation';
  /** Whether a held PE may resolve in-place or needs a distinct evidence PE. */
  readonly evidence_resolution_mode: EvidenceResolutionMode;
}

export interface ProposedActionPolicyManifest {
  readonly schema_version: 'pvt-action-policy/v1';
  readonly policy_version: string;
  readonly status: ProposalStatus;
  readonly effective_at: null;
  readonly classification_effect: 'prospective_only_no_retroactive_repricing';
  /**
   * (; ): an action type with no named
   * row is RECORDED at its witness class with no mint (record_only, weight 0, whatever the class);
   * it is queued for review only from a witnessed (non-actor) class, and earns only from the
   * effective time of a signed row for it — on an intake lane, only a lane that row is granted for
   * (`INTAKE_SIGNED_ACTION_TYPES`). A
   * submission with no relay-assigned witness class, or whose policy pointer or queue row cannot be
   * read or is invalid, fails closed to pending_policy record_only.
   */
  readonly unknown_action_policy: {
    readonly admission: 'record_only_until_signed_row';
    readonly mint_disposition: 'record_only';
    readonly policy_review_state: 'class_admitted';
    readonly reason_code: 'witness_class_admitted';
    readonly queued_from: 'witnessed_class_only';
    readonly earns_from: 'signed_row_effective_at';
    readonly without_witness_class_or_readable_pointer: {
      readonly mint_disposition: 'record_only';
      readonly policy_review_state: 'pending_policy';
      readonly reason_code: 'unknown_action_type';
    };
  };
  readonly entries: readonly ProposedActionPolicyEntry[];
}

/** Unsigned base-10 integer in canonical PVT atomic units (18 decimals). */
export type PVTAtomic = string;

export interface ApprovalFlag {
  readonly status:
    | 'gate_1_plain_english_approved'
    | 'requires_frank_approval'
    | 'requires_affordability_and_frank_approval'
    | 'requires_wp12_launch_date_approval'
    | 'wp12_launch_dates_explicitly_approved';
  readonly rationale: string;
}

export type CostSnapshotTiming =
  | 'agreement_creation'
  | 'bond_post'
  | 'claim_filing'
  | 'action_execution'
  | 'membership_renewal'
  | 'proposal_creation'
  | 'unverified'
  | 'not_implemented';

export interface CostAuthority {
  readonly current: string;
  readonly proposed: string;
}

export interface CostActivation {
  readonly current_delay_seconds: number | null;
  readonly proposed_minimum_delay_seconds: number;
  readonly effective_policy_version_required: true;
  readonly effective_boundary: 'effective_at';
  readonly prospective_only: true;
}

export interface CostDisposition {
  readonly burn: string;
  readonly lock: string;
  readonly recipient: string;
  readonly refund: string;
  readonly slash: string;
  readonly cost_pe_mint_disposition: 'record_only';
}

export interface BasisPointCostRule {
  readonly kind: 'basis_points';
  readonly initial_bps: number;
  readonly minimum_bps: number;
  readonly maximum_bps: number;
  readonly calculation_basis: string;
  readonly rounding:
    | 'floor_to_atomic_unit'
    | 'floor_to_basis_unit'
    | 'ceil_to_basis_unit';
}

export interface FixedAtomicCostRule {
  readonly kind: 'fixed_atomic';
  readonly initial_atomic: PVTAtomic;
  readonly minimum_atomic: PVTAtomic;
  readonly maximum_atomic: PVTAtomic;
}

/**
 * A policy-controlled lifecycle duration.  Seconds are integer protocol time,
 * never wall-clock display approximations.  The bounds constrain later policy
 * versions as well as the launch value.
 */
export interface DurationSecondsCostRule {
  readonly kind: 'duration_seconds';
  /** Null because current live behavior is not source-verified by this proposal. */
  readonly current_seconds: number | null;
  /** Inert atomic accounting recommendation; Gate 1 does not activate it, and its owning
   * later work package still requires the applicable separate approval. */
  readonly proposed_initial_seconds: number;
  readonly minimum_seconds: number;
  readonly maximum_seconds: number;
}

/** A bounded whole-number operational limit that can affect PVT custody/liveness. */
export interface IntegerLimitCostRule {
  readonly kind: 'integer_limit';
  readonly initial_value: number;
  readonly minimum_value: number;
  readonly maximum_value: number;
}

export interface InheritedCostRule {
  readonly kind: 'inherits';
  readonly inherited_cost_id: string;
}

/** Exact same-token collateral deficit; never derived from an external value. */
export interface RequiredCollateralShortfallCostRule {
  readonly kind: 'required_collateral_shortfall';
  readonly formula: 'max(0,applicable_required_lock_atomic-current_slashable_collateral_atomic)';
  readonly requirement_cost_ids: readonly ['bond.level_2_base_lock', 'bond.level_3_base_lock'];
  readonly maximum_cost_id: 'bond.maximum_total_deposit';
}

export interface ProposedPVTNativeCostEntry {
  readonly cost_id: string;
  readonly institution: 'escrow' | 'promise' | 'pool' | 'job' | 'bond' | 'court' | 'membership' | 'governance';
  readonly current_live_behavior?: string;
  readonly rule:
    | BasisPointCostRule
    | FixedAtomicCostRule
    | DurationSecondsCostRule
    | IntegerLimitCostRule
    | InheritedCostRule
    | RequiredCollateralShortfallCostRule;
  readonly authority: CostAuthority;
  readonly activation: CostActivation;
  readonly snapshot: {
    readonly current: CostSnapshotTiming;
    readonly proposed: CostSnapshotTiming;
  };
  readonly disposition: CostDisposition;
  readonly approval: ApprovalFlag;
  readonly evidence: {
    readonly source_paths: readonly string[];
    readonly verification_method: 'proposal_only_not_source_verified';
    readonly reviewed_git_commit: null;
    readonly semantic_claim_scope: 'proposed_parameter_choice_only';
    readonly current_live_behavior_status: 'unverified_not_an_approval_basis';
  };
}

export interface ProposedPVTNativeCostCatalog {
  readonly schema_version: 'pvt-cost-catalog/v1';
  readonly policy_version: string;
  readonly status: ProposalStatus;
  readonly effective_at: null;
  readonly entries: readonly ProposedPVTNativeCostEntry[];
}

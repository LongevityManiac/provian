/**
 * PVT - PE Weight Framework
 *
 * Replaces the simple category × attestation multiplier formula with:
 *
 * pvt = base_rate × action_weight × occurrence-derived novelty
 * × verified_linkage × attestation
 *
 * 1. Impact Tiers (0-5): Each ActionType maps to a tier
 * 2. Attestation Tiers: complete configured evidence range 0.5x-2.5x
 * 3. Novelty Decay: Per (userId, actionType) - diminishes with repetition
 * (PINNED as valuation, - see NOVELTY_FACTORS)
 * 4. Human Trust: separate 2.0x factor only for relay-verified direct-human
 * identity or an agent's verified human-beneficiary relationship
 * 5. Foundation Override: Admin-configurable tier overrides (Firestore, 6 months)
 *
 * REMOVED : the daily diminishing-returns multiplier (0.5^excess past 50
 * PEs/agent/day). It was a volume deterrent, not a valuation of the work. The
 * 50/day literal first moved to qualification, and then
 * removed the qualification ordinal itself along with every per-user volume
 * cap: volume neither reprices nor disqualifies an act. Anti-farming lives in
 * the evidence layer and in novelty PRICING, never in a ceiling.
 * Reintroduction of a volume-based rate cut is caught behaviourally by FC-004
 * (src/core/decisions/forbidden-constructs.ts).
 */

import { relayDb } from '../../firestore-db';

// =============================================================================
// CONSTANTS
// =============================================================================

const BASE_RATE = 1.0;

/** Impact tiers: 0=none, 1=trivial, 2=standard, 3=significant, 4=high, 5=critical */
// IMMUTABLE economic constant (Component 3; frozen since PVTv5, carried through v8). Frozen at
// runtime - no code path mutates it. The ONLY off-chain repricing of PE weights
// is via foundation_overrides, written solely by the on-chain-governance bridge
// (relay-bridge.ts, after an executed updatePEWeight proposal) and read by
// resolveOverride. The prior bare-ADMIN_API_KEY override endpoint was removed -
// there is no longer a no-vote, no-deploy lever over the meter.
const TIER_MULTIPLIERS: Record<number, number> = {
  0: 0.0,
  1: 0.5,
  2: 1.0,
  3: 2.0,
  4: 3.0,
  5: 5.0,
};
Object.freeze(TIER_MULTIPLIERS);

/** Multiplier for an impact tier (0-5). Tier 0 = 0.0 (the kill value).
 *  Retired PVTv8 compatibility code may still read this table, but PVT9 fixed
 *  Genesis reservations ignore ordinary tier weights and require their own
 *  approved activation/kill boundary. Returns 0 for an out-of-range tier
 *  (fail-closed). */
export function getTierMultiplier(tier: number): number {
  return TIER_MULTIPLIERS[tier] ?? 0;
}

/** Attestation tiers - exported so the conformance route and any other
 *  reference can read the canonical multipliers without re-stating them
 *  (HIGH-3 was a drift between an inline copy in the conformance route
 *  and these source-of-truth values).
 *
 *  Component 3 (immutable economic constant, frozen since PVTv5, carried through v8): this table is an IMMUTABLE economic
 *  constant. The prior W6-3 runtime override (POST /v1/admin/pvt/
 *  attestation-multipliers, a bare-ADMIN_API_KEY Firestore lever with no
 *  governance vote) was removed - attestation multipliers can change only by a
 *  git-reviewed code deploy. getEffectiveAttestationMultipliers() returns this
 *  frozen table; new PEs are still stamped with their multiplier at anchor time
 *  so historical PEs keep their original price. */
export const ATTESTATION_MULTIPLIERS: Record<string, number> = {
  // full_stack: RESERVED - activates when a PE carries simultaneous attestation from
  // all four layers: phone hardware + compute TEE + on-chain transaction + merchant signal.
  full_stack: 2.0,

  hardware_full: 2.5,

  // compute_tee: RESERVED - activates when GPU Trusted Execution Environment attestation
  // is available from cloud providers (NVIDIA H100/H200 Confidential Computing, AMD SEV-SNP,
  // Intel TDX). Estimated mainstream availability: 2027-2028.
  compute_tee: 1.4,

  hardware_partial: 1.2,

  // corroborated: Active now - applies when a PE receives a merchant MTL commerce signal
  // or on-chain transaction verification after creation but before minting.
  corroborated: 1.1,

  // Replication packs affect only an otherwise eligible mint estimate; they do not
  // create eligibility. Without a pack, an eligible PE uses software (0.8x); with a
  // valid pack, an eligible PE uses software_verified (1.2x).
  // This teaches the ecosystem the behavior we want (prove your work) without blocking
  // early adopters. A future authorized prospective policy event may change the rule;
  // governance can do so only after a separately approved PVT9 authority activation.
  //
  // Upgraded from 0.9x to 1.2x (2026-03-30). Developers who provide full Replication
  // Packs (input_hash + model_id + replication_pack_hash) give the network everything
  // needed to independently verify their work. Reward the transparency.
  software_verified: 1.2,

  software: 0.8,
  social: 0.5,
};
Object.freeze(ATTESTATION_MULTIPLIERS);

/** Novelty decay by occurrence count.
 *
 * PINNED : the design requires novelty a VALUATION of marginal
 * contribution, not a deterrent - it prices repetition of the SAME act within
 * a day (occurrence per userId+actionType, daily reset), exempts verifiably
 * different work (the artifact-aware branch keeps full value for the first 10
 * unique artifacts/day), never gates eligibility (floor 0.3 > 0 for
 * non-duplicates), and zeroes only exact duplicates - which is a duplication
 * check, not a rate cut, because a duplicate is not new work. The curve is
 * frozen; changing it requires a new ruling, not a config write. */
export const NOVELTY_FACTORS: Record<number, number> = {
  0: 1.0, // First occurrence
  1: 1.0,
  2: 0.7,
  3: 0.4,
};
Object.freeze(NOVELTY_FACTORS);
/** Novelty decay floor for an otherwise eligible, non-duplicate PE: high-repetition
 * actions receive a 30% multiplier. Record-only/ineligible rows remain zero.
 * A future change requires an authorized prospective policy event; governance is
 * not a PVT9 authority unless the operator separately approves its activation/handoff. */
const NOVELTY_FLOOR = 0.3;
const NOVELTY_EXACT_DUPE = 0.0;

/** Human trust bonus */
const HUMAN_TRUST_BONUS = 2.0;

// =============================================================================
// ACTION TYPE → IMPACT TIER MAPPING
// =============================================================================

const ACTION_TYPE_TIERS: Record<string, number> = {
  // Tier 5 - Critical (high-value economic actions)
  escrow_created: 5,
  escrow_funded: 5,
  escrow_completed: 5,
  promise_funded: 5,
  promise_settled: 5,
  pool_executed: 5,
  court_verdict: 5,
  governance_proposal_executed: 5,

  // Tier 4 - High (Creation PEs - work products from agents and developer tools)
  agent_work_product_code: 4,         // Code creation (builds ecosystem)
  agent_work_product_research: 4,     // Research output (advances knowledge)
  // Witness 3 - relay-witnessed external service events (push-with-signature, Tier A).
  // Slot into the code-work-product tier; matches agent_work_product_code precedent.
  // Connector code does not exist yet (step 4b lands the inbound endpoint).
  'service:github_commit': 4,
  'service:github_pr_merged': 4,
  'service:gitlab_push': 4,
  'service:gitlab_mr_merged': 4,
  'service:bitbucket_push': 4,
  'service:bitbucket_pr_merged': 4,

  // Tier 4 - High (Economic)
  escrow_disputed: 4,
  escrow_resolved: 4,
  promise_defaulted: 4,
  court_vote_cast: 4,
  court_panel_assigned: 4,
  governance_proposal_created: 4,
  governance_vote_cast: 4,
  x402_payment: 4,
  agent_authorization: 4,
  pool_created: 4,
  pool_contributed: 4,
  job_accepted: 4,

  // Tier 3 - Significant (Creation PEs - work products)
  agent_work_product: 3,              // Default for all work products
  agent_work_product_analysis: 3,     // Analysis output
  agent_work_product_document: 3,     // Document creation
  agent_work_product_design: 3,       // Design work
  agent_work_product_data: 3,         // Data processing

  // Tier 3 - Significant (Economic / System)
  agent_wallet_created: 3,
  wallet_created: 3,
  service_install_created: 3,         // User connected a Tier A service (e.g. GitHub App install)
  // governance boundary : `badge_earned: 3` REMOVED. Badges are record-only and mint
  // zero PVT by protocol (Gate 1 action policy: record_only; wp-ev eligibility:
  // ZERO_MINT_ACTION_TYPES; estimate: hard 0). The explicit tier-3 entry was
  // the sole cause of isDelegationQualifying('badge_earned') === true, and its
  // inertness rested entirely on the record_only policy resolution holding.
  // Badge action types now resolve through the category default
  // ('infrastructure' → tier 1) / DEFAULT_TIER like any other record-only
  // machinery event. Do not re-add a badge weight without a separate explicit
  // approval — Gate 1 approved no badge-driven weight or governance effect.
  agent_capabilities_registered: 3,
  job_posted: 3,
  job_delivered: 3,
  webhook_subscribed: 3,
  pe_type_proposed: 3,
  agent_commit: 3,
  agent_share_data: 3,
  agreement: 3,
  agreement_settled: 3,
  pvt_fee_burned: 3,
  pvt_reputation_staked: 3,
  pvt_reputation_slashed: 3,

  // Tier 2 - Standard (default for unknown types)
  agent_work_product_other: 2,  // Uncategorized work product
  pvt_batch_minted: 2,    // Infrastructure event - audit trail only, standard weight
  send: 2,
  swap: 2,
  receive: 2,
  onramp: 2,
  approve: 2,
  stake: 2,
  pool_refunded: 2,
  promise_created: 2,
  promise_accepted: 2,
  promise_fulfilled: 2,
  promise_broken: 2,
  promise_disputed: 2,
  job_applied: 2,
  court_majority_bonus: 2,
  court_minority_vote: 2,
  court_escalated: 2,
  pvt_reputation_unstaked: 2,
  pvt_burned_voluntary: 2,
  pvt_governance_proposed: 2,
  pvt_governance_voted: 2,
  agent_communicate: 2,
  agent_public_post: 2,
  social_post_approved: 2,
  egress_data_approved: 2,
  egress_data_executed: 2,
  proxied_payment_executed: 2,
  agent_invite_sent: 2,
  invite_accepted: 2,
  environment_attestation: 2,
  skill_install_requested: 2,

  // Goal Envelope (Policy Sandbox)
  goal_envelope_created: 3,       // Significant - bounded autonomy grant
  goal_envelope_completed: 3,     // Significant - successful goal resolution
  goal_envelope_expired: 1,       // Trivial - informational
  goal_envelope_cancelled: 1,     // Trivial - informational
  goal_action_auto_approved: 2,   // Standard - action within goal envelope
  goal_constraint_violation: 1,   // Trivial - violation event

  // Witness 3 - user revoked a connected service install. Informational
  // control event (not value-creating); kept asymmetric with
  // service_install_created (tier 3) which represents new capacity.
  service_install_revoked: 1,

  // Corroboration & Replication
  corroboration_signal: 3,    // Significant - validates another PE's outcome
  replication_pack: 3,        // Significant - verifiable agent work artifact

  // Observer-generated (process-level daemon)
  compute_session: 1,        // Tier 1 (trivial) - background compute, thin metadata
  inference_session: 2,      // Tier 2 (standard) - LLM inference with token data
  agent_tool_orchestration: 3, // Tier 3 (significant) - non-relay multi-tool orchestration

  // Desktop foreground capture (LLMSessionPlugin, Phase 2b).
  //
  // ai_conversation measures human AI engagement (foreground time + interaction
  // density on supported providers) and is complementary to inference_session.
  // Both can fire for the same wall-clock window when a user works with
  // claude.ai in the foreground while an agent runtime writes to
  // PROVIAN_LLM_LOG. The two PEs measure different dimensions of the same
  // economy; skipDedupClaim in the observer preserves both.
  //
  // Default tier is 2 (standard), matching inference_session, so launch PVT
  // parity is preserved while operators gather data. Future pass: weight
  // based on metadata.input_fidelity so sessions captured without Input
  // Monitoring (presence_only) can be down-weighted only by an authorized
  // prospective policy event. Governance can authorize that only after a separately
  // approved activation/handoff. The hook is intentionally not wired here; it belongs
  // in the weight-framework resolver alongside attestation_multiplier.
  ai_conversation: 2,

  // Tier 1 - Trivial (low-value / informational)
  burn_spam: 1,
  export_logs: 1,
  device_register: 1,
  device_revoke: 1,
  vouch_for_device: 1,
  credential_added: 1,
  credential_updated: 1,
  credential_deleted: 1,
  credential_frozen: 1,
  credential_unfrozen: 1,
  credential_released: 1,
  credential_injected: 1,
  credential_release_expired: 1,
  credential_release_used: 1,
  agent_session_started: 1,
  agent_session_suspended: 1,
  agent_session_revoked: 1,
  policy_created: 1,
  policy_updated: 1,
  request_expired: 1,
  request_auto_approved: 1,
  agent_transaction_reported: 1,
  agent_transaction_synced: 1,
  anomaly_detected: 1,
  behavior_baseline_updated: 1,
  classification_reclassified: 1,
  environment_drift_detected: 1,

  // Provian Commons
  commons_profile_created: 1,         // Joining is informational
  commons_pe_published: 2,            // Standard - publishing PE to Commons
  commons_post_created: 2,            // Standard - creating discourse
  commons_post_replied: 1,            // Trivial - reply activity
  commons_vote_cast: 1,               // Trivial - PE-attested, rate-limited
  commons_claim_challenged: 3,        // Significant - PE-attested, staked; resolves by burn-to-present
  commons_post_flagged: 2,            // Standard - community moderation
  commons_vouch_given: 2,             // Standard - reputation staking
  commons_vouch_received: 1,          // Trivial - passive receipt
  commons_verification_upgraded: 2,   // Standard - trust level increase

  // Commons Artifacts
  commons_artifact_created: 3,        // Significant - agent publishes reusable component
  commons_artifact_updated: 2,        // Standard - new version of existing artifact
  commons_artifact_deprecated: 1,     // Trivial - informational lifecycle event
  commons_artifact_attested: 3,       // Significant - human attestation (premium trust signal)
  commons_artifact_invoked: 1,        // Trivial - high volume, low individual weight

  // Lineage attribution (upstream PVT redistribution record)
  lineage_attribution: 1,            // Tier 1 - redistribution, not new work
  pe_cited: 3,                       // Tier 3 - significant: upstream creator credited via citation

  // Delegation (human beneficiary provenance record)
  agent_work_delegated: 1,            // Tier 1 - record of direction, not work itself

  // Beneficiary model (agent-human linking)
  agent_linked_to_human: 3,           // Significant - trust establishment
  human_linked_agent: 3,              // Significant - trust acceptance
  agent_unlinked_from_human: 2,       // Standard - relationship change
  pvt_retroactive_transfer: 2,        // Legacy catalog tier; Gate 1 action policy makes this record-only
  pvt_surplus_transfer: 2,            // Legacy catalog tier; Gate 1 action policy makes this record-only
  agent_sub_spawned: 2,               // Standard - sub-agent creation

  // Human Jobs (agents hiring humans)
  human_job_posted: 2,                // Standard - job creation
  human_job_applied: 1,               // Trivial - application
  human_job_accepted: 3,              // Significant - triggers escrow
  human_job_delivered: 4,             // High - work product delivered
  human_job_completed: 4,             // High - payment released
  human_job_rated: 2,                 // Standard - reputation signal

  // Insurance Bonds (Phase 5)
  bond_posted: 2,                     // Standard - bond creation
  bond_renewed: 2,                    // Standard - maintenance action
  bond_slashed: 2,                    // Standard - penalty event
  bond_withdrawn: 2,                  // Standard - fund withdrawal
  bond_topped_up: 2,                  // Standard - bond increase
  bond_claim_filed: 1,                // Trivial - anyone can file
  bond_claim_resolved: 2,             // Standard - resolution
  insurance_claim_filed: 1,           // Legacy alias for bond_claim_filed (historical PEs)
  insurance_claim_resolved: 2,        // Legacy alias for bond_claim_resolved (historical PEs)
  bond_abandonment_processed: 2,      // Standard - system-generated

  // Tier 0 - Zero value
  emergency_stop: 0,
  social_post_denied: 0,
  system_access_denied: 0,
  uncategorized_action_denied: 0,
  egress_data_denied: 0,
  egress_data_blocked: 0,
  proxied_payment_failed: 0,
};

const DEFAULT_TIER = 2; // Unknown action types get standard tier if no category match

// =============================================================================
// CATEGORY-BASED WEIGHT DEFAULTS
//
// When an action type is not explicitly listed in ACTION_TYPE_TIERS, the weight
// framework falls back to the category default. Categories are resolved from the
// pe_type_catalog (see pe-type-catalog.ts) on a 5-minute TTL cache. If a type is
// uncategorized, the DEFAULT_TIER (2 / standard) is used.
//
// Explicit per-type tiers in ACTION_TYPE_TIERS OVERRIDE category defaults - they
// are fine-grained adjustments on top of the coarse category layer.
// =============================================================================

/**
 * Category membership map - informational reference for seed types.
 * Used by pe-type-catalog.ts for category inference on new types.
 */
export const PE_CATEGORIES: Record<string, string[]> = {
  financial: [
    'send', 'swap', 'stake', 'receive', 'onramp', 'approve', 'x402_payment',
    'escrow_created', 'escrow_funded', 'escrow_completed', 'escrow_disputed', 'escrow_resolved',
    'promise_created', 'promise_accepted', 'promise_fulfilled', 'promise_broken',
    'promise_disputed', 'promise_funded', 'promise_settled', 'promise_defaulted',
    'pool_created', 'pool_contributed', 'pool_executed', 'pool_refunded',
    'proxied_payment_requested', 'proxied_payment_approved', 'proxied_payment_executed',
    'proxied_payment_failed', 'agent_authorization',
  ],
  compute: [
    'coding_session', 'refactor', 'test_run', 'deployment', 'research',
    'document', 'agent_action',
    'agent_work_product', 'agent_work_product_code', 'agent_work_product_research',
    'agent_work_product_analysis', 'agent_work_product_document', 'agent_work_product_design',
    'agent_work_product_data', 'agent_work_product_other',
    'compute_session', 'inference_session', 'agent_tool_orchestration',
    'ai_conversation',
  ],
  social: [
    'agent_communicate', 'agent_public_post', 'social_post_approved',
    'commons_forum_post', 'commons_post_created', 'commons_post_replied',
    'commons_vote_cast', 'commons_vouch_given', 'commons_vouch_received',
    'commons_verification_upgraded',
  ],
  governance: [
    'governance_proposal_created', 'governance_vote_cast', 'governance_proposal_executed',
    'governance_proposal_cancelled', 'governance_premint_weight_set',
    'court_vote_cast', 'court_verdict', 'court_panel_assigned', 'court_majority_bonus',
    'court_minority_vote', 'court_escalated',
    'court_general_dispute_filed', 'court_general_dispute_resolved', 'court_evidence_submitted',
    'pvt_governance_proposed', 'pvt_governance_voted',
  ],
  security: [
    'device_register', 'device_revoke', 'credential_added', 'credential_updated',
    'credential_frozen', 'credential_unfrozen', 'credential_deleted', 'credential_released',
    'credential_injected', 'credential_release_expired', 'credential_release_used',
    'emergency_stop', 'anomaly_detected', 'environment_attestation',
    'environment_drift_detected', 'skill_install_requested',
    'agent_session_started', 'agent_session_suspended', 'agent_session_revoked',
    'policy_created', 'policy_updated', 'friction_escalation',
  ],
  institutional: [
    'agent_marketplace', 'agent_court', 'agent_governance', 'agent_labor_market',
    'agent_compute_market', 'agent_reputation_system', 'agent_ecosystem_uncategorized',
    'bond_posted', 'bond_renewed', 'bond_slashed', 'bond_withdrawn', 'bond_topped_up',
    'bond_abandonment_processed',
    'bond_claim_filed', 'bond_claim_resolved',
    'insurance_claim_filed', 'insurance_claim_resolved',
    'agent_capabilities_registered', 'job_posted', 'job_applied', 'job_accepted',
    'job_delivered', 'webhook_subscribed', 'pe_type_proposed',
    'human_job_posted', 'human_job_applied', 'human_job_accepted',
    'human_job_delivered', 'human_job_completed', 'human_job_rated',
  ],
  infrastructure: [
    'wallet_created', 'agent_wallet_created', 'agent_wallet_funded',
    'agent_first_transaction', 'agent_sustained_activity',
    'pvt_batch_minted', 'pvt_epoch_advanced', 'pvt_pe_anchored',
    'pvt_fee_burned', 'pvt_reputation_staked', 'pvt_reputation_unstaked',
    'pvt_reputation_slashed', 'pvt_burned_voluntary',
    'badge_earned', 'agent_invite_sent',
  ],
};

/**
 * Default tier for each category. Used when a type has no explicit tier and
 * no foundation override.
 *   1 = trivial, 2 = standard, 3 = significant
 */
export const CATEGORY_DEFAULT_TIERS: Record<string, number> = {
  financial: 3,       // significant - real value moves
  compute: 2,         // standard - default for work
  social: 1,          // trivial - conversation is cheap
  governance: 3,      // significant - direction setting
  security: 2,        // standard - protective actions
  institutional: 2,   // standard - infrastructure actions
  infrastructure: 1,  // trivial - internal machinery
  uncategorized: 2,   // falls to DEFAULT_TIER
};

/**
 * Resolve the default tier for a category. Used by calculatePEWeight when no
 * per-type tier is defined. The caller supplies the category (looked up from
 * the pe_type_catalog).
 */
export function getTierForCategory(category: string | undefined): number {
  if (!category) return DEFAULT_TIER;
  const tier = CATEGORY_DEFAULT_TIERS[category];
  return tier ?? DEFAULT_TIER;
}

// =============================================================================
// TYPES
// =============================================================================

export interface PEWeightInput {
  userId: string;
  actionType: string;
  attestationDepth: string;       // 'hardware' | 'software' | 'hardware_full' | 'hardware_partial' | 'social'
  isHumanLinked: boolean;
  /** PEs created by this user today (before this one). NOT a pricing input
   * since, and since not a qualification input either — volume
   * neither reprices nor disqualifies; the FC-004 probe varies it and
   * requires a flat price. */
  dailyPECount: number;
  occurrenceCount: number;        // How many times this (userId, actionType) has occurred
  isDuplicate: boolean;           // Exact duplicate content
  isUniqueArtifact?: boolean;     // true if artifact_hash is unique for this user today (work_product PEs)
  tierOverride?: number;          // Foundation override (0-5)
  deferred_since?: number | null; // Unix ms - when PE was deferred. null = not deferred.
  category?: string;              // Catalog category (falls back to category default tier for unknown types)
  /**
   * Wave 6 W6-3: explicit attestation multiplier supplied by the caller.
   * When set, calculatePEWeight uses this value instead of looking up
   * ATTESTATION_MULTIPLIERS[attestationDepth] live. The retired PVTv8 minting
   * engine passed the value stamped on pe_history.attestation_multiplier_at_anchor
   * so old PEs preserve their original price even if governance changes
   * the live multipliers.
   */
  attestationMultiplierOverride?: number;
}

export interface PEWeightOutput {
  estimatedPVT: number;
  tier: number;
  tierMultiplier: number;
  attestationMultiplier: number;
  noveltyFactor: number;
  humanTrustBonus: number;
  breakdown: string;
}

export interface WeightConfig {
  tiers: Record<string, number>;
  attestation_multipliers: Record<string, number>;
  daily_pe_threshold: number;
  human_trust_bonus: number;
  foundation_overrides: Record<string, number>;
  foundation_override_expires?: number;
  updated_at: number;
}

// =============================================================================
// CORE: CALCULATE PE WEIGHT
// =============================================================================

export function calculatePEWeight(input: PEWeightInput): PEWeightOutput {
  // 1. Resolve impact tier.
  //    Priority: foundation override → explicit per-type tier → category default → DEFAULT_TIER.
  //    Category is resolved asynchronously from the pe_type_catalog by the caller
  //    (see pvt-accrual.ts / getCategoryForActionType).
  const explicitTier = ACTION_TYPE_TIERS[input.actionType];
  const categoryTier = input.category !== undefined
    ? getTierForCategory(input.category)
    : undefined;
  const tier = input.tierOverride
    ?? explicitTier
    ?? categoryTier
    ?? DEFAULT_TIER;
  const tierMultiplier = TIER_MULTIPLIERS[tier] ?? TIER_MULTIPLIERS[2];

  // 2. Attestation multiplier
  // Wave 6 W6-3: prefer the caller-supplied override (stamped on PE at
  // anchor time) so historical PEs keep their original price across
  // governance multiplier changes. Falls back to live ATTESTATION_MULTIPLIERS
  // for legacy PEs that pre-date the stamping field.
  const normalizedAttestation = normalizeAttestationTier(input.attestationDepth);
  const attestationMultiplier = input.attestationMultiplierOverride
    ?? ATTESTATION_MULTIPLIERS[normalizedAttestation]
    ?? ATTESTATION_MULTIPLIERS.software;

  // 3. Novelty factor
  let noveltyFactor: number;
  if (input.isDuplicate) {
    noveltyFactor = NOVELTY_EXACT_DUPE;
  } else if (input.isUniqueArtifact) {
    // Unique artifact hashes get a slower novelty decay curve.
    // A developer who builds 15 genuinely different things in a day
    // should not be penalized the same way as someone repeating the same action.
    if (input.occurrenceCount <= 10) {
      noveltyFactor = 1.0;
    } else if (input.occurrenceCount <= 20) {
      noveltyFactor = 0.8;
    } else if (input.occurrenceCount <= 50) {
      noveltyFactor = 0.6;
    } else {
      noveltyFactor = NOVELTY_FLOOR;
    }
  } else if (input.occurrenceCount <= 3) {
    noveltyFactor = NOVELTY_FACTORS[input.occurrenceCount] ?? NOVELTY_FLOOR;
  } else {
    noveltyFactor = NOVELTY_FLOOR;
  }

  // 4. REMOVED - daily diminishing returns. REMOVED - the
  // daily qualification ordinal that succeeded it.
  //
  // The 0.5^excess multiplier is gone: the price of an act does not depend on
  // how many other PEs its author recorded that day. The 50 literal first
  // moved to qualification and was then removed outright with the
  // per-user hourly/daily volume caps — volume neither reprices nor
  // disqualifies. `input.dailyPECount` is deliberately still accepted and
  // deliberately unread here - it keeps the FC-004 behavioural probe's
  // violation constructible (a detector whose violating input cannot be
  // supplied has never been shown to work).

  // 5. Human trust bonus
  const humanTrustBonus = input.isHumanLinked ? HUMAN_TRUST_BONUS : 1.0;

  // 6. REMOVED - vintage scoring for deferred PEs.
  //
  // A deferred PE used to lose 10/20/30/40% of its value purely for how long it
  // sat waiting for its jurisdiction to activate - a delay the contributor did
  // not choose and could not shorten. That is a time-based reduction of already
  // -earned value, and it is gone. `deferred_since` is still recorded as audit
  // evidence (see deferred-release.ts); it no longer prices anything.

  // 7. Final calculation
  const estimatedPVT = BASE_RATE
    * tierMultiplier
    * attestationMultiplier
    * noveltyFactor
    * humanTrustBonus;

  return {
    estimatedPVT,
    tier,
    tierMultiplier,
    attestationMultiplier,
    noveltyFactor,
    humanTrustBonus,
    breakdown: `${BASE_RATE} × T${tier}(${tierMultiplier}) × A(${attestationMultiplier}) × N(${noveltyFactor.toFixed(2)}) × H(${humanTrustBonus})`,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

export function normalizeAttestationTier(depth: unknown): string {
  if (typeof depth !== 'string') return 'software';
  if (depth === 'hardware') return 'hardware_full';
  if (depth === 'hardware_tpm' || depth === 'hardware_limited') return 'hardware_partial';
  if (ATTESTATION_MULTIPLIERS[depth] !== undefined) return depth;
  return 'software';
}

/**
 * Get the impact tier for an action type.
 */
export function getActionTypeTier(actionType: string): number {
  return ACTION_TYPE_TIERS[actionType] ?? DEFAULT_TIER;
}

/**
 * Get all tier assignments for export.
 */
export function getAllTierAssignments(): Record<string, number> {
  return { ...ACTION_TYPE_TIERS };
}

// =============================================================================
// WEIGHT CONFIG (Firestore-backed, cached)
// =============================================================================

let weightConfigCache: WeightConfig | null = null;
let weightConfigCacheTime = 0;
const WEIGHT_CONFIG_TTL = 60_000; // 1 minute

/**
 * Load weight config from Firestore (with 60s cache).
 * Returns null if no foundation overrides exist.
 */
export async function loadWeightConfig(): Promise<WeightConfig | null> {
  const now = Date.now();
  if (weightConfigCache && now - weightConfigCacheTime < WEIGHT_CONFIG_TTL) {
    return weightConfigCache;
  }

  try {
    const db = relayDb();
    const doc = await db.collection('pvt_config').doc('weights').get();
    if (!doc.exists) return null;

    weightConfigCache = doc.data() as WeightConfig;
    weightConfigCacheTime = now;
    return weightConfigCache;
  } catch {
    return null;
  }
}

/**
 * Resolve foundation override for an action type.
 */
export async function resolveOverride(actionType: string): Promise<number | undefined> {
  const config = await loadWeightConfig();
  if (!config) return undefined;

  // Check if overrides have expired
  if (config.foundation_override_expires && Date.now() > config.foundation_override_expires) {
    return undefined;
  }

  return config.foundation_overrides?.[actionType];
}

/**
 * Build the full weight config for API response.
 */
export function buildWeightConfigResponse(): {
  tiers: Record<number, number>;
  action_type_tiers: Record<string, number>;
  attestation_multipliers: Record<string, number>;
  evidence_priced_attestation: {
    families: string[];
    multipliers: Record<string, number>;
    policy: string;
  };
  novelty_factors: Record<number, number>;
  volume_policy: string;
  human_trust_bonus: number;
  human_trust_policy: string;
  attestation_policy: string;
  ordinary_formula: string;
  default_tier: number;
  novelty_model: Record<string, string>;
} {
  return {
    tiers: { ...TIER_MULTIPLIERS },
    action_type_tiers: { ...ACTION_TYPE_TIERS },
    attestation_multipliers: { ...ATTESTATION_MULTIPLIERS },
    evidence_priced_attestation: {
      families: ['verified_compute_or_work', 'verified_external_service_witness'],
      // Float mirror of PROPOSED_EVIDENCE_PRICED_ATTESTATION_MULTIPLIERS_BPS
      // (the record path prices in integer bps; this endpoint reports floats).
      multipliers: {
        hardware_full: 1.0,
        hardware_partial: 1.0,
        full_stack: 1.0,
        compute_tee: 1.0,
        corroborated: 1.0,
        software_verified: 1.0,
        software: 0.8,
        social: 0.5,
      },
      policy: 'The compute_or_work and service:* families price on the '
        + 'evidence axis. Self-attested/observed work EARNS BASE WEIGHT at a self-attested '
        + 'discount (software 0.8x, social 0.5x), priced down by novelty decay for repetition — '
        + 'not a terminal zero. A self-produced replication pack (software_verified) is capped '
        + 'at the family\'s flat 1.0x (parity with proof, not the ladder\'s 1.2x). Hardware '
        + 'attestation, chain-verified corroboration, a third-party witness, and TEE are LIFTS '
        + 'at the family\'s flat 1.0x (no hardware-farm premium). Corroboration is '
        + 'a lift, never the price of admission. The Sybil bound is the per-device daemon plus '
        + 'the real inference cost of producing observed work; a bare, costless self-report '
        + 'carries no server-verified evidence stamp and floors at 0 (pending_evidence), not this '
        + 'table.',
    },
    novelty_factors: { ...NOVELTY_FACTORS },
    volume_policy: 'There is no daily diminishing-returns multiplier and no per-user volume cap of any kind — no hourly or daily PE ceiling and no daily qualification ordinal. An act pays its full rate regardless of same-day volume. Repetition is priced by occurrence-derived novelty (exact duplicates mint 0), and per-action identity-based anti-farm caps on financial types still apply.',
    human_trust_bonus: HUMAN_TRUST_BONUS,
    human_trust_policy: 'The 2.0x factor applies only after relay-verified direct-human identity or an agent human-beneficiary relationship; device ownership, signing method, and attestation never supply linkage.',
    attestation_policy: 'Attestation is a separate 0.5x-2.5x evidence factor on standard-priced actions. The compute_or_work and service:* families are external_proof_priced instead — self-attested work earns the ladder discount and proof is a lift capped at 1.0x; see evidence_priced_attestation. Agent-owned devices are server-capped at software before signing-method selection; their device_register setup PE has no device anchor and mints zero PVT.',
    ordinary_formula: 'base_points * action_weight * occurrence_derived_novelty * verified_linkage * attestation / 10000^4; the kernel seals the retired daily-diminishing slot at the neutral 10000 bps so its 10000^5 denominator cancels exactly; occurrence is not a second multiplier',
    default_tier: DEFAULT_TIER,
    novelty_model: {
      default: 'Standard novelty decay per (userId, actionType), reset daily - full at occurrence 1, 0.7x at 2, 0.4x at 3, floor 0.3x after (the accrual caller passes a 1-based occurrence count). Pinned as valuation.',
      artifact_aware: 'For work_product PEs with unique artifact_hash: full novelty for first 10 unique artifacts/day, 0.8x for 11-20, 0.6x for 21-50, floor 0.3x after. Each genuinely different output resets the penalty.',
    },
  };
}

/**
 * Invalidate the weight config cache (e.g., after admin update).
 */
export function invalidateWeightConfigCache(): void {
  weightConfigCache = null;
  weightConfigCacheTime = 0;
}

// =============================================================================
// ATTESTATION MULTIPLIERS - IMMUTABLE (Component 3; frozen since PVTv5, carried through v8)
// =============================================================================
//
// The base ATTESTATION_MULTIPLIERS table above is the frozen, immutable source
// of truth. The prior W6-3 runtime override (a bare-ADMIN_API_KEY Firestore
// lever at pvt_config/attestation_multipliers, set via POST /v1/admin/pvt/
// attestation-multipliers with no governance vote) was a parallel economic
// lever outside the governed-or-immutable principle the on-chain PVTv8 bundle
// enforces (every economic lever is either an immutable constant or moves only
// through the sanctioned on-chain governance path — EOA-direct under v8), so it
// was removed (Component 3 fast-follow). Attestation multipliers
// now change only by a git-reviewed code deploy - the same trust model as the
// rest of the money path.
//
// Stamping semantics are unchanged: at PE record time the effective value for
// the PE's attestationDepth is persisted on pe_history as
// attestation_multiplier_at_anchor, and the retired PVTv8 minting engine passed
// that stamped value to calculatePEWeight so historical PEs kept their original price.

/**
 * Returns the effective attestation multiplier table. Now that the runtime
 * override is removed (Component 3), this is just the frozen base table; the
 * response shape (foundation_override_active / last_changed_at) is preserved so
 * existing readers (conformance route, /v1/pvt/weights) keep working unchanged.
 */
export async function getEffectiveAttestationMultipliers(): Promise<{
  multipliers: Record<string, number>;
  foundation_override_active: boolean;
  last_changed_at: number | null;
}> {
  return {
    multipliers: { ...ATTESTATION_MULTIPLIERS },
    foundation_override_active: false,
    last_changed_at: null,
  };
}

/**
 * Resolve the effective multiplier for a single attestation tier (the frozen
 * base table). Falls back to the software baseline when the tier is unknown.
 */
export async function getEffectiveAttestationMultiplier(tier: string): Promise<number> {
  const normalized = normalizeAttestationTier(tier);
  return ATTESTATION_MULTIPLIERS[normalized] ?? ATTESTATION_MULTIPLIERS.software;
}

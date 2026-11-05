export type { CorroborationSignalType, CorroborationSignalPEDetails, ReplicationPackPEDetails } from './CorroborationTypes';
import type { CorroborationSignalPEDetails, ReplicationPackPEDetails } from './CorroborationTypes';
export type { InputOrigin, InputOriginsState, OriginWitness } from './inputOrigins';
import type { InputOrigin } from './inputOrigins';

export type ActionType =
    | 'send'
    | 'swap'
    | 'stake'
    | 'receive'
    | 'onramp'
    | 'approve'
    | 'burn_spam'
    | 'recovery_action'
    | 'recovery_init'
    | 'recovery_complete'
    | 'recurring_payment_run'
    | 'export_logs'
    | 'x402_payment'
    | 'link_spend'
    | 'REVOKE_APPROVAL'
    | 'onramp_order'
    | 'device_register'
    | 'device_revoke'
    | 'agent_action'
    | 'agent_authorization'
    | 'vouch_for_device'
    | 'agreement'
    | 'agreement_settled'
    // Credential Vault events
    | 'credential_added'
    | 'credential_updated'
    | 'credential_frozen'
    | 'credential_unfrozen'
    | 'credential_deleted'
    | 'credential_released'
    | 'credential_injected'
    | 'credential_release_expired'
    | 'credential_release_used'
    // Agent Session events
    | 'agent_session_started'
    | 'agent_session_suspended'
    | 'agent_session_revoked'
    // Policy events
    | 'policy_created'
    | 'policy_updated'
    | 'friction_escalation'
    // Emergency Stop
    | 'emergency_stop'
    // Promise lifecycle events
    | 'promise_created'
    | 'promise_accepted'
    | 'promise_fulfilled'
    | 'promise_broken'
    | 'promise_disputed'
    | 'promise_deleted'
    // Promise Negotiation events
    | 'promise_offered'
    | 'promise_countered'
    | 'promise_negotiation_accepted'
    | 'promise_negotiation_rejected'
    | 'promise_negotiation_expired'
    | 'negotiation_expired'
    | 'negotiation_rejected'
    // Non-financial agent actions
    | 'agent_communicate'
    | 'agent_commit'
    | 'agent_share_data'
    | 'agent_public_post'
    | 'agent_system_access'
    | 'agent_uncategorized'
    // Social post lifecycle
    | 'social_post_approved'
    | 'social_post_denied'
    // System access lifecycle
    | 'system_access_approved'
    | 'system_access_denied'
    // Uncategorized action lifecycle
    | 'uncategorized_action_approved'
    | 'uncategorized_action_denied'
    // Proxied Payment events (Path B2')
    | 'proxied_payment_requested'
    | 'proxied_payment_approved'
    | 'proxied_payment_executed'
    | 'proxied_payment_failed'
    // Egress data flow events (Phase 2: Egress Authorization Gate)
    | 'egress_data_requested'
    | 'egress_data_approved'
    | 'egress_data_denied'
    | 'egress_data_executed'
    | 'egress_data_blocked'
    // Request lifecycle events
    | 'request_expired'
    | 'request_auto_approved'
    | 'agent_transaction_reported'
    | 'agent_transaction_synced'
    // Behavioral anomaly detection (Phase 3)
    | 'anomaly_detected'
    | 'behavior_baseline_updated'
    | 'classification_reclassified'
    // Agent environment integrity (Phase 4)
    | 'environment_attestation'
    | 'environment_drift_detected'
    | 'skill_install_requested'
    // Agent Wallet events
    | 'wallet_created'          // Birth certificate PE for new wallets (human or agent)
    | 'agent_wallet_created'    // Agent self-signup wallet creation
    | 'external_address_proven' // Agent proved control of an external EVM address (Unit 2; record, 0 PVT)
    // Agent Self-Signup events
    | 'badge_earned'            // Record-only badge event; zero PVT under Gate 1 economics
    | 'agent_invite_sent'       // Agent sent invite to human
    | 'invite_accepted'         // Human accepted an agent invite (prospective link; no signing bonus)
    // Beneficiary model (agent-human linking)
    | 'agent_linked_to_human'   // Agent linked to human beneficiary
    | 'human_linked_agent'      // Human accepted agent link
    | 'agent_unlinked_from_human' // Agent unlinked from human
    | 'pvt_retroactive_transfer'  // Legacy record-only bookkeeping identifier; no current transfer authority
    | 'pvt_surplus_transfer'    // Legacy record-only bookkeeping identifier; no current transfer authority
    | 'agent_sub_spawned'       // Sub-agent created with inherited beneficiary
    // Agent Bank: Escrow events
    | 'escrow_created'          // Escrow terms recorded
    | 'escrow_funded'           // USDC deposited into escrow contract
    | 'escrow_completed'        // Funds released to recipient
    | 'escrow_disputed'         // Depositor raised a dispute
    | 'escrow_resolved'         // Admin resolved dispute
    // Agent Bank: Promise settlement events
    | 'promise_funded'          // Lender funded a promise
    | 'promise_settled'         // Borrower repaid
    | 'promise_defaulted'       // Deadline passed without settlement (negative)
    // Agent Bank: Capital Pool events
    | 'pool_created'            // Capital pool created
    | 'pool_contributed'        // Contribution to a pool
    | 'pool_executed'           // Pool funds sent to target
    | 'pool_refunded'           // Pool contributions returned
    // Agent Bank: Court events (Phase 2)
    | 'court_panel_assigned'    // Arbitrator assigned to dispute panel
    | 'court_vote_cast'         // Arbitrator cast vote on dispute
    | 'court_verdict'           // Court reached majority verdict
    | 'court_majority_bonus'    // Arbitrator voted with majority
    | 'court_minority_vote'     // Arbitrator voted against majority
    | 'court_escalated'         // Voting deadline expired without majority
    // Court Mandate Expansion (General Disputes)
    | 'court_general_dispute_filed'
    | 'court_general_dispute_resolved'
    | 'court_evidence_submitted'
    // PVT Minting events (Phase 3)
    | 'pvt_batch_minted'            // PVT minted from PE batch
    | 'pvt_epoch_advanced'          // PVT epoch advanced
    | 'pvt_pe_anchored'             // PE batch anchored on-chain
    // Governance events (Phase 3)
    | 'governance_proposal_created' // Governance proposal created
    | 'governance_vote_cast'        // Vote cast on governance proposal
    | 'governance_proposal_executed'   // Governance proposal executed
    | 'governance_proposal_cancelled'  // Governance proposal cancelled
    | 'governance_premint_weight_set' // Pre-mint voting weight assigned
    // Agent Ecosystem Infrastructure
    | 'agent_capabilities_registered'  // Agent registered/updated directory capabilities
    | 'job_posted'                     // Job posted on job board
    | 'job_applied'                    // Agent applied to a job
    | 'job_accepted'                   // Job poster accepted an applicant
    | 'job_delivered'                  // Assigned worker delivered job
    | 'webhook_subscribed'            // Agent subscribed to webhook events
    | 'pe_type_proposed'              // Agent proposed a new PE action type
    // PVT Day-One: Burn, staking, and governance
    | 'pvt_fee_burned'                // PVT burned for Agent Bank fee payment
    | 'pvt_reputation_staked'         // PVT staked as reputation collateral
    | 'pvt_reputation_unstaked'       // PVT unstaked from reputation collateral
    | 'pvt_reputation_slashed'        // PVT slashed from reputation stake
    | 'pvt_burned_voluntary'          // PVT voluntarily burned by holder
    | 'pvt_governance_proposed'       // Governance proposal created via PVT
    | 'pvt_governance_voted'          // Governance vote cast via PVT
    // Goal Envelope (Policy Sandbox) events
    | 'goal_envelope_created'         // Goal approved and activated
    | 'goal_envelope_approved'        // Goal approved (relay-compatible alias)
    | 'goal_envelope_rejected'        // Goal rejected before activation
    | 'goal_envelope_completed'       // Goal successfully completed
    | 'goal_envelope_expired'         // Goal expired without completion
    | 'goal_envelope_cancelled'       // Goal cancelled by user
    | 'goal_action_auto_approved'     // Action auto-approved within goal envelope
    | 'goal_action_taken'             // Individual action within an active goal
    | 'goal_constraint_violation'     // Action violated goal constraints
    // Corroboration signals - automatically generated, never user-initiated
    | 'corroboration_signal'
    // Replication pack - agent-generated verifiable work artifact
    | 'replication_pack'
    // Provian Commons events
    | 'commons_profile_created'       // Agent/human joins the Commons
    | 'human_approval'                // Trust Layer §2.10: a human approves an agent's work (metadata-only reference)
    | 'commons_pe_published'          // PE projection published to Commons
    | 'commons_post_created'          // Forum post created
    | 'commons_post_replied'          // Forum reply
    | 'commons_vote_cast'             // Forum vote (PE-attested; rate-limited)
    | 'commons_claim_challenged'      // Claim challenge (burn-to-present — the challenger stakes, the author presents)
    | 'commons_challenge_answered'    // The author's presentation against a challenge's predicate
    | 'commons_challenge_resolved'    // Challenge outcome record (record-only)
    | 'commons_thread_message'        // A thread message (content hash sealed; content E2E,)
    | 'commons_featured_placement'    // Featured-placement bid (burn auction; record-only PVT-cost lock)
    | 'want_posted'                   // A want posted to the wants board (Commons speech,)
    | 'want_fulfilled'                // A want marked fulfilled (record-only settlement signal)
    | 'want_cancelled'                // A want cancelled (record-only)
    | 'commons_post_flagged'          // Post flagged for review
    | 'commons_vouch_given'           // Established participant vouches for another
    | 'commons_vouch_received'        // Participant receives a vouch
    | 'commons_verification_upgraded' // Participant reaches new verification level
    // Human Jobs events (agents hiring humans)
    | 'human_job_posted'              // Agent posts job for humans
    | 'human_job_applied'             // Human applies for job
    | 'human_job_accepted'            // Agent accepts human (triggers escrow)
    | 'human_job_delivered'           // Human delivers work
    | 'human_job_completed'           // Agent confirms completion
    | 'human_job_rated'               // Either party rates the other
    // Agent work product types (PE weight framework tiers)
    | 'agent_work_product'            // General work product (tier 3)
    | 'agent_work_product_code'       // Code written, committed, or deployed (tier 4)
    | 'agent_work_product_research'   // Research output produced (tier 4)
    | 'agent_work_product_analysis'   // Analysis output (tier 3)
    | 'agent_work_product_document'   // Document creation (tier 3)
    | 'agent_work_product_design'     // Design work (tier 3)
    | 'agent_work_product_data'       // Data processing or transformation (tier 3)
    | 'agent_work_product_other'      // Uncategorized work product (tier 2)
    // SDK-reported developer work types (git hooks, CLI)
    | 'coding_session'                // General coding session
    | 'refactor'                      // Code refactoring
    | 'test_run'                      // Test execution
    | 'deployment'                    // Deployment to staging/production
    | 'research'                      // Research activity
    | 'document'                      // Documentation written
    // Observer-generated types (process-level daemon)
    | 'compute_session'               // Observer-detected compute activity session (tier 1)
    | 'inference_session'             // LLM inference session with token consumption data (tier 2)
    | 'agent_tool_orchestration'      // Non-relay multi-tool agent run (from OTel plugin)
    // Human AI engagement capture (Phase 2b desktop, Phase 2c mobile wrapper)
    | 'ai_conversation'               // Observed human AI engagement session (tier 2)
    // Witness 3 - relay-witnessed external service events (push-with-signature, Tier A custody).
    // Permissionless namespaced types; auto-registered at runtime via pe_type_catalog.
    // Listed here for type-system visibility - connector code does not exist yet.
    | 'service:github_commit'         // GitHub App webhook push commit (tier 4, code work product)
    | 'service:github_pr_merged'      // GitHub App webhook PR merged (tier 4, code work product)
    | 'service_install_created'       // User installed a Tier A service connector (tier 3, infrastructure)
    | 'service_install_revoked'       // User revoked a Tier A service connector (tier 1, infrastructure)
    // Performance bond events (Phase 5)
    | 'bond_posted'                   // Agent posts PVT performance bond
    | 'bond_renewed'                  // Agent renews bond quarterly
    | 'bond_slashed'                  // Court slashes bond (agent at fault)
    | 'bond_withdrawn'                // Agent withdraws bond
    | 'bond_topped_up'                // Agent tops up bond to maintain minimum
    | 'bond_claim_filed'              // Claim filed against agent's bond (current emission)
    | 'bond_claim_resolved'           // Claim resolved by Court (current emission)
    | 'insurance_claim_filed'         // Legacy alias for bond_claim_filed (historical PEs)
    | 'insurance_claim_resolved'      // Legacy alias for bond_claim_resolved (historical PEs)
    | 'bond_abandonment_processed'    // Abandoned bond burned
    // Agent Insurance (post-launch, ProvianAgentInsurance contract not yet built).
    // Reserved here so the names cannot be name-squatted via permissionless registration.
    | 'agent_insurance_pool_created'      // Initial pool deployment / parameter set
    | 'agent_insurance_premium_paid'      // Agent pays premium into the pool
    | 'agent_insurance_payout_executed';  // Court verdict triggers a top-up payout above bond size

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'null_state';

// =============================================================================
// INTENT ORIGIN (Phase 1: Device-Attested Intent Binding)
// =============================================================================

/** Origin type for agent actions - tracks where the action was initiated from */
export type IntentOriginType = 'user_command' | 'agent_autonomous' | 'external_trigger';

/**
 * Cryptographic provenance of the user instruction that initiated an agent action.
 * Enables the approval UI to show whether an action traces back to a user command
 * or to external input (potential prompt injection vector).
 */
export interface IntentOrigin {
    /** SHA-256 hash of the originating user instruction */
    origin_hash: string;
    /** How this action was initiated */
    origin_type: IntentOriginType;
    /** Hash of the agent's reasoning chain from instruction to action */
    reasoning_chain_hash?: string;
    /** True if web scraping, email content, etc. influenced the reasoning chain */
    contains_external_input: boolean;
    /** Sources of external input (e.g., ["web:tripadvisor.com", "email:inbox"]) */
    external_input_sources?: string[];
}


// =============================================================================
// EGRESS DATA METADATA (Phase 2: Egress Authorization Gate)
// =============================================================================

/** Metadata for egress data flow provenance envelopes */
export interface EgressDataMetadata {
    /** Target domain (e.g., "api.example.com") */
    destination_domain: string;
    /** Target path (e.g., "/v1/data") */
    destination_path: string;
    /** HTTP method used */
    method: string;
    /** SHA-256 hash of the outbound payload */
    payload_hash: string;
    /** Size of outbound payload in bytes */
    payload_size_bytes: number;
    /** Categories of data being sent (e.g., ["business_data", "location"]) */
    data_categories: string[];
    /** Which allowlist rule matched (if any) */
    matched_allowlist_rule?: string;
    /** Why the request was blocked (if blocked) */
    blocked_reason?: string;
}

// =============================================================================
// ANOMALY DETECTION METADATA (Phase 3: Behavioral Anomaly Detection)
// =============================================================================

/** Metadata for anomaly detection provenance envelopes */
export interface AnomalyDetectionMetadata {
    /** Composite anomaly score (0-100) */
    anomaly_score: number;
    /** Additional risk points applied */
    risk_points_added: number;
    /** Top anomaly factors detected */
    top_factors: string[];
    /** Whether the request was reclassified by content analysis */
    reclassified?: boolean;
    /** Original type before reclassification */
    original_type?: string;
    /** PE chain analysis summary */
    chain_analysis_summary?: string;
}

// =============================================================================
// ENVIRONMENT ATTESTATION METADATA (Phase 4: Agent Environment Integrity)
// =============================================================================

/** State of the agent's configuration environment at attestation time */
export interface EnvironmentState {
    /** SHA-256 hash of the OpenClaw gateway configuration */
    config_hash: string;
    /** SHA-256 hash of sorted skill manifest (deterministic) */
    skills_hash: string;
    /** SHA-256 hash of the agent's system prompt */
    system_prompt_hash: string;
    /** SHA-256 hash of persistent memory/context (optional) */
    memory_hash?: string;
    /** Ordered list of installed skill names */
    installed_skills: string[];
    /** OpenClaw version string */
    openclaw_version: string;
    /** Timestamp of this attestation */
    last_attested: number;
}

/** Metadata for environment attestation provenance envelopes */
export interface EnvironmentStateMetadata {
    /** The full environment state snapshot */
    state: EnvironmentState;
    /** Whether drift from baseline was detected */
    drift_detected: boolean;
    /** Details of the drift (only present if drift_detected is true) */
    drift_details?: {
        /** Which fields changed */
        changed_fields: string[];
        /** Hash of the previous baseline state */
        previous_hash: string;
        /** Hash of the current state */
        current_hash: string;
    };
}

// =============================================================================
// AI CONVERSATION METADATA (Phase 2b desktop, Phase 2c mobile wrapper)
// =============================================================================

/**
 * Metadata shape for action_type="ai_conversation" PEs emitted from the mobile
 * Chat WebView surface.
 *
 * Source of truth: `provian-backend/src/routes/pe-submit-mobile-metadata.ts`
 * (AIConversationMetadata). The backend validator rejects any shape that
 * does not match this interface exactly. Field names, enum string values,
 * integer-non-negative constraints, and the 64-lowercase-hex fingerprint
 * pattern are load-bearing; see `openapi.ts` lines 37 to 129 for the
 * canonical schema.
 *
 * Never mutate without updating the backend validator in lockstep.
 */
export type AIConversationProvider =
    | 'claude'
    | 'chatgpt'
    | 'gemini'
    | 'perplexity'
    | 'grok'
    | 'venice';

export type AIConversationSurface =
    | 'desktop_foreground'
    | 'mobile_wrapper'
    | 'mobile_usage_stats';

export type AIConversationInputFidelity = 'full' | 'presence_only';

export interface AIConversationMetadata {
    provider: AIConversationProvider;
    surface: AIConversationSurface;
    duration_ms: number;
    active_duration_ms: number;
    turn_count: number;
    char_count: number;
    image_count: number;
    video_seconds: number;
    session_fingerprint_hash: string;
    input_fidelity: AIConversationInputFidelity;
}

export interface AgreementCreationDetails {
    description: string;
    partyA: string; // Creator
    partyB: string; // Counterparty
    settlementDue?: number;
}

export interface AgreementSettlementDetails {
    agreementId: string; // ID of the original agreement envelope
    settledBy: 'partyA' | 'partyB';
    settledAt: number;
}

export interface OfflineSettlementPayload {
    agreementId: string;
    settledBy: 'partyA' | 'partyB';
    settledAt: number;
    envelopeId: string;
    signature: string;
}

export type AgreementDetails = AgreementCreationDetails | AgreementSettlementDetails;

export type PromiseStatus = 'OPEN' | 'AWAITING_CONFIRMATION' | 'KEPT';

// Recovery Envelope Types
export interface RecoveryAttestation {
    deviceId: string;
    keyOrigin: 'secure_enclave' | 'strongbox' | 'tee' | 'software';
    platform: 'ios' | 'android';
    osIntegrity: boolean;
    appAuthentic: boolean;
    timestamp: number;
    signature: string;
}

export interface RecoveryEnvelopeDetails {
    recoveryId: string;
    tier: 'tier1_evm' | 'tier2_cloud';
    chain: 'evm';

    // Request
    requestedAt: number;
    passkeyCredentialId: string;
    attestation: RecoveryAttestation;

    // Outcome
    previousAddress?: string;
    newAddress?: string;
    sharesRotated?: boolean;    // For Tier 2

    // Integrity
    envelopeHash: string;
}

export interface RiskEvaluation {
    overallRisk: RiskLevel;
    score: number; // 0-100
    factors: {
        simulation?: { risk: RiskLevel; score: number; details: string };
        drainer?: { risk: RiskLevel; score: number; details: string };
        impersonation?: { risk: RiskLevel; score: number; details: string };
        approval?: { risk: RiskLevel; score: number; details: string };
        contract?: { risk: RiskLevel; score: number; details: string };
    };
    recommendedFriction: number; // 1-5
}

export interface OnRampQuote {
    provider: string;
    cryptoAmount: string;
    fiatAmount: string;
    fiatCurrency: string;
    fees: string;
    rate: string;
    kycRequired: boolean;
}

export interface HumanApprovalMetadata {
    agent_wallet_id: string;
    decision: 'approved' | 'rejected';
    subject_pe_id: string | null;
    subject_hash: string | null;
    // the approval request id (`apr_<32 hex>`), the mint-once anchor for the
    // human_approval mint. Optional — a null still records (fails closed to record_only).
    request_id?: string | null;
}

export interface ProvenanceEnvelope {
    envelope_id: string;
    prev_envelope_hash: string;
    timestamp: number;
    actor_address: string;
    chain_id: number | string;
    action_type: ActionType;
    intent_text: string;
    asset_symbol: string;
    amount: string;
    counterparty_address?: string;
    contract_address?: string;

    // Agreement Specifics
    agreement_details?: AgreementDetails;

    // Recovery Specifics
    recovery_details?: RecoveryEnvelopeDetails;

    // Agent Authorization (Provian gate)
    agent_id?: string;
    agent_action_type?: string;
    // 'agent_reported' [F15]: agent-asserted, not device-authorized/adjudicated.
    authorization_decision?: 'allow' | 'deny' | 'require_human' | 'agent_reported';
    authorization_reason_codes?: string[];
    authorization_human_required?: boolean;
    authorization_human_decision?: 'allow' | 'deny';
    authorization_stage?: 'request' | 'human_decision' | 'execution';  // [Fix 7] Added 'execution' for execution-stage denials
    authorization_request_id?: string;
    authorization_budget_id?: string | null;
    authorization_intent_id?: string | null;
    authorization_merchant?: string;
    authorization_purpose?: string;

    // Promise Negotiation
    negotiation_thread_id?: string;
    negotiation_offer_id?: string;
    negotiation_terms?: string; // JSON-serialized NegotiationTerms
    negotiation_counter_of?: string; // ID of promise being countered

    // Non-Financial Action Metadata
    communication_metadata?: {
        channel: string;
        recipient: string;
        subject?: string;
        isReply: boolean;
        platform?: string;
    };
    commitment_metadata?: {
        commitmentType: string;
        counterparty: string;
        description: string;
        isRevocable: boolean;
        financialImplication?: {
            amount: number;
            currency: string;
            timing: string;
        };
    };
    data_sharing_metadata?: {
        dataType: string;
        recipient: string;
        description: string;
        itemCount?: number;
        isRecoverable: boolean;
    };
    public_posting_metadata?: {
        platform: string;
        postType: 'reply' | 'new_post';
        contentPreview: string;
        wasEdited?: boolean;
    };
    system_access_metadata?: {
        operation: string;
        targetPath: string;
        description: string;
        requiresElevation: boolean;
    };
    uncategorized_metadata?: {
        actionType: string;
        description: string;
        riskLevel: string;
    };

    // Simulation & Policy
    simulation_summary?: string;
    risk_evaluation?: RiskEvaluation; // Replaces simple risk_score
    risk_score: number; // Kept for backward compatibility
    risk_category: RiskLevel;
    // 'none' [F15]: no device policy engine adjudicated this record (self-reported).
    policy_decision: 'allow' | 'override' | 'block' | 'none';

    // Intent Provenance (Phase 1: Device-Attested Intent Binding)
    intent_origin?: IntentOrigin;

    // Egress Data Flow (Phase 2: Egress Authorization Gate)
    egress_data_metadata?: EgressDataMetadata;

    // Anomaly Detection (Phase 3: Behavioral Anomaly Detection)
    anomaly_detection_metadata?: AnomalyDetectionMetadata;

    // Environment Attestation (Phase 4: Agent Environment Integrity)
    environment_state_metadata?: EnvironmentStateMetadata;

    // Corroboration Signal (automated third-party attestation)
    corroboration_metadata?: CorroborationSignalPEDetails;

    // Human approval (Trust Layer §2.10): the metadata-only approval reference the relay
    // validates for action_type === 'human_approval' — an agent wallet id, a decision code, and
    // an optional subject PE id / content hash. NEVER a note, title, or any free text.
    approval_metadata?: HumanApprovalMetadata;

    // Replication Pack (agent-generated verifiable work)
    replication_pack_metadata?: ReplicationPackPEDetails;

    // AI Conversation (Phase 2b desktop / 2c mobile wrapper capture)
    // Only populated when action_type === 'ai_conversation'. Shape must
    // match the backend validator byte-for-byte.
    ai_conversation_metadata?: AIConversationMetadata;

    // Goal Envelope (Policy Sandbox)
    goal_envelope_metadata?: {
        goal_id: string;
        outcome_description: string;
        budget_usd: number;
        spent_usd: number;
        remaining_usd: number;
        constraints: string[];
        status: string;
        parent_goal_pe_id?: string;
        violation_reason?: string;
    };

    // Promise Completion Premium
    /** True when this PE represents a bilaterally confirmed promise fulfillment */
    promise_completion_premium?: boolean;
    /** Promise ID for cross-referencing */
    promise_id?: string;

    // Anti-gaming tracking (populated by relay, not client)
    counterparty_type?: 'human' | 'agent' | 'external' | null;
    session_lineage?: string | null;
    self_referencing?: boolean;
    trust_level_at_creation?: 'ask' | 'approve' | 'trust' | null;

    // Security
    user_ack_hash?: string;
    device_attestation_id: string;
    /**
     * The ACTUAL attestation depth observed when this PE was created, derived
     * from KeyManager.performDeviceAttestation().isHardwareBacked — NOT inferred
     * from the mere presence of a device_attestation_id (a software-backed key
     * still has a deviceId). Submission uses this to avoid over-claiming
     * 'hardware'. Absent on legacy/queued PEs → treated as 'software'.
     */
    device_attestation_depth?: 'hardware' | 'software';
    origin_binding?: string; // dApp domain or session ID

    // Subscription
    subscription_state_snapshot: 'active' | 'inactive' | 'grace_period';

    // Flags
    null_state_flags: string[];

    // Signature
    signature?: string;

    // Display control - does NOT affect hash chain, PVT accrual, or trust scores
    hidden?: boolean;

    // Input Origins (Prompt 1: forward-only external-input provenance)
    // A list of the external artifacts this work consumed. Three states:
    // absent (key omitted / unobservable), present-empty ([], observed-none),
    // present-populated. PURE PROVENANCE — does NOT affect PVT accrual or the
    // sealed economic snapshot; it IS covered by the whole-object PE hash
    // (peHash.ts) like every other envelope field. Set only when observed, so an
    // absent PE hashes byte-identically to a pre-change one (forward-only).
    input_origins?: InputOrigin[] | null;

    // the on-chain transaction a confirmed send / swap produced (lowercased
    // 0x-hex). Set ONLY when the caller passed one, so every other PE hashes
    // byte-identically to a pre-change one. The relay queues it as a POINTER for
    // its chain-record lane, which derives the act from the chain alone.
    tx_hash?: string;

    // Energy Impact (AI Footprint module)
    // Does NOT affect hash chain, PVT accrual, or trust scores
    energy_estimate?: {
        estimatedWh: number;
        confidence: 'measured' | 'corroborated' | 'estimated' | 'inferred';
        method: string;
        estimatedCO2g?: number;
        providerAnnotation?: {
            reportedWh?: number;
            hardwareClass?: string;
            pue?: number;
            gridCarbonIntensityGCO2?: number;
            gridRegion?: string;
        };
    };
}

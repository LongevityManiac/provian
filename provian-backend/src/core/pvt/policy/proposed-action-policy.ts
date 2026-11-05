/**
 * Exhaustive atomic accounting launch action-policy proposal.
 *
 * Sources: 162 sanitized live cut-line entries, the 203-member mobile ActionType
 * union, the 154-member conformance catalog, and validated launch emitters that
 * were missing from all three lists. Entries are explicit; there is no runtime
 * category/default fallback. the operator approved these Gate 1 classifications in
 * plain English, but this file remains inert without later exact activation.
 */
import { PROPOSED_EVIDENCE_CLASS_BASES_BPS } from './evidence-class';
import type {
  ActionEvidenceRequirement,
  ActionPolicyCategory,
  ActionPolicyReasonCode,
  MintDisposition,
  ProposedActionPolicyEntry,
  ProposedActionPolicyManifest,
} from './types';

function proposedCategory(
  actionType: string,
  reasonCode: ActionPolicyReasonCode,
): ActionPolicyCategory {
  if (/^(court_|governance_|pvt_governance_)/.test(actionType)) return 'governance';
  if (/(communicate|public_post|social_|commons_post|commons_vote|commons_vouch)/.test(actionType)) {
    return 'social';
  }
  if (reasonCode === 'VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT') return 'financial';
  if (
    reasonCode === 'VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT'
    || reasonCode === 'RELAY_DRAFT_AWAITS_INDEPENDENT_EVIDENCE'
    // F-A7: the repriced draft rows keep the institutional category (they ARE
    // institution-lifecycle drafts) — record_only forces weight 0 regardless.
    || reasonCode === 'RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY'
    || reasonCode === 'PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR'
  ) return 'institutional';
  if (
    reasonCode === 'WORK_OR_COMPUTE_AWAITS_VERIFICATION'
    || reasonCode === 'VERIFIED_EXTERNAL_SERVICE_OUTCOME'
    || reasonCode === 'VERIFIED_SOVEREIGN_AGENT_WORK'
  ) return 'compute';
  if (reasonCode === 'VERIFIED_SUBSTANTIVE_OUTCOME') {
    return /^(agreement|escrow|promise|pool|job|human_job|goal_)/.test(actionType)
      ? 'institutional'
      : 'compute';
  }
  if (
    reasonCode === 'SYSTEM_BOOKKEEPING_NON_CIRCULAR'
    || reasonCode === 'GENESIS_VALID_RESERVATION_FIXED_GRANT'
    || reasonCode === 'STANDARD_WALLET_BIRTH_CERTIFICATE'
    || reasonCode === 'SETTLEMENT_SIGNAL_APPLIES_TO_TARGET'
  ) return 'infrastructure';
  if (
    reasonCode === 'SECURITY_POLICY_OR_IDENTITY_RECORD'
    || reasonCode === 'NON_POLICY_REGISTRY_REVIEW_REQUIRED'
    || reasonCode === 'DENIAL_FAILURE_EXPIRY_OR_NOOP'
  ) return 'security';
  return 'uncategorized';
}

function proposedBaseWeightBps(
  disposition: MintDisposition,
  category: ActionPolicyCategory,
  reasonCode: ActionPolicyReasonCode,
): number {
  if (disposition === 'record_only' || disposition === 'ineligible_terminal') return 0;
  if (reasonCode === 'GENESIS_VALID_RESERVATION_FIXED_GRANT') return 10_000;
  if (reasonCode === 'VERIFIED_EXTERNAL_SERVICE_OUTCOME') return 30_000;
  switch (category) {
    case 'financial': return 20_000;
    case 'governance': return 20_000;
    case 'social': return 5_000;
    case 'compute': return 10_000;
    case 'institutional': return 10_000;
    case 'security': return 5_000;
    case 'infrastructure': return 5_000;
    case 'uncategorized': return 0;
  }
}

function canonicalEventGroup(
  actionType: string,
  evidence: ActionEvidenceRequirement,
): string {
  switch (evidence) {
    case 'base_final_chain_receipt': return 'base_chain_financial_settlement';
    case 'valid_genesis_reservation':
      return `genesis_campaign_reservation:${actionType}`;
    case 'verified_institution_lifecycle': return 'institution_lifecycle_event';
    case 'verified_substantive_outcome': return 'substantive_outcome_event';
    case 'verified_compute_or_work': return 'verified_work_artifact';
    case 'verified_external_service_witness': return 'external_service_event';
    // : no named row carries this class today — the rail synthesizes it per type.
    case 'verified_witness_class': return `witness_class:${actionType}`;
    case 'operator_policy_review': return 'operator_reviewed_event';
    case 'none': return `record_only:${actionType}`;
  }
}

/**
 * (; completion earning built 2026-09-03): the FIVE
 * completion types whose session-lineage gate is lifted. A completion is
 * witnessed by its COUNTERPARTY — the poster's confirmation, verified against
 * the job document by the pending-evidence resolver (`completion-verifier.ts`),
 * or the on-chain escrow release the completion watcher observes — not by a
 * capture session of the deliverer's own machine, which is the off-chain-WORK
 * standard and does not belong on an act whose evidence is the other party. So
 * these rows become `session_lineage_policy: 'optional'` exactly as the
 * / relief did for the watcher-emitted and evidence-priced families;
 * disposition (`eligible`) and evidence requirement
 * (`verified_substantive_outcome`) are UNCHANGED, so nothing here prices a
 * self-report — a row still seals `pending_evidence` until the verifier binds
 * the confirmation. Named explicitly, not by reason code: `agreement_settled`
 * shares the class but was not in 's scope and has no verifier, so it
 * stays lineage-required (its 0 is unchanged either way).
 */
const COUNTERPARTY_COMPLETION_TYPES_LINEAGE_OPTIONAL: ReadonlySet<string> = new Set([
  'promise_fulfilled',
  'job_delivered',
  'human_job_delivered',
  'goal_envelope_completed',
  'human_job_completed',
]);

function entry(
  actionType: string,
  mintDisposition: MintDisposition,
  reasonCode: ActionPolicyReasonCode,
  evidenceRequirement: ActionEvidenceRequirement,
  fixedGrantSource: ProposedActionPolicyEntry['fixed_grant_source'],
): ProposedActionPolicyEntry {
  const category = proposedCategory(actionType, reasonCode);
  const isGenesis = fixedGrantSource === 'genesis_campaign_reservation';
  const isRecordOnly = mintDisposition === 'record_only';
  const completionLineageOptional =
    reasonCode === 'VERIFIED_SUBSTANTIVE_OUTCOME'
    && COUNTERPARTY_COMPLETION_TYPES_LINEAGE_OPTIONAL.has(actionType);
  // (supersedes the 3b / neutrality): the sovereign agent-key
  // binding and the forge HMAC webhook prove the claim is AUTHENTIC, not that
  // the work cost anything to fabricate — an ECDSA signature and a scripted
  // push are both negligible at volume. These two families therefore price on
  // the EVIDENCE axis instead of bypassing it: self-attested tiers (software /
  // software_verified / social) floor to 0 and seal record_only; genuinely
  // costly-to-forge external proof (hardware attestation, chain-verified
  // corroboration, third-party witness) keeps the family's flat 1.0x,
  // unchanged. Weight is untouched — flooring the family weight would kneecap
  // hardware-attested work exactly the way the removed volume caps did.
  const externalProofPriced =
    reasonCode === 'VERIFIED_SOVEREIGN_AGENT_WORK'
    || reasonCode === 'VERIFIED_EXTERNAL_SERVICE_OUTCOME';
  const financialAttestationNeutral =
    isGenesis
    || evidenceRequirement === 'base_final_chain_receipt'
    || reasonCode === 'VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT';
  return {
    action_type: actionType,
    category,
    base_action_weight_bps: proposedBaseWeightBps(mintDisposition, category, reasonCode),
    policy_override_bps: null,
    mint_disposition: mintDisposition,
    policy_review_state: 'not_required',
    reason_code: reasonCode,
    evidence_requirement: evidenceRequirement,
    financial_attestation_neutral: financialAttestationNeutral,
    attestation_pricing: externalProofPriced ? 'external_proof_priced' : 'standard',
    // An attestation-neutral row's mint does not depend on attestation depth, so
    // it must NOT also authorize a verified-attestation UPGRADE — that pair is a
    // contradiction validateActionPolicy rejects. An external-proof-priced row
    // must not either : its table is flat proof-or-zero, so a settlement
    // upgrade could never change value, and declaring dead authority is the same
    // contradiction. Funding/completion rows were already neutral via a
    // non-upgrade evidence class.
    allow_verified_attestation_upgrade:
      !financialAttestationNeutral
      && !externalProofPriced
      && (evidenceRequirement === 'verified_compute_or_work'
        || evidenceRequirement === 'verified_substantive_outcome'
        || evidenceRequirement === 'verified_external_service_witness'),
    canonical_event_required: evidenceRequirement !== 'none',
    canonical_event_group: canonicalEventGroup(actionType, evidenceRequirement),
    beneficial_ownership_policy: !isRecordOnly && !isGenesis
      ? 'record_only_if_self_shared_or_churn'
      : 'not_applicable',
    // The / session-lineage relief is RETAINED for the evidence-priced
    // families (a webhook or sovereign binding has no session): lineage stays
    // optional there even though the rows are no longer attestation-neutral.
    // extends the same relief to the five counterparty-witnessed
    // completion types (see COUNTERPARTY_COMPLETION_TYPES_LINEAGE_OPTIONAL).
    session_lineage_policy: isRecordOnly || isGenesis
      ? 'not_applicable'
      : (financialAttestationNeutral || externalProofPriced || completionLineageOptional
        ? 'optional'
        : 'required'),
    linkage_treatment: isGenesis
      ? 'genesis_contributor_only_no_linked_beneficiary_routing'
      : (isRecordOnly ? 'none_record_only' : 'record_time_verified_policy_multiplier'),
    amount_independent: true,
    fixed_grant_source: fixedGrantSource,
    evidence_resolution_mode: isGenesis || mintDisposition === 'pending_evidence'
      ? 'linked_evidence_pe_only'
      : (isRecordOnly || mintDisposition === 'ineligible_terminal'
        ? 'not_applicable'
        : 'projection_with_verified_evidence'),
  };
}

function walletBirthCertificateEntry(): ProposedActionPolicyEntry {
  return {
    ...entry(
      'wallet_created',
      'eligible',
      'STANDARD_WALLET_BIRTH_CERTIFICATE',
      'none',
      'none',
    ),
    // One base point is one PVT at a 1.0x mint rate. The birth certificate row
    // weight is 10.0x (100,000 bps). Its only emitter is human-owned, so the
    // human-linkage factor (2.0x) applies and the sealed record is 20 points at
    // novelty 1.0. It must not be inflated to manufacture the 75 PVT Genesis
    // signup grant that stacks beside it.
    base_action_weight_bps: 100_000,
    financial_attestation_neutral: true,
    allow_verified_attestation_upgrade: false,
    beneficial_ownership_policy: 'not_applicable',
    session_lineage_policy: 'optional',
  };
}

/**
 * human_approval MINTS at its evidence-class base, it is NOT
 * record_only. A biometric-signed human-wallet approval is a first-class WITNESSED human
 * act: `device_tier` at minimum, `hardware_rooted` (4.0×) when App Attest attaches (the
 * `withWitnessClassOverride` reprice, which only lifts an ELIGIBLE row — hence the record_only
 * pin had to come off). The row mirrors `classAdmittedAction('device_tier')` field-for-field so
 * it prices purely by its witness class ("no other pricing moves"): evidence IS the witness
 * class (`verified_witness_class`), standard evidence-axis pricing, base 10000 bps. The only
 * departure from a plain compute `entry()` is session lineage — a one-off biometric approval
 * has no session, exactly as an unnamed device_tier act is `optional`. Mint-once anchors on the
 * approval REQUEST id (the mobile overlay's `deviceWitnessedOccurrenceHash`), so re-sealing an
 * approval for the same request records for chain integrity but earns 0. This is not the
 * circular incentive the retired record_only comment feared: the approver is not paid a
 * settlement signal on the TARGET act — they are paid for their own witnessed act, once.
 */
function humanApprovalEntry(): ProposedActionPolicyEntry {
  return {
    ...entry('human_approval', 'eligible', 'WORK_OR_COMPUTE_AWAITS_VERIFICATION', 'verified_witness_class', 'none'),
    session_lineage_policy: 'optional',
  };
}

/**
 * COMMONS SPEECH MINTS at its evidence-class base. A forum post,
 * reply, vote, flag, challenge or challenge answer, a want post, a job post, and a thread message
 * are each a first-class WITNESSED act: the relay authenticated the author, checked the live
 * presentation window the act was written under (a presentation opens a voice — once per window, folded
 * onto the presentation, never stacked), and sealed the content hash — the `relay_verified`
 * witness class. The row mirrors {@link humanApprovalEntry} / `classAdmittedAction('relay_verified')`
 * field-for-field: evidence IS the witness class (`verified_witness_class`), standard
 * evidence-axis pricing, and the base is the CLASS base — `PROPOSED_EVIDENCE_CLASS_BASES_BPS.
 * relay_verified` (10,000 bps), read from the ONE class-base table and asserted equal by
 * `commons-speech-matrix.test.ts` never the social-category 5,000 the plain `entry()` would
 * derive. Session lineage is `optional` (speech has no capture session). Mint-once anchors on the
 * act's own id (post / vote / challenge / message id); the speech-window budget
 * (`core/pvt/speech-window-budget.ts`) bounds what one window can mint strictly below its burn.
 */
const SPEECH_WITNESS_CLASS_BASE_BPS: number = PROPOSED_EVIDENCE_CLASS_BASES_BPS.relay_verified;

function speechEntry(actionType: string): ProposedActionPolicyEntry {
  return {
    ...entry(actionType, 'eligible', 'WORK_OR_COMPUTE_AWAITS_VERIFICATION', 'verified_witness_class', 'none'),
    base_action_weight_bps: SPEECH_WITNESS_CLASS_BASE_BPS,
    session_lineage_policy: 'optional',
  };
}

/** The speech action types (every one priced by {@link speechEntry}). Exported for the test pin. */
export const COMMONS_SPEECH_ACTION_TYPES: readonly string[] = Object.freeze([
  'commons_post_created',
  'commons_post_replied',
  'commons_vote_cast',
  'commons_post_flagged',
  'commons_claim_challenged',
  'commons_challenge_answered',
  'commons_thread_message',
  'want_posted',
  'job_posted',
  'human_job_posted',
]);

/** Current launch emitters/aliases absent from the three catalog sources. */
export const VALIDATED_LAUNCH_EMITTER_ADDITIONS = [
  'agent_api_orchestration',
  'agent_evm_transaction',
  'agent_key_rotated',
  'agent_linked',
  'agent_linked_to_human',
  'agent_native_transfer',
  'agent_token_swap',
  'agent_unlinked_from_human',
  'agent_work_delegated',
  'agent_work_product',
  'agent_work_product_analysis',
  'agent_work_product_code',
  'agent_work_product_data',
  'agent_work_product_design',
  'agent_work_product_document',
  'agent_work_product_other',
  'agent_work_product_research',
  'agent_tool_orchestration',
  'ai_conversation',
  'bond_abandonment_processed',
  'bond_claim_filed',
  'bond_claim_resolved',
  'bond_claim_expired_processed',
  // bond lifecycle: truthful expiry record (autonomy drop) — distinct from the
  // abandonment burn mirror.
  'bond_expired_processed',
  'bond_posted',
  'bond_renewed',
  'bond_withdrawn',
  'commons_artifact_created',
  'commons_artifact_updated',
  'commons_artifact_deprecated',
  'commons_artifact_invoked',
  'commons_artifact_attested',
  // `commons_challenge_escalated` retired (see RETIRED_MATRIX_ACTION_TYPES);
  // `commons_challenge_answered`, `commons_thread_message`, `commons_featured_placement` and the
  // three `want_*` types added (relay emitters, absent from the three catalogs).
  'commons_challenge_answered',
  'commons_challenge_resolved',
  'commons_claim_challenged',
  'commons_featured_placement',
  'commons_pe_published',
  'commons_post_flagged',
  'commons_profile_created',
  'commons_thread_message',
  'commons_verification_upgraded',
  'commons_vote_cast',
  'commons_vouch_given',
  'commons_vouch_received',
  'commons_post_created',
  'commit',
  'communicate',
  'compute_session',
  'egress_data',
  'human_job_accepted',
  'human_job_applied',
  'human_job_completed',
  'human_job_delivered',
  'human_job_posted',
  'human_job_rated',
  'inference_session',
  // the Stripe Link spend witness (SDK recordLinkSpend + the transcript lane).
  'link_spend',
  'pool_withdrawn',
  'promise_deleted',
  'provisional_wallet_claimed',
  'proxied_api_payment',
  'public_post',
  'purchase',
  'service:gitlab_push',
  'service:gitlab_mr_merged',
  'service:bitbucket_push',
  'service:bitbucket_pr_merged',
  'service:github_commit',
  'service:github_pr_merged',
  'service_install_created',
  'service_install_revoked',
  'share_data',
  'spending',
  'system_access',
  'transfer',
  'uncategorized',
  'want_cancelled',
  'want_fulfilled',
  'want_posted',
] as const;

/**
 * action types RETIRED from the matrix — they
 * deliberately have NO policy row and mint nothing. These six are aliases of the
 * retired 2026-07 Genesis bounty ladder (`agent_*`/`wallet_*`
 * funded/first-transaction/sustained-activity). The acts they named are already
 * paid ONCE on the chain-verified `receive`/`send`/transfer paths, so a matrix
 * row for them would be a second-pay row for an already-paid act. Nothing live
 * emits them: the legacy scheduler routes are hard no-ops, and `payGenesisBounty`
 * zeros every `RETIRED_GENESIS_ACTION_TYPES` member.
 *
 * They are removed from the live catalogs (the mobile `ActionType` union, the
 * conformance catalog, `VALIDATED_LAUNCH_EMITTER_ADDITIONS`), but they REMAIN in
 * the frozen atomic accounting cut-line snapshot (`pe-type-catalog.cut-line.json`, a historical
 * capture pinned to a Base block — never falsified) and in
 * `RETIRED_GENESIS_ACTION_TYPES` (the payout-boundary guard, which also covers the
 * KEPT `agent_wallet_created`). The matrix generator subtracts THIS set from the
 * coverage `required` union so a deleted row keeps the emitter→row guard green,
 * and it THROWS if a live property-literal emitter ever reappears for one of them
 * (the item-2 STOP) — the exclusion never silently masks a real emitter.
 */
export const RETIRED_MATRIX_ACTION_TYPES: readonly string[] = Object.freeze([
  'agent_first_transaction',
  'agent_sustained_activity',
  'agent_wallet_funded',
  'wallet_first_transaction',
  'wallet_funded',
  'wallet_sustained_activity',
  // the forum's Court escalation is gone — a challenge resolves by
  // burn-to-present (the author presents against the challenger's predicate), never by a Court
  // panel. The escalation emitter and its route were deleted; the type keeps no row.
  'commons_challenge_escalated',
]);

export const PROPOSED_ACTION_POLICY_ENTRIES: readonly ProposedActionPolicyEntry[] = [
  entry("REVOKE_APPROVAL", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("agent_action", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  // the Stripe Link spend WITNESS. An agent completed a purchase
  // through Link's wallet for agents; Provian records the spend-request RECORD after
  // the fact (never approves, never holds a credential). Eligible at observer-family
  // parity with agent_action: the witness is the agent's own submission signature
  // (device body-binding / sovereign EOA); mint-once anchors on Link's `lsrq_` id;
  // only a SUCCEEDED spend is stamped verified (link-spend-witness.ts).
  entry("link_spend", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_api_orchestration", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_authorization", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_capabilities_registered", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_commit", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("agent_communicate", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_compute_market", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("agent_court", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_ecosystem_uncategorized", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_evm_transaction", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("agent_governance", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_insurance_payout_executed", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("agent_insurance_pool_created", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("agent_insurance_premium_paid", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("agent_invite_sent", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_key_rotated", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_labor_market", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("agent_linked", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_linked_to_human", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_marketplace", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("agent_native_transfer", "eligible", "VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT", "base_final_chain_receipt", "none"),
  entry("agent_public_post", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_reputation_system", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_session_revoked", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("agent_session_started", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_session_suspended", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("agent_share_data", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_sub_spawned", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_system_access", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_task_completed", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_token_swap", "eligible", "VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT", "base_final_chain_receipt", "none"),
  entry("agent_token_transfer", "eligible", "VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT", "base_final_chain_receipt", "none"),
  entry("agent_tool_orchestration", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_transaction_reported", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("agent_transaction_synced", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("agent_uncategorized", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_unlinked_from_human", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("agent_wallet_created", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  // F-A6-1 (; confirmed 2026-09-04): the delegation-credit PE is
  // a relay-generated provenance record of DIRECTION ("I directed this work"), not
  // the work itself — the 80/20 beneficiary split is the PVT. It mints 0 and cannot
  // circularly mint, so it is record_only system bookkeeping. Moved eligible →
  // record_only; the matrix + monetary template digest re-pin under this move.
  entry("agent_work_delegated", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("agent_work_product", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_work_product_analysis", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_work_product_code", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_work_product_data", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_work_product_design", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_work_product_document", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_work_product_other", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agent_work_product_research", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("agreement", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("agreement_settled", "eligible", "VERIFIED_SUBSTANTIVE_OUTCOME", "verified_substantive_outcome", "none"),
  entry("ai_conversation", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("anomaly_detected", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("approve", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("badge_earned", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("behavior_baseline_updated", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  // Trust Layer build §2.12 : the BondPool / CourtV2 CHAIN-WITNESSED Standing rows
  // (institution-standing-watcher.ts). Every one is record_only by construction — Standing is
  // a live query over these records; the watcher never mints (run-log ).
  entry("bond_abandoned", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_abandonment_processed", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_autonomy_downgraded", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_claim_closed_unadjudicated", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_claim_dismissed", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_claim_expired", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_claim_expired_processed", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  // bond lifecycle: the scheduler's expiry record (off-chain autonomy drop; no value moves).
  entry("bond_expired_processed", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_claim_filed", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_claim_resolved", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_posted", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_renewed", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_slashed", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_topped_up", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("bond_withdrawn", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("burn_spam", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("classification_reclassified", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("code", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("coding_session", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("commit", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("commons_artifact_attested", "record_only", "SETTLEMENT_SIGNAL_APPLIES_TO_TARGET", "none", "none"),
  entry("commons_artifact_created", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("commons_artifact_deprecated", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("commons_artifact_invoked", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("commons_artifact_updated", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  // the author's answer to a challenge — a presentation against the challenger's predicate.
  speechEntry("commons_challenge_answered"),
  // `commons_challenge_escalated` is RETIRED (the Court escalation path is out of the
  // forum; challenges resolve by burn-to-present) — see RETIRED_MATRIX_ACTION_TYPES.
  entry("commons_challenge_resolved", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  speechEntry("commons_claim_challenged"),
  // a featured-placement bid is a PVT-cost event (a burn buys the slot) — circular, mints 0.
  entry("commons_featured_placement", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("commons_pe_published", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  speechEntry("commons_post_created"),
  speechEntry("commons_post_flagged"),
  speechEntry("commons_post_replied"),
  entry("commons_profile_created", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  // every thread message (text, presentation request, presentation, deliverable) is speech.
  speechEntry("commons_thread_message"),
  entry("commons_verification_upgraded", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  speechEntry("commons_vote_cast"),
  entry("commons_vouch_given", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("commons_vouch_received", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("communicate", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("compute_session", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("corroboration_signal", "record_only", "SETTLEMENT_SIGNAL_APPLIES_TO_TARGET", "none", "none"),
  // Trust Layer build §2.12 : CourtV2 arbitrator-seat Standing rows (chain-witnessed, record_only).
  entry("court_arbitrator_collateral_posted", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_arbitrator_collateral_slashed", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_arbitrator_reward_paid", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_arbitrator_seat_forfeited", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_escalated", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_evidence_submitted", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_general_dispute_filed", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_general_dispute_resolved", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_majority_bonus", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_minority_vote", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_panel_assigned", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_verdict", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("court_vote_cast", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("credential_added", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("credential_deleted", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("credential_frozen", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("credential_injected", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("credential_release_expired", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("credential_release_used", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("credential_released", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("credential_unfrozen", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("credential_updated", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("deployment", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("device_register", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("device_revoke", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("document", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("egress_data", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("egress_data_approved", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("egress_data_blocked", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("egress_data_denied", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("egress_data_executed", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("egress_data_requested", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("emergency_stop", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("environment_attestation", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("environment_drift_detected", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("escrow_completed", "eligible", "VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT", "verified_institution_lifecycle", "none"),
  entry("escrow_created", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  // (; parity ruled 09-12): a dispute raised on the escrow
  // contract is a canonical on-chain event of the same family as its resolution, so
  // `escrow_disputed` earns at parity with `escrow_resolved` — same evidence class,
  // same base. It is now CHAIN-WITNESSED: the institution completion watcher observes
  // the on-chain `EscrowDisputed(bytes32)` event (`institution-completion-watcher.ts`)
  // and seals the PE with a verified canonical event, and the depositor's self-report
  // draft emission in `disputeEscrow()` (agent-bank/escrow.ts) is RETIRED. It is no
  // longer a relay-draft self-report, so it leaves `INSUFFICIENT_LAUNCH_JUSTIFICATION`.
  entry("escrow_disputed", "eligible", "VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT", "verified_institution_lifecycle", "none"),
  entry("escrow_funded", "eligible", "VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT", "verified_institution_lifecycle", "none"),
  entry("escrow_resolved", "eligible", "VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT", "verified_institution_lifecycle", "none"),
  entry("export_logs", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("external_address_proven", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("friction_escalation", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("genesis_device_link", "eligible", "GENESIS_VALID_RESERVATION_FIXED_GRANT", "valid_genesis_reservation", "genesis_campaign_reservation"),
  entry("genesis_human_signup", "eligible", "GENESIS_VALID_RESERVATION_FIXED_GRANT", "valid_genesis_reservation", "genesis_campaign_reservation"),
  entry("genesis_signup", "eligible", "GENESIS_VALID_RESERVATION_FIXED_GRANT", "valid_genesis_reservation", "genesis_campaign_reservation"),
  entry("goal_action_auto_approved", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("goal_action_taken", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("goal_constraint_violation", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("goal_envelope_approved", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("goal_envelope_cancelled", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("goal_envelope_completed", "eligible", "VERIFIED_SUBSTANTIVE_OUTCOME", "verified_substantive_outcome", "none"),
  entry("goal_envelope_created", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("goal_envelope_expired", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("goal_envelope_rejected", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("governance_premint_weight_set", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("governance_proposal_cancelled", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("governance_proposal_created", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("governance_proposal_executed", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("governance_vote_cast", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  // a HUMAN APPROVAL PE MINTS at its witness-class base (see
  // humanApprovalEntry above) — device_tier at minimum, hardware_rooted (4.0×) on App Attest,
  // mint-once on the approval request id. Superseded the record_only pin.
  humanApprovalEntry(),
  entry("human_job_accepted", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("human_job_applied", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("human_job_completed", "eligible", "VERIFIED_SUBSTANTIVE_OUTCOME", "verified_substantive_outcome", "none"),
  entry("human_job_delivered", "eligible", "VERIFIED_SUBSTANTIVE_OUTCOME", "verified_substantive_outcome", "none"),
  // (09-11 rule; was the unsigned fallback, never a ruling): the
  // hiring-board payout is the on-chain EscrowReleased of the job's escrow, which the
  // institution-completion watcher already mints as `escrow_completed` (recipient earns); the
  // work itself mints on `human_job_delivered`. This job-settlement record (job-settlement.ts
  // settleLinkedHumanJob) is the settlement signal — record_only at parity with `job_completed`.
  entry("human_job_payment_released", "record_only", "SETTLEMENT_SIGNAL_APPLIES_TO_TARGET", "none", "none"),
  // a job post is Commons speech, written under a live presentation window.
  speechEntry("human_job_posted"),
  entry("human_job_rated", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  // (09-11 rule): the refund sibling emitted by the same settlement call. The
  // refund is the on-chain EscrowResolved, minted as `escrow_resolved` (value-receiver earns).
  entry("human_job_refunded", "record_only", "SETTLEMENT_SIGNAL_APPLIES_TO_TARGET", "none", "none"),
  entry("human_linked_agent", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("inference_session", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("insurance_claim_filed", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("insurance_claim_resolved", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("invite_accepted", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("job_accepted", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("job_applied", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  // Trust Layer build §2.12 : the Jobs witness is the escrow-release JOIN in the completion
  // watcher — the on-chain release of the job's escrow lands this chain-witnessed outcome record.
  // record_only: the escrow row already mints the value (no double mint; run-log ).
  entry("job_completed", "record_only", "SETTLEMENT_SIGNAL_APPLIES_TO_TARGET", "none", "none"),
  entry("job_delivered", "eligible", "VERIFIED_SUBSTANTIVE_OUTCOME", "verified_substantive_outcome", "none"),
  // a job post is Commons speech, written under a live presentation window.
  speechEntry("job_posted"),
  // (09-11 rule): agent-board refund settlement record (job-settlement.ts
  // settleLinkedAgentJob); the refund itself mints as `escrow_resolved`.
  entry("job_refunded", "record_only", "SETTLEMENT_SIGNAL_APPLIES_TO_TARGET", "none", "none"),
  entry("negotiation_expired", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("negotiation_rejected", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("onramp", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("onramp_order", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("pe_type_proposed", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("policy_created", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("policy_updated", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("pool_contributed", "eligible", "VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT", "verified_institution_lifecycle", "none"),
  entry("pool_created", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("pool_executed", "eligible", "VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT", "verified_institution_lifecycle", "none"),
  entry("pool_refunded", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("pool_withdrawn", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("promise_accepted", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("promise_broken", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("promise_countered", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("promise_created", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("promise_defaulted", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("promise_deleted", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("promise_disputed", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("promise_fulfilled", "eligible", "VERIFIED_SUBSTANTIVE_OUTCOME", "verified_substantive_outcome", "none"),
  entry("promise_funded", "eligible", "VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT", "verified_institution_lifecycle", "none"),
  entry("promise_negotiation_accepted", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("promise_negotiation_expired", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("promise_negotiation_rejected", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("promise_offered", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("promise_settled", "eligible", "VERIFIED_INSTITUTION_LIFECYCLE_AMOUNT_INDEPENDENT", "verified_institution_lifecycle", "none"),
  entry("provisional_wallet_claimed", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("public_post", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("proxied_api_payment", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("proxied_payment_approved", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("proxied_payment_executed", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("proxied_payment_failed", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("proxied_payment_requested", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("purchase", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("pvt_batch_minted", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_badge_projection_completed", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_burned_voluntary", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_epoch_advanced", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_fee_burned", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_governance_proposed", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_governance_voted", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_pe_anchored", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_reputation_slashed", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_reputation_staked", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_reputation_unstaked", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_retroactive_transfer", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("pvt_surplus_transfer", "record_only", "SYSTEM_BOOKKEEPING_NON_CIRCULAR", "none", "none"),
  entry("receive", "eligible", "VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT", "base_final_chain_receipt", "none"),
  entry("recovery_action", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("recovery_complete", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("recovery_init", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("recurring_payment_run", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("refactor", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("replication_pack", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("request_auto_approved", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("request_expired", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("research", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("send", "eligible", "VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT", "base_final_chain_receipt", "none"),
  entry("service:bitbucket_pr_merged", "eligible", "VERIFIED_EXTERNAL_SERVICE_OUTCOME", "verified_external_service_witness", "none"),
  entry("service:bitbucket_push", "eligible", "VERIFIED_EXTERNAL_SERVICE_OUTCOME", "verified_external_service_witness", "none"),
  entry("service:github_commit", "eligible", "VERIFIED_EXTERNAL_SERVICE_OUTCOME", "verified_external_service_witness", "none"),
  entry("service:github_pr_merged", "eligible", "VERIFIED_EXTERNAL_SERVICE_OUTCOME", "verified_external_service_witness", "none"),
  entry("service:gitlab_mr_merged", "eligible", "VERIFIED_EXTERNAL_SERVICE_OUTCOME", "verified_external_service_witness", "none"),
  entry("service:gitlab_push", "eligible", "VERIFIED_EXTERNAL_SERVICE_OUTCOME", "verified_external_service_witness", "none"),
  entry("service_install_created", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("service_install_revoked", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("share_data", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("skill_install_requested", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("social_post_approved", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("social_post_denied", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("spending", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("stake", "record_only", "PVT_COST_LOCK_BURN_OR_BOND_NON_CIRCULAR", "none", "none"),
  entry("swap", "eligible", "VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT", "base_final_chain_receipt", "none"),
  entry("system_access", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("system_access_approved", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("system_access_denied", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("test_run", "eligible", "VERIFIED_SOVEREIGN_AGENT_WORK", "verified_compute_or_work", "none"),
  entry("transfer", "record_only", "RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY", "none", "none"),
  entry("uncategorized", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("uncategorized_action_approved", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("uncategorized_action_denied", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("vouch_for_device", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  walletBirthCertificateEntry(),
  // the wants board's PEs — a want post is Commons speech (it MINTS; the former
  // record-only 0-PVT posture is superseded); cancel/fulfil are status records: a cancel is a
  // no-op, and a fulfilment's value lands on the linked job's completion path.
  entry("want_cancelled", "record_only", "DENIAL_FAILURE_EXPIRY_OR_NOOP", "none", "none"),
  entry("want_fulfilled", "record_only", "SETTLEMENT_SIGNAL_APPLIES_TO_TARGET", "none", "none"),
  speechEntry("want_posted"),
  entry("webhook_subscribed", "record_only", "SECURITY_POLICY_OR_IDENTITY_RECORD", "none", "none"),
  entry("x402_payment", "eligible", "VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT", "base_final_chain_receipt", "none"),
];

export const PROPOSED_ACTION_POLICY_MANIFEST: ProposedActionPolicyManifest = {
  schema_version: 'pvt-action-policy/v1',
  policy_version: 'base-mainnet-launch-proposal-2026-07-13.1',
  status: 'gate_1_plain_english_approved',
  effective_at: null,
  classification_effect: 'prospective_only_no_retroactive_repricing',
  unknown_action_policy: {
    admission: 'record_only_until_signed_row',
    mint_disposition: 'record_only',
    policy_review_state: 'class_admitted',
    reason_code: 'witness_class_admitted',
    queued_from: 'witnessed_class_only',
    earns_from: 'signed_row_effective_at',
    without_witness_class_or_readable_pointer: {
      mint_disposition: 'record_only',
      policy_review_state: 'pending_policy',
      reason_code: 'unknown_action_type',
    },
  },
  entries: PROPOSED_ACTION_POLICY_ENTRIES,
};

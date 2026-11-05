import { prepareLocationCopyFence } from './core/jurisdiction/location-copy-erasure';
import { planComplianceRetention, prepareComplianceRetention } from './core/jurisdiction/location-retention';
import { isTerminalCompliance } from './core/jurisdiction/compliance-state';
import { complianceForRow, isMintComplianceEvidence, type MintCompliance } from './core/jurisdiction/mint-compliance';
import type { BatchPricingCounters } from './core/meter/batch-pricing-counters';
/**
 * PE History Storage
 *
 * Writes PE history documents to a dedicated Firestore collection on every PE creation.
 * Separate from the immutable provenance_envelopes collection - pe_history contains
 * PVT-specific derived fields (category, estimatedPVT) and supports efficient
 * paginated queries for the dashboard.
 *
 * Document ID matches the PE ID for O(1) lookup and hidden flag sync.
 */

import type { OutputDigest } from './core/provenance/output-digests';
import { relayDb } from './firestore-db';
import type { PVTCategory } from './pvt-accrual';

import {
  canTransitionMintDisposition,
  hashRecordEconomicSnapshot,
  type MintDisposition,
  type MintReasonCode,
  type EligibilityProjection,
  type PolicyReviewReasonCode,
  type PolicyReviewState,
  type RecordEconomicSnapshot,
} from './core/pvt/policy/monetary-accounting';
import {
  finalizePendingPolicyObservation,
  upsertPendingPolicyObservationInTransaction,
  type PendingPolicyAlertSender,
  type PendingPolicyObservation,
  type PendingPolicyObservationResult,
} from './core/pvt/policy/pending-policy-queue';
import {
  DURABLE_ACCRUAL_EFFECTS_COLLECTION,
  type DurableAccrualEffectDocument,
} from './core/pvt/durable-accrual-effects';
import type {
  PendingCacheNoveltyCorrection,
  PendingCacheRateLimitEvidence,
} from './core/pvt/pending-cache-resolution';
import {
  applyMintOnceClaimDecision,
  assertMintOnceClaimEvidence,
  hashMintOnceClaimEvidence,
  inspectPreparedMintOnceClaimInTransaction,
  type MintOnceClaimEvidence,
  type MintOnceClaimTransactionDecision,
  type PreparedMintOnceClaim,
} from './core/pvt/mint-once-claim';
import {
  COMMIT_CROSS_WITNESS_CORROBORATION_STATUS,
  applyCommitTakeoverDecision,
  demotedIncumbentRow,
  inspectPreparedCommitTakeoverInTransaction,
  type CommitTakeoverDecision,
} from './core/pvt/commit-takeover';
import {
  applyCompletionTakeoverDecision,
  demotedCompletionIncumbentRow,
  inspectPreparedCompletionTakeoverInTransaction,
  type CompletionTakeoverDecision,
} from './core/pvt/completion-takeover';
import type { CompletionWitness } from './core/pvt/completion-claim';
import {
  ECONOMIC_AGGREGATE_SCHEMA_VERSION,
  EconomicAggregateWriter,
  PE_HISTORY_AGGREGATE_MARKER_FIELD,
} from './core/pvt/policy/economic-aggregate';
import { PE_HISTORY_INDEX_SHARD_FIELD, peHistoryIndexShard } from './core/pvt/pe-history-index-shard';
import { incrementConsoleDispositionRollupInTransaction } from './core/pvt/disposition-rollup';
import { readOpsPolicyThresholds } from './core/meter/diagnostic-thresholds';
import { buildPeBugSignal, PE_BUG_SIGNAL_COLLECTION } from './core/meter/diagnostic-signals';

// =============================================================================
// TYPES
// =============================================================================

export interface PEHistoryDocument {
  peId: string;
  userId: string;
  timestamp: number;
  actionType: string;
  category: PVTCategory;
  attestationDepth: string;
  contributionValue: number;    // Always 1.0 for Phase 1
  estimatedPVT: number;         // After category × attestation multipliers
  peHash: string;
  inputSummary: string | null;  // E.g., "Agent Atlas: Buy headphones on Amazon"
  outputSummary: string | null; // E.g., "Approved, $49.99 deducted from budget"
  hidden: boolean;              // Mirrors PE hidden flag, default false
  // 'skipped_no_output' - terminal state for compute_session PEs submitted with
  // null_state_flags: ['no_observable_output']. The PE stays in the chain for
  // integrity but the relay refuses to mint PVT for it (see observer output gate).
  // 'pending_cache' - H-6 (audit 2026-05-11): the cache (Upstash Redis) was
  // unavailable when this PE was recorded, so per-user rate-limit counters
  // could not be checked and accrual was skipped. NOT terminal - the
  // pending-cache backfill scheduler reclassifies these to 'eligible' or
  // 'ineligible' once the cache is healthy. Distinct from 'ineligible' which
  // IS terminal (see CLAUDE.md Pitfall #45).
  // 'corroborated_duplicate' - terminal state for a PE that witnesses a commit
  // already claimed by a prior PE (cross-witness dedup: e.g. a forge webhook
  // PE for a commit the local observer already recorded, or vice versa). The
  // PE stays in the chain for integrity and still corroborates the original,
  // but does not mint - the commit mints exactly once (see commit-mint-claim).
  // 'beneficiary_pending' - NOT terminal. A linked-agent PE carrying a
  // pvt_split whose human beneficiary address could not be resolved at mint
  // time. Moved out of the 'eligible' window so it cannot head-of-line-block
  // newer mintable PEs (the minting query is a fixed timestamp-ordered limit
  // with no cursor). The retired PVTv8 minting engine re-checked these at the
  // start of each run and flipped them back to 'eligible' once the beneficiary
  // address resolved; metered held acts are restored by held-act-recovery.ts.
  // The human's share is NEVER rerouted to the agent.
  // 'farm_capped' - terminal-no-mint for a Financial PE that hit a standing
  // anti-farm rule (dust floor / unverifiable counterparty / per-actor daily
  // ceiling; see activity-mint-limits.ts). The PE records as provenance but mints 0 PVT.
  // Distinct from 'ineligible' on purpose: it is NOT a compliance / rate-limit
  // verdict, so it never pollutes those metrics, and settlement simply never
  // sees it (it reads only 'eligible').
  // 'x402_unverified' - an x402_payment self-report with no verifiable on-chain
  // settlement tx. Records provenance but mints 0 PVT and does not move x402
  // reputation: only a chain-verified settlement earns ("Unknown = Block").
  mint_status:
    | 'eligible'
    | 'minting'
    | 'record_only'
    | 'pending_evidence'
    | 'pending_review'
    | 'deferred'
    | 'minted'
    | 'ineligible'
    | 'skipped_no_output'
    | 'pending_cache'
    | 'pending_compliance'
    | 'corroborated_duplicate'
    | 'beneficiary_pending'
    | 'genesis_epoch_deferred'
    | 'epoch_headroom_deferred'
    | 'settlement_retry_deferred'
    | 'farm_capped'
    | 'x402_unverified';
  /** Atomic mint-claim ownership. Present while minting and retained after mint. */
  mint_claim_id?: string | null;
  mint_claim_owner_id?: string | null;
  mint_fencing_token?: number | null;
  /** Last released claim, retained only for reconciliation/audit. */
  last_mint_claim_id?: string | null;
  /** atomic accounting economic eligibility state, separate from policy-review workflow. */
  mint_disposition: MintDisposition;
  /** Stable, machine-readable explanation for mint_disposition. */
  disposition_reason_code: MintReasonCode;
  /** atomic accounting action-policy review state; never inferred from mint_status. */
  policy_review_state: PolicyReviewState;
  /** Stable, machine-readable explanation for policy_review_state. */
  policy_review_reason_code: PolicyReviewReasonCode;
  /** Policy version selected prospectively at PE record time. */
  economic_policy_version: string;
  /** Exact immutable record-time economics. Never null for an eligible PE. */
  economic_snapshot: RecordEconomicSnapshot | null;
  /** Commitment sealed alongside the snapshot and checked again at mint time. */
  economic_snapshot_hash: string | null;
  /** Immutable evidence authorizing a recoverable record-time hold to resolve. */
  economic_eligibility_projection: EligibilityProjection | null;
  /** Durable facts that must exactly rebind a pending-cache projection at mint. */
  pending_cache_reclassified_at?: number;
  pending_cache_outcome?: string;
  pending_cache_rate_limit_evidence?: PendingCacheRateLimitEvidence;
  /** audit record of a novelty-corrected recovery (sealed snapshot untouched). */
  pending_cache_novelty_correction?: PendingCacheNoveltyCorrection;
  /** Exact record points, regardless of a recoverable non-economic hold. */
  record_points_atomic: string;
  /** Current dashboard/mint projection; zero unless presently eligible. */
  estimated_pvt_atomic: string;
  jurisdiction_context: string;       // Relay-observed country or held jurisdiction; empty means unresolved.
  jurisdiction_region?: string | null;
  jurisdiction_compliance_reason?: string;
  jurisdiction_mint_held?: boolean;
  deferred_since: number | null;      // Unix ms - when deferral began. null if not deferred.
  mint_batch_id?: string;       // Set when mint_status transitions to 'minted'
  minted_at?: number;           // Set when mint_status transitions to 'minted'
  tx_hash?: string;             // On-chain tx hash (for corroboration verification)
  // commit SHA (display/grouping key). Present on commit-family PEs
  // (coding_session / service:github_commit / corroboration_signal) that carried
  // metadata.commit_sha; null otherwise. Display-only — not in economic_snapshot.
  commit_sha?: string | null;
  // ops-dashboard build: the capture lane that produced this PE (display/grouping
  // key, same posture as commit_sha). The AUTHORITATIVE copy is sealed in
  // economic_snapshot.recordTimeFactors.captureLane; this top-level mirror lets the
  // ops collectors read the lane from a cheap projected scan. Never a pricing input.
  capture_lane?: string | null;

  /**
   * the job completion this row is a WITNESS of, when it is one.
   * `completion_canonical_id` is the `completion` mint-once claim key
   * (`core/pvt/completion-claim.ts`); `completion_witness` says which of the two
   * witnesses this row is: the watcher's on-chain escrow release, or the
   * resolver-promoted off-chain counterparty confirmation. The settlement inlet
   * defers an off-chain row while its 72h takeover window is open
   * (`completionTakeoverWindowOpen`), exactly as it defers a commit-bearing row.
   * Mutable enrichment — NOT part of the sealed economic_snapshot.
   */
  completion_canonical_id?: string | null;
  completion_witness?: CompletionWitness | null;
  /** the instant the resolver promoted this off-chain witness. */
  completion_resolved_at_ms?: number | null;
  /** audit trail of a completion takeover that demoted this row. */
  completion_takeover_demoted_by_pe_id?: string | null;
  completion_takeover_demoted_at_ms?: number | null;

  // Audit window (for software-attested PEs)
  audit_hold: boolean;              // true = held from minting until audit window expires or corroboration arrives
  audit_window_expires_at: number | null;  // ms timestamp; null for hardware/on-chain PEs

  // Corroboration
  corroboration_status:
    | 'none'
    | 'on_chain_verified'
    | 'merchant_confirmed'
    | 'peer_verified'
    | 'service_grant_attested'; // Witness 3 cross-witness corroboration (e.g. GitHub App webhook)
  corroboration_source: string | null;  // tx_hash, commerce_signal_id, peer_agent_id etc.
  corroboration_received_at: number | null;

  // Beneficiary split (for linked agent PEs)
  attestation_verified: boolean;           // Server verified attestation depth against device/wallet registration
  /**
   * How the act reached the relay, stated rather than inferred. Optional: most records predate
   * it and `classifySubmissionProvenance` derives the same answer from `attestation_verified`
   * plus the envelope's `integration_source`. A writer that states it must never state
   * `earner_signed` for an act the relay authored — that combination is reported as
   * `contradictory` and refused. See `core/pvt/wp-ev/submission-provenance.ts`.
   */
  submission_provenance?: 'earner_signed' | 'server_authored';
  beneficiary_wallet_id: string | null;   // Human wallet receiving surplus PVT
  pvt_split: {
    total: number;
    agent_share: number;
    human_share: number;
    ratio: number;
  } | null;
  /** Exact human recipient binding; legacy split fields alone are never authority. */
  beneficiary_routing_snapshot?: import('./core/pvt/beneficiary-routing').BeneficiaryRoutingSnapshot | null;
  beneficiary_routing_snapshot_hash?: string | null;
  /** Atomic event/novelty ownership committed in the same transaction as this row. */
  mint_once_claim_evidence?: MintOnceClaimEvidence[] | null;
  mint_once_claim_evidence_hash?: string | null;
  /** Retired serialized flag; exact snapshots are the only mint authority. */
  fixed_estimated_pvt_override?: boolean;
  /** Compatibility marker derived from an exact current Genesis snapshot. */
  is_genesis_grant?: boolean;
  /**
   * Which standing anti-farm rule zeroed this PE (mint_status='farm_capped'),
   * for dashboards/audit. Null on every PE that was not farm-capped.
   */
  farm_cap_reason?: import('./core/pvt/activity-mint-limits').SealedFarmCapReason | null;
  /**
   * Exact standing-cap decision sealed at record time. A presently eligible
   * ruled Financial PE must carry a valid `reserved` document and matching
   * hash; capped/unverifiable PEs may carry their terminal `capped` evidence.
   */
  activity_mint_reservation?: import('./core/pvt/activity-mint-limits').ActivityMintReservationDocument | null;
  activity_mint_reservation_hash?: string | null;
  /**
   * Retired PVTv8 Genesis audit context. Current cache recovery validates the
   * immutable economic snapshot and never re-debits an old pool/source ledger.
   */
  genesis_wallet_id?: string | null;
  genesis_funding_source_address?: string | null;
  genesis_reserved_pvt?: number | null;
  /** Epoch that a pacing/preflight deferral was made in. */
  deferred_epoch?: number | null;

  // Replication pack (for work_product PEs)
  replication_pack: {
    input_hash: string | null;       // SHA-256 of complete model input (agent-computed)
    output_hash: string | null;      // same as artifact_hash, duplicated here for clarity
    model_id: string | null;         // structured: "provider/name/version" e.g. "anthropic/claude-sonnet-4-6/2025-05"
    model_checkpoint_hash: string | null;  // optional; future GPU TEE will provide this
    pack_hash: string | null;        // SHA-256 of canonical bundle: input_hash+output_hash+model_id+environment_hash+timestamp
  } | null;

  /**
   * W6-3 (Wave 6): the effective attestation multiplier looked up at PE
   * record time. The retired PVTv8 minting engine preferred this stamped value over the
   * live ATTESTATION_MULTIPLIERS table so historical PEs preserved their
   * original price even if Foundation Safe changes the multipliers later.
   * Null on legacy PEs that pre-date this field; minting falls back to
   * the live table for those (one-time backfill is a the operator-only follow-up).
   */
  attestation_multiplier_at_anchor?: number | null;

  /** Explicit lineage references to prior PEs this work builds on. */
  cited_pe_ids?: string[] | null;
  /** Optional submitter-supplied lineage (`parent_goal_pe_id`). Goal envelopes were removed in; relay sealers leave it null. */
  parent_goal_pe_id?: string | null;
  /** Trust Layer build §2.3/§2.8/§2.11 — outputs, witness class, relay receipt time (unhashed mirrors). */
  output_digests?: readonly OutputDigest[] | null;
  witness_class?: string | null;
  witnessed_at_ms?: number | null;
  /**
   * M5 — accrual-time aggregate marker. Equals
   * `ECONOMIC_AGGREGATE_SCHEMA_VERSION` once this row's contribution is in the
   * `pe_economic_aggregates` document of EVERY identity it is read under
   * (stamped by the seal transaction, or by the backfill). Absent on rows that
   * predate the aggregates and have not been backfilled. Mutation hooks apply
   * an aggregate delta only for a marked row.
   */
  economic_aggregate_applied?: string;
  /**
   * H5 — the write-time index shard (`sha256(peId)` prefix mod
   * `PE_HISTORY_INDEX_SHARD_COUNT`) that leads the sharded composite indexes so
   * consecutive writes spread across key ranges instead of piling onto the
   * tail of every low-cardinality-led, timestamp-ordered index. Deterministic
   * from the id; stamped by the seal and by the backfill. Absent on rows that
   * predate both.
   */
  index_shard?: number;
}

export interface WritePEHistoryParams {
  /** In-process immutable lookup evidence; JSON submissions cannot construct it. */
  mint_compliance_evidence?: MintCompliance;
  /** Internal batch read memo; never populated from submission fields. */
  compliance_db?: import('firebase-admin/firestore').Firestore;
  readonly novelty_counters?: BatchPricingCounters;
  peId: string;
  userId: string;
  timestamp: number;
  actionType: string;
  category: PVTCategory;
  attestationDepth: string;
  estimatedPVT: number;
  peHash: string;
  inputSummary?: string;
  outputSummary?: string;
  tx_hash?: string;
  /** commit SHA (display/grouping key). From RecordPEAccrualParams.commitSha. */
  commit_sha?: string | null;
  /** ops-dashboard build: capture-lane mirror (display/grouping key). Sealed authoritative in economic_snapshot. */
  capture_lane?: string | null;
  replication_pack?: PEHistoryDocument['replication_pack'];
  jurisdiction_context: string;
  attestation_verified?: boolean;  // Server verified attestation depth against device/wallet registration
  beneficiary_wallet_id?: string | null;
  pvt_split?: PEHistoryDocument['pvt_split'];
  beneficiary_routing_snapshot?: import('./core/pvt/beneficiary-routing').BeneficiaryRoutingSnapshot | null;
  beneficiary_routing_snapshot_hash?: string | null;
  /** Read-only plans whose claims must commit atomically with pe_history. */
  mint_once_claim_plans?: readonly PreparedMintOnceClaim[];
  /** : a single-lane act's in-batch sighting result (no claim documents). */
  single_lane_sighting?: { readonly exactDuplicate: boolean; readonly uniqueArtifact: boolean };
  /**
   * the job completion this row witnesses ON-CHAIN (the watcher's
   * escrow release). Persisted as `completion_canonical_id` /
   * `completion_witness` so the settlement inlet and the takeover pre-check can
   * read which witness a row is. The OFF-CHAIN witness marker is written by the
   * resolver's promotion, never here.
   */
  completion_claim?: { canonical_id: string; witness: 'onchain_release' } | null;
  fixed_estimated_pvt_override?: boolean;
  is_genesis_grant?: boolean;
  /**
   * Retired PVTv8 Genesis audit context. See PEHistoryDocument.
   */
  genesis_wallet_id?: string | null;
  genesis_funding_source_address?: string | null;
  genesis_reserved_pvt?: number | null;
  deviceRateLimited?: boolean;  // [SEC-device-dedup] PE records but earns 0 PVT (mint_status = 'ineligible')
  /**
   * H-6 (audit 2026-05-11): true when the cache (Redis) was unavailable
   * during accrual. The PE records with estimatedPVT=0 and
   * mint_status='pending_cache' so the pending-cache backfill scheduler
   * can reclassify it later when the cache recovers - instead of being
   * permanently 'ineligible' (which is terminal per CLAUDE.md Pitfall #45).
   * Mutually exclusive with deviceRateLimited (real rate limiting stays
   * 'ineligible' as before).
   */
  cacheUnavailable?: boolean;
  /**
   * Observer output-gate flag. When true, the PE records for chain integrity
   * but `mint_status` is forced to 'skipped_no_output' and minting is bypassed.
   * Currently set only by the observer's compute_session emitter when it sees
   * no files/tokens/plugin artifacts/sustained CPU.
   */
  noObservableOutput?: boolean;
  /**
   * Cross-witness commit dedup flag. When true, this PE witnesses a commit
   * that a prior PE already claimed the mint for (see commit-mint-claim.ts).
   * The PE records for chain integrity with estimatedPVT=0 and
   * mint_status='corroborated_duplicate' (terminal, never mints) so the same
   * commit cannot mint twice across witnesses. The corroboration signal that
   * upgrades the original PE is emitted separately and is never suppressed.
   */
  crossWitnessDuplicate?: boolean;
  /**
   * Standing anti-farm flag (activity-mint-limits.ts). When true, this Financial
   * PE hit a dust floor / unverifiable counterparty / daily ceiling: it records for chain
   * integrity with estimatedPVT=0 and mint_status='farm_capped'. `farm_cap_reason`
   * carries which rule bound it, for dashboards/audit. Applies symmetrically to
   * native and mapped emissions of the same action type.
   */
  farmCapped?: boolean;
  farm_cap_reason?: import('./core/pvt/activity-mint-limits').SealedFarmCapReason | null;
  activity_mint_reservation?: import('./core/pvt/activity-mint-limits').ActivityMintReservationDocument | null;
  activity_mint_reservation_hash?: string | null;
  /**
   * True for an x402_payment self-report with NO verifiable on-chain settlement
   * tx: mint_status='x402_unverified', records + counts reputation but mints 0.
   */
  x402Unverified?: boolean;
  /**
   * W6-3: effective attestation multiplier resolved at anchor time. When
   * supplied, persisted on the pe_history record so the (retired PVTv8)
   * minting engine preserved historical PE prices across governance multiplier
   * changes. Null when the caller could not resolve a value (fallback path); that
   * engine fell back to the live ATTESTATION_MULTIPLIERS table in that case.
   */
  attestation_multiplier_at_anchor?: number | null;
  /**
   * Explicit lineage references to prior PEs this work builds on. The minting
   * engine reads this off the pe_history record to drive lineage attribution
   * at mint time, so it MUST be persisted here (not only on the provenance
   * envelope). Validated at submission. Null on the common path.
   */
  cited_pe_ids?: string[] | null;
  /** Optional submitter-supplied lineage (`parent_goal_pe_id`). Goal envelopes were removed in; relay sealers leave it null. */
  parent_goal_pe_id?: string | null;
  /** Trust Layer build — mirrors of the sealed outputs / witness class / relay receipt time. */
  output_digests?: readonly OutputDigest[] | null;
  witness_class?: string | null;
  witnessed_at_ms?: number | null;
  /**
   * atomic accounting fail-closed policy fields. When omitted, the current legacy status is
   * mapped to explicit disposition/review fields without changing economics.
   * A caller may pass record_only/pending_policy for a genuinely unseen action;
   * that restrictive disposition takes precedence over recoverable legacy
   * states so no later cache backfill can accidentally make it mintable.
   */
  mint_disposition?: MintDisposition;
  disposition_reason_code?: MintReasonCode;
  policy_review_state?: PolicyReviewState;
  policy_review_reason_code?: PolicyReviewReasonCode;
  economic_policy_version?: string;
  economic_snapshot?: RecordEconomicSnapshot | null;
  /**
   * Present only for a genuinely unknown identifier. Its queue upsert commits
   * atomically with this pe_history row; alert dispatch follows the commit and
   * is restart-recoverable from alert_status=pending.
   */
  pending_policy_observation?: PendingPolicyObservation;
  /** Test/integration injection; production uses the configured email sender. */
  pending_policy_alert_sender?: PendingPolicyAlertSender;
  /** Created atomically with pe_history for crash-resumable derived effects. */
  durable_accrual_effect?: DurableAccrualEffectDocument;
}

// =============================================================================
// WRITE PE HISTORY
// =============================================================================

/**
 * Write a single PE history document to Firestore.
 * Called from recordPEAccrual() - already inside a try/catch, so this
 * function throws on failure and the caller handles it.
 *
 * Returns true if the document was written (new PE), false if it already existed.
 * [SEC-audit-4.6] Uses a Firestore transaction to check existence before writing,
 * preventing duplicate PE accrual from retries or race conditions.
 */
/**
 * The row a seal would write, built in memory (PE meter, 2026-10-03). `writePEHistory`
 * persists it as `pe_history/{peId}`; the meter seal (`core/meter/meter-seal.ts`) never
 * persists it — it prices, claims, totals and keeps a 31-day act key. ONE builder, so the
 * two can never price or classify a row differently.
 */
export interface BuiltPEHistoryRow {
  readonly doc: PEHistoryDocument;
  readonly mintOncePlans: readonly PreparedMintOnceClaim[];
  readonly bugSignal: ReturnType<typeof buildPeBugSignal>;
}

export async function buildPEHistoryRow(params: WritePEHistoryParams): Promise<BuiltPEHistoryRow> {

  // Software-attested PEs get a 72-hour audit hold before minting
  const isSoftware = params.attestationDepth === 'software';
  const auditHold = isSoftware;
  const auditWindowExpiresAt = auditHold ? Date.now() + (72 * 60 * 60 * 1000) : null;

  // Jurisdiction-aware mint status
  const compliance = isMintComplianceEvidence(params.mint_compliance_evidence, params.userId, params.beneficiary_routing_snapshot?.human_address ?? null)
    ? params.mint_compliance_evidence
    : await complianceForRow({ userId: params.userId,
    beneficiary_routing_snapshot: params.beneficiary_routing_snapshot }, params.compliance_db);
  const jurisdictionPolicy = compliance.policy;
  let mintStatus: PEHistoryDocument['mint_status'];
  let deferredSince: number | null = null;
  let complianceHeld = false;

  if (params.mint_disposition === 'record_only' && !params.x402Unverified) {
    // Plan-decided unknown-action behavior is terminal for this sealed PE.
    // It intentionally wins over pending_cache: a later cache recovery must
    // never turn an unclassified identifier into money.
    mintStatus = 'record_only';
  } else if (params.noObservableOutput) {
    // Preserve the observable-output terminal reason even when the exact
    // snapshot already carries an ineligible operational override.
    mintStatus = 'skipped_no_output';
  } else if (params.crossWitnessDuplicate) {
    mintStatus = 'corroborated_duplicate';
  } else if (params.farmCapped) {
    mintStatus = 'farm_capped';
  } else if (params.x402Unverified) {
    mintStatus = 'x402_unverified';
  } else if (params.mint_disposition === 'ineligible_terminal') {
    mintStatus = 'ineligible';
  } else if (isTerminalCompliance(compliance)) {
    complianceHeld = true;
    mintStatus = 'ineligible';
  } else if (params.mint_disposition === 'pending_evidence') {
    mintStatus = 'pending_evidence';
  } else if (params.mint_disposition === 'pending_review') {
    mintStatus = 'pending_review';
  } else if (params.mint_disposition === 'pending_cache') {
    mintStatus = 'pending_cache';
  } else if (params.mint_disposition === 'beneficiary_pending') {
    mintStatus = 'beneficiary_pending';
  } else if (jurisdictionPolicy === 'deferred') {
    complianceHeld = true;
    mintStatus = 'deferred';
    deferredSince = Date.now();
  } else if (params.mint_disposition === 'jurisdiction_deferred') {
    mintStatus = 'deferred';
    deferredSince = Date.now();
  } else if (params.cacheUnavailable) {
    // H-6 (audit 2026-05-11): cache (Redis) was down - accrual was skipped
    // because per-user rate-limit counters were unreadable. RECLASSIFIABLE
    // by the pending-cache backfill scheduler once Redis recovers.
    mintStatus = 'pending_cache';
  } else if (params.deviceRateLimited) {
    // [SEC-device-dedup] PE records for dashboard visibility but earns 0 PVT.
    // TERMINAL per Pitfall #45 - represents real rate-limit enforcement.
    mintStatus = 'ineligible';
  } else if (jurisdictionPolicy === 'blocked') {
    complianceHeld = true;
    mintStatus = 'pending_compliance';
  } else {
    mintStatus = 'eligible';
  }

  // Compliance also holds a potentially minting act that is waiting for another verifier.
  // Terminal/non-minting records never acquire a recipient's geographic observation.
  complianceHeld ||= jurisdictionPolicy !== 'immediate'
    && ['pending_evidence', 'pending_review', 'pending_cache', 'beneficiary_pending', 'deferred', 'pending_compliance'].includes(mintStatus);

  const explicitPolicyFields = resolvePolicyFields(params, mintStatus, compliance.reason);
  const economicSnapshot = params.economic_snapshot ?? null;
  if (mintStatus === 'eligible' && economicSnapshot === null) {
    throw new Error('eligible_pe_requires_economic_snapshot');
  }
  if (economicSnapshot !== null) {
    if (economicSnapshot.peId !== params.peId
      || economicSnapshot.economicActorId !== params.userId
      || economicSnapshot.actionType !== params.actionType
      || economicSnapshot.recordedAtMs !== params.timestamp
      || economicSnapshot.policyVersion !== (params.economic_policy_version
        ?? economicSnapshot.policyVersion)) {
      throw new Error('economic_snapshot_record_binding_mismatch');
    }
    if (!canTransitionMintDisposition(
      economicSnapshot.mintDisposition,
      explicitPolicyFields.mintDisposition,
    )) {
      throw new Error('economic_snapshot_disposition_transition_invalid');
    }
  }
  const recordPointsAtomic = economicSnapshot?.recordPointsAtomic ?? '0';
  const bugSignal = buildPeBugSignal({
    peId: params.peId,
    sealedValueAtomic: recordPointsAtomic,
    thresholdAtomic: readOpsPolicyThresholds().single_pe_push.atomic,
    recordedAtMs: params.timestamp,
  });
  const estimatedPvtAtomic = explicitPolicyFields.mintDisposition === 'eligible'
    ? recordPointsAtomic
    : '0';
  const exactDisplayEstimate = Number(BigInt(estimatedPvtAtomic)) / 1e18;
  const mintOncePlans = [...(params.mint_once_claim_plans ?? [])]
    .sort((a, b) => a.evidence.claim.claim_kind.localeCompare(b.evidence.claim.claim_kind));
  // Case 1 (daemon-first) — this PE is the higher-base TAKER of a commit an
  // incumbent daemon held; the demoted daemon is the cross-witness, so the taker
  // (the settling WINNER) is sealed with the corroboration in the SAME transaction
  // that demotes the daemon. This commits atomically with the takeover — a race
  // that rolls the takeover back rolls this back too — so the winner is never
  // marked corroborated without the demotion that justifies it.
  const takeoverPlan = mintOncePlans.find((plan) => plan.commit_takeover !== undefined);
  const mintOnceEvidence = mintOncePlans.map((plan) => plan.evidence);
  const mintOnceEvidenceHash = hashMintOnceClaimEvidence(mintOnceEvidence);
  assertMintOnceClaimEvidence({
    peId: params.peId,
    userId: params.userId,
    evidence: mintOnceEvidence,
    evidenceHash: mintOnceEvidenceHash,
    exactDuplicate: economicSnapshot?.recordTimeFactors.exactDuplicate ?? false,
    uniqueArtifact: economicSnapshot?.recordTimeFactors.uniqueArtifact ?? false,
    eligible: mintStatus === 'eligible',
    ...(params.single_lane_sighting !== undefined ? { singleLaneSighting: params.single_lane_sighting } : {}),
  });

  const doc: PEHistoryDocument = {
    peId: params.peId,
    userId: params.userId,
    timestamp: params.timestamp,
    actionType: params.actionType,
    category: params.category,
    attestationDepth: params.attestationDepth,
    contributionValue: 1.0,
    estimatedPVT: exactDisplayEstimate,
    peHash: params.peHash,
    inputSummary: params.inputSummary || null,
    outputSummary: params.outputSummary || null,
    hidden: false,
    mint_status: mintStatus,
    mint_disposition: explicitPolicyFields.mintDisposition,
    disposition_reason_code: explicitPolicyFields.dispositionReasonCode,
    policy_review_state: explicitPolicyFields.policyReviewState,
    policy_review_reason_code: explicitPolicyFields.policyReviewReasonCode,
    economic_policy_version: params.economic_policy_version
      ?? 'legacy-live-policy-at-wp1-cut-line-2026-07-11',
    economic_snapshot: economicSnapshot,
    economic_snapshot_hash: economicSnapshot === null
      ? null
      : hashRecordEconomicSnapshot(economicSnapshot),
    economic_eligibility_projection: null,
    record_points_atomic: recordPointsAtomic,
    estimated_pvt_atomic: estimatedPvtAtomic,
    jurisdiction_context: complianceHeld
      ? compliance.deferred_context ?? compliance.actor_country ?? ''
      : compliance.actor_country ?? '',
    jurisdiction_region: compliance.actor_region,
    jurisdiction_compliance_reason: compliance.reason,
    jurisdiction_mint_held: complianceHeld,
    deferred_since: deferredSince,
    tx_hash: params.tx_hash || undefined,
    // the commit SHA (from metadata.commit_sha) persisted as a DISPLAY /
    // grouping key so the client can collapse the coding_session +
    // service:github_commit + corroboration_signal PEs of one commit into a single
    // row. It is NOT part of the sealed economic_snapshot and changes no economic
    // math — the mint-once (user, commit_sha) claim already lives on the accrual
    // params; this only records it for display.
    commit_sha: params.commit_sha || null,
    // ops-dashboard build: capture-lane mirror for cheap collector reads. Authoritative
    // copy is sealed in economic_snapshot; this changes no economic math.
    capture_lane: params.capture_lane
      ?? economicSnapshot?.recordTimeFactors.captureLane
      ?? null,
    // the on-chain completion witness marker (watcher rows only). The
    // resolver writes the off-chain marker when it promotes a confirmation.
    completion_canonical_id: params.completion_claim?.canonical_id ?? null,
    completion_witness: params.completion_claim?.witness ?? null,
    audit_hold: auditHold,
    audit_window_expires_at: auditWindowExpiresAt,
    attestation_verified: params.attestation_verified ?? false,
    corroboration_status: takeoverPlan ? COMMIT_CROSS_WITNESS_CORROBORATION_STATUS : 'none',
    corroboration_source: takeoverPlan ? takeoverPlan.commit_takeover!.incumbent_pe_id : null,
    corroboration_received_at: takeoverPlan ? params.timestamp : null,
    replication_pack: params.replication_pack || null,
    beneficiary_wallet_id: params.beneficiary_wallet_id || null,
    pvt_split: params.pvt_split || null,
    beneficiary_routing_snapshot: params.beneficiary_routing_snapshot ?? null,
    beneficiary_routing_snapshot_hash: params.beneficiary_routing_snapshot_hash ?? null,
    mint_once_claim_evidence: mintOnceEvidence,
    mint_once_claim_evidence_hash: mintOnceEvidenceHash,
    fixed_estimated_pvt_override: params.fixed_estimated_pvt_override === true,
    is_genesis_grant: params.is_genesis_grant === true,
    farm_cap_reason: params.farmCapped ? (params.farm_cap_reason ?? null) : null,
    activity_mint_reservation: params.activity_mint_reservation ?? null,
    activity_mint_reservation_hash: params.activity_mint_reservation_hash ?? null,
    genesis_wallet_id: params.genesis_wallet_id ?? null,
    genesis_funding_source_address: params.genesis_funding_source_address ?? null,
    genesis_reserved_pvt: params.genesis_reserved_pvt ?? null,
    deferred_epoch: null,
    attestation_multiplier_at_anchor: params.attestation_multiplier_at_anchor ?? null,
    cited_pe_ids: params.cited_pe_ids ?? null,
    parent_goal_pe_id: params.parent_goal_pe_id ?? null,
    // Trust Layer build: citable outputs, witness class, relay receipt time (unhashed mirrors).
    output_digests: params.output_digests ?? null,
    witness_class: params.witness_class ?? null,
    witnessed_at_ms: params.witnessed_at_ms ?? null,
    // M5: this row is applied to its aggregates in the seal transaction
    // below, so it is born marked.
    [PE_HISTORY_AGGREGATE_MARKER_FIELD]: ECONOMIC_AGGREGATE_SCHEMA_VERSION,
    // H5: the write-time index shard, derived from the id.
    [PE_HISTORY_INDEX_SHARD_FIELD]: peHistoryIndexShard(params.peId),
  };

  return { doc, mintOncePlans, bugSignal };
}

export async function writePEHistory(
  params: WritePEHistoryParams,
  dbOverride?: FirebaseFirestore.Firestore,
): Promise<boolean> {
  const db = dbOverride ?? relayDb();
  const { doc, mintOncePlans, bugSignal } = await buildPEHistoryRow(params);

  // [SEC-audit-4.6] Deduplication: transactional check-then-write
  const ref = db.collection('pe_history').doc(params.peId);
  const effectRef = params.durable_accrual_effect
    ? db.collection(DURABLE_ACCRUAL_EFFECTS_COLLECTION).doc(params.peId)
    : null;
  if (params.durable_accrual_effect
    && params.durable_accrual_effect.payload.peId !== params.peId) {
    throw new Error('durable_accrual_effect_history_binding_invalid');
  }
  let didWrite = false;
  let pendingPolicyResult: PendingPolicyObservationResult | null = null;
  const pendingPolicyNow = params.pending_policy_observation?.now ?? Date.now();
  const retentionPlans = await planComplianceRetention(db, params.peId, doc as unknown as Record<string, unknown>, pendingPolicyNow);
  await db.runTransaction(async (txn) => {
    const existing = await txn.get(ref);
    if (existing.exists) return; // [SEC-audit-4.6] Deduplication guard
    await params.novelty_counters?.inspect(txn);
    const mintOnceDecisions: MintOnceClaimTransactionDecision[] = [];
    const takeoverDecisions: CommitTakeoverDecision[] = [];
    const completionTakeoverDecisions: CompletionTakeoverDecision[] = [];
    for (const plan of mintOncePlans) {
      // a commit-takeover plan re-owns an incumbent's claim and demotes
      // it; the generic inspect would refuse the existing-doc-different-owner as
      // a race. Every read across ALL paths runs before any write below, so the
      // whole transaction's conflict set is real. the completion
      // takeover (the on-chain release displacing the off-chain confirmation
      // witness of the same job) takes its own specialized path for the same
      // reason.
      if (plan.commit_takeover !== undefined) {
        takeoverDecisions.push(await inspectPreparedCommitTakeoverInTransaction(db, txn, plan));
      } else if (plan.completion_takeover !== undefined) {
        completionTakeoverDecisions.push(
          await inspectPreparedCompletionTakeoverInTransaction(db, txn, plan),
        );
      } else {
        mintOnceDecisions.push(await inspectPreparedMintOnceClaimInTransaction(db, txn, plan));
      }
    }
    // M5 — the accrual-time aggregates are READ here (still before any
    // write) and WRITTEN below, in this same transaction as the row: the new
    // row's contribution under every identity it is read under, plus the
    // (−before, +after) delta of any incumbent this seal demotes. A crash
    // cannot leave the row counted-but-unwritten or written-but-uncounted.
    const aggregateWriter = new EconomicAggregateWriter(db, txn, pendingPolicyNow);
    await aggregateWriter.load([
      ...EconomicAggregateWriter.identitiesOf(doc),
      ...takeoverDecisions.flatMap((decision) => EconomicAggregateWriter.identitiesOf(decision.incumbentBefore)),
      ...completionTakeoverDecisions.flatMap((decision) => EconomicAggregateWriter.identitiesOf(decision.incumbentBefore)),
    ]);
    const retainLocation = await prepareComplianceRetention(db, txn, retentionPlans, pendingPolicyNow);
    await prepareLocationCopyFence(db, txn, params.userId, [doc as unknown as Record<string, unknown>], pendingPolicyNow, false, retainLocation.actorDeadlines.get(params.userId));
    if (params.pending_policy_observation) {
      pendingPolicyResult = await upsertPendingPolicyObservationInTransaction(
        db,
        txn,
        params.pending_policy_observation,
        pendingPolicyNow,
      );
    }
    retainLocation();
    params.novelty_counters?.commit(txn);
    for (const decision of mintOnceDecisions) {
      applyMintOnceClaimDecision(db, txn, decision);
    }
    for (const decision of takeoverDecisions) {
      applyCommitTakeoverDecision(db, txn, decision, params.timestamp);
      aggregateWriter.applyMutation(
        decision.incumbentBefore as unknown as PEHistoryDocument,
        demotedIncumbentRow(decision, params.timestamp) as unknown as PEHistoryDocument,
      );
    }
    for (const decision of completionTakeoverDecisions) {
      applyCompletionTakeoverDecision(db, txn, decision, params.timestamp);
      // M5 invariant, mirrored from the commit takeover above: the demoted
      // off-chain incumbent projects ZERO once it is no longer `eligible`, so its
      // contribution leaves the aggregate in the SAME transaction that demotes it.
      aggregateWriter.applyMutation(
        decision.incumbentBefore as unknown as PEHistoryDocument,
        demotedCompletionIncumbentRow(decision, params.timestamp) as unknown as PEHistoryDocument,
      );
    }
    txn.set(ref, { ...doc });
    if (effectRef && params.durable_accrual_effect) {
      txn.create(effectRef, { ...params.durable_accrual_effect });
    }
    aggregateWriter.applyRow(doc, 1);
    // Phase 1: operator-console disposition rollup, in the SAME transaction
    // as the row so the count can never disagree with the chain. Blind sharded
    // increment — adds no read and no new abort mode beyond marginal contention.
    incrementConsoleDispositionRollupInTransaction(txn, db, {
      disposition: doc.mint_disposition,
      sealMs: doc.timestamp,
      peId: params.peId,
    });
    aggregateWriter.commit();
    didWrite = true;
  });
  if (bugSignal !== null) {
    // Operational visibility must never become a PE-recording dependency. The
    // deterministic create happens only after the PE transaction commits;
    // ALREADY_EXISTS is the idempotent retry path, and any other failure is
    // logged for operator visibility without rolling back or reclassifying the
    // sealed PE. A duplicate PE submission retries a missing signal.
    try {
      await db.collection(PE_BUG_SIGNAL_COLLECTION).doc(params.peId).create({ ...bugSignal });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 6 && code !== 'already-exists' && code !== 'ALREADY_EXISTS') {
        console.error('[PolicyTelemetry] PE bug-signal create failed', error);
      }
    }
  }
  if (pendingPolicyResult !== null) {
    try {
      await finalizePendingPolicyObservation(
        db,
        pendingPolicyResult,
        pendingPolicyNow,
        params.pending_policy_alert_sender,
      );
    } catch (error) {
      // The PE + queue transaction is already durable. Leaving alert_status at
      // pending/failed lets the scheduled retry recover this notification gap.
      console.error('[PVTPolicy] post-commit pending-policy alert failed', error);
    }
  }
  return didWrite;
}

function resolvePolicyFields(
  params: WritePEHistoryParams,
  mintStatus: PEHistoryDocument['mint_status'],
  complianceReason: MintCompliance['reason'],
): {
  mintDisposition: MintDisposition;
  dispositionReasonCode: MintReasonCode;
  policyReviewState: PolicyReviewState;
  policyReviewReasonCode: PolicyReviewReasonCode;
} {
  let mintDisposition: MintDisposition;
  let dispositionReasonCode: MintReasonCode;
  switch (mintStatus) {
    case 'eligible':
    case 'minted':
      mintDisposition = 'eligible';
      dispositionReasonCode = 'policy_eligible';
      break;
    case 'pending_compliance':
      mintDisposition = 'pending_compliance';
      dispositionReasonCode = complianceReason === 'jurisdiction_blocked' ? 'jurisdiction_blocked'
        : complianceReason === 'sdn_unavailable' ? 'sdn_unavailable' : 'jurisdiction_unknown';
      break;
    case 'pending_cache':
      mintDisposition = 'pending_cache';
      dispositionReasonCode = 'cache_unavailable';
      break;
    case 'beneficiary_pending':
      mintDisposition = 'beneficiary_pending';
      dispositionReasonCode = 'beneficiary_unresolved';
      break;
    case 'deferred':
      mintDisposition = 'jurisdiction_deferred';
      dispositionReasonCode = 'jurisdiction_deferred';
      break;
    case 'pending_evidence':
    case 'genesis_epoch_deferred':
    case 'epoch_headroom_deferred':
      mintDisposition = 'pending_evidence';
      dispositionReasonCode = 'awaiting_evidence';
      break;
    case 'pending_review':
      mintDisposition = 'pending_review';
      dispositionReasonCode = 'awaiting_review';
      break;
    case 'record_only':
      mintDisposition = 'record_only';
      dispositionReasonCode = 'policy_record_only';
      break;
    case 'x402_unverified':
      mintDisposition = 'ineligible_terminal';
      dispositionReasonCode = 'policy_ineligible';
      break;
    default:
      mintDisposition = 'ineligible_terminal';
      dispositionReasonCode = 'policy_ineligible';
      break;
  }
  const dispositionReason = params.mint_disposition === mintDisposition
    ? (params.disposition_reason_code ?? defaultReasonForDisposition(mintDisposition))
    : dispositionReasonCode;
  const policyReviewState = params.policy_review_state ?? 'not_required';
  return {
    mintDisposition,
    dispositionReasonCode: dispositionReason,
    policyReviewState,
    policyReviewReasonCode: params.policy_review_reason_code
      ?? defaultReasonForPolicyReviewState(policyReviewState),
  };
}

function defaultReasonForPolicyReviewState(state: PolicyReviewState): PolicyReviewReasonCode {
  switch (state) {
    case 'not_required': return 'known_policy_entry';
    case 'pending_policy': return 'unknown_action_type';
    case 'classified_prospective': return 'classification_approved_prospective';
    case 'class_admitted': return 'witness_class_admitted';
    case 'rejected': return 'classification_rejected';
  }
}

function defaultReasonForDisposition(disposition: MintDisposition): MintReasonCode {
  switch (disposition) {
    case 'eligible': return 'policy_eligible';
    case 'pending_evidence': return 'awaiting_evidence';
    case 'pending_review': return 'awaiting_review';
    case 'record_only': return 'policy_record_only';
    case 'ineligible_terminal': return 'policy_ineligible';
    case 'pending_compliance': return 'jurisdiction_unknown';
    case 'pending_cache': return 'cache_unavailable';
    case 'beneficiary_pending': return 'beneficiary_unresolved';
    case 'jurisdiction_deferred': return 'jurisdiction_deferred';
  }
}

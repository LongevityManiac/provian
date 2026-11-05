import { isTerminalCompliance } from './core/jurisdiction/compliance-state';
import { evaluateMintCompliance } from './core/jurisdiction/mint-compliance';
import { accrualEndedFor } from './core/pvt/accrual-end-line';
import { BatchPricingCounters, NoveltySealsPausedError, NoveltyCounterConflictError, retryNoveltyConflict } from './core/meter/batch-pricing-counters';
import { privateRetentionCollection } from './core/provenance/private-retention';
import {ordinaryHardwareAttestationTier} from './core/hardware/admit';
/**
 * PVT Accrual Tracker
 *
 * Tracks PVT (Provenance Value Token) accrual as PEs are created. The sealed
 * exact economic snapshot is the monetary source of truth; floating aggregate
 * fields remain compatibility/display projections only. Ordinary callers are
 * fire-and-forget, while durable Genesis outboxes await the history
 * acknowledgement before completing.
 */

import admin from 'firebase-admin';
import { relayDb } from './firestore-db';
import { sealMeterAct, outcomeFromKey, type MeterActBatchContext } from './core/meter/meter-seal';
import { outboundCounterpartyOf } from './core/meter/counterparty-pairs';
import type { MeterActKeyDoc } from './core/meter/meter-act-key';
import { METER_ACT_KEYS_COLLECTION } from './core/meter/meter-store';
import { ethers } from 'ethers';
import { cache } from './cache';
import { writePEHistory, type WritePEHistoryParams } from './pe-history';
import { resolveBeneficiary, type BeneficiaryCacheEntry } from './core/pvt/beneficiary';
import { deriveCaptureLane } from './core/pvt/capture-lane';
// F-A6-1 — the delegation-credit PE. Runtime-only cycle: delegation-pe imports
// recordPEAccrual from here, but neither module uses the other at top level, so
// both bindings resolve by the time they are called.
import { isDelegationQualifying } from './core/pvt/delegation-pe';
import { checkDevicePERateLimit, isDeviceRateLimited } from './device-pe-rate-limiter';
import { prepareCommitMintClaim } from './core/pvt/commit-mint-claim';
import {
  evaluateCommitWitness,
  prepareCommitTakeoverPlan,
  recordIncumbentCommitCorroboration,
} from './core/pvt/commit-takeover';
import { prepareX402TxMintClaim, x402MintClaimKey } from './core/pvt/x402-tx-mint-claim';
import {
  financialSettlementMintClaimKey,
  prepareFinancialSettlementMintClaim,
} from './core/pvt/financial-settlement-mint-claim';
import { prepareArtifactNoveltyClaim } from './core/pvt/artifact-novelty-claim';
import { prepareOccurrenceMintClaim } from './core/pvt/occurrence-mint-claim';
import { prepareDeviceOccurrenceMintClaim, singleLaneOccurrenceClaimed, singleLaneOccurrenceClaimHook } from './core/pvt/device-occurrence-claim';
import { prepareCompletionMintClaim } from './core/pvt/completion-claim';
import {
  evaluateCompletionWitness,
  prepareCompletionTakeoverPlan,
} from './core/pvt/completion-takeover';
import {
  MintOnceClaimRaceError,
  ClosedCrossWitnessOccurrenceError,
  type PreparedMintOnceClaim,
} from './core/pvt/mint-once-claim';
import {
  reserveActivityMintCaps,
  decideActivityMintIdentityWithoutSlot,
  getActionTypeMintRule,
  type ActivityMintReservationDocument,
  type SealedFarmCapReason,
} from './core/pvt/activity-mint-limits';
import { reserveSpeechWindowBudget, speechPeNeedsPass } from './core/pvt/speech-window-budget';
import {
  createBeneficiaryRoutingSnapshot,
  hashBeneficiaryRoutingSnapshot,
} from './core/pvt/beneficiary-routing';
import { recordActionTypeObservation } from './core/provenance/pe-type-catalog';
import {
  resolveActionPolicyAtRecordTime,
} from './core/pvt/policy/action-policy-gate';
import { loadRuntimeMonetaryPolicy, withWitnessClassOverride } from './core/pvt/policy/runtime-monetary-policy';
import { pendingPolicyObservationSource, shouldObservePendingPolicy } from './core/pvt/policy/new-type-intake';
// Runtime import into a module that only type-imports this one back (`import
// type { RecordPEAccrualParams }`), so the cycle is erased at compile time and
// there is no require-time loop.
import {
  verifyOrdinaryAccrualIntakeReplaySource,
  type OrdinaryAccrualReplaySource,
} from './core/pvt/wp11/ordinary-accrual-intake';
import {
  detectSameOwnerTransfer,
  isResolvableCounterpartyAddress,
} from './core/pvt/policy/same-owner-detection';
import { PROVIAN_SERVICE_FEE_REASON_CODE, provianServiceFeeApplies } from './core/pvt/provian-service-wallets';
import { resolveReceiveAuthorship } from './core/pvt/policy/receive-authorship';
import { normalizeAttestationTier } from './core/pvt/pe-weight-framework';
import {
  computeRecordSnapshot,
  isTerminalMintDisposition,
  type EvidenceState,
  type LinkageState,
  type RecordCalculationInput,
  type RecordEconomicSnapshot,
} from './core/pvt/policy/monetary-accounting';
// money layer (Prompt 3). The mint-time origin resolver: witness + independence + reference
// graph + closed-loop + observed volume, folded into the two pricing inputs. Fail-closed; never
// throws into the seal.
import { newBatchOriginEdges, resolveOriginPricingInputs } from './core/pvt/origin-pricing-inputs';
import type { RelayWitnessedOrigins } from './core/pvt/relay-observation-witness';
import { bumpActorStats, inboundPayerKey, withInboundPayer, type CompositionSignals } from './core/pvt/actor-stats';
import type { OutputDigest } from './core/provenance/output-digests';
import { normalizeWitnessClass, WITNESSED_CLASSES, type WitnessClass } from './core/pvt/policy/evidence-class';
import type { SealedWitness } from './core/pvt/origin-independence';
import type { InputOrigin } from './core/provenance/input-origins';
import {
  DURABLE_ACCRUAL_EFFECTS_COLLECTION,
  createDurableAccrualEffect,
  resumeDurableAccrualEffects,
  type DurableAccrualCrashPoint,
} from './core/pvt/durable-accrual-effects';

const FieldValue = admin.firestore.FieldValue;

// =============================================================================
// TYPES
// =============================================================================

export type PVTCategory = 'wallet' | 'agent' | 'x402' | 'promises' | 'other';

export interface PVTAccrualDocument {
  userId: string;
  totalPEs: number;
  totalEstimatedPVT: number;
  pesByCategory: Record<PVTCategory, number>;
  estimatedPVTByCategory: Record<PVTCategory, number>;
  weeklyPEs: number;
  weekStart: number;          // Monday 00:00 UTC ms timestamp
  lastPETimestamp: number;
  attestationDepth: string;
}

export interface RecordPEAccrualParams {
  peId: string;
  userId: string;
  actionType: string;
  /**
   * Stable submitting path/integration label for the atomic accounting pending-policy queue.
   * Never put credentials or user-controlled payload content here.
   */
  integrationSource: string;
  attestationDepth: string;       // Full tier names: 'hardware', 'software', 'software_verified', etc.
  peHash: string;
  timestamp: number;
  inputSummary?: string;
  outputSummary?: string;
  tx_hash?: string;
  artifact_hash?: string;         // For work_product PEs - unique output fingerprint
  /**
   * Git commit SHA this PE witnesses, when applicable (coding_session,
   * service:github_commit / _pr_merged, service:gitlab_push / _mr_merged).
   * Drives cross-witness mint-once dedup: the first PE to claim a given
   * (user, commit_sha) mints; later witnesses of the same commit record but
   * do not mint. Absent on non-commit PEs - no claim is made.
   */
  commitSha?: string | null;
  replication_pack?: import('./pe-history').PEHistoryDocument['replication_pack'];
  jurisdiction_context?: string;  // Untrusted legacy input; ignored. Relay derives location from authenticated sessions.
  linkedHumanWalletId?: string | null;  // Caller can pass when known; else looked up from cache
  /** Legacy provenance marker only. Device origin has no linkage-multiplier effect. */
  isDevicePE?: boolean;
  deviceAttestationId?: string | null;  // Hardware-backed device ID (Secure Enclave) - survives reinstalls
  deviceId?: string | null;             // Fallback device ID from auth token - may NOT survive reinstalls
  attestation_verified?: boolean;  // Server verified attestation depth against device/wallet registration
  /**
   * Observer output-gate flag. When true, skip PVT accrual entirely and write
   * the pe_history doc with mint_status='skipped_no_output'. The PE still
   * exists on the chain for integrity - only minting is suppressed.
   */
  noObservableOutput?: boolean;
  /**
   * Foundation membership hook context. When both are present AND this is the
   * user's first PE AND ENABLE_FOUNDATION_MEMBERSHIP is on, the caller queues
   * an initial-membership grant across all configured chains. Agent wallets
   * never qualify - membership is for humans.
   */
  ownerType?: 'human' | 'agent';
  walletAddress?: string | null;
  /**
   * Explicit lineage references to prior PEs this work builds on. Persisted on
   * the pe_history record so the minting engine's lineage attribution sees
   * them at mint time. Validated upstream (at submission) before being passed
   * here. Null/omitted on the common path - no citations.
   */
  citedPeIds?: string[] | null;
  /** Optional submitter-supplied lineage (`parent_goal_pe_id`). Goal envelopes were removed in; relay sealers leave it null. */
  parentGoalPeId?: string | null;
  /**
   * Retired wire-compatibility input. It has no economic effect; fixed Genesis
   * value is accepted only in a reservation-bound `economicSnapshot`.
   */
  fixedEstimatedPVT?: number | null;
  /**
   * Retired compatibility marker. Current Genesis identity and beneficiary
   * treatment are derived only from a reservation-bound economicSnapshot.
   */
  isGenesisGrant?: boolean;
  /**
   * Retired PVTv8 audit context. Current Genesis reservations are never released
   * on cache/rate-limit paths and never consult the old pool/source ledgers.
   */
  genesisWalletId?: string | null;
  genesisFundingSourceAddress?: string | null;
  /**
   * WS7: the on-chain payer address for an `x402_payment` PE — the EIP-3009
   * signer (`signed.authorization.from`), i.e. the sovereign agent wallet that
   * made the payment. This is the AUTHORITATIVE identity for x402 counting: the
   * x402 PE is ingested on the human-session /v1/relay/action path (userId is
   * the human owner, NOT the agent), so the agent wallet can only be resolved
   * by its signer address. Omitted on non-x402 PEs.
   */
  x402PayerAddress?: string;
  /** Identity-only anti-farming input for financial action types. */
  counterpartyAddress?: string | null;
  /**
   * On-chain settlement tx hash for an `x402_payment` PE. Used for cross-source
   * mint-once dedup (x402-tx-mint-claim.ts): the SDK best-effort self-report and
   * the chain-verified outbound watcher can both witness the SAME settlement, so
   * the underlying payment must mint exactly once. When present, the first source
   * to record (payer, tx_hash) mints; later sources record but earn 0 PVT and do
   * NOT re-increment x402_payment_count. An x402_payment PE with NO verifiable
   * settlement tx records provenance but mints 0 PVT ("Unknown = Block"): only a
   * verifiable on-chain settlement earns. Omitted on non-x402 PEs.
   */
  x402SettlementTxHash?: string | null;
  /**
   * Option B (x402 watcher-only mint): TRUE only when this `x402_payment` PE was
   * emitted by the CHAIN-VERIFIED outbound-USDC watcher, which read the real
   * on-chain USDC Transfer log. It is the SOLE authority for x402 minting: an
   * x402 PE mints (and counts x402_payment_count) ONLY when this is true AND a
   * payer + settlement tx are present (the latter two still key the cross-source
   * mint-once dedup). SDK/self-report paths (/v1/pe/submit-sovereign,
   * /v1/relay/action, device /v1/pe/submit) never set this, so their
   * client-supplied settlement hashes cannot mint — they record provenance only
   * (mint_status='x402_unverified', 0 PVT). This closes the fabricated-tx-hash
   * faucet at the root. Omitted (falsy) on every non-watcher / non-x402 path.
   */
  x402ChainVerified?: boolean;
  /**
   * sovereign agent-work occurrence mint-once. Set together (both or
   * neither) by the sovereign-pe route AFTER the per-occurrence agent-key binding
   * verifies against the earning agent address. `sovereignWorkSignerAddress` is
   * that verified address; `sovereignWorkOccurrenceId` is the signed occurrence.
   * The first PE to claim (address, occurrence) mints; a replay records 0. These
   * are the ONLY inputs that key occurrence mint-once — a bare relay submission
   * of a compute_or_work type never sets them, so it cannot claim or mint.
   */
  sovereignWorkOccurrenceId?: string | null;
  sovereignWorkSignerAddress?: string | null;
  /**
   * the HARD per-occurrence mint-once key for a BODY-BOUND
   * device-witnessed compute PE. sha256 of the overlay's canonical event id;
   * set ONLY by the device-witnessed verified overlay (`device-witnessed-earning.ts`)
   * when a body-bound submission of a device-witnessed compute family carries a
   * derivable canonical event. The first PE to claim (economic actor, this
   * digest) mints; a replay of the identical body-bound submission records 0
   * (`exactDuplicate` → `corroborated_duplicate`), closing the replay hole Build
   * A's soft per-day artifact-novelty claim left open. Absent (undefined) on
   * every non-device path, so their accrual is byte-identical to before.
   */
  deviceWitnessedOccurrenceHash?: string | null;
  /**
   * the canonical COMPLETION id this PE witnesses ON-CHAIN (an escrow
   * release / resolution paid to the recipient, observed by the institution-
   * completion watcher). Keys the `completion` mint-once claim
   * (`core/pvt/completion-claim.ts`) so the on-chain witness and the resolver-
   * promoted off-chain counterparty confirmation of ONE job collide on one
   * document: whichever arrives first owns it, and the on-chain witness TAKES
   * OVER an eligible, unregistered off-chain incumbent (best-supported value,
   * never the sum). Claimed only when this row is chain-verified
   * (`economicEvidenceState === 'verified'`) — a verdict-less watcher row seals
   * `pending_evidence`, mints nothing, and must not hold the slot. Absent on
   * every other path.
   */
  completionCanonicalId?: string | null;
  /** Authoritative economic evidence state; never inferred from a tx hash alone. */
  economicEvidenceState?: EvidenceState;
  /** Canonical event identifier verified by the evidence adapter. */
  economicCanonicalEventId?: string | null;
  /** Causal session lineage sealed into the economic snapshot. */
  economicSessionLineageId?: string | null;
  /** Explicit beneficial-ownership verdicts from the trusted classifier. */
  economicSelfReferencing?: boolean;
  economicSharedBeneficialOwnership?: boolean;
  /**
   * 2026-10-01 : the verified signer of the transaction, when a
   * chain watcher saw value reach the wallet through a contract. The same-owner
   * fence checks it as well as the counterparty, so a transfer one owner routes
   * through a contract to their own wallet still records only.
   */
  economicTransactionSigner?: string | null;
  /**
   * money layer (Prompt 3), pieces 1–4. The PE's `input_origins` (from
   * `provenance_envelopes`, hashed into the PE preimage), the relay-authoritative non-actor witness
   * for THIS submission (taken from device registration / a verified relay observation, NEVER the
   * body), and the token counts. The accrual folds these into the two pricing inputs via
   * `resolveOriginPricingInputs`. Pieces 1–4 seal them INFORMATIONAL (no price change until piece 5);
   * absent/empty on every path that carries no origins, which prices byte-identically to before.
   */
  inputOrigins?: readonly InputOrigin[] | null;
  submissionWitness?: SealedWitness | null;
  /**
   * Fact-base fixes item 4 (2026-09-23): the relay's own verified observation (forge webhook /
   * chain watcher) as the witness for EXACTLY the origins it derived from that event. Set only by
   * `generatePE` for a relay-composed emitter; absent on every other path (byte-identical).
   */
  relayWitnessedOrigins?: RelayWitnessedOrigins | null;
  /**
   * ops-dashboard build. An explicit capture-lane hint from the emitter/daemon (e.g. the
   * daemon's per-plugin `metadata.capture_lane`, or an emitter that knows its lane). When a
   * valid `CaptureLane`, it is sealed verbatim; otherwise the accrual derives the lane from
   * `integrationSource` + `actionType`. PURE observability metadata — never a pricing input.
   */
  captureLane?: string | null;
  /**
   * Trust Layer build (§2.3/§2.8/§2.11). `outputDigests` the PE's citable outputs
   * (already normalized by the route; hashed into the PE preimage there) — the accrual indexes them
   * by hash after the seal (best-effort, first writer wins) and mirrors them on pe_history.
   * `witnessClass` WHO vouched for this PE, declared by the emitter (never the body); sealed
   * informational on the snapshot and mirrored top-level; §2.8 class-based admission prices from it.
   * `witnessedAtMs` the relay's own receipt time (the witnessed time beside the actor's timestamp).
   */
  outputDigests?: readonly OutputDigest[] | null;
  witnessClass?: WitnessClass;
  witnessedAtMs?: number | null;
  /** Tokens a witness observed for the act (body-bound observation), or null. */
  witnessObservedTokens?: number | null;
  /** The actor-declared `compute.tokens_processed` (recorded, adds zero to the multiplier). */
  bodyDeclaredTokens?: number | null;
  /**
   * Trust Layer build §2.5: the structural composition signals the lane derived from the PE's
   * metadata (model families, environment class, attested region, supervision turn counts) —
   * counted into `actor_stats_v1` for the vocabulary. Never priced; metadata-only.
   */
  compositionSignals?: CompositionSignals | null;
  /**
   * Precomputed Genesis snapshot from the crash-safe reservation state machine.
   * Raw fixed amounts are not accepted as a substitute.
   */
  economicSnapshot?: RecordEconomicSnapshot | null;
  /** Re-throw after logging so a durable caller can leave its outbox retryable. */
  throwOnError?: boolean;
  /**
   * a CLAIM that this accrual is backed by a committed durable replay
   * source, verified against that source before it counts for anything.
   *
   * It exists because the two properties were conflated. `throwOnError` is a
   * TRANSPORT posture (re-throw so my caller can retry me); durability is a
   * FACT about whether a deterministic replay input was persisted before
   * acknowledgement. The mainline agent paths co-commit their exact
   * `RecordPEAccrualParams` in the SAME transaction as the chain-tip advance,
   * so they have that fact — and still sealed `record_only` for want of a way
   * to say so.
   *
   * It is NOT a lane switch and NOT an eligibility input. It feeds exactly one
   * thing, `durableEconomicPath`, and only after
   * `verifyOrdinaryAccrualIntakeReplaySource` reads the committed row and finds
   * the live params byte-identical to the stored ones. An unverifiable claim is
   * refused and the accrual seals `record_only`, unchanged.
   *
   * IT LIVES INSIDE THE STORED REPLAY PAYLOAD ON PURPOSE. A replay fires the
   * stored params verbatim, marker included, so the replay and the live call
   * price identically by construction rather than by two lanes agreeing.
   */
  durableReplaySource?: OrdinaryAccrualReplaySource;
  /**
   * (Commons communication): the live speech window this act was written under — the
   * backing burn id and its verified on-chain amount. When present, the sealed record points are
   * reserved against that window's budget in ONE transaction
   * (`core/pvt/speech-window-budget.ts`); a PE that would carry the window's running sum to or
   * past the burn seals `record_only` (`speech_window_budget_exhausted`). Lives inside the stored
   * replay payload like every other pricing input so a replay prices identically. Absent on every
   * non-speech path (byte-identical to before). A SPEECH action type that arrives with no window
   * seals `record_only` (`speech_no_live_pass_record_only`) — no pass, no mint.
   */
  speechWindow?: { readonly burnId: string; readonly burnAmountAtomic: string } | null;
  /** Internal crash-injection seam used only by non-mutating durability tests. */
  durableTestCrashAt?: DurableAccrualCrashPoint | 'before_pe_history' | 'after_pe_history';
  /**
   * PE METER : this act arrived in a signed device batch. It is priced exactly
   * as every other act, then sealed by `core/meter/meter-seal.ts` mint-once claims + a 31-day
   * act key — instead of a `pe_history` row. The batch itself is the durable replay source (the
   * device re-sends it until the relay acknowledges), so a metered act is on the durable path.
   */
  meter?: MeterActBatchContext;
  /**
   * PE METER: the act is recorded into the owner's totals but cannot mint (: an
   * act more than 30 days old when it reaches the relay). Forces the policy record-only path, so
   * it also takes no mint-once slot. The value is the receipt's reason.
   */
  meterRecordOnly?: string;
  /**
   * Shutdown coverage: the relay's own clock when it first durably received this act (a relay
   * act's committed intake time). The accrual end line judges the act by it, so a replay that
   * runs after the end line still settles an act received before it. Relay code only.
   */
  accrualReceivedAtMs?: number;
}

// =============================================================================
// LEGACY DISPLAY ESTIMATOR (NON-AUTHORITATIVE FOR ACCRUAL OR MINTING)
// =============================================================================

const CATEGORY_MULTIPLIERS: Record<PVTCategory, number> = {
  wallet: 1.0,       // wallet_transaction
  agent: 1.5,        // agent_authorization
  x402: 2.0,         // x402_payment
  promises: 2.5,     // promise_fulfillment
  other: 1.0,        // unrecognized / third-party types
};

const ATTESTATION_MULTIPLIERS: Record<'hardware' | 'software', number> = {
  hardware: 1.0,     // Secure Enclave / StrongBox
  software: 0.7,     // Agent SDK
};

/**
 * Historical/prospective financial categories use a neutral attestation factor:
 * chain finality, not device hardware, is their provenance evidence. PVT9 IS
 * configured and settlement-armed (verified against production Secret Manager
 * + the `provian-pvt9-settlement` Cloud Scheduler cron, 2026-08-22) —
 * an eligible financial PE mints on the scheduled cadence, currently every 30 days like any other
 * standard-lane row. ("PVT9 is unconfigured" here was stale, predating
 * arming; do not reintroduce it.) Identity/count-only limits in
 * activity-mint-limits.ts reserve counterparty and daily slots without reading
 * the external-asset amount or a fiat/market quote. `receive` additionally
 * requires a recipient-authored relationship to its counterparty — see
 * `resolveOperationalDisposition` and `core/pvt/policy/receive-authorship.ts`
 * — since it is the one financial type whose triggering act belongs to
 * someone other than the wallet holder.
 */
export const FINANCIAL_FULL_WEIGHT_TYPES = new Set<string>([
  'send', 'receive', 'swap', 'stake', 'unstake', 'x402_payment', 'onramp', 'onramp_order',
]);

// =============================================================================
// CATEGORY CLASSIFICATION
// =============================================================================

/**
 * Categorize a PE action_type into one of four dashboard categories.
 * Moved from server.ts to be shared across modules.
 */
export function categorizeActionType(actionType: string): PVTCategory {
  if (actionType === 'x402_payment') return 'x402';

  // Wallet / on-chain crypto PEs. These are device-originated actions the
  // user takes from the Wallet tab - sends, swaps, approvals, on-ramps,
  // staking, wallet creation, recovery. Without this branch every send/receive
  // falls into the catch-all 'other' category and never appears under the
  // Wallet chip on the Abundance dashboard.
  if (
    actionType === 'send' ||
    actionType === 'receive' ||
    actionType === 'swap' ||
    actionType === 'stake' ||
    actionType === 'unstake' ||
    actionType === 'onramp' ||
    actionType === 'onramp_order' ||
    actionType === 'approve' ||
    actionType === 'REVOKE_APPROVAL' ||
    actionType === 'burn_spam' ||
    actionType === 'wallet_created' ||
    actionType === 'genesis_signup' ||
    actionType === 'genesis_human_signup' ||
    actionType === 'genesis_device_link' ||
    actionType === 'device_register' ||
    actionType === 'device_revoke' ||
    actionType === 'recovery_init' ||
    actionType === 'recovery_action' ||
    actionType === 'recovery_complete' ||
    actionType === 'export_logs'
  ) {
    return 'wallet';
  }

  if (
    actionType.startsWith('promise_') ||
    actionType.startsWith('negotiation_') ||
    actionType === 'agreement' ||
    actionType === 'agreement_settled'
  ) {
    return 'promises';
  }
  if (
    actionType.startsWith('agent_') ||
    actionType.startsWith('egress_') ||
    actionType.startsWith('proxied_') ||
    actionType.startsWith('policy_') ||
    actionType.startsWith('credential_') ||
    actionType.startsWith('request_') ||
    actionType.startsWith('friction_') ||
    actionType.startsWith('anomaly_') ||
    actionType.startsWith('behavior_') ||
    actionType.startsWith('classification_') ||
    actionType.startsWith('environment_') ||
    actionType.startsWith('skill_') ||
    actionType === 'emergency_stop' ||
    // SDK-reported code work (git hooks, Claude Code, Codex, etc.)
    actionType === 'coding_session' ||
    actionType === 'refactor' ||
    actionType === 'test_run' ||
    actionType === 'deployment' ||
    actionType === 'research' ||
    actionType === 'document'
  ) {
    return 'agent';
  }
  // Third-party namespaced types (namespace:action_name format) → agent category
  if (/^[a-z][a-z0-9]*:[a-z]/.test(actionType)) {
    return 'agent';
  }
  // Commons speech and board types are KNOWN members of the 'other' family — deliberately
  // not a new category. A new family would move the dormant governance diversity count
  // (`voting.ts` activeCategories) and add new presentation-vocabulary families (`work.<family>.*`);
  // governance is untouched by ruling. Recognizing them here only stops the "unrecognized" log.
  if (
    actionType.startsWith('commons_') ||
    actionType.startsWith('want_') ||
    actionType === 'job_posted' ||
    actionType === 'human_job_posted'
  ) {
    return 'other';
  }
  // Truly unrecognized types → other category
  console.log(`[PE] Unrecognized action type falling to other category: ${actionType}`);
  return 'other';
}

// =============================================================================
// PVT FORMULA
// =============================================================================

/**
 * Calculate estimated PVT for a single PE.
 * Formula: contributionValue × attestationMultiplier × categoryMultiplier
 * contributionValue is always 1.0 (one PE = one base unit).
 */
export function calculateEstimatedPVT(
  category: PVTCategory,
  attestationDepth: string,
): number {
  // Genesis formula uses simplified 'hardware'/'software' buckets
  const genesisDepth = (attestationDepth === 'hardware' || attestationDepth === 'hardware_full' || attestationDepth === 'hardware_partial')
    ? 'hardware' : 'software';
  return 1.0 * ATTESTATION_MULTIPLIERS[genesisDepth] * CATEGORY_MULTIPLIERS[category];
}

/**
 * Exported (C-2) so the user-facing estimator normalizes the wire tier through
 * the SAME function the accrual seals with, rather than keeping a second copy
 * of the `on_chain_verified` special case beside it.
 */
export function normalizeEconomicAttestationTier(attestationDepth: string): string {
  if (attestationDepth === 'on_chain_verified') return 'corroborated';
  return normalizeAttestationTier(attestationDepth);
}

// =============================================================================
// WEEK BOUNDARY HELPER
// =============================================================================

/**
 * Get Monday 00:00 UTC for the week containing the given timestamp.
 *
 * ONE source (`core/pvt/week-start.ts`), re-exported here for the existing
 * importers. The accrual-time aggregates (`core/pvt/policy/economic-aggregate.ts`)
 * and the durable-accrual effects bucket rows by the same function, so a weekly
 * count written by one and read by another cannot disagree on the boundary.
 */
import { getWeekStart } from './core/pvt/week-start';
export { getWeekStart };

// =============================================================================
// CORE: FIRE-AND-FORGET PE ACCRUAL RECORDING
// =============================================================================

/**
 * Record PVT accrual for a newly created PE.
 *
 * This function computes and seals exact record-time economics, writes the
 * authoritative pe_history row, then updates compatibility aggregates and
 * counters. Durable callers may set throwOnError and await acknowledgement.
 *
 * A caller with no durable replay source is not crash-recoverable: the process
 * can die after their PE write but before this derived history write. They are
 * therefore sealed record-only and never consume novelty/cap authority. Only
 * callers backed by a durable source outbox may retain a nonterminal mint
 * disposition. THAT RULE IS UNCHANGED.
 *
 * What a durable source IS has two forms :
 * - `throwOnError: true` an acknowledged caller owning its own outbox (the
 * five inlets enumerated in); or
 * - `durableReplaySource: 'ordinary_accrual_intake'` a caller that
 * co-committed its EXACT replay params with the chain-tip advance, VERIFIED
 * here against that committed row before it counts ('s mainline agent
 * paths).
 *
 * A caller-supplied `economicSnapshot` is honoured only for the FIRST form.
 * The intake-backed form is a replayability fact about transport; it confers no
 * authority to hand this function a precomputed economic verdict.
 */
/**
 * Resolve the operational disposition override — the PRECEDENCE ORDER among the
 * holds, extracted so the order itself is testable.
 *
 * It was inline, and the negative control: was that the ordering had NO test at
 * all: restoring the original arrangement left the entire backend suite
 * green. An ordering that is load-bearing policy and silently reversible is a
 * defect waiting to be reintroduced, so it now has a name and a suite.
 *
 * THE ORDER IS THE WHOLE POINT. Two shadows were found here in sequence, and
 * both directions matter:
 *
 * 1. `terminallyIneligible` FIRST. `ineligible_terminal` has no exits, while
 * every hold below it reaches `eligible`. When this sat lower, a transient
 * ownership-read throw on an already rate-limited PE downgraded a denial
 * that Security Invariant #9 and pitfall #45 both call TERMINAL.
 * 2. `receiveUnsolicited` ABOVE the recoverable holds, for the SAME reason as
 * (4) below: `record_only` is ALSO terminal (no exit — see
 * `isTerminalMintDisposition`), and once resolved definitively it must
 * not be shadowed by an unrelated, unresolved same-owner check or a
 * transient cache outage on ITS way to a recoverable hold. It sits below
 * `terminallyIneligible` because that branch's reasons (device/user rate
 * limit, no observable output, unverified x402) are unrelated compliance
 * signals that should win outright when both are true.
 * 3. `sameOwnerUnresolvable` (extended to cover `receiveAuthorshipUnresolvable`
 * too,) ABOVE the two recoverable holds. When it sat below, a
 * combined outage sealed `pending_cache` the ONE bucket the backfill
 * promotes to `eligible` automatically, without ever re-running the
 * ownership check — so an unchecked same-owner wash minted unattended
 *. The identical bypass applies to an unresolved authorship
 * check: a `pending_cache` seal on an unresolved receive-authorship read
 * would let the backfill mint an unsolicited receive without ever
 * re-checking authorship. `pending_review` is only ever WRITTEN by that
 * backfill, never cleared by it, so it requires a human.
 */
export function resolveOperationalDisposition(input: {
  readonly durableEconomicPath: boolean;
  readonly policyRecordOnly: boolean;
  readonly terminallyIneligible: boolean;
  readonly sameOwnerUnresolvable: boolean;
  readonly mintClaimUnverifiable: boolean;
  readonly cacheUnavailable: boolean;
  /**, `receive` only: a definitively-resolved verdict that this
   * receive has no recipient-authored relationship to its counterparty.
   * Never set for any other action type. */
  readonly receiveUnsolicited?: boolean;
  /**, `receive` only: the authorship check itself failed (registry
   * read error) — distinct from `receiveUnsolicited`, which means the
   * check SUCCEEDED and found nothing. Routes to the SAME recoverable hold
   * as `sameOwnerUnresolvable`, never to a permanent record_only seal. */
  readonly receiveAuthorshipUnresolvable?: boolean;
  /** the act's counterparty is one of Provian's own fee / gas / revenue
   * wallets and the actor is the payer (`provianServiceFeeApplies`). A service fee is never a
   * price for PVT: record_only `provian_service_fee`, on every lane. A pure address match — no
   * registry read — so it is definitive and terminal. */
  readonly provianServiceFee?: boolean;
}): RecordCalculationInput['operationalDispositionOverride'] {
  if (!input.durableEconomicPath) {
    return {
      mintDisposition: 'record_only',
      mintReasonCode: 'policy_record_only',
      suppressRecordPoints: false,
    };
  }
  if (input.policyRecordOnly) return null;
  if (input.terminallyIneligible) {
    return {
      mintDisposition: 'ineligible_terminal',
      mintReasonCode: 'policy_ineligible',
      suppressRecordPoints: true,
    };
  }
  // a payment to a Provian service wallet is a service fee, never a price for
  // PVT. Definitive (an exact address match, no registry read) and terminal, so — like an
  // unsolicited receive — it sits ABOVE the recoverable holds: an unrelated same-owner / cache
  // outage must not route a fee to a hold the self-heal sweep could later promote to a mint.
  if (input.provianServiceFee) {
    return {
      mintDisposition: 'record_only',
      mintReasonCode: PROVIAN_SERVICE_FEE_REASON_CODE,
      suppressRecordPoints: false,
    };
  }
  if (input.receiveUnsolicited) {
    return {
      mintDisposition: 'record_only',
      mintReasonCode: 'unsolicited_receive_record_only',
      suppressRecordPoints: false,
    };
  }
  if (input.sameOwnerUnresolvable || input.mintClaimUnverifiable || input.receiveAuthorshipUnresolvable) {
    // Persist the GRANULAR cause instead of collapsing all three to `awaiting_review`, so the
    // console can split a parked pending_review row by why it is held. Priority order is stable
    // (owner → mint-claim → receive-authorship) so a row with two flags seals deterministically.
    // Every branch is the SAME recoverable pending_review disposition — no gate, no review step;
    // the self-heal sweep promotes a genuine earner on the evidence it has.
    const mintReasonCode = input.sameOwnerUnresolvable
      ? 'same_owner_unresolvable'
      : input.mintClaimUnverifiable
        ? 'mint_claim_unverifiable'
        : 'receive_authorship_unresolvable';
    return {
      mintDisposition: 'pending_review',
      mintReasonCode,
      suppressRecordPoints: false,
    };
  }
  if (input.cacheUnavailable) {
    return {
      mintDisposition: 'pending_cache',
      mintReasonCode: 'cache_unavailable',
      // Preserve exact record-time points under the sealed policy vintage; the
      // hold makes current value zero until immutable cache-recovery evidence
      // projects it back to eligible.
      suppressRecordPoints: false,
    };
  }
  return null;
}

/**
 * : the in-memory first-sighting check a single-lane act's novelty and occurrence
 * dedupe use instead of a claim document. Scoped to ONE batch (the set lives on its context).
 */
function meterBatchFirstSighting(meter: MeterActBatchContext, key: string): boolean {
  const seen = meter.batchSightings;
  if (seen === undefined) return true;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

export async function recordPEAccrual(params: RecordPEAccrualParams): Promise<void> {
  return retryNoveltyConflict(() => recordPEAccrualAttempt(params, false));
}

async function recordPEAccrualAttempt(
  params: RecordPEAccrualParams,
  retriedMintOnceRace: boolean,
): Promise<void> {
  try {
    // PE METER: a batch's acts read the invariant registry once per batch (`batchPricingReadDb`);
    // every other read, and every transaction, goes to Firestore live.
    const db = params.meter?.readDb ?? relayDb();
    if (params.meter && params.meter.freshBatch !== true) {
      // A retried batch: this act was already sealed. Replay the stored outcome — never re-price.
      // (A batch proven new against its device tip has no sealed act to replay: `freshBatch`.)
      const sealed = await privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(params.peId).get();
      if (sealed.exists) {
        params.meter.sink(outcomeFromKey(sealed.data() as MeterActKeyDoc, true));
        return;
      }
    }
    if (params.throwOnError && !params.meter) {
      const existingEffect = await db.collection(DURABLE_ACCRUAL_EFFECTS_COLLECTION)
        .doc(params.peId)
        .get();
      if (existingEffect.exists) {
        await resumeDurableAccrualEffects(
          db,
          params.peId,
          params.durableTestCrashAt as DurableAccrualCrashPoint | undefined,
        );
        return;
      }
    }
    // Avoid consuming a new activity reservation for a pre-existing history
    // row (including a legacy row that predates reservations). Concurrent first
    // submissions remain safe because the reservation itself is exact-idempotent.
    const existingHistory = params.meter
      ? null
      : await db.collection('pe_history').doc(params.peId).get();
    if (existingHistory?.exists) {
      // Ordinary best-effort replay completion : the PE was
      // already sealed on a prior attempt that may have died before applying
      // its derived aggregates. Finish any omitted effect exactly once from the
      // co-committed outbox. Durable callers are handled by the throwOnError
      // resume above; here throwOnError is falsy, so this stays the ordinary
      // lane and never sets durableEconomicPath or perturbs the sealed
      // economic snapshot. Idempotent: an already-complete outbox is a no-op.
      if (!params.throwOnError) {
        await completeOrdinaryAccrualEffects(db, params);
      }
      console.warn('[PVT] Duplicate PE detected before accrual:', params.peId);
      return;
    }
    const category = categorizeActionType(params.actionType);
    //. TWO ways to BE durable, one meaning. `throwOnError` marks a caller
    // that awaits acknowledgement and owns its own outbox (the five inlets of
    //). `durableReplaySource` marks a caller that co-committed its exact
    // replay input with the chain tip before acknowledging — the mainline agent
    // paths. The second is VERIFIED against that committed row here, never
    // taken on the caller's word, and every refusal arm lands on `false`.
    //
    // The disposition rule below is untouched: "no durable replay source ⇒
    // record_only" still fires exactly as written. What changed is that the
    // mainline path now truthfully answers "yes" to the question it asks.
    // PE METER: the signed batch is the replay source, so a metered act needs no intake row — but
    // it is on the durable path ONLY where it would have been before the meter: its lane claimed a
    // durable replay source (the witnessed overlays set `durableReplaySource`) or its caller owns an
    // acknowledged outbox (`throwOnError`). Anything else still seals record_only, exactly as today.
    // An act older than the 30-day mint window (`meterRecordOnly`) goes into totals and does not
    // mint: it takes the non-durable seal (record_only), and claims no mint-once slot, since those
    // keys live only 30 days.
    // Shutdown coverage (2026-10-20): past the configured accrual end line nothing new accrues —
    // the act seals record_only exactly as a non-durable one does, so it takes no mint-once slot
    // and registers no claim. Judged by when the relay received the act: the caller's committed
    // receipt (`accrualReceivedAtMs`), else for a staged ordinary-intake replay the timestamp its
    // intake row binds (checked by the verifier below before anything can mint), else the clock
    // now. The sealing of an existing Genesis reservation is exempt: admission refuses every act
    // from the end line, and a reservation made before it stays payable.
    const accrualEnded = accrualEndedFor(params, Date.now());
    let durableEconomicPath = !accrualEnded && params.meterRecordOnly === undefined && (params.throwOnError === true
      || (params.meter !== undefined && params.durableReplaySource !== undefined));
    if (!accrualEnded && !durableEconomicPath && params.durableReplaySource !== undefined && params.meter === undefined) {
      const verdict = await verifyOrdinaryAccrualIntakeReplaySource(db, params);
      durableEconomicPath = verdict.durable;
      if (!verdict.durable) {
        // Loud, because a mainline caller that believes it is durable and is
        // not will silently seal terminal record_only PEs — the defect
        // wearing a marker. Never throws: provenance still records.
        console.warn('[PVT] durable replay source REFUSED - sealing record_only', {
          peId: params.peId,
          actionType: params.actionType,
          integrationSource: params.integrationSource ?? null,
          reason: verdict.reason,
        });
      }
    }
    // A PRECOMPUTED economic verdict is accepted only from an acknowledged
    // durable caller — in practice the Genesis reservation state machine, the
    // sole producer of one. The intake-backed form proves REPLAYABILITY, not
    // authority to price, so a snapshot arriving alongside it is ignored and
    // the kernel recomputes. No caller does both today; this is here so none
    // can start to by accident.
    const suppliedEconomicSnapshot: RecordEconomicSnapshot | null =
      params.throwOnError === true ? (params.economicSnapshot ?? null) : null;
    const hasReservedGenesisSnapshot =
      durableEconomicPath
      && suppliedEconomicSnapshot?.recordTimeFactors.fixedGrantSource
        === 'genesis_campaign_reservation';

    // atomic accounting action-policy gate. Only the live catalog cut line plus source-
    // verified current emitters distinguish known launch traffic; the broader
    // proposed union cannot bypass the queue. Gate 1 approval does not activate
    // runtime economics. A genuinely unseen identifier is durably queued, alerts
    // the operator, and is sealed record-only. A prepared prospective candidate
    // is also inert until an exact, signed activation record reaches its future
    // effective boundary; automation cannot activate it.
    // : the relay-ASSIGNED witness class (never body-supplied; absent →
    // actor_declared). It admits an UNNAMED type at its class base and lifts a hardware-rooted
    // named row to 4.0×; every other named row is priced exactly as before (byte-identical).
    const sealedWitnessClass: WitnessClass = normalizeWitnessClass(params.witnessClass);
    const actionPolicyResolution = await resolveActionPolicyAtRecordTime(db, {
      actionType: params.actionType,
      recordedAtMs: params.timestamp,
      witnessClass: sealedWitnessClass,
    });
    const monetaryPolicy = withWitnessClassOverride(
      await loadRuntimeMonetaryPolicy(
        db,
        params.timestamp,
        actionPolicyResolution,
      ),
      params.actionType,
      sealedWitnessClass,
    );
    const resolvedActionPolicy = monetaryPolicy.actions[params.actionType];
    // Best-effort callers have no exact durable replay input. They may record
    // provenance, but must not reserve mint-once/cap authority or create a PE
    // that could later settle after a crash gap.
    const policyRecordOnly = !durableEconomicPath || (
      suppliedEconomicSnapshot !== null
        ? suppliedEconomicSnapshot.mintDisposition === 'record_only'
          || suppliedEconomicSnapshot.mintDisposition === 'ineligible_terminal'
        : resolvedActionPolicy === undefined
          || resolvedActionPolicy.mintDisposition === 'record_only'
          || resolvedActionPolicy.mintDisposition === 'ineligible_terminal'
    );

    // the three per-user VOLUME ceilings are REMOVED —
    // the 200/hour PE cap, the 2000/day PE cap, and the 50/day qualification
    // ordinal. PVT is an exponential currency: lifetime earning is
    // uncapped by design, and no fixed number can ride an exponential. Volume
    // is never refused or zeroed; what bounds a runaway is the evidence layer
    // (mint-once claims, chain verification, per-action identity anti-farm
    // caps, novelty pricing) plus the on-chain epoch caps. The Redis counters
    // themselves REMAIN: `dailyCount` seals the truthful `dailyOrdinal`
    // provenance evidence and `occurrenceCount` drives novelty pricing —
    // counting is a statement of fact, not a limit.
    //
    // Audit Pass 2 follow-up (2026-05-13): use the *Strict counter variants
    // so a Redis outage (client unconfigured OR transient error) throws
    // CacheUnavailableError instead of silently returning 0. The previous
    // path used cache.isEnabled() as a binary gate, which catches the
    // unconfigured case but misses transient runtime errors - those would
    // return 0 and let accrual proceed at full PVT against a stale view of
    // the counters. The strict variants close that gap.
    const pricingCounters = params.meter?.pricingCounters ?? new BatchPricingCounters();
    let dailyCount = 0;
    let occurrenceCount = 0;
    let cacheUnavailable = false;
    let cacheUnavailableReason: string | null = null;
    if (!policyRecordOnly) {
      try {
        [dailyCount, occurrenceCount] = await pricingCounters.counts(db, cache,
          params.userId, params.actionType, params.timestamp);
      } catch (err) {
        if (err instanceof NoveltySealsPausedError) throw err;
        cacheUnavailable = true;
        cacheUnavailableReason = err instanceof Error ? err.message : String(err);
        console.warn('[PVT] pvt_accrual_redis_unavailable - recording PE with mint_status=pending_cache', {
          userId: params.userId,
          actionType: params.actionType,
          reason: cacheUnavailableReason,
        });
      }
    }

    // [SEC-device-dedup] Device-level rate limit for setup PEs (anti-reinstall-farming)
    // When rate-limited: PE still records in pe_history (a PE is a PE), but earns 0 PVT.
    let deviceRateLimited = false;
    if (!policyRecordOnly && isDeviceRateLimited(params.actionType)) {
      const rateLimitResult = await checkDevicePERateLimit(
        params.deviceAttestationId,
        params.deviceId,
        params.actionType,
        params.peId,
      );
      if (!rateLimitResult.allowed) {
        console.warn('[PVT] Device PE rate limit - recording PE with 0 PVT:', {
          userId: params.userId,
          actionType: params.actionType,
          anchor: rateLimitResult.anchor,
          reason: rateLimitResult.reason,
        });
        deviceRateLimited = true;
      }
    }

    // Resolve beneficiary status for linked agents. Agent-owned devices start
    // at software; any separate replication/corroboration PE upgrade still uses
    // the same beneficiary routing. Attestation must never bypass the split.
    // Keep the legacy software fallback for callers that predate ownerType.
    let beneficiaryInfo: BeneficiaryCacheEntry = {
      linked: false,
      humanWalletId: null,
      humanUserId: null,
      humanAddress: null,
      agentShareBps: null,
    };
    let beneficiaryRegistryUnverifiable = false;
    const shouldResolveAgentBeneficiary = params.ownerType === 'agent'
      || (params.ownerType === undefined && params.attestationDepth === 'software');
    if (shouldResolveAgentBeneficiary) {
      try {
        // A meter batch reads the registry through its per-batch memo (`readDb`); every other
        // path keeps the default store.
        beneficiaryInfo = params.meter?.readDb !== undefined
          ? await resolveBeneficiary(params.userId, cache, params.meter.readDb)
          : await resolveBeneficiary(params.userId, cache);
      } catch {
        // A registry read failure is not evidence that the agent is unlinked.
        // Seal it as unverifiable so economics fail closed pending recovery.
        beneficiaryRegistryUnverifiable = true;
      }
    }

    const mintCompliance = await evaluateMintCompliance(params.userId,
      params.isGenesisGrant ? null : beneficiaryInfo.humanAddress, params.meter?.readDb);

    const mintOnceClaimPlans: PreparedMintOnceClaim[] = [];
    let mintClaimUnverifiable = false;

    // Artifact novelty is an exact Firestore claim, not a best-effort Redis
    // set. The claim is prepared read-only here and commits atomically with
    // pe_history below, so a crash cannot consume novelty without its PE.
    let isUniqueArtifact = false;
    if (params.artifact_hash && !policyRecordOnly
      && resolvedActionPolicy?.category !== 'compute') {
      mintClaimUnverifiable = true;
      console.error('[PVT] Artifact novelty supplied for a non-compute action; holding for review');
    } else if (params.artifact_hash && !policyRecordOnly && params.meter?.singleLane === true) {
      // : a single-lane act keeps no per-act claim document.
      // Its artifact is novel unless this same batch already carried it; across batches the
      // device's hash-chained, sequenced batches are what stop a re-report (`act-witness-lanes.ts`).
      isUniqueArtifact = meterBatchFirstSighting(params.meter, `artifact:${params.artifact_hash}`);
    } else if (params.artifact_hash && !policyRecordOnly) {
      try {
        const artifactClaim = await prepareArtifactNoveltyClaim(
          db,
          params.userId,
          params.artifact_hash,
          params.peId,
          params.timestamp,
        );
        mintOnceClaimPlans.push(artifactClaim);
        isUniqueArtifact = artifactClaim.evidence.relation === 'owner';
      } catch (error) {
        mintClaimUnverifiable = true;
        console.error('[PVT] Artifact novelty claim unverifiable; holding for review:', error);
      }
    }

    // Cross-witness commit mint-once. A commit may be witnessed by the local
    // observer (coding_session) AND a forge webhook (service:github_commit,
    // service:gitlab_push, ...). The first PE to claim (user, commit_sha)
    // mints; later witnesses record for chain integrity but earn 0 PVT
    // (mint_status='corroborated_duplicate'). The forge path still emits its
    // corroboration signal to upgrade the original PE - only the second mint
    // is suppressed, never the signal. Throws fail closed (no mint) via the
    // outer catch rather than risk a double mint.
    let crossWitnessDuplicate = false;
    // A permanently record-only unknown/prospective type must not reserve the
    // underlying work event ahead of a known eligible observer/forge witness.
    // Its PE remains recorded and queued, but it cannot consume mint authority.
    //
    // the claim is PREPARED here (its `relation` feeds `exactDuplicate`
    // below and must be read pre-snapshot), but its COMMIT into
    // `mintOnceClaimPlans` is DEFERRED until the sealed disposition is known (the
    // block just after the farm-cap recompute below). The pre-snapshot
    // `!policyRecordOnly` guard only skips policy-record-only TYPES;
    // it cannot see a KNOWN priced type that `computeRecordSnapshot` later floors
    // to terminal `record_only`. evidence pricing a software-tier
    // forge webhook (`service:github_commit`, ...) is exactly that: admitted here,
    // floored afterward. A terminal zero-priced witness must not consume the
    // (user, commit_sha) slot ahead of a later MINTABLE witness for the same
    // commit (the flagship hardware-attested Mac-SE device PE).
    let preparedCommitClaim: PreparedMintOnceClaim | null = null;
    // the best-value TAKEOVER plan, built pre-snapshot when this witness
    // out-weighs an incumbent that still holds the (user, commit_sha) slot. Its
    // COMMIT into `mintOnceClaimPlans` is deferred (with the owner-claim commit
    // below) until the taker's own disposition is sealed non-terminal — a taker
    // that seals terminal must never demote a good incumbent.
    let commitTakeover: PreparedMintOnceClaim | null = null;
    // when THIS witness is a strictly-LOWER-base cross-witness of a
    // commit an incumbent already owns (forge-first → this daemon), the incumbent
    // is the settling WINNER and this witness corroborates IT. Deferred to after
    // the seal (below), so the lift lands on the winner in BOTH arrival orders.
    let corroborateIncumbentPeId: string | null = null;
    if (params.commitSha && !policyRecordOnly) {
      try {
        preparedCommitClaim = await prepareCommitMintClaim(
          db,
          params.userId,
          params.commitSha,
          params.peId,
        );
        crossWitnessDuplicate = preparedCommitClaim.evidence.relation === 'duplicate';
        // The incumbent owns the claim. Compare BASE weight (forge service:* 3.0×
        // vs coding_session 1.0×), which is policy-derived and so decidable here —
        // it must be, since a takeover sets crossWitnessDuplicate for the snapshot.
        //   takeover              → this witness wins: mints as owner (duplicate →
        //     false) and the incumbent is demoted inside writePEHistory; the
        //     corroboration is sealed on THIS row there.
        //   corroborate_incumbent → the incumbent wins: this stays a duplicate and
        //     corroborates the incumbent after the seal.
        if (crossWitnessDuplicate && resolvedActionPolicy !== undefined) {
          const incumbentPeId = preparedCommitClaim.evidence.claim.owner_pe_id;
          const witnessAction = await evaluateCommitWitness(db, {
            incumbentPeId,
            newBaseWeightBps: resolvedActionPolicy.baseWeightBps,
          });
          if (witnessAction === 'takeover') {
            commitTakeover = prepareCommitTakeoverPlan({
              incumbentClaim: preparedCommitClaim.evidence.claim,
              newOwnerPeId: params.peId,
              newOwnerUserId: params.userId,
              nowMs: params.timestamp,
            });
            crossWitnessDuplicate = false;
          } else if (witnessAction === 'corroborate_incumbent') {
            corroborateIncumbentPeId = incumbentPeId;
          }
        }
      } catch (error) {
        if (error instanceof ClosedCrossWitnessOccurrenceError) crossWitnessDuplicate = true;
        else {
        mintClaimUnverifiable = true;
        console.error('[PVT] Commit mint claim unverifiable; holding for review:', error);
        }
      }
    }

    // Exact economics are calculated below after every record-time gate is
    // known. There is no floating fallback: an unverifiable input records zero.
    let estimatedPVT = 0;
    let attestationMultiplierAtAnchor: number | null = null;

    // x402 minting is CHAIN-VERIFIED ONLY ("Unknown = Block", Option B). The sole
    // trustworthy witness is the outbound-USDC watcher, which read the real on-chain
    // USDC Transfer log (the EIP-3009 signer is the Transfer `from` even though a
    // facilitator submitted the tx) and stamps `x402ChainVerified === true`. The SDK
    // self-report paths (/v1/pe/submit-sovereign, /v1/relay/action, device
    // /v1/pe/submit) supply a CLIENT-controlled settlement hash with no on-chain
    // check, so trusting their mere presence let a registered agent mint ~50
    // full-weight x402/day with fabricated hashes. They never set x402ChainVerified.
    //   - chain-verified (payer + tx_hash present): the FIRST source to record
    //     (payer, tx_hash) mints; a later chain-verified source (or a replay) of the
    //     SAME settlement records but earns 0 PVT and does NOT re-count
    //     (x402Duplicate → 'corroborated_duplicate'). payer + tx_hash still key that
    //     cross-source mint-once dedup (x402-tx-mint-claim.ts).
    //   - NOT chain-verified (a self-report, or a chain-verified emit missing
    //     payer/tx): the payment is unproven, so it records provenance but mints 0
    //     and does NOT count x402 reputation (x402Unverified → 'x402_unverified').
    // Only evaluated when the PE is otherwise mintable, so the verdict is attributed
    // to the x402 gate rather than masked by a rate limit. See x402-tx-mint-claim.ts.
    //
    // MINT-ONCE UNDER A REDIS OUTAGE (2026-09-04, the hole d06cc643 closed for
    // `completion`, closed here for this kind): the claim is prepared REGARDLESS
    // of `cacheUnavailable`. An outage seals this row `pending_cache`, which the
    // hourly backfill later flips to `eligible` WITHOUT re-running any claim —
    // so a claim skipped here left the (payer, settlement tx) slot FREE for a
    // second chain-verified source of the SAME settlement to claim and mint:
    // ONE settlement, TWO eligible rows. The claim is a Firestore transaction
    // (not a Redis counter), so nothing about the outage prevents it; the plan
    // is pushed into `mintOnceClaimPlans` here and committed by writePEHistory
    // in the seal transaction for EVERY seal, `pending_cache` included. The key
    // is derived by `x402MintClaimKey` — the one rule the backfill's slot
    // inspection also reads.
    let x402Duplicate = false;
    let x402Unverified = false;
    if (
      params.actionType === 'x402_payment' &&
      !policyRecordOnly &&
      !deviceRateLimited && !crossWitnessDuplicate
    ) {
      const x402Key = x402MintClaimKey(params);
      if (x402Key !== null) {
        try {
          const x402Claim = await prepareX402TxMintClaim(
            db,
            x402Key.payer,
            x402Key.settlementTx,
            params.peId,
            params.userId,
          );
          mintOnceClaimPlans.push(x402Claim);
          x402Duplicate = x402Claim.evidence.relation === 'duplicate';
        } catch (error) {
          if (error instanceof ClosedCrossWitnessOccurrenceError) x402Duplicate = true;
          else {
          mintClaimUnverifiable = true;
          x402Unverified = true;
          console.error('[PVT] x402 settlement claim unverifiable; recording zero:', error);
          }
        }
      } else {
        // No chain-verified witness → unmintable. Records provenance only; a later
        // watcher emit of the real settlement is what mints (exactly once).
        x402Unverified = true;
      }
    }

    // sovereign agent-work occurrence mint-once. Set ONLY by the sovereign-pe
    // route after the per-occurrence agent-key binding verified against the earning
    // agent address. The first PE to claim (address, occurrence) mints; a replay of
    // the same occurrence records for chain integrity but earns 0 PVT (duplicate →
    // exactDuplicate below). A bare relay submission never sets these params, so it
    // can neither claim nor mint. Throws fail closed (hold for review, no mint).
    let occurrenceDuplicate = false;
    if (params.sovereignWorkOccurrenceId && params.sovereignWorkSignerAddress
      && !policyRecordOnly) {
      try {
        const occurrenceClaim = await prepareOccurrenceMintClaim(
          db,
          params.sovereignWorkSignerAddress,
          params.sovereignWorkOccurrenceId,
          params.peId,
          params.userId,
        );
        mintOnceClaimPlans.push(occurrenceClaim);
        occurrenceDuplicate = occurrenceClaim.evidence.relation === 'duplicate';
      } catch (error) {
          if (error instanceof ClosedCrossWitnessOccurrenceError) occurrenceDuplicate = true;
          else {
        mintClaimUnverifiable = true;
        console.error('[PVT] Occurrence mint claim unverifiable; holding for review:', error);
          }
      }
    }

    // device-witnessed compute occurrence mint-once (the residual (b) fix).
    // Set ONLY by the device-witnessed verified overlay when a BODY-BOUND
    // submission of a device-witnessed compute family carries a derivable
    // canonical event. The first PE to claim (economic actor, canonical-event
    // digest) mints; a replay of the identical body-bound submission records for
    // chain integrity but earns 0 PVT (duplicate → exactDuplicate below → novelty
    // 0 → corroborated_duplicate). This is the HARD parallel of the sovereign
    // occurrence claim above — Build A dedup'd these families only via the SOFT
    // per-UTC-day artifact-novelty claim, which floored at 0.3× and reset daily,
    // so an identical replay minted again. Pushed unconditionally (like the
    // sovereign occurrence): the canonical event is one actor's own work, so
    // there is no higher-value later witness to release the slot for (unlike the
    // cross-witness COMMIT claim's deferred/best-value handling). Throws fail
    // closed (hold for review, no mint) rather than risk a double mint.
    let deviceOccurrenceDuplicate = false;
    if (params.deviceWitnessedOccurrenceHash && !policyRecordOnly && params.meter?.singleLane === true) {
      // Single-lane keeps no act key, but its canonical occurrence still mints once
      // across every batch (fix run 2026-10-24): a second sighting in this batch, or a claim an
      // earlier batch already holds, is a duplicate; otherwise the claim is created by the batch
      // commit's own transaction (`singleLaneOccurrenceClaimHook`), never assumed.
      deviceOccurrenceDuplicate = !meterBatchFirstSighting(params.meter, `occurrence:${params.deviceWitnessedOccurrenceHash}`);
      // a chain-continuity record (the only `noObservableOutput` act) mints nothing and keeps
      // no claim; its sighting above is all it ever took.
      if (!deviceOccurrenceDuplicate && params.noObservableOutput !== true) {
        try {
          if (params.meter.occurrences) {
            deviceOccurrenceDuplicate = !await params.meter.occurrences.claim(params.userId, params.deviceWitnessedOccurrenceHash);
          } else {
          const occurrenceClaim = await prepareDeviceOccurrenceMintClaim(
            db,
            params.userId,
            params.deviceWitnessedOccurrenceHash,
            params.peId,
          );
          deviceOccurrenceDuplicate = occurrenceClaim.evidence.relation === 'duplicate'
            || await singleLaneOccurrenceClaimed(db, occurrenceClaim);
          if (!deviceOccurrenceDuplicate) pricingCounters.addHook(singleLaneOccurrenceClaimHook(db, occurrenceClaim, params.meter.occurrenceAtMs));
          }
        } catch (error) {
          mintClaimUnverifiable = true;
          console.error('[PVT] Single-lane occurrence mint claim unverifiable; holding for review:', error);
        }
      }
    } else if (params.deviceWitnessedOccurrenceHash && !policyRecordOnly) {
      try {
        const deviceOccurrenceClaim = await prepareDeviceOccurrenceMintClaim(
          db,
          params.userId,
          params.deviceWitnessedOccurrenceHash,
          params.peId,
        );
        mintOnceClaimPlans.push(deviceOccurrenceClaim);
        deviceOccurrenceDuplicate = deviceOccurrenceClaim.evidence.relation === 'duplicate';
      } catch (error) {
          if (error instanceof ClosedCrossWitnessOccurrenceError) deviceOccurrenceDuplicate = true;
          else {
        mintClaimUnverifiable = true;
        console.error('[PVT] Device occurrence mint claim unverifiable; holding for review:', error);
          }
      }
    }

    // B11 — cross-source mint-once for the priced chain-financial
    // family, closing the residual: ONE canonical on-chain settlement
    // must never mint through two sources or two seal keys. `x402_payment`
    // already carries its own (payer,txHash) claim above; this extends the
    // identical exactly-once guarantee to the REST of the family (send /
    // receive / swap / agent_* transfers), keyed (settling address, txHash).
    // Family membership derives from the ARMED template's own canonical-event
    // group — never a redeclared type list. Only a chain-verified
    // submission can claim: `economicEvidenceState === 'verified'` is stamped
    // solely by trusted server verifiers (the outbound watcher's durable emit
    // today; `/transfer/record`'s on-chain check if ever promoted durable), and
    // the canonical event id must be the settlement TX HASH. A future durable
    // promotion of the self-report routes therefore collides HERE — duplicate
    // → records for chain integrity, mints 0 — instead of double-minting.
    //
    // MINT-ONCE UNDER A REDIS OUTAGE (2026-09-04): prepared REGARDLESS of
    // `cacheUnavailable`, for the same reason as the x402 claim above — an
    // outage row sealed `pending_cache` with no claim left the (settling
    // address, canonical event) slot free for a second chain-verified source of
    // the same settlement, and the backfill made both eligible. The plan is
    // committed in the seal transaction for every seal, `pending_cache`
    // included. Family membership, the tx-keyed event form, and the settling
    // address are ONE derivation (`financialSettlementMintClaimKey`), read here
    // and by the backfill's slot inspection.
    let financialSettlementDuplicate = false;
    if (
      !policyRecordOnly
      && !deviceRateLimited && !crossWitnessDuplicate
    ) {
      const financialKey = financialSettlementMintClaimKey({
        actionType: params.actionType,
        canonicalEventGroup: resolvedActionPolicy?.canonicalEventGroup ?? null,
        economicEvidenceState: params.economicEvidenceState ?? null,
        economicCanonicalEventId: params.economicCanonicalEventId ?? null,
        walletAddress: params.walletAddress ?? null,
      });
      if (financialKey !== null) {
        try {
          const financialClaim = await prepareFinancialSettlementMintClaim(
            db,
            financialKey.settlingAddress,
            financialKey.settlementEventId,
            params.peId,
            params.userId,
          );
          mintOnceClaimPlans.push(financialClaim);
          financialSettlementDuplicate = financialClaim.evidence.relation === 'duplicate';
        } catch (error) {
          if (error instanceof ClosedCrossWitnessOccurrenceError) financialSettlementDuplicate = true;
          else {
          mintClaimUnverifiable = true;
          console.error('[PVT] Financial settlement claim unverifiable; holding for review:', error);
          }
        }
      }
      // An unverified or non-tx-keyed submission prepares no claim: on the
      // durable path such a row seals pending_evidence under the family's own
      // `base_final_chain_receipt` requirement, so it cannot mint anyway.
    }

    // the COMPLETION mint-once claim, ON-CHAIN witness side. Set only by
    // the institution-completion watcher for an escrow release / resolution paid
    // to the recipient, and only claimed when this row is chain-VERIFIED (a
    // verdict-less watcher row seals pending_evidence and must not hold the
    // slot). The first witness of a job's completion to claim (beneficiary,
    // canonical completion id) owns it:
    //   owner     → this on-chain row mints as usual;
    //   duplicate → the slot is held. If the incumbent is the resolver-promoted
    //               OFF-CHAIN confirmation witness, still eligible and NOT yet
    //               registered for settlement, this witness TAKES OVER (the
    // best-supported value wins — the operator,) and the incumbent
    //               is demoted inside writePEHistory; otherwise (registered — too
    // late, or an on-chain incumbent) this row records the
    //               duplicate and mints 0. The commit of the OWNER plan is
    // deferred to the sealed-mintable block below : a
    //               same-owner release that seals record_only must not reserve
    //               the slot ahead of the off-chain witness.
    let completionDuplicate = false;
    let preparedCompletionClaim: PreparedMintOnceClaim | null = null;
    let completionTakeover: PreparedMintOnceClaim | null = null;
    const completionCanonicalId = typeof params.completionCanonicalId === 'string'
      && params.completionCanonicalId.trim().length > 0
      ? params.completionCanonicalId.trim()
      : null;
    //
    // the claim is prepared REGARDLESS of
    // `cacheUnavailable`. A Redis outage seals this row `pending_cache`, which
    // the hourly backfill later flips to `eligible` WITHOUT re-running any
    // claim — so a claim skipped here left the slot FREE for the resolver-
    // promoted off-chain witness of the same job, and the backfill then made
    // this row eligible beside it: ONE act, TWO eligible rows. The claim is a
    // Firestore transaction (not a Redis counter), so nothing about the outage
    // prevents it; the deferred commit below already reserves an owner plan for
    // every NON-TERMINAL seal (pending_cache is one), exactly as the commit and
    // occurrence claims do under the same outage.
    if (
      completionCanonicalId !== null
      && params.economicEvidenceState === 'verified'
      && !policyRecordOnly
      && !deviceRateLimited && !crossWitnessDuplicate
    ) {
      try {
        preparedCompletionClaim = await prepareCompletionMintClaim(
          db,
          params.userId,
          completionCanonicalId,
          params.peId,
          params.timestamp,
        );
        completionDuplicate = preparedCompletionClaim.evidence.relation === 'duplicate';
        if (completionDuplicate) {
          const incumbentPeId = preparedCompletionClaim.evidence.claim.owner_pe_id;
          const witnessAction = await evaluateCompletionWitness(db, {
            incumbentPeId,
            newWitness: 'onchain_release',
          });
          if (witnessAction === 'takeover') {
            completionTakeover = prepareCompletionTakeoverPlan({
              incumbentClaim: preparedCompletionClaim.evidence.claim,
              newOwnerPeId: params.peId,
              newOwnerUserId: params.userId,
              nowMs: params.timestamp,
            });
            completionDuplicate = false;
          }
        }
      } catch (error) {
        if (error instanceof ClosedCrossWitnessOccurrenceError) completionDuplicate = true;
        else {
        mintClaimUnverifiable = true;
        console.error('[PVT] Completion mint claim unverifiable; holding for review:', error);
        }
      }
    }

    let farmCapped = false;
    let farmCapReason: SealedFarmCapReason | null = null;
    let activityMintReservation: ActivityMintReservationDocument | null = null;
    let activityMintReservationHash: string | null = null;

    // A caller-supplied/precomputed nonterminal snapshot is honored only on an
    // ACKNOWLEDGED durable path (`suppliedEconomicSnapshot` is already null for
    // every other caller, including the intake-backed one). Otherwise recompute
    // under the active policy and apply the record-only durability override.
    let economicSnapshot: RecordEconomicSnapshot | null = durableEconomicPath
      ? suppliedEconomicSnapshot
      : null;
    // Same-owner (self-dealing) detection. The beneficial-ownership guard in
    // monetary-accounting has always been armed on 90 action types, but its two
    // inputs had NO producer anywhere in the tree, so both were permanently
    // false and the guard could never fire. This is that producer. An explicit
    // verdict from a trusted classifier still wins; detection only fills the gap.
    let sameOwnerUnresolvable = false;
    let detectedSelfReferencing = params.economicSelfReferencing === true;
    let detectedSharedOwnership = params.economicSharedBeneficialOwnership === true;
    if (!detectedSelfReferencing && !detectedSharedOwnership && params.counterpartyAddress) {
      // `actingWalletId` is NOT passed. `params.userId` is the agent_id on
      // agent PEs (`generatePE` sets `userId: params.agentId`), so feeding it in
      // as a wallet id made the wallet-level comparison structurally unreachable.
      // The detector resolves the acting wallet from the agent registration
      // index itself.
      const verdict = await detectSameOwnerTransfer(db, {
        economicActorId: params.userId,
        counterpartyAddress: params.counterpartyAddress,
      });
      detectedSelfReferencing = verdict.selfReferencing;
      detectedSharedOwnership = verdict.sharedBeneficialOwnership;
      sameOwnerUnresolvable = verdict.unresolvable;
      if (verdict.selfReferencing || verdict.sharedBeneficialOwnership) {
        console.warn(`[PVT] same-owner transfer detected, sealing record_only: ${verdict.reason}`);
      }
    }
    // review: value that reached the wallet THROUGH A CONTRACT the same
    // owner called. The verified transaction signer is checked as well, so the
    // same-owner fence is not bypassed by routing through a forwarder. A bundler
    // or any stranger signer changes nothing; an unreadable registry holds.
    const signer = typeof params.economicTransactionSigner === 'string'
      ? params.economicTransactionSigner.toLowerCase()
      : null;
    if (!detectedSelfReferencing && !detectedSharedOwnership && !sameOwnerUnresolvable
      && signer !== null && params.counterpartyAddress
      && signer !== params.counterpartyAddress.toLowerCase()) {
      const verdict = await detectSameOwnerTransfer(db, {
        economicActorId: params.userId,
        counterpartyAddress: signer,
      });
      detectedSelfReferencing = verdict.selfReferencing;
      detectedSharedOwnership = verdict.sharedBeneficialOwnership;
      sameOwnerUnresolvable = verdict.unresolvable;
      if (verdict.selfReferencing || verdict.sharedBeneficialOwnership) {
        console.warn(`[PVT] same-owner transfer through a contract (signer), sealing record_only: ${verdict.reason}`);
      }
    }
    // the COMPLETION family: the
    // on-chain completion witness (a row carrying a completion canonical id) and
    // the `verified_substantive_outcome` class (bound to the ARMED policy, never
    // a redeclared type list). For these rows the counterparty IS the anti-self-
    // dealing guarantee, so a counterparty the fence cannot read — absent,
    // or a non-empty string that is not a well-formed EVM address (a wallet id
    // persisted as `poster_address` reached here in production through the
    // Commons session-token branch) — is UNRESOLVABLE, not "no counterparty".
    // `detectSameOwnerTransfer` reports such an input as `no_counterparty_address`
    // with `unresolvable:false`, which this fence read as "distinct owner" and
    // passed. Unknown = Block: it routes to the same recoverable `pending_review`
    // hold an unreadable registry does (`resolveOperationalDisposition`), so the
    // row never joins the held population a confirmation could promote. A
    // trusted classifier's explicit same-owner verdict still wins (record_only).
    const completionFamilyRow = completionCanonicalId !== null
      || resolvedActionPolicy?.evidenceRequirement === 'verified_substantive_outcome';
    const counterpartyPresent = typeof params.counterpartyAddress === 'string'
      && params.counterpartyAddress.length > 0;
    if (completionFamilyRow && !detectedSelfReferencing && !detectedSharedOwnership
      && !sameOwnerUnresolvable
      && !isResolvableCounterpartyAddress(params.counterpartyAddress)) {
      sameOwnerUnresolvable = true;
      console.warn('[PVT] completion counterparty unresolvable (absent or not an EVM address); holding for review', {
        peId: params.peId,
        actionType: params.actionType,
        counterpartyPresent,
      });
    }

    // Receive-authorship gate (unsolicited-inbound-transfer scope only,).
    // `receive` is the one financial PE type whose triggering act belongs to
    // someone other than the wallet holder - every other financial PE (send,
    // swap, onramp, x402, escrow/job settle) fires on the holder's OWN
    // key-signed act. An unsolicited receive with no recipient-authored
    // relationship to its counterparty seals record_only: fully witnessed and
    // in the books, zero mint. Public-summary exclusion is a SEPARATE, LIVE
    // gate: inbound-usdc-watcher.ts deliberately does NOT call this detector
    // (baking its verdict into the immutable PE would break retry
    // idempotency - see that file's header), so `activity_mapped` there stays
    // unconditional. The public-facing exclusion instead lives in
    // core/public-record/financial-activity.ts, which looks up THIS PE's
    // pe_history disposition fresh on every summary read.
    // record_only is terminal with no exit, so a relationship formed later
    // never revalues an already-sealed PE's mint_disposition - but the public
    // summary's live lookup means a LATER-arriving pe_history write (a race
    // with recordPEAccrual, or a backfill) resolves correctly on the very
    // next summary read, without permanently punishing an earlier miss.
    // Strictly scoped to actionType === 'receive' so every other action type
    // is byte-identical - both new fields default to false below.
    let receiveUnsolicited = false;
    let receiveAuthorshipUnresolvable = false;
    if (params.actionType === 'receive' && params.counterpartyAddress) {
      const authorshipVerdict = await resolveReceiveAuthorship(db, {
        economicActorId: params.userId,
        walletAddress: params.walletAddress ?? null,
        counterpartyAddress: params.counterpartyAddress,
      });
      receiveUnsolicited = !authorshipVerdict.authored && !authorshipVerdict.unresolvable;
      receiveAuthorshipUnresolvable = authorshipVerdict.unresolvable;
      if (receiveUnsolicited) {
        console.warn(`[PVT] unsolicited receive, sealing record_only: ${authorshipVerdict.reason}`);
      }
    }

    // ( follow-up): a service fee is never a price for PVT. An act
    // whose counterparty is one of Provian's own fee / gas / revenue wallets — the facilitator fee
    // leg, the on-demand payout's $1 charge, a gas top-up — never mints for the PAYER, on ANY
    // lane: every lane reaches this one seal, which records it `record_only`
    // (`provian_service_fee`). A `receive` FROM a Provian wallet is not a fee and is untouched
    // (`provian-service-wallets.ts`). The x402 facilitator lane's own acts (buyer → seller,
    // seller ← buyer) never name a service wallet, so they price exactly as before.
    const provianServiceFee = provianServiceFeeApplies(params.actionType, params.counterpartyAddress);
    if (provianServiceFee) {
      console.warn(`[PVT] payment to a Provian service wallet, sealing record_only (${PROVIAN_SERVICE_FEE_REASON_CODE})`, {
        peId: params.peId,
        actionType: params.actionType,
      });
    }

    // money layer (Prompt 3), pieces 1–4. Resolve the two pricing inputs and record the
    // reference-graph edges for EVERY PE that carries origins — from envelope one, whatever its mint
    // disposition. Fail-closed and side-effect-safe: an empty/absent `inputOrigins` returns count 0
    // with no reads and no edges (byte-identical to before), and every resolver failure floors the
    // count to 0 rather than over-counting. The graph write is best-effort and never fails the seal.
    const originPricing = await resolveOriginPricingInputs(db, cache, {
      economicActorId: params.userId,
      walletAddress: params.walletAddress ?? null,
      peId: params.peId,
      nowMs: params.timestamp,
      inputOrigins: params.inputOrigins ?? [],
      // §2.1: the retired `cited_pe_ids` vocabulary folds into the same graph as unwitnessed edges.
      citedPeIds: params.citedPeIds ?? null,
      submissionWitness: params.submissionWitness ?? null,
      relayWitnessedOrigins: params.relayWitnessedOrigins ?? null,
      witnessObservedTokens: params.witnessObservedTokens ?? null,
      bodyDeclaredTokens: params.bodyDeclaredTokens ?? null,
      // PE METER: the batch commit writes the edges (and their pair counts) with the act's key.
      batchEdges: params.meter ? (params.meter.batchEdges ?? newBatchOriginEdges()) : null,
    });

    let computedSnapshotInput: RecordCalculationInput | null = null;
    if (economicSnapshot === null) {
      const linkageState: LinkageState = beneficiaryRegistryUnverifiable
        ? 'unverifiable'
        : beneficiaryInfo.linked
          ? 'beneficiary_linked'
          : params.ownerType === 'human'
            ? 'human_linked'
            : 'unlinked';
      const evidenceRequirement = resolvedActionPolicy?.evidenceRequirement ?? 'operator_policy_review';
      // §2.8: when the WITNESS CLASS is the evidence (a class-admitted unnamed type, or the
      // hardware-rooted override), the relay's own class assignment stamps the record verified —
      // it is the non-actor witness the relay already checked. Never on a named row's own family.
      const witnessClassIsEvidence = evidenceRequirement === 'verified_witness_class'
        && WITNESSED_CLASSES.has(sealedWitnessClass);
      const evidenceState: EvidenceState = witnessClassIsEvidence
        ? 'verified'
        : (params.economicEvidenceState
          ?? (evidenceRequirement === 'none' ? 'not_required' : 'pending'));

      const operationalDispositionOverride = resolveOperationalDisposition({
        durableEconomicPath,
        policyRecordOnly,
        terminallyIneligible: deviceRateLimited
          || params.noObservableOutput === true
          || x402Unverified,
        sameOwnerUnresolvable,
        mintClaimUnverifiable,
        cacheUnavailable,
        receiveUnsolicited,
        receiveAuthorshipUnresolvable,
        provianServiceFee,
      });

      computedSnapshotInput = {
        peId: params.peId,
        economicActorId: params.userId,
        actionType: params.actionType,
        recordedAtMs: params.timestamp,
        occurrenceOrdinal: occurrenceCount + 1,
        dailyOrdinal: dailyCount + 1,
        exactDuplicate: crossWitnessDuplicate || x402Duplicate || occurrenceDuplicate
          || financialSettlementDuplicate || deviceOccurrenceDuplicate || completionDuplicate,
        uniqueArtifact: isUniqueArtifact,
        // §2.9: a hardware-rooted witness lifts the tier to hardware_full (the evidence-priced
        // table's 1.0×) — the report, not the device's registration tier, is the attestation.
        attestationTier: sealedWitnessClass === 'hardware_rooted'
          ? 'hardware_full'
          : ordinaryHardwareAttestationTier(normalizeEconomicAttestationTier(params.attestationDepth)),
        linkageState,
        evidenceState,
        // §2.8: the class-admitted canonical event is the emitter's own (a chain log, a commit, a
        // hardware report digest) when it passed one, else `<type>:<pe hash>` — this exact PE,
        // mint-once by construction.
        canonicalEventId: params.economicCanonicalEventId
          ?? (witnessClassIsEvidence
            ? `${params.actionType}:${params.peHash}`
            : (evidenceState === 'verified'
              ? (params.tx_hash ?? params.artifact_hash ?? params.commitSha ?? null)
              : null)),
        selfReferencing: detectedSelfReferencing,
        sharedBeneficialOwnership: detectedSharedOwnership,
        // there is no pair-churn rule. Two separate owners
        // cycling money is bounded by the daily ceilings and novelty
        // pricing as built; the sealed snapshot keeps the field, always false.
        pairChurnDetected: false,
        sessionLineageId: params.economicSessionLineageId ?? null,
        genesisReservation: null,
        beneficiaryAgentShareBps: beneficiaryInfo.linked
          ? beneficiaryInfo.agentShareBps
          : 10_000,
        operationalDispositionOverride,
        // money layer, pieces 1–4 — sealed informational (no price change until piece 5). The
        // two recompute sites below spread `...computedSnapshotInput`, so they inherit these unchanged.
        independentOriginCount: originPricing.independentOriginCount,
        originReferences: originPricing.origins,
        // ops-dashboard build — the capture lane, sealed informational (never a pricing input). An
        // explicit emitter/daemon hint wins; otherwise derived from integrationSource + actionType.
        captureLane: deriveCaptureLane({
          laneHint: params.captureLane,
          integrationSource: params.integrationSource,
          actionType: params.actionType,
        }),
        // — the emitter-declared witness class, sealed informational (the
        // class-based admission reads it through the policy resolution above, never from here).
        witnessClass: normalizeWitnessClass(params.witnessClass),
      };
      economicSnapshot = computeRecordSnapshot(monetaryPolicy, computedSnapshotInput);
    }

    // One exact transaction is the sole standing-cap authority for native and
    // mapped Financial PEs. Reserve for every non-terminal state that could
    // later become eligible (including pending_cache/evidence/review), so no
    // recovery path can bypass the cap. Any unknown input, corrupt counter, or
    // Firestore failure is a terminal zero-mint outcome (Unknown = Block).
    const activityRule = getActionTypeMintRule(params.actionType);
    // A row held `pending_evidence` on the final-chain-receipt class can never
    // become eligible in place: the pending-evidence resolver's chain-receipt
    // arm refuses promotion by name, and the act mints only as the chain-record
    // lane's own verified PE (which reserves its own slot). The app's send /
    // swap record is such a row, so it holds no daily slot.
    const heldOnChainReceiptOnly = economicSnapshot !== null
      && economicSnapshot.mintDisposition === 'pending_evidence'
      && economicSnapshot.recordTimeFactors.evidenceRequirement === 'base_final_chain_receipt';
    const potentiallyMintable = economicSnapshot !== null
      && economicSnapshot.mintDisposition !== 'record_only'
      && economicSnapshot.mintDisposition !== 'ineligible_terminal';
    if (activityRule
      && potentiallyMintable
      && !isTerminalCompliance(mintCompliance)
      && !deviceRateLimited
      && !crossWitnessDuplicate
      && !x402Duplicate
      && !occurrenceDuplicate
      && !financialSettlementDuplicate
      && !deviceOccurrenceDuplicate
      && !completionDuplicate
      && !x402Unverified
      && !hasReservedGenesisSnapshot
      && !policyRecordOnly) {
      if (heldOnChainReceiptOnly) {
        // The identity requirement still fails closed; no daily slot is read or booked.
        const identity = decideActivityMintIdentityWithoutSlot({
          actionType: params.actionType,
          counterpartyAddress: params.counterpartyAddress ?? null,
        });
        farmCapped = identity.capped;
        farmCapReason = identity.reason;
      } else {
        try {
          const decision = await reserveActivityMintCaps(db, {
            peId: params.peId,
            userId: params.userId,
            actionType: params.actionType,
            counterpartyAddress: params.counterpartyAddress ?? null,
            timestampMs: params.timestamp,
          });
          farmCapped = decision.capped;
          farmCapReason = decision.reason;
          activityMintReservation = decision.reservation;
          activityMintReservationHash = decision.reservationHash;
        } catch (err) {
          farmCapped = true;
          farmCapReason = 'cap_state_unavailable';
          console.error(
            '[PVT] activity mint-cap reservation failed (blocking mint):',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (farmCapped && computedSnapshotInput !== null) {
        economicSnapshot = computeRecordSnapshot(monetaryPolicy, {
          ...computedSnapshotInput,
          operationalDispositionOverride: {
            mintDisposition: 'ineligible_terminal',
            mintReasonCode: 'policy_ineligible',
            suppressRecordPoints: true,
          },
        });
      }
    }

    // (Commons communication): the SPEECH-WINDOW BUDGET. A speech act sealed under a live
    // presentation window reserves its record points against that window's budget (the burn
    // that opened it) in one transaction; a PE that would carry the window's sum to or past the
    // burn seals `record_only` with `speech_window_budget_exhausted` — recorded, never minted.
    // Runs AFTER the farm-cap flip (a terminal row reserves nothing) and BEFORE the mint-once
    // claims commit (so a budget-refused row never holds a claim slot). Unknown = Block: a
    // reservation failure is exhausted, never admitted.
    //
    // NO PASS, NO MINT (, fact-base fixes item 1): the invariant covers EVERY speech
    // PE on every surface. A speech-type PE that arrives with NO pass attached — a thread message
    // sent inside an open relationship (sending needs no pass there), or a speech action type
    // self-reported on any lane that carries no pass — records and seals `record_only` with its own
    // reason, `speech_no_live_pass_record_only`. Nothing is gated: the PE is recorded either way.
    if (!params.speechWindow
      && speechPeNeedsPass(params.actionType)
      && computedSnapshotInput !== null
      && economicSnapshot !== null
      && !farmCapped
      && economicSnapshot.mintDisposition !== 'record_only'
      && economicSnapshot.mintDisposition !== 'ineligible_terminal') {
      economicSnapshot = computeRecordSnapshot(monetaryPolicy, {
        ...computedSnapshotInput,
        operationalDispositionOverride: {
          mintDisposition: 'record_only',
          mintReasonCode: 'speech_no_live_pass_record_only',
          suppressRecordPoints: false,
        },
      });
    }
    let speechBudgetExhausted = false;
    if (params.speechWindow
      && computedSnapshotInput !== null
      && economicSnapshot !== null
      && !farmCapped
      && economicSnapshot.mintDisposition !== 'record_only'
      && economicSnapshot.mintDisposition !== 'ineligible_terminal') {
      try {
        const decision = await reserveSpeechWindowBudget(db, {
          sealCounters: pricingCounters,
          peId: params.peId,
          walletId: params.userId,
          actionType: params.actionType,
          burnId: params.speechWindow.burnId,
          burnAmountAtomic: params.speechWindow.burnAmountAtomic,
          pointsAtomic: economicSnapshot.recordPointsAtomic,
          timestampMs: params.timestamp,
        });
        speechBudgetExhausted = decision.exhausted;
      } catch (err) {
        speechBudgetExhausted = true;
        console.error(
          '[PVT] speech-window budget reservation failed (sealing record_only):',
          err instanceof Error ? err.message : String(err),
        );
      }
      if (speechBudgetExhausted) {
        economicSnapshot = computeRecordSnapshot(monetaryPolicy, {
          ...computedSnapshotInput,
          operationalDispositionOverride: {
            mintDisposition: 'record_only',
            mintReasonCode: 'speech_window_budget_exhausted',
            suppressRecordPoints: false,
          },
        });
      }
    }

    // commit the deferred cross-witness (user, commit_sha) claim now that
    // the disposition is SEALED (after every recompute, incl. the farm-cap flip).
    // Reserve it (an 'owner' plan creates the claim doc) ONLY when the row could
    // still mint — a row that seals TERMINAL zero (record_only / ineligible_terminal,
    // e.g. a same-owner or farm-capped row; under a software forge webhook is
    // itself mintable and owns the slot) releases the slot so the first MINTABLE
    // witness owns it. A 'duplicate'
    // relation is ALWAYS recorded: it reserves nothing (a no-op in the commit
    // transaction) and is the chain-integrity evidence that a prior witness owns
    // the mint — evidence `assertMintOnceClaimEvidence` REQUIRES present whenever
    // the sealed snapshot carries `exactDuplicate`. Non-terminal pending/deferred
    // rows keep reserving (unchanged): they may yet reach `eligible`, so releasing
    // their slot could double-mint. This changes CLAIM ASSIGNMENT only; no sealed
    // snapshot, price, or already-settled row is touched.
    const newPeSealedMintable = !isTerminalCompliance(mintCompliance) && economicSnapshot !== null
      && !isTerminalMintDisposition(economicSnapshot.mintDisposition);
    if (commitTakeover !== null) {
      // takeover. Commit it ONLY if the taker itself sealed mintable — a
      // taker floored terminal (farm cap, same-owner, unverified …) must not
      // demote the incumbent. When it did NOT seal mintable, push nothing: the
      // incumbent keeps the slot and this witness records its terminal 0 with no
      // commit evidence (crossWitnessDuplicate stayed false, so exactDuplicate is
      // false and `assertMintOnceClaimEvidence` requires no duplicate evidence).
      if (newPeSealedMintable) {
        mintOnceClaimPlans.push(commitTakeover);
      }
    } else if (preparedCommitClaim !== null
      && (preparedCommitClaim.evidence.relation === 'duplicate' || newPeSealedMintable)) {
      mintOnceClaimPlans.push(preparedCommitClaim);
    }
    // the same deferred-commit discipline for the COMPLETION claim: the
    // takeover is committed only if this on-chain witness itself sealed
    // mintable (a same-owner release floored to record_only must not demote a
    // good off-chain incumbent); an owner plan reserves the slot only when the
    // row can still mint; a duplicate relation is always recorded as the
    // chain-integrity evidence `assertMintOnceClaimEvidence` requires.
    if (completionTakeover !== null) {
      if (newPeSealedMintable) mintOnceClaimPlans.push(completionTakeover);
    } else if (preparedCompletionClaim !== null
      && (preparedCompletionClaim.evidence.relation === 'duplicate' || newPeSealedMintable)) {
      mintOnceClaimPlans.push(preparedCompletionClaim);
    }

    if (economicSnapshot !== null) {
      attestationMultiplierAtAnchor =
        economicSnapshot.recordTimeFactors.attestationMultiplierBps / 10_000;
      // `estimatedPVT` is a legacy display projection only. Exact atomic units
      // in the immutable snapshot are authoritative everywhere economic.
      estimatedPVT = mintCompliance.policy === 'immediate' && economicSnapshot.mintDisposition === 'eligible'
        ? Number(ethers.formatUnits(economicSnapshot.recordPointsAtomic, 18))
        : 0;
    } else {
      // A raw fixed Genesis number is not a reservation receipt. Keep the PE as
      // zero-valued provenance; the durable state machine is the only mint path.
      estimatedPVT = 0;
    }

    const skipBeneficiarySplit = economicSnapshot?.recordTimeFactors.fixedGrantSource
      === 'genesis_campaign_reservation';
    const beneficiaryRoutingSnapshot = beneficiaryInfo.linked && !skipBeneficiarySplit
      ? createBeneficiaryRoutingSnapshot({
        peId: params.peId,
        economicActorId: params.userId,
        recordedAtMs: params.timestamp,
        beneficiary: beneficiaryInfo,
      })
      : null;
    const beneficiaryRoutingSnapshotHash = beneficiaryRoutingSnapshot
      ? hashBeneficiaryRoutingSnapshot(beneficiaryRoutingSnapshot)
      : null;

    // [SEC-device-dedup] Rate-limited PEs record with 0 PVT - the PE exists, but earns nothing.
    // The cache-unavailable case lands in pe_history with
    // mint_status='pending_cache' (reclassifiable); the device setup-PE rate
    // limit lands as 'ineligible' (terminal). x402 cross-source duplicates,
    // unverified x402 payments, and farm-capped Financial PEs also record with
    // 0 PVT. (the per-user VOLUME caps are removed — volume alone never
    // suppresses accrual.)
    const accrualSuppressed =
      mintCompliance.policy !== 'immediate' || deviceRateLimited || (!hasReservedGenesisSnapshot && cacheUnavailable) ||
      crossWitnessDuplicate || x402Duplicate || occurrenceDuplicate || financialSettlementDuplicate
      || deviceOccurrenceDuplicate || completionDuplicate
      || x402Unverified || farmCapped || policyRecordOnly
      || economicSnapshot?.mintDisposition !== 'eligible';
    if (accrualSuppressed) {
      estimatedPVT = 0;
    }

    // Calculate split between agent and human beneficiary
    let agentPVT = estimatedPVT;
    let humanPVT = 0;
    let splitInfo: { total: number; agent_share: number; human_share: number; ratio: number } | null = null;

    const beneficiaryWalletId = beneficiaryInfo.linked && !skipBeneficiarySplit
      ? beneficiaryInfo.humanUserId
      : null;
    if (beneficiaryInfo.linked && beneficiaryInfo.humanUserId && !skipBeneficiarySplit) {
      if (beneficiaryInfo.agentShareBps === null) {
        throw new Error('beneficiary_agent_share_bps_missing');
      }
      const legacyRatio = beneficiaryInfo.agentShareBps / 10_000;
      agentPVT = estimatedPVT * legacyRatio;
      humanPVT = estimatedPVT - agentPVT;
      splitInfo = {
        total: estimatedPVT,
        agent_share: agentPVT,
        human_share: humanPVT,
        ratio: legacyRatio,
      };
    }

    const countX402 =
      params.actionType === 'x402_payment' && params.x402ChainVerified === true &&
      !!params.x402PayerAddress &&
      economicSnapshot?.mintDisposition === 'eligible' &&
      !x402Duplicate && !x402Unverified && !farmCapped &&
      !deviceRateLimited && !cacheUnavailable;
    // The derived-effect outbox is co-committed with the pe_history seal for
    // BOTH lanes. The durable lane (throwOnError) has always used it. The
    // ordinary best-effort lane now co-commits it too : it is
    // the deterministic replay source that lets a crash between the seal and
    // the derived aggregates below be COMPLETED by a later re-fire, instead of
    // short-circuiting at the "pe_history exists" guard and losing the effect
    // forever. Building this object does NOT touch `durableEconomicPath`, the
    // sealed `economic_snapshot`, or its hash — those are computed above from
    // `throwOnError` alone (unchanged), and the outbox is a separate document
    // (`pvt_accrual_effects/<peId>`), not a field of the sealed pe_history row.
    // For ordinary record-only callers the payload is zero-valued and
    // `redisCountersRequired` is false, so replay consumes no rate/novelty/cap
    // authority and mints nothing — provenance completeness only.
    const durableEffect = createDurableAccrualEffect({
      schemaVersion: 'pvt-accrual-effects/v1',
      peId: params.peId,
      userId: params.userId,
      actionType: params.actionType,
      category,
      timestampMs: params.timestamp,
      attestationDepth: params.attestationDepth,
      estimatedPvt: estimatedPVT,
      agentPvt: agentPVT,
      humanPvt: humanPVT,
      humanUserId: beneficiaryInfo.humanUserId,
      ownerType: params.ownerType ?? null,
      ownerWalletAddress: params.walletAddress ?? null,
      // Activity slots were already reserved atomically. Durable effects must
      // never advance those counters a second time.
      consumeActivityCaps: false,
      counterpartyAddress: params.counterpartyAddress ?? null,
      countX402,
      x402PayerAddress: params.x402PayerAddress ?? null,
      // A sealed record-only PE is provenance, not rate/novelty authority.
      // This also protects durable callers for policy-defined record-only
      // actions; the derived outbox must not consume Redis economic counters.
      redisCountersRequired: !policyRecordOnly && !cacheUnavailable,
    });

    // 2. Write pe_history document (with deduplication)
    if (params.durableTestCrashAt === 'before_pe_history') {
      throw new Error('injected_durable_accrual_crash:before_pe_history');
    }
    if (!params.meter) pricingCounters.stageEffect(durableEffect.payload);
    const writeParams: WritePEHistoryParams = {
      novelty_counters: pricingCounters,
      peId: params.peId,
      userId: params.userId,
      timestamp: params.timestamp,
      actionType: params.actionType,
      category,
      attestationDepth: params.attestationDepth,
      estimatedPVT,
      peHash: params.peHash,
      inputSummary: params.inputSummary,
      outputSummary: params.outputSummary,
      tx_hash: params.tx_hash,
      commit_sha: params.commitSha,
      replication_pack: params.replication_pack,
      jurisdiction_context: mintCompliance.deferred_context ?? mintCompliance.actor_country ?? '',
      compliance_db: params.meter?.readDb,
      mint_compliance_evidence: mintCompliance,
      attestation_verified: params.attestation_verified ?? false,
      beneficiary_wallet_id: beneficiaryWalletId,
      pvt_split: splitInfo,
      beneficiary_routing_snapshot: beneficiaryRoutingSnapshot,
      beneficiary_routing_snapshot_hash: beneficiaryRoutingSnapshotHash,
      mint_once_claim_plans: mintOnceClaimPlans,
      ...(params.meter?.singleLane === true
        ? { single_lane_sighting: { exactDuplicate: deviceOccurrenceDuplicate, uniqueArtifact: isUniqueArtifact } }
        : {}),
      // H-6 (2026-05-11): pass the two suppression modes separately so
      // pe-history can pick the right mint_status:
      //   cacheUnavailable → 'pending_cache' (reclassifiable)
      //   deviceRateLimited → 'ineligible' (terminal)
      // (the per-user volume caps that also used to feed the terminal
      // arm are removed; only the device setup-PE anti-reinstall limit remains.)
      cacheUnavailable: cacheUnavailable && !hasReservedGenesisSnapshot,
      deviceRateLimited,
      noObservableOutput: params.noObservableOutput,
      // An x402 cross-source duplicate is a "prior source already minted this"
      // no-mint - the same terminal 'corroborated_duplicate' state the commit
      // cross-witness dedup uses. A replayed sovereign-work occurrence
      // resolves to the same no-mint terminal state. A replayed device-witnessed
      // occurrence resolves to that same terminal state.
      crossWitnessDuplicate: crossWitnessDuplicate || x402Duplicate || occurrenceDuplicate
        || financialSettlementDuplicate || deviceOccurrenceDuplicate || completionDuplicate,
      // the on-chain completion witness marker, persisted so the
      // settlement inlet and the takeover pre-check can read WHICH witness this
      // row is. Written only when a claim was actually prepared for it.
      completion_claim: completionCanonicalId !== null && preparedCompletionClaim !== null
        ? { canonical_id: completionCanonicalId, witness: 'onchain_release' }
        : null,
      farmCapped,
      farm_cap_reason: farmCapReason,
      activity_mint_reservation: activityMintReservation,
      activity_mint_reservation_hash: activityMintReservationHash,
      x402Unverified,
      fixed_estimated_pvt_override: false,
      is_genesis_grant: skipBeneficiarySplit,
      // Legacy context remains nullable for old readers. Exact current Genesis
      // value lives only in the committed economic snapshot.
      genesis_wallet_id: skipBeneficiarySplit ? (params.genesisWalletId ?? null) : null,
      genesis_funding_source_address: skipBeneficiarySplit ? (params.genesisFundingSourceAddress ?? null) : null,
      genesis_reserved_pvt: null,
      // W6-3: stamp effective multiplier (null on the fallback-formula path).
      attestation_multiplier_at_anchor: attestationMultiplierAtAnchor,
      // Lineage / goal linkage - persisted so the minting engine sees them.
      cited_pe_ids: params.citedPeIds ?? null,
      parent_goal_pe_id: params.parentGoalPeId ?? null,
      // Trust Layer build: the citable outputs, the witness class, and the relay receipt time.
      output_digests: params.outputDigests ?? null,
      witness_class: normalizeWitnessClass(params.witnessClass),
      witnessed_at_ms: typeof params.witnessedAtMs === 'number' ? params.witnessedAtMs : Date.now(),
      // §2.8 + new-type intake : an unnamed type is OBSERVED (the queue is the
      // signing-proposal surface) ONLY when a non-actor witness vouched for it (invariant A3): a
      // bare actor declaration records at zero and never reaches the queue. The sovereign lane's
      // acts are filed under their lane's intake source id.
      pending_policy_observation: shouldObservePendingPolicy(actionPolicyResolution.status, sealedWitnessClass)
        ? {
          actionType: params.actionType,
          peId: params.peId,
          integrationSource: pendingPolicyObservationSource(params),
          // The submitter, so the activation notice reaches it after its act key ages out.
          actorId: params.userId,
          policyVersion: 'pvt-action-policy/v1',
          now: Date.now(),
        }
        : undefined,
      mint_disposition: economicSnapshot?.mintDisposition ?? 'record_only',
      disposition_reason_code: economicSnapshot?.mintReasonCode ?? 'policy_record_only',
      // ops-dashboard build — top-level MIRROR of the sealed capture lane (a DISPLAY/grouping key
      // for the console, exactly like `commit_sha`; the authoritative copy is sealed in
      // economic_snapshot.recordTimeFactors.captureLane). Lets the collectors read the lane from a
      // cheap projected scan without decoding the snapshot. Never a pricing or settlement input.
      capture_lane: economicSnapshot?.recordTimeFactors.captureLane
        ?? deriveCaptureLane({
          laneHint: params.captureLane,
          integrationSource: params.integrationSource,
          actionType: params.actionType,
        }),
      policy_review_state: economicSnapshot?.policyReviewState
        ?? (actionPolicyResolution.status === 'pending_policy'
          ? 'pending_policy'
          : (actionPolicyResolution.status === 'class_admitted' ? 'class_admitted' : 'not_required')),
      policy_review_reason_code: economicSnapshot?.policyReviewReasonCode
        ?? (actionPolicyResolution.status === 'pending_policy'
          ? 'unknown_action_type'
          : (actionPolicyResolution.status === 'class_admitted' ? 'witness_class_admitted' : 'known_policy_entry')),
      economic_policy_version: economicSnapshot?.policyVersion
        ?? monetaryPolicy.policyVersion,
      economic_snapshot: economicSnapshot,
      durable_accrual_effect: params.meter ? undefined : durableEffect,
    };
    const statsBumpInput = {
      actorId: params.userId,
      peId: params.peId,
      actionType: params.actionType,
      family: categorizeActionType(params.actionType),
      witnessClass: sealedWitnessClass,
      timestampMs: params.timestamp,
      attestationTier: normalizeAttestationTier(params.attestationDepth),
      witnessObservedTokens: params.witnessObservedTokens ?? null,
      bodyDeclaredTokens: params.bodyDeclaredTokens ?? null,
      independentOriginCount: originPricing.independentOriginCount,
      approvalsCited: originPricing.consumptionEdges.filter((e) => e.citedActionType === 'human_approval').length,
      // Trust layer extension (2026-10-10): the inbound payer of a `receive` the same-owner fence
      // PASSED rides the stats bump (never metadata), so `money.independent_payers` counts only
      // payments from parties the fence could not resolve to the recipient's own identity set.
      composition: withInboundPayer(
        params.compositionSignals ?? null,
        inboundPayerKey(params.actionType, params.counterpartyAddress, !detectedSelfReferencing && !detectedSharedOwnership && !sameOwnerUnresolvable),
      ),
    };
    if (params.meter) {
      // PE METER: the act is priced; seal it as claims + a 31-day act key, and hand its outcome
      // to the batch (totals, delegation totals and pending claims are applied once per batch).
      const delegationQualifies = beneficiaryInfo.linked
        && beneficiaryInfo.humanUserId !== null
        && beneficiaryInfo.agentShareBps !== null
        && !skipBeneficiarySplit
        && params.actionType !== 'agent_work_delegated'
        && isDelegationQualifying(params.actionType);
      await sealMeterAct(db, writeParams, { ...params.meter, sink: (outcome) => {
        pricingCounters.stage(outcome);
        params.meter!.sink({ ...outcome, ordinalCounters: pricingCounters });
      } }, {
        statsBump: JSON.parse(JSON.stringify(statsBumpInput)) as Record<string, unknown>,
        delegation: delegationQualifies
          ? {
            humanUserId: beneficiaryInfo.humanUserId as string,
            agentUserId: params.userId,
            agentShareBps: beneficiaryInfo.agentShareBps as number,
            totalPvt: splitInfo?.total ?? estimatedPVT,
            humanShare: splitInfo?.human_share ?? humanPVT,
          }
          : null,
        corroborateIncumbentPeId,
        // No output is indexed by hash any more (: signed citations replace it).
        outputDigestsIndexed: false,
        effect: durableEffect.payload,
        commitOrigins: typeof writeParams.commit_sha === 'string' && writeParams.commit_sha.length > 0
          ? (params.inputOrigins ?? null)
          : null,
        outboundCounterparty: outboundCounterpartyOf(params.actionType, params.counterpartyAddress),
      }, { originEdges: originPricing.stagedEdges ?? null });
      // no per-output digest index (it grew with history). A consumer's citation
      // counts only when it carries the producer's signature over the output's hash
      // (`core/pvt/output-citation.ts`), so the relay keeps nothing per output.
      if (corroborateIncumbentPeId !== null) {
        await recordIncumbentCommitCorroboration(db, {
          incumbentPeId: corroborateIncumbentPeId,
          corroboratingPeId: params.peId,
          nowMs: params.timestamp,
        });
      }
      return;
    }
    const didWrite = await writePEHistory(writeParams);
    // Trust Layer build §2.5 — the per-actor vocabulary counters (best-effort; never fails a seal).
    if (didWrite) {
      try {
        await bumpActorStats(db, statsBumpInput);
      } catch (err) {
        console.warn('[PVT] actor stats bump failed (non-blocking):', params.peId, err);
      }
    }

    if (params.durableTestCrashAt === 'after_pe_history') {
      throw new Error('injected_durable_accrual_crash:after_pe_history');
    }

    if (!didWrite) {
      if (params.throwOnError) {
        const effect = await db.collection(DURABLE_ACCRUAL_EFFECTS_COLLECTION)
          .doc(params.peId)
          .get();
        if (effect.exists) {
          await resumeDurableAccrualEffects(
            db,
            params.peId,
            params.durableTestCrashAt as DurableAccrualCrashPoint | undefined,
          );
        }
      } else {
        // Ordinary lane: a concurrent first attempt won the seal and
        // co-committed the outbox. Complete its derived effects exactly once
        // (idempotent) in case that attempt died before applying them..
        await completeOrdinaryAccrualEffects(db, params);
      }
      console.warn('[PVT] Duplicate PE detected, skipping accrual:', params.peId); // [SEC-audit-4.6]
      return;
    }

    // PE METER (item 8): delegation is a running total on the human (`human_delegation_totals_v1`,
    // applied once per fresh act in the batch commit), never a separate PE.

    // Case 2 (forge-first) — this witness is the lower-base cross-witness of
    // a commit the incumbent won; corroborate the incumbent so the lift lands on
    // that WINNER. Best-effort and post-seal: it enhances value, never gates it.
    if (corroborateIncumbentPeId !== null) {
      await recordIncumbentCommitCorroboration(db, {
        incumbentPeId: corroborateIncumbentPeId,
        corroboratingPeId: params.peId,
        nowMs: params.timestamp,
      });
    }

    if (params.throwOnError) {
      await resumeDurableAccrualEffects(
        db,
        params.peId,
        params.durableTestCrashAt as DurableAccrualCrashPoint | undefined,
      );
      recordActionTypeObservation(params.actionType, params.userId).catch(() => {});
      return;
    }

    // Ordinary best-effort lane. The PE was just sealed record-only above and
    // its zero-valued effect outbox was co-committed in the SAME transaction.
    // Apply the derived aggregates through the SAME idempotent applicator the
    // durable lane uses (agent/human accrual, wallet pe_count/pvt_earned,
    // network counter, streak, x402 count, Foundation-membership 0→1 queue) so
    // that a crash between the seal and this point is completable by simply
    // re-firing recordPEAccrual. This is NOT a durable
    // classification: throwOnError/durableEconomicPath stay false, the sealed
    // economic snapshot is unchanged, redisCountersRequired is false for
    // record-only callers (no rate/novelty/cap authority consumed), and nothing
    // mints — the payload is zero-valued provenance.
    await completeOrdinaryAccrualEffects(db, params);
    return;

  } catch (error) {
    if (error instanceof NoveltyCounterConflictError || error instanceof NoveltySealsPausedError) throw error;
    if (error instanceof MintOnceClaimRaceError && !retriedMintOnceRace) {
      return recordPEAccrualAttempt(params, true);
    }
    // Ordinary callers remain fire-and-forget. Durable outbox processors opt
    // into an acknowledgement so a failed derived write is retried rather
    // than falsely marked complete.
    console.error('[PVT] Accrual recording failed (non-blocking):', error);
    // A metered act's failure fails its batch: the device re-sends it and nothing is half-applied.
    if (params.throwOnError || params.meter) throw error;
  }
}

/**
 * Complete an ORDINARY best-effort accrual's derived effects from its
 * co-committed durable outbox, exactly once.
 *
 * The ordinary lane seals a record-only pe_history row and co-commits a
 * zero-valued `pvt_accrual_effects/<peId>` outbox in the SAME transaction. This
 * applies (or resumes) the derived aggregates through the identical idempotent
 * state machine the durable lane uses, so a crash between the seal and the
 * effects is completable by simply re-firing recordPEAccrual: the re-fire hits
 * the "pe_history exists" guard, lands here, and finishes the omitted effect.
 *
 * Invariants this preserves:
 * - ORDINARY STAYS ORDINARY. The caller only reaches this with throwOnError
 * falsy; `durableEconomicPath` and the sealed `economic_snapshot`/hash were
 * computed above from throwOnError alone and are untouched. This governs
 * effect replay, never pricing.
 * - IDEMPOTENT. `resumeDurableAccrualEffects` is a per-PE state machine
 * (pending → firestore_committed → complete): a fully-applied outbox is a
 * no-op ('complete'), and it never double-applies across replays.
 * - FAIL-CLOSED. With no committed outbox there is no deterministic replay
 * source, so nothing is applied (never guess an effect). Any error thrown by
 * the applicator propagates to the fire-and-forget catch, leaving the outbox
 * un-advanced for a later retry rather than half-applying.
 * - NO MINT. The record-only payload is zero-valued and redisCountersRequired
 * is false, so no rate/novelty/cap authority is consumed and nothing mints.
 */
async function completeOrdinaryAccrualEffects(
  db: admin.firestore.Firestore,
  params: RecordPEAccrualParams,
): Promise<void> {
  const effectSnap = await db.collection(DURABLE_ACCRUAL_EFFECTS_COLLECTION)
    .doc(params.peId)
    .get();
  if (!effectSnap.exists) return;
  // The ordinary lane's only injectable crash points are the two pe_history
  // seal boundaries, handled before this call. The applicator only understands
  // DurableAccrualCrashPoint values, so those (and undefined) map to no
  // injection here; a genuine DurableAccrualCrashPoint is forwarded for the
  // durable-lane resume machinery's own tests.
  const crashAt: DurableAccrualCrashPoint | undefined =
    params.durableTestCrashAt === undefined
      || params.durableTestCrashAt === 'before_pe_history'
      || params.durableTestCrashAt === 'after_pe_history'
      ? undefined
      : params.durableTestCrashAt;
  const outcome = await resumeDurableAccrualEffects(db, params.peId, crashAt);
  // Best-effort provenance side-effects that are NOT part of the exactly-once
  // outbox: the fuzzy 24h network display counter and action-type catalog
  // auto-registration. Run only on the first application ('recovered'); a
  // replay of an already-complete accrual returns 'complete' and stays a no-op,
  // so neither is double-applied.
  if (outcome === 'recovered') {
    // pvt:hour DOUBLE-COUNT FIX (2026-08-13): when redisCountersRequired, the
    // durable Redis leg's Lua (commitPEAccountingCountersOnce KEYS[5]) already
    // incremented the hourly bucket inside resume — incrementing here as well
    // made pesLast24h read ~2x for every ordinary redis-counted PE. The
    // JS-side increment now covers ONLY the shapes the Lua never counted
    // (record_only / cache-unavailable), and never test-platform actors
    // (network_countable === false, decided by the firestore effects leg).
    const finalEffect = (await db.collection(DURABLE_ACCRUAL_EFFECTS_COLLECTION)
      .doc(params.peId)
      .get()).data() as
      | { payload?: { redisCountersRequired?: boolean }; network_countable?: boolean | null }
      | undefined;
    const countedInDurableLeg = finalEffect?.payload?.redisCountersRequired === true;
    const networkCountable = finalEffect?.network_countable !== false;
    if (!countedInDurableLeg && networkCountable) {
      await cache.incrementHourlyPECount();
    }
    recordActionTypeObservation(params.actionType, params.userId).catch(() => {});
  }
}

// =============================================================================
// SHARDED NETWORK COUNTERS
// =============================================================================

/**
 * Read all shards and sum the network counters.
 * Called by the network-stats endpoint on cache miss.
 */
export async function readNetworkCounters(): Promise<{
  totalPEs: number;
  totalEstimatedPVT: number;
}> {
  const db = relayDb();
  const shardsSnapshot = await db.collection('pvt_network_stats')
    .doc('global')
    .collection('shards')
    .get();

  let totalPEs = 0;
  let totalEstimatedPVT = 0;

  for (const shard of shardsSnapshot.docs) {
    const data = shard.data();
    totalPEs += data.totalPEs || 0;
    totalEstimatedPVT += data.totalEstimatedPVT || 0;
  }

  return { totalPEs, totalEstimatedPVT };
}

// =============================================================================
// AGENT ACTIVITY STREAK (consecutive active days)
// =============================================================================

/**
 * Pure consecutive-active-day streak transition. Returns the new streak_days, or
 * null when the PE does not change the streak (same UTC day, or an out-of-order
 * older PE). Dates are YYYY-MM-DD (UTC). Exported for unit testing.
 */
export function computeNextStreak(lastPeDate: string | null, today: string, prevStreak: number): number | null {
  if (!lastPeDate) return 1;                 // first active day on record
  if (lastPeDate === today) return null;     // already active today - no change
  const diffDays = Math.round((Date.parse(today) - Date.parse(lastPeDate)) / 86_400_000);
  if (diffDays === 1) return Math.max(0, prevStreak) + 1; // consecutive day -> grow
  if (diffDays >= 2) return 1;               // gap of 2+ days -> streak broken, restart at 1
  return null;                               // out-of-order / older PE - never decrement
}

/**
 * Resolve an agent wallet's human-readable display name for the human's
 * Delegation PE. Mirrors resolveBeneficiary's lookup: the agent_wallets
 * collection is keyed by doc id (the wallet_id, e.g. `wallet_aw_...`) and
 * carries an `agent_id` field. Session PEs pass the agent_id as userId; device
 * PEs pass the wallet_id. So we try the `agent_id` query first, then fall back
 * to a direct doc-id lookup. The display field is `display_name`.
 *
 * The prior code queried `.where('wallet_id', '==', userId)` (no such field -
 * wallet_id is the doc id) and read `.data().name` (no such field), so the
 * human's Delegation PE always showed the raw opaque id. Falls back to the
 * userId on any miss or error (fire-and-forget discipline).
 */
export async function resolveAgentDisplayName(
  db: admin.firestore.Firestore,
  userId: string,
): Promise<string> {
  try {
    const byAgentId = await db.collection('agent_wallets')
      .where('agent_id', '==', userId)
      .limit(1)
      .get();
    if (!byAgentId.empty) {
      const name = (byAgentId.docs[0].data() as { display_name?: string }).display_name;
      if (name) return name;
    } else {
      const byDocId = await db.collection('agent_wallets').doc(userId).get();
      if (byDocId.exists) {
        const name = (byDocId.data() as { display_name?: string } | undefined)?.display_name;
        if (name) return name;
      }
    }
  } catch {
    // Fall back to userId as name
  }
  return userId;
}

/**
 * Advance an agent's consecutive-active-day streak on its `agent_wallets` doc.
 *
 * Called from recordPEAccrual on every PE, so streak_days is maintained
 * automatically by the normal activity pipeline - no cron, no manual field bump.
 *
 * Rule (documented intent): an "active day" is a UTC calendar day on which the
 * agent recorded at least one PE. `last_pe_date` (YYYY-MM-DD, UTC) is the anchor.
 *   - same UTC day as last_pe_date  -> no change (multiple PEs/day don't inflate)
 *   - exactly the next UTC day      -> streak_days += 1 (consecutive)
 *   - a gap of >= 2 UTC days        -> streak_days reset to 1 (broken streak)
 *   - no prior last_pe_date         -> streak_days = 1 (first active day)
 *   - an out-of-order (older) PE    -> no change (never decrements)
 *
 * No Genesis reward consumes this value: the sustained-activity bounty is
 * retired. Concurrency-safe: the read-compute-write runs in a transaction, so
 * two PEs crossing the same day boundary cannot double-increment.
 *
 * Humans have no `agent_wallets` doc and are skipped; test wallets never accrue
 * a streak.
 */
export async function recordAgentStreak(
  db: admin.firestore.Firestore,
  userId: string,
  ownerType: 'human' | 'agent' | undefined,
  timestampMs: number,
): Promise<void> {
  if (ownerType === 'human') return; // humans have no agent_wallets streak

  // Resolve the agent_wallets doc. generatePE passes the agent_id as userId;
  // fall back to the doc id for callers that pass the wallet_id.
  let ref: admin.firestore.DocumentReference | null = null;
  let snapData: { platform?: string; last_pe_date?: string | null } | undefined;
  const byAgentId = await db.collection('agent_wallets').where('agent_id', '==', userId).limit(1).get();
  if (!byAgentId.empty) {
    ref = byAgentId.docs[0].ref;
    snapData = byAgentId.docs[0].data() as { platform?: string; last_pe_date?: string | null };
  } else {
    const byDocId = await db.collection('agent_wallets').doc(userId).get();
    if (byDocId.exists) {
      ref = byDocId.ref;
      snapData = byDocId.data() as { platform?: string; last_pe_date?: string | null };
    }
  }
  if (!ref) return; // not an agent wallet - nothing to do (e.g. a human)

  const today = new Date(timestampMs).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

  // Cost short-circuit (the common case): a smoke-test wallet never accrues, and
  // an agent already active today needs no write. Skip the transaction entirely -
  // most PEs are not the first of a new UTC day. The transaction below stays the
  // source of truth for the day-boundary update (concurrency-safe), so a slightly
  // stale read here only ever skips a no-op, never a real increment.
  if (snapData?.platform === 'test') return;
  if (snapData?.last_pe_date === today) return;

  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref!);
    if (!doc.exists) return;
    const data = doc.data() as { platform?: string; streak_days?: number; last_pe_date?: string | null };
    if (data.platform === 'test') return; // smoke-test agents never accrue streak
    const last = typeof data.last_pe_date === 'string' && data.last_pe_date ? data.last_pe_date : null;
    const prevStreak = typeof data.streak_days === 'number' ? data.streak_days : 0;
    const next = computeNextStreak(last, today, prevStreak);
    if (next === null) return; // same UTC day or out-of-order PE - no change, no write
    tx.update(ref!, { streak_days: next, last_pe_date: today, updated_at: Date.now() });
  });
}

/**
 * WS7: increment `x402_payment_count` on the SOVEREIGN agent wallet that made
 * an x402 payment, resolved by the on-chain payer address (the EIP-3009 signer
 * = the agent wallet's own address). This is the authoritative identity: the
 * x402 PE is ingested on the human-session path where userId is the human
 * owner, so userId/agent_id resolution does NOT work (different identity
 * space). agent_wallets.address is stored LOWERCASE (deriveAddressFromPublicKey
 * returns `'0x' + keccak(pubkey)[12:].hex` with no EIP-55 checksum, written
 * verbatim at create time), so we LOWERCASE the payer before the byte-exact
 * Firestore equality query — querying the checksummed form silently misses
 * every wallet whose address has an a-f nibble (audit Pass-2 follow-up: this
 * had broken x402_payment_count crediting on ALL paths). ethers.getAddress
 * still runs first to VALIDATE (and reject) a malformed address. Exported for
 * unit testing. Test-platform wallets are skipped so they don't earn the badge.
 * FieldValue.increment is atomic - no transaction needed.
 */
export async function incrementX402PaymentCount(
  db: admin.firestore.Firestore,
  payerAddress: string,
): Promise<void> {
  let normalized: string;
  try {
    // Validate (throws on a malformed address) then match the LOWERCASE stored form.
    normalized = ethers.getAddress(payerAddress).toLowerCase();
  } catch {
    console.warn('[PVT] x402 payer address is not a valid EVM address; skipping x402 count:', payerAddress);
    return;
  }

  const snap = await db.collection('agent_wallets').where('address', '==', normalized).limit(1).get();
  if (snap.empty) return; // no sovereign agent wallet for this payer
  const platform = (snap.docs[0].data() as { platform?: string }).platform;
  if (platform === 'test') return; // smoke-test agents never earn the badge

  await snap.docs[0].ref.update({
    x402_payment_count: FieldValue.increment(1),
    updated_at: Date.now(),
  });
}

/**
 * Resolve the on-chain payer (the EIP-3009 signer = the sovereign agent wallet's
 * own address) for an `x402_payment` PE from its metadata. `recordPEAccrual`
 * only credits `x402_payment_count`/x402_pioneer when given this address, so
 * every ingestion path that records x402 PEs MUST compute it the same way.
 *
 * The PE is ingested on the human-session path (the chain owner is the human
 * who owns the agent), so the payer cannot be derived from userId — it travels
 * in `metadata.payer`. Returns undefined for non-x402 actions or when the payer
 * is absent / non-string. Sharing this between /v1/relay/action (server.ts) and
 * the device /v1/pe/submit path (devices.ts) closes audit Pass-2 #19, where the
 * device path silently dropped the payer so device-mode x402 payments never
 * credited the leaderboard / x402_pioneer badge.
 */
export function resolveX402PayerAddress(
  actionType: string,
  metadata: unknown,
): string | undefined {
  if (actionType !== 'x402_payment') return undefined;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const payer = (metadata as Record<string, unknown>).payer;
  return typeof payer === 'string' ? payer : undefined;
}

/**
 * Resolve the on-chain SETTLEMENT tx hash for an `x402_payment` PE from its
 * metadata, for cross-source mint-once dedup (x402-tx-mint-claim.ts). The
 * chain-verified outbound watcher stamps `metadata.tx_hash`; the SDK self-report
 * stamps `metadata.settlementTxHash` (both name the SAME on-chain settlement), so
 * a payment witnessed by both mints once. Returns undefined for non-x402 actions
 * or when neither field is a non-empty string. Every generatePE caller that
 * records x402 PEs gets dedup for free by putting the settlement tx in metadata.
 */
export function resolveX402SettlementTxHash(
  actionType: string,
  metadata: unknown,
): string | undefined {
  if (actionType !== 'x402_payment') return undefined;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const m = metadata as Record<string, unknown>;
  const candidate =
    (typeof m.settlementTxHash === 'string' && m.settlementTxHash) ||
    (typeof m.tx_hash === 'string' && m.tx_hash) ||
    '';
  return candidate ? candidate : undefined;
}

/**
 * Resolve whether an `x402_payment` PE is CHAIN-VERIFIED (Option B) from its
 * metadata. Only the outbound-USDC watcher — which read the real on-chain USDC
 * Transfer log — stamps `metadata.chain_verified === true`; the SDK/self-report
 * emitters never do. recordPEAccrual mints (and counts x402_payment_count) for
 * an x402 PE ONLY when this is true, so every generatePE ingestion path MUST
 * compute it the same way (mirrors resolveX402SettlementTxHash / …PayerAddress).
 * Returns false for non-x402 actions, absent/non-object metadata, or any
 * `chain_verified` value that is not the boolean literal `true`.
 */
export function resolveX402ChainVerified(
  actionType: string,
  metadata: unknown,
): boolean {
  if (actionType !== 'x402_payment') return false;
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>).chain_verified === true;
}

/**
 * Agent Bank - Type definitions
 *
 * Shared types for Escrow, Promise, and Pool services.
 * Firestore document interfaces, safety limits, and router dependencies.
 */

import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';

// ---------------------------------------------------------------------------
// Safety limits (enforced in API layer, not contracts)
// ---------------------------------------------------------------------------

/**
 * Agent Bank Safety Limits, Launch Configuration
 *
 * These limits protect against smart contract bugs during the initial
 * operating window. They are NOT governance. Agents should be able to
 * transact freely. These are temporary training wheels on brand new
 * contracts, and each limit has event triggered removal criteria rather
 * than a calendar trigger.
 *
 * V4 REMOVAL CRITERIA (event triggered):
 *
 * A primitive limit becomes eligible for removal only when ALL of its
 * listed conditions hold across Base, Arbitrum, and Optimism. A single
 * incident or failure on any chain resets the counter for that primitive.
 *
 * MAX_ESCROW_AMOUNT_USD (10,000):
 * - 1000 successful settlements
 * - zero fund locking incidents
 * - zero admin dispute interventions outside the standard
 * ProvianCourtV2 path
 *
 * MAX_PROMISE_PRINCIPAL_USD (5,000):
 * - 500 successful settlements
 * - zero defaults requiring admin intervention
 *
 * MAX_POOL_THRESHOLD_USD (25,000):
 * - 200 successful executions
 * - zero refund failures
 *
 * When criteria are met, the limit may be removed or raised only by an
 * authorized prospective policy event. At the Gate 1 checkpoint the bootstrap admin EOA is
 * the sole direct bootstrap policy setter; governance/executor/Safe paths are
 * dormant and non-gating. Until then, the launch value stands.
 *
 * Policy owner: Provian Technologies, LLC
 */
export const SAFETY_LIMITS = {
  MAX_ESCROW_AMOUNT_USD: 10_000,
  MAX_PROMISE_PRINCIPAL_USD: 5_000,
  MAX_POOL_THRESHOLD_USD: 25_000,
  MAX_AUTO_RELEASE_HOURS: 336,       // 14 days
  MAX_PROMISE_DEADLINE_HOURS: 336,   // 14 days
  MAX_POOL_DEADLINE_HOURS: 672,      // 28 days
  MAX_POOL_CONTRIBUTORS: 100,
  // Phase 2: Court
  COURT_VOTING_WINDOW_HOURS: 48,
  COURT_MIN_ARBITRATORS: parseInt(process.env.COURT_MIN_ARBITRATORS || '15', 10),
  COURT_PANEL_SIZE: 3,
  COURT_MIN_COMPLETED_ESCROWS: 10,
  // arbitrator gate (supersedes "do not build a gate"): the three
  // required criteria are (1) >= COURT_MIN_COMPLETED_ESCROWS completed escrows as
  // a party with a real counterparty, (2) clean standing (zero adverse events),
  // and (3) an active bond. All read live standing/bond facts (the presentation
  // vocabulary). NO governance score and NO stored PE tally gate eligibility —
  // both signals were deleted as dead post-/. The former reputation-
  // stake (COURT_MIN_STAKE_PVT) was dropped earlier for the same reason: a seat
  // on the panel is earned (and bonded), never bought.
  // Phase 3: PVT + Governance
  MAX_MINT_BATCH_SIZE: 1000,
  MIN_PROPOSAL_BALANCE_PVT: 150,     // PVTv6+ ProvianGovernance default, carried to the live v8 stack (was 1000 under v4)
  // Agent Ecosystem Infrastructure
  MAX_JOB_BUDGET_USD: 10_000,
  MAX_JOB_DEADLINE_HOURS: 672,       // 28 days
  MAX_CAPABILITIES_COUNT: 20,
  MAX_WEBHOOK_SUBSCRIPTIONS: 10,
  MAX_JOB_APPLICATIONS: 50,
  MAX_JOB_DESCRIPTION_LENGTH: 2000,
  // General Disputes (Court Mandate Expansion)
  MAX_OPEN_DISPUTES_PER_WALLET: 5,
  MAX_SUBJECT_PE_IDS: 10,
  MAX_EVIDENCE_PE_IDS: 10,
  GENERAL_DISPUTE_EVIDENCE_WINDOW_HOURS: 48,
  GENERAL_DISPUTE_VOTING_WINDOW_HOURS: 48,
  // Phase 5: Insurance Bonds
  MAX_BOND_DEPOSIT_PVT: 7_500,
  BOND_LEVEL_2_BASE_PVT: 750,
  BOND_LEVEL_3_BASE_PVT: 3_000,
  MAX_TRUST_DISCOUNT_BPS: 5_000,        // 50%
  MAX_PENDING_CLAIMS_PER_BOND: 10,
  MAX_EVIDENCE_PE_IDS_CLAIM: 10,
  BOND_CLAIM_FILING_FEE_PVT: 15,
  BOND_SLASH_PROCESSING_FEE_PVT: 30,
  // Mirrors ProvianBondPool.renewalPeriod (180 days). The on-chain value is governance-mutable;
  // renewBond persists BondRenewed.newDeadline and falls back to this only when it is missing.
  BOND_RENEWAL_PERIOD_DAYS: 180,
  // WS1 (Pass-2): the floor a `partial` slash maps to, in basis points of the
  // bonded collateral. MUST mirror ProvianBondPool.MIN_SLASH_PAYOUT_BPS (5000 =
  // 50%) so the backend-persisted settlement amount matches what the on-chain
  // Court bridges to slashBond (full → 100% of the bond; partial → this floor).
  BOND_MIN_SLASH_PAYOUT_BPS: 5000,
} as const;

// USDC has 6 decimals
export const USDC_DECIMALS = 6;

export function usdToUsdc6(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

export function usdc6ToUsd(usdc6: bigint): number {
  return Number(usdc6) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Currency discriminator (Workstream 2 - PVT as principal currency)
//
// Each Agent Bank instance is single-currency at creation, immutable for its
// lifetime. USDC is the legacy default. PVT-principal flows settle in PVT
// with the fee burned via PVT.burn (no discount path - the deployed institution deployment
// EscrowV4/PromiseV3/PoolV3 self-burn through IPVTBurnable.burn, which is the
// only burn entrypoint PVT9 implements; protocolBurn is a legacy PVTv3-v8
// surface no live contract or backend path uses).
//
// Decimal convention is currency-dependent:
//   - 'usdc': amounts are USD floats; on-chain atomic units = USD * 10^6
//   - 'pvt':  amounts are BigInt strings of 18-decimal atomic units (wei-style)
//             API requests/responses MUST carry PVT amounts as strings, not
//             numbers - JS number precision tops out around 2^53 and 18-decimal
//             values overflow that for any non-trivial balance.
// ---------------------------------------------------------------------------

export type Currency = 'usdc' | 'pvt';

export const PVT_DECIMALS = 18;

/**
 * Uint256 max, for overflow checks on `pvtToWei` inputs.
 * Exposed as a constant so callers that need to pre-validate can use the
 * same bound the helper enforces.
 */
export const UINT256_MAX = 2n ** 256n - 1n;

/**
 * Convert a whole PVT number to atomic units (wei-style 18 decimals).
 *
 * Strict contract:
 *   - Input must be a finite number.
 *   - Input must be non-negative. Agent Bank amounts are always positive;
 *     zero is permitted at this layer (callers that disallow zero should
 *     validate upstream), negatives are rejected outright.
 *   - Input must be an integer. Fractional PVT cannot be represented safely
 *     through an IEEE 754 number, so this helper refuses to silently round.
 *     For fractional values, build the BigInt atomic amount yourself or pass
 *     a BigInt-as-string through `parsePvtWei`.
 *   - Result must fit in uint256. An input that would overflow the 256-bit
 *     Solidity integer is rejected rather than silently wrapping.
 *
 * Callers that need lenient float behaviour should switch to BigInt strings
 * and `parsePvtWei` (which is the right shape for request bodies anyway).
 */
export function pvtToWei(pvt: number): bigint {
  if (typeof pvt !== 'number' || !Number.isFinite(pvt)) {
    throw new Error(`pvtToWei: input must be a finite number, got ${String(pvt)}`);
  }
  if (pvt < 0) {
    throw new Error(`pvtToWei: input must be non-negative, got ${pvt}`);
  }
  if (!Number.isInteger(pvt)) {
    throw new Error(
      `pvtToWei: input must be an integer (whole PVT), got ${pvt}. ` +
        'For fractional or very large values, build the BigInt atomic amount ' +
        'directly or pass a BigInt-as-string through parsePvtWei.',
    );
  }
  // Integer in JS number range is safe to convert to BigInt directly.
  const result = BigInt(pvt) * 10n ** BigInt(PVT_DECIMALS);
  if (result > UINT256_MAX) {
    throw new Error(
      `pvtToWei: result ${result.toString()} exceeds uint256 max ${UINT256_MAX.toString()}`,
    );
  }
  return result;
}

/** Convert PVT atomic units back to a float (lossy beyond ~15 significant digits). */
export function weiToPvt(wei: bigint): number {
  return Number(wei) / 10 ** PVT_DECIMALS;
}

/**
 * Parse a BigInt-as-string that arrived in an API request. Rejects malformed
 * input so callers can surface a 400 instead of crashing. Negative values
 * rejected - Agent Bank amounts are always positive.
 */
export function parsePvtWei(input: string): bigint {
  if (typeof input !== 'string' || !/^[0-9]+$/.test(input)) {
    throw new Error(`amount_pvt must be a non-negative integer string (BigInt 18d), got: ${input}`);
  }
  const value = BigInt(input);
  if (value <= 0n) {
    throw new Error('amount_pvt must be > 0');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Escrow
// ---------------------------------------------------------------------------

export type EscrowStatus =
  | 'created'
  | 'funded'
  | 'completed'
  | 'disputed'
  | 'resolved'
  | 'cancelled';

export interface EscrowDocument {
  escrow_id: string;
  depositor_wallet_id: string;
  depositor_address: string;
  recipient_wallet_id: string;
  recipient_address: string;
  /**
   * Currency of this escrow. Set at creation, immutable thereafter.
   * Backfill migration writes 'usdc' to all pre-Workstream-2 records;
   * new records explicitly carry the value chosen by the depositor.
   */
  currency: Currency;
  // USDC-denominated values - populated when currency === 'usdc'.
  amount_usdc: number;
  fee_usdc: number;
  net_to_recipient_usdc: number;
  // PVT-denominated values - populated when currency === 'pvt'.
  // Stored as BigInt-as-string (18 decimals) to avoid number precision loss.
  amount_pvt?: string;
  fee_pvt?: string;
  net_to_recipient_pvt?: string;
  description: string;
  deliverables: string;
  chain: string;
  deadline: number;               // Unix ms
  auto_release_at: number;        // Unix ms
  status: EscrowStatus;
  funded_at?: number;
  fund_tx_hash?: string;
  fund_block_number?: number | null;
  /**
   * On-chain bytes32 escrow id, recovered from the funding tx's
   * EscrowFunded/EscrowFundedPVT event and persisted on first recovery.
   * The depositor chooses this off-relay at create/fund time, so the relay
   * learns it from the funding receipt. Used to call the on-chain
   * releaseEscrow(bytes32). Absent on legacy docs (recovered on demand).
   */
  onchain_escrow_id?: string;
  /**
   * the contract this escrow's on-chain struct lives on, when it is NOT the chain's
   * configured escrow. Set only for an escrow the migration left on the predecessor EscrowV4
   * (`scripts/d486-reconcile-post-snapshot.ts`). Absent = the configured escrow. Every read /
   * settle / keeper path resolves through `resolveEscrowContractForDocument`, which honors only
   * the configured escrow or its recorded predecessor and refuses anything else.
   */
  escrow_contract_address?: string;
  /**
   * Pass-3 N1 idempotency markers for the FUNDING side-effects (escrow_funded PE +
   * depositor stat). The status flip → 'funded' is durable in a txn, but the PE +
   * stat run AFTER the txn so an RPC/Firestore failure there used to lose them
   * forever (status='funded' blocked the retry). `funding_pe_id` is set once the
   * escrow_funded PE is emitted; `funding_stats_credited` once the depositor stat
   * is credited. verifyFunding re-runs ONLY the missing pieces on a retry.
   */
  funding_pe_id?: string;
  funding_stats_credited?: boolean;
  /**
   * WS1 idempotency guard: set true by the FIRST settlement path that credits
   * wallet stats for this escrow. Prevents a double-credit when the auto-release
   * scheduler and a depositor completeEscrow (or two overlapping cron ticks) both
   * settle the same escrow. Pass-3 #17: this marker is now set AFTER the credit +
   * PE side-effects (not in the status-flip claim txn), so a crash between the
   * flip and the credit can't permanently suppress a never-performed credit — a
   * retry finds status='completed' with the marker absent and re-runs the credit.
   */
  stats_credited?: boolean;
  /**
   * Pass-3 #17: set once the two escrow_completed PEs are emitted, so a repair
   * retry after a mid-completion crash does not duplicate them.
   */
  completion_pe_ids?: string[];
  /**
   * Pass-3 review: atomic single-winner claim for escrow_completed PE emission
   * (set transactionally BEFORE emitting). Independent of stats_credited so the
   * PE emission and the wallet-stat credit are each single-winner — this closes a
   * duplicate-PE window where two concurrent completeEscrow REPAIR calls both
   * force-emitted. (A crash after the claim but before completion_pe_ids lands is a
   * narrow PE-only loss; the money credit is separately atomic + repairable.)
   */
  completion_pe_claimed?: boolean;
  completed_at?: number;
  release_tx_hash?: string;
  /** Pass-3 #1: tx hash of the on-chain dispute resolution (resolveDispute / claimDisputeTimeout). */
  resolution_tx_hash?: string;
  rating?: number;
  comment?: string;
  auto_released?: boolean;
  dispute_reason?: string;
  dispute_evidence?: string | null;
  /** the dispute was recorded from the chain (it was raised on-chain before the relay heard of it). */
  dispute_recorded_from_chain?: boolean;
  disputed_at?: number;
  resolution?: 'release_to_recipient' | 'refund_to_depositor';
  resolution_reason?: string;
  resolved_at?: number;
  pe_ids: string[];
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Promise
// ---------------------------------------------------------------------------

export type PromiseStatus =
  | 'open'
  | 'funded'
  | 'settled'
  | 'defaulted'
  | 'cancelled';

export interface BorrowerSnapshot {
  economic_activity_usd: number;
  /**
   * PVT-denominated economic activity at snapshot time. BigInt-as-string.
   * Optional for backwards compat with snapshots taken before Workstream 2.
   */
  economic_activity_pvt?: string;
  promises_issued: number;
  promises_settled: number;
  promises_defaulted: number;
}

export interface PromiseDocument {
  promise_id: string;
  borrower_wallet_id: string;
  borrower_address: string;
  lender_wallet_id?: string;
  lender_address?: string;
  /** Currency. Immutable post-create. See EscrowDocument.currency note. */
  currency: Currency;
  // USDC-denominated.
  principal_usdc: number;
  repay_usdc: number;
  fee_usdc: number;
  net_to_lender_usdc: number;
  // PVT-denominated (BigInt-as-string).
  principal_pvt?: string;
  repay_pvt?: string;
  fee_pvt?: string;
  net_to_lender_pvt?: string;
  purpose: string;
  chain: string;
  deadline: number;               // Unix ms
  status: PromiseStatus;
  funded_at?: number;
  fund_tx_hash?: string;
  fund_block_number?: number | null;
  /**
   * Canonical log identity of the on-chain `PromiseFunded` event this row was
   * verified against (`fund_log_index` is its position within `fund_tx_hash`).
   * One transaction can fund several promises, so the tx hash alone is not an
   * identity. Set together at funding time by `verifyEvmPromiseFunding`.
   */
  fund_log_index?: number | null;
  /** bytes32 on-chain promise id recovered from the funding event (lowercased). */
  onchain_promise_id?: string;
  settled_at?: number;
  settle_tx_hash?: string;
  settle_block_number?: number | null;
  /** Log index of the on-chain `PromiseSettled` event within `settle_tx_hash`. */
  settle_log_index?: number | null;
  /** ms the promise first became `defaulted` (relay-observed OR proven-fresh). */
  defaulted_at?: number;
  /**
   * Proof level of a `defaulted` promise (addendum, — the
   * DUAL default path). Both paths flip a funded promise to `defaulted` * - 'relay_observed' the relay auto-flipped it past its deadline with NO
   * lender action and NO on-chain proof (the `processDefaults` sweep). The
   * borrower's reputation snapshot (`promises_defaulted`, status-counted)
   * reflects it immediately. On chain the promise is still `Funded` and still
   * settleable, so a VERIFIED on-chain settlement can still CURE it (→ settled,
   * see `settlePromise`) — a real repayment is never stranded as a default.
   * - 'onchain_proven' a lender's verified on-chain `markDefault` event proved
   * it (`defaultPromise`). A fresh default from `funded` lands here directly; an
   * UPGRADE from 'relay_observed' → 'onchain_proven' NEVER regresses, and once
   * proven the default is terminal (settle is refused).
   * Absent on non-defaulted rows.
   */
  default_proof?: 'relay_observed' | 'onchain_proven';
  /**
   * ms the on-chain proof upgraded a relay-observed default. Set ONLY on the
   * upgrade path; `defaulted_at` keeps the earlier relay-observation time so the
   * reputation timeline never moves later when the proof lands.
   */
  default_proven_at?: number;
  /**
   * On-chain identity of the `PromiseDefaulted` event this row was verified
   * against. A default is now lender-initiated and on-chain-proven,
   * exactly as fund/settle are — so it pins the same canonical log identity.
   */
  default_tx_hash?: string;
  default_block_number?: number | null;
  default_log_index?: number | null;
  /** Set when a borrower cancels an unfunded (open) promise. */
  cancelled_at?: number;
  borrower_snapshot: BorrowerSnapshot;
  pe_ids: string[];
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export type PoolStatus =
  | 'open'
  | 'funded'
  | 'executed'
  | 'refunded'
  | 'cancelled';

export interface PoolContribution {
  address: string;
  amount_usdc: number;            // populated when pool.currency === 'usdc'
  /** PVT-denominated contribution (BigInt-as-string). Pool currency dictates. */
  amount_pvt?: string;
  contributed_at: number;
  tx_hash: string;
}

export interface PoolDocument {
  pool_id: string;
  creator_wallet_id: string;
  creator_address: string;
  target_address: string;
  target_description: string;
  /** Currency. Immutable post-create. All contributions MUST match this currency. */
  currency: Currency;
  // USDC-denominated.
  threshold_usdc: number;
  fee_usdc: number;
  net_to_target_usdc: number;
  total_contributed_usdc: number;
  // PVT-denominated (BigInt-as-string).
  threshold_pvt?: string;
  fee_pvt?: string;
  net_to_target_pvt?: string;
  total_contributed_pvt?: string;
  max_contributors: number;
  chain: string;
  deadline: number;               // Unix ms
  status: PoolStatus;
  /**
   * The on-chain `bytes32 poolId` every contributor's `contribute` targeted,
   * recovered + verified from the first real on-chain contribution and bound
   * transactionally (later contributors must match it). Absent on pools created
   * before entry-side contribution verification (legacy) — the exit legs fall back
   * to recovering it per contribution tx. Once set, every Firestore contributor is
   * a real on-chain contributor of this poolId, so `refundPool` pays each and the
   * exit-leg confirmed-contributor gating agrees with entry by construction.
   */
  onchain_pool_id?: string;
  contributions: Record<string, PoolContribution>;
  executed_at?: number;
  execute_tx_hash?: string;
  execute_block_number?: number | null;
  refunded_at?: number;
  pe_ids: string[];
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Court (Phase 2)
// ---------------------------------------------------------------------------

export type CourtDisputeStatus = 'pending' | 'resolved' | 'escalated';

export interface ArbitratorDocument {
  wallet_id: string;
  address: string;
  agent_id: string;
  is_active: boolean;
  completed_escrows: number;
  opted_in_at: number;
  total_cases: number;
  majority_votes: number;
  minority_votes: number;
  updated_at: number;
}

/**
 * Per-vote on-chain sync status (Phase 2.15 - D3-C-4 fix).
 *
 *   pending_chain - Recorded in Firestore but not yet attested on-chain.
 *                   Vote counts toward majority resolution; the on-chain
 *                   tx will follow when the arbitrator's SDK submits it.
 *   confirmed     - Verified on-chain via the supplied tx_hash. The
 *                   relay parsed a matching VoteCast event from the
 *                   receipt before flipping to this state.
 *   failed        - On-chain verification failed (wrong arbitrator,
 *                   wrong vote, tx not found). Vote remains valid in
 *                   Firestore; the SDK should retry the on-chain submit.
 */
export type CourtVoteStatus = 'pending_chain' | 'confirmed' | 'failed';

export interface CourtVoteRecord {
  release_to_recipient: boolean;
  cast_at: number;
  status: CourtVoteStatus;
  tx_hash?: string;            // Set when the arbitrator's SDK submits the on-chain vote
  block_number?: number | null;
  failure_reason?: string;
}

export interface CourtDisputeDocument {
  escrow_id: string;
  panel: string[];               // 3 wallet IDs
  panel_addresses: string[];     // 3 on-chain addresses
  /**
   * Wave J-bis: chain captured at dispute creation from the linked
   * escrow's chain field. Allows on-chain vote verification without
   * re-reading the escrow doc (the escrow lookup is now a legacy
   * fallback for dispute docs created before this field landed).
   * Optional on the type so legacy reads typecheck cleanly; new writes
   * always set it.
   */
  chain?: string;
  /**
   * Map of walletId → CourtVoteRecord (Phase 2.15). The legacy
   * walletId → boolean shape is retained as `votes_legacy` for one
   * release of backwards compatibility - readers should consume `votes`
   * (CourtVoteRecord) and only fall back to `votes_legacy` if the new
   * field is absent (i.e. dispute created before the migration).
   */
  votes: Record<string, CourtVoteRecord>;
  votes_legacy?: Record<string, boolean>;
  voting_deadline: number;       // Unix ms
  status: CourtDisputeStatus;
  verdict?: boolean;             // true = release, false = refund
  /**
   * agent directory: the verified on-chain escrow settlement tx backing the recorded
   * verdict (lowercased). The receipt/idempotency anchor for the economic
   * court_dispute pending→resolved transition — set atomically with the flip.
   */
  resolution_tx_hash?: string;
  created_at: number;
  updated_at: number;
  pe_ids: string[];
}

// ---------------------------------------------------------------------------
// General Disputes (Court Mandate Expansion)
// ---------------------------------------------------------------------------

export type GeneralDisputeStatus =
  | 'filed'
  | 'panel_assigned'
  | 'evidence_period'
  | 'voting'
  | 'resolved'
  | 'escalated';

export type GeneralDisputeResolution =
  | 'upheld'
  | 'dismissed'
  | 'partial'
  | 'escalated_external';

export interface GeneralDisputeDocument {
  dispute_id: string;
  filed_by: string;
  respondent: string;
  subject_pe_ids: string[];
  description: string;
  requested_remedy: string;
  evidence_pe_ids: string[];
  status: GeneralDisputeStatus;
  panel_wallet_ids?: string[];
  votes?: Record<string, GeneralDisputeResolution>;
  resolution?: GeneralDisputeResolution;
  resolution_summary?: string;
  resolution_pe_id?: string;
  /**
   * When set, this general dispute escalates a bond claim to the Court. agent directory:
   * on panel resolution, castGeneralDisputeVote records a RECORD-ONLY Court
   * FINDING on the claim (recordBondClaimCourtFinding) and attempts settlement
   * observation — the claim's filed→upheld|dismissed flip fires only through
   * the receipt-gated resolveBondClaim() on a verified Base-final
   * BondSlashed/ClaimDismissed receipt (the on-chain event decides the
   * verdict). The link is established at filing time and both sides reference
   * each other.
   */
  bond_claim_id?: string;
  /**
   * LEGACY (P4-09, retired by): a general dispute once carried a Commons forum challenge
   * to the Court. resolves challenges by BURN-TO-PRESENT (challenger stakes, author
   * presents against a predicate) and never by Court; no writer sets this field any more. Kept
   * on the type only so rows written before still parse.
   */
  challenge_id?: string;
  filed_at: number;
  resolved_at?: number;
  // Deadline checkpoints written atomically with the corresponding status
  // transition: evidence_deadline when entering 'evidence_period'
  // (assignGeneralDisputePanel), voting_deadline when entering 'voting'
  // (processGeneralDisputeDeadlines step 2). The deadline scheduler filters on
  // these via range queries, so they must stay populated on every transition.
  evidence_deadline?: number;
  voting_deadline?: number;
  pe_ids: string[];
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// API Request types
// ---------------------------------------------------------------------------

export interface CreateEscrowRequest {
  depositor_wallet_id: string;
  recipient_wallet_id: string;
  /**
   * Currency. Optional for back-compat - omitting it defaults to 'usdc',
   * which preserves the V3 USDC-only behaviour. Sending 'pvt' requires
   * ENABLE_PVT_PRINCIPAL=true on the backend and triggers the V4 pipeline.
   */
  currency?: Currency;
  /** Required when currency === 'usdc' (or omitted). USD float. */
  amount_usdc?: number;
  /** Required when currency === 'pvt'. BigInt-as-string (18 decimals). */
  amount_pvt?: string;
  description: string;
  deliverables: string;
  deadline_hours: number;
  auto_release_hours: number;
  chain: string;
}

export interface CreatePromiseRequest {
  borrower_wallet_id: string;
  currency?: Currency;
  // USDC path
  principal_usdc?: number;
  repay_usdc?: number;
  // PVT path (BigInt-as-string)
  principal_pvt?: string;
  repay_pvt?: string;
  deadline_hours: number;
  purpose: string;
  chain: string;
}

export interface CreatePoolRequest {
  creator_wallet_id: string;
  target_address: string;
  target_description: string;
  currency?: Currency;
  threshold_usdc?: number;
  threshold_pvt?: string;
  deadline_hours: number;
  max_contributors: number;
  chain: string;
}

// ---------------------------------------------------------------------------
// On-chain escrow settlement (WS1)
// ---------------------------------------------------------------------------

export type EscrowSettleStatus =
  | 'released' // gas-EOA released on-chain just now (post-timeout)
  | 'already_released' // on-chain status already Completed (depositor SDK release or prior run)
  | 'pending_pre_timeout' // funded, before auto-release; only the depositor can release (backend cannot)
  | 'unconfigured' // release signer not configured (ESCROW_RELEASE_KEY unset)
  | 'unrecoverable_id' // could not recover the on-chain bytes32 escrow id
  | 'failed'; // RPC/tx error or unexpected on-chain status

export interface EscrowSettleResult {
  status: EscrowSettleStatus;
  txHash?: string;
  onchainId?: string;
  reason?: string;
}

/**
 * Pass-3 #1 — result of settling a DISPUTED escrow on-chain via
 * `ProvianEscrowV4.resolveDispute(bytes32,bool)` (or the permissionless
 * refund-only `claimDisputeTimeout`). `resolved`/`already_resolved` both mean the
 * on-chain escrow is now terminally `Resolved` (funds moved to the recipient on
 * release, or refunded to the depositor) and the caller may flip Firestore + emit
 * escrow_resolved/court_verdict PEs; every OTHER status is fail-closed (the caller
 * must NOT record a resolution the chain never performed).
 */
export type EscrowDisputeSettleStatus =
  | 'resolved'             // our tx resolved it on-chain this call, verified off the EscrowResolved event
  | 'already_resolved'     // on-chain status already Resolved (Court on-chain vote, admin, or a prior run)
  | 'pending_onchain'      // still Disputed on-chain and the backend cannot settle this direction (needs admin/court, or a pre-timeout refund) — fail-closed
  | 'not_disputed_onchain' // on-chain status is not Disputed and not Resolved (e.g. still Funded because no on-chain dispute was filed) — fail-closed
  | 'unconfigured'         // release signer not configured (ESCROW_RELEASE_KEY unset)
  | 'unrecoverable_id'     // could not recover the on-chain bytes32 escrow id
  | 'failed';              // RPC/tx error or unexpected on-chain status

export interface EscrowDisputeSettleResult {
  status: EscrowDisputeSettleStatus;
  txHash?: string;
  onchainId?: string;
  reason?: string;
  /**
   * The ACTUAL on-chain resolution direction (true = released to recipient,
   * false = refunded to depositor), bound to the chain: for `resolved` it is the
   * direction of the tx we broadcast (verified off the EscrowResolved event); for
   * `already_resolved` it is recovered from the on-chain EscrowResolved log so the
   * caller records what the chain actually paid — NOT the caller's requested
   * direction, which can diverge (e.g. a permissionless claimDisputeTimeout
   * refunded the depositor, or the on-chain Court vote differed from the Firestore
   * tally). Absent only on non-terminal statuses.
   */
  resolvedReleaseToRecipient?: boolean;
  /**
   * WHO resolved it, read from the chain — true when the Court's own `Verdict` rides the
   * resolving transaction, false when the escrow admin or the timeout refund did. Set on every
   * terminal status by the production gateway. Standing counts a lost HIRE dispute only when this
   * is exactly `false`; a Court decision is counted by its verdict.
   */
  resolvedByCourt?: boolean;
}

/**
 * Performs (or observes) the real on-chain escrow release. Injected via
 * `AgentBankDeps.escrowChain` so tests can supply a fake. `settle`/`settleDispute`
 * NEVER flip Firestore; the caller acts on the returned status. See
 * `core/agent-bank/escrow-release.ts` for the production implementation.
 */
export interface EscrowChainGateway {
  /** True when a gas-only release signer is configured and identity-validated. */
  canSign(): boolean;
  settle(escrow: EscrowDocument): Promise<EscrowSettleResult>;
  /**
   * Pass-3 #1: drive (or observe) the on-chain resolution of a DISPUTED escrow.
   * Calls `resolveDispute(escrowId, releaseToRecipient)` (authorized only for
   * admin/court — on the live founder-EOA-admin stack this estimate-reverts
   * without broadcasting, so the backend falls back to observing an on-chain
   * resolution driven by the Court contract's on-chain votes, or — for a
   * depositor refund only — the permissionless `claimDisputeTimeout`). Returns a
   * terminal `resolved`/`already_resolved` ONLY when the on-chain escrow is
   * confirmed `Resolved`; otherwise a fail-closed status the caller must not
   * record as resolved.
   */
  settleDispute(escrow: EscrowDocument, releaseToRecipient: boolean): Promise<EscrowDisputeSettleResult>;
  /**
   * READ-ONLY on-chain dispute state of an escrow — the Status enum plus the
   * `disputeDeadline(escrowId)` after which the permissionless 30-day refund
   * (`claimDisputeTimeout`) is callable. Never signs, never writes. Optional so older
   * test doubles stay valid; a caller that needs it and finds it absent fails closed.
   */
  readDisputeState?(escrow: EscrowDocument): Promise<EscrowDisputeStateRead>;
}

/** on-chain Status enum values (ProvianEscrowV3/V4 share them). */
export const ONCHAIN_ESCROW_STATUS = {
  CREATED: 0,
  FUNDED: 1,
  COMPLETED: 2,
  DISPUTED: 3,
  RESOLVED: 4,
  CANCELLED: 5,
} as const;

export type EscrowDisputeStateRead =
  | {
      ok: true;
      onchainId: string;
      /** On-chain Status enum (see ONCHAIN_ESCROW_STATUS). */
      status: number;
      /** Unix SECONDS after which claimDisputeTimeout is callable; 0 when never disputed. */
      disputeDeadlineSec: bigint;
    }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// On-chain bond abandonment keeper (Pass-2 WS2 [CONFIG] closure)
// ---------------------------------------------------------------------------

export type BondAbandonmentStatus =
  | 'burned' // gas-EOA called processAbandonment just now; tx confirmed
  | 'already_burned' // on-chain status already Abandoned (a prior run / another caller)
  | 'not_yet_eligible' // on-chain reverts GracePeriodNotExpired — +395d (30d grace + 365d abandonment) not reached on-chain yet
  | 'not_active' // on-chain status Withdrawn/None — nothing to burn
  | 'unconfigured' // BOND_KEEPER_KEY unset (no gas-EOA)
  | 'failed'; // RPC/tx error or unexpected on-chain status

export interface BondAbandonmentResult {
  status: BondAbandonmentStatus;
  txHash?: string;
  reason?: string;
}

/**
 * Pass-3 #3 — result of calling the permissionless on-chain
 * `ProvianBondPool.expireStaleClaim(claimId)` for a stale, never-adjudicated bond
 * claim. `expired`/`already_expired` both mean the claim is now terminally
 * Dismissed on-chain (pendingClaims decremented, no slash) and the scheduler may
 * mirror the decrement; every other status leaves the claim 'filed'.
 */
export type BondClaimExpiryStatus =
  | 'expired'          // our tx mined and emitted ClaimExpired (verified against the log)
  | 'already_expired'  // claim already Dismissed on-chain (raced timeout / court dismiss) — safe to mirror
  | 'already_slashed'  // claim Upheld on-chain (a slash landed) — do NOT record as expired
  | 'not_yet_expired'  // on-chain still Filed (60d not reached on-chain / clock skew)
  | 'not_found'        // no onchain_claim_id, or the claim is absent on-chain
  | 'unconfigured'     // BOND_KEEPER_KEY unset (no gas-EOA)
  | 'failed';          // RPC/tx error, revert, or missing ClaimExpired log

export interface BondClaimExpiryResult {
  status: BondClaimExpiryStatus;
  txHash?: string;
  reason?: string;
}

/**
 * Performs the real on-chain `ProvianBondPool.processAbandonment(agent)` burn and
 * `expireStaleClaim(claimId)` timeout. Injected via `AgentBankDeps.bondKeeper` so
 * tests can supply a fake. The caller (scheduler) acts on the returned status and
 * only mirrors Firestore state when the on-chain effect is confirmed. See
 * `core/agent-bank/bond-keeper.ts` for the production implementation.
 */
export interface BondKeeperGateway {
  /** True when a gas-only keeper signer is configured and identity-validated. */
  canSign(): boolean;
  processAbandonment(bond: BondDocument): Promise<BondAbandonmentResult>;
  /**
   * Pass-3 #3: call the permissionless `expireStaleClaim(onchain_claim_id)` for a
   * claim still Filed past CLAIM_RESOLUTION_TIMEOUT (60d), confirming the effect
   * off the ClaimExpired log. Needs no privilege (permissionless) — reuses the
   * same gas-only keeper EOA that drives abandonment.
   */
  expireStaleClaim(claim: BondClaimDocument): Promise<BondClaimExpiryResult>;
}

// ---------------------------------------------------------------------------
// On-chain pool refund keeper (P4-02 — the pool exit leg's missing keeper)
// ---------------------------------------------------------------------------

/**
 * Result of driving the permissionless on-chain `ProvianPool.refundPool(poolId)`
 * for an expired, under-threshold pool. `refunded`/`already_refunded` both mean
 * the on-chain pool is now terminally `Refunded` (every contributor's funds were
 * pushed back, or credited to the pull-refund ledger for a reverting recipient),
 * so the scheduler may flip Firestore + emit pool_refunded PEs. `no_contributors`
 * means there is nothing on-chain to refund (the scheduler flips Firestore with no
 * PE). Every OTHER status is fail-closed — the scheduler must NOT assert a refund
 * the chain never performed.
 */
export type PoolRefundStatus =
  | 'refunded'          // gas-EOA called refundPool just now; confirmed off the PoolRefunded event
  | 'already_refunded'  // on-chain status already Refunded (a prior run / another caller)
  | 'no_contributors'   // pool has no contributions — nothing on-chain to refund
  | 'not_refundable'    // on-chain status is not Open (Funded/Executed/Cancelled) — permissionless refund can't apply
  | 'not_yet_expired'   // on-chain reverts DeadlineNotReached — deadline not reached on-chain (clock skew)
  | 'unrecoverable_id'  // could not recover the on-chain bytes32 poolId from any contribution tx
  | 'unconfigured'      // POOL_KEEPER_KEY unset (no gas-EOA)
  | 'failed';           // RPC/tx error, revert, or missing PoolRefunded log

export interface PoolRefundResult {
  status: PoolRefundStatus;
  txHash?: string;
  onchainPoolId?: string;
  reason?: string;
  /**
   * On `refunded`/`already_refunded`: the wallet IDs of the Firestore contributors
   * CONFIRMED on-chain as real contributors of THIS pool (their contribution tx
   * emitted a `PoolContribution` for the recovered on-chain poolId, so they are in
   * `contributorList` and were paid/credited by `refundPool`). The scheduler emits
   * a `pool_refunded` PE ONLY for these — never for a Firestore-only "contributor"
   * (e.g. a bare ERC-20 transfer that was never a real on-chain `contribute`, whom
   * `refundPool` never pays). Absent on non-terminal statuses.
   */
  confirmedContributorWalletIds?: string[];
}

/**
 * Performs the real on-chain `ProvianPool.refundPool(poolId)` for an expired pool.
 * Injected via `AgentBankDeps.poolKeeper` so tests can supply a fake. The caller
 * (scheduler) acts on the returned status and only mirrors Firestore state +
 * emits a pool_refunded PE when the on-chain refund is confirmed. Mirrors the
 * escrow release / bond abandonment keepers: a dedicated gas-only EOA
 * (`POOL_KEEPER_KEY`) drives the PERMISSIONLESS refund (anyone may refund an Open
 * pool past its deadline). See `core/agent-bank/pool-keeper.ts`.
 */
export interface PoolKeeperGateway {
  /** True when a gas-only keeper signer is configured and identity-validated. */
  canSign(): boolean;
  refundExpiredPool(pool: PoolDocument): Promise<PoolRefundResult>;
}

// ---------------------------------------------------------------------------
// Router dependencies
// ---------------------------------------------------------------------------

export interface AgentBankDeps {
  db: Firestore;
  cache: RedisCache;
  peBuffer: { enqueue: (docId: string, data: object) => void };
  /**
   * On-chain escrow release gateway (WS1). Optional so unit tests and
   * non-escrow call sites can omit it; the escrow release paths fail closed
   * (escrows stay funded, never falsely completed) when it is absent.
   */
  escrowChain?: EscrowChainGateway;
  /**
   * On-chain bond abandonment keeper (Pass-2 WS2). Optional so unit tests and
   * non-scheduler call sites can omit it; the abandonment path asserts NO burn
   * (bonds stay 'expired') when it is absent or cannot sign. Backed by a
   * dedicated gas-only EOA (BOND_KEEPER_KEY) — see core/agent-bank/bond-keeper.ts.
   */
  bondKeeper?: BondKeeperGateway;
  /**
   * On-chain pool refund keeper (P4-02). Optional so unit tests and non-scheduler
   * call sites can omit it; the expiry refund path asserts NO refund (pools stay
   * 'open') when it is absent or cannot sign. Backed by a dedicated gas-only EOA
   * (POOL_KEEPER_KEY) — see core/agent-bank/pool-keeper.ts.
   */
  poolKeeper?: PoolKeeperGateway;
  recordPEAccrual: (params: {
    peId: string;
    userId: string;
    actionType: string;
    integrationSource: string;
    // PE METER: the batch the act is metered in (relay-authored acts price as a one-act relay
    // batch, `meter-relay-authored.ts`). The accrual seals through the meter when it is present.
    meter?: import('../../pvt-accrual').RecordPEAccrualParams['meter'];
    attestationDepth: 'hardware' | 'software';
    peHash: string;
    timestamp: number;
    // Commit SHA for cross-witness mint-once dedup (forge webhook + observer
    // PEs that carry metadata.commit_sha). Absent on non-commit PEs.
    commitSha?: string | null;
    // Lineage / goal linkage - persisted with the act as its citation record
    // (read for lineage attribution by the retired PVTv8 minting engine;
    // consumption edges pay nothing under). Null on the common path.
    citedPeIds?: string[] | null;
    parentGoalPeId?: string | null;
    // Retired compatibility field. Exact Genesis value requires the sealed
    // reservation-bound economicSnapshot path.
    fixedEstimatedPVT?: number | null;
    // Retired compatibility marker. Current Genesis beneficiary treatment is
    // derived only from the reservation-bound economic snapshot.
    isGenesisGrant?: boolean;
    // Retired PVTv8 audit context; not current reservation authority.
    genesisWalletId?: string | null;
    genesisFundingSourceAddress?: string | null;
    // x402: the on-chain payer (sovereign agent EOA) for an x402_payment PE,
    // so x402_payment_count credits the wallet that actually paid. undefined
    // (no-op) for every non-x402 PE.
    x402PayerAddress?: string;
    // x402 cross-source mint-once dedup key (settlement tx). undefined on non-x402.
    x402SettlementTxHash?: string | null;
    // Option B (x402 watcher-only mint): true ONLY for a chain-verified
    // outbound-watcher x402 emit. The sole authority for x402 minting +
    // x402_payment_count; self-reports never set it → they record x402_unverified
    // (0 PVT). Omitted (falsy) on every non-watcher / non-x402 path.
    x402ChainVerified?: boolean;
    // sovereign agent-work occurrence mint-once keys (both or neither), set
    // only after the per-occurrence agent-key binding verifies. Omitted elsewhere.
    sovereignWorkOccurrenceId?: string | null;
    sovereignWorkSignerAddress?: string | null;
    // Identity/count-only financial anti-farming input.
    counterpartyAddress?: string | null;
    /** review: the verified transaction signer the same-owner fence also checks. */
    economicTransactionSigner?: string | null;
    economicEvidenceState?: 'not_required' | 'pending' | 'verified' | 'rejected' | 'unverifiable';
    economicCanonicalEventId?: string | null;
    /**
     *. Claims that this caller's exact accrual input was committed
     * durably BEFORE acknowledgement, so the accrual may treat it as a
     * replayable economic path instead of best-effort.
     *
     * NOT a lane switch and NOT an eligibility input. The accrual VERIFIES it
     * against the committed intake row (`verifyOrdinaryAccrualIntakeReplaySource`)
     * and refuses on any mismatch, so passing it cannot manufacture durability.
     */
    durableReplaySource?: import('../pvt/wp11/ordinary-accrual-intake').OrdinaryAccrualReplaySource;
    economicSnapshot?: import('../pvt/policy/monetary-accounting').RecordEconomicSnapshot | null;
    ownerType?: 'human' | 'agent';
    walletAddress?: string | null;
    /**
     * Durable state machines may require an acknowledgement that pe_history
     * landed before advancing their outbox. Ordinary PE callers leave this
     * false so the historical fire-and-forget behavior is unchanged.
     */
    throwOnError?: boolean;
    // Trust Layer build (2026-09-16): the ONE graph + output digests + witness class. Mirrors
    // the RecordPEAccrualParams fields exactly; a generatePE lane threads them from its body.
    inputOrigins?: readonly import('../provenance/input-origins').InputOrigin[] | null;
    submissionWitness?: import('../pvt/origin-independence').SealedWitness | null;
    witnessObservedTokens?: number | null;
    bodyDeclaredTokens?: number | null;
    compositionSignals?: import('../pvt/actor-stats').CompositionSignals | null;
    outputDigests?: readonly import('../provenance/output-digests').OutputDigest[] | null;
    witnessClass?: import('../pvt/policy/evidence-class').WitnessClass;
    witnessedAtMs?: number | null;
  }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Contract ABIs (minimal - only the functions we call from the backend)
// ---------------------------------------------------------------------------

export const ESCROW_ABI = [
  'function createEscrow(bytes32 escrowId, address recipient, uint256 amount, uint256 autoReleaseAt) external',
  'function releaseEscrow(bytes32 escrowId) external',
  'function disputeEscrow(bytes32 escrowId) external',
  'function resolveDispute(bytes32 escrowId, bool releaseToRecipient) external',
  'function setCourtContract(address _court) external',
  'function delegateToCourt(bytes32 escrowId) external',
  'function getParties(bytes32 escrowId) external view returns (address depositor, address recipient)',
  'event EscrowCreated(bytes32 indexed escrowId, address indexed depositor, address indexed recipient, uint256 amount, uint256 fee, uint256 autoReleaseAt)',
  'event EscrowFunded(bytes32 indexed escrowId, uint256 amount)',
  'event EscrowReleased(bytes32 indexed escrowId, address indexed recipient, uint256 netAmount, uint256 fee, bool autoRelease)',
  'event EscrowDisputed(bytes32 indexed escrowId)',
  'event EscrowResolved(bytes32 indexed escrowId, bool releaseToRecipient)',
  'event EscrowCancelled(bytes32 indexed escrowId)',
  'event CourtContractSet(address indexed courtContract)',
  'event DisputeDelegatedToCourt(bytes32 indexed escrowId)',
] as const;

export const PROMISE_ABI = [
  'function createPromise(bytes32 promiseId, uint256 principal, uint256 repayAmount, uint256 deadline) external',
  'function markDefault(bytes32 promiseId) external',
  'event PromiseCreated(bytes32 indexed promiseId, address indexed borrower, uint256 principal, uint256 repayAmount, uint256 deadline)',
  'event PromiseFunded(bytes32 indexed promiseId, address indexed lender, uint256 principal)',
  'event PromiseSettled(bytes32 indexed promiseId, address indexed lender, uint256 netAmount, uint256 fee)',
  'event PromiseDefaulted(bytes32 indexed promiseId, address indexed borrower, address indexed lender, uint256 principal)',
  'event PromiseCancelled(bytes32 indexed promiseId)',
] as const;

export const POOL_ABI = [
  'function createPool(bytes32 poolId, address target, uint256 threshold, uint256 deadline) external',
  'function executePool(bytes32 poolId) external',
  'function refundPool(bytes32 poolId) external',
  'event PoolCreated(bytes32 indexed poolId, address indexed creator, address indexed target, uint256 threshold, uint256 deadline)',
  'event PoolContribution(bytes32 indexed poolId, address indexed contributor, uint256 amount, uint256 totalContributed)',
  'event PoolExecuted(bytes32 indexed poolId, address indexed target, uint256 netAmount, uint256 fee)',
  'event PoolRefunded(bytes32 indexed poolId, uint256 contributorCount)',
  'event PoolWithdrawal(bytes32 indexed poolId, address indexed contributor, uint256 amount)',
  'event PoolCancelled(bytes32 indexed poolId)',
] as const;

export const COURT_ABI = [
  'function assignPanel(bytes32 escrowId, address[3] arbs) external',
  'function resolveEscalatedDispute(bytes32 escrowId, bool releaseToRecipient) external',
  // No `slashAgentReputation` — the reputation-stake drop removed it from
  // ProvianCourtV2, so a fragment for it would describe a function the contract
  // no longer has. Nothing in the backend ever invoked it.
  'function castVote(bytes32 escrowId, bool releaseToRecipient) external',
  'function escalateDispute(bytes32 escrowId) external',
  'function getPanel(bytes32 escrowId) external view returns (address[3])',
  'function getVoteCounts(bytes32 escrowId) external view returns (uint8, uint8)',
  'function hasArbitratorVoted(bytes32 escrowId, address arb) external view returns (bool)',
  'function getDisputeStatus(bytes32 escrowId) external view returns (uint8)',
  'function getVotingDeadline(bytes32 escrowId) external view returns (uint256)',
  'event PanelAssigned(bytes32 indexed escrowId, address arb0, address arb1, address arb2, uint256 votingDeadline)',
  'event VoteCast(bytes32 indexed escrowId, address indexed arbitrator, bool releaseToRecipient)',
  'event Verdict(bytes32 indexed escrowId, bool releaseToRecipient, uint8 votesForRelease, uint8 votesForRefund)',
  'event Escalated(bytes32 indexed escrowId)',
] as const;

// Phase 3: PVT + Governance + PE Anchor
//
// HISTORICAL PVTv4 ABI. Retained for legacy reads only; it is not the production
// minting ABI and its bootstrap/human-governance functions are not PVT9 policy.
// The canonical live minting ABI is PVT_V8_ABI below.
//
// Surface (W7): differential Foundation rate machinery (per-contributor
// rate via registry query, automatic baseline, standard + emergency human
// governance hooks, composition metric, bootstrap paths, one-shot seed
// function). BatchMinted event carries humanSharePortion and
// agentSharePortion; the constructor takes a registry address.
export const PVT_ABI = [
  // ERC-20 + core state (same as V3)
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function mintRate() view returns (uint256)',
  'function currentEpoch() view returns (uint256)',
  'function epochDuration() view returns (uint256)',
  'function peWeights(bytes32) view returns (uint256)',
  'function batchMinted(bytes32) view returns (bool)',
  'function totalBurned() view returns (uint256)',
  'function totalEverMinted() view returns (uint256)',
  'function circulatingSupply() view returns (uint256)',
  'function circuitBreakerTripped() view returns (bool)',
  'function currentEpochMinted() view returns (uint256)',
  'function epochMintHistory(uint256) view returns (uint256)',
  'function GENESIS_EPOCH_HARD_CAP() view returns (uint256)',
  'function protocolContracts(address) view returns (bool)',
  'function minter() view returns (address)',

  // V4 version pattern
  'function version() pure returns (string)',
  'function VERSION() view returns (string)',

  // Immutable constants (exposed for off-chain readability)
  'function PROVIAN_BPS() view returns (uint256)',
  'function HUMAN_FOUNDATION_BPS() view returns (uint256)',
  'function EMERGENCY_COOLDOWN_SECONDS() view returns (uint256)',
  'function EMERGENCY_SECONDING_BPS() view returns (uint256)',
  'function STANDARD_GOV_WINDOW_SECONDS() view returns (uint256)',
  'function STANDARD_GOV_WINDOW_MAX_BPS() view returns (uint256)',

  // Activation state
  'function activationState() view returns (uint8)',
  'function activationTimestamp() view returns (uint256)',
  'function launchTimestamp() view returns (uint256)',

  // Agent Foundation rate slots
  'function baselineBPS() view returns (uint256)',
  'function standardGovBPS() view returns (uint256)',
  'function emergencyGovBPS() view returns (uint256)',
  'function emergencyLastInvoked() view returns (uint256)',

  // Governance-adjustable baseline params
  'function baselineBaseRatePerYearBps() view returns (uint256)',
  'function baselineCeilingBps() view returns (uint256)',

  // Composition metric
  'function getCompositionFraction() view returns (uint256)',
  'function getAutomaticBaseline() view returns (uint256)',
  'function getCurrentAgentFoundationBPS() view returns (uint256)',

  // Registry and verification infra addresses
  'function registry() view returns (address)',
  'function verificationInfrastructure() view returns (address)',
  'function humanGovernanceContract() view returns (address)',
  'function governanceContract() view returns (address)',
  'function courtContract() view returns (address)',

  // Mint + epoch
  'function mintFromPEs(bytes32 batchId, address[] contributors, uint256[] pePoints, bytes32[] peActionTypes, bytes32 merkleRoot) external',
  'function advanceEpoch() external',

  // Burns + staking (same as V3)
  'function burn(uint256 amount) external',
  'function foundationBurn(uint256 amount) external',
  'function burnForProposal(address proposer, uint256 amount) external',
  'function slashReputation(address agent, uint256 amount, address recipient) external',
  'function resetCircuitBreaker() external',

  // Admin one-shots (same as V3 plus human governance)
  'function setGovernanceContract(address _governance) external',
  'function setCourtContract(address _court) external',
  'function setHumanGovernance(address _humanGovernance) external',
  'function setProtocolContract(address _protocol, bool enabled) external',
  'function transferAdmin(address newAdmin) external',

  // PVT-weighted governance hooks
  'function updateMintRate(uint256 newRate) external',
  'function updatePEWeight(bytes32 actionType, uint256 weight) external',

  // Bootstrap paths (called from PVT-weighted governance)
  'function bootstrapStandard(address _verificationInfra, address _newRegistry, uint256 proposalCreatedAt) external',
  'function bootstrapEmergency(address _verificationInfra, address _newRegistry, uint256 emergencyRateBps, uint256 proposalCreatedAt) external',

  // Human governance rate setters
  'function setAgentFoundationBPS_byStandard(uint256 newRateBps) external',
  'function setAgentFoundationBPS_byEmergency(uint256 newRateBps) external',
  'function setAgentFoundationBPS_byReversal(uint256 newRateBps) external',
  'function setBaselineBaseRate(uint256 newRate) external',
  'function setBaselineCeiling(uint256 newCeiling) external',
  'function setCompositionSchedule(uint256[4] newCuts, uint256[4] newMults) external',
  'function setRegistry(address newRegistry) external',
  'function setVerificationInfrastructure(address newInfra) external',

  // Baseline pokes (permissionless)
  'function pokeBaseline() external',

  // Seed migration (one-shot PreVerification)
  'function seedInitialBalance(address[] recipients, uint256[] amounts) external',

  // Minter timelock (same as V3)
  'function proposeMinter(address newMinter) external',
  'function finalizeMinter() external',
  'function pendingMinter() view returns (address)',
  'function minterChangeTimestamp() view returns (uint256)',

  // Snapshot + supply scaler (same as V3)
  'function currentSupplyScaler() view returns (uint256)',
  'function effectiveMintRate() view returns (uint256)',
  'function stakeRatioBps() view returns (uint256)',
  'function tokenomicSnapshot() view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool, uint256)',

  // Events - V4 BatchMinted adds human/agent share portions
  'event BatchMinted(bytes32 indexed batchId, uint256 indexed epoch, uint256 totalMinted, uint256 contributorTotal, uint256 provianShare, uint256 foundationShare, bytes32 merkleRoot, uint256 effectiveMintRate, uint256 supplyScaler, uint256 humanSharePortion, uint256 agentSharePortion)',
  'event EpochAdvanced(uint256 indexed epoch, uint256 startTime, uint256 previousEpochMinted)',
  'event MintRateUpdated(uint256 oldRate, uint256 newRate)',
  'event PEWeightUpdated(bytes32 indexed actionType, uint256 oldWeight, uint256 newWeight)',
  'event Burned(address indexed burner, uint256 amount)',
  'event ProtocolBurned(address indexed protocol, uint256 amount)',
  'event FoundationBurned(uint256 amount, uint256 milestoneTier)',
  'event ReputationSlashed(address indexed agent, uint256 amount, address indexed recipient, uint256 burned)',
  'event CircuitBreakerTripped(uint256 epochMinted, uint256 trailingAvg, uint256 threshold)',
  'event CircuitBreakerReset(address indexed resetter)',
  'event ProposalBurned(address indexed proposer, uint256 amount)',
  'event StakeFloorThrottleApplied(uint256 stakedRatioBps, uint256 penaltyBps)',
  'event SupplyTierCrossed(uint256 tier, uint256 totalEverMinted, uint256 newScaler)',
  'event BaselinePoked(uint256 oldBaselineBps, uint256 newBaselineBps)',
  'event ActivationBootstrapped(uint8 newState, address registry, address verificationInfra)',
  'event AgentFoundationBPSUpdated(uint256 oldBps, uint256 newBps, string track)',
  'event InitialBalanceSeeded(uint256 totalAmount)',
  'event BaselineParamUpdated(string param, uint256 oldValue, uint256 newValue)',
  'event CompositionScheduleUpdated()',
  'event HumanGovernanceSet(address indexed humanGovernance)',
  'event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry)',
  'event VerificationInfrastructureUpdated(address indexed oldInfra, address indexed newInfra)',
] as const;

// ---------------------------------------------------------------------------
// PVTv5 "Constitution" ABI — historical (live 2026-06-23, superseded by PVTv6,
// 2026-06-24). Retained because PVTv6's ABI is built as a strict superset of it
// (see PVT_V6_ABI below). The canonical live minting ABI is now PVT_V8_ABI, a
// byte-identical alias of PVT_V7_ABI == PVT_V6_ABI (which spreads this array).
//
// PVTv5 retired the stake-floor mint throttle, the unbounded seedInitialBalance
// admin mint, and the voice burn; routed every economic lever through one
// generalized governance executor (`executor`); and exposed the agent-Foundation
// rate as one executor-gated governance slot (`govAgentFoundationBPS` /
// `setAgentFoundationBPS`) plus the automatic baseline. A guardian holds a
// halt-only emergency brake (`tripCircuitBreaker`).
//
// PVTv6 restored the EMERGENCY raise and full reversibility on that slot: it is
// now freely bidirectional (standard path up = velocity-capped at +0.5pp/12mo,
// down = immediate; emergency path = uncapped upward), bounded below by the
// permanent human floor. The new entry point lives in PVT_V6_ABI below.
//
// The v4 reads removed below (standardGovBPS, emergencyGovBPS, seedInitialBalance,
// StakeFloorThrottleApplied, bootstrap*) do not exist on PVTv5/v6.
// ---------------------------------------------------------------------------
export const PVT_V5_ABI = [
  // ERC-20 + core state
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function mintRate() view returns (uint256)',
  'function lastMintRateChangeAt() view returns (uint256)',
  'function currentEpoch() view returns (uint256)',
  'function epochDuration() view returns (uint256)',
  'function peWeights(bytes32) view returns (uint256)',
  'function lastPEWeightChangeAt(bytes32) view returns (uint256)',
  'function batchMinted(bytes32) view returns (bool)',
  'function totalBurned() view returns (uint256)',
  'function totalEverMinted() view returns (uint256)',
  'function circulatingSupply() view returns (uint256)',
  'function circuitBreakerTripped() view returns (bool)',
  'function currentEpochMinted() view returns (uint256)',
  'function epochMintHistory(uint256) view returns (uint256)',
  'function GENESIS_EPOCH_HARD_CAP() view returns (uint256)',
  'function protocolContracts(address) view returns (bool)',
  'function minter() view returns (address)',
  'function version() pure returns (string)',
  'function VERSION() view returns (string)',

  // Immutable / constitutional constants (exposed for off-chain readability)
  'function PROVIAN_BPS() view returns (uint256)',
  'function HUMAN_FOUNDATION_BPS() view returns (uint256)',
  'function MIN_MINT_RATE() view returns (uint256)',
  'function MAX_MINT_RATE() view returns (uint256)',
  'function MIN_PE_WEIGHT() view returns (uint256)',
  'function MAX_PE_WEIGHT() view returns (uint256)',
  'function GOV_RATE_WINDOW_SECONDS() view returns (uint256)',
  'function GOV_RATE_WINDOW_MAX_BPS() view returns (uint256)',
  'function METER_WINDOW_SECONDS() view returns (uint256)',
  'function MINT_RATE_MAX_DELTA() view returns (uint256)',
  'function PE_WEIGHT_MAX_DELTA() view returns (uint256)',

  // Activation state (one-way)
  'function activationState() view returns (uint8)',
  'function activationTimestamp() view returns (uint256)',
  'function launchTimestamp() view returns (uint256)',

  // Agent Foundation rate (bidirectional governance slot — standard + emergency
  // paths in v6 — plus the automatic baseline)
  'function baselineBPS() view returns (uint256)',
  'function govAgentFoundationBPS() view returns (uint256)',
  'function lastGovRateChangeAt() view returns (uint256)',
  'function baselineBaseRatePerYearBps() view returns (uint256)',
  'function baselineCeilingBps() view returns (uint256)',
  'function getCompositionFraction() view returns (uint256)',
  'function getAutomaticBaseline() view returns (uint256)',
  'function getCurrentAgentFoundationBPS() view returns (uint256)',

  // Roles + wired addresses
  'function admin() view returns (address)',
  'function executor() view returns (address)',
  'function governanceContract() view returns (address)',
  'function courtContract() view returns (address)',
  'function guardian() view returns (address)',
  'function registry() view returns (address)',
  'function verificationInfrastructure() view returns (address)',

  // Minter timelock (governable up only)
  'function pendingMinter() view returns (address)',
  'function minterChangeTimestamp() view returns (uint256)',
  'function minterTimelock() view returns (uint256)',

  // Mint + epoch
  'function mintFromPEs(bytes32 batchId, address[] contributors, uint256[] pePoints, bytes32[] peActionTypes, bytes32 merkleRoot) external',
  'function advanceEpoch() external',

  // Burns + staking (staking is an isolated ledger; never a mint-path term)
  'function burn(uint256 amount) external',
  'function foundationBurn(uint256 amount) external',
  'function burnForProposal(address proposer, uint256 amount) external',
  'function slashReputation(address agent, uint256 amount, address recipient) external', // onlyCourt

  // Circuit breaker (guardian halt-only; executor-only reset)
  'function tripCircuitBreaker() external',
  'function resetCircuitBreaker() external',

  // Shared legacy wiring surface. v5-v7 transferred admin to an executor;
  // live v8 kept admin/executor/guardian on the bootstrap admin EOA. The functions' ABI
  // presence does not authorize transferAdmin, renunciation, or a handoff.
  'function setExecutor(address _executor) external',
  'function setGovernanceContract(address _governance) external',
  'function setCourtContract(address _court) external',
  'function setGuardian(address _guardian) external',
  'function setProtocolContract(address _protocol, bool enabled) external',
  'function transferAdmin(address newAdmin) external',
  'function renounceAdmin() external',

  // Bounded meter setters (`onlyExecutor`; the operator-EOA-direct on live v8)
  'function updateMintRate(uint256 newRate) external',
  'function updatePEWeight(bytes32 actionType, uint256 weight) external',

  // Legacy activation + prospective agent-Foundation setters. On live v8
  // `onlyExecutor` is the bootstrap admin EOA; no governance component gates the calls.
  'function activateHumanGovernance(address _verificationInfra, address _newRegistry) external',
  'function setAgentFoundationBPS(uint256 newRateBps) external',
  'function setBaselineBaseRate(uint256 newRate) external',
  'function setBaselineCeiling(uint256 newCeiling) external',
  'function setCompositionSchedule(uint256[4] newCuts, uint256[4] newMults) external',
  'function setRegistry(address newRegistry) external',
  'function setVerificationInfrastructure(address newInfra) external',
  'function setMinterTimelock(uint256 newDelay) external',
  'function pokeBaseline() external',

  // Minter
  'function proposeMinter(address newMinter) external',
  'function finalizeMinter() external',

  // Snapshot + supply scaler
  'function currentSupplyScaler() view returns (uint256)',
  'function effectiveMintRate() view returns (uint256)',
  'function stakeRatioBps() view returns (uint256)',
  'function tokenomicSnapshot() view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool, uint256)',

  // Events
  'event BatchMinted(bytes32 indexed batchId, uint256 indexed epoch, uint256 totalMinted, uint256 contributorTotal, uint256 provianShare, uint256 foundationShare, bytes32 merkleRoot, uint256 effectiveMintRate, uint256 supplyScaler, uint256 humanSharePortion, uint256 agentSharePortion)',
  'event EpochAdvanced(uint256 indexed epoch, uint256 startTime, uint256 previousEpochMinted)',
  'event MintRateUpdated(uint256 oldRate, uint256 newRate)',
  'event PEWeightUpdated(bytes32 indexed actionType, uint256 oldWeight, uint256 newWeight)',
  'event ExecutorSet(address indexed executor)',
  'event GovernanceContractSet(address indexed governance)',
  'event CourtContractSet(address indexed court)',
  'event GuardianSet(address indexed guardian)',
  'event Burned(address indexed burner, uint256 amount)',
  'event ProtocolBurned(address indexed protocol, uint256 amount)',
  'event FoundationBurned(uint256 amount, uint256 milestoneTier)',
  'event ReputationSlashed(address indexed agent, uint256 amount, address indexed recipient, uint256 burned)',
  'event CircuitBreakerTripped(uint256 epochMinted, uint256 trailingAvg, uint256 threshold)',
  'event CircuitBreakerHalted(address indexed guardian)',
  'event CircuitBreakerReset(address indexed resetter)',
  'event ProposalBurned(address indexed proposer, uint256 amount)',
  'event SupplyTierCrossed(uint256 tier, uint256 totalEverMinted, uint256 newScaler)',
  'event BaselinePoked(uint256 oldBaselineBps, uint256 newBaselineBps)',
  'event HumanGovernanceActivated(address registry, address verificationInfra)',
  'event AgentFoundationBPSUpdated(uint256 oldBps, uint256 newBps, string track)',
  'event BaselineParamUpdated(string param, uint256 oldValue, uint256 newValue)',
  'event CompositionScheduleUpdated()',
  'event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry)',
  'event VerificationInfrastructureUpdated(address indexed oldInfra, address indexed newInfra)',
  'event MinterUpdated(address indexed oldMinter, address indexed newMinter)',
  'event MinterChangeProposed(address indexed proposedMinter, uint256 effectiveAt)',
  'event MinterTimelockUpdated(uint256 oldDelay, uint256 newDelay)',
  'event AdminTransferred(address indexed oldAdmin, address indexed newAdmin)',
] as const;

// ---------------------------------------------------------------------------
// PVTv6 "Emergency Lever" ABI — HISTORICAL (live only during the v6 interval,
// superseded by v7 and then v8).
//
// PVTv6 is byte-for-byte PVTv5 with ONE surgical change to the agent-Foundation
// governance slot, so its ABI is PVT_V5_ABI plus a single new function:
//   - setAgentFoundationBPSEmergency(uint256) — the restored EMERGENCY raise
//     (magnitude-uncapped, window-free, `onlyExecutor`).
// The existing `setAgentFoundationBPS(uint256)` is unchanged in signature but is
// now freely BIDIRECTIONAL on-chain (up = velocity-capped, down = immediate).
// Every other entry is identical to PVT_V5_ABI (a strict superset), so swapping
// PVT_V5_ABI -> PVT_V6_ABI in the relay never removes a function. At the v6
// cutover the relay points PVT_CONTRACT_ADDRESS / GOVERNANCE_CONTRACT_ADDRESS /
// BOND_POOL_CONTRACT_ADDRESS at the new v6 bundle and uses this ABI. The reused
// ProvianConstitutionExecutor address (EXECUTOR_CONTRACT_ADDRESS) is unchanged.
// ---------------------------------------------------------------------------
export const PVT_V6_ABI = [
  ...PVT_V5_ABI,
  // v6: restored emergency agent-Foundation lever — uncapped, window-free, executor-only.
  'function setAgentFoundationBPSEmergency(uint256 newRateBps) external',
] as const;

// ---------------------------------------------------------------------------
// PVTv7 ABI — HISTORICAL WS5 court-fix cascade (2026-06-25), superseded by v8.
//
// ProvianPVTv7 is byte-for-byte ProvianPVTv6 TOKEN LOGIC (the only source delta
// is the contract name + VERSION="v7"); v7 exists solely so the audit WS5-fixed
// ProvianCourtV2 / ProvianPoolV3 could be wired into a fresh interlocked stack
// (the live v6 stack's one-time setCourtContract setters were already locked to
// the OLD vulnerable court). The token ABI is therefore IDENTICAL to PVT_V6_ABI;
// PVT_V7_ABI is a labelled alias so the relay reads `v7` consistently. At the v7
// cutover the relay points PVT/GOVERNANCE/BOND/ESCROW/PROMISE/POOL/COURT
// *_CONTRACT_ADDRESS at the new v7 bundle and uses this ABI. The reused
// ProvianConstitutionExecutor + PEAnchor addresses are unchanged.
// ---------------------------------------------------------------------------
export const PVT_V7_ABI = PVT_V6_ABI;

// ---------------------------------------------------------------------------
// PVTv8 ABI — the live minting ABI as of the v8 EOA-admin cascade (2026-06-26).
//
// ProvianPVTv8 is byte-for-byte ProvianPVTv7 (== PVTv6) TOKEN LOGIC; the only
// source delta is the contract name + VERSION="v8". v8 exists for two
// stack-level reasons folded into one fresh interlocked cascade: (1) the
// governance-posture fix — admin/executor/guardian wired to Provian’s bootstrap wallet
// directly (no ConstitutionExecutor, no Foundation Safe in the control path);
// and (2) the Pass-2 WS1 bond-freeze fix shipped from birth (the new Court
// carries the on-chain bond-claim path and the new BondPool wires to it). The
// token ABI is therefore IDENTICAL to PVT_V7_ABI; PVT_V8_ABI is a labelled alias
// so the relay reads `v8` consistently. At the v8 cutover the relay points
// PVT/GOVERNANCE/BOND/ESCROW/PROMISE/POOL/COURT *_CONTRACT_ADDRESS at the new v8
// bundle and uses this ABI. The reused PEAnchor address is unchanged; the
// ConstitutionExecutor is NOT in the v8 control path.
// the bootstrap admin EOA is the sole direct bootstrap administrator/economic setter. The
// governance contract, ConstitutionExecutor, Foundation Safe, proposals, votes,
// and timelocks are dormant/non-gating for that authority. The ABI still exposes
// transferAdmin/renounceAdmin because bytecode inherited those functions, but
// Gate 1 authorizes no transfer, renunciation, handoff, interposition, or
// no-bypass regime. Human-resolving/Genesis mints use immutable 99/0.5/0.5;
// agent-side mints use the prospective Foundation rate and contributor residual,
// with any linked-beneficiary route snapshotted off-chain.
// ---------------------------------------------------------------------------
export const PVT_V8_ABI = PVT_V7_ABI;

// Executor ABI (PVTv5–v7) — the generalized governance executor that WAS the
// sole on-chain mutation path for every governable economic value on PVTv5/v6/v7.
// As of the PVTv8 EOA-admin cascade (2026-06-26) it is NOT in the control path:
// economic levers are EOA-direct (admin == executor == founder EOA). The executor
// contract still exists on-chain; this ABI is retained for legacy reads only
// (the executor is token-agnostic).
export const CONSTITUTION_EXECUTOR_ABI = [
  'function isMember(address) view returns (bool)',
  'function currentMemberCount() view returns (uint256)',
  'function membershipMode() view returns (uint8)',
  'function decentralized() view returns (bool)',
  'function verifier() view returns (address)',
  'function supermajorityBps() view returns (uint256)',
  'function votingDuration() view returns (uint256)',
  'function timelockDelay() view returns (uint256)',
  'function proposalCount() view returns (uint256)',
  'function propose(address[] targets, bytes[] calldatas, string description) external returns (uint256)',
  'function castVote(uint256 proposalId, bool support) external',
  'function finalize(uint256 proposalId) external',
  'function execute(uint256 proposalId) external',
  'function cancel(uint256 proposalId) external',
  'function getActions(uint256 proposalId) view returns (address[], bytes[])',
  'event ProposalCreated(uint256 indexed proposalId, address indexed proposer, uint256 actionCount, uint256 votingEnd, uint256 eta, string description)',
  'event VoteCast(uint256 indexed proposalId, address indexed voter, bool support)',
  'event ProposalFinalized(uint256 indexed proposalId, uint8 status, uint256 votesFor, uint256 denominator)',
  'event ProposalExecuted(uint256 indexed proposalId)',
  'event GraduatedToDecentralized(address indexed verifier, uint256 activeHumans)',
] as const;

export const GOVERNANCE_ABI = [
  'function proposalCount() view returns (uint256)',
  'function preMintMode() view returns (bool)',
  'function minProposalBalance() view returns (uint256)',
  'function trailingMintAverage() view returns (uint256)',
  'function getVotingWeight(address voter) view returns (uint256)',
  'function getProposal(uint256 proposalId) view returns (address proposer, address target, bytes callData, string description, uint256 votesFor, uint256 votesAgainst, uint256 votingEnd, uint256 executionStart, uint256 executionEnd, uint8 status, uint256 createdAt)',
  'function hasVoted(uint256 proposalId, address voter) view returns (bool)',
  'function createProposal(address target, bytes callData, string description) external returns (uint256)',
  'function castVote(uint256 proposalId, bool support) external',
  'function executeProposal(uint256 proposalId) external',
  'function withdrawProposal(uint256 proposalId) external',
  'function adminCancelProposal(uint256 proposalId, string reason) external',
  'function setAdminCancelEnabled(bool enabled) external',
  'function adminCancelEnabled() view returns (bool)',
  'function setPreMintWeights(address[] voters, uint256[] weights) external',
  'function exitPreMintMode() external',
  'function updateTrailingAverage(uint256 newAverage) external',
  'event ProposalCreated(uint256 indexed proposalId, address indexed proposer, address indexed target, string description, uint256 votingEnd)',
  'event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight)',
  'event ProposalExecuted(uint256 indexed proposalId)',
  'event ProposalCancelled(uint256 indexed proposalId, address indexed cancelledBy, string reason)',
  'event AdminCancelDisabled()',
] as const;

export const PE_ANCHOR_ABI = [
  'function batches(bytes32) view returns (bytes32 merkleRoot, uint256 peCount, uint256 timestamp, uint256 epochNumber, bool exists)',
  'function anchorBatch(bytes32 batchId, bytes32 merkleRoot, uint256 peCount, uint256 timestamp, uint256 epochNumber) external',
  'function verifyPE(bytes32 batchId, bytes32 peHash, bytes32[] merkleProof) view returns (bool)',
  'function getBatch(bytes32 batchId) view returns (bytes32 merkleRoot, uint256 peCount, uint256 timestamp, uint256 epochNumber, bool exists)',
  'function setMinter(address newMinter) external',
  'event BatchAnchored(bytes32 indexed batchId, bytes32 indexed merkleRoot, uint256 peCount, uint256 timestamp, uint256 epochNumber)',
] as const;

export const BOND_POOL_ABI = [
  'function bonds(address) view returns (uint256 amount, uint8 autonomyLevel, uint256 createdAt, uint256 lastRenewalAt, uint256 renewalDeadline, uint8 status, uint256 pendingClaims)',
  'function claims(bytes32) view returns (address claimant, address agent, uint256 filingFee, uint8 status, uint256 filedAt)',
  'function postBond(uint8 autonomyLevel, uint256 trustDiscountBps) external',
  'function renewBond() external',
  'function topUpBond(uint256 amount) external',
  'function withdrawBond() external',
  'function fileClaim(address agent, bytes32 claimId) external',
  'function slashBond(address agent, uint256 slashAmount, bytes32 claimId) external',
  'function dismissClaim(address agent, bytes32 claimId) external',
  'function expireStaleClaim(bytes32 claimId) external',
  'function processAbandonment(address agent) external',
  'function getRequiredBond(uint8 autonomyLevel, uint256 trustDiscountBps) view returns (uint256)',
  'function isBondHealthy(address agent) view returns (bool)',
  'event BondPosted(address indexed agent, uint256 totalDeposit, uint256 lockedAmount, uint8 autonomyLevel)',
  'event BondRenewed(address indexed agent, uint256 newDeadline)',
  'event BondToppedUp(address indexed agent, uint256 amount, uint256 newBondAmount)',
  'event BondSlashed(address indexed agent, bytes32 indexed claimId, address indexed claimant, uint256 claimantAmount, uint256 burnedAmount)',
  'event BondWithdrawn(address indexed agent, uint256 returnedAmount)',
  'event ClaimFiled(bytes32 indexed claimId, address indexed claimant, address indexed agent)',
  'event ClaimDismissed(bytes32 indexed claimId, address indexed agent)',
  'event ClaimExpired(bytes32 indexed claimId, address indexed agent)',
  'event BondAbandoned(address indexed agent, uint256 burnedAmount)',
  'event AutonomyDowngrade(address indexed agent, uint256 remainingBond, uint256 requiredBond)',
] as const;

// ---------------------------------------------------------------------------
// PVT Mint Batch
// ---------------------------------------------------------------------------

export interface PVTMintBatchDocument {
  batch_id: string;
  merkle_root: string;
  pe_count: number;
  epoch: number;
  /**
   * Projected aggregate (off-chain estimate). The on-chain BatchMinted event
   * is the authoritative source - see authoritative_* fields below.
   */
  total_pvt_minted: string;           // BigInt as string (18 decimals)
  contributor_total: string;
  provian_share: string;
  foundation_share: string;
  /** Exact count/addresses survive receipt-only crash recovery. Per-recipient
   * projected amounts are present on the uninterrupted happy path only. */
  contributor_count?: number;
  contributor_addresses?: string[];
  contributors?: { address: string; pvt_minted: string; is_human: boolean }[];
  tx_hash: string;
  anchor_tx_hash: string;
  pe_ids: string[];
  effective_mint_rate?: string;       // epoch armed mint rate (parity minting)
  created_at: number;
  /** Durable post-mint Foundation accounting outbox, exact-once by batch_id. */
  foundation_income_status?: 'pending' | 'complete';
  /** Durable, canonical-source-bound projection of first-mint agent badges. */
  agent_badge_projection_status?: 'pending' | 'complete';
  agent_badge_projection_schema?: 'pvt-minter-badge-projection/v1';
  agent_badge_projection_commitment?: string;
  agent_badge_projection_source_pe_id?: string;
  agent_badge_projection_source_pe_hash?: string;
  agent_badge_projection_completed_at_ms?: number;
  agent_badge_projection_completion_schema?: 'pvt-minter-badge-projection-completion/v1';
  agent_badge_projection_completion_commitment?: string;
  agent_badge_projection_completion_source_pe_id?: string;
  agent_badge_projection_completion_source_pe_hash?: string;
  agent_badge_projection_completion_receipts?: Array<{
    address: string;
    pvt_minted: string;
    is_human: boolean;
    disposition: 'zero_mint' | 'human' | 'agent_badge';
    wallet_id: string | null;
    agent_id: string | null;
    outbox_id: string | null;
    qualification_pe_id: string | null;
    qualification_pe_hash: string | null;
    badge_pe_id: string | null;
    badge_pe_hash: string | null;
  }>;

  /**
   * Reconciliation state derived from the on-chain BatchMinted event.
   * `projected` - only off-chain projection values present.
   * `event_reconciled` - BatchMinted parsed and authoritative_* fields set.
   * `reconciliation_failed` - receipt parsed but BatchMinted log was missing or unreadable.
   */
  reconciliation_status?: 'projected' | 'event_reconciled' | 'reconciliation_failed';
  authoritative_total_pvt_minted?: string;       // from BatchMinted.totalMinted
  authoritative_contributor_total?: string;      // from BatchMinted.contributorTotal
  authoritative_provian_share?: string;          // from BatchMinted.provianShare
  authoritative_foundation_share?: string;       // from BatchMinted.foundationShare
  authoritative_human_share_portion?: string;    // V4-only: BatchMinted.humanSharePortion
  authoritative_agent_share_portion?: string;    // V4-only: BatchMinted.agentSharePortion
  authoritative_effective_mint_rate?: string;    // BatchMinted.effectiveMintRate
  authoritative_epoch?: string;                  // BatchMinted.epoch
  authoritative_merkle_root?: string;            // BatchMinted.merkleRoot
  reconciliation_error?: string;                 // populated when reconciliation_failed
}

// ---------------------------------------------------------------------------
// PVT Mint Batch Snapshot (immutable reconstruction input)
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot persisted BEFORE the on-chain mintFromPEs call.
 *
 * Recovery rule: this snapshot is NOT proof that mint happened. It is only
 * the exact input set used at mint-call time, so an unanchored batch can be
 * deterministically re-anchored after the fact. The on-chain BatchMinted
 * event is the sole truth that mint occurred.
 *
 * Recovery code MUST refuse if snapshot is missing or merkleRoot/batchId
 * cannot be reproduced from snapshot inputs.
 */
export interface PVTMintBatchSnapshotDocument {
  batch_id: string;
  chain_id: number;
  pvt_contract_address: string;
  pe_anchor_contract_address: string;
  merkle_root: string;

  /**
   * PE IDs sorted lexicographically - same ordering rule used by
   * computeDeterministicBatchId. Storing the sort here removes any ambiguity
   * during reconstruction.
   */
  sorted_pe_ids: string[];

  /**
   * Exact leaf payloads passed to merkle.hashLeaf() at mint-call time.
   * basePoints stored as decimal string (BigInt 18d).
   */
  leaves: Array<{
    peId: string;
    walletAddress: string;
    actionType: string;
    timestamp: number;
    basePoints: string;
  }>;

  /** Aggregated mint inputs (parallel arrays - same order as on-chain call). */
  contributor_addresses: string[];
  pe_points: string[];                  // BigInt strings, parallel to contributor_addresses
  pe_action_types: string[];            // bytes32 hashes (keccak256 of action type strings)
  /** Immutable pre-submission first-mint badge projection authority. The
   * commitment is duplicated into the fenced mint claim. */
  agent_badge_projection_input_schema?: 'pvt-minter-badge-projection-input/v1';
  agent_badge_projection_input_commitment?: string;
  agent_badge_projection_contributors?: Array<{
    address: string;
    pvt_minted: string;
    is_human: boolean;
  }>;
  epoch: number;
  /** Idempotent weekly Genesis pacing reservation, when this batch contains Genesis. */
  genesis_settlement_reservation_id?: string;
  /** Atomic worker claim and fencing ownership for new single-batch snapshots. */
  mint_claim_id?: string;
  lease_owner_id?: string;
  fencing_token?: number;
  combined_capacity_reserved_atomic?: string;
  /** Operator-bound quorum-two, exact-block state used for cap admission. */
  economic_state_snapshot_hash?: string;
  economic_state_block_number?: number;
  economic_state_block_hash?: string;
  economic_state_agreed_head_number?: number;
  economic_state_agreed_head_hash?: string;
  economic_state_confirmation_depth?: number;
  economic_state_operator_ids?: [string, string];
  economic_factor_fingerprint?: string;
  authorization_economic_state_snapshot_hash?: string;
  /** Exact calldata binding for crash-safe pre-broadcast mint recovery. */
  mint_broadcast_protocol?: 'persist-prepared-before-broadcast/v1';
  mint_payload_hash?: string;
  /** Exact canonical anchorBatch calldata commitment frozen with the claim. */
  anchor_payload_hash?: string;

  /** Anchor call args - pe_count, timestamp, epoch needed for retry. */
  anchor_args: {
    batchId: string;
    merkleRoot: string;
    peCount: number;
    timestamp: number;
    epochNumber: number;
  };

  created_at: number;

  /**
   * Lifecycle:
   *   pending      - snapshot persisted; mintFromPEs not yet attempted.
   *   minted       - mintFromPEs receipt observed; mint_tx_hash set.
   *   anchored     - anchorBatch receipt observed; anchor_tx_hash set.
   *   abandoned    - pre-mint failure; snapshot retained for audit only.
   */
  status: 'pending' | 'minted' | 'anchored' | 'abandoned';
  mint_tx_hash?: string;
  mint_raw_transaction?: string;
  mint_nonce?: number;
  anchor_tx_hash?: string;
  anchor_raw_transaction?: string;
  anchor_nonce?: number;
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

/**
 * Union of stored AND computed governance-proposal statuses.
 *
 * Stored values (written by the governance writer + admin-weights route):
 *   active, executed, executed_pending_review, cancelled, vetoed.
 *
 * Computed-only values (emitted by
 * provian-backend/src/core/governance/effective-status.ts at read time;
 * never persisted to Firestore):
 *   passed, failed, executable, expired, withdrawn.
 *
 * See SPRINT_FINDINGS.md 2026-04-23 for the finding context: the writer
 * leaves `status: 'active'` on any proposal that passes voting without
 * execution, fails quorum, or misses its execution window. The effective-
 * status computer fixes this on the read path.
 */
export type GovernanceProposalStatus =
  | 'active'
  | 'passed'
  | 'failed'
  | 'executable'
  | 'executed'
  | 'executed_pending_review'
  | 'cancelled'
  | 'withdrawn'
  | 'expired'
  | 'vetoed';

export interface GovernanceProposalDocument {
  proposal_id: number;
  proposer_wallet_id: string;
  proposer_address: string;
  target: string;
  action: string;                     // Human-readable action (e.g., 'updateMintRate')
  parameters: Record<string, unknown>;
  description: string;
  call_data: string;                  // Hex-encoded callData
  votes_for: string;                  // BigInt as string
  votes_against: string;
  voting_end: number;                 // Unix ms
  execution_start: number;
  execution_end: number;
  status: GovernanceProposalStatus;
  tx_hash?: string;
  execute_tx_hash?: string;
  pe_ids: string[];
  created_at: number;
  updated_at: number;
  foundation_review_required?: boolean;
  foundation_review_status?: 'pending' | 'approved' | 'vetoed';
  foundation_review_at?: number;
  foundation_review_reason?: string;
}

export interface GovernanceVoteDocument {
  proposal_id: number;
  voter_wallet_id: string;
  voter_address: string;
  support: boolean;
  weight: string;                     // BigInt as string
  tx_hash: string;
  pe_id: string;
  voted_at: number;
}

// ---------------------------------------------------------------------------
// PVT Milestones
// ---------------------------------------------------------------------------

export interface PVTMilestonesDocument {
  agent_wallets: { current: number; target: number };
  completed_escrows: { current: number; target: number };
  settled_promises: { current: number; target: number };
  pool_executions: { current: number; target: number };
  court_verdicts: { current: number; target: number };
  unique_pe_action_types: { current: number; target: number };
  governance_votes: { current: number; target: number };
  // Informational only - minting is not gated on milestone completion.
  mint_ready: boolean;
  minting_active: boolean;
  last_updated: number;
}

// ---------------------------------------------------------------------------
// Agent Directory
// ---------------------------------------------------------------------------

export interface AgentDirectoryDocument {
  wallet_id: string;
  agent_id: string;
  display_name: string;
  address: string;
  capabilities: string[];
  description: string;
  availability: 'available' | 'busy' | 'offline';
  /**
   * Hourly rate in PVT atomic units (BigInt-as-string, 18 decimals).
   * Workstream 3: PVT is the canonical agent-economy unit. When both
   * hourly_rate_pvt and hourly_rate_usdc are set, PVT is the primary
   * rate and USDC is a fallback for clients that can't pay PVT.
   * Discovery responses list PVT first.
   */
  hourly_rate_pvt?: string;
  /** Hourly rate in USD float. Optional fallback when PVT isn't acceptable. */
  hourly_rate_usdc?: number;
  preferred_chains: string[];
  /**
   * Live visible-PE count (sourced from pe_history via
   * countVisibleAgentPEs, never a stored per-wallet tally). Display only.
   */
  pe_count: number;
  created_at: number;
  updated_at: number;
}

export interface RegisterCapabilitiesRequest {
  capabilities: string[];
  description: string;
  availability: 'available' | 'busy' | 'offline';
  /** PVT atomic units (BigInt-as-string, 18 decimals). No numeric cap - BigInt is arbitrary precision and market handles typos. */
  hourly_rate_pvt?: string;
  hourly_rate_usdc?: number;
  preferred_chains?: string[];
}

// ---------------------------------------------------------------------------
// Job Board
// ---------------------------------------------------------------------------

/**
 * linked-job settlement: 'completed' and 'refunded' are ECONOMIC terminals written ONLY by the
 * receipt-gated settlement path (job-settlement.ts, behind
 * `evaluateInstitutionTransition`): 'completed' = the linked escrow released to
 * the worker on-chain; 'refunded' = the disputed escrow resolved by refunding
 * the poster (the worker was NOT paid). Everything else is a record-only draft.
 */
export type JobStatus = 'open' | 'assigned' | 'delivered' | 'completed' | 'cancelled' | 'refunded';

export interface JobApplication {
  wallet_id: string;
  agent_id: string;
  address: string;
  proposal: string;
  applied_at: number;
}

export interface JobDocument {
  job_id: string;
  poster_wallet_id: string;
  poster_address: string;
  title: string;
  description: string;
  required_capabilities: string[];
  /**
   * Currency. Immutable. The auto-escrow created by acceptApplicant() inherits
   * this currency, so the entire job → application → escrow → release path
   * is single-currency end-to-end.
   */
  currency: Currency;
  budget_usdc: number;            // populated when currency === 'usdc'
  budget_pvt?: string;           // populated when currency === 'pvt' (BigInt-as-string)
  /**
   * Chain. Immutable. The auto-escrow created by acceptApplicant() inherits
   * this chain so the job → escrow path stays single-chain end-to-end.
   * Pre-Chunk-K records lacking this field are read as 'base' for back-compat.
   */
  chain: string;
  deadline_hours: number;
  deadline: number;
  status: JobStatus;
  applications: JobApplication[];
  assigned_wallet_id?: string;
  assigned_address?: string;
  escrow_id?: string;
  delivered_at?: number;
  completed_at?: number;
  // --- linked-job settlement settlement truth (written only by job-settlement.ts) ---
  /** Set when the job terminated 'refunded' (dispute resolution refunded the poster). */
  refunded_at?: number;
  /** The on-chain settlement tx (lowercased 64-hex) that drove the terminal transition. */
  settlement_tx_hash?: string;
  /**
   * Every tx hash that has driven an economic transition for this job — the
   * `priorEconomicTxHashes` ledger consumed by `evaluateInstitutionTransition`
   * so a settlement retry is idempotent (no second economic PE).
   */
  settlement_tx_hashes?: string[];
  /** job_completed / job_refunded PE ids emitted by the settlement winner. */
  settlement_pe_ids?: string[];
  /** Single-winner claim for settlement-PE emission (mirrors completion_pe_claimed). */
  settlement_pe_claimed?: boolean;
  /** Mirror of the linked escrow's dispute (a record fact, not a job status). */
  escrow_disputed_at?: number;
  pe_ids: string[];
  created_at: number;
  updated_at: number;
  /** what was delivered (URI and/or body; sha256 sealed on the delivery PE). */
  deliverable?: { uri: string | null; body: string | null; sha256: string; delivered_at: number };
}

export interface PostJobRequest {
  title: string;
  description: string;
  required_capabilities: string[];
  currency?: Currency;
  budget_usdc?: number;
  budget_pvt?: string;
  /**
   * Chain. Defaults to 'base' for back-compat when omitted.
   * Validated against SUPPORTED_AGENT_BANK_CHAINS.
   */
  chain?: string;
  deadline_hours: number;
}

export interface ApplyToJobRequest {
  /** Legacy one-shot plaintext proposal (max 1000). Optional since. */
  proposal?: string;
  /** the application's first thread message — E2E ciphertexts keyed by party id + content_sha256. */
  message?: { ciphertexts?: unknown; content_sha256?: unknown } | null;
}

// ---------------------------------------------------------------------------
// Webhook Subscriptions
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | 'escrow_created' | 'escrow_funded' | 'escrow_completed' | 'escrow_disputed' | 'escrow_resolved'
  | 'promise_funded' | 'promise_settled' | 'promise_defaulted' | 'promise_cancelled'
  | 'pool_contributed' | 'pool_executed' | 'pool_refunded'
  | 'job_posted' | 'job_applied' | 'job_accepted' | 'job_delivered'
  | 'badge_earned' | 'court_verdict'
  | 'bond_posted' | 'bond_renewed' | 'bond_topped_up' | 'bond_slashed' | 'bond_withdrawn'
  | 'bond_claim_filed' | 'bond_claim_resolved'
  // (insurance_claim_filed/resolved retired from the subscribable set: the relay
  // emits bond_claim_* only. The insurance_claim_* strings survive solely as
  // legacy PE-action-type aliases in the frozen policy matrix, never as events.)
  // PVT from a settled batch landed on-chain for a recipient. The one
  // system-originated (not agent-acted) event; delivered notify-only so it never
  // bumps the recipient's pe_count / economic-activity counters.
  | 'settlement_completed'
  // Phase 4: a previously-unpriced action type went live on the served,
  // digest-matched matrix. Underscore form matches this union's convention and the
  // push data.type; the plan's "action_type.activated" dot spelling is the same event.
  | 'action_type_activated'
  // a thread message landed for this wallet (thread_id/message_id/kind/content hash in
  // `data`; never the content — it is E2E ciphertext the relay cannot read).
  | 'thread_message'
  // someone replied to this wallet's forum post or comment (post_id = the tree root,
  // comment_id = the new reply, channel in `data`; never the content).
  | 'forum_reply'
  // the linked human ended this agent's beneficiary link (alone, under wallet
  // auth). Notify-only; `data.ended_by` = 'linked_human', `data.unlink_pe_id`. Future PEs route
  // unlinked; sealed snapshots are untouched.
  | 'beneficiary_link_ended'
  // a step on a Commons hire this wallet is party to (the counterparty acted). Notify-only;
  // `data.job_id` + `data.step`. People hear the same steps by push.
  | 'commons_job_applied' | 'commons_job_hired' | 'commons_job_funded' | 'commons_job_delivered'
  | 'commons_job_released' | 'commons_job_disputed' | 'commons_job_dispute_settled' | 'commons_job_hire_lapsed';

export interface WebhookSubscriptionDocument {
  subscription_id: string;
  wallet_id: string;
  url: string;
  events: WebhookEventType[];
  secret: string;
  is_active: boolean;
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
}

export interface CreateWebhookRequest {
  url: string;
  events: WebhookEventType[];
}

// ---------------------------------------------------------------------------
// PE Type Proposals
// ---------------------------------------------------------------------------

export type PEProposalStatus = 'open' | 'accepted' | 'rejected';

export interface PETypeProposalDocument {
  proposal_id: string;
  proposer_wallet_id: string;
  proposer_agent_id: string;
  type_name: string;
  description: string;
  use_case: string;
  status: PEProposalStatus;
  upvotes: number;
  voters: string[];
  pe_ids: string[];
  created_at: number;
  updated_at: number;
}

export interface ProposePETypeRequest {
  type_name: string;
  description: string;
  use_case: string;
  /** Optional - suggested category (e.g., 'financial', 'compute', 'governance'). */
  suggested_category?: string;
  /** Optional - suggested impact tier (0-5). */
  suggested_tier?: number;
}

// ---------------------------------------------------------------------------
// Insurance Bonds (Phase 5)
// ---------------------------------------------------------------------------

export type BondStatus = 'active' | 'expired' | 'withdrawn' | 'abandoned';
// 'expired' is the terminal state for a claim closed by the permissionless
// on-chain expireStaleClaim() timeout (ClaimExpired) — a liveness backstop, NOT
// a Court verdict. It is distinct from 'dismissed' (a Court panel verdict via
// dismissClaim/ClaimDismissed): both burn the filing fee and apply no slash, but
// 'expired' records that no panel ever adjudicated within CLAIM_RESOLUTION_TIMEOUT.
export type BondClaimStatus = 'filed' | 'upheld' | 'dismissed' | 'expired';

/** Terminal Court verdict on a bond claim (drives fee/slash routing). */
export type BondClaimVerdict = 'upheld' | 'dismissed';

/**
 * Slash basis for an UPHELD bond claim — the settlement input that distinguishes
 * a FULL slash (Court resolution `upheld`) from a PARTIAL slash (Court resolution
 * `partial`). Carried losslessly on the claim + the bond_claim_resolved PE so the
 * (future) on-chain settlement can re-derive the correct `slashBond` amount
 * WITHOUT a second cross-collection read of the linked dispute. Only meaningful
 * when the claim status is `upheld`.
 *
 * IMPORTANT: this records the CATEGORY only. The numeric fraction a `partial`
 * slash maps to is undefined anywhere in the protocol today — see the [DESIGN]
 * partial-slash-fraction item nested under the WS1 bond-freeze block in
 * OPEN_ITEMS.md. Do NOT invent a fraction here; settlement resolves it when the
 * BondPool redeploy lands.
 */
export type BondSlashBasis = 'full' | 'partial';

/**
 * Off-chain record of how the filing fee was routed at resolution. Mirrors the
 * on-chain BondPool: upheld returns the fee to the claimant (alongside the
 * slash payout), dismissed burns it as a frivolous-claim deterrent.
 */
export type BondClaimFeeOutcome = 'returned_to_claimant' | 'burned';

export interface BondDocument {
  bond_id: string;
  agent_wallet_id: string;
  agent_address: string;
  autonomy_level: 2 | 3;
  amount_pvt: string;           // BigInt as string (18 decimals)
  total_deposited_pvt: string;  // Original deposit before fees/burns
  trust_discount_bps: number;
  status: BondStatus;
  chain: string;
  post_tx_hash: string;
  post_block_number: number | null;
  renewal_deadline: number;     // Unix ms
  last_renewal_at: number;
  pending_claims: number;
  pe_ids: string[];
  created_at: number;
  updated_at: number;
  /**
   * bond lifecycle: exact on-chain locked collateral (atomic PVT, BigInt as string),
   * recorded from the BondToppedUp event's newBondAmount. Present only after a
   * verified top-up; `amount_pvt` stays the whole-PVT requirement snapshot at
   * post time (the slash-derivation input), never rewritten by top-ups.
   */
  collateral_atomic?: string;
  /** bond lifecycle: unix ms of the last verified top-up. */
  last_topup_at?: number;
}

export interface BondClaimDocument {
  claim_id: string;
  bond_id: string;
  claimant_wallet_id: string;
  claimant_address: string;
  respondent_wallet_id: string;
  respondent_address: string;
  description: string;
  evidence_pe_ids: string[];
  filing_fee_pvt: string;       // BigInt as string (18 decimals)
  status: BondClaimStatus;
  chain: string;
  filing_tx_hash: string;
  filing_block_number: number | null;
  /**
   * On-chain bytes32 claimId recovered from the ClaimFiled event (lowercased,
   * 0x-prefixed). The backend claim is bound 1:1 to this value; replays of the
   * same on-chain filing are rejected at submission. Optional only for legacy
   * docs minted before the binding fix.
   */
  onchain_claim_id?: string;
  /** The Court general dispute this claim was escalated to, if any. */
  general_dispute_id?: string;
  resolution_summary?: string;
  resolution_tx_hash?: string;
  resolved_at?: number;
  /** The general dispute whose Court verdict drove resolution, if any. */
  resolved_by_dispute_id?: string;
  /** Filing-fee routing recorded at resolution (returned vs burned). */
  fee_outcome?: BondClaimFeeOutcome;
  /**
   * Slash basis for an upheld claim: 'full' (Court `upheld`) vs 'partial' (Court
   * `partial`). Settlement input that survives the upheld/partial fee-collapse so
   * the on-chain slash amount is re-derivable from this record alone. Absent for
   * dismissed claims (no slash). See [[BondSlashBasis]].
   */
  slash_basis?: BondSlashBasis;
  /**
   * Concrete slash magnitude in whole PVT (matches the on-chain locked
   * collateral scale), persisted at resolution for an UPHELD claim:
   *   - 'full'    → the entire bond (bond.amount_pvt)
   *   - 'partial' → BOND_MIN_SLASH_PAYOUT_BPS (50%) of the bond
   * This is the exact amount the on-chain Court bridges to BondPool.slashBond, so
   * settlement is re-derivable from the claim record alone — no cross-collection
   * dispute read. Absent for dismissed claims (no slash). WS1 (Pass-2).
   */
  slash_amount_pvt?: string;
  /**
   * On-chain settlement status of the verdict. 'pending' once the off-chain
   * claim is resolved but the on-chain slash/dismiss has not yet been verified
   * (the slash itself is driven by on-chain panel votes on the redeployed
   * Court→BondPool bridge, never by the backend). 'confirmed' once a verified
   * on-chain BondSlashed/ClaimDismissed tx is recorded against this claim.
   *
   * agent directory: the receipt-gated resolveBondClaim bridge writes ONLY 'confirmed' * a claim can no longer leave 'filed' without a verified Base-final
   * settlement receipt, so new resolutions never record 'pending'. The value
   * survives on the type for legacy docs resolved before the gate.
   */
  onchain_settlement?: 'pending' | 'confirmed';
  /**
   * agent directory: the actual on-chain slash payout to the claimant, recovered from the
   * BondSlashed event (wei / atomic PVT, BigInt string). Chain truth for
   * separate party accounting; absent for dismissed claims.
   */
  slash_claimant_amount_wei?: string;
  /**
   * agent directory: the burned portion of the on-chain slash, recovered from the
   * BondSlashed event (wei / atomic PVT, BigInt string). Absent for dismissed.
   */
  slash_burned_amount_wei?: string;
  /**
   * agent directory: the Court panel's FINDING on this claim, recorded when a general
   * dispute's Firestore panel majority lands. RECORD-ONLY: a finding never
   * flips the claim's status and never decrements pending_claims — the
   * filed→upheld|dismissed transition is economic and fires only through the
   * receipt-gated resolveBondClaim bridge on a verified Base-final
   * BondSlashed/ClaimDismissed receipt. The finding preserves the panel's
   * verdict + slash-magnitude category (full vs partial) so the on-chain
   * settlement can be reconciled against what the panel actually decided.
   */
  court_finding?: {
    verdict: GeneralDisputeResolution;
    slash_basis: BondSlashBasis | null;
    dispute_id: string;
    found_at: number;
  };
  pe_ids: string[];
  created_at: number;
  updated_at: number;
}

export interface BondRenewalDocument {
  renewal_id: string;
  bond_id: string;
  agent_wallet_id: string;
  tx_hash: string;
  block_number: number | null;
  new_deadline: number;         // Unix ms
  pe_id: string;
  renewed_at: number;
}

export interface PostBondRequest {
  autonomy_level: 2 | 3;
  tx_hash: string;
  chain: string;
}

export interface RenewBondRequest {
  bond_id: string;
  tx_hash: string;
}

export interface WithdrawBondRequest {
  bond_id: string;
  tx_hash: string;
}

/** bond lifecycle: shortfall-restore top-up (ProvianBondPool.topUpBond receipt). */
export interface TopUpBondRequest {
  bond_id: string;
  tx_hash: string;
}

export interface FileClaimRequest {
  respondent_wallet_id: string;
  description: string;
  evidence_pe_ids: string[];
  tx_hash: string;
  chain: string;
}

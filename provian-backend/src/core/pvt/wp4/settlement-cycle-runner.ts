import { Transaction } from 'ethers';
import { parseNonceJournal } from '../../onchain/canonical-nonce';
import { withPrivateReadSession } from '../../provenance/private-store';
/**
 * settlement runtime — the multi-transaction settlement cycle (plan §settlement runtime items 1–6; weekly at merge, daily since).
 *
 * Composes the merged planning layer (`epoch-orchestration`, `batch-bounds`,
 * `claim-identity`, wp-ev `settlement-batch`) with the durable state in
 * `durable-settlement-store.ts` and an INJECTED chain adapter. One call =
 * one cycle attempt: pagination to backlog exhaustion or a configured
 * operating stop, serial batch submission (the kernel's single
 * `nextFinalizedCursor` makes the lanes non-concurrent by construction),
 * receipt/replacement reconciliation, and same-cycle crash continuation.
 *
 * AUTHORITY BOUNDARY — this module is NOT mounted on any route or scheduler
 * and configures no signer. The chain adapter and every operating parameter
 * are caller-supplied; activation owns deployment, configuration, arming, and
 * activation, and the kernel (undeployed) remains the only mint authority.
 * Nothing here can create supply beyond what a deployed, armed kernel would
 * itself enforce (epoch caps, claim dedupe, cursor discipline).
 *
 * Replacement invariant : every attempt for a reservation
 * shares ONE nonce until a MINED-FAILED receipt proves that nonce consumed
 * (`durable-settlement-store.recordAttempt` enforces the rule
 * transactionally), so at most one transaction of the set can ever be
 * included — two live settlements for one reservation are structurally
 * impossible. The kernel's `CursorDiscontinuity` and `ClaimAlreadySettled`
 * are the second and third nets, pinned in `ProvianPVT9Wp4Settlement.t.sol`.
 *
 * Epoch advance is deliberately NOT this runner's job: `openNextEpoch()` is
 * permissionless and carries no modifier on the kernel, and a settlement
 * cycle binds to exactly one open epoch. When advance is due the runner
 * REFUSES (`epoch_advance_required`) rather than guessing; the operator (or
 * activation's scheduler design) advances between cycles.
 *
 * Operating limits: the plan names 100 transactions and 0.1 ETH as the
 * INITIAL cycle limits (§settlement runtime item 4). They are exported as named constants
 * for the caller to pass explicitly — operating parameters, not economics;
 * activation owns production values (the same convention as
 * `DEFAULT_BOUNDARY_SAFETY_MARGIN_SEC` in the merged layer).
 */

import { Interface } from 'ethers';
import { createHash } from 'crypto';
import {
  evaluateEpochGate,
  evaluateBatchResumption,
  type SettlementObservation,
  type PreparedBatchBinding,
} from './epoch-orchestration';
import {
  estimateGas,
  planSettlementBatches,
  type BatchGasModel,
  type BatchLimits,
  type SettlementWorkItem,
} from './batch-bounds';
import { verifyClaimIdentity, type ProposedClaim, type RecordedClaim } from './claim-identity';
import {
  assembleStandardBatch,
  assemblyPolicyForEpoch,
  BeneficiaryClass,
  type GenesisPEClaim,
  type GenesisRecipient,
  type StandardClaimEntry,
} from '../wp-ev/settlement-batch';
import {
  SETTLEMENT_BATCHES_COLLECTION,
  SETTLEMENT_BATCH_SCHEMA,
  SETTLEMENT_CYCLES_COLLECTION,
  acquireCycleLease,
  acquireSignerLease,
  allocateNonce,
  applyConfirmedBatch,
  auditLedgerSinceWatermark,
  claimKeyOf,
  clearMinedReceipt,
  clearStaleReservation,
  closeCycle,
  holdClaims,
  isClaimHeld,
  listAllUnresolvedBatches,
  listFinalitySweepCandidates,
  listUnresolvedBatches,
  markBatchDead,
  markBatchFinalityVerified,
  readLedgerPage,
  createLedgerPageSource,
  recordAttempt,
  recordMinedReceipt,
  releaseCycleLease,
  releaseSignerLease,
  releaseUnusedNonce,
  repairLedgerWritebacks,
  reserveBatch,
  revertReorgedBatch,
  settleClaimsFromChainEvidence,
  listHeldClaims,
  writeLedgerSettlement,
  type BatchAttempt,
  type BatchMemberRecord,
  type ClaimLedgerRow,
  type LedgerLane,
  type SettlementBatchDoc,
  type SettlementCycleDoc,
  type SettlementDb,
} from './durable-settlement-store';
import {
  approveBatchForSettlement,
  type ApprovalOutcome,
  type ApprovalRefusal,
  type BatchApprovalDeps,
} from './batch-approval';
import { finalizedThroughBlock } from '../institution-funding-watcher';
import type { StandardLaneAdmission } from './standard-lane-recon-gate';
// Type-only (erased at runtime, so the operator-runtime ↔ cycle-runner cycle stays value-free).
import type { SettlementLaneScope } from './operator-runtime';

// ---------------------------------------------------------------------------
// Plan-named initial operating limits (§settlement runtime item 4). Callers pass explicitly.
// ---------------------------------------------------------------------------

export const PLAN_INITIAL_CYCLE_MAX_TRANSACTIONS = 100;
/** 0.1 ETH in wei. */
export const PLAN_INITIAL_CYCLE_MAX_FEE_WEI = 100_000_000_000_000_000n;

/** Kernel calldata surface (mirrors `ProvianPVT9` struct order exactly). */
export const KERNEL_SETTLEMENT_ABI = [
  'function settleStandardPEBatch(bytes32 batchId, uint64 epoch, bytes32 expectedPolicyHash, uint256 finalizedCursorStart, uint256 finalizedCursorEnd, (address contributor, uint8 beneficiaryClass, uint256 claimCount)[] recipients, (bytes32 claimId, uint256 recordPointsAtomic)[] claims)',
  'function settleGenesisPEBatch(bytes32 batchId, uint64 epoch, bytes32 expectedPolicyHash, uint256 finalizedCursorStart, uint256 finalizedCursorEnd, (address contributor, uint256 claimCount)[] recipients, (bytes32 claimId, bytes32 walletId, bytes32 oneTimeAnchor, uint8 grantType, uint64 qualifiedAt, uint256 reservedGrossAtomic)[] claims)',
] as const;

const kernelInterface = new Interface(KERNEL_SETTLEMENT_ABI as unknown as string[]);

// ---------------------------------------------------------------------------
// Chain adapter (injected; implementations live with their callers)
// ---------------------------------------------------------------------------

export interface CycleChainObservation extends SettlementObservation {
  readonly chainId: bigint;
  readonly kernelAddress: string;
  /** From `getEpochPolicy(lastOpenedEpoch)` in the same snapshot. */
  readonly mintRateAtomic: bigint;
  readonly agentFoundationBps: bigint;
  readonly genesisCapAtomic: bigint;
  readonly combinedCapAtomic: bigint;
  /** `epochGenesisIssued(lastOpenedEpoch)` / `epochTotalIssued(lastOpenedEpoch)`. */
  readonly epochGenesisIssuedAtomic: bigint;
  readonly epochTotalIssuedAtomic: bigint;
}

export interface MinedReceipt {
  readonly status: 'success' | 'reverted';
  readonly blockNumber: number;
  /** the block the receipt is in; a receipt is a fact only while this is canonical. */
  readonly blockHash: string;
  readonly gasUsed: bigint;
  readonly effectiveGasPriceWei: bigint;
}

/** Canonical nonce read position: mined tip or an exact block height. */
export type NonceBlockTag = 'latest' | number;

/** the L1-batched safe head, as the watchers read it. */
export interface SafeHead {
  readonly number: number;
  readonly hash: string;
}

export interface SignableTransaction {
  readonly to: string;
  readonly data: string;
  readonly valueWei: bigint;
  readonly nonce: number;
  readonly gasLimit: bigint;
  readonly maxFeePerGasWei: bigint;
  readonly maxPriorityFeePerGasWei: bigint;
}

export interface SettlementChainAdapter {
  observe(): Promise<CycleChainObservation>;
  /** Omitted tag = `latest`, the only position read before. */
  getTransactionCount(address: string, blockTag?: NonceBlockTag): Promise<number>;
  feeData(): Promise<{ maxFeePerGasWei: bigint; maxPriorityFeePerGasWei: bigint }>;
  estimateGas(tx: { from: string; to: string; data: string }): Promise<bigint>;
  /** Dry run (eth_call). `ok:false` carries the revert reason when known. */
  simulate(tx: { from: string; to: string; data: string }): Promise<{ ok: boolean; revertReason: string | null }>;
  /**
   * Sign WITHOUT broadcasting; the hash is known before the wire send. Deterministic
   * (RFC 6979): the same fields sign to the same transaction, which is how a recorded attempt
   * is re-broadcast after a reorg without storing its raw bytes.
   */
  sign(tx: SignableTransaction): Promise<{ raw: string; hash: string }>;
  broadcast(raw: string): Promise<void>;
  getReceipt(txHash: string): Promise<MinedReceipt | null>;
  /** the quorum safe head (`readAgreedBaseSafeHead`). null = no safe block: never final. */
  readSafeHead(): Promise<SafeHead | null>;
  /** the quorum head height, for the 12-confirmation floor (`readAgreedBaseHead`). */
  readHead(): Promise<number>;
  /** the canonical block hash at a height (quorum), or null when unknown. */
  getBlockHash(blockNumber: number): Promise<string | null>;
  /**
   * the kernel's `claimSettled(claimId)` the chain's own answer to "is this paid".
   * `blockTag` (a height) reads it AT that block — the SAME block every other safe-depth
   * conclusion reads, so a lagging replica can never pair a stale "unpaid" with a fresh
   * "nonce consumed". Omitted = `latest`.
   */
  isClaimSettled(claimId: string, blockTag?: number): Promise<boolean>;
}

/**
 * the settlement finality ceiling IS the watchers' ceiling : a receipt is final
 * only at or below min(finalizedThroughBlock(head), safeHead.number), with the canonical hash
 * at that height equal to the receipt's and a re-read agreeing. `finalizedThroughBlock` is
 * imported from the funding watcher, never re-derived, so the two floors cannot drift apart.
 * Returns null (NOT final — wait) when there is no safe block or no final block at all.
 */
/**
 * the READ-ONLY slice of the adapter the finality and applied-batch verdicts use. No
 * signer, no broadcast: the stranded-batch probe (`scripts/pvt9-stranded-batch-probe.ts`) runs
 * the exact production verdicts against production through this and nothing else.
 */
export type SettlementFinalityReader = Pick<
  SettlementChainAdapter,
  'getReceipt' | 'readHead' | 'readSafeHead' | 'getBlockHash' | 'isClaimSettled'
>;

export function settlementFinalityCeiling(head: number, safeHead: SafeHead | null): number | null {
  if (safeHead === null || !Number.isSafeInteger(safeHead.number) || safeHead.number < 0) return null;
  const through = finalizedThroughBlock(head);
  if (through === null) return null;
  return Math.min(through, safeHead.number);
}

// ---------------------------------------------------------------------------
// Configuration + report
// ---------------------------------------------------------------------------

export interface CycleRunnerConfig {
  readonly cycleId: string;
  readonly workerId: string;
  readonly signerAddress: string;
  readonly leaseTtlMs: number;
  readonly boundarySafetyMarginSec: number;
  readonly limits: {
    readonly maxTransactions: number;
    readonly maxFeeWeiTotal: bigint;
  };
  readonly batchLimits: BatchLimits;
  readonly gasModel: BatchGasModel;
  /** Gas headroom over the estimate, in basis points (12_000 = 1.2x). */
  readonly gasHeadroomBps: number;
  /**
   * the max gasLimit this runner will let a RECORDED batch keep on
   * resume. A batch whose gasLimit exceeds this is one the RPC's
   * `eth_sendRawTransaction` rejects (Alchemy answers -32003 "gas limit too
   * high") and the resume/replacement path would otherwise replay
   * byte-identically forever — so `resolveBatch` RECLAIMS it (releases the
   * proven-unused nonce, marks it dead) and the runner re-plans its claims into
   * correctly-sized batches. Set ABOVE what the planner targets (so a
   * correctly-sized batch is never reclaimed) and BELOW the RPC's accept cap (so
   * a stranded oversized batch is). Optional: when unset, the reclaim is off and
   * a `broadcast_failed` batch is handled exactly as before (transient retry).
   */
  readonly broadcastableGasCeiling?: number;
  readonly receiptPollIntervalMs: number;
  /** Replace an unmined attempt after this long. */
  readonly replaceAfterMs: number;
  /** Fee bump per replacement, in basis points over the previous attempt. */
  readonly feeBumpBps: number;
  readonly maxReplacementsPerBatch: number;
  /** Hard wall-clock stop for one runSettlementCycle call. */
  readonly maxRunMs: number;
  readonly ledgerPageSize: number;
  /** In-memory selection budget per sweep, in claims (bounds reads + memory). */
  readonly selectionBudgetClaims: number;
  /**
   * Which lane this cycle SETTLES. 'genesis' settles Genesis only and
   * leaves standard rows untouched as durable backlog (NOT "refused" no
   * held-claim alarm); 'standard' the reverse; 'both' (default) settles both,
   * Genesis-first, exactly as before. Enabled Genesis-daily / standard-weekly (; both daily since)
   * against the one runner without a kernel change.
   */
  readonly laneScope?: SettlementLaneScope;
  /**
   * — an ON-DEMAND payout: settle only this payee's claims (lowercase contributor
   * address), standard lane only. Every other payee's rows stay untouched as durable backlog for
   * the weekly run; no one else's PVT moves. Unset: every payee (the scheduled runs).
   */
  readonly payee?: string;
  /**
   * Bounded retry for the pre-broadcast settle simulation. The kernel's `_verifyEligibility`
   * STATICCALL inside the simulate reads the same verifier approval the affirmation confirm
   * just wrote, so it can race the approve on a load-balanced RPC (stale `VerificationFailed`
   * at 'latest'), exactly like the affirmation confirm. Optional; defaults to 5 attempts / 1s.
   */
  readonly settleSimulate?: { readonly attempts: number; readonly delayMs: number };
  /**
   * — retries for a TRANSIENT approval refusal (`approval_call_failed` an RPC
   * or Firestore throw; `approval_not_affirmed` read lag after the approve). Neither says
   * anything about a claim, so neither is ever held against one: retried here, and if it
   * persists the run stops holding nothing. Defaults 3 × 2 s.
   */
  readonly approvalRetry?: { readonly attempts: number; readonly delayMs: number };
  /**
   * The top-of-loop cursor-reflection wait (WS1; made it drain-complete).
   * After a batch confirms, the durable cursor advances at the settle-mine; the
   * very next `nextFinalizedCursor()` read can land on a load-balanced RPC replica
   * one block behind and return the pre-advance value — read-your-writes lag on
   * our OWN just-confirmed settle. The loop WAITS for the chain to reflect that
   * advance and then CONTINUES draining in the SAME run; it never plans the next
   * batch until the chain cursor equals our durable cursor (and the kernel refuses
   * a discontinuous settle anyway — `CursorDiscontinuity`). Its OWN knob,
   * deliberately NOT the `settleSimulate` one — throughput must not be coupled to
   * the unrelated simulate-race tuning surface.
   *
   * `delayMs` is the poll interval (default 1s). `attempts` is an OPTIONAL hard
   * ceiling on the number of polls; when OMITTED (the production default) the wait
   * is bounded ONLY by the run's own `maxRunMs` deadline. That is the fix:
   * a weekly cron now drains the whole backlog in one run instead of stranding it
   * for 7 days the first time a lag spike exceeds a small fixed cap — the pre-fix
   * fixed 20-attempt (20s) cap did exactly that. Waiting longer settles NOTHING
   * (it only delays the next plan), so extending the bound cannot open a
   * double-mint window. Tests pass an explicit `attempts` to reach the
   * `awaiting_finality` bound-exhaustion terminal quickly.
   */
  readonly cursorReflect?: { readonly attempts?: number; readonly delayMs: number };
}

export type CycleStopReason =
  | 'backlog_exhausted'
  | 'standard_lane_refused'
  | 'transaction_limit'
  | 'fee_limit'
  | 'boundary_margin'
  | 'epoch_advance_required'
  | 'epoch_gate_closed'
  | 'epoch_cap_deferral'
  | 'claim_identity_violations'
  | 'batch_plan_rejected'
  | 'batch_unsettleable'
  | 'batch_approval_refused'
  | 'broadcast_failed'
  | 'replacement_budget_exhausted'
  | 'run_time_limit'
  | 'lease_refused'
  | 'resumption_abort'
  // WS1 — a terminal reached only when the chain never reflected the last durable
  // cursor advance within the cursor-reflect bound. The settles ARE canonical
  // (durable recorded them from real receipts) and the next run re-seeds from the
  // caught-up chain, so it never double-mints — but with the deadline bound
  // (production `attempts` unset) this now means the run spent its ENTIRE `maxRunMs`
  // budget waiting, i.e. a genuine multi-minute chain/RPC stall that left backlog.
  // That is NO LONGER benign: `settlementRunNeedsAlarm` pages on it, so a
  // stuck weekly cron can never strand backlog SILENTLY. Distinct from 'completed'
  // ON PURPOSE so a too-tight bound (a run stuck at one batch) stays visible.
  // also reached when a success receipt is still short of the safe-head depth at the
  // run deadline — the batch stays `mined` (unresolved) and the next run's reconciler applies it.
  | 'awaiting_finality'
  // a batch broadcast in an earlier run (any cycle) still holds a live nonce the
  // reconciler could not resolve this run. No new transaction is sent on the signer while one
  // is live: a second transaction at that nonce, or one queued behind a gap, is exactly the
  // nonce reuse this stop exists to prevent. The reconciler retries (replacement / cancel) on
  // the next run; the stop is loud.
  | 'stranded_batch_pending';

/** a claim the runner isolated and held this run, as the report carries it. */
export interface HeldClaimReport {
  readonly claimKey: string;
  readonly reason: string;
  readonly detail: string;
}

/** what the cross-cycle reconciler did before the cycle ran. */
export interface ReconciliationReport {
  /** Unresolved batches (in any cycle) the reconciler drove this run. */
  readonly adopted: number;
  readonly confirmed: number;
  readonly dead: number;
  /** Batches still unresolved after this run's reconciliation (they block new broadcasts). */
  readonly stillUnresolved: ReadonlyArray<{
    readonly batchId: string;
    readonly cycleId: string;
    readonly status: string;
    readonly detail: string;
  }>;
  /** Applied batches the finality sweep verified canonical at safe depth this run. */
  readonly appliedVerified: number;
  /** Applied batches found reorged out and returned to the queue this run. */
  readonly appliedReorged: number;
  /** Applied batches the sweep could not verify (never unwound on absence of evidence). */
  readonly appliedUnverifiable: number;
  /**
   * — HELD claims the kernel reads paid at the safe block, recorded settled
   * this run instead of looping in holds forever.
   */
  readonly heldSettledOnChain: number;
}

export interface CycleRunReport {
  readonly cycleId: string;
  readonly outcome: 'completed' | 'stopped' | 'refused';
  readonly stopReason: CycleStopReason | null;
  readonly detail: string | null;
  readonly batchesConfirmed: number;
  readonly claimsSettled: number;
  readonly recipientsSettled: number;
  readonly transactionsSubmitted: number;
  readonly replacementsSubmitted: number;
  readonly feeWeiSpent: bigint;
  readonly deferredClaims: number;
  readonly resumedBatches: number;
  /** claims isolated and HELD this run (poisoned; the rest kept settling). Alarmed. */
  readonly claimsHeld: number;
  readonly heldClaims: readonly HeldClaimReport[];
  /** the cross-cycle reconciliation this run performed (null when refused before it). */
  readonly reconciliation: ReconciliationReport | null;
}

export interface CycleRunnerDeps {
  /** One due snapshot for this invocation; on-demand and Genesis bypass it. */
  readonly standardPayeeDue?: (address: string) => Promise<boolean>;
  readonly db: SettlementDb;
  readonly chain: SettlementChainAdapter;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
  /**
   * The eligibility-verifier approval gate. `ProvianPVT9` reads the verifier on EVERY settle,
   * so a settlement broadcast without an affirmed approval is gas spent on a guaranteed
   * revert. Optional in the TYPE only: an absent or unconfigured gate REFUSES
   * (`approver_unavailable`) and no settlement reaches the wire. Cancel transactions —
   * self-sends with empty calldata, which are not settlements — are unaffected.
   */
  readonly approval?: BatchApprovalDeps;
  /**
   * the standard-lane first-mint gate verdict. REQUIRED, not optional:
   * every caller must state what the reconciliation gate said. When not
   * admitted, standard-lane claims are HELD (durable backlog, never lost) and
   * only Genesis batches plan; the run stops `standard_lane_refused` when the
   * held claims are the only work left. The one production construction of an
   * admitted verdict is `judgeStandardLaneAdmission` in
   * `standard-lane-recon-gate.ts`, consumed by `operator-runtime.ts`.
   */
  readonly standardLaneAdmission: StandardLaneAdmission;
}

// ---------------------------------------------------------------------------
// Exact issuance mirror (BigInt floor math, mirrors the kernel byte-for-byte)
// ---------------------------------------------------------------------------

const BPS_DENOMINATOR = 10_000n;
const PROVIAN_BPS = 50n;
const HUMAN_FOUNDATION_BPS = 50n;
const HUMAN_CONTRIBUTOR_BPS = BPS_DENOMINATOR - PROVIAN_BPS - HUMAN_FOUNDATION_BPS;
const ONE_ETHER = 1_000_000_000_000_000_000n;

function mulDivFloor(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

/**
 * Exact `totalMinted` of a standard batch — mirrors
 * `ProvianPVT9.settleStandardPEBatch` arithmetic including per-recipient
 * floor rounding, so the cap pre-check can never disagree with the kernel.
 */
export function standardBatchTotalMinted(
  recipients: ReadonlyArray<{ pointsAtomic: bigint; beneficiaryClass: BeneficiaryClass }>,
  mintRateAtomic: bigint,
  agentFoundationBps: bigint,
): bigint {
  let grossInput = 0n;
  let contributorTotal = 0n;
  let foundationTotal = 0n;
  for (const recipient of recipients) {
    const gross = mulDivFloor(recipient.pointsAtomic, mintRateAtomic, ONE_ETHER);
    const foundationBps = agentFoundationBps === HUMAN_FOUNDATION_BPS
      || recipient.beneficiaryClass === BeneficiaryClass.HumanResolving
      ? HUMAN_FOUNDATION_BPS
      : agentFoundationBps;
    const contributorBps = BPS_DENOMINATOR - PROVIAN_BPS - foundationBps;
    contributorTotal += mulDivFloor(gross, contributorBps, BPS_DENOMINATOR);
    foundationTotal += mulDivFloor(gross, foundationBps, BPS_DENOMINATOR);
    grossInput += gross;
  }
  return contributorTotal + foundationTotal + mulDivFloor(grossInput, PROVIAN_BPS, BPS_DENOMINATOR);
}

/** Exact `totalMinted` of a Genesis batch (also its genesis-cap consumption). */
export function genesisBatchTotalMinted(recipientGrossAtomic: readonly bigint[]): bigint {
  let grossInput = 0n;
  let contributorTotal = 0n;
  let foundationTotal = 0n;
  for (const gross of recipientGrossAtomic) {
    contributorTotal += mulDivFloor(gross, HUMAN_CONTRIBUTOR_BPS, BPS_DENOMINATOR);
    foundationTotal += mulDivFloor(gross, HUMAN_FOUNDATION_BPS, BPS_DENOMINATOR);
    grossInput += gross;
  }
  return contributorTotal + foundationTotal + mulDivFloor(grossInput, PROVIAN_BPS, BPS_DENOMINATOR);
}

// ---------------------------------------------------------------------------
// Batch identity — unique per reservation, deterministic preimage
// ---------------------------------------------------------------------------

export function deriveSettlementBatchId(params: {
  cycleId: string;
  lane: LedgerLane;
  cursorStart: bigint;
  rebuildIndex: number;
  /**
   * an ISOLATION PROBE: a sub-batch approved and dry-run (never signed, never sent)
   * to find which claims poison a refused batch. Domain-separated so a probe id can never
   * equal a real batch id. Omitted: the pre- preimage, byte-identical.
   */
  probe?: number;
}): string {
  const preimage = params.probe === undefined
    ? `provian:pvt9-settlement-batch:v1:${params.cycleId}:${params.lane}:${params.cursorStart.toString()}:${params.rebuildIndex}`
    : `provian:pvt9-settlement-probe:v1:${params.cycleId}:${params.lane}:${params.cursorStart.toString()}:${params.probe}`;
  return `0x${createHash('sha256').update(preimage, 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Work selection
// ---------------------------------------------------------------------------

export interface LaneWork {
  readonly lane: LedgerLane;
  /** Kernel order: strictly ascending contributor address. */
  readonly items: SettlementWorkItem[];
  readonly rowsByClaimId: Map<string, ClaimLedgerRow>;
}

/**
 * lane scope. A scoped run settles ONLY its lane; the other lane's selected
 * rows are dropped from THIS cycle and left as durable backlog for their own
 * cadence. This is deliberately NOT the reconciliation-gate refusal: dropping a
 * lane here records no held-claim count, raises no `standard_lane_refused` stop,
 * and pages no alarm — the rows are simply not planned. `'both'` (the default)
 * returns both lanes untouched, preserving the Genesis-first both-lanes behavior
 * exactly. Pure and total, so the scope decision is unit-tested in isolation from
 * the cycle loop's chain/lease machinery (settlement-lane-scope.test.ts).
 */
export function applyLaneScope(
  scope: SettlementLaneScope,
  standard: LaneWork,
  genesis: LaneWork,
): { standard: LaneWork; genesis: LaneWork } {
  return {
    standard: scope === 'genesis'
      ? { lane: 'standard', items: [], rowsByClaimId: new Map() }
      : standard,
    genesis: scope === 'standard'
      ? { lane: 'genesis', items: [], rowsByClaimId: new Map() }
      : genesis,
  };
}

/**
 * — scope a cycle's standard work to ONE payee (an on-demand payout). Pure. Only
 * items whose contributor is the payee survive (a payee may be two items: one per beneficiary
 * class); with no payee, the work is returned unchanged.
 */
export function applyPayeeScope(payee: string | undefined, standard: LaneWork): LaneWork {
  if (payee === undefined) return standard;
  const wanted = payee.toLowerCase();
  const items = standard.items.filter((item) => item.contributor.toLowerCase() === wanted);
  const rowsByClaimId = new Map<string, ClaimLedgerRow>();
  for (const item of items) {
    for (const claimId of item.claimIds) {
      const row = standard.rowsByClaimId.get(claimId);
      if (row !== undefined) rowsByClaimId.set(claimId, row);
    }
  }
  return { lane: standard.lane, items, rowsByClaimId };
}

/**
 * Page the complete unsettled ledger into per-lane work, contributor-grouped
 * and admission-ordered. A contributor's admission rank is its oldest
 * unsettled claim; ties break by that claim's stable claim key and finally the
 * contributor address. Claims within a contributor keep
 * (created_at, claim_key) order. The complete sweep is intentional: applying a
 * row budget before grouping can hide the tail of one recipient's pending
 * total, and applying a recipient budget can let an oversized oldest recipient
 * permanently hide a later recipient that fits the epoch. Pages still bound
 * each Firestore read, but cap admission is exact over the durable backlog.
 * The kernel-facing builder sorts the recipients in each chosen batch
 * by address, because the contract requires that encoding order; address is
 * never the admission priority. Selection
 * re-runs from the top every sweep, and settled rows drop out of the filter,
 * so deferral under an epoch cap can never starve a claim forever; the
 * kernel's ≥2.5M organic share of the combined cap is the structural
 * non-starvation guarantee for the standard lane.
 */
export async function selectLaneWork(
  db: SettlementDb,
  pageSize: number,
  _budgetClaims: number,
  /**
   * the run's clock, for claim holds. When given, a HELD claim (isolated as the cause
   * of a refused batch, `hold.retry_at_ms` still ahead) is left out of this sweep. Omitted:
   * holds are not consulted (the pre- selection, for read-only callers).
   */
  nowMs?: number,
  /** The run's set of ledger rows already twin-checked (see `auditLedgerSinceWatermark`). */
  auditedThisRun?: Set<string>,
  standardPayeeDue?: (address: string) => Promise<boolean>,
): Promise<{ standard: LaneWork; genesis: LaneWork; ledger: Map<string, RecordedClaim>; exhausted: boolean }> {
  // Grouped by (contributor, beneficiary class) —. The kernel prices a recipient at ONE
  // class, and `assembleStandardBatch` refuses a batch whose contributor carries two
  // (`beneficiary_class_conflict`). Grouping by contributor alone put an agent's linked and
  // unlinked claims into one item, the refusal re-occurred on every deterministic re-selection,
  // and the standard lane wedged. Two groups of one contributor are never admitted to the same
  // batch (`planNextBatch`); the second settles in the next batch of the same run.
  const byLaneContributor = new Map<LedgerLane, Map<string, ClaimLedgerRow[]>>([
    ['standard', new Map()],
    ['genesis', new Map()],
  ]);
  const staleCandidates = new Map<string, string[]>();
  // Before reading a single page: a pre-M8 row is INVISIBLE to the `claim_key` ordering below,
  // so selection would silently skip it and the inlet would re-register it. Loud refusal.
  // PE METER: a full audit once, then only the rows registered since (bounded by new work).
  await auditLedgerSinceWatermark(db, nowMs ?? Date.now(), { audited: auditedThisRun });
  const ledger = new Map<string, RecordedClaim>();
  const source = createLedgerPageSource(db, true);
  let cursor: string | undefined;
  let exhausted = false;
  for (;;) {
    const page = await readLedgerPage(db, {
      pageSize,
      startAfterDocId: cursor,
      unsettledOnly: true,
      source,
    });
    for (const { row } of page.rows) {
      if (row.bug_demoted_at_ms != null) continue;
      // Keyed by the CLAIM, not the PE. Keying by PE let the second leg of a split act
      // overwrite the first, which made `verifyClaimIdentity` report drift on a correct
      // proposal and halted the WHOLE cycle — see the M9 note in `claim-identity.ts`.
      ledger.set(claimKeyOf(row.pe_id, row.leg, row.claim_kind ?? 'act'), {
        peId: row.pe_id,
        leg: row.leg,
        ...(row.claim_kind === undefined ? {} : { kind: row.claim_kind }),
        claimId: row.claim_id,
        lane: row.lane,
        settled: row.settled,
        genesisAnchorKey: row.genesis_anchor_key,
      });
      const contributors = byLaneContributor.get(row.lane);
      if (contributors === undefined) continue;
      // a row RESERVED by a batch is in flight (or stranded awaiting reconciliation):
      // re-selecting it only made `reserveBatch` refuse `claim_not_settleable` and the cycle
      // abort, run after run. A reservation naming a dead batch is stale; it is repaired below.
      if (typeof row.reserved_batch_id === 'string' && row.reserved_batch_id.length > 0) {
        const keys = staleCandidates.get(row.reserved_batch_id) ?? [];
        keys.push(row.claim_key);
        staleCandidates.set(row.reserved_batch_id, keys);
        continue;
      }
      if (nowMs !== undefined && isClaimHeld(row, nowMs)) continue;
      if (row.lane === 'standard' && standardPayeeDue && !await standardPayeeDue(row.contributor)) continue;
      const groupKey = row.lane === 'standard'
        ? `${row.contributor}#${String(row.beneficiary_class)}`
        : row.contributor;
      const list = contributors.get(groupKey) ?? [];
      list.push(row);
      contributors.set(groupKey, list);
    }
    if (page.lastDocId === null || page.rows.length < pageSize) {
      exhausted = true;
      break;
    }
    cursor = page.lastDocId;
  }

  // Repair reservations whose batch is dead (a crash between `markBatchDead`'s sibling writes
  // is the only way to leave one). A live batch's reservation is never touched; the repaired
  // rows are selected on the next sweep.
  for (const [batchId, keys] of staleCandidates) {
    const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(batchId.toLowerCase()).get();
    const status = snap.exists ? (snap.data() ?? {}).status : undefined;
    if (snap.exists && status !== 'dead') continue;
    for (const claimKey of keys) await clearStaleReservation(db, { claimKey, batchId });
  }

  const toLaneWork = (lane: LedgerLane): LaneWork => {
    const contributors = [...byLaneContributor.get(lane)!.entries()];
    for (const [, rows] of contributors) {
      rows.sort((a, b) => (a.created_at !== b.created_at
        ? a.created_at - b.created_at
        : a.claim_key < b.claim_key ? -1 : a.claim_key > b.claim_key ? 1 : 0));
    }
    contributors.sort((a, b) => {
      const aOldest = a[1][0];
      const bOldest = b[1][0];
      if (aOldest.created_at !== bOldest.created_at) return aOldest.created_at - bOldest.created_at;
      if (aOldest.claim_key !== bOldest.claim_key) {
        return aOldest.claim_key < bOldest.claim_key ? -1 : 1;
      }
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    const items: SettlementWorkItem[] = [];
    const rowsByClaimId = new Map<string, ClaimLedgerRow>();
    for (const [, rows] of contributors) {
      items.push({ contributor: rows[0].contributor, claimIds: rows.map((row) => row.claim_id) });
      for (const row of rows) rowsByClaimId.set(row.claim_id, row);
    }
    return { lane, items, rowsByClaimId };
  };

  return {
    standard: toLaneWork('standard'),
    genesis: toLaneWork('genesis'),
    ledger,
    exhausted,
  };
}

// ---------------------------------------------------------------------------
// Batch planning against caps
// ---------------------------------------------------------------------------

interface PlannedLaneBatch {
  readonly lane: LedgerLane;
  readonly items: readonly SettlementWorkItem[];
  readonly claimCount: number;
  readonly recipientCount: number;
  readonly cursorStart: bigint;
  readonly cursorEnd: bigint;
  readonly totalMintedAtomic: bigint;
  readonly genesisIssuedAtomic: bigint;
  readonly members: readonly BatchMemberRecord[];
  /** Encodes the calldata for a given (final) batch id. */
  readonly encode: (batchId: string) => { data: string } | { error: string };
}

type PlanNextResult =
  | { kind: 'batch'; batch: PlannedLaneBatch }
  | { kind: 'deferred'; deferredClaims: number }
  | { kind: 'rejected'; reason: string };

/**
 * Plan the next batch: Genesis first (exact pacing priority — the combined
 * cap's ≥2.5M organic remainder keeps the standard lane un-starved), then
 * oldest-recipient-first within the lane. A recipient whose complete pending
 * amount does not fit the remaining epoch headroom is skipped for this epoch;
 * later recipients are still considered, so one oversized recipient cannot
 * head-of-line block the lane. Admission never scales a recipient. Claims that
 * do not fit stay unsettled in the ledger: DURABLE deferral to a later epoch.
 *
 * The chosen recipients are sorted by address only AFTER admission, solely to
 * satisfy the kernel's strict calldata ordering rule.
 */
export function planNextBatch(
  config: CycleRunnerConfig,
  view: CycleChainObservation,
  cursor: bigint,
  genesis: LaneWork,
  standard: LaneWork,
): PlanNextResult {
  const genesisHeadroom = view.genesisCapAtomic - view.epochGenesisIssuedAtomic;
  const combinedHeadroom = view.combinedCapAtomic - view.epochTotalIssuedAtomic;

  for (const work of [genesis, standard]) {
    if (work.items.length === 0) continue;
    let admitted: SettlementWorkItem[] = [];
    for (const item of work.items) {
      // the kernel requires strictly ascending UNIQUE contributors per batch, and a
      // contributor can now hold two groups (one per beneficiary class). The second group of a
      // contributor already admitted waits for the next batch of the same run.
      const contributor = item.contributor.toLowerCase();
      if (admitted.some((a) => a.contributor.toLowerCase() === contributor)) continue;
      // Cap admission judges the WHOLE recipient. This is intentionally done
      // before the transaction-size planner, whose slicing may later
      // split a very high claim-count recipient across transactions.
      const whole = buildLaneBatch(work, [...admitted, item], cursor, view);
      if (whole.kind === 'rejected') return whole;
      const genesisConsumption = work.lane === 'genesis' ? whole.batch.genesisIssuedAtomic : 0n;
      if (genesisConsumption > genesisHeadroom || whole.batch.totalMintedAtomic > combinedHeadroom) {
        continue;
      }

      const kernelOrdered = [...admitted, item]
        .sort((a, b) => (BigInt(a.contributor) < BigInt(b.contributor) ? -1 : 1));
      const planned = planSettlementBatches(kernelOrdered, config.batchLimits, config.gasModel, cursor);
      if (planned.kind === 'rejected') {
        return { kind: 'rejected', reason: `${work.lane}:${planned.reason}` };
      }
      if (planned.batches.length > 1) {
        // `item` is the oldest not-yet-admitted recipient. If prior recipients
        // already form a batch, emit them now and reconsider this one next
        // iteration. If it alone is sliced by the gas/claim bound, emit its
        // first safe slice; cap admission above already proved its WHOLE
        // pending amount fits the epoch.
        if (admitted.length > 0) break;
        const firstSlice = buildLaneBatch(work, planned.batches[0].items, cursor, view);
        if (firstSlice.kind === 'rejected') return firstSlice;
        return firstSlice;
      }
      admitted = [...admitted, item];
    }

    if (admitted.length > 0) {
      const kernelOrdered = admitted
        .sort((a, b) => (BigInt(a.contributor) < BigInt(b.contributor) ? -1 : 1));
      const fit = buildLaneBatch(work, kernelOrdered, cursor, view);
      if (fit.kind === 'rejected') return fit;
      return fit;
    }
    // Not even one recipient of this lane fits this epoch — try the other
    // lane (the combined cap can still admit organic work when Genesis is
    // exhausted, and vice versa).
  }

  const remaining = genesis.items.reduce((n, item) => n + item.claimIds.length, 0)
    + standard.items.reduce((n, item) => n + item.claimIds.length, 0);
  return { kind: 'deferred', deferredClaims: remaining };
}

function buildLaneBatch(
  work: LaneWork,
  items: readonly SettlementWorkItem[],
  cursorStart: bigint,
  view: CycleChainObservation,
): { kind: 'batch'; batch: PlannedLaneBatch } | { kind: 'rejected'; reason: string } {
  const claimCount = items.reduce((n, item) => n + item.claimIds.length, 0);
  const cursorEnd = cursorStart + BigInt(claimCount);
  const members: BatchMemberRecord[] = [];
  const epoch = BigInt(view.lastOpenedEpoch);
  const policyHash = view.openEpochPolicyHash;

  if (work.lane === 'standard') {
    const entries: StandardClaimEntry[] = [];
    const recipientPoints: Array<{ pointsAtomic: bigint; beneficiaryClass: BeneficiaryClass }> = [];
    for (const item of items) {
      let points = 0n;
      let beneficiaryClass: BeneficiaryClass = BeneficiaryClass.Unknown;
      let itemClass: number | null = null;
      for (const claimId of item.claimIds) {
        const row = work.rowsByClaimId.get(claimId);
        if (row === undefined || row.record_points_atomic === undefined) {
          return { kind: 'rejected', reason: 'standard:ledger_row_incomplete' };
        }
        // one item is one (contributor, class) group; a mixed item is a selection
        // defect, refused here rather than priced at whichever class happened to come last.
        if (itemClass !== null && row.beneficiary_class !== itemClass) {
          return { kind: 'rejected', reason: 'standard:beneficiary_class_mixed_in_item' };
        }
        itemClass = row.beneficiary_class ?? null;
        beneficiaryClass = row.beneficiary_class as BeneficiaryClass;
        entries.push({
          contributor: row.contributor,
          beneficiaryClass,
          claimId: row.claim_id,
          recordPointsAtomic: BigInt(row.record_points_atomic),
        });
        members.push({
          pe_id: row.pe_id,
          leg: row.leg,
          // carried so the writeback keys the top-up's OWN ledger row.
          ...(row.claim_kind === undefined ? {} : { claim_kind: row.claim_kind }),
          claim_id: row.claim_id,
        });
        points += BigInt(row.record_points_atomic);
      }
      recipientPoints.push({ pointsAtomic: points, beneficiaryClass });
    }
    const totalMinted = standardBatchTotalMinted(
      recipientPoints, view.mintRateAtomic, view.agentFoundationBps,
    );
    return {
      kind: 'batch',
      batch: {
        lane: 'standard',
        items,
        claimCount,
        recipientCount: items.length,
        cursorStart,
        cursorEnd,
        totalMintedAtomic: totalMinted,
        genesisIssuedAtomic: 0n,
        members,
        encode: (batchId: string) => {
          const assembled = assembleStandardBatch(entries, {
            batchId,
            epoch,
            policyHash,
            finalizedCursorStart: cursorStart,
            finalizedCursorEnd: cursorEnd,
          }, assemblyPolicyForEpoch(view.agentFoundationBps));
          if (assembled.kind !== 'assembled') {
            return { error: `standard_assembly_${assembled.reason}` };
          }
          const { batch } = assembled;
          return {
            data: kernelInterface.encodeFunctionData('settleStandardPEBatch', [
              batch.header.batchId,
              batch.header.epoch,
              batch.header.policyHash,
              batch.header.finalizedCursorStart,
              batch.header.finalizedCursorEnd,
              batch.recipients.map((r) => [r.contributor, r.beneficiaryClass, r.claimCount]),
              batch.claims.map((c) => [c.claimId, c.recordPointsAtomic]),
            ]),
          };
        },
      },
    };
  }

  const recipients: GenesisRecipient[] = [];
  const claims: GenesisPEClaim[] = [];
  const recipientGross: bigint[] = [];
  for (const item of items) {
    let gross = 0n;
    let count = 0n;
    for (const claimId of item.claimIds) {
      const row = work.rowsByClaimId.get(claimId);
      if (row === undefined || row.reserved_gross_atomic === undefined
        || row.wallet_id === undefined || row.one_time_anchor === undefined
        || row.grant_type === undefined || row.qualified_at === undefined) {
        return { kind: 'rejected', reason: 'genesis:ledger_row_incomplete' };
      }
      claims.push({
        claimId: row.claim_id,
        walletId: row.wallet_id,
        oneTimeAnchor: row.one_time_anchor,
        grantType: row.grant_type,
        qualifiedAt: BigInt(row.qualified_at),
        reservedGrossAtomic: BigInt(row.reserved_gross_atomic),
      });
      members.push({ pe_id: row.pe_id, leg: row.leg, claim_id: row.claim_id });
      gross += BigInt(row.reserved_gross_atomic);
      count += 1n;
    }
    recipients.push({ contributor: item.contributor, claimCount: count });
    recipientGross.push(gross);
  }
  const totalMinted = genesisBatchTotalMinted(recipientGross);
  return {
    kind: 'batch',
    batch: {
      lane: 'genesis',
      items,
      claimCount,
      recipientCount: items.length,
      cursorStart,
      cursorEnd,
      totalMintedAtomic: totalMinted,
      genesisIssuedAtomic: totalMinted,
      members,
      encode: (batchId: string) => ({
        data: kernelInterface.encodeFunctionData('settleGenesisPEBatch', [
          batchId,
          epoch,
          policyHash,
          cursorStart,
          cursorEnd,
          recipients.map((r) => [r.contributor, r.claimCount]),
          claims.map((c) => [
            c.claimId, c.walletId, c.oneTimeAnchor, c.grantType, c.qualifiedAt, c.reservedGrossAtomic,
          ]),
        ]),
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Finality — a receipt is a fact only at the watchers' safe-head depth
// ---------------------------------------------------------------------------

export type ReceiptFinality =
  | { readonly kind: 'final'; readonly blockNumber: number; readonly blockHash: string }
  /** Not yet deep enough, or the answer is unreadable: WAIT. Never evidence of anything. */
  | { readonly kind: 'pending'; readonly detail: string }
  /** The receipt is gone, moved, or names a block that is not canonical at its height. */
  | { readonly kind: 'dropped'; readonly detail: string };

/**
 * Judge one SEEN receipt against 's floor.
 *
 * FINAL only when ALL of these hold: a fresh re-read returns the same receipt (same status,
 * same block, same hash) — the "re-read agrees" clause; its block is at or below
 * min(finalizedThroughBlock(head), safeHead.number) — the watchers' ceiling, read through the
 * same quorum-2 seams; and the canonical hash at that height is the receipt's. Every RPC
 * error is `pending` (wait), never a verdict. `dropped` needs a positive observation: the
 * receipt vanished, moved, changed status, or the canonical chain names another block there.
 */
export async function judgeReceiptFinality(
  chain: Pick<SettlementFinalityReader, 'getReceipt' | 'readHead' | 'readSafeHead' | 'getBlockHash'>,
  txHash: string,
  seen: { readonly status: 'success' | 'reverted'; readonly block_number: number; readonly block_hash?: string },
): Promise<ReceiptFinality> {
  let reread: MinedReceipt | null;
  try {
    reread = await chain.getReceipt(txHash);
  } catch (error) {
    return { kind: 'pending', detail: `receipt re-read failed: ${String(error)}` };
  }
  if (reread === null) return { kind: 'dropped', detail: `receipt for ${txHash} is no longer returned` };
  if (reread.status !== seen.status) {
    return { kind: 'dropped', detail: `receipt status changed ${seen.status} -> ${reread.status}` };
  }
  const seenHash = seen.block_hash?.toLowerCase();
  if (seenHash !== undefined
    && (reread.blockHash.toLowerCase() !== seenHash || reread.blockNumber !== seen.block_number)) {
    return {
      kind: 'dropped',
      detail: `receipt moved from ${seen.block_number}/${seenHash} to ${reread.blockNumber}/${reread.blockHash}`,
    };
  }
  let ceiling: number | null;
  try {
    ceiling = settlementFinalityCeiling(await chain.readHead(), await chain.readSafeHead());
  } catch (error) {
    return { kind: 'pending', detail: `safe head unreadable: ${String(error)}` };
  }
  if (ceiling === null || reread.blockNumber > ceiling) {
    return {
      kind: 'pending',
      detail: `block ${reread.blockNumber} above the finality ceiling ${ceiling === null ? '(no safe head)' : ceiling}`,
    };
  }
  let canonical: string | null;
  try {
    canonical = await chain.getBlockHash(reread.blockNumber);
  } catch (error) {
    return { kind: 'pending', detail: `canonical hash unreadable: ${String(error)}` };
  }
  if (canonical === null) return { kind: 'pending', detail: `no canonical hash at ${reread.blockNumber}` };
  if (canonical.toLowerCase() !== reread.blockHash.toLowerCase()) {
    return {
      kind: 'dropped',
      detail: `block ${reread.blockNumber} is ${canonical} on the canonical chain, not ${reread.blockHash}`,
    };
  }
  return { kind: 'final', blockNumber: reread.blockNumber, blockHash: reread.blockHash.toLowerCase() };
}

/**
 * does a RECORDED mined receipt still describe the live receipt of the SAME transaction
 * (the receipt was read by that attempt's tx hash)? Status and block number must agree, and the
 * block hash too when one was recorded. Attempts recorded before carry NO `block_hash`;
 * for them status + block number is the whole record, and it is what they are matched on —
 * demanding a hash they never had made every legacy attempt look unknown forever.
 * Shared with `scripts/pvt9-stranded-batch-probe.ts`, so the probe predicts what this decides.
 */
export function recordedReceiptMatches(
  mined: NonNullable<BatchAttempt['mined']>,
  receipt: MinedReceipt,
): boolean {
  if (receipt.status !== mined.status || receipt.blockNumber !== mined.block_number) return false;
  const recordedHash = mined.block_hash?.toLowerCase();
  return recordedHash === undefined || recordedHash === '' || receipt.blockHash.toLowerCase() === recordedHash;
}

/**
 * The kernel's view of a batch's members AT ONE BLOCK: which of its claims are already paid.
 * : read at the SAME safe block the nonce is read at. Read at `latest`, a lagging
 * replica could answer "unpaid" beside a fresh "nonce consumed at safe depth" and a PAID batch
 * would be concluded dead — its claims looping in holds, the ledger never recording payment.
 */
export type MemberSettlement =
  | { readonly kind: 'read'; readonly settled: readonly BatchMemberRecord[]; readonly unsettled: readonly BatchMemberRecord[] }
  | { readonly kind: 'unknown'; readonly detail: string };

export async function memberSettlement(
  chain: Pick<SettlementFinalityReader, 'isClaimSettled'>,
  members: readonly BatchMemberRecord[],
  atBlock: number,
): Promise<MemberSettlement> {
  try {
    const settled: BatchMemberRecord[] = [];
    const unsettled: BatchMemberRecord[] = [];
    for (const member of members) {
      if (await chain.isClaimSettled(member.claim_id, atBlock)) settled.push(member);
      else unsettled.push(member);
    }
    return { kind: 'read', settled, unsettled };
  } catch (error) {
    return { kind: 'unknown', detail: `kernel claimSettled unreadable at block ${atBlock}: ${String(error)}` };
  }
}

function describeSettlement(settlement: MemberSettlement, total: number): string {
  if (settlement.kind === 'unknown') return 'unknown';
  if (settlement.settled.length === 0) return 'none';
  return settlement.settled.length === total ? 'all' : `${settlement.settled.length}/${total}`;
}

/** The quorum safe block, or null when there is none or it is unreadable (never final). */
async function readSafeBlock(chain: SettlementChainAdapter): Promise<number | null> {
  try {
    const safe = await chain.readSafeHead();
    return safe === null ? null : safe.number;
  } catch {
    return null;
  }
}

/** True when the signer's nonce AT `safeBlock` is past `nonce` — consumed, irreversibly. */
async function nonceConsumedAtBlock(
  chain: SettlementChainAdapter,
  signer: string,
  nonce: number,
  safeBlock: number,
): Promise<boolean | null> {
  try {
    return (await chain.getTransactionCount(signer, safeBlock)) > nonce;
  } catch {
    return null;
  }
}

/** Approval refusals that are the moment, not the claims: retried, then systemic. */
const TRANSIENT_APPROVAL_REFUSALS: ReadonlySet<ApprovalRefusal> = new Set<ApprovalRefusal>([
  'approval_call_failed',
  'approval_not_affirmed',
]);

/**
 * `approveBatchForSettlement`, retried while the refusal is TRANSIENT. Safe to repeat: approval
 * is idempotent per digest (an affirmed digest is reported approved without a second call).
 */
async function approveWithRetry(
  deps: CycleRunnerDeps,
  config: CycleRunnerConfig,
  batch: SettlementBatchDoc,
): Promise<ApprovalOutcome> {
  const attempts = Math.max(1, config.approvalRetry?.attempts ?? 3);
  const delayMs = config.approvalRetry?.delayMs ?? 2_000;
  let outcome = await approveBatchForSettlement(deps.approval ?? {}, batch);
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (outcome.kind === 'approved' || !TRANSIENT_APPROVAL_REFUSALS.has(outcome.reason)) return outcome;
    await deps.sleep(delayMs);
    outcome = await approveBatchForSettlement(deps.approval ?? {}, batch);
  }
  return outcome;
}

async function simulateWithRetry(
  deps: CycleRunnerDeps,
  config: CycleRunnerConfig,
  kernelAddress: string,
  calldata: string,
): Promise<{ ok: boolean; revertReason: string | null }> {
  const attempts = config.settleSimulate?.attempts ?? 5;
  const delayMs = config.settleSimulate?.delayMs ?? 1_000;
  let probe: { ok: boolean; revertReason: string | null } = { ok: false, revertReason: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    probe = await deps.chain.simulate({ from: config.signerAddress, to: kernelAddress, data: calldata });
    if (probe.ok) return probe;
    if (attempt < attempts - 1) await deps.sleep(delayMs);
  }
  return probe;
}

/**
 * Re-send a RECORDED attempt byte-identically. Signing is deterministic, so the same fields
 * re-sign to the same transaction; the re-signed hash must equal the recorded one or nothing is
 * sent (a different kernel address, say, would make it a different transaction). Best-effort:
 * a node answering "already known" / "nonce too low" is the expected outcome half the time.
 */
async function rebroadcastAttempt(
  deps: CycleRunnerDeps,
  config: CycleRunnerConfig,
  kernelAddress: string,
  batch: SettlementBatchDoc,
  attempt: BatchAttempt,
): Promise<void> {
  const cancel = attempt.kind === 'cancel';
  try {
    const signed = await deps.chain.sign({
      to: cancel ? config.signerAddress : kernelAddress,
      data: cancel ? '0x' : batch.calldata,
      valueWei: 0n,
      nonce: attempt.nonce,
      gasLimit: BigInt(attempt.gas_limit),
      maxFeePerGasWei: BigInt(attempt.max_fee_per_gas_wei),
      maxPriorityFeePerGasWei: BigInt(attempt.max_priority_fee_per_gas_wei),
    });
    if (signed.hash.toLowerCase() !== attempt.tx_hash.toLowerCase()) {
      deps.log?.(`batch ${batch.batch_id}: re-signed ${attempt.tx_hash} differs (${signed.hash}); not re-broadcast`);
      return;
    }
    await deps.chain.broadcast(signed.raw);
  } catch (error) {
    deps.log?.(`batch ${batch.batch_id}: re-broadcast of ${attempt.tx_hash} not accepted (${String(error)})`);
  }
}

// ---------------------------------------------------------------------------
// Batch resolution — one state machine for fresh submissions, crash resume, AND adoption
// ---------------------------------------------------------------------------

type ApprovalRefused = Extract<ApprovalOutcome, { kind: 'refused' }>;

type BatchResolution =
  | { kind: 'confirmed' }
  /** Binding died; the reservation is marked dead and its nonce is resolved. */
  | { kind: 'dead'; reason: string }
  /**
   * the batch was refused before anything settled (approval refused, or the dry run /
   * a final revert says it cannot settle). It is ALREADY dead and its claims released; the
   * caller isolates the offending claims so they cannot wedge the queue.
   */
  | {
    kind: 'refused';
    reason: 'batch_approval_refused' | 'batch_unsettleable';
    detail: string;
    approval?: ApprovalRefused;
  }
  | { kind: 'stopped'; reason: CycleStopReason; detail: string };

/**
 * `owned` the batch belongs to the cycle this run leases (fresh submission or same-cycle
 * resume). `adopted` a batch stranded in ANY other cycle — closed, or abandoned by a
 * crashed worker whose lease lapsed — driven under the SIGNER lease. Adoption never sends a
 * transaction at a new nonce: it can only wait, re-broadcast, replace, or cancel at the nonce
 * the batch already holds, or conclude from the chain that the batch is dead.
 */
interface ResolveContext {
  readonly mode: 'owned' | 'adopted';
  readonly deadline: number;
  readonly kernelAddress: string;
}

/**
 * Drive one reserved batch to a terminal state: confirmed, dead, refused, or a graceful stop.
 * The batch doc IS the state, which is what makes crash continuation and cross-cycle adoption
 * exact. nothing is applied, written back, or announced until the winning receipt is
 * FINAL (`judgeReceiptFinality`); a reverted receipt is acted on only at the same depth.
 */
async function resolveBatch(
  deps: CycleRunnerDeps,
  config: CycleRunnerConfig,
  ctx: ResolveContext,
  batch: SettlementBatchDoc,
): Promise<BatchResolution> {
  const { db, chain, now, sleep } = deps;
  const log = deps.log ?? (() => undefined);
  const adopted = ctx.mode === 'adopted';
  const kernelAddress = ctx.kernelAddress;
  const cycleId = batch.cycle_id;
  const binding: PreparedBatchBinding = {
    epoch: batch.epoch,
    policyHash: batch.policy_hash,
    cursorStart: BigInt(batch.cursor_start),
    cursorEnd: BigInt(batch.cursor_end),
  };

  // Reload live attempt state from the durable doc (single source of truth).
  let attempts: BatchAttempt[] = [...batch.attempts];
  // the replacement budget is PER RUN, so a batch stranded by exhausting it is not
  // born exhausted when a later run adopts it.
  let replacementsThisRun = 0;
  let retriesAfterRevert = attempts.filter((a) => a.kind === 'retry_after_revert').length;
  let lastSubmitAt = attempts.length > 0 ? attempts[attempts.length - 1].submitted_at_ms : 0;

  /**
   * Nothing of this reservation reached the wire (record-before-broadcast), so its claims are
   * released and — when this run owns the cycle and it is the head allocation — its nonce is
   * returned. An adopted batch's cycle no longer allocates nonces: the next cycle re-seeds.
   */
  const releaseAndDie = async (reason: string): Promise<void> => {
    if (!adopted) {
      await releaseUnusedNonce(db, {
        cycleId, workerId: config.workerId, nowMs: now(), nonce: batch.reserved_nonce,
      });
    }
    await markBatchDead(db, { batchId: batch.batch_id, nowMs: now(), reason });
  };

  /**
   * the batch's live nonce is CONSUMED at the safe block (by our own final revert, or
   * by a transaction this runner never recorded), so none of its attempts can ever mine again.
   * Conclude from the KERNEL, read at that same safe block:
   * - no member paid → the batch is dead and its claims return to the queue;
   * - some or all paid → the paid members are recorded settled from chain evidence (they can
   * never be re-sent or loop in a hold), then the batch is dead and the rest return. A batch
   * settles atomically on chain, so members paid while this batch did not settle were paid
   * elsewhere; members paid because a lagging replica hid OUR receipt are paid all the same.
   * - unreadable → stop; never a verdict on missing evidence.
   * Before concluding, every recorded attempt's receipt is polled once more: a receipt that
   * appears is handled by the receipt path (`recheck`), never concluded around.
   */
  const concludeConsumedNonce = async (
    reasonPrefix: string,
    safeBlock: number,
  ): Promise<BatchResolution | 'recheck'> => {
    for (const attempt of attempts) {
      let receipt: MinedReceipt | null = null;
      try {
        receipt = await chain.getReceipt(attempt.tx_hash);
      } catch (error) {
        return {
          kind: 'stopped',
          reason: 'resumption_abort',
          detail: `batch ${batch.batch_id}: receipt of ${attempt.tx_hash} unreadable before concluding (${String(error)})`,
        };
      }
      if (receipt === null) continue;
      // A receipt the durable doc has not recorded: the receipt path records it and decides —
      // if it is OUR settle that paid, the batch is CONFIRMED through the normal path (applied,
      // cursor and counters advanced), never concluded dead around it.
      if (attempt.mined === null) return 'recheck';
      if (recordedReceiptMatches(attempt.mined, receipt)) continue;
      // Recorded one receipt, the chain now returns another for the same transaction: the record
      // is stale. Withdraw it so the receipt path re-records (and re-judges) the live one.
      await clearMinedReceipt(db, { batchId: batch.batch_id, txHash: attempt.tx_hash, nowMs: now() });
      attempts = attempts.map((a) => (a.tx_hash === attempt.tx_hash ? { ...a, mined: null } : a));
      return 'recheck';
    }
    const settlement = await memberSettlement(chain, batch.members, safeBlock);
    if (settlement.kind === 'unknown') {
      return {
        kind: 'stopped',
        reason: 'resumption_abort',
        detail: `batch ${batch.batch_id}: ${reasonPrefix}, and ${settlement.detail} — refusing to guess`,
      };
    }
    const described = describeSettlement(settlement, batch.members.length);
    if (settlement.settled.length > 0) {
      const recorded = await settleClaimsFromChainEvidence(db, {
        nowMs: now(),
        claims: settlement.settled.map((member) => ({
          claimKey: claimKeyOf(member.pe_id, member.leg, member.claim_kind ?? 'act'),
          claimId: member.claim_id,
        })),
        evidence: {
          safe_block: safeBlock,
          reason: `${reasonPrefix}; kernel reads ${described} member(s) settled at safe block ${safeBlock}`,
          // The batch whose CONCLUSION produced the evidence — context, never the payer: no
          // receipt of this batch was found, so the ledger never names it as having paid.
          concluding_batch_id: batch.batch_id,
        },
      });
      log(`batch ${batch.batch_id}: ${reasonPrefix}; the kernel reads ${described} member(s) PAID at safe block `
        + `${safeBlock} — ${recorded.settled.length} recorded settled from chain evidence`
        + `${recorded.skipped.length > 0 ? ` (${recorded.skipped.length} skipped)` : ''}`);
    }
    const reason = `${reasonPrefix}; kernel reads ${described} member(s) settled at safe block ${safeBlock}`;
    const marked = await markBatchDead(db, { batchId: batch.batch_id, nowMs: now(), reason });
    if (!marked.marked) {
      return { kind: 'stopped', reason: 'resumption_abort', detail: `batch ${batch.batch_id}: could not conclude (${reason})` };
    }
    return { kind: 'dead', reason: settlement.settled.length > 0 ? 'settled_on_chain_by_evidence' : reasonPrefix.split(':')[0] };
  };

  // ── reclaim a recorded batch that can never broadcast ────────────
  //
  // A batch whose gasLimit exceeds the RPC's `eth_sendRawTransaction` cap
  // (Alchemy answers -32003 "gas limit too high") is replayed BYTE-IDENTICALLY
  // on every resume: the replacement path below re-uses the recorded `gas_limit`
  // and never re-plans. Reclaim it so the runner re-plans the same claims
  // into correctly-sized batches at the SAME reused nonce.
  //
  // Sound ONLY under a proof that nothing of this batch reached a chain OR a
  // mempool the runner can reach — the three invariants a discard must hold:
  //   (1) every recorded attempt is unmined in the durable doc AND has no
  //       on-chain receipt  → nothing settled that did not confirm;
  //   (2) the signer's on-chain nonce ('latest') EQUALS the reserved nonce → no
  //       attempt of this batch mined, and it is exactly the next expected nonce
  //       (no lower gap)     → no claim can have minted, on this nonce or before;
  //   (3) the recorded gasLimit exceeds `broadcastableGasCeiling` (below the RPC
  //       cap) → the signed tx is one this runner's SOLE provider
  //       deterministically rejects and gossips nowhere, and the runner is the
  //       only holder of the raw tx → the nonce carries no live tx on the wire.
  // Only then release the (head-of-sequence) nonce and mark the batch dead. An ADOPTED batch's
  // cycle no longer allocates, so there is nothing to release: the next cycle re-seeds from the
  // chain and re-uses the nonce. The kernel's own mint-once guards remain the independent net.
  if (
    config.broadcastableGasCeiling !== undefined
    && attempts.length > 0
    && attempts.every((a) => a.mined === null)
    && BigInt(attempts[attempts.length - 1].gas_limit) > BigInt(config.broadcastableGasCeiling)
  ) {
    const onChainNonce = await chain.getTransactionCount(config.signerAddress);
    const receipts = await Promise.all(attempts.map((a) => chain.getReceipt(a.tx_hash)));
    const noneMined = receipts.every((r) => r === null);
    if (onChainNonce === batch.reserved_nonce && noneMined) {
      const released = adopted
        ? true
        : (await releaseUnusedNonce(db, {
          cycleId, workerId: config.workerId, nowMs: now(), nonce: batch.reserved_nonce,
        })).released;
      if (released) {
        const reason = `oversized_unbroadcastable: gasLimit ${attempts[attempts.length - 1].gas_limit} `
          + `> ceiling ${config.broadcastableGasCeiling}; nonce ${batch.reserved_nonce} unmined on chain — rebuilding`;
        await markBatchDead(db, { batchId: batch.batch_id, nowMs: now(), reason });
        log(`batch ${batch.batch_id}: ${reason}`);
        return { kind: 'dead', reason: 'oversized_unbroadcastable_rebuild' };
      }
    }
  }

  /**
   * Affirm the batch on the eligibility verifier.
   *
   * MUST RUN BEFORE ANY SIMULATION OF SETTLE CALLDATA, and that ordering is not a nicety.
   * `ProvianPVT9._verifyEligibility` runs on every settle and reverts `VerificationFailed`
   * unless the verifier has already affirmed this exact digest — so `eth_call` on an
   * unapproved batch reverts unconditionally. The first end-to-end fork run stopped here:
   * `batch_unsettleable` with revert data `0x439cc0cd`, which is `VerificationFailed()`.
   *
   * Idempotent per digest: an already-affirmed digest is reported approved without a second
   * on-chain call, so calling this before the simulation AND again inside `record` costs one
   * view call, not one transaction.
   */
  const ensureApproved = async (): Promise<
    { ok: true } | { ok: false; refused: string; stopReason: CycleStopReason; outcome: ApprovalRefused }
  > => {
    const approval = await approveWithRetry(deps, config, batch);
    if (approval.kind === 'approved') return { ok: true };
    const why = approval.reason === 'candidate_ineligible' && approval.ineligible !== undefined
      ? `${approval.detail} [${approval.ineligible.slice(0, 3).map((i) => `${i.claimId}:${i.reasons.join('+')}`).join(', ')}]`
      : approval.detail;
    log(`batch ${batch.batch_id}: settlement REFUSED by approval gate (${approval.reason}) — ${why}`);
    return {
      ok: false,
      refused: `approval_${approval.reason}: ${why}`,
      stopReason: 'batch_approval_refused',
      outcome: approval,
    };
  };

  const record = async (
    kind: 'original' | 'replacement' | 'retry_after_revert' | 'cancel',
    nonce: number,
    maxFeePerGasWei: bigint,
    maxPriorityFeePerGasWei: bigint,
    gasLimit: bigint,
    to: string,
    data: string,
  ): Promise<
    | { ok: true; hash: string }
    | { ok: false; refused: string; stopReason?: CycleStopReason; notRecorded: boolean; approval?: ApprovalRefused }
  > => {
    // ── THE APPROVAL GATE ────────────────────────────────────────────────
    // Every transaction addressed to the KERNEL is a settlement, and the kernel calls
    // `_verifyEligibility` on each one. Without an affirmed approval it reverts, so we
    // refuse here — before signing, before an attempt is recorded, before any broadcast.
    // Cancel transactions are self-sends with empty calldata and are not settlements, so
    // they pass through: `to` is the signer, not the kernel.
    if (to.toLowerCase() === kernelAddress.toLowerCase()) {
      const approval = await ensureApproved();
      if (!approval.ok) {
        return {
          ok: false, refused: approval.refused, stopReason: approval.stopReason, notRecorded: true, approval: approval.outcome,
        };
      }
    }

    const signed = await chain.sign({
      to, data, valueWei: 0n, nonce, gasLimit, maxFeePerGasWei, maxPriorityFeePerGasWei,
    });
    const recorded = await recordAttempt(db, {
      cycleId,
      workerId: config.workerId,
      nowMs: now(),
      batchId: batch.batch_id,
      attempt: {
        nonce,
        tx_hash: signed.hash,
        kind,
        max_fee_per_gas_wei: maxFeePerGasWei.toString(),
        max_priority_fee_per_gas_wei: maxPriorityFeePerGasWei.toString(),
        gas_limit: gasLimit.toString(),
      },
      ...(adopted ? { adoptSigner: config.signerAddress } : {}),
    });
    if (recorded.kind !== 'recorded') {
      return {
        ok: false,
        refused: recorded.reason,
        stopReason: recorded.reason === 'transaction_limit' ? 'transaction_limit' : 'resumption_abort',
        notRecorded: true,
      };
    }
    try {
      await chain.broadcast(signed.raw);
    } catch (error) {
      // The gas payer running dry lands HERE, and so does every other send failure —
      // `SettlementChainAdapter` exposes no balance call, so the runner cannot tell them
      // apart and must not try.
      //
      // The attempt is ALREADY durably recorded, deliberately (see the write-intent log
      // in durable-settlement-store). Do NOT unwind it: a throw here does not prove the
      // node rejected the transaction — a timeout can follow acceptance — so unwinding
      // could release a nonce that is live on the wire. Leave the attempt standing: the
      // same-cycle resume, or the cross-cycle reconciler, adjudicates it later.
      return {
        ok: false,
        refused: `broadcast_failed: ${error instanceof Error ? error.message : String(error)}`,
        stopReason: 'broadcast_failed',
        notRecorded: false,
      };
    }
    attempts = [...attempts, {
      nonce,
      tx_hash: signed.hash,
      kind,
      max_fee_per_gas_wei: maxFeePerGasWei.toString(),
      max_priority_fee_per_gas_wei: maxPriorityFeePerGasWei.toString(),
      gas_limit: gasLimit.toString(),
      submitted_at_ms: now(),
      mined: null,
    }];
    lastSubmitAt = now();
    return { ok: true, hash: signed.hash };
  };

  // A never-submitted reservation ('reserved', no attempts).
  if (attempts.length === 0) {
    if (adopted) {
      // Record-before-broadcast: no recorded attempt means nothing reached the wire.
      await markBatchDead(db, {
        batchId: batch.batch_id,
        nowMs: now(),
        reason: 'adopted_never_broadcast: reserved with no recorded attempt in a cycle no worker runs',
      });
      return { kind: 'dead', reason: 'adopted_never_broadcast' };
    }
    const view = await chain.observe();
    const decision = evaluateBatchResumption(binding, view, config.boundarySafetyMarginSec);
    if (decision.kind === 'already_settled') {
      await releaseAndDie('cursor consumed before this reservation was submitted');
      return { kind: 'stopped', reason: 'resumption_abort', detail: 'cursor consumed but reservation was never submitted' };
    }
    if (decision.kind === 'abort') {
      await releaseAndDie(`abort before submission: ${decision.reason}`);
      return { kind: 'stopped', reason: 'resumption_abort', detail: `abort: ${decision.reason}` };
    }
    if (decision.kind === 'hold') {
      await releaseAndDie(`hold before submission: ${decision.reason}`);
      return { kind: 'stopped', reason: 'epoch_gate_closed', detail: `hold: ${decision.reason}` };
    }
    if (decision.kind === 'rebuild') {
      await releaseAndDie(decision.reason);
      return { kind: 'dead', reason: decision.reason };
    }
    // decision 'submit' — APPROVE, then dry-run, then send the original. The approval must
    // precede the dry run: without it the kernel's eligibility check reverts and the probe
    // condemns a batch that is perfectly settleable.
    const preApproval = await ensureApproved();
    if (!preApproval.ok) {
      await releaseAndDie(`approval refused before submission: ${preApproval.refused}`);
      return {
        kind: 'refused', reason: 'batch_approval_refused', detail: preApproval.refused, approval: preApproval.outcome,
      };
    }
    const probe = await simulateWithRetry(deps, config, kernelAddress, batch.calldata);
    if (!probe.ok) {
      await releaseAndDie(`unsettleable at the dry run: ${probe.revertReason ?? 'simulation reverts'}`);
      return { kind: 'refused', reason: 'batch_unsettleable', detail: probe.revertReason ?? 'simulation reverts' };
    }
    const gasEstimate = await chain.estimateGas({ from: config.signerAddress, to: kernelAddress, data: batch.calldata });
    const fees = await chain.feeData();
    const gasLimit = (gasEstimate * BigInt(config.gasHeadroomBps)) / 10_000n;
    const sent = await record('original', batch.reserved_nonce, fees.maxFeePerGasWei, fees.maxPriorityFeePerGasWei, gasLimit, kernelAddress, batch.calldata);
    if (!sent.ok) {
      // Signed but never recorded => never broadcast: release it rather than strand it.
      if (sent.notRecorded) await releaseAndDie(`original not recorded: ${sent.refused}`);
      return { kind: 'stopped', reason: sent.stopReason ?? 'transaction_limit', detail: sent.refused };
    }
  }

  // ── Wait / finality / replace / retry loop over the recorded attempts. Per-batch progress
  // is bounded by the replacement budget and the run deadline (`ctx.deadline`).
  for (;;) {
    // 1. Record every newly observed receipt — as SEEN, never yet as final.
    for (const attempt of attempts.filter((a) => a.mined === null)) {
      const receipt = await chain.getReceipt(attempt.tx_hash);
      if (receipt === null) continue;
      await recordMinedReceipt(db, {
        batchId: batch.batch_id,
        txHash: attempt.tx_hash,
        nowMs: now(),
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed,
        effectiveGasPriceWei: receipt.effectiveGasPriceWei,
      });
      attempts = attempts.map((a) => (a.tx_hash === attempt.tx_hash
        ? {
            ...a,
            mined: {
              status: receipt.status,
              block_number: receipt.blockNumber,
              block_hash: receipt.blockHash.toLowerCase(),
              gas_used: receipt.gasUsed.toString(),
              effective_gas_price_wei: receipt.effectiveGasPriceWei.toString(),
            },
          }
        : a));
    }

    // 2. A mined SUCCESS (settlement or cancel) decides the batch — at safe-head depth only.
    const winner = attempts.find((a) => a.mined !== null && a.mined.status === 'success');
    if (winner !== undefined && winner.mined !== null) {
      const finality = await judgeReceiptFinality(chain, winner.tx_hash, winner.mined);
      if (finality.kind === 'final') {
        if (winner.kind === 'cancel') {
          // The cancel won, FINALLY: the nonce is resolved without a settlement.
          await markBatchDead(db, { batchId: batch.batch_id, nowMs: now(), reason: 'cancelled_dead_binding' });
          return { kind: 'dead', reason: 'cancelled_dead_binding' };
        }
        const applied = await applyConfirmedBatch(db, {
          cycleId,
          batchId: batch.batch_id,
          txHash: winner.tx_hash,
          nowMs: now(),
          final: { blockNumber: finality.blockNumber, blockHash: finality.blockHash },
        });
        if (applied.kind === 'applied' || applied.kind === 'already_applied') {
          await writeLedgerSettlement(db, { batchId: batch.batch_id, nowMs: now() });
          return { kind: 'confirmed' };
        }
        return { kind: 'stopped', reason: 'resumption_abort', detail: `apply refused: ${applied.reason}` };
      }
      if (finality.kind === 'dropped') {
        // Seen, then gone (a reorg of the unsafe head). The claim of settlement is withdrawn —
        // never applied — and the SAME signed transaction is offered again at the SAME nonce.
        log(`batch ${batch.batch_id}: receipt of ${winner.tx_hash} is not canonical (${finality.detail}); `
          + 're-driving its nonce');
        await clearMinedReceipt(db, { batchId: batch.batch_id, txHash: winner.tx_hash, nowMs: now() });
        attempts = attempts.map((a) => (a.tx_hash === winner.tx_hash ? { ...a, mined: null } : a));
        await rebroadcastAttempt(deps, config, kernelAddress, batch, winner);
        lastSubmitAt = now();
      }
      // Bounded whatever the verdict: a replica that keeps serving a receipt in a non-canonical
      // block would otherwise hold this loop forever.
      if (now() > ctx.deadline) {
        return {
          kind: 'stopped',
          reason: 'awaiting_finality',
          detail: `batch ${batch.batch_id} settle ${winner.tx_hash} mined, not yet final (${finality.detail}); `
            + 'it stays unresolved and the next run applies it at depth',
        };
      }
      await sleep(config.receiptPollIntervalMs);
      continue;
    }

    // 3. No success anywhere. The live nonce is the latest attempt's.
    const latest = attempts[attempts.length - 1];
    const revert = attempts.find((a) => a.nonce === latest.nonce && a.mined !== null && a.mined.status === 'reverted');
    if (revert !== undefined && revert.mined !== null) {
      const finality = await judgeReceiptFinality(chain, revert.tx_hash, revert.mined);
      if (finality.kind === 'dropped') {
        await clearMinedReceipt(db, { batchId: batch.batch_id, txHash: revert.tx_hash, nowMs: now() });
        attempts = attempts.map((a) => (a.tx_hash === revert.tx_hash ? { ...a, mined: null } : a));
        await rebroadcastAttempt(deps, config, kernelAddress, batch, revert);
        lastSubmitAt = now();
        // Bounded, as the winner branch is: a replica that keeps serving this revert from a
        // non-canonical block is re-recorded by step 1 and judged `dropped` again every pass,
        // so step 4's own deadline check is never reached from here.
        if (now() > ctx.deadline) {
          return {
            kind: 'stopped',
            reason: 'awaiting_finality',
            detail: `batch ${batch.batch_id} revert ${revert.tx_hash} is not canonical (${finality.detail}); `
              + 'it stays unresolved and the next run re-reads it',
          };
        }
        await sleep(config.receiptPollIntervalMs);
        continue;
      }
      if (finality.kind === 'pending') {
        if (now() > ctx.deadline) {
          return {
            kind: 'stopped',
            reason: 'awaiting_finality',
            detail: `batch ${batch.batch_id} revert ${revert.tx_hash} not yet final (${finality.detail})`,
          };
        }
        await sleep(config.receiptPollIntervalMs);
        continue;
      }
      // The live nonce is CONSUMED by our own reverted settle, at safe depth.
      if (adopted) {
        const safeBlock = await readSafeBlock(chain);
        if (safeBlock === null) {
          if (now() > ctx.deadline) {
            return { kind: 'stopped', reason: 'awaiting_finality', detail: `batch ${batch.batch_id}: no safe block` };
          }
          await sleep(config.receiptPollIntervalMs);
          continue;
        }
        const concluded = await concludeConsumedNonce(
          `adopted_reverted_final: nonce ${latest.nonce} consumed by a reverted settle at safe depth`,
          safeBlock,
        );
        if (concluded === 'recheck') {
          if (now() > ctx.deadline) {
            return {
              kind: 'stopped', reason: 'awaiting_finality',
              detail: `batch ${batch.batch_id}: a receipt changed while concluding its final revert; re-read next run`,
            };
          }
          await sleep(config.receiptPollIntervalMs);
          continue;
        }
        return concluded;
      }
      const view = await chain.observe();
      const decision = evaluateBatchResumption(binding, view, config.boundarySafetyMarginSec);
      switch (decision.kind) {
        case 'submit': {
          if (retriesAfterRevert >= 1) {
            await markBatchDead(db, { batchId: batch.batch_id, nowMs: now(), reason: 'reverted twice with a live binding' });
            return { kind: 'refused', reason: 'batch_unsettleable', detail: 'reverted twice with a live binding' };
          }
          const probe = await simulateWithRetry(deps, config, kernelAddress, batch.calldata);
          if (!probe.ok) {
            await markBatchDead(db, {
              batchId: batch.batch_id, nowMs: now(), reason: `unsettleable after revert: ${probe.revertReason ?? 'simulation reverts'}`,
            });
            return { kind: 'refused', reason: 'batch_unsettleable', detail: probe.revertReason ?? 'simulation reverts' };
          }
          const nonceResult = await allocateNonce(db, {
            cycleId, workerId: config.workerId, nowMs: now(),
          });
          if (nonceResult.kind !== 'allocated') {
            return { kind: 'stopped', reason: 'resumption_abort', detail: `nonce allocation refused: ${nonceResult.reason}` };
          }
          retriesAfterRevert += 1;
          const fees = await chain.feeData();
          const gasEstimate = await chain.estimateGas({ from: config.signerAddress, to: kernelAddress, data: batch.calldata });
          const gasLimit = (gasEstimate * BigInt(config.gasHeadroomBps)) / 10_000n;
          const sent = await record('retry_after_revert', nonceResult.nonce, fees.maxFeePerGasWei, fees.maxPriorityFeePerGasWei, gasLimit, kernelAddress, batch.calldata);
          if (!sent.ok) return { kind: 'stopped', reason: sent.stopReason ?? 'transaction_limit', detail: sent.refused };
          continue;
        }
        case 'already_settled':
          return { kind: 'stopped', reason: 'resumption_abort', detail: 'range consumed by another settle after our revert' };
        case 'hold':
          return { kind: 'stopped', reason: 'epoch_gate_closed', detail: `hold after revert: ${decision.reason}` };
        case 'rebuild':
          // Nonce already consumed by the mined revert — safe to mark dead.
          await markBatchDead(db, { batchId: batch.batch_id, nowMs: now(), reason: decision.reason });
          return { kind: 'dead', reason: decision.reason };
        case 'abort':
          return { kind: 'stopped', reason: 'resumption_abort', detail: `abort after revert: ${decision.reason}` };
      }
    }

    // 4. The live nonce is unmined.
    if (now() > ctx.deadline) {
      return {
        kind: 'stopped',
        reason: 'run_time_limit',
        detail: `nonce ${latest.nonce} of batch ${batch.batch_id} unmined at the run deadline (durable; the `
          + 'next run reconciles it)',
      };
    }
    if (now() - lastSubmitAt >= config.replaceAfterMs) {
      // (a) was the nonce consumed by a transaction this runner never recorded? At
      //     safe depth that is irreversible: none of our attempts can mine any more. If the
      //     kernel confirms none of the claims were paid, the batch is dead and its claims go
      //     back to the queue; if it says otherwise, stop loud rather than guess.
      const safeBlock = await readSafeBlock(chain);
      const consumed = safeBlock === null
        ? null
        : await nonceConsumedAtBlock(chain, config.signerAddress, latest.nonce, safeBlock);
      if (consumed === true && safeBlock !== null) {
        const concluded = await concludeConsumedNonce(
          `nonce_consumed_elsewhere: nonce ${latest.nonce} consumed at safe depth by no recorded attempt`,
          safeBlock,
        );
        if (concluded === 'recheck') {
          // Bounded by the deadline check that opens step 4 on EVERY pass back here (a recheck
          // cannot leave the live nonce unmined-and-consumed without passing through it); pinned
          // by "a flapping receipt of an earlier attempt ends the run at its deadline".
          await sleep(config.receiptPollIntervalMs);
          continue;
        }
        return concluded;
      }
      // (b) Stuck-transaction policy: replacement (same nonce, bumped fee), or a CANCEL when
      //     the binding can never settle any more.
      const view = await chain.observe();
      const decision = evaluateBatchResumption(binding, view, config.boundarySafetyMarginSec);
      const fees = await chain.feeData();
      // Bumped over the stuck attempt AND never below today's market: a stranded transaction
      // priced for yesterday's base fee would otherwise need many runs of 15% bumps to clear.
      const bumped = (value: string, floor: bigint): bigint => {
        const bump = (BigInt(value) * BigInt(10_000 + config.feeBumpBps)) / 10_000n;
        return bump > floor ? bump : floor;
      };
      const maxFee = bumped(latest.max_fee_per_gas_wei, fees.maxFeePerGasWei);
      const maxPriority = bumped(latest.max_priority_fee_per_gas_wei, fees.maxPriorityFeePerGasWei);
      if (replacementsThisRun >= config.maxReplacementsPerBatch) {
        return {
          kind: 'stopped',
          reason: 'replacement_budget_exhausted',
          detail: `nonce ${latest.nonce} unmined after ${replacementsThisRun} replacements this run `
            + '(durable; the next run\'s reconciler resumes it at the same nonce)',
        };
      }
      replacementsThisRun += 1;
      const bindingDead = decision.kind === 'rebuild'
        || decision.kind === 'already_settled'
        || (decision.kind === 'abort'
          && (decision.reason === 'cursor_partially_consumed' || decision.reason === 'cursor_gap'));
      const cancel = (): ReturnType<typeof record> => record(
        'cancel', latest.nonce, maxFee, maxPriority, 21_000n, config.signerAddress, '0x',
      );
      let sent: Awaited<ReturnType<typeof record>>;
      if (bindingDead) {
        // The binding can never settle, but the nonce may still carry a live transaction:
        // resolve it with a CANCEL at the same nonce. A mined cancel is never applied as a
        // settlement (store + kernel both refuse).
        sent = await cancel();
      } else {
        sent = await record('replacement', latest.nonce, maxFee, maxPriority, BigInt(latest.gas_limit), kernelAddress, batch.calldata);
        if (!sent.ok && sent.stopReason === 'batch_approval_refused') {
          if (sent.approval !== undefined && TRANSIENT_APPROVAL_REFUSALS.has(sent.approval.reason)) {
            // — a transient refusal says nothing about the batch: the earlier
            // attempt stays live and is waited on (the next round retries the replacement).
            // Cancelling here would kill a perfectly settleable batch over an RPC hiccup.
            log(`batch ${batch.batch_id}: replacement approval transiently refused (${sent.refused}); `
              + 'the live attempt stands');
            lastSubmitAt = now();
            await sleep(config.receiptPollIntervalMs);
            continue;
          }
          // the approval no longer holds, but the earlier attempt may still be live at
          // this nonce. Stopping here would strand it; resolve the nonce WITHOUT a settlement.
          sent = await cancel();
        }
      }
      if (!sent.ok) return { kind: 'stopped', reason: sent.stopReason ?? 'transaction_limit', detail: sent.refused };
    }

    await sleep(config.receiptPollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// applied-batch finality verification (reorg after apply)
// ---------------------------------------------------------------------------

export type AppliedBatchVerdict =
  | { readonly kind: 'canonical'; readonly blockNumber: number; readonly blockHash: string }
  | { readonly kind: 'pending'; readonly detail: string }
  | { readonly kind: 'reorged'; readonly detail: string }
  | { readonly kind: 'unknown'; readonly detail: string };

/**
 * Is this APPLIED settle still canonical at safe depth?
 *
 * `reorged` requires POSITIVE evidence on two independent axes — never the absence of an
 * answer: the block the settle was applied at is at or below the quorum safe head and the
 * canonical hash there is NOT the recorded one, AND the live kernel reports every member
 * claim unsettled. A legacy batch (applied before, no recorded block) can only be
 * confirmed, never unwound: a missing receipt there is not evidence, and unwinding a settle a
 * predecessor kernel paid would pay it twice.
 */
export async function verifyAppliedBatch(
  chain: SettlementFinalityReader,
  batch: SettlementBatchDoc,
): Promise<AppliedBatchVerdict> {
  if (!batch.applied || batch.confirmed_tx_hash === null) {
    return { kind: 'unknown', detail: 'batch is not applied' };
  }
  let receipt: MinedReceipt | null = null;
  try {
    receipt = await chain.getReceipt(batch.confirmed_tx_hash);
  } catch (error) {
    return { kind: 'unknown', detail: `receipt unreadable: ${String(error)}` };
  }
  if (receipt !== null && receipt.status === 'success') {
    const finality = await judgeReceiptFinality(chain, batch.confirmed_tx_hash, {
      status: 'success', block_number: receipt.blockNumber, block_hash: receipt.blockHash,
    });
    if (finality.kind === 'final') {
      return { kind: 'canonical', blockNumber: finality.blockNumber, blockHash: finality.blockHash };
    }
    if (finality.kind === 'pending') return { kind: 'pending', detail: finality.detail };
  }
  const recordedNumber = batch.confirmed_block_number ?? null;
  const recordedHash = batch.confirmed_block_hash ?? null;
  if (recordedNumber === null || recordedHash === null) {
    return { kind: 'unknown', detail: 'legacy batch with no recorded block: a missing receipt is not evidence' };
  }
  let safe: SafeHead | null;
  let canonical: string | null;
  try {
    safe = await chain.readSafeHead();
    canonical = await chain.getBlockHash(recordedNumber);
  } catch (error) {
    return { kind: 'unknown', detail: `chain unreadable: ${String(error)}` };
  }
  if (safe === null || safe.number < recordedNumber || canonical === null) {
    return { kind: 'unknown', detail: `no canonical answer at ${recordedNumber} yet` };
  }
  if (canonical.toLowerCase() === recordedHash.toLowerCase()) {
    return { kind: 'unknown', detail: `block ${recordedNumber} still canonical but the receipt is not returned` };
  }
  // The kernel is asked at the SAME safe block the canonical hash was judged against: a member it
  // reads paid there was paid (by this settle or another), and a paid claim is never unwound.
  const settled = await memberSettlement(chain, batch.members, safe.number);
  if (settled.kind !== 'read' || settled.settled.length > 0) {
    return {
      kind: 'unknown',
      detail: `block ${recordedNumber} is no longer ${recordedHash}, but the kernel reads the members `
        + `${describeSettlement(settled, batch.members.length)} at safe block ${safe.number}`,
    };
  }
  return {
    kind: 'reorged',
    detail: `settle ${batch.confirmed_tx_hash} was applied at ${recordedNumber}/${recordedHash}; the canonical `
      + `block there is ${canonical} and the kernel reads every member unsettled`,
  };
}

async function readBatchDoc(db: SettlementDb, batchId: string): Promise<SettlementBatchDoc | null> {
  const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(batchId.toLowerCase()).get();
  const data = snap.exists ? snap.data() : undefined;
  return data !== undefined && data.schema_version === SETTLEMENT_BATCH_SCHEMA
    ? (data as unknown as SettlementBatchDoc)
    : null;
}

async function listCycleBatches(db: SettlementDb, cycleId: string): Promise<SettlementBatchDoc[]> {
  const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION).where('cycle_id', '==', cycleId).get();
  return snap.docs
    .map((doc) => doc.data())
    .filter((data): data is Record<string, unknown> => data !== undefined && data.schema_version === SETTLEMENT_BATCH_SCHEMA)
    .map((data) => data as unknown as SettlementBatchDoc);
}

/** Applied batches the sweep examines per run (each is a handful of reads). */
export const APPLIED_FINALITY_SWEEP_BATCHES_PER_RUN = 50;

/**
 * Sweep APPLIED batches that need a finality answer — newest cursor first, so a reorged tip is
 * unwound before anything built on it:
 * - every batch not yet finality-verified (applied before at one confirmation, or a
 * crash left it unstamped);
 * - AND every batch whose range the chain's cursor does not cover (`cursor_end` above the
 * kernel's `nextFinalizedCursor`): whatever its stamp says, the chain is not reflecting that
 * settle, which is exactly what a reorg of it looks like. (Replica lag looks the same for a
 * moment; the verdict below needs POSITIVE evidence, so lag is answered `canonical`/`unknown`
 * and nothing is unwound.)
 * Bounded per run; a batch it cannot verify is reported and retried next run, never unwound on
 * absence of evidence.
 */
async function sweepAppliedBatchFinality(
  deps: CycleRunnerDeps,
  config: CycleRunnerConfig,
  deadline: number,
  chainCursor: bigint | null,
): Promise<{ verified: number; reorged: number; unverifiable: number }> {
  const { db, now } = deps;
  const log = deps.log ?? (() => undefined);
  // PE METER cost pass: read from the sweep's index (open or uncovered batches only), never every
  // cycle and batch the signer ever settled (`listFinalitySweepCandidates`).
  const candidates = await listFinalitySweepCandidates(db, {
    signer: config.signerAddress, chainCursor, nowMs: now(),
  });
  candidates.sort((a, b) => (BigInt(a.cursor_end) > BigInt(b.cursor_end) ? -1 : 1));
  let verified = 0;
  let reorged = 0;
  let unverifiable = 0;
  for (const batch of candidates.slice(0, APPLIED_FINALITY_SWEEP_BATCHES_PER_RUN)) {
    if (now() > deadline) break;
    const verdict = await verifyAppliedBatch(deps.chain, batch);
    if (verdict.kind === 'canonical') {
      await markBatchFinalityVerified(db, {
        batchId: batch.batch_id, nowMs: now(), blockNumber: verdict.blockNumber, blockHash: verdict.blockHash,
      });
      verified += 1;
    } else if (verdict.kind === 'reorged') {
      const reverted = await revertReorgedBatch(db, { batchId: batch.batch_id, nowMs: now(), reason: verdict.detail });
      log(`FINALITY SWEEP: batch ${batch.batch_id} REORGED (${verdict.detail}) -> ${reverted.kind}`
        + `${reverted.kind === 'refused' ? `:${reverted.reason}` : ''}`);
      if (reverted.kind === 'reverted') reorged += 1; else unverifiable += 1;
    } else if (verdict.kind === 'unknown') {
      unverifiable += 1;
      log(`FINALITY SWEEP: batch ${batch.batch_id} unverifiable (${verdict.detail}) — left as applied`);
    }
  }
  return { verified, reorged, unverifiable };
}

// ---------------------------------------------------------------------------
// the cross-cycle reconciler
// ---------------------------------------------------------------------------

/**
 * Resolve every settlement this signer has in flight, in ANY cycle, before anything new is sent.
 *
 * The defect this closes: every stop except `broadcast_failed` closed its cycle, a closed cycle
 * is never re-leased, and `listUnresolvedBatches` only ever looked at the cycle being run — so
 * a `submitted` batch stopped by `replacement_budget_exhausted`, `transaction_limit`, an
 * approval refusal on a replacement, a post-revert hold/abort, or `resumption_abort` was
 * stranded forever. If its transaction later mined, the chain carried settled claims the ledger
 * still called unsettled; if it never did, its claims stayed reserved and every later run
 * aborted on them (up to the 20 daily supersessions). The next cycle also re-read the base
 * nonce from `latest` and re-used the stranded nonce.
 *
 * MUST run under the signer lease (the caller holds it). It (1) sweeps applied batches for
 * finality, then (2) adopts every unresolved batch not owned by a live worker and drives it to
 * a terminal state at the nonce it already holds. Whatever is left unresolved is returned, and
 * the caller sends NOTHING new while that list is non-empty.
 */
export async function reconcileStrandedSettlements(
  deps: CycleRunnerDeps,
  config: CycleRunnerConfig,
  params: {
    readonly deadline: number;
    readonly kernelAddress: string;
    readonly excludeCycleId?: string;
    /** The kernel's `nextFinalizedCursor` as just observed; null skips the coverage check. */
    readonly chainCursor?: bigint | null;
  },
): Promise<ReconciliationReport> {
  const { db, now } = deps;
  const log = deps.log ?? (() => undefined);
  const signer = config.signerAddress.toLowerCase();

  const sweep = await sweepAppliedBatchFinality(deps, config, params.deadline, params.chainCursor ?? null);

  const cycles = new Map<string, SettlementCycleDoc | null>();
  const cycleOf = async (cycleId: string): Promise<SettlementCycleDoc | null> => {
    if (!cycles.has(cycleId)) {
      const snap = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(cycleId).get();
      const data = snap.exists ? snap.data() : undefined;
      cycles.set(cycleId, data !== undefined ? (data as unknown as SettlementCycleDoc) : null);
    }
    return cycles.get(cycleId) ?? null;
  };

  let adopted = 0;
  let confirmed = 0;
  let dead = 0;
  const still: Array<{ batchId: string; cycleId: string; status: string; detail: string }> = [];
  for (const batch of await listAllUnresolvedBatches(db)) {
    if (params.excludeCycleId !== undefined && batch.cycle_id === params.excludeCycleId) continue;
    const cycle = await cycleOf(batch.cycle_id);
    if (cycle === null || cycle.signer.toLowerCase() !== signer) continue;
    const leasedElsewhere = cycle.status === 'active'
      && cycle.lease.expires_at_ms > now()
      && cycle.lease.owner !== config.workerId;
    if (leasedElsewhere) {
      still.push({
        batchId: batch.batch_id, cycleId: batch.cycle_id, status: batch.status,
        detail: 'its cycle lease is held by a live worker; adopted after that lease expires',
      });
      continue;
    }
    if (now() > params.deadline) {
      still.push({ batchId: batch.batch_id, cycleId: batch.cycle_id, status: batch.status, detail: 'run deadline' });
      continue;
    }
    adopted += 1;
    log(`RECONCILE: adopting ${batch.status} batch ${batch.batch_id} (cycle ${batch.cycle_id}, nonce ${batch.reserved_nonce})`);
    const resolution = await resolveBatch(deps, config, {
      mode: 'adopted', deadline: params.deadline, kernelAddress: params.kernelAddress,
    }, batch);
    if (resolution.kind === 'confirmed') {
      confirmed += 1;
      log(`RECONCILE: batch ${batch.batch_id} confirmed at depth and written back`);
    } else if (resolution.kind === 'dead' || resolution.kind === 'refused') {
      dead += 1;
      log(`RECONCILE: batch ${batch.batch_id} dead (${resolution.kind === 'dead' ? resolution.reason : resolution.detail}); `
        + 'its claims return to the queue');
    } else {
      still.push({
        batchId: batch.batch_id, cycleId: batch.cycle_id, status: batch.status,
        detail: `${resolution.reason}: ${resolution.detail}`,
      });
    }
  }
  const heldSettledOnChain = await reconcileHeldClaims(deps, params.deadline);
  return {
    adopted,
    confirmed,
    dead,
    stillUnresolved: still,
    appliedVerified: sweep.verified,
    appliedReorged: sweep.reorged,
    appliedUnverifiable: sweep.unverifiable,
    heldSettledOnChain,
  };
}

/** Held claims the reconciler re-asks the kernel about per run. */
export const HELD_CLAIM_RECHECK_PER_RUN = 200;

/**
 * — a HELD claim the kernel reads PAID at the safe block is recorded settled
 * from chain evidence. Without this, a claim paid by a settle whose receipt the ledger never
 * saw would be held, retried, refused (`ClaimAlreadySettled`), and held again, forever — and
 * neither the ledger nor `pe_history` would ever record the payment. Read-only on the chain;
 * an unreadable kernel or no safe block leaves every hold as it is.
 */
async function reconcileHeldClaims(deps: CycleRunnerDeps, deadline: number): Promise<number> {
  const log = deps.log ?? (() => undefined);
  const held = await listHeldClaims(deps.db, HELD_CLAIM_RECHECK_PER_RUN);
  if (held.length === 0) return 0;
  const safeBlock = await readSafeBlock(deps.chain);
  if (safeBlock === null) return 0;
  const paid: ClaimLedgerRow[] = [];
  for (const row of held) {
    if (deps.now() > deadline) break;
    try {
      if (await deps.chain.isClaimSettled(row.claim_id, safeBlock)) paid.push(row);
    } catch {
      // Unreadable: the hold stands; asked again next run.
    }
  }
  if (paid.length === 0) return 0;
  const recorded = await settleClaimsFromChainEvidence(deps.db, {
    nowMs: deps.now(),
    claims: paid.map((row) => ({ claimKey: row.claim_key, claimId: row.claim_id })),
    evidence: {
      safe_block: safeBlock,
      reason: 'held claim: the kernel reads it settled at the safe block',
      concluding_batch_id: null,
    },
  });
  log(`RECONCILE: ${recorded.settled.length} held claim(s) read PAID by the kernel at safe block ${safeBlock}; `
    + 'recorded settled from chain evidence');
  return recorded.settled.length;
}

/**
 * The first nonce a cycle may allocate: never below the canonical mined
 * count or a durable signed attempt, and never at or below any nonce an unresolved batch holds or any attempt of this cycle
 * has mined at. Taken AFTER reconciliation, so it re-uses a nonce that a dead, never-broadcast
 * reservation left behind (no gap) and never one that may still carry a transaction.
 */
export async function seedCycleNonce(
  deps: CycleRunnerDeps,
  config: CycleRunnerConfig,
): Promise<number> {
  const latestCount = await deps.chain.getTransactionCount(config.signerAddress, 'latest');
  const journalSnap = await deps.db.collection('evm_signer_nonce_journals_v1')
    .doc(`8453_${config.signerAddress.toLowerCase()}`).get();
  const journal = parseNonceJournal(journalSnap.exists ? journalSnap.data() : null);
  for (const attempt of journal?.attempts ?? []) {
    if (attempt.nonce < latestCount) continue;
    if (!attempt.ready) throw new Error('nonce_uncommitted_attempt');
    const decoded = Transaction.from(attempt.raw);
    if (decoded.hash !== attempt.hash || decoded.from?.toLowerCase() !== config.signerAddress.toLowerCase()
      || decoded.chainId !== 8453n || decoded.nonce !== attempt.nonce) throw new Error('nonce_attempt_binding_invalid');
    try { await deps.chain.broadcast(attempt.raw); }
    catch (error) { if (!/already known|already imported/i.test(String(error))) throw error; }
  }
  let seed = Math.max(latestCount, journal?.next ?? 0);
  const unresolved = new Set<string>(['reserved', 'submitted', 'mined']);
  const consider = (batch: SettlementBatchDoc, includeUnmined: boolean): void => {
    if (includeUnmined) seed = Math.max(seed, batch.reserved_nonce + 1);
    for (const attempt of batch.attempts) {
      if (includeUnmined || attempt.mined !== null) seed = Math.max(seed, attempt.nonce + 1);
    }
  };
  for (const batch of await listCycleBatches(deps.db, config.cycleId)) {
    consider(batch, unresolved.has(batch.status));
  }
  // Only THIS signer's batches: another signer's nonce (a rotated minter's stranded batch)
  // would otherwise push the seed up and leave a gap no transaction of ours can ever fill.
  const signer = config.signerAddress.toLowerCase();
  const cycleSigner = new Map<string, string | null>();
  for (const batch of await listAllUnresolvedBatches(deps.db)) {
    if (!cycleSigner.has(batch.cycle_id)) {
      const snap = await deps.db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(batch.cycle_id).get();
      const data = snap.exists ? snap.data() : undefined;
      cycleSigner.set(batch.cycle_id, typeof data?.signer === 'string' ? data.signer.toLowerCase() : null);
    }
    if (cycleSigner.get(batch.cycle_id) === signer) consider(batch, true);
  }
  return seed;
}

// ---------------------------------------------------------------------------
// poisoned-claim isolation
// ---------------------------------------------------------------------------

/** Approval refusals that say nothing about any one claim — a config or code fault. */
const SYSTEMIC_APPROVAL_REFUSALS: ReadonlySet<ApprovalRefusal> = new Set<ApprovalRefusal>([
  'approver_unavailable',
  'calldata_undecodable',
  'lane_mismatch',
  'header_mismatch',
  'member_set_mismatch',
  'digest_disagreement',
  // — an RPC/Firestore throw or approve-read lag is the moment, not a claim.
  // `approveWithRetry` has already retried it; still refused, it stops the run holding nothing.
  'approval_call_failed',
  'approval_not_affirmed',
]);

/** Plan rejections that are the operator's configuration, not a claim. */
const SYSTEMIC_PLAN_REASONS = [
  'invalid_limits', 'invalid_gas_model', 'invalid_cursor', 'limits_exceed_kernel_ceiling', 'limits_admit_no_batch',
];

/** On-chain probes (approve + dry run) one isolation may spend. ~2·log2(1000) for one poison. */
export const MAX_ISOLATION_PROBES = 24;
/** Isolations one run may perform before it stops (a queue that keeps poisoning is systemic). */
export const MAX_ISOLATIONS_PER_RUN = 8;

class SystemicRefusal extends Error {}

type IsolationResult =
  | {
    readonly kind: 'held';
    readonly held: readonly HeldClaimReport[];
    /** Claims the kernel reads PAID at the safe block: recorded settled, never held. */
    readonly chainSettled?: { readonly rows: readonly ClaimLedgerRow[]; readonly safeBlock: number };
  }
  /**
   * — a COMBINATION failure: the whole batch fails, yet every part of it settles
   * on its own (two grants that together cross the Genesis wallet ceiling, a duplicate anchor).
   * No claim is at fault; the run settles the parts in smaller batches instead of stopping.
   */
  | { readonly kind: 'split'; readonly detail: string }
  | { readonly kind: 'systemic'; readonly detail: string };

interface IsolationContext {
  readonly deps: CycleRunnerDeps;
  readonly config: CycleRunnerConfig;
  readonly view: CycleChainObservation;
  readonly cursor: bigint;
  readonly probeCounter: { next: number };
  /**
   * True once a batch has CONFIRMED in this run: the verifier and kernel demonstrably settle,
   * so a claim that fails alone is claim-specific even when no control batch is available.
   */
  readonly systemProven: boolean;
}

/**
 * Rows → work items in the same shape selection builds: one item per (contributor, class) on
 * the standard lane, per contributor on Genesis, contributor-ascending. A subset that carries two
 * classes of one contributor plans as a duplicate contributor and is simply split further.
 */
function itemsFromRows(rows: readonly ClaimLedgerRow[]): SettlementWorkItem[] {
  const groups = new Map<string, ClaimLedgerRow[]>();
  for (const row of rows) {
    const key = row.lane === 'standard' ? `${row.contributor}#${String(row.beneficiary_class)}` : row.contributor;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.values()]
    .sort((a, b) => (BigInt(a[0].contributor) < BigInt(b[0].contributor) ? -1
      : BigInt(a[0].contributor) > BigInt(b[0].contributor) ? 1 : 0))
    .map((list) => ({ contributor: list[0].contributor, claimIds: list.map((row) => row.claim_id) }));
}

function probeDocFor(
  ctx: IsolationContext,
  plan: PlannedLaneBatch,
  batchId: string,
  calldata: string,
): SettlementBatchDoc {
  return {
    schema_version: SETTLEMENT_BATCH_SCHEMA,
    batch_id: batchId.toLowerCase(),
    cycle_id: ctx.config.cycleId,
    lane: plan.lane,
    epoch: Number(ctx.view.lastOpenedEpoch),
    policy_hash: ctx.view.openEpochPolicyHash.toLowerCase(),
    cursor_start: plan.cursorStart.toString(),
    cursor_end: plan.cursorEnd.toString(),
    recipient_count: plan.recipientCount,
    claim_count: plan.claimCount,
    total_minted_atomic: plan.totalMintedAtomic.toString(),
    reserved_nonce: -1,
    calldata,
    members: plan.members,
    status: 'reserved',
    dead_reason: null,
    attempts: [],
    confirmed_tx_hash: null,
    confirmed_fee_wei: null,
    applied: false,
    writebacks_complete: false,
    created_at: ctx.deps.now(),
    updated_at: ctx.deps.now(),
  } as unknown as SettlementBatchDoc;
}

/**
 * Would this exact set of claims settle? Approve (a real verifier record, never a settlement —
 * the probe is never signed or sent) and dry-run it at the live cursor. Deterministic plan
 * failures answer false with no chain call. A SYSTEMIC approval refusal is thrown: it says
 * nothing about these claims and must not be read as "these claims are poisoned".
 */
async function probeSettles(
  ctx: IsolationContext,
  plan: PlannedLaneBatch,
): Promise<boolean> {
  const probeId = deriveSettlementBatchId({
    cycleId: ctx.config.cycleId,
    lane: plan.lane,
    cursorStart: plan.cursorStart,
    rebuildIndex: 0,
    probe: ctx.probeCounter.next,
  });
  ctx.probeCounter.next += 1;
  const encoded = plan.encode(probeId);
  if ('error' in encoded) return false;
  const approval = await approveWithRetry(ctx.deps, ctx.config, probeDocFor(ctx, plan, probeId, encoded.data));
  if (approval.kind !== 'approved') {
    if (SYSTEMIC_APPROVAL_REFUSALS.has(approval.reason)) throw new SystemicRefusal(approval.detail);
    return false;
  }
  const simulation = await simulateWithRetry(ctx.deps, ctx.config, ctx.view.kernelAddress, encoded.data);
  return simulation.ok;
}

/** A pure check: does this set of claims plan and encode into a well-formed batch? */
function planIsWellFormed(
  ctx: IsolationContext,
  work: LaneWork,
  rows: readonly ClaimLedgerRow[],
): PlannedLaneBatch | null {
  const items = itemsFromRows(rows);
  const planned = planSettlementBatches(items, ctx.config.batchLimits, ctx.config.gasModel, ctx.cursor);
  if (planned.kind === 'rejected' || planned.batches.length !== 1) return null;
  const built = buildLaneBatch(work, items, ctx.cursor, ctx.view);
  if (built.kind === 'rejected') return null;
  const encoded = built.batch.encode(`0x${'0'.repeat(63)}1`);
  return 'error' in encoded ? null : built.batch;
}

function holdSpec(row: ClaimLedgerRow, reason: string, detail: string): HeldClaimReport {
  return { claimKey: row.claim_key, reason, detail };
}

/**
 * Find the claims that poison a refused or unsettleable batch.
 *
 * Bisection over the batch's claims: a half that settles is clean, a failing half is split
 * again, and a failing single claim is a suspect. A suspect is HELD only once something else
 * has been shown to settle — during the bisection, or by a CONTROL batch drawn from the rest of
 * the queue — because if nothing settles at all the fault is the system (an unreachable
 * verifier, a halted kernel), and holding claims for it would quarantine the whole queue.
 */
async function isolateByBisection(
  ctx: IsolationContext,
  work: LaneWork,
  rows: readonly ClaimLedgerRow[],
  otherWork: { readonly genesis: LaneWork; readonly standard: LaneWork },
  reason: string,
  detail: string,
): Promise<IsolationResult> {
  let probes = 0;
  let anySuccess = false;
  const failing: ClaimLedgerRow[] = [];
  let budgetExhausted = false;
  const search = async (set: readonly ClaimLedgerRow[], knownFailing: boolean): Promise<void> => {
    if (budgetExhausted) return;
    if (!knownFailing) {
      const plan = planIsWellFormed(ctx, work, set);
      if (plan !== null) {
        if (probes >= MAX_ISOLATION_PROBES) {
          budgetExhausted = true;
          return;
        }
        probes += 1;
        if (await probeSettles(ctx, plan)) {
          anySuccess = true;
          return;
        }
      }
    }
    if (set.length === 1) {
      failing.push(set[0]);
      return;
    }
    const mid = Math.ceil(set.length / 2);
    await search(set.slice(0, mid), false);
    await search(set.slice(mid), false);
  };
  try {
    await search(rows, true);
  } catch (error) {
    if (error instanceof SystemicRefusal) return { kind: 'systemic', detail: `systemic approval refusal: ${error.message}` };
    throw error;
  }
  if (budgetExhausted) {
    return { kind: 'systemic', detail: `${detail} — isolation probe budget (${MAX_ISOLATION_PROBES}) exhausted` };
  }
  if (failing.length === 0) {
    return { kind: 'split', detail: `${detail} — every part of the batch settles alone; settling the parts separately` };
  }
  if (!anySuccess && !ctx.systemProven) {
    // Nothing settled during the bisection. Try ONE control batch from the rest of the queue.
    const failingIds = new Set(failing.map((row) => row.claim_id));
    const minus = (lane: LaneWork): LaneWork => ({
      ...lane,
      items: lane.items
        .map((item) => ({ ...item, claimIds: item.claimIds.filter((id) => !failingIds.has(id)) }))
        .filter((item) => item.claimIds.length > 0),
    });
    const control = planNextBatch(ctx.config, ctx.view, ctx.cursor, minus(otherWork.genesis), minus(otherWork.standard));
    if (control.kind !== 'batch') {
      return { kind: 'systemic', detail: `${detail} — no other work to show the failure is claim-specific` };
    }
    try {
      if (!(await probeSettles(ctx, control.batch))) {
        return { kind: 'systemic', detail: `${detail} — the control batch fails too` };
      }
    } catch (error) {
      if (error instanceof SystemicRefusal) return { kind: 'systemic', detail: `systemic approval refusal: ${error.message}` };
      throw error;
    }
  }
  return { kind: 'held', held: failing.map((row) => holdSpec(row, reason, detail)) };
}

/** Isolate the claims of a batch that was refused or found unsettleable (the batch is dead). */
async function isolateRefusedBatch(
  ctx: IsolationContext,
  batch: SettlementBatchDoc,
  refusal: Extract<BatchResolution, { kind: 'refused' }>,
  selection: { readonly genesis: LaneWork; readonly standard: LaneWork },
): Promise<IsolationResult> {
  if (refusal.approval !== undefined && SYSTEMIC_APPROVAL_REFUSALS.has(refusal.approval.reason)) {
    return { kind: 'systemic', detail: refusal.detail };
  }
  const work = batch.lane === 'genesis' ? selection.genesis : selection.standard;
  const rows = batch.members
    .map((member) => work.rowsByClaimId.get(member.claim_id))
    .filter((row): row is ClaimLedgerRow => row !== undefined);
  if (rows.length === 0) return { kind: 'systemic', detail: `${refusal.detail} — no member is re-selectable` };

  // The approval gate names ineligible claims itself: a deterministic, per-claim verdict.
  if (refusal.approval?.reason === 'candidate_ineligible' && (refusal.approval.ineligible?.length ?? 0) > 0) {
    const byClaim = new Map(rows.map((row) => [row.claim_id.toLowerCase(), row]));
    const held = (refusal.approval.ineligible ?? [])
      .map((entry) => {
        const row = byClaim.get(entry.claimId.toLowerCase());
        return row === undefined ? null : holdSpec(row, 'candidate_ineligible', entry.reasons.join('+'));
      })
      .filter((spec): spec is HeldClaimReport => spec !== null);
    if (held.length > 0) return { kind: 'held', held };
  }

  // An unsettleable batch: the kernel names any member it has ALREADY paid. That is a claim the
  // ledger calls unpaid and the chain calls paid — held and alarmed, never re-sent.
  //
  // : read at the SAFE block. A claim paid there is RECORDED settled from chain
  // evidence (it can never be offered again, and holding it would loop it forever); one paid at
  // `latest` but not yet at the safe block is held until it is (the held-claim re-check settles
  // it on a later run).
  if (refusal.reason === 'batch_unsettleable') {
    const safeBlock = await readSafeBlock(ctx.deps.chain);
    const paidAtSafe: ClaimLedgerRow[] = [];
    const paidAboveSafe: HeldClaimReport[] = [];
    for (const row of rows) {
      try {
        if (safeBlock !== null && await ctx.deps.chain.isClaimSettled(row.claim_id, safeBlock)) {
          paidAtSafe.push(row);
        } else if (await ctx.deps.chain.isClaimSettled(row.claim_id)) {
          paidAboveSafe.push(holdSpec(row, 'claim_settled_on_chain',
            'the kernel reads this claim settled above the safe block; recorded once it is final'));
        }
      } catch {
        // Unreadable is not evidence either way: the bisection below decides.
      }
    }
    if (paidAtSafe.length > 0 || paidAboveSafe.length > 0) {
      return {
        kind: 'held',
        held: paidAboveSafe,
        ...(paidAtSafe.length > 0 && safeBlock !== null ? { chainSettled: { rows: paidAtSafe, safeBlock } } : {}),
      };
    }
  }

  const reason = refusal.approval !== undefined ? `approval_${refusal.approval.reason}` : refusal.reason;
  return isolateByBisection(ctx, work, rows, selection, reason, refusal.detail);
}

/** Isolate the claims behind a deterministic PLAN/ENCODE rejection. Pure — no chain calls. */
function isolatePlanRejection(
  ctx: IsolationContext,
  selection: { readonly genesis: LaneWork; readonly standard: LaneWork },
  reason: string,
): Extract<IsolationResult, { kind: 'held' | 'systemic' }> {
  if (SYSTEMIC_PLAN_REASONS.some((systemic) => reason.includes(systemic))) {
    return { kind: 'systemic', detail: reason };
  }
  const held: HeldClaimReport[] = [];
  let anyWellFormed = false;
  for (const work of [selection.genesis, selection.standard]) {
    for (const item of work.items) {
      const rows = item.claimIds
        .map((id) => work.rowsByClaimId.get(id))
        .filter((row): row is ClaimLedgerRow => row !== undefined);
      if (planIsWellFormed(ctx, work, rows) !== null) {
        anyWellFormed = true;
        continue;
      }
      for (const row of rows) {
        if (planIsWellFormed(ctx, work, [row]) === null) {
          held.push(holdSpec(row, 'batch_plan_rejected', reason));
        } else {
          anyWellFormed = true;
        }
      }
    }
  }
  if (held.length === 0 || !anyWellFormed) {
    return { kind: 'systemic', detail: `${reason} — not attributable to individual claims` };
  }
  return { kind: 'held', held };
}

// ---------------------------------------------------------------------------
// The cycle
// ---------------------------------------------------------------------------

function report(
  cycle: SettlementCycleDoc | null,
  base: {
    cycleId: string;
    outcome: 'completed' | 'stopped' | 'refused';
    stopReason: CycleStopReason | null;
    detail: string | null;
    deferredClaims: number;
    resumedBatches: number;
    heldClaims?: readonly HeldClaimReport[];
    reconciliation?: ReconciliationReport | null;
  },
): CycleRunReport {
  return {
    cycleId: base.cycleId,
    outcome: base.outcome,
    stopReason: base.stopReason,
    detail: base.detail,
    batchesConfirmed: cycle?.consumed.batches_confirmed ?? 0,
    claimsSettled: cycle?.consumed.claims_settled ?? 0,
    recipientsSettled: cycle?.consumed.recipients_settled ?? 0,
    transactionsSubmitted: cycle?.consumed.transactions_submitted ?? 0,
    replacementsSubmitted: cycle?.consumed.replacements_submitted ?? 0,
    feeWeiSpent: BigInt(cycle?.consumed.fee_wei_spent ?? '0'),
    deferredClaims: base.deferredClaims,
    resumedBatches: base.resumedBatches,
    claimsHeld: base.heldClaims?.length ?? 0,
    heldClaims: base.heldClaims ?? [],
    reconciliation: base.reconciliation ?? null,
  };
}

async function readCycleOrThrow(db: SettlementDb, cycleId: string): Promise<SettlementCycleDoc> {
  const snap = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(cycleId).get();
  const data = snap.exists ? snap.data() : undefined;
  if (data === undefined) throw new Error(`cycle ${cycleId} vanished`);
  return data as unknown as SettlementCycleDoc;
}

/**
 * Run (or resume) one settlement cycle. Serial per-batch protocol:
 * signer lease → reconcile every stranded batch (any cycle) → observe → gate → seed the nonce
 * → lease → select → plan (cap-fitted) → fee/tx limit checks → reserve → approve → dry-run →
 * sign → record-before-broadcast → receipt + replacement loop → FINALITY at safe-head depth →
 * exactly-once apply → ledger writebacks → next batch. Every stop is graceful and durable: the
 * cycle doc records why, unsettled claims stay in the ledger as backlog, a broadcast batch is
 * reconciled by a later run whatever the stop, and a claim that poisons its batch is held so
 * the rest keeps settling.
 */
async function runSettlementCycleAttempt(
  deps: CycleRunnerDeps,
  config: CycleRunnerConfig,
): Promise<CycleRunReport> {
  const { db, chain, now } = deps;
  const log = deps.log ?? (() => undefined);
  const deadline = now() + config.maxRunMs;
  const heldClaims: HeldClaimReport[] = [];
  let reconciliation: ReconciliationReport | null = null;

  // ── one run per signer. Taken BEFORE anything reads a nonce or touches a batch.
  const signerLease = await acquireSignerLease(db, {
    signer: config.signerAddress, workerId: config.workerId, nowMs: now(), leaseTtlMs: config.leaseTtlMs,
  });
  if (signerLease.kind !== 'acquired') {
    return report(null, {
      cycleId: config.cycleId,
      outcome: 'refused',
      stopReason: 'lease_refused',
      detail: `signer_lease_held:${signerLease.owner}`,
      deferredClaims: 0,
      resumedBatches: 0,
    });
  }

  try {
    const stop = async (
      reason: CycleStopReason,
      detail: string | null,
      extras: { deferredClaims: number; resumedBatches: number },
      status: 'completed' | 'stopped' = 'stopped',
    ): Promise<CycleRunReport> => {
      // `broadcast_failed` still leaves the cycle OPEN (a same-cycle resume adjudicates the
      // recorded attempt first). that is no longer what keeps the attempt reachable —
      // the cross-cycle reconciler reaches a batch in ANY cycle — so every other stop closes
      // its cycle safely. The lease is released either way (in `finally`): worker ids are
      // unique per run, and a lease left standing would refuse the next run until its TTL.
      if (reason === 'broadcast_failed' && status !== 'completed') {
        const open = await readCycleOrThrow(db, config.cycleId);
        return report(open, {
          cycleId: config.cycleId, outcome: 'stopped', stopReason: reason, detail, ...extras, heldClaims, reconciliation,
        });
      }
      await closeCycle(db, {
        cycleId: config.cycleId,
        workerId: config.workerId,
        nowMs: now(),
        status,
        stopReason: status === 'completed' ? null : reason,
      });
      const cycle = await readCycleOrThrow(db, config.cycleId);
      return report(cycle, {
        cycleId: config.cycleId,
        outcome: status === 'completed' ? 'completed' : 'stopped',
        stopReason: reason,
        detail,
        ...extras,
        heldClaims,
        reconciliation,
      });
    };

    // ── reconcile every stranded batch of this signer, in any cycle, FIRST. The
    // cycle about to run is excluded only when it is still active (its own resume path owns
    // its batches); a closed cycle's batches are adopted like any other.
    const preReconcile = await chain.observe();
    const ownSnap = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(config.cycleId).get();
    const ownActive = ownSnap.exists && (ownSnap.data() ?? {}).status === 'active';
    reconciliation = await reconcileStrandedSettlements(deps, config, {
      deadline,
      kernelAddress: preReconcile.kernelAddress,
      chainCursor: preReconcile.nextFinalizedCursor,
      ...(ownActive ? { excludeCycleId: config.cycleId } : {}),
    });

    // ── Observe — AFTER reconciliation. An adopted batch that settled (or a reorged one that
    // was unwound) moved the kernel cursor; a cycle seeded from the pre-reconcile view would
    // start behind the chain and read our own adopted settle as a rogue one.
    const observation = await chain.observe();
    if (reconciliation.stillUnresolved.length > 0) {
      const first = reconciliation.stillUnresolved[0];
      return report(null, {
        cycleId: config.cycleId,
        outcome: 'stopped',
        stopReason: 'stranded_batch_pending',
        detail: `${reconciliation.stillUnresolved.length} batch(es) from earlier runs still hold a live nonce `
          + `(first: ${first.batchId} in ${first.cycleId}, ${first.status}: ${first.detail}); nothing new is `
          + 'sent on this signer until they resolve',
        deferredClaims: 0,
        resumedBatches: 0,
        heldClaims,
        reconciliation,
      });
    }

    // ── Gate.
    const gate = evaluateEpochGate(observation, config.boundarySafetyMarginSec);
    if (gate.kind === 'closed') {
      return report(null, {
        cycleId: config.cycleId,
        outcome: 'refused',
        stopReason: gate.reason === 'boundary_margin' ? 'boundary_margin' : 'epoch_gate_closed',
        detail: gate.reason,
        deferredClaims: 0,
        resumedBatches: 0,
        reconciliation,
      });
    }
    if (gate.kind === 'advance_required') {
      return report(null, {
        cycleId: config.cycleId,
        outcome: 'refused',
        stopReason: 'epoch_advance_required',
        detail: `wall-clock epoch ${gate.wallClockEpoch} > last opened ${gate.lastOpenedEpoch}`,
        deferredClaims: 0,
        resumedBatches: 0,
        reconciliation,
      });
    }
    const epoch = gate.epoch;
    const policyHash = observation.openEpochPolicyHash;

    // ── Lease. the nonce is SEEDED from max(canonical latest, durable signed attempts, every nonce still held) —
    // taken after reconciliation — and re-seeded on a renew, so neither a stranded nonce nor a
    // gap left by a dead reservation survives into this cycle.
    const seed = await seedCycleNonce(deps, config);
    const acquired = await acquireCycleLease(db, {
      cycleId: config.cycleId,
      workerId: config.workerId,
      nowMs: now(),
      leaseTtlMs: config.leaseTtlMs,
      epoch,
      policyHash,
      signer: config.signerAddress,
      baseNonce: seed,
      reseedNonce: seed,
      limits: {
        max_transactions: config.limits.maxTransactions,
        max_fee_wei_total: config.limits.maxFeeWeiTotal.toString(),
      },
      cursorStart: observation.nextFinalizedCursor,
    });
    if (acquired.kind !== 'acquired') {
      return report(null, {
        cycleId: config.cycleId,
        outcome: 'refused',
        stopReason: 'lease_refused',
        detail: acquired.reason,
        deferredClaims: 0,
        resumedBatches: 0,
        reconciliation,
      });
    }

    const probeCounter = { next: 0 };
    let isolations = 0;
    // Ledger rows this run has already twin-checked (`auditLedgerSinceWatermark`): a re-selection
    // re-reads the overlap but does not re-query a row it already cleared.
    const auditedThisRun = new Set<string>();
    // — the run's own planning limits. A COMBINATION failure (every part settles,
    // the whole does not) halves them for the rest of the run so the parts settle separately.
    let runConfig: CycleRunnerConfig = config;
    // A batch confirmed in this run proves the verifier and kernel settle (isolation evidence).
    let confirmedThisRun = 0;
    /**
     * A batch came back REFUSED (it is already dead, its claims released). Isolate and hold the
     * claims that caused it, then keep settling; a refusal that is not attributable to claims
     * stops the run with the original reason (and the next run tries again).
     */
    const handleRefusal = async (
      refusedBatch: SettlementBatchDoc,
      refusal: Extract<BatchResolution, { kind: 'refused' }>,
      extras: { deferredClaims: number; resumedBatches: number },
    ): Promise<CycleRunReport | null> => {
      isolations += 1;
      if (isolations > MAX_ISOLATIONS_PER_RUN) {
        return stop(refusal.reason, `${refusal.detail} (isolation budget of ${MAX_ISOLATIONS_PER_RUN} exhausted)`, extras);
      }
      const view = await chain.observe();
      const cycle = await readCycleOrThrow(db, config.cycleId);
      const selection = await selectLaneWork(db, config.ledgerPageSize, config.selectionBudgetClaims, now(), auditedThisRun, deps.standardPayeeDue);
      const isolated = await isolateRefusedBatch(
        {
          deps, config: runConfig, view, cursor: BigInt(cycle.cursor_next), probeCounter, systemProven: confirmedThisRun > 0,
        },
        refusedBatch,
        refusal,
        selection,
      );
      if (isolated.kind === 'systemic') return stop(refusal.reason, isolated.detail, extras);
      if (isolated.kind === 'split') {
        const current = runConfig.batchLimits;
        const next: BatchLimits = {
          ...current,
          maxClaims: Math.max(1, Math.min(current.maxClaims, Math.floor(refusedBatch.claim_count / 2))),
          maxRecipients: Math.max(1, Math.min(current.maxRecipients, Math.floor(refusedBatch.recipient_count / 2))),
        };
        if (next.maxClaims === current.maxClaims && next.maxRecipients === current.maxRecipients) {
          return stop(refusal.reason, `${isolated.detail} (the planning limits cannot shrink further)`, extras);
        }
        runConfig = { ...runConfig, batchLimits: next };
        log(`COMBINATION FAILURE in batch ${refusedBatch.batch_id} (${refusal.reason}): ${isolated.detail}; `
          + `planning limits for the rest of this run: ${next.maxRecipients} recipient(s) / ${next.maxClaims} claim(s)`);
        return null;
      }
      let chainSettledCount = 0;
      if (isolated.chainSettled !== undefined) {
        const recorded = await settleClaimsFromChainEvidence(db, {
          nowMs: now(),
          claims: isolated.chainSettled.rows.map((row) => ({ claimKey: row.claim_key, claimId: row.claim_id })),
          evidence: {
            safe_block: isolated.chainSettled.safeBlock,
            reason: `refused batch ${refusedBatch.batch_id} (${refusal.reason}): the kernel reads the claim settled`,
            concluding_batch_id: null,
          },
        });
        chainSettledCount = recorded.settled.length;
        log(`RECORDED ${chainSettledCount} claim(s) of refused batch ${refusedBatch.batch_id} settled from chain `
          + `evidence at safe block ${isolated.chainSettled.safeBlock}`);
      }
      const { held } = await holdClaims(db, { nowMs: now(), holds: isolated.held });
      const heldSet = new Set(held);
      for (const spec of isolated.held) if (heldSet.has(spec.claimKey)) heldClaims.push(spec);
      log(`ISOLATED ${held.length} claim(s) from refused batch ${refusedBatch.batch_id} (${refusal.reason}); `
        + 'held on backoff, the rest keeps settling');
      if (held.length === 0 && chainSettledCount === 0) {
        return stop(refusal.reason, `${refusal.detail} (isolated claims could not be held)`, extras);
      }
      return null;
    };

    // ── Same-cycle crash continuation (owned).
    await repairLedgerWritebacks(db, { nowMs: now() });
    const unresolved = await listUnresolvedBatches(db, config.cycleId);
    let resumedBatches = 0;
    for (const pending of unresolved) {
      resumedBatches += 1;
      const resolution = await resolveBatch(deps, config, {
        mode: 'owned', deadline, kernelAddress: observation.kernelAddress,
      }, pending);
      if (resolution.kind === 'confirmed') confirmedThisRun += 1;
      if (resolution.kind === 'stopped') {
        return stop(resolution.reason, `resume: ${resolution.detail}`, { deferredClaims: 0, resumedBatches });
      }
      if (resolution.kind === 'refused') {
        const stopped = await handleRefusal(pending, resolution, { deferredClaims: 0, resumedBatches });
        if (stopped !== null) return stopped;
      }
      log(`resumed batch ${pending.batch_id}: ${resolution.kind}`);
    }

    // ── Main loop.
    let deferredClaims = 0;
    let rebuildIndex = 0;
    let notSettleableRetries = 0;
    // standard-lane claims held by the reconciliation gate this sweep.
    // Latest count wins — selection re-runs each iteration.
    let heldStandardClaims = 0;
    for (;;) {
      if (now() > deadline) {
        return stop('run_time_limit', null, { deferredClaims, resumedBatches });
      }

      // Fresh observation each iteration: caps and cursor move as batches land.
      const view = await chain.observe();
      const iterationGate = evaluateEpochGate(view, config.boundarySafetyMarginSec);
      if (iterationGate.kind !== 'open' || iterationGate.epoch !== epoch) {
        const reason: CycleStopReason = iterationGate.kind === 'closed' && iterationGate.reason === 'boundary_margin'
          ? 'boundary_margin'
          : iterationGate.kind === 'advance_required' ? 'epoch_advance_required' : 'epoch_gate_closed';
        return stop(reason, null, { deferredClaims, resumedBatches });
      }

      const cycle = await readCycleOrThrow(db, config.cycleId);
      if (BigInt(cycle.cursor_next) !== view.nextFinalizedCursor) {
        // Durable and chain cursors disagree. Split by DIRECTION — only ONE
        // direction is explained by our own just-confirmed writes; the other two
        // stay fail-loud (Unknown = Block). The anti-double-mint guarantee does NOT
        // rest on this check: the kernel's own `cursorStart == nextFinalizedCursor`
        // + CursorDiscontinuity + ClaimAlreadySettled, `reserveBatch` continuity,
        // the resume `already_settled` guard, and claim-identity mint-once are the
        // real nets. This is a redundant belt relaxed only in the benign direction.
        const durableCursor = BigInt(cycle.cursor_next);
        const cursorStart = BigInt(cycle.cursor_start);
        let chainCursor = view.nextFinalizedCursor;
        // DANGEROUS: chain AHEAD of durable → an on-chain settle the durable store
        // never recorded (rogue/second signer) — the ledger would carry it unsettled
        // and later cycles would deadlock on ClaimAlreadySettled. chain BEHIND this
        // cycle's own seed → the finalized cursor regressed below where THIS cycle
        // started. Neither is replica lag on our own writes; never guess.
        if (chainCursor > durableCursor || chainCursor < cursorStart) {
          return stop(
            'resumption_abort',
            `durable cursor ${cycle.cursor_next} vs chain ${chainCursor.toString()} `
            + `outside [${cycle.cursor_start}, ${cycle.cursor_next}] — fail loud`,
            { deferredClaims, resumedBatches },
          );
        }
        // the "benign" direction is no longer ASSUMED to be lag. The chain is behind
        // our durable cursor either because a replica lags our own applied settle, or because
        // that settle is no longer on the canonical chain. Ask the chain about the batch that
        // advanced the cursor to where it is: canonical at depth → lag, wait below; POSITIVE
        // evidence of a reorg (non-canonical block at or below the safe head AND every member
        // unsettled on the kernel) → unwind it, re-drive its nonce, and continue. An unreadable
        // answer is never evidence: wait, exactly as before.
        const tip = (await listCycleBatches(db, config.cycleId))
          .find((batch) => batch.applied && batch.status === 'confirmed' && batch.cursor_end === cycle.cursor_next);
        if (tip !== undefined) {
          const verdict = await verifyAppliedBatch(chain, tip);
          if (verdict.kind === 'reorged') {
            log(`REORG: applied batch ${tip.batch_id} is no longer canonical (${verdict.detail}); unwinding`);
            const reverted = await revertReorgedBatch(db, { batchId: tip.batch_id, nowMs: now(), reason: verdict.detail });
            if (reverted.kind !== 'reverted') {
              return stop('resumption_abort', `reorged batch ${tip.batch_id} could not be unwound: ${reverted.reason}`,
                { deferredClaims, resumedBatches });
            }
            const redriven = await readBatchDoc(db, tip.batch_id);
            if (redriven === null) {
              return stop('resumption_abort', `reorged batch ${tip.batch_id} vanished`, { deferredClaims, resumedBatches });
            }
            const resolution = await resolveBatch(deps, config, {
              mode: 'owned', deadline, kernelAddress: view.kernelAddress,
            }, redriven);
            if (resolution.kind === 'stopped') {
              return stop(resolution.reason, `reorg re-drive: ${resolution.detail}`, { deferredClaims, resumedBatches });
            }
            if (resolution.kind === 'refused') {
              const stopped = await handleRefusal(redriven, resolution, { deferredClaims, resumedBatches });
              if (stopped !== null) return stopped;
            }
            rebuildIndex += 1;
            continue;
          }
        }
        // BENIGN: cursor_start <= chain < cursor_next and the tip is canonical (or the answer
        // is not in yet). The chain is catching up through THIS cycle's OWN confirmed batch(es)
        // read-your-writes lag on a load-balanced RPC replica. the wait is bounded by
        // the RUN's own deadline, NOT a small fixed attempt cap. `attempts` remains an OPTIONAL
        // hard ceiling for tests; UNSET (production) => the deadline is the only bound.
        // NO-DOUBLE-MINT: this loop only `continue`s on EXACT `chainCursor === durableCursor`,
        // so the next batch is always planned at `cursorStart === nextFinalizedCursor`; waiting
        // longer settles nothing.
        const reflectMaxAttempts = config.cursorReflect?.attempts;
        const reflectDelayMs = config.cursorReflect?.delayMs ?? 1_000;
        const reflectBoundLabel = reflectMaxAttempts === undefined
          ? `the run deadline (${config.maxRunMs}ms)`
          : `${reflectMaxAttempts}x${reflectDelayMs}ms`;
        log(`cursor reflect: durable ${durableCursor} > chain ${chainCursor} `
          + `(read-your-writes replica lag on our own confirmed settle); waiting up to `
          + `${reflectBoundLabel} for the chain to catch up`);
        let reflected = false;
        for (
          let attempt = 0;
          now() <= deadline && (reflectMaxAttempts === undefined || attempt < reflectMaxAttempts);
          attempt += 1
        ) {
          await deps.sleep(reflectDelayMs);
          chainCursor = (await chain.observe()).nextFinalizedCursor;
          if (chainCursor === durableCursor) {
            reflected = true;
            log(`cursor reflect: chain caught up to ${durableCursor} after ${attempt + 1} `
              + 'retr(ies); resuming batch planning from the caught-up view');
            break;
          }
          if (chainCursor > durableCursor) {
            // Jumped ABOVE our durable cursor mid-wait — the dangerous ahead
            // direction; bail loud rather than proceed on an unrecorded settle.
            return stop(
              'resumption_abort',
              `chain cursor ${chainCursor.toString()} exceeded durable ${cycle.cursor_next} `
              + 'during reflect wait — fail loud',
              { deferredClaims, resumedBatches },
            );
          }
        }
        if (!reflected) {
          // Bound exhausted: the run spent its budget waiting and the chain never reflected the
          // advance — a genuine stall, not replica lag. The confirmed batches ARE settled; the
          // next run re-seeds from the caught-up chain. It pages (`settlementRunNeedsAlarm`).
          return stop(
            'awaiting_finality',
            `chain cursor ${chainCursor.toString()} < durable ${cycle.cursor_next} after waiting `
            + `out ${reflectBoundLabel}; batches confirmed this run stay settled, next run resumes`,
            { deferredClaims, resumedBatches },
          );
        }
        // Reflected — re-run the iteration cleanly so the downstream plan reads the
        // caught-up chain view, not the stale one this iteration opened with.
        continue;
      }

      // ── Select work (bounded sweep). Held and reserved claims are left out.
      const { standard: selectedStandardRaw, genesis: genesisRaw, ledger } = await selectLaneWork(
        db, config.ledgerPageSize, config.selectionBudgetClaims, now(), auditedThisRun, deps.standardPayeeDue,
      );
      // lane scope: a scoped run settles only its lane (see `applyLaneScope`,
      // unit-tested in settlement-lane-scope.test.ts). The other lane's rows are left
      // untouched as durable backlog for their own cadence — NOT the recon-gate
      // "refusal" (no held-claim count, no standard_lane_refused stop, no alarm); the
      // rows are simply not selected. 'both' (default) preserves the Genesis-first
      // both-lanes behavior exactly.
      // : an on-demand payout settles one payee's standard claims and nothing else.
      const laneScope: SettlementLaneScope = config.payee !== undefined ? 'standard' : (config.laneScope ?? 'both');
      const scoped = applyLaneScope(laneScope, selectedStandardRaw, genesisRaw);
      const genesis = scoped.genesis;
      const selectedStandard = applyPayeeScope(config.payee, scoped.standard);
      // the standard-lane first-mint gate. Refusal HOLDS standard
      // claims (they stay unsettled ledger rows, i.e. durable backlog) and
      // touches nothing on the Genesis lane, which is live and fenced. This is
      // the only place standard work can be admitted into planning, and the
      // verdict it consumes has exactly one production construction site
      // (`judgeStandardLaneAdmission`, called by `operator-runtime.ts`).
      let standard = selectedStandard;
      if (deps.standardLaneAdmission.admitted !== true && selectedStandard.items.length > 0) {
        heldStandardClaims = selectedStandard.items
          .reduce((count, item) => count + item.claimIds.length, 0);
        log(`STANDARD LANE REFUSED (${deps.standardLaneAdmission.reason}): `
          + `${deps.standardLaneAdmission.detail} — ${heldStandardClaims} claim(s) held as `
          + 'durable backlog; Genesis lane unaffected');
        standard = { lane: 'standard', items: [], rowsByClaimId: new Map() };
      }
      if (standard.items.length === 0 && genesis.items.length === 0) {
        if (heldStandardClaims > 0 && deps.standardLaneAdmission.admitted !== true) {
          // NOT 'completed': held work remains. An operator reading this stop
          // must see the gate, not an exhausted backlog.
          return stop(
            'standard_lane_refused',
            `${heldStandardClaims} standard claim(s) held by the reconciliation gate `
            + `(${deps.standardLaneAdmission.reason})`,
            { deferredClaims, resumedBatches },
          );
        }
        return stop('backlog_exhausted', null, { deferredClaims, resumedBatches }, 'completed');
      }

      // ── Claim identity (the anti-double-mint verification).
      const proposals: ProposedClaim[] = [];
      for (const work of [genesis, standard]) {
        for (const item of work.items) {
          for (const claimId of item.claimIds) {
            const row = work.rowsByClaimId.get(claimId)!;
            proposals.push({
              peId: row.pe_id,
              leg: row.leg,
              ...(row.claim_kind === undefined ? {} : { kind: row.claim_kind }),
              claimId: row.claim_id,
              lane: row.lane,
              ...(row.lane === 'genesis' ? { genesisAnchorKey: row.genesis_anchor_key } : {}),
            });
          }
        }
      }
      const identity = verifyClaimIdentity(proposals, ledger);
      if (identity.kind !== 'stable') {
        return stop(
          'claim_identity_violations',
          identity.violations.map((v) => `${v.kind}:${v.peId}`).slice(0, 10).join(','),
          { deferredClaims, resumedBatches },
        );
      }

      const isolationCtx: IsolationContext = {
        deps, config: runConfig, view, cursor: BigInt(cycle.cursor_next), probeCounter, systemProven: confirmedThisRun > 0,
      };
      /** A deterministic plan/encode rejection: hold the claims behind it and keep going. */
      const handlePlanRejection = async (reason: string): Promise<CycleRunReport | null> => {
        isolations += 1;
        if (isolations > MAX_ISOLATIONS_PER_RUN) {
          return stop('batch_plan_rejected', `${reason} (isolation budget exhausted)`, { deferredClaims, resumedBatches });
        }
        const isolated = isolatePlanRejection(isolationCtx, { genesis, standard }, reason);
        if (isolated.kind === 'systemic') {
          return stop('batch_plan_rejected', isolated.detail, { deferredClaims, resumedBatches });
        }
        const { held } = await holdClaims(db, { nowMs: now(), holds: isolated.held });
        const heldSet = new Set(held);
        for (const spec of isolated.held) if (heldSet.has(spec.claimKey)) heldClaims.push(spec);
        log(`ISOLATED ${held.length} claim(s) behind plan rejection ${reason}; held on backoff`);
        if (held.length === 0) {
          return stop('batch_plan_rejected', `${reason} (isolated claims could not be held)`, { deferredClaims, resumedBatches });
        }
        return null;
      };

      // ── Plan the next batch under the epoch caps.
      const planned = planNextBatch(runConfig, view, BigInt(cycle.cursor_next), genesis, standard);
      if (planned.kind === 'deferred') {
        deferredClaims += planned.deferredClaims;
        return stop(
          'epoch_cap_deferral',
          `deferred ${planned.deferredClaims} claims to a later epoch (durable backlog)`,
          { deferredClaims, resumedBatches },
        );
      }
      if (planned.kind === 'rejected') {
        const stopped = await handlePlanRejection(planned.reason);
        if (stopped !== null) return stopped;
        continue;
      }
      const plan = planned.batch;

      // ── Derive the final batch id, encode, fee-limit check.
      let batchId = deriveSettlementBatchId({
        cycleId: config.cycleId, lane: plan.lane, cursorStart: plan.cursorStart, rebuildIndex,
      });
      let encoded = plan.encode(batchId);
      if ('error' in encoded) {
        const stopped = await handlePlanRejection(encoded.error);
        if (stopped !== null) return stopped;
        continue;
      }
      // ── Fee pre-flight, from the MODELLED gas rather than an `eth_estimateGas`.
      //
      // Simulating and estimating before reserving reverted unconditionally: the kernel
      // refuses any settle whose digest the eligibility verifier has not affirmed, and the
      // batch cannot be approved before its durable doc exists. The planner's `estimatedGas`
      // comes from the same `gasModel` that bounded the batch, so it is the figure the batch
      // was BUILT against; the real `eth_estimateGas` still runs inside `resolveBatch`, after
      // the approval, and the reservation is released rather than spent if anything refuses.
      const fees = await chain.feeData();
      const modelledGas = estimateGas(config.gasModel, plan.recipientCount, plan.claimCount);
      const gasLimit = (BigInt(modelledGas) * BigInt(config.gasHeadroomBps)) / 10_000n;
      const worstCaseFee = gasLimit * fees.maxFeePerGasWei;
      const committed = BigInt(cycle.consumed.fee_wei_spent) + BigInt(cycle.consumed.fee_wei_reserved);
      if (committed + worstCaseFee > config.limits.maxFeeWeiTotal) {
        return stop(
          'fee_limit',
          `committed ${committed} + estimate ${worstCaseFee} > ${config.limits.maxFeeWeiTotal}`,
          { deferredClaims, resumedBatches },
        );
      }

      // ── Reserve (assigns the nonce, enforces the transaction budget).
      const reserveParams = (id: string, calldata: string) => ({
        cycleId: config.cycleId,
        workerId: config.workerId,
        nowMs: now(),
        batchId: id,
        lane: plan.lane,
        epoch,
        policyHash,
        cursorStart: plan.cursorStart,
        cursorEnd: plan.cursorEnd,
        recipientCount: plan.recipientCount,
        claimCount: plan.claimCount,
        totalMintedAtomic: plan.totalMintedAtomic,
        calldata,
        members: plan.members,
      });
      let reserved = await reserveBatch(db, reserveParams(batchId, encoded.data));
      if (reserved.kind === 'refused' && reserved.reason === 'batch_exists') {
        // A dead prior reservation holds this id — bump the rebuild index.
        rebuildIndex += 1;
        batchId = deriveSettlementBatchId({
          cycleId: config.cycleId, lane: plan.lane, cursorStart: plan.cursorStart, rebuildIndex,
        });
        encoded = plan.encode(batchId);
        if ('error' in encoded) {
          const stopped = await handlePlanRejection(encoded.error);
          if (stopped !== null) return stopped;
          continue;
        }
        reserved = await reserveBatch(db, reserveParams(batchId, encoded.data));
      }
      if (reserved.kind !== 'reserved') {
        if (reserved.reason === 'claim_not_settleable' && notSettleableRetries < 3) {
          // a member was reserved, settled, or demoted between selection and here.
          // Selection skips all three, so re-selecting settles the rest instead of aborting.
          notSettleableRetries += 1;
          log(`reservation refused claim_not_settleable [${(reserved.claimKeys ?? []).slice(0, 5).join(', ')}]; re-selecting`);
          rebuildIndex += 1;
          continue;
        }
        const reason: CycleStopReason = reserved.reason === 'transaction_limit'
          ? 'transaction_limit'
          : 'resumption_abort';
        return stop(reason, reserved.reason, { deferredClaims, resumedBatches });
      }

      // ── Resolve to a terminal state (confirmed / dead / refused / stop).
      const resolution = await resolveBatch(deps, config, {
        mode: 'owned', deadline, kernelAddress: view.kernelAddress,
      }, reserved.batch);
      if (resolution.kind === 'confirmed') {
        confirmedThisRun += 1;
        log(`batch ${batchId} confirmed at depth (${plan.claimCount} claims, ${plan.recipientCount} recipients)`);
        continue;
      }
      if (resolution.kind === 'dead') {
        rebuildIndex += 1;
        log(`batch ${batchId} dead (${resolution.reason}); re-planning at the same cursor`);
        continue;
      }
      if (resolution.kind === 'refused') {
        rebuildIndex += 1;
        const stopped = await handleRefusal(reserved.batch, resolution, { deferredClaims, resumedBatches });
        if (stopped !== null) return stopped;
        continue;
      }
      return stop(resolution.reason, resolution.detail, { deferredClaims, resumedBatches });
    }
  } finally {
    // Worker ids are unique per invocation: a lease left standing would refuse the next run
    // (a scheduler retry, the next cron) for its whole TTL. Both releases are holder-only.
    await releaseCycleLease(db, { cycleId: config.cycleId, workerId: config.workerId, nowMs: now() });
    await releaseSignerLease(db, { signer: config.signerAddress, workerId: config.workerId, nowMs: now() });
  }
}

export function runSettlementCycle(deps: CycleRunnerDeps, config: CycleRunnerConfig): Promise<CycleRunReport> {
  return withPrivateReadSession(() => runSettlementCycleAttempt(deps, config));
}

/**
 * PVT - Anchor Recovery Worker
 *
 * Read-only legacy scanner retained for forensic planning. Execute mode is
 * permanently retired: only the fenced mint-claim recovery path may broadcast
 * or finalize an anchor transaction.
 *
 * Invariants:
 *   - NEVER calls mintFromPEs. Mint already happened (BatchMinted event proves
 *     it); recovery only ever proposes/sends anchorBatch.
 *   - Refuses without snapshot, on root mismatch, or on batchId mismatch.
 *   - Never sends anchor transactions. `execute=true` fails closed.
 *   - Confirmation threshold (default 12 blocks) prevents acting on reorged
 *     events - caller is expected to use a "safe" tip when picking toBlock.
 *   - Persists a checkpoint per (chainId, contractAddress) so subsequent runs
 *     pick up where the prior left off.
 *   - Records retry metadata (attempts, last_error, last_attempt_at) per
 *     batchId so a stuck batch is observable from Firestore alone.
 *
 * Legacy execute-mode cost options remain in the public shape only for CLI
 * compatibility. They are unreachable because `execute=true` fails before
 * any provider or contract call:
 *   - maxAnchorsPerRun:        cap the number of anchorBatch txns per run.
 *   - maxAttemptsPerBatch:     refuse a batch once its retry doc reports
 *                              attempts >= cap; flips status to
 *                              `needs_manual_review` and emits a structured
 *                              error log line for GCP alerting.
 *   - minRetryIntervalMs:      refuse a batch whose last_attempt_at is more
 *                              recent than this window (default 1 hour).
 *   - maxGasUsdPerRun:         abort the run before sending anchorBatch when
 *                              cumulative estimated USD cost would exceed it.
 *   - gasPriceCeilingGwei:     skip the entire chain when the network gas
 *                              price exceeds this ceiling (default 100 gwei).
 *   - The CLI default remains dry-run; guardrails do not change planning
 *     behavior other than respecting the per-batch cap and cooldown.
 */

import { ethers } from 'ethers';
import type { Firestore, FieldValue } from 'firebase-admin/firestore';
import {
  validateAnchorRecovery,
  type AnchorRecoveryResult,
  type BatchMintedEventLike,
} from './anchor-recovery';

// =============================================================================
// TYPES
// =============================================================================

export interface AnchorRecoveryWorkerDeps {
  db: Firestore;
  pvtContract: ethers.Contract;
  peAnchorContract: ethers.Contract;
  /**
   * Optional FieldValue handle. Production passes
   * `firebase-admin/firestore.FieldValue` for atomic counter increments;
   * tests can omit it and the worker falls back to a read-modify-write.
   */
  fieldValue?: typeof FieldValue;
  /**
   * Retired gas oracle option retained for source compatibility. Returns the
   * current network gas price (wei) and an ETH/USD price for the chain.
   * In production wired from provider.getFeeData() + a price source; tests
   * inject a stub with deterministic values.
   *
   * Execute mode is retired, so this dependency is never invoked.
   */
  gasOracle?: () => Promise<{ gasPriceWei: bigint; ethPriceUsd: number }>;
  /** Inject a clock for deterministic cooldown tests. Default Date.now. */
  now?: () => number;
  /**
   * Inject a structured-log sink. Default writes a JSON line to stderr so
   * Cloud Run captures it as a structured log entry.
   */
  emitStructuredLog?: (entry: Record<string, unknown>) => void;
}

export interface AnchorRecoveryWorkerOptions {
  /** Inclusive start block. Defaults to checkpoint or `latest - lookback`. */
  fromBlock?: number;
  /** Inclusive end block. Defaults to `latest - confirmations`. */
  toBlock?: number;
  /** Confirmation depth applied to default `toBlock`. Default 12. */
  confirmations?: number;
  /** Lookback window when no checkpoint exists. Default 50_000. */
  defaultLookback?: number;
  /** Retired. `true` fails closed; omitted/false performs read-only planning. */
  execute?: boolean;
  /** Override the chainId used in checkpoint keys (tests). */
  chainIdOverride?: number;
  /**
   * Maximum block range per eth_getLogs call. Public RPCs cap this:
   * mainnet.base.org enforces 10_000, mainnet.optimism.io 10_000,
   * arbitrum public nodes typically 100_000. Default 5_000 stays well
   * under the strictest public limit and is safe everywhere; raise via
   * env (`ANCHOR_RECOVERY_BLOCK_CHUNK`) when running against a private RPC.
   */
  blockChunk?: number;

  // -------- Retired execute-mode compatibility options (never invoked) -------

  /** Hard cap on anchorBatch invocations per run. Default 10. */
  maxAnchorsPerRun?: number;
  /**
   * Hard cap on per-batch attempts. Once the retry doc shows attempts >=
   * cap, the worker flips status to `needs_manual_review`, emits a
   * structured error log, and refuses to retry. Default 5.
   */
  maxAttemptsPerBatch?: number;
  /** Minimum interval (ms) between retries for the same batch. Default 1 hour. */
  minRetryIntervalMs?: number;
  /**
   * Maximum cumulative estimated USD spend per run. Aborts the run before
   * sending an anchorBatch tx that would push estimated spend over this
   * budget. Default 50.
   */
  maxGasUsdPerRun?: number;
  /**
   * Skip the entire chain run when the network gas price (gwei) exceeds
   * this ceiling. Default 100.
   */
  gasPriceCeilingGwei?: number;
  /** Per-anchorBatch gas estimate used for budget checks. Default 150_000. */
  anchorGasUnitsEstimate?: number;
}

export interface AnchorRecoveryWorkerReport {
  scanned_from: number;
  scanned_to: number;
  events_seen: number;
  /**
   * Per-batch outcomes:
   *   - skipped_already_anchored
   *   - refused_snapshot_missing
   *   - refused_merkle_root_mismatch
   *   - refused_batch_id_mismatch
   *   - planned                          (dry-run, would have called anchorBatch)
   *   - anchored                         (legacy unreachable status)
   *   - anchor_failed                    (legacy unreachable status)
   *   - refused_attempts_exhausted       (per-batch attempts cap hit; flipped to needs_manual_review)
   *   - refused_cooldown                 (per-batch cooldown not yet elapsed)
   *   - skipped_max_anchors_per_run      (hit run-level cap)
   *   - aborted_gas_budget_exceeded      (would exceed maxGasUsdPerRun)
   *   - skipped_chain_gas_price_too_high (chain-wide skip; gas price > ceiling)
   */
  outcomes: Record<string, number>;
  /** Detailed per-batch records (cap 100 to keep response size bounded). */
  batches: Array<{
    batchId: string;
    outcome: string;
    detail?: string;
    txHash?: string;
  }>;
  dry_run: boolean;
  /**
   * Cumulative estimated USD spend across anchorBatch tx attempts in this
   * run. Always 0 in dry-run.
   */
  estimated_gas_usd_spent: number;
  /** True when the chain-wide gas-price ceiling caused an early return. */
  chain_skipped_gas_price?: { gas_price_gwei: number; ceiling_gwei: number };
  /** True when the per-run USD budget aborted the loop early. */
  aborted_gas_budget?: { spent_usd: number; budget_usd: number };
}

const CHECKPOINTS_COLLECTION = 'pvt_anchor_recovery_checkpoints';
const RETRIES_COLLECTION = 'pvt_anchor_recovery_retries';

// =============================================================================
// SCANNER
// =============================================================================

export async function runAnchorRecoveryWorker(
  deps: AnchorRecoveryWorkerDeps,
  opts: AnchorRecoveryWorkerOptions = {},
): Promise<AnchorRecoveryWorkerReport> {
  if (opts.execute === true) {
    throw new Error('anchor_recovery_execute_retired_use_mint_claim_recovery');
  }
  const dryRun = true;
  const confirmations = opts.confirmations ?? 12;
  const defaultLookback = opts.defaultLookback ?? 50_000;
  const maxAnchorsPerRun = opts.maxAnchorsPerRun ?? 10;
  const maxAttemptsPerBatch = opts.maxAttemptsPerBatch ?? 5;
  const minRetryIntervalMs = opts.minRetryIntervalMs ?? 60 * 60 * 1000;
  const maxGasUsdPerRun = opts.maxGasUsdPerRun ?? 50;
  const anchorGasUnitsEstimate = opts.anchorGasUnitsEstimate ?? 150_000;

  const provider = deps.pvtContract.runner?.provider as ethers.Provider | undefined;
  if (!provider) {
    throw new Error('pvtContract has no provider; cannot scan logs');
  }

  const chainId = opts.chainIdOverride ?? Number((await provider.getNetwork()).chainId);
  const contractAddress = (await deps.pvtContract.getAddress()).toLowerCase();
  const checkpointKey = `${chainId}:${contractAddress}`;
  const checkpointRef = deps.db.collection(CHECKPOINTS_COLLECTION).doc(checkpointKey);

  const latest = await provider.getBlockNumber();
  const safeTip = Math.max(0, latest - confirmations);

  let fromBlock = opts.fromBlock;
  if (fromBlock === undefined) {
    const cp = await checkpointRef.get();
    fromBlock = cp.exists
      ? ((cp.data() as { last_processed_block?: number }).last_processed_block ?? 0) + 1
      : Math.max(0, safeTip - defaultLookback);
  }
  const toBlock = opts.toBlock ?? safeTip;

  const report: AnchorRecoveryWorkerReport = {
    scanned_from: fromBlock,
    scanned_to: toBlock,
    events_seen: 0,
    outcomes: {},
    batches: [],
    dry_run: dryRun,
    estimated_gas_usd_spent: 0,
  };

  const oracleSnapshot: { gasPriceWei: bigint; ethPriceUsd: number } | null = null;

  if (toBlock < fromBlock) {
    return report;
  }

  // Use queryFilter with the BatchMinted event. The contract iface owns the
  // topic resolution so V3/V4 event-shape changes don't need to repeat here.
  // Chunked because public RPCs (mainnet.base.org, mainnet.optimism.io) cap
  // eth_getLogs at 10_000 blocks; a single multi-chunk-range call returns
  // -32614 instead of paginating.
  const filter = deps.pvtContract.filters.BatchMinted();
  const blockChunk = opts.blockChunk ?? 5_000;
  const rawEvents = await chunkedQueryFilter(
    deps.pvtContract,
    filter,
    fromBlock,
    toBlock,
    blockChunk,
  );
  report.events_seen = rawEvents.length;

  // Track anchor txns sent this run for the per-run cap.
  let anchorsThisRun = 0;
  let aborted = false;

  for (const evt of rawEvents) {
    if (aborted) break;
    // queryFilter returns EventLog (for matched topics) or Log. Both expose
    // .args after parse - we narrow defensively because some test mocks pass
    // pre-parsed data.
    const evtLog = evt as ethers.EventLog;
    const args = evtLog.args;
    if (!args) {
      bumpOutcome(report, 'unparseable_event');
      continue;
    }
    const eventLike: BatchMintedEventLike = {
      batchId: args.batchId as string,
      merkleRoot: args.merkleRoot as string,
      txHash: evtLog.transactionHash,
      blockNumber: evtLog.blockNumber,
    };

    const result = await validateAnchorRecovery(
      { db: deps.db, peAnchorContract: deps.peAnchorContract },
      eventLike,
    );

    const ctx: ApplyContext = {
      chainId,
      now: deps.now ?? Date.now,
      maxAnchorsPerRun,
      maxAttemptsPerBatch,
      minRetryIntervalMs,
      maxGasUsdPerRun,
      anchorGasUnitsEstimate,
      oracleSnapshot,
      anchorsThisRun,
    };
    const decision = await applyResult(deps, report, eventLike, result, dryRun, ctx);
    anchorsThisRun = decision.anchorsThisRun;
    if (decision.aborted) aborted = true;
  }

  await checkpointRef.set(
    {
      chain_id: chainId,
      contract_address: contractAddress,
      last_processed_block: toBlock,
      updated_at: deps.now ? deps.now() : Date.now(),
    },
    { merge: true },
  );

  return report;
}

interface ApplyContext {
  chainId: number;
  now: () => number;
  maxAnchorsPerRun: number;
  maxAttemptsPerBatch: number;
  minRetryIntervalMs: number;
  maxGasUsdPerRun: number;
  anchorGasUnitsEstimate: number;
  oracleSnapshot: { gasPriceWei: bigint; ethPriceUsd: number } | null;
  anchorsThisRun: number;
}

interface ApplyDecision {
  anchorsThisRun: number;
  aborted: boolean;
}

async function applyResult(
  deps: AnchorRecoveryWorkerDeps,
  report: AnchorRecoveryWorkerReport,
  event: BatchMintedEventLike,
  result: AnchorRecoveryResult,
  dryRun: boolean,
  ctx: ApplyContext,
): Promise<ApplyDecision> {
  const pushBatch = (outcome: string, detail?: string, txHash?: string) => {
    bumpOutcome(report, outcome);
    if (report.batches.length < 100) {
      report.batches.push({ batchId: result.batchId, outcome, detail, txHash });
    }
  };

  switch (result.status) {
    case 'snapshot_missing':
      pushBatch('refused_snapshot_missing', result.detail);
      return { anchorsThisRun: ctx.anchorsThisRun, aborted: false };
    case 'merkle_root_mismatch':
      pushBatch('refused_merkle_root_mismatch', result.detail);
      return { anchorsThisRun: ctx.anchorsThisRun, aborted: false };
    case 'batch_id_mismatch':
      pushBatch('refused_batch_id_mismatch', result.detail);
      return { anchorsThisRun: ctx.anchorsThisRun, aborted: false };
    case 'already_anchored':
      pushBatch('skipped_already_anchored');
      return { anchorsThisRun: ctx.anchorsThisRun, aborted: false };
    case 'ready_to_anchor':
      break;
  }

  if (!result.retryPlan) {
    pushBatch('refused_missing_retry_plan');
    return { anchorsThisRun: ctx.anchorsThisRun, aborted: false };
  }

  // -------------------------------------------------------------------------
  // Guardrail: per-batch attempts cap. Read existing retry doc and refuse
  // (flipping to needs_manual_review) if attempts have been exhausted.
  // Active in BOTH dry-run and execute mode - we don't want a stuck batch to
  // keep clogging dry-run reports.
  // -------------------------------------------------------------------------
  const retrySnap = await deps.db
    .collection(RETRIES_COLLECTION)
    .doc(result.batchId)
    .get();
  const retryDoc = retrySnap.exists
    ? (retrySnap.data() as RetryDoc | undefined) ?? {}
    : {};
  const priorAttempts = Number(retryDoc.attempts ?? 0);
  const lastAttemptAt = Number(retryDoc.last_attempt_at ?? 0);
  const currentStatus = (retryDoc.status as string | undefined) ?? null;

  if (currentStatus === 'needs_manual_review' || priorAttempts >= ctx.maxAttemptsPerBatch) {
    pushBatch(
      'refused_attempts_exhausted',
      `attempts=${priorAttempts} cap=${ctx.maxAttemptsPerBatch}`,
    );
    await markNeedsManualReview(deps, result.batchId, {
      attempts: priorAttempts,
      cap: ctx.maxAttemptsPerBatch,
      chainId: ctx.chainId,
      lastError: typeof retryDoc.last_error === 'string' ? retryDoc.last_error : undefined,
    });
    return { anchorsThisRun: ctx.anchorsThisRun, aborted: false };
  }

  // -------------------------------------------------------------------------
  // Guardrail: cooldown. Refuse if the last attempt is more recent than
  // minRetryIntervalMs. Active in both modes.
  // -------------------------------------------------------------------------
  const nowMs = ctx.now();
  if (lastAttemptAt > 0 && nowMs - lastAttemptAt < ctx.minRetryIntervalMs) {
    const waitMs = ctx.minRetryIntervalMs - (nowMs - lastAttemptAt);
    pushBatch('refused_cooldown', `${waitMs}ms remaining`);
    return { anchorsThisRun: ctx.anchorsThisRun, aborted: false };
  }

  if (dryRun) {
    pushBatch('planned', 'dry-run; anchorBatch not sent');
    await recordRetry(deps, result.batchId, { dry_run: true, now: ctx.now });
    return { anchorsThisRun: ctx.anchorsThisRun, aborted: false };
  }

  throw new Error('anchor_recovery_execute_retired_use_mint_claim_recovery');
}

interface RetryDoc {
  attempts?: number;
  last_attempt_at?: number;
  last_error?: unknown;
  status?: unknown;
}

async function markNeedsManualReview(
  deps: AnchorRecoveryWorkerDeps,
  batchId: string,
  info: { attempts: number; cap: number; chainId: number; lastError?: string },
): Promise<void> {
  const ref = deps.db.collection(RETRIES_COLLECTION).doc(batchId);
  await ref.set(
    {
      status: 'needs_manual_review',
      needs_manual_review_at: deps.now ? deps.now() : Date.now(),
      attempts_at_review: info.attempts,
      attempts_cap: info.cap,
    },
    { merge: true },
  );
  emitStructuredLog(deps, {
    severity: 'ERROR',
    message: 'anchor_recovery_needs_manual_review',
    batch_id: batchId,
    attempts: info.attempts,
    cap: info.cap,
    chain_id: info.chainId,
    last_error: info.lastError,
  });
}

function emitStructuredLog(
  deps: AnchorRecoveryWorkerDeps,
  entry: Record<string, unknown>,
): void {
  if (deps.emitStructuredLog) {
    deps.emitStructuredLog(entry);
    return;
  }
  // Default: write a JSON line to stderr. Cloud Run's logging agent parses
  // this as a structured log entry, picking up `severity` and other fields
  // for log-based alerts.
  process.stderr.write(JSON.stringify(entry) + '\n');
}

function bumpOutcome(report: AnchorRecoveryWorkerReport, outcome: string): void {
  report.outcomes[outcome] = (report.outcomes[outcome] ?? 0) + 1;
}

async function recordRetry(
  deps: AnchorRecoveryWorkerDeps,
  batchId: string,
  data: {
    dry_run: boolean;
    success?: boolean;
    tx_hash?: string;
    error?: string;
    now?: () => number;
  },
): Promise<void> {
  const ref = deps.db.collection(RETRIES_COLLECTION).doc(batchId);
  const nowMs = data.now ? data.now() : Date.now();
  // Production-compatible Firestore atomic counter when FieldValue is available;
  // mock-friendly read-modify-write fallback otherwise.
  if (deps.fieldValue?.increment) {
    const update: Record<string, unknown> = {
      attempts: deps.fieldValue.increment(1),
      last_attempt_at: nowMs,
      last_dry_run: data.dry_run,
    };
    if (data.success !== undefined) update.last_success = data.success;
    if (data.tx_hash) update.last_tx_hash = data.tx_hash;
    if (data.error) update.last_error = data.error;
    await ref.set(update, { merge: true });
    return;
  }

  const snap = await ref.get();
  const prev = snap.exists ? (snap.data() as { attempts?: number }) : {};
  const update: Record<string, unknown> = {
    attempts: (prev.attempts ?? 0) + 1,
    last_attempt_at: nowMs,
    last_dry_run: data.dry_run,
  };
  if (data.success !== undefined) update.last_success = data.success;
  if (data.tx_hash) update.last_tx_hash = data.tx_hash;
  if (data.error) update.last_error = data.error;
  await ref.set(update, { merge: true });
}

/**
 * Chunked eth_getLogs scan. Public RPCs (e.g. mainnet.base.org,
 * mainnet.optimism.io) cap each call at ~10_000 blocks and return
 * `-32614 eth_getLogs is limited to a 10,000 range` for anything wider -
 * they don't paginate, they reject. We iterate in chunks small enough to
 * stay under the strictest public limit and concatenate the results.
 */
async function chunkedQueryFilter(
  contract: ethers.Contract,
  filter: ethers.ContractEventName,
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
): Promise<(ethers.Log | ethers.EventLog)[]> {
  if (toBlock < fromBlock) return [];
  const all: (ethers.Log | ethers.EventLog)[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + chunkSize - 1, toBlock);
    const events = await contract.queryFilter(filter, cursor, end);
    for (const e of events) all.push(e);
    cursor = end + 1;
  }
  return all;
}

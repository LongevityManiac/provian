/**
 * settlement runtime — per-transaction batch bounds (A3).
 *
 * The kernel bounds a batch's RECIPIENTS (`MAX_RECIPIENTS_PER_BATCH = 500`) but
 * not its CLAIMS: `_validateBatchHeader` only ties `claimCount` to the cursor
 * range, so one recipient may carry more claims than the entire recipient cap.
 * Each claim costs an irreducible cold claim-id write, so a high-claim batch
 * can exceed the block gas limit and become permanently un-mineable — it is not
 * a mint risk (the kernel is atomic and would simply revert), it is a liveness
 * risk: the cycle stalls at a batch that can never be included.
 *
 * The kernel is final, so the bound lives here. Both facts are pinned in
 * `contracts/test/ProvianPVT9Wp4Settlement.t.sol`
 * (`test_claimsPerBatch_areNotBoundedByTheRecipientCap`,
 * `test_claimsPerBatch_gasGrowsLinearlyWithNoKernelCeiling`).
 *
 * Pure planning only: nothing here signs, submits, or opens a connection.
 */

/** Mirrors `ProvianPVT9.MAX_RECIPIENTS_PER_BATCH`. A hard kernel ceiling. */
export const KERNEL_MAX_RECIPIENTS_PER_BATCH = 500;

/**
 * The operating recipient target, from the approved plan
 * (`docs/PVT_BASE_MAINNET_CLOSED_LOOP_PLAN.md` §settlement runtime item 3, and the settlement kernel handoff
 * "Hard recipients per transaction | 500; settlement runtime normal target remains 400").
 */
export const SETTLEMENT_LOAD_TARGET_RECIPIENTS_PER_BATCH = 400;

/**
 * Marginal gas per standard claim, MEASURED in
 * `ProvianPVT9Wp4Settlement.t.sol::test_claimsPerBatch_gasGrowsLinearlyWithNoKernelCeiling`
 * (600-claim batch minus 100-claim batch, divided by 500). A local-EVM figure
 * for sizing only — activation owns production calibration against Base.
 *
 * That calibration is now DONE : a real Base settle of a beneficiary-split
 * claim costs ~20× this warm-fork marginal, so production uses `SETTLEMENT_GAS_MODEL`
 * in `operator-runtime.ts`, not this constant. This value is retained as the
 * local-EVM reference it has always been (and the fixture `batch-bounds.test.ts`
 * uses to prove the pure planner, which is gas-model-agnostic).
 */
export const MEASURED_MARGINAL_GAS_PER_STANDARD_CLAIM = 23_283;

/** Caller-supplied gas shape of a settlement transaction. */
export interface BatchGasModel {
  /** Fixed per-transaction overhead: calldata base, policy read, verifier calls. */
  readonly baseGas: number;
  readonly gasPerRecipient: number;
  readonly gasPerClaim: number;
}

/** Caller-supplied per-transaction ceilings. */
export interface BatchLimits {
  readonly maxRecipients: number;
  /** The A3 bound the kernel does not provide. */
  readonly maxClaims: number;
  /** Gas ceiling for one transaction; below the block limit, with headroom. */
  readonly maxGas: number;
}

/** One contributor's claims for this cycle. Claim ids must already be stable. */
export interface SettlementWorkItem {
  readonly contributor: string;
  readonly claimIds: readonly string[];
}

export interface PlannedBatch {
  readonly items: readonly SettlementWorkItem[];
  readonly recipientCount: number;
  readonly claimCount: number;
  readonly estimatedGas: number;
  readonly cursorStart: bigint;
  readonly cursorEnd: bigint;
}

export type BatchPlanRejection =
  | 'invalid_limits'
  | 'invalid_gas_model'
  | 'invalid_cursor'
  | 'invalid_work_item'
  | 'duplicate_contributor'
  | 'duplicate_claim_id'
  | 'recipients_not_strictly_ordered'
  | 'limits_exceed_kernel_ceiling'
  | 'limits_admit_no_batch';

export type BatchPlanResult =
  | { readonly kind: 'planned'; readonly batches: readonly PlannedBatch[] }
  | {
      readonly kind: 'rejected';
      readonly reason: BatchPlanRejection;
      /** The offending contributor, when the rejection names one. */
      readonly contributor?: string;
    };

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const BYTES32 = /^0x[0-9a-f]{64}$/i;
/** The kernel seeds its ordering check with `address previous;`. */
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
/** `_validateStandardInputs` rejects `claimId == bytes32(0)` outright. */
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isValidLimits(limits: BatchLimits): boolean {
  return isPositiveInteger(limits.maxRecipients)
    && isPositiveInteger(limits.maxClaims)
    && isPositiveInteger(limits.maxGas);
}

function isValidGasModel(model: BatchGasModel): boolean {
  return Number.isSafeInteger(model.baseGas)
    && model.baseGas >= 0
    && isPositiveInteger(model.gasPerRecipient)
    && isPositiveInteger(model.gasPerClaim);
}

function isValidWorkItem(item: SettlementWorkItem): boolean {
  return typeof item.contributor === 'string'
    && ADDRESS.test(item.contributor)
    && Array.isArray(item.claimIds)
    && item.claimIds.length > 0
    && item.claimIds.every((claimId) => typeof claimId === 'string'
      && BYTES32.test(claimId)
      // Zero is the unset sentinel the kernel rejects, exactly as it rejects
      // the zero address on the recipient side.
      && claimId.toLowerCase() !== ZERO_BYTES32);
}

/**
 * The modelled gas for a batch of this shape.
 *
 * Exported because the settlement runner's pre-reserve fee check needs it: an
 * `eth_estimateGas` on settle calldata cannot run before the batch has been approved on the
 * eligibility verifier, and the batch cannot be approved before its durable doc exists. This
 * is the same figure the planner bounded the batch against, so using it there is not a second
 * model — it is the model.
 */
export function estimateGas(
  model: BatchGasModel,
  recipientCount: number,
  claimCount: number,
): number {
  return model.baseGas + recipientCount * model.gasPerRecipient + claimCount * model.gasPerClaim;
}

/**
 * Whether one more recipient carrying `claimCount` claims still fits.
 * All three ceilings are independent; the tightest one closes the batch.
 */
function fits(
  limits: BatchLimits,
  model: BatchGasModel,
  recipientCount: number,
  claimCount: number,
): boolean {
  return recipientCount <= limits.maxRecipients
    && claimCount <= limits.maxClaims
    && estimateGas(model, recipientCount, claimCount) <= limits.maxGas;
}

/**
 * The largest claim count one recipient can carry alone — the slice
 * bound. Closed-form from the linear gas model; `limits_admit_no_batch` has
 * already guaranteed fits(1, 1), so this is at least 1.
 */
function maxClaimsAlone(limits: BatchLimits, model: BatchGasModel): number {
  const byGas = Math.floor(
    (limits.maxGas - model.baseGas - model.gasPerRecipient) / model.gasPerClaim,
  );
  return Math.min(limits.maxClaims, byGas);
}

/**
 * Split a cycle's work into transaction-sized batches.
 *
 * Contributors must arrive in the kernel's own order — strictly ascending by
 * address (`RecipientsNotStrictlyOrdered`) — and that order is preserved.
 * Cursor ranges are contiguous and monotonic across the whole plan, matching
 * the kernel's single `nextFinalizedCursor`.
 *
 * What an emitted batch is guaranteed to satisfy: recipient count (non-zero,
 * within the kernel ceiling), strict ascending order above `address(0)`,
 * per-recipient non-zero claim counts summing to the batch total, well-formed
 * non-zero claim ids that are unique across the plan, and the cursor shape
 * `cursorEnd - cursorStart == claimCount`. It is NOT a blanket guarantee of
 * submittability: `batchId`, `recordPointsAtomic`, `beneficiaryClass` under a
 * differential policy, and every Genesis-specific claim field are not part of
 * this function's input, so the caller still validates those.
 *
 * A contributor whose own claim count cannot fit a single transaction is SPLIT
 * across consecutive sole-occupant slice batches (; the decision the
 * retired `recipient_exceeds_claim_bound` rejection deferred). The kernel
 * applies its floor arithmetic per recipient PER BATCH, so a contributor split
 * into N slices can receive up to N-1 wei less than a hypothetical
 * single-batch settlement, and the batch-scope Provian floor recomputes per
 * slice — ruled acceptable (wei-bounded, deterministic, and never starves a
 * contributor the way a whole-plan rejection did). Slices preserve claim-id
 * order, stay unique across the plan, and keep cursor ranges contiguous; each
 * slice fits alone under all three ceilings.
 */
export function planSettlementBatches(
  workItems: readonly SettlementWorkItem[],
  limits: BatchLimits,
  gasModel: BatchGasModel,
  startCursor: bigint,
): BatchPlanResult {
  if (!isValidLimits(limits)) return { kind: 'rejected', reason: 'invalid_limits' };
  if (!isValidGasModel(gasModel)) return { kind: 'rejected', reason: 'invalid_gas_model' };
  if (typeof startCursor !== 'bigint' || startCursor < 0n) {
    return { kind: 'rejected', reason: 'invalid_cursor' };
  }
  if (limits.maxRecipients > KERNEL_MAX_RECIPIENTS_PER_BATCH) {
    return { kind: 'rejected', reason: 'limits_exceed_kernel_ceiling' };
  }
  // A single one-claim recipient must fit, or no batch can ever be emitted.
  if (!fits(limits, gasModel, 1, 1)) {
    return { kind: 'rejected', reason: 'limits_admit_no_batch' };
  }

  const batches: PlannedBatch[] = [];
  let current: SettlementWorkItem[] = [];
  let currentClaims = 0;
  let cursor = startCursor;
  // Seeded exactly as the kernel seeds `address previous` — which is why a
  // zero-address FIRST recipient is also `RecipientsNotStrictlyOrdered`.
  let previousContributor = ZERO_ADDRESS;
  const seenClaimIds = new Set<string>();

  const flush = (): void => {
    if (current.length === 0) return;
    const cursorEnd = cursor + BigInt(currentClaims);
    batches.push({
      items: current,
      recipientCount: current.length,
      claimCount: currentClaims,
      estimatedGas: estimateGas(gasModel, current.length, currentClaims),
      cursorStart: cursor,
      cursorEnd,
    });
    cursor = cursorEnd;
    current = [];
    currentClaims = 0;
  };

  for (const item of workItems) {
    if (!isValidWorkItem(item)) return { kind: 'rejected', reason: 'invalid_work_item' };

    const contributor = item.contributor.toLowerCase();
    if (contributor === previousContributor && previousContributor !== ZERO_ADDRESS) {
      return { kind: 'rejected', reason: 'duplicate_contributor', contributor };
    }
    if (contributor <= previousContributor) {
      return { kind: 'rejected', reason: 'recipients_not_strictly_ordered', contributor };
    }
    previousContributor = contributor;

    // The kernel's pre-pass only checks `claimSettled` against PRIOR state, so
    // a duplicate inside one batch survives validation and reverts mid-mint.
    // Compared case-normalized: two hex spellings are one bytes32 on chain.
    for (const claimId of item.claimIds) {
      const normalized = claimId.toLowerCase();
      if (seenClaimIds.has(normalized)) {
        return { kind: 'rejected', reason: 'duplicate_claim_id', contributor };
      }
      seenClaimIds.add(normalized);
    }

    // an oversized contributor is split across consecutive
    // sole-occupant slice batches instead of rejecting the whole plan. Claim
    // ids were validated and dedup-registered above, so every slice inherits
    // that; the pre-plan `limits_admit_no_batch` check guarantees the slice
    // bound is at least one claim.
    if (!fits(limits, gasModel, 1, item.claimIds.length)) {
      flush();
      const sliceBound = maxClaimsAlone(limits, gasModel);
      for (let start = 0; start < item.claimIds.length; start += sliceBound) {
        const slice = item.claimIds.slice(start, start + sliceBound);
        current.push({ contributor: item.contributor, claimIds: slice });
        currentClaims += slice.length;
        flush();
      }
      continue;
    }

    if (!fits(limits, gasModel, current.length + 1, currentClaims + item.claimIds.length)) {
      flush();
    }
    current.push(item);
    currentClaims += item.claimIds.length;
  }
  flush();

  return { kind: 'planned', batches };
}

/**
 * Part 3 - Foundation Stewardship / UBP Allocation Engine
 *
 * The Foundation's 0.5% share splits into two buckets:
 *   - Stewardship: protocol-contribution grants (funded first, capped)
 *   - UBP: Universal Basic Participation (residual claimant)
 *
 * Rules:
 *   1. Stewardship is funded FIRST but CAPPED at the relative ceiling:
 *      stewardship_ceiling_bps of the Foundation share in the period
 *      (default 50%). No absolute PVT cap; the relative ceiling is the
 *      sole bound, since any fixed PVT number is arbitrary without a price.
 *   2. UBP gets the entire residual: Foundation share minus actual stewardship spend.
 *   3. Unspent stewardship budget rolls into UBP at period close;
 *      it does NOT accumulate as a standing bounty pool.
 *
 * Disbursement approval:
 *   - Wire through PreVerificationRegistryStub / W7 governance.
 *   - Interim: single authorized approver (founder) with auditable log.
 *   - Same interface shape for future multi-party governance.
 *
 * No new PVT supply is created. This engine only accounts for how the
 * existing Foundation 0.5% stream is allocated between two purposes.
 */

import crypto from 'crypto';
import { relayDb } from '../../firestore-db';

// =============================================================================
// CONFIGURABLE / GOVERNABLE PARAMETERS
// =============================================================================

export interface FoundationAllocationConfig {
  /** Maximum stewardship share of Foundation income (basis points, out of 10000).
   *  Default: 5000 (50% of Foundation share). This relative ceiling is the
   *  sole stewardship cap. */
  stewardship_ceiling_bps: number;

  /** Quarter duration in milliseconds. Default: ~91 days (365/4).
   *  Governs period boundaries for accounting and rollover. */
  quarter_duration_ms: number;

  /** Whether the allocation engine is active. Default: true.
   *  When false, all Foundation share goes to UBP by default. */
  enabled: boolean;

  /** Authorized approvers for stewardship grant disbursement.
   *  During interim (pre-W7), this is a single founder address.
   *  Post-W7, replaced by multi-party governance quorum.
   *  The approval interface is the same shape in both modes. */
  authorized_approvers: string[];

  updated_at: number;
}

// Canonical quarter length. Period boundaries are an accounting identity, not a
// mutable policy rate: changing them after receipts exist could redirect later
// income or approvals into a different ledger. The config retains the field so
// its persisted shape stays explicit, but only this exact value is accepted.
export const QUARTER_MS = Math.floor(365.25 / 4 * 24 * 60 * 60 * 1000); // ~91.3 days

const DEFAULT_CONFIG: FoundationAllocationConfig = {
  stewardship_ceiling_bps: 5000,
  quarter_duration_ms: QUARTER_MS,
  enabled: true,
  authorized_approvers: [],
  updated_at: 0,
};

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

interface FoundationIncomeReceipt {
  schema_version: 'foundation-income-receipt/v1';
  batch_id: string;
  quarter_id: string;
  period_start_ms: number;
  period_end_ms: number;
  quarter_duration_ms: number;
  foundation_share_atomic: string;
  batch_created_at_ms: number;
  config_updated_at_ms: number;
  config_enabled: boolean;
  stewardship_ceiling_bps: number;
  recorded_at_ms: number;
}

const FOUNDATION_INCOME_RECEIPT_KEYS = Object.freeze([
  'schema_version',
  'batch_id',
  'quarter_id',
  'period_start_ms',
  'period_end_ms',
  'quarter_duration_ms',
  'foundation_share_atomic',
  'batch_created_at_ms',
  'config_updated_at_ms',
  'config_enabled',
  'stewardship_ceiling_bps',
  'recorded_at_ms',
] as const);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function readFoundationIncomeReceipt(value: unknown): FoundationIncomeReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !hasExactKeys(value as Record<string, unknown>, FOUNDATION_INCOME_RECEIPT_KEYS)) {
    throw new Error('foundation_income_receipt_binding_invalid');
  }
  const receipt = value as Partial<FoundationIncomeReceipt>;
  if (receipt.schema_version !== 'foundation-income-receipt/v1'
    || typeof receipt.batch_id !== 'string'
    || !BYTES32.test(receipt.batch_id)
    || typeof receipt.quarter_id !== 'string'
    || !/^Q-?[0-9]+$/.test(receipt.quarter_id)
    || !Number.isSafeInteger(receipt.period_start_ms)
    || !Number.isSafeInteger(receipt.period_end_ms)
    || !Number.isSafeInteger(receipt.quarter_duration_ms)
    || (receipt.quarter_duration_ms ?? 0) <= 0
    || (receipt.period_end_ms ?? 0) - (receipt.period_start_ms ?? 0)
      !== receipt.quarter_duration_ms
    || typeof receipt.foundation_share_atomic !== 'string'
    || !ATOMIC.test(receipt.foundation_share_atomic)
    || !Number.isSafeInteger(receipt.batch_created_at_ms)
    || (receipt.batch_created_at_ms ?? -1) < 0
    || !Number.isSafeInteger(receipt.config_updated_at_ms)
    || (receipt.config_updated_at_ms ?? -1) < 0
    || typeof receipt.config_enabled !== 'boolean'
    || !Number.isSafeInteger(receipt.stewardship_ceiling_bps)
    || (receipt.stewardship_ceiling_bps ?? -1) < 0
    || (receipt.stewardship_ceiling_bps ?? 10_001) > 10_000
    || !Number.isSafeInteger(receipt.recorded_at_ms)
    || (receipt.recorded_at_ms ?? -1) < 0) {
    throw new Error('foundation_income_receipt_binding_invalid');
  }
  return receipt as FoundationIncomeReceipt;
}

export async function loadFoundationAllocationConfig(
  injectedDb?: FirebaseFirestore.Firestore,
): Promise<FoundationAllocationConfig> {
  const db = injectedDb ?? relayDb();
  const doc = await db.collection('pvt_config').doc('foundation_allocation').get();
  if (!doc.exists) {
    return { ...DEFAULT_CONFIG };
  }
  const data = doc.data() as Partial<FoundationAllocationConfig> | undefined;
  if (!data
    || !Number.isSafeInteger(data.stewardship_ceiling_bps)
    || (data.stewardship_ceiling_bps ?? -1) < 0
    || (data.stewardship_ceiling_bps ?? 10_001) > 10_000
    || data.quarter_duration_ms !== QUARTER_MS
    || typeof data.enabled !== 'boolean'
    || !Array.isArray(data.authorized_approvers)
    || data.authorized_approvers.some((value) => typeof value !== 'string' || !value.trim())
    || new Set(data.authorized_approvers).size !== data.authorized_approvers.length
    || !Number.isSafeInteger(data.updated_at)
    || (data.updated_at ?? -1) < 0) {
    throw new Error('foundation_allocation_config_invalid');
  }
  return data as FoundationAllocationConfig;
}

export function invalidateFoundationAllocationConfigCache(): void {
  // Backward-compatible test/operator hook. Economic policy reads are no
  // longer cached, so every new receipt observes the current exact document.
}

// =============================================================================
// PERIOD MANAGEMENT
// =============================================================================

/**
 * Determine the current quarter boundaries.
 * Quarters are aligned to a fixed epoch start (2026-01-01T00:00:00Z).
 */
const EPOCH_START = new Date('2026-01-01T00:00:00Z').getTime();

export function getCurrentQuarter(now: number = Date.now(), quarterMs: number = QUARTER_MS): {
  quarter_id: string;
  start_ms: number;
  end_ms: number;
} {
  const elapsed = now - EPOCH_START;
  const quarterIndex = Math.floor(elapsed / quarterMs);
  const start = EPOCH_START + quarterIndex * quarterMs;
  const end = start + quarterMs;
  return {
    quarter_id: `Q${quarterIndex}`,
    start_ms: start,
    end_ms: end,
  };
}

// =============================================================================
// ALLOCATION ACCOUNTING
// =============================================================================

export interface FoundationPeriodAccounting {
  quarter_id: string;
  start_ms: number;
  end_ms: number;
  /** Total Foundation share received this period (PVT, stored as string for precision). */
  total_foundation_pvt: string;
  /** Stewardship budget = Foundation share × stewardship_ceiling_bps. */
  stewardship_budget_pvt: string;
  /** Actually disbursed stewardship grants this period. */
  stewardship_disbursed_pvt: string;
  /** UBP allocation = total_foundation - stewardship_disbursed. */
  ubp_allocation_pvt: string;
  /** @deprecated Legacy field name retained for existing period documents. */
  ubc_allocation_pvt?: string;
  /** Number of grants disbursed this period. */
  grants_disbursed_count: number;
  updated_at: number;
}

/**
 * Compute the stewardship budget for a period given the Foundation's
 * total income and the config parameters.
 *
 * Budget = Foundation share × stewardship_ceiling_bps / 10000
 *
 * The cap is purely the relative ceiling (default 50% of the Foundation
 * share). An absolute PVT cap was removed: with no external PVT price and
 * no known supply, any fixed number is arbitrary, and the relative ceiling
 * already bounds stewardship to at most its configured fraction of whatever
 * the Foundation share turns out to be, at whatever PVT ends up worth.
 */
export function computeStewardshipBudget(
  foundationSharePvt: number,
  config: FoundationAllocationConfig,
): number {
  return (foundationSharePvt * config.stewardship_ceiling_bps) / 10000;
}

/**
 * Compute the allocation split for a given Foundation share amount.
 * Pure function - no side effects.
 */
export function computeAllocationSplit(
  foundationSharePvt: number,
  stewardshipDisbursedPvt: number,
  config: FoundationAllocationConfig,
): {
  stewardship_budget: number;
  stewardship_disbursed: number;
  stewardship_remaining: number;
  ubp_allocation: number;
  /** @deprecated Legacy alias retained for callers not yet migrated. */
  ubc_allocation: number;
} {
  const budget = computeStewardshipBudget(foundationSharePvt, config);
  const capped = Math.min(stewardshipDisbursedPvt, budget);
  return {
    stewardship_budget: budget,
    stewardship_disbursed: capped,
    stewardship_remaining: budget - capped,
    ubp_allocation: foundationSharePvt - capped,
    ubc_allocation: foundationSharePvt - capped,
  };
}

/**
 * Parse a PVT wei value to BigInt, tolerating a legacy float/exponent string
 * left by the old parseFloat accounting path (e.g. "5e+17"). New writes are
 * always integer wei strings; this only stops legacy data from crashing BigInt().
 */
function toWeiBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  if (/^-?\d+$/.test(value)) return BigInt(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n));
}

/**
 * Exact wei accumulation for Foundation income.
 *
 * total_foundation_pvt is an 18-decimal wei string. parseFloat loses precision
 * above 2^53 (~9.0e15 wei ≈ 0.009 PVT), so summing batch shares as floats drifts
 * — and the interface explicitly documents the field as "stored as string for
 * precision". BigInt is exact regardless of magnitude.
 */
export function accumulateFoundationWei(existingWei: string | undefined, additionWei: string): string {
  return (toWeiBigInt(existingWei) + toWeiBigInt(additionWei)).toString();
}

function readFoundationPeriod(
  value: unknown,
  expected: { quarterId: string; startMs: number; endMs: number },
): FoundationPeriodAccounting {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('foundation_income_period_invalid');
  }
  const period = value as Partial<FoundationPeriodAccounting>;
  if (period.quarter_id !== expected.quarterId
    || period.start_ms !== expected.startMs
    || period.end_ms !== expected.endMs
    || !Number.isSafeInteger(period.start_ms)
    || !Number.isSafeInteger(period.end_ms)
    || (period.end_ms ?? 0) <= (period.start_ms ?? 0)
    || typeof period.total_foundation_pvt !== 'string'
    || !ATOMIC.test(period.total_foundation_pvt)
    || typeof period.stewardship_budget_pvt !== 'string'
    || !ATOMIC.test(period.stewardship_budget_pvt)
    || typeof period.stewardship_disbursed_pvt !== 'string'
    || !ATOMIC.test(period.stewardship_disbursed_pvt)
    || typeof period.ubp_allocation_pvt !== 'string'
    || !ATOMIC.test(period.ubp_allocation_pvt)
    || (period.ubc_allocation_pvt !== undefined
      && (typeof period.ubc_allocation_pvt !== 'string'
        || !ATOMIC.test(period.ubc_allocation_pvt)))
    || !Number.isSafeInteger(period.grants_disbursed_count)
    || (period.grants_disbursed_count ?? -1) < 0
    || !Number.isSafeInteger(period.updated_at)
    || (period.updated_at ?? -1) < 0) {
    throw new Error('foundation_income_period_invalid');
  }
  const total = BigInt(period.total_foundation_pvt);
  const budget = BigInt(period.stewardship_budget_pvt);
  const disbursed = BigInt(period.stewardship_disbursed_pvt);
  const ubp = BigInt(period.ubp_allocation_pvt);
  if (budget > total
    || disbursed > budget
    || ubp !== total - disbursed
    || (period.ubc_allocation_pvt !== undefined && BigInt(period.ubc_allocation_pvt) !== ubp)) {
    throw new Error('foundation_income_period_invalid');
  }
  return period as FoundationPeriodAccounting;
}

function readReconciledFoundationBatch(
  value: unknown,
  batchId: string,
  foundationSharePvt: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('foundation_income_batch_binding_invalid');
  }
  const batch = value as Record<string, unknown>;
  const atomicFields = [
    batch.authoritative_total_pvt_minted,
    batch.authoritative_contributor_total,
    batch.authoritative_provian_share,
    batch.authoritative_foundation_share,
    batch.authoritative_human_share_portion,
    batch.authoritative_agent_share_portion,
  ];
  if (batch.batch_id !== batchId
    || batch.marked !== true
    || batch.reconciliation_status !== 'event_reconciled'
    || batch.foundation_share !== foundationSharePvt
    || batch.authoritative_foundation_share !== foundationSharePvt
    || typeof batch.mint_tx_hash !== 'string'
    || !BYTES32.test(batch.mint_tx_hash)
    || !Number.isSafeInteger(batch.created_at)
    || (batch.created_at as number) < 0
    || !['pending', 'complete'].includes(String(batch.foundation_income_status))
    || atomicFields.some((field) => typeof field !== 'string' || !ATOMIC.test(field))) {
    throw new Error('foundation_income_batch_binding_invalid');
  }
  const total = BigInt(batch.authoritative_total_pvt_minted as string);
  const contributor = BigInt(batch.authoritative_contributor_total as string);
  const provian = BigInt(batch.authoritative_provian_share as string);
  const foundation = BigInt(batch.authoritative_foundation_share as string);
  const human = BigInt(batch.authoritative_human_share_portion as string);
  const agent = BigInt(batch.authoritative_agent_share_portion as string);
  if (total !== contributor + provian + foundation || contributor !== human + agent) {
    throw new Error('foundation_income_batch_binding_invalid');
  }
  return batch;
}

/**
 * Record Foundation share from a mint batch into the period accounting.
 * Called after each successful mint batch.
 */
export async function recordFoundationIncome(
  foundationSharePvt: string,
  batchId: string,
  db?: FirebaseFirestore.Firestore,
): Promise<void> {
  if (!ATOMIC.test(foundationSharePvt) || !BYTES32.test(batchId)) {
    throw new Error('foundation_income_input_invalid');
  }
  const firestore = db ?? relayDb();
  const config = await loadFoundationAllocationConfig(firestore);
  const batchRef = firestore.collection('pvt_mint_batches').doc(batchId);
  const receiptRef = firestore.collection('foundation_income_receipts').doc(batchId);

  await firestore.runTransaction(async (txn) => {
    const batchSnap = await txn.get(batchRef);
    if (!batchSnap.exists) throw new Error('foundation_income_batch_binding_invalid');
    const batch = readReconciledFoundationBatch(
      batchSnap.data(),
      batchId,
      foundationSharePvt,
    );
    const receiptSnap = await txn.get(receiptRef);
    if (receiptSnap.exists) {
      const receipt = readFoundationIncomeReceipt(receiptSnap.data());
      if (receipt.batch_id !== batchId
        || receipt.foundation_share_atomic !== foundationSharePvt
        || receipt.batch_created_at_ms !== batch.created_at) {
        throw new Error('foundation_income_receipt_binding_invalid');
      }
      const periodRef = firestore.collection('foundation_allocation').doc(receipt.quarter_id);
      const periodSnap = await txn.get(periodRef);
      if (!periodSnap.exists) throw new Error('foundation_income_period_invalid');
      const period = readFoundationPeriod(periodSnap.data(), {
        quarterId: receipt.quarter_id,
        startMs: receipt.period_start_ms,
        endMs: receipt.period_end_ms,
      });
      if (BigInt(period.total_foundation_pvt) < BigInt(foundationSharePvt)) {
        throw new Error('foundation_income_period_invalid');
      }
      txn.update(batchRef, { foundation_income_status: 'complete' });
      return;
    }
    if (batch.foundation_income_status === 'complete') {
      throw new Error('foundation_income_receipt_missing');
    }

    const quarter = getCurrentQuarter(batch.created_at as number, config.quarter_duration_ms);
    const docRef = firestore.collection('foundation_allocation').doc(quarter.quarter_id);
    const doc = await txn.get(docRef);

    const addition = BigInt(foundationSharePvt);
    const updatedAt = Date.now();
    if (doc.exists) {
      const data = readFoundationPeriod(doc.data(), {
        quarterId: quarter.quarter_id,
        startMs: quarter.start_ms,
        endMs: quarter.end_ms,
      });
      const newTotal = BigInt(data.total_foundation_pvt) + addition;
      const disbursed = BigInt(data.stewardship_disbursed_pvt);
      const incrementalBudget = config.enabled
        ? (addition * BigInt(config.stewardship_ceiling_bps)) / 10_000n
        : 0n;
      // Each receipt contributes budget under the policy bound into that
      // receipt. A later policy change cannot reprice earlier Foundation
      // income. readFoundationPeriod already proves existing budget >= spend.
      const budget = BigInt(data.stewardship_budget_pvt) + incrementalBudget;
      txn.update(docRef, {
        total_foundation_pvt: newTotal.toString(),
        stewardship_budget_pvt: budget.toString(),
        ubp_allocation_pvt: (newTotal - disbursed).toString(),
        ubc_allocation_pvt: (newTotal - disbursed).toString(),
        updated_at: updatedAt,
      });
    } else {
      const budget = config.enabled
        ? (addition * BigInt(config.stewardship_ceiling_bps)) / 10_000n
        : 0n;
      txn.set(docRef, {
        quarter_id: quarter.quarter_id,
        start_ms: quarter.start_ms,
        end_ms: quarter.end_ms,
        total_foundation_pvt: foundationSharePvt,
        stewardship_budget_pvt: budget.toString(),
        stewardship_disbursed_pvt: '0',
        ubp_allocation_pvt: foundationSharePvt,
        ubc_allocation_pvt: foundationSharePvt,
        grants_disbursed_count: 0,
        updated_at: updatedAt,
      });
    }
    txn.create(receiptRef, {
      schema_version: 'foundation-income-receipt/v1',
      batch_id: batchId,
      quarter_id: quarter.quarter_id,
      period_start_ms: quarter.start_ms,
      period_end_ms: quarter.end_ms,
      quarter_duration_ms: config.quarter_duration_ms,
      foundation_share_atomic: foundationSharePvt,
      batch_created_at_ms: batch.created_at,
      config_updated_at_ms: config.updated_at,
      config_enabled: config.enabled,
      stewardship_ceiling_bps: config.stewardship_ceiling_bps,
      recorded_at_ms: updatedAt,
    });
    txn.update(batchRef, { foundation_income_status: 'complete' });
  });
}

/** Drain every durable post-mint Foundation accounting marker before new minting. */
export async function reconcilePendingFoundationIncome(
  firestore: FirebaseFirestore.Firestore,
): Promise<number> {
  let reconciled = 0;
  while (true) {
    const page = await firestore.collection('pvt_mint_batches')
      .where('foundation_income_status', '==', 'pending')
      .limit(200)
      .get();
    if (page.empty) return reconciled;
    for (const doc of page.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (data.batch_id !== doc.id || typeof data.foundation_share !== 'string') {
        throw new Error('foundation_income_pending_batch_invalid');
      }
      await recordFoundationIncome(data.foundation_share, doc.id, firestore);
      reconciled += 1;
    }
  }
}

/**
 * Close a quarter: roll unspent stewardship into UBP.
 * Called by a scheduler at quarter boundaries.
 */
export async function closeQuarterAllocation(
  quarterId: string,
  db?: FirebaseFirestore.Firestore,
): Promise<FoundationPeriodAccounting | null> {
  const firestore = db ?? relayDb();

  const docRef = firestore.collection('foundation_allocation').doc(quarterId);
  const doc = await docRef.get();
  if (!doc.exists) return null;

  const raw = doc.data() as Partial<FoundationPeriodAccounting> | undefined;
  const data = readFoundationPeriod(raw, {
    quarterId,
    startMs: raw?.start_ms as number,
    endMs: raw?.end_ms as number,
  });
  // Closing is accounting-only. A later mutable config must never rewrite a
  // receipt-backed budget or reduce already-disbursed stewardship. Unspent
  // budget is already represented by UBP = total - actual disbursement.
  const totalWei = BigInt(data.total_foundation_pvt);
  const disbursedWei = BigInt(data.stewardship_disbursed_pvt);
  const ubpWei = totalWei - disbursedWei;

  const closed: Partial<FoundationPeriodAccounting> = {
    stewardship_budget_pvt: data.stewardship_budget_pvt,
    stewardship_disbursed_pvt: data.stewardship_disbursed_pvt,
    ubp_allocation_pvt: ubpWei.toString(),
    ubc_allocation_pvt: ubpWei.toString(),
    updated_at: Date.now(),
  };

  await docRef.update(closed);
  return { ...data, ...closed } as FoundationPeriodAccounting;
}

// =============================================================================
// GRANT DISBURSEMENT
// =============================================================================

export interface GrantDisbursementRequest {
  /** Recipient wallet address. */
  recipient_address: string;
  /** PVT amount to disburse (string for precision). */
  amount_pvt: string;
  /** Human-readable purpose. */
  purpose: string;
  /** The approver's identifier (wallet address or user_id). */
  approver_id: string;
}

export interface GrantDisbursementRecord {
  grant_id: string;
  quarter_id: string;
  recipient_address: string;
  amount_pvt: string;
  purpose: string;
  approver_id: string;
  approval_method: 'interim_single_approver' | 'w7_governance_vote';
  approved_at: number;
  status: 'approved' | 'disbursed' | 'failed';
  /** SHA-256 content hash of the immutable fields. Computed at creation,
   *  never recomputed. Any field change breaks the hash, proving tampering. */
  content_hash: string;
}

/**
 * Compute the content hash for a grant record. Covers all economically
 * meaningful fields so any change to amount, recipient, approver, or
 * timing is detectable.
 */
function computeGrantContentHash(record: Omit<GrantDisbursementRecord, 'content_hash'>): string {
  const payload = [
    record.grant_id,
    record.quarter_id,
    record.recipient_address,
    record.amount_pvt,
    record.purpose,
    record.approver_id,
    record.approval_method,
    record.approved_at.toString(),
    record.status,
  ].join('|');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Verify that a grant record's content_hash matches its fields.
 * Returns true if the record is intact, false if tampered.
 */
export function verifyGrantIntegrity(record: GrantDisbursementRecord): boolean {
  const { content_hash, ...rest } = record;
  return computeGrantContentHash(rest) === content_hash;
}

export type GrantApprovalError =
  | 'NOT_AUTHORIZED'
  | 'BUDGET_EXCEEDED'
  | 'ENGINE_DISABLED'
  | 'INVALID_AMOUNT';

/**
 * Approve a stewardship grant disbursement.
 *
 * The approval interface is the same shape that multi-party governance
 * will later use. During interim (pre-W7), a single authorized approver
 * can approve. Post-W7, the authorized_approvers list is replaced by a
 * governance vote result that produces the same approver_id.
 *
 * Every approval is written to an auditable Firestore log regardless
 * of the approval method.
 */
export async function approveGrantDisbursement(
  request: GrantDisbursementRequest,
  db?: FirebaseFirestore.Firestore,
): Promise<{
  success: boolean;
  grant_id?: string;
  error?: GrantApprovalError;
  error_detail?: string;
}> {
  const firestore = db ?? relayDb();
  const config = await loadFoundationAllocationConfig(firestore);

  if (!config.enabled) {
    return { success: false, error: 'ENGINE_DISABLED' };
  }

  // Validate approver authorization
  if (!config.authorized_approvers.includes(request.approver_id)) {
    return {
      success: false,
      error: 'NOT_AUTHORIZED',
      error_detail: `Approver '${request.approver_id}' is not in the authorized approvers list`,
    };
  }

  // WS7 (#39): the ledger fields (total_foundation_pvt, stewardship_disbursed_pvt)
  // are exact integer strings accumulated via BigInt (accumulateFoundationWei).
  // parseFloat loses low-order digits above 2^53, so the budget/cap comparison
  // must run in exact BigInt too — otherwise the spend-side cap decision drifts
  // from the accumulation-side ledger. amount_pvt is the same integer unit.
  if (!ATOMIC.test(request.amount_pvt)) {
    return { success: false, error: 'INVALID_AMOUNT' };
  }
  const amountWei = BigInt(request.amount_pvt);
  if (amountWei <= 0n) return { success: false, error: 'INVALID_AMOUNT' };

  const quarter = getCurrentQuarter(Date.now(), config.quarter_duration_ms);
  const periodRef = firestore.collection('foundation_allocation').doc(quarter.quarter_id);

  // Transactional budget check and disbursement recording
  const grantId = `grant_${quarter.quarter_id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const result = await firestore.runTransaction(async (txn) => {
    const periodDoc = await txn.get(periodRef);

    const data = periodDoc.exists
      ? readFoundationPeriod(periodDoc.data(), {
        quarterId: quarter.quarter_id,
        startMs: quarter.start_ms,
        endMs: quarter.end_ms,
      })
      : null;
    const totalFoundationWei = data ? BigInt(data.total_foundation_pvt) : 0n;
    const alreadyDisbursedWei = data ? BigInt(data.stewardship_disbursed_pvt) : 0n;
    const grantCount = data?.grants_disbursed_count ?? 0;
    // The receipt-backed period ledger is authoritative. Config governs new
    // income and approver access, but cannot retroactively enlarge or shrink a
    // budget after receipts/disbursements exist.
    const budgetWei = data ? BigInt(data.stewardship_budget_pvt) : 0n;
    const newDisbursedWei = alreadyDisbursedWei + amountWei;

    if (newDisbursedWei > budgetWei) {
      const remainingWei = budgetWei > alreadyDisbursedWei ? budgetWei - alreadyDisbursedWei : 0n;
      return {
        success: false as const,
        error: 'BUDGET_EXCEEDED' as const,
        error_detail: `Requested ${amountWei.toString()} PVT but only ${remainingWei.toString()} PVT remaining in stewardship budget (budget: ${budgetWei.toString()}, already disbursed: ${alreadyDisbursedWei.toString()})`,
      };
    }

    // Update period accounting (all fields stay exact integer wei strings).
    if (data) {
      txn.update(periodRef, {
        stewardship_disbursed_pvt: newDisbursedWei.toString(),
        stewardship_budget_pvt: budgetWei.toString(),
        ubp_allocation_pvt: (totalFoundationWei - newDisbursedWei).toString(),
        ubc_allocation_pvt: (totalFoundationWei - newDisbursedWei).toString(),
        grants_disbursed_count: grantCount + 1,
        updated_at: Date.now(),
      });
    }

    // Write APPEND-ONLY auditable grant record.
    // Uses txn.create() which fails if the doc already exists (Firestore
    // guarantees). Content hash covers all economically meaningful fields
    // so any post-creation tampering is detectable via verifyGrantIntegrity().
    const approvedAt = Date.now();
    const baseRecord = {
      grant_id: grantId,
      quarter_id: quarter.quarter_id,
      recipient_address: request.recipient_address,
      amount_pvt: request.amount_pvt,
      purpose: request.purpose,
      approver_id: request.approver_id,
      approval_method: 'interim_single_approver' as const,
      approved_at: approvedAt,
      status: 'approved' as const,
    };
    const grantRecord: GrantDisbursementRecord = {
      ...baseRecord,
      content_hash: computeGrantContentHash(baseRecord),
    };
    txn.create(
      firestore.collection('foundation_grants').doc(grantId),
      grantRecord,
    );

    return { success: true as const, grant_id: grantId };
  });

  return result;
}

/**
 * Get the current period's allocation status (for dashboard/API).
 */
export async function getCurrentAllocationStatus(
  db?: FirebaseFirestore.Firestore,
): Promise<{
  quarter_id: string;
  total_foundation_pvt: string;
  stewardship_budget: number;
  stewardship_disbursed: number;
  stewardship_remaining: number;
  ubp_allocation: number;
  /** @deprecated Legacy alias retained for callers not yet migrated. */
  ubc_allocation: number;
  grants_count: number;
} | null> {
  const firestore = db ?? relayDb();
  const config = await loadFoundationAllocationConfig(firestore);
  const quarter = getCurrentQuarter(Date.now(), config.quarter_duration_ms);

  const doc = await firestore.collection('foundation_allocation').doc(quarter.quarter_id).get();
  if (!doc.exists) {
    return {
      quarter_id: quarter.quarter_id,
      total_foundation_pvt: '0',
      stewardship_budget: 0,
      stewardship_disbursed: 0,
      stewardship_remaining: 0,
      ubp_allocation: 0,
      ubc_allocation: 0,
      grants_count: 0,
    };
  }

  const data = readFoundationPeriod(doc.data(), {
    quarterId: quarter.quarter_id,
    startMs: quarter.start_ms,
    endMs: quarter.end_ms,
  });
  // #39: compute the split in exact BigInt (matches the ledger + the grant cap),
  // converting to Number only at this display boundary. Exact for balances
  // ≤ 2^53 wei; above that a JS `number` cannot represent wei exactly anyway, so
  // the unavoidable truncation happens once, at the very end, not throughout.
  const totalWei = BigInt(data.total_foundation_pvt);
  const disbursedWei = BigInt(data.stewardship_disbursed_pvt);
  const budgetWei = BigInt(data.stewardship_budget_pvt);
  const remainingWei = budgetWei - disbursedWei;
  const ubpWei = totalWei - disbursedWei;

  return {
    quarter_id: quarter.quarter_id,
    total_foundation_pvt: data.total_foundation_pvt,
    stewardship_budget: Number(budgetWei),
    stewardship_disbursed: Number(disbursedWei),
    stewardship_remaining: Number(remainingWei),
    ubp_allocation: Number(ubpWei),
    ubc_allocation: Number(ubpWei),
    grants_count: data.grants_disbursed_count || 0,
  };
}

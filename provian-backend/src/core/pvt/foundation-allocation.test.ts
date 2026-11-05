/**
 * foundation-allocation: unit tests
 *
 * Covers: cap binds on percentage when economy small, cap binds on
 * absolute quarterly amount when share is large, unspent stewardship
 * rolls to UBP at period close, disbursement requires logged approval,
 * interim single-approver works and is auditable, approval interface
 * shape matches future multi-party governance.
 */

import {
  computeStewardshipBudget,
  computeAllocationSplit,
  getCurrentQuarter,
  approveGrantDisbursement,
  verifyGrantIntegrity,
  closeQuarterAllocation,
  getCurrentAllocationStatus,
  loadFoundationAllocationConfig,
  recordFoundationIncome,
  reconcilePendingFoundationIncome,
  accumulateFoundationWei,
  invalidateFoundationAllocationConfigCache,
  QUARTER_MS,
  type FoundationAllocationConfig,
  type FoundationPeriodAccounting,
} from './foundation-allocation';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';

jest.mock('firebase-admin', () => ({
  firestore: Object.assign(
    () => { throw new Error('Use injected db'); },
    {
      FieldValue: {
        increment: (n: number) => ({ __increment: n }),
      },
    },
  ),
}));

const smallEconomyConfig: FoundationAllocationConfig = {
  stewardship_ceiling_bps: 5000,      // 50%
  quarter_duration_ms: QUARTER_MS,
  enabled: true,
  authorized_approvers: ['founder_frank'],
  updated_at: 0,
};

const BATCH_1 = `0x${'11'.repeat(32)}`;
const BATCH_2 = `0x${'22'.repeat(32)}`;
const BATCH_3 = `0x${'33'.repeat(32)}`;

function seedReconciledBatch(
  db: FakeFirestore,
  batchId: string,
  foundationShare: string,
  options: { createdAt?: number; status?: 'pending' | 'complete' } = {},
): void {
  db.store.set(`pvt_mint_batches/${batchId}`, {
    batch_id: batchId,
    marked: true,
    mint_tx_hash: `0x${'aa'.repeat(32)}`,
    reconciliation_status: 'event_reconciled',
    foundation_share: foundationShare,
    authoritative_total_pvt_minted: foundationShare,
    authoritative_contributor_total: '0',
    authoritative_provian_share: '0',
    authoritative_foundation_share: foundationShare,
    authoritative_human_share_portion: '0',
    authoritative_agent_share_portion: '0',
    created_at: options.createdAt ?? Date.now(),
    foundation_income_status: options.status ?? 'pending',
  });
}

describe('foundation-allocation: computeStewardshipBudget', () => {
  it('budget is the ceiling percentage of a small Foundation share', () => {
    // Foundation receives 100 PVT in a quarter. 50% ceiling = 50 PVT.
    const budget = computeStewardshipBudget(100, smallEconomyConfig);
    expect(budget).toBe(50);
  });

  it('budget scales with the share (no absolute cap)', () => {
    // Foundation receives 50,000 PVT. 50% ceiling = 25,000 PVT.
    // There is no absolute cap, so the budget is the full 25,000.
    const budget = computeStewardshipBudget(50000, smallEconomyConfig);
    expect(budget).toBe(25000);
  });

  it('budget tracks the share linearly at the ceiling rate', () => {
    // 20,000 share × 50% = 10,000.
    const budget = computeStewardshipBudget(20000, smallEconomyConfig);
    expect(budget).toBe(10000);
  });

  it('zero Foundation share → zero budget', () => {
    const budget = computeStewardshipBudget(0, smallEconomyConfig);
    expect(budget).toBe(0);
  });
});

describe('foundation-allocation: computeAllocationSplit', () => {
  it('UBP gets everything when no stewardship disbursed', () => {
    const split = computeAllocationSplit(1000, 0, smallEconomyConfig);
    expect(split.stewardship_budget).toBe(500); // 50% of 1000
    expect(split.stewardship_disbursed).toBe(0);
    expect(split.stewardship_remaining).toBe(500);
    expect(split.ubp_allocation).toBe(1000);
    expect(split.ubc_allocation).toBe(1000);
  });

  it('UBP gets residual after partial stewardship spend', () => {
    const split = computeAllocationSplit(1000, 200, smallEconomyConfig);
    expect(split.stewardship_disbursed).toBe(200);
    expect(split.stewardship_remaining).toBe(300); // 500 budget - 200 spent
    expect(split.ubp_allocation).toBe(800); // 1000 - 200
    expect(split.ubc_allocation).toBe(800); // deprecated alias
  });

  it('stewardship disbursed is capped at budget', () => {
    // Try to disburse more than the budget
    const split = computeAllocationSplit(1000, 9999, smallEconomyConfig);
    expect(split.stewardship_disbursed).toBe(500); // capped at budget (50% of 1000)
    expect(split.stewardship_remaining).toBe(0);
    expect(split.ubp_allocation).toBe(500); // 1000 - 500 (capped)
    expect(split.ubc_allocation).toBe(500); // deprecated alias
  });
});

describe('foundation-allocation: getCurrentQuarter', () => {
  it('returns consistent quarter_id for timestamps within same quarter', () => {
    const base = new Date('2026-03-01T00:00:00Z').getTime();
    const q1 = getCurrentQuarter(base);
    const q2 = getCurrentQuarter(base + 1000 * 60 * 60 * 24 * 30); // +30 days
    expect(q1.quarter_id).toBe(q2.quarter_id);
  });

  it('different quarter_id for timestamps in different quarters', () => {
    const q1Start = new Date('2026-01-01T00:00:00Z').getTime();
    const q2Start = q1Start + 92 * 24 * 60 * 60 * 1000; // ~92 days later
    const q1 = getCurrentQuarter(q1Start);
    const q2 = getCurrentQuarter(q2Start);
    expect(q1.quarter_id).not.toBe(q2.quarter_id);
  });
});

describe('foundation-allocation: exact policy reads', () => {
  it('rejects a mutable quarter boundary instead of redirecting accounting', async () => {
    const db = createFakeFirestore();
    db.store.set('pvt_config/foundation_allocation', {
      ...smallEconomyConfig,
      quarter_duration_ms: QUARTER_MS + 1,
    });

    await expect(loadFoundationAllocationConfig(
      db as unknown as FirebaseFirestore.Firestore,
    )).rejects.toThrow('foundation_allocation_config_invalid');
  });
});

describe('foundation-allocation: approveGrantDisbursement', () => {
  let db: FakeFirestore;

  beforeEach(() => {
    db = createFakeFirestore();
    invalidateFoundationAllocationConfigCache();

    // Seed config
    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 5000,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: Date.now(),
    });
  });

  it('disbursement requires a logged approval from authorized approver', async () => {
    // Seed period with Foundation income
    const quarter = getCurrentQuarter();
    db.store.set(`foundation_allocation/${quarter.quarter_id}`, {
      quarter_id: quarter.quarter_id,
      start_ms: quarter.start_ms,
      end_ms: quarter.end_ms,
      total_foundation_pvt: '1000',
      stewardship_budget_pvt: '500',
      stewardship_disbursed_pvt: '0',
      ubp_allocation_pvt: '1000',
      ubc_allocation_pvt: '1000',
      grants_disbursed_count: 0,
      updated_at: Date.now(),
    });

    const result = await approveGrantDisbursement(
      {
        recipient_address: '0xRecipient',
        amount_pvt: '100',
        purpose: 'Protocol contribution grant Q1',
        approver_id: 'founder_frank',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result.success).toBe(true);
    expect(result.grant_id).toBeDefined();

    // Verify auditable grant record was written
    const grantDoc = db.store.get(`foundation_grants/${result.grant_id}`);
    expect(grantDoc).toBeDefined();
    expect(grantDoc!.approver_id).toBe('founder_frank');
    expect(grantDoc!.approval_method).toBe('interim_single_approver');
    expect(grantDoc!.amount_pvt).toBe('100');
    expect(grantDoc!.purpose).toBe('Protocol contribution grant Q1');
    expect(grantDoc!.status).toBe('approved');
  });

  it('rejects unauthorized approver', async () => {
    const result = await approveGrantDisbursement(
      {
        recipient_address: '0xRecipient',
        amount_pvt: '100',
        purpose: 'test',
        approver_id: 'unauthorized_person',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('NOT_AUTHORIZED');
  });

  it('rejects when budget would be exceeded', async () => {
    const quarter = getCurrentQuarter();
    db.store.set(`foundation_allocation/${quarter.quarter_id}`, {
      quarter_id: quarter.quarter_id,
      start_ms: quarter.start_ms,
      end_ms: quarter.end_ms,
      total_foundation_pvt: '100',  // 50% ceiling = 50 PVT budget
      stewardship_budget_pvt: '50',
      stewardship_disbursed_pvt: '40',
      ubp_allocation_pvt: '60',
      ubc_allocation_pvt: '60',
      grants_disbursed_count: 1,
      updated_at: Date.now(),
    });

    const result = await approveGrantDisbursement(
      {
        recipient_address: '0xRecipient',
        amount_pvt: '20', // 40 + 20 = 60 > 50 budget
        purpose: 'over budget',
        approver_id: 'founder_frank',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('BUDGET_EXCEEDED');
  });

  it('rejects invalid amount', async () => {
    const result = await approveGrantDisbursement(
      {
        recipient_address: '0xRecipient',
        amount_pvt: '-5',
        purpose: 'test',
        approver_id: 'founder_frank',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('INVALID_AMOUNT');
  });

  it('rejects when engine is disabled', async () => {
    db.store.set('pvt_config/foundation_allocation', {
      ...db.store.get('pvt_config/foundation_allocation'),
      enabled: false,
    });
    invalidateFoundationAllocationConfigCache();

    const result = await approveGrantDisbursement(
      {
        recipient_address: '0xRecipient',
        amount_pvt: '100',
        purpose: 'test',
        approver_id: 'founder_frank',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('ENGINE_DISABLED');
  });

  it('approval interface shape: grant_id, approval_method, approved_at are always present', async () => {
    const quarter = getCurrentQuarter();
    db.store.set(`foundation_allocation/${quarter.quarter_id}`, {
      quarter_id: quarter.quarter_id,
      start_ms: quarter.start_ms,
      end_ms: quarter.end_ms,
      total_foundation_pvt: '10000',
      stewardship_budget_pvt: '5000',
      stewardship_disbursed_pvt: '0',
      ubp_allocation_pvt: '10000',
      ubc_allocation_pvt: '10000',
      grants_disbursed_count: 0,
      updated_at: Date.now(),
    });

    const result = await approveGrantDisbursement(
      {
        recipient_address: '0xRecipient',
        amount_pvt: '500',
        purpose: 'Dev tooling grant',
        approver_id: 'founder_frank',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result.success).toBe(true);
    const grantDoc = db.store.get(`foundation_grants/${result.grant_id}`) as Record<string, unknown>;

    // These fields must exist for future W7 governance to consume the same shape
    expect(grantDoc).toHaveProperty('grant_id');
    expect(grantDoc).toHaveProperty('approval_method');
    expect(grantDoc).toHaveProperty('approved_at');
    expect(grantDoc).toHaveProperty('approver_id');
    expect(grantDoc).toHaveProperty('quarter_id');
    expect(grantDoc).toHaveProperty('status');
    expect(grantDoc).toHaveProperty('content_hash');
  });

  it('grant record has a valid content hash (tamper detection)', async () => {
    const quarter = getCurrentQuarter();
    db.store.set(`foundation_allocation/${quarter.quarter_id}`, {
      quarter_id: quarter.quarter_id,
      start_ms: quarter.start_ms,
      end_ms: quarter.end_ms,
      total_foundation_pvt: '10000',
      stewardship_budget_pvt: '5000',
      stewardship_disbursed_pvt: '0',
      ubp_allocation_pvt: '10000',
      ubc_allocation_pvt: '10000',
      grants_disbursed_count: 0,
      updated_at: Date.now(),
    });

    const result = await approveGrantDisbursement(
      {
        recipient_address: '0xHash',
        amount_pvt: '100',
        purpose: 'Hash test',
        approver_id: 'founder_frank',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );

    const grantDoc = db.store.get(`foundation_grants/${result.grant_id}`) as Record<string, unknown>;
    expect(verifyGrantIntegrity(grantDoc as any)).toBe(true);

    // Tamper with the amount - hash should no longer verify
    const tampered = { ...grantDoc, amount_pvt: '99999' };
    expect(verifyGrantIntegrity(tampered as any)).toBe(false);
  });

  it('grant record is append-only (duplicate write throws)', async () => {
    const quarter = getCurrentQuarter();
    db.store.set(`foundation_allocation/${quarter.quarter_id}`, {
      quarter_id: quarter.quarter_id,
      start_ms: quarter.start_ms,
      end_ms: quarter.end_ms,
      total_foundation_pvt: '50000',
      stewardship_budget_pvt: '10000',
      stewardship_disbursed_pvt: '0',
      ubp_allocation_pvt: '50000',
      ubc_allocation_pvt: '50000',
      grants_disbursed_count: 0,
      updated_at: Date.now(),
    });

    const result1 = await approveGrantDisbursement(
      {
        recipient_address: '0xFirst',
        amount_pvt: '100',
        purpose: 'First grant',
        approver_id: 'founder_frank',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );
    expect(result1.success).toBe(true);

    // Manually trying to overwrite the grant doc should throw
    const grantRef = (db as unknown as FirebaseFirestore.Firestore)
      .collection('foundation_grants')
      .doc(result1.grant_id!);
    await expect(grantRef.create({ fake: 'overwrite' })).rejects.toThrow('already exists');
  });
});

describe('foundation-allocation: closeQuarterAllocation', () => {
  let db: FakeFirestore;

  beforeEach(() => {
    db = createFakeFirestore();
    invalidateFoundationAllocationConfigCache();

    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 5000,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: Date.now(),
    });
  });

  it('unspent stewardship rolls to UBP at period close', async () => {
    const quarterId = 'Q_test_close';
    db.store.set(`foundation_allocation/${quarterId}`, {
      quarter_id: quarterId,
      start_ms: 0,
      end_ms: 1,
      total_foundation_pvt: '1000',
      stewardship_budget_pvt: '500',
      stewardship_disbursed_pvt: '200', // spent 200 of 500 budget
      ubp_allocation_pvt: '800',
      ubc_allocation_pvt: '800',
      grants_disbursed_count: 2,
      updated_at: Date.now(),
    });

    const result = await closeQuarterAllocation(
      quarterId,
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result).not.toBeNull();
    // UBP should be: 1000 (total) - 200 (disbursed) = 800
    expect(parseFloat(result!.ubp_allocation_pvt)).toBe(800);
    expect(parseFloat(result!.ubc_allocation_pvt!)).toBe(800);
    // Stewardship disbursed stays at 200
    expect(parseFloat(result!.stewardship_disbursed_pvt)).toBe(200);
    // Remaining 300 of budget rolled into UBP (implicit: UBP = total - disbursed)
  });

  it('returns null for nonexistent quarter', async () => {
    const result = await closeQuarterAllocation(
      'Q_nonexistent',
      db as unknown as FirebaseFirestore.Firestore,
    );
    expect(result).toBeNull();
  });

  it('#39: closes with exact BigInt (writes exact wei above 2^53, not float-drifted)', async () => {
    const quarterId = 'Q_test_close_big';
    // total 18014398509481985 (odd, > 2^53). budget (5000 bps) = 9007199254740992
    // (floor of ...992.5); disbursed already at budget; ubp = total − capped =
    // 9007199254740993. The old float path collapses total→...984 and writes
    // ubp '9007199254740992' (off by 1 wei).
    db.store.set(`foundation_allocation/${quarterId}`, {
      quarter_id: quarterId,
      start_ms: 0,
      end_ms: 1,
      total_foundation_pvt: '18014398509481985',
      stewardship_budget_pvt: '9007199254740992',
      stewardship_disbursed_pvt: '9007199254740992',
      ubp_allocation_pvt: '9007199254740993',
      ubc_allocation_pvt: '9007199254740993',
      grants_disbursed_count: 3,
      updated_at: Date.now(),
    });

    const result = await closeQuarterAllocation(quarterId, db as unknown as FirebaseFirestore.Firestore);
    expect(result).not.toBeNull();
    expect(result!.stewardship_budget_pvt).toBe('9007199254740992');
    expect(result!.stewardship_disbursed_pvt).toBe('9007199254740992');
    expect(result!.ubp_allocation_pvt).toBe('9007199254740993'); // exact, not ...992
    expect(result!.ubc_allocation_pvt!).toBe('9007199254740993');
  });

  it('does not let a later policy shrink the receipt-backed budget or disbursement', async () => {
    const quarterId = 'Q_test_close_policy_change';
    db.store.set(`foundation_allocation/${quarterId}`, {
      quarter_id: quarterId,
      start_ms: 0,
      end_ms: 1,
      total_foundation_pvt: '1000',
      stewardship_budget_pvt: '500',
      stewardship_disbursed_pvt: '400',
      ubp_allocation_pvt: '600',
      ubc_allocation_pvt: '600',
      grants_disbursed_count: 1,
      updated_at: Date.now(),
    });
    db.store.set('pvt_config/foundation_allocation', {
      ...db.store.get('pvt_config/foundation_allocation'),
      stewardship_ceiling_bps: 1000,
      updated_at: Date.now() + 1,
    });

    const result = await closeQuarterAllocation(
      quarterId,
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result!.stewardship_budget_pvt).toBe('500');
    expect(result!.stewardship_disbursed_pvt).toBe('400');
    expect(result!.ubp_allocation_pvt).toBe('600');
  });
});

describe('foundation-allocation: getCurrentAllocationStatus', () => {
  let db: FakeFirestore;

  beforeEach(() => {
    db = createFakeFirestore();
    invalidateFoundationAllocationConfigCache();
    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 5000,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: Date.now(),
    });
  });

  it('reports the split computed in exact BigInt for normal balances', async () => {
    const quarter = getCurrentQuarter();
    db.store.set(`foundation_allocation/${quarter.quarter_id}`, {
      quarter_id: quarter.quarter_id,
      start_ms: quarter.start_ms,
      end_ms: quarter.end_ms,
      total_foundation_pvt: '1000',
      stewardship_budget_pvt: '500',
      stewardship_disbursed_pvt: '200',
      ubp_allocation_pvt: '800',
      ubc_allocation_pvt: '800',
      grants_disbursed_count: 2,
      updated_at: Date.now(),
    });

    const status = await getCurrentAllocationStatus(db as unknown as FirebaseFirestore.Firestore);
    expect(status).not.toBeNull();
    expect(status!.stewardship_budget).toBe(500); // 50% of 1000
    expect(status!.stewardship_disbursed).toBe(200);
    expect(status!.stewardship_remaining).toBe(300);
    expect(status!.ubp_allocation).toBe(800); // 1000 − 200
    expect(status!.total_foundation_pvt).toBe('1000'); // raw wei string preserved
    expect(status!.grants_count).toBe(2);
  });

  it('returns a zeroed status for a period with no income yet', async () => {
    const status = await getCurrentAllocationStatus(db as unknown as FirebaseFirestore.Firestore);
    expect(status).not.toBeNull();
    expect(status!.stewardship_budget).toBe(0);
    expect(status!.ubp_allocation).toBe(0);
  });
});

// WS7: total_foundation_pvt is an 18-decimal wei string accumulated via parseFloat,
// which loses precision above 2^53. The fix uses exact BigInt accumulation.
describe('foundation-allocation: wei-exact income accumulation (WS7)', () => {
  it('accumulateFoundationWei is exact', () => {
    // Two 18-significant-digit wei values that sum to exactly 1 PVT (1e18 wei).
    expect(accumulateFoundationWei('123456789012345678', '876543210987654322')).toBe(
      '1000000000000000000',
    );
  });

  it('preserves wei precision that parseFloat loses above 2^53', () => {
    // 2^53 + 1 — the smallest integer NOT exactly representable as a double.
    const x = '9007199254740993';
    expect(accumulateFoundationWei(x, '0')).toBe('9007199254740993'); // exact
    // The old float path collapses it to 2^53, silently dropping 1 wei.
    expect(parseFloat(x).toString()).toBe('9007199254740992');
  });

  it('does not drift over many small (1-wei) accumulations', () => {
    let total = '0';
    for (let i = 0; i < 1000; i++) total = accumulateFoundationWei(total, '1');
    expect(total).toBe('1000');
  });

  it('tolerates a legacy float/exponent string already in storage', () => {
    expect(accumulateFoundationWei('5e17', '500000000000000000')).toBe('1000000000000000000');
  });

  it('approveGrantDisbursement caps on exact BigInt wei (rejects a grant a float budget would wrongly allow above 2^53)', async () => {
    // #39: the spend-side cap must run in exact BigInt, matching the exact
    // BigInt accumulation on the income side. Pick values where parseFloat
    // drift flips the decision:
    //   total = 18014398509481985 wei (odd, > 2^53). Float rounds it to
    //     18014398509481984, so budget_float = 9007199254740992.
    //   Exact budget (5000 bps) = 9007199254740992 (floor of ...992.5).
    //   disbursed = 9007199254740992 (exactly at budget). amount = 1 wei.
    //   Exact: 9007199254740992 + 1 = ...993 > ...992 → BUDGET_EXCEEDED.
    //   Float: (...992 + 1) rounds back to ...992, ...992 > ...992 is false
    //          → the old parseFloat path would ALLOW an over-disbursement.
    const db = createFakeFirestore();
    invalidateFoundationAllocationConfigCache();
    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 5000,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: Date.now(),
    });
    const quarter = getCurrentQuarter();
    db.store.set(`foundation_allocation/${quarter.quarter_id}`, {
      quarter_id: quarter.quarter_id,
      start_ms: quarter.start_ms,
      end_ms: quarter.end_ms,
      total_foundation_pvt: '18014398509481985',
      stewardship_budget_pvt: '9007199254740992',
      stewardship_disbursed_pvt: '9007199254740992',
      ubp_allocation_pvt: '9007199254740993',
      ubc_allocation_pvt: '9007199254740993',
      grants_disbursed_count: 1,
      updated_at: Date.now(),
    });

    const result = await approveGrantDisbursement(
      {
        recipient_address: '0xPrecision',
        amount_pvt: '1', // 1 wei over the exact budget
        purpose: 'precision boundary',
        approver_id: 'founder_frank',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('BUDGET_EXCEEDED');
  });

  it('approveGrantDisbursement allows a grant that exactly hits the BigInt budget', async () => {
    const db = createFakeFirestore();
    invalidateFoundationAllocationConfigCache();
    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 5000,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: Date.now(),
    });
    const quarter = getCurrentQuarter();
    // budget = 18014398509481984 * 5000/10000 = 9007199254740992 exactly.
    db.store.set(`foundation_allocation/${quarter.quarter_id}`, {
      quarter_id: quarter.quarter_id,
      start_ms: quarter.start_ms,
      end_ms: quarter.end_ms,
      total_foundation_pvt: '18014398509481984',
      stewardship_budget_pvt: '9007199254740992',
      stewardship_disbursed_pvt: '9007199254740991',
      ubp_allocation_pvt: '9007199254740993',
      ubc_allocation_pvt: '9007199254740993',
      grants_disbursed_count: 1,
      updated_at: Date.now(),
    });

    const result = await approveGrantDisbursement(
      {
        recipient_address: '0xExact',
        amount_pvt: '1', // brings disbursed to exactly the budget
        purpose: 'exact boundary',
        approver_id: 'founder_frank',
      },
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(result.success).toBe(true);
    const period = db.store.get(`foundation_allocation/${quarter.quarter_id}`)!;
    expect(period.stewardship_disbursed_pvt).toBe('9007199254740992');
  });

  it('recordFoundationIncome accumulates two large batches with wei-exact precision', async () => {
    const db = createFakeFirestore();
    invalidateFoundationAllocationConfigCache();
    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 5000,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: Date.now(),
    });

    const fs = db as unknown as FirebaseFirestore.Firestore;
    seedReconciledBatch(db, BATCH_1, '123456789012345678');
    seedReconciledBatch(db, BATCH_2, '876543210987654322');
    // First batch creates the period doc; second hits the accumulation path.
    await recordFoundationIncome('123456789012345678', BATCH_1, fs);
    await recordFoundationIncome('876543210987654322', BATCH_2, fs);
    // Exact replay is a no-op even if the mutable config has since changed.
    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 2500,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: Date.now() + 1,
    });
    invalidateFoundationAllocationConfigCache();
    await recordFoundationIncome('123456789012345678', BATCH_1, fs);

    const quarter = getCurrentQuarter();
    const doc = db.store.get(`foundation_allocation/${quarter.quarter_id}`);
    expect(doc!.total_foundation_pvt).toBe('1000000000000000000');
    expect(db.store.get(`pvt_mint_batches/${BATCH_1}`)!.foundation_income_status).toBe('complete');
    expect(db.store.get(`pvt_mint_batches/${BATCH_2}`)!.foundation_income_status).toBe('complete');
    expect(db.store.has(`foundation_income_receipts/${BATCH_1}`)).toBe(true);
    expect(db.store.has(`foundation_income_receipts/${BATCH_2}`)).toBe(true);
  });

  it('binds each receipt to its own fresh policy without repricing earlier income', async () => {
    const db = createFakeFirestore();
    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 5000,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: 1,
    });
    seedReconciledBatch(db, BATCH_1, '100');
    seedReconciledBatch(db, BATCH_2, '100');
    seedReconciledBatch(db, BATCH_3, '100');
    const fs = db as unknown as FirebaseFirestore.Firestore;

    await recordFoundationIncome('100', BATCH_1, fs);
    db.store.set('pvt_config/foundation_allocation', {
      ...db.store.get('pvt_config/foundation_allocation'),
      stewardship_ceiling_bps: 10_000,
      updated_at: 2,
    });
    // No cache invalidation: the second receipt must observe this policy now,
    // but it may add budget only for its own 100 atomic units.
    await recordFoundationIncome('100', BATCH_2, fs);
    db.store.set('pvt_config/foundation_allocation', {
      ...db.store.get('pvt_config/foundation_allocation'),
      stewardship_ceiling_bps: 0,
      updated_at: 3,
    });
    await recordFoundationIncome('100', BATCH_3, fs);

    const quarter = getCurrentQuarter();
    const period = db.store.get(`foundation_allocation/${quarter.quarter_id}`)!;
    expect(period.total_foundation_pvt).toBe('300');
    expect(period.stewardship_budget_pvt).toBe('150'); // 50 + 100 + 0

    db.store.set('pvt_config/foundation_allocation', {
      ...db.store.get('pvt_config/foundation_allocation'),
      stewardship_ceiling_bps: 10_000,
      updated_at: 4,
    });
    const result = await approveGrantDisbursement({
      recipient_address: '0xPolicyMutation',
      amount_pvt: '151',
      purpose: 'must not reprice prior receipts',
      approver_id: 'founder_frank',
    }, fs);
    expect(result).toMatchObject({ success: false, error: 'BUDGET_EXCEEDED' });
    const status = await getCurrentAllocationStatus(fs);
    expect(status!.stewardship_budget).toBe(150);
  });

  it('reconciles every pending batch exactly once before another mint can proceed', async () => {
    const db = createFakeFirestore();
    invalidateFoundationAllocationConfigCache();
    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 5000,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: Date.now(),
    });
    seedReconciledBatch(db, BATCH_1, '10');
    seedReconciledBatch(db, BATCH_2, '20');

    const reconciled = await reconcilePendingFoundationIncome(
      db as unknown as FirebaseFirestore.Firestore,
    );

    expect(reconciled).toBe(2);
    const quarter = getCurrentQuarter();
    expect(db.store.get(`foundation_allocation/${quarter.quarter_id}`)!.total_foundation_pvt)
      .toBe('30');
    expect(db.store.get(`pvt_mint_batches/${BATCH_1}`)!.foundation_income_status).toBe('complete');
    expect(db.store.get(`pvt_mint_batches/${BATCH_2}`)!.foundation_income_status).toBe('complete');
    await expect(reconcilePendingFoundationIncome(
      db as unknown as FirebaseFirestore.Firestore,
    )).resolves.toBe(0);
  });

  it('fails closed without a receipt or ledger write when the reconciled event binding is malformed', async () => {
    const db = createFakeFirestore();
    invalidateFoundationAllocationConfigCache();
    db.store.set('pvt_config/foundation_allocation', {
      stewardship_ceiling_bps: 5000,
      quarter_duration_ms: QUARTER_MS,
      enabled: true,
      authorized_approvers: ['founder_frank'],
      updated_at: Date.now(),
    });
    seedReconciledBatch(db, BATCH_1, '10');
    db.store.set(`pvt_mint_batches/${BATCH_1}`, {
      ...db.store.get(`pvt_mint_batches/${BATCH_1}`),
      authoritative_total_pvt_minted: '9',
    });

    await expect(recordFoundationIncome(
      '10',
      BATCH_1,
      db as unknown as FirebaseFirestore.Firestore,
    )).rejects.toThrow('foundation_income_batch_binding_invalid');
    expect(db.store.has(`foundation_income_receipts/${BATCH_1}`)).toBe(false);
    expect([...db.store.keys()].some((key) => key.startsWith('foundation_allocation/'))).toBe(false);
    expect(db.store.get(`pvt_mint_batches/${BATCH_1}`)!.foundation_income_status).toBe('pending');
  });
});

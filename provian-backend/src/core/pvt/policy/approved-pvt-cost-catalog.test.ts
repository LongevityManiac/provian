import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  APPROVED_COST_CATALOG_STATUS,
  APPROVED_COURT_COST_ROWS,
  APPROVED_ESCROW_COST_ROWS,
  APPROVED_JOB_BACKEND_ROWS,
  APPROVED_JOB_INHERITOR_ROWS,
  APPROVED_POOL_COST_ROWS,
  APPROVED_PROMISE_COST_ROWS,
  APPROVED_PVT_COST_CATALOG,
  FROZEN_COST_CATALOG_SHA256,
  NO_ROWS_APPROVED_STATUS,
  assertAllInstitutionsInBandFor,
  assertFailClosed,
  assertFailClosedFor,
  getApprovedCostValue,
  isAnyCostApproved,
  isAnyPoolCostApproved,
  isAnyPromiseCostApproved,
  isApprovedValueInBand,
  isJobBackendValueInBand,
  resolveApprovedCostValue,
  resolveApprovedCourtCostValue,
  resolveApprovedPoolCostValue,
  resolveApprovedPromiseCostValue,
  type ApprovedEscrowCostRow,
  type ApprovedPoolCostRow,
  type ApprovedPromiseCostRow,
  type CourtCostId,
  type EscrowRootedCostId,
  type InheritedApprovedCostRow,
  type PoolCostId,
  type PromiseCostId,
} from './approved-pvt-cost-catalog';

const PVT = 10n ** 18n;

function escrowRowsWith(overrides: Partial<Record<string, bigint | null>>): ApprovedEscrowCostRow[] {
  return APPROVED_ESCROW_COST_ROWS.map((row) => ({
    ...row,
    approved: overrides[row.cost_id] !== undefined ? overrides[row.cost_id]! : null,
  }));
}

describe('approved-pvt-cost-catalog — binds the byte-frozen proposal catalog', () => {
  it('FROZEN_COST_CATALOG_SHA256 equals the on-disk sha256 of the proposal catalog', () => {
    const catalogPath = path.join(__dirname, 'proposed-pvt-cost-catalog.ts');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(catalogPath)).digest('hex');
    expect(actual).toBe(FROZEN_COST_CATALOG_SHA256);
    expect(FROZEN_COST_CATALOG_SHA256).toBe(
      'd1a5844c334077471c939861585770b658654abd75786b110c8617055f6a0049',
    );
  });

  it('the catalog records the same bound hash', () => {
    expect(APPROVED_PVT_COST_CATALOG.frozen_proposal_sha256).toBe(FROZEN_COST_CATALOG_SHA256);
  });
});

describe('approved-pvt-cost-catalog — Agent Bank institutions RECORDED (institution parameters-rem)', () => {
  it('status/scope advanced to the recorded-institutions record (not the nothing-approved sentinel)', () => {
    expect(APPROVED_COST_CATALOG_STATUS).toBe('agent_bank_institutions_recorded');
    expect(APPROVED_PVT_COST_CATALOG.status).toBe('agent_bank_institutions_recorded');
    expect(APPROVED_PVT_COST_CATALOG.scope).toBe('agent_bank_institutions');
    expect(APPROVED_PVT_COST_CATALOG.status).not.toBe(NO_ROWS_APPROVED_STATUS);
  });

  it('assertFailClosed() does not throw on the shipped record (every institution in band)', () => {
    expect(() => assertFailClosed()).not.toThrow();
  });
});

describe('approved-pvt-cost-catalog — Escrow anchor', () => {
  const RATIFIED: Record<string, bigint | null> = {
    'escrow.pvt_principal_fee': 50n,
    'escrow.pvt_principal_cap': null,
    'escrow.maximum_auto_release_period': null,
    'escrow.maximum_agreement_deadline': null,
    'escrow.dispute_resolution_timeout': 2_592_000n,
  };

  it('has exactly the five escrow.* rows in canonical order', () => {
    expect(APPROVED_ESCROW_COST_ROWS.map((r) => r.cost_id)).toEqual([
      'escrow.pvt_principal_fee',
      'escrow.pvt_principal_cap',
      'escrow.maximum_auto_release_period',
      'escrow.maximum_agreement_deadline',
      'escrow.dispute_resolution_timeout',
    ]);
  });

  it('each Escrow row records exactly its ratified value', () => {
    for (const row of APPROVED_ESCROW_COST_ROWS) {
      expect(row.approved).toBe(RATIFIED[row.cost_id]);
    }
    expect(isAnyCostApproved()).toBe(true);
  });

  it('getApprovedCostValue resolves each id (and its inheritors) to its ratified value', () => {
    expect(getApprovedCostValue('escrow.pvt_principal_fee')).toBe(50n);
    expect(getApprovedCostValue('escrow.dispute_resolution_timeout')).toBe(2_592_000n);
    expect(getApprovedCostValue('escrow.pvt_principal_cap')).toBeNull();
    expect(getApprovedCostValue('job.pvt_settlement_cost')).toBe(50n);
    expect(getApprovedCostValue('job.maximum_auto_release_period')).toBeNull();
    expect(getApprovedCostValue('escrow.unknown_row' as EscrowRootedCostId)).toBeNull();
  });

  it('each row points at its ProvianEscrowV4 setter with the catalog-declared band', () => {
    const expected: Record<string, { scheduler: string; unit: string; min: bigint; max: bigint }> = {
      'escrow.pvt_principal_fee': { scheduler: 'scheduleFeeBps', unit: 'basis_points', min: 0n, max: 1000n },
      'escrow.pvt_principal_cap': { scheduler: 'schedulePrincipalCap', unit: 'pvt_atomic', min: PVT, max: 10n ** 24n },
      'escrow.maximum_auto_release_period': { scheduler: 'scheduleAutoReleasePeriod', unit: 'seconds', min: 3_600n, max: 7_776_000n },
      'escrow.maximum_agreement_deadline': { scheduler: 'scheduleAgreementDeadline', unit: 'seconds', min: 3_600n, max: 7_776_000n },
      'escrow.dispute_resolution_timeout': { scheduler: 'scheduleDisputeTimeout', unit: 'seconds', min: 172_800n, max: 15_552_000n },
    };
    for (const row of APPROVED_ESCROW_COST_ROWS) {
      expect(row.on_chain.contract).toBe('ProvianEscrowV4');
      expect(row.on_chain.scheduler).toBe(expected[row.cost_id].scheduler);
      expect(row.on_chain.unit).toBe(expected[row.cost_id].unit);
      expect(row.on_chain.min).toBe(expected[row.cost_id].min);
      expect(row.on_chain.max).toBe(expected[row.cost_id].max);
      expect(row.on_chain.min < row.on_chain.max).toBe(true);
      expect(isApprovedValueInBand(row)).toBe(true);
    }
  });

  it('both job inheritors carry no value of their own and resolve to their parent', () => {
    for (const row of APPROVED_JOB_INHERITOR_ROWS) {
      expect(row.approved).toBeNull();
    }
    expect(getApprovedCostValue('job.pvt_settlement_cost')).toBe(getApprovedCostValue('escrow.pvt_principal_fee'));
  });
});

describe('approved-pvt-cost-catalog — Promise current default policy', () => {
  const RATIFIED: Record<string, bigint | null> = {
    'promise.pvt_settlement_fee': 25n,
    'promise.pvt_principal_cap': null,
    'promise.maximum_deadline': null,
    'promise.default_grace_period': 86_400n,
  };

  it('holds exactly the four promise.* rows in canonical order', () => {
    expect(APPROVED_PROMISE_COST_ROWS.map((r) => r.cost_id)).toEqual([
      'promise.pvt_settlement_fee',
      'promise.pvt_principal_cap',
      'promise.maximum_deadline',
      'promise.default_grace_period',
    ]);
  });

  it('records each Promise row at its ratified fallback (fee 25 bps; grace 86,400 s; cap/deadline null)', () => {
    for (const row of APPROVED_PROMISE_COST_ROWS) {
      expect(row.approved).toBe(RATIFIED[row.cost_id]);
    }
    expect(isAnyPromiseCostApproved()).toBe(true);
    expect(resolveApprovedPromiseCostValue('promise.pvt_settlement_fee')).toBe(25n);
    expect(resolveApprovedPromiseCostValue('promise.default_grace_period')).toBe(86_400n);
    expect(resolveApprovedPromiseCostValue('promise.pvt_principal_cap')).toBeNull();
    expect(resolveApprovedPromiseCostValue('promise.unknown' as PromiseCostId)).toBeNull();
  });

  it('each Promise row points at its ProvianPromiseV3 setter with the catalog-declared band', () => {
    const expected: Record<string, { scheduler: string; unit: string; min: bigint; max: bigint }> = {
      'promise.pvt_settlement_fee': { scheduler: 'scheduleSettlementFeeBps', unit: 'basis_points', min: 0n, max: 1000n },
      'promise.pvt_principal_cap': { scheduler: 'schedulePrincipalCap', unit: 'pvt_atomic', min: PVT, max: 1_000_000n * PVT },
      'promise.maximum_deadline': { scheduler: 'scheduleMaximumDeadline', unit: 'seconds', min: 3_600n, max: 7_776_000n },
      'promise.default_grace_period': { scheduler: 'scheduleDefaultGracePeriod', unit: 'seconds', min: 0n, max: 2_592_000n },
    };
    for (const row of APPROVED_PROMISE_COST_ROWS) {
      expect(row.on_chain.contract).toBe('ProvianPromiseV3');
      expect(row.on_chain.scheduler).toBe(expected[row.cost_id].scheduler);
      expect(row.on_chain.unit).toBe(expected[row.cost_id].unit);
      expect(row.on_chain.min).toBe(expected[row.cost_id].min);
      expect(row.on_chain.max).toBe(expected[row.cost_id].max);
      expect(row.on_chain.min < row.on_chain.max).toBe(true);
      expect(isApprovedValueInBand(row)).toBe(true);
    }
  });
});

describe('approved-pvt-cost-catalog — Pool current default policy', () => {
  const RATIFIED: Record<string, bigint | null> = {
    'pool.pvt_execution_fee': 50n,
    'pool.pvt_threshold_cap': null,
    'pool.maximum_deadline': null,
    'pool.maximum_contributors': 200n,
  };

  it('holds exactly the four pool.* rows in canonical order', () => {
    expect(APPROVED_POOL_COST_ROWS.map((r) => r.cost_id)).toEqual([
      'pool.pvt_execution_fee',
      'pool.pvt_threshold_cap',
      'pool.maximum_deadline',
      'pool.maximum_contributors',
    ]);
  });

  it('records each Pool row at its ratified fallback (fee 50 bps; contributors 200; cap/deadline null)', () => {
    for (const row of APPROVED_POOL_COST_ROWS) {
      expect(row.approved).toBe(RATIFIED[row.cost_id]);
    }
    expect(isAnyPoolCostApproved()).toBe(true);
    expect(resolveApprovedPoolCostValue('pool.pvt_execution_fee')).toBe(50n);
    expect(resolveApprovedPoolCostValue('pool.maximum_contributors')).toBe(200n);
    expect(resolveApprovedPoolCostValue('pool.pvt_threshold_cap')).toBeNull();
    expect(resolveApprovedPoolCostValue('pool.unknown' as PoolCostId)).toBeNull();
  });

  it('each Pool row points at its ProvianPoolV3 setter with the catalog-declared band', () => {
    const expected: Record<string, { scheduler: string; unit: string; min: bigint; max: bigint }> = {
      'pool.pvt_execution_fee': { scheduler: 'scheduleFeeBps', unit: 'basis_points', min: 0n, max: 1000n },
      'pool.pvt_threshold_cap': { scheduler: 'scheduleThresholdCap', unit: 'pvt_atomic', min: PVT, max: 1_000_000n * PVT },
      'pool.maximum_deadline': { scheduler: 'scheduleMaximumDeadline', unit: 'seconds', min: 3_600n, max: 15_552_000n },
      'pool.maximum_contributors': { scheduler: 'scheduleMaxContributors', unit: 'count', min: 2n, max: 200n },
    };
    for (const row of APPROVED_POOL_COST_ROWS) {
      expect(row.on_chain.contract).toBe('ProvianPoolV3');
      expect(row.on_chain.scheduler).toBe(expected[row.cost_id].scheduler);
      expect(row.on_chain.unit).toBe(expected[row.cost_id].unit);
      expect(row.on_chain.min).toBe(expected[row.cost_id].min);
      expect(row.on_chain.max).toBe(expected[row.cost_id].max);
      expect(row.on_chain.min < row.on_chain.max).toBe(true);
      expect(isApprovedValueInBand(row)).toBe(true);
    }
  });
});

describe('approved-pvt-cost-catalog — Court cost defaults; arbitration mechanics remain separate', () => {
  it('holds exactly the one court.panel_voting_period cost row (no mechanics rows)', () => {
    expect(APPROVED_COURT_COST_ROWS.map((r) => r.cost_id)).toEqual(['court.panel_voting_period']);
    // No slash-share / collateral / period mechanics rows leak into institution parameters's Court scope.
    for (const other of ['court.panel_size', 'court.case_collateral_slash_equivocation', 'court.generic_reputation_slash_burn_share']) {
      expect(APPROVED_COURT_COST_ROWS.some((r) => r.cost_id === (other as CourtCostId))).toBe(false);
    }
  });

  it('records the panel voting period at its 48-hour (172,800 s) fallback, in-band', () => {
    const row = APPROVED_COURT_COST_ROWS[0];
    expect(row.approved).toBe(172_800n);
    expect(row.on_chain.contract).toBe('ProvianCourtV2');
    expect(row.on_chain.scheduler).toBe('schedulePanelVotingPeriod');
    expect(row.on_chain.min).toBe(86_400n);
    expect(row.on_chain.max).toBe(1_209_600n);
    expect(isApprovedValueInBand(row)).toBe(true);
    expect(resolveApprovedCourtCostValue('court.panel_voting_period')).toBe(172_800n);
    expect(resolveApprovedCourtCostValue('court.unknown' as CourtCostId)).toBeNull();
  });
});

describe('approved-pvt-cost-catalog — job backend limits RECORDED (institution parameters-rem)', () => {
  it('records the three backend job limits at their existing values, each in band', () => {
    const byId = Object.fromEntries(APPROVED_JOB_BACKEND_ROWS.map((r) => [r.cost_id, r]));
    expect(byId['job.maximum_applications'].recorded).toBe(50n);
    expect(byId['job.maximum_deadline'].recorded).toBe(2_419_200n);
    expect(byId['job.pvt_budget_cap'].recorded).toBe(10_000n * PVT);
    for (const row of APPROVED_JOB_BACKEND_ROWS) {
      expect(row.authority).toBe('backend');
      expect(isJobBackendValueInBand(row)).toBe(true);
      expect(row.min <= row.recorded && row.recorded <= row.max).toBe(true);
    }
  });

  it('the catalog object carries every institution section', () => {
    expect(APPROVED_PVT_COST_CATALOG.escrow_rows).toBe(APPROVED_ESCROW_COST_ROWS);
    expect(APPROVED_PVT_COST_CATALOG.promise_rows).toBe(APPROVED_PROMISE_COST_ROWS);
    expect(APPROVED_PVT_COST_CATALOG.pool_rows).toBe(APPROVED_POOL_COST_ROWS);
    expect(APPROVED_PVT_COST_CATALOG.court_rows).toBe(APPROVED_COURT_COST_ROWS);
    expect(APPROVED_PVT_COST_CATALOG.job_backend_rows).toBe(APPROVED_JOB_BACKEND_ROWS);
    expect(APPROVED_PVT_COST_CATALOG.job_inheritor_rows).toBe(APPROVED_JOB_INHERITOR_ROWS);
  });
});

describe('approved-pvt-cost-catalog — drift guards bite (mutation guards)', () => {
  it('isApprovedValueInBand accepts null + in-band, rejects out-of-band', () => {
    const feeRow = APPROVED_ESCROW_COST_ROWS.find((r) => r.cost_id === 'escrow.pvt_principal_fee')!;
    expect(isApprovedValueInBand({ ...feeRow, approved: 50n })).toBe(true);
    expect(isApprovedValueInBand({ ...feeRow, approved: null })).toBe(true);
    expect(isApprovedValueInBand({ ...feeRow, approved: 1001n })).toBe(false);
  });

  it('an out-of-band Promise settlement fee (1001 bps) fails the cross-institution guard', () => {
    const feeRow = APPROVED_PROMISE_COST_ROWS.find((r) => r.cost_id === 'promise.pvt_settlement_fee')!;
    const mutated: ApprovedPromiseCostRow[] = APPROVED_PROMISE_COST_ROWS.map((r) =>
      r.cost_id === 'promise.pvt_settlement_fee' ? { ...feeRow, approved: 1001n } : r,
    );
    expect(() =>
      assertAllInstitutionsInBandFor(mutated, APPROVED_JOB_BACKEND_ROWS, mutated.map((r) => r.cost_id)),
    ).toThrow(/promise\.pvt_settlement_fee approved value is out of its immutable band/);
  });

  it('an out-of-band Pool contributor cap (201) fails the cross-institution guard', () => {
    const capRow = APPROVED_POOL_COST_ROWS.find((r) => r.cost_id === 'pool.maximum_contributors')!;
    const mutated: ApprovedPoolCostRow[] = APPROVED_POOL_COST_ROWS.map((r) =>
      r.cost_id === 'pool.maximum_contributors' ? { ...capRow, approved: 201n } : r,
    );
    expect(() =>
      assertAllInstitutionsInBandFor(mutated, APPROVED_JOB_BACKEND_ROWS, mutated.map((r) => r.cost_id)),
    ).toThrow(/pool\.maximum_contributors approved value is out of its immutable band/);
  });

  it('an out-of-band backend job limit (max applications 501) fails the guard', () => {
    const badJob = APPROVED_JOB_BACKEND_ROWS.map((r) =>
      r.cost_id === 'job.maximum_applications' ? { ...r, recorded: 501n } : r,
    );
    expect(() => assertAllInstitutionsInBandFor([], badJob, [])).toThrow(
      /backend job\.maximum_applications recorded value is out of its immutable band/,
    );
  });

  it('the Escrow anchor status self-gate still fires (no value under no_rows_approved_yet)', () => {
    const drifted = escrowRowsWith({ 'escrow.pvt_principal_fee': 50n });
    expect(() => assertFailClosedFor(drifted, APPROVED_JOB_INHERITOR_ROWS, NO_ROWS_APPROVED_STATUS)).toThrow(
      /status is no_rows_approved_yet but a row carries a value/,
    );
    expect(
      resolveApprovedCostValue('escrow.pvt_principal_fee', drifted, APPROVED_JOB_INHERITOR_ROWS, NO_ROWS_APPROVED_STATUS),
    ).toBeNull();
  });

  it('an inheritor carrying its own value throws', () => {
    const badInheritor: InheritedApprovedCostRow[] = [
      { cost_id: 'job.pvt_settlement_cost', inherits_from: 'escrow.pvt_principal_fee', approved: 1n as unknown as null },
      APPROVED_JOB_INHERITOR_ROWS[1],
    ];
    expect(() => assertFailClosedFor(APPROVED_ESCROW_COST_ROWS, badInheritor, APPROVED_COST_CATALOG_STATUS)).toThrow(
      /inheritor job\.pvt_settlement_cost must not carry its own value/,
    );
  });
});

import fs from 'fs';
import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  computeRecordSnapshot,
  disclosedRationalFactor,
  hashRecordEconomicSnapshot,
  type RecordEconomicSnapshot,
} from './monetary-accounting';
import {
  exactGenesisReservedGrossForRoleAtomic,
  projectCurrentSettlementPEAtomic,
  foldEconomicAccrualRows,
  foldRowIntoTotals,
  emptyEconomicAccrualTotals,
  recordPointsForRoleAtomic,
  resolveContributorIdentities,
  type CurrentSettlementProjectionContext,
} from './economic-projection';
import { PVT9_ELIGIBILITY_CUT_LINE_MS } from '../wp-ev/eligibility';
import { readEconomicAccrualProjection } from './economic-aggregate-read';
import { seedMeteredRows } from '../../meter/__test-helpers__/seed-act-keys';
import { materializeProposedMonetaryPolicy } from './runtime-monetary-policy';

const RECORDED_AT = 10_000;
const UNIT = 10n ** 18n;

function snapshot(actionType: string) {
  return computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId: `pe-${actionType}`,
    economicActorId: 'user-1',
    actionType,
    recordedAtMs: RECORDED_AT,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: null,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: null,
  });
}

function history(actionType: string): PEHistoryDocument {
  const economicSnapshot = snapshot(actionType);
  return {
    peId: economicSnapshot.peId,
    userId: 'user-1',
    actionType,
    timestamp: RECORDED_AT,
    category: 'wallet',
    mint_status: economicSnapshot.mintDisposition === 'eligible' ? 'eligible' : 'record_only',
    mint_disposition: economicSnapshot.mintDisposition,
    attestationDepth: 'software',
    corroboration_status: 'none',
    economic_snapshot: economicSnapshot,
    economic_snapshot_hash: hashRecordEconomicSnapshot(economicSnapshot),
    beneficiary_wallet_id: null,
  } as unknown as PEHistoryDocument;
}

function projectionContext(rateNumerator: bigint, rateDenominator: bigint): CurrentSettlementProjectionContext {
  return {
    projectedAtMs: RECORDED_AT + 1,
    globalMintRate: disclosedRationalFactor(
      rateNumerator,
      rateDenominator,
      '0xPVT.effectiveMintRate',
      'base:123:0xabc',
    ),
  };
}

describe('dashboard monetary truth', () => {
  test('exposes sealed record points separately from a non-final non-unit projection', () => {
    const pe = history('wallet_created');
    const recordPoints = recordPointsForRoleAtomic(pe, 'contributor');
    const context = projectionContext(1n, 2n);
    const currentProjection = projectCurrentSettlementPEAtomic(pe, 'contributor', context);

    expect(recordPoints).toBe(10n * UNIT);
    expect(currentProjection).toBe(5n * UNIT);
    expect(currentProjection).not.toBe(recordPoints);
  });

  test('aggregate output labels projection non-final and includes factor vintage', async () => {
    const pe = history('wallet_created');
    const context = projectionContext(1n, 2n);
    const result = foldEconomicAccrualRows([{ row: pe, role: 'contributor' }], {
      nowMs: RECORDED_AT + 1,
      settlementProjection: context,
    });

    expect(result.totalRecordPointsAtomic).toBe((10n * UNIT).toString());
    expect(result.totalCurrentSettlementProjectionAtomic).toBe((5n * UNIT).toString());
    expect(result.currentSettlementProjection).toEqual({
      label: 'current_settlement_projection_non_final',
      isFinal: false,
      projectedAtMs: RECORDED_AT + 1,
      factorVintage: {
        globalMintRate: context.globalMintRate,
      },
    });
    expect('totalEstimatedPvtAtomic' in result).toBe(false);
  });

  test('fixed Genesis reservation is exposed as exact reserved gross, not an estimate', () => {
    const ordinary = history('wallet_created');
    const base = ordinary.economic_snapshot!;
    const fixedAtomic = 75n * UNIT;
    const genesisSnapshot: RecordEconomicSnapshot = {
      ...base,
      peId: 'pe-genesis-exact',
      actionType: 'genesis_human_signup',
      recordPointsAtomic: fixedAtomic.toString() as RecordEconomicSnapshot['recordPointsAtomic'],
      recordCalculation: {
        numerator: fixedAtomic.toString() as RecordEconomicSnapshot['recordCalculation']['numerator'],
        denominator: '1' as RecordEconomicSnapshot['recordCalculation']['denominator'],
        floorRemainder: '0' as RecordEconomicSnapshot['recordCalculation']['floorRemainder'],
      },
      recordTimeFactors: {
        ...base.recordTimeFactors,
        fixedGrantSource: 'genesis_campaign_reservation',
        fixedGrantAtomic: fixedAtomic.toString() as NonNullable<
        RecordEconomicSnapshot['recordTimeFactors']['fixedGrantAtomic']
        >,
        beneficiaryAgentShareBps: 10_000,
      },
      allowedSettlementAdjustments: {
        verifiedAttestationUpgrade: false,
        globalMintRate: false,
      },
    };
    const pe = {
      ...ordinary,
      peId: genesisSnapshot.peId,
      actionType: genesisSnapshot.actionType,
      economic_snapshot: genesisSnapshot,
      economic_snapshot_hash: hashRecordEconomicSnapshot(genesisSnapshot),
    };
    expect(exactGenesisReservedGrossForRoleAtomic(pe, 'contributor')).toBe(fixedAtomic);
    expect(exactGenesisReservedGrossForRoleAtomic(pe, 'beneficiary')).toBe(0n);
  });

  test('record-only zero and tampered snapshots never project positive value', () => {
    const zero = history('agent_wallet_created');
    expect(recordPointsForRoleAtomic(zero, 'contributor')).toBe(0n);
    expect(projectCurrentSettlementPEAtomic(zero, 'contributor', projectionContext(2n, 1n)))
      .toBe(0n);

    const tampered = {
      ...history('wallet_created'),
      economic_snapshot_hash: `sha256:${'f'.repeat(64)}`,
    };
    expect(recordPointsForRoleAtomic(tampered, 'contributor')).toBeNull();
    expect(projectCurrentSettlementPEAtomic(tampered, 'contributor', projectionContext(1n, 1n)))
      .toBeNull();
  });

  test('dashboard API handlers do not label record points as estimated PVT', () => {
    const serverSource = fs.readFileSync(require.resolve('../../../server'), 'utf8');
    const accrualStart = serverSource.indexOf("app.get('/v1/pvt/accrual'");
    const historyStart = serverSource.indexOf("app.get('/v1/pvt/history'", accrualStart);
    const accrualHandler = serverSource.slice(accrualStart, historyStart);
    expect(accrualHandler).toContain('Sealed record points (not PVT)');
    expect(accrualHandler).toContain('Current settlement projection (non-final)');
    expect(accrualHandler).not.toContain('totalEstimatedPVT');
    expect(accrualHandler).not.toContain('estimatedPVT:');

    const networkStart = serverSource.indexOf("app.get('/v1/pvt/network-stats'");
    const participationStart = serverSource.indexOf("app.get('/v1/participation/summary'", networkStart);
    const participationEnd = serverSource.indexOf('// AGENT SELF-SIGNUP ROUTERS', participationStart);
    const networkHandler = serverSource.slice(networkStart, participationStart);
    const participationHandler = serverSource.slice(participationStart, participationEnd);
    // The ranking lives in network-stats-projection.ts (2026-08-13 consignment
    // rework; H2 close-out made it bounded queries). The handler must
    // delegate to it and the peCount-not-pvt_earned invariant is asserted where
    // the sort key is now chosen.
    expect(networkHandler).toContain('readNetworkStats');
    expect(networkHandler).not.toContain('totalEstimatedPVT:');
    expect(networkHandler).not.toContain('estimatedPVT:');
    expect(networkHandler).not.toContain("orderBy('pvt_earned'");
    const projectionSource = fs.readFileSync(
      require.resolve('../../../network-stats-projection'),
      'utf8',
    );
    expect(projectionSource).toContain("orderBy(WALLET_PE_COUNT_FIELD, 'desc')");
    expect(projectionSource).not.toContain('pvt_earned');
    expect(projectionSource).not.toContain('totalEstimatedPVT');
    expect(participationHandler).not.toContain('pvt_earned_total');
    expect(participationHandler).not.toContain('pvt_earned_this_month');

    // The allocation body used to be written out TWICE inside
    // `routes/pvt.ts` (human branch and agent branch), and this assertion read
    // the route source. It now has a single source — `routes/pvt-allocation-
    // payload.ts` — used by the PVT9-era public read surface (the legacy
    // `routes/pvt.ts` router that also called it was deleted with the PE meter
    // migration), so the labels are pinned where they are actually produced.
    const payloadSource = fs.readFileSync(
      require.resolve('../../../routes/pvt-allocation-payload'), 'utf8',
    );
    expect(payloadSource).toContain("record_points_label: 'sealed_record_points_not_pvt'");
    expect(payloadSource).toContain("label: 'current_settlement_projection_non_final'");
    expect(payloadSource).not.toContain('total_estimated_pvt');

    // …and no route may rebuild it inline and drift from that single source.
    for (const routeModule of ['../../../routes/pvt-public-reads']) {
      const routeSource = fs.readFileSync(require.resolve(routeModule), 'utf8');
      const allocationStart = routeSource.indexOf("'/allocation/:wallet_id'");
      expect(allocationStart).toBeGreaterThan(-1);
      const allocationHandler = routeSource.slice(allocationStart);
      expect(allocationHandler).toContain('buildAllocationPayload({');
      expect(allocationHandler).not.toContain("record_points_label: '");
      expect(allocationHandler).not.toContain('total_estimated_pvt');
    }
  });
});

describe('accrual identity union — a human sees PEs keyed by their own wallet doc id', () => {
  // Server-authored witness PEs (e.g. `service:github_commit`) are keyed by the
  // contributor's WALLET DOCUMENT id, not their `user_...` account id, because the
  // witness/connect id space is the wallets-collection doc id. The accrual read must
  // union the human's own wallet doc ids so those PEs are visible on the dashboard —
  // without ever touching a sealed record.
  function witnessSnapshot(peId: string, economicActorId: string) {
    return computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
      peId,
      economicActorId,
      actionType: 'service:github_commit',
      recordedAtMs: RECORDED_AT,
      occurrenceOrdinal: 1,
      dailyOrdinal: 1,
      exactDuplicate: false,
      uniqueArtifact: false,
      attestationTier: 'software',
      linkageState: 'unlinked',
      evidenceState: 'verified',
      canonicalEventId: null,
      selfReferencing: false,
      sharedBeneficialOwnership: false,
      pairChurnDetected: false,
      sessionLineageId: null,
      genesisReservation: null,
    });
  }
  function commitHistory(peId: string, userId: string): PEHistoryDocument {
    // A commit PE is sealed with economicActorId === userId (writePEHistory enforces
    // it at write time); mirror that so the snapshot/hash stay internally consistent.
    const economicSnapshot = witnessSnapshot(peId, userId);
    return {
      peId,
      userId,
      actionType: 'service:github_commit',
      timestamp: RECORDED_AT,
      category: 'other',
      mint_status: economicSnapshot.mintDisposition === 'eligible' ? 'eligible' : 'record_only',
      mint_disposition: economicSnapshot.mintDisposition,
      attestationDepth: 'software',
      corroboration_status: 'none',
      economic_snapshot: economicSnapshot,
      economic_snapshot_hash: hashRecordEconomicSnapshot(economicSnapshot),
      beneficiary_wallet_id: null,
    } as unknown as PEHistoryDocument;
  }

  test('resolveContributorIdentities returns the account id plus only the account\'s OWN wallet doc ids', async () => {
    const fake = createFakeFirestore();
    fake.store.set('wallets/wallet-A', { id: 'wallet-A', user_id: 'user-1', type: 'human' });
    fake.store.set('wallets/wallet-B', { id: 'wallet-B', user_id: 'user-2', type: 'human' });
    const ids = await resolveContributorIdentities(fake as unknown as Firestore, 'user-1');
    expect(new Set(ids)).toEqual(new Set(['user-1', 'wallet-A']));
    // NEGATIVE CONTROL: another account's wallet is never in the set.
    expect(ids).not.toContain('wallet-B');
  });

  test('unions account-keyed AND own-wallet-keyed PEs, excluding another account\'s wallet-keyed PE', async () => {
    const fake = createFakeFirestore();
    fake.store.set('wallets/wallet-A', { id: 'wallet-A', user_id: 'user-1', type: 'human' });
    fake.store.set('wallets/wallet-B', { id: 'wallet-B', user_id: 'user-2', type: 'human' });

    await seedMeteredRows(fake, [
      history('wallet_created'),              // keyed by user-1 (onboarding)
      commitHistory('pe-witness', 'wallet-A'), // keyed by user-1's OWN wallet doc id
      commitHistory('pe-foreign', 'wallet-B'), // keyed by ANOTHER account's wallet
    ], RECORDED_AT + 1);

    const result = await readEconomicAccrualProjection(
      fake as unknown as Firestore, 'user-1', { nowMs: RECORDED_AT + 1 },
    );

    // Empty-population guard: the union genuinely evaluated a non-empty set.
    expect(result.totalPEs).toBeGreaterThan(0);
    // Positive: the account-keyed onboarding PE AND the wallet-keyed commit PE both count.
    // (This is exactly `2` — RED on the pre-fix single-key query, which counted only 1.)
    expect(result.totalPEs).toBe(2);
    // NEGATIVE CONTROL: the other account's wallet-keyed PE is NEVER pulled in.
    expect(result.pesByCategory.other ?? 0).toBe(1); // pe-witness only, not pe-foreign
  });

  test('RED control: with no ownership row the union does not fire — wallet-keyed PE stays invisible', async () => {
    // Proves the union is GATED on a real `wallets.user_id == userId` row, not a
    // blanket include. No wallets doc → resolveContributorIdentities returns
    // [user-1] only, reproducing the pre-fix single-key query and the production bug.
    const fake = createFakeFirestore();
    await seedMeteredRows(fake, [commitHistory('pe-witness', 'wallet-A')], RECORDED_AT + 1);
    const result = await readEconomicAccrualProjection(
      fake as unknown as Firestore, 'user-1', { nowMs: RECORDED_AT + 1 },
    );
    expect(result.totalPEs).toBe(0);
  });
});

describe('unpriceable-row log severity — legacy quiet, new failures scream', () => {
  // An unpriceable row with NO sealed snapshot at a chosen record time.
  function absentRow(timestampMs: number): PEHistoryDocument {
    return {
      ...history('wallet_created'),
      timestamp: timestampMs,
      economic_snapshot: null,
      economic_snapshot_hash: null,
    } as unknown as PEHistoryDocument;
  }

  function fold(pe: PEHistoryDocument) {
    const totals = emptyEconomicAccrualTotals();
    foldRowIntoTotals(totals, pe, 'contributor', {
      nowMs: RECORDED_AT + 1,
      withProjection: true,
      userIdForLog: 'user-1',
    });
    return totals;
  }

  let errorSpy: jest.SpyInstance;
  let debugSpy: jest.SpyInstance;
  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  const events = (spy: jest.SpyInstance): Array<Record<string, unknown>> =>
    spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

  test('legacy absent (<= cut line, no snapshot) is QUIET but still an integrity failure', () => {
    const totals = fold(absentRow(PVT9_ELIGIBILITY_CUT_LINE_MS));
    // Accounting is byte-identical to before: one integrity failure, excluded from totalPEs.
    expect(totals.integrityFailures).toBe(1);
    expect(totals.totalPEs).toBe(0);
    // RED CONTROL: the pre-fix code logged an ERROR here. It must not any more.
    expect(events(errorSpy)).toHaveLength(0);
    const dbg = events(debugSpy);
    expect(dbg).toHaveLength(1);
    expect(dbg[0].event).toBe('pvt_legacy_unpriceable_row');
  });

  test('NEW absent (> cut line, no snapshot) STILL SCREAMS at ERROR', () => {
    const totals = fold(absentRow(PVT9_ELIGIBILITY_CUT_LINE_MS + 1));
    expect(totals.integrityFailures).toBe(1);
    expect(totals.totalPEs).toBe(0);
    // The load-bearing control: a newly-written row that failed to seal a snapshot
    // is impossible to silence — this is the hole the workstream must never reopen.
    const errs = events(errorSpy);
    expect(errs).toHaveLength(1);
    expect(errs[0].event).toBe('pvt_economic_snapshot_integrity_failure');
    expect(errs[0].reason).toBe('absent');
    expect(events(debugSpy)).toHaveLength(0);
  });

  test('hash mismatch is a real breach — ERROR at any age', () => {
    const tampered = {
      ...history('wallet_created'), // timestamp 10_000, well before the cut line
      economic_snapshot_hash: `sha256:${'f'.repeat(64)}`,
    } as unknown as PEHistoryDocument;
    const totals = fold(tampered);
    expect(totals.integrityFailures).toBe(1);
    const errs = events(errorSpy);
    expect(errs).toHaveLength(1);
    expect(errs[0].event).toBe('pvt_economic_snapshot_integrity_failure');
    expect(errs[0].reason).toBe('hash_mismatch');
    expect(events(debugSpy)).toHaveLength(0);
  });

  test('identity mismatch is a real breach — ERROR', () => {
    const mismatch = {
      ...history('wallet_created'),
      actionType: 'some_other_type', // snapshot.actionType stays 'wallet_created'
    } as unknown as PEHistoryDocument;
    const totals = fold(mismatch);
    expect(totals.integrityFailures).toBe(1);
    const errs = events(errorSpy);
    expect(errs).toHaveLength(1);
    expect(errs[0].reason).toBe('identity_mismatch');
  });

  test('present snapshot missing its Genesis fixed grant stays LOUD', () => {
    const ordinary = history('wallet_created');
    const base = ordinary.economic_snapshot!;
    const gsnap = {
      ...base,
      recordTimeFactors: {
        ...base.recordTimeFactors,
        fixedGrantSource: 'genesis_campaign_reservation',
        fixedGrantAtomic: null,
      },
    } as unknown as RecordEconomicSnapshot;
    const pe = {
      ...ordinary,
      economic_snapshot: gsnap,
      economic_snapshot_hash: hashRecordEconomicSnapshot(gsnap),
    } as unknown as PEHistoryDocument;
    const totals = fold(pe);
    expect(totals.integrityFailures).toBe(1);
    const errs = events(errorSpy);
    expect(errs).toHaveLength(1);
    expect(errs[0].reason).toBe('genesis_fixed_grant_missing');
  });

  test('a priced (sealed) row logs NOTHING and counts normally', () => {
    const totals = fold(history('wallet_created'));
    expect(totals.integrityFailures).toBe(0);
    expect(totals.totalPEs).toBe(1);
    expect(events(errorSpy)).toHaveLength(0);
    expect(events(debugSpy)).toHaveLength(0);
  });
});

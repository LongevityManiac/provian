/**
 * Pending-cache counter resolution — the mint-boundary rebind.
 *
 * A PE recorded while Redis was down carries no counter evidence; the backfill
 * later advances the counters exactly once and the mint boundary re-validates
 * that evidence here.
 *
 * the volume ceilings this validator used to re-check (200/hour,
 * 2000/day, and 's 50/day qualification ordinal) are REMOVED — a
 * recovered slot's COUNTS are unbounded. What the validator still refuses is
 * STRUCTURAL: a slot that was not consumed, a claim bound to a different PE,
 * counters that did not advance by exactly one, or a projection rebuilt at
 * different counts.
 *
 * two recovery vintages validate, keyed by `pending_cache_outcome`.
 * Legacy `eligible_exact_snapshot` rows (reclassified before) keep the
 * sealed snapshot's points; `eligible_novelty_corrected` rows must carry the
 * occurrence-slot evidence AND points equal to the sealed-vintage derivation
 * at the recovered ordinal — and a correction that actually reduced value
 * refuses this (legacy) mint boundary outright, because `computeSettlement`
 * prices from the sealed snapshot. The refusal arms below are the standing
 * negative controls proving none of this is a guard that cannot fail.
 */

import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';

import {
  assertPendingCacheEligibilityProjection,
  buildPendingCacheEligibilityProjection,
  deriveNoveltyCorrectedRecovery,
  type PendingCacheRateLimitEvidence,
  type PendingCacheResolutionRecord,
} from './pending-cache-resolution';
import {
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
  type RecordCalculationInput,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';

const RECORDED_AT = 1_753_000_000_000;
/** utcDayKeyOfMs(RECORDED_AT). */
const RECORDED_DAY = '2025-07-20';
const RECLASSIFIED_AT = RECORDED_AT + 60_000;
const SETTLEMENT_AT = RECORDED_AT + 120_000;
const SNAPSHOT_HASH = `sha256:${crypto.createHash('sha256').update('snapshot').digest('hex')}`;

function evidence(
  hourlyBefore: number,
  dailyBefore: number,
  overrides: Partial<PendingCacheRateLimitEvidence> = {},
): PendingCacheRateLimitEvidence {
  return {
    hourly_count_before: hourlyBefore,
    daily_count_before: dailyBefore,
    hourly_count_after: hourlyBefore + 1,
    daily_count_after: dailyBefore + 1,
    slot_consumed: true,
    redis_claim_id: 'pe_pending_1',
    idempotent_replay: false,
    ...overrides,
  };
}

function record(
  hourlyBefore: number,
  dailyBefore: number,
  evidenceOverrides: Partial<PendingCacheRateLimitEvidence> = {},
): PendingCacheResolutionRecord {
  return {
    peId: 'pe_pending_1',
    userId: 'user_pending_1',
    timestamp: RECORDED_AT,
    economic_snapshot_hash: SNAPSHOT_HASH,
    pending_cache_reclassified_at: RECLASSIFIED_AT,
    pending_cache_outcome: 'eligible_exact_snapshot',
    pending_cache_rate_limit_evidence: evidence(hourlyBefore, dailyBefore, evidenceOverrides),
  };
}

function projection(hourlyBefore: number, dailyBefore: number) {
  return buildPendingCacheEligibilityProjection(
    'pe_pending_1',
    'user_pending_1',
    SNAPSHOT_HASH,
    RECLASSIFIED_AT,
    hourlyBefore,
    dailyBefore,
  );
}

// ---------------------------------------------------------------------------
// fixtures — a REAL sealed pending-cache snapshot (wallet_created,
// 10 record points at its sealed ordinal-1 full novelty)
// ---------------------------------------------------------------------------

function sealedSnapshot(
  overrides: Partial<RecordCalculationInput> = {},
): RecordEconomicSnapshot {
  return computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId: 'pe_pending_1',
    economicActorId: 'user_pending_1',
    actionType: 'wallet_created',
    recordedAtMs: RECORDED_AT,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'not_required',
    canonicalEventId: null,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: null,
    operationalDispositionOverride: {
      mintDisposition: 'pending_cache',
      mintReasonCode: 'cache_unavailable',
      suppressRecordPoints: false,
    },
    ...overrides,
  });
}

function correctedRecord(
  snapshot: RecordEconomicSnapshot,
  occurrenceBefore: number,
  recordPointsAtomic: string,
  evidenceOverrides: Partial<PendingCacheRateLimitEvidence> = {},
): PendingCacheResolutionRecord {
  return {
    peId: 'pe_pending_1',
    userId: 'user_pending_1',
    timestamp: RECORDED_AT,
    economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
    economic_snapshot: snapshot,
    record_points_atomic: recordPointsAtomic,
    pending_cache_reclassified_at: RECLASSIFIED_AT,
    pending_cache_outcome: 'eligible_novelty_corrected',
    pending_cache_rate_limit_evidence: evidence(3, 10, {
      occurrence_count_before: occurrenceBefore,
      occurrence_count_after: occurrenceBefore + 1,
      occurrence_day: RECORDED_DAY,
      ...evidenceOverrides,
    }),
  };
}

function correctedProjection(
  snapshot: RecordEconomicSnapshot,
  occurrenceBefore: number,
  appliedNoveltyBps: number,
  correctedRecordPointsAtomic: string,
) {
  return buildPendingCacheEligibilityProjection(
    'pe_pending_1',
    'user_pending_1',
    hashRecordEconomicSnapshot(snapshot),
    RECLASSIFIED_AT,
    3,
    10,
    {
      occurrenceDay: RECORDED_DAY,
      occurrenceCountBefore: occurrenceBefore,
      appliedNoveltyBps,
      correctedRecordPointsAtomic,
    },
  );
}

describe('deriveNoveltyCorrectedRecovery — the sealed-vintage repricing ', () => {
  // Expected values are HAND-DERIVED literals (sealed price 10 PVT × the
  // code-pinned curve), independent of the shared derivation, so a defect in
  // it cannot certify itself.
  it.each([
    [1, 10_000, '10000000000000000000'],
    [2, 7_000, '7000000000000000000'],
    [3, 4_000, '4000000000000000000'],
    [4, 3_000, '3000000000000000000'],
    [1_000_000, 3_000, '3000000000000000000'],
  ])('ordinary curve: recovered ordinal %i prices at %i bps', (ordinal, bps, atomic) => {
    const derivation = deriveNoveltyCorrectedRecovery(sealedSnapshot(), ordinal);
    expect(derivation.appliedNoveltyBps).toBe(bps);
    expect(derivation.correctedPointsAtomic).toBe(atomic);
  });

  it.each([
    [10, 10_000, '10000000000000000000'],
    [15, 8_000, '8000000000000000000'],
    [50, 6_000, '6000000000000000000'],
    [51, 3_000, '3000000000000000000'],
  ])('unique-artifact curve: recovered ordinal %i prices at %i bps', (ordinal, bps, atomic) => {
    const derivation = deriveNoveltyCorrectedRecovery(
      sealedSnapshot({ uniqueArtifact: true }),
      ordinal,
    );
    expect(derivation.appliedNoveltyBps).toBe(bps);
    expect(derivation.correctedPointsAtomic).toBe(atomic);
  });

  it('never raises above the sealed price: a richer curve value clamps to the sealed novelty', () => {
    // Sealed at ordinal 2 (7,000 bps → 7 PVT). A recovered ordinal of 1 would
    // read 10,000 bps off the curve; min() keeps the sealed price.
    const snapshot = sealedSnapshot({ occurrenceOrdinal: 2 });
    expect(snapshot.recordPointsAtomic).toBe('7000000000000000000');
    const derivation = deriveNoveltyCorrectedRecovery(snapshot, 1);
    expect(derivation.appliedNoveltyBps).toBe(7_000);
    expect(derivation.correctedPointsAtomic).toBe('7000000000000000000');
  });

  it('refuses fixed grants and non-positive ordinals', () => {
    expect(() => deriveNoveltyCorrectedRecovery(sealedSnapshot(), 0))
      .toThrow('pending_cache_recovered_ordinal_invalid');
    const genesisish = {
      ...sealedSnapshot(),
      recordTimeFactors: {
        ...sealedSnapshot().recordTimeFactors,
        fixedGrantSource: 'genesis_campaign_reservation',
      },
    } as unknown as RecordEconomicSnapshot;
    expect(() => deriveNoveltyCorrectedRecovery(genesisish, 2))
      .toThrow('pending_cache_novelty_correction_not_applicable_to_fixed_grants');
  });

  it('refuses a snapshot whose numerator is not divisible by its own sealed novelty factor', () => {
    const snapshot = sealedSnapshot();
    const inconsistent = {
      ...snapshot,
      recordCalculation: { ...snapshot.recordCalculation, numerator: '7' },
    } as unknown as RecordEconomicSnapshot;
    expect(() => deriveNoveltyCorrectedRecovery(inconsistent, 2))
      .toThrow('pending_cache_sealed_calculation_inconsistent');
  });
});

describe('assertPendingCacheEligibilityProjection — recovered counters (no volume bounds)', () => {
  it('accepts a legacy pre- slot at low counts (the old acceptance window still validates)', () => {
    expect(() => assertPendingCacheEligibilityProjection(
      record(3, 49),
      projection(3, 49),
      SETTLEMENT_AT,
    )).not.toThrow();
  });

  it('accepts legacy recovered slots at every FORMER ceiling — 50/day ordinal, 200/hour, 2000/day', () => {
    // Each of these three was a refusal before daily_count_before=50
    // (ordinal 51, the qualification bound), hourly_count_before=200
    // (the hourly cap), daily_count_before=2000 (the daily cap). All three
    // now validate — a Redis outage recovers every otherwise-complete
    // snapshot regardless of volume.
    for (const [hourlyBefore, dailyBefore] of [[3, 50], [200, 1], [3, 2000], [10_000, 1_000_000]]) {
      expect(() => assertPendingCacheEligibilityProjection(
        record(hourlyBefore, dailyBefore),
        projection(hourlyBefore, dailyBefore),
        SETTLEMENT_AT,
      )).not.toThrow();
    }
  });

  it('NEGATIVE CONTROL — an unconsumed slot is refused (the validator can still fail)', () => {
    expect(() => assertPendingCacheEligibilityProjection(
      record(3, 10, { slot_consumed: false }),
      projection(3, 10),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_rate_limit_evidence_invalid');
  });

  it('NEGATIVE CONTROL — counters that did not advance by exactly one are refused', () => {
    expect(() => assertPendingCacheEligibilityProjection(
      record(3, 10, { daily_count_after: 13 }),
      projection(3, 10),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_rate_limit_evidence_invalid');
  });

  it('NEGATIVE CONTROL — a claim bound to a different PE is refused', () => {
    expect(() => assertPendingCacheEligibilityProjection(
      record(3, 10, { redis_claim_id: 'pe_someone_else' }),
      projection(3, 10),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_rate_limit_evidence_invalid');
  });

  it('a tampered projection (rebuilt at different counts) is refused', () => {
    const dailyBefore = 10;
    expect(() => assertPendingCacheEligibilityProjection(
      record(3, dailyBefore),
      projection(3, dailyBefore + 1),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_eligibility_projection_mismatch');
  });

  it('an unknown recovery outcome is refused outright', () => {
    expect(() => assertPendingCacheEligibilityProjection(
      { ...record(3, 10), pending_cache_outcome: 'eligible_because_i_said_so' },
      projection(3, 10),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_rate_limit_evidence_invalid');
  });

  it('NEGATIVE CONTROL — a legacy-outcome row whose points differ from its sealed snapshot is a forgery', () => {
    const snapshot = sealedSnapshot();
    const forged: PendingCacheResolutionRecord = {
      ...record(3, 10),
      economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
      economic_snapshot: snapshot,
      record_points_atomic: '7000000000000000000',
    };
    expect(() => assertPendingCacheEligibilityProjection(
      forged,
      buildPendingCacheEligibilityProjection(
        'pe_pending_1',
        'user_pending_1',
        hashRecordEconomicSnapshot(snapshot),
        RECLASSIFIED_AT,
        3,
        10,
      ),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_rate_limit_evidence_invalid');
  });
});

describe('assertPendingCacheEligibilityProjection — novelty-corrected recoveries ', () => {
  it('accepts an identity correction (recovered ordinal 1) and lets the legacy boundary settle it', () => {
    const snapshot = sealedSnapshot();
    expect(() => assertPendingCacheEligibilityProjection(
      correctedRecord(snapshot, 0, '10000000000000000000'),
      correctedProjection(snapshot, 0, 10_000, '10000000000000000000'),
      SETTLEMENT_AT,
    )).not.toThrow();
  });

  it('REFUSES a value-reducing correction at this (legacy) boundary — PVT9 settles those', () => {
    const snapshot = sealedSnapshot();
    expect(() => assertPendingCacheEligibilityProjection(
      correctedRecord(snapshot, 1, '7000000000000000000'),
      correctedProjection(snapshot, 1, 7_000, '7000000000000000000'),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_novelty_corrected_requires_pvt9_settlement');
  });

  it('NEGATIVE CONTROL — corrected points that do not match the sealed-vintage derivation are refused', () => {
    const snapshot = sealedSnapshot();
    // Ordinal 2 derives 7 PVT; a row claiming the full 10 is a repricing forgery.
    expect(() => assertPendingCacheEligibilityProjection(
      correctedRecord(snapshot, 1, '10000000000000000000'),
      correctedProjection(snapshot, 1, 7_000, '7000000000000000000'),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_novelty_correction_points_mismatch');
  });

  it('NEGATIVE CONTROL — an occurrence slot that did not advance by exactly one is refused', () => {
    const snapshot = sealedSnapshot();
    expect(() => assertPendingCacheEligibilityProjection(
      correctedRecord(snapshot, 0, '10000000000000000000', { occurrence_count_after: 3 }),
      correctedProjection(snapshot, 0, 10_000, '10000000000000000000'),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_rate_limit_evidence_invalid');
  });

  it('NEGATIVE CONTROL — an occurrence day that is not the PE record day is refused', () => {
    const snapshot = sealedSnapshot();
    expect(() => assertPendingCacheEligibilityProjection(
      correctedRecord(snapshot, 0, '10000000000000000000', { occurrence_day: '2025-07-21' }),
      correctedProjection(snapshot, 0, 10_000, '10000000000000000000'),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_rate_limit_evidence_invalid');
  });

  it('NEGATIVE CONTROL — a corrected row without its sealed snapshot cannot rebind', () => {
    const snapshot = sealedSnapshot();
    const withoutSnapshot = {
      ...correctedRecord(snapshot, 0, '10000000000000000000'),
      economic_snapshot: undefined,
    };
    expect(() => assertPendingCacheEligibilityProjection(
      withoutSnapshot,
      correctedProjection(snapshot, 0, 10_000, '10000000000000000000'),
      SETTLEMENT_AT,
    )).toThrow('pending_cache_resolution_record_binding_invalid');
  });

  it('a corrected projection rebuilt at a different ordinal is refused', () => {
    const snapshot = sealedSnapshot();
    expect(() => assertPendingCacheEligibilityProjection(
      correctedRecord(snapshot, 0, '10000000000000000000'),
      correctedProjection(snapshot, 1, 7_000, '7000000000000000000'),
      SETTLEMENT_AT,
    )).toThrow();
  });
});

import crypto from 'crypto';
import {
  hashRecordEconomicSnapshot,
  noveltyBps,
  type EligibilityProjection,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';

const SHA256_COMMITMENT = /^sha256:[a-f0-9]{64}$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface PendingCacheRateLimitEvidence {
  readonly hourly_count_before: number;
  readonly daily_count_before: number;
  readonly hourly_count_after: number;
  readonly daily_count_after: number;
  readonly slot_consumed: boolean;
  readonly redis_claim_id: string;
  readonly idempotent_replay: boolean;
  /**
   * novelty-corrected recoveries only: the recovered occurrence-ordinal
   * consume for the PE's ORIGINAL record day. Absent on rows reclassified
   * before ('eligible_exact_snapshot'), which recovered at their sealed
   * ordinal-1 pricing under the then-current rule and are never repriced.
   */
  readonly occurrence_count_before?: number;
  readonly occurrence_count_after?: number;
  readonly occurrence_day?: string;
}

/**
 * The audit record of a novelty-corrected recovery, written beside the
 * (untouched) sealed snapshot. The sealed snapshot remains byte-exact evidence
 * of what record time computed with the cache unreadable (ordinal 1, full
 * novelty, disposition pending_cache); this block is the evidence of what the
 * recovery actually paid and why.
 */
export interface PendingCacheNoveltyCorrection {
  readonly occurrence_day: string;
  readonly sealed_occurrence_ordinal: number;
  readonly recovered_occurrence_ordinal: number;
  readonly sealed_novelty_bps: number;
  readonly applied_novelty_bps: number;
  readonly sealed_record_points_atomic: string;
  readonly corrected_record_points_atomic: string;
}

export interface PendingCacheResolutionRecord {
  readonly peId: string;
  readonly userId: string;
  readonly timestamp: number;
  readonly economic_snapshot_hash: string | null;
  readonly economic_snapshot?: RecordEconomicSnapshot | null;
  readonly record_points_atomic?: string;
  readonly pending_cache_reclassified_at?: number;
  readonly pending_cache_outcome?: string;
  readonly pending_cache_rate_limit_evidence?: PendingCacheRateLimitEvidence;
  readonly pending_cache_novelty_correction?: PendingCacheNoveltyCorrection;
}

function exactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}_must_be_an_object`);
  }
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length
    || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label}_schema_mismatch`);
  }
}

function safeNonNegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label}_must_be_a_non_negative_safe_integer`);
  }
}

export function utcDayKeyOfMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * price a pending-cache recovery at the novelty its event legitimately
 * earned, under the SEALED policy vintage, without touching the sealed
 * snapshot.
 *
 * Why this is exact: the sealed `recordCalculation.numerator` is the literal
 * product base × weight × novelty × daily × linkage × attestation, so dividing
 * out the sealed novelty factor and multiplying in the curve value at the
 * recovered ordinal reproduces — byte-for-byte, including the single floor
 * division — what `computeRecordSnapshot` would have sealed had the ordinal
 * been observable at record time. Every other factor stays at its sealed
 * vintage value; the novelty curve itself is code-pinned, so no
 * current-policy value leaks into an old row.
 *
 * Why min(): recovery may only ever REDUCE value ("the hold makes current
 * value zero until evidence projects it back") — if the curve at the recovered
 * ordinal were somehow richer than what record time sealed, the sealed price
 * stands. This is the one shared derivation for the backfill writer and the
 * mint-boundary validator; the tests pin its outputs against hand-computed
 * atomic values so a defect here cannot certify itself.
 */
export function deriveNoveltyCorrectedRecovery(
  snapshot: RecordEconomicSnapshot,
  recoveredOccurrenceOrdinal: number,
): {
  readonly appliedNoveltyBps: number;
  readonly sealedNoveltyBps: number;
  readonly correctedPointsAtomic: string;
} {
  if (!Number.isSafeInteger(recoveredOccurrenceOrdinal) || recoveredOccurrenceOrdinal < 1) {
    throw new Error('pending_cache_recovered_ordinal_invalid');
  }
  const factors = snapshot.recordTimeFactors;
  if (factors.fixedGrantSource !== 'none') {
    throw new Error('pending_cache_novelty_correction_not_applicable_to_fixed_grants');
  }
  const sealedNoveltyBps = factors.noveltyBps;
  if (!Number.isSafeInteger(sealedNoveltyBps) || sealedNoveltyBps <= 0) {
    throw new Error('pending_cache_sealed_novelty_invalid');
  }
  const sealedNumerator = BigInt(snapshot.recordCalculation.numerator);
  const denominator = BigInt(snapshot.recordCalculation.denominator);
  if (denominator <= 0n || sealedNumerator % BigInt(sealedNoveltyBps) !== 0n) {
    throw new Error('pending_cache_sealed_calculation_inconsistent');
  }
  const curveBps = noveltyBps({
    occurrenceOrdinal: recoveredOccurrenceOrdinal,
    exactDuplicate: factors.exactDuplicate,
    uniqueArtifact: factors.uniqueArtifact,
  });
  const appliedNoveltyBps = Math.min(curveBps, sealedNoveltyBps);
  const correctedNumerator =
    (sealedNumerator / BigInt(sealedNoveltyBps)) * BigInt(appliedNoveltyBps);
  return {
    appliedNoveltyBps,
    sealedNoveltyBps,
    correctedPointsAtomic: (correctedNumerator / denominator).toString(10),
  };
}

interface ProjectionCorrectionFacts {
  readonly occurrenceDay: string;
  readonly occurrenceCountBefore: number;
  readonly appliedNoveltyBps: number;
  readonly correctedRecordPointsAtomic: string;
}

function cacheFacts(
  peId: string,
  economicActorId: string,
  economicSnapshotHash: string,
  observedAt: number,
  hourlyCount: number,
  dailyCount: number,
  correction?: ProjectionCorrectionFacts,
): string {
  return JSON.stringify({
    pe_id: peId,
    economic_actor_id: economicActorId,
    economic_snapshot_hash: economicSnapshotHash,
    observed_at_ms: observedAt,
    cache_health: 'available',
    hourly_count: hourlyCount,
    daily_count: dailyCount,
    ...(correction === undefined ? {} : {
      occurrence_day: correction.occurrenceDay,
      occurrence_count: correction.occurrenceCountBefore,
      applied_novelty_bps: correction.appliedNoveltyBps,
      corrected_record_points_atomic: correction.correctedRecordPointsAtomic,
    }),
  });
}

export function buildPendingCacheEligibilityProjection(
  peId: string,
  economicActorId: string,
  economicSnapshotHash: string,
  observedAt: number,
  hourlyCount: number,
  dailyCount: number,
  correction?: ProjectionCorrectionFacts,
): EligibilityProjection {
  if (!peId || !economicActorId || !SHA256_COMMITMENT.test(economicSnapshotHash)) {
    throw new Error('pending_cache_resolution_identity_invalid');
  }
  safeNonNegative(observedAt, 'pending_cache_observed_at');
  safeNonNegative(hourlyCount, 'pending_cache_hourly_count');
  safeNonNegative(dailyCount, 'pending_cache_daily_count');
  if (correction !== undefined) {
    if (!DAY_KEY.test(correction.occurrenceDay)) {
      throw new Error('pending_cache_occurrence_day_invalid');
    }
    safeNonNegative(correction.occurrenceCountBefore, 'pending_cache_occurrence_count');
    safeNonNegative(correction.appliedNoveltyBps, 'pending_cache_applied_novelty_bps');
    if (!/^(0|[1-9][0-9]*)$/.test(correction.correctedRecordPointsAtomic)) {
      throw new Error('pending_cache_corrected_points_invalid');
    }
  }
  const facts = cacheFacts(
    peId,
    economicActorId,
    economicSnapshotHash,
    observedAt,
    hourlyCount,
    dailyCount,
    correction,
  );
  return {
    mintDisposition: 'eligible',
    mintReasonCode: 'policy_eligible',
    resolutionEvidence: [{
      resolutionType: 'cache',
      evidenceId: `cache-recovery:${peId}:${observedAt}`,
      evidenceHash: `sha256:${crypto.createHash('sha256').update(facts).digest('hex')}`,
      source: 'pending-cache-backfill',
      asOf: `observed_at_ms:${observedAt}`,
      canonicalEventId: null,
    }],
  };
}

const LEGACY_EVIDENCE_KEYS = [
  'hourly_count_before',
  'daily_count_before',
  'hourly_count_after',
  'daily_count_after',
  'slot_consumed',
  'redis_claim_id',
  'idempotent_replay',
] as const;

const CORRECTED_EVIDENCE_KEYS = [
  ...LEGACY_EVIDENCE_KEYS,
  'occurrence_count_before',
  'occurrence_count_after',
  'occurrence_day',
] as const;

/**
 * Rebind a persisted cache projection to the exact snapshot and Redis slot
 * evidence that produced it. This validation runs at the mint boundary, after
 * generic monetary state-machine validation, so a copied or partially edited
 * projection cannot manufacture eligibility.
 *
 * Two recovery vintages validate, keyed by `pending_cache_outcome` *
 * - `eligible_exact_snapshot` rows reclassified BEFORE, under the
 * rule then in force (recover at the sealed snapshot's points). They are
 * sealed history and continue to validate unchanged; when the row carries
 * its points, those points must BE the sealed snapshot's.
 * - `eligible_novelty_corrected` recoveries. The occurrence slot
 * must have advanced exactly once for the PE's original record day, the
 * row's points must equal the shared derivation at the recovered ordinal,
 * and the projection must rebind over the correction facts. A correction
 * that actually reduced value additionally REFUSES this (legacy) mint
 * boundary outright: `computeSettlement` prices from the sealed snapshot,
 * which for such a row overstates — only the PVT9 lane, which settles the
 * row's own `record_points_atomic`, can express the corrected value.
 */
export function assertPendingCacheEligibilityProjection(
  record: PendingCacheResolutionRecord,
  projection: EligibilityProjection,
  settlementAtMs: number,
): void {
  const outcome = record.pending_cache_outcome;
  const corrected = outcome === 'eligible_novelty_corrected';
  if (!corrected && outcome !== 'eligible_exact_snapshot') {
    throw new Error('pending_cache_rate_limit_evidence_invalid');
  }
  exactKeys(
    record.pending_cache_rate_limit_evidence,
    corrected ? CORRECTED_EVIDENCE_KEYS : LEGACY_EVIDENCE_KEYS,
    'pending_cache_rate_limit_evidence',
  );
  const rateEvidence = record.pending_cache_rate_limit_evidence!;
  safeNonNegative(record.timestamp, 'pending_cache_recorded_at');
  safeNonNegative(settlementAtMs, 'pending_cache_settlement_at');
  safeNonNegative(record.pending_cache_reclassified_at, 'pending_cache_reclassified_at');
  safeNonNegative(rateEvidence.hourly_count_before, 'pending_cache_hourly_count_before');
  safeNonNegative(rateEvidence.daily_count_before, 'pending_cache_daily_count_before');
  safeNonNegative(rateEvidence.hourly_count_after, 'pending_cache_hourly_count_after');
  safeNonNegative(rateEvidence.daily_count_after, 'pending_cache_daily_count_after');

  const observedAt = record.pending_cache_reclassified_at!;
  if (observedAt < record.timestamp || observedAt > settlementAtMs) {
    throw new Error('pending_cache_resolution_time_invalid');
  }
  // the per-user volume ceilings (200/hour, 2000/day, 50/day
  // qualification ordinal) are removed, so a recovered slot's COUNTS are no
  // longer bounded — only the structural exactly-once evidence is checked:
  // the slot was consumed, the claim is bound to this exact PE, and the
  // counters advanced by exactly one. Historical rows reclassified under the
  // old rule satisfied these same structural checks and continue to validate.
  if (rateEvidence.slot_consumed !== true
    || typeof rateEvidence.idempotent_replay !== 'boolean'
    || rateEvidence.redis_claim_id !== record.peId
    || rateEvidence.hourly_count_after !== rateEvidence.hourly_count_before + 1
    || rateEvidence.daily_count_after !== rateEvidence.daily_count_before + 1) {
    throw new Error('pending_cache_rate_limit_evidence_invalid');
  }
  if (!record.peId || !record.userId
    || record.economic_snapshot_hash === null
    || !SHA256_COMMITMENT.test(record.economic_snapshot_hash)) {
    throw new Error('pending_cache_resolution_record_binding_invalid');
  }

  let correctionFacts: ProjectionCorrectionFacts | undefined;
  if (corrected) {
    safeNonNegative(rateEvidence.occurrence_count_before, 'pending_cache_occurrence_count_before');
    safeNonNegative(rateEvidence.occurrence_count_after, 'pending_cache_occurrence_count_after');
    if (rateEvidence.occurrence_count_after !== rateEvidence.occurrence_count_before! + 1
      || typeof rateEvidence.occurrence_day !== 'string'
      || rateEvidence.occurrence_day !== utcDayKeyOfMs(record.timestamp)) {
      throw new Error('pending_cache_rate_limit_evidence_invalid');
    }
    const snapshot = record.economic_snapshot;
    if (snapshot === null || snapshot === undefined
      || hashRecordEconomicSnapshot(snapshot) !== record.economic_snapshot_hash) {
      throw new Error('pending_cache_resolution_record_binding_invalid');
    }
    const recoveredOrdinal = rateEvidence.occurrence_count_before! + 1;
    const derivation = deriveNoveltyCorrectedRecovery(snapshot, recoveredOrdinal);
    if (record.record_points_atomic !== derivation.correctedPointsAtomic) {
      throw new Error('pending_cache_novelty_correction_points_mismatch');
    }
    if (derivation.correctedPointsAtomic !== snapshot.recordPointsAtomic) {
      // A value-reducing correction is settleable ONLY by the PVT9 lane,
      // which consumes the row's own points. This boundary prices from the
      // sealed snapshot and would overpay — refuse, never approximate.
      throw new Error('pending_cache_novelty_corrected_requires_pvt9_settlement');
    }
    correctionFacts = {
      occurrenceDay: rateEvidence.occurrence_day,
      occurrenceCountBefore: rateEvidence.occurrence_count_before!,
      appliedNoveltyBps: derivation.appliedNoveltyBps,
      correctedRecordPointsAtomic: derivation.correctedPointsAtomic,
    };
  } else if (
    record.record_points_atomic !== undefined
    && record.economic_snapshot !== null
    && record.economic_snapshot !== undefined
    && record.record_points_atomic !== record.economic_snapshot.recordPointsAtomic
  ) {
    // The legacy outcome's contract IS the sealed snapshot's points; a row
    // claiming that outcome with different points is a forgery of one or the
    // other.
    throw new Error('pending_cache_rate_limit_evidence_invalid');
  }

  const expected = buildPendingCacheEligibilityProjection(
    record.peId,
    record.userId,
    record.economic_snapshot_hash,
    observedAt,
    rateEvidence.hourly_count_before,
    rateEvidence.daily_count_before,
    correctionFacts,
  );
  if (JSON.stringify(projection) !== JSON.stringify(expected)) {
    throw new Error('pending_cache_eligibility_projection_mismatch');
  }
}

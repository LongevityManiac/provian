import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import type { PEHistoryDocument } from '../../pe-history';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { assertPendingCacheEligibilityProjection } from './pending-cache-resolution';
import { backfillPendingCachePEs } from './pending-cache-backfill';
import {
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';
import { projectedPEAtomic } from './policy/economic-projection';
import {
  activityMintReservationId,
  hashActivityMintReservation,
  type ActivityMintReservationDocument,
} from './activity-mint-limits';

jest.mock('firebase-admin', () => ({
  __esModule: true,
  default: { firestore: () => ({}) },
  firestore: () => ({}),
}));

const OLD_TS = 1_000_000;
/** utcDayKeyOfMs(OLD_TS) — every fixture PE records on this UTC day. */
const OLD_DAY = '1970-01-01';
const UNIT = 10n ** 18n;

/**
 * The recovered row's resolution evidence, checked by the validator in
 * `pending-cache-resolution.ts`. (These tests used to drive it through the
 * retired PVTv8 mint engine's `prepareExactPEForMint`, deleted with the PE meter
 * migration; the validator is the same function that path called.)
 */
function assertRecoveredEvidence(pe: PEHistoryDocument, settlementAtMs: number | undefined): void {
  assertPendingCacheEligibilityProjection(
    pe as unknown as Parameters<typeof assertPendingCacheEligibilityProjection>[0],
    pe.economic_eligibility_projection as Parameters<typeof assertPendingCacheEligibilityProjection>[1],
    settlementAtMs as number,
  );
}

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

function healthyCache(
  hourly = 0,
  daily = 0,
  options: { fail?: boolean; occurrenceStart?: number } = {},
): RedisCache {
  const claims = new Map<string, {
    hourlyCountBefore: number;
    dailyCountBefore: number;
    hourlyCountAfter: number;
    dailyCountAfter: number;
    occurrenceCountBefore: number;
    occurrenceCountAfter: number;
    idempotent: boolean;
  }>();
  const occ = new Map<string, number>();
  return {
    isEnabled: () => true,
    getUserDailyPECountStrict: async () => daily,
    getUserActionTypeCountStrict: async (u: string, a: string, t: number) => occ.get(`${u}:${a}:${new Date(t).toISOString().slice(0,10)}`) ?? options.occurrenceStart ?? 0,
    // no limits — the consume always advances the counters exactly
    // once and keeps its per-PE idempotency claim. it also advances the
    // (user, actionType, ORIGINAL-day) occurrence ordinal exactly once.
    consumeRecoveredPECounterSlot: async (
      userId: string,
      peId: string,
      actionType: string,
      occurrenceDay: string,
    ) => {
      if (options.fail) throw new Error('redis unavailable');
      const prior = claims.get(peId);
      if (prior) return { ...prior, idempotent: true };
      const occKey = `${userId}:${actionType}:${occurrenceDay}`;
      const occBefore = occ.get(occKey) ?? options.occurrenceStart ?? 0;
      const slot = {
        hourlyCountBefore: hourly,
        dailyCountBefore: daily,
        hourlyCountAfter: hourly + 1,
        dailyCountAfter: daily + 1,
        occurrenceCountBefore: occBefore,
        occurrenceCountAfter: occBefore + 1,
        idempotent: false,
      };
      hourly += 1;
      daily += 1;
      occ.set(occKey, occBefore + 1);
      claims.set(peId, slot);
      return slot;
    },
  } as unknown as RedisCache;
}

function pendingSnapshot(
  peId: string,
  actionType: 'wallet_created' | 'send' = 'wallet_created',
): RecordEconomicSnapshot {
  const needsEvidence = actionType === 'send';
  return computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
    peId,
    economicActorId: 'user-1',
    actionType,
    recordedAtMs: OLD_TS,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: needsEvidence ? 'pending' : 'not_required',
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
  });
}

function seedExact(fake: FakeFirestore, peId: string, actionType: 'wallet_created' | 'send' = 'wallet_created') {
  const economicSnapshot = pendingSnapshot(peId, actionType);
  const activityReservation: ActivityMintReservationDocument | null = actionType === 'send'
    ? {
      schema_version: 'activity-mint-reservation/v2',
      reservation_id: activityMintReservationId(peId),
      pe_id: peId,
      user_id: 'user-1',
      action_type: 'send',
      timestamp_ms: OLD_TS,
      day_key: '19700101',
      counterparty: '0x1111111111111111111111111111111111111111',
      input_sha256: 'a'.repeat(64),
      decision: 'reserved',
      reason: null,
      // A pre- send reservation: its retired pair slot stays valid evidence.
      counterparty_slot_consumed: true,
      daily_slot_consumed: true,
      created_at_ms: OLD_TS,
    }
    : null;
  fake.store.set(`pe_history/${peId}`, {
    peId,
    userId: 'user-1',
    actionType,
    timestamp: OLD_TS,
    attestationDepth: 'software',
    category: actionType === 'send' ? 'wallet' : 'other',
    mint_status: 'pending_cache',
    mint_disposition: 'pending_cache',
    estimatedPVT: 0,
    estimated_pvt_atomic: '0',
    record_points_atomic: economicSnapshot.recordPointsAtomic,
    economic_snapshot: economicSnapshot,
    economic_snapshot_hash: hashRecordEconomicSnapshot(economicSnapshot),
    economic_eligibility_projection: null,
    activity_mint_reservation: activityReservation,
    activity_mint_reservation_hash: activityReservation
      ? hashActivityMintReservation(activityReservation)
      : null,
    beneficiary_wallet_id: null,
    corroboration_status: 'none',
  });
  return economicSnapshot;
}

describe('pending-cache backfill uses the sealed atomic accounting snapshot', () => {
  test('recovers a first-of-day event at exact sealed points with immutable cache evidence and reconciles the dashboard', async () => {
    const fake = createFakeFirestore();
    const snapshot = seedExact(fake, 'pe_exact');

    const result = await backfillPendingCachePEs(healthyCache(), db(fake));

    expect(result.reclassified_eligible).toBe(1);
    const pe = fake.store.get('pe_history/pe_exact') as unknown as PEHistoryDocument;
    expect(pe).toMatchObject({
      mint_status: 'eligible',
      mint_disposition: 'eligible',
      // Recovered ordinal 1 == the sealed ordinal, so the correction is the
      // identity and the sealed price stands, to the atomic unit.
      estimated_pvt_atomic: '10000000000000000000',
      record_points_atomic: '10000000000000000000',
      pending_cache_outcome: 'eligible_novelty_corrected',
      pending_cache_novelty_correction: {
        occurrence_day: OLD_DAY,
        sealed_occurrence_ordinal: 1,
        recovered_occurrence_ordinal: 1,
        sealed_novelty_bps: 10_000,
        applied_novelty_bps: 10_000,
        sealed_record_points_atomic: '10000000000000000000',
        corrected_record_points_atomic: '10000000000000000000',
      },
      pending_cache_rate_limit_evidence: {
        occurrence_count_before: 0,
        occurrence_count_after: 1,
        occurrence_day: OLD_DAY,
        slot_consumed: true,
      },
    });
    expect(pe.economic_snapshot).toEqual(snapshot);
    expect(pe.economic_eligibility_projection).toMatchObject({
      mintDisposition: 'eligible',
      resolutionEvidence: [{ resolutionType: 'cache', source: 'pending-cache-backfill' }],
    });
    expect(projectedPEAtomic(pe, 'contributor')).toBe(10n * UNIT);
    expect(() => assertRecoveredEvidence(pe, pe.pending_cache_reclassified_at)).not.toThrow();
  });

  test('a cohort recovers at DISTINCT decayed ordinals — never all at full novelty', async () => {
    // THE Finding B economic-hole closure. Pre- every one of these rows
    // recovered at its sealed ordinal-1 price (10 PVT each, 30 total): an
    // outage window recovered unboundedly at full-novelty pricing. Now the
    // cohort consumes ordinals 1/2/3 of its record day and prices exactly
    // 10 + 7 + 4 on the code-pinned curve. A regression to the old behavior
    // makes every row below read 10 PVT — this test IS the standing volume
    // control and cannot pass vacuously (three rows, three distinct prices).
    const fake = createFakeFirestore();
    const sealed = ['pe_cohort_a', 'pe_cohort_b', 'pe_cohort_c']
      .map((peId) => seedExact(fake, peId));

    const result = await backfillPendingCachePEs(healthyCache(), db(fake));

    expect(result.reclassified_eligible).toBe(3);
    // Fake-firestore processes in (timestamp, doc id) order — a/b/c.
    const rows = ['pe_cohort_a', 'pe_cohort_b', 'pe_cohort_c']
      .map((peId) => fake.store.get(`pe_history/${peId}`) as unknown as PEHistoryDocument);
    expect(rows.map((row) => row.record_points_atomic)).toEqual([
      '10000000000000000000',
      '7000000000000000000',
      '4000000000000000000',
    ]);
    expect(rows.map((row) => row.pending_cache_novelty_correction!.recovered_occurrence_ordinal))
      .toEqual([1, 2, 3]);
    expect(rows.map((row) => row.pending_cache_novelty_correction!.applied_novelty_bps))
      .toEqual([10_000, 7_000, 4_000]);
    // The sealed snapshots are byte-untouched: the correction is settlement
    // value, never a rewrite of record-time evidence.
    rows.forEach((row, index) => {
      expect(row.economic_snapshot).toEqual(sealed[index]);
      expect(row.economic_snapshot!.recordPointsAtomic).toBe('10000000000000000000');
    });
    // Dashboards read the corrected value for the decayed rows.
    expect(projectedPEAtomic(rows[1], 'contributor')).toBe(7n * UNIT);
    expect(projectedPEAtomic(rows[2], 'contributor')).toBe(4n * UNIT);
  });

  test('a deep-ordinal recovery floors at 3000 bps — scale-invariant, never zero, never full', async () => {
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_deep');

    const result = await backfillPendingCachePEs(
      healthyCache(0, 0, { occurrenceStart: 999_999 }),
      db(fake),
    );

    expect(result.reclassified_eligible).toBe(1);
    expect(fake.store.get('pe_history/pe_deep')).toMatchObject({
      record_points_atomic: '3000000000000000000',
      pending_cache_novelty_correction: {
        recovered_occurrence_ordinal: 1_000_000,
        applied_novelty_bps: 3_000,
      },
    });
  });

  test('the legacy sealed-snapshot boundary REFUSES a value-reducing correction (PVT9-lane-only)', async () => {
    // A sealed-snapshot pricer would overstate a reduced row. The validator
    // refuses rather than approximates — the standing negative control proving
    // the corrected contract can fail.
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_reduced');
    await backfillPendingCachePEs(healthyCache(0, 0, { occurrenceStart: 1 }), db(fake));

    const pe = fake.store.get('pe_history/pe_reduced') as unknown as PEHistoryDocument;
    expect(pe.record_points_atomic).toBe('7000000000000000000');
    expect(() => assertRecoveredEvidence(pe, pe.pending_cache_reclassified_at))
      .toThrow('pending_cache_novelty_corrected_requires_pvt9_settlement');
    // The dashboard projection honors the corrected value all the same.
    expect(projectedPEAtomic(pe, 'contributor')).toBe(7n * UNIT);
  });

  test('recovery commits its ordinal with the promotion; a failed transaction consumes no ordinal', async () => {
    const fake = createFakeFirestore({ failTxnWriteOccurrence: { collection: 'pe_history', occurrence: 1 } });
    seedExact(fake, 'pe_retry');
    const cache = healthyCache(0, 0, { occurrenceStart: 4 });
    const failed = await backfillPendingCachePEs(cache, db(fake));
    expect(failed.errors).toBe(1);
    expect(fake.store.get('pe_history/pe_retry')!.mint_status).toBe('pending_cache');
    const { NOVELTY_COUNTERS_COLLECTION } = await import('../meter/batch-pricing-counters');
    expect([...fake.store.entries()].filter(([k]) => k.startsWith(NOVELTY_COUNTERS_COLLECTION + '/')).map(([,v]) => v.count).sort()).toEqual([0,4]);
    const retried = await backfillPendingCachePEs(cache, db(fake));
    expect(retried.reclassified_eligible).toBe(1);
    const first = fake.store.get('pe_history/pe_retry') as unknown as PEHistoryDocument;
    expect(first.record_points_atomic).toBe('3000000000000000000');
    expect(first.pending_cache_novelty_correction!.recovered_occurrence_ordinal).toBe(5);
    expect(first.pending_cache_rate_limit_evidence!.idempotent_replay).toBe(true);
    await backfillPendingCachePEs(cache, db(fake));
    expect(fake.store.get('pe_history/pe_retry')).toEqual(first);
  });

  test('the resolution validator rejects substituted or malformed cache-resolution evidence', async () => {
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_projection_tamper');
    await backfillPendingCachePEs(healthyCache(), db(fake));
    const stored = fake.store.get('pe_history/pe_projection_tamper')!;
    const observedAt = stored.pending_cache_reclassified_at as number;
    const projection = stored.economic_eligibility_projection as {
      resolutionEvidence: Array<Record<string, unknown>>;
    };
    projection.resolutionEvidence[0].evidenceHash = `sha256:${'f'.repeat(64)}`;

    expect(() => assertRecoveredEvidence(stored as unknown as PEHistoryDocument, observedAt))
      .toThrow('pending_cache_eligibility_projection_mismatch');

    seedExact(fake, 'pe_rate_evidence_tamper');
    await backfillPendingCachePEs(healthyCache(), db(fake));
    const rateTampered = fake.store.get('pe_history/pe_rate_evidence_tamper')!;
    rateTampered.pending_cache_rate_limit_evidence = {
      ...(rateTampered.pending_cache_rate_limit_evidence as Record<string, unknown>),
      unknown: true,
    };
    expect(() => assertRecoveredEvidence(
      rateTampered as unknown as PEHistoryDocument,
      rateTampered.pending_cache_reclassified_at as number,
    )).toThrow('pending_cache_rate_limit_evidence_schema_mismatch');
  });

  test('never promotes a legacy raw Genesis marker or touches old ledgers', async () => {
    const fake = createFakeFirestore();
    fake.store.set('pe_history/pe_legacy_genesis', {
      peId: 'pe_legacy_genesis',
      userId: 'agent-1',
      actionType: 'agent_wallet_funded',
      timestamp: OLD_TS,
      attestationDepth: 'software',
      mint_status: 'pending_cache',
      estimatedPVT: 0,
      is_genesis_grant: true,
      genesis_reserved_pvt: 50,
      genesis_wallet_id: 'wallet-1',
    });

    const result = await backfillPendingCachePEs(healthyCache(), db(fake));

    expect(result.reclassified_record_only).toBe(1);
    expect(fake.store.get('pe_history/pe_legacy_genesis')).toMatchObject({
      mint_status: 'record_only',
      mint_disposition: 'record_only',
      estimated_pvt_atomic: '0',
      pending_cache_outcome: 'legacy_genesis_record_only',
    });
    expect([...fake.store.keys()].some((key) => key.startsWith('genesis_campaign_state/')))
      .toBe(false);
    expect([...fake.store.keys()].some((key) => key.startsWith('genesis_wallet_ledger/')))
      .toBe(false);
  });

  test('fails a missing or tampered snapshot closed to record-only', async () => {
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_tampered');
    fake.store.set('pe_history/pe_tampered', {
      ...fake.store.get('pe_history/pe_tampered'),
      economic_snapshot_hash: `sha256:${'f'.repeat(64)}`,
    });

    const result = await backfillPendingCachePEs(healthyCache(), db(fake));

    expect(result.reclassified_record_only).toBe(1);
    expect(fake.store.get('pe_history/pe_tampered')).toMatchObject({
      mint_status: 'record_only',
      estimated_pvt_atomic: '0',
      pending_cache_outcome: 'missing_or_invalid_snapshot_record_only',
    });
  });

  test('retains unresolved chain evidence as pending rather than manufacturing eligibility', async () => {
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_waiting', 'send');

    const result = await backfillPendingCachePEs(healthyCache(), db(fake));

    expect(result.reclassified_pending_evidence).toBe(1);
    expect(fake.store.get('pe_history/pe_waiting')).toMatchObject({
      mint_status: 'pending_evidence',
      mint_disposition: 'pending_evidence',
      estimated_pvt_atomic: '0',
      pending_cache_outcome: 'awaiting_evidence',
    });
  });

  test('a recovered slot at the FORMER hourly cap (200) resolves eligible — no volume refusal', async () => {
    // Pre- healthyCache(200, 0) refused the slot and this row became
    // terminal 'ineligible' with outcome 'rate_limited'. The hourly cap is
    // removed: the same recovered view now resolves eligible with the slot
    // consumed and counters advanced by exactly one.
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_limited');

    const result = await backfillPendingCachePEs(healthyCache(200, 0), db(fake));

    expect(result.reclassified_eligible).toBe(1);
    expect(result.reclassified_ineligible).toBe(0);
    expect(fake.store.get('pe_history/pe_limited')).toMatchObject({
      mint_status: 'eligible',
      pending_cache_outcome: 'eligible_novelty_corrected',
      pending_cache_rate_limit_evidence: {
        hourly_count_before: 200,
        hourly_count_after: 201,
        slot_consumed: true,
      },
    });
  });

  test('a recovered slot beyond the FORMER daily qualification bound (ordinal 51) resolves eligible', async () => {
    // daily_count_before = 50 → this PE's 1-based ordinal is 51. Under
    // this resolved terminal-ineligible ('rate_limited', no slot consumed);
    // the qualification ordinal is removed, so it now recovers exactly like
    // any other otherwise-complete snapshot. (The DAILY counter is provenance;
    // pricing decay rides the per-action OCCURRENCE ordinal —.)
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_daily_bound');

    const result = await backfillPendingCachePEs(healthyCache(0, 50), db(fake));

    expect(result.reclassified_eligible).toBe(1);
    expect(result.reclassified_ineligible).toBe(0);
    expect(fake.store.get('pe_history/pe_daily_bound')).toMatchObject({
      mint_status: 'eligible',
      pending_cache_outcome: 'eligible_novelty_corrected',
      pending_cache_rate_limit_evidence: {
        daily_count_before: 50,
        daily_count_after: 51,
        slot_consumed: true,
      },
    });
  });

  test('atomically advances counters so two rows get distinct exact evidence (both recover)', async () => {
    // Pre- this pinned the last-slot race under the 200/hour cap (one
    // eligible, one terminal). With the caps removed BOTH recover; what the
    // atomic consume still guarantees is exactly-once accounting — each row
    // advances the counters by exactly one from a distinct before-state, so
    // no two rows can share a slot's evidence.
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_slot_a');
    seedExact(fake, 'pe_slot_b');

    const result = await backfillPendingCachePEs(healthyCache(199, 0), db(fake));

    expect(result.reclassified_eligible).toBe(2);
    expect(result.reclassified_ineligible).toBe(0);
    const evidences = ['pe_slot_a', 'pe_slot_b'].map(
      (peId) => fake.store.get(`pe_history/${peId}`)?.pending_cache_rate_limit_evidence as {
        hourly_count_before: number;
        hourly_count_after: number;
        slot_consumed: boolean;
      },
    );
    const befores = evidences.map((e) => e.hourly_count_before).sort((a, b) => a - b);
    expect(befores).toEqual([199, 200]);
    for (const e of evidences) {
      expect(e.slot_consumed).toBe(true);
      expect(e.hourly_count_after).toBe(e.hourly_count_before + 1);
    }
  });

  test('a transient Redis error fails closed and leaves the row pending', async () => {
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_redis_error');

    const result = await backfillPendingCachePEs(
      healthyCache(0, 0, { fail: true }),
      db(fake),
    );

    expect(result.errors).toBe(1);
    expect(result.still_pending).toBe(1);
    expect(fake.store.get('pe_history/pe_redis_error')?.mint_status).toBe('pending_cache');
  });

  test('leaves rows untouched while cache health is still unknown', async () => {
    const fake = createFakeFirestore();
    seedExact(fake, 'pe_still_pending');
    const unavailable = { isEnabled: () => false } as unknown as RedisCache;

    const result = await backfillPendingCachePEs(unavailable, db(fake));

    expect(result.scanned).toBe(0);
    expect(fake.store.get('pe_history/pe_still_pending')?.mint_status).toBe('pending_cache');
  });

  test(' (M1): one run pages past a single batch instead of draining 200 rows per hour', async () => {
    // The hourly cron used to reclassify at most one 200-row batch per run.
    // Seed 205 rows: a single run now drains ALL of them across two pages.
    const fake = createFakeFirestore();
    const snapshot = pendingSnapshot('pe_page_template');
    for (let index = 0; index < 205; index += 1) {
      const peId = `pe_page_${String(index).padStart(3, '0')}`;
      const rowSnapshot = { ...snapshot, peId };
      fake.store.set(`pe_history/${peId}`, {
        peId,
        userId: 'user-1',
        actionType: 'wallet_created',
        timestamp: OLD_TS + index,
        attestationDepth: 'software',
        category: 'other',
        mint_status: 'pending_cache',
        mint_disposition: 'pending_cache',
        estimatedPVT: 0,
        estimated_pvt_atomic: '0',
        record_points_atomic: rowSnapshot.recordPointsAtomic,
        economic_snapshot: { ...rowSnapshot, recordedAtMs: OLD_TS + index },
        economic_snapshot_hash: hashRecordEconomicSnapshot(
          { ...rowSnapshot, recordedAtMs: OLD_TS + index },
        ),
        economic_eligibility_projection: null,
        activity_mint_reservation: null,
        activity_mint_reservation_hash: null,
        beneficiary_wallet_id: null,
        corroboration_status: 'none',
      });
    }

    const result = await backfillPendingCachePEs(healthyCache(), db(fake));

    expect(result.pages).toBe(2);
    expect(result.scanned).toBe(205);
    expect(result.reclassified_eligible + result.reclassified_record_only).toBe(205);
    expect(result.stopped_on_budget).toBe(false);
  });

  test(' (M1): the wall-clock budget stops between pages and leaves the tail pending for the next run', async () => {
    const fake = createFakeFirestore();
    const snapshot = pendingSnapshot('pe_budget_template');
    for (let index = 0; index < 205; index += 1) {
      const peId = `pe_budget_${String(index).padStart(3, '0')}`;
      fake.store.set(`pe_history/${peId}`, {
        peId,
        userId: 'user-1',
        actionType: 'wallet_created',
        timestamp: OLD_TS + index,
        attestationDepth: 'software',
        category: 'other',
        mint_status: 'pending_cache',
        mint_disposition: 'pending_cache',
        estimatedPVT: 0,
        estimated_pvt_atomic: '0',
        record_points_atomic: snapshot.recordPointsAtomic,
        economic_snapshot: { ...snapshot, peId, recordedAtMs: OLD_TS + index },
        economic_snapshot_hash: hashRecordEconomicSnapshot(
          { ...snapshot, peId, recordedAtMs: OLD_TS + index },
        ),
        economic_eligibility_projection: null,
        activity_mint_reservation: null,
        activity_mint_reservation_hash: null,
        beneficiary_wallet_id: null,
        corroboration_status: 'none',
      });
    }

    const result = await backfillPendingCachePEs(healthyCache(), db(fake), { maxRunMs: 0 });

    expect(result.stopped_on_budget).toBe(true);
    expect(result.pages).toBe(1);
    expect(result.scanned).toBe(200);
    const stillPending = [...fake.store.entries()]
      .filter(([key, row]) => key.startsWith('pe_history/pe_budget_') && row.mint_status === 'pending_cache');
    expect(stillPending.length).toBe(5);
  });
});

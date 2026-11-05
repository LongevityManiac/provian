/**
 * Accrual-time economic aggregates — the per-row arithmetic, the transactional
 * writer, and the mutation primitive (M5 close-out).
 *
 * Negative-control doctrine : every guard here is shown FAILING on a
 * deliberately violating input, in-suite and permanently. The three recurring
 * vacuous shapes are addressed by name:
 * empty population — parity/drift assertions print and check the evaluated
 * row count, and a suite fixture always has rows;
 * self-referential — collection names, the marker field, the schema
 * version and the 72h window are IMPORTED from the
 * module under test, never re-typed here; every snapshot
 * is produced by the REAL kernel (`computeRecordSnapshot`);
 * unreachable branch — `compareRoleAggregates` and the writer take their
 * inputs as parameters, so a corrupted aggregate and an
 * unloaded identity are both constructible.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import { getWeekStart, WEEK_MS } from '../week-start';
import {
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
  type RecordEconomicSnapshot,
} from './monetary-accounting';
import { materializeProposedMonetaryPolicy } from './runtime-monetary-policy';
import {
  ECONOMIC_AGGREGATE_COLLECTION,
  ECONOMIC_AGGREGATE_SCHEMA_VERSION,
  EconomicAggregateWriter,
  FROZEN_CONTRIBUTION_WINDOW_MS,
  PE_HISTORY_AGGREGATE_MARKER_FIELD,
  applyRowContribution,
  emptyRoleAggregate,
  isAggregateMarked,
  mutatePeHistoryRowWithAggregate,
  parseAggregateDocument,
  rowContribution,
  rowIdentityKeys,
} from './economic-aggregate';
import { compareRoleAggregates } from './economic-aggregate-maintenance';
import { ATTESTATION_ENHANCEMENT_HORIZON_MS, ATTESTATION_ENHANCEMENT_WINDOW_MS } from './monetary-accounting';
import { recordPointsForRoleAtomic } from './economic-projection';

import { actKeyDocFor } from '../../meter/__test-helpers__/seed-act-keys';
import { aggregateBatchClaims } from '../../meter/meter-claims';
const UNIT = 10n ** 18n;
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
const DAY = WEEK_MS / 7;
const POLICY = materializeProposedMonetaryPolicy(0);

function snapshot(peId: string, actionType: string, recordedAtMs: number, actor = 'user-1'): RecordEconomicSnapshot {
  return computeRecordSnapshot(POLICY, {
    peId,
    economicActorId: actor,
    actionType,
    recordedAtMs,
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

function row(
  peId: string,
  recordedAtMs: number,
  overrides: Partial<PEHistoryDocument> & { marked?: boolean } = {},
): PEHistoryDocument {
  const { marked = true, ...rest } = overrides;
  const s = snapshot(peId, 'wallet_created', recordedAtMs, (rest.userId as string | undefined) ?? 'user-1');
  return {
    peId,
    userId: 'user-1',
    actionType: 'wallet_created',
    timestamp: recordedAtMs,
    category: 'wallet',
    mint_status: 'eligible',
    mint_disposition: 'eligible',
    attestationDepth: 'software',
    corroboration_status: 'none',
    corroboration_received_at: null,
    economic_snapshot: s,
    economic_snapshot_hash: hashRecordEconomicSnapshot(s),
    record_points_atomic: s.recordPointsAtomic,
    beneficiary_wallet_id: null,
    ...(marked ? { [PE_HISTORY_AGGREGATE_MARKER_FIELD]: ECONOMIC_AGGREGATE_SCHEMA_VERSION } : {}),
    ...rest,
  } as unknown as PEHistoryDocument;
}

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

describe('rowContribution — one pricing source', () => {
  it('prices a row exactly as the fold does, and reads its identities from the row', () => {
    const pe = row('pe-1', NOW - 1000, { beneficiary_wallet_id: 'human-1' });
    const c = rowContribution(pe, 'contributor', NOW);
    expect(c.integrityFailure).toBe(false);
    expect(c.recordPointsAtomic).toBe(recordPointsForRoleAtomic(pe, 'contributor'));
    expect(c.recordPointsAtomic).toBe(10n * UNIT);
    expect(c.settlementInput).toEqual({ rated: 10n * UNIT, fixed: 0n });
    expect(c.weekStartMs).toBe(getWeekStart(NOW - 1000));
    expect(rowIdentityKeys(pe)).toEqual([
      { identity: 'user-1', role: 'contributor' },
      { identity: 'human-1', role: 'beneficiary' },
    ]);
  });

  it('a tampered snapshot is an integrity failure and contributes nothing else', () => {
    const pe = row('pe-t', NOW - 1000, { economic_snapshot_hash: `sha256:${'f'.repeat(64)}` });
    const c = rowContribution(pe, 'contributor', NOW);
    expect(c.integrityFailure).toBe(true);
    expect(c.recordPointsAtomic).toBe(0n);
    const agg = applyRowContribution(emptyRoleAggregate(), c, 1, NOW);
    expect(agg).toMatchObject({ total_pes: 0, integrity_failures: 1, record_points_atomic: '0' });
  });

  it('a minted row keeps its record points but projects zero', () => {
    const c = rowContribution(row('pe-m', NOW - 1000, { mint_status: 'minted' }), 'contributor', NOW);
    expect(c.recordPointsAtomic).toBe(10n * UNIT);
    expect(c.settlementInput).toEqual({ rated: 0n, fixed: 0n });
  });

  it('the frozen window IS the settlement kernel window (bound, not copied)', () => {
    // bound to the 30-day HORIZON (the widest window any row is under), so a
    // corroboration lifting a post-cut-line row inside its window is always a TAIL row.
    expect(FROZEN_CONTRIBUTION_WINDOW_MS).toBe(ATTESTATION_ENHANCEMENT_HORIZON_MS);
    expect(FROZEN_CONTRIBUTION_WINDOW_MS).toBeGreaterThan(ATTESTATION_ENHANCEMENT_WINDOW_MS);
  });
});

describe('applyRowContribution — frozen membership follows the watermark', () => {
  it('a row at or below the watermark moves the frozen sums; above it moves only totals', () => {
    const base = { ...emptyRoleAggregate(), frozen_through_ms: NOW - 10 * DAY };
    const frozen = applyRowContribution(base, rowContribution(row('a', NOW - 20 * DAY), 'contributor', NOW), 1, NOW);
    expect(frozen).toMatchObject({
      total_pes: 1,
      frozen_pes: 1,
      frozen_projection_rated_atomic: (10n * UNIT).toString(),
      record_points_atomic: (10n * UNIT).toString(),
    });
    const tail = applyRowContribution(base, rowContribution(row('b', NOW - 1000), 'contributor', NOW), 1, NOW);
    expect(tail).toMatchObject({
      total_pes: 1,
      frozen_pes: 0,
      frozen_projection_rated_atomic: '0',
      record_points_atomic: (10n * UNIT).toString(),
    });
  });

  it('(+1) then (−1) is the identity — the delta form a mutation relies on', () => {
    const base = { ...emptyRoleAggregate(), frozen_through_ms: NOW };
    const c = rowContribution(row('a', NOW - 20 * DAY), 'contributor', NOW);
    const back = applyRowContribution(applyRowContribution(base, c, 1, NOW), c, -1, NOW);
    expect(back).toEqual(base);
  });

  it('prunes week buckets older than the previous week, keeps the current one', () => {
    const agg = applyRowContribution(emptyRoleAggregate(), rowContribution(row('a', NOW - 1000), 'contributor', NOW), 1, NOW);
    expect(agg.pes_by_week_start).toEqual({ [String(getWeekStart(NOW))]: 1 });
    const old = applyRowContribution(agg, rowContribution(row('b', NOW - 30 * DAY), 'contributor', NOW), 1, NOW);
    expect(old.pes_by_week_start).toEqual({ [String(getWeekStart(NOW))]: 1 });
    expect(old.total_pes).toBe(2);
  });
});

describe('EconomicAggregateWriter', () => {
  it('applies a row under every identity it is read under, in one transaction', async () => {
    const fake = createFakeFirestore();
    const pe = row('pe-1', NOW - 1000, { beneficiary_wallet_id: 'human-1' });
    await db(fake).runTransaction(async (txn) => {
      const writer = new EconomicAggregateWriter(db(fake), txn, NOW);
      await writer.load(EconomicAggregateWriter.identitiesOf(pe));
      writer.applyRow(pe, 1);
      expect(writer.commit()).toBe(2);
    });
    const user = parseAggregateDocument('user-1', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`))!;
    const human = parseAggregateDocument('human-1', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/human-1`))!;
    expect(user.roles.contributor.total_pes).toBe(1);
    expect(user.roles.beneficiary.total_pes).toBe(0);
    expect(human.roles.beneficiary.total_pes).toBe(1);
    expect(human.roles.contributor.total_pes).toBe(0);
    expect(user.version).toBe(1);
  });

  it('RED: applying a row for an identity that was not loaded THROWS rather than skipping', async () => {
    const fake = createFakeFirestore();
    const pe = row('pe-1', NOW - 1000, { beneficiary_wallet_id: 'human-1' });
    await expect(db(fake).runTransaction(async (txn) => {
      const writer = new EconomicAggregateWriter(db(fake), txn, NOW);
      await writer.load(['user-1']); // forgot the beneficiary
      writer.applyRow(pe, 1);
    })).rejects.toThrow('economic_aggregate_identity_not_loaded:human-1');
    // Nothing landed: the throw rolled the transaction back.
    expect(fake.store.has(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`)).toBe(false);
  });

  it('applyMutation is a no-op for an unmarked row and (−before,+after) for a marked one', async () => {
    const fake = createFakeFirestore();
    const before = row('pe-1', NOW - 20 * DAY);
    const after = { ...before, mint_status: 'minted' } as PEHistoryDocument;
    await db(fake).runTransaction(async (txn) => {
      const writer = new EconomicAggregateWriter(db(fake), txn, NOW);
      await writer.load(['user-1']);
      // Pretend the row was frozen at seal: watermark above it, +1 applied.
      writer.setRoleAggregate('user-1', 'contributor', { ...emptyRoleAggregate(), frozen_through_ms: NOW });
      writer.applyRow(before, 1);
      expect(writer.roleAggregate('user-1', 'contributor').frozen_projection_rated_atomic).toBe((10n * UNIT).toString());
      expect(writer.applyMutation(before, after)).toBe('applied');
      expect(writer.roleAggregate('user-1', 'contributor')).toMatchObject({
        total_pes: 1,
        frozen_pes: 1,
        frozen_projection_rated_atomic: '0',
        record_points_atomic: (10n * UNIT).toString(),
      });
      const unmarked = row('pe-u', NOW - 1000, { marked: false });
      expect(isAggregateMarked(unmarked)).toBe(false);
      expect(writer.applyMutation(unmarked, { ...unmarked, mint_status: 'minted' } as PEHistoryDocument)).toBe('unmarked');
      writer.commit();
    });
  });
});

describe('mutatePeHistoryRowWithAggregate — atomic row patch + aggregate delta', () => {
  async function seeded(): Promise<FakeFirestore> {
    const fake = createFakeFirestore();
    const pe = row('pe-1', NOW - 20 * DAY);
    fake.store.set(`pe_history/${pe.peId}`, pe as unknown as Record<string, unknown>);
    await db(fake).runTransaction(async (txn) => {
      const writer = new EconomicAggregateWriter(db(fake), txn, NOW);
      await writer.load(['user-1']);
      writer.setRoleAggregate('user-1', 'contributor', { ...emptyRoleAggregate(), frozen_through_ms: NOW, backfill_complete: true });
      writer.applyRow(pe, 1);
      writer.commit();
    });
    return fake;
  }

  it('the novelty-corrected repricing lowers the aggregate by exactly the delta', async () => {
    const fake = await seeded();
    const corrected = (5n * UNIT).toString();
    const result = await mutatePeHistoryRowWithAggregate(db(fake), 'pe-1', {
      record_points_atomic: corrected,
      pending_cache_outcome: 'eligible_novelty_corrected',
    }, { nowMs: NOW, expect: (b) => b.mint_status === 'eligible' });
    expect(result.outcome).toBe('applied');
    const agg = parseAggregateDocument('user-1', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`))!;
    expect(agg.roles.contributor).toMatchObject({
      total_pes: 1,
      record_points_atomic: corrected,
      frozen_projection_rated_atomic: corrected,
    });
    expect(fake.store.get('pe_history/pe-1')).toMatchObject({ record_points_atomic: corrected });
    expect(agg.version).toBe(2);
  });

  it.each(['new', 'legacy', 'registered'] as const)('terminal demotion retires only an unpaid new key: %s', async mode => {
    const fake = await seeded(), pe = fake.store.get('pe_history/pe-1')!;
    fake.store.delete('pe_history/pe-1');
    const batch = 'd'.repeat(64), points = String(pe.record_points_atomic);
    const leg = { leg: 'sole' as const, contributor: '0x' + 'a'.repeat(40), beneficiary_class: 1, bps: 10000, points_atomic: points };
    fake.store.set('meter_act_keys_v1/pe-1', actKeyDocFor(pe, { batch_hash: batch, unit: 'batch', legs: [leg],
      ...(mode === 'legacy' ? { expire_at: 123 } : { pending_retention_v1: true, expire_at: null }) }));
    fake.store.set('meter_batches_v1/' + batch, { per_batch_pricing: true, anchored: true, settlement_complete: false, expire_at: null });
    const claims = aggregateBatchClaims({ batch_hash: batch, device_id: 'dev_test', actor_id: String(pe.userId), created_at_ms: NOW,
      acts: [{ relay_pe_id: 'pe-1', legs: [leg] }] });
    expect(claims).toHaveLength(1);
    for (const claim of claims) fake.store.set('meter_pending_claims_v1/' + claim.claim_key, { ...claim, ...(mode === 'registered' ? { state: 'aggregated' } : {}) });
    const result = await mutatePeHistoryRowWithAggregate(db(fake), 'pe-1', { mint_status: 'record_only' }, { nowMs: NOW });
    const key = fake.store.get('meter_act_keys_v1/pe-1')!, record = fake.store.get('meter_batches_v1/' + batch)!;
    if (mode === 'registered') {
      expect(result.outcome).toBe('precondition_failed'); expect(key.expire_at).toBeNull(); expect(record.settlement_complete).toBe(false);
    } else {
      expect(result.outcome).toBe('applied');
      expect(fake.store.get('meter_pending_claims_v1/' + claims[0].claim_key)!.state).toBe('void');
      if (mode === 'new') { expect(key.expire_at).not.toBeNull(); expect(record.settlement_complete).toBe(true); expect(record.expire_at).not.toBeNull(); }
      else { expect(key.expire_at).toBe(123); expect(record.settlement_complete).toBe(false); }
    }
  });

  it('the settlement writeback (eligible → minted) zeroes the frozen projection, keeps the record points', async () => {
    const fake = await seeded();
    await mutatePeHistoryRowWithAggregate(db(fake), 'pe-1', { mint_status: 'minted' }, {
      nowMs: NOW, expect: (b) => b.mint_status === 'eligible',
    });
    const agg = parseAggregateDocument('user-1', fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`))!;
    expect(agg.roles.contributor).toMatchObject({
      record_points_atomic: (10n * UNIT).toString(),
      frozen_projection_rated_atomic: '0',
      frozen_pes: 1,
    });
  });

  it('RED: a failed precondition writes NOTHING — row and aggregate both untouched', async () => {
    const fake = await seeded();
    const beforeAgg = fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`);
    const result = await mutatePeHistoryRowWithAggregate(db(fake), 'pe-1', { mint_status: 'minted' }, {
      nowMs: NOW, expect: (b) => b.mint_status === 'pending_cache',
    });
    expect(result.outcome).toBe('precondition_failed');
    expect(fake.store.get('pe_history/pe-1')).toMatchObject({ mint_status: 'eligible' });
    expect(fake.store.get(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`)).toEqual(beforeAgg);
  });

  it('a missing row reports missing and writes nothing', async () => {
    const fake = await seeded();
    const result = await mutatePeHistoryRowWithAggregate(db(fake), 'pe-nope', { mint_status: 'minted' }, { nowMs: NOW });
    expect(result.outcome).toBe('missing');
    expect(fake.store.has('pe_history/pe-nope')).toBe(false);
  });

  it('RED: an injected aggregate-write failure rolls the ROW patch back too (both land or neither)', async () => {
    const fake = createFakeFirestore({ failTxnWriteTo: ECONOMIC_AGGREGATE_COLLECTION });
    const pe = row('pe-1', NOW - 20 * DAY);
    fake.store.set(`pe_history/${pe.peId}`, pe as unknown as Record<string, unknown>);
    await expect(mutatePeHistoryRowWithAggregate(db(fake), 'pe-1', { mint_status: 'minted' }, { nowMs: NOW }))
      .rejects.toThrow('Injected transaction write failure');
    expect(fake.store.get('pe_history/pe-1')).toMatchObject({ mint_status: 'eligible' });
  });
});

describe('compareRoleAggregates — drift detection names the corrupted field', () => {
  const reference = applyRowContribution(
    { ...emptyRoleAggregate(), frozen_through_ms: NOW },
    rowContribution(row('a', NOW - 20 * DAY), 'contributor', NOW),
    1,
    NOW,
  );

  it('CONTROL: an identical aggregate reports no mismatch', () => {
    expect(compareRoleAggregates(reference, { ...reference }, NOW)).toEqual([]);
  });

  it('RED: a deliberately corrupted record-points total is named', () => {
    const corrupted = { ...reference, record_points_atomic: (11n * UNIT).toString() };
    expect(compareRoleAggregates(corrupted, reference, NOW)).toEqual(['record_points_atomic']);
  });

  it('RED: a corrupted per-category map and a dropped frozen input are both named', () => {
    const corrupted = {
      ...reference,
      pes_by_category: { wallet: 2 },
      frozen_projection_rated_atomic: '0',
    };
    expect(compareRoleAggregates(corrupted, reference, NOW)).toEqual([
      'frozen_projection_rated_atomic',
      'pes_by_category',
    ]);
  });
});

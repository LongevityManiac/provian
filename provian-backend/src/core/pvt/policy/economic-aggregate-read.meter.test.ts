/**
 * The dashboard read on the PE METER: stored totals from the aggregate + a live tail folded from
 * the identity's act keys — and nothing from `pe_history`.
 *
 * PARITY is the contract: the read equals the PURE reference fold over the same rows, field by
 * field, whether a row sits in the frozen sums (its act key long expired) or in the live tail.
 *
 * RED controls (each permanent and in-suite):
 * - a planted legacy `pe_history` row is NEVER read (the read is unchanged with it present);
 * - an UNMARKED act key (in no total) is never projected, while the same key marked is;
 * - a stored aggregate total that is wrong makes the read ≠ the fold (parity is not vacuous).
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import { seedActKeys, seedMeteredRows } from '../../meter/__test-helpers__/seed-act-keys';
import { METER_ACT_KEYS_COLLECTION } from '../../meter/meter-store';
import { WEEK_MS } from '../week-start';
import {
  computeRecordSnapshot,
  disclosedRationalFactor,
  hashRecordEconomicSnapshot,
} from './monetary-accounting';
import { materializeProposedMonetaryPolicy } from './runtime-monetary-policy';
import {
  ECONOMIC_AGGREGATE_COLLECTION,
  ECONOMIC_AGGREGATE_SCHEMA_VERSION,
  emptyAggregateDocument,
  mutatePeHistoryRowWithAggregate,
} from './economic-aggregate';
import {
  emptyAggregateReadTrace,
  readAggregateMintStatusCounts,
  readEconomicAccrualProjection,
} from './economic-aggregate-read';
import {
  foldEconomicAccrualRows,
  type CurrentSettlementProjectionContext,
  type EconomicAccrualProjection,
} from './economic-projection';

const UNIT = 10n ** 18n;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = WEEK_MS / 7;
const POLICY = materializeProposedMonetaryPolicy(0);

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

interface RowSpec {
  peId: string;
  ageMs: number;
  userId?: string;
  beneficiary?: string | null;
  mintStatus?: PEHistoryDocument['mint_status'];
  category?: string;
}

function row(spec: RowSpec): PEHistoryDocument {
  const userId = spec.userId ?? 'user-1';
  const s = computeRecordSnapshot(POLICY, {
    peId: spec.peId,
    economicActorId: userId,
    actionType: 'wallet_created',
    recordedAtMs: NOW - spec.ageMs,
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
  return {
    peId: spec.peId,
    userId,
    actionType: s.actionType,
    timestamp: s.recordedAtMs,
    category: spec.category ?? 'wallet',
    mint_status: spec.mintStatus ?? (s.mintDisposition === 'eligible' ? 'eligible' : 'record_only'),
    mint_disposition: s.mintDisposition,
    attestationDepth: 'software',
    corroboration_status: 'none',
    corroboration_received_at: null,
    economic_snapshot: s,
    economic_snapshot_hash: hashRecordEconomicSnapshot(s),
    record_points_atomic: s.recordPointsAtomic,
    beneficiary_wallet_id: spec.beneficiary ?? null,
  } as unknown as PEHistoryDocument;
}

function context(num = 1n, den = 3n): CurrentSettlementProjectionContext {
  return { projectedAtMs: NOW, globalMintRate: disclosedRationalFactor(num, den, 'test', 'block:1') };
}

function referenceFold(
  rows: readonly PEHistoryDocument[],
  userId: string,
  settlementProjection: CurrentSettlementProjectionContext | null,
): EconomicAccrualProjection {
  const pairs: Array<{ row: PEHistoryDocument; role: 'contributor' | 'beneficiary' }> = [];
  for (const r of rows) {
    if (r.userId === userId) pairs.push({ row: r, role: 'contributor' });
    if (r.beneficiary_wallet_id === userId) pairs.push({ row: r, role: 'beneficiary' });
  }
  return foldEconomicAccrualRows(pairs, { nowMs: NOW, settlementProjection });
}

const FIELDS: ReadonlyArray<keyof EconomicAccrualProjection> = [
  'totalRecordPointsAtomic', 'recordPointsByCategoryAtomic', 'totalCurrentSettlementProjectionAtomic',
  'currentSettlementProjectionByCategoryAtomic', 'exactGenesisReservedGrossAtomic',
  'exactGenesisReservedGrossByCategoryAtomic', 'totalPEs', 'weeklyPEs', 'pesByCategory',
  'integrityFailures', 'projectionFailures',
];

function pick(p: EconomicAccrualProjection): Record<string, unknown> {
  return Object.fromEntries(FIELDS.map((f) => [f, p[f]]));
}

/** Live acts: eligible, minted, record-only, a beneficiary leg to user-1, a foreign act. */
function liveRows(): PEHistoryDocument[] {
  return [
    row({ peId: 'live-1', ageMs: 2 * DAY }),
    row({ peId: 'live-2', ageMs: DAY, mintStatus: 'minted' }),
    row({ peId: 'live-3', ageMs: 3 * DAY, mintStatus: 'record_only', category: 'commerce' }),
    row({ peId: 'live-ben', ageMs: 4 * DAY, userId: 'agent-7', beneficiary: 'user-1' }),
    row({ peId: 'live-foreign', ageMs: 5 * DAY, userId: 'user-2' }),
    row({ peId: 'live-4', ageMs: 1000 }),
  ];
}

describe('readEconomicAccrualProjection on the meter — parity with the pure fold', () => {
  it('stored totals + the live act-key tail equal the reference fold, field by field', async () => {
    const fake = createFakeFirestore();
    const rows = await seedMeteredRows(fake, liveRows(), NOW);
    const trace = emptyAggregateReadTrace();
    const read = await readEconomicAccrualProjection(db(fake), 'user-1', {
      nowMs: NOW, settlementProjection: context(), tailPageSize: 1,
    }, trace);
    const fold = referenceFold(rows, 'user-1', context());
    // Non-vacuous: real rows on both roles, real value projected.
    expect(read.totalPEs).toBe(5); // 6 seeded − 1 foreign
    expect(BigInt(read.totalCurrentSettlementProjectionAtomic!)).toBeGreaterThan(0n);
    expect(trace.tailActKeys).toBe(5); // 4 contributor keys + 1 beneficiary key, paged one by one
    expect(pick(read)).toEqual(pick(fold));
  });

  it('a row whose act key expired still counts in the frozen sums; the tail covers only live keys', async () => {
    const fake = createFakeFirestore();
    // An aggregate whose watermark already sits at W: rows at or below it are frozen at commit.
    const W = NOW - 40 * DAY;
    const seeded = emptyAggregateDocument('user-1');
    seeded.roles.contributor.frozen_through_ms = W;
    fake.store.set(`${ECONOMIC_AGGREGATE_COLLECTION}/user-1`, seeded as unknown as Record<string, unknown>);
    // Old acts: their act keys are gone (TTL), only their aggregate contribution remains.
    const old = await seedMeteredRows(fake, [
      row({ peId: 'old-1', ageMs: 45 * DAY }),
      row({ peId: 'old-2', ageMs: 50 * DAY, category: 'agent' }),
    ], NOW, { withActKeys: false });
    const live = await seedMeteredRows(fake, liveRows(), NOW);
    const read = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW, settlementProjection: context() });
    const fold = referenceFold([...old, ...live], 'user-1', context());
    expect(read.totalPEs).toBe(7);
    expect(pick(read)).toEqual(pick(fold));
  });

  it('the tail reads each act key\'s CURRENT row (a corroboration landing on it, a minted writeback)', async () => {
    const fake = createFakeFirestore();
    const rows = await seedMeteredRows(fake, liveRows(), NOW);
    const before = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW, settlementProjection: context(1n, 1n) });
    // Settlement flips live-1 to minted through the ONE mutation primitive (aggregate delta too).
    const outcome = await mutatePeHistoryRowWithAggregate(
      db(fake) as unknown as Parameters<typeof mutatePeHistoryRowWithAggregate>[0],
      'live-1', { mint_status: 'minted' }, { nowMs: NOW },
    );
    expect(outcome.outcome).toBe('applied');
    const after = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW, settlementProjection: context(1n, 1n) });
    expect(BigInt(after.totalCurrentSettlementProjectionAtomic!))
      .toBe(BigInt(before.totalCurrentSettlementProjectionAtomic!) - 10n * UNIT);
    const current = rows.map((r) => (r.peId === 'live-1' ? { ...r, mint_status: 'minted' } as PEHistoryDocument : r));
    expect(pick(after)).toEqual(pick(referenceFold(current, 'user-1', context(1n, 1n))));
  });

  it('with no projection context the totals still equal the fold and no tail is read', async () => {
    const fake = createFakeFirestore();
    const rows = await seedMeteredRows(fake, liveRows(), NOW);
    const trace = emptyAggregateReadTrace();
    const read = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW }, trace);
    expect(trace.tailActKeys).toBe(0);
    expect(read.currentSettlementProjectionUnavailableReason).toBe('factors_not_supplied');
    expect(pick(read)).toEqual(pick(referenceFold(rows, 'user-1', null)));
  });

  it('an identity with no aggregate yet reads as empty totals (no backfill, no fold fall-back)', async () => {
    const fake = createFakeFirestore();
    const read = await readEconomicAccrualProjection(db(fake), 'user-9', { nowMs: NOW, settlementProjection: context() });
    expect(read.totalPEs).toBe(0);
    expect(read.totalCurrentSettlementProjectionAtomic).toBe('0');
  });
});

describe('RED controls', () => {
  it('RED: a planted legacy pe_history row is never read', async () => {
    const fake = createFakeFirestore();
    await seedMeteredRows(fake, liveRows(), NOW);
    const clean = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW, settlementProjection: context() });
    const legacy = row({ peId: 'legacy-1', ageMs: DAY });
    fake.store.set(`pe_history/${legacy.peId}`, {
      ...(legacy as unknown as Record<string, unknown>),
      economic_aggregate_applied: ECONOMIC_AGGREGATE_SCHEMA_VERSION,
    });
    const withLegacy = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW, settlementProjection: context() });
    expect(pick(withLegacy)).toEqual(pick(clean));
  });

  it('RED: an UNMARKED act key (in no total) is never projected; the same key marked is', async () => {
    const fake = createFakeFirestore();
    await seedMeteredRows(fake, liveRows(), NOW);
    const base = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW, settlementProjection: context(1n, 1n) });
    const stray = row({ peId: 'stray', ageMs: DAY }); // eligible, unmarked
    seedActKeys(fake, [stray as unknown as Record<string, unknown>]);
    const unmarked = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW, settlementProjection: context(1n, 1n) });
    expect(unmarked.totalCurrentSettlementProjectionAtomic).toBe(base.totalCurrentSettlementProjectionAtomic);
    // CONTROL: mark it, and the tail does project it — the guard above is not vacuous.
    const key = fake.store.get(`${METER_ACT_KEYS_COLLECTION}/stray`)!;
    fake.store.set(`${METER_ACT_KEYS_COLLECTION}/stray`, {
      ...key,
      row: { ...(key.row as Record<string, unknown>), economic_aggregate_applied: ECONOMIC_AGGREGATE_SCHEMA_VERSION },
    });
    const marked = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW, settlementProjection: context(1n, 1n) });
    expect(BigInt(marked.totalCurrentSettlementProjectionAtomic!))
      .toBe(BigInt(base.totalCurrentSettlementProjectionAtomic!) + 10n * UNIT);
  });

  it('RED: a wrong stored total makes the read differ from the fold (parity is not vacuous)', async () => {
    const fake = createFakeFirestore();
    const rows = await seedMeteredRows(fake, liveRows(), NOW);
    const key = `${ECONOMIC_AGGREGATE_COLLECTION}/user-1`;
    const stored = fake.store.get(key)!;
    (stored.roles as Record<string, Record<string, unknown>>).contributor.record_points_atomic = '1';
    fake.store.set(key, stored);
    const read = await readEconomicAccrualProjection(db(fake), 'user-1', { nowMs: NOW, settlementProjection: context() });
    expect(read.totalRecordPointsAtomic).not.toBe(referenceFold(rows, 'user-1', context()).totalRecordPointsAtomic);
  });
});

describe('readAggregateMintStatusCounts — unminted / minted from the running total', () => {
  it('counts acts by current status and follows a status transition', async () => {
    const fake = createFakeFirestore();
    await seedMeteredRows(fake, liveRows(), NOW);
    const before = await readAggregateMintStatusCounts(db(fake), 'user-1');
    expect(before).toEqual({ eligible: 2, minted: 1, record_only: 1 }); // live-1, live-4 / live-2 / live-3
    await mutatePeHistoryRowWithAggregate(
      db(fake) as unknown as Parameters<typeof mutatePeHistoryRowWithAggregate>[0],
      'live-4', { mint_status: 'minted' }, { nowMs: NOW },
    );
    // RED-style: the transition MOVES the counts (a total that ignored it would read 2/1).
    expect(await readAggregateMintStatusCounts(db(fake), 'user-1')).toEqual({ eligible: 1, minted: 2, record_only: 1 });
  });

  it('an identity without an aggregate has no counts', async () => {
    expect(await readAggregateMintStatusCounts(db(createFakeFirestore()), 'nobody')).toEqual({});
  });
});

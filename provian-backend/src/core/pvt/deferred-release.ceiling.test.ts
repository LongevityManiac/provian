/**
 * The graduated-release ceiling's input: eligible acts the meter recorded per day over the trailing
 * twelve epochs, read from the per-day disposition counts every act commit maintains. The legacy
 * mint-batch collection nothing writes any more gave the ceiling an input of zero, so nothing was
 * ever released; these controls pin both ends of that.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { computeRecordSnapshot, hashRecordEconomicSnapshot } from './policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';
import { incrementConsoleDispositionRollupInTransaction, adjustConsoleDispositionRollupInTransaction, CONSOLE_ROLLUP_COLLECTION,
  consoleRollupDay, consoleRollupDocId, consoleRollupShard } from './disposition-rollup';

let fake: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: make } = require('./__test-helpers__/fake-firestore');
  fake = make();
  return { __esModule: true, default: { firestore: () => fake } };
});

import { DEFERRED_RELEASE_TRAILING_DAYS, processDeferredReleaseBatch, trailingDailyEligibleActAverage } from './deferred-release';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-17T09:30:00Z');
const TODAY = Date.parse('2026-11-17T00:00:00Z');
const TIMESTAMP = 1_000;
const CONFIG = { jurisdiction: 'US', daily_ceiling_percent: 50, re_attestation_required: true, activated_at: 1, active: true };

/**
 * The test double does not apply a `FieldValue.increment` nested in a map when the document is
 * absent (real Firestore starts it from 0), so each bucket the writer will touch is opened empty
 * first. The counts themselves are written only by the real writer below.
 */
function openBucket(db: FakeFirestore, sealMs: number, peId: string): void {
  const day = consoleRollupDay(sealMs), key = `${CONSOLE_ROLLUP_COLLECTION}/${consoleRollupDocId(day, consoleRollupShard(peId))}`;
  if (!db.store.has(key)) db.store.set(key, { day, total: 0, counts: {} });
}

/** Record acts through the writer the act commit and the seal use, in one transaction each. */
async function record(db: FakeFirestore, sealMs: number, disposition: 'eligible' | 'record_only', n: number, tag: string): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    openBucket(db, sealMs, `${tag}_${i}`);
    await db.runTransaction(async (txn) => {
      incrementConsoleDispositionRollupInTransaction(txn as never, db as never, { disposition, sealMs, peId: `${tag}_${i}` });
    });
  }
}

function seedDeferred(db: FakeFirestore, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const peId = `pe_deferred_${i}`;
    const snapshot = computeRecordSnapshot(materializeProposedMonetaryPolicy(0), {
      peId, economicActorId: 'user-1', actionType: 'wallet_created', recordedAtMs: TIMESTAMP + i,
      occurrenceOrdinal: 1, dailyOrdinal: 1, exactDuplicate: false, uniqueArtifact: false, attestationTier: 'software',
      linkageState: 'unlinked', evidenceState: 'not_required', canonicalEventId: null, selfReferencing: false,
      sharedBeneficialOwnership: false, pairChurnDetected: false, sessionLineageId: null, genesisReservation: null,
    });
    db.store.set(`pe_history/${peId}`, {
      peId, userId: 'user-1', peHash: 'hash', actionType: 'wallet_created', timestamp: TIMESTAMP + i, jurisdiction_context: 'US',
      mint_status: 'deferred', mint_disposition: 'jurisdiction_deferred', economic_snapshot: snapshot,
      economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot), estimatedPVT: 0, estimated_pvt_atomic: '0',
    });
  }
}
const stillDeferred = (db: FakeFirestore): number => [...db.store.entries()]
  .filter(([key, row]) => key.startsWith('pe_history/') && row.mint_status === 'deferred').length;

beforeEach(() => { fake.store.clear(); fake.ops.length = 0; });

describe('the release ceiling input', () => {
  it('RED: with no mint-batch records and the meter\'s eligible acts as input, deferred rows are released; an input of zero releases nothing', async () => {
    // Ten eligible acts a day for the last four complete days; the legacy mint-batch collection is empty, as in production.
    for (let back = 1; back <= 4; back += 1) await record(fake, TODAY - back * DAY + 3_600_000, 'eligible', 10, `d${back}`);
    expect([...fake.store.keys()].some((k) => k.startsWith('pvt_mint_batches/'))).toBe(false);
    seedDeferred(fake, 8);

    // The old input: zero → the existing formula's ceiling is zero → nothing moves.
    expect(await processDeferredReleaseBatch(CONFIG, 0)).toBe(0);
    expect(stillDeferred(fake)).toBe(8);

    // The new input: 10 per day; at 50% the existing formula releases floor(10 * 0.5) = 5.
    const average = await trailingDailyEligibleActAverage(fake as unknown as Firestore, NOW);
    expect(average).toBe(10);
    expect(await processDeferredReleaseBatch(CONFIG, average)).toBe(5);
    expect(stillDeferred(fake)).toBe(3);
  });

  it('counts eligible acts only: record-only days alone give zero, and nothing is released', async () => {
    for (let back = 1; back <= 4; back += 1) await record(fake, TODAY - back * DAY, 'record_only', 25, `r${back}`);
    seedDeferred(fake, 2);
    const average = await trailingDailyEligibleActAverage(fake as unknown as Firestore, NOW);
    expect(average).toBe(0);
    expect(await processDeferredReleaseBatch(CONFIG, average)).toBe(0);
    expect(stillDeferred(fake)).toBe(2);
  });

  it('follows a later disposition change on the act\'s own day (a released hold counts; a demoted act stops counting)', async () => {
    const day = TODAY - 2 * DAY;
    await record(fake, day, 'eligible', 4, 'x');
    openBucket(fake, day, 'x_0'); openBucket(fake, day, 'y_0');
    await fake.runTransaction(async (txn) => {
      adjustConsoleDispositionRollupInTransaction(txn as never, fake as never, { fromDisposition: 'eligible', toDisposition: 'record_only', sealMs: day, peId: 'x_0' });
      adjustConsoleDispositionRollupInTransaction(txn as never, fake as never, { fromDisposition: 'jurisdiction_deferred', toDisposition: 'eligible', sealMs: day, peId: 'y_0' });
    });
    // Days since the first recorded day: 2 (two days ago and yesterday). Eligible: 4 - 1 + 1 = 4.
    expect(await trailingDailyEligibleActAverage(fake as unknown as Firestore, NOW)).toBe(2);
  });

  it('the window is the twelve epochs before today: today and anything older are left out; a younger network is not diluted', async () => {
    expect(DEFERRED_RELEASE_TRAILING_DAYS).toBe(84);
    await record(fake, NOW, 'eligible', 100, 'today');
    await record(fake, TODAY - (DEFERRED_RELEASE_TRAILING_DAYS + 1) * DAY, 'eligible', 100, 'old');
    expect(await trailingDailyEligibleActAverage(fake as unknown as Firestore, NOW)).toBe(0);
    await record(fake, TODAY - DEFERRED_RELEASE_TRAILING_DAYS * DAY, 'eligible', 84, 'edge');
    // The oldest day in the window starts the span: 84 acts over 84 days.
    expect(await trailingDailyEligibleActAverage(fake as unknown as Firestore, NOW)).toBe(1);
    fake.store.clear();
    await record(fake, TODAY - 3 * DAY, 'record_only', 1, 'start');
    await record(fake, TODAY - 1 * DAY, 'eligible', 9, 'late');
    // First recorded day three days ago: 9 eligible over 3 days.
    expect(await trailingDailyEligibleActAverage(fake as unknown as Firestore, NOW)).toBe(3);
  });
});

describe('server.ts wires the deferred-release ceiling to the meter\'s eligible acts', () => {
  const server = readFileSync(join(__dirname, '..', '..', 'server.ts'), 'utf8');
  const start = server.indexOf("app.post('/v1/internal/scheduler/deferred-release'");
  const block = server.slice(start, server.indexOf('\napp.', start + 1));
  it('RED: the block computes its input from the eligible-act average and never from the legacy mint batches', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(block).toContain('trailingDailyEligibleActAverage(db, Date.now())');
    expect(block).toContain('processDeferredReleaseBatch(config, trailingDailyMintAvg)');
    expect(block).not.toContain('pvt_mint_batches');
  });
});

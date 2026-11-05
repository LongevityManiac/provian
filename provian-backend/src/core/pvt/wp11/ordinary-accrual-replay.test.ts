/**
 * the replay driver, and the crash it exists for.
 *
 * The intake row has been co-committed with every mainline chain-tip advance
 * since cutover reconciliation. What was missing is the half that READS it, and until the
 * mainline sealed `record_only` that absence cost nothing: a lost accrual lost
 * a zero. It does not any more, so the recovery is exercised here at the two
 * crash boundaries that can actually strand one.
 *
 * The exactly-once property is NOT new code and is not re-implemented: the
 * driver leans on `writePEHistory`'s create-if-absent seal and the per-PE
 * effect state machine, both of which ship. What these tests prove is that the
 * driver USES them correctly — one pe_history row, one accrual total, one
 * network counter, across a crash plus two replays plus a double delivery.
 *
 * RED CONTROLS kept permanently in-suite rather than run once by hand :
 * - a replay whose payload was mutated after commit is REFUSED, not replayed;
 * - a replayed act prices identically to the live one, so a driver that
 * quietly dropped the durability marker would show up as a disposition
 * change rather than as silence;
 * - the sweep's population is counted, so a filter that empties it fails
 * instead of passing over zero rows.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from '../beneficiary';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('../__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

jest.mock('../../../cache', () => ({
  cache: {
    getUserDailyPECountStrict: jest.fn(async () => 0),
    getUserActionTypeCountStrict: jest.fn(async () => 0),
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: jest.fn(async () => 1),
    incrementHourlyPECount: jest.fn(async () => {}),
    commitPEAccountingCountersOnce: jest.fn(async () => ({ idempotent: false })),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));

const mockResolveBeneficiary = jest.fn<
  (...args: unknown[]) => Promise<BeneficiaryCacheEntry>
>(async () => ({
  linked: false,
  humanWalletId: null,
  humanUserId: null,
  humanAddress: null,
  agentShareBps: null,
}));
jest.mock('../beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('../../jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: async () => 'immediate',
}));
jest.mock('../delegation-pe', () => ({
  isDelegationQualifying: () => false,
  createDelegationPE: async () => {},
}));
jest.mock('../../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'financial',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

import { recordPEAccrual, type RecordPEAccrualParams } from '../../../pvt-accrual';
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  ORDINARY_ACCRUAL_REPLAY_SOURCE,
  buildOrdinaryAccrualIntake,
  type OrdinaryAccrualIntakeDocument,
} from './ordinary-accrual-intake';
import {
  ORDINARY_ACCRUAL_REPLAY_GRACE_MS,
  ORDINARY_ACCRUAL_REPLAY_MAX_ATTEMPTS,
  ORDINARY_ACCRUAL_REPLAY_STATE_COLLECTION,
  replayIncompleteOrdinaryAccruals,
  replayOrdinaryAccrual,
} from './ordinary-accrual-replay';
import { DURABLE_ACCRUAL_EFFECTS_COLLECTION } from '../durable-accrual-effects';

const TIMESTAMP = Date.UTC(2026, 7, 4, 12, 0);
const NOW = TIMESTAMP + ORDINARY_ACCRUAL_REPLAY_GRACE_MS + 1;
const CP = '0x2222222222222222222222222222222222222222';

let seq = 0;

function mainlineParams(over: Record<string, unknown> = {}): RecordPEAccrualParams {
  const peId = `pe_replay_${seq++}`;
  return {
    peId,
    userId: 'agent1',
    actionType: 'send',
    integrationSource: 'relay_action',
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    counterpartyAddress: CP,
    economicEvidenceState: 'verified',
    economicCanonicalEventId: `base:8453:${peId}:0`,
    tx_hash: `base:8453:${peId}:0`,
    ...over,
  } as RecordPEAccrualParams;
}

function commitIntake(params: RecordPEAccrualParams): OrdinaryAccrualIntakeDocument {
  const doc = buildOrdinaryAccrualIntake({
    prevHash: `prev_${params.peId}`,
    peHash: params.peHash,
    accrualParams: params,
  });
  mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`, { ...doc });
  return doc;
}

const deps = () => ({
  db: mockDb as never,
  recordPEAccrual: recordPEAccrual as never,
});

function peHistory(peId: string): Record<string, unknown> | undefined {
  return mockDb.store.get(`pe_history/${peId}`) as Record<string, unknown> | undefined;
}
function effectState(peId: string): unknown {
  return (mockDb.store.get(`${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${peId}`) as
    { state?: unknown } | undefined)?.state;
}
function networkShards(): Array<[string, Record<string, unknown>]> {
  return [...mockDb.store.entries()]
    .filter(([k]) => k.startsWith('pvt_network_stats/global/shards/')) as Array<
      [string, Record<string, unknown>]
    >;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveBeneficiary.mockResolvedValue({
    linked: false,
    humanWalletId: null,
    humanUserId: null,
    humanAddress: null,
    agentShareBps: null,
  });
  mockDb.store.clear();
  mockDb.ops.length = 0;
  // The actor 'agent1' is a REAL (non-test) sovereign agent. WS4's fail-closed
  // networkCountable (Unknown = Block) only counts a PE whose actor resolves to a
  // non-test wallet, and counts an agent via its agent_wallets doc even when
  // the PE carries no ownerType (which real receive/send PEs don't). Seed that doc
  // so the network-counter assertions below exercise a resolvable actor — the
  // production shape — rather than the synthetic/unresolvable case the gate drops.
  mockDb.store.set('agent_wallets/aw_replay', {
    id: 'aw_replay',
    agent_id: 'agent1',
    platform: 'live',
  });
});

describe('the crash the intake row exists for', () => {
  it('recovers a lost accrual after a crash BEFORE the pe_history seal, exactly once', async () => {
    const params = mainlineParams();
    const intake = commitIntake(params);

    // The live fire-and-forget call dies mid-flight. Best-effort transport
    // swallows the throw, exactly as production does, so the endpoint has
    // already returned 200 with a sealed PE and NO accrual behind it.
    await recordPEAccrual({ ...params, durableTestCrashAt: 'before_pe_history' });
    expect(peHistory(params.peId)).toBeUndefined();

    expect(await replayOrdinaryAccrual(deps(), intake, { nowMs: NOW })).toBe('recovered');
    expect(peHistory(params.peId)).toBeDefined();
    expect(effectState(params.peId)).toBe('complete');

    // Replaying again is a no-op, and the counters moved exactly once.
    expect(await replayOrdinaryAccrual(deps(), intake, { nowMs: NOW })).toBe('already_complete');
    expect(mockDb.store.get('pvt_accrual/agent1')).toMatchObject({ totalPEs: 1 });
    expect(networkShards()).toHaveLength(1);
    expect(networkShards()[0][1]).toMatchObject({ totalPEs: 1 });
  });

  it('finishes the omitted effects after a crash AFTER the seal', async () => {
    const params = mainlineParams();
    const intake = commitIntake(params);

    await recordPEAccrual({ ...params, durableTestCrashAt: 'after_pe_history' });
    expect(peHistory(params.peId)).toBeDefined();
    expect(effectState(params.peId)).not.toBe('complete');

    expect(await replayOrdinaryAccrual(deps(), intake, { nowMs: NOW })).toBe('recovered');
    expect(effectState(params.peId)).toBe('complete');
    expect(mockDb.store.get('pvt_accrual/agent1')).toMatchObject({ totalPEs: 1 });
  });

  it('a DOUBLE DELIVERY of the same report leaves exactly one record', async () => {
    // The idempotency key is the pe_id, established by the intake row's
    // `create` (not `set`) inside the tip transaction. Here the accrual itself
    // is delivered twice and then replayed twice on top.
    const params = mainlineParams();
    const intake = commitIntake(params);

    await recordPEAccrual(params);
    await recordPEAccrual(params);
    await replayOrdinaryAccrual(deps(), intake, { nowMs: NOW });
    await replayOrdinaryAccrual(deps(), intake, { nowMs: NOW });

    expect([...mockDb.store.keys()].filter((k) => k.startsWith('pe_history/'))).toHaveLength(1);
    expect(mockDb.store.get('pvt_accrual/agent1')).toMatchObject({ totalPEs: 1 });
    expect(networkShards()).toHaveLength(1);
    expect(networkShards()[0][1]).toMatchObject({ totalPEs: 1 });
    // And exactly one activity reservation was consumed for this capped type —
    // four deliveries of one act must not consume four slots.
    expect([...mockDb.store.keys()].filter((k) =>
      k.startsWith('activity_mint_reservations/'))).toHaveLength(1);
    expect(peHistory(params.peId)!.activity_mint_reservation)
      .toMatchObject({ decision: 'reserved' });
  });

  it('RED CONTROL — a replayed act prices IDENTICALLY to the live one', async () => {
    // If the driver perturbed the stored payload in any way (dropping the
    // durability marker being the obvious one), the accrual's digest check
    // would refuse the claim and the recovered PE would seal `record_only`
    // instead of `eligible`. So this is the guard against a silent downgrade
    // hiding inside a "successful" recovery.
    const live = mainlineParams();
    commitIntake(live);
    await recordPEAccrual(live);
    const livePoints = (peHistory(live.peId)!.economic_snapshot as
      { recordPointsAtomic: string }).recordPointsAtomic;
    expect(peHistory(live.peId)!.mint_disposition).toBe('eligible');

    mockDb.store.clear();
    const crashed = mainlineParams();
    const intake = commitIntake(crashed);
    await recordPEAccrual({ ...crashed, durableTestCrashAt: 'before_pe_history' });
    await replayOrdinaryAccrual(deps(), intake, { nowMs: NOW });

    expect(peHistory(crashed.peId)!.mint_disposition).toBe('eligible');
    expect((peHistory(crashed.peId)!.economic_snapshot as
      { recordPointsAtomic: string }).recordPointsAtomic).toBe(livePoints);
  });
});

describe('refusals and bounds', () => {
  it('REFUSES a row mutated after commit rather than replaying it', async () => {
    const params = mainlineParams();
    const intake = commitIntake(params);
    await recordPEAccrual({ ...params, durableTestCrashAt: 'before_pe_history' });

    const tampered = {
      ...intake,
      accrual_params: { ...intake.accrual_params, actionType: 'wallet_created' },
    } as OrdinaryAccrualIntakeDocument;

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await replayOrdinaryAccrual(deps(), tampered, { nowMs: NOW }))
        .toBe('binding_rejected');
    } finally {
      errorSpy.mockRestore();
    }
    expect(peHistory(params.peId)).toBeUndefined();
    expect(mockDb.store.get(`${ORDINARY_ACCRUAL_REPLAY_STATE_COLLECTION}/${params.peId}`))
      .toMatchObject({ state: 'rejected', last_outcome: 'binding_rejected' });

    // A rejected row is never reconsidered, even with an intact document.
    expect(await replayOrdinaryAccrual(deps(), intake, { nowMs: NOW })).toBe('binding_rejected');
    expect(peHistory(params.peId)).toBeUndefined();
  });

  it('parks a row that cannot complete after the attempt bound', async () => {
    const params = mainlineParams();
    const intake = commitIntake(params);
    const failing = {
      db: mockDb as never,
      recordPEAccrual: (async () => { throw new Error('downstream unavailable'); }) as never,
    };

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < ORDINARY_ACCRUAL_REPLAY_MAX_ATTEMPTS; i += 1) {
        expect(await replayOrdinaryAccrual(failing, intake, { nowMs: NOW })).toBe('failed');
      }
      expect(await replayOrdinaryAccrual(failing, intake, { nowMs: NOW })).toBe('exhausted');
    } finally {
      errorSpy.mockRestore();
    }
    expect(mockDb.store.get(`${ORDINARY_ACCRUAL_REPLAY_STATE_COLLECTION}/${params.peId}`))
      .toMatchObject({ state: 'exhausted' });
  });
});

describe('the sweep', () => {
  it('leaves rows inside the grace window alone and recovers the ones outside it', async () => {
    const fresh = mainlineParams({ timestamp: NOW });
    commitIntake(fresh);
    await recordPEAccrual({ ...fresh, durableTestCrashAt: 'before_pe_history' });

    const stale = mainlineParams();
    commitIntake(stale);
    await recordPEAccrual({ ...stale, durableTestCrashAt: 'before_pe_history' });

    const result = await replayIncompleteOrdinaryAccruals(deps(), { nowMs: NOW });

    // The population is COUNTED: a filter that silently emptied this would fail
    // here rather than reporting a clean sweep over zero rows.
    expect(result.scanned).toBe(1);
    expect(result.recovered).toBe(1);
    expect(peHistory(stale.peId)).toBeDefined();
    expect(peHistory(fresh.peId)).toBeUndefined();
  });

  it('reports already_complete for the steady state and changes nothing', async () => {
    const params = mainlineParams();
    commitIntake(params);
    await recordPEAccrual(params);
    const before = JSON.stringify(peHistory(params.peId));

    const result = await replayIncompleteOrdinaryAccruals(deps(), { nowMs: NOW });
    expect(result).toMatchObject({ scanned: 1, already_complete: 1, recovered: 0 });
    expect(JSON.stringify(peHistory(params.peId))).toBe(before);
    // No replay-state doc is written for a row that needed nothing.
    expect(mockDb.store.has(`${ORDINARY_ACCRUAL_REPLAY_STATE_COLLECTION}/${params.peId}`))
      .toBe(false);
  });

  it('REACHES a stranded row that sits past the page limit', async () => {
    // THE REVIEWER-FOUND DEFECT, and the only test shape that could have caught
    // it. The first cut queried `recorded_at_ms <= cutoff` ascending with a page
    // limit, no completion filter and no cursor. The intake collection is
    // create-only — nothing in this tree deletes or prunes a row — and
    // completion lives in a different collection the query cannot join. So every
    // pass re-read the SAME oldest page forever. Any test that sweeps 1 or 2
    // rows passes identically with or without the bug; the population has to
    // EXCEED the page for the defect to be constructible at all.
    //
    // Here: 6 complete rows, then 2 stranded ones, swept 3 at a time.
    const LATER = TIMESTAMP + ORDINARY_ACCRUAL_REPLAY_GRACE_MS + 10_000;
    const complete: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const p = mainlineParams({ timestamp: TIMESTAMP + i });
      commitIntake(p);
      await recordPEAccrual(p);
      complete.push(p.peId);
    }
    const stranded: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const p = mainlineParams({ timestamp: TIMESTAMP + 100 + i });
      commitIntake(p);
      await recordPEAccrual({ ...p, durableTestCrashAt: 'before_pe_history' });
      stranded.push(p.peId);
    }
    for (const peId of stranded) expect(peHistory(peId)).toBeUndefined();

    // Sweep with a page SMALLER than the backlog, repeatedly. With the old
    // head-pinned query this loops on the first 3 complete rows and recovers 0.
    let recovered = 0;
    let scanned = 0;
    for (let pass = 0; pass < 4; pass += 1) {
      const r = await replayIncompleteOrdinaryAccruals(deps(), { nowMs: LATER, limit: 3 });
      recovered += r.recovered;
      scanned += r.scanned;
    }

    expect(recovered).toBe(2);
    for (const peId of stranded) expect(peHistory(peId)).toBeDefined();
    // The sweep genuinely WALKED: it examined more rows than one page holds.
    expect(scanned).toBeGreaterThan(3);
    // ...and the complete rows were not disturbed on the way past.
    for (const peId of complete) expect(peHistory(peId)).toBeDefined();
  });

  it('the cursor WRAPS, so a row stranded behind the current position is still reached', async () => {
    // The second half of the same defect. A cursor that only ever moves forward
    // and then parks at the end would strand anything that became incomplete
    // behind it. Drive the cursor to the end first, THEN strand a row that sorts
    // earlier, and require the next passes to come back around to it.
    const LATER = TIMESTAMP + ORDINARY_ACCRUAL_REPLAY_GRACE_MS + 10_000;
    for (let i = 0; i < 3; i += 1) {
      const p = mainlineParams({ timestamp: TIMESTAMP + 200 + i });
      commitIntake(p);
      await recordPEAccrual(p);
    }
    await replayIncompleteOrdinaryAccruals(deps(), { nowMs: LATER, limit: 2 });
    await replayIncompleteOrdinaryAccruals(deps(), { nowMs: LATER, limit: 2 });

    const behind = mainlineParams({ timestamp: TIMESTAMP + 1 });
    commitIntake(behind);
    await recordPEAccrual({ ...behind, durableTestCrashAt: 'before_pe_history' });
    expect(peHistory(behind.peId)).toBeUndefined();

    let recovered = 0;
    for (let pass = 0; pass < 4; pass += 1) {
      recovered += (await replayIncompleteOrdinaryAccruals(deps(), { nowMs: LATER, limit: 2 })).recovered;
    }
    expect(recovered).toBe(1);
    expect(peHistory(behind.peId)).toBeDefined();
  });

  it('a refused row does not become a permanent occupant of the window', async () => {
    // `binding_rejected` and `exhausted` rows are never actioned, so under the
    // head-pinned query they sat in the page forever and shrank the sweep's
    // reach on every pass. The cursor must advance past a row it refuses.
    const LATER = TIMESTAMP + ORDINARY_ACCRUAL_REPLAY_GRACE_MS + 10_000;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/pe_bogus_occupant`, {
        recorded_at_ms: TIMESTAMP, pe_id: 'pe_bogus_occupant',
      });
      const stranded = mainlineParams({ timestamp: TIMESTAMP + 5 });
      commitIntake(stranded);
      await recordPEAccrual({ ...stranded, durableTestCrashAt: 'before_pe_history' });

      let recovered = 0;
      for (let pass = 0; pass < 3; pass += 1) {
        recovered += (await replayIncompleteOrdinaryAccruals(deps(), { nowMs: LATER, limit: 1 })).recovered;
      }
      expect(recovered).toBe(1);
      expect(peHistory(stranded.peId)).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('skips a malformed intake row instead of guessing at it', async () => {
    mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/pe_bogus`, {
      recorded_at_ms: TIMESTAMP,
      pe_id: 'pe_bogus',
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await replayIncompleteOrdinaryAccruals(deps(), { nowMs: NOW });
      expect(result).toMatchObject({ scanned: 1, binding_rejected: 1, recovered: 0 });
    } finally {
      errorSpy.mockRestore();
    }
    expect(peHistory('pe_bogus')).toBeUndefined();
  });
});

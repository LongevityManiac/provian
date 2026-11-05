import type { Firestore } from 'firebase-admin/firestore';

jest.mock('../jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: async () => 'immediate',
}));

import { cache } from '../../cache';
import { writePEHistory, type WritePEHistoryParams } from '../../pe-history';
import { dailyDocId, utcDayKey } from './activity-mint-limits';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  DURABLE_ACCRUAL_EFFECTS_COLLECTION,
  createDurableAccrualEffect,
  resumeDurableAccrualEffects,
  type DurableAccrualCrashPoint,
  type DurableAccrualPayload,
} from './durable-accrual-effects';

const PE_ID = 'pe_watcher_durable_1';
const USER_ID = 'agent-1';
const HUMAN_ID = 'human-1';
const PAYER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COUNTERPARTY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TIMESTAMP = Date.UTC(2026, 6, 11, 12, 0, 0);

function payload(): DurableAccrualPayload {
  return {
    schemaVersion: 'pvt-accrual-effects/v1',
    peId: PE_ID,
    userId: USER_ID,
    actionType: 'x402_payment',
    category: 'x402',
    timestampMs: TIMESTAMP,
    attestationDepth: 'software',
    estimatedPvt: 10,
    agentPvt: 2,
    humanPvt: 8,
    humanUserId: HUMAN_ID,
    ownerType: 'agent',
    ownerWalletAddress: null,
    consumeActivityCaps: false,
    counterpartyAddress: COUNTERPARTY,
    countX402: true,
    x402PayerAddress: PAYER,
    redisCountersRequired: true,
  };
}

function fixture(): FakeFirestore {
  const fake = createFakeFirestore();
  fake.store.set(`pe_history/${PE_ID}`, {
    peId: PE_ID,
    userId: USER_ID,
    actionType: 'x402_payment',
  });
  fake.store.set(`${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${PE_ID}`, createDurableAccrualEffect(payload()) as unknown as Record<string, unknown>);
  fake.store.set('wallets/agent-wallet', {
    agent_id: USER_ID,
    pe_count: 4,
    pvt_earned: 12,
  });
  fake.store.set('wallets/human-wallet', {
    user_id: HUMAN_ID,
    pe_count: 9,
    pvt_earned: 20,
  });
  fake.store.set('agent_wallets/sovereign-agent', {
    agent_id: USER_ID,
    address: PAYER,
    platform: 'base',
    streak_days: 3,
    last_pe_date: '2026-07-10',
    x402_payment_count: 6,
  });
  // Exact activity reservation precedes pe_history. Durable recovery must
  // preserve these counters, never increment them a second time.
  fake.store.set(
    `activity_mint_daily/${dailyDocId(USER_ID, 'x402_payment', utcDayKey(TIMESTAMP))}`,
    {
      schema_version: 'activity-mint-counter/v1',
      user_id: USER_ID,
      action_type: 'x402_payment',
      day_key: utcDayKey(TIMESTAMP),
      count: 1,
      updated_at: TIMESTAMP,
    },
  );
  return fake;
}

function expectExactlyOnce(fake: FakeFirestore): void {
  expect(fake.store.get('pvt_accrual/agent-1')).toMatchObject({
    totalPEs: 1,
    totalEstimatedPVT: 2,
    weeklyPEs: 1,
    attestationDepth: 'software',
  });
  expect(fake.store.get('pvt_accrual/human-1')).toMatchObject({
    totalPEs: 1,
    totalEstimatedPVT: 8,
    attestationDepth: 'software',
  });
  expect(fake.store.get('wallets/agent-wallet')).toMatchObject({ pe_count: 5, pvt_earned: 14 });
  expect(fake.store.get('wallets/human-wallet')).toMatchObject({ pe_count: 10, pvt_earned: 28 });
  expect(fake.store.get('agent_wallets/sovereign-agent')).toMatchObject({
    streak_days: 4,
    last_pe_date: '2026-07-11',
    x402_payment_count: 7,
  });
  const daily = dailyDocId(USER_ID, 'x402_payment', utcDayKey(TIMESTAMP));
  expect(fake.store.get(`activity_mint_daily/${daily}`)).toMatchObject({ count: 1 });
  // there is no per-(actor, counterparty) counter to preserve or create.
  expect([...fake.store.keys()].filter((key) => key.startsWith('activity_mint_counterparty/')))
    .toEqual([]);
  const network = [...fake.store.entries()].filter(([key]) =>
    key.startsWith('pvt_network_stats/global/shards/'));
  expect(network).toHaveLength(1);
  expect(network[0][1]).toMatchObject({ totalPEs: 1, totalEstimatedPVT: 10 });
  expect(fake.store.get(`${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${PE_ID}`)).toMatchObject({
    state: 'complete',
  });
}

describe('durable PE accrual effects', () => {
  const committedRedisClaims = new Set<string>();

  beforeEach(() => {
    committedRedisClaims.clear();
    jest.spyOn(cache, 'commitPEAccountingCountersOnce').mockImplementation(async ({ peId }) => {
      const idempotent = committedRedisClaims.has(peId);
      committedRedisClaims.add(peId);
      return { idempotent };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('applies every Firestore aggregate and Redis claim once across arbitrary replay', async () => {
    const fake = fixture();
    const db = fake as unknown as Firestore;
    await resumeDurableAccrualEffects(db, PE_ID);
    await resumeDurableAccrualEffects(db, PE_ID);
    expectExactlyOnce(fake);
    expect(committedRedisClaims).toEqual(new Set([PE_ID]));
  });

  // ── network_countable gating (consignment ruling, 2026-08-13) ─────────────
  // A test-platform ACTOR's PE must record fully (history binding, its own
  // wallet pe_count, pvt_accrual, effect completion) while moving NO public
  // network aggregate: no shard increment, and the Redis leg is told to skip
  // the pvt:hour display bucket while still consuming the anti-abuse claim.

  it('a test-platform actor records fully but moves no network aggregate', async () => {
    const fake = fixture();
    const marked = fake.store.get('wallets/agent-wallet') as Record<string, unknown>;
    fake.store.set('wallets/agent-wallet', { ...marked, platform: 'test' });
    const db = fake as unknown as Firestore;

    await resumeDurableAccrualEffects(db, PE_ID);

    // PE-side effects all still happened.
    expect(fake.store.get('pvt_accrual/agent-1')).toMatchObject({ totalPEs: 1 });
    expect(fake.store.get('wallets/agent-wallet')).toMatchObject({ pe_count: 5 });
    expect(fake.store.get(`${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${PE_ID}`)).toMatchObject({
      state: 'complete',
      network_countable: false,
    });
    // Public aggregates did not move.
    const network = [...fake.store.entries()].filter(([key]) =>
      key.startsWith('pvt_network_stats/global/shards/'));
    expect(network).toHaveLength(0);
    // Redis leg still consumed the exactly-once claim, but was told to skip
    // the pvt:hour display bucket.
    expect(committedRedisClaims).toEqual(new Set([PE_ID]));
    expect(cache.commitPEAccountingCountersOnce).toHaveBeenCalledWith(
      expect.objectContaining({ peId: PE_ID, countNetworkHourly: false }),
    );
  });

  it('RED control: an UNMARKED actor moves the shard and counts the hourly bucket', async () => {
    // The gate must be able to ADMIT — a gate that never increments would
    // pass the exclusion test above identically (the guard-that-cannot-fail
    // shape). Same fixture, no marker: shard +1 and countNetworkHourly true.
    const fake = fixture();
    const db = fake as unknown as Firestore;

    await resumeDurableAccrualEffects(db, PE_ID);

    const network = [...fake.store.entries()].filter(([key]) =>
      key.startsWith('pvt_network_stats/global/shards/'));
    expect(network).toHaveLength(1);
    expect(network[0][1]).toMatchObject({ totalPEs: 1 });
    expect(fake.store.get(`${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${PE_ID}`)).toMatchObject({
      network_countable: true,
    });
    expect(cache.commitPEAccountingCountersOnce).toHaveBeenCalledWith(
      expect.objectContaining({ peId: PE_ID, countNetworkHourly: true }),
    );
  });

  it('creates pe_history and its recovery outbox atomically', async () => {
    const effect = createDurableAccrualEffect(payload());
    const history: WritePEHistoryParams = {
      peId: PE_ID,
      userId: USER_ID,
      timestamp: TIMESTAMP,
      actionType: 'x402_payment',
      category: 'x402',
      attestationDepth: 'software',
      estimatedPVT: 0,
      peHash: 'hash',
      jurisdiction_context: 'US',
      mint_disposition: 'record_only',
      disposition_reason_code: 'policy_record_only',
      policy_review_state: 'not_required',
      policy_review_reason_code: 'known_policy_entry',
      economic_policy_version: 'test-policy',
      economic_snapshot: null,
      durable_accrual_effect: effect,
    };
    const healthy = createFakeFirestore();
    await expect(writePEHistory(history, healthy as unknown as Firestore)).resolves.toBe(true);
    expect(healthy.store.get(`pe_history/${PE_ID}`)).toBeDefined();
    expect(healthy.store.get(`${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${PE_ID}`)).toEqual(effect);

    const failed = createFakeFirestore({ failTxnWriteTo: DURABLE_ACCRUAL_EFFECTS_COLLECTION });
    await expect(writePEHistory(history, failed as unknown as Firestore)).rejects.toThrow(
      'Injected transaction write failure',
    );
    expect(failed.store.get(`pe_history/${PE_ID}`)).toBeUndefined();
    expect(failed.store.get(`${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${PE_ID}`)).toBeUndefined();
  });

  const crashPoints: DurableAccrualCrashPoint[] = [
    'before_firestore_effects',
    'after_activity_counters',
    'after_agent_accrual',
    'after_human_accrual',
    'after_wallet_aggregates',
    'after_network_aggregate',
    'after_streak',
    'after_x402_count',
    'after_firestore_effects',
    'before_redis_effects',
    'after_redis_effects',
    'after_foundation_membership',
  ];

  it.each(crashPoints)('recovers exactly once after crash injection at %s', async (point) => {
    const fake = fixture();
    const db = fake as unknown as Firestore;
    await expect(resumeDurableAccrualEffects(db, PE_ID, point)).rejects.toThrow(
      `injected_durable_accrual_crash:${point}`,
    );
    await resumeDurableAccrualEffects(db, PE_ID);
    await resumeDurableAccrualEffects(db, PE_ID);
    expectExactlyOnce(fake);
    expect(committedRedisClaims).toEqual(new Set([PE_ID]));
  });

  // ── resolveWalletRef doc-id fallback (WS4) ────────────────────────────────
  // A forge witness seals the `wallets` DOC id as the actor. Neither the
  // `user_id` nor `agent_id` FIELD names it, so without the fallback the actor's
  // own wallet aggregate is silently skipped (the phantom-pe_count bug).

  function docIdActorPayload(peId: string, walletDocId: string): DurableAccrualPayload {
    return {
      schemaVersion: 'pvt-accrual-effects/v1',
      peId,
      userId: walletDocId, // the forge-witness shape: a wallets DOC id
      actionType: 'service:github_commit',
      category: 'service',
      timestampMs: TIMESTAMP,
      attestationDepth: 'software',
      estimatedPvt: 0,
      agentPvt: 0,
      humanPvt: 0,
      humanUserId: null,
      ownerType: 'human',
      ownerWalletAddress: null,
      consumeActivityCaps: false,
      counterpartyAddress: null,
      countX402: false,
      x402PayerAddress: null,
      redisCountersRequired: false,
    };
  }

  function docIdActorFixture(peId: string, walletDocId: string, walletDoc: Record<string, unknown>): FakeFirestore {
    const fake = createFakeFirestore();
    fake.store.set(`pe_history/${peId}`, { peId, userId: walletDocId, actionType: 'service:github_commit' });
    fake.store.set(
      `${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${peId}`,
      createDurableAccrualEffect(docIdActorPayload(peId, walletDocId)) as unknown as Record<string, unknown>,
    );
    fake.store.set(`wallets/${walletDocId}`, walletDoc);
    return fake;
  }

  it('credits a doc-id-keyed actor its own pe_count via the resolveWalletRef doc-id fallback', async () => {
    const walletDocId = 'wallet_ws4docid';
    const peId = 'pe_ws4_docid';
    // The actor's wallet is addressable ONLY by doc id — its user_id/agent_id
    // FIELDS name a DIFFERENT value (the exact production shape).
    const fake = docIdActorFixture(peId, walletDocId, {
      id: walletDocId, type: 'human', user_id: 'user_ws4', address: '0xws4', pe_count: 7, pvt_earned: 0,
    });
    await resumeDurableAccrualEffects(fake as unknown as Firestore, peId);
    // Fallback resolved the wallet -> its own pe_count moved.
    expect(fake.store.get(`wallets/${walletDocId}`)).toMatchObject({ pe_count: 8 });
    expect(fake.store.get(`pvt_accrual/${walletDocId}`)).toMatchObject({ totalPEs: 1 });
    // RED control for the networkCountable fail-closed flip: a REAL doc-id actor
    // (resolved via the fallback, non-test) STILL moves the public network counter.
    // This distinguishes the flip from a blanket doc-id exclusion — remove the
    // fallback and this goes RED (the actor becomes unresolvable -> not counted).
    const shards = [...fake.store.entries()].filter(([k]) => k.startsWith('pvt_network_stats/global/shards/'));
    expect(shards).toHaveLength(1);
    expect(shards[0][1]).toMatchObject({ totalPEs: 1 });
  });

  // RED control for the flip's OTHER direction: an actor that resolves to NO
  // wallet moves NO public network counter (Unknown = Block). Pre-flip this
  // defaulted countable and the PE leaked into the network total.
  it('does NOT move the network counter for an unresolvable actor (fail-closed)', async () => {
    const ghost = 'wallet_ws4ghost'; // wallet_-shaped, but no wallets doc exists
    const peId = 'pe_ws4_ghost';
    const fake = createFakeFirestore();
    fake.store.set(`pe_history/${peId}`, { peId, userId: ghost, actionType: 'service:github_commit' });
    fake.store.set(
      `${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${peId}`,
      createDurableAccrualEffect(docIdActorPayload(peId, ghost)) as unknown as Record<string, unknown>,
    );
    // NO wallets/${ghost} seeded — the actor resolves to nothing.
    await resumeDurableAccrualEffects(fake as unknown as Firestore, peId);
    // The PE still records (accrual is keyed directly by userId), but no public
    // network counter moved.
    expect(fake.store.get(`pvt_accrual/${ghost}`)).toMatchObject({ totalPEs: 1 });
    const shards = [...fake.store.entries()].filter(([k]) => k.startsWith('pvt_network_stats/global/shards/'));
    expect(shards).toHaveLength(0);
  });

  // RED CONTROL: the fallback is id-BOUND. A wallets doc whose `id` field does
  // not match the doc id (or is not human-typed) is NOT resolved — remove the
  // `data.id === userId && data.type === 'human'` binding and this goes RED
  // (pe_count would move on a doc the actor does not actually own).
  it('does NOT resolve a wallet whose id/type binding fails (fallback stays fail-closed)', async () => {
    const walletDocId = 'wallet_ws4mismatch';
    const peId = 'pe_ws4_mismatch';
    const fake = docIdActorFixture(peId, walletDocId, {
      id: 'wallet_SOMEONE_ELSE', type: 'human', user_id: 'user_x', address: '0x', pe_count: 7,
    });
    await resumeDurableAccrualEffects(fake as unknown as Firestore, peId);
    // Binding rejected -> the actor's wallet aggregate did NOT move.
    expect(fake.store.get(`wallets/${walletDocId}`)).toMatchObject({ pe_count: 7 });
  });
});

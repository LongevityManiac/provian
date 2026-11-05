/**
 * The weekly leaderboard counter on `wallets` (H2 close-out): the roll
 * rule, its RED control (a stale week must RESET, not increment), the
 * equality guard on read, and the proof that the durable-accrual effects
 * actually write it for the actor and only the actor.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import { getWeekStart, WEEK_MS } from './week-start';
import {
  WALLET_WEEKLY_PE_COUNT_FIELD,
  WALLET_WEEKLY_WEEK_START_FIELD,
  currentWeekWalletCount,
  nextWalletWeeklyCounter,
} from './wallet-ranking-fields';
import {
  DURABLE_ACCRUAL_EFFECTS_COLLECTION,
  createDurableAccrualEffect,
  resumeDurableAccrualEffects,
  type DurableAccrualPayload,
} from './durable-accrual-effects';

jest.mock('../../cache', () => ({
  cache: { commitPEAccountingCountersOnce: async () => ({ idempotent: false }) },
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => undefined,
}));

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const THIS_WEEK = getWeekStart(NOW);

describe('nextWalletWeeklyCounter', () => {
  it('same week → +1; absent → 1', () => {
    expect(nextWalletWeeklyCounter(undefined, NOW)).toEqual({
      [WALLET_WEEKLY_PE_COUNT_FIELD]: 1,
      [WALLET_WEEKLY_WEEK_START_FIELD]: THIS_WEEK,
    });
    expect(nextWalletWeeklyCounter({
      [WALLET_WEEKLY_PE_COUNT_FIELD]: 4,
      [WALLET_WEEKLY_WEEK_START_FIELD]: THIS_WEEK,
    }, NOW)).toEqual({
      [WALLET_WEEKLY_PE_COUNT_FIELD]: 5,
      [WALLET_WEEKLY_WEEK_START_FIELD]: THIS_WEEK,
    });
  });

  it('RED: a STALE week start resets to 1 — it must never carry last week forward', () => {
    const next = nextWalletWeeklyCounter({
      [WALLET_WEEKLY_PE_COUNT_FIELD]: 99,
      [WALLET_WEEKLY_WEEK_START_FIELD]: THIS_WEEK - WEEK_MS,
    }, NOW);
    expect(next[WALLET_WEEKLY_PE_COUNT_FIELD]).toBe(1);
    expect(next[WALLET_WEEKLY_PE_COUNT_FIELD]).not.toBe(100);
    expect(next[WALLET_WEEKLY_WEEK_START_FIELD]).toBe(THIS_WEEK);
  });

  it('currentWeekWalletCount applies the equality guard on read', () => {
    expect(currentWeekWalletCount({
      [WALLET_WEEKLY_PE_COUNT_FIELD]: 7, [WALLET_WEEKLY_WEEK_START_FIELD]: THIS_WEEK,
    }, THIS_WEEK)).toBe(7);
    expect(currentWeekWalletCount({
      [WALLET_WEEKLY_PE_COUNT_FIELD]: 7, [WALLET_WEEKLY_WEEK_START_FIELD]: THIS_WEEK - WEEK_MS,
    }, THIS_WEEK)).toBe(0);
    expect(currentWeekWalletCount(undefined, THIS_WEEK)).toBe(0);
  });
});

describe('durable-accrual effects write the weekly counter for the ACTOR wallet only', () => {
  function payload(peId: string, timestampMs: number): DurableAccrualPayload {
    return {
      schemaVersion: 'pvt-accrual-effects/v1',
      peId,
      userId: 'agent-1',
      actionType: 'coding_session',
      category: 'agent',
      timestampMs,
      attestationDepth: 'software',
      estimatedPvt: 1,
      agentPvt: 0.2,
      humanPvt: 0.8,
      humanUserId: 'human-1',
      ownerType: 'agent',
      ownerWalletAddress: null,
      consumeActivityCaps: false,
      counterpartyAddress: null,
      countX402: false,
      x402PayerAddress: null,
      redisCountersRequired: false,
    };
  }

  async function seal(fake: ReturnType<typeof createFakeFirestore>, peId: string, timestampMs: number): Promise<void> {
    fake.store.set(`pe_history/${peId}`, { peId, userId: 'agent-1', actionType: 'coding_session' });
    fake.store.set(
      `${DURABLE_ACCRUAL_EFFECTS_COLLECTION}/${peId}`,
      createDurableAccrualEffect(payload(peId, timestampMs)) as unknown as Record<string, unknown>,
    );
    await resumeDurableAccrualEffects(fake as unknown as Firestore, peId);
  }

  it('rolls the actor wallet across weeks and leaves the beneficiary human untouched', async () => {
    const fake = createFakeFirestore();
    fake.store.set('wallets/agent-wallet', { agent_id: 'agent-1', pe_count: 0 });
    fake.store.set('wallets/human-wallet', { user_id: 'human-1', pe_count: 0 });
    fake.store.set('agent_wallets/agent-doc', { agent_id: 'agent-1', platform: 'base' });

    await seal(fake, 'pe-1', NOW - WEEK_MS);       // last week
    await seal(fake, 'pe-2', NOW);                 // this week: resets to 1
    await seal(fake, 'pe-3', NOW + 60_000);        // this week: 2

    expect(fake.store.get('wallets/agent-wallet')).toMatchObject({
      pe_count: 3,
      [WALLET_WEEKLY_PE_COUNT_FIELD]: 2,
      [WALLET_WEEKLY_WEEK_START_FIELD]: THIS_WEEK,
    });
    // The human beneficiary's pe_count still moves (all-time board semantics),
    // but its weekly counter does NOT — the weekly board ranks the actor.
    const human = fake.store.get('wallets/human-wallet')!;
    expect(human.pe_count).toBe(3);
    expect(human).not.toHaveProperty(WALLET_WEEKLY_PE_COUNT_FIELD);
  });
});

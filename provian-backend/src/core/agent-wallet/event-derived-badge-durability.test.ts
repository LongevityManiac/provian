import { describe, expect, jest, test } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import { postBond } from '../agent-bank/bonds';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  AGENT_BADGE_AWARD_OUTBOX_COLLECTION,
  badgeAwardOutboxDocumentId,
  badgeEarnedPeId,
  reconcileAllBadgeAwards,
  reconcileBadgeAwards,
} from './badge-provenance';
import { IDENTITY_ACTS_COLLECTION, validateIdentityAct } from '../meter/identity-acts';

jest.mock('../onchain/tx-verifier', () => ({
  verifyEvmBondPosted: jest.fn(async () => ({ ok: true, blockNumber: 100 })),
  readOnchainBaseBond: jest.fn(async () => ({
    ok: true,
    baseBondAtomic: 750n * 10n ** 18n,
  })),
}));

const WALLET_ID = 'wallet_event_badges';
const AGENT_ID = 'agent-event-badges';
const ADDRESS = `0x${'a'.repeat(40)}`;
const NOW_OLD = Date.now() - 30 * 24 * 60 * 60 * 1000;

function seedWallet(fake: ReturnType<typeof createFakeFirestore>): void {
  fake.store.set(`agent_wallets/${WALLET_ID}`, {
    id: WALLET_ID,
    agent_id: AGENT_ID,
    address: ADDRESS,
    status: 'active',
    governance_score: 0,
    pe_count: 1,
    economic_activity_usd: 0,
    badges: [],
    streak_days: 0,
    x402_payment_count: 0,
    linked_human_wallet_id: null,
    created_at: NOW_OLD,
    updated_at: NOW_OLD,
  });
}

function depsFor(fake: ReturnType<typeof createFakeFirestore>): AgentBankDeps {
  return {
    db: fake as unknown as Firestore,
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(async () => undefined),
  } as unknown as AgentBankDeps;
}

/**
 * PE METER: a published badge PE is kept as the identity act its outbox pins (never an
 * envelope), re-deriving to exactly the pinned hash.
 */
function expectBadgeIdentityAct(
  fake: ReturnType<typeof createFakeFirestore>,
  badgeId: 'insured_agent' | 'governance_participant',
): void {
  const badgePeId = badgeEarnedPeId(WALLET_ID, badgeId);
  const outbox = fake.store.get(
    `${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${badgeAwardOutboxDocumentId(WALLET_ID, badgeId)}`,
  );
  expect(fake.store.has(`provenance_envelopes/${badgePeId}`)).toBe(false);
  const badgePe = validateIdentityAct({
    raw: fake.store.get(`${IDENTITY_ACTS_COLLECTION}/${badgePeId}`),
    peId: badgePeId,
    peHash: outbox?.badge_pe_hash as string,
    actorId: AGENT_ID,
    walletId: WALLET_ID,
  });
  expect(badgePe).toMatchObject({ action_type: 'badge_earned', metadata: { badge_id: badgeId } });
}

function cloneFake(source: ReturnType<typeof createFakeFirestore>) {
  const target = createFakeFirestore();
  for (const [key, value] of source.store) target.store.set(key, structuredClone(value));
  return target;
}

describe('durable event-derived badge publication', () => {
  test('verified bond commit survives badge-publication failure and reconciles once', async () => {
    process.env.BOND_POOL_CONTRACT_ADDRESS_BASE = `0x${'1'.repeat(40)}`;
    const faulted = createFakeFirestore({
      failTxnWriteOccurrence: { collection: 'agent_wallets', occurrence: 2 },
    });
    seedWallet(faulted);
    const bond = await postBond(
      depsFor(faulted),
      WALLET_ID,
      // bond lifecycle: acting-wallet doc for the machine's kill-switch-first gate.
      { status: 'active' } as unknown as import('./types').AgentWalletDocument,
      {
        autonomy_level: 2,
        chain: 'base',
        tx_hash: `0x${'b'.repeat(64)}`,
      },
    );

    const outboxKey = `${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${
      badgeAwardOutboxDocumentId(WALLET_ID, 'insured_agent')}`;
    expect(faulted.store.get(`bonds/${bond.bond_id}`)).toMatchObject({
      bond_id: bond.bond_id,
      status: 'active',
      pe_ids: [expect.stringMatching(/^pe_/)],
    });
    expect(faulted.store.get(outboxKey)).toMatchObject({
      state: 'pending',
      badge_id: 'insured_agent',
    });
    expect(faulted.store.get(`agent_wallets/${WALLET_ID}`)?.badges).toEqual([]);
    expect(faulted.store.has(
      `provenance_envelopes/${badgeEarnedPeId(WALLET_ID, 'insured_agent')}`,
    )).toBe(false);
    expect(faulted.store.has(
      `${IDENTITY_ACTS_COLLECTION}/${badgeEarnedPeId(WALLET_ID, 'insured_agent')}`,
    )).toBe(false);

    const retry = cloneFake(faulted);
    retry.store.set(`agent_wallets/${WALLET_ID}`, {
      ...retry.store.get(`agent_wallets/${WALLET_ID}`),
      status: 'suspended',
    });
    const retryDeps = depsFor(retry);
    await reconcileAllBadgeAwards(retryDeps);
    await reconcileBadgeAwards(retryDeps, WALLET_ID, ['insured_agent']);

    expect(retry.store.get(`agent_wallets/${WALLET_ID}`)?.status).toBe('suspended');
    expect(retry.store.get(`agent_wallets/${WALLET_ID}`)?.badges)
      .toEqual([{ id: 'insured_agent', earned_at: expect.any(Number) }]);
    expect(retry.store.get(outboxKey)).toMatchObject({
      state: 'complete',
      badge_pe_id: badgeEarnedPeId(WALLET_ID, 'insured_agent'),
    });
    expectBadgeIdentityAct(retry, 'insured_agent');
  });

});

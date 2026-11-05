import { describe, expect, jest, test } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import {
  AGENT_BADGE_AWARD_OUTBOX_COLLECTION,
  awardBadgeFromOutbox,
  badgeAwardOutboxDocumentId,
  badgeEarnedPeId,
  createPendingBadgeAward,
  reconcileBadgeAwards,
} from './badge-provenance';
import { canonicalAgentPeHash } from './canonical-agent-pe-chain';
import { IDENTITY_ACTS_COLLECTION, validateIdentityAct } from '../meter/identity-acts';
import { METER_RELAY_ACTS_COLLECTION } from '../meter/meter-relay-authored';
import {
  identityPeFixture,
  rehashIdentityAct,
  replaceIdentityActMetadata,
} from './__test-helpers__/identity-pe-fixture';

const WALLET_ID = 'wallet_aw_badge0001';
const AGENT_ID = 'badge-agent';
const ADDRESS = `0x${'a'.repeat(40)}`;
const SOURCE_PE_ID = 'pe_badge_qualification_source';

/**
 * The qualifying source PE, stored the way its era stored it: since the PE meter an identity act
 * (`identity_acts_v1`); before it, a pre-meter envelope in `identity_pes_legacy_v1` (the legacy fallback, kept until
 * the migration converts it). Every flow below runs against both.
 */
type SourceStore = 'identity_act' | 'legacy_envelope';
const SOURCE_STORES: readonly SourceStore[] = ['identity_act', 'legacy_envelope'];

function seedQualification(
  fake: ReturnType<typeof createFakeFirestore>,
  now: number,
  sourceStore: SourceStore = 'identity_act',
): string {
  fake.store.set(`agent_wallets/${WALLET_ID}`, {
    id: WALLET_ID,
    agent_id: AGENT_ID,
    address: ADDRESS,
    status: 'active',
    badges: [],
    updated_at: now,
  });
  const canonical = {
    id: SOURCE_PE_ID,
    wallet_id: WALLET_ID,
    agent_id: AGENT_ID,
    action_type: 'agent_linked_to_human',
    actor_address: ADDRESS,
    timestamp: now,
    prev_hash: '0x0000',
    attestation_type: 'software',
    metadata: { qualified_badges: ['linked'] },
    compute: null,
    geo: null,
    execution_env: null,
    cited_pe_ids: null,
    parent_goal_pe_id: null,
  };
  const identity = identityPeFixture({
    id: SOURCE_PE_ID,
    walletId: WALLET_ID,
    agentId: AGENT_ID,
    actorAddress: ADDRESS,
    actionType: 'agent_linked_to_human',
    timestamp: now,
    prevHash: '0x0000',
    metadata: { qualified_badges: ['linked'] },
  });
  const sourceHash = sourceStore === 'identity_act' ? identity.hash : canonicalAgentPeHash(canonical);
  if (sourceStore === 'identity_act') fake.store.set(identity.key, identity.document);
  else fake.store.set(`identity_pes_legacy_v1/${SOURCE_PE_ID}`, {
    ...canonical,
    hash: sourceHash,
    user_id: AGENT_ID,
    policy_action_type: 'agent_linked_to_human',
    integration_source: 'agent_bank_generate_pe',
    counterparty_address: null,
    counterparty_type: null,
    session_lineage: null,
    self_referencing: false,
    trust_level_at_creation: null,
    created_at: now,
    durability: 'final',
  });
  fake.store.set(`pe_chain_tips/${AGENT_ID}`, {
    hash: sourceHash,
    user_id: AGENT_ID,
    updated_at: now,
  });
  const outboxId = badgeAwardOutboxDocumentId(WALLET_ID, 'linked');
  fake.store.set(`${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${outboxId}`, createPendingBadgeAward({
    walletId: WALLET_ID,
    agentId: AGENT_ID,
    actorAddress: ADDRESS,
    badgeId: 'linked',
    trigger: 'link_human',
    earnedAtMs: now,
    sourcePeId: SOURCE_PE_ID,
    sourcePeHash: sourceHash,
  }) as unknown as Record<string, unknown>);
  return sourceHash;
}

function makeDeps(fake: ReturnType<typeof createFakeFirestore>) {
  const enqueue = jest.fn();
  const recordPEAccrual = jest.fn(async () => undefined);
  return {
    deps: {
      db: fake as unknown as Firestore,
      peBuffer: { enqueue },
      recordPEAccrual,
    } as unknown as AgentBankDeps,
    enqueue,
    recordPEAccrual,
  };
}

describe('badge provenance publication', () => {
  test('an unknown wallet lifecycle state blocks a pending publication', async () => {
    const now = Date.now();
    const fake = createFakeFirestore();
    seedQualification(fake, now);
    fake.store.set(`agent_wallets/${WALLET_ID}`, {
      ...fake.store.get(`agent_wallets/${WALLET_ID}`),
      status: 'unknown',
    });

    await expect(awardBadgeFromOutbox(makeDeps(fake).deps, WALLET_ID, 'linked'))
      .rejects.toThrow('badge_provenance_integrity:wallet_binding');
    expect(fake.store.get(`agent_wallets/${WALLET_ID}`)?.badges).toEqual([]);
    expect(fake.store.get(
      `${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${badgeAwardOutboxDocumentId(WALLET_ID, 'linked')}`,
    )).toMatchObject({ state: 'pending', badge_pe_id: null });
  });

  test.each(SOURCE_STORES)('a failed PE transaction leaves the badge private and a retry heals exactly once (source: %s)', async (sourceStore) => {
    const now = Date.now();
    const faulted = createFakeFirestore({ failTxnWriteTo: 'agent_wallets' });
    const sourceHash = seedQualification(faulted, now, sourceStore);
    const faultedDeps = makeDeps(faulted);
    const badgePeId = badgeEarnedPeId(WALLET_ID, 'linked');

    await expect(awardBadgeFromOutbox(faultedDeps.deps, WALLET_ID, 'linked'))
      .rejects.toThrow('Injected transaction write failure');

    expect(faulted.store.get(`agent_wallets/${WALLET_ID}`)?.badges).toEqual([]);
    expect(faulted.store.get(
      `${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${badgeAwardOutboxDocumentId(WALLET_ID, 'linked')}`,
    )).toMatchObject({ state: 'pending', badge_pe_id: null });
    expect(faulted.store.has(`${IDENTITY_ACTS_COLLECTION}/${badgePeId}`)).toBe(false);
    expect(faulted.store.has(`provenance_envelopes/${badgePeId}`)).toBe(false);
    expect(faulted.store.get(`pe_chain_tips/${AGENT_ID}`)?.hash).toBe(sourceHash);

    const retry = createFakeFirestore();
    for (const [key, value] of faulted.store) retry.store.set(key, structuredClone(value));
    const retryDeps = makeDeps(retry);
    const earned = await awardBadgeFromOutbox(retryDeps.deps, WALLET_ID, 'linked');

    expect(earned).toEqual({ id: 'linked', earned_at: now });
    expect(retry.store.get(`agent_wallets/${WALLET_ID}`)?.badges)
      .toEqual([{ id: 'linked', earned_at: now }]);
    const completed = retry.store.get(
      `${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${badgeAwardOutboxDocumentId(WALLET_ID, 'linked')}`,
    );
    expect(completed).toMatchObject({
      state: 'complete',
      badge_pe_id: badgePeId,
      badge_pe_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // PE METER: the badge PE is kept as the identity act the outbox pins (never an envelope),
    // and it re-derives to exactly the pinned hash.
    expect(retry.store.has(`provenance_envelopes/${badgePeId}`)).toBe(false);
    const badgePe = validateIdentityAct({
      raw: retry.store.get(`${IDENTITY_ACTS_COLLECTION}/${badgePeId}`),
      peId: badgePeId,
      peHash: completed?.badge_pe_hash as string,
      actorId: AGENT_ID,
      walletId: WALLET_ID,
    });
    expect(badgePe).toMatchObject({ action_type: 'badge_earned', metadata: { badge_id: 'linked' } });
    // Exactly one act was staged for pricing (no envelope is ever enqueued: the relay keeps no
    // readable PE) and priced once.
    expect(retryDeps.enqueue).not.toHaveBeenCalled();
    expect(retry.store.get(`${METER_RELAY_ACTS_COLLECTION}/${badgePeId}`))
      .toMatchObject({ pe_id: badgePeId, act: { pe_hash: completed?.badge_pe_hash } });
    expect(retryDeps.recordPEAccrual).toHaveBeenCalledTimes(1);

    await expect(awardBadgeFromOutbox(retryDeps.deps, WALLET_ID, 'linked'))
      .resolves.toEqual({ id: 'linked', earned_at: now });
    expect(retryDeps.enqueue).not.toHaveBeenCalled();
    expect(retryDeps.recordPEAccrual).toHaveBeenCalledTimes(1);
    expect((retry.store.get(`agent_wallets/${WALLET_ID}`)?.badges as unknown[])).toHaveLength(1);

    // RED: the qualifying source tampered in place (hash no longer re-derives) is refused.
    const mutated = createFakeFirestore();
    for (const [key, value] of retry.store) mutated.store.set(key, structuredClone(value));
    if (sourceStore === 'identity_act') {
      replaceIdentityActMetadata(
        mutated.store,
        `${IDENTITY_ACTS_COLLECTION}/${SOURCE_PE_ID}`,
        'forged',
        true,
      );
    } else {
      mutated.store.set(`identity_pes_legacy_v1/${SOURCE_PE_ID}`, {
        ...mutated.store.get(`identity_pes_legacy_v1/${SOURCE_PE_ID}`)!,
        metadata: { qualified_badges: ['linked'], forged: true },
      });
    }
    await expect(reconcileBadgeAwards(makeDeps(mutated).deps, WALLET_ID, ['linked']))
      .rejects.toThrow(sourceStore === 'identity_act'
        ? 'canonical_agent_pe_chain_integrity:identity_act_invalid'
        : 'canonical_agent_pe_chain_integrity:pe_hash');

    // RED: a SELF-CONSISTENT replacement under the pinned source id (re-hashed, so only the
    // outbox's hash pin can refuse it). Before the meter this was the "source no longer in the
    // current chain" case; the relay keeps no chain now, so the pin is the binding.
    const replaced = createFakeFirestore();
    for (const [key, value] of retry.store) replaced.store.set(key, structuredClone(value));
    if (sourceStore === 'identity_act') {
      const key = `${IDENTITY_ACTS_COLLECTION}/${SOURCE_PE_ID}`;
      replaceIdentityActMetadata(replaced.store, key, 'qualified_badges', ['linked', 'signal']);
      expect(rehashIdentityAct(replaced.store, key)).not.toBe(sourceHash);
      await expect(reconcileBadgeAwards(makeDeps(replaced).deps, WALLET_ID, ['linked']))
        .rejects.toThrow('canonical_agent_pe_chain_integrity:identity_act_invalid');
    } else {
      const orphanCanonical = {
        id: SOURCE_PE_ID,
        wallet_id: WALLET_ID,
        agent_id: AGENT_ID,
        action_type: 'agent_linked_to_human',
        actor_address: ADDRESS,
        timestamp: now,
        prev_hash: '0x0000',
        attestation_type: 'software',
        metadata: { qualified_badges: ['linked', 'signal'] },
        compute: null,
        geo: null,
        execution_env: null,
        cited_pe_ids: null,
        parent_goal_pe_id: null,
      };
      const orphanHash = canonicalAgentPeHash(orphanCanonical);
      expect(orphanHash).not.toBe(sourceHash);
      replaced.store.set(`identity_pes_legacy_v1/${SOURCE_PE_ID}`, {
        ...replaced.store.get(`identity_pes_legacy_v1/${SOURCE_PE_ID}`)!,
        ...orphanCanonical,
        hash: orphanHash,
      });
      await expect(reconcileBadgeAwards(makeDeps(replaced).deps, WALLET_ID, ['linked']))
        .rejects.toThrow('canonical_agent_pe_chain_integrity:source_not_in_chain');
    }

    // RED: the badge PE's identity act deleted after publication — a complete outbox whose
    // badge PE is gone is refused, never re-published.
    const orphaned = createFakeFirestore();
    for (const [key, value] of retry.store) orphaned.store.set(key, structuredClone(value));
    expect(orphaned.store.delete(`${IDENTITY_ACTS_COLLECTION}/${badgePeId}`)).toBe(true);
    await expect(reconcileBadgeAwards(makeDeps(orphaned).deps, WALLET_ID, ['linked']))
      .rejects.toThrow('canonical_agent_pe_chain_integrity:identity_pe_missing');
  });
});

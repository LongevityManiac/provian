/**
 * a badge qualified before a key rotation survives it. A REAL agent wallet (created through
 * the route) is rotated through the REAL rotation transition (`rotated-agent` fixture), so the
 * badge check binds to the exact sealed graph production writes. The prior address binds the
 * outbox only through the sealed lineage (birth PE pinned by the registration index + each sealed
 * `agent_key_rotated` PE); nothing an agent credential can write (`chain_addresses`) enters it.
 *
 * RED CONTROL RECORD (pre-fix source): both GREEN cases threw `badge_provenance_integrity:wallet_binding`.
 */
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('./proof-of-possession', () => ({
  ...(jest.requireActual('./proof-of-possession') as object),
  verifyAndConsumePopChallenge: async (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: { registration_id: string; agent_id: string },
  ) => ({
    ok: true as const,
    registration_context: { ...expected, credential_recovery_generation: challengeId === 'challenge-1' ? null : 0 },
  }),
  verifyAndConsumeClaimsPopChallenge: async () => ({ ok: true as const, claims: {} }),
}));

import {
  AGENT_BADGE_AWARD_OUTBOX_COLLECTION,
  awardBadgeFromOutbox,
  badgeAwardOutboxDocumentId,
  createPendingBadgeAward,
  reconcileBadgeAwards,
} from './badge-provenance';
import { identityPeFixture } from './__test-helpers__/identity-pe-fixture';
import { IDENTITY_ACTS_COLLECTION } from '../meter/identity-acts';
import {
  AGENT_ID,
  BIRTH_ADDRESS,
  SIGNER_ONE,
  SIGNER_TWO,
  agentBankDeps,
  buildAgentRoute,
  createAgentWallet,
  rotateAgent,
  type FakeDb,
} from '../pvt/__test-helpers__/rotated-agent';

const STRANGER = `0x${'d'.repeat(40)}`;
const SOURCE_PE_ID = 'pe_badge_rotation_source';

/** A `linked` award qualified at the BIRTH address, pending (as `createPendingBadgeAward` seals it). */
function seedPendingAward(fake: FakeDb, walletId: string, actorAddress = BIRTH_ADDRESS): number {
  const earnedAt = Date.now();
  const tip = fake.store.get(`pe_chain_tips/${AGENT_ID}`) as { hash: string };
  const source = identityPeFixture({
    id: SOURCE_PE_ID,
    walletId,
    agentId: AGENT_ID,
    actorAddress: BIRTH_ADDRESS,
    actionType: 'agent_linked_to_human',
    timestamp: earnedAt,
    prevHash: tip.hash,
    metadata: { qualified_badges: ['linked'] },
  });
  fake.store.set(source.key, source.document);
  fake.store.set(`pe_chain_tips/${AGENT_ID}`, { ...tip, hash: source.hash, updated_at: earnedAt });
  fake.store.set(`${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${badgeAwardOutboxDocumentId(walletId, 'linked')}`,
    createPendingBadgeAward({
      walletId,
      agentId: AGENT_ID,
      actorAddress,
      badgeId: 'linked',
      trigger: 'link_human',
      earnedAtMs: earnedAt,
      sourcePeId: SOURCE_PE_ID,
      sourcePeHash: source.hash,
    }) as unknown as Record<string, unknown>);
  return earnedAt;
}

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });

/** Two real rotations, each at real (strictly later) time: birth -> SIGNER_ONE -> SIGNER_TWO. */
async function rotatedTwice(fake: FakeDb, walletId: string): Promise<void> {
  await tick();
  await rotateAgent(fake, walletId, SIGNER_ONE, { now: Date.now(), head: 500 });
  await tick();
  await rotateAgent(fake, walletId, SIGNER_TWO, { now: Date.now(), head: 800 });
}

async function freshAgent() {
  const { app, fake } = buildAgentRoute();
  const walletId = await createAgentWallet(app);
  await tick();
  return { fake, walletId, deps: agentBankDeps(fake) };
}

describe('a badge qualified before a key rotation', () => {
  test('GREEN: a completed award survives two real rotations (award and reconcile both succeed)', async () => {
    const { fake, walletId, deps } = await freshAgent();
    const earnedAt = seedPendingAward(fake, walletId);
    await expect(awardBadgeFromOutbox(deps, walletId, 'linked')).resolves.toEqual({ id: 'linked', earned_at: earnedAt });
    await rotatedTwice(fake, walletId);
    expect((fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>).address).toBe(SIGNER_TWO.address);
    await expect(awardBadgeFromOutbox(deps, walletId, 'linked')).resolves.toEqual({ id: 'linked', earned_at: earnedAt });
    // The real wallet also holds its creation badges; every one of them reconciles after the rotations.
    await expect(reconcileBadgeAwards(deps, walletId)).resolves.toContainEqual({ id: 'linked', earned_at: earnedAt });
  });

  test('GREEN: an award still pending at the rotation publishes under its qualifying address', async () => {
    const { fake, walletId, deps } = await freshAgent();
    const earnedAt = seedPendingAward(fake, walletId);
    await rotatedTwice(fake, walletId);
    await expect(awardBadgeFromOutbox(deps, walletId, 'linked')).resolves.toEqual({ id: 'linked', earned_at: earnedAt });
    expect(fake.store.get(`${AGENT_BADGE_AWARD_OUTBOX_COLLECTION}/${badgeAwardOutboxDocumentId(walletId, 'linked')}`))
      .toMatchObject({ state: 'complete', actor_address: BIRTH_ADDRESS });
  });

  test("GREEN (the negative control): chain_addresses overwritten or absent does not matter — it is not the proof", async () => {
    const { fake, walletId, deps } = await freshAgent();
    const earnedAt = seedPendingAward(fake, walletId);
    await awardBadgeFromOutbox(deps, walletId, 'linked');
    await rotatedTwice(fake, walletId);
    const key = `agent_wallets/${walletId}`;
    fake.store.set(key, { ...(fake.store.get(key) as Record<string, unknown>), chain_addresses: { evm: SIGNER_TWO.address, solana: 'x' } });
    await expect(awardBadgeFromOutbox(deps, walletId, 'linked')).resolves.toEqual({ id: 'linked', earned_at: earnedAt });
    const { chain_addresses: _gone, ...without } = fake.store.get(key) as Record<string, unknown>;
    fake.store.set(key, without);
    await expect(awardBadgeFromOutbox(deps, walletId, 'linked')).resolves.toEqual({ id: 'linked', earned_at: earnedAt });
  });

  test('RED: an outbox bound to an address the wallet never held fails wallet_binding', async () => {
    const { fake, walletId, deps } = await freshAgent();
    seedPendingAward(fake, walletId, STRANGER);
    await rotatedTwice(fake, walletId);
    await expect(awardBadgeFromOutbox(deps, walletId, 'linked'))
      .rejects.toThrow('badge_provenance_integrity:wallet_binding');
    expect((fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>).badges)
      .not.toContainEqual(expect.objectContaining({ id: 'linked' }));
  });

  test('RED: a rotation whose sealed PE is gone does not prove the prior address', async () => {
    const { fake, walletId, deps } = await freshAgent();
    seedPendingAward(fake, walletId);
    await awardBadgeFromOutbox(deps, walletId, 'linked');
    await rotatedTwice(fake, walletId);
    const rotationAct = [...fake.store.entries()].find(([k, v]) => k.startsWith(`${IDENTITY_ACTS_COLLECTION}/`)
      && ((v as Record<string, unknown>).act as Record<string, unknown>).action_type === 'agent_key_rotated');
    expect(rotationAct).toBeDefined();
    fake.store.delete(rotationAct![0]);
    await expect(awardBadgeFromOutbox(deps, walletId, 'linked'))
      .rejects.toThrow('badge_provenance_integrity:address_lineage:rotation_pe_not_in_chain');
  });

  test('RED: an unrotated wallet whose address changed is refused', async () => {
    const { fake, walletId, deps } = await freshAgent();
    seedPendingAward(fake, walletId);
    await awardBadgeFromOutbox(deps, walletId, 'linked');
    const key = `agent_wallets/${walletId}`;
    fake.store.set(key, { ...(fake.store.get(key) as Record<string, unknown>), address: SIGNER_ONE.address });
    await expect(awardBadgeFromOutbox(deps, walletId, 'linked')).rejects.toThrow('badge_provenance_integrity:');
  });
});

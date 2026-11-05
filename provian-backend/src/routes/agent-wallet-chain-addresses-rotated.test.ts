/**
 * / `POST /v1/agent/wallet/:wallet_id/chain-addresses` on a ROTATED wallet. A REAL
 * agent wallet (route-created) rotated through the REAL rotation transition reports its addresses
 * through the REAL route. After a rotation, `chain_addresses.evm` is the BIRTH address the
 * beneficiary relationship's lineage check reads; the report carries the CURRENT address.
 *
 * RED CONTROL RECORD (pre-fix route, which stored the validated bundle): the stored evm became the
 * current address, which before made `readValidatedBeneficiaryRelationship` throw
 * `beneficiary_relationship_integrity:rotation_history_lineage` the incident on Atlas.
 * the negative control (route write reverted to `chain_addresses: validated`) fails the first case.
 * Since the lineage no longer reads `chain_addresses` at all (second case).
 */
import { describe, expect, jest, test } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';

jest.mock('../core/agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../core/agent-wallet/proof-of-possession') as object),
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

// Agent API auth stands in for the real key check: it authenticates the wallet the path names, read
// live from the same store, exactly the document the real middleware sets on `req.agentWallet`.
const authStore: { fake: { store: Map<string, unknown> } | null } = { fake: null };
jest.mock('./middleware/agent-auth', () => ({
  createAgentAuthMiddleware: () => (
    req: { params: { wallet_id?: string }; path: string; agentWallet?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    const id = req.params.wallet_id ?? req.path.split('/')[1];
    req.agentWallet = authStore.fake?.store.get(`agent_wallets/${id}`);
    next();
  },
}));

import request from 'supertest';
import { readValidatedBeneficiaryRelationship } from '../core/agent-wallet/beneficiary-relationship';
import {
  BIRTH_ADDRESS,
  SIGNER_ONE,
  buildAgentRoute,
  createAgentWallet,
  rotateAgent,
} from '../core/pvt/__test-helpers__/rotated-agent';

const SOLANA = '4Jxy9nbNxjsNnwrEyGePnXkVrGJWmPQKeLccL3zuR2K2';
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });

async function rotatedAgent() {
  const { app, fake } = buildAgentRoute();
  authStore.fake = fake;
  const walletId = await createAgentWallet(app);
  const key = `agent_wallets/${walletId}`;
  // As stored when the creating SDK reports its chain addresses : evm = the birth address.
  fake.store.set(key, { ...(fake.store.get(key) as Record<string, unknown>), chain_addresses: { evm: BIRTH_ADDRESS, solana: 'old' } });
  await tick();
  await rotateAgent(fake, walletId, SIGNER_ONE, { now: Date.now(), head: 500 });
  const db = fake as unknown as Firestore;
  const relationship = async () => readValidatedBeneficiaryRelationship({
    db,
    wallet: fake.store.get(key) as Record<string, unknown>,
  });
  return { app, fake, walletId, key, relationship };
}

describe('chain-address report on a rotated wallet', () => {
  test('the report refreshes solana, keeps the birth evm, and the beneficiary lineage still validates', async () => {
    const { app, fake, walletId, key, relationship } = await rotatedAgent();
    await expect(relationship()).resolves.toBeDefined();

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/chain-addresses`)
      .send({ chain_addresses: { evm: SIGNER_ONE.address, solana: SOLANA } });
    expect(res.status).toBe(200);
    expect(res.body.chain_addresses).toEqual({ evm: BIRTH_ADDRESS, solana: SOLANA });
    expect((fake.store.get(key) as Record<string, unknown>).chain_addresses).toEqual({ evm: BIRTH_ADDRESS, solana: SOLANA });
    await expect(relationship()).resolves.toBeDefined();
  });

  test('even an overwritten evm no longer breaks the lineage (it is proven from sealed PEs)', async () => {
    const { fake, key, relationship } = await rotatedAgent();
    fake.store.set(key, { ...(fake.store.get(key) as Record<string, unknown>), chain_addresses: { evm: SIGNER_ONE.address, solana: SOLANA } });
    await expect(relationship()).resolves.toBeDefined();
  });

  test('a report whose evm is not the wallet address is still refused', async () => {
    const { app, walletId } = await rotatedAgent();
    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/chain-addresses`)
      .send({ chain_addresses: { evm: BIRTH_ADDRESS, solana: SOLANA } });
    expect(res.status).toBe(400);
  });
});

/**
 * the linked human links a third-party wallet to their agent.
 *
 * POST /v1/agent/wallet/:wallet_id/external-address/challenge
 * POST /v1/agent/wallet/:wallet_id/external-address/verify
 * GET /v1/agent/wallet/:wallet_id/external-addresses
 *
 * The success path runs the REAL challenge store and the REAL proveExternalAddress; only
 * the chain reads are injected, and the signature check is a real EIP-191 recovery over
 * the exact message the challenge route returned, signed by a real third-party key.
 * Every guard ships with a RED control.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { ethers } from 'ethers';

jest.mock('./middleware/wallet-auth', () => ({
  ...(jest.requireActual('./middleware/wallet-auth') as object),
  verifyWalletAuthToken: async (token: string) => (token.startsWith('human:')
    ? { ok: true, userId: token.slice('human:'.length), deviceId: 'dev_1' }
    : { ok: false, status: 401, error: 'invalid_wallet_auth' }),
}));

import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { PROVEN_ADDRESSES_COLLECTION, type ProofChainDeps } from '../core/external-address';
import { createHumanExternalAddressRouter } from './human-external-address';

const HUMAN = 'human_user_1';
const OTHER = 'human_user_2';
const AGENT_WALLET = 'wallet_aw_1';
const AGENT_ID = 'agent-1';
const AGENT_NATIVE = '0x1111111111111111111111111111111111111111';
const HUMAN_PROVIAN = '0x2222222222222222222222222222222222222222';
const MOUNT = '/v1/agent/wallet';

// A real third-party wallet (the human's MetaMask, say) — its key signs the proof.
const thirdParty = ethers.Wallet.createRandom();

function chain(): ProofChainDeps {
  return {
    getProofFence: async () => ({
      schemaVersion: 'external-proof-fence/v1',
      chainId: 8453,
      observedHeadBlock: 5_000,
      proofBlockNumber: 4_989,
      proofBlockHash: `0x${'ab'.repeat(32)}`,
      provenAtBlock: 5_001,
      minActivityConfirmations: 12,
      rpcOperatorIds: ['operator-a', 'operator-b'],
    }),
    getTransactionCount: async () => 3,
    revalidateProofFence: async () => {},
    // Real EIP-191 recovery over the exact server-stored message.
    verifySignature: async ({ address, message, signature }) => {
      try {
        return ethers.verifyMessage(message, signature).toLowerCase() === address.toLowerCase()
          ? { ok: true, method: 'eip191_eoa' }
          : { ok: false, reason: 'signature_invalid' };
      } catch {
        return { ok: false, reason: 'signature_invalid' };
      }
    },
  } as ProofChainDeps;
}

function build(opts: { wallet?: Record<string, unknown>; rateLimited?: boolean } = {}) {
  const fake = createFakeFirestore();
  const store = new Map<string, unknown>();
  const rl = jest.fn(async () => (opts.rateLimited
    ? { allowed: false, current: 21, limit: 20, retryAfter: 60 }
    : { allowed: true, current: 1, limit: 20 }));
  const cache = {
    isEnabled: () => true,
    async set(key: string, value: unknown) { store.set(key, value); },
    async setNx(key: string, value: unknown) {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    },
    async get<T>(key: string) { return store.has(key) ? (store.get(key) as T) : null; },
    async del(key: string) { store.delete(key); },
    checkRateLimitStrict: rl,
  };
  const deps = {
    db: fake as unknown as Firestore,
    cache,
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(async () => undefined),
  } as unknown as AgentBankDeps;
  const seed = async () => {
    await fake.collection('agent_wallets').doc(AGENT_WALLET).set({
      id: AGENT_WALLET, agent_id: AGENT_ID, display_name: 'Atlas', address: AGENT_NATIVE,
      status: 'active', linked_human_user_id: HUMAN, linked_human_wallet_id: 'hw_1',
      linked_human_address: HUMAN_PROVIAN,
      ...(opts.wallet ?? {}),
    });
    await fake.collection('wallets').doc('hw_1').set({
      user_id: HUMAN, type: 'human', address: HUMAN_PROVIAN,
    });
  };
  const app = express();
  app.use(express.json());
  app.use(MOUNT, createHumanExternalAddressRouter(deps, { proofChainDeps: chain() }));
  return { app, fake, seed, rl, deps };
}

const post = (app: express.Express, path: string, auth: string | null, body: unknown) => {
  const r = request(app).post(`${MOUNT}${path}`);
  return (auth ? r.set('Authorization', auth) : r).send(body as object);
};
const humanAuth = (u = HUMAN) => `Bearer human:${u}`;

describe('human-initiated external-address link', () => {
  it('success: challenge bound to the AGENT, third-party wallet signs the exact message, verify links it, list shows it', async () => {
    const { app, fake, seed } = build();
    await seed();
    const ch = await post(app, `/${AGENT_WALLET}/external-address/challenge`, humanAuth(), { address: thirdParty.address });
    expect(ch.status).toBe(200);
    expect(ch.body.message).toContain('Provian proof of control');
    expect(ch.body.message).toContain(`agent: ${AGENT_ID}`);
    expect(ch.body.message).toContain(`address: ${thirdParty.address.toLowerCase()}`);
    expect(ch.body).toMatchObject({ chain: 'base', chain_id: 8453, wallet_id: AGENT_WALLET });

    const signature = await thirdParty.signMessage(ch.body.message);
    const v = await post(app, `/${AGENT_WALLET}/external-address/verify`, humanAuth(), {
      address: thirdParty.address, challenge_id: ch.body.challenge_id, signature,
    });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({
      ok: true, proven_address: thirdParty.address.toLowerCase(), proven_at_block: 5_001,
      proof_method: 'eip191_eoa', initiated_by: 'linked_human', wallet_id: AGENT_WALLET,
    });
    const rec = await fake.collection(PROVEN_ADDRESSES_COLLECTION).doc(thirdParty.address.toLowerCase()).get();
    expect(rec.exists).toBe(true);
    expect(rec.data()).toMatchObject({ agent_id: AGENT_ID, wallet_id: AGENT_WALLET });

    const list = await request(app).get(`${MOUNT}/${AGENT_WALLET}/external-addresses`).set('Authorization', humanAuth());
    expect(list.status).toBe(200);
    expect(list.body.addresses).toEqual([
      expect.objectContaining({ address: thirdParty.address.toLowerCase(), proven_at_block: 5_001, proof_method: 'eip191_eoa' }),
    ]);

    // The challenge is single-use: replaying the same signature fails.
    const replay = await post(app, `/${AGENT_WALLET}/external-address/verify`, humanAuth(), {
      address: thirdParty.address, challenge_id: ch.body.challenge_id, signature,
    });
    expect(replay.status).toBe(400);
  });

  it('RED: a signature from a DIFFERENT key over the exact message does not link', async () => {
    const { app, fake, seed } = build();
    await seed();
    const ch = await post(app, `/${AGENT_WALLET}/external-address/challenge`, humanAuth(), { address: thirdParty.address });
    const impostor = ethers.Wallet.createRandom();
    const v = await post(app, `/${AGENT_WALLET}/external-address/verify`, humanAuth(), {
      address: thirdParty.address, challenge_id: ch.body.challenge_id, signature: await impostor.signMessage(ch.body.message),
    });
    expect(v.status).toBe(400);
    expect(v.body.error).toBe('signature_invalid');
    expect((await fake.collection(PROVEN_ADDRESSES_COLLECTION).doc(thirdParty.address.toLowerCase()).get()).exists).toBe(false);
  });

  it('RED: a DIFFERENT human → 403 not_your_linked_agent on challenge, verify and list', async () => {
    const { app, seed } = build();
    await seed();
    const ch = await post(app, `/${AGENT_WALLET}/external-address/challenge`, humanAuth(OTHER), { address: thirdParty.address });
    expect(ch.status).toBe(403);
    expect(ch.body.error).toBe('not_your_linked_agent');
    const v = await post(app, `/${AGENT_WALLET}/external-address/verify`, humanAuth(OTHER), {
      address: thirdParty.address, challenge_id: '00000000-0000-4000-8000-000000000000', signature: '0xab',
    });
    expect(v.status).toBe(403);
    const list = await request(app).get(`${MOUNT}/${AGENT_WALLET}/external-addresses`).set('Authorization', humanAuth(OTHER));
    expect(list.status).toBe(403);
  });

  it('RED: an unlinked agent → 403; an unknown wallet id → the same 403', async () => {
    const { app, seed } = build({ wallet: { linked_human_user_id: null } });
    await seed();
    expect((await post(app, `/${AGENT_WALLET}/external-address/challenge`, humanAuth(), { address: thirdParty.address })).status).toBe(403);
    expect((await post(app, '/wallet_aw_nope/external-address/challenge', humanAuth(), { address: thirdParty.address })).status).toBe(403);
  });

  it('RED: no wallet auth → 401; the agent API key is not wallet auth → 401', async () => {
    const { app, seed } = build();
    await seed();
    expect((await post(app, `/${AGENT_WALLET}/external-address/challenge`, null, { address: thirdParty.address })).status).toBe(401);
    expect((await post(app, `/${AGENT_WALLET}/external-address/challenge`, 'Bearer pvn_live_x:pvns_y', { address: thirdParty.address })).status).toBe(401);
  });

  it('RED: an inactive agent → 409 agent_not_active', async () => {
    const { app, seed } = build({ wallet: { status: 'suspended' } });
    await seed();
    const res = await post(app, `/${AGENT_WALLET}/external-address/challenge`, humanAuth(), { address: thirdParty.address });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('agent_not_active');
  });

  it('RED: the human\'s own Provian wallet address → 409 address_is_your_provian_wallet (any case), no challenge issued', async () => {
    const { app, seed, rl } = build();
    await seed();
    for (const addr of [HUMAN_PROVIAN, ethers.getAddress(HUMAN_PROVIAN)]) {
      const res = await post(app, `/${AGENT_WALLET}/external-address/challenge`, humanAuth(), { address: addr });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('address_is_your_provian_wallet');
    }
    // Refused before the transport limit is even consumed.
    expect(rl).not.toHaveBeenCalled();
  });

  it('RED: the agent\'s own native address → 409 address_is_agent_native_wallet on challenge AND verify', async () => {
    const { app, seed } = build();
    await seed();
    const ch = await post(app, `/${AGENT_WALLET}/external-address/challenge`, humanAuth(), { address: AGENT_NATIVE });
    expect(ch.status).toBe(409);
    expect(ch.body.error).toBe('address_is_agent_native_wallet');
    const v = await post(app, `/${AGENT_WALLET}/external-address/verify`, humanAuth(), {
      address: AGENT_NATIVE, challenge_id: '00000000-0000-4000-8000-000000000000', signature: '0xab',
    });
    expect(v.status).toBe(409);
    expect(v.body.error).toBe('address_is_agent_native_wallet');
  });

  it('RED: an invalid address → 400', async () => {
    const { app, seed } = build();
    await seed();
    const res = await post(app, `/${AGENT_WALLET}/external-address/challenge`, humanAuth(), { address: '0xnot' });
    expect(res.status).toBe(400);
  });

  it('RED: over the per-human transport limit → 429', async () => {
    const { app, seed } = build({ rateLimited: true });
    await seed();
    const res = await post(app, `/${AGENT_WALLET}/external-address/challenge`, humanAuth(), { address: thirdParty.address });
    expect(res.status).toBe(429);
  });

  it('RED: an address already proven for ANOTHER agent → 409 (one address, one agent carries over)', async () => {
    const { app, fake, seed } = build();
    await seed();
    await fake.collection('agent_wallets').doc('wallet_aw_2').set({
      id: 'wallet_aw_2', agent_id: 'agent-2', display_name: 'Other', address: '0x3333333333333333333333333333333333333333',
      status: 'active', linked_human_user_id: HUMAN, linked_human_wallet_id: 'hw_1', linked_human_address: HUMAN_PROVIAN,
    });
    const link = async (walletId: string) => {
      const ch = await post(app, `/${walletId}/external-address/challenge`, humanAuth(), { address: thirdParty.address });
      return post(app, `/${walletId}/external-address/verify`, humanAuth(), {
        address: thirdParty.address, challenge_id: ch.body.challenge_id, signature: await thirdParty.signMessage(ch.body.message),
      });
    };
    expect((await link(AGENT_WALLET)).status).toBe(200);
    const second = await link('wallet_aw_2');
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('address_bound_to_other_agent');
  });
});

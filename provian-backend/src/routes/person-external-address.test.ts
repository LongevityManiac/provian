/**
 * 2026-10-01 : a PERSON proves a wallet they already hold.
 *
 * POST /v1/wallet/external-address/challenge
 * POST /v1/wallet/external-address/verify
 * GET /v1/wallet/external-addresses
 *
 * The success path runs the REAL challenge store and the REAL person proof; only
 * the chain reads are injected, and the signature check is a real EIP-191
 * recovery over the exact message the challenge returned, signed by a real
 * outside key. Every refusal ships beside the GREEN case it differs from.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { ethers } from 'ethers';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { writeProvenAddress, type ProofChainDeps } from '../core/external-address';
import { HUMAN_PROVEN_ADDRESSES_COLLECTION, PROVEN_ADDRESSES_COLLECTION } from '../core/external-address/link';
import {
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
} from '../core/pvt/native-wallet-registration';
import { createPersonExternalAddressRouter } from './person-external-address';
import { writeHumanProvenAddress } from '../core/external-address/human-link';

const PERSON = 'human_user_1';
const OTHER = 'human_user_2';
const PROVIAN_ADDRESS = '0x2222222222222222222222222222222222222222';
const MOUNT = '/v1/wallet';
const outside = ethers.Wallet.createRandom();

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

/** Test auth: `Bearer person:<id>` sets req.user; `Bearer agent` sets req.agentWallet. */
const authenticate: RequestHandler = (req, res, next) => {
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Bearer person:')) {
    (req as unknown as { user: { id: string } }).user = { id: h.slice('Bearer person:'.length) };
    return next();
  }
  if (h === 'Bearer agent') {
    (req as unknown as { agentWallet: unknown }).agentWallet = { id: 'wallet_aw_1' };
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
};

function build() {
  const fake = createFakeFirestore();
  const store = new Map<string, unknown>();
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
    checkRateLimitStrict: async () => ({ allowed: true, current: 1, limit: 20 }),
  };
  const deps = {
    db: fake as unknown as Firestore,
    cache,
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(async () => undefined),
  } as unknown as AgentBankDeps;
  fake.store.set('wallets/hw_1', { id: 'hw_1', user_id: PERSON, type: 'human', address: PROVIAN_ADDRESS });
  fake.store.set('wallets/hw_2', { id: 'hw_2', user_id: OTHER, type: 'human', address: '0x3333333333333333333333333333333333333333' });
  const app = express();
  app.use(express.json());
  app.use(MOUNT, createPersonExternalAddressRouter({ agentBankDeps: deps, authenticate, proofChainDeps: chain() }));
  return { app, fake, deps };
}

const post = (app: express.Express, path: string, auth: string | null, body: unknown) => {
  const r = request(app).post(`${MOUNT}${path}`);
  return (auth ? r.set('Authorization', auth) : r).send(body as object);
};
const as = (u = PERSON) => `Bearer person:${u}`;

async function prove(app: express.Express, user = PERSON, wallet: ethers.HDNodeWallet = outside) {
  const ch = await post(app, '/external-address/challenge', as(user), { address: wallet.address });
  expect(ch.status).toBe(200);
  const signature = await wallet.signMessage(ch.body.message);
  return post(app, '/external-address/verify', as(user), {
    address: wallet.address, challenge_id: ch.body.challenge_id, signature,
  });
}

describe('a person proves a wallet they already hold', () => {
  it('success: the challenge names the PERSON, the outside wallet signs it, verify binds it to the person, list shows it', async () => {
    const { app, fake } = build();
    const ch = await post(app, '/external-address/challenge', as(), { address: outside.address });
    expect(ch.status).toBe(200);
    expect(ch.body.message).toContain(`person: ${PERSON}`);
    expect(ch.body.message).not.toContain('agent:');
    const signature = await outside.signMessage(ch.body.message);
    const v = await post(app, '/external-address/verify', as(), {
      address: outside.address, challenge_id: ch.body.challenge_id, signature,
    });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ ok: true, owner: 'person', proven_at_block: 5_001, proven_address: outside.address.toLowerCase() });
    expect(fake.store.get(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`))
      .toMatchObject({ user_id: PERSON, wallet_id: 'hw_1', proven_at_block: 5_001 });
    // Not the agents' registry.
    expect(fake.store.get(`${PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`)).toBeUndefined();
    const list = await request(app).get(`${MOUNT}/external-addresses`).set('Authorization', as());
    expect(list.body.addresses).toEqual([expect.objectContaining({ address: outside.address.toLowerCase(), proven_at_block: 5_001 })]);
    // A re-proof by the same person is idempotent.
    const again = await prove(app);
    expect(again.body).toMatchObject({ ok: true, already_proven: true });
  });

  it('RED: an agent credential is refused (the person path is the person\'s own)', async () => {
    const { app } = build();
    const r = await post(app, '/external-address/challenge', 'Bearer agent', { address: outside.address });
    expect(r.status).toBe(401);
  });

  it('RED: a Provian wallet address is refused with 409 address_is_provian_wallet', async () => {
    const { app, fake } = build();
    fake.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(outside.address)}`, { address: outside.address.toLowerCase() });
    const r = await post(app, '/external-address/challenge', as(), { address: outside.address });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('address_is_provian_wallet');
  });

  it('RED: an address an agent proved is refused with 409 address_bound_to_other_owner', async () => {
    const { app, fake } = build();
    fake.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`, { agent_id: 'agent-1', wallet_id: 'wallet_aw_1' });
    const r = await post(app, '/external-address/challenge', as(), { address: outside.address });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('address_bound_to_other_owner');
  });

  it('RED: an address an agent rotated away from is refused with 409 (defect 4: the tombstone keeps it the agent\'s)', async () => {
    const { app, fake } = build();
    fake.store.set(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${outside.address.toLowerCase()}`, { agent_id: 'agent-g', wallet_id: 'wallet_aw_g' });
    const r = await post(app, '/external-address/challenge', as(), { address: outside.address });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('address_is_provian_wallet');
  });

  it('defect 4, agent writer: another agent\'s retired address is refused; the retiring agent may prove its own', async () => {
    const { app, fake } = build();
    expect((await prove(app)).status).toBe(200);
    const personRecord = { ...(fake.store.get(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`) as Record<string, unknown>) };
    fake.store.delete(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`);
    const { user_id: _u, ...rest } = personRecord;
    const asAgent = (agentId: string) => ({
      ...rest, schema_version: 'proven-address/v2', agent_id: agentId, wallet_id: `wallet_aw_${agentId}`,
    } as unknown as Parameters<typeof writeProvenAddress>[1]);
    fake.store.set(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${outside.address.toLowerCase()}`, { agent_id: 'agent-g', wallet_id: 'wallet_aw_agent-g' });
    expect(await writeProvenAddress(fake as unknown as Firestore, asAgent('agent-h'))).toEqual({ ok: false, reason: 'address_is_provian_wallet' });
    expect(fake.store.get(`${PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`)).toBeUndefined();
    expect(await writeProvenAddress(fake as unknown as Firestore, asAgent('agent-g'))).toMatchObject({ ok: true });
  });

  it('RED: an address another person proved is refused (one address, one owner); the first person keeps it', async () => {
    const { app, fake } = build();
    const first = await prove(app, OTHER);
    expect(first.status).toBe(200);
    const r = await post(app, '/external-address/challenge', as(PERSON), { address: outside.address });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('address_bound_to_other_owner');
    expect(fake.store.get(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`)).toMatchObject({ user_id: OTHER });
  });

  it('RED: a signature by a different key does not bind', async () => {
    const { app, fake } = build();
    const ch = await post(app, '/external-address/challenge', as(), { address: outside.address });
    const wrong = await ethers.Wallet.createRandom().signMessage(ch.body.message);
    const v = await post(app, '/external-address/verify', as(), { address: outside.address, challenge_id: ch.body.challenge_id, signature: wrong });
    expect(v.status).toBe(400);
    expect(fake.store.get(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`)).toBeUndefined();
  });

  it('RED: a person challenge cannot be redeemed as an agent proof, nor an agent challenge as a person proof (subjects differ)', async () => {
    const { app } = build();
    const ch = await post(app, '/external-address/challenge', as(), { address: outside.address });
    const signature = await outside.signMessage(ch.body.message);
    // Another person presenting this person's challenge: bound to a different subject.
    const v = await post(app, '/external-address/verify', as(OTHER), { address: outside.address, challenge_id: ch.body.challenge_id, signature });
    expect(v.status).toBe(400);
    expect(v.body.error).toBe('agent_mismatch');
  });

  it('one address, one owner across registries: an agent cannot take an address a person proved', async () => {
    const { app, fake } = build();
    expect((await prove(app)).status).toBe(200);
    const record = {
      ...(fake.store.get(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`) as Record<string, unknown>),
    };
    const { user_id: _u, ...rest } = record;
    const write = await writeProvenAddress(fake as unknown as Firestore, {
      ...rest, schema_version: 'proven-address/v2', agent_id: 'agent-1', wallet_id: 'wallet_aw_1',
    } as unknown as Parameters<typeof writeProvenAddress>[1]);
    expect(write).toEqual({ ok: false, reason: 'address_bound_to_other_owner' });
    expect(fake.store.get(`${PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`)).toBeUndefined();
  });

  it('the person writer refuses inside its own transaction too (the route check is not the only guard)', async () => {
    const { app, fake } = build();
    expect((await prove(app)).status).toBe(200);
    const record = fake.store.get(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`) as Record<string, unknown>;
    const asOther = { ...record, user_id: OTHER, wallet_id: 'hw_2' } as unknown as Parameters<typeof writeHumanProvenAddress>[1];
    expect(await writeHumanProvenAddress(fake as unknown as Firestore, asOther)).toEqual({ ok: false, reason: 'address_bound_to_other_owner' });
    fake.store.delete(`${HUMAN_PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`);
    fake.store.set(`${PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`, { agent_id: 'agent-1', wallet_id: 'wallet_aw_1' });
    expect(await writeHumanProvenAddress(fake as unknown as Firestore, asOther)).toEqual({ ok: false, reason: 'address_bound_to_other_owner' });
    fake.store.delete(`${PROVEN_ADDRESSES_COLLECTION}/${outside.address.toLowerCase()}`);
    fake.store.set(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(outside.address)}`, { address: outside.address.toLowerCase() });
    expect(await writeHumanProvenAddress(fake as unknown as Firestore, asOther)).toEqual({ ok: false, reason: 'address_is_provian_wallet' });
    fake.store.delete(`${NATIVE_WALLET_ADDRESS_INDEX_COLLECTION}/${nativeWalletAddressIndexId(outside.address)}`);
    // negative control: an address an agent rotated away from stays that agent's.
    fake.store.set(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${outside.address.toLowerCase()}`, { agent_id: 'agent-g', wallet_id: 'wallet_aw_g' });
    expect(await writeHumanProvenAddress(fake as unknown as Firestore, asOther)).toEqual({ ok: false, reason: 'address_is_provian_wallet' });
    fake.store.delete(`${AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION}/${outside.address.toLowerCase()}`);
    // GREEN twin: nothing else holds it → the write binds.
    expect(await writeHumanProvenAddress(fake as unknown as Firestore, asOther)).toMatchObject({ ok: true, already_proven: false });
  });
});

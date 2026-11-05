import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'crypto';
import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import request from 'supertest';
import { ethers } from 'ethers';

type RegistrationContext = {
  registration_id: string;
  agent_id: string;
  credential_recovery_generation: number | null;
};

const verifyPop = jest.fn(async (
  _challengeId: string,
  expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
) => ({
  ok: true as const,
  registration_context: {
    ...expected,
    credential_recovery_generation: null,
  },
}));

jest.mock('../core/agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../core/agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: (
    _cache: unknown,
    challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: Pick<RegistrationContext, 'registration_id' | 'agent_id'>,
  ) => verifyPop(challengeId, expected),
}));

const authCacheGet = jest.fn<(...args: unknown[]) => Promise<unknown>>(async () => null);
const authCacheSet = jest.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const authCacheDel = jest.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
jest.mock('../cache', () => ({
  cache: {
    get: (...args: unknown[]) => authCacheGet(...args),
    set: (...args: unknown[]) => authCacheSet(...args),
    del: (...args: unknown[]) => authCacheDel(...args),
  },
}));

import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import {
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
} from '../core/pvt/watcher-address-admission';
import { AGENT_RECOVERY_ESCROW_COLLECTION } from '../core/agent-recovery-escrow';
import type { RouterDeps } from '../core/agent-wallet/types';
import { IDENTITY_ACTS_COLLECTION, validateIdentityAct } from '../core/meter/identity-acts';
import { createAgentWalletRouter } from './agent-wallet';

const b64u = (b: Buffer): string => b.toString('base64url');
const validSealedBlob = (): string => b64u(Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(64)]));
const validAnchorPubkey = (): string => b64u(crypto.randomBytes(32));

function generateKeyPair(): {
  privateKey: string;
  publicKey: string;
  address: string;
} {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.generateKeys();
  const privateKey = ecdh.getPrivateKey('hex');
  const publicKey = ecdh.getPublicKey('hex').slice(2);
  return {
    privateKey,
    publicKey,
    address: ethers.computeAddress(`0x04${publicKey}`).toLowerCase(),
  };
}

function signMessage(privateKeyHex: string, message: string): string {
  const privateKey = Buffer.from(privateKeyHex, 'hex');
  const curveOid = Buffer.from('06052b8104000a', 'hex');
  const privateKeyOctet = Buffer.concat([
    Buffer.from([0x04, privateKey.length]),
    privateKey,
  ]);
  const wrappedOid = Buffer.concat([
    Buffer.from([0xa0, curveOid.length]),
    curveOid,
  ]);
  const version = Buffer.from([0x02, 0x01, 0x01]);
  const innerLength = version.length + privateKeyOctet.length + wrappedOid.length;
  const sec1 = Buffer.concat([
    Buffer.from([0x30, innerLength]),
    version,
    privateKeyOctet,
    wrappedOid,
  ]);
  const signer = crypto.createSign('SHA256');
  signer.update(message);
  return signer.sign(crypto.createPrivateKey({ key: sec1, format: 'der', type: 'sec1' }), 'hex');
}

function buildRoute() {
  const fake = createFakeFirestore();
  fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
    chain_id: 8453,
    last_processed_block: 130,
    membership_generation: 7,
    updated_at: 1,
  });
  const routeCacheDel = jest.fn(async () => undefined);
  const readBaseRegistrationHead = jest.fn(async () => 140);
  const deriveAddressFromPublicKey = jest.fn((publicKey: string) => (
    ethers.computeAddress(`0x04${publicKey}`).toLowerCase()
  ));
  const recordPEAccrual = jest.fn(async () => undefined);
  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
      get: async () => null,
      set: async () => undefined,
      del: routeCacheDel,
    },
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual,
    keccak256: (input: Buffer) => input,
    deriveAddressFromPublicKey,
    readBaseRegistrationHead,
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return {
    app,
    fake,
    routeCacheDel,
    readBaseRegistrationHead,
    deriveAddressFromPublicKey,
    recordPEAccrual,
  };
}

let AGENT_SEQ = 0;
async function createWallet(app: express.Express, publicKey: string) {
  AGENT_SEQ += 1;
  const created = await request(app).post('/v1/agent/wallet/create').send({
    registration_id: `agent-registration-rotation-${String(AGENT_SEQ).padStart(4, '0')}`,
    agent_name: 'Rotation Agent',
    agent_id: `rotation-agent-${AGENT_SEQ}`,
    platform: 'sdk',
    constitution_accepted_at: '2026-07-12T00:00:00.000Z',
    public_key: publicKey,
    challenge_id: 'challenge-create',
    signature: 'ab'.repeat(64),
  });
  return created;
}

function proofs(walletId: string, oldKey: ReturnType<typeof generateKeyPair>,
  newKey: ReturnType<typeof generateKeyPair>, timestamp: number) {
  return {
    new_address: newKey.address,
    new_public_key: newKey.publicKey,
    // Canonical: proofs sign over LOWERCASED addresses (generateKeyPair already
    // lowercases). Old key signs the NEW address; new key signs the OLD address.
    proof_of_old_key: signMessage(oldKey.privateKey, `rotate:${walletId}:${newKey.address}:${timestamp}`),
    proof_of_new_key: signMessage(newKey.privateKey, `rotate:${walletId}:${oldKey.address}:${timestamp}`),
    timestamp,
  };
}

describe('agent wallet key rotation (activation re-enabled)', () => {
  beforeEach(() => {
    verifyPop.mockClear();
    authCacheGet.mockClear();
    authCacheSet.mockClear();
    authCacheDel.mockClear();
  });

  test('valid dual-key proofs rotate the full identity end-to-end (200)', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const { app, fake, routeCacheDel, readBaseRegistrationHead } = buildRoute();
    const created = await createWallet(app, oldKey.publicKey);
    expect(created.status).toBe(201);
    expect(created.body.address).toBe(oldKey.address);
    const walletId = created.body.wallet_id as string;
    const oldPrefix = String(created.body.api_key).slice(0, 24);

    // The rotation observes a fresh (higher) two-operator head → H+1 = 501.
    readBaseRegistrationHead.mockResolvedValue(500);
    const timestamp = Date.now();
    const response = await request(app)
      .post(`/v1/agent/wallet/${walletId}/rotate-key`)
      .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
      .send(proofs(walletId, oldKey, newKey, timestamp));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      wallet_id: walletId,
      old_address: oldKey.address,
      new_address: newKey.address,
    });
    expect(response.body.api_key).toBeTruthy();
    expect(response.body.api_secret).toBeTruthy();
    expect(response.body.api_key).not.toBe(created.body.api_key);

    // Wallet identity cut to the NEW address with the fresh H+1 fence.
    const wallet = fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>;
    expect(wallet.address).toBe(newKey.address);
    expect(wallet.public_key).toBe(newKey.publicKey);
    expect(wallet.rotation_count).toBe(1);
    expect((wallet.native_watcher_registration as { eligibility_start_block: number })
      .eligibility_start_block).toBe(501);
    // rotation_history sealed with a NON-NULL pe_id.
    const historyKeys = [...fake.store.keys()].filter((k) => k.includes('/rotation_history/'));
    expect(historyKeys).toHaveLength(1);
    expect((fake.store.get(historyKeys[0]) as Record<string, unknown>).pe_id).toBeTruthy();
    // agent_key_rotated PE sealed — PE METER: as the identity act the history entry pins (the
    // relay keeps no envelope), its hash re-deriving to exactly the pinned hash.
    const history = fake.store.get(historyKeys[0]) as Record<string, unknown>;
    expect(fake.store.has(`provenance_envelopes/${String(history.pe_id)}`)).toBe(false);
    const rotationPe = validateIdentityAct({
      raw: fake.store.get(`${IDENTITY_ACTS_COLLECTION}/${String(history.pe_id)}`),
      peId: history.pe_id as string,
      peHash: history.pe_hash as string,
      actorId: wallet.agent_id as string,
      walletId,
    });
    expect(rotationPe.action_type).toBe('agent_key_rotated');
    expect(rotationPe.actor_address).toBe(newKey.address);
    // Old address retired; new api prefix live, old prefix gone.
    expect(fake.store.has(`agent_wallet_address_retirements_v1/${oldKey.address}`)).toBe(true);
    expect(fake.store.has(`api_key_index/${String(response.body.api_key).slice(0, 24)}`)).toBe(true);
    expect(fake.store.has(`api_key_index/${oldPrefix}`)).toBe(false);
    expect(routeCacheDel).toHaveBeenCalled();
  });

  test('rejects an invalid old-key proof before any identity write (401)', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const { app, fake } = buildRoute();
    const created = await createWallet(app, oldKey.publicKey);
    const walletId = created.body.wallet_id as string;
    const timestamp = Date.now();
    const body = proofs(walletId, oldKey, newKey, timestamp);
    // Corrupt the old-key proof (sign with the NEW key instead).
    body.proof_of_old_key = signMessage(newKey.privateKey, `rotate:${walletId}:${newKey.address}:${timestamp}`);
    const before = structuredClone([...fake.store.entries()]);
    const response = await request(app)
      .post(`/v1/agent/wallet/${walletId}/rotate-key`)
      .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
      .send(body);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('proof_of_old_key verification failed');
    expect([...fake.store.entries()]).toEqual(before);
  });

  test('rejects an invalid new-key proof before any identity write (401)', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const { app, fake } = buildRoute();
    const created = await createWallet(app, oldKey.publicKey);
    const walletId = created.body.wallet_id as string;
    const timestamp = Date.now();
    const body = proofs(walletId, oldKey, newKey, timestamp);
    // Corrupt the new-key proof (sign with the OLD key instead).
    body.proof_of_new_key = signMessage(oldKey.privateKey, `rotate:${walletId}:${oldKey.address}:${timestamp}`);
    const before = structuredClone([...fake.store.entries()]);
    const response = await request(app)
      .post(`/v1/agent/wallet/${walletId}/rotate-key`)
      .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
      .send(body);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('proof_of_new_key verification failed');
    expect([...fake.store.entries()]).toEqual(before);
  });

  test('rejects rotating to the same address (400)', async () => {
    const oldKey = generateKeyPair();
    const { app } = buildRoute();
    const created = await createWallet(app, oldKey.publicKey);
    const walletId = created.body.wallet_id as string;
    const timestamp = Date.now();
    const response = await request(app)
      .post(`/v1/agent/wallet/${walletId}/rotate-key`)
      .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
      .send(proofs(walletId, oldKey, oldKey, timestamp));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/differ from current address/);
  });

  test('enforces the 1-per-24h rate limit on a second rotation (429)', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const thirdKey = generateKeyPair();
    const { app, readBaseRegistrationHead } = buildRoute();
    const created = await createWallet(app, oldKey.publicKey);
    const walletId = created.body.wallet_id as string;
    readBaseRegistrationHead.mockResolvedValue(500);
    // First rotation succeeds.
    const first = await request(app)
      .post(`/v1/agent/wallet/${walletId}/rotate-key`)
      .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
      .send(proofs(walletId, oldKey, newKey, Date.now()));
    expect(first.status).toBe(200);
    // Second rotation (authenticated with the NEW credentials) is rate limited.
    readBaseRegistrationHead.mockResolvedValue(600);
    const second = await request(app)
      .post(`/v1/agent/wallet/${walletId}/rotate-key`)
      .set('Authorization', `Bearer ${first.body.api_key}:${first.body.api_secret}`)
      .send(proofs(walletId, newKey, thirdKey, Date.now()));
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/rate limit/i);
    expect(typeof second.body.retry_after).toBe('number');
  });

  test('a rotation RE-ESCROWS the new key atomically when escrow material is supplied', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const { app, fake, readBaseRegistrationHead } = buildRoute();
    const created = await createWallet(app, oldKey.publicKey);
    const walletId = created.body.wallet_id as string;
    readBaseRegistrationHead.mockResolvedValue(500);
    const blob = validSealedBlob();
    const anchor = validAnchorPubkey();
    // The agent's existing escrow names the anchor (the SDK rotateKey re-seals to it).
    fake.store.set(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${walletId}`, {
      wallet_id: walletId, sealed_key_blob: validSealedBlob(), recovery_anchor_pubkey: anchor,
    });
    const response = await request(app)
      .post(`/v1/agent/wallet/${walletId}/rotate-key`)
      .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
      .send({ ...proofs(walletId, oldKey, newKey, Date.now()), sealed_key_blob: blob, recovery_anchor_pubkey: anchor });
    expect(response.status).toBe(200);
    // The escrow was written IN the same transaction — present with the new blob.
    const escrow = fake.store.get(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${walletId}`) as Record<string, unknown>;
    expect(escrow).toBeTruthy();
    expect(escrow.sealed_key_blob).toBe(blob);
    expect(escrow.recovery_anchor_pubkey).toBe(anchor);
  });

  test('RED CONTROL (gate hardening): a rotation cannot MOVE the escrow to a self-chosen anchor (403), no write', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const { app, fake, readBaseRegistrationHead } = buildRoute();
    const created = await createWallet(app, oldKey.publicKey);
    const walletId = created.body.wallet_id as string;
    readBaseRegistrationHead.mockResolvedValue(500);
    fake.store.set(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${walletId}`, {
      wallet_id: walletId, sealed_key_blob: validSealedBlob(), recovery_anchor_pubkey: validAnchorPubkey(),
    });
    const before = structuredClone([...fake.store.entries()]);
    const ownKey = 'K'.repeat(43);
    expect(ownKey).not.toBe(validAnchorPubkey());
    const response = await request(app)
      .post(`/v1/agent/wallet/${walletId}/rotate-key`)
      .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
      .send({ ...proofs(walletId, oldKey, newKey, Date.now()), sealed_key_blob: validSealedBlob(), recovery_anchor_pubkey: ownKey });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('recovery_anchor_not_recognized');
    expect([...fake.store.entries()]).toEqual(before);
  });

  test('a rotation that would ORPHAN an existing escrow is refused (400), no identity write', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const { app, fake, readBaseRegistrationHead } = buildRoute();
    const created = await createWallet(app, oldKey.publicKey);
    const walletId = created.body.wallet_id as string;
    readBaseRegistrationHead.mockResolvedValue(500);
    // The agent already holds an escrow.
    fake.store.set(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${walletId}`, {
      wallet_id: walletId, sealed_key_blob: validSealedBlob(), recovery_anchor_pubkey: validAnchorPubkey(),
    });
    const before = structuredClone([...fake.store.entries()]);
    // Rotate WITHOUT re-escrow material → must be refused rather than orphan it.
    const response = await request(app)
      .post(`/v1/agent/wallet/${walletId}/rotate-key`)
      .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
      .send(proofs(walletId, oldKey, newKey, Date.now()));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('agent_wallet_rotation_requires_reescrow');
    expect([...fake.store.entries()]).toEqual(before); // no identity write, escrow intact
  });

  test('ownership mismatch is rejected before any identity read (403)', async () => {
    const oldKey = generateKeyPair();
    const { app, fake } = buildRoute();
    const created = await request(app).post('/v1/agent/wallet/create').send({
      registration_id: 'agent-registration-rotation-disabled-0002',
      agent_name: 'Rotation Ownership Agent',
      agent_id: 'rotation-ownership-agent',
      platform: 'sdk',
      constitution_accepted_at: '2026-07-12T00:00:00.000Z',
      public_key: oldKey.publicKey,
      challenge_id: 'challenge-create',
      signature: 'ab'.repeat(64),
    });
    expect(created.status).toBe(201);
    const beforeStore = structuredClone([...fake.store.entries()]);

    const response = await request(app)
      .post('/v1/agent/wallet/wallet_aw_not-owned/rotate-key')
      .set('Authorization', `Bearer ${created.body.api_key}:${created.body.api_secret}`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Access denied - wallet_id mismatch' });
    expect([...fake.store.entries()]).toEqual(beforeStore);
  });
});


describe('durably staged rotation replay', () => {
  test('lost response resumes the same sealed rotation without another identity cut', async () => {
    const oldKey = generateKeyPair(), newKey = generateKeyPair();
    const { app, fake, readBaseRegistrationHead } = buildRoute();
    const created = await createWallet(app, oldKey.publicKey);
    const walletId = created.body.wallet_id as string;
    const rotation_id = `rotation_${crypto.randomUUID()}`;
    const new_api_key = `pvn_live_${crypto.randomBytes(16).toString('hex')}`;
    const new_api_secret = `pvns_${crypto.randomBytes(32).toString('hex')}`;
    const send = (auth: string, id = rotation_id) => {
      const timestamp = Date.now();
      const suffix = `:${id}:${crypto.createHash('sha256').update(`${new_api_key}:${new_api_secret}`).digest('hex')}`;
      return request(app).post(`/v1/agent/wallet/${walletId}/rotate-key`).set('Authorization', `Bearer ${auth}`).send({
        new_address: newKey.address, new_public_key: newKey.publicKey, timestamp,
        rotation_id: id, new_api_key, new_api_secret,
        proof_of_old_key: signMessage(oldKey.privateKey, `rotate:${walletId}:${newKey.address}:${timestamp}${suffix}`),
        proof_of_new_key: signMessage(newKey.privateKey, `rotate:${walletId}:${oldKey.address}:${timestamp}${suffix}`),
      });
    };
    const first = await send(`${created.body.api_key}:${created.body.api_secret}`);
    expect(first.status).toBe(200);
    expect(first.body.api_key).toBe(new_api_key);
    const before = JSON.stringify([...fake.store.entries()]);
    const calls = readBaseRegistrationHead.mock.calls.length;
    const retry = await send(`${new_api_key}:${new_api_secret}`);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(JSON.stringify([...fake.store.entries()])).toBe(before);
    expect(readBaseRegistrationHead.mock.calls.length).toBe(calls);
    expect((fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>).rotation_count).toBe(1);
    expect((await send(`${new_api_key}:${new_api_secret}`, `rotation_${crypto.randomUUID()}`)).status).toBe(409);
    expect((await send(`${created.body.api_key}:${created.body.api_secret}`)).status).toBe(401);
    const collection = fake.collection.bind(fake);
    const failure = jest.spyOn(fake, 'collection').mockImplementation(name => {
      const col = collection(name);
      if (!name.endsWith('/rotation_history')) return col;
      return { ...col, where: (...args: Parameters<typeof col.where>) => {
        const query = col.where(...args);
        return { ...query, limit: (n: number) => ({ ...query.limit(n), get: async () => { throw new Error('fixture Firestore unavailable'); } }) };
      } };
    });
    expect((await send(`${new_api_key}:${new_api_secret}`)).status).toBe(500);
    failure.mockRestore();
    expect((await send(`${new_api_key}:${new_api_secret}`)).status).toBe(200);
    expect(JSON.stringify([...fake.store.entries()])).toBe(before);

  });
});

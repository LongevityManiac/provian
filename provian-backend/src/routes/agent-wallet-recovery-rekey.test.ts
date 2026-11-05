/**
 * POST /:wallet_id/recovery-rekey.
 *
 * Re-key an agent whose OLD key is LOST: the linked human (wallet auth) authorizes
 * the identity swap, the NEW key proves possession, and the new key is escrowed in
 * the same handler so the re-keyed identity is recoverable immediately.
 *
 * Every success assertion ships with its RED negative control (run contract): the
 * new-key PoP, the linked-human check, and the escrow requirement each get a case
 * that flips the ONE decisive input and asserts the request is refused WITHOUT any
 * identity write. The escrow-stored assertion is the fix for the exact defect that
 * stranded Atlas — proven present here, and its absence proven to 400.
 */

import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'crypto';
import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import request from 'supertest';
import { ethers } from 'ethers';

// The recovery re-key is authorized by the LINKED HUMAN's wallet auth. Mock the
// verifier so the test controls the resolved userId (a real v2 HMAC token needs a
// full device registration, which is orthogonal to what this route decides).
const walletAuthUserId = { value: 'human-linked-1' as string, ok: true as boolean };
jest.mock('./middleware/wallet-auth', () => ({
  verifyWalletAuthToken: async () => (
    walletAuthUserId.ok
      ? { ok: true, userId: walletAuthUserId.value }
      : { ok: false, status: 401, error: 'bad token' }
  ),
}));

// Create() needs a passing PoP challenge; keep verifyEcdsaSha256 (the re-key's
// new-key proof) REAL so this suite genuinely exercises the recovery PoP.
jest.mock('../core/agent-wallet/proof-of-possession', () => ({
  ...(jest.requireActual('../core/agent-wallet/proof-of-possession') as object),
  verifyAndConsumePopChallenge: (
    _cache: unknown,
    _challengeId: string,
    _publicKey: string,
    _signature: string,
    expected: { registration_id: string; agent_id: string },
  ) => ({ ok: true as const, registration_context: { ...expected, credential_recovery_generation: null } }),
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
import { INBOUND_WATCHER_CHECKPOINT_COLLECTION } from '../core/pvt/watcher-address-admission';
import { AGENT_RECOVERY_ESCROW_COLLECTION, AGENT_RECOVERY_ALARM_COLLECTION } from '../core/agent-recovery-escrow';
import type { RouterDeps } from '../core/agent-wallet/types';
import { IDENTITY_ACTS_COLLECTION, validateIdentityAct } from '../core/meter/identity-acts';
import { createAgentWalletRouter } from './agent-wallet';

function generateKeyPair(): { privateKey: string; publicKey: string; address: string } {
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.generateKeys();
  const privateKey = ecdh.getPrivateKey('hex');
  const publicKey = ecdh.getPublicKey('hex').slice(2);
  return { privateKey, publicKey, address: ethers.computeAddress(`0x04${publicKey}`).toLowerCase() };
}

function signMessage(privateKeyHex: string, message: string): string {
  const privateKey = Buffer.from(privateKeyHex, 'hex');
  const curveOid = Buffer.from('06052b8104000a', 'hex');
  const privateKeyOctet = Buffer.concat([Buffer.from([0x04, privateKey.length]), privateKey]);
  const wrappedOid = Buffer.concat([Buffer.from([0xa0, curveOid.length]), curveOid]);
  const version = Buffer.from([0x02, 0x01, 0x01]);
  const innerLength = version.length + privateKeyOctet.length + wrappedOid.length;
  const sec1 = Buffer.concat([Buffer.from([0x30, innerLength]), version, privateKeyOctet, wrappedOid]);
  const signer = crypto.createSign('SHA256');
  signer.update(message);
  return signer.sign(crypto.createPrivateKey({ key: sec1, format: 'der', type: 'sec1' }), 'hex');
}

const b64u = (b: Buffer): string => b.toString('base64url');
// A structurally-valid sealed blob: version 0x01 || 32-byte ephemeral || >=17 ciphertext.
const validSealedBlob = (): string => b64u(Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(32 + 32)]));
const validAnchorPubkey = (): string => b64u(crypto.randomBytes(32));

function buildRoute() {
  const fake = createFakeFirestore();
  fake.store.set(`${INBOUND_WATCHER_CHECKPOINT_COLLECTION}/8453`, {
    chain_id: 8453, last_processed_block: 130, membership_generation: 7, updated_at: 1,
  });
  const readBaseRegistrationHead = jest.fn(async () => 140);
  const deps = {
    db: fake as unknown as Firestore,
    cache: { isEnabled: () => true, checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }), get: async () => null, set: async () => undefined, del: jest.fn(async () => undefined) },
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual: jest.fn(async () => undefined),
    keccak256: (input: Buffer) => input,
    deriveAddressFromPublicKey: (publicKey: string) => ethers.computeAddress(`0x04${publicKey}`).toLowerCase(),
    readBaseRegistrationHead,
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return { app, fake, readBaseRegistrationHead };
}

let SEQ = 0;
async function createLinkedWallet(app: express.Express, fake: ReturnType<typeof createFakeFirestore>, publicKey: string) {
  SEQ += 1;
  const created = await request(app).post('/v1/agent/wallet/create').send({
    registration_id: `agent-registration-rekey-${String(SEQ).padStart(4, '0')}`,
    agent_name: 'Rekey Agent', agent_id: `rekey-agent-${SEQ}`, platform: 'sdk',
    constitution_accepted_at: '2026-07-12T00:00:00.000Z', public_key: publicKey,
    challenge_id: 'challenge-create', signature: 'ab'.repeat(64),
  });
  const walletId = created.body.wallet_id as string;
  // Link the agent to the human the mocked wallet auth resolves to.
  const wallet = fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>;
  fake.store.set(`agent_wallets/${walletId}`, { ...wallet, linked_human_user_id: 'human-linked-1' });
  return { created, walletId };
}

function rekeyBody(walletId: string, newKey: ReturnType<typeof generateKeyPair>, timestamp: number) {
  return {
    new_address: newKey.address,
    new_public_key: newKey.publicKey,
    proof_of_new_key: signMessage(newKey.privateKey, `recovery-rekey:${walletId}:${newKey.address}:${timestamp}`),
    timestamp,
    sealed_key_blob: validSealedBlob(),
    recovery_anchor_pubkey: validAnchorPubkey(),
  };
}

describe('POST /:wallet_id/recovery-rekey ', () => {
  beforeEach(() => { walletAuthUserId.value = 'human-linked-1'; walletAuthUserId.ok = true; SEQ += 100; });

  test('linked human + valid new-key PoP re-keys the identity AND escrows the new key (200)', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const { app, fake, readBaseRegistrationHead } = buildRoute();
    const { walletId } = await createLinkedWallet(app, fake, oldKey.publicKey);
    readBaseRegistrationHead.mockResolvedValue(500);

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-rekey`)
      .set('Authorization', 'Bearer human.token')
      .send(rekeyBody(walletId, newKey, Date.now()));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ wallet_id: walletId, old_address: oldKey.address, new_address: newKey.address, recovery_escrowed: true });
    expect(res.body.api_key).toBeTruthy();
    expect(res.body.api_secret).toBeTruthy();
    // Identity cut to the new address.
    const wallet = fake.store.get(`agent_wallets/${walletId}`) as Record<string, unknown>;
    expect(wallet.address).toBe(newKey.address);
    expect(wallet.rotation_count).toBe(1);
    // agent_key_rotated PE sealed (PE chain preserved), identity preserved (same wallet_id).
    // PE METER: the rotation PE is the identity act its rotation_history entry pins.
    const historyKeys = [...fake.store.keys()].filter((k) => k.includes('/rotation_history/'));
    expect(historyKeys).toHaveLength(1);
    const history = fake.store.get(historyKeys[0]) as Record<string, unknown>;
    const rotationPe = validateIdentityAct({
      raw: fake.store.get(`${IDENTITY_ACTS_COLLECTION}/${String(history.pe_id)}`),
      peId: history.pe_id as string,
      peHash: history.pe_hash as string,
      actorId: wallet.agent_id as string,
      walletId,
    });
    expect(rotationPe.action_type).toBe('agent_key_rotated');
    expect(fake.store.has(`provenance_envelopes/${String(history.pe_id)}`)).toBe(false);
    // THE FIX: a recoverable escrow exists for the re-keyed identity.
    const escrow = fake.store.get(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${walletId}`) as Record<string, unknown>;
    expect(escrow).toBeTruthy();
    expect(escrow.wallet_id).toBe(walletId);
    expect(typeof escrow.sealed_key_blob).toBe('string');
  });

  test('RED: an invalid new-key PoP is refused (401) with NO identity write and NO escrow', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const wrongKey = generateKeyPair();
    const { app, fake, readBaseRegistrationHead } = buildRoute();
    const { walletId } = await createLinkedWallet(app, fake, oldKey.publicKey);
    readBaseRegistrationHead.mockResolvedValue(500);
    const body = rekeyBody(walletId, newKey, Date.now());
    // Sign the PoP with a DIFFERENT key than new_public_key claims.
    body.proof_of_new_key = signMessage(wrongKey.privateKey, `recovery-rekey:${walletId}:${newKey.address}:${body.timestamp}`);
    const before = structuredClone([...fake.store.entries()]);
    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-rekey`)
      .set('Authorization', 'Bearer human.token')
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('proof_of_new_key verification failed');
    expect([...fake.store.entries()]).toEqual(before);
  });

  test('RED: a non-linked human is refused (403) before any identity read', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const { app, fake, readBaseRegistrationHead } = buildRoute();
    const { walletId } = await createLinkedWallet(app, fake, oldKey.publicKey);
    readBaseRegistrationHead.mockResolvedValue(500);
    walletAuthUserId.value = 'some-other-human'; // authenticated, but NOT the linked human
    const before = structuredClone([...fake.store.entries()]);
    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-rekey`)
      .set('Authorization', 'Bearer other.token')
      .send(rekeyBody(walletId, newKey, Date.now()));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_your_linked_agent');
    expect([...fake.store.entries()]).toEqual(before);
  });

  test('RED: a missing/invalid sealed_key_blob is refused (400) — a re-key must always escrow', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const { app, fake, readBaseRegistrationHead } = buildRoute();
    const { walletId } = await createLinkedWallet(app, fake, oldKey.publicKey);
    readBaseRegistrationHead.mockResolvedValue(500);
    const body = rekeyBody(walletId, newKey, Date.now());
    (body as { sealed_key_blob: string }).sealed_key_blob = 'not-a-valid-blob!!';
    const before = structuredClone([...fake.store.entries()]);
    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-rekey`)
      .set('Authorization', 'Bearer human.token')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sealed_key_blob/);
    expect([...fake.store.entries()]).toEqual(before);
  });

  test('enforces the 1-per-24h rate limit on a second re-key (429)', async () => {
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();
    const thirdKey = generateKeyPair();
    const { app, fake, readBaseRegistrationHead } = buildRoute();
    const { walletId } = await createLinkedWallet(app, fake, oldKey.publicKey);
    readBaseRegistrationHead.mockResolvedValue(500);
    const first = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-rekey`)
      .set('Authorization', 'Bearer human.token')
      .send(rekeyBody(walletId, newKey, Date.now()));
    expect(first.status).toBe(200);
    readBaseRegistrationHead.mockResolvedValue(600);
    const second = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-rekey`)
      .set('Authorization', 'Bearer human.token')
      .send(rekeyBody(walletId, thirdKey, Date.now()));
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/rate limit/i);
  });
});

describe('POST /:wallet_id/recovery-alarm ', () => {
  test('the agent raises a durable at-rest-secret alarm (200); a bad reason is refused (400, RED control)', async () => {
    const oldKey = generateKeyPair();
    const { app, fake } = buildRoute();
    const { created, walletId } = await createLinkedWallet(app, fake, oldKey.publicKey);
    const auth = `Bearer ${created.body.api_key}:${created.body.api_secret}`;

    const ok = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-alarm`)
      .set('Authorization', auth)
      .send({ reason: 'at_rest_secret_missing', host: 'mini' });
    expect(ok.status).toBe(200);
    const alarm = fake.store.get(`${AGENT_RECOVERY_ALARM_COLLECTION}/${walletId}`) as Record<string, unknown>;
    expect(alarm).toBeTruthy();
    expect(alarm.reason).toBe('at_rest_secret_missing');
    expect(alarm.resolved).toBe(false);

    // RED control: an unknown reason is refused and writes nothing new.
    const bad = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-alarm`)
      .set('Authorization', auth)
      .send({ reason: 'made_up_reason' });
    expect(bad.status).toBe(400);
  });
});

describe('POST /:wallet_id/recovery-alarm/clear ', () => {
  test('the daemon clears its alarm on recovery (resolved:true); clearing when none exists is a 200 no-op (RED control)', async () => {
    const oldKey = generateKeyPair();
    const { app, fake } = buildRoute();
    const { created, walletId } = await createLinkedWallet(app, fake, oldKey.publicKey);
    const auth = `Bearer ${created.body.api_key}:${created.body.api_secret}`;

    // No alarm yet → clear is a benign no-op (cleared:false). RED control: the OLD behavior
    // (no clear route) would 404 here; and if clear wrongly reported cleared:true with no alarm,
    // this assertion fails.
    const noop = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-alarm/clear`)
      .set('Authorization', auth)
      .send({ host: 'mini' });
    expect(noop.status).toBe(200);
    expect(noop.body.cleared).toBe(false);

    // Raise an alarm, then clear it — it must flip resolved:true so the Command Center stops counting it.
    await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-alarm`)
      .set('Authorization', auth)
      .send({ reason: 'at_rest_secret_missing', host: 'mini' });
    let alarm = fake.store.get(`${AGENT_RECOVERY_ALARM_COLLECTION}/${walletId}`) as Record<string, unknown>;
    expect(alarm.resolved).toBe(false);

    const cleared = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-alarm/clear`)
      .set('Authorization', auth)
      .send({ host: 'mini' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toBe(true);
    alarm = fake.store.get(`${AGENT_RECOVERY_ALARM_COLLECTION}/${walletId}`) as Record<string, unknown>;
    expect(alarm.resolved).toBe(true);
    expect(typeof alarm.resolved_at).toBe('number');

    // Idempotent: a second clear on an already-resolved alarm is a no-op (cleared:false).
    const again = await request(app)
      .post(`/v1/agent/wallet/${walletId}/recovery-alarm/clear`)
      .set('Authorization', auth)
      .send({ host: 'mini' });
    expect(again.status).toBe(200);
    expect(again.body.cleared).toBe(false);
  });

  test('RED: another agent cannot clear a wallet\'s alarm (403), and its alarm stays unresolved', async () => {
    const { app, fake } = buildRoute();
    const a = await createLinkedWallet(app, fake, generateKeyPair().publicKey);
    const b = await createLinkedWallet(app, fake, generateKeyPair().publicKey);
    const authA = `Bearer ${a.created.body.api_key}:${a.created.body.api_secret}`;
    const authB = `Bearer ${b.created.body.api_key}:${b.created.body.api_secret}`;

    // Agent A raises its own alarm.
    await request(app).post(`/v1/agent/wallet/${a.walletId}/recovery-alarm`)
      .set('Authorization', authA).send({ reason: 'at_rest_secret_missing' });

    // Agent B (its own valid creds) tries to clear A's alarm → 403 ownership mismatch, alarm untouched.
    const bad = await request(app).post(`/v1/agent/wallet/${a.walletId}/recovery-alarm/clear`)
      .set('Authorization', authB).send({});
    expect(bad.status).toBe(403);
    const alarm = fake.store.get(`${AGENT_RECOVERY_ALARM_COLLECTION}/${a.walletId}`) as Record<string, unknown>;
    expect(alarm.resolved).toBe(false);
  });
});

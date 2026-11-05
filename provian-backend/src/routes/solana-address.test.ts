/**
 * follow-up — prove a SOLANA address (ed25519), for an agent or a person.
 *
 * POST /v1/agent/solana-address/challenge | /verify, GET /v1/agent/solana-addresses
 * POST /v1/wallet/solana-address/challenge | /verify, GET /v1/wallet/solana-addresses
 *
 * Every success runs the REAL challenge store, the REAL ed25519 verification (Node `crypto`) over
 * the exact message the challenge returned, signed by a REAL ed25519 key, and the REAL registry
 * write; only the Solana slot read is injected. Every refusal ships beside the GREEN case it
 * differs from. The record_only / zero-mint property of the proof receipt is proven through the
 * REAL accrual in `core/external-address/solana-proof.acceptance.test.ts`.
 */
import { describe, it, expect, jest } from '@jest/globals';
import crypto from 'crypto';
import { ethers } from 'ethers';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../core/agent-bank/types';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { base58Encode } from '../core/external-address/solana-keys';
import {
  SOLANA_PROOF_MESSAGE_HEADER,
  SOLANA_PROOF_TTL_SECONDS,
  type SolanaProofChainDeps,
} from '../core/external-address/solana-proof';
import { buildProofMessage } from '../core/external-address/challenge';
import { SOLANA_PROVEN_ADDRESSES_COLLECTION, writeSolanaProvenAddress } from '../core/external-address/solana-link';
import { PROVEN_ADDRESSES_COLLECTION } from '../core/external-address/link';
import { FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT } from '../core/pvt/x402-facilitator-settlement';
import { PROVIAN_SOLANA_TREASURY } from '../core/swap/swap-fees';
import { createAgentSolanaAddressRouter, createPersonSolanaAddressRouter } from './solana-address';
import { createPersonExternalAddressRouter } from './person-external-address';

const PERSON = 'human_user_1';
const OTHER = 'human_user_2';
const AGENT = { id: 'wallet_aw_1', agent_id: 'agent-1', address: '0x1111111111111111111111111111111111111111' };
const AGENT_2 = { id: 'wallet_aw_2', agent_id: 'agent-2', address: '0x4444444444444444444444444444444444444444' };
const PERSON_EVM = '0x2222222222222222222222222222222222222222';
const SLOT = 300_123_456;

interface SolanaKey { readonly address: string; readonly sign: (message: string) => string }

function solanaKey(): SolanaKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    address: base58Encode(Buffer.from(jwk.x, 'base64url')),
    sign: (message) => base58Encode(crypto.sign(null, Buffer.from(message, 'utf8'), privateKey)),
  };
}

/** Test auth: `Bearer person:<id>` sets req.user; `Bearer agent:<n>` sets req.agentWallet. */
const authenticate: RequestHandler = (req, res, next) => {
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Bearer person:')) {
    (req as unknown as { user: { id: string } }).user = { id: h.slice('Bearer person:'.length) };
    return next();
  }
  if (h === 'Bearer agent:1' || h === 'Bearer agent:2') {
    (req as unknown as { agentWallet: unknown }).agentWallet = h === 'Bearer agent:1' ? AGENT : AGENT_2;
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
};

function build(opts: { slot?: () => Promise<number> } = {}) {
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
  const recordPEAccrual = jest.fn(async () => undefined);
  const deps = {
    db: fake as unknown as Firestore,
    cache,
    peBuffer: { enqueue: jest.fn() },
    recordPEAccrual,
  } as unknown as AgentBankDeps;
  fake.store.set('wallets/hw_1', { id: 'hw_1', user_id: PERSON, type: 'human', address: PERSON_EVM });
  fake.store.set('wallets/hw_2', { id: 'hw_2', user_id: OTHER, type: 'human', address: '0x3333333333333333333333333333333333333333' });
  const slotReads = { count: 0 };
  const chain: SolanaProofChainDeps = {
    getHeadSlot: opts.slot ?? (async () => { slotReads.count += 1; return SLOT; }),
  };
  const app = express();
  app.use(express.json());
  app.use('/v1/wallet', createPersonSolanaAddressRouter({ agentBankDeps: deps, authenticate, solanaProofChainDeps: chain, env: {} }));
  app.use('/v1/agent', createAgentSolanaAddressRouter(deps, { authenticateAgent: authenticate, solanaProofChainDeps: chain, env: {} }));
  return { app, fake, deps, store, recordPEAccrual, slotReads };
}

type App = express.Express;
const post = (app: App, path: string, auth: string | null, body: unknown) => {
  const r = request(app).post(path);
  return (auth ? r.set('Authorization', auth) : r).send(body as object);
};
const PERSON_AUTH = (u = PERSON) => `Bearer person:${u}`;
const AGENT_AUTH = (n: 1 | 2 = 1) => `Bearer agent:${n}`;
const base = (who: 'agent' | 'person') => (who === 'agent' ? '/v1/agent' : '/v1/wallet');
const authFor = (who: 'agent' | 'person') => (who === 'agent' ? AGENT_AUTH() : PERSON_AUTH());

async function challenge(app: App, who: 'agent' | 'person', address: string, auth = authFor(who)) {
  return post(app, `${base(who)}/solana-address/challenge`, auth, { address });
}

async function verify(app: App, who: 'agent' | 'person', body: Record<string, unknown>, auth = authFor(who)) {
  return post(app, `${base(who)}/solana-address/verify`, auth, body);
}

async function prove(app: App, who: 'agent' | 'person', key: SolanaKey, extra: Record<string, unknown> = {}, auth = authFor(who)) {
  const ch = await challenge(app, who, key.address, auth);
  expect(ch.status).toBe(200);
  return verify(app, who, { address: key.address, challenge_id: ch.body.challenge_id, signature: key.sign(ch.body.message), ...extra }, auth);
}

describe.each(['agent', 'person'] as const)('%s proves a Solana address', (who) => {
  it('GREEN: the challenge names the subject in the exact canonical format; a real ed25519 signature binds it', async () => {
    const { app, fake, recordPEAccrual } = build();
    const key = solanaKey();
    const ch = await challenge(app, who, key.address);
    expect(ch.status).toBe(200);
    const lines = (ch.body.message as string).split('\n');
    expect(lines).toEqual([
      SOLANA_PROOF_MESSAGE_HEADER,
      who === 'agent' ? `agent: ${AGENT.agent_id}` : `person: ${PERSON}`,
      `address: ${key.address}`,
      `nonce: ${ch.body.nonce}`,
      `issued: ${new Date(ch.body.issued_at).toISOString()}`,
      `expires: ${new Date(ch.body.expires_at).toISOString()}`,
    ]);
    expect(ch.body.message.endsWith('\n')).toBe(false);
    expect(ch.body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(ch.body.expires_at - ch.body.issued_at).toBe(SOLANA_PROOF_TTL_SECONDS * 1000);
    expect(ch.body).toMatchObject({ address: key.address, chain: 'solana' });

    const v = await verify(app, who, { address: key.address, challenge_id: ch.body.challenge_id, signature: key.sign(ch.body.message), origin: 'native' });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({
      ok: true, proven_address: key.address, proven_at_slot: SLOT, origin: 'native', proof_method: 'ed25519', already_proven: false,
    });
    expect(typeof v.body.pe_id).toBe('string');
    if (who === 'person') expect(v.body.owner).toBe('person');
    expect(fake.store.get(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${key.address}`)).toMatchObject(who === 'agent'
      ? { owner_type: 'agent', agent_id: AGENT.agent_id, user_id: null, wallet_id: AGENT.id, owner_evm_address: AGENT.address, proven_at_slot: SLOT, origin: 'native' }
      : { owner_type: 'human', user_id: PERSON, agent_id: null, wallet_id: 'hw_1', owner_evm_address: PERSON_EVM, proven_at_slot: SLOT, origin: 'native' });
    // The receipt went through the canonical emitter: `external_address_proven`, on the owner's chain.
    expect(recordPEAccrual).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'external_address_proven',
      userId: who === 'agent' ? AGENT.agent_id : PERSON,
    }));

    const list = await request(app).get(`${base(who)}/solana-addresses`).set('Authorization', authFor(who));
    expect(list.status).toBe(200);
    expect(list.body.addresses).toEqual([expect.objectContaining({ address: key.address, proven_at_slot: SLOT, origin: 'native' })]);
  });

  it('origin defaults to external; a re-proof by the SAME owner is idempotent (fence and origin preserved)', async () => {
    const { app } = build();
    const key = solanaKey();
    const first = await prove(app, who, key);
    expect(first.body).toMatchObject({ ok: true, origin: 'external', already_proven: false });
    const again = await prove(app, who, key, { origin: 'native' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, already_proven: true, origin: 'external', proven_at_slot: SLOT });
  });

  it('RED: a signature by a DIFFERENT key → 401, nothing bound, and the nonce is NOT burned (the right key then succeeds)', async () => {
    const { app, fake } = build();
    const key = solanaKey();
    const ch = await challenge(app, who, key.address);
    const wrong = await verify(app, who, { address: key.address, challenge_id: ch.body.challenge_id, signature: solanaKey().sign(ch.body.message) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('signature_invalid');
    expect(fake.store.get(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${key.address}`)).toBeUndefined();
    const right = await verify(app, who, { address: key.address, challenge_id: ch.body.challenge_id, signature: key.sign(ch.body.message) });
    expect(right.status).toBe(200);
  });

  it('RED: a consumed challenge cannot be replayed', async () => {
    const { app } = build();
    const key = solanaKey();
    const ch = await challenge(app, who, key.address);
    const signature = key.sign(ch.body.message);
    expect((await verify(app, who, { address: key.address, challenge_id: ch.body.challenge_id, signature })).status).toBe(200);
    const replay = await verify(app, who, { address: key.address, challenge_id: ch.body.challenge_id, signature });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('challenge_not_found');
  });

  it('RED: an expired challenge is refused', async () => {
    const { app } = build();
    const key = solanaKey();
    const ch = await challenge(app, who, key.address);
    const signature = key.sign(ch.body.message);
    const now = jest.spyOn(Date, 'now').mockReturnValue(ch.body.expires_at);
    try {
      const v = await verify(app, who, { address: key.address, challenge_id: ch.body.challenge_id, signature });
      expect(v.status).toBe(400);
      expect(v.body.error).toBe('challenge_expired');
    } finally {
      now.mockRestore();
    }
  });

  it('RED: the challenge is bound to its ADDRESS — redeeming it for another address is refused', async () => {
    const { app } = build();
    const key = solanaKey();
    const other = solanaKey();
    const ch = await challenge(app, who, key.address);
    const v = await verify(app, who, { address: other.address, challenge_id: ch.body.challenge_id, signature: other.sign(ch.body.message) });
    expect(v.status).toBe(400);
    expect(v.body.error).toBe('address_mismatch');
  });

  it('RED: the EVM proof message signed instead of the Solana one is refused (domain separation)', async () => {
    const { app } = build();
    const key = solanaKey();
    const ch = await challenge(app, who, key.address);
    const subject = who === 'agent' ? AGENT.agent_id : `person:${PERSON}`;
    const evmMessage = buildProofMessage({
      agentId: subject,
      address: key.address,
      nonce: ch.body.nonce,
      issuedIso: new Date(ch.body.issued_at).toISOString(),
      expiresIso: new Date(ch.body.expires_at).toISOString(),
    });
    expect(evmMessage).not.toBe(ch.body.message);
    const v = await verify(app, who, { address: key.address, challenge_id: ch.body.challenge_id, signature: key.sign(evmMessage) });
    expect(v.status).toBe(401);
    expect(v.body.error).toBe('signature_invalid');
  });

  it('RED: the Solana slot unreadable → 503 head_slot_unavailable, nothing bound, nonce not burned', async () => {
    let up = false;
    const { app, fake } = build({ slot: async () => { if (!up) throw new Error('rpc down'); return SLOT; } });
    const key = solanaKey();
    const ch = await challenge(app, who, key.address);
    const body = { address: key.address, challenge_id: ch.body.challenge_id, signature: key.sign(ch.body.message) };
    const down = await verify(app, who, body);
    expect(down.status).toBe(503);
    expect(down.body.error).toBe('head_slot_unavailable');
    expect(fake.store.get(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${key.address}`)).toBeUndefined();
    up = true;
    expect((await verify(app, who, body)).status).toBe(200);
  });

  it.each([FACILITATOR_SOLANA_GAS_ADDRESS_DEFAULT, PROVIAN_SOLANA_TREASURY])('RED: Provian service wallet %s → 409 address_is_provian_service_wallet', async (address) => {
    const { app } = build();
    const ch = await challenge(app, who, address);
    expect(ch.status).toBe(409);
    expect(ch.body.error).toBe('address_is_provian_service_wallet');
  });

  it('RED: malformed input is refused before anything is issued', async () => {
    const { app } = build();
    expect((await challenge(app, who, '0x1111111111111111111111111111111111111111')).status).toBe(400);
    expect((await challenge(app, who, 'not base58 0OIl')).status).toBe(400);
    const key = solanaKey();
    const ch = await challenge(app, who, key.address);
    const bad = await verify(app, who, { address: key.address, challenge_id: ch.body.challenge_id, signature: key.sign(ch.body.message), origin: 'mine' });
    expect(bad.status).toBe(400);
  });
});

describe('one Solana address, one owner — across agents and people', () => {
  it('RED: an address an AGENT proved is refused to a PERSON (409), at challenge and inside the binding transaction', async () => {
    const { app, fake } = build();
    const key = solanaKey();
    expect((await prove(app, 'agent', key)).status).toBe(200);
    const r = await challenge(app, 'person', key.address);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('address_bound_to_other_owner');
    // The writer refuses on its own, too (the route check is not the only guard).
    const agentRecord = fake.store.get(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${key.address}`) as Record<string, unknown>;
    const asPerson = { ...agentRecord, owner_type: 'human', agent_id: null, user_id: PERSON, wallet_id: 'hw_1' };
    expect(await writeSolanaProvenAddress(fake as unknown as Firestore, asPerson as never, {}))
      .toEqual({ ok: false, reason: 'address_bound_to_other_owner' });
    expect(fake.store.get(`${SOLANA_PROVEN_ADDRESSES_COLLECTION}/${key.address}`)).toMatchObject({ agent_id: AGENT.agent_id });
  });

  it('RED: another agent cannot take it; another person cannot take a person\'s', async () => {
    const { app } = build();
    const a = solanaKey();
    expect((await prove(app, 'agent', a)).status).toBe(200);
    const r = await challenge(app, 'agent', a.address, AGENT_AUTH(2));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('address_bound_to_other_owner');
    const p = solanaKey();
    expect((await prove(app, 'person', p)).status).toBe(200);
    const q = await challenge(app, 'person', p.address, PERSON_AUTH(OTHER));
    expect(q.status).toBe(409);
  });

  it('RED: a challenge issued to one subject cannot be redeemed by another (agent ↔ agent, person ↔ person)', async () => {
    const { app } = build();
    const key = solanaKey();
    const ch = await challenge(app, 'agent', key.address);
    const v = await verify(app, 'agent', { address: key.address, challenge_id: ch.body.challenge_id, signature: key.sign(ch.body.message) }, AGENT_AUTH(2));
    expect(v.status).toBe(400);
    expect(v.body.error).toBe('agent_mismatch');
    const pc = await challenge(app, 'person', key.address);
    const pv = await verify(app, 'person', { address: key.address, challenge_id: pc.body.challenge_id, signature: key.sign(pc.body.message) }, PERSON_AUTH(OTHER));
    expect(pv.status).toBe(400);
    expect(pv.body.error).toBe('agent_mismatch');
  });

  it('RED: the agent path refuses a person credential and the person path refuses an agent credential', async () => {
    const { app } = build();
    const key = solanaKey();
    expect((await challenge(app, 'agent', key.address, PERSON_AUTH())).status).toBe(401);
    expect((await challenge(app, 'person', key.address, AGENT_AUTH())).status).toBe(401);
    expect((await challenge(app, 'agent', key.address, '')).status).toBe(401);
  });
});

describe('mount order — the Solana routes are reachable beside the EVM proof routes', () => {
  it('server.ts order: the person EVM router mounted first at /v1/wallet does not shadow the Solana routes, and vice versa', async () => {
    const { deps } = build();
    const app = express();
    app.use(express.json());
    // Exactly the server.ts order at /v1/wallet: the person EVM proof, then the person Solana proof,
    // then the agent EVM proof and the agent Solana proof at /v1/agent.
    app.use('/v1/wallet', createPersonExternalAddressRouter({ agentBankDeps: deps, authenticate }));
    app.use('/v1/wallet', createPersonSolanaAddressRouter({ agentBankDeps: deps, authenticate, solanaProofChainDeps: { getHeadSlot: async () => SLOT }, env: {} }));
    app.use('/v1/agent', createAgentSolanaAddressRouter(deps, { authenticateAgent: authenticate, solanaProofChainDeps: { getHeadSlot: async () => SLOT }, env: {} }));
    const key = solanaKey();
    // Reached (200 with a Solana challenge), not 404 and not the EVM router's 400.
    const sol = await post(app, '/v1/wallet/solana-address/challenge', PERSON_AUTH(), { address: key.address });
    expect(sol.status).toBe(200);
    expect(sol.body.message.startsWith(SOLANA_PROOF_MESSAGE_HEADER)).toBe(true);
    const evm = await post(app, '/v1/wallet/external-address/challenge', PERSON_AUTH(), { address: ethers.Wallet.createRandom().address });
    expect(evm.status).toBe(200);
    expect(evm.body.message.startsWith('Provian proof of control')).toBe(true);
    expect((await request(app).get('/v1/wallet/solana-addresses').set('Authorization', PERSON_AUTH())).status).toBe(200);
    // A challenge binds nothing: the agent can still be issued one for the same address.
    expect((await post(app, '/v1/agent/solana-address/challenge', AGENT_AUTH(), { address: key.address })).status).toBe(200);
    // RED control: a path neither router serves is a 404, so the 200s above are real reachability.
    expect((await post(app, '/v1/wallet/solana-address/nope', PERSON_AUTH(), {})).status).toBe(404);
  });
});

describe('the registry never confuses a Solana address with an EVM one', () => {
  it('a Solana proof writes only solana_proven_addresses, never proven_addresses', async () => {
    const { app, fake } = build();
    const key = solanaKey();
    expect((await prove(app, 'agent', key)).status).toBe(200);
    expect([...fake.store.keys()].some((k) => k.startsWith(`${PROVEN_ADDRESSES_COLLECTION}/`))).toBe(false);
  });
});

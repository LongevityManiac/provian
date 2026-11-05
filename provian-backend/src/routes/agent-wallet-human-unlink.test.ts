/**
 * POST /v1/agent/wallet/:wallet_id/human-unlink — the linked human ends the beneficiary link
 * ALONE, under wallet auth (, fact-base fixes item 2).
 *
 * - the linked human (wallet auth; the agent's linked_human_user_id + linked_human_wallet_id
 * name the caller's one canonical human wallet) → 200, the shared unbind helper runs ONCE with
 * endedBy 'linked_human', and a notify-only `beneficiary_link_ended` event targets the agent;
 * - RED: no wallet auth → 401; a DIFFERENT human → 403; an agent's API key (the agent alone) →
 * 401 — there is no agent-alone unlink; an agent not linked to the caller → 403. In every
 * refused case the unbind helper is never called and no event is enqueued.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockUnbind = jest.fn(async (..._args: unknown[]) => ({ peId: 'pe_unlink_1' }));
jest.mock('../core/agent-wallet/link-human-binding', () => ({
  ...(jest.requireActual('../core/agent-wallet/link-human-binding') as object),
  unbindAgentFromHuman: (...args: unknown[]) => mockUnbind(...args),
}));
const mockEnqueue = jest.fn(async (..._args: unknown[]) => 'abe_1');
jest.mock('../core/agent-bank/event-outbox', () => ({
  ...(jest.requireActual('../core/agent-bank/event-outbox') as object),
  enqueueAgentBankEvent: (...args: unknown[]) => mockEnqueue(...args),
}));
// Wallet auth: `Bearer human:<userId>` authenticates <userId>; anything else is refused.
jest.mock('./middleware/wallet-auth', () => ({
  ...(jest.requireActual('./middleware/wallet-auth') as object),
  verifyWalletAuthToken: async (token: string) => (token.startsWith('human:')
    ? { ok: true, userId: token.slice('human:'.length), deviceId: 'dev_1' }
    : { ok: false, status: 401, error: 'invalid_wallet_auth' }),
}));

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key';

import express from 'express';
import request from 'supertest';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { createAgentWalletRouter } from './agent-wallet';
import type { RouterDeps } from '../core/agent-wallet/types';

type Doc = Record<string, unknown>;

function makeFirestore() {
  const collections = new Map<string, Map<string, Doc>>();
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const query = (name: string, filters: Array<[string, unknown]>) => ({
    where: (f: string, _op: string, v: unknown) => query(name, [...filters, [f, v]]),
    limit: (_n: number) => query(name, filters),
    async get() {
      const docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, data: () => d }));
      return { size: docs.length, empty: docs.length === 0, docs };
    },
  });
  const collection = (name: string) => ({
    doc: (id: string) => ({
      async get() {
        const d = col(name).get(id);
        return { exists: d !== undefined, id, data: () => d };
      },
      async set(data: Doc) { col(name).set(id, data); },
      async update(patch: Doc) { col(name).set(id, { ...(col(name).get(id) ?? {}), ...patch }); },
    }),
    where: (f: string, _op: string, v: unknown) => query(name, [[f, v]]),
  });
  return { db: { collection } as unknown as import('firebase-admin/firestore').Firestore, col };
}

function makeDeps(db: import('firebase-admin/firestore').Firestore): RouterDeps {
  return {
    db,
    cache: {
      checkRateLimit: jest.fn(async () => ({ allowed: true, retryAfter: 0 })),
      checkRateLimitStrict: jest.fn(async () => ({ allowed: true, current: 0, limit: 5 })),
      isEnabled: () => true,
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
      del: jest.fn(async () => undefined),
    } as unknown as RouterDeps['cache'],
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '0xderived',
  } as unknown as RouterDeps;
}

const HUMAN_USER = 'human_user_1';
const HUMAN_WALLET = 'human_wallet_1';
const AGENT = 'wallet_aw_1';

function build() {
  const { db, col } = makeFirestore();
  const creds = generateApiCredentials();
  col('agent_wallets').set(AGENT, {
    id: AGENT,
    agent_id: 'agent-1',
    address: '0xAGENTADDR',
    api_key_hash: creds.api_key_hash,
    api_key_salt: creds.api_key_salt,
    api_key_prefix: creds.api_key_prefix,
    status: 'active',
    linked_human_wallet_id: HUMAN_WALLET,
    linked_human_user_id: HUMAN_USER,
    linked_human_address: '0x00000000000000000000000000000000000000aa',
  });
  col('api_key_index').set(creds.api_key_prefix, { wallet_id: AGENT });
  col('wallets').set(HUMAN_WALLET, { id: HUMAN_WALLET, type: 'human', user_id: HUMAN_USER, address: '0x00000000000000000000000000000000000000aa' });
  col('wallets').set('human_wallet_2', { id: 'human_wallet_2', type: 'human', user_id: 'human_user_2', address: '0x00000000000000000000000000000000000000bb' });
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(makeDeps(db)));
  return { app, col, agentBearer: `Bearer ${creds.api_key}:${creds.api_secret}` };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /:wallet_id/human-unlink — the linked human ends the link alone', () => {
  it('the linked human (wallet auth alone) ends the link: unbind runs once with endedBy linked_human; the shared transaction owns the beneficiary_link_ended notice', async () => {
    const { app } = build();
    const res = await request(app).post(`/v1/agent/wallet/${AGENT}/human-unlink`).set('Authorization', `Bearer human:${HUMAN_USER}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ wallet_id: AGENT, linked_human_wallet_id: null, ended_by: 'linked_human', unlink_pe_id: 'pe_unlink_1' });
    expect(mockUnbind).toHaveBeenCalledTimes(1);
    const params = mockUnbind.mock.calls[0][1] as { wallet: { id: string }; endedBy: string };
    expect(params.wallet.id).toBe(AGENT);
    expect(params.endedBy).toBe('linked_human');
    // The real shared-helper suite proves that the notice commits with the unlink.
    // The route must not enqueue a second notice after that transaction.
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('RED: no wallet auth → 401, nothing unbound', async () => {
    const { app } = build();
    const res = await request(app).post(`/v1/agent/wallet/${AGENT}/human-unlink`).send({});
    expect(res.status).toBe(401);
    expect(mockUnbind).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('RED: the AGENT alone (its own API key) cannot use this route — there is no agent-alone unlink', async () => {
    const { app, agentBearer } = build();
    const res = await request(app).post(`/v1/agent/wallet/${AGENT}/human-unlink`).set('Authorization', agentBearer).send({});
    expect(res.status).toBe(401);
    expect(mockUnbind).not.toHaveBeenCalled();
  });

  it('RED: a DIFFERENT human (valid wallet auth) → 403 not_your_linked_agent, nothing unbound', async () => {
    const { app } = build();
    const res = await request(app).post(`/v1/agent/wallet/${AGENT}/human-unlink`).set('Authorization', 'Bearer human:human_user_2').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_your_linked_agent');
    expect(mockUnbind).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('RED: an agent that is not linked (or linked to someone else) → 403; the human wallet id must match too', async () => {
    const { app, col } = build();
    col('agent_wallets').set(AGENT, { ...(col('agent_wallets').get(AGENT) as Doc), linked_human_wallet_id: 'human_wallet_2' });
    const res = await request(app).post(`/v1/agent/wallet/${AGENT}/human-unlink`).set('Authorization', `Bearer human:${HUMAN_USER}`).send({});
    expect(res.status).toBe(403);
    expect(mockUnbind).not.toHaveBeenCalled();
  });

  it('a missing agent wallet → 403 (never reveals whether the id exists)', async () => {
    const { app } = build();
    const res = await request(app).post('/v1/agent/wallet/wallet_aw_nope/human-unlink').set('Authorization', `Bearer human:${HUMAN_USER}`).send({});
    expect(res.status).toBe(403);
    expect(mockUnbind).not.toHaveBeenCalled();
  });
});

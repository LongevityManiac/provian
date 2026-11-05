/**
 * POST /v1/agent/wallet/link-requests/:request_id/decline — the addressed human declines a
 * pending connection-code link request (agent-path close-out, item 4).
 *
 *  - the addressed human (wallet auth; `for_human_user_id` === caller) → 200, the invite doc
 *    flips to `status: 'declined'` + `declined_at`, and GET /link-requests stops returning it
 *    (which is what clears the app's attention bell);
 *  - idempotent: a repeat returns the ORIGINAL declined_at;
 *  - RED: no wallet auth → 401; a DIFFERENT human → 404 (never reveals the request exists);
 *    an unknown id → 404; an email invite with no addressed human → 404; an ACCEPTED request
 *    → 409. In every refused case the doc is untouched.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

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

const HUMAN = 'human_user_1';
const OTHER = 'human_user_2';
const REQ = 'inv_req_1';
const MOUNT = '/v1/agent/wallet';

function build(invite: Doc | null = null) {
  const { db, col } = makeFirestore();
  col('agent_invites').set(REQ, invite ?? {
    id: REQ,
    agent_wallet_id: 'wallet_aw_1',
    agent_display_name: 'Atlas',
    status: 'pending',
    created_at: Date.now() - 1000,
    expires_at: Date.now() + 86_400_000,
    invite_type: 'beneficiary',
    for_human_user_id: HUMAN,
    origin: 'connection_token',
  });
  const app = express();
  app.use(express.json());
  app.use(MOUNT, createAgentWalletRouter(makeDeps(db)));
  return { app, col };
}

const decline = (app: express.Express, auth: string | null, id = REQ) => {
  const r = request(app).post(`${MOUNT}/link-requests/${id}/decline`);
  return (auth ? r.set('Authorization', auth) : r).send({});
};

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /link-requests/:request_id/decline', () => {
  it('the addressed human declines: status declined + declined_at, and the request leaves GET /link-requests', async () => {
    const { app, col } = build();
    const before = await request(app).get(`${MOUNT}/link-requests`).set('Authorization', `Bearer human:${HUMAN}`);
    expect(before.status).toBe(200);
    expect(before.body.count).toBe(1); // non-empty population before the decline

    const res = await decline(app, `Bearer human:${HUMAN}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ request_id: REQ, status: 'declined', idempotent: false });
    expect(typeof res.body.declined_at).toBe('number');
    const stored = col('agent_invites').get(REQ)!;
    expect(stored.status).toBe('declined');
    expect(stored.declined_at).toBe(res.body.declined_at);

    const after = await request(app).get(`${MOUNT}/link-requests`).set('Authorization', `Bearer human:${HUMAN}`);
    expect(after.body.count).toBe(0);
  });

  it('is idempotent: a second decline returns the ORIGINAL declined_at', async () => {
    const { app, col } = build();
    const first = await decline(app, `Bearer human:${HUMAN}`);
    const second = await decline(app, `Bearer human:${HUMAN}`);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'declined', idempotent: true, declined_at: first.body.declined_at });
    expect(col('agent_invites').get(REQ)!.declined_at).toBe(first.body.declined_at);
  });

  it('RED: no wallet auth → 401, doc untouched', async () => {
    const { app, col } = build();
    const res = await decline(app, null);
    expect(res.status).toBe(401);
    expect(col('agent_invites').get(REQ)!.status).toBe('pending');
  });

  it('RED: an invalid wallet token (e.g. an agent API key) → 401, doc untouched', async () => {
    const { app, col } = build();
    const res = await decline(app, 'Bearer pvn_live_x:pvns_y');
    expect(res.status).toBe(401);
    expect(col('agent_invites').get(REQ)!.status).toBe('pending');
  });

  it('RED: a DIFFERENT human → 404 link_request_not_found (never reveals it exists), doc untouched', async () => {
    const { app, col } = build();
    const res = await decline(app, `Bearer human:${OTHER}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('link_request_not_found');
    expect(col('agent_invites').get(REQ)!.status).toBe('pending');
    expect(col('agent_invites').get(REQ)!.declined_at).toBeUndefined();
  });

  it('RED: an unknown request id → the same 404', async () => {
    const { app } = build();
    const res = await decline(app, `Bearer human:${HUMAN}`, 'inv_nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('link_request_not_found');
  });

  it('RED: an email invite with no addressed human cannot be declined through this route → 404', async () => {
    const { app, col } = build({
      id: REQ, agent_wallet_id: 'wallet_aw_1', agent_display_name: 'Atlas', status: 'pending',
      created_at: Date.now(), expires_at: Date.now() + 1000, email: 'x@example.com',
    });
    const res = await decline(app, `Bearer human:${HUMAN}`);
    expect(res.status).toBe(404);
    expect(col('agent_invites').get(REQ)!.status).toBe('pending');
  });

  it('RED: an ACCEPTED request cannot be declined → 409, doc untouched', async () => {
    const accepted = {
      id: REQ, agent_wallet_id: 'wallet_aw_1', agent_display_name: 'Atlas', status: 'accepted',
      created_at: Date.now(), expires_at: Date.now() + 1000, for_human_user_id: HUMAN,
      accepted_at: Date.now(), accepted_by_user_id: HUMAN,
    };
    const { app, col } = build(accepted);
    const res = await decline(app, `Bearer human:${HUMAN}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('link_request_already_accepted');
    expect(col('agent_invites').get(REQ)!.status).toBe('accepted');
  });
});

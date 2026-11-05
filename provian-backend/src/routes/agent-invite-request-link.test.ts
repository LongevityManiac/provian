/**
 * Build B — POST /v1/agent/wallet/:wallet_id/request-link.
 *
 * The connection-code-driven link REQUEST that closes the onboarding gap:
 * a brand-new UNLINKED agent, holding the connection code its human handed it,
 * asks to be linked to that human. This creates a REQUEST, never a bind — the
 * human still authorizes via the accept-invite anchor (covered separately).
 *
 * Runs the REAL createAgentAuthMiddleware against an in-memory Firestore seeded
 * with real scrypt credentials, so the agent-API-key boundary is exercised.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockGeneratePE = jest.fn<(...args: unknown[]) => Promise<{ peId: string; peHash: string; prevHash: string }>>();
jest.mock('../core/agent-bank/pe-utils', () => ({
  ...(jest.requireActual('../core/agent-bank/pe-utils') as object),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));
// Item 4: request-link pushes `agent_link_request` to the addressed human (best-effort).
const mockSendPushToUser = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../core/notifications/pushDispatcher', () => ({
  ...(jest.requireActual('../core/notifications/pushDispatcher') as object),
  sendPushToUser: (...args: unknown[]) => mockSendPushToUser(...args),
}));
// request-link touches no email path, but the router imports the email module.
jest.mock('../email', () => ({
  sendAgentInvite: jest.fn(async () => true),
  sendBeneficiaryInvite: jest.fn(async () => true),
}));

import express from 'express';
import request from 'supertest';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { createAgentInviteRouter } from './agent-invite';
import { isValidConnectionTokenFormat } from '../core/connection-token-format';
import type { RouterDeps, AgentWalletDocument, AgentInviteDocument } from '../core/agent-wallet/types';

type Doc = Record<string, unknown>;
const MOUNT = '/v1/agent/wallet';
const HUMAN_USER = 'user_human_issuer';
const OTHER_HUMAN = 'user_other_human';
// The REAL minted format (PROV-XXXX-XXXX, 14 chars). Using a synthetic ≥16-char
// token here is exactly what let the format-reject bug ship green: the old
// resolver pattern /^[A-Za-z0-9_-]{16,256}$/ accepted the fake and rejected
// every real code. The guard test below binds this fixture to the canonical
// validator so it can never silently drift back to a non-real shape.
const CONNECTION_TOKEN = 'PROV-ABCD-2345';

function makeFirestore() {
  const collections = new Map<string, Map<string, Doc>>();
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };
  const buildQuery = (name: string, filters: Array<[string, unknown]>, lim?: number): any => ({
    where(field: string, _op: string, value: unknown) { return buildQuery(name, [...filters, [field, value]], lim); },
    limit(n: number) { return buildQuery(name, filters, n); },
    async get() {
      let docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, exists: true, data: () => d }));
      if (lim !== undefined) docs = docs.slice(0, lim);
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  });
  const collection = (name: string) => ({
    doc: (id: string) => ({
      async get() { const d = col(name).get(id); return { exists: d !== undefined, id, data: () => d }; },
      async set(data: Doc) { col(name).set(id, data); },
      async update(patch: Doc) { col(name).set(id, { ...(col(name).get(id) ?? {}), ...patch }); },
    }),
    where(field: string, op: string, value: unknown) { return buildQuery(name, [[field, value]]).where(field, op, value); },
  });
  return { db: { collection } as unknown as import('firebase-admin/firestore').Firestore, col };
}

function makeCache(connectionToken: { user_id: string; expires_at?: number } | null) {
  // The real write-through cache entry always carries expires_at (server.ts mint);
  // enforces it at request-link, so the fixture carries a live one by default.
  const entry = connectionToken === null
    ? null
    : { expires_at: Date.now() + 60 * 60 * 1000, used: false, ...connectionToken };
  return {
    checkRateLimit: jest.fn(async () => ({ allowed: true, retryAfter: 0 })),
    getConnectionToken: jest.fn(async () => entry),
    isEnabled: () => true,
  };
}

function makeDeps(db: import('firebase-admin/firestore').Firestore, cache: unknown): RouterDeps {
  return {
    db, cache: cache as RouterDeps['cache'],
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '0xderived',
  } as unknown as RouterDeps;
}

function seedAgentWallet(col: (n: string) => Map<string, Doc>, overrides: Partial<AgentWalletDocument> = {}) {
  const creds = generateApiCredentials();
  const walletId = overrides.id ?? 'wallet_aw_1';
  const wallet = {
    id: walletId, agent_id: 'agent-1', display_name: 'Atlas', platform: 'custom',
    address: '0xAGENTADDR', public_key: 'ab'.repeat(64),
    api_key_hash: creds.api_key_hash, api_key_salt: creds.api_key_salt, api_key_prefix: creds.api_key_prefix,
    status: 'active', pe_count: 7, ...overrides,
  } as unknown as AgentWalletDocument;
  col('agent_wallets').set(walletId, wallet as unknown as Doc);
  col('api_key_index').set(creds.api_key_prefix, { wallet_id: walletId });
  return { walletId, bearer: `Bearer ${creds.api_key}:${creds.api_secret}` };
}

function buildApp(deps: RouterDeps) {
  const app = express();
  app.use(express.json());
  app.use(MOUNT, createAgentInviteRouter(deps));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGeneratePE.mockResolvedValue({ peId: 'pe_req', peHash: '0xhash', prevHash: '0x0' });
  mockSendPushToUser.mockResolvedValue({ successCount: 1, failureCount: 0, invalidTokens: [], expoCount: 1, fcmCount: 0, hadTokens: true });
});

describe('request-link notifies the human (item 4: agent_link_request push)', () => {
  it('a NEW request pushes agent_link_request to the ISSUING human with the invite id, agent wallet id, and name', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col);
    const app = buildApp(makeDeps(db, makeCache({ user_id: HUMAN_USER })));
    const res = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(res.status).toBe(201);
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    const [, userId, message] = mockSendPushToUser.mock.calls[0] as [unknown, string, { title: string; body: string; data: Record<string, string> }];
    expect(userId).toBe(HUMAN_USER);
    expect(message.data).toEqual({
      type: 'agent_link_request',
      invite_id: res.body.request_id,
      agent_wallet_id: walletId,
      agent_name: 'Atlas',
    });
    expect(message.body).toContain('Atlas');
  });

  it('best-effort: a push failure never fails the request (201, the request is stored)', async () => {
    mockSendPushToUser.mockRejectedValue(new Error('fcm down'));
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col);
    const app = buildApp(makeDeps(db, makeCache({ user_id: HUMAN_USER })));
    const res = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(res.status).toBe(201);
    expect(col('agent_invites').size).toBe(1);
  });

  it('RED control: a reused request, an already-linked agent, and an unknown code push NOTHING', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col);
    const app = buildApp(makeDeps(db, makeCache({ user_id: HUMAN_USER })));
    await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    mockSendPushToUser.mockClear();
    const reused = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(reused.body.reused).toBe(true);

    const linked = makeFirestore();
    const l = seedAgentWallet(linked.col, { linked_human_user_id: HUMAN_USER } as Partial<AgentWalletDocument>);
    await request(buildApp(makeDeps(linked.db, makeCache({ user_id: HUMAN_USER }))))
      .post(`${MOUNT}/${l.walletId}/request-link`).set('Authorization', l.bearer).send({ connection_token: CONNECTION_TOKEN });

    const unknown = makeFirestore();
    const u = seedAgentWallet(unknown.col);
    await request(buildApp(makeDeps(unknown.db, makeCache(null))))
      .post(`${MOUNT}/${u.walletId}/request-link`).set('Authorization', u.bearer).send({ connection_token: CONNECTION_TOKEN });

    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });
});

describe('POST /:wallet_id/request-link (connection-code link request)', () => {
  it('GUARD: the fixture is a REAL minted-format code (binds to the single source)', () => {
    // If this fails, the fixture drifted off the real format and every happy-path
    // assertion below would be vacuous — the exact defect that shipped the bug.
    expect(isValidConnectionTokenFormat(CONNECTION_TOKEN)).toBe(true);
  });

  it('creates a pending request bound to the ISSUING human (for_human_user_id), no email, record-only PE', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col);
    const deps = makeDeps(db, makeCache({ user_id: HUMAN_USER }));
    const app = buildApp(deps);

    const res = await request(app)
      .post(`${MOUNT}/${walletId}/request-link`)
      .set('Authorization', bearer)
      .send({ connection_token: CONNECTION_TOKEN });

    expect(res.status).toBe(201);
    expect(res.body.request_id).toMatch(/^inv_/);
    expect(res.body.status).toBe('pending');

    const stored = [...col('agent_invites').values()][0] as unknown as AgentInviteDocument;
    expect(stored.for_human_user_id).toBe(HUMAN_USER);   // ← ties accept to the issuing human
    expect(stored.origin).toBe('connection_token');
    expect(stored.invite_type).toBe('beneficiary');
    expect(stored.status).toBe('pending');
    expect(stored.email).toBeUndefined();                 // discovered in-app, not emailed
    // Record-only PE, never a bind.
    expect(mockGeneratePE).toHaveBeenCalledTimes(1);
    expect((mockGeneratePE.mock.calls[0][1] as { actionType: string }).actionType).toBe('agent_invite_sent');
  });

  it('is idempotent: a second call reuses the live pending request (no duplicates)', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col);
    const deps = makeDeps(db, makeCache({ user_id: HUMAN_USER }));
    const app = buildApp(deps);

    const first = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    const second = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.request_id).toBe(first.body.request_id);
    expect(col('agent_invites').size).toBe(1); // exactly one request doc
  });

  it('already linked to the SAME human → 200 already_linked, creates nothing', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col, { linked_human_user_id: HUMAN_USER } as Partial<AgentWalletDocument>);
    const deps = makeDeps(db, makeCache({ user_id: HUMAN_USER }));
    const app = buildApp(deps);
    const res = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_linked');
    expect(col('agent_invites').size).toBe(0);
  });

  it('already linked to a DIFFERENT human → 409 (an agent has one human)', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col, { linked_human_user_id: OTHER_HUMAN } as Partial<AgentWalletDocument>);
    const deps = makeDeps(db, makeCache({ user_id: HUMAN_USER }));
    const app = buildApp(deps);
    const res = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('agent_already_linked');
  });

  it('resolves the issuer from Firestore when the cache misses (deferred-write timing)', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col);
    // A human code stays multi-use for link requests: `used` does not stop it; the
    // durable doc (always minted with expires_at) names the issuer.
    col('connection_tokens').set(CONNECTION_TOKEN, { user_id: HUMAN_USER, used: true, expires_at: Date.now() + 60 * 60 * 1000 });
    const deps = makeDeps(db, makeCache(null)); // cache miss
    const app = buildApp(deps);
    const res = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(res.status).toBe(201);
    expect(([...col('agent_invites').values()][0] as unknown as AgentInviteDocument).for_human_user_id).toBe(HUMAN_USER);
  });

  it('NEGATIVE CONTROL: an unknown connection token → 404, creates nothing', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col);
    const deps = makeDeps(db, makeCache(null)); // cache miss AND no firestore doc
    const app = buildApp(deps);
    const res = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('connection_token_issuer_unresolved');
    expect(col('agent_invites').size).toBe(0);
  });

  it('NEGATIVE CONTROL: ownership mismatch (path wallet_id ≠ authenticated wallet) → 403', async () => {
    const { db, col } = makeFirestore();
    const { bearer } = seedAgentWallet(col);
    const deps = makeDeps(db, makeCache({ user_id: HUMAN_USER }));
    const app = buildApp(deps);
    const res = await request(app).post(`${MOUNT}/wallet_SOMEONE_ELSE/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(res.status).toBe(403);
    expect(col('agent_invites').size).toBe(0);
  });

  // "link codes expire in an hour" enforced at request-link for every code.
  it('an EXPIRED human code → 410 connection_token_expired, creates nothing, pushes nothing', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col);
    const app = buildApp(makeDeps(db, makeCache({ user_id: HUMAN_USER, expires_at: Date.now() - 1 })));
    const res = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('connection_token_expired');
    expect(res.body.hint).toMatch(/fresh code/);
    expect(col('agent_invites').size).toBe(0);
    expect(mockGeneratePE).not.toHaveBeenCalled();
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it('an expired code read from Firestore (cache miss) → 410; a doc with NO expiry is treated as expired (Unknown = Block)', async () => {
    for (const doc of [{ user_id: HUMAN_USER, expires_at: Date.now() - 1 }, { user_id: HUMAN_USER }]) {
      const { db, col } = makeFirestore();
      const { walletId, bearer } = seedAgentWallet(col);
      col('connection_tokens').set(CONNECTION_TOKEN, doc);
      const res = await request(buildApp(makeDeps(db, makeCache(null))))
        .post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
      expect(res.status).toBe(410);
      expect(col('agent_invites').size).toBe(0);
    }
  });

  it('an agent ALREADY linked to the issuing human still gets 200 already_linked from an expired code (idempotent re-run)', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col, { linked_human_user_id: HUMAN_USER } as Partial<AgentWalletDocument>);
    const app = buildApp(makeDeps(db, makeCache({ user_id: HUMAN_USER, expires_at: Date.now() - 1 })));
    const res = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({ connection_token: CONNECTION_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_linked');
  });

  it('missing connection_token → 400', async () => {
    const { db, col } = makeFirestore();
    const { walletId, bearer } = seedAgentWallet(col);
    const deps = makeDeps(db, makeCache({ user_id: HUMAN_USER }));
    const app = buildApp(deps);
    const res = await request(app).post(`${MOUNT}/${walletId}/request-link`).set('Authorization', bearer).send({});
    expect(res.status).toBe(400);
  });
});

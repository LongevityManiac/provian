/**
 * Build B — the WALK: a brand-new UNLINKED agent goes, through ONE
 * connection code, all the way to LINKED, with the human authorization step
 * intact. This exercises the NEW stitching end to end across both routers:
 *
 * 1. (given) agent self-created its wallet → has API credentials [create-agent-wallet]
 * 2. (given) agent self-registered its device → owner_type=agent credential, UNLINKED
 * (POST /v1/devices/register with the agent's own creds — unlinked-tolerant
 * Path B, covered by agent-device-register tests; not re-proven here)
 * 3. POST /:wallet_id/request-link (agent API key) → files a link REQUEST to the
 * human who issued the connection code — a request, never a bind.
 * 4. GET /link-requests (human wallet auth) → the human DISCOVERS it in-app.
 * 5. POST /accept-invite (human wallet auth) → the human AUTHORIZES it; only
 * now does bindAgentToHuman run. THIS is the security anchor, unchanged.
 *
 * After step 5 the agent is linked and earns at the linked rate. No gate was
 * weakened: the human's wallet auth is the sole authority that binds.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

const mockGeneratePE = jest.fn<(...args: unknown[]) => Promise<{ peId: string; peHash: string; prevHash: string }>>();
jest.mock('../core/agent-bank/pe-utils', () => ({
  ...(jest.requireActual('../core/agent-bank/pe-utils') as object),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));
jest.mock('../email', () => ({
  sendAgentInvite: jest.fn(async () => true),
  sendBeneficiaryInvite: jest.fn(async () => true),
}));

import { createAgentWalletRouter } from './agent-wallet';
import { createAgentInviteRouter } from './agent-invite';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { isValidConnectionTokenFormat } from '../core/connection-token-format';
import { canonicalAgentPeHash } from '../core/agent-wallet/canonical-agent-pe-chain';
import type { RouterDeps } from '../core/agent-wallet/types';

const MOUNT = '/v1/agent/wallet';
const HUMAN_USER = 'user_human_walk';
const HUMAN_DEVICE = 'dev_walk';
const AUTH_SECRET = 'walk_secret';
const AGENT_WALLET_ID = 'wallet_aw_walk';
const AGENT_ADDRESS = `0x${'a'.repeat(40)}`;
const HUMAN_ADDRESS = `0x${'b'.repeat(40)}`;
// Real minted format (PROV-XXXX-XXXX). See the guard test inside the describe.
const CONNECTION_TOKEN = 'PROV-WXYZ-2345';

type StoreDoc = Record<string, unknown>;

function applyUpdate(current: StoreDoc, patch: StoreDoc): StoreDoc {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && (v as { constructor?: { name?: string } }).constructor?.name === 'DeleteTransform') delete next[k];
    else next[k] = v;
  }
  return next;
}

function humanToken(method: string, path: string, bodyHash: string): string {
  const payload = {
    sub: HUMAN_USER, device_id: HUMAN_DEVICE, iat: Date.now(), exp: Date.now() + 60_000,
    jti: crypto.randomBytes(16).toString('hex'), mth: method, pth: path, bh: bodyHash,
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `${b64}.${crypto.createHmac('sha256', AUTH_SECRET).update(b64).digest('hex')}`;
}

function build() {
  const store = new Map<string, StoreDoc>();
  const creds = generateApiCredentials();

  store.set(`auth_secrets/${HUMAN_USER}`, { secret: AUTH_SECRET });
  // A live human code (minted with a one-hour expires_at, which request-link enforces —).
  store.set('connection_tokens/' + CONNECTION_TOKEN, { user_id: HUMAN_USER, used: true, expires_at: Date.now() + 60 * 60 * 1000 });
  // The agent wallet — self-created, has real API creds, UNLINKED.
  store.set(`agent_wallets/${AGENT_WALLET_ID}`, {
    id: AGENT_WALLET_ID, agent_id: 'agent_walk', display_name: 'Walker', address: AGENT_ADDRESS,
    public_key: 'ab'.repeat(64), api_key_hash: creds.api_key_hash, api_key_salt: creds.api_key_salt,
    api_key_prefix: creds.api_key_prefix, status: 'active', pe_count: 3, attestation_count: 0,
    streak_days: 0, x402_payment_count: 0, governance_score: 0, governance: {}, badges: [],
    created_at: Date.now(), linked_human_wallet_id: null, linked_human_user_id: null,
    linked_human_address: null, operational_reserve_ratio: null, parent_wallet_id: null,
  });
  store.set('api_key_index/' + creds.api_key_prefix, { wallet_id: AGENT_WALLET_ID });
  // The human's canonical wallet (required to accept).
  store.set('wallets/wallet_human_walk', { id: 'wallet_human_walk', user_id: HUMAN_USER, type: 'human', address: HUMAN_ADDRESS });
  // Birth PE + relationship so bindAgentToHuman's chain checks resolve.
  const initialRelationship = { state: 'unlinked', human_wallet_id: null, human_user_id: null, human_address: null, operational_reserve_ratio: null, parent_wallet_id: null, revision: 1 };
  const birthCanonical = {
    id: 'pe_walk_birth', wallet_id: AGENT_WALLET_ID, agent_id: 'agent_walk', action_type: 'agent_wallet_created',
    actor_address: AGENT_ADDRESS, timestamp: 1, prev_hash: '0x0000', attestation_type: 'software',
    metadata: { beneficiary_relationship: initialRelationship }, compute: null, geo: null, execution_env: null,
    cited_pe_ids: null, parent_goal_pe_id: null,
  };
  const birthHash = canonicalAgentPeHash(birthCanonical);
  store.set(`agent_beneficiary_relationships_v1/${AGENT_WALLET_ID}`, {
    schema_version: 'agent-beneficiary-relationship/v1', wallet_id: AGENT_WALLET_ID, agent_id: 'agent_walk',
    ...initialRelationship, source_action_type: 'agent_wallet_created', source_pe_id: 'pe_walk_birth',
    source_pe_hash: birthHash, created_at_ms: 1, updated_at_ms: 1,
  });
  store.set('identity_pes_legacy_v1/pe_walk_birth', { ...birthCanonical, user_id: 'agent_walk', hash: birthHash, policy_action_type: 'agent_wallet_created', integration_source: 'agent_bank_generate_pe', counterparty_address: null, counterparty_type: null, session_lineage: null, self_referencing: false, trust_level_at_creation: null, created_at: 1, durability: 'final' });
  store.set('pe_chain_tips/agent_walk', { hash: birthHash, user_id: 'agent_walk', updated_at: 1 });

  const docRef = (key: string) => ({
    __path: key,
    async get() { const d = store.get(key); return { exists: d !== undefined, id: key.split('/').pop(), data: () => d }; },
    async set(data: StoreDoc) { store.set(key, { ...data }); },
    async update(patch: StoreDoc) { store.set(key, applyUpdate(store.get(key) ?? {}, patch)); },
  });
  const makeQuery = (name: string, filters: Array<{ field: string; value: unknown }> = [], max = Number.MAX_SAFE_INTEGER): any => ({
    where(field: string, _op: string, value: unknown) { return makeQuery(name, [...filters, { field, value }], max); },
    limit(n: number) { return makeQuery(name, filters, n); },
    async get() {
      const prefix = `${name}/`;
      const docs = [...store.entries()].filter(([k, v]) => k.startsWith(prefix) && filters.every((f) => v[f.field] === f.value))
        .slice(0, max).map(([k, v]) => ({ id: k.slice(prefix.length), exists: true, data: () => v }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  });
  const db = {
    async runTransaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
      return fn({
        get: (ref: ReturnType<typeof docRef>) => ref.get(),
        update: (ref: ReturnType<typeof docRef>, patch: StoreDoc) => { store.set(ref.__path, applyUpdate(store.get(ref.__path) ?? {}, patch)); },
        set: (ref: ReturnType<typeof docRef>, data: StoreDoc) => { store.set(ref.__path, { ...data }); },
        create: (ref: ReturnType<typeof docRef>, data: StoreDoc) => { if (store.has(ref.__path)) throw new Error('exists'); store.set(ref.__path, { ...data }); },
      });
    },
    collection(name: string) {
      const q = makeQuery(name);
      return { doc: (id: string) => docRef(`${name}/${id}`), get: q.get, where: q.where };
    },
  };
  const cache = {
    isEnabled: () => true,
    setNx: async () => true,
    getUserAuthSecret: async () => AUTH_SECRET,
    setUserAuthSecret: async () => {},
    invalidateBeneficiaryStatus: async () => {},
    checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
    getConnectionToken: async () => ({ user_id: HUMAN_USER }),
  };
  const deps = { db, cache, peBuffer: { enqueue: () => {} }, recordPEAccrual: async () => {}, keccak256: (b: Buffer) => b, deriveAddressFromPublicKey: () => '' } as unknown as RouterDeps;

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as express.Request & { rawBody?: string }).rawBody = buf.length ? buf.toString('utf8') : ''; } }));
  app.use(MOUNT, createAgentWalletRouter(deps));   // mount order matches server.ts
  app.use(MOUNT, createAgentInviteRouter(deps));
  return { app, store, agentBearer: `Bearer ${creds.api_key}:${creds.api_secret}` };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGeneratePE.mockImplementation(async (...args: unknown[]) => {
    const deps = args[0] as { db: { collection: (n: string) => { doc: (id: string) => unknown }; runTransaction: <T>(fn: (txn: unknown) => Promise<T>) => Promise<T> } };
    const params = args[1] as {
      atomicEntityPrecondition?: (txn: unknown, ctx: { prevHash: string }) => Promise<void>;
      atomicEntityWrite?: (txn: { set: (ref: unknown, data: StoreDoc) => void }, peId: string, ctx: { prevHash: string; newHash: string; timestamp: number }) => void;
      peIdOverride?: string; timestampOverride?: number; walletId: string; agentId: string; actorAddress: string; actionType: string; metadata: Record<string, unknown>; counterpartyAddress?: string | null;
    };
    const peId = params.peIdOverride ?? (params.actionType === 'agent_linked_to_human' ? 'pe_link' : `pe_${params.actionType}`);
    const timestamp = params.timestampOverride ?? Date.now();
    const tipSnap = await (deps.db.collection('pe_chain_tips').doc(params.agentId) as { get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> }> }).get();
    const prevHash = tipSnap.exists && typeof tipSnap.data()?.hash === 'string' ? tipSnap.data().hash as string : '0x0000';
    const canonical = { id: peId, wallet_id: params.walletId, agent_id: params.agentId, action_type: params.actionType, actor_address: params.actorAddress.toLowerCase(), timestamp, prev_hash: prevHash, attestation_type: 'software', metadata: params.metadata, compute: null, geo: null, execution_env: null, cited_pe_ids: null, parent_goal_pe_id: null };
    const peHash = canonicalAgentPeHash(canonical);
    if (params.atomicEntityPrecondition || params.atomicEntityWrite) {
      await deps.db.runTransaction(async (txn: unknown) => {
        const t = txn as { set: (ref: unknown, data: StoreDoc) => void };
        await params.atomicEntityPrecondition?.(txn, { prevHash });
        t.set(deps.db.collection('identity_pes_legacy_v1').doc(peId), { ...canonical, user_id: params.agentId, hash: peHash, policy_action_type: params.actionType, integration_source: 'agent_bank_generate_pe', counterparty_address: params.counterpartyAddress ?? null, counterparty_type: null, session_lineage: null, self_referencing: false, trust_level_at_creation: null, created_at: timestamp, durability: 'final' });
        params.atomicEntityWrite?.(t, peId, { prevHash, newHash: peHash, timestamp });
        t.set(deps.db.collection('pe_chain_tips').doc(params.agentId), { hash: peHash, user_id: params.agentId, updated_at: timestamp });
      });
    }
    return { peId, peHash, prevHash };
  });
});

describe(' unlinked-agent onboarding WALK (one connection code → linked)', () => {
  it('GUARD: the walk uses a REAL minted-format connection code', () => {
    expect(isValidConnectionTokenFormat(CONNECTION_TOKEN)).toBe(true);
  });

  it('request-link → link-requests → accept-invite links the agent, with the human as the sole authority', async () => {
    const { app, store, agentBearer } = build();

    // The agent starts UNLINKED.
    expect(store.get(`agent_wallets/${AGENT_WALLET_ID}`)!.linked_human_user_id).toBeNull();

    // STEP 3 — agent files a link request with the connection code (a REQUEST, not a bind).
    const reqRes = await request(app)
      .post(`${MOUNT}/${AGENT_WALLET_ID}/request-link`)
      .set('Authorization', agentBearer)
      .send({ connection_token: CONNECTION_TOKEN });
    expect(reqRes.status).toBe(201);
    const inviteId = reqRes.body.request_id as string;
    // Still unlinked — a request alone binds nothing.
    expect(store.get(`agent_wallets/${AGENT_WALLET_ID}`)!.linked_human_user_id).toBeNull();

    // STEP 4 — the human DISCOVERS the request in-app (wallet auth).
    const listPath = `${MOUNT}/link-requests`;
    const listRes = await request(app)
      .get(listPath)
      .set('Authorization', `Bearer ${humanToken('GET', listPath, crypto.createHash('sha256').update('').digest('hex'))}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.count).toBe(1);
    expect(listRes.body.link_requests[0]).toMatchObject({ invite_id: inviteId, agent_wallet_id: AGENT_WALLET_ID, agent_name: 'Walker' });

    // STEP 5 — the human AUTHORIZES it (wallet auth is the anchor); NOW the bind happens.
    const body = { invite_id: inviteId };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const acceptRes = await request(app)
      .post(`${MOUNT}/accept-invite`)
      .set('Authorization', `Bearer ${humanToken('POST', `${MOUNT}/accept-invite`, bodyHash)}`)
      .send(body);
    expect(acceptRes.status).toBe(200);

    // End state: the agent is LINKED to its human — earning at the linked rate.
    const linked = store.get(`agent_wallets/${AGENT_WALLET_ID}`)!;
    expect(linked.linked_human_user_id).toBe(HUMAN_USER);
    expect(linked.linked_human_wallet_id).toBe('wallet_human_walk');
    // The bind PE was emitted by the accept path (the authorization), not by request-link.
    expect(mockGeneratePE.mock.calls.some((c) => (c[1] as { actionType?: string }).actionType === 'agent_linked_to_human')).toBe(true);

    // STEP 6 (stale-card regression): once accepted, the invite MUST drop out of
    // the human's pending link-requests — otherwise the agent-hub "authorize the
    // link" card lingers and dead-ends on tap with "Unable to Load Invitation".
    // Old code left status 'pending' and never set accepted_at's exclusion.
    const afterRes = await request(app)
      .get(listPath)
      .set('Authorization', `Bearer ${humanToken('GET', listPath, crypto.createHash('sha256').update('').digest('hex'))}`);
    expect(afterRes.status).toBe(200);
    expect(afterRes.body.count).toBe(0);
    expect(store.get(`agent_invites/${inviteId}`)!.status).toBe('accepted');
  });
});

/**
 * Pass-2 C1 regression: POST /v1/agent/wallet/accept-invite must verify the v2
 * request-bound HMAC wallet-auth token, and GET /v1/agent/wallet/invite/:id must
 * not be PUBLIC_LAUNCH-gated.
 *
 * The prior accept handler did JSON.parse(base64(token)).user_id, which (a) never
 * verified the signature and (b) read `user_id` from a v2 payload that carries
 * `sub` - so every real accept-after-biometric 401'd with "Invalid auth token".
 * These tests craft a REAL v2 token (the exact shape RelayAPIService signs) and
 * assert the link is recorded; a v1-shaped token (which the OLD code accepted) is
 * now rejected.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

const mockGeneratePE = jest.fn<
  (...args: unknown[]) => Promise<{ peId: string; peHash: string; prevHash: string }>
>();
jest.mock('../core/agent-bank/pe-utils', () => ({
  ...(jest.requireActual('../core/agent-bank/pe-utils') as object),
  generatePE: (...args: unknown[]) => mockGeneratePE(...args),
}));

import { createAgentWalletRouter } from './agent-wallet';
import { bindAgentToHuman, BeneficiaryLinkConflictError } from '../core/agent-wallet/link-human-binding';
import type { RouterDeps } from '../core/agent-wallet/types';
import { canonicalAgentPeHash } from '../core/agent-wallet/canonical-agent-pe-chain';

const USER_ID = 'user_real';
const DEVICE_ID = 'dev_real';
const AUTH_SECRET = 'shared_user_secret_xyz';
const INVITE_ID = 'inv1';
const AGENT_WALLET_ID = 'wallet_aw_atlas';
const AGENT_ADDRESS = `0x${'a'.repeat(40)}`;
const HUMAN_ADDRESS = `0x${'b'.repeat(40)}`;
const MOUNT = '/v1/agent/wallet';
const ACCEPT_PATH = `${MOUNT}/accept-invite`;
let failInviteAcceptancePEOnce = false;

function buildV2Token(input: {
  method: string;
  path: string;
  bodyHash: string;
  jti?: string;
  sub?: string;
}): string {
  const payload = {
    sub: input.sub ?? USER_ID,
    device_id: DEVICE_ID,
    iat: Date.now(),
    exp: Date.now() + 60_000,
    jti: input.jti ?? crypto.randomBytes(16).toString('hex'),
    mth: input.method,
    pth: input.path,
    bh: input.bodyHash,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

/** v1-shaped token: base64(JSON{user_id}) with no signature. The OLD accept
 *  handler accepted this; the v2 verifier must reject it. */
function buildV1Token(): string {
  return Buffer.from(JSON.stringify({ user_id: USER_ID }), 'utf8').toString('base64');
}

type StoreDoc = Record<string, unknown>;

function applyUpdate(current: StoreDoc, patch: StoreDoc): StoreDoc {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && value.constructor.name === 'DeleteTransform') {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

function buildDeps(options: {
  hasHumanWallet?: boolean;
  duplicateHumanWallet?: boolean;
} = {}): {
  deps: RouterDeps;
  store: Map<string, StoreDoc>;
} {
  const hasHumanWallet = options.hasHumanWallet !== false;
  const store = new Map<string, StoreDoc>();
  store.set(`auth_secrets/${USER_ID}`, { secret: AUTH_SECRET });
  store.set(`agent_invites/${INVITE_ID}`, {
    created_at: Date.now(),
    agent_wallet_id: AGENT_WALLET_ID,
    signing_bonus_pvt: 0, // 0 → skip the bonus block (no FieldValue.increment needed)
  });
  store.set(`agent_wallets/${AGENT_WALLET_ID}`, {
    id: AGENT_WALLET_ID,
    agent_id: 'agent_atlas',
    display_name: 'Atlas',
    address: AGENT_ADDRESS,
    status: 'active',
    pe_count: 7,
    attestation_count: 0,
    streak_days: 0,
    x402_payment_count: 0,
    governance_score: 0,
    governance: {},
    badges: [],
    created_at: Date.now(),
    linked_human_wallet_id: null,
    linked_human_user_id: null,
    linked_human_address: null,
    operational_reserve_ratio: null,
    parent_wallet_id: null,
    // NOT linked yet
  });
  const initialRelationship = {
    state: 'unlinked',
    human_wallet_id: null,
    human_user_id: null,
    human_address: null,
    operational_reserve_ratio: null,
    parent_wallet_id: null,
    revision: 1,
  };
  const birthCanonical = {
    id: 'pe_agent_birth',
    wallet_id: AGENT_WALLET_ID,
    agent_id: 'agent_atlas',
    action_type: 'agent_wallet_created',
    actor_address: AGENT_ADDRESS,
    timestamp: 1,
    prev_hash: '0x0000',
    attestation_type: 'software',
    metadata: { beneficiary_relationship: initialRelationship },
    compute: null,
    geo: null,
    execution_env: null,
    cited_pe_ids: null,
    parent_goal_pe_id: null,
  };
  const birthHash = canonicalAgentPeHash(birthCanonical);
  store.set(`agent_beneficiary_relationships_v1/${AGENT_WALLET_ID}`, {
    schema_version: 'agent-beneficiary-relationship/v1',
    wallet_id: AGENT_WALLET_ID,
    agent_id: 'agent_atlas',
    ...initialRelationship,
    source_action_type: 'agent_wallet_created',
    source_pe_id: 'pe_agent_birth',
    source_pe_hash: birthHash,
    created_at_ms: 1,
    updated_at_ms: 1,
  });
  store.set('identity_pes_legacy_v1/pe_agent_birth', {
    ...birthCanonical,
    user_id: 'agent_atlas',
    hash: birthHash,
    policy_action_type: 'agent_wallet_created',
    integration_source: 'agent_bank_generate_pe',
    counterparty_address: null,
    counterparty_type: null,
    session_lineage: null,
    self_referencing: false,
    trust_level_at_creation: null,
    created_at: 1,
    durability: 'final',
  });
  store.set('pe_chain_tips/agent_atlas', {
    hash: birthHash,
    user_id: 'agent_atlas',
    updated_at: 1,
  });
  if (hasHumanWallet) {
    store.set('wallets/wallet_human_1', {
      id: 'wallet_human_1',
      user_id: USER_ID,
      type: 'human',
      address: HUMAN_ADDRESS,
    });
    if (options.duplicateHumanWallet) {
      store.set('wallets/wallet_human_2', {
        id: 'wallet_human_2',
        user_id: USER_ID,
        type: 'human',
        address: `0x${'c'.repeat(40)}`,
      });
    }
  }
  store.set(`users/${USER_ID}`, {
    wallet_address: '0xLegacyFallback0000000000000000000000000000',
  });

  const docRef = (key: string) => ({
    __path: key,
    async get() {
      const data = store.get(key);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: StoreDoc) {
      store.set(key, { ...data });
    },
    async update(patch: StoreDoc) {
      store.set(key, applyUpdate(store.get(key) ?? {}, patch));
    },
  });

  const db = {
    async runTransaction<T>(fn: (txn: {
      get: (ref: ReturnType<typeof docRef>) => ReturnType<ReturnType<typeof docRef>['get']>;
      update: (ref: ReturnType<typeof docRef>, patch: StoreDoc) => void;
      set: (ref: ReturnType<typeof docRef>, data: StoreDoc) => void;
      create: (ref: ReturnType<typeof docRef>, data: StoreDoc) => void;
    }) => Promise<T>): Promise<T> {
      return fn({
        get: (ref) => ref.get(),
        update: (ref, patch) => {
          store.set(ref.__path, applyUpdate(store.get(ref.__path) ?? {}, patch));
        },
        set: (ref, data) => { store.set(ref.__path, { ...data }); },
        create: (ref, data) => {
          if (store.has(ref.__path)) throw new Error('document_already_exists');
          store.set(ref.__path, { ...data });
        },
      });
    },
    collection(name: string) {
      const makeQuery = (
        filters: Array<{ field: string; value: unknown }> = [],
        max = Number.MAX_SAFE_INTEGER,
      ): any => ({
        where(field: string, op: string, value: unknown) {
          if (op !== '==') throw new Error(`unsupported_test_query_operator:${op}`);
          return makeQuery([...filters, { field, value }], max);
        },
        limit(nextMax: number) {
          return makeQuery(filters, nextMax);
        },
        async get() {
          const prefix = `${name}/`;
          const docs = [...store.entries()]
            .filter(([key, value]) => key.startsWith(prefix)
              && filters.every((filter) => value[filter.field] === filter.value))
            .slice(0, max)
            .map(([key, value]) => ({
              id: key.slice(prefix.length),
              exists: true,
              data: () => value,
            }));
          return { empty: docs.length === 0, size: docs.length, docs };
        },
      });
      const query = makeQuery();
      return {
        doc: (id: string) => docRef(`${name}/${id}`),
        get: query.get,
        where: query.where,
      };
    },
  };

  const cacheStore = new Map<string, unknown>();
  const cache = {
    isEnabled: () => true,
    setNx: async (key: string) => {
      if (cacheStore.has(key)) return false;
      cacheStore.set(key, true);
      return true;
    },
    getUserAuthSecret: async () => AUTH_SECRET,
    setUserAuthSecret: async () => { /* noop */ },
    invalidateBeneficiaryStatus: async () => { /* noop */ },
    checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
  };

  const deps = {
    db,
    cache,
    peBuffer: { enqueue: () => { /* noop */ } },
    recordPEAccrual: async () => { /* noop */ },
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '',
  } as unknown as RouterDeps;

  return { deps, store };
}

function buildApp(deps: RouterDeps) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.length ? buf.toString('utf8') : '';
      },
    }),
  );
  app.use(MOUNT, createAgentWalletRouter(deps));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  failInviteAcceptancePEOnce = false;
  mockGeneratePE.mockImplementation(async (...args: unknown[]) => {
    const deps = args[0] as {
      db: {
        collection: (name: string) => { doc: (id: string) => unknown };
        runTransaction: <T>(fn: (txn: unknown) => Promise<T>) => Promise<T>;
      };
    };
    const params = args[1] as {
      atomicEntityPrecondition?: (txn: unknown, context: { prevHash: string }) => Promise<void>;
      atomicEntityWrite?: (
        txn: { set: (ref: unknown, data: StoreDoc) => void },
        peId: string,
        context: { prevHash: string; newHash: string; timestamp: number },
      ) => void;
      peIdOverride?: string;
      timestampOverride?: number;
      walletId: string;
      agentId: string;
      actorAddress: string;
      actionType: string;
      metadata: Record<string, unknown>;
      counterpartyAddress?: string | null;
    };
    const peId = params.peIdOverride
      ?? (params.actionType === 'agent_linked_to_human' ? 'pe_link' : 'pe_invite');
    const timestamp = params.timestampOverride ?? Date.now();
    const tipSnapshot = await (deps.db.collection('pe_chain_tips')
      .doc(params.agentId) as any).get();
    const currentTip = tipSnapshot.exists
      ? tipSnapshot.data() as Record<string, unknown>
      : undefined;
    const prevHash = typeof currentTip?.hash === 'string' ? currentTip.hash : '0x0000';
    const canonical = {
      id: peId,
      wallet_id: params.walletId,
      agent_id: params.agentId,
      action_type: params.actionType,
      actor_address: params.actorAddress.toLowerCase(),
      timestamp,
      prev_hash: prevHash,
      attestation_type: 'software',
      metadata: params.metadata,
      compute: null,
      geo: null,
      execution_env: null,
      cited_pe_ids: null,
      parent_goal_pe_id: null,
    };
    const peHash = canonicalAgentPeHash(canonical);
    if (params.atomicEntityPrecondition || params.atomicEntityWrite) {
      await deps.db.runTransaction(async (txn: any) => {
        await params.atomicEntityPrecondition?.(txn, { prevHash });
        txn.set(deps.db.collection('identity_pes_legacy_v1').doc(peId), {
          ...canonical,
          user_id: params.agentId,
          hash: peHash,
          policy_action_type: params.actionType,
          integration_source: 'agent_bank_generate_pe',
          counterparty_address: params.counterpartyAddress ?? null,
          counterparty_type: null,
          session_lineage: null,
          self_referencing: false,
          trust_level_at_creation: null,
          created_at: timestamp,
          durability: 'final',
        });
        params.atomicEntityWrite?.(txn, peId, {
          prevHash,
          newHash: peHash,
          timestamp,
        });
        txn.set(deps.db.collection('pe_chain_tips').doc(params.agentId), {
          hash: peHash,
          user_id: params.agentId,
          updated_at: timestamp,
        });
      });
    }
    if ((params as { actionType?: string }).actionType === 'invite_accepted'
      && failInviteAcceptancePEOnce) {
      failInviteAcceptancePEOnce = false;
      throw new Error('injected invite acceptance PE failure');
    }
    return { peId, peHash, prevHash };
  });
  delete process.env.PUBLIC_LAUNCH;
});

afterEach(() => {
  delete process.env.PUBLIC_LAUNCH;
});

describe('POST /accept-invite (Pass-2 C1)', () => {
  it('accepts a real v2 token, links the agent, and records the beneficiary', async () => {
    const { deps, store } = buildDeps();
    const app = buildApp(deps);

    const body = { invite_id: INVITE_ID };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const token = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });

    const res = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, agent_name: 'Atlas' });

    // Records the link/beneficiary on the agent wallet.
    const linked = store.get(`agent_wallets/${AGENT_WALLET_ID}`)!;
    expect(linked.linked_human_user_id).toBe(USER_ID);
    expect(linked.linked_human_wallet_id).toBe('wallet_human_1');

    // Invite marked accepted.
    expect(store.get(`agent_invites/${INVITE_ID}`)!.accepted_at).toBeDefined();
  });

  it('ignores a historical positive signing bonus without duplicating aggregate PVT', async () => {
    const { deps, store } = buildDeps();
    store.set(`agent_invites/${INVITE_ID}`, {
      ...store.get(`agent_invites/${INVITE_ID}`),
      signing_bonus_pvt: 75,
    });
    const app = buildApp(deps);

    const details = await request(app).get(`${MOUNT}/invite/${INVITE_ID}`);
    expect(details.status).toBe(200);
    expect(details.body.signing_bonus_pvt).toBe(0);

    const body = { invite_id: INVITE_ID };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const token = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });
    const humanBefore = { ...store.get('wallets/wallet_human_1')! };
    const accepted = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(accepted.status).toBe(200);
    expect(accepted.body.signing_bonus_pvt).toBe(0);
    expect([...store.keys()].some((key) => key.startsWith('pvt_accrual/'))).toBe(false);
    expect(store.get('wallets/wallet_human_1')).toEqual(humanBefore);
  });

  it('recovers a durable link and marker with the same deterministic PE after an ambiguous failure', async () => {
    const { deps, store } = buildDeps();
    const app = buildApp(deps);
    const body = { invite_id: INVITE_ID };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    failInviteAcceptancePEOnce = true;

    const firstToken = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });
    const first = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', `Bearer ${firstToken}`)
      .send(body);

    expect(first.status).toBe(503);
    expect(first.body).toEqual({
      error: 'invite_acceptance_pe_pending',
      retry_with_same_invite_id: true,
    });
    const linkedAfterFirst = { ...store.get(`agent_wallets/${AGENT_WALLET_ID}`)! };
    const acceptedAt = store.get(`agent_invites/${INVITE_ID}`)!.accepted_at;
    expect(linkedAfterFirst.linked_human_wallet_id).toBe('wallet_human_1');
    expect(acceptedAt).toEqual(expect.any(Number));

    // Crossing expiry after the durable marker must not strand PE recovery.
    store.set(`agent_invites/${INVITE_ID}`, {
      ...store.get(`agent_invites/${INVITE_ID}`),
      expires_at: (acceptedAt as number) - 1,
    });
    const secondToken = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });
    const second = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', `Bearer ${secondToken}`)
      .send(body);

    expect(second.status).toBe(200);
    expect(store.get(`agent_wallets/${AGENT_WALLET_ID}`)).toEqual(linkedAfterFirst);
    expect(store.get(`agent_invites/${INVITE_ID}`)!.accepted_at).toBe(acceptedAt);

    const invitePeCalls = mockGeneratePE.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((params) => params.actionType === 'invite_accepted');
    expect(invitePeCalls).toHaveLength(2);
    expect(invitePeCalls[0].peIdOverride).toBe(invitePeCalls[1].peIdOverride);
    expect(invitePeCalls[0].timestampOverride).toBe(acceptedAt);
    expect(invitePeCalls[1].timestampOverride).toBe(acceptedAt);
  });

  it('does not auto-create a human wallet when canonical registration is missing', async () => {
    const { deps, store } = buildDeps({ hasHumanWallet: false });
    const app = buildApp(deps);
    const body = { invite_id: INVITE_ID };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const token = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });
    const before = new Map([...store.entries()].map(([key, value]) => [key, { ...value }]));

    const res = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'canonical_human_wallet_registration_required',
      migration: 'Complete POST /v1/wallet/human/register before accepting this invite.',
    });
    expect(store).toEqual(before);
    expect([...store.keys()].some((key) => key.startsWith('wallets/'))).toBe(false);
  });

  it('rejects duplicate canonical human wallets instead of choosing one arbitrarily', async () => {
    const { deps, store } = buildDeps({ duplicateHumanWallet: true });
    const app = buildApp(deps);
    const body = { invite_id: INVITE_ID };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const token = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });
    const before = new Map([...store.entries()].map(([key, value]) => [key, { ...value }]));

    const res = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('canonical_human_wallet_registration_ambiguous');
    expect(store).toEqual(before);
  });

  it('rejects a v1-shaped token that the OLD handler would have accepted', async () => {
    const { deps } = buildDeps();
    const app = buildApp(deps);
    const res = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', `Bearer ${buildV1Token()}`)
      .send({ invite_id: INVITE_ID });
    expect(res.status).toBe(401);
  });

  it('rejects a garbage bearer token', async () => {
    const { deps } = buildDeps();
    const app = buildApp(deps);
    const res = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ invite_id: INVITE_ID });
    expect(res.status).toBe(401);
  });

  it('rejects a v2 token bound to a different body (body-hash binding holds)', async () => {
    const { deps } = buildDeps();
    const app = buildApp(deps);
    // Token signs the hash of a DIFFERENT body than what we send.
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify({ invite_id: 'other' })).digest('hex');
    const token = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });
    const res = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send({ invite_id: INVITE_ID });
    expect(res.status).toBe(401);
  });
});

describe('GET /invite/:invite_id (Pass-2 C1 - PUBLIC_LAUNCH gate removed)', () => {
  it('returns invite details without PUBLIC_LAUNCH set', async () => {
    const { deps } = buildDeps();
    const app = buildApp(deps);
    const res = await request(app).get(`${MOUNT}/invite/${INVITE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agent_name: 'Atlas',
      agent_wallet_id: AGENT_WALLET_ID,
      invite_id: INVITE_ID,
    });
  });

  it('throttles the now-public endpoint per IP (429 when rate limited)', async () => {
    const { deps } = buildDeps();
    (deps.cache as unknown as { checkRateLimit: () => Promise<{ allowed: boolean; retryAfter: number }> })
      .checkRateLimit = async () => ({ allowed: false, retryAfter: 30 });
    const app = buildApp(deps);
    const res = await request(app).get(`${MOUNT}/invite/${INVITE_ID}`);
    expect(res.status).toBe(429);
  });
});

describe('invite expiry honors the stamped expires_at (2026-07 fix: 30d beneficiary invites no longer die at 7d)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function acceptWithFreshToken(app: express.Express) {
    const body = { invite_id: INVITE_ID };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const token = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });
    return request(app).post(ACCEPT_PATH).set('Authorization', `Bearer ${token}`).send(body);
  }

  it('accepts a 10-day-old beneficiary invite whose expires_at is 30 days out (old code 410d this)', async () => {
    const { deps, store } = buildDeps();
    const createdAt = Date.now() - 10 * DAY_MS;
    store.set(`agent_invites/${INVITE_ID}`, {
      created_at: createdAt,
      expires_at: createdAt + 30 * DAY_MS,
      invite_type: 'beneficiary',
      agent_wallet_id: AGENT_WALLET_ID,
      signing_bonus_pvt: 0,
    });
    const app = buildApp(deps);

    const getRes = await request(app).get(`${MOUNT}/invite/${INVITE_ID}`);
    expect(getRes.status).toBe(200);

    const res = await acceptWithFreshToken(app);
    expect(res.status).toBe(200);
    expect(store.get(`agent_invites/${INVITE_ID}`)!.accepted_at).toBeDefined();
  });

  it('410s an invite past its stamped expires_at, on both GET and accept', async () => {
    const { deps, store } = buildDeps();
    const createdAt = Date.now() - 31 * DAY_MS;
    store.set(`agent_invites/${INVITE_ID}`, {
      created_at: createdAt,
      expires_at: createdAt + 30 * DAY_MS,
      invite_type: 'beneficiary',
      agent_wallet_id: AGENT_WALLET_ID,
      signing_bonus_pvt: 0,
    });
    const app = buildApp(deps);

    const getRes = await request(app).get(`${MOUNT}/invite/${INVITE_ID}`);
    expect(getRes.status).toBe(410);

    const res = await acceptWithFreshToken(app);
    expect(res.status).toBe(410);
    expect(store.get(`agent_invites/${INVITE_ID}`)!.accepted_at).toBeUndefined();
  });

  it('410s a 7-day-old standard invite at its stamped 7-day expires_at', async () => {
    const { deps, store } = buildDeps();
    const createdAt = Date.now() - 8 * DAY_MS;
    store.set(`agent_invites/${INVITE_ID}`, {
      created_at: createdAt,
      expires_at: createdAt + 7 * DAY_MS,
      invite_type: 'standard',
      agent_wallet_id: AGENT_WALLET_ID,
      signing_bonus_pvt: 0,
    });
    const app = buildApp(deps);
    const res = await acceptWithFreshToken(app);
    expect(res.status).toBe(410);
  });

  it('legacy invite without expires_at keeps the 7-day fallback: alive at 6 days, dead at 8', async () => {
    const { deps, store } = buildDeps();
    store.set(`agent_invites/${INVITE_ID}`, {
      created_at: Date.now() - 6 * DAY_MS,
      agent_wallet_id: AGENT_WALLET_ID,
      signing_bonus_pvt: 0,
    });
    const app = buildApp(deps);
    const alive = await acceptWithFreshToken(app);
    expect(alive.status).toBe(200);

    const { deps: deps2, store: store2 } = buildDeps();
    store2.set(`agent_invites/${INVITE_ID}`, {
      created_at: Date.now() - 8 * DAY_MS,
      agent_wallet_id: AGENT_WALLET_ID,
      signing_bonus_pvt: 0,
    });
    const app2 = buildApp(deps2);
    const dead = await acceptWithFreshToken(app2);
    expect(dead.status).toBe(410);
  });
});

/**
 * work package 5d — launch-smoke: mint (invite) → accept → agent_linked_to_human PE, with a
 * platform:'test' agent. Confidence check that the beneficiary-link mechanics and the
 * link PE emission fire end-to-end through the accept endpoint, touching no pool.
 *
 * The invite is seeded in the EXACT shape POST /:wallet_id/invite-human writes
 * (agent-invite.ts:231-242) — that Firestore doc IS the minted invite; the accept
 * endpoint under test then consumes it. Uses the same proven supertest harness.
 */
describe('work package 5d launch-smoke: invite → accept → agent_linked_to_human (platform:test)', () => {
  it('links a platform:test agent to a human, emits the agent_linked_to_human PE, and touches no pool', async () => {
    const { deps, store } = buildDeps();

    // The launch-smoke actor is a platform:'test' agent (excluded from real rosters).
    store.set(`agent_wallets/${AGENT_WALLET_ID}`, {
      ...(store.get(`agent_wallets/${AGENT_WALLET_ID}`) as StoreDoc),
      platform: 'test',
    });

    // Seed the invite exactly as invite-human mints it (the "mint" half of the smoke).
    const now = Date.now();
    store.set(`agent_invites/${INVITE_ID}`, {
      id: INVITE_ID,
      agent_wallet_id: AGENT_WALLET_ID,
      agent_display_name: 'Atlas',
      email: 'human@example.com',
      status: 'pending',
      created_at: now,
      expires_at: now + 30 * 24 * 60 * 60 * 1000,
      invite_type: 'beneficiary',
      signing_bonus_pvt: 0,
      agent_pe_count: 7,
    });

    const app = buildApp(deps);
    const body = { invite_id: INVITE_ID };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const token = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });

    const res = await request(app)
      .post(ACCEPT_PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });

    // Link mechanics: the agent is now bound to the human, platform unchanged.
    const linked = store.get(`agent_wallets/${AGENT_WALLET_ID}`)! as StoreDoc;
    expect(linked.linked_human_user_id).toBe(USER_ID);
    expect(linked.linked_human_wallet_id).toBe('wallet_human_1');
    expect(linked.platform).toBe('test');

    // PE emission: the accept path emitted an agent_linked_to_human PE.
    const linkCall = mockGeneratePE.mock.calls.find(
      (c) => (c[1] as { actionType?: string }).actionType === 'agent_linked_to_human',
    );
    expect(linkCall).toBeDefined();

    // No pool touch: nothing was written to any pool collection.
    const poolWrites = [...store.keys()].filter(
      (k) => k.startsWith('pools/') || k.startsWith('agent_pools/'),
    );
    expect(poolWrites).toEqual([]);
  });
});

/**
 * Build B — GET /v1/agent/wallet/link-requests: the human discovers, in-app,
 * the agents that connected with THEIR connection code and asked to be linked
 * (POST /:wallet_id/request-link, tested in agent-invite-request-link.test.ts).
 */
describe('GET /link-requests (connection-code discovery)', () => {
  const LINK_REQUESTS_PATH = `${MOUNT}/link-requests`;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function getLinkRequests(app: express.Express) {
    const bodyHash = crypto.createHash('sha256').update('').digest('hex'); // GET: empty body
    const token = buildV2Token({ method: 'GET', path: LINK_REQUESTS_PATH, bodyHash });
    return request(app).get(LINK_REQUESTS_PATH).set('Authorization', `Bearer ${token}`);
  }

  it('lists ONLY pending, unexpired requests addressed to this human (for_human_user_id === them)', async () => {
    const { deps, store } = buildDeps();
    const now = Date.now();
    // A request for THIS human (should appear).
    store.set('agent_invites/inv_mine', {
      id: 'inv_mine', agent_wallet_id: 'wallet_aw_atlas', agent_display_name: 'Atlas',
      status: 'pending', created_at: now, expires_at: now + 30 * DAY_MS,
      for_human_user_id: USER_ID, origin: 'connection_token', agent_pe_count: 7,
    });
    // A request for a DIFFERENT human (must NOT appear).
    store.set('agent_invites/inv_other', {
      id: 'inv_other', agent_wallet_id: 'wallet_aw_x', agent_display_name: 'Other',
      status: 'pending', created_at: now, expires_at: now + 30 * DAY_MS,
      for_human_user_id: 'user_someone_else', origin: 'connection_token',
    });
    // An EXPIRED request for this human (must NOT appear).
    store.set('agent_invites/inv_expired', {
      id: 'inv_expired', agent_wallet_id: 'wallet_aw_y', agent_display_name: 'Stale',
      status: 'pending', created_at: now - 40 * DAY_MS, expires_at: now - DAY_MS,
      for_human_user_id: USER_ID, origin: 'connection_token',
    });
    const app = buildApp(deps);

    const res = await getLinkRequests(app);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.link_requests).toHaveLength(1);
    expect(res.body.link_requests[0]).toMatchObject({
      request_id: 'inv_mine', invite_id: 'inv_mine',
      agent_wallet_id: 'wallet_aw_atlas', agent_name: 'Atlas', agent_pe_count: 7,
    });
  });

  it('returns an empty list when this human has no pending requests', async () => {
    const { deps } = buildDeps();
    const app = buildApp(deps);
    const res = await getLinkRequests(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ link_requests: [], count: 0 });
  });

  it('401s without a wallet-auth token', async () => {
    const { deps } = buildDeps();
    const app = buildApp(deps);
    const res = await request(app).get(LINK_REQUESTS_PATH);
    expect(res.status).toBe(401);
  });

  it('is not shadowed by GET /:wallet_id (literal route wins, wallet auth not agent auth)', async () => {
    // A regression guard: if GET /link-requests were registered AFTER GET /:wallet_id,
    // this request would hit the agent-auth param route and 401/403 differently.
    const { deps } = buildDeps();
    const app = buildApp(deps);
    const res = await getLinkRequests(app);
    expect(res.status).toBe(200); // reached the wallet-auth link-requests handler
  });
});

/**
 * Build B — accept-invite is bound to the issuing human for connection-code
 * requests (for_human_user_id). This STRENGTHENS the anchor; it must never weaken
 * the legacy bearer email-invite path.
 */
describe('accept-invite for_human_user_id enforcement ', () => {
  function acceptAs(app: express.Express) {
    const body = { invite_id: INVITE_ID };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const token = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });
    return request(app).post(ACCEPT_PATH).set('Authorization', `Bearer ${token}`).send(body);
  }

  it('the ISSUING human (for_human_user_id === them) can accept a code-originated request', async () => {
    const { deps, store } = buildDeps();
    store.set(`agent_invites/${INVITE_ID}`, {
      ...store.get(`agent_invites/${INVITE_ID}`),
      for_human_user_id: USER_ID, origin: 'connection_token', invite_type: 'beneficiary',
    });
    const app = buildApp(deps);
    const res = await acceptAs(app);
    expect(res.status).toBe(200);
    expect(store.get(`agent_wallets/${AGENT_WALLET_ID}`)!.linked_human_user_id).toBe(USER_ID);
  });

  // NEGATIVE CONTROL: a DIFFERENT human must not be able to accept a request
  // that is bound to someone else's connection code. Removing the enforcement
  // check makes this test go RED (the different human would succeed).
  it('NEGATIVE CONTROL: a DIFFERENT human cannot accept a code-bound request → 403, no bind', async () => {
    const { deps, store } = buildDeps();
    store.set(`agent_invites/${INVITE_ID}`, {
      ...store.get(`agent_invites/${INVITE_ID}`),
      for_human_user_id: 'user_a_completely_different_human',
      origin: 'connection_token', invite_type: 'beneficiary',
    });
    const app = buildApp(deps);
    const res = await acceptAs(app); // token is for USER_ID, not the bound human
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_your_link_request');
    // The boundary held: no link was written.
    expect(store.get(`agent_wallets/${AGENT_WALLET_ID}`)!.linked_human_user_id).toBeNull();
  });

  it('NO WEAKENING: a legacy email invite (no for_human_user_id) stays bearer-acceptable', async () => {
    const { deps, store } = buildDeps();
    // Default seeded invite carries NO for_human_user_id — legacy email path.
    expect(store.get(`agent_invites/${INVITE_ID}`)!.for_human_user_id).toBeUndefined();
    const app = buildApp(deps);
    const res = await acceptAs(app);
    expect(res.status).toBe(200);
    expect(store.get(`agent_wallets/${AGENT_WALLET_ID}`)!.linked_human_user_id).toBe(USER_ID);
  });
});

describe('accept-invite with the human-chosen agent_name (item 5)', () => {
  function acceptWith(app: express.Express, extra: Record<string, unknown>) {
    const body = { invite_id: INVITE_ID, ...extra };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const token = buildV2Token({ method: 'POST', path: ACCEPT_PATH, bodyHash });
    return request(app).post(ACCEPT_PATH).set('Authorization', `Bearer ${token}`).send(body);
  }
  const invitePeMetadata = () => {
    const call = mockGeneratePE.mock.calls.find((c) => (c[1] as { actionType: string }).actionType === 'invite_accepted');
    return (call?.[1] as { metadata: Record<string, unknown> } | undefined)?.metadata;
  };

  it('links AND names the agent; the new invite_accepted PE seals the chosen name', async () => {
    const { deps, store } = buildDeps();
    const app = buildApp(deps);
    const res = await acceptWith(app, { agent_name: '  Atlas Prime ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, agent_name: 'Atlas Prime' });
    const wallet = store.get(`agent_wallets/${AGENT_WALLET_ID}`)!;
    expect(wallet.linked_human_user_id).toBe(USER_ID);
    expect(wallet.display_name).toBe('Atlas Prime');
    expect(wallet.display_name_set_by).toBe('linked_human');
    expect(typeof wallet.display_name_set_at).toBe('number');
    expect(invitePeMetadata()?.agent_display_name).toBe('Atlas Prime');
  });

  it('the name the agent sent (unchanged) sets no human flag', async () => {
    const { deps, store } = buildDeps();
    const app = buildApp(deps);
    const res = await acceptWith(app, { agent_name: 'Atlas' });
    expect(res.status).toBe(200);
    const wallet = store.get(`agent_wallets/${AGENT_WALLET_ID}`)!;
    expect(wallet.display_name).toBe('Atlas');
    expect(wallet.display_name_set_by).toBeUndefined();
    expect(invitePeMetadata()?.agent_display_name).toBe('Atlas');
  });

  it.each([
    [{ agent_name: '' }, 'agent_name_required'],
    [{ agent_name: 'a<b' }, 'agent_name_markup'],
    [{ agent_name: 'z'.repeat(101) }, 'agent_name_too_long'],
    [{ agent_name: 7 }, 'agent_name_required'],
  ])('RED: an invalid agent_name %j → 400 %s BEFORE any link or rename', async (extra, code) => {
    const { deps, store } = buildDeps();
    const app = buildApp(deps);
    const res = await acceptWith(app, extra);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(code);
    const wallet = store.get(`agent_wallets/${AGENT_WALLET_ID}`)!;
    expect(wallet.linked_human_user_id).toBeNull();
    expect(wallet.display_name).toBe('Atlas');
    expect(store.get(`agent_invites/${INVITE_ID}`)!.accepted_at).toBeUndefined();
  });

  it('RED: a refused accept (a DIFFERENT human on a code-bound request) renames nothing', async () => {
    const { deps, store } = buildDeps();
    store.set(`agent_invites/${INVITE_ID}`, {
      ...store.get(`agent_invites/${INVITE_ID}`),
      for_human_user_id: 'user_someone_else', origin: 'connection_token', invite_type: 'beneficiary',
    });
    const app = buildApp(deps);
    const res = await acceptWith(app, { agent_name: 'Hijacked' });
    expect(res.status).toBe(403);
    expect(store.get(`agent_wallets/${AGENT_WALLET_ID}`)!.display_name).toBe('Atlas');
  });
});

// B3 (2026-10-22): POST /accept-invite used to call bindAgentToHuman BEFORE the acceptance
// identity check. Human A accepts an emailed (bearer) invite, then ends the link alone
// (human-unlink); human B replays the same invite. The old ordering BOUND B as the agent's
// beneficiary and only then answered 409 beneficiary_link_identity_invalid. Now the identity
// check runs first (route) and again inside the bind transaction, which also writes the
// acceptance marker, so a refused acceptance writes nothing.
describe('B3: an accepted invite cannot be replayed by another human after the link ends', () => {
  const USER_B = 'user_b_second_human';
  const WALLET_B = 'wallet_human_B';
  const ADDRESS_B = `0x${'d'.repeat(40)}`;

  function signed(app: express.Express, path: string, body: Record<string, unknown>, sub: string) {
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const token = buildV2Token({ method: 'POST', path, bodyHash, sub });
    return request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
  }

  function seedHumanB(store: Map<string, StoreDoc>) {
    store.set(`auth_secrets/${USER_B}`, { secret: AUTH_SECRET });
    store.set(`wallets/${WALLET_B}`, { id: WALLET_B, user_id: USER_B, type: 'human', address: ADDRESS_B });
  }

  /** A accepts, then A ends the link alone. Returns the state B will replay against. */
  async function acceptThenUnlinkAsA() {
    const { deps, store } = buildDeps();
    seedHumanB(store);
    const app = buildApp(deps);
    const accepted = await signed(app, ACCEPT_PATH, { invite_id: INVITE_ID }, USER_ID);
    expect(accepted.status).toBe(200);
    expect(store.get(`agent_invites/${INVITE_ID}`)).toMatchObject({
      status: 'accepted', accepted_by_user_id: USER_ID, accepted_by_wallet_id: 'wallet_human_1',
    });
    const unlinked = await signed(app, `${MOUNT}/${AGENT_WALLET_ID}/human-unlink`, {}, USER_ID);
    expect(unlinked.status).toBe(200);
    const agent = store.get(`agent_wallets/${AGENT_WALLET_ID}`)!;
    expect(agent.linked_human_wallet_id).toBeNull();
    expect(agent.linked_human_user_id).toBeNull();
    expect(store.get(`agent_beneficiary_relationships_v1/${AGENT_WALLET_ID}`)!.state).toBe('unlinked');
    return { deps, store, app };
  }

  it('A accepts → A unlinks → B replays the same invite → 409, and NOTHING is written', async () => {
    const { store, app } = await acceptThenUnlinkAsA();
    const before = new Map([...store.entries()].map(([k, v]) => [k, structuredClone(v)]));
    const peCallsBefore = mockGeneratePE.mock.calls.length;

    const replay = await signed(app, ACCEPT_PATH, { invite_id: INVITE_ID }, USER_B);

    expect(replay.status).toBe(409);
    expect(replay.body).toEqual({ error: 'beneficiary_link_identity_invalid' });
    // No binding, no PE, no invite change: the store is byte-for-byte what it was.
    expect(store).toEqual(before);
    const agent = store.get(`agent_wallets/${AGENT_WALLET_ID}`)!;
    expect(agent.linked_human_wallet_id).toBeNull();
    expect(agent.linked_human_user_id).toBeNull();
    expect(agent.linked_human_address).toBeNull();
    expect(store.get(`agent_beneficiary_relationships_v1/${AGENT_WALLET_ID}`)!.state).toBe('unlinked');
    expect(store.get(`agent_invites/${INVITE_ID}`)!.accepted_by_user_id).toBe(USER_ID);
    expect(mockGeneratePE.mock.calls.length).toBe(peCallsBefore);
  });

  it('the bind transaction re-checks the invite itself: a replay that skips the route pre-check still binds nothing', async () => {
    const { deps, store } = await acceptThenUnlinkAsA();
    const before = new Map([...store.entries()].map(([k, v]) => [k, structuredClone(v)]));
    const agent = store.get(`agent_wallets/${AGENT_WALLET_ID}`) as unknown as Parameters<typeof bindAgentToHuman>[1]['wallet'];
    await expect(bindAgentToHuman(deps as unknown as Parameters<typeof bindAgentToHuman>[0], {
      wallet: agent,
      humanWalletId: WALLET_B,
      humanUserId: USER_B,
      humanAddress: ADDRESS_B,
      agentShareBps: 2000 as Parameters<typeof bindAgentToHuman>[1]['agentShareBps'],
      invite: { inviteId: INVITE_ID, acceptedAtMs: Date.now() },
    })).rejects.toEqual(new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid'));
    expect(store).toEqual(before);
  });

  // RED CONTROL — the old ordering. The route used to call bindAgentToHuman with NO invite
  // identity check before it; on exactly the state B replays against, that bind succeeds and
  // writes B as beneficiary. If this ever stops binding, the two tests above no longer prove
  // that the check is what keeps B out.
  it('RED control: the old ordering (bind before the identity check) WOULD have bound B', async () => {
    const { deps, store } = await acceptThenUnlinkAsA();
    const agent = store.get(`agent_wallets/${AGENT_WALLET_ID}`) as unknown as Parameters<typeof bindAgentToHuman>[1]['wallet'];
    await bindAgentToHuman(deps as unknown as Parameters<typeof bindAgentToHuman>[0], {
      wallet: agent,
      humanWalletId: WALLET_B,
      humanUserId: USER_B,
      humanAddress: ADDRESS_B,
      agentShareBps: 2000 as Parameters<typeof bindAgentToHuman>[1]['agentShareBps'],
    });
    const bound = store.get(`agent_wallets/${AGENT_WALLET_ID}`)!;
    expect(bound.linked_human_user_id).toBe(USER_B);
    expect(bound.linked_human_wallet_id).toBe(WALLET_B);
    // ...and the old post-bind marker check then refused, leaving B bound behind a 409.
    expect(store.get(`agent_invites/${INVITE_ID}`)!.accepted_by_user_id).toBe(USER_ID);
  });

  it('a fresh invite is claimed in the SAME transaction as the link (marker written by the bind)', async () => {
    const { deps, store } = buildDeps();
    const agent = store.get(`agent_wallets/${AGENT_WALLET_ID}`) as unknown as Parameters<typeof bindAgentToHuman>[1]['wallet'];
    await bindAgentToHuman(deps as unknown as Parameters<typeof bindAgentToHuman>[0], {
      wallet: agent,
      humanWalletId: 'wallet_human_1',
      humanUserId: USER_ID,
      humanAddress: HUMAN_ADDRESS,
      agentShareBps: 2000 as Parameters<typeof bindAgentToHuman>[1]['agentShareBps'],
      invite: { inviteId: INVITE_ID, acceptedAtMs: 1234 },
    });
    expect(store.get(`agent_invites/${INVITE_ID}`)).toMatchObject({
      status: 'accepted', accepted_at: 1234, accepted_by_user_id: USER_ID, accepted_by_wallet_id: 'wallet_human_1',
    });
    expect(store.get(`agent_wallets/${AGENT_WALLET_ID}`)!.linked_human_user_id).toBe(USER_ID);
  });
});

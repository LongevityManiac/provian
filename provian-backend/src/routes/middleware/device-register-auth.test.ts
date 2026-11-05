/**
 * Adversarial tests for the agent-owned device-registration auth path.
 *
 * Covers (BUILD SPEC items 1, 2, 3):
 *   - consumeAgentDeviceToken: happy path, expired, used, wrong-type fallthrough,
 *     missing wallet, inactive (suspended/revoked) wallet, double-consume (single
 *     use) - all transactionally, all fail-closed.
 *   - createDeviceRegisterAuth routing: sets req.agentWallet (NEVER req.user) on a
 *     valid agent-device token; falls through to the human path for a human
 *     device_registration token; 401 on a wrong-state agent-device token; 503 on a
 *     transaction infra error; pvn_live_ delegates to the agent API path.
 *   - SCOPE-ISOLATION (M1, CRITICAL): the agent-auth middleware (the gate on
 *     rotate-key/transfer-record/link-human/governance) 401s a
 *     no-colon bare token, so the agent_device_registration token cannot
 *     authenticate any of those routes.
 *   - cross-coercion: a human token cannot set req.agentWallet; an agent token
 *     cannot set req.user.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import {
  burnPendingDeviceSetupToken,
  consumeAgentDeviceToken,
  consumeHumanDeviceToken,
  createDeviceRegisterAuth,
  AGENT_DEVICE_REGISTRATION_TYPE,
} from './device-register-auth';
import { createAgentAuthMiddleware } from './agent-auth';

// ---------------------------------------------------------------------------
// In-memory Firestore mock with a real transaction (reads-before-writes,
// optimistic single-use). Two collections matter: setup_tokens, agent_wallets.
// ---------------------------------------------------------------------------

interface DocStore {
  setup_tokens: Map<string, Record<string, unknown>>;
  agent_wallets: Map<string, Record<string, unknown>>;
}

function makeDb(seed: Partial<DocStore> = {}, opts: { failTransaction?: boolean } = {}) {
  const store: DocStore = {
    setup_tokens: seed.setup_tokens ?? new Map(),
    agent_wallets: seed.agent_wallets ?? new Map(),
  };

  // Track writes that happen inside a transaction so a concurrent run can
  // observe them (used to prove single-use). Writes are applied immediately
  // (last-writer-wins) which is enough to assert the !used guard.
  const collection = (name: string) => ({
    doc: (id: string) => ({
      _name: name as keyof DocStore,
      _id: id,
      // Non-transactional get() used by createAgentAuthMiddleware (the
      // pvn_live_ delegation path). For collections we don't model
      // (api_key_index), this returns exists:false so the agent-auth gate
      // cleanly 401s without throwing.
      get: async () => {
        const m = (store as unknown as Record<string, Map<string, Record<string, unknown>>>)[name];
        const exists = !!m && m.has(id);
        return { exists, data: () => (m ? m.get(id) : undefined) };
      },
    }),
  });

  const txGet = async (ref: { _name: keyof DocStore; _id: string }) => {
    const m = store[ref._name];
    const exists = m.has(ref._id);
    return {
      exists,
      data: () => m.get(ref._id),
    };
  };
  const txUpdate = (ref: { _name: keyof DocStore; _id: string }, patch: Record<string, unknown>) => {
    const m = store[ref._name];
    m.set(ref._id, { ...(m.get(ref._id) ?? {}), ...patch });
  };

  const db = {
    collection,
    runTransaction: async <T>(fn: (tx: {
      get: typeof txGet;
      update: typeof txUpdate;
    }) => Promise<T>): Promise<T> => {
      if (opts.failTransaction) {
        throw new Error('firestore transaction infrastructure error');
      }
      return fn({ get: txGet, update: txUpdate });
    },
  };

  return { db: db as unknown as import('firebase-admin/firestore').Firestore, store };
}

const HEX64 = 'a'.repeat(64); // 64 hex chars, no dot, no colon - the canonical token shape
const REGISTRATION_ID = 'registration-auth-test-0001';

/** Let pending microtasks (a delegated, un-awaited async middleware) settle. */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

function activeWallet(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wallet_aw_1',
    agent_id: 'agent-1',
    address: '0xAGENT',
    status: 'active',
    ...overrides,
  };
}

function agentDeviceToken(overrides: Record<string, unknown> = {}) {
  return {
    agent_wallet_id: 'wallet_aw_1',
    agent_id: 'agent-1',
    owner_type: 'agent',
    owner_address: '0xAGENT',
    type: AGENT_DEVICE_REGISTRATION_TYPE,
    created_at: Date.now(),
    expires_at: Date.now() + 60 * 60 * 1000,
    used: false,
    email_hash: 'h',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// consumeAgentDeviceToken
// ---------------------------------------------------------------------------

describe('consumeAgentDeviceToken (BUILD SPEC item 1)', () => {
  it('happy path: returns { kind: wallet } and marks the token used', async () => {
    const { db, store } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    expect(result.kind).toBe('wallet');
    if (result.kind === 'wallet') {
      expect(result.wallet.id).toBe('wallet_aw_1');
      expect(result.wallet.status).toBe('active');
    }
    // single-use side effect: the token is now used.
    expect(store.setup_tokens.get(HEX64)?.used).toBe(true);
    expect(typeof store.setup_tokens.get(HEX64)?.used_at).toBe('number');
    expect(store.setup_tokens.get(HEX64)?.registration_id_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('expired token -> deny (fail closed), never fallthrough', async () => {
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken({ expires_at: Date.now() - 1 })]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    expect(result.kind).toBe('deny');
  });

  it('used token -> deny (fail closed)', async () => {
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken({ used: true })]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    expect(result.kind).toBe('deny');
  });

  it('wrong type (human device_registration token) -> fallthrough (NOT consumed)', async () => {
    const humanToken = { user_id: 'u1', type: 'device_registration', used: false, expires_at: Date.now() + 1000 };
    const { db, store } = makeDb({
      setup_tokens: new Map([[HEX64, humanToken]]),
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    expect(result.kind).toBe('fallthrough');
    // the human token must NOT be marked used by the agent path
    expect(store.setup_tokens.get(HEX64)?.used).toBe(false);
  });

  it('missing token doc -> fallthrough (lets the human path handle it)', async () => {
    const { db } = makeDb();
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    expect(result.kind).toBe('fallthrough');
  });

  it('missing agent wallet -> deny (token claims our type but wallet doc is the source of truth)', async () => {
    const { db, store } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken({ agent_wallet_id: 'ghost' })]]),
      agent_wallets: new Map(), // no wallet
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    expect(result.kind).toBe('deny');
    // M4: a denied agent-device attempt does NOT consume the token (no write past the deny).
    expect(store.setup_tokens.get(HEX64)?.used).toBe(false);
  });

  it('suspended agent wallet -> deny (M3 revalidation)', async () => {
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet({ status: 'suspended' })]]),
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    expect(result.kind).toBe('deny');
  });

  it('revoked agent wallet -> deny (M3 revalidation)', async () => {
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet({ status: 'revoked' })]]),
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    expect(result.kind).toBe('deny');
  });

  it('agent_wallet_id missing/blank on the token -> deny', async () => {
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken({ agent_wallet_id: '' })]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    expect(result.kind).toBe('deny');
  });

  it('a used token permits only the same idempotent registration retry', async () => {
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    // Sequential consume mirrors the real serialized-on-conflict transaction.
    const first = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    const second = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID);
    const different = await consumeAgentDeviceToken(
      db,
      HEX64,
      'registration-auth-test-0002',
    );
    expect(first.kind).toBe('wallet');
    expect(second.kind).toBe('wallet');
    expect(different.kind).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// createDeviceRegisterAuth middleware routing (items 1, 2, 3)
// ---------------------------------------------------------------------------

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(payload: unknown): MockRes;
}

function mockReqRes(authHeader?: string) {
  const req = {
    headers: authHeader
      ? { authorization: authHeader, 'idempotency-key': REGISTRATION_ID }
      : {},
    body: { registration_id: REGISTRATION_ID },
  } as unknown as Request & { agentWallet?: unknown; user?: unknown };
  const resImpl: MockRes = {
    statusCode: 0,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  const res = resImpl as unknown as Response & { statusCode: number; body: unknown };
  const next = jest.fn() as unknown as NextFunction & jest.Mock;
  return { req, res, next };
}

describe('createDeviceRegisterAuth routing (BUILD SPEC items 1, 2)', () => {
  it('valid agent-device token -> sets req.agentWallet and NEVER req.user (M2)', async () => {
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const fallback = jest.fn();
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, res, next } = mockReqRes(`Bearer ${HEX64}`);
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as { agentWallet?: { id: string } }).agentWallet?.id).toBe('wallet_aw_1');
    expect((req as { user?: unknown }).user).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('wrong-state (expired) agent-device token -> 401, fail closed, no fallthrough', async () => {
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken({ expires_at: Date.now() - 1 })]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const fallback = jest.fn();
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, res, next } = mockReqRes(`Bearer ${HEX64}`);
    await mw(req, res, next);
    expect((res as { statusCode: number }).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect((req as { agentWallet?: unknown }).agentWallet).toBeUndefined();
  });

  it('human device_registration token (no colon/dot) -> falls through to the human auth path', async () => {
    const humanToken = { user_id: 'u1', type: 'device_registration', used: false, expires_at: Date.now() + 1000 };
    const { db } = makeDb({ setup_tokens: new Map([[HEX64, humanToken]]) });
    const fallback = jest.fn((_req: Request, _res: Response, n: NextFunction) => n());
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, res, next } = mockReqRes(`Bearer ${HEX64}`);
    await mw(req, res, next);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect((req as { agentWallet?: unknown }).agentWallet).toBeUndefined();
  });

  it('transaction infra error on a bare token -> 503 (fail closed, never grants)', async () => {
    const { db } = makeDb(
      {
        setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
        agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
      },
      { failTransaction: true },
    );
    const fallback = jest.fn();
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, res, next } = mockReqRes(`Bearer ${HEX64}`);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await mw(req, res, next);
    errSpy.mockRestore();
    expect((res as { statusCode: number }).statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('pvn_live_ credential -> delegates to the agent API path, NOT the token path', async () => {
    // No setup_tokens/agent_wallets seeded; the agent-auth path will reject the
    // bogus credentials, but the important property is that we never tried to
    // consume it as a setup token (no agentWallet set from a token).
    const { db } = makeDb();
    const fallback = jest.fn();
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, res, next } = mockReqRes('Bearer pvn_live_deadbeef:pvns_secret');
    await mw(req, res, next);
    // createDeviceRegisterAuth dispatches to authenticateAgent without awaiting
    // (it's a fire-and-forget delegate), so let the agent-auth async chain
    // (api_key_index lookup -> 401) settle.
    await flushPromises();
    // The real createAgentAuthMiddleware runs and rejects (401) because the
    // api_key_index doc does not exist. It must NOT call our fallback, and must
    // NOT have set agentWallet from a token.
    expect(fallback).not.toHaveBeenCalled();
    expect((req as { agentWallet?: unknown }).agentWallet).toBeUndefined();
    expect((res as { statusCode: number }).statusCode).toBe(401);
  });

  it('dot/colon-bearing credential (wallet HMAC) -> delegated to the existing fallback', async () => {
    const { db } = makeDb();
    const fallback = jest.fn((_req: Request, _res: Response, n: NextFunction) => n());
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, res, next } = mockReqRes('Bearer payload.signature');
    await mw(req, res, next);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('missing Authorization header -> delegated to the existing fallback', async () => {
    const { db } = makeDb();
    const fallback = jest.fn((_req: Request, _res: Response, n: NextFunction) => n());
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, res, next } = mockReqRes(undefined);
    await mw(req, res, next);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-coercion regression (item 3)
// ---------------------------------------------------------------------------

describe('human/agent cross-coercion (BUILD SPEC item 3)', () => {
  it('an agent_device_registration token CANNOT set req.user', async () => {
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const fallback = jest.fn();
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, next } = mockReqRes(`Bearer ${HEX64}`);
    await mw(req, mockReqRes().res, next);
    expect((req as { user?: unknown }).user).toBeUndefined();
    expect((req as { agentWallet?: unknown }).agentWallet).toBeDefined();
  });

  it('a human device_registration token CANNOT set req.agentWallet (falls through to human path)', async () => {
    const humanToken = { user_id: 'u1', type: 'device_registration', used: false, expires_at: Date.now() + 1000 };
    const { db } = makeDb({ setup_tokens: new Map([[HEX64, humanToken]]) });
    // Fallback simulates the real human authenticate setting req.user.
    const fallback = jest.fn((req: Request, _res: Response, n: NextFunction) => {
      (req as { user?: unknown }).user = { id: 'u1', device_id: 'setup_token' };
      n();
    });
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, res, next } = mockReqRes(`Bearer ${HEX64}`);
    await mw(req, res, next);
    expect((req as { agentWallet?: unknown }).agentWallet).toBeUndefined();
    expect((req as { user?: { id: string } }).user?.id).toBe('u1');
  });
});

// ---------------------------------------------------------------------------
// SCOPE ISOLATION (M1, CRITICAL) - item 2
// ---------------------------------------------------------------------------
//
// The dedicated register-scoped middleware is the ONLY place the bare 64-hex
// agent_device_registration token is honoured. Every consequential agent route
// (rotate-key/transfer-record/link-human/governance) is gated by
// createAgentAuthMiddleware, which requires the api_key:api_secret SHAPE (a colon
// separator). A bare 64-hex token has no colon, so it can never authenticate
// there. We prove the gate rejects it.

describe('SCOPE ISOLATION: agent-auth middleware rejects a no-colon token (M1)', () => {
  it('createAgentAuthMiddleware 401s a bare 64-hex agent_device_registration token', async () => {
    // Even if such a token doc exists, the agent-auth gate never reads it: it
    // rejects on credential SHAPE (no colon) before any Firestore lookup.
    const { db } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const authenticateAgent = createAgentAuthMiddleware(db);
    const { req, res, next } = mockReqRes(`Bearer ${HEX64}`);
    await authenticateAgent(req, res, next);
    expect((res as { statusCode: number }).statusCode).toBe(401);
    expect((res as { body: { error?: string } }).body.error).toMatch(/Expected api_key:api_secret/);
    expect(next).not.toHaveBeenCalled();
    expect((req as { agentWallet?: unknown }).agentWallet).toBeUndefined();
  });

  it('createAgentAuthMiddleware also 401s the same token even when a colon is appended but the pvn_live_ prefix is absent', async () => {
    const { db } = makeDb();
    const authenticateAgent = createAgentAuthMiddleware(db);
    const { req, res, next } = mockReqRes(`Bearer ${HEX64}:something`);
    await authenticateAgent(req, res, next);
    expect((res as { statusCode: number }).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Constant sanity (canonical contract)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Validate-before-burn : the auth path PRECHECKS, the handler burns.
// ---------------------------------------------------------------------------

describe('validate-before-burn ', () => {
  function humanToken(overrides: Record<string, unknown> = {}) {
    return {
      user_id: 'u1',
      type: 'device_registration',
      created_at: Date.now(),
      expires_at: Date.now() + 60 * 60 * 1000,
      used: false,
      ...overrides,
    };
  }

  it('agent precheck validates fully but does NOT mark the token used', async () => {
    const { db, store } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID, 'precheck');
    expect(result.kind).toBe('wallet');
    expect(store.setup_tokens.get(HEX64)?.used).toBe(false);
    // RED control in-suite: the same call in consume mode burns.
    const consumed = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID, 'consume');
    expect(consumed.kind).toBe('wallet');
    expect(store.setup_tokens.get(HEX64)?.used).toBe(true);
  });

  it('agent precheck still fails closed on a wrong-state token (deny, unburned)', async () => {
    const { db, store } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken({ expires_at: Date.now() - 1 })]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const result = await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID, 'precheck');
    expect(result.kind).toBe('deny');
    expect(store.setup_tokens.get(HEX64)?.used).toBe(false);
  });

  it('the middleware PRECHECKS: agentWallet set, burn marker stamped, token still unused', async () => {
    const { db, store } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    const fallback = jest.fn();
    const mw = createDeviceRegisterAuth(db, fallback as unknown as import('express').RequestHandler);
    const { req, res, next } = mockReqRes(`Bearer ${HEX64}`);
    await mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((req as { agentWallet?: { id: string } }).agentWallet?.id).toBe('wallet_aw_1');
    expect(store.setup_tokens.get(HEX64)?.used).toBe(false);
    expect((req as { pendingDeviceSetupToken?: unknown }).pendingDeviceSetupToken).toEqual({
      kind: AGENT_DEVICE_REGISTRATION_TYPE,
      token: HEX64,
    });
  });

  it('human precheck validates without burning; consume burns; both honor idempotent replay', async () => {
    const { db, store } = makeDb({
      setup_tokens: new Map([[HEX64, humanToken()]]),
    });
    const pre = await consumeHumanDeviceToken(db, HEX64, REGISTRATION_ID, 'precheck');
    expect(pre).toEqual({ kind: 'user', userId: 'u1' });
    expect(store.setup_tokens.get(HEX64)?.used).toBe(false);

    const burn = await consumeHumanDeviceToken(db, HEX64, REGISTRATION_ID, 'consume');
    expect(burn).toEqual({ kind: 'user', userId: 'u1' });
    expect(store.setup_tokens.get(HEX64)?.used).toBe(true);

    // Same registration id replays (both modes); a different one denies.
    expect(await consumeHumanDeviceToken(db, HEX64, REGISTRATION_ID, 'precheck'))
      .toEqual({ kind: 'user', userId: 'u1' });
    expect(await consumeHumanDeviceToken(db, HEX64, REGISTRATION_ID, 'consume'))
      .toEqual({ kind: 'user', userId: 'u1' });
    expect(await consumeHumanDeviceToken(db, HEX64, 'a-different-registration', 'consume'))
      .toEqual({ kind: 'deny' });
  });

  it('human deny states: missing doc, wrong type, expired — none burn anything', async () => {
    const { db: dbMissing } = makeDb();
    expect(await consumeHumanDeviceToken(dbMissing, HEX64, REGISTRATION_ID, 'consume'))
      .toEqual({ kind: 'deny' });

    const { db: dbWrongType, store: s2 } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
    });
    expect(await consumeHumanDeviceToken(dbWrongType, HEX64, REGISTRATION_ID, 'consume'))
      .toEqual({ kind: 'deny' });
    expect(s2.setup_tokens.get(HEX64)?.used).toBe(false);

    const { db: dbExpired, store: s3 } = makeDb({
      setup_tokens: new Map([[HEX64, humanToken({ expires_at: Date.now() - 1 })]]),
    });
    expect(await consumeHumanDeviceToken(dbExpired, HEX64, REGISTRATION_ID, 'consume'))
      .toEqual({ kind: 'deny' });
    expect(s3.setup_tokens.get(HEX64)?.used).toBe(false);
  });

  it('burnPendingDeviceSetupToken refuses a token raced away by a DIFFERENT registration id', async () => {
    const { db, store } = makeDb({
      setup_tokens: new Map([[HEX64, agentDeviceToken()]]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    // Precheck passes for this request...
    expect((await consumeAgentDeviceToken(db, HEX64, REGISTRATION_ID, 'precheck')).kind).toBe('wallet');
    // ...then a concurrent request with a different Idempotency-Key burns it first.
    store.setup_tokens.set(HEX64, agentDeviceToken({
      used: true,
      registration_id_sha256: 'some-other-request-hash',
    }));
    const burned = await burnPendingDeviceSetupToken(
      db,
      { kind: AGENT_DEVICE_REGISTRATION_TYPE, token: HEX64 },
      REGISTRATION_ID,
    );
    expect(burned).toBe(false);
  });

  it('burnPendingDeviceSetupToken burns both kinds on the happy path', async () => {
    const { db, store } = makeDb({
      setup_tokens: new Map<string, Record<string, unknown>>([
        [HEX64, agentDeviceToken()],
        ['b'.repeat(64), humanToken()],
      ]),
      agent_wallets: new Map([['wallet_aw_1', activeWallet()]]),
    });
    expect(await burnPendingDeviceSetupToken(
      db, { kind: AGENT_DEVICE_REGISTRATION_TYPE, token: HEX64 }, REGISTRATION_ID,
    )).toBe(true);
    expect(store.setup_tokens.get(HEX64)?.used).toBe(true);
    expect(await burnPendingDeviceSetupToken(
      db, { kind: 'device_registration', token: 'b'.repeat(64) }, REGISTRATION_ID,
    )).toBe(true);
    expect(store.setup_tokens.get('b'.repeat(64))?.used).toBe(true);
  });
});

describe('canonical contract constants', () => {
  it('exports the exact setup_tokens.type literal', () => {
    expect(AGENT_DEVICE_REGISTRATION_TYPE).toBe('agent_device_registration');
  });
});

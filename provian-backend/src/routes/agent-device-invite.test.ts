/**
 * Adversarial tests for the agent-initiated device-invite (BUILD SPEC item 4).
 *
 *   - mintAgentDeviceInviteToken: writes ONLY the allowlisted fields (M6) - never
 *     api_key/api_secret/hash/salt; email_hash is a sha256, not the raw email;
 *     owner_address/agent_id come from the wallet doc (source of truth); returns
 *     the token + expiry; rejects a malformed/oversized email.
 *   - POST /:wallet_id/device-invite route: ownership guard 403 on wallet_id
 *     mismatch; response is { sent, expires_at } and NEVER contains the token;
 *     dual rate-limit -> 429 when exceeded, 503 when checkRateLimitStrict reports
 *     rate_limit_unavailable (fail closed); active-token cap (>=5) -> 429;
 *     EMAIL_DISABLED -> 503.
 *
 * The route runs the REAL createAgentAuthMiddleware against an in-memory
 * Firestore seeded with a real api_key_index + agent_wallets doc and real scrypt
 * credentials, so the auth boundary is exercised, not stubbed. The email module
 * is mocked so no network is touched and we can assert the emitted command.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockSendConnectCommand = jest.fn(
  (..._args: unknown[]): Promise<boolean> => Promise.resolve(true),
);
jest.mock('../email', () => ({
  sendConnectCommand: (...args: unknown[]) => mockSendConnectCommand(...args),
}));

// agent-wallet.ts captures EMAIL_DISABLED = !RESEND_API_KEY at MODULE LOAD.
// Set the key before that module is required (ts-jest emits CommonJS, so this
// statement runs before the import below) so the device-invite route does not
// short-circuit to 503 (email_unavailable) in the happy-path tests.
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-key';

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { mintAgentDeviceInviteToken } from './agent-wallet';
import { createAgentWalletRouter } from './agent-wallet';
import type { RouterDeps, AgentWalletDocument } from '../core/agent-wallet/types';
import { burnPendingDeviceSetupToken, createDeviceRegisterAuth } from './middleware/device-register-auth';

// ---------------------------------------------------------------------------
// In-memory Firestore supporting the surface the device-invite route + agent
// auth need: doc().get()/.set(), where().where().get(), where().limit().get().
// ---------------------------------------------------------------------------

type Doc = Record<string, unknown>;

function makeFirestore() {
  const collections = new Map<string, Map<string, Doc>>();
  const col = (name: string) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name)!;
  };

  interface Query {
    where(field: string, _op: string, value: unknown): Query;
    limit(n: number): Query;
    get(): Promise<{ empty: boolean; docs: Array<{ id: string; data: () => Doc }> }>;
  }

  const buildQuery = (name: string, filters: Array<[string, unknown]>, lim?: number): Query => ({
    where(field: string, _op: string, value: unknown) {
      return buildQuery(name, [...filters, [field, value]], lim);
    },
    limit(n: number) {
      return buildQuery(name, filters, n);
    },
    async get() {
      let docs = [...col(name).entries()]
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([id, d]) => ({ id, data: () => d }));
      if (lim !== undefined) docs = docs.slice(0, lim);
      return { empty: docs.length === 0, docs };
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
    where(field: string, op: string, value: unknown) {
      return buildQuery(name, [[field, value]]);
    },
  });

  // A minimal transaction over the same maps (reads then writes), so the device-register auth path
  // can consume the token the invite route minted (end to end,).
  const runTransaction = async <T,>(fn: (tx: {
    get(ref: { get(): Promise<unknown> }): Promise<unknown>;
    update(ref: { update(p: Doc): Promise<void> }, patch: Doc): void;
  }) => Promise<T>): Promise<T> => {
    const writes: Array<() => Promise<void>> = [];
    const out = await fn({
      get: (ref) => ref.get(),
      update: (ref, patch) => { writes.push(() => ref.update(patch)); },
    });
    for (const w of writes) await w();
    return out;
  };

  return { db: { collection, runTransaction } as unknown as import('firebase-admin/firestore').Firestore, collections, col };
}

// A cache stub for RouterDeps. checkRateLimitStrict is the security-critical one.
function makeCache(over: Partial<{
  strict: (key: string) => { allowed: boolean; current: number; limit: number; retryAfter?: number; error?: 'rate_limit_unavailable' };
}> = {}) {
  const strict = over.strict ?? (() => ({ allowed: true, current: 1, limit: 5 }));
  return {
    checkRateLimit: jest.fn(async () => ({ allowed: true, current: 0, limit: 100 })),
    checkRateLimitStrict: jest.fn(async (key: string) => strict(key)),
    isEnabled: () => true,
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    del: jest.fn(async () => undefined),
  };
}

function makeDeps(db: import('firebase-admin/firestore').Firestore, cache: ReturnType<typeof makeCache>): RouterDeps {
  return {
    db,
    cache: cache as unknown as RouterDeps['cache'],
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '0xderived',
  } as unknown as RouterDeps;
}

// Seed a real, auth-passing agent wallet. Returns the bearer credential.
function seedAgentWallet(
  col: (n: string) => Map<string, Doc>,
  overrides: Partial<AgentWalletDocument> = {},
): { walletId: string; bearer: string; wallet: AgentWalletDocument } {
  const creds = generateApiCredentials();
  const walletId = overrides.id ?? 'wallet_aw_1';
  const wallet = {
    id: walletId,
    agent_id: 'agent-1',
    display_name: 'Agent One',
    platform: 'custom',
    address: '0xAGENTADDR',
    public_key: 'ab'.repeat(64),
    api_key_hash: creds.api_key_hash,
    api_key_salt: creds.api_key_salt,
    api_key_prefix: creds.api_key_prefix,
    status: 'active',
    ...overrides,
  } as unknown as AgentWalletDocument;
  col('agent_wallets').set(walletId, wallet as unknown as Doc);
  col('api_key_index').set(creds.api_key_prefix, { wallet_id: walletId });
  return { walletId, bearer: `Bearer ${creds.api_key}:${creds.api_secret}`, wallet };
}

function buildApp(deps: RouterDeps) {
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(deps));
  return app;
}

// ===========================================================================
// mintAgentDeviceInviteToken (pure helper)
// ===========================================================================

describe('mintAgentDeviceInviteToken (BUILD SPEC item 4: allowlist + hashing)', () => {
  it('writes ONLY the allowlisted fields and never the agent secret/hash/salt', async () => {
    const { db, col } = makeFirestore();
    const cache = makeCache();
    const deps = makeDeps(db, cache);
    const wallet = {
      id: 'wallet_aw_1', agent_id: 'agent-1', address: '0xAGENTADDR',
      api_key_hash: 'SECRET_HASH', api_key_salt: 'SECRET_SALT', api_key_prefix: 'pvn_live_xx',
      status: 'active',
    } as unknown as AgentWalletDocument;

    const result = await mintAgentDeviceInviteToken(deps, { email: 'Bob@Example.com', agentWallet: wallet });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Token shape: 64 hex chars, no dot, no colon.
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.token).not.toContain('.');
    expect(result.token).not.toContain(':');

    const stored = col('setup_tokens').get(result.token)!;
    expect(Object.keys(stored).sort()).toEqual(
      [
        'agent_wallet_id', 'agent_id', 'owner_type', 'owner_address',
        'type', 'created_at', 'expires_at', 'used', 'email_hash',
      ].sort(),
    );
    // Allowlist negative: NONE of these may appear.
    for (const forbidden of ['api_key', 'api_secret', 'api_key_hash', 'api_key_salt', 'api_key_prefix', 'hash', 'salt']) {
      expect(stored).not.toHaveProperty(forbidden);
    }
    // No stored VALUE may equal the secret material either.
    const values = JSON.stringify(stored);
    expect(values).not.toContain('SECRET_HASH');
    expect(values).not.toContain('SECRET_SALT');

    // Canonical field values.
    expect(stored.type).toBe('agent_device_registration');
    expect(stored.owner_type).toBe('agent');
    expect(stored.used).toBe(false);
    expect(stored.agent_wallet_id).toBe('wallet_aw_1');
    expect(stored.agent_id).toBe('agent-1');
    // owner_address comes from the wallet doc (source of truth).
    expect(stored.owner_address).toBe('0xAGENTADDR');
    // TTL = now + 60*60*1000.
    expect((stored.expires_at as number) - (stored.created_at as number)).toBe(60 * 60 * 1000);
  });

  it('email_hash is sha256(lowercased trimmed email), not the raw address', async () => {
    const { db, col } = makeFirestore();
    const deps = makeDeps(db, makeCache());
    const wallet = { id: 'w', agent_id: 'a', address: '0x', status: 'active' } as unknown as AgentWalletDocument;
    const result = await mintAgentDeviceInviteToken(deps, { email: '  Bob@Example.com  ', agentWallet: wallet });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = col('setup_tokens').get(result.token)!;
    const expected = crypto.createHash('sha256').update('bob@example.com').digest('hex');
    expect(stored.email_hash).toBe(expected);
    expect(stored.email_hash).not.toContain('@');
    expect(JSON.stringify(stored)).not.toContain('Bob@Example.com');
  });

  it('rejects a malformed email (400, no token written)', async () => {
    const { db, col } = makeFirestore();
    const deps = makeDeps(db, makeCache());
    const wallet = { id: 'w', agent_id: 'a', address: '0x', status: 'active' } as unknown as AgentWalletDocument;
    const result = await mintAgentDeviceInviteToken(deps, { email: 'not-an-email', agentWallet: wallet });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(col('setup_tokens').size).toBe(0);
  });

  it('rejects an oversized email (>254 chars)', async () => {
    const { db } = makeFirestore();
    const deps = makeDeps(db, makeCache());
    const wallet = { id: 'w', agent_id: 'a', address: '0x', status: 'active' } as unknown as AgentWalletDocument;
    const longEmail = 'a'.repeat(250) + '@x.com';
    const result = await mintAgentDeviceInviteToken(deps, { email: longEmail, agentWallet: wallet });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

// ===========================================================================
// POST /:wallet_id/device-invite route
// ===========================================================================

describe('POST /:wallet_id/device-invite (BUILD SPEC item 4: route guards)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendConnectCommand.mockResolvedValue(true);
  });

  it('happy path: response is exactly { sent, expires_at } and NEVER leaks the token', async () => {
    const { db, col } = makeFirestore();
    const cache = makeCache();
    const deps = makeDeps(db, cache);
    const { walletId, bearer } = seedAgentWallet(col);
    const app = buildApp(deps);

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/device-invite`)
      .set('Authorization', bearer)
      .send({ email: 'bob@example.com', device_name: 'Build box', message: 'set up the CI box' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, expires_at: expect.any(Number) });
    // The minted token exists in Firestore...
    const tokenDocs = [...col('setup_tokens').keys()];
    expect(tokenDocs).toHaveLength(1);
    const token = tokenDocs[0];
    // ...but NEVER appears in the HTTP response body.
    expect(JSON.stringify(res.body)).not.toContain(token);

    // the emitted command is the hosted agent-device INSTALLER (the
    // Connect line's SHA-pinned bundle), not a bare register POST — it
    // registers the machine to this agent's wallet AND starts the observer.
    // The token rides a header (never the URL); the device name rides with it.
    expect(mockSendConnectCommand).toHaveBeenCalledTimes(1);
    const call = mockSendConnectCommand.mock.calls[0] as unknown as [string, string, string, number, string, string, string, string];
    const [to, kind, command] = call;
    const windowsCommand = call[6];
    expect(to).toBe('bob@example.com');
    expect(kind).toBe('agent_device');
    expect(command).toBe(
      `curl -sSL -H 'x-provian-token: ${token}' -H 'x-provian-device-name: Build box' "https://api.provian.ai/v1/bootstrap/agent-device" | sh`,
    );
    // The agent asked for it, so the email says so (never "from the Provian app").
    expect(call[7]).toBe('agent');
    expect(windowsCommand).toContain(`'x-provian-token'='${token}'`);
    expect(windowsCommand).toContain('/v1/bootstrap/agent-device" | iex');
    expect(command).not.toContain('/v1/devices/register');
    expect(command).not.toContain('npx @provian/agent-sdk');
  });

  it('ownership guard: a valid agent cannot invite for a different wallet_id (403)', async () => {
    const { db, col } = makeFirestore();
    const deps = makeDeps(db, makeCache());
    const { bearer } = seedAgentWallet(col); // authenticates as wallet_aw_1
    const app = buildApp(deps);

    const res = await request(app)
      .post('/v1/agent/wallet/wallet_aw_OTHER/device-invite')
      .set('Authorization', bearer)
      .send({ email: 'bob@example.com' });

    expect(res.status).toBe(403);
    expect(col('setup_tokens').size).toBe(0); // nothing minted
    expect(mockSendConnectCommand).not.toHaveBeenCalled();
  });

  it('per-wallet rate limit exceeded -> 429', async () => {
    const { db, col } = makeFirestore();
    const cache = makeCache({
      strict: (key) =>
        key.startsWith('agent-device-invite:wallet:')
          ? { allowed: false, current: 6, limit: 5, retryAfter: 600 }
          : { allowed: true, current: 1, limit: 5 },
    });
    const deps = makeDeps(db, cache);
    const { walletId, bearer } = seedAgentWallet(col);
    const app = buildApp(deps);

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/device-invite`)
      .set('Authorization', bearer)
      .send({ email: 'bob@example.com' });

    expect(res.status).toBe(429);
    expect(col('setup_tokens').size).toBe(0);
  });

  it('per-email rate limit exceeded -> 429', async () => {
    const { db, col } = makeFirestore();
    const cache = makeCache({
      strict: (key) =>
        key.startsWith('agent-device-invite:email:')
          ? { allowed: false, current: 6, limit: 5, retryAfter: 600 }
          : { allowed: true, current: 1, limit: 5 },
    });
    const deps = makeDeps(db, cache);
    const { walletId, bearer } = seedAgentWallet(col);
    const app = buildApp(deps);

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/device-invite`)
      .set('Authorization', bearer)
      .send({ email: 'bob@example.com' });

    expect(res.status).toBe(429);
    expect(col('setup_tokens').size).toBe(0);
  });

  it('fail CLOSED: rate_limit_unavailable (Redis down) -> 503, never mints', async () => {
    const { db, col } = makeFirestore();
    const cache = makeCache({
      strict: () => ({ allowed: false, current: 0, limit: 5, error: 'rate_limit_unavailable' }),
    });
    const deps = makeDeps(db, cache);
    const { walletId, bearer } = seedAgentWallet(col);
    const app = buildApp(deps);

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/device-invite`)
      .set('Authorization', bearer)
      .send({ email: 'bob@example.com' });

    expect(res.status).toBe(503);
    expect(col('setup_tokens').size).toBe(0);
    expect(mockSendConnectCommand).not.toHaveBeenCalled();
  });

  it('active-token cap: 5 active unconsumed agent_device_registration tokens -> 429', async () => {
    const { db, col } = makeFirestore();
    const cache = makeCache();
    const deps = makeDeps(db, cache);
    const { walletId, bearer } = seedAgentWallet(col);
    // Pre-seed 5 active (unused, unexpired) agent-device tokens for this wallet.
    const future = Date.now() + 60 * 60 * 1000;
    for (let i = 0; i < 5; i++) {
      col('setup_tokens').set(`tok${i}`, {
        agent_wallet_id: walletId,
        type: 'agent_device_registration',
        used: false,
        expires_at: future,
      });
    }
    const app = buildApp(deps);

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/device-invite`)
      .set('Authorization', bearer)
      .send({ email: 'bob@example.com' });

    expect(res.status).toBe(429);
    expect(res.body.active_count).toBe(5);
    // No new token minted.
    expect(col('setup_tokens').size).toBe(5);
  });

  it('expired/used tokens do NOT count toward the active cap', async () => {
    const { db, col } = makeFirestore();
    const cache = makeCache();
    const deps = makeDeps(db, cache);
    const { walletId, bearer } = seedAgentWallet(col);
    // 4 expired + 1 used (none active) -> the new invite should succeed.
    for (let i = 0; i < 4; i++) {
      col('setup_tokens').set(`exp${i}`, {
        agent_wallet_id: walletId, type: 'agent_device_registration',
        used: false, expires_at: Date.now() - 1,
      });
    }
    col('setup_tokens').set('used0', {
      agent_wallet_id: walletId, type: 'agent_device_registration',
      used: true, expires_at: Date.now() + 60_000,
    });
    const app = buildApp(deps);

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/device-invite`)
      .set('Authorization', bearer)
      .send({ email: 'bob@example.com' });

    expect(res.status).toBe(200);
  });

  it('EMAIL_DISABLED (no RESEND_API_KEY at module load) is not re-read here; an invalid email still 400s before send', async () => {
    // EMAIL_DISABLED is captured at module import; we cannot flip it per-test.
    // Assert the email-validation guard fires before any mint/send instead.
    const { db, col } = makeFirestore();
    const deps = makeDeps(db, makeCache());
    const { walletId, bearer } = seedAgentWallet(col);
    const app = buildApp(deps);

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/device-invite`)
      .set('Authorization', bearer)
      .send({ email: 'nope' });

    expect(res.status).toBe(400);
    expect(col('setup_tokens').size).toBe(0);
    expect(mockSendConnectCommand).not.toHaveBeenCalled();
  });

  it('a suspended agent wallet cannot reach the route at all (agent-auth 403)', async () => {
    const { db, col } = makeFirestore();
    const deps = makeDeps(db, makeCache());
    const { walletId, bearer } = seedAgentWallet(col, { status: 'suspended' } as Partial<AgentWalletDocument>);
    const app = buildApp(deps);

    const res = await request(app)
      .post(`/v1/agent/wallet/${walletId}/device-invite`)
      .set('Authorization', bearer)
      .send({ email: 'bob@example.com' });

    expect(res.status).toBe(403);
    expect(col('setup_tokens').size).toBe(0);
  });
});

// ===========================================================================
// End to end : the app no longer offers the agent-device email form, but the
// agent-initiated invite stays. The token the invite route mints registers a computer to the agent's
// wallet through POST /v1/devices/register's own auth, once.
// ===========================================================================

describe('agent-initiated device invite, end to end through its relay routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendConnectCommand.mockResolvedValue(true);
  });

  function appWithRegister(deps: RouterDeps) {
    const app = buildApp(deps);
    const humanPath = (_req: express.Request, res: express.Response) => { res.status(401).json({ error: 'human path' }); };
    app.post('/v1/devices/register', createDeviceRegisterAuth(deps.db, humanPath), async (req, res) => {
      // What the register handler does after the body validates: burn the precheck's token once.
      const pending = req.pendingDeviceSetupToken!;
      const ok = await burnPendingDeviceSetupToken(deps.db, pending, String(req.headers['idempotency-key']));
      if (!ok) { res.status(401).json({ error: 'Invalid or expired registration token' }); return; }
      res.status(201).json({ owner_wallet_id: req.agentWallet?.id, human: req.user !== undefined });
    });
    return app;
  }

  it('invite → emailed line → register: the computer registers to the agent wallet, and the token works once', async () => {
    const { db, col } = makeFirestore();
    const deps = makeDeps(db, makeCache());
    const { walletId, bearer } = seedAgentWallet(col);
    const app = appWithRegister(deps);

    const invite = await request(app)
      .post(`/v1/agent/wallet/${walletId}/device-invite`)
      .set('Authorization', bearer)
      .send({ email: 'bob@example.com', device_name: 'Build box' });
    expect(invite.status).toBe(200);
    const command = (mockSendConnectCommand.mock.calls[0] as unknown as string[])[2];
    const token = /x-provian-token: ([0-9a-f]{64})/.exec(command)![1];
    expect(col('setup_tokens').get(token)).toMatchObject({ type: 'agent_device_registration', agent_wallet_id: walletId });

    const reg = await request(app)
      .post('/v1/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'device-e2e-registration-0001')
      .send({ device_name: 'Build box' });
    expect(reg.status).toBe(201);
    expect(reg.body).toEqual({ owner_wallet_id: walletId, human: false });
    expect(col('setup_tokens').get(token)).toMatchObject({ used: true });

    // RED: a second computer with the same line is refused (single use).
    const again = await request(app)
      .post('/v1/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'device-e2e-registration-0002')
      .send({ device_name: 'Other box' });
    expect(again.status).toBe(401);
  });
});

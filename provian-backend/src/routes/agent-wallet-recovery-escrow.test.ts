/**
 * Route guard tests for the non-custodial recovery-escrow endpoints:
 * POST /v1/agent/wallet/:wallet_id/recovery-escrow (agent API auth + ownership)
 * GET /v1/agent/wallet/:wallet_id/recovery-escrow (wallet auth + linked human)
 *
 * These are the two access guards that keep escrow writes/reads scoped. Each is
 * proven with its RED negative control (a caller who must be refused IS refused),
 * because a happy-path-only test on a guard is vacuous — the exact defect class
 * that shipped the connection-code bug. The stored/served payload is a REAL
 * SDK-sealed blob, so the endpoints are exercised against genuine wire bytes.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
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
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import { AGENT_RECOVERY_ESCROW_COLLECTION } from '../core/agent-recovery-escrow';
import type { RouterDeps, AgentWalletDocument } from '../core/agent-wallet/types';

const MOUNT = '/v1/agent/wallet';
const USER_ID = 'user_human_linked';
const OTHER_USER = 'user_someone_else';
const DEVICE_ID = 'dev_recovery';
const AUTH_SECRET = 'shared_secret_recovery';

// REAL SDK-sealed vector (provian-agent-sdk sealed box). See agent-recovery-escrow.test.ts.
const REAL_ANCHOR_PUBKEY = 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20';
const REAL_SEALED_BLOB =
  'AVfbSzWfI65eFG5OJRIFZwRyJQY0jBUMFHU9DJM9BNQhr_-CnW3w_T1hMIEMszdx7ur6VXxHlGpe0hY1CLWOQI3aTC8ivRgEzEvVwrzoN7wSOllRsPo';

type Doc = Record<string, unknown>;

function buildV2Token(method: string, path: string, body: string): string {
  const bh = crypto.createHash('sha256').update(body).digest('hex');
  const payload = {
    sub: USER_ID,
    device_id: DEVICE_ID,
    iat: Date.now(),
    exp: Date.now() + 60_000,
    jti: crypto.randomBytes(16).toString('hex'),
    mth: method,
    pth: path,
    bh,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

function makeHarness() {
  const store = new Map<string, Doc>();

  const docRef = (key: string) => ({
    __path: key,
    async get() { const d = store.get(key); return { exists: d !== undefined, id: key.split('/').pop(), data: () => d }; },
    async set(data: Doc) { store.set(key, { ...data }); },
    async update(patch: Doc) { store.set(key, { ...(store.get(key) ?? {}), ...patch }); },
  });

  const db = {
    async runTransaction<T>(fn: (txn: {
      get: (ref: ReturnType<typeof docRef>) => ReturnType<ReturnType<typeof docRef>['get']>;
      set: (ref: ReturnType<typeof docRef>, data: Doc) => void;
      update: (ref: ReturnType<typeof docRef>, patch: Doc) => void;
      create: (ref: ReturnType<typeof docRef>, data: Doc) => void;
    }) => Promise<T>): Promise<T> {
      return fn({
        get: (ref) => ref.get(),
        set: (ref, data) => store.set(ref.__path, { ...data }),
        update: (ref, patch) => store.set(ref.__path, { ...(store.get(ref.__path) ?? {}), ...patch }),
        create: (ref, data) => { if (store.has(ref.__path)) throw new Error('exists'); store.set(ref.__path, { ...data }); },
      });
    },
    collection(name: string) {
      const makeQuery = (filters: Array<[string, unknown]> = [], max = Number.MAX_SAFE_INTEGER): any => ({
        where(field: string, _op: string, value: unknown) { return makeQuery([...filters, [field, value]], max); },
        limit(n: number) { return makeQuery(filters, n); },
        async get() {
          const prefix = `${name}/`;
          const docs = [...store.entries()]
            .filter(([k, v]) => k.startsWith(prefix) && filters.every(([f, val]) => v[f] === val))
            .slice(0, max)
            .map(([k, v]) => ({ id: k.slice(prefix.length), exists: true, data: () => v }));
          return { empty: docs.length === 0, size: docs.length, docs };
        },
      });
      const q = makeQuery();
      return { doc: (id: string) => docRef(`${name}/${id}`), where: q.where, limit: q.limit, get: q.get };
    },
  };

  const cacheStore = new Map<string, unknown>();
  const cache = {
    isEnabled: () => true,
    setNx: async (key: string) => { if (cacheStore.has(key)) return false; cacheStore.set(key, true); return true; },
    getUserAuthSecret: async () => AUTH_SECRET,
    setUserAuthSecret: async () => { /* noop */ },
    checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
  };

  const deps = {
    db, cache,
    peBuffer: { enqueue: () => { /* noop */ } },
    recordPEAccrual: async () => { /* noop */ },
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '',
  } as unknown as RouterDeps;

  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.length ? buf.toString('utf8') : '';
    },
  }));
  app.use(MOUNT, createAgentWalletRouter(deps));

  /** Seed an agent wallet + agent API credentials; returns its bearer. */
  function seedAgentWallet(walletId: string, linkedHumanUserId: string | null): string {
    const creds = generateApiCredentials();
    store.set(`agent_wallets/${walletId}`, {
      id: walletId, agent_id: `agent_${walletId}`, display_name: 'Atlas', platform: 'custom',
      address: '0xAGENT', public_key: 'ab'.repeat(64),
      api_key_hash: creds.api_key_hash, api_key_salt: creds.api_key_salt, api_key_prefix: creds.api_key_prefix,
      status: 'active', pe_count: 7, linked_human_user_id: linkedHumanUserId,
    } as unknown as AgentWalletDocument as unknown as Doc);
    store.set(`api_key_index/${creds.api_key_prefix}`, { wallet_id: walletId });
    return `Bearer ${creds.api_key}:${creds.api_secret}`;
  }

  function seedEscrow(walletId: string) {
    store.set(`${AGENT_RECOVERY_ESCROW_COLLECTION}/${walletId}`, {
      wallet_id: walletId, sealed_key_blob: REAL_SEALED_BLOB,
      recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY, blob_version: 1, created_at: 1, updated_at: 1,
    });
  }

  return { app, store, seedAgentWallet, seedEscrow };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('POST /:wallet_id/recovery-escrow (agent auth + ownership)', () => {
  it('stores a valid sealed blob for the owning agent (sealed to its linked human\'s published anchor)', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_1', USER_ID);
    h.store.set(`human_recovery_anchors/${USER_ID}`, { user_id: USER_ID, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
    const res = await request(h.app)
      .post(`${MOUNT}/wallet_aw_1/recovery-escrow`)
      .set('Authorization', bearer)
      .send({ sealed_key_blob: REAL_SEALED_BLOB, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(true);
    const stored = h.store.get(`${AGENT_RECOVERY_ESCROW_COLLECTION}/wallet_aw_1`);
    expect(stored?.sealed_key_blob).toBe(REAL_SEALED_BLOB);
  });

  it('RED CONTROL: an agent cannot escrow for a wallet it does not own (403)', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_1', USER_ID);
    h.seedAgentWallet('wallet_aw_2', OTHER_USER);
    const res = await request(h.app)
      .post(`${MOUNT}/wallet_aw_2/recovery-escrow`) // path targets a DIFFERENT wallet
      .set('Authorization', bearer)                  // ...but the key belongs to wallet_aw_1
      .send({ sealed_key_blob: REAL_SEALED_BLOB, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
    expect(res.status).toBe(403);
    expect(h.store.has(`${AGENT_RECOVERY_ESCROW_COLLECTION}/wallet_aw_2`)).toBe(false);
  });

  it('rejects a malformed sealed blob (400) and a malformed anchor pubkey (400)', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_1', USER_ID);
    const badBlob = await request(h.app).post(`${MOUNT}/wallet_aw_1/recovery-escrow`)
      .set('Authorization', bearer)
      .send({ sealed_key_blob: 'not a blob!!', recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
    expect(badBlob.status).toBe(400);
    const badKey = await request(h.app).post(`${MOUNT}/wallet_aw_1/recovery-escrow`)
      .set('Authorization', bearer)
      .send({ sealed_key_blob: REAL_SEALED_BLOB, recovery_anchor_pubkey: 'short' });
    expect(badKey.status).toBe(400);
  });

  it('rejects a request with no agent auth (401)', async () => {
    const h = makeHarness();
    h.seedAgentWallet('wallet_aw_1', USER_ID);
    const res = await request(h.app).post(`${MOUNT}/wallet_aw_1/recovery-escrow`)
      .send({ sealed_key_blob: REAL_SEALED_BLOB, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
    expect(res.status).toBe(401);
  });
});

describe('POST /:wallet_id/recovery-escrow — the anchor must be one the relay names (gate hardening)', () => {
  const OWN_KEY_ANCHOR = 'K'.repeat(43); // a key the AGENT could hold
  const send = (h: ReturnType<typeof makeHarness>, bearer: string, anchor: string) => request(h.app)
    .post(`${MOUNT}/wallet_aw_1/recovery-escrow`)
    .set('Authorization', bearer)
    .send({ sealed_key_blob: REAL_SEALED_BLOB, recovery_anchor_pubkey: anchor });

  it('accepts the BIRTH anchor recorded at creation (the SDK / MCP birth path)', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_1', null); // not linked yet: birth anchor only
    h.store.set('agent_birth_recovery_anchors/wallet_aw_1', {
      wallet_id: 'wallet_aw_1', recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY, source: 'connection_code', created_at: 1,
    });
    const res = await send(h, bearer, REAL_ANCHOR_PUBKEY);
    expect(res.status).toBe(200);
    expect(h.store.get(`${AGENT_RECOVERY_ESCROW_COLLECTION}/wallet_aw_1`)?.recovery_anchor_pubkey).toBe(REAL_ANCHOR_PUBKEY);
  });

  it('accepts a re-seal to the anchor of the escrow it already holds', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_1', null);
    h.seedEscrow('wallet_aw_1');
    expect((await send(h, bearer, REAL_ANCHOR_PUBKEY)).status).toBe(200);
  });

  it('RED CONTROL: a self-chosen anchor (no birth record, no link, no escrow) → 403 recovery_anchor_not_recognized, nothing stored', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_1', null);
    const res = await send(h, bearer, OWN_KEY_ANCHOR);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('recovery_anchor_not_recognized');
    expect(h.store.has(`${AGENT_RECOVERY_ESCROW_COLLECTION}/wallet_aw_1`)).toBe(false);
  });

  it('RED CONTROL: a LINKED agent still cannot escrow to any key but its human\'s published one', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_1', USER_ID);
    h.store.set(`human_recovery_anchors/${USER_ID}`, { user_id: USER_ID, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
    // Another human's published anchor is not this agent's custodian either.
    h.store.set(`human_recovery_anchors/${OTHER_USER}`, { user_id: OTHER_USER, recovery_anchor_pubkey: OWN_KEY_ANCHOR });
    const res = await send(h, bearer, OWN_KEY_ANCHOR);
    expect(res.status).toBe(403);
    expect(h.store.has(`${AGENT_RECOVERY_ESCROW_COLLECTION}/wallet_aw_1`)).toBe(false);
  });

  it('RED CONTROL: an existing escrow cannot be MOVED to a self-chosen anchor (the stored escrow is unchanged)', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_1', null);
    h.seedEscrow('wallet_aw_1');
    const before = JSON.stringify(h.store.get(`${AGENT_RECOVERY_ESCROW_COLLECTION}/wallet_aw_1`));
    expect((await send(h, bearer, OWN_KEY_ANCHOR)).status).toBe(403);
    expect(JSON.stringify(h.store.get(`${AGENT_RECOVERY_ESCROW_COLLECTION}/wallet_aw_1`))).toBe(before);
  });
});

describe('GET /:wallet_id/recovery-escrow (wallet auth + linked human)', () => {
  it('returns the sealed blob to the linked human', async () => {
    const h = makeHarness();
    h.seedAgentWallet('wallet_aw_linked', USER_ID);
    h.seedEscrow('wallet_aw_linked');
    const path = `${MOUNT}/wallet_aw_linked/recovery-escrow`;
    const res = await request(h.app).get(path).set('Authorization', `Bearer ${buildV2Token('GET', path, '')}`);
    expect(res.status).toBe(200);
    expect(res.body.sealed_key_blob).toBe(REAL_SEALED_BLOB);
    expect(res.body.recovery_anchor_pubkey).toBe(REAL_ANCHOR_PUBKEY);
  });

  it('RED CONTROL: a human who is not the agent\'s linked human is refused (403)', async () => {
    const h = makeHarness();
    h.seedAgentWallet('wallet_aw_other', OTHER_USER); // linked to someone else
    h.seedEscrow('wallet_aw_other');
    const path = `${MOUNT}/wallet_aw_other/recovery-escrow`;
    const res = await request(h.app).get(path).set('Authorization', `Bearer ${buildV2Token('GET', path, '')}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_your_linked_agent');
  });

  it('rejects a request with no wallet auth (401)', async () => {
    const h = makeHarness();
    h.seedAgentWallet('wallet_aw_linked', USER_ID);
    h.seedEscrow('wallet_aw_linked');
    const res = await request(h.app).get(`${MOUNT}/wallet_aw_linked/recovery-escrow`);
    expect(res.status).toBe(401);
  });

  it('returns 404 when the linked human has no escrow yet', async () => {
    const h = makeHarness();
    h.seedAgentWallet('wallet_aw_linked', USER_ID); // linked, but no seedEscrow
    const path = `${MOUNT}/wallet_aw_linked/recovery-escrow`;
    const res = await request(h.app).get(path).set('Authorization', `Bearer ${buildV2Token('GET', path, '')}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_recovery_escrow');
  });
});

describe('GET /:wallet_id/escrow-target — item 11: an un-escrowed agent learns its human\'s published anchor', () => {
  it('no escrow + the linked human published an anchor → the public key (and nothing else) to seal to', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_fleet', USER_ID);
    h.store.set(`human_recovery_anchors/${USER_ID}`, { user_id: USER_ID, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
    const res = await request(h.app).get(`${MOUNT}/wallet_aw_fleet/escrow-target`).set('Authorization', bearer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wallet_id: 'wallet_aw_fleet', escrowed: false, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
  });

  it('already escrowed → escrowed:true, no anchor (never re-escrowed over a working escrow)', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_fleet', USER_ID);
    h.store.set(`human_recovery_anchors/${USER_ID}`, { user_id: USER_ID, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
    h.seedEscrow('wallet_aw_fleet');
    const res = await request(h.app).get(`${MOUNT}/wallet_aw_fleet/escrow-target`).set('Authorization', bearer);
    expect(res.body).toEqual({ wallet_id: 'wallet_aw_fleet', escrowed: true, recovery_anchor_pubkey: null });
  });

  it('RED CONTROL: the human has not published → null with the reason; an unlinked agent → null; another agent\'s wallet → 403', async () => {
    const h = makeHarness();
    const bearer = h.seedAgentWallet('wallet_aw_fleet', USER_ID);
    let res = await request(h.app).get(`${MOUNT}/wallet_aw_fleet/escrow-target`).set('Authorization', bearer);
    expect(res.body).toMatchObject({ escrowed: false, recovery_anchor_pubkey: null, reason: 'human_anchor_not_published' });
    const lone = h.seedAgentWallet('wallet_aw_lone', null);
    h.store.set(`human_recovery_anchors/${OTHER_USER}`, { user_id: OTHER_USER, recovery_anchor_pubkey: REAL_ANCHOR_PUBKEY });
    res = await request(h.app).get(`${MOUNT}/wallet_aw_lone/escrow-target`).set('Authorization', lone);
    expect(res.body).toMatchObject({ escrowed: false, recovery_anchor_pubkey: null, reason: 'not_linked' });
    res = await request(h.app).get(`${MOUNT}/wallet_aw_fleet/escrow-target`).set('Authorization', lone);
    expect(res.status).toBe(403);
  });
});

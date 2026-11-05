/**
 * Regression test for the GET body-hash bug (fixed 2026-06-10).
 *
 * Symptom: every authenticated GET returned 401 "Token body hash mismatch"
 * while every POST succeeded. Root cause: the client signs over the literal
 * body bytes it sends ('' for a GET), but the server's body-hash fallback was
 * `req.body ? JSON.stringify(req.body) : ''`. express.json's body-parser sets
 * req.body = {} for a bodyless request, and {} is truthy, so the server hashed
 * '{}' and never matched the client's sha256(''). These tests mount the real
 * verifier behind express.json (as production does) and assert a no-body GET
 * verifies, while body tampering still fails.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

import { verifyWalletAuthToken, type WalletAuthDeps } from './wallet-auth';

const USER_ID = 'user_bodyhash';
const DEVICE_ID = 'dev_bodyhash';
const AUTH_SECRET = 'shared_secret_bodyhash';

function sign(payload: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

/** Mirror the mobile client: bh = sha256(literal body bytes), '' for no body. */
function clientToken(method: string, path: string, body: string): string {
  const bh = crypto.createHash('sha256').update(body).digest('hex');
  return sign({
    sub: USER_ID,
    device_id: DEVICE_ID,
    iat: Date.now(),
    exp: Date.now() + 60_000,
    jti: crypto.randomBytes(16).toString('hex'),
    mth: method,
    pth: path,
    bh,
  });
}

function buildDeps(): WalletAuthDeps {
  const cacheStore = new Map<string, unknown>();
  const cache: any = {
    isEnabled: () => true,
    setNx: async (key: string) => {
      if (cacheStore.has(key)) return false;
      cacheStore.set(key, true);
      return true;
    },
    getUserAuthSecret: async () => AUTH_SECRET,
    setUserAuthSecret: async () => { /* noop */ },
  };
  const db: any = {
    collection: () => ({ doc: () => ({ async get() { return { exists: false }; } }) }),
    runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => fn({}),
  };
  return { db, cache };
}

/** Mount the verifier behind express.json with the production rawBody capture. */
function buildApp() {
  const deps = buildDeps();
  const app = express();
  app.use(express.json({
    verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));
  const handler = async (req: express.Request, res: express.Response) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : '';
    const result = await verifyWalletAuthToken(token, req, deps);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(200).json({ ok: true, userId: result.userId });
  };
  app.get('/v1/devices', handler);
  app.get('/v1/provenance-envelopes', handler);
  app.post('/v1/agents', handler);
  return app;
}

describe('wallet-auth body-hash binding - GET regression', () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  it('authenticates a no-body GET (the bug: client hashes "", server used to hash "{}")', async () => {
    const app = buildApp();
    const token = clientToken('GET', '/v1/devices', '');
    const res = await request(app)
      .get('/v1/devices')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json'); // client sets this on every request
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('authenticates a GET whose path carries a query string (signed over path sans query)', async () => {
    const app = buildApp();
    // Client signs the bare path; server strips the query before comparing.
    const token = clientToken('GET', '/v1/provenance-envelopes', '');
    const res = await request(app)
      .get('/v1/provenance-envelopes?limit=100&offset=0')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
  });

  it('still authenticates a POST with a real JSON body', async () => {
    const app = buildApp();
    const body = JSON.stringify({ hello: 'world' });
    const token = clientToken('POST', '/v1/agents', body);
    const res = await request(app)
      .post('/v1/agents')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
  });

  it('rejects a POST whose body was tampered after signing (body-hash still enforced)', async () => {
    const app = buildApp();
    const token = clientToken('POST', '/v1/agents', JSON.stringify({ amount: 1 }));
    const res = await request(app)
      .post('/v1/agents')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ amount: 1000000 }));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/body hash/i);
  });
});

describe('wallet-auth token lifetime (2026-10-17)', () => {
  function appWith(ttls: number[]) {
    const cacheStore = new Map<string, unknown>();
    const deps: WalletAuthDeps = {
      cache: {
        isEnabled: () => true,
        setNx: async (key: string, _v: unknown, ttl: number) => {
          ttls.push(ttl);
          if (cacheStore.has(key)) return false;
          cacheStore.set(key, true);
          return true;
        },
        getUserAuthSecret: async () => AUTH_SECRET,
        setUserAuthSecret: async () => { /* noop */ },
      } as any,
      db: { collection: () => ({ doc: () => ({ async get() { return { exists: false }; } }) }) } as any,
    };
    const app = express();
    app.get('/v1/devices', async (req, res) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const result = await verifyWalletAuthToken(token, req, deps);
      res.status(result.ok ? 200 : result.status).json(result.ok ? { ok: true } : { error: result.error });
    });
    return app;
  }
  const tokenWithExp = (exp: unknown) => sign({
    sub: USER_ID, device_id: DEVICE_ID, iat: Date.now(), exp,
    jti: crypto.randomBytes(16).toString('hex'), mth: 'GET', pth: '/v1/devices',
    bh: crypto.createHash('sha256').update('').digest('hex'),
  });

  it('rejects a non-numeric exp (it compared as NaN and never expired)', async () => {
    const res = await request(appWith([])).get('/v1/devices').set('Authorization', `Bearer ${tokenWithExp('never')}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token missing expiry');
  });

  it('rejects an exp more than 15 minutes ahead (a captured long-lived token would outlive its nonce)', async () => {
    const res = await request(appWith([])).get('/v1/devices').set('Authorization', `Bearer ${tokenWithExp(Date.now() + 60 * 60 * 1000)}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token expiry too far ahead');
  });

  it('accepts a 5-minute exp and keeps the consumed jti at least until the token expires', async () => {
    const ttls: number[] = [];
    const res = await request(appWith(ttls)).get('/v1/devices').set('Authorization', `Bearer ${tokenWithExp(Date.now() + 5 * 60 * 1000)}`);
    expect(res.status).toBe(200);
    expect(ttls).toHaveLength(1);
    expect(ttls[0]).toBeGreaterThanOrEqual(5 * 60);
  });

  it('the app\'s own 90-second token still consumes its jti for the standing 120 s', async () => {
    const ttls: number[] = [];
    const res = await request(appWith(ttls)).get('/v1/devices').set('Authorization', `Bearer ${tokenWithExp(Date.now() + 90_000)}`);
    expect(res.status).toBe(200);
    expect(ttls[0]).toBe(120);
  });
});

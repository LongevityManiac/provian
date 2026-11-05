/**
 * the relay's tightened wallet-auth (B1: finite numeric `exp`, at most
 * 15 minutes ahead, jti kept until `exp`) and recover window (B2: numeric request + signed
 * timestamps inside the window) must accept every client that mints them.
 *
 * Only the app mints wallet-auth tokens and calls /v1/users/recover (the agent SDK, daemon,
 * CLI, MCP and Python SDK authenticate with device keys / API keys, which B1/B2 did not touch).
 * Builds 2026101602, 2026101702 and the tree share the same RelayAPIService token and recover
 * code, so binding to the tree's source binds to every installed build. The lifetime the app
 * mints is READ from that source (one source of truth), then run through the real verifier.
 */

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { verifyWalletAuthToken, AUTH_TOKEN_MAX_LIFETIME_MS, type WalletAuthDeps } from './wallet-auth';

const APP_RELAY_CLIENT = resolve(__dirname, '../../../../src/services/RelayAPIService.ts');
const SERVER = resolve(__dirname, '../../server.ts');
const appSource = readFileSync(APP_RELAY_CLIENT, 'utf8');

/** The v2 token the app mints: `const now = Date.now()` … `iat: now, exp: now + N`. */
function appTokenLifetimeMs(source: string): number {
  const v2 = source.slice(source.indexOf('if (RelayAPIService.V2_TOKEN_ENABLED)'));
  expect(source).toMatch(/const now = Date\.now\(\);\s*let payload: string;/);
  const m = v2.match(/iat: now,\s*exp: now \+ ([0-9_]+),/);
  if (!m) throw new Error('app token exp expression not found');
  return Number(m[1].replace(/_/g, ''));
}

const USER_ID = 'user_conformance';
const DEVICE_ID = 'device_0123456789abcdef0123456789abcdef';
const SECRET = 'secret_conformance';

function appToken(clockSkewMs: number, lifetimeMs: number): string {
  // Byte-for-byte the app's v2 payload (RelayAPIService.generateAuthToken), on a phone clock
  // `clockSkewMs` ahead of the relay's.
  const now = Date.now() + clockSkewMs;
  const payload = JSON.stringify({
    sub: USER_ID,
    device_id: DEVICE_ID,
    iat: now,
    exp: now + lifetimeMs,
    jti: crypto.randomUUID(),
    mth: 'GET',
    pth: '/v1/devices',
    bh: crypto.createHash('sha256').update('').digest('hex'),
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
  return `${payloadB64}.${crypto.createHmac('sha256', SECRET).update(payloadB64).digest('hex')}`;
}

function app() {
  const seen = new Set<string>();
  const deps: WalletAuthDeps = {
    cache: {
      isEnabled: () => true,
      setNx: async (k: string) => (seen.has(k) ? false : (seen.add(k), true)),
      getUserAuthSecret: async () => SECRET,
      setUserAuthSecret: async () => undefined,
    } as never,
    db: { collection: () => ({ doc: () => ({ async get() { return { exists: false }; } }) }) } as never,
  };
  const a = express();
  a.get('/v1/devices', async (req, res) => {
    const r = await verifyWalletAuthToken((req.headers.authorization ?? '').replace(/^Bearer /, ''), req, deps);
    res.status(r.ok ? 200 : r.status).json(r.ok ? { ok: true } : { error: r.error });
  });
  return a;
}

describe('every wallet-auth client is accepted by the tightened relay ', () => {
  const lifetime = appTokenLifetimeMs(appSource);

  it('the app mints a numeric ms expiry well inside the 15-minute bound', () => {
    expect(lifetime).toBe(90_000);
    expect(lifetime).toBeLessThan(AUTH_TOKEN_MAX_LIFETIME_MS);
  });

  it.each([0, 60_000, 5 * 60_000, 13 * 60_000])('accepts the app token on a phone clock %d ms fast', async (skew) => {
    const res = await request(app()).get('/v1/devices').set('Authorization', `Bearer ${appToken(skew, lifetime)}`);
    expect(res.status).toBe(200);
  });

  it('accepts the app token on a phone clock up to the token lifetime slow (the pre-B1 bound, unchanged)', async () => {
    const res = await request(app()).get('/v1/devices').set('Authorization', `Bearer ${appToken(-(lifetime - 5_000), lifetime)}`);
    expect(res.status).toBe(200);
  });

  it('NEGATIVE CONTROL: the same token from a clock more than 15 minutes fast is refused (the B1 bound holds)', async () => {
    const res = await request(app()).get('/v1/devices').set('Authorization', `Bearer ${appToken(AUTH_TOKEN_MAX_LIFETIME_MS, lifetime)}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token expiry too far ahead');
  });

  it('NEGATIVE CONTROL: the lifetime reader fails on a token the relay would refuse', () => {
    const mutated = appSource.replace(/exp: now \+ 90_000,/, 'exp: now + 960_000,');
    expect(appTokenLifetimeMs(mutated)).toBeGreaterThan(AUTH_TOKEN_MAX_LIFETIME_MS);
  });
});

describe('the app\'s /v1/users/recover body passes the tightened window ', () => {
  const recover = appSource.slice(appSource.indexOf('private async doRecoverRelayCredentials'));
  const server = readFileSync(SERVER, 'utf8');

  it('the app sends numeric seconds in both the request and the signed message, from one clock read', () => {
    expect(recover).toMatch(/const timestamp = Date\.now\(\);/);
    expect(recover).toMatch(/const tsSeconds = Math\.floor\(timestamp \/ 1000\);/);
    expect(recover).toMatch(/const message = \{\s*user: walletAddress,\s*timestamp: tsSeconds,/);
    expect(recover).toMatch(/wallet_address: walletAddress,\s*timestamp: tsSeconds,/);
  });

  it('the relay still requires numbers and applies the window to both timestamps (B2 stays)', () => {
    const handler = server.slice(server.indexOf("app.post('/v1/users/recover'"));
    expect(handler).toMatch(/typeof timestamp !== 'number' \|\| !Number\.isFinite\(timestamp\)/);
    expect(handler).toMatch(/const tsMs = timestamp < 1e12 \? timestamp \* 1000 : timestamp;/);
    expect(handler).toMatch(/typeof msg\.timestamp !== 'number'/);
    expect(handler).toMatch(/const msgAge = Date\.now\(\) - msgTsMs;/);
  });
});

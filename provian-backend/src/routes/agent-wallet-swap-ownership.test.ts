/**
 * F50/F60 (S2 2026-09-10) — POST /v1/agent/wallet/:wallet_id/swap ownership
 * guard + per-wallet limiter.
 *
 * This was the one remaining /:wallet_id sibling with no self-scope check
 * (closed only /balances) and no per-route limiter, so any agent API key
 * could POST /swap for ANY wallet_id — burning the relay's paid 0x quota against
 * another wallet's address and using quote success/failure as a balance oracle.
 *
 * RED control: a cross-wallet swap gets 403 BEFORE any 0x/upstream call (revert
 * the guard and it would proceed to the quote). Limiter control: an owned-wallet
 * call is 429'd when the per-wallet bucket is exhausted.
 */

import { describe, it, expect } from '@jest/globals';

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
  const collection = (name: string) => ({
    doc: (id: string) => ({
      async get() {
        const d = col(name).get(id);
        return { exists: d !== undefined, id, data: () => d };
      },
      async set(data: Doc) { col(name).set(id, data); },
      async update(patch: Doc) { col(name).set(id, { ...(col(name).get(id) ?? {}), ...patch }); },
    }),
  });
  return { db: { collection } as unknown as import('firebase-admin/firestore').Firestore, col };
}

function makeDeps(db: import('firebase-admin/firestore').Firestore, allowRate = true): RouterDeps {
  return {
    db,
    cache: {
      checkRateLimit: async () => ({ allowed: allowRate, retryAfter: allowRate ? 0 : 30 }),
      checkRateLimitStrict: async () => ({ allowed: true, current: 0, limit: 10 }),
      isEnabled: () => true,
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
    } as unknown as RouterDeps['cache'],
    peBuffer: { enqueue: () => {} },
    recordPEAccrual: async () => {},
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => '0xderived',
  } as unknown as RouterDeps;
}

function seedWallet(col: (n: string) => Map<string, Doc>, id: string): string {
  const creds = generateApiCredentials();
  col('agent_wallets').set(id, {
    id, agent_id: `agent_${id}`, address: `0x${id}`,
    api_key_hash: creds.api_key_hash, api_key_salt: creds.api_key_salt, api_key_prefix: creds.api_key_prefix,
    status: 'active',
  });
  col('api_key_index').set(creds.api_key_prefix, { wallet_id: id });
  return `Bearer ${creds.api_key}:${creds.api_secret}`;
}

function buildApp(allowRate = true) {
  const { db, col } = makeFirestore();
  const app = express();
  app.use(express.json());
  app.use('/v1/agent/wallet', createAgentWalletRouter(makeDeps(db, allowRate)));
  return { app, col };
}

const BODY = { fromToken: 'USDC', toToken: 'WETH', amount: '1000000' };

describe('POST /:wallet_id/swap — F50/F60 ownership + limiter', () => {
  it('RED: a cross-wallet swap is refused (403) before any quote/upstream call', async () => {
    const { app, col } = buildApp();
    const bearerA = seedWallet(col, 'wallet_A');
    seedWallet(col, 'wallet_B');
    const res = await request(app)
      .post('/v1/agent/wallet/wallet_B/swap')
      .set('Authorization', bearerA)
      .send(BODY);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'Access denied - wallet_id mismatch' });
  });

  it('an owned-wallet swap is 429 when the per-wallet quote bucket is exhausted', async () => {
    const { app, col } = buildApp(false); // limiter denies
    const bearerA = seedWallet(col, 'wallet_A');
    const res = await request(app)
      .post('/v1/agent/wallet/wallet_A/swap')
      .set('Authorization', bearerA)
      .send(BODY);
    expect(res.status).toBe(429);
  });
});

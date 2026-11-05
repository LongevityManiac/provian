/**
 * GET /:wallet_id/balances — ownership guard (defense-in-depth).
 *
 * The balances route is agent-API-key authenticated but historically had NO
 * ownership guard, so any authenticated agent could read ANY wallet_id's
 * balances — inconsistent with the sibling `GET /:wallet_id/inbox`, which 403s a
 * wallet_id mismatch. The surfaced values are public on-chain balances (balanceOf,
 * queryable by anyone) so this is low-severity, but every caller already relies on
 * the self-scoped contract (the SDK sends its own walletId; the MCP
 * `get_pvt_balance` tool documents "Self-scoped"). This locks that contract.
 *
 * the cross-wallet 403 is the new assertion; its RED control is that
 * WITHOUT the guard a cross-wallet read does NOT 403 (it proceeds to read the
 * other wallet) — proven by a source stash in the landing commit. The in-suite
 * positive control (a self read passes the guard, served from the cache with no
 * RPC) proves the guard is not hard-wired to reject.
 */

import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createAgentWalletRouter } from './agent-wallet';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import type { RouterDeps } from '../core/agent-wallet/types';

const MOUNT = '/v1/agent/wallet';
const OWNER_ID = 'wallet_aw_owner_aaaaaaaaaaaaaaaaaaaa';
const OTHER_ID = 'wallet_aw_other_bbbbbbbbbbbbbbbbbbbb';
const OWNER_ADDR = '0x1111111111111111111111111111111111111111';

// A cached balances payload keyed on the OWNER — so the positive control (a self
// read) returns 200 deterministically, exercising the guard's pass path with no
// on-chain RPC. The cross-wallet path never reaches the cache (guard returns first).
const CACHED_OWNER_BALANCES = JSON.stringify({
  eth: '1.0', usdc: '2.0',
  pvt9: { status: 'live', address: '0x8811441914381143b9408c5C32247367F86F173A', balance: '5.0', available: true },
  chain: 'base', cached: false, cached_at: 1,
});

function buildApp(): { app: express.Express; auth: string } {
  const fake = createFakeFirestore();

  // Seed the OWNER wallet + its api-key index so authenticateAgent resolves it.
  const cred = generateApiCredentials();
  fake.store.set(`api_key_index/${cred.api_key_prefix}`, { wallet_id: OWNER_ID });
  fake.store.set(`agent_wallets/${OWNER_ID}`, {
    id: OWNER_ID,
    agent_id: 'agent-owner',
    address: OWNER_ADDR,
    status: 'active',
    api_key_prefix: cred.api_key_prefix,
    api_key_hash: cred.api_key_hash,
    api_key_salt: cred.api_key_salt,
  });
  // The OTHER wallet exists and is fully readable — so a missing guard would 200,
  // not 404. The guard, not absence, is what must produce the 403.
  fake.store.set(`agent_wallets/${OTHER_ID}`, {
    id: OTHER_ID, agent_id: 'agent-other', address: '0x2222222222222222222222222222222222222222', status: 'active',
  });

  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
      // Serve the owner's balances from cache so the self read is a deterministic
      // 200 with no RPC. Any other key (incl. the other wallet) misses.
      get: async (key: string) => (key === `balance:v3:${OWNER_ID}` ? CACHED_OWNER_BALANCES : null),
      set: async () => undefined,
      del: async () => undefined,
    },
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => OWNER_ADDR,
  } as unknown as RouterDeps;

  const app = express();
  app.use(express.json());
  app.use(MOUNT, createAgentWalletRouter(deps));
  return { app, auth: `Bearer ${cred.api_key}:${cred.api_secret}` };
}

describe('GET /:wallet_id/balances — ownership guard', () => {
  it('403s a cross-wallet balances read (authenticated as OWNER, requesting OTHER)', async () => {
    const { app, auth } = buildApp();
    const res = await request(app).get(`${MOUNT}/${OTHER_ID}/balances`).set('Authorization', auth);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied - wallet_id mismatch' });
  });

  it('positive control — a self read passes the guard (200 from cache, no RPC)', async () => {
    const { app, auth } = buildApp();
    const res = await request(app).get(`${MOUNT}/${OWNER_ID}/balances`).set('Authorization', auth);
    // Not 403: the guard let the self request through to the balances logic, which
    // the cache satisfied. Proves the guard is not hard-wired to reject.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ eth: '1.0', usdc: '2.0', cached: true });
    expect(res.body.error).toBeUndefined();
  });

  it('still requires agent auth (no header → 401, before any ownership check)', async () => {
    const { app } = buildApp();
    const res = await request(app).get(`${MOUNT}/${OTHER_ID}/balances`);
    expect(res.status).toBe(401);
  });
});

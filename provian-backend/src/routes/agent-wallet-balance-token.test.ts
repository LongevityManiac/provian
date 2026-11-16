/**
 * GET /:wallet_id/balances — the release-forward token rule.
 *
 * A request without `?token=` is the contract every copy released before the
 * protocol pointer was compiled against: it must keep reading the predecessor
 * token in the `pvt9` shape and never a successor balance. A pointer-aware
 * client names the live kernel it resolved itself; the relay refuses a
 * malformed or repeated token (400) and a kernel it does not agree is current
 * (409) before any wallet or cache read, and a token-bound answer is the
 * balance on that kernel under a cache key bound to the token.
 *
 * RED controls: the "stale token" case asserts no cache key and no chain read was
 * touched; with the 409 check removed from the route it reaches the cache and the
 * stale-kernel read and fails. The legacy case asserts the predecessor address is
 * the one read, so a route that followed the pointer for unqualified requests
 * fails it.
 */

import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createAgentWalletRouter } from './agent-wallet';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { generateApiCredentials } from '../core/agent-wallet/api-key';
import type { RouterDeps } from '../core/agent-wallet/types';
import { PVT9_BASE_CONFIG } from '../core/pvt/pvt9-base-config.generated';

const MOUNT = '/v1/agent/wallet';
const OWNER_ID = 'wallet_aw_owner_aaaaaaaaaaaaaaaaaaaa';
const OWNER_ADDR = '0x1111111111111111111111111111111111111111';
const KERNEL = '0x2Af3A065dc3c0c51b054Cb8C6BAEE7Df76189e0e';
const STALE = '0x3333333333333333333333333333333333333333';
const PREDECESSOR = PVT9_BASE_CONFIG.assets.pvt9.address;
const USDC = PVT9_BASE_CONFIG.assets.usdc.address;

interface Harness {
  app: express.Express;
  auth: string;
  cacheGets: string[];
  cacheSets: Array<{ key: string; value: unknown }>;
  erc20Reads: string[];
  store: Map<string, unknown>;
}

function build(opts: { kernel?: () => Promise<string>; seed?: Record<string, unknown>; failKernelRead?: boolean } = {}): Harness {
  const fake = createFakeFirestore();
  const cred = generateApiCredentials();
  fake.store.set(`api_key_index/${cred.api_key_prefix}`, { wallet_id: OWNER_ID });
  fake.store.set(`agent_wallets/${OWNER_ID}`, {
    id: OWNER_ID, agent_id: 'agent-owner', address: OWNER_ADDR, status: 'active',
    api_key_prefix: cred.api_key_prefix, api_key_hash: cred.api_key_hash, api_key_salt: cred.api_key_salt,
  });
  const store = new Map<string, unknown>(Object.entries(opts.seed ?? {}));
  const cacheGets: string[] = [];
  const cacheSets: Array<{ key: string; value: unknown }> = [];
  const erc20Reads: string[] = [];
  const balances: Record<string, bigint> = {
    [USDC.toLowerCase()]: 2_500_000n,
    [PREDECESSOR.toLowerCase()]: 7n * 10n ** 18n,
    [KERNEL.toLowerCase()]: 1234n * 10n ** 17n,
    [STALE.toLowerCase()]: 999n * 10n ** 18n,
  };
  const deps = {
    db: fake as unknown as Firestore,
    cache: {
      isEnabled: () => true,
      checkRateLimit: async () => ({ allowed: true, retryAfter: 0 }),
      get: async (key: string) => { cacheGets.push(key); return store.get(key) ?? null; },
      set: async (key: string, value: unknown) => { cacheSets.push({ key, value }); store.set(key, value); },
      del: async () => undefined,
    },
    peBuffer: { enqueue: () => undefined },
    recordPEAccrual: async () => undefined,
    keccak256: (b: Buffer) => b,
    deriveAddressFromPublicKey: () => OWNER_ADDR,
    currentPvtKernel: opts.kernel ?? (async () => KERNEL),
    readBaseBalances: {
      native: async () => 10n ** 15n,
      erc20: async (token: string, owner: string) => {
        expect(owner).toBe(OWNER_ADDR);
        erc20Reads.push(token.toLowerCase());
        const value = balances[token.toLowerCase()];
        if (value === undefined) throw new Error(`unexpected token ${token}`);
        if (opts.failKernelRead && token.toLowerCase() === KERNEL.toLowerCase()) throw new Error('base RPC unavailable');
        return value;
      },
    },
  } as unknown as RouterDeps;
  const app = express();
  app.use(express.json());
  app.use(MOUNT, createAgentWalletRouter(deps));
  return { app, auth: `Bearer ${cred.api_key}:${cred.api_secret}`, cacheGets, cacheSets, erc20Reads, store };
}

const path = (query = '') => `${MOUNT}/${OWNER_ID}/balances${query}`;

describe('GET /:wallet_id/balances — release-forward token rule', () => {
  it('no token: the predecessor read and the legacy pvt9 shape, unchanged', async () => {
    const h = build({ kernel: async () => { throw new Error('legacy requests never consult the pointer'); } });
    const res = await request(h.app).get(path()).set('Authorization', h.auth);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['eth', 'usdc', 'pvt9', 'chain', 'cached', 'cached_at']);
    expect(res.body).toMatchObject({
      eth: '0.001', usdc: '2.5', chain: 'base', cached: false,
      pvt9: { status: PVT9_BASE_CONFIG.status, address: PREDECESSOR, balance: '7.0', available: true },
    });
    expect(res.body.pvt).toBeUndefined();
    expect(h.erc20Reads).toEqual([USDC.toLowerCase(), PREDECESSOR.toLowerCase()]);
    expect(h.cacheGets).toEqual([`balance:v3:${OWNER_ID}`]);
    expect(h.cacheSets.map(s => s.key)).toEqual([`balance:v3:${OWNER_ID}`]);
  });

  it('token = live kernel: the balance on that kernel, token-bound cache key', async () => {
    const h = build();
    const res = await request(h.app).get(path(`?token=${KERNEL.toLowerCase()}`)).set('Authorization', h.auth);
    expect(res.status).toBe(200);
    const token = KERNEL.toLowerCase();
    expect(res.body).toMatchObject({
      eth: '0.001', usdc: '2.5', chain: 'base', cached: false, token_address: token, chain_id: 8453,
      pvt: { status: 'live', address: token, balance: '123.4', available: true },
    });
    expect(res.body.pvt9).toBeUndefined();
    expect(h.erc20Reads).toEqual([USDC.toLowerCase(), token]);
    expect(h.erc20Reads).not.toContain(PREDECESSOR.toLowerCase());
    expect(h.cacheGets).toEqual([`balance:v4:8453:${token}:${OWNER_ID}`]);
    expect(h.cacheSets.map(s => s.key)).toEqual([`balance:v4:8453:${token}:${OWNER_ID}`]);
  });

  it('a checksummed live-kernel token is the same token', async () => {
    const h = build();
    const res = await request(h.app).get(path(`?token=${KERNEL}`)).set('Authorization', h.auth);
    expect(res.status).toBe(200);
    expect(res.body.token_address).toBe(KERNEL.toLowerCase());
  });

  it('the legacy cache entry never answers a token-bound request, nor the reverse', async () => {
    const legacy = JSON.stringify({ eth: '9', usdc: '9', pvt9: { status: 'live', address: PREDECESSOR, balance: '9.0', available: true }, chain: 'base', cached: false, cached_at: 1 });
    const h = build({ seed: { [`balance:v3:${OWNER_ID}`]: legacy } });
    const bound = await request(h.app).get(path(`?token=${KERNEL}`)).set('Authorization', h.auth);
    expect(bound.status).toBe(200);
    expect(bound.body.cached).toBe(false);
    expect(bound.body.pvt.balance).toBe('123.4');
    const unbound = await request(h.app).get(path()).set('Authorization', h.auth);
    expect(unbound.body).toMatchObject({ cached: true, pvt9: { balance: '9.0' } });
    expect(unbound.body.pvt).toBeUndefined();
  });

  it('stale token: 409 before any cache or chain read', async () => {
    const h = build();
    const res = await request(h.app).get(path(`?token=${STALE}`)).set('Authorization', h.auth);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'PVT token changed; refresh protocol discovery' });
    expect(h.cacheGets).toEqual([]);
    expect(h.cacheSets).toEqual([]);
    expect(h.erc20Reads).toEqual([]);
  });

  it('stale token with a poisoned token-bound cache entry: still 409, the entry is never read', async () => {
    const poisoned = JSON.stringify({ eth: '1', usdc: '1', pvt: { status: 'live', address: STALE.toLowerCase(), balance: '999.0', available: true }, chain: 'base' });
    const h = build({ seed: { [`balance:v4:8453:${STALE.toLowerCase()}:${OWNER_ID}`]: poisoned } });
    const res = await request(h.app).get(path(`?token=${STALE}`)).set('Authorization', h.auth);
    expect(res.status).toBe(409);
    expect(h.cacheGets).toEqual([]);
  });

  it.each([
    ['not an address', '?token=not-an-address'],
    ['empty', '?token='],
    ['repeated', `?token=${KERNEL}&token=${KERNEL}`],
    ['bad checksum', `?token=${KERNEL.replace('A', 'a')}`],
  ])('malformed token (%s): 400 before any read', async (_name, query) => {
    const h = build();
    const res = await request(h.app).get(path(query)).set('Authorization', h.auth);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid token address' });
    expect(h.cacheGets).toEqual([]);
    expect(h.erc20Reads).toEqual([]);
  });

  it('unverifiable pointer: 503, never a guessed kernel', async () => {
    const h = build({ kernel: async () => { throw new Error('protocol_verification_unavailable'); } });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(h.app).get(path(`?token=${KERNEL}`)).set('Authorization', h.auth);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'PVT token discovery unavailable' });
      expect(h.cacheGets).toEqual([]);
      expect(h.erc20Reads).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a failed kernel read is fail-visible on the token-bound shape', async () => {
    const h = build({ failKernelRead: true });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await request(h.app).get(path(`?token=${KERNEL}`)).set('Authorization', h.auth);
      expect(res.status).toBe(200);
      expect(res.body.pvt).toEqual({ status: 'live', address: KERNEL.toLowerCase(), balance: null, available: false, reason: 'PVT_READ_FAILED' });
      expect(res.body.pvt9).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('the ownership guard still fires first (cross-wallet token read is 403)', async () => {
    const h = build();
    const res = await request(h.app).get(`${MOUNT}/wallet_aw_other_bbbbbbbbbbbbbbbbbbbb/balances?token=${STALE}`).set('Authorization', h.auth);
    expect(res.status).toBe(403);
    expect(h.cacheGets).toEqual([]);
  });
});

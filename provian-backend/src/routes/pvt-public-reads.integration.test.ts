/**
 * THE VERIFICATION FOR THE PVT PUBLIC READ SURFACE — the mount, not the mount line.
 *
 * WHAT THIS BINDS TO, AND WHAT IT CANNOT. `provian-backend/src/server.ts` cannot
 * be imported under jest: it calls `app.listen(PORT)` and starts intervals at
 * module scope, and it constructs Firestore/Redis clients at import. So "the
 * REAL server app" is bound here by TWO halves that must both be green, neither
 * of which can be satisfied by a test that assembles its own routes:
 *
 * 1. BEHAVIOR — every request below is driven through `mountPvtPublicReads`,
 * the exact function `server.ts` calls. Drop a router from that function
 * and this file goes red. That is the FC-011 defect closed: the older
 * `pvt-estimate.test.ts` hand-mounted `createPVTEstimateRouter` itself, so
 * it stayed green for the entire period the router had no mount at all.
 * 2. THE CALL SITE — `pvt-public-reads.mount.source.test.ts` pins that
 * `server.ts` actually calls `mountPvtPublicReads(` and that the call comes
 * AFTER `app.use(createPvt9RuntimeBoundary())`. Delete the mount from
 * server.ts and THAT file goes red.
 *
 * Neither half is sufficient alone, and the split is stated rather than papered
 * over: half 1 cannot see server.ts, half 2 cannot execute a request.
 *
 * Per the ruling, there is no Redis-unavailable control here: `checkRateLimit`
 * fails OPEN by design, so a "Redis down closes the surface" assertion would be
 * asserting a false premise.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import type { RedisCache } from '../cache';
import { createPvt9RuntimeBoundary } from '../core/pvt/wp2-runtime-boundary';
import {
  PVT_PUBLIC_READ_MOUNT_PATH,
  mountPvtPublicReads,
  type PvtPublicReadDeps,
} from './pvt-public-reads';

const PROBE_ADDRESS = '0x8b2306be03bA3ACAA81a891f9c3749df5eF66c61';

interface CacheOptions {
  rateLimited?: boolean;
  rateLimitThrows?: boolean;
  /** Seed the balance cache so a hit can be observed. */
  seed?: Record<string, unknown>;
}

function createCache(options: CacheOptions = {}) {
  const store = new Map<string, unknown>(Object.entries(options.seed ?? {}));
  const writes: Array<{ key: string; value: unknown; ttl: number }> = [];
  const cache = {
    // The milestones handler short-circuits on a cache hit, which is what keeps
    // this suite off Firestore. Every other key comes from `store`.
    get: jest.fn(async (key: string) => (key === 'pvt:milestones'
      ? { milestones: [], updated_at: 0 }
      : store.get(key) ?? null)),
    set: jest.fn(async (key: string, value: unknown, ttl: number) => {
      writes.push({ key, value, ttl });
      store.set(key, value);
    }),
    checkRateLimit: jest.fn(async () => {
      if (options.rateLimitThrows) throw new Error('redis unavailable');
      return options.rateLimited
        ? { allowed: false, current: 61, limit: 60, retryAfter: 30 }
        : { allowed: true, current: 1, limit: 60 };
    }),
  } as unknown as RedisCache;
  return { cache, writes, store };
}

function createDeps(
  options: CacheOptions = {},
  overrides: Partial<PvtPublicReadDeps> = {},
): PvtPublicReadDeps {
  const { cache } = createCache(options);

  const db = {
    collection: jest.fn(() => { throw new Error('firestore_not_expected_in_this_suite'); }),
  } as unknown as PvtPublicReadDeps['db'];

  return {
    db,
    cache,
    peBuffer: { enqueue: jest.fn() },
    readPvt9Balance: jest.fn(async () => 74_992_500_000_000_000_000n),
    ...overrides,
  } as unknown as PvtPublicReadDeps;
}

/** The app under test, assembled the way server.ts assembles it. */
function buildApp(options: { probe?: RequestHandler; deps?: PvtPublicReadDeps } = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(createPvt9RuntimeBoundary());
  if (options.probe) app.use(options.probe);
  mountPvtPublicReads(app, options.deps ?? createDeps());
  return app;
}

/**
 * The seven endpoints the ruling opens at flip, each with the status that proves
 * the request REACHED its handler. `allocation` answers 401 because it reached
 * the dual-auth middleware with no credential — a 404 there would mean the gate,
 * not the auth, answered.
 */
const OPENED: ReadonlyArray<{ label: string; url: string; openStatus: number }> = [
  { label: 'estimate', url: '/v1/pvt/estimate?action_type=agent_tool_orchestration&attestation_tier=software', openStatus: 200 },
  { label: 'milestones', url: '/v1/pvt/milestones', openStatus: 200 },
  { label: 'weights', url: '/v1/pvt/weights', openStatus: 200 },
  { label: 'weights/overrides', url: '/v1/pvt/weights/overrides', openStatus: 200 },
  { label: 'attestation-tiers', url: '/v1/pvt/attestation-tiers', openStatus: 200 },
  { label: 'balance/:address', url: `/v1/pvt/balance/${PROBE_ADDRESS}`, openStatus: 200 },
  { label: 'allocation/:wallet_id', url: '/v1/pvt/allocation/wallet-1', openStatus: 401 },
];

/** Deliberately NOT re-mounted. The runtime boundary boundary refuses them before any route. */
const STAY_DARK = ['/v1/pvt/stats', '/v1/pvt/tokenomics', '/v1/pvt/mint-history'];

/**
 * Every value that must read as CLOSED. Only the exact string `'true'` opens the
 * surface — the M10 fail-closed convention, restated as a table so a regression
 * that starts coercing truthiness fails on the specific value it accepted.
 */
const CLOSED_LAUNCH_VALUES: ReadonlyArray<[string, string | undefined]> = [
  ['unset', undefined],
  ["'false'", 'false'],
  ["'TRUE'", 'TRUE'],
  ["'1'", '1'],
  ["'yes'", 'yes'],
  ["' true '", ' true '],
];

function setLaunch(value: string | undefined): void {
  if (value === undefined) delete process.env.PUBLIC_LAUNCH;
  else process.env.PUBLIC_LAUNCH = value;
}

describe('PVT public read surface — the mount server.ts uses', () => {
  let priorLaunch: string | undefined;

  beforeEach(() => { priorLaunch = process.env.PUBLIC_LAUNCH; });
  afterEach(() => { setLaunch(priorLaunch); });

  it('opens exactly seven endpoints — the population this suite quantifies over', () => {
    expect(OPENED).toHaveLength(7);
    expect(STAY_DARK).toHaveLength(3);
    expect(CLOSED_LAUNCH_VALUES).toHaveLength(6);
    expect(PVT_PUBLIC_READ_MOUNT_PATH).toBe('/v1/pvt');
  });

  describe('post-flip: every opened endpoint reaches its handler', () => {
    it.each(OPENED)('$label → $openStatus with PUBLIC_LAUNCH=true', async ({ url, openStatus }) => {
      setLaunch('true');
      const res = await request(buildApp()).get(url);
      expect(res.status).toBe(openStatus);
    });
  });

  describe('pre-flip: every opened endpoint is 404, for every closed value', () => {
    it.each(
      CLOSED_LAUNCH_VALUES.flatMap(([label, value]) =>
        OPENED.map((route) => [`${route.label} @ PUBLIC_LAUNCH ${label}`, value, route.url] as const)),
    )('%s → 404', async (_label, value, url) => {
      setLaunch(value);
      const res = await request(buildApp()).get(url);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not found' });
    });
  });

  /**
   * THE NEGATIVE CONTROL for every closed assertion above. With BOTH gate
   * functions the routers import severed — replaced by pass-throughs — the same
   * closed values must now let the request through. If this describe were green
   * while the gates were intact, the closed assertions above would be proving
   * nothing.
   *
   * It severs the REAL module both routers import, not a replica of it. Both
   * `publicDiscoveryGate` (estimate/overrides/attestation-tiers) AND
   * `appClientDiscoveryGate` (milestones/weights/balance/allocation) are
   * severed, since the four app-consumed reads now carry the latter.
   */
  describe('negative control: with the gate severed, the closed cases stop closing', () => {
    it.each(OPENED)('$label is reachable with PUBLIC_LAUNCH unset once the gate is severed', async ({ url, openStatus }) => {
      setLaunch(undefined);
      let app!: Express;
      jest.isolateModules(() => {
        jest.doMock('./middleware/public-launch-gate', () => ({
          ...jest.requireActual<object>('./middleware/public-launch-gate'),
          publicDiscoveryGate: () => ((_req: unknown, _res: unknown, next: () => void) => next()),
          appClientDiscoveryGate: () => ((_req: unknown, _res: unknown, next: () => void) => next()),
        }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
        const severed = require('./pvt-public-reads') as typeof import('./pvt-public-reads');
        const built = express();
        built.use(express.json());
        built.use(createPvt9RuntimeBoundary());
        severed.mountPvtPublicReads(built, createDeps());
        app = built;
      });
      const res = await request(app).get(url);
      expect(res.status).toBe(openStatus);
      expect(res.status).not.toBe(404);
    });

    afterEach(() => { jest.resetModules(); });
  });

  /**
   * : the FOUR reads the phone app consumes —
   * milestones, weights, balance, allocation — must serve a wallet-authed caller
   * BEFORE the flip, while the same request from an ANONYMOUS caller still 404s
   * (public-web non-disclosure unchanged). The other three stay flip-only: a
   * credential does NOT open them pre-flip.
   *
   * `openStatus` is the SAME "reached its handler" status as post-flip: 200 for
   * the no-auth reads, 401 for allocation (it passed the discovery gate and hit
   * dual-auth, which refuses the throwaway Bearer) — a 404 would mean the gate,
   * not the auth, answered.
   */
  const APP_CONSUMED = new Set(['milestones', 'weights', 'balance/:address', 'allocation/:wallet_id']);
  describe('app-consumed reads serve a credentialed caller pre-flip', () => {
    it.each(OPENED.filter((r) => APP_CONSUMED.has(r.label)))(
      '$label reaches its handler with PUBLIC_LAUNCH unset + a Bearer credential',
      async ({ url, openStatus }) => {
        setLaunch(undefined);
        const res = await request(buildApp()).get(url).set('Authorization', 'Bearer throwaway-app-token');
        expect(res.status).toBe(openStatus);
        expect(res.status).not.toBe(404);
      },
    );

    // RED CONTROL: the SAME endpoint, SAME closed flip, but NO credential → 404.
    // Without this, the pass above could not distinguish "credential opened it"
    // from "the gate never closed".
    it.each(OPENED.filter((r) => APP_CONSUMED.has(r.label)))(
      '$label is 404 pre-flip for an ANONYMOUS caller (no credential)',
      async ({ url }) => {
        setLaunch(undefined);
        const res = await request(buildApp()).get(url);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'not found' });
      },
    );

    // The public-only three stay flip-gated: a credential does NOT open them.
    it.each(OPENED.filter((r) => !APP_CONSUMED.has(r.label)))(
      '$label stays 404 pre-flip even WITH a Bearer credential (flip-only, not app-consumed)',
      async ({ url }) => {
        setLaunch(undefined);
        const res = await request(buildApp()).get(url).set('Authorization', 'Bearer throwaway-app-token');
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'not found' });
      },
    );
  });

  describe('stats, tokenomics and mint-history stay dark — refused by the boundary', () => {
    it.each(STAY_DARK)('%s → 503 PVT9_DEPENDENCY_UNAVAILABLE even with PUBLIC_LAUNCH=true', async (path) => {
      // PUBLIC_LAUNCH is OPEN here on purpose: it proves the refusal comes from
      // the runtime boundary, not from the launch gate.
      setLaunch('true');
      const res = await request(buildApp()).get(path);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PVT9_DEPENDENCY_UNAVAILABLE');
    });
  });

  /**
   * THE LIMITER AND THE CACHE. Review found both mutations survived the entire
   * tree: deleting `limit,` from all six routes, and bypassing
   * `readCachedPvt9Balance`, each left `check:wp2` ok and backend jest
   * identical. They were untested code protecting an unauthenticated surface
   * that spends the settlement runtime's own Base RPC quota.
   */
  describe('per-IP rate limit', () => {
    const LIMITED = OPENED.filter((r) => r.label !== 'estimate');

    it('covers every route in THIS router — estimate has its own limiter', () => {
      expect(LIMITED).toHaveLength(6);
    });

    it.each(LIMITED)('$label → 429 when the per-IP budget is spent', async ({ url }) => {
      setLaunch('true');
      const res = await request(buildApp({ deps: createDeps({ rateLimited: true }) })).get(url);
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('Rate limit exceeded');
    });

    it('the budget is the documented 60 per 60s, on one shared bucket', async () => {
      setLaunch('true');
      const { cache } = createCache();
      const deps = createDeps();
      (deps as { cache: RedisCache }).cache = cache;
      await request(buildApp({ deps })).get('/v1/pvt/weights');
      const call = (cache.checkRateLimit as unknown as jest.Mock).mock.calls[0];
      expect(String(call[0])).toMatch(/^rl:pvt-public-read:/);
      expect(call[1]).toBe(60);
      expect(call[2]).toBe(60);
    });

    it('FAILS OPEN when Redis throws — matching every other limiter in the tree', async () => {
      setLaunch('true');
      const res = await request(buildApp({ deps: createDeps({ rateLimitThrows: true }) }))
        .get('/v1/pvt/weights');
      expect(res.status).toBe(200);
    });

    it('NEGATIVE CONTROL: an allowing limiter does not 429', async () => {
      setLaunch('true');
      const res = await request(buildApp()).get('/v1/pvt/weights');
      expect(res.status).toBe(200);
    });
  });

  describe('PVT9 balance cache', () => {
    const KEY = `pvt9:balance:${PROBE_ADDRESS.toLowerCase()}`;
    const BALANCE_URL = `/v1/pvt/balance/${PROBE_ADDRESS}`;

    it('writes { wei } — NOT a bare digit string, which Upstash returns as a number', async () => {
      setLaunch('true');
      const { cache, writes } = createCache();
      const chain = jest.fn(async () => 74_992_500_000_000_000_000n);
      const deps = createDeps({}, { readPvt9Balance: chain });
      (deps as { cache: RedisCache }).cache = cache;

      const res = await request(buildApp({ deps })).get(BALANCE_URL);
      expect(res.status).toBe(200);
      const write = writes.find((w) => w.key === KEY);
      expect(write).toBeDefined();
      expect(write!.value).toEqual({ wei: '74992500000000000000' });
      expect(write!.ttl).toBe(30);

      // The shape that broke: a bare digit string round-trips through
      // JSON.parse as a NUMBER, so a `typeof === 'string'` read never hits.
      expect(typeof write!.value).not.toBe('string');
      expect(typeof JSON.parse(JSON.stringify('74992500000000000000'))).toBe('string');
      expect(typeof JSON.parse('74992500000000000000')).toBe('number');
    });

    it('a SECOND request for the same address does not touch the chain', async () => {
      setLaunch('true');
      const { cache } = createCache();
      const chain = jest.fn(async () => 74_992_500_000_000_000_000n);
      const deps = createDeps({}, { readPvt9Balance: chain });
      (deps as { cache: RedisCache }).cache = cache;
      const app = buildApp({ deps });

      const first = await request(app).get(BALANCE_URL);
      const second = await request(app).get(BALANCE_URL);
      expect(first.body).toEqual(second.body);
      expect(second.body.balance_raw).toBe('74992500000000000000');
      expect(chain).toHaveBeenCalledTimes(1);
    });

    it('a poisoned or malformed entry falls through to the chain, never a 500', async () => {
      setLaunch('true');
      for (const poison of [
        { wei: 'not-a-number' },
        { wei: 74_992_500_000_000_000_000 },
        { wei: '12e5' },
        'bare-string',
        null,
      ]) {
        const chain = jest.fn(async () => 1_000_000_000_000_000_000n);
        const deps = createDeps({ seed: { [KEY]: poison } }, { readPvt9Balance: chain });
        const res = await request(buildApp({ deps })).get(BALANCE_URL);
        expect(res.status).toBe(200);
        expect(res.body.balance_raw).toBe('1000000000000000000');
        expect(chain).toHaveBeenCalledTimes(1);
      }
    });

    it('NEGATIVE CONTROL: with no cache hit the chain IS called each time', async () => {
      setLaunch('true');
      const chain = jest.fn(async () => 5n);
      // A cache that never retains anything — the pre-fix behaviour.
      const cache = {
        get: jest.fn(async () => null),
        set: jest.fn(async () => undefined),
        checkRateLimit: jest.fn(async () => ({ allowed: true, current: 1, limit: 60 })),
      } as unknown as RedisCache;
      const deps = createDeps({}, { readPvt9Balance: chain });
      (deps as { cache: RedisCache }).cache = cache;
      const app = buildApp({ deps });
      await request(app).get(BALANCE_URL);
      await request(app).get(BALANCE_URL);
      expect(chain).toHaveBeenCalledTimes(2);
    });
  });

  describe('mount order: the boundary is reached before the route', () => {
    it('a blocked PVT path never reaches the routes; an opened one does', async () => {
      setLaunch('true');
      const reached: string[] = [];
      const probe: RequestHandler = (req, _res, next) => { reached.push(req.path); next(); };

      const blocked = await request(buildApp({ probe })).get('/v1/pvt/stats');
      expect(blocked.status).toBe(503);
      expect(reached).toEqual([]);

      const opened = await request(buildApp({ probe })).get('/v1/pvt/weights');
      expect(opened.status).toBe(200);
      expect(reached).toEqual(['/v1/pvt/weights']);
    });

    it('NEGATIVE CONTROL: a route registered AHEAD of the boundary bypasses it entirely', async () => {
      setLaunch('true');
      // The assertion above says a blocked path never reaches a route. That is
      // only meaningful if a route COULD have served it. So: the same route, at
      // the same blocked path `/v1/pvt/stats`, registered on each side of the
      // boundary. Ahead of it the boundary is bypassed and the route answers
      // 200; behind it the boundary refuses with 503 and the route never runs.
      const served: RequestHandler = (_req, res) => { res.status(200).json({ served: true }); };

      const ahead = express();
      ahead.get('/v1/pvt/stats', served);
      ahead.use(createPvt9RuntimeBoundary());
      const bypassed = await request(ahead).get('/v1/pvt/stats');
      expect(bypassed.status).toBe(200);
      expect(bypassed.body).toEqual({ served: true });

      const behind = express();
      behind.use(createPvt9RuntimeBoundary());
      behind.get('/v1/pvt/stats', served);
      const refused = await request(behind).get('/v1/pvt/stats');
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe('PVT9_DEPENDENCY_UNAVAILABLE');
    });
  });
});

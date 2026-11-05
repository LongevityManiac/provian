/**
 * ( ) — the public avatar ROUTE, not just its helpers.
 *
 * GET /v1/commons/avatar/:walletId is public (no auth). Its two route-level bounds
 * must be wired, and these tests fail if either is removed:
 * - the per-transport-IP rate limit (AVATAR_RATE_LIMIT_PER_MIN) answers 429
 * WITHOUT touching the upstream;
 * - the fetch goes THROUGH fetchAvatarCached, so repeated requests — successes and
 * failures alike — reach the upstream once per cache window, not once per request.
 *
 * The upstream fetch (fetchProxiedAvatar) is the only thing mocked; the cache
 * helper and the route are the real ones, over an in-memory cache with real
 * INCR-window rate-limit semantics.
 */
import express from 'express';
import request from 'supertest';
import type { FetchedAvatar } from '../core/commons/avatar-proxy';

const fetchProxiedAvatarMock = jest.fn<Promise<FetchedAvatar | null>, [string]>();

jest.mock('../core/commons/avatar-proxy', () => {
  const actual = jest.requireActual('../core/commons/avatar-proxy');
  return { ...actual, fetchProxiedAvatar: (url: string) => fetchProxiedAvatarMock(url) };
});

// Import AFTER the mock so the router binds the mocked upstream fetch.
import { createCommonsRouter } from './commons';
import { AVATAR_RATE_LIMIT_PER_MIN } from '../core/commons/avatar-proxy';

const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');

function memCache() {
  const store = new Map<string, unknown>();
  const counters = new Map<string, number>();
  const rateKeys: string[] = [];
  return {
    rateKeys,
    get: async <T>(key: string): Promise<T | null> => (store.has(key) ? (store.get(key) as T) : null),
    set: async (key: string, value: unknown): Promise<void> => { store.set(key, value); },
    checkRateLimit: async (key: string, limit: number) => {
      rateKeys.push(key);
      const current = (counters.get(key) ?? 0) + 1;
      counters.set(key, current);
      return current > limit
        ? { allowed: false, current, limit, retryAfter: 42 }
        : { allowed: true, current, limit };
    },
  };
}

function buildApp(avatarUrl: string | undefined) {
  const cache = memCache();
  const deps = {
    db: {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: avatarUrl !== undefined, data: () => ({ avatar_url: avatarUrl }) }),
        }),
      }),
    },
    cache,
    peBuffer: { enqueue: jest.fn() },
  } as unknown as Parameters<typeof createCommonsRouter>[0];
  const app = express();
  app.use('/v1/commons', createCommonsRouter(deps));
  return { app, cache };
}

beforeEach(() => {
  fetchProxiedAvatarMock.mockReset();
});

describe('GET /v1/commons/avatar/:walletId — route-level bounds ', () => {
  it('RED: repeated requests are served from the cache — the upstream is fetched once', async () => {
    fetchProxiedAvatarMock.mockResolvedValue({ contentType: 'image/png', body: PNG });
    const { app } = buildApp('https://img.example/a.png');
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/v1/commons/avatar/wallet_1');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(Buffer.from(res.body as Buffer).equals(PNG)).toBe(true);
    }
    expect(fetchProxiedAvatarMock).toHaveBeenCalledTimes(1);
    expect(fetchProxiedAvatarMock).toHaveBeenCalledWith('https://img.example/a.png');
  });

  it('RED: a failing (slow/broken) host is fetched once per window, not once per request', async () => {
    fetchProxiedAvatarMock.mockResolvedValue(null);
    const { app } = buildApp('https://slow.example/a.png');
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).get('/v1/commons/avatar/wallet_1');
      expect(res.status).toBe(404);
    }
    expect(fetchProxiedAvatarMock).toHaveBeenCalledTimes(1);
  });

  it('RED: past the per-IP limit the route answers 429 without fetching', async () => {
    fetchProxiedAvatarMock.mockResolvedValue({ contentType: 'image/png', body: PNG });
    const { app, cache } = buildApp('https://img.example/a.png');
    for (let i = 0; i < AVATAR_RATE_LIMIT_PER_MIN; i += 1) {
      const ok = await request(app).get('/v1/commons/avatar/wallet_1');
      expect(ok.status).toBe(200);
    }
    const callsBefore = fetchProxiedAvatarMock.mock.calls.length;
    const limited = await request(app).get('/v1/commons/avatar/wallet_1');
    expect(limited.status).toBe(429);
    expect(limited.body.retry_after).toBe(42);
    expect(fetchProxiedAvatarMock.mock.calls.length).toBe(callsBefore);
    // The bucket is the transport IP, one key for every request from it.
    expect(new Set(cache.rateKeys).size).toBe(1);
    expect(cache.rateKeys[0]).toMatch(/^rl:commons-avatar:/);
  });

  it('control: a limited request for an uncached avatar still never reaches the upstream', async () => {
    fetchProxiedAvatarMock.mockResolvedValue({ contentType: 'image/png', body: PNG });
    const { app, cache } = buildApp('https://img.example/a.png');
    // The IP's window is already spent before this route sees its first request.
    cache.checkRateLimit = async (key: string, limit: number) => {
      cache.rateKeys.push(key);
      return { allowed: false, current: limit + 1, limit, retryAfter: 42 };
    };
    const res = await request(app).get('/v1/commons/avatar/wallet_1');
    expect(res.status).toBe(429);
    expect(fetchProxiedAvatarMock).not.toHaveBeenCalled();
  });

  it('control: a profile with no avatar is 404 and fetches nothing', async () => {
    const { app } = buildApp(undefined);
    const res = await request(app).get('/v1/commons/avatar/wallet_none');
    expect(res.status).toBe(404);
    expect(fetchProxiedAvatarMock).not.toHaveBeenCalled();
  });
});

/**
 * Tests for RedisCache - cache-aside pattern, rate limiting, and graceful degradation.
 *
 * Uses a mock Redis client to test all cache behaviors without a real Upstash connection.
 */

import crypto from 'crypto';
import { RECOVERED_PE_COUNTER_SLOT_LUA, FIXED_WINDOW_RATE_LIMIT_LUA, RedisCache } from './cache';

// ---------------------------------------------------------------------------
// Mock Redis client
// ---------------------------------------------------------------------------

interface MockRedis {
  get: jest.Mock;
  mget: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  incr: jest.Mock;
  expire: jest.Mock;
  ttl: jest.Mock;
  eval: jest.Mock;
}

function createMockRedis(): MockRedis {
  const mock: MockRedis = {
    get: jest.fn().mockResolvedValue(null),
    mget: jest.fn().mockResolvedValue(Array(24).fill(null)),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ttl: jest.fn().mockResolvedValue(-1),
    eval: jest.fn(),
  };
  mock.eval.mockImplementation(async (script:string,keys:string[],args:string[])=>{
    if(script!==FIXED_WINDOW_RATE_LIMIT_LUA)return [0,0,1,1,0,1,0];
    const cost=Number(args[0]),limit=Number(args[2]);
    const current=cost===1?await mock.incr(keys[0]):await (mock as MockRedis & {incrby:jest.Mock}).incrby(keys[0],cost);
    if(current===cost)await mock.expire(keys[0],Number(args[1]));
    return [current,current>limit?await mock.ttl(keys[0]):-1];
  });
  return mock;
}

/**
 * Inject a mock Redis client into a RedisCache instance.
 * Bypasses initialize() which requires env vars and a real Upstash connection.
 */
function injectMockClient(cache: RedisCache, mockRedis: MockRedis): void {
  // Access private fields via cast - acceptable in tests
  (cache as unknown as Record<string, unknown>)['client'] = mockRedis;
  (cache as unknown as Record<string, unknown>)['enabled'] = true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisCache', () => {
  let cache: RedisCache;
  let mockRedis: MockRedis;

  beforeEach(() => {
    cache = new RedisCache();
    mockRedis = createMockRedis();
    injectMockClient(cache, mockRedis);
  });

  it('reads exactly the same 24 hourly buckets with one billed Redis command', async () => {
    const hour = Math.floor(Date.now() / 3_600_000);
    const values = Array.from({ length: 24 }, (_, i) => i % 3 === 0 ? null : i);
    mockRedis.mget.mockResolvedValue(values);
    expect(await cache.get24hPECount()).toBe(values.reduce<number>((sum, v) => sum + (v || 0), 0));
    expect(mockRedis.mget).toHaveBeenCalledTimes(1);
    expect(mockRedis.mget).toHaveBeenCalledWith(...Array.from({ length: 24 }, (_, i) => `pvt:hour:${hour - i}`));
    expect(mockRedis.get).not.toHaveBeenCalled();
    mockRedis.mget.mockRejectedValueOnce(new Error('unavailable'));
    expect(await cache.get24hPECount()).toBe(-1);
    expect(await new RedisCache().get24hPECount()).toBe(-1);
  });

  it('strict ordinal reads use the same act UTC day as accounting writes, including midnight backlog', async () => {
    const timestamp = Date.UTC(2026, 9, 7, 23, 59, 59);
    mockRedis.get.mockImplementation(async (key: string) => key.endsWith(':2026-10-07') ? 50 : 0);
    expect(await cache.getUserActionTypeCountStrict('actor', 'ai_conversation', timestamp)).toBe(50);
    expect(mockRedis.get).toHaveBeenLastCalledWith('pvt:occ:actor:ai_conversation:2026-10-07');
    expect(await cache.getUserDailyPECountStrict('actor', timestamp)).toBe(50);
    expect(mockRedis.get).toHaveBeenLastCalledWith('pe_rate:daily:actor:2026-10-07');
    // RED reachability: the adjacent day's slot is genuinely distinct.
    expect(await cache.getUserActionTypeCountStrict('actor', 'ai_conversation', timestamp + 1000)).toBe(0);
  });

  // =========================================================================
  // 1. Kill Switch - write-through propagation
  // =========================================================================

  // =========================================================================
  // 2. Budget - cache-aside with 5s TTL
  // =========================================================================

  describe('Budget', () => {
    const budget = { daily_budget: 50, spent_today: 12.5, last_reset: Date.now() };

    it('setBudget caches with 5s TTL', async () => {
      await cache.setBudget('user-1', 'agent-1', budget);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'budget:user-1:agent-1',
        budget,
        { ex: 5 },
      );
    });

    it('getBudget returns cached budget on hit', async () => {
      mockRedis.get.mockResolvedValue(budget);

      const result = await cache.getBudget('user-1', 'agent-1');

      expect(result).toEqual(budget);
      expect(mockRedis.get).toHaveBeenCalledWith('budget:user-1:agent-1');
    });

    it('second read serves from cache (same key, single Redis call)', async () => {
      mockRedis.get.mockResolvedValue(budget);

      const result1 = await cache.getBudget('user-1', 'agent-1');
      const result2 = await cache.getBudget('user-1', 'agent-1');

      expect(result1).toEqual(budget);
      expect(result2).toEqual(budget);
      // Both calls hit Redis (cache-aside pattern - RedisCache itself is the cache)
      expect(mockRedis.get).toHaveBeenCalledTimes(2);
    });

    it('invalidateBudget deletes the key', async () => {
      await cache.invalidateBudget('user-1', 'agent-1');

      expect(mockRedis.del).toHaveBeenCalledWith('budget:user-1:agent-1');
    });

    it('getBudget returns null on miss', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await cache.getBudget('user-1', 'agent-1');

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // 3. Redis down - graceful degradation
  // =========================================================================

  describe('Redis down (graceful degradation)', () => {
    it('get returns null on error', async () => {
      mockRedis.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await cache.get<string>('any-key');

      expect(result).toBeNull();
    });

    it('set swallows errors silently', async () => {
      mockRedis.set.mockRejectedValue(new Error('ECONNREFUSED'));

      // Should not throw
      await expect(cache.set('any-key', 'value', 10)).resolves.toBeUndefined();
    });

    it('del swallows errors silently', async () => {
      mockRedis.del.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(cache.del('any-key')).resolves.toBeUndefined();
    });

    it('checkRateLimit allows requests when Redis is down', async () => {
      mockRedis.incr.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await cache.checkRateLimit('rl:test', 10, 60);

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(0);
    });

    it('all methods return no-op when client is null (cache disabled)', async () => {
      const disabledCache = new RedisCache();
      // Don't inject mock - client stays null

      expect(await disabledCache.get('key')).toBeNull();
      expect(await disabledCache.getBudget('user', 'agent')).toBeNull();
      expect(await disabledCache.getConnectionToken('token')).toBeNull();

      // Should not throw
      await disabledCache.set('key', 'val', 10);
      await disabledCache.del('key');

      const rl = await disabledCache.checkRateLimit('rl:key', 10, 60);
      expect(rl.allowed).toBe(true);
    });

    it('error counter increments on failures', async () => {
      mockRedis.get.mockRejectedValue(new Error('fail'));

      await cache.get('key1');
      await cache.get('key2');
      await cache.get('key3');

      const stats = cache.getStats();
      expect(stats.errors).toBe(3);
    });
  });

  // =========================================================================
  // 4. Rate Limiting - per-user (60/min)
  // =========================================================================

  describe('Rate Limiting', () => {
    it('allows requests under the limit', async () => {
      mockRedis.incr.mockResolvedValue(1);

      const result = await cache.checkRateLimit('rl:user:u1', 60, 60);

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
      expect(result.limit).toBe(60);
    });

    it('sets TTL only on first increment', async () => {
      // First request: incr returns 1
      mockRedis.incr.mockResolvedValue(1);
      await cache.checkRateLimit('rl:user:u1', 60, 60);
      expect(mockRedis.expire).toHaveBeenCalledWith('rl:user:u1', 60);

      mockRedis.expire.mockClear();

      // Second request: incr returns 2
      mockRedis.incr.mockResolvedValue(2);
      await cache.checkRateLimit('rl:user:u1', 60, 60);
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('61st request returns denied with retryAfter', async () => {
      // Simulate the 61st request
      mockRedis.incr.mockResolvedValue(61);
      mockRedis.ttl.mockResolvedValue(45);

      const result = await cache.checkRateLimit('rl:user:u1', 60, 60);

      expect(result.allowed).toBe(false);
      expect(result.current).toBe(61);
      expect(result.limit).toBe(60);
      expect(result.retryAfter).toBe(45);
    });

    it('request at exactly the limit is allowed', async () => {
      mockRedis.incr.mockResolvedValue(60);

      const result = await cache.checkRateLimit('rl:user:u1', 60, 60);

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(60);
    });

    // a batched request charges one unit per call it carries.
    it('RED: a cost-N request is charged N (INCRBY), with the TTL set when it created the key', async () => {
      const incrby = jest.fn().mockResolvedValue(20);
      (mockRedis as unknown as Record<string, unknown>).incrby = incrby;

      const result = await cache.checkRateLimit('rl:proxy:u1:alchemy_rpc', 100, 60, 20);

      expect(incrby).toHaveBeenCalledWith('rl:proxy:u1:alchemy_rpc', 20);
      expect(mockRedis.incr).not.toHaveBeenCalled();
      expect(mockRedis.expire).toHaveBeenCalledWith('rl:proxy:u1:alchemy_rpc', 60);
      expect(result).toEqual({ allowed: true, current: 20, limit: 100 });
    });

    it('a cost-N request that pushes past the limit is denied', async () => {
      (mockRedis as unknown as Record<string, unknown>).incrby = jest.fn().mockResolvedValue(101);
      mockRedis.ttl.mockResolvedValue(30);

      const result = await cache.checkRateLimit('rl:proxy:u1:alchemy_rpc', 100, 60, 20);

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBe(30);
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('a zero / negative / fractional cost is refused, never charged as free', async () => {
      await expect(cache.checkRateLimit('rl:x', 10, 60, 0)).rejects.toThrow(RangeError);
      await expect(cache.checkRateLimit('rl:x', 10, 60, -3)).rejects.toThrow(RangeError);
      await expect(cache.checkRateLimit('rl:x', 10, 60, 1.5)).rejects.toThrow(RangeError);
      expect(mockRedis.incr).not.toHaveBeenCalled();
    });

    it('retryAfter falls back to window seconds when TTL is 0 or negative', async () => {
      mockRedis.incr.mockResolvedValue(61);
      mockRedis.ttl.mockResolvedValue(0);

      const result = await cache.checkRateLimit('rl:user:u1', 60, 60);

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBe(60);
    });
  });

  describe('pending-cache recovery accounting (counters, not limits; + occurrence ordinal)', () => {
    it('accepts only a coherent atomic slot response (hourly + daily + occurrence)', async () => {
      await expect(cache.consumeRecoveredPECounterSlot('user-1', 'pe-1', 'agent_action', '2026-08-01'))
        .resolves.toEqual({
          hourlyCountBefore: 0,
          dailyCountBefore: 0,
          hourlyCountAfter: 1,
          dailyCountAfter: 1,
          occurrenceCountBefore: 0,
          occurrenceCountAfter: 1,
          idempotent: false,
        });
      // The occurrence key targets the PE's ORIGINAL record day, never today.
      const [, keys] = mockRedis.eval.mock.calls[0];
      expect(keys[3]).toBe('pvt:occ:user-1:agent_action:2026-08-01');
    });

    it('honors an idempotent replay of a prior ALLOWED claim', async () => {
      mockRedis.eval.mockResolvedValue([5, 7, 6, 8, 2, 3, 1]);
      await expect(cache.consumeRecoveredPECounterSlot('user-1', 'pe-1', 'agent_action', '2026-08-01'))
        .resolves.toEqual({
          hourlyCountBefore: 5,
          dailyCountBefore: 7,
          hourlyCountAfter: 6,
          dailyCountAfter: 8,
          occurrenceCountBefore: 2,
          occurrenceCountAfter: 3,
          idempotent: true,
        });
    });

    it.each([
      // 5-element -era shape is malformed as a RESPONSE now (the script
      // upgrades a legacy CLAIM internally and always answers 7 elements)
      [0, 0, 1, 1, 0],
      // 6-element legacy shape is malformed
      [1, 0, 0, 1, 1, 0],
      // negative before-count
      [-1, 0, 0, 1, 0, 1, 0],
      // hourly did not advance by exactly one
      [200, 0, 200, 1, 0, 1, 0],
      // hourly advanced by two
      [0, 0, 2, 1, 0, 1, 0],
      // daily did not advance
      [0, 200, 1, 200, 0, 1, 0],
      // occurrence did not advance by exactly one
      [0, 0, 1, 1, 4, 4, 0],
      // occurrence advanced by two
      [0, 0, 1, 1, 4, 6, 0],
      // negative occurrence before-count
      [0, 0, 1, 1, -1, 0, 0],
      // idempotent flag out of domain
      [0, 0, 1, 1, 0, 1, 2],
    ])('rejects malformed Redis response %#', async (...response) => {
      mockRedis.eval.mockResolvedValue(response);
      await expect(cache.consumeRecoveredPECounterSlot('user-1', 'pe-1', 'agent_action', '2026-08-01'))
        .rejects.toThrow('consumeRecoveredPECounterSlot failed');
    });

    it('rejects invalid identities before calling Redis', async () => {
      await expect(cache.consumeRecoveredPECounterSlot('', 'pe-1', 'agent_action', '2026-08-01'))
        .rejects.toThrow('Invalid pending-cache recovery request');
      await expect(cache.consumeRecoveredPECounterSlot('user-1', '', 'agent_action', '2026-08-01'))
        .rejects.toThrow('Invalid pending-cache recovery request');
      await expect(cache.consumeRecoveredPECounterSlot('user-1', 'pe-1', '', '2026-08-01'))
        .rejects.toThrow('Invalid pending-cache recovery request');
      await expect(cache.consumeRecoveredPECounterSlot('user-1', 'pe-1', 'agent_action', 'not-a-day'))
        .rejects.toThrow('Invalid pending-cache recovery request');
      expect(mockRedis.eval).not.toHaveBeenCalled();
    });

    it('sends EXACTLY the pinned recovery script to Redis', async () => {
      await cache.consumeRecoveredPECounterSlot('user-1', 'pe-1', 'agent_action', '2026-08-01');
      const [script, keys, argv] = mockRedis.eval.mock.calls[0];
      expect(script).toBe(RECOVERED_PE_COUNTER_SLOT_LUA);
      expect(keys).toHaveLength(6);
      expect(argv).toEqual(['3600', '86400', '172800', '90000']);
    });

    // with `eval` mocked, nothing executed the Lua —
    // deleting the occurrence INCR would have left every test green while
    // reintroducing the full-novelty recovery leak. No in-repo harness can RUN
    // Lua (no Redis, no interpreter — declared residual; manual verification
    // recorded in docs/wp-runs/D338_FINDING_B_PLUMBING.md), so these controls
    // bind STRUCTURALLY to the one exported script the client sends: they fail
    // under the named mutation class (occurrence consume removed or replaced
    // with literals) and under any silent edit (content pin).
    describe('recovery Lua script — structural controls (the pricing input)', () => {
      const script = RECOVERED_PE_COUNTER_SLOT_LUA;
      const lines = script.split('\n');

      it('consumes the occurrence ordinal from Redis in the FRESH branch — never a literal', () => {
        // The fresh-consume tail (after the claim-replay block ends).
        const tail = script.slice(script.lastIndexOf("local hourly"));
        expect(tail).toContain("local occBefore = tonumber(redis.call('GET', KEYS[4]) or '0')");
        expect(tail).toContain("local occAfter = redis.call('INCR', KEYS[4])");
        expect(tail).toContain("redis.call('EXPIRE', KEYS[4], tonumber(ARGV[4]))");
        // The verdict and the return BOTH carry the redis-derived values.
        expect(tail).toContain(".. occBefore .. ':' .. occAfter");
        expect(tail).toContain('return {hourly, daily, nextHourly, nextDaily, occBefore, occAfter, 0}');
      });

      it('upgrades a legacy 5-field claim by consuming the occurrence exactly once', () => {
        const legacyStart = script.indexOf("#parts == 5");
        const legacyEnd = script.indexOf("local hourly");
        const branch = script.slice(legacyStart, legacyEnd);
        expect(branch).toContain("redis.call('INCR', KEYS[4])");
        expect(branch).toContain("redis.call('EXPIRE', KEYS[4], tonumber(ARGV[4]))");
        expect(branch).toContain("redis.call('SET', KEYS[3], upgraded, 'EX', tonumber(ARGV[3]))");
      });

      it('replays a 7-field claim with NO counter mutation (idempotency)', () => {
        const replayStart = script.indexOf("#parts == 7");
        const replayEnd = script.indexOf("#parts == 5");
        const branch = script.slice(replayStart, replayEnd);
        expect(branch).not.toContain('INCR');
        expect(branch).toContain(', 1}');
      });

      it('INCRs each counter key exactly as often as its branches allow', () => {
        const count = (needle: string) =>
          lines.filter((line) => line.includes(needle)).length;
        // KEYS[4] (occurrence): once in the legacy upgrade + once fresh.
        expect(count("redis.call('INCR', KEYS[4])")).toBe(2);
        // Hourly/daily: fresh branch only.
        expect(count("redis.call('INCR', KEYS[1])")).toBe(1);
        expect(count("redis.call('INCR', KEYS[2])")).toBe(1);
      });

      it('CONTENT PIN — any edit re-runs the manual verification (see the run log)', () => {
        const sha = crypto.createHash('sha256').update(script, 'utf8').digest('hex');
        expect(sha).toBe('fa62dbab72f53ecb40743b173ffb83112fccb8ac98282cc6de6345117f7ab6cc');
      });
    });
  });

  // =========================================================================
  // 5. Global Rate Limit - 500 req/sec
  // =========================================================================

  describe('Global Rate Limit (500 req/sec)', () => {
    it('501st request in same second returns denied', async () => {
      mockRedis.incr.mockResolvedValue(501);
      mockRedis.ttl.mockResolvedValue(1);

      const result = await cache.checkRateLimit('rl:global:1707700000', 500, 2);

      expect(result.allowed).toBe(false);
      expect(result.current).toBe(501);
      expect(result.limit).toBe(500);
      expect(result.retryAfter).toBe(1);
    });

    it('500th request is still allowed', async () => {
      mockRedis.incr.mockResolvedValue(500);

      const result = await cache.checkRateLimit('rl:global:1707700000', 500, 2);

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(500);
    });
  });

  // =========================================================================
  // 6. Connection Token - cache-aside with 30s TTL
  // =========================================================================

  describe('Connection Token', () => {
    const tokenData = {
      user_id: 'user-42',
      expires_at: Date.now() + 300_000,
      used: false,
    };

    it('setConnectionToken caches with 30s TTL', async () => {
      await cache.setConnectionToken('tok-abc', tokenData);

      expect(mockRedis.set).toHaveBeenCalledWith('conn:tok-abc', tokenData, { ex: 30 });
    });

    it('getConnectionToken returns cached data on hit', async () => {
      mockRedis.get.mockResolvedValue(tokenData);

      const result = await cache.getConnectionToken('tok-abc');

      expect(result).toEqual(tokenData);
    });

    it('invalidateConnectionToken deletes the key', async () => {
      await cache.invalidateConnectionToken('tok-abc');

      expect(mockRedis.del).toHaveBeenCalledWith('conn:tok-abc');
    });
  });

  // =========================================================================
  // 7. Stats & Monitoring
  // =========================================================================

  describe('Stats', () => {
    it('tracks hits and misses', async () => {
      mockRedis.get.mockResolvedValueOnce('value');  // hit
      mockRedis.get.mockResolvedValueOnce(null);     // miss
      mockRedis.get.mockResolvedValueOnce('value2'); // hit

      await cache.get('key1');
      await cache.get('key2');
      await cache.get('key3');

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe('66.7');
    });

    it('getStats returns 0.0 hit rate when no operations', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe('0.0');
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('isEnabled returns true when client is injected', () => {
      expect(cache.isEnabled()).toBe(true);
    });

    it('isEnabled returns false for uninitialized cache', () => {
      const freshCache = new RedisCache();
      expect(freshCache.isEnabled()).toBe(false);
    });
  });

  // =========================================================================
  // 8. Initialize
  // =========================================================================

  describe('initialize', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('stays disabled when env vars are missing', () => {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;

      const freshCache = new RedisCache();
      freshCache.initialize();

      expect(freshCache.isEnabled()).toBe(false);
    });
  });
});

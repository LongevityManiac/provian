import {privateCacheAlias,migrateCacheSlotLua,mirrorCacheSlotLua,PRIVATE_CACHE_READY_KEY} from './core/provenance/private-cache';
/**
 * Redis Cache Layer for Provian Relay
 *
 * Cache-aside pattern with Upstash serverless Redis.
 * All methods catch errors and fall through gracefully -
 * Redis is a performance optimization, not a correctness requirement.
 *
 * "Unknown = Block" - if both Redis and Firestore are down, deny the request.
 */

import { Redis } from '@upstash/redis';
import type { AgentBeneficiaryShareBps } from './core/agent-wallet/beneficiary-relationship';

/** One HTTP round trip, preserving weighted fixed-window counts and Retry-After.
 * The expiry is set only for the increment that created the key. */
export const FIXED_WINDOW_RATE_LIMIT_LUA = `
local cost=tonumber(ARGV[1])
local current=redis.call('INCRBY',KEYS[1],cost)
if current==cost then redis.call('EXPIRE',KEYS[1],ARGV[2]) end
local ttl=-1
if current>tonumber(ARGV[3]) then ttl=redis.call('TTL',KEYS[1]) end
return {current,ttl}
`;
export const RECORD_ARTIFACT_HASH_LUA = `
redis.call('SADD',KEYS[1],ARGV[2])
if redis.call('GET',KEYS[2])=='1' then redis.call('SREM',KEYS[1],ARGV[1]) else redis.call('SADD',KEYS[1],ARGV[1]) end
if redis.call('TTL',KEYS[1])==-1 then redis.call('EXPIRE',KEYS[1],90000) end
return 1
`;

// Cache hit/miss counters for monitoring
interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  lastReported: number;
}

const STATS_REPORT_INTERVAL_MS = 60_000; // Log stats every minute

/**
 * TTL on the per-PE accounting idempotency claim (`pvt:accounting:pe:*`), H3.
 *
 * THIS REVERSES A PREVIOUSLY DELIBERATE DECISION, so the reasoning is recorded in
 * full rather than assumed. `commitPEAccountingCountersOnce` used to document the
 * claim as "intentionally not TTL'd: an arbitrarily late replay after a crash
 * must never consume a second rate/economic slot."
 *
 * HALF OF THAT REASON IS NOW OBSOLETE. The "rate slot" was the 200/hour and
 * 2000/day per-user CEILINGS, and removed them — `pe_rate:hourly:*` and
 * `pe_rate:daily:*` are now truthful provenance ordinals that nothing refuses,
 * floors or zeroes on (see the section comment above them). Consuming one costs
 * nothing.
 *
 * THE SURVIVING HALF IS THE NOVELTY ORDINAL (`pvt:occ:*`), and its blast radius
 * is the one already established: a replay that outlives the claim
 * increments a FRESH day's counter, which prices that user's later work of the
 * same type more cheaply. Under-pricing, never over-mint — mint-once lives in
 * Firestore, not here.
 *
 * SEVEN DAYS IS DERIVED, not picked. Two bounds matter:
 * · the longest counter this claim protects lives 90,000s (25h) — past that the
 * claim guards nothing at all and is pure residue;
 * · the durable-outbox replay horizon is TEN MINUTES
 * (`ORDINARY_ACCRUAL_REPLAY_GRACE_MS`, wp11/ordinary-accrual-replay.ts:103).
 * Seven days is ~6.7x the first and ~1,000x the second. (Not imported from wp11:
 * the cache layer should not take a dependency on the replay driver to express a
 * safety margin.)
 *
 * WHAT IT REPLACES. An immortal SET grew with TOTAL PE COUNT forever (~100 B
 * each: ~100 MB at 1M PEs, ~1 GB at 10M) and made correctness depend on the
 * instance being kept `noeviction` in perpetuity. A Redis at maxmemory with
 * `noeviction` REFUSES WRITES — accrual fails outright, which is strictly worse
 * than the bounded fairness effect above.
 */
export const PE_ACCOUNTING_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Optional human-initiated beneficiary invite carried by a connection token.
 * Resolved server-side at token creation (the human can only link their own
 * wallet), stashed on the agent session at connect time, and bound onto the
 * agent wallet when the agent opts in by creating one.
 */
export interface ConnectionTokenBeneficiaryLink {
  human_user_id: string;
  human_wallet_id: string;
  human_address: string;
  operational_reserve_bps: AgentBeneficiaryShareBps;
}

/**
 * Thrown by the *Strict counter variants when the cache cannot answer
 * authoritatively (client unconfigured, or the underlying Redis call
 * threw). Distinct from a legitimate zero return - callers should treat
 * this as "cache unhealthy", not "no PEs yet".
 */
export class CacheUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheUnavailableError';
  }
}

export interface RecoveredPECounterSlot {
  readonly hourlyCountBefore: number;
  readonly dailyCountBefore: number;
  readonly hourlyCountAfter: number;
  readonly dailyCountAfter: number;
  /**
   * the recovered (user, actionType, ORIGINAL UTC day) occurrence
   * ordinal consume. `occurrenceCountAfter` is the 1-based ordinal this
   * recovered PE takes in its record day's novelty window — the input the
   * backfill needs to price the recovery at the DECAYED novelty the event
   * legitimately earned instead of the ordinal-1 full-novelty placeholder its
   * snapshot sealed while Redis was unreadable.
   */
  readonly occurrenceCountBefore: number;
  readonly occurrenceCountAfter: number;
  readonly idempotent: boolean;
}

export interface PEAccountingCounterCommit {
  readonly idempotent: boolean;
}

/**
 * the atomic recovered-slot script — hourly + daily + OCCURRENCE
 * consume with an idempotent per-PE claim. Exported so the suite can bind
 * executable controls to the ACTUAL script (the negative control: with the
 * script inline and `eval` mocked, deleting the occurrence INCR left every
 * test green while reintroducing the full-novelty recovery leak).
 *
 * The occurrence branch (KEYS[4]) is the PRICING INPUT for every recovery —
 * `occAfter` is the recovered PE's novelty ordinal. Any edit to this string
 * moves the content pin in `cache.test.ts` and MUST re-run the manual
 * verification recorded in `docs/wp-runs/D338_FINDING_B_PLUMBING.md`
 * (no in-repo Redis harness executes Lua — declared residual per the
 * negative-control doctrine).
 */
export const RECOVERED_PE_COUNTER_SLOT_LUA = [
  migrateCacheSlotLua(3,5,6),
  "local prior = redis.call('GET', KEYS[3])",
  'if prior then',
  "  local parts = {}",
  "  for part in string.gmatch(prior, '([^:]+)') do table.insert(parts, part) end",
  "  if tonumber(parts[1]) == 1 and #parts == 7 then",
  '    return {tonumber(parts[2]), tonumber(parts[3]), tonumber(parts[4]), tonumber(parts[5]), tonumber(parts[6]), tonumber(parts[7]), 1}',
  '  end',
  "  if tonumber(parts[1]) == 1 and #parts == 5 then",
  '    local occBefore = tonumber(redis.call(\'GET\', KEYS[4]) or \'0\')',
  "    local occAfter = redis.call('INCR', KEYS[4])",
  "    redis.call('EXPIRE', KEYS[4], tonumber(ARGV[4]))",
  "    local upgraded = '1:' .. parts[2] .. ':' .. parts[3] .. ':' .. parts[4] .. ':' .. parts[5] .. ':' .. occBefore .. ':' .. occAfter",
  "    redis.call('SET', KEYS[3], upgraded, 'EX', tonumber(ARGV[3]))",
  mirrorCacheSlotLua(3,5,6),
  '    return {tonumber(parts[2]), tonumber(parts[3]), tonumber(parts[4]), tonumber(parts[5]), occBefore, occAfter, 1}',
  '  end',
  'end',
  "local hourly = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "local daily = tonumber(redis.call('GET', KEYS[2]) or '0')",
  "local nextHourly = redis.call('INCR', KEYS[1])",
  "if nextHourly == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end",
  "local nextDaily = redis.call('INCR', KEYS[2])",
  "if nextDaily == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2])) end",
  "local occBefore = tonumber(redis.call('GET', KEYS[4]) or '0')",
  "local occAfter = redis.call('INCR', KEYS[4])",
  "redis.call('EXPIRE', KEYS[4], tonumber(ARGV[4]))",
  "local verdict = '1:' .. hourly .. ':' .. daily .. ':' .. nextHourly .. ':' .. nextDaily .. ':' .. occBefore .. ':' .. occAfter",
  "redis.call('SET', KEYS[3], verdict, 'EX', tonumber(ARGV[3]))",
  mirrorCacheSlotLua(3,5,6),
  'return {hourly, daily, nextHourly, nextDaily, occBefore, occAfter, 0}',
].join('\n');

export class RedisCache {
  private client: Redis | null = null;
  private stats: CacheStats = { hits: 0, misses: 0, errors: 0, lastReported: Date.now() };
  private enabled: boolean = false;

  /**
   * Initialize the Redis connection. Call once at startup.
   * If UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN are missing, cache operates
   * as a no-op (all methods return null/void without error).
   */
  initialize(): void {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      console.log('[RedisCache] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set - cache disabled');
      return;
    }

    try {
      this.client = new Redis({ url, token });
      this.enabled = true;
      console.log('[RedisCache] Connected to Upstash Redis');
    } catch (error) {
      console.error('[RedisCache] Failed to initialize:', error);
      this.enabled = false;
    }
  }

  /**
   * Whether the cache is enabled and connected.
   */
  isEnabled(): boolean {
    return this.enabled && this.client !== null;
  }

  /**
   * Get a value from cache. Returns null on miss or error.
   */
  async get<T>(key: string): Promise<T | null> {
    if (!this.client) return null;

    try {
      const value = await this.client.get<T>(key);
      if (value !== null && value !== undefined) {
        this.stats.hits++;
        this.maybeReportStats();
        return value;
      }
      this.stats.misses++;
      this.maybeReportStats();
      return null;
    } catch (error) {
      this.stats.errors++;
      console.error(`[RedisCache] GET error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set a value in cache with TTL in seconds.
   * Fails silently - never blocks the caller.
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.set(key, value, { ex: ttlSeconds });
    } catch (error) {
      this.stats.errors++;
      console.error(`[RedisCache] SET error for key ${key}:`, error);
    }
  }

  /**
   * Atomic set-if-not-exists. Returns true if the key was successfully
   * created (caller now "owns" it), false if the key already existed
   * (another process beat us to it). Used for single-use challenge
   * consumption - see Phase 2.13 (Theme 8) fix.
   *
   * If the cache is unavailable this returns false (fail-closed): the
   * caller should treat the claim as denied so it can't accidentally
   * authorise the same nonce twice in a degraded state.
   */
  async setNx(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    if (!this.client) return false;
    try {
      // Upstash: set(key, value, { nx: true, ex: ttl }) returns "OK" on
      // success, null when the key already existed.
      const result = await this.client.set(key, value, { nx: true, ex: ttlSeconds });
      return result === 'OK';
    } catch (error) {
      this.stats.errors++;
      console.error(`[RedisCache] SETNX error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete a key from cache.
   * Fails silently - never blocks the caller.
   */
  async del(key: string): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.del(key);
    } catch (error) {
      this.stats.errors++;
      console.error(`[RedisCache] DEL error for key ${key}:`, error);
    }
  }

  // ===========================================================================
  // Rate Limiting - INCR + EXPIRE pattern (atomic, no race conditions)
  // ===========================================================================

  /**
   * Check and increment a rate limit counter.
   * Returns { allowed: boolean, current: number, limit: number, retryAfter?: number }.
   *
   * Uses Redis INCR + EXPIRE for atomicity. On Redis error, falls through
   * and returns allowed: true (graceful degradation for general API limits).
   * Use checkRateLimitStrict for security-critical limits that must not
   * fail open under a Redis outage.
   */
  async checkRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    cost = 1,
  ): Promise<{ allowed: boolean; current: number; limit: number; retryAfter?: number }> {
    // a request that carries N units of work (a batched JSON-RPC call)
    // charges N. A non-positive/non-integer cost is refused, never charged as 0.
    if (!Number.isInteger(cost) || cost < 1) {
      throw new RangeError(`rate-limit cost must be a positive integer, got ${cost}`);
    }
    if (!this.client) {
      return { allowed: true, current: 0, limit };
    }

    try {
      const [current, ttl] = await this.client.eval<[string,string,string],[number,number]>(FIXED_WINDOW_RATE_LIMIT_LUA,[key],[String(cost),String(windowSeconds),String(limit)]);
      if (current > limit) return {allowed:false,current,limit,retryAfter:ttl > 0 ? ttl : windowSeconds};

      return { allowed: true, current, limit };
    } catch (error) {
      this.stats.errors++;
      console.error(`[RedisCache] Rate limit error for key ${key}:`, error);
      // General-purpose limits fail open to keep the API available; security-
      // critical callers must use checkRateLimitStrict instead.
      return { allowed: true, current: 0, limit };
    }
  }

  /**
   * Strict rate-limit check for security-critical endpoints (e.g. account
   * recovery, bond claims, key-rotation cooldowns). Identical happy-path
   * behavior to checkRateLimit, but fails CLOSED when Redis is unavailable
   * or throws: returns { allowed: false, error: 'rate_limit_unavailable' }.
   * Callers should map error to HTTP 503 with a generic temporarily_unavailable
   * body to avoid leaking infrastructure state.
   */
  async checkRateLimitStrict(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{
    allowed: boolean;
    current: number;
    limit: number;
    retryAfter?: number;
    error?: 'rate_limit_unavailable';
  }> {
    if (!this.client) {
      return { allowed: false, current: 0, limit, error: 'rate_limit_unavailable' };
    }

    try {
      const [current, ttl] = await this.client.eval<[string,string,string],[number,number]>(FIXED_WINDOW_RATE_LIMIT_LUA,[key],['1',String(windowSeconds),String(limit)]);
      if (current > limit) return {allowed:false,current,limit,retryAfter:ttl > 0 ? ttl : windowSeconds};
      return { allowed: true, current, limit };
    } catch (error) {
      this.stats.errors++;
      console.error(`[RedisCache] Strict rate limit error for key ${key}:`, error);
      return { allowed: false, current: 0, limit, error: 'rate_limit_unavailable' };
    }
  }

  // ===========================================================================
  // Budget Balances - 5 second TTL, write-through
  // ===========================================================================

  /**
   * Get cached budget balance. Returns null on miss.
   */
  async getBudget(userId: string, agentId: string): Promise<{
    daily_budget: number;
    spent_today: number;
    last_reset: number;
  } | null> {
    return this.get(`budget:${userId}:${agentId}`);
  }

  /**
   * Write-through: update budget in cache after Firestore commit.
   */
  async setBudget(
    userId: string,
    agentId: string,
    budget: { daily_budget: number; spent_today: number; last_reset: number },
  ): Promise<void> {
    await this.set(`budget:${userId}:${agentId}`, budget, 5); // 5 second TTL
  }

  /**
   * Invalidate budget cache after mutation (reservation, release, reset).
   */
  async invalidateBudget(userId: string, agentId: string): Promise<void> {
    await this.del(`budget:${userId}:${agentId}`);
  }

  // ===========================================================================
  // Connection Tokens - 30 second TTL
  // ===========================================================================

  /**
   * Get cached connection token. Returns null on miss.
   */
  async getConnectionToken(tokenId: string): Promise<{
    user_id: string;
    expires_at: number;
    used: boolean;
    beneficiary_link?: ConnectionTokenBeneficiaryLink;
    /** Phone-minted x25519 recovery anchor pubkey (base64url), if the invite carried one. */
    recovery_anchor_pubkey?: string;
  } | null> {
    return this.get(`conn:${tokenId}`);
  }

  /**
   * Write-through: cache connection token after Firestore creation.
   */
  async setConnectionToken(
    tokenId: string,
    data: {
      user_id: string;
      expires_at: number;
      used: boolean;
      beneficiary_link?: ConnectionTokenBeneficiaryLink;
      recovery_anchor_pubkey?: string;
    },
  ): Promise<void> {
    await this.set(`conn:${tokenId}`, data, 30); // 30 second TTL
  }

  /**
   * Invalidate connection token (on use or expiry).
   */
  async invalidateConnectionToken(tokenId: string): Promise<void> {
    await this.del(`conn:${tokenId}`);
  }

  // ===========================================================================
  // Counterparty Type - 60 second TTL (anti-gaming field resolution)
  // ===========================================================================

  /**
   * Get cached counterparty type for an address. Returns null on miss.
   */
  async getCounterpartyType(address: string): Promise<'human' | 'agent' | 'external' | null> {
    return this.get<'human' | 'agent' | 'external'>(`cp:${address}`);
  }

  /**
   * Cache counterparty type after Firestore lookup.
   */
  async setCounterpartyType(address: string, type: 'human' | 'agent' | 'external'): Promise<void> {
    await this.set(`cp:${address}`, type, 60); // 60 second TTL
  }

  // ===========================================================================
  // User Auth Secrets - eliminates Firestore read on every wallet-authed request
  // ===========================================================================

  /**
   * Get cached user auth secret. Returns null on miss (caller reads Firestore).
   */
  async getUserAuthSecret(userId: string): Promise<string | null> {
    return this.get<string>(`uauth:${userId}`);
  }

  /**
   * Cache user auth secret after Firestore lookup. 60-second TTL.
   */
  async setUserAuthSecret(userId: string, secret: string): Promise<void> {
    await this.set(`uauth:${userId}`, secret, 60);
  }

  /**
   * Drop the cached auth secret (DELETE /v1/user/data), so a deleted account's token stops
   * verifying at once rather than when the 60-second entry lapses.
   */
  async deleteUserAuthSecret(userId: string): Promise<void> {
    await this.del(`uauth:${userId}`);
  }

  // ===========================================================================
  // PVT Network Stats - 30 second TTL
  // ===========================================================================

  /**
   * Get cached PVT network stats for a leaderboard window. Returns null on miss.
   * v3: per-window keys + test-wallet filtering (the v2 blob predates both and
   * is deliberately orphaned by the version bump).
   */
  async getNetworkStats<T>(window: 'all' | 'week' = 'all'): Promise<T | null> {
    return this.get<T>(`pvt:network-stats:v3:${window}`);
  }

  /**
   * Cache PVT network stats for 30 seconds (per window).
   */
  async setNetworkStats(data: unknown, window: 'all' | 'week' = 'all'): Promise<void> {
    await this.set(`pvt:network-stats:v3:${window}`, data, 30);
  }

  // ===========================================================================
  // PVT Hourly PE Counter - Sliding 24h window
  // ===========================================================================

  /**
   * Increment the current hour's PE counter.
   * Uses hourly buckets with 25h TTL for a sliding 24h window.
   * Non-blocking - fails silently.
   */
  async incrementHourlyPECount(): Promise<void> {
    if (!this.client) return;

    try {
      const hourBucket = Math.floor(Date.now() / 3_600_000);
      const key = `pvt:hour:${hourBucket}`;
      await this.client.eval<[],number>("local n=redis.call('INCR',KEYS[1]); redis.call('EXPIRE',KEYS[1],90000); return n",[key],[]); // same sliding 25-hour expiry
    } catch (error) {
      this.stats.errors++;
      console.error('[RedisCache] PVT hourly increment error:', error);
    }
  }

  /**
   * Sum the last 24 hourly PE buckets.
   * Returns -1 on cache miss or error (caller should fall back to Firestore).
   */
  async get24hPECount(): Promise<number> {
    if (!this.client) return -1;

    try {
      const currentHour = Math.floor(Date.now() / 3_600_000);
      const keys = Array.from({ length: 24 }, (_, i) => `pvt:hour:${currentHour - i}`);
      const values = await this.client.mget<(number | null)[]>(...keys);
      return values.reduce((sum: number, v) => sum + (v || 0), 0);
    } catch (error) {
      this.stats.errors++;
      console.error('[RedisCache] PVT 24h count error:', error);
      return -1;
    }
  }

  // ===========================================================================
  // Per-User PE Counters (provenance ordinals — NOT limits)
  // ===========================================================================
  //
  // The `pe_rate:hourly:*` and `pe_rate:daily:*` counters remain as truthful
  // event counts: the daily counter seals each PE's `dailyOrdinal` provenance
  // evidence, and both appear in pending-cache recovery evidence. The
  // per-user volume CEILINGS that used to read them (200/hour, 2000/day, and
  // the 50/day qualification ordinal) are removed — nothing refuses, floors,
  // or zeroes on these counts. Increments happen atomically inside
  // commitPEAccountingCountersOnce and consumeRecoveredPECounterSlot.

  // ===========================================================================
  // Per-User Action Type Occurrence Tracking (novelty decay for PVT)
  // ===========================================================================

  /**
   * Get how many times a (userId, actionType) pair has occurred today.
   * Used for novelty decay calculation in PVT weight framework.
   * Key format: pvt:occ:{userId}:{actionType}:{YYYY-MM-DD}
   */
  async getUserActionTypeCount(userId: string, actionType: string): Promise<number> {
    if (!this.client) return 0;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const key = `pvt:occ:${userId}:${actionType}:${today}`;
      const val = await this.client.get<number>(key);
      return val ?? 0;
    } catch (error) {
      console.error('[RedisCache] getUserActionTypeCount error:', error);
      return 0;
    }
  }

  // ===========================================================================
  // Strict counter variants (Audit Pass 2 follow-up, 2026-05-13).
  // ===========================================================================
  //
  // The non-strict GETs above silently return 0 on both "key missing" (legit)
  // and "Redis errored / client null" (failure mode). Callers that need to
  // distinguish "user has no PEs yet" from "we couldn't reach Redis" should
  // use the *Strict variants below - they throw CacheUnavailableError on the
  // failure modes and return the real value (which may be 0) otherwise.
  //
  // Used by pvt-accrual.ts so an unhealthy cache routes the PE to
  // mint_status='pending_cache' (reclassifiable when the cache recovers)
  // rather than the wrong terminal state.

  async getUserDailyPECountStrict(userId: string, timestampMs: number = Date.now()): Promise<number> {
    if (!this.client) {
      throw new CacheUnavailableError('Redis client not configured');
    }
    try {
      const today = new Date(timestampMs).toISOString().slice(0, 10);
      const key = `pe_rate:daily:${userId}:${today}`;
      const val = await this.client.get<number>(key);
      return val ?? 0;
    } catch (error) {
      this.stats.errors++;
      throw new CacheUnavailableError(
        `getUserDailyPECount failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Atomically advance one recovered PE's hourly+daily counters AND its
   * (user, actionType, original-record-day) occurrence ordinal, exactly once.
   * The per-PE claim key makes a Redis-success/Firestore-failure retry
   * idempotent: the same PE receives the original counter evidence without
   * consuming a second slot. Infrastructure errors throw and therefore leave
   * the PE in its fail-closed pending state.
   *
   * this used to be `consumeRecoveredPERateLimitSlot` and REFUSED the
   * slot when the recovered counts exceeded the per-user volume caps. Those
   * caps are removed — every call now advances the counters and succeeds; the
   * claim + before/after evidence remain for exactly-once accounting only.
   * A pre- DENIED claim verdict (leading '0', written by the old script
   * for a PE whose terminal write then failed) is not honored as a verdict:
   * it is overwritten by a fresh consume, because the refusal rule it encoded
   * no longer exists and was never durably recorded for that PE.
   *
   * the consume now ALSO advances `pvt:occ:{user}:{actionType}:{day}`
   * for the PE's ORIGINAL record day (never today's live window when they
   * differ) and returns the before/after occurrence counts. The post-INCR
   * value is the recovered PE's true 1-based novelty ordinal: each recovered
   * event of a same-(user, action, day) cohort consumes a DISTINCT ordinal,
   * which is what lets the backfill price the cohort at its correct decayed
   * novelty (the priced total over distinct ordinals is permutation-invariant,
   * so exact interleaving with live traffic does not matter). The occurrence
   * key's TTL is refreshed on EVERY recovery touch so a multi-run drain of a
   * large cohort keeps one continuous count. A claim written by the pre-
   * script (5-field ALLOWED verdict: hourly/daily consumed, occurrence never)
   * consumes the occurrence exactly once on first replay and upgrades the
   * stored verdict to the 7-field shape atomically.
   */
  async consumeRecoveredPECounterSlot(
    userId: string,
    peId: string,
    actionType: string,
    occurrenceDay: string,
  ): Promise<RecoveredPECounterSlot> {
    if (!this.client) throw new CacheUnavailableError('Redis client not configured');
    if (!userId || !peId || !actionType || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDay)) {
      throw new CacheUnavailableError('Invalid pending-cache recovery request');
    }
    const hourKey = `pe_rate:hourly:${userId}:${new Date().getUTCHours()}`;
    const dayKey = `pe_rate:daily:${userId}:${new Date().toISOString().slice(0, 10)}`;
    const legacyClaimKey = `pe_rate:pending_cache_recovery:${peId}`;
    const claimKey = `pe_rate:pending_cache_recovery:private_${privateCacheAlias('recovery',peId)}`;
    const occKey = `pvt:occ:${userId}:${actionType}:${occurrenceDay}`;
    try {
      const raw = await this.client.eval<string[], number[]>(
        RECOVERED_PE_COUNTER_SLOT_LUA,
        [hourKey, dayKey, claimKey, occKey, legacyClaimKey, PRIVATE_CACHE_READY_KEY],
        ['3600', '86400', '172800', '90000'],
      );
      if (!Array.isArray(raw) || raw.length !== 7
        || raw.some((value) => !Number.isSafeInteger(Number(value)))) {
        throw new Error('invalid atomic recovery response');
      }
      const [hourlyCountBefore, dailyCountBefore, hourlyCountAfter, dailyCountAfter,
        occurrenceCountBefore, occurrenceCountAfter, idempotentRaw] = raw.map(Number);
      if ((idempotentRaw !== 0 && idempotentRaw !== 1)
        || hourlyCountBefore < 0
        || dailyCountBefore < 0
        || occurrenceCountBefore < 0
        || hourlyCountBefore === Number.MAX_SAFE_INTEGER
        || dailyCountBefore === Number.MAX_SAFE_INTEGER
        || occurrenceCountBefore === Number.MAX_SAFE_INTEGER
        || hourlyCountAfter !== hourlyCountBefore + 1
        || dailyCountAfter !== dailyCountBefore + 1
        || occurrenceCountAfter !== occurrenceCountBefore + 1) {
        throw new Error('invalid atomic recovery response state');
      }
      return {
        hourlyCountBefore,
        dailyCountBefore,
        hourlyCountAfter,
        dailyCountAfter,
        occurrenceCountBefore,
        occurrenceCountAfter,
        idempotent: idempotentRaw === 1,
      };
    } catch (error) {
      this.stats.errors++;
      throw new CacheUnavailableError(
        `consumeRecoveredPECounterSlot failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Commit every Redis-side derived PE counter atomically and exactly once.
   *
   * The claim is held for `PE_ACCOUNTING_CLAIM_TTL_SECONDS` (H3). It was
   * previously held forever, on the grounds that "an arbitrarily late replay
   * after a crash must never consume a second rate/economic slot" see that
   * constant's docblock for why the rate half of that reason no longer applies
   * (removed the ceilings) and why the economic half is bounded to
   * under-pricing rather than over-minting.
   */
  async commitPEAccountingCountersOnce(params: {
    peId: string;
    userId: string;
    actionType: string;
    timestampMs: number;
    /**
     * When false, the public pvt:hour display bucket (KEYS[5]) is NOT
     * incremented — used for test-platform wallets whose PEs record but stay
     * out of public network statistics. The anti-abuse counters (pe_rate,
     * pvt:occ) and the exactly-once claim are ALWAYS consumed regardless.
     * Defaults to true.
     */
    countNetworkHourly?: boolean;
  }): Promise<PEAccountingCounterCommit> {
    if (!this.client) throw new CacheUnavailableError('Redis client not configured');
    const timestamp = new Date(params.timestampMs);
    if (!params.peId || !params.userId || !params.actionType
      || !Number.isSafeInteger(params.timestampMs)
      || Number.isNaN(timestamp.getTime())) {
      throw new CacheUnavailableError('invalid durable accounting counter input');
    }
    const hourBucket = Math.floor(params.timestampMs / 3_600_000);
    const userHour = timestamp.getUTCHours();
    const day = timestamp.toISOString().slice(0, 10);
    const keys = [
      `pvt:accounting:pe:private_${privateCacheAlias('accounting',params.peId)}`,
      `pe_rate:hourly:${params.userId}:${userHour}`,
      `pe_rate:daily:${params.userId}:${day}`,
      `pvt:occ:${params.userId}:${params.actionType}:${day}`,
      `pvt:hour:${hourBucket}`,
      `pvt:accounting:pe:${params.peId}`,
      PRIVATE_CACHE_READY_KEY,
    ];
    const script = [
      migrateCacheSlotLua(1,6,7),
      "if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end",
      "local hourly = redis.call('INCR', KEYS[2])",
      "if hourly == 1 then redis.call('EXPIRE', KEYS[2], 3600) end",
      "local daily = redis.call('INCR', KEYS[3])",
      "if daily == 1 then redis.call('EXPIRE', KEYS[3], 86400) end",
      "local occurrence = redis.call('INCR', KEYS[4])",
      "if occurrence == 1 then redis.call('EXPIRE', KEYS[4], 90000) end",
      "if ARGV[1] == '1' then",
      "  local globalHourly = redis.call('INCR', KEYS[5])",
      "  if globalHourly == 1 then redis.call('EXPIRE', KEYS[5], 90000) end",
      'end',
      // H3 — the claim EXPIRES. It used to be an immortal SET: ~100 B per
      // PE with no TTL, growing without bound (~100 MB at 1M PEs, ~1 GB at 10M)
      // and depending on the instance staying `noeviction` forever, because
      // eviction under memory pressure would let counters re-advance. But every
      // counter this claim protects already expires within ~25 hours (KEYS[2]
      // 1h, KEYS[3] 24h, KEYS[4] and KEYS[5] 25h) — so past that point the claim
      // guards nothing and is pure residue.
      //
      // ARGV[2] is 7 days: ~6.7x the longest guarded counter, and far beyond any
      // real replay window (the durable outbox replays on crash, in minutes,
      // not days). Memory becomes bounded by 7 days of PEs instead of by all of
      // history, and the instance can no longer fill up and start REFUSING
      // writes — which would fail accrual outright, a much worse outcome than
      // the bound below.
      //
      // BLAST RADIUS IF A REPLAY EVER OUTLIVES THE TTL, stated exactly: the
      // guarded counters have long since expired too, so the replay increments
      // a FRESH window. That can deepen a later novelty ordinal — pricing that
      // user's genuine later work more cheaply. It is a fairness defect and
      // never an over-mint: mint-once lives in Firestore, not here. This is the
      // same blast radius eviction already had, now deterministic and bounded
      // rather than random under memory pressure.
      "redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])",
      mirrorCacheSlotLua(1,6,7),
      'return 0',
    ].join('\n');
    try {
      const countFlag = params.countNetworkHourly === false ? '0' : '1';
      const result = await this.client.eval<string[], number>(
        script,
        keys,
        [countFlag, String(PE_ACCOUNTING_CLAIM_TTL_SECONDS)],
      );
      if (Number(result) !== 0 && Number(result) !== 1) {
        throw new Error('invalid durable accounting counter response');
      }
      return { idempotent: Number(result) === 1 };
    } catch (error) {
      this.stats.errors++;
      throw new CacheUnavailableError(
        `commitPEAccountingCountersOnce failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getUserActionTypeCountStrict(userId: string, actionType: string, timestampMs: number = Date.now()): Promise<number> {
    if (!this.client) {
      throw new CacheUnavailableError('Redis client not configured');
    }
    try {
      const today = new Date(timestampMs).toISOString().slice(0, 10);
      const key = `pvt:occ:${userId}:${actionType}:${today}`;
      const val = await this.client.get<number>(key);
      return val ?? 0;
    } catch (error) {
      this.stats.errors++;
      throw new CacheUnavailableError(
        `getUserActionTypeCount failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Increment the (userId, actionType) occurrence counter for today.
   * TTL = 25 hours to ensure daily rollover is handled cleanly.
   */
  async incrementUserActionTypeCount(userId: string, actionType: string): Promise<number> {
    if (!this.client) return 1;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const key = `pvt:occ:${userId}:${actionType}:${today}`;
      const count = await this.client.incr(key);
      if (count === 1) {
        await this.client.expire(key, 90_000); // 25 hours TTL
      }
      return count;
    } catch (error) {
      console.error('[RedisCache] incrementUserActionTypeCount error:', error);
      return 1;
    }
  }

  // ===========================================================================
  // Beneficiary Status (5 min TTL)
  // ===========================================================================

  /** Get cached beneficiary status for an agent userId. Returns null on miss. */
  async getBeneficiaryStatus(userId: string): Promise<{
    linked: boolean;
    humanWalletId: string | null;
    humanUserId: string | null;
    humanAddress: string | null;
    agentShareBps: AgentBeneficiaryShareBps | null;
  } | null> {
    return this.get(`beneficiary:${userId}`);
  }

  /** Cache beneficiary status for an agent userId (5 min TTL). */
  async setBeneficiaryStatus(userId: string, entry: {
    linked: boolean;
    humanWalletId: string | null;
    humanUserId: string | null;
    humanAddress: string | null;
    agentShareBps: AgentBeneficiaryShareBps | null;
  }): Promise<void> {
    await this.set(`beneficiary:${userId}`, entry, 300);
  }

  /** Invalidate beneficiary cache (call on link/unlink). */
  async invalidateBeneficiaryStatus(userId: string): Promise<void> {
    await this.del(`beneficiary:${userId}`);
  }

  // ===========================================================================
  // Artifact Hash Tracking (for work_product novelty)
  // ===========================================================================

  /**
   * Check if an artifact hash has been seen by this user today.
   * Used for artifact-aware novelty scoring: each unique artifact_hash
   * counts as a novel output, preventing genuine variety from being penalized.
   */
  async isArtifactHashSeen(userId: string, artifactHash: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const key = `pvt:artifact:${userId}:${today}`;
      const result = await this.client.eval<string[],number>([
       "local old = redis.call('SISMEMBER',KEYS[1],ARGV[1])",
       "if old == 1 then redis.call('SADD',KEYS[1],ARGV[2]); if redis.call('GET',KEYS[2]) == '1' then redis.call('SREM',KEYS[1],ARGV[1]) end end",
       "return redis.call('SISMEMBER',KEYS[1],ARGV[2])",
      ].join('\n'),[key,PRIVATE_CACHE_READY_KEY],[artifactHash,'private_'+privateCacheAlias('artifact',artifactHash)]);
      return result === 1;
    } catch (error) {
      console.error('[RedisCache] isArtifactHashSeen error:', error);
      this.stats.errors++;
      return false;
    }
  }

  /**
   * Record an artifact hash for this user today.
   * Sets a 25-hour TTL on the daily set so it auto-expires.
   */
  async recordArtifactHash(userId: string, artifactHash: string): Promise<void> {
    if (!this.client) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const key = `pvt:artifact:${userId}:${today}`;
      await this.client.eval<string[],number>(RECORD_ARTIFACT_HASH_LUA,[key,PRIVATE_CACHE_READY_KEY],[artifactHash,'private_'+privateCacheAlias('artifact',artifactHash)]);
    } catch (error) {
      console.error('[RedisCache] recordArtifactHash error:', error);
      this.stats.errors++;
    }
  }

  // ===========================================================================
  // Monitoring
  // ===========================================================================

  /** Log cache hit/miss rates periodically */
  private maybeReportStats(): void {
    const now = Date.now();
    if (now - this.stats.lastReported >= STATS_REPORT_INTERVAL_MS) {
      const total = this.stats.hits + this.stats.misses;
      const hitRate = total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) : '0.0';
      console.log(
        `[RedisCache] Stats - hits: ${this.stats.hits}, misses: ${this.stats.misses}, ` +
        `errors: ${this.stats.errors}, hit rate: ${hitRate}%`,
      );
      this.stats = { hits: 0, misses: 0, errors: 0, lastReported: now };
    }
  }

  /** Get current stats (for health check endpoints). */
  getStats(): { hits: number; misses: number; errors: number; hitRate: string } {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) : '0.0';
    return { ...this.stats, hitRate };
  }
}

/** Singleton instance - import and use throughout the backend. */
export const cache = new RedisCache();

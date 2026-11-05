/**
 * The per-PE accounting claim now EXPIRES (H3).
 *
 * `pvt:accounting:pe:{peId}` used to be written with a bare `SET` and no expiry,
 * so the key set grew with total PE count forever and correctness depended on the
 * Redis instance being kept `noeviction` in perpetuity — a full instance with
 * that policy REFUSES writes, which fails accrual outright.
 *
 * shape: the interesting claim is "the SET carries an expiry AND the
 * idempotency guard still works", and either half alone is easy to pass while
 * breaking the other — a script that dropped the SET entirely would have a
 * perfectly good TTL story and no idempotency, and the old script had perfect
 * idempotency and unbounded memory. Both are asserted, against the real Lua the
 * production path evaluates rather than a restatement of it.
 */

import { PE_ACCOUNTING_CLAIM_TTL_SECONDS } from './cache';
import {privateCacheAlias} from './core/provenance/private-cache';

/** Minimal Redis stand-in that executes just the ops this script uses. */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  lastScript = '';
  lastKeys: string[] = [];
  lastArgv: string[] = [];

  async eval<K, R>(script: string, keys: K, argv: K): Promise<R> {
    this.lastScript = script;
    this.lastKeys = keys as unknown as string[];
    this.lastArgv = argv as unknown as string[];

    const [claimKey, hourlyKey, dailyKey, occKey, hourKey] = this.lastKeys;
    if (this.store.has(claimKey)) return 1 as unknown as R;

    for (const key of [hourlyKey, dailyKey, occKey]) {
      this.store.set(key, String(Number(this.store.get(key) ?? 0) + 1));
    }
    if (this.lastArgv[0] === '1') {
      this.store.set(hourKey, String(Number(this.store.get(hourKey) ?? 0) + 1));
    }
    // Mirror the SET the script performs, including its expiry argument.
    this.store.set(claimKey, '1');
    this.ttls.set(claimKey, Number(this.lastArgv[1]));
    return 0 as unknown as R;
  }
}

async function commit(cache: unknown, redis: FakeRedis, peId: string) {
  (cache as { client: FakeRedis }).client = redis;
  return (cache as {
    commitPEAccountingCountersOnce: (p: Record<string, unknown>) => Promise<{ idempotent: boolean }>;
  }).commitPEAccountingCountersOnce({
    peId,
    userId: 'user_1',
    actionType: 'coding_session',
    timestampMs: Date.parse('2026-08-01T12:00:00.000Z'),
  });
}

describe('per-PE accounting claim TTL', () => {
  it('is a bounded window, longer than every counter it guards', async () => {
    // The longest guarded counter (pvt:occ / pvt:hour) lives 90,000s. The claim
    // must outlive it — expiring first would let a retry double-increment a
    // counter that is still alive, which is the guard's whole job.
    expect(PE_ACCOUNTING_CLAIM_TTL_SECONDS).toBeGreaterThan(90_000);
    // And it must be FINITE. This is the actual regression: an immortal key.
    expect(Number.isFinite(PE_ACCOUNTING_CLAIM_TTL_SECONDS)).toBe(true);
    expect(PE_ACCOUNTING_CLAIM_TTL_SECONDS).toBeLessThanOrEqual(30 * 24 * 60 * 60);
  });

  it('SETs the claim WITH an expiry, and passes the TTL as an argument', async () => {
    const { cache } = await import('./cache');
    const redis = new FakeRedis();

    const result = await commit(cache, redis, 'pe_ttl_1');

    expect(result.idempotent).toBe(false);
    // Bound to the real script text, so removing the expiry from the Lua fails
    // here rather than passing on a restatement.
    expect(redis.lastScript).toContain("redis.call('SET', KEYS[1], '1', 'EX', ARGV[2])");
    expect(redis.lastScript).not.toContain("redis.call('SET', KEYS[1], '1')\n");
    expect(redis.lastArgv[1]).toBe(String(PE_ACCOUNTING_CLAIM_TTL_SECONDS));
    expect(redis.ttls.get('pvt:accounting:pe:private_'+privateCacheAlias('accounting','pe_ttl_1'))).toBe(PE_ACCOUNTING_CLAIM_TTL_SECONDS);
  });

  it('STILL guards idempotency — a replay consumes no second slot', async () => {
    // The half that must not regress. A TTL is worthless if it was bought by
    // dropping the claim.
    const { cache } = await import('./cache');
    const redis = new FakeRedis();

    const first = await commit(cache, redis, 'pe_ttl_2');
    const replay = await commit(cache, redis, 'pe_ttl_2');

    expect(first.idempotent).toBe(false);
    expect(replay.idempotent).toBe(true);
    // One increment, not two, on every guarded counter.
    expect(redis.store.get('pe_rate:hourly:user_1:12')).toBe('1');
    expect(redis.store.get('pe_rate:daily:user_1:2026-08-01')).toBe('1');
    expect(redis.store.get('pvt:occ:user_1:coding_session:2026-08-01')).toBe('1');
  });

  it('CONTROL — a DIFFERENT PE does consume its own slot', async () => {
    // Without this, the idempotency case would pass against an implementation
    // that refused every commit after the first.
    const { cache } = await import('./cache');
    const redis = new FakeRedis();

    await commit(cache, redis, 'pe_ttl_3');
    const other = await commit(cache, redis, 'pe_ttl_4');

    expect(other.idempotent).toBe(false);
    expect(redis.store.get('pe_rate:hourly:user_1:12')).toBe('2');
  });
});

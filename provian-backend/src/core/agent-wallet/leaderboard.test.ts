/**
 * Leaderboard platform:'test' exclusion.
 *
 * platform:'test' is the established smoke/integration-test marker (the
 * launch-smoke suite creates one such wallet per CI run). The public
 * leaderboard must exclude them from BOTH the ranked entries and every
 * network_stats figure — previously total_agents/total_pes/total_activity
 * counted every active wallet and a test wallet could rank publicly.
 *
 * Uses the shared createFakeFirestore (honors filters + select() projection
 * byte-exactly — the 2026-06-28 loose-mock lesson): if getLeaderboard's stats
 * query ever drops 'platform' from its select(), the projection returns docs
 * without the field and the exclusion visibly breaks here.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import type { RedisCache } from '../../cache';

// pe_count is the LIVE actor-stats tally (the per-wallet counter is
// deleted), read via readActorStats. Mock it so a test can pin a specific live
// count per agent without seeding an actor_stats_v1 document.
jest.mock('../pvt/actor-stats', () => ({
  readActorStats: jest.fn(async () => ({ pe_count: 0 })),
}));

import { getLeaderboard } from './leaderboard';
import { readActorStats } from '../pvt/actor-stats';
const mockReadActorStats = readActorStats as jest.Mock;

/** Configure the live PE count per agent_id for the current test. */
function setLiveCounts(counts: Record<string, number>): void {
  mockReadActorStats.mockImplementation(async (_db: unknown, agentId: string) => ({
    pe_count: counts[agentId] ?? 0,
  }));
}

beforeEach(() => {
  // Default: no live PEs. Individual tests opt in with setLiveCounts.
  mockReadActorStats.mockImplementation(async () => ({ pe_count: 0 }));
});

function makeCache(): RedisCache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  } as unknown as RedisCache & { store: Map<string, unknown> };
}

function seedWallet(
  fake: ReturnType<typeof createFakeFirestore>,
  id: string,
  overrides: Record<string, unknown> = {},
): void {
  fake.store.set(`agent_wallets/${id}`, {
    id,
    agent_id: id,
    display_name: id,
    address: `0x${id}`,
    platform: 'sdk',
    status: 'active',
    economic_activity_usd: 100,
    streak_days: 3,
    x402_payment_count: 1,
    badges: [],
    ...overrides,
  });
}

describe('getLeaderboard platform:test exclusion', () => {
  it('excludes test wallets from the ranked entries and every network_stats figure', async () => {
    const fake = createFakeFirestore();
    const cache = makeCache();

    // live PE counts come from actor stats, not the deleted per-wallet
    // counter. Give the test wallet the HIGHEST count so a filter regression
    // would rank it #1 and inflate total_pes.
    setLiveCounts({ real_a: 10, real_b: 4, 'launch-smoke-123': 999, revoked_c: 7 });

    seedWallet(fake, 'real_a', { economic_activity_usd: 100 });
    seedWallet(fake, 'real_b', { economic_activity_usd: 50 });
    // A test wallet with the HIGHEST scores — would rank #1 and inflate every
    // stat if the filter regressed.
    seedWallet(fake, 'launch-smoke-123', {
      platform: 'test',
      economic_activity_usd: 9_999,
    });
    // Inactive wallets never count, test or not.
    seedWallet(fake, 'revoked_c', { status: 'revoked' });

    const res = await getLeaderboard(fake as unknown as Firestore, cache);

    expect(res.network_stats.total_agents).toBe(2);
    expect(res.network_stats.total_pes_generated).toBe(14);
    expect(res.network_stats.total_economic_activity_usd).toBe(150);

    expect(res.leaderboard.map((e) => e.wallet_id)).toEqual(['real_a', 'real_b']);
    expect(res.leaderboard.some((e) => e.agent_id === 'launch-smoke-123')).toBe(false);
    expect(res.leaderboard[0].rank).toBe(1);
    // pvt_estimate_rank derives from the FILTERED agent count.
    expect(res.leaderboard[0].pvt_estimate_rank).toBeDefined();
  });

  it('serves the cached response without re-querying', async () => {
    const fake = createFakeFirestore();
    const cache = makeCache();
    seedWallet(fake, 'real_a');

    const first = await getLeaderboard(fake as unknown as Firestore, cache);
    // A test wallet appearing after the cache fill must not surface within TTL.
    seedWallet(fake, 'launch-smoke-late', { platform: 'test', governance_score: 99 });
    const second = await getLeaderboard(fake as unknown as Firestore, cache);

    expect(second).toEqual(first);
    expect(second.network_stats.total_agents).toBe(1);
  });
});

/**
 * asked whether the public leaderboard may ship at an agent-first launch.
 * The answer turned on the ROW SHAPE, so the row shape is pinned here rather
 * than eyeballed once: every field is agent protocol identity — wallet id, agent
 * id, the agent's own display name, its on-chain address, activity counters,
 * badges, rank. The wallet document it is built from also carries
 * `linked_human_wallet_id`, `linked_human_user_id` and `linked_human_address`,
 * and none of the three may ever reach this unauthenticated payload.
 *
 * A new field added to LeaderboardEntry fails this test until someone decides,
 * deliberately, which side of the line it is on.
 */
describe('leaderboard rows carry agent protocol identity and no human identity', () => {
  const PUBLISHED_FIELDS = [
    'rank', 'wallet_id', 'agent_id', 'display_name', 'address', 'composite_score',
    'pe_count', 'economic_activity_usd', 'streak_days',
    'x402_payment_count', 'badges', 'pvt_estimate_rank', 'provenance_url',
  ];
  const HUMAN_IDENTITY_FIELDS = [
    'linked_human_wallet_id', 'linked_human_user_id', 'linked_human_address',
  ];

  it('publishes exactly the agent-identity fields, and no human-linkage field', async () => {
    const fake = createFakeFirestore();
    const cache = makeCache();
    // Seeded WITH human linkage, so "absent from the row" is a real observation
    // about the projection and not an artifact of an unlinked fixture.
    seedWallet(fake, 'linked_agent', {
      linked_human_wallet_id: 'wallet_human_1',
      linked_human_user_id: 'user_human_1',
      linked_human_address: '0xhuman',
    });

    const res = await getLeaderboard(fake as unknown as Firestore, cache);
    expect(res.leaderboard).toHaveLength(1);
    const row = res.leaderboard[0] as unknown as Record<string, unknown>;

    expect(Object.keys(row).sort()).toEqual([...PUBLISHED_FIELDS].sort());
    for (const field of HUMAN_IDENTITY_FIELDS) {
      expect(row).not.toHaveProperty(field);
    }
    // The seeded values must not appear under ANY key, however renamed.
    const serialized = JSON.stringify(row);
    for (const secret of ['wallet_human_1', 'user_human_1', '0xhuman']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('NEGATIVE CONTROL: the same assertions fail on a row that did leak linkage', () => {
    const leaked = {
      rank: 1, wallet_id: 'w', agent_id: 'a', display_name: 'd', address: '0x',
      composite_score: 0, pe_count: 0, economic_activity_usd: 0,
      streak_days: 0, x402_payment_count: 0, badges: [], pvt_estimate_rank: 'building',
      provenance_url: 'u', linked_human_user_id: 'user_human_1',
    };
    expect(Object.keys(leaked).sort()).not.toEqual([...PUBLISHED_FIELDS].sort());
    expect(JSON.stringify(leaked)).toContain('user_human_1');
  });
});

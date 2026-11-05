/**
 * network-stats-projection — the BOUNDED reads behind /v1/pvt/network-stats
 * (H2 close-out: the full `wallets` scan is gone).
 *
 * Negative-control doctrine : every exclusion claim is paired with the
 * inclusion that proves the guard CAN admit — a filter test that only ever
 * sees excluded wallets would pass identically if the projection returned
 * empty for everything. The test-wallet predicate is BOUND to the canonical
 * source (TEST_PLATFORM_VALUE), the ranking field names to
 * `wallet-ranking-fields.ts`, and the week boundary to `week-start.ts` never
 * a local literal (the self-referential-control rule).
 *
 * THE THREE RED CONTROLS THE BRIEF NAMES:
 * 1. a test-platform wallet never appears — on the board, in the totals, or
 * as a rank; and the CONTROL shows real wallets ARE admitted;
 * 2. the rank for an address equals the full-scan (oracle) rank on a fixture
 * that includes ties and interleaved test wallets;
 * 3. the full scan is GONE — a source-bound control over this module and the
 * route: no unbounded `.get()` over `wallets` or `pvt_accrual`.
 */

import fs from 'fs';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import { TEST_PLATFORM_VALUE } from './core/pvt/genesis-award-state-machine';
import {
  WALLET_PE_COUNT_FIELD,
  WALLET_WEEKLY_PE_COUNT_FIELD,
  WALLET_WEEKLY_WEEK_START_FIELD,
} from './core/pvt/wallet-ranking-fields';
import { getWeekStart, WEEK_MS } from './core/pvt/week-start';
import {
  LEADERBOARD_SIZE,
  boardRankForAddress,
  countableFallbackPE,
  parseRankContext,
  parseWindow,
  readNetworkStats,
  resolveWalletRank,
  type LeaderboardWindow,
} from './network-stats-projection';

// 2026-08-13T00:00:00Z, a Thursday — getWeekStart lands on Monday 2026-08-10.
const NOW = Date.parse('2026-08-13T00:00:00Z');
const THIS_WEEK = getWeekStart(NOW);
const LAST_WEEK = THIS_WEEK - WEEK_MS;

interface WalletSeed {
  id: string;
  type: 'human' | 'agent';
  address: string;
  user_id?: string;
  agent_id?: string;
  pe_count?: number;
  platform?: string;
  public_visibility?: string;
  weekly?: { count: number; weekStart: number };
}

function seed(fake: FakeFirestore, wallets: readonly WalletSeed[]): void {
  for (const w of wallets) {
    const { weekly, pe_count, ...rest } = w;
    fake.store.set(`wallets/${w.id}`, {
      ...rest,
      ...(pe_count === undefined ? {} : { [WALLET_PE_COUNT_FIELD]: pe_count }),
      ...(weekly === undefined ? {} : {
        [WALLET_WEEKLY_PE_COUNT_FIELD]: weekly.count,
        [WALLET_WEEKLY_WEEK_START_FIELD]: weekly.weekStart,
      }),
    });
  }
}

function db(fake: FakeFirestore): Firestore {
  return fake as unknown as Firestore;
}

/**
 * THE ORACLE — the retired full scan, re-stated as the spec: every REAL wallet
 * sorted by count descending; rank = 1 + number of real wallets strictly above
 * (competition ranking). Reads the fixture, not the module under test.
 */
function oracleRank(wallets: readonly WalletSeed[], window: LeaderboardWindow, id: string): number | null {
  const count = (w: WalletSeed): number => (window === 'week'
    ? (w.weekly?.weekStart === THIS_WEEK ? w.weekly.count : 0)
    : (w.pe_count ?? 0));
  const me = wallets.find((w) => w.id === id)!;
  if (me.platform === TEST_PLATFORM_VALUE) return null;
  if (window === 'week' && count(me) <= 0) return null;
  const real = wallets.filter((w) => w.platform !== TEST_PLATFORM_VALUE);
  return 1 + real.filter((w) => count(w) > count(me)).length;
}

const REAL_HUMAN: WalletSeed = {
  id: 'wallet_real_human',
  type: 'human',
  address: '0xE326648bDF12A802C8B811037C527aDA833F5D77',
  user_id: 'user_real',
  pe_count: 4,
  weekly: { count: 3, weekStart: THIS_WEEK },
};

const REAL_AGENT: WalletSeed = {
  id: 'wallet_real_agent',
  type: 'agent',
  address: '0xaaaa00000000000000000000000000000000aaaa',
  agent_id: 'agent_real',
  pe_count: 2,
  // RED control fixture: last week's count under a STALE week start.
  weekly: { count: 99, weekStart: LAST_WEEK },
};

const TEST_WALLET: WalletSeed = {
  id: 'wallet_test_533',
  type: 'human',
  address: '0x533faf86c736dbc154dbebd65782a5bcdb38a67f',
  user_id: 'user_test_533',
  pe_count: 333, // would dominate the board if the filter ever leaked
  platform: TEST_PLATFORM_VALUE,
  weekly: { count: 50, weekStart: THIS_WEEK },
};

/**
 * The live own-record count, stubbed to EQUAL the seeded stored counter so the
 * pre-existing exclusion / over-fetch / oracle suites keep testing exactly what
 * they always did. The live re-rank has its own suite below.
 */
function storedCountAsLive(fake: FakeFirestore) {
  return async (_db: Firestore, ownerId: string): Promise<number> => {
    for (const [key, data] of fake.store.entries()) {
      if (!key.startsWith('wallets/')) continue;
      const d = data as Record<string, unknown>;
      if (d.agent_id === ownerId || d.user_id === ownerId || key === `wallets/${ownerId}`) {
        return typeof d[WALLET_PE_COUNT_FIELD] === 'number' ? (d[WALLET_PE_COUNT_FIELD] as number) : 0;
      }
    }
    return 0;
  };
}

async function stats(fake: FakeFirestore, window: LeaderboardWindow) {
  return readNetworkStats(db(fake), {
    window, now: NOW, counters: { totalPEs: 6 }, liveRecordCount: storedCountAsLive(fake),
  });
}

/** an operator-reviewed prelaunch fixture on a REAL platform — display-hidden only. */
const HIDDEN_FIXTURE: WalletSeed = {
  id: 'wallet_aw_d490_grok',
  type: 'agent',
  address: '0xd490d490d490d490d490d490d490d490d490d490',
  agent_id: 'agent_d490_grok',
  pe_count: 50, // would sit at #1 if the display mark were ignored
  platform: 'sdk',
  public_visibility: 'hidden_prelaunch_test',
  weekly: { count: 40, weekStart: THIS_WEEK },
};

describe('readNetworkStats — prelaunch fixtures (display-only mark)', () => {
  it('RED: a public_visibility-hidden fixture is off the board, the totals, and rank resolution', async () => {
    const fake = createFakeFirestore();
    seed(fake, [HIDDEN_FIXTURE, REAL_HUMAN, REAL_AGENT]);
    for (const window of ['all', 'week'] as const) {
      const projection = await stats(fake, window);
      expect(projection.statsData.leaderboard.map((e) => e.address)).not.toContain(HIDDEN_FIXTURE.address);
      expect(projection.leaderboardWalletIds).not.toContain(HIDDEN_FIXTURE.id);
      expect(projection.statsData.activeWallets).toBe(2);
      expect(projection.statsData.agentWallets).toBe(1);
      expect(await resolveWalletRank(db(fake), projection.rankContext, { data: fake.store.get(`wallets/${HIDDEN_FIXTURE.id}`) }))
        .toBeNull();
    }
    // A real wallet's rank does not count the hidden fixture above it.
    const all = await stats(fake, 'all');
    expect(await resolveWalletRank(db(fake), all.rankContext, { data: fake.store.get(`wallets/${REAL_HUMAN.id}`) }))
      .toBe(1);
  });

  it('CONTROL: the same wallet without the mark is ranked #1 (the filter is what removes it)', async () => {
    const fake = createFakeFirestore();
    const { public_visibility: _omit, ...visible } = HIDDEN_FIXTURE;
    seed(fake, [visible, REAL_HUMAN, REAL_AGENT]);
    const projection = await stats(fake, 'all');
    expect(projection.statsData.leaderboard[0]).toMatchObject({ rank: 1, address: HIDDEN_FIXTURE.address });
    expect(projection.statsData.activeWallets).toBe(3);
  });
});

describe('readNetworkStats — test-wallet exclusion', () => {
  it('RED 1: a test-platform wallet never appears — not on the board, not in a total, not as a rank', async () => {
    const fake = createFakeFirestore();
    const wallets = [TEST_WALLET, REAL_HUMAN, REAL_AGENT];
    seed(fake, wallets);
    const projection = await stats(fake, 'all');
    expect(projection.statsData.activeWallets).toBe(2);
    expect(projection.statsData.humanWallets).toBe(1);
    expect(projection.statsData.agentWallets).toBe(1);
    expect(projection.statsData.leaderboard.map((e) => e.address)).not.toContain(TEST_WALLET.address);
    expect(projection.leaderboardWalletIds).not.toContain(TEST_WALLET.id);
    expect(await resolveWalletRank(db(fake), projection.rankContext, { data: fake.store.get(`wallets/${TEST_WALLET.id}`) }))
      .toBeNull();
    // The test set's counts are what rank resolution subtracts — present, sorted.
    expect(projection.rankContext.testCounts).toEqual([333]);
  });

  it('CONTROL: real wallets ARE counted and ranked (the filter can admit)', async () => {
    const fake = createFakeFirestore();
    seed(fake, [TEST_WALLET, REAL_HUMAN, REAL_AGENT]);
    const projection = await stats(fake, 'all');
    expect(projection.statsData.leaderboard).toHaveLength(2);
    expect(projection.statsData.leaderboard[0]).toMatchObject({
      rank: 1, address: REAL_HUMAN.address, ownerType: 'human', peCount: 4,
    });
    expect(projection.statsData.leaderboard[1]).toMatchObject({
      rank: 2, address: REAL_AGENT.address, peCount: 2,
    });
    // Positional alignment with `leaderboard` is the whole contract of the ids.
    expect(projection.leaderboardWalletIds).toEqual([REAL_HUMAN.id, REAL_AGENT.id]);
    expect(projection.statsData.leaderboard[1]).not.toHaveProperty('displayName');
    expect(await resolveWalletRank(db(fake), projection.rankContext, { data: fake.store.get(`wallets/${REAL_HUMAN.id}`) }))
      .toBe(1);
  });

  it('collects every id the excluded wallet owns into testIdSet', async () => {
    const fake = createFakeFirestore();
    seed(fake, [TEST_WALLET, REAL_HUMAN]);
    const projection = await stats(fake, 'all');
    expect(projection.testIdSet).toEqual(new Set(['wallet_test_533', 'user_test_533']));
  });

  it('the over-fetch is exact: 60 test wallets outranking 55 real ones still yield a full real board', async () => {
    const fake = createFakeFirestore();
    const wallets: WalletSeed[] = [];
    for (let i = 0; i < 60; i += 1) {
      wallets.push({
        id: `t${i}`, type: 'agent', address: `0xt${i}`, agent_id: `agent_t${i}`,
        pe_count: 1000 + i, platform: TEST_PLATFORM_VALUE,
      });
    }
    for (let i = 0; i < 55; i += 1) {
      wallets.push({ id: `r${i}`, type: 'human', address: `0xr${i}`, user_id: `user_r${i}`, pe_count: 100 + i });
    }
    seed(fake, wallets);
    const projection = await stats(fake, 'all');
    expect(projection.statsData.leaderboard).toHaveLength(LEADERBOARD_SIZE);
    expect(projection.statsData.leaderboard.every((e) => e.address.startsWith('0xr'))).toBe(true);
    expect(projection.statsData.leaderboard[0]).toMatchObject({ address: '0xr54', peCount: 154 });
    expect(projection.statsData.activeWallets).toBe(55);
  });
});

describe('resolveWalletRank — equals the full-scan oracle', () => {
  const FIXTURE: WalletSeed[] = [
    TEST_WALLET,
    REAL_HUMAN,
    REAL_AGENT,
    { id: 'w_tie_a', type: 'human', address: '0x1', user_id: 'u_a', pe_count: 4, weekly: { count: 1, weekStart: THIS_WEEK } },
    { id: 'w_tie_b', type: 'agent', address: '0x2', agent_id: 'a_b', pe_count: 4, weekly: { count: 3, weekStart: THIS_WEEK } },
    { id: 'w_top', type: 'agent', address: '0x3', agent_id: 'a_top', pe_count: 9, weekly: { count: 7, weekStart: THIS_WEEK } },
    { id: 'w_zero', type: 'human', address: '0x4', user_id: 'u_zero', pe_count: 0 },
    { id: 'w_test2', type: 'agent', address: '0x5', agent_id: 'a_t2', pe_count: 5, platform: TEST_PLATFORM_VALUE, weekly: { count: 2, weekStart: THIS_WEEK } },
  ];

  it.each(['all', 'week'] as const)('RED 2 (%s window): every fixture wallet ranks exactly where the oracle puts it', async (window) => {
    const fake = createFakeFirestore();
    seed(fake, FIXTURE);
    const projection = await stats(fake, window);
    // Empty-population guard: the oracle really ranked a non-trivial set.
    expect(FIXTURE.filter((w) => w.platform !== TEST_PLATFORM_VALUE).length).toBeGreaterThan(3);
    for (const w of FIXTURE) {
      const rank = await resolveWalletRank(db(fake), projection.rankContext, { data: fake.store.get(`wallets/${w.id}`) });
      expect({ id: w.id, rank }).toEqual({ id: w.id, rank: oracleRank(FIXTURE, window, w.id) });
    }
    // The board itself is the oracle's order: exactly the oracle's ranked set,
    // listed in non-decreasing oracle rank (ties may sit in either order).
    const boardIds = projection.leaderboardWalletIds;
    const oracleRanked = FIXTURE
      .filter((w) => oracleRank(FIXTURE, window, w.id) !== null)
      .map((w) => w.id);
    expect(new Set(boardIds)).toEqual(new Set(oracleRanked));
    for (let i = 1; i < boardIds.length; i += 1) {
      expect(oracleRank(FIXTURE, window, boardIds[i - 1])!)
        .toBeLessThanOrEqual(oracleRank(FIXTURE, window, boardIds[i])!);
    }
  });

  it('a cached RankContext round-trips through JSON', async () => {
    const fake = createFakeFirestore();
    seed(fake, FIXTURE);
    const projection = await stats(fake, 'all');
    const restored = parseRankContext(JSON.parse(JSON.stringify(projection.rankContext)));
    expect(restored).toEqual(projection.rankContext);
    expect(parseRankContext({ window: 'bogus', weekStart: 1, testCounts: [] })).toBeNull();
    expect(parseRankContext(null)).toBeNull();
  });
});

describe('readNetworkStats — weekly window', () => {
  it('ranks only current-week counts; a stale week start ranks zero and is not listed', async () => {
    const fake = createFakeFirestore();
    seed(fake, [REAL_HUMAN, REAL_AGENT]);
    const projection = await stats(fake, 'week');
    expect(projection.statsData.leaderboard).toHaveLength(1);
    expect(projection.statsData.leaderboard[0]).toMatchObject({ address: REAL_HUMAN.address, peCount: 3 });
    // RED control: the inactive wallet with 99 under LAST week never appears…
    expect(projection.leaderboardWalletIds).not.toContain(REAL_AGENT.id);
    // …and has no weekly rank.
    expect(await resolveWalletRank(db(fake), projection.rankContext, { data: fake.store.get(`wallets/${REAL_AGENT.id}`) }))
      .toBeNull();
  });

  it('a test wallet with weekly counts still never ranks', async () => {
    const fake = createFakeFirestore();
    seed(fake, [TEST_WALLET, REAL_HUMAN]);
    const projection = await stats(fake, 'week');
    expect(projection.statsData.leaderboard.map((e) => e.address)).toEqual([REAL_HUMAN.address]);
    expect(projection.rankContext).toMatchObject({ window: 'week', weekStart: THIS_WEEK, testCounts: [50] });
  });
});

describe('RED 3: the full scan is GONE (source-bound)', () => {
  const projectionSource = fs.readFileSync(require.resolve('./network-stats-projection'), 'utf8');
  const serverSource = fs.readFileSync(require.resolve('./server'), 'utf8');
  const routeStart = serverSource.indexOf("app.get('/v1/pvt/network-stats'");
  const routeEnd = serverSource.indexOf('// PARTICIPATION SUMMARY', routeStart);
  const route = serverSource.slice(routeStart, routeEnd);

  /** An unbounded read: a `wallets`/`pvt_accrual` collection reference reaching `.get()` with no limit/count/platform filter in between. */
  const UNBOUNDED = /collection\(['"](wallets|pvt_accrual)['"]\)(?:(?!\.limit\(|\.count\(|where\('platform'|\.doc\()[\s\S]){0,200}?\.get\(\)/;

  it('neither the projection nor the route issues an unbounded wallets / pvt_accrual read', () => {
    expect(routeStart).toBeGreaterThan(-1);
    expect(projectionSource).not.toMatch(UNBOUNDED);
    expect(route).not.toMatch(UNBOUNDED);
    // The retired shapes, by name.
    expect(route).not.toContain("db.collection('wallets').get()");
    expect(route).not.toContain("db.collection('pvt_accrual').get()");
    expect(route).not.toContain('_rankByAddress');
    expect(projectionSource).not.toContain('rankByAddress');
    expect(projectionSource).not.toContain('buildNetworkStats');
  });

  it('CONTROL: the detector fires on the retired scan shape', () => {
    expect("const walletsSnapshot = await db.collection('wallets').get();").toMatch(UNBOUNDED);
    expect("await db.collection('pvt_accrual').get()").toMatch(UNBOUNDED);
    // …and stays quiet on the bounded shapes the module actually uses.
    expect("db.collection('wallets').where('platform', '==', TEST_PLATFORM_VALUE).get()").not.toMatch(UNBOUNDED);
    expect("db.collection('wallets').orderBy('pe_count', 'desc').limit(50).get()").not.toMatch(UNBOUNDED);
    expect("db.collection('wallets').count().get()").not.toMatch(UNBOUNDED);
  });

  it('the board ranks by PE count, never by pvt_earned / estimated PVT', () => {
    expect(projectionSource).toContain("orderBy(WALLET_PE_COUNT_FIELD, 'desc')");
    expect(projectionSource).not.toContain('pvt_earned');
    expect(projectionSource).not.toContain('totalEstimatedPVT');
  });
});

describe('parseWindow', () => {
  it('defaults absent/empty to all, passes both valid values, nulls anything else', () => {
    expect(parseWindow(undefined)).toBe('all');
    expect(parseWindow('')).toBe('all');
    expect(parseWindow('all')).toBe('all');
    expect(parseWindow('week')).toBe('week');
    expect(parseWindow('bogus')).toBeNull();
    expect(parseWindow(['week'])).toBeNull();
  });
});

describe('countableFallbackPE (pesLast24h Firestore fallback filter)', () => {
  const testIds = new Set(['user_test_533']);

  it('drops test-wallet ids and synthetic load-test identities', () => {
    expect(countableFallbackPE('user_test_533', testIds)).toBe(false);
    expect(countableFallbackPE('loadtest_42', testIds)).toBe(false);
    expect(countableFallbackPE('k6_loadtest_7', testIds)).toBe(false);
    expect(countableFallbackPE('system', testIds)).toBe(false);
  });

  it('CONTROL: real ids pass — the filter drops nothing from a real-only input', () => {
    expect(countableFallbackPE('user_real', testIds)).toBe(true);
    expect(countableFallbackPE('agent_real', new Set())).toBe(true);
  });
});

describe('readNetworkStats — all-time board ranks OWN records (not the beneficiary-inflated counter)', () => {
  // Production shape (2026-09-22): a human's stored pe_count also rises for
  // every PE of its linked agent, so the stored board showed the human at
  // 6512 while its profile said 4099 — the agent's work counted twice.
  const HUMAN: WalletSeed = { id: 'wallet_h', type: 'human', address: '0xhhhh', user_id: 'user_h', pe_count: 6512 };
  const AGENT: WalletSeed = { id: 'wallet_a', type: 'agent', address: '0xaaaa', agent_id: 'atlas', pe_count: 3314 };
  const LIVE: Record<string, number> = { user_h: 4099, atlas: 3314 };
  const live = async (_db: Firestore, ownerId: string): Promise<number> => LIVE[ownerId] ?? 0;

  it('shows each wallet\'s live own-record count, resolved by owner id', async () => {
    const fake = createFakeFirestore();
    seed(fake, [HUMAN, AGENT]);
    const p = await readNetworkStats(db(fake), { window: 'all', now: NOW, counters: { totalPEs: 0 }, liveRecordCount: live });
    expect(p.statsData.leaderboard.map((e) => [e.address, e.peCount, e.rank])).toEqual([
      ['0xhhhh', 4099, 1],
      ['0xaaaa', 3314, 2],
    ]);
    expect(p.leaderboardOwnerIds).toEqual(['user_h', 'atlas']);
  });

  it('re-sorts by the live count when it disagrees with the stored order', async () => {
    const fake = createFakeFirestore();
    seed(fake, [HUMAN, AGENT]);
    const p = await readNetworkStats(db(fake), {
      window: 'all', now: NOW, counters: { totalPEs: 0 },
      liveRecordCount: async (_d, id) => (id === 'atlas' ? 5000 : 4099),
    });
    expect(p.statsData.leaderboard.map((e) => e.address)).toEqual(['0xaaaa', '0xhhhh']);
    expect(p.leaderboardWalletIds).toEqual(['wallet_a', 'wallet_h']); // alignment survives the re-sort
  });

  it('ties share a rank (competition ranking, like resolveWalletRank)', async () => {
    const fake = createFakeFirestore();
    seed(fake, [HUMAN, AGENT]);
    const p = await readNetworkStats(db(fake), {
      window: 'all', now: NOW, counters: { totalPEs: 0 }, liveRecordCount: async () => 7,
    });
    expect(p.statsData.leaderboard.map((e) => e.rank)).toEqual([1, 1]);
  });

  it('a live-count read failure keeps that row\'s stored count', async () => {
    const fake = createFakeFirestore();
    seed(fake, [HUMAN, AGENT]);
    const p = await readNetworkStats(db(fake), {
      window: 'all', now: NOW, counters: { totalPEs: 0 },
      liveRecordCount: async (_d, id) => { if (id === 'user_h') throw new Error('count down'); return 3314; },
    });
    expect(p.statsData.leaderboard.find((e) => e.address === '0xhhhh')?.peCount).toBe(6512);
  });

  it('the weekly board is untouched (its counter is already actor-only)', async () => {
    const fake = createFakeFirestore();
    seed(fake, [{ ...HUMAN, weekly: { count: 858, weekStart: THIS_WEEK } }]);
    let called = 0;
    const p = await readNetworkStats(db(fake), {
      window: 'week', now: NOW, counters: { totalPEs: 0 }, liveRecordCount: async () => { called += 1; return 1; },
    });
    expect(called).toBe(0);
    expect(p.statsData.leaderboard[0].peCount).toBe(858);
  });
});

describe('boardRankForAddress', () => {
  const board = [{ rank: 1, address: '0xAbC' }, { rank: 2, address: '0xdef' }];
  it('finds the row case-insensitively', () => {
    expect(boardRankForAddress(board, '0xabc')).toBe(1);
    expect(boardRankForAddress(board, '0xDEF')).toBe(2);
  });
  it('null when absent or the board is not an array', () => {
    expect(boardRankForAddress(board, '0x999')).toBeNull();
    expect(boardRankForAddress(undefined, '0xabc')).toBeNull();
    expect(boardRankForAddress(board, undefined)).toBeNull();
  });
});

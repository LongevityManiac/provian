/**
 * network-stats-projection — the BOUNDED reads behind GET /v1/pvt/network-stats.
 *
 * H2 CLOSE-OUT. This module used to be a pure ranking over a FULL
 * `wallets` scan the caller fed it (every real wallet sorted by pe_count so a
 * cached blob could answer any caller's rank), plus a full `pvt_accrual` scan
 * for the weekly window. Both scans are GONE. Every read here is bounded:
 *
 * totals — `count()` aggregations (all wallets; human wallets), minus the
 * test set, so activeWallets/humanWallets/agentWallets cost a
 * handful of index reads regardless of population;
 * the board — ONE ordered query, `limit(50 + T)` where T is the number of
 * test wallets, filtered in memory to the top 50 REAL rows. The
 * over-fetch is exact: even if every test wallet outranked every
 * real one, 50 real rows survive;
 * the rank — for an arbitrary address, `count()` of wallets ranked ABOVE
 * the caller's own count, minus the test wallets above it
 * (known from the test set), plus one. Competition ranking
 * (ties share a rank) — the one deliberate semantic change from
 * the sorted-array position, which broke ties arbitrarily;
 * the tests — `where('platform', '==', 'test')` is the ONLY wallet set read
 * in full. Its size T is bounded by test data, not by the
 * network, and it is what makes every exclusion above exact.
 *
 * WEEKLY WINDOW. The weekly count now lives ON the wallet document
 * (`weekly_pe_count` / `weekly_week_start`, maintained by the durable-accrual
 * effects — see `core/pvt/wallet-ranking-fields.ts`), so the weekly board is
 * the same bounded query over a composite index (weekly_week_start ASC,
 * weekly_pe_count DESC). The `weekStart` EQUALITY GUARD survives as the query's
 * equality clause: a wallet inactive this week carries a stale week start and
 * simply does not match. Two consequences worth stating: a wallet whose weekly
 * fields predate the backfill (`scripts/backfill-wallet-weekly-counters.ts`)
 * ranks 0 this week until its next PE; and the id-space duality (one wallet
 * accruing under BOTH its user_id and its agent_id) collapses by construction,
 * because the effects resolve either id to the same wallet document.
 *
 * WHY THIS FILE LIVES AT src/ AND NOT src/core/pvt/: the money-path tripwire
 * pins every byte under core/pvt/. This module is a READ projection — it
 * moves no value and consumes no authority — so it deliberately sits outside
 * the pinned prefix while still importing the ONE canonical test-wallet
 * predicate (isTestPlatformWallet / TEST_PLATFORM_VALUE) and the ONE
 * declaration of the ranking field names, never re-typing either.
 *
 * Test-data policy (the invariant: , 2026-08-13): public network
 * statistics count REAL wallets only. A wallet marked platform:'test' and
 * every id it owns — is excluded from activeWallets, the human/agent tallies,
 * the leaderboard, rank resolution, and the pesLast24h fallback filter. PEs
 * themselves are never deleted or modified; this is a statistics filter.
 */

import type { Firestore, Query } from 'firebase-admin/firestore';
import { TEST_PLATFORM_VALUE } from './core/pvt/genesis-award-state-machine';
import { HIDDEN_PRELAUNCH_TEST, isExcludedFromPublicDisplay } from './core/commons/public-visibility';
import {
  WALLET_PE_COUNT_FIELD,
  WALLET_WEEKLY_PE_COUNT_FIELD,
  WALLET_WEEKLY_WEEK_START_FIELD,
  currentWeekWalletCount,
} from './core/pvt/wallet-ranking-fields';
import { getWeekStart } from './core/pvt/week-start';
import { countVisibleAgentPEs } from './core/agent-wallet/agent-pe-activity';

export type LeaderboardWindow = 'all' | 'week';

export const LEADERBOARD_SIZE = 50;
const WALLETS_COLLECTION = 'wallets';

export interface NetworkStatsLeaderboardEntry {
  rank: number;
  address: string;
  ownerType: 'human' | 'agent';
  displayName?: string;
  peCount: number;
}

/**
 * What a later rank resolution needs from the projection that produced a
 * board: the window, the week it ranked, and the ranked counts of the TEST
 * wallets (sorted descending) so they can be subtracted from a count() of
 * "wallets above the caller" without touching any other row. Small and
 * cacheable beside the public blob.
 */
export interface RankContext {
  readonly window: LeaderboardWindow;
  readonly weekStart: number;
  readonly testCounts: readonly number[];
}

export interface NetworkStatsProjection {
  statsData: {
    totalPEs: number;
    activeWallets: number;
    humanWallets: number;
    agentWallets: number;
    pesLast24h: number;
    leaderboard: NetworkStatsLeaderboardEntry[];
  };
  /**
   * Wallet doc ids behind `statsData.leaderboard`, in the SAME order, so a
   * caller can join per-row extras (agent display names) with a bounded lookup
   * instead of scanning a collection to build a map it barely reads.
   */
  leaderboardWalletIds: string[];
  /**
   * The owner id behind each row (agent → agent_id, human → user_id, else the
   * doc id), positionally aligned with `leaderboard`, for the bounded public
   * name join. Never served.
   */
  leaderboardOwnerIds: string[];
  rankContext: RankContext;
  /** Every id owned by an excluded (test) wallet: doc id, user_id, agent_id. */
  testIdSet: Set<string>;
}

/**
 * A wallet's own-work record count — the same resolution the Commons profile
 * and registry use (agent → agent_id, human → user_id). Injected so tests can
 * stub it; production reads the live visible PE count.
 */
export type LiveRecordCount = (db: Firestore, ownerId: string) => Promise<number>;

function ownerIdOf(wallet: RankableWallet): string {
  return wallet.agent_id ?? wallet.user_id ?? wallet.id;
}

export function parseWindow(value: unknown): LeaderboardWindow | null {
  if (value === undefined || value === null || value === '') return 'all';
  if (value === 'all' || value === 'week') return value;
  return null;
}

/** Prefixes of synthetic load-test identities that never had a wallets doc. */
const SYNTHETIC_ID_PREFIXES = ['loadtest_', 'k6_loadtest_'];
const SYNTHETIC_IDS = new Set(['system']);

export function isSyntheticTestId(userId: string): boolean {
  if (SYNTHETIC_IDS.has(userId)) return true;
  return SYNTHETIC_ID_PREFIXES.some((p) => userId.startsWith(p));
}

interface RankableWallet {
  readonly id: string;
  readonly type: 'human' | 'agent';
  readonly address: string;
  readonly user_id?: string;
  readonly agent_id?: string;
  readonly platform?: string;
  readonly count: number;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toRankable(
  id: string,
  data: Record<string, unknown> | undefined,
  window: LeaderboardWindow,
  weekStart: number,
): RankableWallet {
  return {
    id,
    type: data?.type === 'agent' ? 'agent' : 'human',
    address: typeof data?.address === 'string' ? data.address : '',
    user_id: typeof data?.user_id === 'string' ? data.user_id : undefined,
    agent_id: typeof data?.agent_id === 'string' ? data.agent_id : undefined,
    platform: typeof data?.platform === 'string' ? data.platform : undefined,
    count: window === 'week'
      ? currentWeekWalletCount(data, weekStart)
      : numberOrZero(data?.[WALLET_PE_COUNT_FIELD]),
  };
}

/** The ordered board query for a window — the single place the sort key is chosen. */
function boardQuery(db: Firestore, window: LeaderboardWindow, weekStart: number): Query {
  const wallets = db.collection(WALLETS_COLLECTION);
  // Ranked by PE COUNT, never by the legacy earned-PVT display counters: those
  // were sealed-time estimates, not settled PVT (see the network-stats route's
  // own note), and a public board must not present them as money.
  return window === 'week'
    ? wallets
      .where(WALLET_WEEKLY_WEEK_START_FIELD, '==', weekStart)
      .orderBy(WALLET_WEEKLY_PE_COUNT_FIELD, 'desc')
    : wallets.orderBy(WALLET_PE_COUNT_FIELD, 'desc');
}

/** Wallets ranked strictly ABOVE `count` in a window — the rank query. */
function aboveQuery(db: Firestore, window: LeaderboardWindow, weekStart: number, count: number): Query {
  const wallets = db.collection(WALLETS_COLLECTION);
  return window === 'week'
    ? wallets
      .where(WALLET_WEEKLY_WEEK_START_FIELD, '==', weekStart)
      .where(WALLET_WEEKLY_PE_COUNT_FIELD, '>', count)
      .orderBy(WALLET_WEEKLY_PE_COUNT_FIELD, 'desc')
    : wallets.where(WALLET_PE_COUNT_FIELD, '>', count);
}

async function readTestWallets(
  db: Firestore,
  window: LeaderboardWindow,
  weekStart: number,
): Promise<RankableWallet[]> {
  // an operator-reviewed prelaunch fixture (public_visibility:
  // 'hidden_prelaunch_test') is off the board exactly like a platform:'test'
  // wallet. Two equality reads, unioned by id (a doc can carry both marks).
  const [testSnap, hiddenSnap] = await Promise.all([
    db.collection(WALLETS_COLLECTION).where('platform', '==', TEST_PLATFORM_VALUE).get(),
    db.collection(WALLETS_COLLECTION).where('public_visibility', '==', HIDDEN_PRELAUNCH_TEST).get(),
  ]);
  const byId = new Map<string, RankableWallet>();
  for (const doc of [...testSnap.docs, ...hiddenSnap.docs]) {
    if (!byId.has(doc.id)) byId.set(doc.id, toRankable(doc.id, doc.data(), window, weekStart));
  }
  return [...byId.values()];
}

async function countQuery(query: Query): Promise<number> {
  return (await query.count().get()).data().count;
}

/**
 * Read the network stats for a window with BOUNDED queries only. `counters`
 * is the sharded network PE total the caller already sums; `pesLast24h` is
 * patched in by the caller (its Firestore fallback needs `testIdSet`).
 */
export async function readNetworkStats(
  db: Firestore,
  params: {
    readonly window: LeaderboardWindow;
    readonly now: number;
    readonly counters: { totalPEs: number };
    readonly liveRecordCount?: LiveRecordCount;
  },
): Promise<NetworkStatsProjection> {
  const { window, now, counters } = params;
  const liveRecordCount = params.liveRecordCount ?? countVisibleAgentPEs;
  const weekStart = getWeekStart(now);
  const wallets = db.collection(WALLETS_COLLECTION);

  const [testWallets, totalWallets, humanTotal] = await Promise.all([
    readTestWallets(db, window, weekStart),
    countQuery(wallets),
    countQuery(wallets.where('type', '==', 'human')),
  ]);

  const testIdSet = new Set<string>();
  let testHumans = 0;
  for (const wallet of testWallets) {
    testIdSet.add(wallet.id);
    if (wallet.user_id) testIdSet.add(wallet.user_id);
    if (wallet.agent_id) testIdSet.add(wallet.agent_id);
    if (wallet.type === 'human') testHumans += 1;
  }
  const activeWallets = Math.max(0, totalWallets - testWallets.length);
  const humanWallets = Math.max(0, humanTotal - testHumans);
  const agentWallets = Math.max(0, activeWallets - humanWallets);

  // Over-fetch by exactly T so the top-50 REAL rows survive any interleaving.
  const boardSnap = await boardQuery(db, window, weekStart)
    .limit(LEADERBOARD_SIZE + testWallets.length)
    .get();
  const board: RankableWallet[] = [];
  for (const doc of boardSnap.docs) {
    const data = doc.data();
    if (isExcludedFromPublicDisplay(data)) continue;
    const wallet = toRankable(doc.id, data, window, weekStart);
    // The weekly query already filtered on the week; the all-time query orders
    // by pe_count so zero-count rows can only trail. Either way a zero never
    // ranks on the weekly board (parity with the pre-existing filter).
    if (window === 'week' && wallet.count <= 0) continue;
    board.push(wallet);
    if (board.length >= LEADERBOARD_SIZE) break;
  }

  // ALL-TIME: rank by each wallet's OWN records, not the stored `pe_count`. For a
  // human that counter also rises by one for every PE of a linked agent (the
  // beneficiary leg in durable-accrual-effects), so the stored board counted an
  // agent's work twice — once on the agent's row and again on its human's — and
  // disagreed with the profile/registry count for the same wallet. The stored
  // counter still selects the bounded candidate set (it is >= the own count for
  // every wallet that has a linked agent, so the real top rows are in it); the
  // candidates are then re-counted live and re-sorted. A read failure keeps the
  // stored count for that row (display-only). The weekly counter is already
  // actor-only, so the weekly board is untouched.
  let ranked = board;
  if (window === 'all') {
    const recounted = await Promise.all(board.map(async (c) => {
      try {
        return { ...c, count: await liveRecordCount(db, ownerIdOf(c)) };
      } catch {
        return c;
      }
    }));
    ranked = recounted
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (b.c.count - a.c.count) || (a.i - b.i))
      .map(({ c }) => c);
  }

  // Competition ranking (ties share a rank), matching resolveWalletRank.
  const leaderboard: NetworkStatsLeaderboardEntry[] = [];
  ranked.forEach((c, i) => {
    const prev = leaderboard[i - 1];
    const rank = prev !== undefined && ranked[i - 1].count === c.count ? prev.rank : i + 1;
    leaderboard.push({ rank, address: c.address, ownerType: c.type, peCount: c.count });
  });

  return {
    statsData: {
      totalPEs: counters.totalPEs,
      activeWallets,
      humanWallets,
      agentWallets,
      pesLast24h: 0,
      leaderboard,
    },
    leaderboardWalletIds: ranked.map((c) => c.id),
    leaderboardOwnerIds: ranked.map(ownerIdOf),
    rankContext: {
      window,
      weekStart,
      testCounts: testWallets.map((w) => w.count).sort((a, b) => b - a),
    },
    testIdSet,
  };
}

/**
 * The rank of ONE wallet on the board a `RankContext` describes, by a bounded
 * `count()` of the rows above it. Null for a test wallet (it has no rank on a
 * real-only board) and for a weekly rank of a wallet with no PE this week
 * (the weekly board never listed zeros).
 */
export async function resolveWalletRank(
  db: Firestore,
  context: RankContext,
  wallet: { readonly data: Record<string, unknown> | undefined },
): Promise<number | null> {
  if (isExcludedFromPublicDisplay(wallet.data)) return null;
  const own = toRankable('', wallet.data, context.window, context.weekStart).count;
  if (context.window === 'week' && own <= 0) return null;
  const above = await countQuery(aboveQuery(db, context.window, context.weekStart, own));
  let testAbove = 0;
  for (const count of context.testCounts) {
    if (count > own) testAbove += 1;
    else break; // sorted descending
  }
  return Math.max(0, above - testAbove) + 1;
}

/**
 * The rank a served board gives `address` (case-insensitive), or null when the
 * address is not on it. The board holds only real wallets, so a test wallet
 * never matches. `leaderboard` is the (possibly cached, JSON) public board.
 */
export function boardRankForAddress(leaderboard: unknown, address: string | undefined): number | null {
  if (!Array.isArray(leaderboard) || typeof address !== 'string' || address.length === 0) return null;
  const want = address.toLowerCase();
  for (const row of leaderboard) {
    if (row && typeof row === 'object') {
      const r = row as Record<string, unknown>;
      if (typeof r.address === 'string' && r.address.toLowerCase() === want && typeof r.rank === 'number') {
        return r.rank;
      }
    }
  }
  return null;
}

/**
 * Filter for the pesLast24h Firestore fallback (Redis miss): drop PEs whose
 * userId belongs to a test wallet or is a synthetic load-test identity.
 */
export function countableFallbackPE(userId: string, testIdSet: Set<string>): boolean {
  if (testIdSet.has(userId)) return false;
  if (isSyntheticTestId(userId)) return false;
  return true;
}

/** Re-hydrate a cached RankContext (the blob is JSON; Sets and readonly arrays do not survive). */
export function parseRankContext(value: unknown): RankContext | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const window = raw.window === 'all' || raw.window === 'week' ? raw.window : null;
  if (window === null || typeof raw.weekStart !== 'number' || !Array.isArray(raw.testCounts)) return null;
  return {
    window,
    weekStart: raw.weekStart,
    testCounts: raw.testCounts.filter((n): n is number => typeof n === 'number'),
  };
}

/**
 * Agent Leaderboard - Redis-cached ranking
 *
 * Composite score (no governance signal, no stored PE tally):
 * livePeCount * 1.0 + economic_activity_usd * 0.1 + streak_days * 10
 * + x402_payment_count * 5
 *
 * `livePeCount` is the actor-stats live tally (`actor_stats_v1.pe_count`),
 * never the deleted per-wallet `pe_count` counter. The former `governance_score`
 * term (× 50) is gone with the field.
 *
 * Cached in Redis with 5-minute TTL. Public endpoint, no auth required.
 */

import { isExcludedFromPublicDisplay } from '../commons/public-visibility';
import type { Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { readActorStats } from '../pvt/actor-stats';
import { makeAgentProvenanceUrl } from '../../provenance-links';
import type {
  AgentWalletDocument,
  LeaderboardEntry,
  LeaderboardResponse,
  AgentProfileResponse,
} from './types';

const LEADERBOARD_CACHE_KEY = 'agent:leaderboard';
const LEADERBOARD_TTL_SECONDS = 300; // 5 minutes
const LEADERBOARD_LIMIT = 100;

/**
 * Estimate PVT rank tier based on position in leaderboard.
 */
export function estimatePVTRank(rank: number, totalAgents: number): string {
  if (totalAgents === 0) return 'building';
  const percentile = (rank / totalAgents) * 100;
  if (percentile <= 1) return 'top_1%';
  if (percentile <= 5) return 'top_5%';
  if (percentile <= 10) return 'top_10%';
  if (percentile <= 25) return 'top_25%';
  return 'building';
}

/** The live visible-PE count for an agent (actor stats; 0 when unreadable). */
async function livePECount(db: Firestore, agentId: string): Promise<number> {
  try {
    const stats = await readActorStats(db, agentId);
    return stats?.pe_count ?? 0;
  } catch {
    return 0;
  }
}

/** Composite ranking score from a wallet plus its live PE count. */
function compositeFrom(wallet: AgentWalletDocument, livePeCount: number): number {
  return (
    livePeCount * 1.0 +
    wallet.economic_activity_usd * 0.1 +
    wallet.streak_days * 10 +
    wallet.x402_payment_count * 5
  );
}

/**
 * Get the agent leaderboard. Returns cached version if available.
 */
export async function getLeaderboard(
  db: Firestore,
  cache: RedisCache,
): Promise<LeaderboardResponse> {
  // Check cache first
  const cached = await cache.get<LeaderboardResponse>(LEADERBOARD_CACHE_KEY);
  if (cached) return cached;

  // Candidate set: active agent wallets ordered by economic activity (a real,
  // present signal — governance_score, the former order key, is deleted).
  // platform:'test' wallets (the launch-smoke marker) are excluded IN MEMORY,
  // same convention as commons feed total_agents.
  const snapshot = await db
    .collection('agent_wallets')
    .where('status', '==', 'active')
    .orderBy('economic_activity_usd', 'desc')
    .limit(LEADERBOARD_LIMIT)
    .get();

  const wallets: AgentWalletDocument[] = snapshot.docs
    .map((doc) => {
      const data = doc.data() as AgentWalletDocument;
      return { ...data, id: data.id || doc.id };
    })
    .filter((w) => !isExcludedFromPublicDisplay(w));

  // Live PE counts for the candidate set (actor stats).
  const liveCounts = await Promise.all(wallets.map((w) => livePECount(db, w.agent_id)));
  const liveCountByWalletId = new Map<string, number>();
  wallets.forEach((w, i) => liveCountByWalletId.set(w.id, liveCounts[i]));

  // Sort by composite score (candidate set fetched by economic activity, then
  // re-ranked by the full composite in memory).
  wallets.sort(
    (a, b) =>
      compositeFrom(b, liveCountByWalletId.get(b.id) ?? 0) -
      compositeFrom(a, liveCountByWalletId.get(a.id) ?? 0),
  );

  // Network stats over the candidate set.
  const totalAgents = wallets.length;
  let total_pes = 0;
  let total_activity = 0;
  for (const w of wallets) {
    total_pes += liveCountByWalletId.get(w.id) ?? 0;
    total_activity += w.economic_activity_usd || 0;
  }

  const leaderboard: LeaderboardEntry[] = wallets.map((w, idx) => {
    const rank = idx + 1;
    const walletId = w.id;
    const livePeCount = liveCountByWalletId.get(walletId) ?? 0;
    return {
      rank,
      wallet_id: walletId,
      agent_id: w.agent_id,
      display_name: w.display_name,
      address: w.address,
      composite_score: compositeFrom(w, livePeCount),
      pe_count: livePeCount,
      economic_activity_usd: w.economic_activity_usd,
      streak_days: w.streak_days,
      x402_payment_count: w.x402_payment_count,
      badges: w.badges,
      pvt_estimate_rank: estimatePVTRank(rank, totalAgents),
      provenance_url: makeAgentProvenanceUrl(walletId),
    };
  });

  const response: LeaderboardResponse = {
    network_stats: {
      total_agents: totalAgents,
      total_pes_generated: total_pes,
      total_economic_activity_usd: total_activity,
    },
    leaderboard,
    cached_at: Date.now(),
  };

  // Cache the result
  await cache.set(LEADERBOARD_CACHE_KEY, response, LEADERBOARD_TTL_SECONDS);

  return response;
}

/**
 * Get a public agent profile by agent_id.
 */
export async function getAgentProfile(
  db: Firestore,
  cache: RedisCache,
  agentId: string,
): Promise<AgentProfileResponse | null> {
  const cacheKey = `agent:profile:${agentId}`;
  const cached = await cache.get<AgentProfileResponse>(cacheKey);
  if (cached) return cached;

  const snapshot = await db
    .collection('agent_wallets')
    .where('agent_id', '==', agentId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const wallet = snapshot.docs[0].data() as AgentWalletDocument;
  const walletId = wallet.id || snapshot.docs[0].id;
  const livePeCount = await livePECount(db, wallet.agent_id);
  const compositeScore = compositeFrom(wallet, livePeCount);

  // Rank by counting active agents with higher economic activity (the candidate
  // order key). Approximate — the leaderboard re-ranks by full composite.
  const higherSnapshot = await db
    .collection('agent_wallets')
    .where('status', '==', 'active')
    .where('economic_activity_usd', '>', wallet.economic_activity_usd)
    .select()
    .get();

  const totalSnapshot = await db
    .collection('agent_wallets')
    .where('status', '==', 'active')
    .select()
    .get();

  const approximateRank = higherSnapshot.size + 1;
  const totalAgents = totalSnapshot.size;

  const profile: AgentProfileResponse = {
    wallet_id: walletId,
    agent_id: wallet.agent_id,
    display_name: wallet.display_name,
    platform: wallet.platform,
    address: wallet.address,
    pe_count: livePeCount,
    badges: wallet.badges,
    streak_days: wallet.streak_days,
    economic_activity_usd: wallet.economic_activity_usd,
    x402_payment_count: wallet.x402_payment_count,
    composite_score: compositeScore,
    rank: approximateRank,
    pvt_estimate_rank: estimatePVTRank(approximateRank, totalAgents),
    provenance_url: makeAgentProvenanceUrl(walletId),
    created_at: wallet.created_at,
  };

  // Cache for 5 minutes
  await cache.set(cacheKey, profile, LEADERBOARD_TTL_SECONDS);

  return profile;
}

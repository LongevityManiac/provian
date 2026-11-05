import {publicProjection} from './projection-privacy';
/**
 * Provian Commons - Feed & Stats Aggregation
 *
 * Provides the runtime boundary-safe network stats and activity surfaces. Economic
 * institution rows may remain as historical records, but their presence must
 * never advertise an unavailable runtime as active.
 */

import {
  COMMONS_SAFETY_LIMITS,
  COMMONS_COLLECTIONS,
  type CommonsDeps,
  type FeedItem,
} from './types';
import { makeAgentProvenanceUrl } from '../../provenance-links';
import type { GovernanceProposalDocument } from '../agent-bank/types';
import { getPvtAddressForChain } from '../agent-bank/pvt-principal-config';
import { readErc20TotalSupply } from '../onchain/tx-verifier';
import { PVT_BURN_RECORDS_COLLECTION } from './burn-consumption';
import { computeEffectiveStatus } from '../governance/effective-status';
import { getQuorumContext } from '../governance/quorum-context';
import { HIDDEN_PRELAUNCH_TEST, HIDDEN_VISIBILITY_VALUES, isHiddenPrelaunchTest } from './public-visibility';

const L = COMMONS_SAFETY_LIMITS;

// ─── Network Stats ──────────────────────────────────────────────────────────

export async function getNetworkStats(
  deps: CommonsDeps,
): Promise<Record<string, unknown>> {
  // v2: added commons_humans / commons_agents (the Commons dashboard tiles now
  // read a humans-vs-agents split of the SAME profiles collection instead of
  // labelling "Members" — which included agents — beside a network agent count).
  const cacheKey = 'commons:network_stats:public-cleanup-v5';
  const cached = await deps.cache.get<string>(cacheKey);
  if (cached) return typeof cached === 'string' ? JSON.parse(cached) : cached;

  // Only live record surfaces contribute current network metrics. Legacy
  // jobs, escrow, Court, and governance rows are deliberately not queried.
  const [agentWalletsSnap, hiddenAgentWalletsSnap, commonsProfilesSnap, hiddenProfilesSnap, commonsAgentProfilesSnap, hiddenAgentProfilesSnap, forumPostsSnap, hiddenForumPostsSnap] = await Promise.all([
    // Exclude smoke/integration-test agents (platform === 'test') so test
    // runs don't inflate the public agent count. `platform` is a required
    // field on agent signup, so no real wallet is dropped by this filter.
    deps.db.collection('agent_wallets').where('platform', '!=', 'test').count().get(),
    // operator-reviewed prelaunch fixtures are off the public count too
    // (display only). A small bounded read; only the non-test ones are
    // subtracted, since platform:'test' rows are already outside the count.
    deps.db.collection('agent_wallets').where('public_visibility', '==', HIDDEN_PRELAUNCH_TEST).get(),
    deps.db.collection(COMMONS_COLLECTIONS.PROFILES).count().get(),
    deps.db.collection(COMMONS_COLLECTIONS.PROFILES)
      .where('public_visibility', '==', HIDDEN_PRELAUNCH_TEST).count().get(),
    // The agent slice of Commons membership. commons_participants counts every
    // profile (humans + agents); the humans-only figure is the difference, so
    // Humans + Agents == Members exactly (no double-count, no overlap with the
    // network-wide total_agents which counts agent_wallets, not profiles).
    deps.db.collection(COMMONS_COLLECTIONS.PROFILES).where('participant_type', '==', 'agent').count().get(),
    deps.db.collection(COMMONS_COLLECTIONS.PROFILES)
      .where('participant_type', '==', 'agent')
      .where('public_visibility', '==', HIDDEN_PRELAUNCH_TEST).count().get(),
    deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).count().get(),
    deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS)
      .where('public_visibility', 'in', [...HIDDEN_VISIBILITY_VALUES]).count().get(),
  ]);

  const commons_participants = Math.max(0, commonsProfilesSnap.data().count - hiddenProfilesSnap.data().count);
  const commons_agents = Math.max(0, commonsAgentProfilesSnap.data().count - hiddenAgentProfilesSnap.data().count);
  const commons_humans = Math.max(0, commons_participants - commons_agents);

  const stats = {
    total_agents: Math.max(
      0,
      agentWalletsSnap.data().count
        - hiddenAgentWalletsSnap.docs.filter((d) => (d.data() as { platform?: unknown }).platform !== 'test').length,
    ),
    commons_participants,
    commons_humans,
    commons_agents,
    forum_posts: Math.max(0, forumPostsSnap.data().count - hiddenForumPostsSnap.data().count),
    // opened `/v1/commons/jobs` (the human-jobs post → accept → fund →
    // complete path the phone drives); this catalog had not been updated to
    // match, so the app reported a WORKING surface as unavailable. Jobs moves
    // to the active list here and in getInstitutions below.
    // lights the Market (the read face of the same hiring board).
    active_surfaces: ['registry', 'forum', 'jobs', 'market'],
    unavailable_institutions: ['escrow', 'court', 'bonds', 'governance'],
    timestamp: new Date().toISOString(),
  };

  await deps.cache.set(cacheKey, JSON.stringify(stats), 30);
  return stats;
}

// ─── Activity Feed ──────────────────────────────────────────────────────────

export async function getActivityFeed(
  deps: CommonsDeps,
  options: { page_size?: number; before?: number },
): Promise<FeedItem[]> {
  const pageSize = Math.min(options.page_size || L.FEED_PAGE_SIZE, 100);
  const before = options.before || Date.now();

  // Get recent published PEs (most common feed item)
  const publishedSnap = await deps.db
    .collection(COMMONS_COLLECTIONS.PUBLISHED_PES)
    .where('published_at', '<', new Date(before).toISOString())
    .orderBy('published_at', 'desc')
    .limit(pageSize)
    .get();

  const feedItems: FeedItem[] = [];

  for (const doc of publishedSnap.docs) {
    const pe = publicProjection(doc.data() as import('./types').PEPublicProjection);
    if (isHiddenPrelaunchTest(pe)) continue;
    // Look up actor display name
    const profileDoc = await deps.db
      .collection(COMMONS_COLLECTIONS.PROFILES)
      .doc(pe.actor_wallet_id)
      .get();
    const profile = profileDoc.exists ? profileDoc.data() : null;

    feedItems.push({
      id: pe.pe_id,
      type: 'pe_published',
      actor_wallet_id: pe.actor_wallet_id,
      actor_provenance_url: makeAgentProvenanceUrl(pe.actor_wallet_id),
      actor_display_name: profile?.display_name || pe.actor_wallet_id.slice(0, 10),
      actor_attestation_tier: pe.attestation_tier || 'software',
      institution: pe.institution === 'registry' || pe.institution === 'forum'
        ? pe.institution
        : 'provenance',
      summary: pe.institution === 'registry' || pe.institution === 'forum' || pe.institution === 'provenance'
        ? `Published ${pe.action_type} PE`
        : `Published historical ${pe.action_type} provenance record`,
      reference_id: pe.pe_id,
      timestamp: new Date(pe.published_at).getTime(),
    });
  }

  // Get recent forum posts
  const forumSnap = await deps.db
    .collection(COMMONS_COLLECTIONS.FORUM_POSTS)
    .where('created_at', '<', before)
    .orderBy('created_at', 'desc')
    .limit(Math.floor(pageSize / 3))
    .get();

  for (const doc of forumSnap.docs) {
    const post = doc.data();
    if (isHiddenPrelaunchTest(post)) continue;
    const profileDoc = await deps.db
      .collection(COMMONS_COLLECTIONS.PROFILES)
      .doc(post.author_wallet_id)
      .get();
    const profile = profileDoc.exists ? profileDoc.data() : null;

    feedItems.push({
      id: post.post_id,
      type: 'forum_post',
      actor_wallet_id: post.author_wallet_id,
      actor_provenance_url: makeAgentProvenanceUrl(post.author_wallet_id),
      actor_display_name: profile?.display_name || post.author_wallet_id.slice(0, 10),
      actor_attestation_tier: profile?.attestation_tier || 'software',
      institution: 'forum',
      summary: post.title || post.content.slice(0, 100),
      reference_id: post.post_id,
      timestamp: post.created_at,
    });
  }

  // Sort by timestamp descending and limit
  feedItems.sort((a, b) => b.timestamp - a.timestamp);
  return feedItems.slice(0, pageSize);
}

// ─── Institution Metadata ───────────────────────────────────────────────────

export interface InstitutionInfo {
  id: string;
  name: string;
  description: string;
  route: string | null;
  status: 'live' | 'record_only' | 'unavailable' | 'coming_soon';
  /**
   * WHO transacts here. The mobile Commons groups by this before it groups by
   * status: a person seeing Court/Bonds/Escrow marked "unavailable" reads the
   * app as broken, when in fact those are agent-API rails a human never calls
   * directly. 'agent' surfaces render as "your agents use these" with no
   * availability badge; 'human'/'both' are the surfaces a person can act on.
   */
  audience: 'human' | 'agent' | 'both';
  key_metric?: { label: string; value: number | string };
}

/**
 * The public Commons catalog's deliberately unopened institutions.
 *
 * makes this the one backend source shared by the app-facing catalog and
 * the Command Center snapshot. Null routes are intentional: unopened cards are
 * informational and must never advertise a dead destination.
 */
export const NOT_OPEN_YET_INSTITUTIONS: readonly InstitutionInfo[] = [
  {
    id: 'governance',
    name: 'Voting',
    description: 'Community voting on how the network is run. Not open yet.',
    route: null,
    status: 'unavailable',
    audience: 'both',
  },
  {
    id: 'compute',
    name: 'Compute market',
    description: 'A marketplace for verified computing power. Not open yet.',
    route: null,
    status: 'coming_soon',
    audience: 'both',
  },
  {
    id: 'insurance',
    name: 'Insurance',
    description: "Agent insurance — pooled coverage that pays Court-triggered payouts above an at-fault agent's performance bond. PVT premiums, contract-held, no admin override; coverage scales with the pool. Not open: premium pricing needs real PE and claim history. Provian provides the rails, not the insurance.",
    route: null,
    status: 'coming_soon',
    audience: 'both',
  },
];

export async function getInstitutions(
  deps: CommonsDeps,
): Promise<InstitutionInfo[]> {
  // bump whenever catalog copy changes. Reusing v3 left production
  // serving the pre- cached payload even after the new image was live.
  // the Market is live for both people and agents.
  const cacheKey = 'commons:institutions:public-cleanup-v7'; // Escrow + Bonds live
  const cached = await deps.cache.get<string>(cacheKey);
  if (cached) return typeof cached === 'string' ? JSON.parse(cached) : cached;

  // Get counts for key metrics
  const [profileCount, hiddenProfileCount, forumCount, hiddenForumCount] = await Promise.all([
    deps.db.collection(COMMONS_COLLECTIONS.PROFILES).where('status', '==', 'active').count().get(),
    deps.db.collection(COMMONS_COLLECTIONS.PROFILES)
      .where('status', '==', 'active').where('public_visibility', '==', HIDDEN_PRELAUNCH_TEST).count().get(),
    deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).count().get(),
    deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS)
      .where('public_visibility', 'in', [...HIDDEN_VISIBILITY_VALUES]).count().get(),
  ]);

  const institutions: InstitutionInfo[] = [
    {
      id: 'registry',
      name: 'Registry',
      description: 'Browse everyone here — people and agents — and see their track record.',
      route: '/commons/registry',
      status: 'live',
      audience: 'both',
      key_metric: { label: 'Members', value: Math.max(0, profileCount.data().count - hiddenProfileCount.data().count) },
    },
    {
      id: 'forum',
      name: 'Forum',
      description: 'Post, reply, and vote. People and agents discuss here together.',
      route: '/commons/forum',
      status: 'live',
      audience: 'both',
      key_metric: { label: 'Posts', value: Math.max(0, forumCount.data().count - hiddenForumCount.data().count) },
    },
    {
      id: 'jobs',
      name: 'Jobs',
      description: 'Hire a person or an agent, or get hired. Pay in PVT or USDC; payment is held in escrow until the work is done.',
      route: '/commons/jobs',
      status: 'live',
      audience: 'both',
    },
    {
      id: 'escrow',
      name: 'Escrow',
      description: 'Holds payment in the deployed contract until delivery. Until the Court opens, Provian’s admin key resolves disputed escrows, releasing only to the recipient or refunding only the depositor. Anyone can trigger the depositor refund after the 30-day timeout. Provian’s admin key can execute pools only to their creator-fixed target or refund contributors.',
      route: '/commons/escrow',
      status: 'live',
      audience: 'both',
    },
    {
      id: 'bonds',
      name: 'Bonds',
      description: 'Deposits agents put up to back their work, and lose if they do it badly.',
      route: '/commons/bonds',
      status: 'live',
      audience: 'agent',
    },
    {
      id: 'court',
      name: 'Disputes',
      description: 'Settles disagreements between agents. Not open yet: it opens once enough members qualify to judge cases. Until then, Provian’s admin key resolves disputed escrows, only to the recipient or depositor.',
      route: '/commons/court',
      status: 'unavailable',
      audience: 'agent',
    },
    {
      id: 'market',
      name: 'Agent market',
      description: 'Where people and agents hire agents — and each other. Bids, a thread per job, and payment held in escrow until the work is delivered.',
      route: '/commons/market',
      status: 'live',
      audience: 'both',
    },
    ...NOT_OPEN_YET_INSTITUTIONS,
  ];

  await deps.cache.set(cacheKey, JSON.stringify(institutions), 30);
  return institutions;
}

// ─── Commons institution stats (aggregated from existing data) ─────────────────────────────

export async function getInstitutionsStats(
  deps: CommonsDeps,
): Promise<Record<string, unknown>> {
  const cacheKey = 'commons:institutions_stats:regulatory';
  const cached = await deps.cache.get<string>(cacheKey);
  if (cached) return typeof cached === 'string' ? JSON.parse(cached) : cached;

  const [escrowSnap, outstandingCount, settledCount, poolCount, testAgentSnap, hiddenAgentSnap] = await Promise.all([
    deps.db.collection('escrows').get(),
    deps.db.collection('promises').where('status', '==', 'funded').count().get(),
    deps.db.collection('promises').where('status', '==', 'settled').count().get(),
    deps.db.collection('pools').where('status', '==', 'active').count().get(),
    deps.db.collection('agent_wallets').where('platform', '==', 'test').get(),
    deps.db.collection('agent_wallets').where('public_visibility', '==', HIDDEN_PRELAUNCH_TEST).get(),
  ]);
  // an escrow with a test or display-hidden fixture agent on either side is not public
  // activity (display filter only — the escrow records are untouched).
  const excludedParties = new Set<string>([...testAgentSnap.docs, ...hiddenAgentSnap.docs].map(d => d.id));

  let totalEscrowValue = 0;
  let activeEscrows = 0;
  let completedEscrows = 0;
  escrowSnap.docs.forEach(d => {
    const e = d.data();
    if (excludedParties.has(e.depositor_wallet_id) || excludedParties.has(e.recipient_wallet_id)) return;
    totalEscrowValue += e.amount_usdc || 0;
    if (e.status === 'funded' || e.status === 'created') activeEscrows++;
    if (e.status === 'completed') completedEscrows++;
  });

  const promisesOutstanding = outstandingCount.data().count;
  const promisesSettled = settledCount.data().count;
  const activePools = poolCount.data().count;

  // A6 : the CommonsInstitutions PVT tiles read pvt_circulating_supply /
  // pvt_total_minted / pvt_total_burned, which this endpoint never returned.
  // Supply is a LIVE kernel read (successor PVT9 on Base). Burned sums the
  // protocol-verified burn records (`pvt_burn_records`, status 'recorded' —
  // every burn the work package products consume flows through that substrate; a burn
  // broadcast outside it is not counted, so burned/minted are protocol-verified
  // floors). Minted = supply + burned: the kernel's only supply-creation lanes
  // are settlement mints and its only reduction is burn. Any read failure
  // yields null — the tile renders an honest absence, never a fabrication.
  let pvtCirculating: number | null = null;
  let pvtBurned: number | null = null;
  let pvtMinted: number | null = null;
  try {
    const kernelAddress = getPvtAddressForChain('base');
    const supplyAtomic = kernelAddress
      ? await readErc20TotalSupply(8453, kernelAddress)
      : null;
    if (supplyAtomic !== null) {
      let burnedAtomic = 0n;
      const burnSnap = await deps.db
        .collection(PVT_BURN_RECORDS_COLLECTION)
        .where('status', '==', 'recorded')
        .get();
      for (const doc of burnSnap.docs) {
        const raw = (doc.data() as { amount_atomic?: unknown }).amount_atomic;
        if (typeof raw === 'string' && /^\d+$/.test(raw)) burnedAtomic += BigInt(raw);
      }
      pvtCirculating = Number(supplyAtomic) / 1e18;
      pvtBurned = Number(burnedAtomic) / 1e18;
      pvtMinted = Number(supplyAtomic + burnedAtomic) / 1e18;
    }
  } catch {
    // Chain/Firestore hiccup: leave the PVT fields null (tile shows '--').
  }

  const stats = {
    total_escrow_value_usd: totalEscrowValue,
    active_escrows: activeEscrows,
    completed_escrows: completedEscrows,
    promises_outstanding: promisesOutstanding,
    promises_settled: promisesSettled,
    active_pools: activePools,
    pvt_circulating_supply: pvtCirculating,
    pvt_total_minted: pvtMinted,
    pvt_total_burned: pvtBurned,
    timestamp: new Date().toISOString(),
  };

  await deps.cache.set(cacheKey, JSON.stringify(stats), 30);
  return stats;
}

// ─── Court Stats ────────────────────────────────────────────────────────────

export async function getCourtStats(
  deps: CommonsDeps,
): Promise<Record<string, unknown>> {
  const cacheKey = 'commons:court_stats';
  const cached = await deps.cache.get<string>(cacheKey);
  if (cached) return typeof cached === 'string' ? JSON.parse(cached) : cached;

  const [totalCount, resolvedCount, escalatedCount] = await Promise.all([
    deps.db.collection('court_disputes').count().get(),
    deps.db.collection('court_disputes').where('status', '==', 'resolved').count().get(),
    deps.db.collection('court_disputes').where('status', '==', 'escalated').count().get(),
  ]);
  const totalCases = totalCount.data().count;
  const resolved = resolvedCount.data().count;
  const escalated = escalatedCount.data().count;

  const arbitratorSnap = await deps.db.collection('arbitrators')
    .where('status', '==', 'active')
    .count()
    .get();

  const stats = {
    total_cases: totalCases,
    cases_resolved: resolved,
    cases_escalated: escalated,
    resolution_rate: totalCases > 0 ? resolved / totalCases : 0,
    active_arbitrators: arbitratorSnap.data().count,
    timestamp: new Date().toISOString(),
  };

  await deps.cache.set(cacheKey, JSON.stringify(stats), 30);
  return stats;
}

// ─── Governance Stats ───────────────────────────────────────────────────────

export async function getGovernanceStats(
  deps: CommonsDeps,
): Promise<Record<string, unknown>> {
  const cacheKey = 'commons:governance_stats';
  const cached = await deps.cache.get<string>(cacheKey);
  if (cached) return typeof cached === 'string' ? JSON.parse(cached) : cached;

  const proposalSnap = await deps.db.collection('governance_proposals').get();
  let totalProposals = 0;
  let active = 0;
  let executed = 0;
  let cancelled = 0;
  let expired = 0;
  let passed = 0;
  let failed = 0;

  // Count by EFFECTIVE status - proposals stored as 'active' may have aged
  // past voting_end / execution window and are no longer actively accepting
  // votes. See provian-backend/src/core/governance/effective-status.ts and
  // SPRINT_FINDINGS.md 2026-04-23 for the read-layer finding.
  const quorum = deps.governanceContract && deps.pvtContract
    ? await getQuorumContext(deps.governanceContract, deps.pvtContract)
    : undefined;
  const nowMs = Date.now();

  proposalSnap.docs.forEach(d => {
    totalProposals++;
    const status = computeEffectiveStatus(
      d.data() as GovernanceProposalDocument,
      nowMs,
      quorum,
    );
    switch (status) {
      case 'active': active++; break;
      case 'executed':
      case 'executed_pending_review':
        executed++; break;
      case 'cancelled':
      case 'withdrawn':
        cancelled++; break;
      case 'expired': expired++; break;
      case 'passed':
      case 'executable':
        passed++; break;
      case 'failed':
      case 'vetoed':
        failed++; break;
      // Exhaustive - GovernanceProposalStatus has no other values.
    }
  });

  const stats = {
    total_proposals: totalProposals,
    active_proposals: active,            // Only proposals within the voting window
    passed_proposals: passed,            // Passed (awaiting execution) + currently executable
    executed_proposals: executed,
    cancelled_proposals: cancelled,      // Admin-cancelled + proposer-withdrawn
    expired_proposals: expired,          // Passed but missed execution window
    failed_proposals: failed,            // Failed quorum or vote + foundation vetoes
    timestamp: new Date().toISOString(),
  };

  await deps.cache.set(cacheKey, JSON.stringify(stats), 30);
  return stats;
}

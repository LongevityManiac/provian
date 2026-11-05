/**
 * Agent Badges - 10 badge definitions + evaluation logic
 *
 * Badges are earned based on agent activity and stored on the agent wallet document.
 * Each new badge generates a `badge_earned` PE.
 */

import type { BadgeId, BadgeDefinition, EarnedBadge, AgentWalletDocument } from './types';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../pvt/policy/proposed-genesis-policy';

// ---------------------------------------------------------------------------
// Badge definitions (constants)
// ---------------------------------------------------------------------------

/**
 * Cutoff for the record-only `genesis_agent` badge = the approved Genesis
 * admission close (`window.end_ms`, 2027-01-01T00:00:00Z since; open through 2026-12-31). DERIVED
 * LIVE from the single approved-window source so it can never drift from a
 * stale second copy — this constant previously hard-coded `2026-06-30T23:59:59Z`,
 * which predated the approved Genesis launch (2026-07-27T00:00:00Z), so under the
 * reset window NO genuine Genesis-era wallet could ever earn it.
 * If the window is not yet approved (`end_ms === null`) the badge is unearnable
 * (fail-closed: no finite `created_at <= -Infinity`). This is a record-only badge
 * that mints 0 PVT; correcting it carries no economic effect.
 */
const GENESIS_CUTOFF = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms ?? Number.NEGATIVE_INFINITY;

export const BADGE_DEFINITIONS: Record<BadgeId, BadgeDefinition> = {
  genesis_agent: {
    id: 'genesis_agent',
    name: 'Genesis Agent',
    description: 'Created wallet before the cutoff date',
    icon: 'seed',
  },
  chain_builder: {
    id: 'chain_builder',
    name: 'Chain Builder',
    description: '100+ provenance envelopes generated',
    icon: 'chain',
  },
  architect: {
    id: 'architect',
    name: 'Architect',
    description: '1,000+ provenance envelopes generated',
    icon: 'blueprint',
  },
  constellation: {
    id: 'constellation',
    name: 'Constellation',
    description: '10,000+ provenance envelopes generated',
    icon: 'stars',
  },
  governed: {
    id: 'governed',
    name: 'Governed',
    description: 'Retired: never awarded. The agent governance layer it named was removed.',
    icon: 'shield',
  },
  linked: {
    id: 'linked',
    name: 'Linked',
    description: 'Connected to a human wallet',
    icon: 'link',
  },
  x402_pioneer: {
    id: 'x402_pioneer',
    name: 'x402 Pioneer',
    description: 'Made first x402 payment',
    icon: 'lightning',
  },
  signal: {
    id: 'signal',
    name: 'Signal',
    description: 'PE chain verified by 3+ merchants',
    icon: 'broadcast',
  },
  seven_day_streak: {
    id: 'seven_day_streak',
    name: '7-Day Streak',
    description: '7 consecutive days of PE generation',
    icon: 'fire',
  },
  thirty_day_streak: {
    id: 'thirty_day_streak',
    name: '30-Day Streak',
    description: '30 consecutive days of PE generation',
    icon: 'inferno',
  },
  pvt_minter: {
    id: 'pvt_minter',
    name: 'PVT Minter',
    description: 'Received PVT from PE-based minting',
    icon: 'coin',
  },
  governance_participant: {
    id: 'governance_participant',
    name: 'Governance Participant',
    description: 'Cast a vote on a governance proposal',
    icon: 'vote',
  },
  insured_agent: {
    id: 'insured_agent',
    name: 'Performance Bond Posted',
    description: 'Posted a PVT performance bond. Collateral, not insurance.',
    icon: 'shield-checkmark',
  },
};

// ---------------------------------------------------------------------------
// Badge evaluation
// ---------------------------------------------------------------------------

interface BadgeContext {
  wallet: AgentWalletDocument;
  verifiedMerchantCount?: number;  // For 'signal' badge
  eventType?: string;              // For event-triggered badges (pvt_minter, governance_participant)
  /**
   * the LIVE visible-PE count (pe_history / actor_stats), passed in by the
   * caller for the PE-count reputation badges. The stored per-wallet `pe_count`
   * tally is deleted; a caller that does not supply this contributes 0 (the
   * count-based badges simply do not award on that path).
   */
  livePeCount?: number;
}

type BadgeCheck = (ctx: BadgeContext) => boolean;

const BADGE_CHECKS: Record<BadgeId, BadgeCheck> = {
  genesis_agent: (ctx) => ctx.wallet.created_at <= GENESIS_CUTOFF,
  chain_builder: (ctx) => (ctx.livePeCount ?? 0) >= 100,
  architect: (ctx) => (ctx.livePeCount ?? 0) >= 1000,
  constellation: (ctx) => (ctx.livePeCount ?? 0) >= 10000,
  // /the agent governance layer is gone; there is no full-governance
  // signal to derive, so 'governed' is never newly awarded (the derived value
  // was already always false).
  governed: () => false,
  linked: (ctx) => ctx.wallet.linked_human_wallet_id !== null,
  x402_pioneer: (ctx) => ctx.wallet.x402_payment_count >= 1,
  signal: (ctx) => (ctx.verifiedMerchantCount ?? 0) >= 3,
  seven_day_streak: (ctx) => ctx.wallet.streak_days >= 7,
  thirty_day_streak: (ctx) => ctx.wallet.streak_days >= 30,
  pvt_minter: (ctx) => ctx.eventType === 'pvt_batch_minted',
  governance_participant: (ctx) => ctx.eventType === 'governance_vote_cast',
  insured_agent: (ctx) => ctx.eventType === 'bond_posted',
};

/**
 * Evaluate which badges the wallet has newly earned.
 * Returns only the NEW badges (not already in wallet.badges).
 */
export function evaluateBadges(ctx: BadgeContext): BadgeId[] {
  const existingIds = new Set(ctx.wallet.badges.map(b => b.id));
  const newBadges: BadgeId[] = [];

  for (const [badgeId, check] of Object.entries(BADGE_CHECKS) as [BadgeId, BadgeCheck][]) {
    if (!existingIds.has(badgeId) && check(ctx)) {
      newBadges.push(badgeId);
    }
  }

  return newBadges;
}

/**
 * Create EarnedBadge objects for newly earned badges.
 */
export function createEarnedBadges(badgeIds: BadgeId[], now: number): EarnedBadge[] {
  return badgeIds.map(id => ({ id, earned_at: now }));
}

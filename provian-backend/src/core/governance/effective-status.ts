/**
 * Governance - effective-status computer (READ PATH ONLY).
 *
 * Firestore stores proposal status as `'active'` at creation and only mutates
 * it on execute / withdraw / admin-cancel / foundation-review. Proposals that
 * pass voting without execution, fail quorum, or miss their execution window
 * stay as `'active'` in Firestore forever. This module computes the
 * effective status from timestamps + vote totals + quorum context at read
 * time so API responses reflect reality.
 *
 * WRITE PATHS CONTINUE TO USE STORED STATUS. This module is strictly for
 * shaping responses. Firestore schema is untouched. Smart contract is
 * untouched. See SPRINT_FINDINGS.md 2026-04-23 for the finding context.
 */

import type { GovernanceProposalDocument } from '../agent-bank/types';

/**
 * Effective status values returned to API consumers. Superset of stored
 * GovernanceProposalStatus with two read-only values: 'executable' and
 * 'withdrawn'. 'expired' exists in the stored type enum but is never
 * actually written by any code path - it's only emitted as a computed
 * value here.
 */
export type EffectiveProposalStatus =
  | 'active'
  | 'passed'
  | 'failed'
  | 'executable'
  | 'expired'
  | 'executed'
  | 'executed_pending_review'
  | 'cancelled'
  | 'withdrawn'
  | 'vetoed';

/**
 * Quorum inputs for the post-voting pass/fail decision. Fetched from the
 * Governance + PVT contracts once per minute and cached by
 * ./quorum-context.ts. Matches the contract's executeProposal logic:
 *   threshold = totalSupply * quorumBps / 10_000
 *   quorumMet = (votesFor + votesAgainst) >= threshold
 * When `quorumBps === 0`, the contract treats every proposal as
 * quorum-met (no threshold configured), and so does this module.
 */
export interface QuorumContext {
  totalSupply: bigint;
  quorumBps: number;
}

/**
 * Maps a stored proposal document to its effective status as of `nowMs`.
 * Pure function - no I/O. Caller provides QuorumContext if available; when
 * omitted, the "quorum not met" branch cannot fire, so a quorum-failed
 * proposal with votes_for > votes_against would show as
 * `'passed'`/`'executable'`/`'expired'` instead of `'failed'`. Callers that
 * need accuracy should provide it; callers that want a cheap approximation
 * may omit it.
 */
export function computeEffectiveStatus(
  proposal: GovernanceProposalDocument,
  nowMs: number,
  quorum?: QuorumContext,
): EffectiveProposalStatus {
  // Terminal stored statuses - trust them.
  if (proposal.status === 'executed') return 'executed';
  if (proposal.status === 'executed_pending_review') return 'executed_pending_review';
  if (proposal.status === 'vetoed') return 'vetoed';
  if (proposal.status === 'cancelled') {
    // Distinguish proposer-withdrawal from admin-cancel at read time. Both
    // are stored as 'cancelled' with `cancelled_by` set.
    const cancelledBy = (proposal as { cancelled_by?: string }).cancelled_by;
    return cancelledBy === 'proposer' ? 'withdrawn' : 'cancelled';
  }

  // Dormant stored statuses - never actually written by the current writer,
  // but handle defensively if ever populated.
  if (proposal.status === 'passed') return 'passed';
  if (proposal.status === 'failed') return 'failed';
  if (proposal.status === 'expired') return 'expired';

  // Stored status is 'active'. Compute from timestamps + votes.
  if (nowMs <= proposal.voting_end) return 'active';

  // Voting closed. Determine pass/fail. Parse defensively: a malformed weight
  // string degrades to 0n (⇒ 'failed') rather than throwing and 500-ing the
  // whole listing — matching isQuorumReached / weiToPvtNumber, which already
  // swallow malformed input. (Production writers only ever store valid integer
  // strings; this is defense-in-depth against a corrupt doc.)
  let votesFor: bigint;
  let votesAgainst: bigint;
  try {
    votesFor = BigInt(proposal.votes_for);
    votesAgainst = BigInt(proposal.votes_against);
  } catch {
    votesFor = 0n;
    votesAgainst = 0n;
  }
  let quorumMet = true;
  if (quorum && quorum.quorumBps > 0) {
    const threshold = (quorum.totalSupply * BigInt(quorum.quorumBps)) / 10_000n;
    quorumMet = (votesFor + votesAgainst) >= threshold;
  }
  const passed = quorumMet && votesFor > votesAgainst;
  if (!passed) return 'failed';

  // Passed. Determine execution window position. The contract uses strict
  // `<` for executionStart and strict `>` for executionEnd, so we mirror:
  //   nowMs < executionStart → 'passed' (not yet executable)
  //   executionStart <= nowMs <= executionEnd → 'executable'
  //   nowMs > executionEnd → 'expired'
  if (nowMs < proposal.execution_start) return 'passed';
  if (nowMs <= proposal.execution_end) return 'executable';
  return 'expired';
}

/**
 * Shape a document for API response: replace stored `status` with the
 * computed effective status. Everything else is preserved.
 */
export function withEffectiveStatus(
  proposal: GovernanceProposalDocument,
  nowMs: number,
  quorum?: QuorumContext,
): GovernanceProposalDocument & { status: EffectiveProposalStatus } {
  return {
    ...proposal,
    status: computeEffectiveStatus(proposal, nowMs, quorum),
  };
}

/**
 * Quorum-met test, mirroring computeEffectiveStatus / the contract:
 *   threshold = totalSupply * quorumBps / 10_000
 *   met = (votesFor + votesAgainst) >= threshold
 * With no quorum context (or quorumBps === 0) the contract treats every
 * proposal as quorum-met, and so do we. A malformed weight string ⇒ not met.
 */
export function isQuorumReached(
  proposal: GovernanceProposalDocument,
  quorum?: QuorumContext,
): boolean {
  if (!quorum || quorum.quorumBps <= 0) return true;
  let votesFor: bigint;
  let votesAgainst: bigint;
  try {
    votesFor = BigInt(proposal.votes_for);
    votesAgainst = BigInt(proposal.votes_against);
  } catch {
    return false;
  }
  const threshold = (quorum.totalSupply * BigInt(quorum.quorumBps)) / 10_000n;
  return votesFor + votesAgainst >= threshold;
}

const WEI_PER_PVT = 1_000_000_000_000_000_000n; // 18 decimals

/**
 * Scale an atomic-unit (18-dec) BigInt-as-string vote weight down to a
 * whole-ish PVT number. Lossy for very large weights, but this only ever feeds
 * the relative For/Against ratio bar, so magnitude is what matters. The raw
 * string is preserved separately as total_weight_*. Malformed ⇒ 0.
 */
function weiToPvtNumber(weight: string): number {
  try {
    // Keep 3 fractional digits of resolution without overflowing JS precision.
    return Number((BigInt(weight) * 1000n) / WEI_PER_PVT) / 1000;
  } catch {
    return 0;
  }
}

/**
 * Stable client-facing view of a governance proposal — the SINGLE source of
 * truth for the shape the Commons governance cards consume.
 *
 * The stored GovernanceProposalDocument speaks the contract's vocabulary
 * (`voting_end`, `votes_for` as a BigInt weight string, `execution_start/end`),
 * which the mobile cards never matched: they read `title`, `voting_ends_at`,
 * `quorum_reached`, and NUMERIC votes. Reading the raw doc left every one of
 * those fields undefined (blank title, NaN countdown, no quorum badge, string
 * concatenation in the vote bar). This view emits exactly what the card reads.
 */
export interface GovernanceProposalView {
  proposal_id: string;
  title: string;
  description: string;
  action: string;
  proposer_wallet_id: string;
  status: EffectiveProposalStatus;
  /** Vote weights scaled to whole-PVT numbers — for the For/Against ratio bar. */
  votes_for: number;
  votes_against: number;
  /** Raw atomic-unit BigInt-as-string weights — the source of truth. */
  total_weight_for: string;
  total_weight_against: string;
  quorum_reached: boolean;
  voting_ends_at: number;
  execution_window_start: number;
  execution_window_end: number;
  created_at: number;
}

export function toGovernanceProposalView(
  proposal: GovernanceProposalDocument,
  nowMs: number,
  quorum?: QuorumContext,
): GovernanceProposalView {
  return {
    proposal_id: String(proposal.proposal_id),
    title: proposal.action || 'Governance Proposal',
    description: proposal.description ?? '',
    action: proposal.action ?? '',
    proposer_wallet_id: proposal.proposer_wallet_id,
    status: computeEffectiveStatus(proposal, nowMs, quorum),
    votes_for: weiToPvtNumber(proposal.votes_for),
    votes_against: weiToPvtNumber(proposal.votes_against),
    total_weight_for: proposal.votes_for,
    total_weight_against: proposal.votes_against,
    quorum_reached: isQuorumReached(proposal, quorum),
    voting_ends_at: proposal.voting_end,
    execution_window_start: proposal.execution_start,
    execution_window_end: proposal.execution_end,
    created_at: proposal.created_at,
  };
}

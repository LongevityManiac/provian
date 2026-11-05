/**
 * vouchModel — pure rules for the person-side vouch on a Commons profile.
 *
 * A vouch is a costly signal: it rides a live REPUTATION presentation (a 15 PVT burn) from the person
 * to the profile, and one burn covers vouching for that profile for seven days. A person cannot vouch
 * for themselves or for their own beneficiary-linked agents (the relay refuses that pair with 403
 * `linked_pair_vouch_refused`; the phone hides the action first).
 */
import { CommonsError, type MyVouch } from './CommonsService';

/** The reputation presentation floor a vouch rides (PVT). */
export const VOUCH_BURN_PVT = 15;

/** The linked-agent identity fields the check needs (RelayAPIService.getLinkedAgents rows). */
export interface LinkedAgentIds {
  wallet_id: string;
  agent_id: string;
}

/** Show the Vouch action? Hidden on your own profile and on any of your linked agents. */
export function canShowVouch(params: {
  viewerId: string | null | undefined;
  targetId: string | null | undefined;
  targetAgentId?: string | null;
  linkedAgents: readonly LinkedAgentIds[];
}): boolean {
  const { viewerId, targetId, targetAgentId, linkedAgents } = params;
  if (!viewerId || !targetId) return false;
  if (viewerId === targetId) return false;
  const ids = new Set([targetId, ...(targetAgentId ? [targetAgentId] : [])]);
  return !linkedAgents.some((a) => ids.has(a.wallet_id) || ids.has(a.agent_id));
}

/** Has this person already vouched for the profile? */
export function hasVouchedFor(
  myVouches: readonly Pick<MyVouch, 'target_id'>[],
  targetId: string,
  targetAgentId?: string | null,
): boolean {
  return myVouches.some((v) => v.target_id === targetId || (!!targetAgentId && v.target_id === targetAgentId));
}

export type VouchFailure = 'needs_presentation' | 'linked_pair' | 'self' | 'not_found' | 'other';

/** Classify a vouch refusal so the screen can route (428) or explain (403 linked pair). */
export function classifyVouchError(err: unknown): VouchFailure {
  if (err instanceof CommonsError) {
    if (err.status === 428 && err.reason === 'rail_handshake_required') return 'needs_presentation';
    if (err.status === 403 && err.reason === 'linked_pair_vouch_refused') return 'linked_pair';
    if (err.status === 400 && /yourself/i.test(err.message)) return 'self';
    if (err.status === 404) return 'not_found';
  }
  return 'other';
}

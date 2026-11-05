/**
 * REPLY POLICY (, item 4) — how a linked agent answers its Commons mail.
 *
 * answer_anyone (default, the behavior every agent has had) — reply to every message.
 * ask_me_first — reply directly only to the linked human; for anyone else, ask that human first
 * through the existing request-approval route and reply only once approved.
 *
 * It is OWNER state: only the linked human sets it, under wallet auth
 * (`routes/agent-reply-policy.ts`); an agent credential can never write it. The relay hands it to the
 * agent on every thread read, and the agent FOLLOWS it — it is never a relay gate on thread-send
 * (Security Invariant #3: no approval on a PE-recording route).
 *
 * A choice binds only while the human who made it is still the agent's linked human: after an
 * unlink or a new link it reads as the default, so one owner's choice never carries to the next.
 * A stored value this module cannot read is the restrictive one (unknown = block).
 */

import type { Firestore } from 'firebase-admin/firestore';

export const REPLY_POLICY_MODES = ['answer_anyone', 'ask_me_first'] as const;
export type ReplyPolicyMode = typeof REPLY_POLICY_MODES[number];
export const DEFAULT_REPLY_POLICY_MODE: ReplyPolicyMode = 'answer_anyone';

/** What `agent_wallets/{id}.reply_policy` holds. */
export interface StoredReplyPolicy {
  readonly mode: ReplyPolicyMode;
  readonly set_by_user_id: string;
  readonly updated_at_ms: number;
}

/** What the agent is told: the mode, and the one party it may answer directly under ask_me_first. */
export interface AgentReplyPolicy {
  readonly mode: ReplyPolicyMode;
  /** The linked human's party id (the id their thread messages carry), or null when unlinked. */
  readonly linked_human: string | null;
}

export function isReplyPolicyMode(x: unknown): x is ReplyPolicyMode {
  return typeof x === 'string' && (REPLY_POLICY_MODES as readonly string[]).includes(x);
}

export function effectiveReplyPolicy(wallet: { reply_policy?: unknown; linked_human_user_id?: unknown }): AgentReplyPolicy {
  const linked = typeof wallet.linked_human_user_id === 'string' && wallet.linked_human_user_id.length > 0
    ? wallet.linked_human_user_id : null;
  // No linked human: no one to ask, and no owner whose choice could bind.
  if (linked === null) return { mode: DEFAULT_REPLY_POLICY_MODE, linked_human: null };
  const raw = wallet.reply_policy;
  if (raw === undefined || raw === null) return { mode: DEFAULT_REPLY_POLICY_MODE, linked_human: linked };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (typeof r.set_by_user_id === 'string' && r.set_by_user_id.length > 0 && r.set_by_user_id !== linked) {
      // A previous owner's choice: the current one has not chosen.
      return { mode: DEFAULT_REPLY_POLICY_MODE, linked_human: linked };
    }
    if (r.set_by_user_id === linked && isReplyPolicyMode(r.mode)) return { mode: r.mode, linked_human: linked };
  }
  return { mode: 'ask_me_first', linked_human: linked };
}

/** The policy for an agent party, or null when the id is not an agent wallet. A read failure throws. */
export async function readAgentReplyPolicy(db: Firestore, agentWalletId: string): Promise<AgentReplyPolicy | null> {
  const snap = await db.collection('agent_wallets').doc(agentWalletId).get();
  if (!snap.exists) return null;
  return effectiveReplyPolicy(snap.data() ?? {});
}

export function storedReplyPolicy(mode: ReplyPolicyMode, userId: string, nowMs: number): StoredReplyPolicy {
  return { mode, set_by_user_id: userId, updated_at_ms: nowMs };
}

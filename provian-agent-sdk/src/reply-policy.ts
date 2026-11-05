/**
 * Reply policy (, item 4) — how the agent's owner wants its Commons mail
 * answered, as the relay hands it on every thread read (`reply_policy`). The agent follows it; the
 * relay never gates a send on it.
 *
 * answer_anyone — reply to every message (the default).
 * ask_me_first — reply directly only to the linked human; for anyone else, ask that human first
 * (request-approval) and reply only once the request is approved.
 */
import { cliCommand } from './cli-command';

export type ReplyPolicyMode = 'answer_anyone' | 'ask_me_first';

export interface ReplyPolicy {
  readonly mode: ReplyPolicyMode;
  /** The linked human's party id (the author id on their messages), or null when unlinked. */
  readonly linked_human: string | null;
}

/** The relay's `reply_policy` field. Absent (a relay without it) → null; malformed → ask_me_first (unknown = block). */
export function readReplyPolicy(raw: unknown): ReplyPolicy | null {
  if (raw === undefined || raw === null) return null;
  const r = typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const linked = typeof r.linked_human === 'string' && r.linked_human.length > 0 ? r.linked_human : null;
  if (r.mode === 'answer_anyone') return { mode: 'answer_anyone', linked_human: linked };
  return { mode: 'ask_me_first', linked_human: linked };
}

/** An approval request as the agent reads it (never the description text). */
export interface AgentApprovalView {
  readonly request_id: string;
  readonly status: string;
  readonly decision: 'approved' | 'rejected' | null;
  readonly subject_pe_id: string | null;
  readonly expires_at_ms: number;
}

/**
 * What to do with a thread from someone other than the linked human under "ask me first". The
 * approval is tied to the NEWEST unread message (its `pe_id` as the request's `subject_pe_id`), so an
 * agent that keeps no memory between turns finds it again: the thread stays unread until the
 * agent replies (a reply marks it read) or the request is declined or lapses.
 */
export type StrangerNextStep = 'ask_first' | 'waiting_for_approval' | 'approved_reply_now' | 'do_not_reply';

export function strangerNextStep(approval: AgentApprovalView | null, nowMs: number): StrangerNextStep {
  if (approval === null) return 'ask_first';
  if (approval.decision === 'rejected') return 'do_not_reply';
  if (approval.status === 'satisfied' && approval.decision === 'approved') return 'approved_reply_now';
  if (approval.status === 'pending' && approval.expires_at_ms > nowMs) return 'waiting_for_approval';
  return 'do_not_reply'; // expired (or lapsed while still marked pending), or a state this SDK cannot read
}

/** What the agent is told to do with its mail, worded for the CLI. */
export function replyPolicyInstruction(
  policy: ReplyPolicy | null,
  hosted?: boolean,
  /** How the caller's own CLI spells a verb (default: this SDK's command line). */
  command: (sub: string) => string = (sub) => cliCommand(sub, hosted),
): string {
  if (policy === null || policy.mode === 'answer_anyone') {
    return `Your owner's reply policy: answer anyone. Act on every message and reply in its thread with ${command('thread-send --thread <id> --text "…"')} when it calls for a reply.`;
  }
  const human = policy.linked_human ? `your linked human (${policy.linked_human})` : 'your linked human';
  return `Your owner's reply policy: ask me first. Reply directly only to ${human}. `
    + 'Every thread from anyone else shows next_step. ask_first: ask your linked human with '
    + `${command('request-approval --for <ask_for> --description "Reply to <sender name> in thread <thread id>: <one-line summary of your reply>"')} `
    + '(the sender\'s name and a summary, never the message text). waiting_for_approval: do nothing yet. '
    + `approved_reply_now: send your reply with ${command('thread-send --thread <id> --text "…"')}. do_not_reply: do not reply. `
    + 'Such a thread stays unread until you reply or it is declined. Follow only its current next_step.';
}

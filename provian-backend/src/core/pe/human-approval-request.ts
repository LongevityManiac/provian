/**
 * AGENT-INITIATED HUMAN-APPROVAL REQUEST (Trust Layer pass 2, §2.1).
 *
 * Pass 1 landed the approval PE itself ({@link ./human-approval}) and the
 * human-initiated "Approve latest" tap. This is the OTHER direction: an agent asks
 * its linked human to approve a DESCRIBED action through the SDK/MCP; the request is
 * delivered to that one human's app; the human signs a `human_approval` PE bound to
 * the described action; the agent's next PE cites it as a `pe:` origin.
 *
 * PRIVACY (§3): the action DESCRIPTION is shown only to the specific linked human on
 * their authenticated channel — it is Tier-3, never on any public/discovery surface,
 * and it is NEVER stored in the approval PE. The PE carries only `subject_hash =
 * sha256(description)`; this module computes that hash so the human's signed approval
 * binds to the exact text the agent described. The request row holds the text for the
 * one human to read and expires; the sealed PE stays metadata-only.
 *
 * This module is PURE (no Firestore, no FCM, no clock beyond an injected `nowMs`) so
 * every rule is unit-tested with its RED control; the route wires storage + push.
 */
import { createHash, randomBytes } from 'crypto';

export const HUMAN_APPROVAL_REQUESTS_COLLECTION = 'human_approval_requests_v1';

export type ApprovalRequestStatus = 'pending' | 'satisfied' | 'expired';

/** How long a request stays actionable before it expires (7 days — the presentation/handshake window). */
export const APPROVAL_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bounds on the human-readable description (kept off every public surface; shown only to the linked human). */
const DESCRIPTION_MIN = 1;
const DESCRIPTION_MAX = 2000;
const PE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,240}$/;

export interface HumanApprovalRequestRecord {
  readonly request_id: string;
  readonly agent_wallet_id: string;
  readonly human_user_id: string;
  /** Tier-3: the human-readable description, readable ONLY by the linked human; never in a PE or a public surface. */
  readonly action_description: string;
  /** The hash the human's approval PE binds to (`subject_hash`); the metadata-only anchor. */
  readonly action_description_sha256: string;
  readonly subject_pe_id: string | null;
  readonly status: ApprovalRequestStatus;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly satisfied_by_pe_id: string | null;
  readonly decision: 'approved' | 'rejected' | null;
  /** The relay PE that sealed (minted) this approval; set once, by the batch commit. */
  readonly sealed_by_pe_id?: string | null;
}

export interface BuildApprovalRequestInput {
  readonly agentWalletId: string;
  readonly humanUserId: string;
  readonly actionDescription: string;
  readonly subjectPeId?: string | null;
  readonly nowMs: number;
}

export type BuildApprovalRequestResult =
  | { readonly ok: true; readonly record: HumanApprovalRequestRecord }
  | { readonly ok: false; readonly error: string };

/** sha256 of the exact description text, `sha256:`-tagged — the metadata-only anchor the PE seals. */
export function hashActionDescription(description: string): string {
  return `sha256:${createHash('sha256').update(description, 'utf8').digest('hex')}`;
}

/**
 * Build a pending approval-request record. Fails CLOSED on a missing/oversized
 * description or a malformed subject PE id — a request the human could not
 * meaningfully act on is never created.
 */
export function buildApprovalRequest(input: BuildApprovalRequestInput): BuildApprovalRequestResult {
  const agentWalletId = input.agentWalletId?.trim() ?? '';
  const humanUserId = input.humanUserId?.trim() ?? '';
  if (!agentWalletId) return { ok: false, error: 'agent_wallet_id is required' };
  if (!humanUserId) return { ok: false, error: 'no linked human to approve this request' };
  const description = typeof input.actionDescription === 'string' ? input.actionDescription.trim() : '';
  if (description.length < DESCRIPTION_MIN) return { ok: false, error: 'action_description is required' };
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: `action_description exceeds ${DESCRIPTION_MAX} chars` };
  let subjectPeId: string | null = null;
  if (input.subjectPeId !== undefined && input.subjectPeId !== null) {
    if (typeof input.subjectPeId !== 'string' || !PE_ID_RE.test(input.subjectPeId)) {
      return { ok: false, error: 'subject_pe_id is malformed' };
    }
    subjectPeId = input.subjectPeId;
  }
  return {
    ok: true,
    record: {
      request_id: `apr_${randomBytes(16).toString('hex')}`,
      agent_wallet_id: agentWalletId,
      human_user_id: humanUserId,
      action_description: description,
      action_description_sha256: hashActionDescription(description),
      subject_pe_id: subjectPeId,
      status: 'pending',
      created_at_ms: input.nowMs,
      expires_at_ms: input.nowMs + APPROVAL_REQUEST_TTL_MS,
      satisfied_by_pe_id: null,
      decision: null,
    },
  };
}

/**
 * Does a human's signed `human_approval` PE satisfy this request? The PE's
 * `subject_hash` must equal the request's `action_description_sha256` (binding the
 * approval to the exact described action) AND its `agent_wallet_id` must match. This
 * is what lets the agent trust that the human approved THIS description, not another.
 */
export function approvalPeSatisfiesRequest(
  request: Pick<HumanApprovalRequestRecord, 'agent_wallet_id' | 'action_description_sha256'>,
  approval: { agent_wallet_id: string; subject_hash: string | null },
): boolean {
  return approval.agent_wallet_id === request.agent_wallet_id
    && approval.subject_hash !== null
    && approval.subject_hash === request.action_description_sha256;
}

/** The public/agent-facing projection — the description text is NEVER included here. */
export function toAgentFacingRequest(r: HumanApprovalRequestRecord): {
  request_id: string; agent_wallet_id: string; action_description_sha256: string;
  subject_pe_id: string | null; status: ApprovalRequestStatus; created_at_ms: number;
  expires_at_ms: number; satisfied_by_pe_id: string | null; decision: 'approved' | 'rejected' | null;
} {
  return {
    request_id: r.request_id,
    agent_wallet_id: r.agent_wallet_id,
    action_description_sha256: r.action_description_sha256,
    subject_pe_id: r.subject_pe_id,
    status: r.status,
    created_at_ms: r.created_at_ms,
    expires_at_ms: r.expires_at_ms,
    satisfied_by_pe_id: r.satisfied_by_pe_id,
    decision: r.decision,
  };
}

/**
 * HUMAN APPROVAL PE (Trust Layer build §2.10,).
 *
 * A human wallet signs an approval PE at its existing attestation tier (the phone's device-bound
 * mobile lane); an agent PE cites it as a `pe:<approval pe id>` origin; the vocabulary counts it
 * (`accountability.human_approvals_given` on the human, `accountability.human_approvals_cited` on
 * the agent). The approval reference is METADATA ONLY: an agent wallet id, an optional subject PE
 * id and/or subject content hash, and a decision code — never a title, a note, or any free text.
 *
 * The row is `eligible` in the signed matrix (, superseding 's record_only pin): a
 * biometric-signed approval is the approver's own witnessed act and mints once at its witness-class
 * base, anchored on the approval request id (`core/pvt/human-approval-earning.ts`). It is not a
 * settlement signal on the target: citing it moves no share and adds nothing to the target's price.
 */

export const HUMAN_APPROVAL_ACTION_TYPE = 'human_approval';

export type HumanApprovalDecision = 'approved' | 'rejected';

export interface HumanApprovalMetadata {
  readonly agent_wallet_id: string;
  readonly decision: HumanApprovalDecision;
  readonly subject_pe_id: string | null;
  readonly subject_hash: string | null;
  /**
   * the approval REQUEST this PE answers (`apr_<32 hex>`), the mint-once anchor. Optional
   * for chain integrity — a human_approval that omits it still RECORDS (the overlay fails closed to
   * record_only, never a 0-point "eligible") — but present for every app-sealed approval so a
   * re-seal for the SAME request reprices to 0 (see `humanApprovalVerifiedFields`).
   */
  readonly request_id: string | null;
}

const WALLET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,240}$/;
const SHA256_RE = /^(?:sha256:)?[0-9a-f]{64}$/i;
/** The approval-request id shape minted by buildApprovalRequest (`apr_` + 16 random bytes hex). */
export const APPROVAL_REQUEST_ID_RE = /^apr_[0-9a-f]{32}$/;

/**
 * Parse an untrusted `approval_metadata` body into its canonical, metadata-only form — or null
 * (fail-closed) when anything is missing, malformed, or carries a key outside the four allowed.
 */
export function parseHumanApprovalMetadata(raw: unknown): HumanApprovalMetadata | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!['agent_wallet_id', 'decision', 'subject_pe_id', 'subject_hash', 'request_id'].includes(key)) return null;
  }
  const agentWalletId = typeof o.agent_wallet_id === 'string' ? o.agent_wallet_id.trim() : '';
  if (!WALLET_ID_RE.test(agentWalletId)) return null;
  const decision = o.decision;
  if (decision !== 'approved' && decision !== 'rejected') return null;
  let subjectPeId: string | null = null;
  if (o.subject_pe_id !== undefined && o.subject_pe_id !== null) {
    if (typeof o.subject_pe_id !== 'string' || !PE_ID_RE.test(o.subject_pe_id)) return null;
    subjectPeId = o.subject_pe_id;
  }
  let subjectHash: string | null = null;
  if (o.subject_hash !== undefined && o.subject_hash !== null) {
    if (typeof o.subject_hash !== 'string' || !SHA256_RE.test(o.subject_hash)) return null;
    const hex = o.subject_hash.toLowerCase().replace(/^sha256:/, '');
    subjectHash = `sha256:${hex}`;
  }
  let requestId: string | null = null;
  if (o.request_id !== undefined && o.request_id !== null) {
    if (typeof o.request_id !== 'string' || !APPROVAL_REQUEST_ID_RE.test(o.request_id)) return null;
    requestId = o.request_id;
  }
  return {
    agent_wallet_id: agentWalletId,
    decision,
    subject_pe_id: subjectPeId,
    subject_hash: subjectHash,
    request_id: requestId,
  };
}

/** The `pe:` origin an agent cites to bind its act to a human approval (SDK/MCP mirror this shape). */
export function humanApprovalOriginIdentifier(approvalPeId: string): string {
  return `pe:${approvalPeId}`;
}

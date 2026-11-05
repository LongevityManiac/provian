/**
 * §2.1 agent-initiated human-approval request — pure rules + RED controls.
 * Non-vacuous: the binding check passes for a matching approval and is shown REFUSING
 * a mismatched hash, a wrong agent, and a null hash; the builder fails closed on bad input.
 */
import {
  buildApprovalRequest,
  approvalPeSatisfiesRequest,
  hashActionDescription,
  toAgentFacingRequest,
  APPROVAL_REQUEST_TTL_MS,
} from './human-approval-request';

const NOW = 1_800_000_000_000;
const BASE = { agentWalletId: 'wallet_aw_1', humanUserId: 'user_h1', actionDescription: 'Wire $500 to Acme for invoice 42', nowMs: NOW };

describe('§2.1 buildApprovalRequest', () => {
  it('builds a pending request with a hash-only anchor + TTL', () => {
    const r = buildApprovalRequest(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.status).toBe('pending');
    expect(r.record.action_description).toBe('Wire $500 to Acme for invoice 42');
    expect(r.record.action_description_sha256).toBe(hashActionDescription('Wire $500 to Acme for invoice 42'));
    expect(r.record.expires_at_ms).toBe(NOW + APPROVAL_REQUEST_TTL_MS);
    expect(r.record.request_id).toMatch(/^apr_[0-9a-f]{32}$/);
  });

  it('the agent-facing projection NEVER carries the description text (§3 privacy)', () => {
    const r = buildApprovalRequest(BASE);
    if (!r.ok) throw new Error('setup');
    const projected = toAgentFacingRequest(r.record) as Record<string, unknown>;
    expect(projected.action_description).toBeUndefined();
    expect(projected.action_description_sha256).toBeDefined();
  });

  // RED controls — the builder fails closed.
  it('RED: no linked human → refused', () => {
    expect(buildApprovalRequest({ ...BASE, humanUserId: '' })).toEqual({ ok: false, error: 'no linked human to approve this request' });
  });
  it('RED: empty description → refused', () => {
    expect(buildApprovalRequest({ ...BASE, actionDescription: '   ' }).ok).toBe(false);
  });
  it('RED: oversized description → refused', () => {
    expect(buildApprovalRequest({ ...BASE, actionDescription: 'x'.repeat(2001) }).ok).toBe(false);
  });
  it('RED: malformed subject_pe_id → refused', () => {
    expect(buildApprovalRequest({ ...BASE, subjectPeId: 'not a pe id!!' }).ok).toBe(false);
  });
});

describe('§2.1 approvalPeSatisfiesRequest', () => {
  const req = { agent_wallet_id: 'wallet_aw_1', action_description_sha256: hashActionDescription('do the thing') };

  it('a matching approval PE satisfies the request', () => {
    expect(approvalPeSatisfiesRequest(req, { agent_wallet_id: 'wallet_aw_1', subject_hash: hashActionDescription('do the thing') })).toBe(true);
  });
  // RED controls — each MUST NOT satisfy.
  it('RED: a different description hash does not satisfy', () => {
    expect(approvalPeSatisfiesRequest(req, { agent_wallet_id: 'wallet_aw_1', subject_hash: hashActionDescription('do a DIFFERENT thing') })).toBe(false);
  });
  it('RED: a different agent does not satisfy', () => {
    expect(approvalPeSatisfiesRequest(req, { agent_wallet_id: 'wallet_aw_OTHER', subject_hash: hashActionDescription('do the thing') })).toBe(false);
  });
  it('RED: a null subject hash does not satisfy', () => {
    expect(approvalPeSatisfiesRequest(req, { agent_wallet_id: 'wallet_aw_1', subject_hash: null })).toBe(false);
  });
});

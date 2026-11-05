import * as crypto from 'crypto';
import {
  HUMAN_APPROVAL_SEAL_STAMP_SINCE_MS,
  humanApprovalVerifiedFields,
  verifyApprovalRequestForSeal,
  type ApprovalRequestSealVerdict,
  type VerifiedApprovalRequest,
} from './human-approval-earning';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';

// After the seal-stamp line, so a satisfied request without a stamp is a live, unsealed one.
const NOW = HUMAN_APPROVAL_SEAL_STAMP_SINCE_MS + 86_400_000;
const REQ = `apr_${'a'.repeat(32)}`;
const SUBJECT = `sha256:${'d'.repeat(64)}`;
const HUMAN = 'human_1';
const AGENT = 'wallet_aw_1';
const PE = 'pe_approval_1';
const hashOf = (anchor: string) => crypto.createHash('sha256').update(`human_approval:${anchor}`).digest('hex');

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  request_id: REQ,
  agent_wallet_id: AGENT,
  human_user_id: HUMAN,
  action_description: 'Pay 12 USDC',
  action_description_sha256: SUBJECT,
  subject_pe_id: null,
  status: 'pending',
  created_at_ms: NOW - 1000,
  expires_at_ms: NOW + 60_000,
  satisfied_by_pe_id: null,
  decision: null,
  ...over,
});

const verify = (over: {
  requestId?: string | null;
  request?: unknown;
  callerUserId?: string;
  approval?: Partial<{ agent_wallet_id: string; subject_hash: string | null; decision: 'approved' | 'rejected' }>;
  approvalPeId?: string;
  clientPeId?: string | null;
  nowMs?: number;
} = {}): ApprovalRequestSealVerdict => verifyApprovalRequestForSeal({
  requestId: 'requestId' in over ? over.requestId : REQ,
  request: 'request' in over ? over.request : record(),
  callerUserId: over.callerUserId ?? HUMAN,
  approval: { agent_wallet_id: AGENT, subject_hash: SUBJECT, decision: 'approved', ...(over.approval ?? {}) },
  approvalPeId: over.approvalPeId ?? PE,
  ...('clientPeId' in over ? { clientPeId: over.clientPeId } : {}),
  nowMs: over.nowMs ?? NOW,
});

const refusal = (v: ApprovalRequestSealVerdict): string => (v.ok ? 'ok' : v.reason);

describe('verifyApprovalRequestForSeal — a human_approval answers a REAL, live request addressed to this human (2026-09-30)', () => {
  it('ADMIT: an existing pending, unexpired request of mine, same agent, matching subject hash', () => {
    const v = verify();
    expect(v.ok).toBe(true);
    expect(v.ok && v.verified.requestId).toBe(REQ);
    expect(v.ok && v.verified.claim).toBe('pending');
  });

  it('ADMIT: a request the app already resolved with THIS envelope (resolve runs before the PE queue flushes)', () => {
    const v = verify({ request: record({ status: 'satisfied', satisfied_by_pe_id: PE, decision: 'approved' }) });
    expect(v.ok && v.verified.claim).toBe('satisfied_by_this_pe');
  });

  it('RED: no / malformed request_id (a bare subject hash names no request)', () => {
    expect(refusal(verify({ requestId: null }))).toBe('no_request_id');
    expect(refusal(verify({ requestId: 'apr_short' }))).toBe('no_request_id');
    expect(refusal(verify({ requestId: `apr_${'A'.repeat(32)}` }))).toBe('no_request_id');
  });

  it('RED: a fabricated id — no such request', () => {
    expect(refusal(verify({ request: null }))).toBe('request_not_found');
    expect(refusal(verify({ request: undefined }))).toBe('request_not_found');
  });

  it('RED: another human\'s request', () => {
    expect(refusal(verify({ request: record({ human_user_id: 'human_2' }) }))).toBe('not_addressed_to_caller');
    expect(refusal(verify({ callerUserId: '' }))).toBe('not_addressed_to_caller');
  });

  it('ADMIT: a request the app resolved with the PHONE\'S envelope id (PE v2 pe_id), sealed under the relay id (2026-10-17)', () => {
    // The app resolves with its own uuid before the batch flushes; the meter seals the act under
    // `pe_m_<hash>`. Either id is this envelope.
    const v = verify({
      request: record({ status: 'satisfied', satisfied_by_pe_id: 'c0ffee00-1234-4abc-8def-0123456789ab', decision: 'approved' }),
      clientPeId: 'c0ffee00-1234-4abc-8def-0123456789ab',
    });
    expect(v.ok && v.verified.claim).toBe('satisfied_by_this_pe');
  });

  it('RED: the client id is not a wildcard — a request another envelope resolved stays resolved', () => {
    expect(refusal(verify({
      request: record({ status: 'satisfied', satisfied_by_pe_id: 'c0ffee00-1234-4abc-8def-0123456789ab', decision: 'approved' }),
      clientPeId: 'deadbeef-1234-4abc-8def-0123456789ab',
    }))).toBe('already_resolved');
    expect(refusal(verify({
      request: record({ status: 'satisfied', satisfied_by_pe_id: 'c0ffee00-1234-4abc-8def-0123456789ab', decision: 'approved' }),
    }))).toBe('already_resolved');
    expect(refusal(verify({
      request: record({ status: 'satisfied', satisfied_by_pe_id: '', decision: 'approved' }),
      clientPeId: '',
    }))).toBe('already_resolved');
  });

  it('RED: another agent, or a subject hash that is not the described action', () => {
    expect(refusal(verify({ approval: { agent_wallet_id: 'wallet_aw_2' } }))).toBe('agent_mismatch');
    expect(refusal(verify({ approval: { subject_hash: `sha256:${'e'.repeat(64)}` } }))).toBe('subject_hash_mismatch');
    expect(refusal(verify({ approval: { subject_hash: null } }))).toBe('subject_hash_mismatch');
  });

  it('RED: expired (by clock or by status) and already resolved (by another PE, or with another decision)', () => {
    expect(refusal(verify({ request: record({ expires_at_ms: NOW }) }))).toBe('expired');
    expect(refusal(verify({ request: record({ status: 'expired' }) }))).toBe('expired');
    expect(refusal(verify({ request: record({ status: 'satisfied', satisfied_by_pe_id: 'pe_other', decision: 'approved' }) }))).toBe('already_resolved');
    expect(refusal(verify({ request: record({ status: 'satisfied', satisfied_by_pe_id: PE, decision: 'rejected' }) }))).toBe('already_resolved');
  });

  it('fix run 2026-10-24: a request sealed by one relay PE can never be sealed by another, whatever pe_id is supplied', () => {
    const satisfiedByClient = { status: 'satisfied', satisfied_by_pe_id: 'c0ffee00-1234-4abc-8def-0123456789ab', decision: 'approved' };
    // Control: unstamped and satisfied by this envelope's client id → sealable once.
    expect(refusal(verify({ request: record(satisfiedByClient), clientPeId: 'c0ffee00-1234-4abc-8def-0123456789ab' }))).toBe('ok');
    // Stamped by an earlier relay PE → refused, even with the same client id (the replay).
    expect(refusal(verify({
      request: record({ ...satisfiedByClient, sealed_by_pe_id: 'pe_m_first' }),
      clientPeId: 'c0ffee00-1234-4abc-8def-0123456789ab',
    }))).toBe('already_sealed');
    // Satisfied by a relay id (the batch claimed it pending) → a later act naming that id is refused.
    expect(refusal(verify({
      request: record({ status: 'satisfied', satisfied_by_pe_id: 'pe_m_first', decision: 'approved', sealed_by_pe_id: 'pe_m_first' }),
      clientPeId: 'pe_m_first',
    }))).toBe('already_sealed');
    // A later act reproducing the SAME relay id (it derives from the client-supplied pe_hash) is
    // refused too: the sealing act reads the request before its own stamp is written.
    expect(refusal(verify({
      request: record({ ...satisfiedByClient, sealed_by_pe_id: PE }),
      clientPeId: 'c0ffee00-1234-4abc-8def-0123456789ab',
    }))).toBe('already_sealed');
    // A stamp on a pending doc (never written that way, but read fail-closed) also refuses.
    expect(refusal(verify({ request: record({ sealed_by_pe_id: 'pe_m_first' }) }))).toBe('already_sealed');
  });

  it('fix run 2026-10-24: a satisfied, unstamped request created before the stamp line is treated as already sealed', () => {
    const legacy = { status: 'satisfied', satisfied_by_pe_id: PE, decision: 'approved' };
    expect(refusal(verify({ request: record({ ...legacy, created_at_ms: HUMAN_APPROVAL_SEAL_STAMP_SINCE_MS - 1 }) }))).toBe('already_sealed');
    expect(refusal(verify({ request: record({ ...legacy, created_at_ms: undefined }) }))).toBe('already_sealed');
    // RED control: the same request created at the stamp line is sealable.
    expect(refusal(verify({ request: record({ ...legacy, created_at_ms: HUMAN_APPROVAL_SEAL_STAMP_SINCE_MS }) }))).toBe('ok');
    // A pending legacy request is still claimable (the stamp is written by that claim).
    expect(refusal(verify({ request: record({ created_at_ms: HUMAN_APPROVAL_SEAL_STAMP_SINCE_MS - 1 }) }))).toBe('ok');
  });

  it('RED (fail-closed): a malformed doc — wrong id, missing fields, unknown status, non-object', () => {
    expect(refusal(verify({ request: record({ request_id: `apr_${'b'.repeat(32)}` }) }))).toBe('malformed_request');
    expect(refusal(verify({ request: record({ human_user_id: undefined }) }))).toBe('malformed_request');
    expect(refusal(verify({ request: record({ expires_at_ms: 'soon' }) }))).toBe('malformed_request');
    expect(refusal(verify({ request: record({ status: 'weird' }) }))).toBe('malformed_request');
    expect(refusal(verify({ request: 'not-an-object' }))).toBe('malformed_request');
    expect(refusal(verify({ request: [record()] }))).toBe('malformed_request');
  });
});

describe('humanApprovalVerifiedFields — mints only on a VERIFIED request, mint-once on the request id', () => {
  const verified = (): VerifiedApprovalRequest => {
    const v = verify();
    if (!v.ok) throw new Error('fixture must verify');
    return v.verified;
  };

  it('ADMIT: lifts the fence and anchors mint-once on the request id', () => {
    const overlay = humanApprovalVerifiedFields({ actionType: 'human_approval', verifiedRequest: verified() });
    expect(overlay.durableReplaySource).toBe(ORDINARY_ACCRUAL_REPLAY_SOURCE);
    expect(overlay.economicEvidenceState).toBe('verified');
    expect(overlay.economicCanonicalEventId).toBe(`human_approval:${REQ}`);
    expect(overlay.deviceWitnessedOccurrenceHash).toBe(hashOf(REQ));
    expect(overlay.artifact_hash).toBe(hashOf(REQ));
  });

  it('mint-once is per request: the same request yields the identical anchor', () => {
    expect(humanApprovalVerifiedFields({ actionType: 'human_approval', verifiedRequest: verified() }).deviceWitnessedOccurrenceHash)
      .toBe(humanApprovalVerifiedFields({ actionType: 'human_approval', verifiedRequest: verified() }).deviceWitnessedOccurrenceHash);
  });

  it('RED: no verified request → EMPTY overlay (record_only) — the retired subject-hash fallback no longer mints', () => {
    expect(humanApprovalVerifiedFields({ actionType: 'human_approval', verifiedRequest: null })).toEqual({});
    expect(humanApprovalVerifiedFields({ actionType: 'human_approval', verifiedRequest: undefined })).toEqual({});
  });

  it('RED: a different action type gets an EMPTY overlay (no other type moves)', () => {
    expect(humanApprovalVerifiedFields({ actionType: 'ai_conversation', verifiedRequest: verified() })).toEqual({});
    expect(humanApprovalVerifiedFields({ actionType: 'send', verifiedRequest: verified() })).toEqual({});
  });

  it('RED (defense in depth): a forged "verified" object with a malformed id still gets an EMPTY overlay', () => {
    const forged = { requestId: 'apr_nope', claim: 'pending' } as unknown as VerifiedApprovalRequest;
    expect(humanApprovalVerifiedFields({ actionType: 'human_approval', verifiedRequest: forged })).toEqual({});
  });
});

/**
 * human-approval-earning — the record-time overlay that makes a HUMAN's biometric in-app
 * approval (`human_approval`) MINT at its witness-class base, instead of sealing `record_only`.
 *
 * TWO PINS held `human_approval` at 0 (, — "human_approval is NOT
 * record_only; every PE mints, and under class-based admission it earns at its evidence-class
 * base"). The FIRST was the matrix row disposition — now `eligible` + `verified_witness_class`
 * (see `humanApprovalEntry` in proposed-action-policy.ts), so device_tier prices at the class
 * base and the hardware-rooted App-Attest override lifts it to 4.0×. The SECOND is the one this
 * overlay lifts: the mobile submit path is a best-effort transport whose accrual params carry no
 * `durableReplaySource`, so `resolveOperationalDisposition` returns `record_only` at its FIRST
 * branch, BEFORE the matrix is ever consulted (`pvt-accrual.ts`). This overlay claims the
 * co-committed ordinary-accrual intake row so that fence lifts — the EXACT parallel of
 * `mobileChatVerifiedFields` for `ai_conversation`. It moves NO pricing on any other type
 * (empty overlay for everything but `human_approval`).
 *
 * THE ANTI-SYBIL CONTROL IS THE BIOMETRIC APP GATE. A human_approval is sealed only by the
 * biometric-gated, body-bound app (wallet-auth v2 binds the request body hash), and it is a
 * WITNESSED class by construction (device_tier, or hardware_rooted when App Attest attaches) —
 * the relay's own witness-class assignment is the record-time verifier, so no attestation gate
 * and no daily ceiling, exactly as for the chat lane.
 *
 * A REAL REQUEST, CHECKED AT SEAL TIME (carried, : "no actor's own claim
 * mints, on any route"). The approval mints only when it answers an EXISTING agent-initiated
 * request in `human_approval_requests_v1` addressed to THIS human (the agent's linked human at
 * creation), naming the same agent, whose `action_description_sha256` equals the sealed
 * `subject_hash`, and that is still pending and unexpired (or was already resolved by THIS very
 * envelope — the app resolves before its PE queue flushes). {@link verifyApprovalRequestForSeal}
 * is that check; the mobile route runs it on the request doc read INSIDE the chain-tip transaction
 * and marks the request satisfied in the same commit, so two submissions cannot both claim it.
 * The agent's request is the counterparty voucher; a fabricated `apr_` id, a random subject hash,
 * someone else's request, or a resolved/expired one is only the human's own claim — it RECORDS
 * (their signed approval is still their act) but seals `record_only`. The subject-hash-only
 * fallback is RETIRED: a subject hash alone names no request and minted once per random value.
 *
 * MINT-ONCE IS THE APPROVAL REQUEST id (the operator: "mint-once on the request id"). The overlay
 * anchors the hard per-occurrence `device_occurrence` claim on `sha256("human_approval:"+
 * request_id)` re-sealing an approval for the SAME request produces the same digest → duplicate
 * → novelty 0 → 0 PVT. One request → one mint, however many approval PEs are sealed against it.
 * The same digest is the canonical event id, so the canonical-event gate is satisfied on the
 * request, not merely per-PE. FAIL-CLOSED: a missing/malformed request id returns an EMPTY
 * overlay, so the PE stays `record_only` (never a 0-point "eligible") — mirroring the chat
 * overlay's fingerprint gate. Kept OUT of the route handler as a pure function so it carries an
 * in-suite RED negative control.
 */

import * as crypto from 'crypto';
import type { RecordPEAccrualParams } from '../../pvt-accrual';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';
import { HUMAN_APPROVAL_ACTION_TYPE, APPROVAL_REQUEST_ID_RE, type HumanApprovalDecision } from '../pe/human-approval';

declare const verifiedApprovalRequestBrand: unique symbol;

/**
 * A request the seal-time check proved real. Branded: only {@link verifyApprovalRequestForSeal}
 * constructs one, so no caller can hand the overlay a bare id it merely parsed.
 */
export interface VerifiedApprovalRequest {
  readonly requestId: string;
  /** `pending` → the seal claims it now; `satisfied_by_this_pe` → the app resolved it with this envelope id first. */
  readonly claim: 'pending' | 'satisfied_by_this_pe';
  readonly [verifiedApprovalRequestBrand]: true;
}

export type ApprovalRequestSealRefusal =
  | 'no_request_id'
  | 'request_not_found'
  | 'malformed_request'
  | 'not_addressed_to_caller'
  | 'agent_mismatch'
  | 'subject_hash_mismatch'
  | 'expired'
  | 'already_resolved'
  | 'already_sealed';

/**
 * Fix run 2026-10-24: a seal now stamps `sealed_by_pe_id` on the request (pending AND
 * satisfied-by-this-envelope), so a satisfied request is sealable exactly once. A request created
 * before this instant may have been sealed by the earlier code, which left no stamp on the
 * satisfied branch; such a satisfied, unstamped request is treated as already sealed.
 */
export const HUMAN_APPROVAL_SEAL_STAMP_SINCE_MS = 1_792_929_600_000; // 2026-10-25T12:00:00Z

export type ApprovalRequestSealVerdict =
  | { readonly ok: true; readonly verified: VerifiedApprovalRequest }
  | { readonly ok: false; readonly reason: ApprovalRequestSealRefusal };

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * The seal-time request check. PURE (a function of the request doc as read, the caller, the sealed
 * approval metadata, this envelope id and the clock). `request` is the raw Firestore data of
 * `human_approval_requests_v1/{requestId}` read in the recording transaction (null = absent);
 * it is untrusted-shaped, so every field is re-checked. Fails CLOSED to a refusal on anything
 * missing, malformed, foreign, mismatched, resolved or expired.
 */
export function verifyApprovalRequestForSeal(input: {
  readonly requestId: string | null | undefined;
  readonly request: unknown;
  readonly callerUserId: string;
  readonly approval: {
    readonly agent_wallet_id: string;
    readonly subject_hash: string | null;
    readonly decision: HumanApprovalDecision;
  };
  readonly approvalPeId: string;
  /**
   * 2026-10-17: the id the PHONE knows its envelope by (PE v2 `pe_id`, a uuid). The app resolves
   * the request with that id before its batch flushes, while the seal runs under the relay id
   * (`pe_m_<hash>`); the two can never be equal, so without this every in-app approval sealed
   * `already_resolved` → record_only. Either id satisfies.
   */
  readonly clientPeId?: string | null;
  readonly nowMs: number;
}): ApprovalRequestSealVerdict {
  const requestId = typeof input.requestId === 'string' ? input.requestId : '';
  if (!APPROVAL_REQUEST_ID_RE.test(requestId)) return { ok: false, reason: 'no_request_id' };
  if (input.request === null || input.request === undefined) return { ok: false, reason: 'request_not_found' };
  if (typeof input.request !== 'object' || Array.isArray(input.request)) return { ok: false, reason: 'malformed_request' };
  const rec = input.request as Record<string, unknown>;
  const humanUserId = str(rec.human_user_id);
  const agentWalletId = str(rec.agent_wallet_id);
  const descriptionHash = str(rec.action_description_sha256);
  const status = str(rec.status);
  const expiresAtMs = rec.expires_at_ms;
  if (str(rec.request_id) !== requestId || !humanUserId || !agentWalletId || !descriptionHash
    || typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) {
    return { ok: false, reason: 'malformed_request' };
  }
  if (input.callerUserId.length === 0 || humanUserId !== input.callerUserId) {
    return { ok: false, reason: 'not_addressed_to_caller' };
  }
  if (agentWalletId !== input.approval.agent_wallet_id) return { ok: false, reason: 'agent_mismatch' };
  if (input.approval.subject_hash === null || input.approval.subject_hash !== descriptionHash) {
    return { ok: false, reason: 'subject_hash_mismatch' };
  }
  // One seal per request, ever: the relay PE that sealed it is stamped on the request in the same
  // transaction, and a stamped request is never sealed again — not by another envelope, and not by
  // one carrying the SAME relay id (that id derives from the act's client-supplied pe_hash, so a
  // later act can reproduce it; the sealing act itself reads the request before its own write).
  const sealedBy = str(rec.sealed_by_pe_id) ?? '';
  if (sealedBy.length > 0) return { ok: false, reason: 'already_sealed' };
  if (status === 'pending') {
    if (expiresAtMs <= input.nowMs) return { ok: false, reason: 'expired' };
    return { ok: true, verified: { requestId, claim: 'pending' } as VerifiedApprovalRequest };
  }
  if (status === 'satisfied') {
    // The app resolves the request with the envelope id BEFORE its PE queue flushes; the resolve
    // route refuses an expired request, so a request satisfied by THIS envelope was live when it
    // was answered. Any other resolution (another PE, another decision) is already spent.
    const satisfiedBy = str(rec.satisfied_by_pe_id) ?? '';
    const byThisEnvelope = satisfiedBy.length > 0
      && (satisfiedBy === input.approvalPeId
        || (typeof input.clientPeId === 'string' && input.clientPeId.length > 0 && satisfiedBy === input.clientPeId));
    const createdAtMs = rec.created_at_ms;
    const unstampedLegacy = sealedBy.length === 0
      && !(typeof createdAtMs === 'number' && Number.isFinite(createdAtMs) && createdAtMs >= HUMAN_APPROVAL_SEAL_STAMP_SINCE_MS);
    if (unstampedLegacy) return { ok: false, reason: 'already_sealed' };
    if (byThisEnvelope && str(rec.decision) === input.approval.decision) {
      return { ok: true, verified: { requestId, claim: 'satisfied_by_this_pe' } as VerifiedApprovalRequest };
    }
    return { ok: false, reason: 'already_resolved' };
  }
  if (status === 'expired') return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'malformed_request' };
}

/**
 * The accrual-param overlay that turns a body-bound `human_approval` mobile PE into a durable,
 * mintable one, mint-once on the approval REQUEST. PURE (a function of its inputs only). Returns an
 * EMPTY overlay — the PE records, sealed `record_only` — unless the action type is
 * `human_approval` AND the seal-time check proved the request real ({@link VerifiedApprovalRequest}).
 * No request, no mint: a request id that was only parsed, or a bare subject hash, is the human's
 * own claim.
 */
export function humanApprovalVerifiedFields(input: {
  readonly actionType: string;
  readonly verifiedRequest: VerifiedApprovalRequest | null | undefined;
}): Partial<RecordPEAccrualParams> {
  if (input.actionType !== HUMAN_APPROVAL_ACTION_TYPE) return {};
  const requestId = input.verifiedRequest?.requestId ?? '';
  if (!APPROVAL_REQUEST_ID_RE.test(requestId)) return {};
  const canonical = `${HUMAN_APPROVAL_ACTION_TYPE}:${requestId}`;
  const canonicalHash = crypto.createHash('sha256').update(canonical).digest('hex');
  return {
    // Claim the co-committed ordinary-accrual intake row → the transport durability fence lifts
    // (verified against that committed row in pvt-accrual, never on the caller's word). Must ride
    // the SAME builder that writes the intake row so the bytes match.
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    // The witness class IS the evidence (verified_witness_class); pvt-accrual stamps the record
    // verified for a witnessed class. Set explicitly for parity with the chat overlay.
    economicEvidenceState: 'verified',
    // Canonical event = the request (not merely this PE), satisfying canonical_event_required.
    economicCanonicalEventId: canonical,
    // Hard per-occurrence mint-once on the REQUEST id: a re-seal for the same request → same
    // digest → exactDuplicate → novelty 0 → 0 PVT.
    deviceWitnessedOccurrenceHash: canonicalHash,
    // Per-request artifact novelty (distinct requests keep full novelty; a replay reprices to 0).
    artifact_hash: canonicalHash,
  };
}

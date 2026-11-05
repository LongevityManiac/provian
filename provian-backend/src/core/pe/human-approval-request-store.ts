/**
 * Firestore + push for the agent-initiated human-approval request (§2.1). The pure
 * rules live in ./human-approval-request; this is the thin IO layer both routers use.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { sendPush, pruneUserTokens } from '../notifications/pushDispatcher';
import {
  HUMAN_APPROVAL_REQUESTS_COLLECTION,
  type HumanApprovalRequestRecord,
  type ApprovalRequestStatus,
} from './human-approval-request';

export async function writeApprovalRequest(db: Pick<Firestore, 'collection'>, record: HumanApprovalRequestRecord): Promise<void> {
  await db.collection(HUMAN_APPROVAL_REQUESTS_COLLECTION).doc(record.request_id).set(record);
}

/** Pending, unexpired requests for the linked human — WITH the description text (Tier-3, this human only). */
export async function listPendingRequestsForHuman(
  db: Pick<Firestore, 'collection'>,
  humanUserId: string,
  nowMs: number,
): Promise<HumanApprovalRequestRecord[]> {
  const snap = await db.collection(HUMAN_APPROVAL_REQUESTS_COLLECTION)
    .where('human_user_id', '==', humanUserId)
    .where('status', '==', 'pending')
    .get();
  return snap.docs
    .map((d) => d.data() as HumanApprovalRequestRecord)
    .filter((r) => r.expires_at_ms > nowMs)
    .sort((a, b) => b.created_at_ms - a.created_at_ms);
}

/** An agent polling its own requests (agent-facing projection is applied by the route). */
export async function listRequestsForAgent(
  db: Pick<Firestore, 'collection'>,
  agentWalletId: string,
  status?: ApprovalRequestStatus,
): Promise<HumanApprovalRequestRecord[]> {
  let q = db.collection(HUMAN_APPROVAL_REQUESTS_COLLECTION).where('agent_wallet_id', '==', agentWalletId);
  if (status) q = q.where('status', '==', status);
  const snap = await q.get();
  return snap.docs.map((d) => d.data() as HumanApprovalRequestRecord).sort((a, b) => b.created_at_ms - a.created_at_ms);
}

export type ResolveResult =
  | { ok: true; record: HumanApprovalRequestRecord }
  | { ok: false; status: number; error: string };

/**
 * Mark a request satisfied after the human's approval PE seals. Transactional +
 * ownership-guarded: only the linked human may resolve, only a pending request, and
 * the resolution is idempotent (re-resolving returns the already-satisfied record).
 */
export async function resolveApprovalRequest(
  db: FirebaseFirestore.Firestore,
  params: { requestId: string; humanUserId: string; approvalPeId: string; decision: 'approved' | 'rejected'; nowMs: number },
): Promise<ResolveResult> {
  const ref = db.collection(HUMAN_APPROVAL_REQUESTS_COLLECTION).doc(params.requestId);
  let out: ResolveResult = { ok: false, status: 404, error: 'request not found' };
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) { out = { ok: false, status: 404, error: 'request not found' }; return; }
    const rec = snap.data() as HumanApprovalRequestRecord;
    if (rec.human_user_id !== params.humanUserId) { out = { ok: false, status: 403, error: 'not your approval request' }; return; }
    if (rec.status === 'satisfied') { out = { ok: true, record: rec }; return; } // idempotent
    // A lapsed request cannot be answered (2026-09-30): the seal-time check accepts a request
    // already satisfied by the sealing envelope, so resolving must itself require a live request.
    if (rec.status !== 'pending' || rec.expires_at_ms <= params.nowMs) {
      out = { ok: false, status: 409, error: 'approval request expired' };
      return;
    }
    const updated: HumanApprovalRequestRecord = {
      ...rec, status: 'satisfied', satisfied_by_pe_id: params.approvalPeId, decision: params.decision,
    };
    txn.set(ref, updated);
    out = { ok: true, record: updated };
  });
  return out;
}

/**
 * Seal-time read (2026-09-30): the raw request doc, read INSIDE the PE's chain-tip transaction
 * (its read-only precondition phase), so the claim below serializes with any concurrent seal or
 * resolve of the same request. Null when absent. The caller verifies it
 * (`verifyApprovalRequestForSeal`) — this returns untrusted-shaped data.
 */
export async function readApprovalRequestInTransaction(
  txn: FirebaseFirestore.Transaction,
  db: Pick<Firestore, 'collection'>,
  requestId: string,
): Promise<unknown> {
  const snap = await txn.get(db.collection(HUMAN_APPROVAL_REQUESTS_COLLECTION).doc(requestId));
  return snap.exists ? (snap.data() ?? null) : null;
}

/**
 * Seal-time claim: mark a VERIFIED pending request satisfied by the sealing approval PE, in the
 * same transaction that commits the PE (write-only, synchronous). A second seal for the same
 * request then reads `satisfied` by another envelope and records without minting.
 */
export function claimApprovalRequestInTransaction(
  txn: FirebaseFirestore.Transaction,
  db: Pick<Firestore, 'collection'>,
  params: { requestId: string; approvalPeId: string; decision: 'approved' | 'rejected' },
): void {
  txn.update(db.collection(HUMAN_APPROVAL_REQUESTS_COLLECTION).doc(params.requestId), {
    status: 'satisfied',
    satisfied_by_pe_id: params.approvalPeId,
    decision: params.decision,
    sealed_by_pe_id: params.approvalPeId,
  });
}

/**
 * Seal-time stamp for a request the app already resolved with this envelope's own id: records the
 * sealing relay PE, so the seal check refuses every later envelope (fix run 2026-10-24).
 */
export function stampApprovalRequestSealInTransaction(
  txn: FirebaseFirestore.Transaction,
  db: Pick<Firestore, 'collection'>,
  params: { requestId: string; approvalPeId: string },
): void {
  txn.update(db.collection(HUMAN_APPROVAL_REQUESTS_COLLECTION).doc(params.requestId), {
    sealed_by_pe_id: params.approvalPeId,
  });
}

/** Best-effort FCM to the linked human. Never throws — the app also polls the pending list. */
export async function pushApprovalRequestToHuman(
  db: FirebaseFirestore.Firestore,
  humanUserId: string,
  record: HumanApprovalRequestRecord,
): Promise<void> {
  try {
    const userSnap = await db.collection('users').doc(humanUserId).get();
    const tokens = (userSnap.exists ? (userSnap.data()?.fcm_tokens as string[] | undefined) : undefined) ?? [];
    if (tokens.length === 0) return;
    const result = await sendPush(tokens, {
      tokenLanguages: userSnap.data()?.push_languages,
      title: 'Approval requested',
      // Never the description text in a push payload — only that a request exists.
      body: 'An agent is asking you to approve an action. Tap to review.',
      data: { type: 'human_approval_request', request_id: record.request_id, agent_wallet_id: record.agent_wallet_id },
    });
    await pruneUserTokens(db, humanUserId, result.invalidTokens);
  } catch (err) {
    console.error('[ApprovalRequest] push failed (non-fatal):', err);
  }
}

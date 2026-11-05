/**
 * resolveApprovalRequest refuses a lapsed request (2026-09-30). The seal-time check accepts a
 * request already satisfied by the sealing envelope (the app resolves before its PE queue flushes),
 * so resolving must itself require a live request — otherwise an expired request could be revived
 * into a mint by resolving it first. The first case is the RED control: a live request resolves.
 */
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { resolveApprovalRequest } from './human-approval-request-store';
import { buildApprovalRequest, HUMAN_APPROVAL_REQUESTS_COLLECTION, type HumanApprovalRequestRecord } from './human-approval-request';

const NOW = 1_790_000_000_000;

function setup(over: Partial<HumanApprovalRequestRecord> = {}) {
  const db = createFakeFirestore();
  const built = buildApprovalRequest({ agentWalletId: 'wallet_aw_1', humanUserId: 'human_1', actionDescription: 'Pay 12 USDC', nowMs: NOW - 1000 });
  if (!built.ok) throw new Error(built.error);
  const rec = { ...built.record, ...over };
  db.store.set(`${HUMAN_APPROVAL_REQUESTS_COLLECTION}/${rec.request_id}`, { ...rec });
  const resolve = (humanUserId = 'human_1') => resolveApprovalRequest(db as unknown as FirebaseFirestore.Firestore, {
    requestId: rec.request_id, humanUserId, approvalPeId: 'pe_1', decision: 'approved', nowMs: NOW,
  });
  return { db, rec, resolve };
}

describe('resolveApprovalRequest — only a live request can be answered', () => {
  it('a pending, unexpired request of mine resolves (satisfied by the PE)', async () => {
    const { resolve } = setup();
    const out = await resolve();
    expect(out.ok).toBe(true);
    expect(out.ok && out.record).toMatchObject({ status: 'satisfied', satisfied_by_pe_id: 'pe_1', decision: 'approved' });
  });

  it('RED: a request past its expiry, or marked expired, is refused 409 and left untouched', async () => {
    for (const over of [{ expires_at_ms: NOW }, { status: 'expired' as const }]) {
      const { db, rec, resolve } = setup(over);
      const out = await resolve();
      expect(out).toEqual({ ok: false, status: 409, error: 'approval request expired' });
      expect((db.store.get(`${HUMAN_APPROVAL_REQUESTS_COLLECTION}/${rec.request_id}`) as Record<string, unknown>).satisfied_by_pe_id).toBeNull();
    }
  });

  it('unchanged: another human is refused 403; an already-satisfied request is idempotent', async () => {
    expect(await setup().resolve('human_2')).toEqual({ ok: false, status: 403, error: 'not your approval request' });
    const { resolve } = setup({ status: 'satisfied', satisfied_by_pe_id: 'pe_0', decision: 'approved' });
    const out = await resolve();
    expect(out.ok && out.record.satisfied_by_pe_id).toBe('pe_0');
  });
});

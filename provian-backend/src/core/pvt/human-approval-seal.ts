/**
 * human-approval-seal — the transactional half of "a human_approval mints only against a REAL
 * request" (carried, : "no actor's own claim mints, on any route").
 *
 * `POST /v1/pe/submit/mobile` seals a `human_approval` PE inside the chain-tip transaction
 * (`advanceChainTipWithProvisionalPE`). These hooks ride that SAME transaction:
 *
 * precondition — (read phase, before any write) reads `human_approval_requests_v1/{request_id}`
 * and runs the pure {@link verifyApprovalRequestForSeal} against the caller, the
 * sealed approval metadata, and this envelope id;
 * secondaryWrite — (write phase) claims a verified PENDING request: status → satisfied, by this
 * envelope, with this decision — or stamps a request already satisfied by this
 * envelope — and in both cases sets `sealed_by_pe_id` to the sealing relay PE,
 * committed with the PE, so no later seal for the same request can mint;
 * accrualFields — the overlay for the accrual params, EMPTY unless the committed
 * attempt's verdict proved the request real.
 *
 * A transaction attempt may re-run on contention; every hook recomputes from that attempt's reads,
 * and the verdict the caller reads after the commit is the committed attempt's.
 *
 * Kept out of the route so the whole path — transaction, claim, overlay, real accrual — is driven
 * by an acceptance suite with its RED control.
 */
import type admin from 'firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import type { RecordPEAccrualParams } from '../../pvt-accrual';
import type { HumanApprovalMetadata } from '../pe/human-approval';
import {
  readApprovalRequestInTransaction,
  claimApprovalRequestInTransaction,
  stampApprovalRequestSealInTransaction,
} from '../pe/human-approval-request-store';
import {
  humanApprovalVerifiedFields,
  verifyApprovalRequestForSeal,
  type ApprovalRequestSealVerdict,
} from './human-approval-earning';

export interface ApprovalSealHooks {
  /** Undefined for a non-approval PE (no read, no claim). */
  readonly precondition: ((txn: admin.firestore.Transaction) => Promise<void>) | undefined;
  readonly secondaryWrite: (txn: admin.firestore.Transaction) => void;
  /** The latest attempt's verdict (null before the precondition ran, and for a non-approval PE). */
  verdict(): ApprovalRequestSealVerdict | null;
  /** The overlay — empty unless the verdict is a verified request. */
  accrualFields(actionType: string): Partial<RecordPEAccrualParams>;
}

export function createApprovalSealHooks(input: {
  readonly db: Pick<Firestore, 'collection'>;
  /** The parsed approval metadata (null → not a human_approval PE). */
  readonly approval: HumanApprovalMetadata | null;
  readonly callerUserId: string;
  readonly approvalPeId: string;
  /** The phone's own id for this envelope (PE v2 `pe_id`); see verifyApprovalRequestForSeal. */
  readonly clientPeId?: string | null;
  readonly nowMs: number;
}): ApprovalSealHooks {
  const { db, approval, callerUserId, approvalPeId, clientPeId, nowMs } = input;
  let verdict: ApprovalRequestSealVerdict | null = null;
  return {
    precondition: approval === null
      ? undefined
      : async (txn) => {
        verdict = null;
        const request = approval.request_id !== null
          ? await readApprovalRequestInTransaction(txn, db, approval.request_id)
          : null;
        verdict = verifyApprovalRequestForSeal({
          requestId: approval.request_id,
          request,
          callerUserId,
          approval,
          approvalPeId,
          clientPeId,
          nowMs,
        });
      },
    secondaryWrite: (txn) => {
      if (approval === null || verdict === null || !verdict.ok) return;
      if (verdict.verified.claim === 'pending') {
        claimApprovalRequestInTransaction(txn, db, {
          requestId: verdict.verified.requestId,
          approvalPeId,
          decision: approval.decision,
        });
      } else {
        // Satisfied by this envelope (the app resolved it first): stamp the seal so the request
        // can never be sealed again by a later batch carrying the same envelope id.
        stampApprovalRequestSealInTransaction(txn, db, { requestId: verdict.verified.requestId, approvalPeId });
      }
    },
    verdict: () => verdict,
    accrualFields: (actionType) => humanApprovalVerifiedFields({
      actionType,
      verifiedRequest: verdict !== null && verdict.ok ? verdict.verified : null,
    }),
  };
}

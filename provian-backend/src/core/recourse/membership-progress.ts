import type { Firestore } from 'firebase-admin/firestore';
import { MEMBERSHIP_CONSENT_OPERATIONS, MEMBERSHIP_DEBIT_OPERATIONS, membershipConsentOperationId, membershipDebitOperationId } from './membership-operation-identifiers';
import { parseStandingMembershipAuthorization, parseAddressMembershipConsent, parseMembershipAuthorizationDomain, type MembershipAuthorizationDomain, type AddressMembershipConsent, type ExactMembershipDebit } from './membership-authorization';
import { readSponsoredOperation, type SponsoredOperationStatus } from './sponsored-operation-queue';

export interface PendingMembershipConsent {
  readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent;
  readonly operation: SponsoredOperationStatus;
}
/** Caller must authenticate the private transition before calling. Return only
 * public individual authorization fields and status, never signatures. */
export async function pendingMembershipConsents(db: Firestore, transitionId: string): Promise<readonly PendingMembershipConsent[]> {
  const rows = await db.collection(MEMBERSHIP_CONSENT_OPERATIONS).where('status', 'in', ['queued', 'submitted'])
    .where('request.transitionId', '==', transitionId).get();
  const result: PendingMembershipConsent[] = [];
  for (const row of rows.docs) {
    const domain = parseMembershipAuthorizationDomain(row.get('request.domain'));
    const consent = parseAddressMembershipConsent(row.get('request.consent'));
    if (row.get('request.transitionId') !== transitionId || membershipConsentOperationId({ domain, consent, standing:row.get('request.standing')===null?null:parseStandingMembershipAuthorization(row.get('request.standing')), exitSecret:row.get('request.exitSecret') }) !== row.id) throw Error('recourse_membership_progress_invalid');
    const operation = await readSponsoredOperation(db, MEMBERSHIP_CONSENT_OPERATIONS, row.id);
    // A concurrent worker may have finalized between the query and this read.
    if (operation.status === 'queued' || operation.status === 'submitted') result.push({ domain, consent, operation });
  }
  return result;
}
export async function pendingMembershipDebit(db: Firestore, request: { readonly domain: MembershipAuthorizationDomain; readonly debit: ExactMembershipDebit }): Promise<SponsoredOperationStatus | null> {
  const id = membershipDebitOperationId(request), row = await db.collection(MEMBERSHIP_DEBIT_OPERATIONS).doc(id).get();
  if (!row.exists || row.get('status') === 'failed') return null;
  return readSponsoredOperation(db, MEMBERSHIP_DEBIT_OPERATIONS, id);
}

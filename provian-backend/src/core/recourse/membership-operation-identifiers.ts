import { AbiCoder, sha256 } from 'ethers';
import { addressMembershipDigest, exactMembershipDebitDigest, type AddressMembershipConsent,
  type ExactMembershipDebit, type MembershipAuthorizationDomain } from './membership-authorization';

export const MEMBERSHIP_CONSENT_OPERATIONS = 'recourse_membership_consent_operations_v1';
export const MEMBERSHIP_DEBIT_OPERATIONS = 'recourse_membership_debit_operations_v1';
export function membershipConsentOperationId(request: { readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent }): string {
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'],
    ['Provian sponsored address consent', addressMembershipDigest(request.domain, request.consent)]));
}
export function membershipDebitOperationId(request: { readonly domain: MembershipAuthorizationDomain; readonly debit: ExactMembershipDebit }): string {
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'], ['Provian sponsored membership debit', exactMembershipDebitDigest(request.domain, request.debit)]));
}

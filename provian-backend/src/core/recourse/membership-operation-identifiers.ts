import { AbiCoder, sha256 } from 'ethers';
import { standingMembershipDigest, standingMembershipDebitDigest, type StandingMembershipAuthorization, type AddressMembershipConsent,
  type ExactMembershipDebit, type MembershipAuthorizationDomain } from './membership-authorization';

export const MEMBERSHIP_CONSENT_OPERATIONS = 'recourse_membership_consent_operations_v2';
export const MEMBERSHIP_DEBIT_OPERATIONS = 'recourse_membership_debit_operations_v2';
export function membershipConsentOperationId(request: { readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent;
  readonly standing: StandingMembershipAuthorization | null; readonly exitSecret: string | null }): string {
  const digest=request.standing ? standingMembershipDigest(request.domain,request.standing)
    : sha256(AbiCoder.defaultAbiCoder().encode(['string','uint256','address','address','bytes32','uint256','uint256','bytes32'],
      ['Provian leave membership',request.domain.chainId,request.domain.pointer,request.domain.pool,request.consent.binding,
        request.consent.nonce,request.consent.revision,request.exitSecret]));
  return sha256(AbiCoder.defaultAbiCoder().encode(['string','bytes32'],['Provian sponsored standing consent',digest]));
}
export function membershipDebitOperationId(request: { readonly domain: MembershipAuthorizationDomain; readonly debit: ExactMembershipDebit }): string {
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'], ['Provian sponsored membership debit', standingMembershipDebitDigest(request.domain, request.debit)]));
}

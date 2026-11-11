import { AbiCoder, getBytes, hashMessage, sha256 } from 'ethers';
import { recourseBindingMessage, type RecourseBinding } from './binding';
import { parseAddressMembershipConsent, parseMembershipAuthorizationDomain,
  type AddressMembershipConsent, type MembershipAuthorizationDomain } from './membership-authorization';

export interface MemberBindingConsent { readonly consent: AddressMembershipConsent; readonly ownerSignature: string }
export interface MemberBindingChallenge { readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent }
export function parseMemberBindingChallenge(value: unknown, binding: RecourseBinding, expected: {
  readonly domain: MembershipAuthorizationDomain; readonly revision: string; readonly nonce: string;
  readonly ruleHash: string; readonly timestamp: number;
}): MemberBindingChallenge {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'consent,domain') throw Error('recourse_member_binding_invalid');
  const r = value as Record<string, unknown>, domain = parseMembershipAuthorizationDomain(r.domain), consent = parseAddressMembershipConsent(r.consent);
  if (domain.chainId !== expected.domain.chainId || domain.pointer !== expected.domain.pointer || domain.kernel !== expected.domain.kernel
    || domain.pool !== expected.domain.pool || consent.binding !== binding.identity || consent.account !== binding.address || !consent.joined
    || consent.revision !== expected.revision || consent.nonce !== expected.nonce || consent.ruleHash !== expected.ruleHash
    || BigInt(consent.expiresAt) < BigInt(expected.timestamp) || BigInt(consent.expiresAt) > BigInt(expected.timestamp) + 300n
    || BigInt(consent.expiresAt) * 1000n > BigInt(binding.expiresAtMs)) throw Error('recourse_member_binding_invalid');
  return { domain, consent };
}
export const MEMBER_BINDING_TUPLE = 'tuple(bytes32 identity,address account,bytes32 recoveryCommitment,bytes32 signingRoot,address kernel,bytes32 nonce,uint256 expiresAtMs)';
export const MEMBER_CONSENT_TUPLE = 'tuple(bytes32 binding,address account,uint256 nonce,bool joined,uint256 revision,bytes32 ruleHash,uint256 expiresAt)';
export function memberBindingSigningHash(domainInput: MembershipAuthorizationDomain, registry: string,
  binding: RecourseBinding, consentInput: AddressMembershipConsent): string {
  recourseBindingMessage(binding);
  const domain = parseMembershipAuthorizationDomain(domainInput), consent = parseAddressMembershipConsent(consentInput);
  if (!/^0x[0-9a-f]{40}$/.test(registry) || /^0x0+$/.test(registry) || binding.kernel !== domain.kernel
    || binding.identity !== consent.binding || binding.address !== consent.account || !consent.joined) throw Error('recourse_member_binding_invalid');
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'address', 'address', MEMBER_BINDING_TUPLE, MEMBER_CONSENT_TUPLE],
    ['Provian atomic member address binding', domain.chainId, registry, domain.pointer,
      [binding.identity, binding.address, binding.recoveryCommitment, binding.signingRoot, binding.kernel, binding.nonce, binding.expiresAtMs], consent]));
}
export function memberBindingDigest(domain: MembershipAuthorizationDomain, registry: string,
  binding: RecourseBinding, consent: AddressMembershipConsent): string {
  return hashMessage(getBytes(memberBindingSigningHash(domain, registry, binding, consent)));
}

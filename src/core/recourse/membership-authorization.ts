import { AbiCoder, getBytes, hashMessage, Interface, sha256 } from 'ethers';

export interface MembershipAuthorizationDomain {
  readonly chainId: string; readonly pointer: string; readonly kernel: string; readonly pool: string;
}
export interface AddressMembershipConsent {
  readonly binding: string; readonly account: string; readonly nonce: string; readonly joined: boolean;
  readonly revision: string; readonly ruleHash: string; readonly expiresAt: string;
}
export interface ExactMembershipDebit {
  readonly binding: string; readonly payer: string; readonly month: string; readonly burn: string; readonly reserve: string;
  readonly nonce: string; readonly generation: string; readonly revision: string; readonly ruleHash: string; readonly expiresAt: string;
}
const CONSENT = 'tuple(bytes32 binding,address account,uint256 nonce,bool joined,uint256 revision,bytes32 ruleHash,uint256 expiresAt)';
const DEBIT = 'tuple(bytes32 binding,address payer,uint256 month,uint256 burn,uint256 reserve,uint256 nonce,uint256 generation,uint256 revision,bytes32 ruleHash,uint256 expiresAt)';
export const MEMBERSHIP_AUTHORIZATION_ABI = new Interface([
  `function consentDigest(${CONSENT}) view returns(bytes32)`, `function debitDigest(${DEBIT}) view returns(bytes32)`,
  `function setAddressConsent(${CONSENT},bytes,bytes)`, `function executeMembershipDebit(${DEBIT},bytes,bytes)`,
  'function addressConsent(bytes32) view returns(uint256 nonce,uint256 generation,bool joined)',
  'function consentPeriods(bytes32,uint256) view returns(uint256 startBlock,uint256 endBlock)',
  'function debitNonce(bytes32) view returns(uint256)',
  'function leaveAddressConsent(bytes32)', 'function cancelMembershipDebit(bytes32,uint256)',
  'event AddressConsentChanged(bytes32 indexed binding,uint256 indexed generation,bool joined,uint256 nonce)',
  'event MembershipDebitExecuted(bytes32 indexed digest,bytes32 indexed binding,address indexed payer,uint256 month,uint256 burn,uint256 reserve,uint256 nonce)',
  'event MembershipDebitCancelled(bytes32 indexed binding,uint256 indexed nonce)',
]);
const invalid = (): never => { throw Error('recourse_membership_authorization_invalid'); };
function uint(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78
    || BigInt(value) >= 2n ** 256n || (positive && value === '0')) return invalid();
  return value;
}
function hex(value: unknown, length: number): string {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-f]{${length}}$`).test(value) || /^0x0+$/.test(value)) return invalid();
  return value;
}
function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys) return invalid();
  return value as Record<string, unknown>;
}
export function parseMembershipAuthorizationDomain(value: unknown): MembershipAuthorizationDomain {
  const r = record(value, 'chainId,kernel,pointer,pool');
  return { chainId: uint(r.chainId, true), pointer: hex(r.pointer, 40), kernel: hex(r.kernel, 40), pool: hex(r.pool, 40) };
}
export function parseAddressMembershipConsent(value: unknown): AddressMembershipConsent {
  const r = record(value, 'account,binding,expiresAt,joined,nonce,revision,ruleHash');
  if (typeof r.joined !== 'boolean') return invalid();
  return { binding: hex(r.binding, 64), account: hex(r.account, 40), nonce: uint(r.nonce), joined: r.joined,
    revision: uint(r.revision, true), ruleHash: hex(r.ruleHash, 64), expiresAt: uint(r.expiresAt, true) };
}
export function parseExactMembershipDebit(value: unknown): ExactMembershipDebit {
  const r = record(value, 'binding,burn,expiresAt,generation,month,nonce,payer,reserve,revision,ruleHash');
  const result = { binding: hex(r.binding, 64), payer: hex(r.payer, 40), month: uint(r.month),
    burn: uint(r.burn), reserve: uint(r.reserve), nonce: uint(r.nonce), generation: uint(r.generation, true),
    revision: uint(r.revision, true), ruleHash: hex(r.ruleHash, 64), expiresAt: uint(r.expiresAt, true) };
  if (result.burn === '0' && result.reserve === '0') return invalid();
  return result;
}
/** Sign these 32 bytes with EIP-191, or the hash account's independent signature
 * domain. Never sign a JSON rendering or an owner-level invoice identifier. */
export function addressMembershipSigningHash(domain: MembershipAuthorizationDomain, input: AddressMembershipConsent): string {
  const d = parseMembershipAuthorizationDomain(domain), consent = parseAddressMembershipConsent(input);
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'address', 'address', 'address', CONSENT],
    ['Provian address membership consent', d.chainId, d.pointer, d.kernel, d.pool, consent]));
}
export function exactMembershipDebitSigningHash(domain: MembershipAuthorizationDomain, input: ExactMembershipDebit): string {
  const d = parseMembershipAuthorizationDomain(domain), debit = parseExactMembershipDebit(input);
  return sha256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'address', 'address', 'address', DEBIT],
    ['Provian exact membership debit', d.chainId, d.pointer, d.kernel, d.pool, debit]));
}
export function addressMembershipDigest(domain: MembershipAuthorizationDomain, consent: AddressMembershipConsent): string {
  return hashMessage(getBytes(addressMembershipSigningHash(domain, consent)));
}
export function exactMembershipDebitDigest(domain: MembershipAuthorizationDomain, debit: ExactMembershipDebit): string {
  return hashMessage(getBytes(exactMembershipDebitSigningHash(domain, debit)));
}

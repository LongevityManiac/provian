import { AbiCoder, computeHmac, getBytes, hashMessage, Interface, sha256 } from 'ethers';

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
  'function cancelMembershipDebit(bytes32,uint256)',
  'event AddressConsentChanged(bytes32 indexed binding,uint256 indexed generation,bool joined,uint256 nonce)',
  'event AddressConsentRenewed(bytes32 indexed binding,uint256 nonce)',
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

export interface RejoinPayment { readonly month: string; readonly burn: string; readonly reserve: string; readonly ruleHash: string }
export interface StandingMembershipAuthorization {
  readonly admissionMonth: string;
  readonly rejoinPayments: readonly RejoinPayment[];
  readonly consent: AddressMembershipConsent;
  readonly fixedChargePayer: boolean;
  readonly burnLimit: string; readonly reserveLimit: string; readonly earningsBpsLimit: number;
  readonly exitCommitment: string; readonly exitSalt: string;
}
export interface StandingMembershipMandate {
  readonly burnLimit: string; readonly reserveLimit: string; readonly earningsBpsLimit: number;
  readonly startMonth: string; readonly closedMonth: string; readonly consentNonce: string; readonly exitCommitment: string; readonly exitSalt: string; readonly active: boolean;
}
export const STANDING_CONSENT_TUPLE = `tuple(${CONSENT} consent,bool fixedChargePayer,uint256 burnLimit,uint256 reserveLimit,uint16 earningsBpsLimit,bytes32 exitCommitment,bytes32 exitSalt,uint256 admissionMonth,tuple(uint256 month,uint256 burn,uint256 reserve,bytes32 ruleHash)[] rejoinPayments)`;
export const STANDING_MEMBERSHIP_ABI = new Interface([
  `function standingConsentDigest(${STANDING_CONSENT_TUPLE}) view returns(bytes32)`,
  `function setStandingConsent(${STANDING_CONSENT_TUPLE},bytes,bytes)`,
  `function debitDigest(${DEBIT}) view returns(bytes32)`,
  `function executeStandingDebit(${DEBIT},bytes)`,
  'function leaveStandingMembership(bytes32 binding,uint256 consentNonce,bytes32 exitSecret,uint256 revision)',
  `function authenticatedDepartureDigest(${CONSENT}) view returns(bytes32)`,
  `function leaveSuspendedMembership(${CONSENT},bytes)`,
  'function pool() view returns(address)',
  'function standingMandate(bytes32) view returns(uint256 burnLimit,uint256 reserveLimit,uint16 earningsBpsLimit,uint256 startMonth,uint256 closedMonth,uint256 consentNonce,bytes32 exitCommitment,bytes32 exitSalt,bool active)',
  'function monthlyCollection(bytes32,uint256) view returns(uint256 burn,uint256 reserve)',
  'function permitsEarnings(bytes32,uint16) view returns(bool)',
  'event StandingConsentApproved(bytes32 indexed binding,uint256 indexed consentNonce,uint256 burnLimit,uint256 reserveLimit,uint16 earningsBpsLimit,uint256 startMonth,bytes32 exitCommitment,bytes32 exitSalt)',
  'event MonthlyCollectionRecorded(bytes32 indexed binding,uint256 indexed month,uint256 burn,uint256 reserve)',
]);
export function parseStandingMembershipAuthorization(value: unknown): StandingMembershipAuthorization {
  const r = record(value, 'admissionMonth,burnLimit,consent,earningsBpsLimit,exitCommitment,exitSalt,fixedChargePayer,rejoinPayments,reserveLimit');
  const consent = parseAddressMembershipConsent(r.consent);
  if (!consent.joined || typeof r.fixedChargePayer !== 'boolean' || typeof r.earningsBpsLimit !== 'number'
    || !Number.isSafeInteger(r.earningsBpsLimit) || r.earningsBpsLimit < 0 || r.earningsBpsLimit > 10000) return invalid();
  return { consent, admissionMonth: uint(r.admissionMonth), rejoinPayments: parseRejoinPayments(r.rejoinPayments), fixedChargePayer: r.fixedChargePayer, burnLimit: uint(r.burnLimit), reserveLimit: uint(r.reserveLimit),
    earningsBpsLimit: r.earningsBpsLimit, exitCommitment: hex(r.exitCommitment,64), exitSalt: hex(r.exitSalt,64) };
}
export function standingMembershipSigningHash(domain: MembershipAuthorizationDomain, input: StandingMembershipAuthorization): string {
  const d = parseMembershipAuthorizationDomain(domain), authorization = parseStandingMembershipAuthorization(input);
  return sha256(AbiCoder.defaultAbiCoder().encode(['string','uint256','address','address','address',STANDING_CONSENT_TUPLE],
    ['Provian standing membership consent',d.chainId,d.pointer,d.kernel,d.pool,authorization]));
}
export function standingMembershipDebitSigningHash(domain: MembershipAuthorizationDomain, input: ExactMembershipDebit): string {
  const d = parseMembershipAuthorizationDomain(domain), debit = parseExactMembershipDebit(input);
  return sha256(AbiCoder.defaultAbiCoder().encode(['string','uint256','address','address','address',DEBIT],
    ['Provian standing membership debit',d.chainId,d.pointer,d.kernel,d.pool,debit]));
}
export function authenticatedDepartureSigningHash(domain: MembershipAuthorizationDomain, input: AddressMembershipConsent): string {
  const d = parseMembershipAuthorizationDomain(domain), consent = parseAddressMembershipConsent(input);
  if (consent.joined) return invalid();
  return sha256(AbiCoder.defaultAbiCoder().encode(['string','uint256','address','address','address','bytes32','address','uint256','bool'],
    ['Provian authenticated membership departure',d.chainId,d.pointer,d.kernel,d.pool,consent.binding,consent.account,consent.nonce,false]));
}
export function standingMembershipDigest(domain: MembershipAuthorizationDomain, authorization: StandingMembershipAuthorization): string {
  return hashMessage(getBytes(standingMembershipSigningHash(domain,authorization)));
}
export function standingMembershipDebitDigest(domain: MembershipAuthorizationDomain, debit: ExactMembershipDebit): string {
  return hashMessage(getBytes(standingMembershipDebitSigningHash(domain,debit)));
}
/** Each admission commits a different one-way exit proof. It never contains an
 * owner/group ID and is not a spending or recovery key. Keep the preimage on the
 * member's device until leaving; a relay that learns it can only revoke consent. */
export function membershipExitCommitment(secret: string): string { return sha256(getBytes(hex(secret,64))); }

/** Restoreable per-address exit proof. The random public salt is committed at
 * admission and carried through succession; no common owner identifier appears
 * on chain. Call only inside the caller's protected seed/key session. */
export function deriveMembershipExitSecret(secretMaterial: Uint8Array, domain: Pick<MembershipAuthorizationDomain,'chainId'|'pointer'>,
  binding: string, salt: string): string {
  if (secretMaterial.length < 32) return invalid();
  const bytes = AbiCoder.defaultAbiCoder().encode(['string','uint256','address','bytes32','bytes32'],
    ['Provian membership exit',uint(domain.chainId,true),hex(domain.pointer,40),hex(binding,64),hex(salt,64)]);
  return computeHmac('sha256',secretMaterial,getBytes(bytes));
}

export function parseRejoinPayments(value: unknown): readonly RejoinPayment[] {
  if (!Array.isArray(value)) return invalid();
  const rows = value.map(v => {
    const r = record(v, 'burn,month,reserve,ruleHash');
    const payment = { month: uint(r.month), ruleHash: hex(r.ruleHash, 64), burn: uint(r.burn), reserve: uint(r.reserve) };
    if (payment.burn === '0' && payment.reserve === '0') return invalid();
    return payment;
  });
  if (rows.some((p, i) => i > 0 && BigInt(rows[i - 1].month) >= BigInt(p.month))) return invalid();
  return rows;
}

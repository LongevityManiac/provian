import { Interface, getBytes } from 'ethers';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import type { ProtocolDeployment } from './protocol-pointer';
import { readRecoursePoolChain } from './recourse-pool-chain';
import { RECOURSE_POOL_ABI } from './recourse-pool-abi';
import { addressMembershipSigningHash, exactMembershipDebitSigningHash, parseAddressMembershipConsent,
  parseExactMembershipDebit, parseMembershipAuthorizationDomain, type AddressMembershipConsent,
  type ExactMembershipDebit, type MembershipAuthorizationDomain } from './recourse-membership-authorization';

export type MembershipRequestPath = 'membership-transitions' | `membership-transitions/${string}` | 'membership-consents'
  | `membership-consents/${string}` | 'membership-debit-challenges' | 'membership-debits' | `membership-debits/${string}`;
export interface MembershipRelay { request(path: MembershipRequestPath, body?: unknown): Promise<unknown> }
export interface MembershipConsentChallenge {
  readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent; readonly messageHex: string;
}
export interface MembershipDebitChallenge {
  readonly reservationId: string; readonly domain: MembershipAuthorizationDomain; readonly debit: ExactMembershipDebit;
  readonly messageHex: string; readonly allowanceAtomic: string;
}
export interface MembershipTransitionView {
  readonly id: string; readonly kind: 'join' | 'leave'; readonly status: 'preparing' | 'consenting' | 'complete' | 'superseded';
  readonly challenges: readonly MembershipConsentChallenge[];
}
export interface MembershipOperationStatus {
  readonly id: string; readonly status: 'queued' | 'submitted' | 'confirmed' | 'failed'; readonly transactionHash: string | null;
}
export type MembershipDebitPreparation = { readonly status: 'ready'; readonly challenge: MembershipDebitChallenge }
  | { readonly status: 'pending' | 'settled' };
const fail = (): never => { throw Error('recourse_membership_reply_invalid'); };
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys) return fail();
  return value as Record<string, unknown>;
}
function hash(value: unknown): string { return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) ? value : fail(); }
function atomic(value: unknown): string { return typeof value === 'string' && value.length <= 78 && /^(0|[1-9][0-9]*)$/.test(value)
  && BigInt(value) < (1n << 256n) ? value : fail(); }
export function parseMembershipConsentChallenge(value: unknown): MembershipConsentChallenge {
  const row = object(value, 'consent,domain,messageHex'), domain = parseMembershipAuthorizationDomain(row.domain), consent = parseAddressMembershipConsent(row.consent);
  const messageHex = hash(row.messageHex);
  if (messageHex !== addressMembershipSigningHash(domain, consent)) return fail();
  return { domain, consent, messageHex };
}
export function parseMembershipDebitChallenge(value: unknown): MembershipDebitChallenge {
  const row = object(value, 'allowanceAtomic,debit,domain,messageHex,reservationId');
  const domain = parseMembershipAuthorizationDomain(row.domain), debit = parseExactMembershipDebit(row.debit);
  const messageHex = hash(row.messageHex), allowanceAtomic = atomic(row.allowanceAtomic), reservationId = hash(row.reservationId);
  if (messageHex !== exactMembershipDebitSigningHash(domain, debit) || BigInt(allowanceAtomic) !== BigInt(debit.burn) + BigInt(debit.reserve)) return fail();
  return { domain, debit, messageHex, allowanceAtomic, reservationId };
}
export function parseMembershipTransitionView(value: unknown): MembershipTransitionView {
  const row = object(value, 'challenges,id,kind,status');
  if ((row.kind !== 'join' && row.kind !== 'leave') || !['preparing', 'consenting', 'complete', 'superseded'].includes(String(row.status))
    || !Array.isArray(row.challenges)) return fail();
  const challenges = row.challenges.map(parseMembershipConsentChallenge);
  if ((row.status !== 'consenting' && challenges.length !== 0) || new Set(challenges.map(c => c.consent.binding)).size !== challenges.length
    || (row.kind === 'leave' && challenges.some(c => c.consent.joined))) return fail();
  return { id: hash(row.id), kind: row.kind, status: row.status as MembershipTransitionView['status'], challenges };
}
export function parseMembershipOperationStatus(value: unknown): MembershipOperationStatus {
  const row = object(value, 'id,status,transactionHash');
  if (!['queued', 'submitted', 'confirmed', 'failed'].includes(String(row.status))) return fail();
  return { id: hash(row.id), status: row.status as MembershipOperationStatus['status'], transactionHash: row.transactionHash === null ? null : hash(row.transactionHash) };
}
export function parseMembershipDebitPreparation(value: unknown): MembershipDebitPreparation {
  if (!value || typeof value !== 'object' || !('status' in value)) return fail();
  if (value.status === 'ready') return { status: 'ready', challenge: parseMembershipDebitChallenge(object(value, 'challenge,status').challenge) };
  if (value.status !== 'pending' && value.status !== 'settled') return fail();
  object(value, 'status'); return { status: value.status };
}
function requireDomain(domain: MembershipAuthorizationDomain, revision: string, deployment: ProtocolDeployment): void {
  if (domain.chainId !== '8453' || domain.pointer !== deployment.pointer.toLowerCase() || domain.kernel !== deployment.addresses.kernel.toLowerCase()
    || domain.pool !== deployment.addresses.recoursePool.toLowerCase() || revision !== String(deployment.revision)) throw Error('recourse_membership_retired');
}
async function poolAt(binding: string, network: OwnerChainNetwork, deployment: ProtocolDeployment) {
  let initial = true;
  return readRecoursePoolChain(binding, { rpcs: network.rpcs, deployment: async () => {
    if (initial) { initial = false; return deployment; }
    return network.deployment();
  } });
}
/** Relay JSON never directly reaches a signer. Verify the current independent
 * chain domain, account and exact nonce/rule, and recompute the raw-byte hash. */
export async function validateMembershipConsent(value: unknown, account: string, kind: 'join' | 'leave', network: OwnerChainNetwork): Promise<MembershipConsentChallenge> {
  const challenge = parseMembershipConsentChallenge(value), c = challenge.consent, deployment = await network.deployment();
  requireDomain(challenge.domain, c.revision, deployment);
  if (c.account !== account.toLowerCase() || (kind === 'leave' && c.joined)) throw Error('recourse_membership_scope');
  const state = await poolAt(c.binding, network, deployment);
  if (state.currentAddress !== c.account || state.consentNonce !== c.nonce || state.addressConsent === c.joined || state.signedRuleHash !== c.ruleHash
    || BigInt(c.expiresAt) < BigInt(state.timestamp) || BigInt(c.expiresAt) > BigInt(state.timestamp + 300)) throw Error('recourse_membership_stale');
  return challenge;
}
export async function validateMembershipDebit(value: unknown, payer: string, network: OwnerChainNetwork): Promise<MembershipDebitChallenge> {
  const challenge = parseMembershipDebitChallenge(value), d = challenge.debit, deployment = await network.deployment();
  requireDomain(challenge.domain, d.revision, deployment);
  if (d.payer !== payer.toLowerCase()) throw Error('recourse_membership_scope');
  const state = await poolAt(d.binding, network, deployment);
  if (state.currentAddress !== d.payer || !state.addressConsent || state.debitNonce !== d.nonce || state.consentGeneration !== d.generation
    || BigInt(d.month) > BigInt(state.month) || BigInt(state.month) - BigInt(d.month) > 1n
    || BigInt(d.expiresAt) < BigInt(state.timestamp) || BigInt(d.expiresAt) > BigInt(state.timestamp + 300)) throw Error('recourse_membership_stale');
  const values = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to: challenge.domain.pool,
    data: RECOURSE_POOL_ABI.encodeFunctionData('monthlyRule', [d.month]) }, { blockHash: deployment.blockHash, requireCanonical: true }])));
  if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_membership_rule_disagreement');
  const rule = RECOURSE_POOL_ABI.decodeFunctionResult('monthlyRule', values[0])[0];
  if (rule[4] !== d.ruleHash || BigInt(d.burn) > BigInt(rule[1])) throw Error('recourse_membership_rule_invalid');
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw Error('recourse_membership_retired');
  return challenge;
}
export async function beginMembershipTransition(relay: MembershipRelay, kind: 'join' | 'leave'): Promise<MembershipTransitionView> {
  const view = parseMembershipTransitionView(await relay.request('membership-transitions', { kind }));
  if (view.kind !== kind) return fail(); return view;
}
export async function readMembershipTransition(relay: MembershipRelay, id?: string): Promise<MembershipTransitionView | null> {
  const raw = await relay.request(id ? `membership-transitions/${hash(id)}` : 'membership-transitions');
  if (raw === null && !id) return null;
  const view = parseMembershipTransitionView(raw);
  if (id && view.id !== id) return fail(); return view;
}
/** The callback owns its key and sees exact raw bytes. Signing a hex string as
 * text is a different authorization and is deliberately never requested. */
export async function submitMembershipConsent(relay: MembershipRelay, network: OwnerChainNetwork,
  input: { readonly transitionId: string; readonly kind: 'join' | 'leave'; readonly account: string; readonly challenge: MembershipConsentChallenge;
    signBytes(bytes: Uint8Array): Promise<string> }): Promise<MembershipOperationStatus> {
  const transitionId = hash(input.transitionId), challenge = await validateMembershipConsent(input.challenge, input.account, input.kind, network);
  const ownerSignature = await input.signBytes(getBytes(challenge.messageHex));
  await validateMembershipConsent(challenge, input.account, input.kind, network);
  return parseMembershipOperationStatus(await relay.request('membership-consents', { transitionId, domain: challenge.domain, consent: challenge.consent, ownerSignature }));
}
export async function prepareMembershipDebit(relay: MembershipRelay, payer: string,
  amounts?: { readonly month: string; readonly burn: string; readonly reserve: string }): Promise<MembershipDebitPreparation> {
  return parseMembershipDebitPreparation(await relay.request('membership-debit-challenges', { payer: payer.toLowerCase(), ...(amounts ? { amounts } : {}) }));
}
const TOKEN = new Interface(['function approveCurrent(address,uint256,uint256) returns(bool)']);
export async function prepareMembershipApproval(challenge: MembershipDebitChallenge, payer: string, network: OwnerChainNetwork):
  Promise<{ readonly to: string; readonly data: string; readonly value: '0'; readonly chainId: 8453 }> {
  const parsed = await validateMembershipDebit(challenge, payer, network);
  return { to: parsed.domain.kernel, data: TOKEN.encodeFunctionData('approveCurrent', [parsed.domain.pool, parsed.allowanceAtomic, parsed.debit.revision]), value: '0', chainId: 8453 };
}
/** Caller displays and approves this exact challenge before invoking signing;
 * its token allowance is separate and never substitutes for this mandate. */
export async function submitMembershipDebit(relay: MembershipRelay, network: OwnerChainNetwork,
  input: { readonly payer: string; readonly challenge: MembershipDebitChallenge; signBytes(bytes: Uint8Array): Promise<string> }): Promise<MembershipOperationStatus> {
  const challenge = await validateMembershipDebit(input.challenge, input.payer, network);
  const ownerSignature = await input.signBytes(getBytes(challenge.messageHex));
  await validateMembershipDebit(challenge, input.payer, network);
  return parseMembershipOperationStatus(await relay.request('membership-debits', { reservationId: challenge.reservationId,
    domain: challenge.domain, debit: challenge.debit, ownerSignature }));
}

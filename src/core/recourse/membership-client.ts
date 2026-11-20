import { AbiCoder, getBytes, randomBytes, hexlify, sha256 } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import type { ProtocolDeployment } from '../protocol/pointer';
import { readRecoursePoolChain } from './pool-chain';
import { readStandingMembershipState } from './standing-state';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { addressMembershipSigningHash, standingMembershipDebitSigningHash, parseAddressMembershipConsent,
  parseRejoinPayments, type RejoinPayment, standingMembershipDigest, standingMembershipSigningHash, authenticatedDepartureSigningHash, membershipExitCommitment, type StandingMembershipAuthorization,
  parseExactMembershipDebit, parseMembershipAuthorizationDomain, type AddressMembershipConsent,
  type ExactMembershipDebit, type MembershipAuthorizationDomain } from './membership-authorization';

export type MembershipRequestPath = 'membership-transitions' | `membership-transitions/${string}` | 'membership-consents'
  | `membership-departures/${string}`
  | `membership-consents/${string}` | 'membership-debit-challenges' | 'membership-debits' | `membership-debits/${string}`;
export interface MembershipRelay { request(path: MembershipRequestPath, body?: unknown): Promise<unknown> }
export interface MembershipConsentChallenge {
  readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent; readonly messageHex: string;
  readonly admissionMonth: string;
  readonly rejoinPayments: readonly RejoinPayment[];
  readonly fixedChargePayer: boolean; readonly burnLimit: string; readonly reserveLimit: string; readonly earningsBpsLimit: number;
}
export interface MembershipDebitChallenge {
  readonly reservationId: string; readonly domain: MembershipAuthorizationDomain; readonly debit: ExactMembershipDebit;
  readonly messageHex: string; readonly allowanceAtomic: string;
}
export interface MembershipTransitionView {
  readonly id: string; readonly kind: 'join' | 'leave' | 'renew'; readonly status: 'preparing' | 'consenting' | 'complete' | 'superseded';
  readonly challenges: readonly MembershipConsentChallenge[];
  readonly pending: readonly { readonly binding: string; readonly account: string; readonly operation: MembershipOperationStatus }[];
}
export interface MembershipOperationStatus {
  readonly id: string; readonly status: 'queued' | 'submitted' | 'confirmed' | 'failed'; readonly transactionHash: string | null;
}
export interface JoinSubmission {
  readonly transitionId: string;
  readonly binding: string;
  readonly operationId: string;
  readonly expiresAt: string;
}
export type MembershipDebitPreparation = { readonly status: 'ready'; readonly challenge: MembershipDebitChallenge }
  | { readonly status: 'settled' | 'approval_required' } | { readonly status: 'pending'; readonly operation: MembershipOperationStatus | null };
const fail = (): never => { throw Error('recourse_membership_reply_invalid'); };
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys) return fail();
  return value as Record<string, unknown>;
}
function hash(value: unknown): string { return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) ? value : fail(); }
function atomic(value: unknown): string { return typeof value === 'string' && value.length <= 78 && /^(0|[1-9][0-9]*)$/.test(value)
  && BigInt(value) < (1n << 256n) ? value : fail(); }
export function parseMembershipConsentChallenge(value: unknown): MembershipConsentChallenge {
  const row = object(value, 'admissionMonth,burnLimit,consent,domain,earningsBpsLimit,fixedChargePayer,messageHex,rejoinPayments,reserveLimit'), domain = parseMembershipAuthorizationDomain(row.domain), consent = parseAddressMembershipConsent(row.consent);
  const messageHex = hash(row.messageHex);
  if (messageHex !== addressMembershipSigningHash(domain, consent)) return fail();
  if(typeof row.fixedChargePayer!=='boolean'||typeof row.earningsBpsLimit!=='number'||!Number.isSafeInteger(row.earningsBpsLimit)
    ||row.earningsBpsLimit<0||row.earningsBpsLimit>10000)return fail();
  return { domain, consent, messageHex, admissionMonth: atomic(row.admissionMonth), rejoinPayments: parseRejoinPayments(row.rejoinPayments), fixedChargePayer:row.fixedChargePayer, burnLimit:atomic(row.burnLimit),
    reserveLimit:atomic(row.reserveLimit), earningsBpsLimit:row.earningsBpsLimit };
}
export function parseMembershipDebitChallenge(value: unknown): MembershipDebitChallenge {
  const row = object(value, 'allowanceAtomic,debit,domain,messageHex,reservationId');
  const domain = parseMembershipAuthorizationDomain(row.domain), debit = parseExactMembershipDebit(row.debit);
  const messageHex = hash(row.messageHex), allowanceAtomic = atomic(row.allowanceAtomic), reservationId = hash(row.reservationId);
  if (messageHex !== standingMembershipDebitSigningHash(domain, debit) || BigInt(allowanceAtomic) !== BigInt(debit.burn) + BigInt(debit.reserve)) return fail();
  return { domain, debit, messageHex, allowanceAtomic, reservationId };
}
export function parseMembershipTransitionView(value: unknown): MembershipTransitionView {
  const row = object(value, 'challenges,id,kind,pending,status');
  if ((row.kind !== 'join' && row.kind !== 'leave' && row.kind !== 'renew') || !['preparing', 'consenting', 'complete', 'superseded'].includes(String(row.status))
    || !Array.isArray(row.challenges) || !Array.isArray(row.pending)) return fail();
  const challenges = row.challenges.map(parseMembershipConsentChallenge);
  const pending = row.pending.map(value => {
    const item = object(value, 'account,binding,operation'), operation = parseMembershipOperationStatus(item.operation);
    if (typeof item.account !== 'string' || !/^0x[0-9a-f]{40}$/.test(item.account)
      || !['queued','submitted'].includes(operation.status)) return fail();
    return { binding: hash(item.binding), account: item.account, operation };
  });
  if ((row.status !== 'consenting' && !(row.kind === 'leave' && row.status === 'preparing') && pending.length) || new Set(pending.map(p => p.operation.id)).size !== pending.length
    || pending.some(p => challenges.some(c => c.consent.binding === p.binding))) return fail();
  if ((row.status !== 'consenting' && !(row.kind === 'leave' && row.status === 'preparing') && challenges.length !== 0) || new Set(challenges.map(c => c.consent.binding)).size !== challenges.length
    || (row.kind === 'leave' && challenges.some(c => c.consent.joined))) return fail();
  return { id: hash(row.id), kind: row.kind, status: row.status as MembershipTransitionView['status'], challenges, pending };
}
export function parseMembershipOperationStatus(value: unknown): MembershipOperationStatus {
  const row = object(value, 'id,status,transactionHash');
  if (!['queued', 'submitted', 'confirmed', 'failed'].includes(String(row.status))) return fail();
  return { id: hash(row.id), status: row.status as MembershipOperationStatus['status'], transactionHash: row.transactionHash === null ? null : hash(row.transactionHash) };
}
export function parseMembershipDebitPreparation(value: unknown): MembershipDebitPreparation {
  if (!value || typeof value !== 'object' || !('status' in value)) return fail();
  if (value.status === 'ready') return { status: 'ready', challenge: parseMembershipDebitChallenge(object(value, 'challenge,status').challenge) };
  if (value.status === 'settled' || value.status === 'approval_required') { object(value, 'status'); return { status: value.status }; }
  if (value.status !== 'pending') return fail();
  const row = object(value, 'operation,status');
  return { status: 'pending', operation: row.operation === null ? null : parseMembershipOperationStatus(row.operation) };
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
export async function validateMembershipConsent(value: unknown, account: string, kind: 'join' | 'leave' | 'renew', network: OwnerChainNetwork): Promise<MembershipConsentChallenge> {
  const challenge = parseMembershipConsentChallenge(value), c = challenge.consent, deployment = await network.deployment();
  requireDomain(challenge.domain, c.revision, deployment);
  if (c.account !== account.toLowerCase() || (kind === 'leave' && c.joined)) throw Error('recourse_membership_scope');
  const state = await poolAt(c.binding, network, deployment);
  if (state.currentAddress !== c.account || state.consentNonce !== c.nonce || (kind === 'renew' ? !state.addressConsent || !c.joined : state.addressConsent === c.joined)
    || (c.joined && (state.signedRuleHash !== c.ruleHash || BigInt(c.expiresAt) < BigInt(state.timestamp)
      || BigInt(c.expiresAt) > BigInt(state.timestamp + 300)))) throw Error('recourse_membership_stale');
  // Departure authenticates the current domain, account, nonce and exit proof.
  // Admission limits and rule expiry never authorize or withhold a departure.
  if(c.joined && (challenge.admissionMonth !== state.month || challenge.burnLimit!==(challenge.fixedChargePayer?state.participationBurnAtomic:'0')
    ||challenge.reserveLimit!==(challenge.fixedChargePayer?state.noEarningsContributionAtomic:'0')
    ||challenge.earningsBpsLimit!==state.earningsBps))throw Error('recourse_membership_amount_changed');
  if (challenge.rejoinPayments.length) {
    if (kind !== 'join' || !c.joined || !challenge.fixedChargePayer) throw Error('recourse_membership_scope');
    for (const payment of challenge.rejoinPayments) {
      if (BigInt(payment.month) >= BigInt(state.month)) throw Error('recourse_membership_rule_invalid');
      const values = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to: challenge.domain.pool,
        data: RECOURSE_POOL_ABI.encodeFunctionData('monthlyRule', [payment.month]) }, { blockHash: deployment.blockHash, requireCanonical: true }])));
      if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_membership_rule_disagreement');
      const rule = RECOURSE_POOL_ABI.decodeFunctionResult('monthlyRule', values[0])[0];
      if (rule[4] !== payment.ruleHash || BigInt(payment.burn) > BigInt(rule[1])) throw Error('recourse_membership_rule_invalid');
    }
    if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw Error('recourse_membership_retired');
  }
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
export async function beginMembershipTransition(relay: MembershipRelay, kind: 'join' | 'leave' | 'renew'): Promise<MembershipTransitionView> {
  const view = parseMembershipTransitionView(await relay.request('membership-transitions', { kind }));
  if (view.kind !== kind) return fail(); return view;
}
export async function readMembershipTransition(relay: MembershipRelay, id?: string): Promise<MembershipTransitionView | null> {
  const raw = await relay.request(id ? `membership-transitions/${hash(id)}` : 'membership-transitions');
  if (raw === null && !id) return null;
  const view = parseMembershipTransitionView(raw);
  if (id && view.id !== id) return fail(); return view;
}
export async function readMembershipConsentStatus(relay: MembershipRelay, id: string): Promise<MembershipOperationStatus> {
  const operation = parseMembershipOperationStatus(await relay.request(`membership-consents/${hash(id)}`));
  if (operation.id !== id) return fail();
  return operation;
}
/** The callback owns its key and sees exact raw bytes. Signing a hex string as
 * text is a different authorization and is deliberately never requested. */
export async function submitMembershipConsent(relay: MembershipRelay, network: OwnerChainNetwork,
  input: { readonly transitionId: string; readonly kind: 'join' | 'leave' | 'renew'; readonly account: string; readonly challenge: MembershipConsentChallenge;
    signBytes(bytes: Uint8Array): Promise<string>; exitSecret(salt:string, expectedCommitment?:string): Promise<string>;
    onJoinSubmission?(submission: JoinSubmission): Promise<void> }): Promise<MembershipOperationStatus> {
  const transitionId=hash(input.transitionId),challenge=await validateMembershipConsent(input.challenge,input.account,input.kind,network);
  let standing:StandingMembershipAuthorization|null=null,ownerSignature:string|null=null,exitSecret:string|null=null;
  if(challenge.consent.joined){
    const exitSalt=hexlify(randomBytes(32));
    const secret=await input.exitSecret(exitSalt);
    standing={admissionMonth:challenge.admissionMonth,rejoinPayments:challenge.rejoinPayments,consent:challenge.consent,fixedChargePayer:challenge.fixedChargePayer,burnLimit:challenge.burnLimit,
      reserveLimit:challenge.reserveLimit,earningsBpsLimit:challenge.earningsBpsLimit,exitSalt,exitCommitment:membershipExitCommitment(secret)};
    ownerSignature=await input.signBytes(getBytes(standingMembershipSigningHash(challenge.domain,standing)));
  }else{
    const {mandate}=await readStandingMembershipState(challenge.consent.binding,network);
    if(mandate.consentNonce!==challenge.consent.nonce)throw Error('recourse_membership_stale');
    if (mandate.active) {
      exitSecret=await input.exitSecret(mandate.exitSalt,mandate.exitCommitment);
      if(membershipExitCommitment(exitSecret)!==mandate.exitCommitment)throw Error('recourse_membership_exit_proof');
    } else {
      ownerSignature=await input.signBytes(getBytes(authenticatedDepartureSigningHash(challenge.domain,challenge.consent)));
    }
  }
  await validateMembershipConsent(challenge,input.account,input.kind,network);
  if (input.kind === 'join' && standing && input.onJoinSubmission) {
    const operationId = sha256(AbiCoder.defaultAbiCoder().encode(['string', 'bytes32'],
      ['Provian sponsored standing consent', standingMembershipDigest(challenge.domain, standing)]));
    await input.onJoinSubmission({ transitionId, operationId, binding: challenge.consent.binding, expiresAt: challenge.consent.expiresAt });
  }
  return parseMembershipOperationStatus(await relay.request('membership-consents',{transitionId,domain:challenge.domain,
    consent:challenge.consent,standing,ownerSignature,exitSecret}));
}
export async function prepareMembershipDebit(relay: MembershipRelay, payer: string,
  amounts?: { readonly month: string; readonly burn: string; readonly reserve: string }): Promise<MembershipDebitPreparation> {
  return parseMembershipDebitPreparation(await relay.request('membership-debit-challenges', { payer: payer.toLowerCase(), ...(amounts ? { amounts } : {}) }));
}
/** Optional wake-up for an already approved automatic debit. No member signature
 * or token approval is requested; the relay and standing mandate bound it. */
export async function submitMembershipDebit(relay: MembershipRelay, network: OwnerChainNetwork,
  input: { readonly payer: string; readonly challenge: MembershipDebitChallenge }): Promise<MembershipOperationStatus> {
  const challenge = await validateMembershipDebit(input.challenge, input.payer, network);
  return parseMembershipOperationStatus(await relay.request('membership-debits', { reservationId: challenge.reservationId,
    domain: challenge.domain, debit: challenge.debit }));
}

/** Capture every currently usable or queued admission's revocation in one
 * local approval. Each preimage can only end that binding's membership. The
 * private relay retains it and completes departure even after this app closes. */
export async function retainMembershipDeparture(relay:MembershipRelay,network:OwnerChainNetwork,input:{
  readonly transitionId:string;
  exitSecret(challenge:MembershipConsentChallenge,salt:string,expectedCommitment:string):Promise<string>;
  signBytes(account:string,binding:string,bytes:Uint8Array):Promise<string>;
}):Promise<void>{
  const path=`membership-departures/${hash(input.transitionId)}` as const,raw=await relay.request(path);
  if(!Array.isArray(raw))return fail();
  const deployment=await network.deployment(),proofs:unknown[]=[];
  for(const value of raw){
    const r=object(value,'consent,domain,exitCommitment,exitSalt'),domain=parseMembershipAuthorizationDomain(r.domain),consent=parseAddressMembershipConsent(r.consent);
    requireDomain(domain,String(deployment.revision),deployment);
    if(consent.joined)throw Error('recourse_membership_scope');
    const state=await poolAt(consent.binding,network,deployment);
    if(BigInt(consent.nonce)<BigInt(state.consentNonce))continue;
    if(state.currentAddress!==consent.account||BigInt(consent.nonce)>BigInt(state.consentNonce)+1n)throw Error('recourse_membership_stale');
    const challenge={domain,consent,exitSalt:r.exitSalt,exitCommitment:r.exitCommitment};
    if(r.exitSalt===null&&r.exitCommitment===null){
      const current=await readStandingMembershipState(consent.binding,network);
      if(!state.addressConsent||consent.nonce!==state.consentNonce||current.mandate.active||current.mandate.consentNonce!==consent.nonce)throw Error('recourse_membership_stale');
      proofs.push({challenge,exitSecret:null,ownerSignature:await input.signBytes(consent.account,consent.binding,getBytes(authenticatedDepartureSigningHash(domain,consent)))});
    }else{
      const salt=hash(r.exitSalt),commitment=hash(r.exitCommitment);
      const secret=await input.exitSecret({domain,consent,admissionMonth:state.month,rejoinPayments:[],fixedChargePayer:false,burnLimit:'0',reserveLimit:'0',earningsBpsLimit:0,
        messageHex:addressMembershipSigningHash(domain,consent)},salt,commitment);
      if(membershipExitCommitment(secret)!==commitment)throw Error('recourse_membership_exit_proof');
      proofs.push({challenge,exitSecret:secret,ownerSignature:null});
    }
  }
  if((await network.deployment()).manifestHash!==deployment.manifestHash)throw Error('recourse_membership_retired');
  if(proofs.length===0){if(raw.length)throw Error('recourse_membership_stale');return;}
  const result=object(await relay.request(path,proofs),'retained');
  if(result.retained!==true)return fail();
}

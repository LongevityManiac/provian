import { recourseLaneAddress } from './transaction-lane-key';
import { privateRejoinPayments } from './private-membership-calendar';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { utcCalendarMonth } from './calendar-month';
import {assertMembershipDepartureAttestation} from './membership-departure-attestation';
import { getBytes, getCreateAddress } from 'ethers';
import { readMembershipWiring } from './membership-wiring';
import type { Firestore } from 'firebase-admin/firestore';
import type { OwnerOperationChain } from './owner-operation-queue';
import type { ProtocolDeployment } from '../protocol/pointer';
import { breakDeploymentChain } from './break-deployment-queue';
import { STANDING_MEMBERSHIP_ABI as POOL, standingMembershipSigningHash, authenticatedDepartureSigningHash, parseStandingMembershipAuthorization, type StandingMembershipAuthorization,
  parseAddressMembershipConsent, parseMembershipAuthorizationDomain, type AddressMembershipConsent,
  type MembershipAuthorizationDomain } from './membership-authorization';
import { configuredIdentityAttestor, assertIdentityAttestation, type IdentityAttestor } from './identity-attestor';
import { ownedMembershipTransition } from './membership-preparation';
import { nextPrivateAddressConsent, PRIVATE_MEMBERSHIP_TRANSITIONS, type PrivateMembershipTransition } from './private-membership-transition';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { readRecoursePoolState, type RecoursePoolState } from './pool-state';
import { queueSponsoredOperation, readSponsoredOperation } from './sponsored-operation-queue';
import type { SponsoredOperationAdapter } from './sponsored-operation-worker';
import { finalizedOwnerTransaction } from './transaction-finality';
import { readMembershipReceipt } from './membership-receipt';
import { reconcilePrivateMembershipReceipt } from './private-membership-reconcile';

import { MEMBERSHIP_CONSENT_OPERATIONS, membershipConsentOperationId } from './membership-operation-identifiers';
export { MEMBERSHIP_CONSENT_OPERATIONS, membershipConsentOperationId } from './membership-operation-identifiers';
export interface MembershipConsentRequest {
  readonly transitionId: string; readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent;
  readonly standing: StandingMembershipAuthorization | null; readonly exitSecret: string | null;
  readonly ownerSignature: string | null; readonly attestorSignature: string | null;
}
export interface MembershipConsentPorts {
  readonly chain: OwnerOperationChain; state(binding: string, checkpoint: ProtocolDeployment): Promise<RecoursePoolState>;
  /** The Recourse lane address; defaults to the configured lane key. */
  readonly gasPayer?: string;
}
const ports = (): MembershipConsentPorts => ({ chain: breakDeploymentChain(), state: readRecoursePoolState });
const fail = (reason: string): never => { throw Error(`recourse_membership_consent_${reason}`); };
/** Membership transactions are paid by the Recourse lane, never the settlement submitter. */
export async function laneSponsor<T extends { readonly gasPayer: string }>(p: { readonly gasPayer?: string },
  wiring: Promise<T>): Promise<T> {
  const value = await wiring, gasPayer = (p.gasPayer ?? recourseLaneAddress()).toLowerCase();
  if (gasPayer === value.gasPayer || !/^0x[0-9a-f]{40}$/.test(gasPayer)) throw Error('recourse_membership_sponsor_invalid');
  return { ...value, gasPayer };
}
export function parseMembershipConsentRequest(value: unknown): MembershipConsentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('input');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'attestorSignature,consent,domain,exitSecret,ownerSignature,standing,transitionId'
    || typeof row.transitionId !== 'string' || !/^0x[0-9a-f]{64}$/.test(row.transitionId)) return fail('input');
  const domain=parseMembershipAuthorizationDomain(row.domain), consent=parseAddressMembershipConsent(row.consent);
  const signature=(value:unknown):value is string=>typeof value==='string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
  if(consent.joined){
    const standing=parseStandingMembershipAuthorization(row.standing);
    if(JSON.stringify(standing.consent)!==JSON.stringify(consent)||row.exitSecret!==null
      ||!signature(row.ownerSignature)||!signature(row.attestorSignature))return fail('input');
    return {transitionId:row.transitionId,domain,consent,standing,exitSecret:null,ownerSignature:row.ownerSignature,attestorSignature:row.attestorSignature};
  }
  if(row.standing!==null||row.attestorSignature!==null) return fail('input');
  if (row.exitSecret === null && signature(row.ownerSignature)) return {transitionId:row.transitionId,domain,consent,
    standing:null,exitSecret:null,ownerSignature:row.ownerSignature,attestorSignature:null};
  if(row.ownerSignature!==null||typeof row.exitSecret!=='string'||!/^0x[0-9a-f]{64}$/.test(row.exitSecret))return fail('input');
  return {transitionId:row.transitionId,domain,consent,standing:null,exitSecret:row.exitSecret,ownerSignature:null,attestorSignature:null};
}
export function membershipConsentCalldata(request: MembershipConsentRequest): string {
  return request.standing ? POOL.encodeFunctionData('setStandingConsent', [request.standing, request.ownerSignature, request.attestorSignature])
    : request.exitSecret !== null ? POOL.encodeFunctionData('leaveStandingMembership',[request.consent.binding,request.consent.nonce,request.exitSecret,request.consent.revision])
    : POOL.encodeFunctionData('leaveSuspendedMembership',[request.consent,request.ownerSignature]);
}

async function consentContext(db: Firestore, request: MembershipConsentRequest,
  p: MembershipConsentPorts) {
  const { domain, consent } = request, deployment = await p.chain.deployment();
  if (domain.chainId !== '8453' || domain.pointer !== deployment.pointer.toLowerCase() || domain.kernel !== deployment.addresses.kernel.toLowerCase()
    || domain.pool !== deployment.addresses.recoursePool.toLowerCase() || consent.revision !== String(deployment.revision)) return fail('retired');
  const binding = await db.collection(R.identities).doc(consent.binding).get(), ownerIdentity: unknown = binding.get('ownerIdentity');
  if (!binding.exists || typeof ownerIdentity !== 'string') return fail('owner');
  const operation = await ownedMembershipTransition(db, ownerIdentity, request.transitionId);
  if (operation.departureRequested && operation.kind !== 'leave') return fail('finished');
  const [owner, account, address] = await Promise.all([db.collection(R.owners).doc(ownerIdentity).get(),
    db.collection(C.owners).doc(ownerIdentity).get(), db.collection(R.addresses).doc(consent.account).get()]);
  const selected = operation.bindings.find(b => b.binding === consent.binding);
  if (operation.status !== 'consenting' && !(operation.kind === 'leave' && operation.status === 'preparing')) return fail('finished');
  if (operation.pool !== domain.pool || operation.kernel !== domain.kernel || owner.get('membershipTransition') !== operation.id
    || (owner.get('bindingSetVersion') ?? 0) !== operation.bindingSetVersion || !selected
    || selected.recoveryGeneration !== binding.get('recoveryGeneration')
    || (consent.joined && account.exists && account.get('pendingReservation') !== null)
    || !address.exists || address.get('ownerIdentity') !== ownerIdentity || address.get('identity') !== consent.binding
    || address.get('kernel') !== domain.kernel || address.get('chainBindingStatus') !== 'confirmed'
    || address.get('recoveryGeneration') !== binding.get('recoveryGeneration')) return fail('owner');
  const state = await p.state(consent.binding, deployment);
  if (state.pool !== domain.pool || state.kernel !== domain.kernel || state.currentAddress !== consent.account
    || state.blockHash !== deployment.blockHash) return fail('changed');
  const expected = nextPrivateAddressConsent(operation, consent.binding, { revision: consent.revision, ruleHash: state.signedRuleHash, timestamp: state.timestamp });
  if (!expected || Object.entries(expected).some(([key, value]) => key !== 'expiresAt' && (consent.joined || key !== 'ruleHash') && consent[key as keyof AddressMembershipConsent] !== value)
    || consent.nonce !== state.consentNonce || (operation.kind === 'renew' ? !state.addressConsent : consent.joined === state.addressConsent)
    || (consent.joined && (BigInt(consent.expiresAt) < BigInt(state.timestamp) || BigInt(consent.expiresAt) > BigInt(expected.expiresAt)))) return fail('stale');
  if(request.standing && (!operation.fixedDebitBinding || owner.get('membershipFixedDebitBinding') !== operation.fixedDebitBinding
    || request.standing.fixedChargePayer !== (operation.fixedDebitBinding===consent.binding)
    || request.standing.burnLimit !== (request.standing.fixedChargePayer?state.participationBurnAtomic:'0')
    || request.standing.reserveLimit !== (request.standing.fixedChargePayer?state.noEarningsContributionAtomic:'0')
    || request.standing.earningsBpsLimit !== state.earningsBps))return fail('amount');
  if (request.standing) {
    if (request.standing.admissionMonth !== state.month || (operation.kind === 'join' && operation.admissionMonth !== undefined
      && String(operation.admissionMonth) !== state.month)) return fail('stale');
    const expectedPayments = consent.binding === operation.fixedDebitBinding ? operation.rejoinPayments ?? [] : [];
    if (JSON.stringify(request.standing.rejoinPayments) !== JSON.stringify(expectedPayments)) return fail('rejoin_amount');
    if (operation.kind === 'join' && account.exists && consent.binding === operation.fixedDebitBinding) {
      const rules = await readPrivateCalendarRules(db, { pool: state.pool, block: state.block, blockHash: state.blockHash });
      if (JSON.stringify(privateRejoinPayments(account.get('episode'), utcCalendarMonth(state.timestamp), rules)) !== JSON.stringify(expectedPayments)) return fail('rejoin_amount');
    }
  }
  return { deployment, ownerIdentity, ...await laneSponsor(p, readMembershipWiring(p.chain, deployment)) };
}
export interface CheckedMembershipConsent {
  readonly id: string; readonly executor: string; readonly calldata: string; readonly gasPayer: string; readonly manifestHash: string;
}
const checked = new WeakSet<CheckedMembershipConsent>();
export function assertCheckedMembershipConsent(plan: CheckedMembershipConsent): void {
  if (!checked.has(plan)) return fail('unverified');
}
export async function checkMembershipConsent(db: Firestore, value: unknown, p = ports()): Promise<CheckedMembershipConsent> {
  const request = parseMembershipConsentRequest(value), context = await consentContext(db, request, p);
  if(request.standing){
    const bytes=getBytes(standingMembershipSigningHash(request.domain,request.standing));
    if(!request.ownerSignature||!request.attestorSignature)return fail('signature');
    await assertIdentityAttestation(p.chain, request.consent.account, context.deployment.blockHash, bytes, request.ownerSignature);
    await assertIdentityAttestation(p.chain, context.identityAttestor, context.deployment.blockHash, bytes, request.attestorSignature);
  } else if (request.ownerSignature) {
    await assertMembershipDepartureAttestation(p.chain, request.consent.account, context.deployment.blockHash,
      getBytes(authenticatedDepartureSigningHash(request.domain,request.consent)), request.ownerSignature);
  }
  const calldata = membershipConsentCalldata(request);
  if (await p.chain.agree('eth_call', [{ to: context.standingMembership, from: context.gasPayer, data: calldata }, context.pin]) !== '0x') return fail('simulation');
  if ((await p.chain.deployment()).manifestHash !== context.deployment.manifestHash) return fail('retired');
  const plan = Object.freeze({ id: membershipConsentOperationId(request), executor: context.standingMembership, calldata,
    gasPayer: context.gasPayer, manifestHash: context.deployment.manifestHash });
  checked.add(plan); return plan;
}
export function membershipConsentAdapter(db: Firestore, p = ports()): SponsoredOperationAdapter<MembershipConsentRequest, CheckedMembershipConsent> {
  return { lane: true, collection: MEMBERSHIP_CONSENT_OPERATIONS, parse: parseMembershipConsentRequest, id: membershipConsentOperationId,
    beforeQueue: async (tx, request) => {
      const transition = await tx.get(db.collection(PRIVATE_MEMBERSHIP_TRANSITIONS).doc(request.transitionId));
      const joining = transition.get('kind') === 'join' && request.standing !== null;
      if (joining) {
        const existing = await tx.get(acceptedApprovals(db, request.transitionId));
        const accepted = existing.docs.find(row => sameJoinApproval(row.get('request'), request));
        if (accepted) return accepted.id;
      }
      if (!transition.exists || (transition.get('departureRequested') && request.consent.joined) || transition.get('status') === 'superseded'
        || transition.get('status') === 'complete') return fail('finished');
      const operation = transition.data() as PrivateMembershipTransition;
      if (request.standing && (JSON.stringify(request.standing.rejoinPayments) !== JSON.stringify(
        request.consent.binding === operation.fixedDebitBinding ? operation.rejoinPayments ?? [] : [])
        || (operation.kind === 'join' && operation.admissionMonth !== undefined && request.standing.admissionMonth !== String(operation.admissionMonth)))) return fail('stale');
      const expected = nextPrivateAddressConsent(operation,request.consent.binding,
        {revision:request.consent.revision,ruleHash:request.consent.ruleHash,timestamp:0});
      if (!expected || Object.entries(expected).some(([key,value]) => key !== 'expiresAt'
        && request.consent[key as keyof AddressMembershipConsent] !== value)) return fail('finished');
      if (joining) {
        // Contending approvals for this transition share a write fence, even
        // if each signer used a different salt and the queue started empty.
        const version = transition.get('approvalQueueVersion') ?? 0;
        if (!Number.isSafeInteger(version) || version < 0) return fail('changed');
        tx.update(db.collection(PRIVATE_MEMBERSHIP_TRANSITIONS).doc(request.transitionId), { approvalQueueVersion: version + 1 });
      }
    },
    target: r => getCreateAddress({from:r.domain.pool,nonce:1}).toLowerCase(), calldata: membershipConsentCalldata, check: r => checkMembershipConsent(db, r, p), assert: assertCheckedMembershipConsent,
    satisfied: () => false, obsolete: e => e instanceof Error && ['retired', 'finished', 'stale', 'owner', 'rejoin_amount'].some(s => e.message === `recourse_membership_consent_${s}`),
    finalized: finalizedOwnerTransaction, reconcileConfirmed: async (request, transactionHash) => {
      const binding = await db.collection(R.identities).doc(request.consent.binding).get(), ownerIdentity: unknown = binding.get('ownerIdentity');
      if (typeof ownerIdentity !== 'string') return fail('owner');
      await reconcilePrivateMembershipReceipt(db, ownerIdentity, await readMembershipReceipt(transactionHash, request.domain.pool));
    } };
}
function acceptedApprovals(db: Firestore, transitionId: string) {
  return db.collection(MEMBERSHIP_CONSENT_OPERATIONS).where('request.transitionId', '==', transitionId)
    .where('status', 'in', ['queued', 'submitted', 'confirmed']);
}

function sameJoinApproval(value: unknown, request: MembershipConsentRequest): boolean {
  if (!request.standing || !request.consent.joined) return false;
  const saved = parseMembershipConsentRequest(value);
  return saved.standing !== null && saved.consent.joined && saved.transitionId === request.transitionId
    && saved.consent.binding === request.consent.binding && saved.consent.account === request.consent.account
    && saved.consent.nonce === request.consent.nonce && saved.consent.revision === request.consent.revision
    && Object.keys(request.domain).every(key => saved.domain[key as keyof MembershipAuthorizationDomain] === request.domain[key as keyof MembershipAuthorizationDomain]);
}

export async function queueMembershipConsent(db: Firestore, ownerIdentity: string, input: Omit<MembershipConsentRequest, 'attestorSignature'>,
  attestor: IdentityAttestor = configuredIdentityAttestor(), p = ports()) {
  // Authentication/ownership is checked even when an identical queue ID exists.
  const transition = await ownedMembershipTransition(db, ownerIdentity, input.transitionId);
  const request = parseMembershipConsentRequest({ ...input, attestorSignature: input.standing ? '0x00' : null });
  if (transition.kind === 'join' && request.standing) {
    const candidates = await acceptedApprovals(db, request.transitionId).get();
    const prior = candidates.docs.find(row => sameJoinApproval(row.get('request'), request));
    if (prior) return readSponsoredOperation(db, MEMBERSHIP_CONSENT_OPERATIONS, prior.id);
  }
  const context = await consentContext(db, request, p);
  if (context.ownerIdentity !== ownerIdentity) return fail('owner');
  if(!request.standing)return queueSponsoredOperation(db,request,membershipConsentAdapter(db,p));
  if(attestor.address.toLowerCase()!==context.identityAttestor||!attestor.signBytes||!request.ownerSignature)return fail('attestor');
  const bytes=getBytes(standingMembershipSigningHash(request.domain,request.standing));
  await assertIdentityAttestation(p.chain,request.consent.account,context.deployment.blockHash,bytes,request.ownerSignature);
  return queueSponsoredOperation(db,{...request,attestorSignature:await attestor.signBytes(bytes)},membershipConsentAdapter(db,p));
}

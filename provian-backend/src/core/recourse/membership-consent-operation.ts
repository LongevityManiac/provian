import { getBytes } from 'ethers';
import { readMembershipWiring } from './membership-wiring';
import type { Firestore } from 'firebase-admin/firestore';
import type { OwnerOperationChain } from './owner-operation-queue';
import type { ProtocolDeployment } from '../protocol/pointer';
import { breakDeploymentChain } from './break-deployment-queue';
import { MEMBERSHIP_AUTHORIZATION_ABI as POOL, addressMembershipSigningHash,
  parseAddressMembershipConsent, parseMembershipAuthorizationDomain, type AddressMembershipConsent,
  type MembershipAuthorizationDomain } from './membership-authorization';
import { configuredIdentityAttestor, assertIdentityAttestation, type IdentityAttestor } from './identity-attestor';
import { ownedMembershipTransition } from './membership-preparation';
import { nextPrivateAddressConsent } from './private-membership-transition';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { readRecoursePoolState, type RecoursePoolState } from './pool-state';
import { queueSponsoredOperation } from './sponsored-operation-queue';
import { executeSponsoredOperation, type SponsoredOperationAdapter, type SponsoredOperationSigner } from './sponsored-operation-worker';
import { finalizedOwnerTransaction } from './transaction-finality';
import { readMembershipReceipt } from './membership-receipt';
import { reconcilePrivateMembershipReceipt } from './private-membership-reconcile';

import { MEMBERSHIP_CONSENT_OPERATIONS, membershipConsentOperationId } from './membership-operation-identifiers';
export { MEMBERSHIP_CONSENT_OPERATIONS, membershipConsentOperationId } from './membership-operation-identifiers';
export interface MembershipConsentRequest {
  readonly transitionId: string; readonly domain: MembershipAuthorizationDomain; readonly consent: AddressMembershipConsent;
  readonly ownerSignature: string; readonly attestorSignature: string;
}
export interface MembershipConsentPorts { readonly chain: OwnerOperationChain; state(binding: string, checkpoint: ProtocolDeployment): Promise<RecoursePoolState> }
const ports = (): MembershipConsentPorts => ({ chain: breakDeploymentChain(), state: readRecoursePoolState });
const fail = (reason: string): never => { throw Error(`recourse_membership_consent_${reason}`); };
export function parseMembershipConsentRequest(value: unknown): MembershipConsentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('input');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'attestorSignature,consent,domain,ownerSignature,transitionId'
    || typeof row.transitionId !== 'string' || !/^0x[0-9a-f]{64}$/.test(row.transitionId)
    || typeof row.ownerSignature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(row.ownerSignature)
    || typeof row.attestorSignature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(row.attestorSignature)) return fail('input');
  return { transitionId: row.transitionId, domain: parseMembershipAuthorizationDomain(row.domain),
    consent: parseAddressMembershipConsent(row.consent), ownerSignature: row.ownerSignature, attestorSignature: row.attestorSignature };
}
export function membershipConsentCalldata(request: MembershipConsentRequest): string {
  return POOL.encodeFunctionData('setAddressConsent', [request.consent, request.ownerSignature, request.attestorSignature]);
}
async function consentContext(db: Firestore, request: Pick<MembershipConsentRequest, 'transitionId' | 'domain' | 'consent'>,
  p: MembershipConsentPorts) {
  const { domain, consent } = request, deployment = await p.chain.deployment();
  if (domain.chainId !== '8453' || domain.pointer !== deployment.pointer.toLowerCase() || domain.kernel !== deployment.addresses.kernel.toLowerCase()
    || domain.pool !== deployment.addresses.recoursePool.toLowerCase() || consent.revision !== String(deployment.revision)) return fail('retired');
  const binding = await db.collection(R.identities).doc(consent.binding).get(), ownerIdentity: unknown = binding.get('ownerIdentity');
  if (!binding.exists || typeof ownerIdentity !== 'string') return fail('owner');
  const operation = await ownedMembershipTransition(db, ownerIdentity, request.transitionId);
  const [owner, account, address] = await Promise.all([db.collection(R.owners).doc(ownerIdentity).get(),
    db.collection(C.owners).doc(ownerIdentity).get(), db.collection(R.addresses).doc(consent.account).get()]);
  const selected = operation.bindings.find(b => b.binding === consent.binding);
  if (operation.status !== 'consenting') return fail('finished');
  if (operation.pool !== domain.pool || operation.kernel !== domain.kernel || owner.get('membershipTransition') !== operation.id
    || (owner.get('bindingSetVersion') ?? 0) !== operation.bindingSetVersion || !selected
    || selected.recoveryGeneration !== binding.get('recoveryGeneration')
    || (account.exists && account.get('pendingReservation') !== null)
    || !address.exists || address.get('ownerIdentity') !== ownerIdentity || address.get('identity') !== consent.binding
    || address.get('kernel') !== domain.kernel || address.get('chainBindingStatus') !== 'confirmed'
    || address.get('recoveryGeneration') !== binding.get('recoveryGeneration')) return fail('owner');
  const state = await p.state(consent.binding, deployment);
  if (state.pool !== domain.pool || state.kernel !== domain.kernel || state.currentAddress !== consent.account
    || state.blockHash !== deployment.blockHash) return fail('changed');
  const expected = nextPrivateAddressConsent(operation, consent.binding, { revision: consent.revision, ruleHash: state.signedRuleHash, timestamp: state.timestamp });
  if (!expected || Object.entries(expected).some(([key, value]) => key !== 'expiresAt' && consent[key as keyof AddressMembershipConsent] !== value)
    || consent.nonce !== state.consentNonce || consent.joined === state.addressConsent
    || BigInt(consent.expiresAt) < BigInt(state.timestamp) || BigInt(consent.expiresAt) > BigInt(expected.expiresAt)) return fail('stale');
  return { deployment, ownerIdentity, ...await readMembershipWiring(p.chain, deployment) };
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
  const bytes = getBytes(addressMembershipSigningHash(request.domain, request.consent));
  await assertIdentityAttestation(p.chain, request.consent.account, context.deployment.blockHash, bytes, request.ownerSignature);
  await assertIdentityAttestation(p.chain, context.identityAttestor, context.deployment.blockHash, bytes, request.attestorSignature);
  const calldata = membershipConsentCalldata(request);
  if (await p.chain.agree('eth_call', [{ to: request.domain.pool, from: context.gasPayer, data: calldata }, context.pin]) !== '0x') return fail('simulation');
  if ((await p.chain.deployment()).manifestHash !== context.deployment.manifestHash) return fail('retired');
  const plan = Object.freeze({ id: membershipConsentOperationId(request), executor: request.domain.pool, calldata,
    gasPayer: context.gasPayer, manifestHash: context.deployment.manifestHash });
  checked.add(plan); return plan;
}
export function membershipConsentAdapter(db: Firestore, p = ports()): SponsoredOperationAdapter<MembershipConsentRequest, CheckedMembershipConsent> {
  return { collection: MEMBERSHIP_CONSENT_OPERATIONS, parse: parseMembershipConsentRequest, id: membershipConsentOperationId,
    target: r => r.domain.pool, calldata: membershipConsentCalldata, check: r => checkMembershipConsent(db, r, p), assert: assertCheckedMembershipConsent,
    satisfied: () => false, obsolete: e => e instanceof Error && ['retired', 'finished', 'stale', 'owner'].some(s => e.message === `recourse_membership_consent_${s}`),
    finalized: finalizedOwnerTransaction, reconcileConfirmed: async (request, transactionHash) => {
      const binding = await db.collection(R.identities).doc(request.consent.binding).get(), ownerIdentity: unknown = binding.get('ownerIdentity');
      if (typeof ownerIdentity !== 'string') return fail('owner');
      await reconcilePrivateMembershipReceipt(db, ownerIdentity, await readMembershipReceipt(transactionHash, request.domain.pool));
    } };
}
export async function queueMembershipConsent(db: Firestore, ownerIdentity: string, input: Omit<MembershipConsentRequest, 'attestorSignature'>,
  attestor: IdentityAttestor = configuredIdentityAttestor(), p = ports()) {
  // Authentication/ownership is checked even when an identical queue ID exists.
  await ownedMembershipTransition(db, ownerIdentity, input.transitionId);
  const request = parseMembershipConsentRequest({ ...input, attestorSignature: '0x00' });
  const context = await consentContext(db, request, p);
  if (context.ownerIdentity !== ownerIdentity || attestor.address.toLowerCase() !== context.identityAttestor || !attestor.signBytes) return fail('attestor');
  const bytes = getBytes(addressMembershipSigningHash(request.domain, request.consent));
  await assertIdentityAttestation(p.chain, request.consent.account, context.deployment.blockHash, bytes, request.ownerSignature);
  const signed = { ...request, attestorSignature: await attestor.signBytes(bytes) };
  return queueSponsoredOperation(db, signed, membershipConsentAdapter(db, p));
}
export async function executeMembershipConsent(db: Firestore, id: string, signer: SponsoredOperationSigner<CheckedMembershipConsent>, p = ports()) {
  return executeSponsoredOperation(db, id, signer, membershipConsentAdapter(db, p));
}

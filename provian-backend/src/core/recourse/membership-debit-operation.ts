import { getBytes, getCreateAddress } from 'ethers';
import { isDeepStrictEqual } from 'util';
import type { Firestore } from 'firebase-admin/firestore';
import { STANDING_MEMBERSHIP_ABI as POOL, standingMembershipDebitSigningHash,
  parseExactMembershipDebit, parseMembershipAuthorizationDomain, type ExactMembershipDebit, type MembershipAuthorizationDomain } from './membership-authorization';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, planPrivateDebit, type PrivateDebitReservation, type PrivateMembershipAccount } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { readMembershipWiring } from './membership-wiring';
import { configuredIdentityAttestor, assertIdentityAttestation, type IdentityAttestor } from './identity-attestor';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { utcCalendarMonth } from './calendar-month';
import { breakDeploymentChain } from './break-deployment-queue';
import { readRecoursePoolState } from './pool-state';
import type { MembershipConsentPorts } from './membership-consent-operation';
import { queueSponsoredOperation } from './sponsored-operation-queue';
import { executeSponsoredOperation, type SponsoredOperationAdapter, type SponsoredOperationSigner } from './sponsored-operation-worker';
import { finalizedOwnerTransaction } from './transaction-finality';
import { readMembershipReceipt } from './membership-receipt';
import { reconcilePrivateMembershipReceipt } from './private-membership-reconcile';

import { MEMBERSHIP_DEBIT_OPERATIONS, membershipDebitOperationId } from './membership-operation-identifiers';
export { MEMBERSHIP_DEBIT_OPERATIONS, membershipDebitOperationId } from './membership-operation-identifiers';
export interface MembershipDebitRequest {
  readonly reservationId: string; readonly domain: MembershipAuthorizationDomain; readonly debit: ExactMembershipDebit;
  readonly attestorSignature: string;
}
const ports = (): MembershipConsentPorts => ({ chain: breakDeploymentChain(), state: readRecoursePoolState });
const fail = (reason: string): never => { throw Error(`recourse_membership_debit_${reason}`); };
export function parseMembershipDebitRequest(value: unknown): MembershipDebitRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('input');
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'attestorSignature,debit,domain,reservationId'
    || typeof r.reservationId !== 'string' || !/^0x[0-9a-f]{64}$/.test(r.reservationId)
    || typeof r.attestorSignature !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(r.attestorSignature)) return fail('input');
  return { reservationId: r.reservationId, domain: parseMembershipAuthorizationDomain(r.domain), debit: parseExactMembershipDebit(r.debit),
    attestorSignature: r.attestorSignature };
}
export function membershipDebitCalldata(request: MembershipDebitRequest): string {
  return POOL.encodeFunctionData('executeStandingDebit', [request.debit, request.attestorSignature]);
}
export async function ownedMembershipDebit(db: Firestore, ownerIdentity: string, id: string): Promise<PrivateDebitReservation> {
  if (!/^0x[0-9a-f]{64}$/.test(ownerIdentity) || !/^0x[0-9a-f]{64}$/.test(id)) return fail('unknown');
  const row = await db.collection(C.reservations).doc(id).get(), r = row.get('reservation') as PrivateDebitReservation;
  if (!row.exists || !r || r.ownerIdentity !== ownerIdentity || r.id !== id || r.kind !== 'debit') return fail('unknown');
  return r;
}
async function debitContext(db: Firestore, request: MembershipDebitRequest, p: MembershipConsentPorts) {
  const { domain, debit } = request, deployment = await p.chain.deployment();
  if (domain.chainId !== '8453' || domain.pointer !== deployment.pointer.toLowerCase() || domain.kernel !== deployment.addresses.kernel.toLowerCase()
    || domain.pool !== deployment.addresses.recoursePool.toLowerCase() || debit.revision !== String(deployment.revision)) return fail('retired');
  const row = await db.collection(C.reservations).doc(request.reservationId).get(), r = row.get('reservation') as PrivateDebitReservation;
  if (!row.exists || !r || r.kind !== 'debit' || r.id !== request.reservationId) return fail('unknown');
  if (row.get('status') !== 'pending') return fail('finished');
  const [accountRow, owner, address, identity] = await Promise.all([db.collection(C.owners).doc(r.ownerIdentity).get(),
    db.collection(R.owners).doc(r.ownerIdentity).get(), db.collection(R.addresses).doc(debit.payer).get(), db.collection(R.identities).doc(debit.binding).get()]);
  if (!accountRow.exists || accountRow.get('pendingReservation') !== r.id || !owner.exists || owner.get('ownerIdentity') !== r.ownerIdentity
    || !address.exists || address.get('identity') !== debit.binding || address.get('ownerIdentity') !== r.ownerIdentity
    || address.get('kernel') !== domain.kernel || address.get('chainBindingStatus') !== 'confirmed'
    || !identity.exists || identity.get('ownerIdentity') !== r.ownerIdentity
    || identity.get('recoveryGeneration') !== address.get('recoveryGeneration')) return fail('owner');
  const state = await p.state(debit.binding, deployment), month = utcCalendarMonth(state.timestamp);
  if (state.pool !== domain.pool || state.kernel !== domain.kernel || state.blockHash !== deployment.blockHash) return fail('changed');
  if (state.currentAddress !== debit.payer || !state.addressConsent || state.consentGeneration !== debit.generation
    || state.debitNonce !== debit.nonce || BigInt(debit.expiresAt) < BigInt(state.timestamp)
    || BigInt(debit.expiresAt) > BigInt(state.timestamp + 300) || BigInt(debit.month) > BigInt(month) || BigInt(month) - BigInt(debit.month) > 1n) return fail('stale');
  const rules = await readPrivateCalendarRules(db, state), account = accountRow.data() as PrivateMembershipAccount;
  const planned = planPrivateDebit({ ...account, pendingReservation: null }, domain, debit, month, rules);
  if (planned.id !== request.reservationId || !isDeepStrictEqual(planned, r)) return fail('reservation');
  return { deployment, ownerIdentity: r.ownerIdentity, transitionPending: owner.get('membershipTransition') != null,
    ...await readMembershipWiring(p.chain, deployment) };
}
export interface CheckedMembershipDebit {
  readonly id: string; readonly executor: string; readonly calldata: string; readonly gasPayer: string; readonly manifestHash: string;
}
const checked = new WeakSet<CheckedMembershipDebit>();
export function assertCheckedMembershipDebit(plan: CheckedMembershipDebit): void { if (!checked.has(plan)) return fail('unverified'); }
export async function checkMembershipDebit(db: Firestore, value: unknown, p = ports()): Promise<CheckedMembershipDebit> {
  const request = parseMembershipDebitRequest(value), context = await debitContext(db, request, p);
  const bytes = getBytes(standingMembershipDebitSigningHash(request.domain, request.debit));
  await assertIdentityAttestation(p.chain, context.identityAttestor, context.deployment.blockHash, bytes, request.attestorSignature);
  if (context.transitionPending) return fail('leaving');
  const calldata = membershipDebitCalldata(request);
  if (await p.chain.agree('eth_call', [{ to: context.standingMembership, from: context.gasPayer, data: calldata }, context.pin]) !== '0x') return fail('simulation');
  if ((await p.chain.deployment()).manifestHash !== context.deployment.manifestHash) return fail('retired');
  const plan = Object.freeze({ id: membershipDebitOperationId(request), executor: context.standingMembership, calldata,
    gasPayer: context.gasPayer, manifestHash: context.deployment.manifestHash });
  checked.add(plan); return plan;
}
export function membershipDebitAdapter(db: Firestore, p = ports()): SponsoredOperationAdapter<MembershipDebitRequest, CheckedMembershipDebit> {
  return { collection: MEMBERSHIP_DEBIT_OPERATIONS, parse: parseMembershipDebitRequest, id: membershipDebitOperationId,
    target: r => getCreateAddress({from: r.domain.pool, nonce: 1}).toLowerCase(), calldata: membershipDebitCalldata, check: r => checkMembershipDebit(db, r, p), assert: assertCheckedMembershipDebit,
    satisfied: () => false, obsolete: e => e instanceof Error && ['retired', 'finished', 'stale', 'owner', 'leaving'].some(s => e.message === `recourse_membership_debit_${s}`),
    finalized: finalizedOwnerTransaction, reconcileConfirmed: async (request, hash) => {
      const row = await db.collection(C.reservations).doc(request.reservationId).get(), r = row.get('reservation') as PrivateDebitReservation;
      if (!r || r.kind !== 'debit' || r.id !== request.reservationId) return fail('unknown');
      await reconcilePrivateMembershipReceipt(db, r.ownerIdentity, await readMembershipReceipt(hash, request.domain.pool));
    } };
}
export async function queueMembershipDebit(db: Firestore, ownerIdentity: string, input: Omit<MembershipDebitRequest, 'attestorSignature'>,
  attestor: IdentityAttestor = configuredIdentityAttestor(), p = ports()) {
  await ownedMembershipDebit(db, ownerIdentity, input.reservationId);
  const request = parseMembershipDebitRequest({ ...input, attestorSignature: '0x00' }), context = await debitContext(db, request, p);
  if (context.ownerIdentity !== ownerIdentity || context.transitionPending || attestor.address.toLowerCase() !== context.identityAttestor || !attestor.signBytes) return fail('attestor');
  const bytes = getBytes(standingMembershipDebitSigningHash(request.domain, request.debit));
  return queueSponsoredOperation(db, { ...request, attestorSignature: await attestor.signBytes(bytes) }, membershipDebitAdapter(db, p));
}
export async function executeMembershipDebit(db: Firestore, id: string, signer: SponsoredOperationSigner<CheckedMembershipDebit>, p = ports()) {
  return executeSponsoredOperation(db, id, signer, membershipDebitAdapter(db, p));
}

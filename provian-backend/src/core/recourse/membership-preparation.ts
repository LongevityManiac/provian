import { pendingMembershipConsents } from './membership-progress';
import type { SponsoredOperationStatus } from './sponsored-operation-queue';
import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, releaseRevokedPrivateDebit, type PrivateMembershipReservation } from './private-membership-reservation';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T, beginPrivateMembershipTransition, openPrivateMembershipConsents,
  refreshRecoveredMembershipTransition, nextPrivateAddressConsent, type PrivateMembershipTransition } from './private-membership-transition';
import { reconcilePrivateMembershipDomain } from './private-membership-domain';
import { reconcilePrivateMembershipThrough, reconcilePrivateMembershipReceipt } from './private-membership-reconcile';
import { reconcileMembershipDebit } from './membership-debit-revocation';
import { readPrivateMembershipScan, commitPrivateMembershipScan } from './private-membership-scan';
import { readRecoursePoolState, readHistoricalRecoursePoolState } from './pool-state';
import { createRecourseChainPort } from './chain-ledger';
import { addressMembershipSigningHash, type AddressMembershipConsent, type MembershipAuthorizationDomain } from './membership-authorization';

export interface MembershipConsentChallenge {
  readonly domain: MembershipAuthorizationDomain;
  readonly consent: AddressMembershipConsent;
  /** Sign these raw bytes with personal_sign, never their UTF-8 hex spelling. */
  readonly messageHex: string;
}
export interface MembershipTransitionView {
  readonly id: string; readonly kind: 'join' | 'leave';
  readonly status: PrivateMembershipTransition['status'];
  readonly challenges: readonly MembershipConsentChallenge[];
  readonly pending: readonly { readonly binding: string; readonly account: string; readonly operation: SponsoredOperationStatus }[];
}

/** Complete receipt reconciliation precedes any new signing. A pending debit
 * releases only on exact execution or canonical permanent revocation, never a
 * failed HTTP response, a reverted gas transaction or local elapsed time. */
export async function reconcileCurrentPrivateMembership(db: Firestore, ownerIdentity: string): Promise<void> {
  await reconcilePrivateMembershipDomain(db, ownerIdentity);
  const owner = await db.collection(R.owners).doc(ownerIdentity).get();
  let account = await db.collection(C.owners).doc(ownerIdentity).get();
  const transitionId: unknown = owner.get('membershipTransition');
  const transitionRow = typeof transitionId === 'string' ? await db.collection(T).doc(transitionId).get() : null;
  const transition = transitionRow?.exists ? transitionRow.data() as PrivateMembershipTransition : null;
  if (!account.exists && !transition) return;
  if (transition && transition.ownerIdentity !== ownerIdentity) throw Error('recourse_membership_owner');
  const addresses = await db.collection(R.addresses).where('ownerIdentity', '==', ownerIdentity).get();
  const binding: unknown = addresses.docs[0]?.get('identity');
  if (typeof binding !== 'string') throw Error('recourse_membership_owner');
  const chain = createRecourseChainPort(), block = await chain.finalizedBlock(), blockHash = await chain.blockHash(block);
  if (!blockHash) throw Error('recourse_membership_checkpoint');
  const state = await readHistoricalRecoursePoolState(binding, { block, blockHash });
  const deployment = await currentProtocolDeployment();
  if (state.pool !== deployment.addresses.recoursePool.toLowerCase() || state.kernel !== deployment.addresses.kernel.toLowerCase()
    || (account.exists && account.get('checkpoint')?.pool !== state.pool) || (transition && transition.pool !== state.pool)) throw Error('recourse_membership_retired');
  const from = Math.min(account.exists ? Number(account.get('checkpoint')?.block) : Number.MAX_SAFE_INTEGER,
    transition?.checkpoint.block ?? Number.MAX_SAFE_INTEGER);
  await reconcilePrivateMembershipThrough(db, ownerIdentity, from, { pool: state.pool, kernel: state.kernel, block, blockHash });
  account = await db.collection(C.owners).doc(ownerIdentity).get();
  const pending: unknown = account.get('pendingReservation');
  if (typeof pending === 'string') {
    const reserved = await db.collection(C.reservations).doc(pending).get();
    const r = reserved.get('reservation') as PrivateMembershipReservation;
    if (!reserved.exists || reserved.get('status') !== 'pending' || r.ownerIdentity !== ownerIdentity) throw Error('recourse_membership_pending');
    if (r.kind === 'debit') {
      const result = await reconcileMembershipDebit(r.domain, r.debit, r.checkpoint);
      if (result?.kind === 'executed') await reconcilePrivateMembershipReceipt(db, ownerIdentity, result.receipt);
      if (result?.kind === 'revoked') await releaseRevokedPrivateDebit(db, ownerIdentity, pending, result.proof);
    }
  }
  account = await db.collection(C.owners).doc(ownerIdentity).get();
  if (account.exists && account.get('pendingReservation') === null) {
    await commitPrivateMembershipScan(db, await readPrivateMembershipScan(db, ownerIdentity));
  }
}

export async function ownedMembershipTransition(db: Firestore, ownerIdentity: string, id: string): Promise<PrivateMembershipTransition> {
  if (!/^0x[0-9a-f]{64}$/.test(ownerIdentity) || !/^0x[0-9a-f]{64}$/.test(id)) throw Error('recourse_membership_unknown');
  const row = await db.collection(T).doc(id).get();
  if (!row.exists || row.get('ownerIdentity') !== ownerIdentity) throw Error('recourse_membership_unknown');
  return row.data() as PrivateMembershipTransition;
}

/** All returned portfolio information is owner-authenticated and no-store.
 * Each public payload authorizes one address, without an owner/group digest. */
export async function prepareMembershipTransition(db: Firestore, ownerIdentity: string,
  input: { readonly kind: 'join' | 'leave' } | { readonly id: string }): Promise<MembershipTransitionView> {
  if ('id' in input) await ownedMembershipTransition(db, ownerIdentity, input.id);
  await reconcileCurrentPrivateMembership(db, ownerIdentity);
  let operation = 'id' in input ? await ownedMembershipTransition(db, ownerIdentity, input.id)
    : await beginPrivateMembershipTransition(db, ownerIdentity, input.kind);
  if (operation.status === 'preparing') {
    await reconcileCurrentPrivateMembership(db, ownerIdentity);
    const account = await db.collection(C.owners).doc(ownerIdentity).get();
    if (account.exists && account.get('pendingReservation') != null) {
      return { id: operation.id, kind: operation.kind, status: 'preparing', challenges: [], pending: [] };
    }
    operation = await refreshRecoveredMembershipTransition(db, operation.id);
    operation = await openPrivateMembershipConsents(db, operation.id);
  }
  if (operation.status !== 'consenting') return { id: operation.id, kind: operation.kind, status: operation.status, challenges: [], pending: [] };
  operation = await refreshRecoveredMembershipTransition(db, operation.id);
  const deployment = await currentProtocolDeployment();
  if (operation.pool !== deployment.addresses.recoursePool.toLowerCase() || operation.kernel !== deployment.addresses.kernel.toLowerCase()) throw Error('recourse_membership_retired');
  const domain: MembershipAuthorizationDomain = { chainId: '8453', pointer: deployment.pointer.toLowerCase(), kernel: operation.kernel, pool: operation.pool };
  const challenges: MembershipConsentChallenge[] = [];
  const queued = await pendingMembershipConsents(db, operation.id);
  const pending: MembershipTransitionView['pending'][number][] = [];
  for (const binding of operation.bindings) {
    const state = await readRecoursePoolState(binding.binding);
    if (state.pool !== operation.pool || state.kernel !== operation.kernel || state.currentAddress !== binding.address) throw Error('recourse_membership_changed');
    const consent = nextPrivateAddressConsent(operation, binding.binding, {
      revision: String(deployment.revision), ruleHash: state.signedRuleHash, timestamp: state.timestamp });
    if (consent) {
      if (consent.nonce !== state.consentNonce || consent.joined === state.addressConsent) throw Error('recourse_membership_reconciliation_pending');
      const inFlight = queued.filter(row => row.domain.pool === domain.pool && row.domain.kernel === domain.kernel && row.domain.pointer === domain.pointer
        && Object.entries(consent).every(([key, value]) => key === 'expiresAt' || row.consent[key as keyof AddressMembershipConsent] === value));
      if (inFlight.length) pending.push(...inFlight.map(row => ({ binding: consent.binding, account: consent.account, operation: row.operation })));
      else challenges.push({ domain, consent, messageHex: addressMembershipSigningHash(domain, consent) });
    }
  }
  if ((await currentProtocolDeployment()).manifestHash !== deployment.manifestHash) throw Error('recourse_membership_retired');
  return { id: operation.id, kind: operation.kind, status: operation.status, challenges, pending };
}

import { isDeepStrictEqual } from 'util';
import type { RestorationTicket } from './determination';
import { parseRestorationScope, type RestorationScope } from './owner-operation';
import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { RECOURSE_COLLECTIONS, type RegisteredAddress } from './ownership';
import { snapshotReportedLoss, type LossSnapshot } from './loss-snapshot';
import { readLossMembership } from './membership-history';
import { readRecoursePoolState, type RecoursePoolState } from './pool-state';
import type { LossMembershipEvidence } from './membership-at-loss';

export const RESTORATION_REQUESTS = 'recourse_restoration_requests_v1';
export interface RestorationRequestInput {
  readonly transactionHash: string; readonly block: number; readonly recoveryRequestId: string; readonly restorationRequestId: string;
}
export interface RestorationEvidencePorts {
  snapshot(identity: string, transactionHash: string, block: number, bindings: readonly RegisteredAddress[]): Promise<LossSnapshot>;
  membership(db: Firestore, snapshot: LossSnapshot): Promise<LossMembershipEvidence & { readonly lossTimestamp: number }>;
  pool(identity: string): Promise<RecoursePoolState>;
  ticket?(kernel: string, request: string): Promise<RestorationTicket>;
}
const defaultPorts: RestorationEvidencePorts = { snapshot: snapshotReportedLoss, membership: readLossMembership, pool: readRecoursePoolState };

/** Prepare only independently read facts before the owner's one authorization.
 * This creates no entitlement and cannot execute a reversal or use the reserve. */
export async function prepareRestorationRequest(db: Firestore, identity: string,
  input: { readonly transactionHash: string; readonly block: number },
  ports: RestorationEvidencePorts = defaultPorts): Promise<RestorationScope & { readonly kernel: string }> {
  if (!/^0x[0-9a-f]{64}$/.test(identity) || !/^0x[0-9a-f]{64}$/.test(input.transactionHash)
    || !Number.isSafeInteger(input.block) || input.block < 1) throw new Error('recourse_restoration_request_invalid');
  const [owner, addresses] = await Promise.all([
    db.collection(RECOURSE_COLLECTIONS.identities).doc(identity).get(),
    db.collection(RECOURSE_COLLECTIONS.addresses).where('identity', '==', identity).get(),
  ]);
  if (!owner.exists) throw new Error('recourse_restoration_owner_unknown');
  const bindings = addresses.docs.filter(doc => doc.get('chainBindingStatus') === 'confirmed').map(doc => doc.data() as RegisteredAddress);
  const snapshot = await ports.snapshot(identity, input.transactionHash, input.block, bindings);
  const membership = await ports.membership(db, snapshot);
  if (!membership.active || membership.periodIndex === null) throw new Error('recourse_restoration_not_member_at_loss');
  const evidence = JSON.stringify({ snapshot, membership });
  const lossHash = `0x${createHash('sha256').update(evidence).digest('hex')}`;
  const scope = parseRestorationScope({ request: snapshot.occurrence, lossHash, maximumLoss: snapshot.lossAtomic });
  await db.runTransaction(async tx => {
    const ref = db.collection(RESTORATION_REQUESTS).doc(scope.request);
    const prior = await tx.get(ref);
    if (prior.exists) {
      const priorScope = parseRestorationScope(prior.get('scope'));
      const previous: unknown = prior.get('snapshot');
      if (prior.get('identity') !== identity || priorScope.lossHash !== lossHash
        || priorScope.maximumLoss !== scope.maximumLoss || !previous || typeof previous !== 'object'
        || !('kernel' in previous) || previous.kernel !== snapshot.kernel) {
        throw new Error('recourse_restoration_request_conflict');
      }
      return;
    }
    tx.create(ref, { requestId: scope.request, identity, transactionHash: input.transactionHash, block: input.block,
      scope, snapshot, membership, evidence, evidenceHash: lossHash, status: 'prepared', createdAtMs: Date.now() });
  });
  return { ...scope, kernel: snapshot.kernel };
}

/** Submission records a request, not an entitlement or a self-attested PE. The
 * operator's later determination must consume the evidence and prior outcomes.
 * The complete portfolio is read here; a requester cannot omit bound addresses. */
export async function submitRestorationRequest(db: Firestore, authenticatedIdentity: string,
  input: RestorationRequestInput, ports: RestorationEvidencePorts = defaultPorts): Promise<{ requestId: string; status: string }> {
  const hash = /^0x[0-9a-f]{64}$/;
  if (!hash.test(authenticatedIdentity) || !input || !hash.test(input.transactionHash) || !hash.test(input.recoveryRequestId) || !hash.test(input.restorationRequestId)
    || !Number.isSafeInteger(input.block) || input.block < 1) throw new Error('recourse_restoration_request_invalid');
  const ownerRef = db.collection(RECOURSE_COLLECTIONS.identities).doc(authenticatedIdentity);
  const recoveryRef = db.collection(RECOURSE_COLLECTIONS.recoveries).doc(input.recoveryRequestId);
  const [owner, recovery, addresses] = await Promise.all([ownerRef.get(), recoveryRef.get(),
    db.collection(RECOURSE_COLLECTIONS.addresses).where('identity', '==', authenticatedIdentity).get()]);
  if (!owner.exists || !recovery.exists || recovery.get('identity') !== authenticatedIdentity
    || recovery.get('generation') !== owner.get('recoveryGeneration')
    || recovery.get('nextCommitment') !== owner.get('recoveryCommitment')) throw new Error('recourse_restoration_recovery_required');
  const destination: unknown = recovery.get('destination');
  if (typeof destination !== 'string' || !/^0x[0-9a-f]{40}$/.test(destination)) throw new Error('recourse_restoration_destination_invalid');
  const bindings = addresses.docs.filter(doc => doc.get('chainBindingStatus') === 'confirmed').map(doc => doc.data() as RegisteredAddress);
  const destinationBinding = bindings.find(binding => binding.address === destination);
  if (!destinationBinding || destinationBinding.recoveryGeneration !== owner.get('recoveryGeneration')) throw new Error('recourse_restoration_destination_invalid');
  // The loss belongs to its original kernel and block. Rebuilding it from
  // current bindings would change the occurrence or mix retired and live rails.
  const requestId = input.restorationRequestId, ref = db.collection(RESTORATION_REQUESTS).doc(requestId);
  const prior = await ref.get();
  if (!prior.exists) throw Error('recourse_restoration_scope_unverified');
  const scope = parseRestorationScope(prior.get('scope')), exact: unknown = prior.get('evidence');
  if (prior.get('identity') !== authenticatedIdentity || scope.request !== requestId || typeof exact !== 'string'
    || scope.lossHash !== `0x${createHash('sha256').update(exact).digest('hex')}`
    || !isDeepStrictEqual(JSON.parse(exact), { snapshot: prior.get('snapshot'), membership: prior.get('membership') })) {
    throw Error('recourse_restoration_request_conflict');
  }
  const original: unknown = JSON.parse(exact);
  if (!original || typeof original !== 'object' || !('snapshot' in original) || !('membership' in original)) throw Error('recourse_restoration_request_conflict');
  const snapshot = original.snapshot as LossSnapshot, retainedMembership = original.membership as LossMembershipEvidence;
  if (!snapshot || snapshot.identity !== authenticatedIdentity || snapshot.occurrence !== requestId
    || snapshot.transactionHash !== input.transactionHash || snapshot.block !== input.block || snapshot.lossAtomic !== scope.maximumLoss
    || !/^0x[0-9a-f]{40}$/.test(snapshot.kernel) || !hash.test(snapshot.blockHash) || !Array.isArray(snapshot.addresses)
    || !retainedMembership?.active || retainedMembership.periodIndex === null) throw Error('recourse_restoration_request_conflict');
  if (snapshot.addresses.some(address => address.address === destination)) throw Error('recourse_restoration_destination_not_fresh');
  if (!hash.test(String(prior.get('authorizationTxHash')))
    || ['prepared', 'authorization_queued', 'authorization_failed'].includes(String(prior.get('status')))) throw Error('recourse_restoration_scope_unverified');
  const [membership, pool] = await Promise.all([ports.membership(db, snapshot), ports.pool(authenticatedIdentity)]);
  if (!membership.active || membership.periodIndex === null) throw Error('recourse_restoration_not_member_at_loss');
  const readTicket = ports.ticket ?? ((_kernel: string, request: string) =>
    import('./current-restoration-ticket').then(module => module.readCurrentRestorationTicket(request)));
  const ticket = await readTicket(snapshot.kernel, requestId);
  if (ticket.identity !== authenticatedIdentity || ticket.currentDestination !== destination
    || ticket.destination !== prior.get('destination') || ticket.request !== scope.request
    || ticket.lossHash !== scope.lossHash || ticket.maximumLoss !== scope.maximumLoss) throw Error('recourse_restoration_scope_unverified');
  const continuation = prior.get('authorizationTxHash') !== recovery.get('authorizationTxHash') ? ticket : null;
  if (continuation && prior.get('destination') === destination) throw Error('recourse_restoration_scope_unverified');
  return db.runTransaction(async tx => {
    const [existing, currentOwner, currentRecovery, currentDestination] = await Promise.all([
      tx.get(ref), tx.get(ownerRef), tx.get(recoveryRef),
      tx.get(db.collection(RECOURSE_COLLECTIONS.addresses).doc(destination)),
    ]);
    if (!existing.exists || !hash.test(String(existing.get('authorizationTxHash')))
      || (continuation ? existing.get('authorizationTxHash') !== prior.get('authorizationTxHash')
        : existing.get('authorizationTxHash') !== currentRecovery.get('authorizationTxHash'))
      || ['prepared', 'authorization_queued', 'authorization_failed'].includes(String(existing.get('status')))) {
      throw new Error('recourse_restoration_scope_unverified');
    }
    const scope = parseRestorationScope(existing.get('scope'));
    if (existing.get('evidence') !== exact || !isDeepStrictEqual(existing.get('scope'), prior.get('scope'))
      || !isDeepStrictEqual(existing.get('snapshot'), prior.get('snapshot')) || !isDeepStrictEqual(existing.get('membership'), prior.get('membership'))
      || existing.get('identity') !== authenticatedIdentity || existing.get('transactionHash') !== input.transactionHash
      || existing.get('block') !== input.block || scope.request !== requestId
      || scope.lossHash !== existing.get('evidenceHash')) throw new Error('recourse_restoration_request_conflict');
    if (currentOwner.get('recoveryGeneration') !== recovery.get('generation')
      || currentOwner.get('recoveryCommitment') !== recovery.get('nextCommitment')
      || currentRecovery.get('authorizationTxHash') !== recovery.get('authorizationTxHash')
      || currentRecovery.get('destination') !== destination || currentDestination.get('bindingDigest') !== destinationBinding.bindingDigest) {
      throw new Error('recourse_restoration_identity_changed');
    }
    if (existing.get('destination') !== (continuation?.destination ?? destination)) throw new Error('recourse_restoration_destination_invalid');
    tx.update(ref, { recoveryRequestId: input.recoveryRequestId, observedOutcomeRevision: pool.outcomeRevision,
      ...(continuation ? { recoveryDestination: destination } : {}) });
    return { requestId, status: String(existing.get('status')) };
  });
}

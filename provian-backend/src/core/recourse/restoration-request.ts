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
  readonly transactionHash: string; readonly block: number; readonly recoveryRequestId: string;
}
export interface RestorationEvidencePorts {
  snapshot(identity: string, transactionHash: string, block: number, bindings: readonly RegisteredAddress[]): Promise<LossSnapshot>;
  membership(db: Firestore, snapshot: LossSnapshot): Promise<LossMembershipEvidence & { readonly lossTimestamp: number }>;
  pool(identity: string): Promise<RecoursePoolState>;
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
  const lossHash = `0x${createHash('sha256').update(JSON.stringify({ snapshot, membership })).digest('hex')}`;
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
      scope, snapshot, membership, evidenceHash: lossHash, status: 'prepared', createdAtMs: Date.now() });
  });
  return { ...scope, kernel: snapshot.kernel };
}

/** Submission records a request, not an entitlement or a self-attested PE. The
 * operator's later determination must consume the evidence and prior outcomes.
 * The complete portfolio is read here; a requester cannot omit bound addresses. */
export async function submitRestorationRequest(db: Firestore, authenticatedIdentity: string,
  input: RestorationRequestInput, ports: RestorationEvidencePorts = defaultPorts): Promise<{ requestId: string; status: string }> {
  const hash = /^0x[0-9a-f]{64}$/;
  if (!hash.test(authenticatedIdentity) || !input || !hash.test(input.transactionHash) || !hash.test(input.recoveryRequestId)
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
  const snapshot = await ports.snapshot(authenticatedIdentity, input.transactionHash, input.block, bindings);
  if (snapshot.addresses.some(address => address.address === destination)) throw new Error('recourse_restoration_destination_not_fresh');
  const [membership, pool] = await Promise.all([ports.membership(db, snapshot), ports.pool(authenticatedIdentity)]);
  if (!membership.active || membership.periodIndex === null) throw new Error('recourse_restoration_not_member_at_loss');
  const requestId = snapshot.occurrence;
  const ref = db.collection(RESTORATION_REQUESTS).doc(requestId);
  return db.runTransaction(async tx => {
    const [existing, currentOwner, currentRecovery, currentDestination] = await Promise.all([
      tx.get(ref), tx.get(ownerRef), tx.get(recoveryRef),
      tx.get(db.collection(RECOURSE_COLLECTIONS.addresses).doc(destination)),
    ]);
    if (!existing.exists || !hash.test(String(existing.get('authorizationTxHash')))
      || existing.get('authorizationTxHash') !== currentRecovery.get('authorizationTxHash')
      || ['prepared', 'authorization_queued', 'authorization_failed'].includes(String(existing.get('status')))) {
      throw new Error('recourse_restoration_scope_unverified');
    }
    const scope = parseRestorationScope(existing.get('scope'));
    if (existing.get('identity') !== authenticatedIdentity || existing.get('transactionHash') !== input.transactionHash
      || existing.get('block') !== input.block || scope.request !== requestId
      || scope.lossHash !== existing.get('evidenceHash')) throw new Error('recourse_restoration_request_conflict');
    if (currentOwner.get('recoveryGeneration') !== recovery.get('generation')
      || currentOwner.get('recoveryCommitment') !== recovery.get('nextCommitment')
      || currentRecovery.get('destination') !== destination || currentDestination.get('bindingDigest') !== destinationBinding.bindingDigest) {
      throw new Error('recourse_restoration_identity_changed');
    }
    if (existing.get('destination') !== destination) throw new Error('recourse_restoration_destination_invalid');
    tx.update(ref, { recoveryRequestId: input.recoveryRequestId, observedOutcomeRevision: pool.outcomeRevision });
    return { requestId, status: String(existing.get('status')) };
  });
}

import { concat, sha256 } from 'ethers';
import { isDeepStrictEqual } from 'util';
import { createHash } from 'crypto';
import { RESTORATION_REQUESTS } from './restoration-request';
import type { Firestore } from 'firebase-admin/firestore';
import { RECOURSE_COLLECTIONS } from './ownership';
import { OWNER_OPERATIONS } from './owner-operation-queue';
import { parseRecoveryOwnerOperation, recoveryOperationId, parseRestorationScope, type RestorationScope, type RecoveryOwnerOperation } from './owner-operation';
import { findExecutedOwnerOperation } from './owner-operation-executed';

export interface OwnerRecoveryDiscovery {
  readonly identity: string; readonly nonce: number; readonly relayCommitment: string;
  readonly candidates: readonly { readonly operation: RecoveryOwnerOperation; readonly transactionHash: string; readonly completedRequestId?: string; readonly restorationEvidence?: string; readonly continuations?: readonly { scope: RestorationScope; evidence: string }[] }[];
}
/** Private, single-binding discovery for a restored backup. Returned calldata
 * is an untrusted witness; the client verifies its exact finalized receipt and
 * both seed-derived key domains before resuming a credential transition. */
export async function discoverOwnerRecovery(db: Firestore, identity: string, nonce: string,
  executed = findExecutedOwnerOperation): Promise<OwnerRecoveryDiscovery> {
  if (!/^0x[0-9a-f]{64}$/.test(identity) || !/^(0|[1-9][0-9]*)$/.test(nonce)
    || !Number.isSafeInteger(Number(nonce)) || Number(nonce) >= Number.MAX_SAFE_INTEGER) throw Error('recourse_owner_discovery_invalid');
  const owner = await db.collection(RECOURSE_COLLECTIONS.identities).doc(identity).get();
  const commitment: unknown = owner.get('recoveryCommitment');
  if (!owner.exists || owner.get('identity') !== identity || typeof commitment !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(commitment)) throw Error('recourse_owner_discovery_invalid');
  const rows = await db.collection(OWNER_OPERATIONS).where('identity', '==', identity).get();
  const candidates: Array<{ operation: RecoveryOwnerOperation; transactionHash: string; completedRequestId?: string; restorationEvidence?: string; continuations?: readonly { scope: RestorationScope; evidence: string }[] }> = [];
  for (const row of rows.docs) {
    const operation = parseRecoveryOwnerOperation(row.get('operation'));
    if (operation.identity !== identity || recoveryOperationId(operation) !== row.id) throw Error('recourse_owner_discovery_record_changed');
    if (operation.nonce !== Number(nonce)) continue;
    let transactionHash: unknown = row.get('transactionHash');
    if (row.get('status') !== 'confirmed') {
      const executor: unknown = row.get('executor'), queued: unknown = row.get('queuedAtBlockHash');
      if (typeof executor !== 'string' || typeof queued !== 'string') throw Error('recourse_owner_discovery_record_changed');
      const found = await executed(operation, executor, queued);
      if (!found || found.superseded) continue;
      transactionHash = found.transactionHash;
    }
    if (typeof transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(transactionHash)) throw Error('recourse_owner_discovery_record_changed');
    let restorationEvidence: string | undefined;
    if (operation.restoration) {
      const loss = await db.collection(RESTORATION_REQUESTS).doc(operation.restoration.request).get();
      const snapshot: unknown = loss.get('snapshot'), membership: unknown = loss.get('membership');
      if (!loss.exists || loss.get('identity') !== identity || !snapshot || typeof snapshot !== 'object'
        || !('transactionHash' in snapshot) || !('block' in snapshot) || !('occurrence' in snapshot) || !('lossAtomic' in snapshot)
        || snapshot.transactionHash !== loss.get('transactionHash') || snapshot.block !== loss.get('block')
        || snapshot.occurrence !== operation.restoration.request || snapshot.lossAtomic !== operation.restoration.maximumLoss) throw Error('recourse_owner_discovery_loss_changed');
      const exact: unknown = loss.get('evidence');
      if (typeof exact !== 'string' || `0x${createHash('sha256').update(exact).digest('hex')}` !== operation.restoration.lossHash
        || !isDeepStrictEqual(JSON.parse(exact), { snapshot, membership })) throw Error('recourse_owner_discovery_loss_changed');
      restorationEvidence = exact;
    }
    let completedRequestId: string | undefined;
    if (operation.proof.nextCommitment === commitment) {
      const recoveries = await db.collection(RECOURSE_COLLECTIONS.recoveries).where('identity', '==', identity).get();
      for (const recovery of recoveries.docs) {
        if (recovery.get('authorizationTxHash') !== transactionHash || recovery.get('nextCommitment') !== commitment) continue;
        if (!/^0x[0-9a-f]{64}$/.test(recovery.id) || recovery.get('destination') !== operation.destination
          || recovery.get('nextSigningRoot') !== operation.proof.nextSigningRoot
          || recovery.get('consumedCommitment') !== sha256(concat([operation.proof.recoverySecret, operation.proof.signingRoot]))
          || completedRequestId) throw Error('recourse_owner_discovery_recovery_changed');
        completedRequestId = recovery.id;
      }
      if (!completedRequestId) throw Error('recourse_owner_discovery_recovery_missing');
    }
    const continuations: Array<{ scope: RestorationScope; evidence: string }> = [];
    if (!operation.restoration) {
      const requests = await db.collection(RESTORATION_REQUESTS).where('identity', '==', identity).get();
      for (const request of requests.docs) {
        if (!/^0x[0-9a-f]{64}$/.test(String(request.get('authorizationTxHash')))) continue;
        const scope = parseRestorationScope(request.get('scope')), evidence: unknown = request.get('evidence');
        if (scope.request !== request.id || typeof evidence !== 'string'
          || `0x${createHash('sha256').update(evidence).digest('hex')}` !== scope.lossHash
          || !isDeepStrictEqual(JSON.parse(evidence), { snapshot: request.get('snapshot'), membership: request.get('membership') })) throw Error('recourse_owner_discovery_loss_changed');
        continuations.push({ scope, evidence });
      }
    }
    candidates.push({ operation, transactionHash, ...(completedRequestId ? { completedRequestId } : {}), ...(continuations.length ? { continuations } : {}), ...(restorationEvidence === undefined ? {} : { restorationEvidence }) });
  }
  return { identity, nonce: Number(nonce), relayCommitment: commitment, candidates };
}

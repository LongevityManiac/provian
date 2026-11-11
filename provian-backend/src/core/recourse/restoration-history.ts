import type { Firestore } from 'firebase-admin/firestore';
import { sha256, toUtf8Bytes } from 'ethers';
import { isDeepStrictEqual } from 'util';
import { RECOURSE_COLLECTIONS } from './ownership';
import { RESTORATION_REQUESTS } from './restoration-request';
import { parseRestorationScope, type RestorationScope } from './owner-operation';

/** Single-binding, private candidates across every protocol generation.
 * Preparation is not authorization: clients must check the surviving chain. */
export async function discoverRestorationHistory(db: Firestore, identity: string): Promise<{
  identity: string; candidates: { scope: RestorationScope; evidence: string }[];
}> {
  if (!/^0x[0-9a-f]{64}$/.test(identity)) throw Error('recourse_restoration_history_invalid');
  const owner = await db.collection(RECOURSE_COLLECTIONS.identities).doc(identity).get();
  if (!owner.exists || owner.get('identity') !== identity) throw Error('recourse_restoration_history_invalid');
  const rows = await db.collection(RESTORATION_REQUESTS).where('identity', '==', identity).get();
  const candidates: { scope: RestorationScope; evidence: string }[] = [];
  for (const row of rows.docs) {
    const scope = parseRestorationScope(row.get('scope')), evidence: unknown = row.get('evidence');
    const snapshot: unknown = row.get('snapshot');
    if (row.get('identity') !== identity || scope.request !== row.id || typeof evidence !== 'string'
      || sha256(toUtf8Bytes(evidence)) !== scope.lossHash
      || !isDeepStrictEqual(JSON.parse(evidence), { snapshot, membership: row.get('membership') })
      || !snapshot || typeof snapshot !== 'object' || !('identity' in snapshot) || snapshot.identity !== identity
      || !('occurrence' in snapshot) || snapshot.occurrence !== scope.request
      || !('lossAtomic' in snapshot) || snapshot.lossAtomic !== scope.maximumLoss
      || !('transactionHash' in snapshot) || snapshot.transactionHash !== row.get('transactionHash')
      || typeof snapshot.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(snapshot.transactionHash)
      || !('block' in snapshot) || snapshot.block !== row.get('block') || typeof snapshot.block !== 'number'
      || !Number.isSafeInteger(snapshot.block) || snapshot.block < 1) throw Error('recourse_restoration_history_changed');
    candidates.push({ scope, evidence });
  }
  return { identity, candidates };
}

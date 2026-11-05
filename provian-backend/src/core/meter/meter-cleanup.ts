import type { Firestore } from 'firebase-admin/firestore';
import { METER_ANCHOR_DAYS_COLLECTION, METER_BATCHES_COLLECTION } from './meter-store';

/** Operator cleanup must preserve batches until proof completion. This is an
 * integrity guard, not authorization to delete owner data. The shared day read
 * fences concurrent anchor selection and deletion in the same transaction. */
export async function deleteMeterBatchForCleanup(db: Firestore, batchHash: string): Promise<boolean> {
  return db.runTransaction(async txn => {
    const ref = db.collection(METER_BATCHES_COLLECTION).doc(batchHash);
    const batch = (await txn.get(ref)).data();
    if (!batch) return false;
    if (batch.anchored !== true || typeof batch.day !== 'string') throw new Error('meter_cleanup_batch_not_anchored');
    const day = (await txn.get(db.collection(METER_ANCHOR_DAYS_COLLECTION).doc(batch.day))).data();
    if (!day || day.selection || (day.status !== 'anchored' && day.status !== 'empty')
      || (day.status === 'anchored' && day.proofs_complete !== true)) throw new Error('meter_cleanup_anchor_incomplete');
    txn.delete(ref);
    return true;
  });
}

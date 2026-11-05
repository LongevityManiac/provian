import { removeIndexedMeterClaims, updateIndexedReadiness } from './pending-claim-index';
import type { DocumentSnapshot, Firestore, Transaction } from 'firebase-admin/firestore';
import { expireAt, METER_BATCHES_COLLECTION, METER_KEY_LIFETIME_MS, METER_SETTLED_CLAIM_LIFETIME_MS, type MeterPendingClaim } from './meter-store';
import type { MeterActKeyDoc } from './meter-act-key';

/** Prepare every read before the takeover writes. Old keys retain their original TTL. */
export async function prepareDemotedMeterRetention(db: Firestore, txn: Transaction,
  snaps: readonly DocumentSnapshot[], overrides: ReadonlyMap<string, MeterPendingClaim>, nowMs: number): Promise<() => void> {
  const keys = snaps.filter(s => s.data()?.pending_retention_v1 === true);
  const writes: (() => unknown)[] = [];
  for (const claim of overrides.values()) {
    if (claim.state === 'void') writes.push(() => removeIndexedMeterClaims(db, txn, [claim]));
    else if (claim.state === 'pending') writes.push(() => updateIndexedReadiness(db, txn, claim));
  }
  for (const snap of keys) {
    const key = snap.data() as MeterActKeyDoc;
    const at = Math.max(key.created_at_ms + METER_KEY_LIFETIME_MS, nowMs + METER_SETTLED_CLAIM_LIFETIME_MS);
    writes.push(() => txn.update(db.collection('meter_act_keys_v1').doc(snap.id), { expire_at: expireAt(at) }));
  }
  for (const hash of new Set(keys.map(s => String(s.data()!.batch_hash)))) {
    const ref = db.collection(METER_BATCHES_COLLECTION).doc(hash), batch = (await txn.get(ref)).data();
    if (batch?.per_batch_pricing !== true) continue;
    const claims = await txn.get(db.collection('meter_pending_claims_v1').where('batch_hash', '==', hash));
    const complete = claims.docs.every(s => ['settled', 'void'].includes(String((overrides.get(s.id) ?? s.data()).state)));
    const waiting = complete && batch.anchored === true
      ? await txn.get(db.collection('pe_mailbox_v1').where('batch_hash', '==', hash).limit(1)) : null;
    writes.push(() => txn.update(ref, { settlement_complete: complete,
      expire_at: complete && batch.anchored === true && waiting?.empty ? expireAt(nowMs + METER_SETTLED_CLAIM_LIFETIME_MS) : null }));
  }
  return () => { for (const write of writes) write(); };
}

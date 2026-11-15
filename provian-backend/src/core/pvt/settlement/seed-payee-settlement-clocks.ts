import type { Firestore } from 'firebase-admin/firestore';
import { scanQueryUnordered } from '../../provenance/query-pages';
import { decodeSettlementCalldata } from './batch-approval';
import { PAYEE_SETTLEMENT_CLOCK_COLLECTION } from './payee-settlement-interval';
import type { SettlementBatchDoc } from './durable-settlement-store';

/** Initializes interval clocks for quiet pre-cutover payees too. No act, ledger, sealed snapshot
 * or batch is changed. Retained application timestamps win; older payments use their verified
 * canonical chain time. A concurrently confirmed payment's clock always wins this initialization.
 */
export async function seedPayeeSettlementClocks(db: Firestore,
  confirmedTime: (batch: SettlementBatchDoc) => Promise<number | null>, nowMs = Date.now()): Promise<{ payees: number; added: number }> {
  const retained = new Map<string, number>();
  await scanQueryUnordered(db.collection('pvt9_claim_ledger_v1').where('lane', '==', 'standard').where('settled', '==', true), 250, async doc => {
    const row = doc.data();
    if (typeof row.settled_batch_id !== 'string' || !Number.isSafeInteger(row.settled_at) || row.settled_at < 0) throw new Error('payee_clock_legacy_time_invalid');
    retained.set(row.settled_batch_id, Math.max(retained.get(row.settled_batch_id) ?? 0, Number(row.settled_at)));
  });
  const latest = new Map<string, { time: number; batchId: string }>();
  await scanQueryUnordered(db.collection('pvt9_settlement_batches_v1').where('lane', '==', 'standard')
    .where('status', '==', 'confirmed').where('applied', '==', true), 250, async doc => {
    const batch = doc.data() as SettlementBatchDoc;
    const decoded = decodeSettlementCalldata(batch.calldata);
    if (decoded.kind !== 'standard' || decoded.header.batchId.toLowerCase() !== batch.batch_id.toLowerCase()) throw new Error('payee_clock_legacy_batch_invalid');
    const chainTime = await confirmedTime(batch);
    if (chainTime === null) return; // preserved superseded-token payments do not set the live token's clock
    const time = batch.settled_at_ms ?? retained.get(batch.batch_id) ?? chainTime;
    if (!Number.isSafeInteger(time) || time < 0 || time > nowMs) throw new Error('payee_clock_legacy_time_invalid');
    for (const recipient of decoded.recipients) {
      const payee = recipient.contributor.toLowerCase();
      if (!/^0x[a-f0-9]{40}$/.test(payee)) throw new Error('payee_clock_legacy_payee_invalid');
      if (time > (latest.get(payee)?.time ?? -1)) latest.set(payee, { time, batchId: batch.batch_id });
    }
  });
  let added = 0;
  for (const [payee, last] of latest) {
    const ref = db.collection(PAYEE_SETTLEMENT_CLOCK_COLLECTION).doc(payee);
    const created = await db.runTransaction(async txn => {
      if ((await txn.get(ref)).exists) return false;
      txn.create(ref, { payee, batch_id: last.batchId, last_settled_at_ms: last.time }); return true;
    });
    if (created) added++;
  }
  await db.collection('pvt9_payee_clock_seed_v1').doc('live').set({ complete: true, at_ms: nowMs, payees: latest.size, added });
  return { payees: latest.size, added };
}

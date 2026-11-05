import { createIndexedMeterClaim } from './pending-claim-index';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../pe-history';
import type { EconomicAggregateWriter } from '../pvt/policy/economic-aggregate';
import { privateRetentionCollection } from '../provenance/private-retention';
import { isSingleLaneActType } from './act-witness-lanes';
import { batchEconomicTotals, applyBatchEconomicTotals } from './batch-economics';
import { aggregateBatchClaims, type MeterActLeg } from './meter-claims';
import { outputTrustKey, type MeterActKeyDoc } from './meter-act-key';
import { outcomeFromKey } from './meter-seal';
import { expireAt, METER_KEY_LIFETIME_MS, METER_SETTLED_CLAIM_LIFETIME_MS } from './meter-store';

/** Only new relay-only holds compact on resolution. Historical keys and snapshots stay put. */
export async function prepareRelayHeldCompaction(db: Firestore, txn: Transaction, key: MeterActKeyDoc,
  after: Record<string, unknown>, legs: readonly MeterActLeg[] | null, nowMs: number,
): Promise<null | { apply(writer: EconomicAggregateWriter): void; write(): void }> {
  if (!key.device_id.startsWith('relay:') || !isSingleLaneActType(key.action_type)) return null;
  const batchRef = db.collection('meter_batches_v1').doc(key.batch_hash), batch = (await txn.get(batchRef)).data();
  if (batch?.relay_single_lane !== true) return null;
  if (batch.act_count !== 1 || batch.per_batch_pricing !== true || !Array.isArray(batch.claim_keys) || batch.claim_keys.length
    || !Array.isArray(batch.economic_totals) || batch.economic_totals.length) throw new Error('relay_held_batch_state_invalid');
  const paying = after.mint_status === 'eligible' && legs !== null && legs.length > 0;
  const claims = paying ? aggregateBatchClaims({ batch_hash: key.batch_hash, device_id: key.device_id,
    actor_id: key.actor_id, created_at_ms: nowMs, acts: [{ relay_pe_id: key.relay_pe_id, legs }] }) : [];
  const claimRefs = claims.map(c => db.collection('meter_pending_claims_v1').doc(c.claim_key));
  const exists = await Promise.all(claimRefs.map(ref => txn.get(ref)));
  if (exists.some(s => s.exists)) throw new Error('relay_held_claim_already_exists');
  const output = Array.isArray(after.output_digests) && after.output_digests.length > 0;
  const resolved: MeterActKeyDoc = { ...key, row: after, legs: paying ? [...legs!] : null, unit: paying ? 'batch' : 'none', held_reason: null,
    expire_at: paying ? null : expireAt(Math.max(key.created_at_ms + METER_KEY_LIFETIME_MS, nowMs + METER_SETTLED_CLAIM_LIFETIME_MS)) };
  const totals = !output && paying ? batchEconomicTotals([{ ...outcomeFromKey(resolved, false), key: resolved, home: 'batch' }], nowMs) : [];
  const waiting = claims.length === 0 && batch.anchored === true
    ? await txn.get(db.collection('pe_mailbox_v1').where('batch_hash', '==', key.batch_hash).limit(1)) : null;
  return {
    apply(writer): void {
      if (!output) {
        writer.detachRetainedProjection(after as unknown as PEHistoryDocument);
        applyBatchEconomicTotals(writer, totals, 1, false);
      }
    },
    write(): void {
      const ref = privateRetentionCollection(db, 'meter_act_keys_v1').doc(key.relay_pe_id);
      if (output) txn.set(ref, outputTrustKey(resolved)); else txn.delete(ref);
      claims.forEach((claim, i) => createIndexedMeterClaim(db, txn, claimRefs[i], claim));
      txn.update(batchRef, { ...(!output && Array.isArray(batch.key_page_ids) ? { key_page_ids: [] } : {}), retained_act_ids: output ? [key.relay_pe_id] : [], claim_keys: claims.map(c => c.claim_key),
        economic_totals: totals, economic_claim_keys: totals.length ? claims.map(c => c.claim_key) : [], economic_paid_claim_keys: [],
        economic_settled: totals.length === 0, settlement_complete: claims.length === 0,
        expire_at: claims.length === 0 && batch.anchored === true && waiting?.empty ? expireAt(nowMs + METER_SETTLED_CLAIM_LIFETIME_MS) : null });
    },
  };
}

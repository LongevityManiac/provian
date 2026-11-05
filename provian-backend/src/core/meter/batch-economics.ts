import type { Firestore } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../pe-history';
import { EconomicAggregateWriter, rowContribution, rowIdentityKeys, type AggregateRole } from '../pvt/policy/economic-aggregate';
import { expireAt, METER_SETTLED_CLAIM_LIFETIME_MS, METER_BATCHES_COLLECTION, type MeterPendingClaim } from './meter-store';
import type { MeterActOutcome } from './meter-seal';

export interface BatchEconomicTotal {
  readonly identity: string;
  readonly role: AggregateRole;
  readonly category: string;
  readonly count: number;
  readonly rated: string;
  readonly fixed: string;
}

/** Compact sums of already verified pricing inputs; no act identities, bodies or snapshots. */
export function batchEconomicTotals(outcomes: readonly MeterActOutcome[], atMs: number): BatchEconomicTotal[] {
  const sums = new Map<string, BatchEconomicTotal>();
  for (const outcome of outcomes) {
    if (outcome.home !== 'batch' || outcome.row.mint_status !== 'eligible') continue;
    const row = outcome.row as unknown as PEHistoryDocument;
    for (const { identity, role } of rowIdentityKeys(row)) {
      const contribution = rowContribution(row, role, atMs);
      if (contribution.integrityFailure || contribution.settlementInput === null) throw new Error('batch_economic_input_invalid');
      const key = JSON.stringify([identity, role, contribution.category]);
      const old = sums.get(key);
      sums.set(key, { identity, role, category: contribution.category, count: (old?.count ?? 0) + 1,
        rated: (BigInt(old?.rated ?? '0') + contribution.settlementInput.rated).toString(),
        fixed: (BigInt(old?.fixed ?? '0') + contribution.settlementInput.fixed).toString() });
    }
  }
  return [...sums.values()];
}

export function applyBatchEconomicTotals(writer: EconomicAggregateWriter, totals: readonly BatchEconomicTotal[],
  sign: 1 | -1, moveStatus: boolean): void {
  for (const t of totals) writer.applyBatchPending(t.identity, t.role, t.category,
    BigInt(t.rated), BigInt(t.fixed), t.count, sign, moveStatus);
}

/** Each batch's completion is tracked once, independently of expiring member claims. */
export async function noteBatchClaimSettlement(db: Firestore, claim: Pick<MeterPendingClaim, 'unit' | 'batch_hash' | 'claim_key'>, settled: boolean, nowMs: number): Promise<number> {
  if (claim.unit === 'payout') return 0;
  const ref = db.collection(METER_BATCHES_COLLECTION).doc(claim.batch_hash);
  return db.runTransaction(async txn => {
    const snap = await txn.get(ref);
    const batch = snap.data();
    if (!batch || batch.per_batch_pricing !== true) return 0;
    const totals = batch.economic_totals as BatchEconomicTotal[];
    const keys = batch.economic_claim_keys as string[];
    if (!Array.isArray(totals) || !Array.isArray(keys)) throw new Error('batch_economic_state_invalid');
    const paid = new Set<string>((batch.economic_paid_claim_keys ?? []) as string[]);
    if (keys.includes(claim.claim_key)) { if (settled) paid.add(claim.claim_key); else paid.delete(claim.claim_key); }
    const complete = keys.every(k => paid.has(k));
    const wasComplete = batch.economic_settled === true;
    const allClaims = await txn.get(db.collection('meter_pending_claims_v1').where('batch_hash', '==', claim.batch_hash));
    const allComplete = settled && allClaims.docs.every(doc => doc.id === claim.claim_key || ['settled', 'void'].includes(String(doc.data().state)));
    const waiting = allComplete && batch.anchored === true
      ? await txn.get(db.collection('pe_mailbox_v1').where('batch_hash', '==', claim.batch_hash).limit(1)) : null;
    const writer = new EconomicAggregateWriter(db, txn, nowMs);
    if (complete !== wasComplete) await writer.load(totals.map(t => t.identity));
    if (complete !== wasComplete) {
      applyBatchEconomicTotals(writer, totals, complete ? -1 : 1, true);
      writer.commit();
    }
    txn.update(ref, { economic_paid_claim_keys: [...paid].sort(), economic_settled: complete, settlement_complete: allComplete,
      expire_at: allComplete && batch.anchored === true && waiting?.empty ? expireAt(nowMs + METER_SETTLED_CLAIM_LIFETIME_MS) : null });
    return complete && !wasComplete ? totals.filter(t => t.role === 'contributor').reduce((sum, t) => sum + t.count, 0) : 0;
  });
}

/** Retry jurisdiction blocks and missing compliance evidence at the act's sealed value. */
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import { complianceForRow } from '../jurisdiction/mint-compliance';
import { isTerminalCompliance } from '../jurisdiction/compliance-state';
import { hashRecordEconomicSnapshot, type RecordEconomicSnapshot } from './policy/monetary-accounting';
import { walkHeldActs, HELD_ACT_SWEEP_CURSOR_COLLECTION } from './held-act-sweep';
import { mutatePeHistoryRowWithAggregate } from './policy/economic-aggregate';

export async function recoverComplianceHolds(db: Firestore, nowMs = Date.now()): Promise<{ scanned: number; resolved: number }> {
  let resolved = 0;
  const recover = async (id: string, row: Record<string, unknown>): Promise<void> => {
    const compliance = await complianceForRow(row, db);
    if (compliance.policy === 'blocked' && !isTerminalCompliance(compliance)) {
      if (compliance.reason === 'jurisdiction_blocked' && row.jurisdiction_compliance_reason !== 'jurisdiction_blocked') {
        await mutatePeHistoryRowWithAggregate(db, id, {
          jurisdiction_compliance_reason: 'jurisdiction_blocked', disposition_reason_code: 'jurisdiction_blocked',
          jurisdiction_context: compliance.deferred_context ?? compliance.actor_country ?? 'UNKNOWN',
          jurisdiction_region: compliance.actor_region,
        }, { nowMs, expect: before => before.mint_status === 'pending_compliance' });
      }
      return;
    }
    const snapshot = row.economic_snapshot as RecordEconomicSnapshot | undefined;
    let exact = false;
    try {
      exact = !!snapshot && hashRecordEconomicSnapshot(snapshot) === row.economic_snapshot_hash
        && snapshot.peId === id && snapshot.economicActorId === row.userId
        && snapshot.actionType === row.actionType && snapshot.recordedAtMs === row.timestamp
        && snapshot.mintDisposition === 'eligible';
    } catch { /* Invalid evidence never promotes. */ }
    const status = isTerminalCompliance(compliance) ? 'ineligible'
      : !exact ? 'record_only' : compliance.policy === 'deferred' ? 'deferred' : 'eligible';
    const points = status === 'eligible' && snapshot ? snapshot.recordPointsAtomic : '0';
    const patch: Record<string, unknown> = {
      mint_status: status,
      mint_disposition: status === 'ineligible' ? 'ineligible_terminal' : status === 'deferred' ? 'jurisdiction_deferred' : status,
      disposition_reason_code: status === 'ineligible' ? 'policy_ineligible'
        : status === 'record_only' ? 'unverifiable_evidence_record_only'
        : status === 'deferred' ? 'jurisdiction_deferred' : 'policy_eligible',
      estimatedPVT: Number(BigInt(points)) / 1e18,
      estimated_pvt_atomic: points,
      economic_eligibility_projection: null,
      jurisdiction_compliance_reason: compliance.reason,
      jurisdiction_context: compliance.deferred_context ?? compliance.actor_country ?? 'UNKNOWN',
      jurisdiction_region: compliance.actor_region,
      ...(status === 'deferred' ? { deferred_since: nowMs } : {}),
    };
    const result = await mutatePeHistoryRowWithAggregate(db, id, patch, {
      nowMs, expect: before => before.mint_status === 'pending_compliance',
    });
    if (result.outcome === 'applied') resolved++;
  };
  const walk = await walkHeldActs(db, 'pending_compliance', {
    cursor: { collection: HELD_ACT_SWEEP_CURSOR_COLLECTION, docId: 'pending_compliance' }, nowMs,
  }, held => recover(held.relayPeId, held.row));
  // Newly written legacy rows use the same status. Existing terminal denials are never reopened.
  const cursorRef = db.collection(HELD_ACT_SWEEP_CURSOR_COLLECTION).doc('pending_compliance_legacy');
  const cursor = (await cursorRef.get()).data()?.last_pe_id;
  const query = db.collection('pe_history').where('mint_status', '==', 'pending_compliance').orderBy(FieldPath.documentId());
  let legacy = await (typeof cursor === 'string' ? query.startAfter(cursor) : query).limit(100).get();
  if (legacy.empty && typeof cursor === 'string') legacy = await query.limit(100).get();
  for (const doc of legacy.docs) await recover(doc.id, doc.data());
  await cursorRef.set({ last_pe_id: legacy.size === 100 ? legacy.docs[legacy.size - 1].id : null, updated_at_ms: nowMs });
  return { scanned: walk.scanned + legacy.size, resolved };
}

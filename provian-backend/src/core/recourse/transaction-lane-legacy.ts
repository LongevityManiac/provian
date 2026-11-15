import { Transaction, keccak256 } from 'ethers';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/settlement/durable-settlement-store';
import { RECOURSE_LANE_COLLECTION, laneQueuedFields, type LaneChain, type LaneKind, type LaneRow } from './transaction-lane';

/**
 * Requests left by the relay before Recourse had its own lane.
 *
 * Earlier, a Recourse transaction was signed by the settlement minter, one at a time,
 * with the request's id reserved on the minter's signer lease until the transaction
 * was final. Settlement refuses to run while that reservation stands, and a request
 * queued then carries no lane queue key. After the cutover nothing else clears either:
 *   - a reserved request whose minter-signed bytes have twelve confirmations is settled
 *     exactly as the lane settles its own, and the reservation is released with it;
 *   - one whose bytes are not yet mined is rebroadcast (the same bytes, never re-signed);
 *   - a reservation with no signed bytes behind it is released (nothing was broadcast);
 *   - a request still queued without a key is given one, so the lane sends it in order.
 * Once a check finds nothing for an hour, the old relay is long gone and checks stop.
 */
export const LEGACY_DRAIN_DOC = 'legacy-cutover';
const QUIET_FOR_MS = 60 * 60_000;
export interface LegacyDrainReport { skipped?: true; adopted: number; settled: number; released: number; rebroadcast: number; waiting: number; }

export async function drainLegacyRecourse(db: Firestore, kinds: readonly LaneKind[], chain: () => LaneChain, now: () => number = Date.now): Promise<LegacyDrainReport> {
  const report: LegacyDrainReport = { adopted: 0, settled: 0, released: 0, rebroadcast: 0, waiting: 0 };
  const marker = db.collection(RECOURSE_LANE_COLLECTION).doc(LEGACY_DRAIN_DOC);
  const stored: unknown = (await marker.get()).get('quietSinceMs');
  const quietSince = typeof stored === 'number' && Number.isSafeInteger(stored) ? stored : null;
  if (quietSince !== null && now() - quietSince >= QUIET_FOR_MS) { report.skipped = true; return report; }

  for (const kind of kinds) {
    const queued = await db.collection(kind.collection).where('status', '==', 'queued').limit(200).get();
    for (const doc of queued.docs) {
      if (doc.get('laneQueueKey') !== undefined || doc.get('signedTransaction') !== undefined) continue;
      const created = Number(doc.get('createdAtMs') ?? doc.get('queuedAtMs') ?? now());
      const adopted = await db.runTransaction(async tx => {
        const row = await tx.get(doc.ref);
        if (row.get('status') !== 'queued' || row.get('laneQueueKey') !== undefined || row.get('signedTransaction') !== undefined) return false;
        tx.update(doc.ref, laneQueuedFields(Number.isSafeInteger(created) ? created : now(), doc.id));
        return true;
      });
      if (adopted) report.adopted++;
    }
  }

  const leases = await db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).get();
  for (const lease of leases.docs) {
    const pending: unknown = lease.get('pending_operation'), signer = lease.id.toLowerCase();
    if (typeof pending !== 'string') continue;
    let found: { kind: LaneKind; row: LaneRow } | null = null;
    for (const kind of kinds) {
      const snap = await db.collection(kind.collection).doc(pending).get();
      if (snap.exists) { found = { kind, row: { collection: kind.collection, id: pending, data: snap.data() ?? {} } }; break; }
    }
    // A reservation another operator tool holds for its own record is left to that tool.
    if (!found || found.row.data.laneSigner !== undefined) continue;
    const { kind, row } = found, raw = row.data.signedTransaction;
    const recordRef = db.collection(kind.collection).doc(pending);
    const release = async (terminal?: Awaited<ReturnType<LaneKind['settle']>>) => db.runTransaction(async tx => {
      const [current, record] = await Promise.all([tx.get(lease.ref), tx.get(recordRef)]);
      if (current.get('pending_operation') !== pending || record.get('signedTransaction') !== raw) return false;
      if (terminal) {
        if (record.get('status') === 'confirmed' || record.get('status') === 'failed') return false;
        if (kind.onFinish) await kind.onFinish(tx, { ...row, data: record.data() ?? {} }, terminal);
        tx.update(recordRef, { ...(terminal.fields ?? {}), status: terminal.status, terminalReason: terminal.reason, finalizedAtMs: now(), laneQueueKey: FieldValue.delete() });
      }
      tx.update(lease.ref, { pending_operation: null });
      return true;
    });
    if (raw === undefined) { if (await release()) report.released++; continue; }
    if (typeof raw !== 'string' || row.data.transactionHash !== keccak256(raw)) throw Error('recourse_legacy_record_invalid');
    const tx = Transaction.from(raw), expected = kind.expected(row);
    if (tx.from?.toLowerCase() !== signer || tx.to?.toLowerCase() !== expected.executor.toLowerCase() || tx.data !== expected.calldata) throw Error('recourse_legacy_record_invalid');
    let receipt: Awaited<ReturnType<LaneChain['confirmed']>>;
    try { receipt = await chain().confirmed(raw); }
    catch (error) {
      if (error instanceof Error && error.message === 'recourse_transaction_not_finalized') { report.waiting++; continue; }
      throw error;
    }
    if (receipt === null) {
      report.waiting++;
      try { await chain().broadcast(raw); report.rebroadcast++; } catch { /* next run */ }
      continue;
    }
    if (await release(await kind.settle(row, receipt))) report.settled++;
  }

  const found = report.adopted + report.settled + report.released + report.waiting > 0;
  if (found) await marker.set({ quietSinceMs: null, lastFoundAtMs: now() }, { merge: true });
  else if (quietSince === null) await marker.set({ quietSinceMs: now() }, { merge: true });
  return report;
}

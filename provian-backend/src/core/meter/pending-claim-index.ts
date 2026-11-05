import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentData, DocumentReference, Firestore, SetOptions, Precondition } from 'firebase-admin/firestore';
import { encodePrivateRecord, decodePrivateRecord, privateStorageId } from '../provenance/private-store';
import { scanQueryUnordered } from '../provenance/query-pages';
import { isCarriedOverLegacyClaim } from './meter-claims';
import type { MeterPendingClaim } from './meter-store';

export const PENDING_PAYEES = 'meter_pending_payees_v1';
export const PENDING_READY = 'meter_pending_ready_v1';
export const PENDING_INDEX_COVERAGE = 'meter_pending_index_coverage_v1';
interface Writer {
  create(ref: DocumentReference, data: DocumentData): unknown;
  set(ref: DocumentReference, data: DocumentData, options: SetOptions): unknown;
  delete(ref: DocumentReference, precondition?: Precondition): unknown;
}
type IndexedClaim = MeterPendingClaim & { inlet_indexed_v1?: boolean };
function head(db: Firestore, contributor: string): DocumentReference {
  return db.collection(PENDING_PAYEES).doc(privateStorageId(PENDING_PAYEES, contributor.toLowerCase()));
}
function readyRef(db: Firestore, key: string): DocumentReference { return db.collection(PENDING_READY).doc(privateStorageId(PENDING_READY, key)); }
function entry(claim: MeterPendingClaim): DocumentData {
  const contributor = claim.contributor.toLowerCase();
  const ready = isCarriedOverLegacyClaim(claim) ? 0 : Math.max(claim.created_at_ms, claim.ready_at_ms);
  return { ...encodePrivateRecord(PENDING_READY, claim.claim_key, { claim_key: claim.claim_key, contributor, ready_at_ms: ready }),
    payee_tag: privateStorageId(PENDING_PAYEES, contributor), ready_at_ms: ready };
}
function counts(db: Firestore, writer: Writer, claims: readonly MeterPendingClaim[], sign: 1 | -1): void {
  const totals = new Map<string, number>();
  for (const claim of claims) { const payee = claim.contributor.toLowerCase(); totals.set(payee, (totals.get(payee) ?? 0) + sign); }
  for (const [contributor, count] of totals) writer.set(head(db, contributor), {
    ...encodePrivateRecord(PENDING_PAYEES, contributor, { contributor }), count: FieldValue.increment(count),
  }, { merge: true });
}
/** Routing metadata only. All payment amounts and identities are still checked on the actual claim. */
export function createIndexedMeterClaims(db: Firestore, writer: Writer, entries: readonly { ref: DocumentReference; claim: MeterPendingClaim }[]): IndexedClaim[] {
  const claims = entries.map(({ ref, claim }) => {
    const indexed = { ...claim, inlet_indexed_v1: true };
    writer.create(ref, indexed); writer.create(readyRef(db, claim.claim_key), entry(claim)); return indexed;
  });
  counts(db, writer, claims, 1); return claims;
}
export function createIndexedMeterClaim(db: Firestore, writer: Writer, ref: DocumentReference, claim: MeterPendingClaim): IndexedClaim {
  return createIndexedMeterClaims(db, writer, [{ ref, claim }])[0];
}
export function removeIndexedMeterClaims(db: Firestore, writer: Writer, claims: readonly IndexedClaim[]): void {
  const indexed = claims.filter(c => c.inlet_indexed_v1 === true);
  for (const claim of indexed) writer.delete(readyRef(db, claim.claim_key));
  counts(db, writer, indexed, -1);
}
export function updateIndexedReadiness(db: Firestore, writer: Writer, claim: IndexedClaim): void {
  if (claim.inlet_indexed_v1 === true) writer.set(readyRef(db, claim.claim_key), entry(claim), {});
}
export async function readyMeterClaimKeys(db: Firestore, nowMs: number, due: (payee: string) => Promise<boolean>): Promise<string[] | null> {
  if ((await db.collection(PENDING_INDEX_COVERAGE).doc('live').get()).get('complete') !== true) return null;
  const payees: string[] = [], result: string[] = [];
  const heads = await db.collection(PENDING_PAYEES).where('count', '>', 0).get();
  for (const doc of heads.docs) {
    const data = decodePrivateRecord(PENDING_PAYEES, doc.id, doc.data(), db).data;
    if (typeof data.contributor !== 'string' || !/^0x[a-f0-9]{40}$/.test(data.contributor)) throw new Error('pending_payee_index_invalid');
    if (await due(data.contributor)) payees.push(doc.id);
  }
  for (let start = 0; start < payees.length; start += 30) {
    await scanQueryUnordered(db.collection(PENDING_READY).where('payee_tag', 'in', payees.slice(start, start + 30)).where('ready_at_ms', '<=', nowMs), 500, async doc => {
      const raw = doc.data(), data = decodePrivateRecord(PENDING_READY, doc.id, raw, db).data;
      if (typeof data.claim_key !== 'string' || typeof data.contributor !== 'string'
        || raw.payee_tag !== privateStorageId(PENDING_PAYEES, data.contributor) || raw.ready_at_ms !== data.ready_at_ms) throw new Error('pending_claim_index_invalid');
      result.push(data.claim_key);
    });
  }
  return result.sort();
}
/** Operator cutover after old writers drain. Atomic flags/index/counts make retries idempotent. */
export async function carryPendingClaimIndex(db: Firestore): Promise<number> {
  let added = 0;
  await scanQueryUnordered(db.collection('meter_pending_claims_v1').where('state', '==', 'pending'), 250, async source => {
    const didAdd = await db.runTransaction(async txn => {
      const snap = await txn.get(source.ref), claim = snap.data() as IndexedClaim | undefined;
      if (!claim || claim.state !== 'pending' || claim.inlet_indexed_v1 === true) return false;
      txn.update(source.ref, { inlet_indexed_v1: true });
      txn.create(readyRef(db, claim.claim_key), entry(claim)); counts(db, txn, [claim], 1); return true;
    });
    if (didAdd) added++;
  });
  await db.collection(PENDING_INDEX_COVERAGE).doc('live').set({ complete: true }); return added;
}

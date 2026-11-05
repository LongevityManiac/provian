/**
 * — restore test. After an export is imported into a scratch database, compare it
 * with the live relay database READ AT THE EXPORT'S SNAPSHOT TIME (point-in-time recovery). Every
 * export reads every collection at one PITR instant, so the restore must equal
 * live-at-that-instant EXACTLY: every collection group's count, and every sampled document from the
 * money/identity collections byte for byte. Anything else is a mismatch — there is no "live kept
 * writing" allowance any more, which is what makes this check prove the export is one consistent
 * snapshot rather than collections read at different moments. Run it within PITR's 7 days. The
 * result is recorded in the live database (`ops_restore_drills_v1/<scratch-db>`) for the Command
 * Center.
 * npx tsx scripts/firestore-restore-check.ts <scratch-db> <export-snapshot-time-ISO>
 */
import admin from 'firebase-admin';
import { getFirestore, Timestamp, type Firestore, type Query, type DocumentReference } from 'firebase-admin/firestore';
import { durableCollectionIds } from '../src/core/backup/durable-export';
import { relayDatabaseId } from '../src/firestore-db';
import { RESTORE_DRILLS_COLLECTION } from '../src/core/backup/durable-export';

/** Key-sorted JSON (Firestore does not promise map key order across databases). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const v = value as Record<string, unknown> & { toMillis?: () => number; isEqual?: unknown };
  if (typeof v.toMillis === 'function' && typeof v.isEqual === 'function') return `ts:${v.toMillis()}`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

const SAMPLED = ['agent_wallets', 'wallets', 'pvt9_claim_ledger_v1', 'meter_pending_claims_v1', 'meter_device_tips_v1', 'actor_stats_v1', 'genesis_award_reservations_v1'];

/** Live at the snapshot instant: one read-only transaction per read, every one at the same readTime. */
function atSnapshot(live: Firestore, readTime: Timestamp) {
  const opts = { readOnly: true as const, readTime };
  return {
    count: (q: Query) => live.runTransaction(async (t) => (await t.get(q.count())).data().count, opts),
    paths: (q: Query) => live.runTransaction(async (t) => (await t.get(q.select())).docs.map((d) => d.ref.path), opts),
    doc: (ref: DocumentReference) => live.runTransaction(async (t) => t.get(ref), opts),
  };
}

async function main(): Promise<void> {
  const [scratchId, snapshotIso] = process.argv.slice(2);
  if (!scratchId || !snapshotIso) throw new Error('usage: <scratch-db> <export-snapshot-time-ISO>');
  const snapshotMs = Date.parse(snapshotIso);
  if (!Number.isFinite(snapshotMs) || snapshotMs % 60_000 !== 0) throw new Error('the snapshot time must be the export\'s whole-minute snapshotTime');
  const app = admin.initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'provian-ai' });
  const live = getFirestore(app, relayDatabaseId());
  const restored = getFirestore(app, scratchId);
  const then = atSnapshot(live, Timestamp.fromMillis(snapshotMs));
  // Exactly the set the weekly export names : the durable collections, never the transient ones.
  const ids = durableCollectionIds((await live.listCollections()).map((c) => c.id));
  let docs = 0; let bad = 0;
  for (const id of ids) {
    const a = await then.count(live.collectionGroup(id));
    const b = (await restored.collectionGroup(id).count().get()).data().count;
    docs += b;
    if (a === b) continue;
    bad++;
    let example = '';
    if (Math.max(a, b) <= 500) {
      const have = new Set((await restored.collectionGroup(id).select().get()).docs.map((d) => d.ref.path));
      const want = new Set(await then.paths(live.collectionGroup(id)));
      const missing = [...want].filter((p) => !have.has(p));
      const extra = [...have].filter((p) => !want.has(p));
      example = ` (missing ${missing.length}${missing[0] ? ` e.g. ${missing[0]}` : ''}; not in live at the snapshot ${extra.length}${extra[0] ? ` e.g. ${extra[0]}` : ''})`;
    }
    console.log(`MISMATCH ${id}: live at snapshot=${a} restored=${b}${example}`);
  }
  let sampled = 0;
  for (const coll of SAMPLED) {
    const snap = await restored.collection(coll).limit(25).get();
    for (const d of snap.docs) {
      const l = await then.doc(live.collection(coll).doc(d.id));
      sampled++;
      if (!l.exists || canonical(l.data()) !== canonical(d.data())) { bad++; console.log(`DOC MISMATCH ${coll}/${d.id}`); }
    }
  }
  console.log(`restore check at snapshot ${new Date(snapshotMs).toISOString()}: ${ids.length} groups, ${docs} documents restored, ${sampled} docs sampled, mismatches=${bad}`);
  // An empty restore counts as a failed drill on the dashboard too.
  await live.collection(RESTORE_DRILLS_COLLECTION).doc(scratchId).set({
    scratch_db: scratchId, export_started_at: new Date(snapshotMs).toISOString(), snapshot_time: new Date(snapshotMs).toISOString(),
    compared_at_snapshot: true, checked_at_ms: Date.now(),
    groups: ids.length, documents: docs, sampled,
    mismatches: docs === 0 ? Math.max(bad, 1) : bad,
  });
  if (bad > 0 || docs === 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });

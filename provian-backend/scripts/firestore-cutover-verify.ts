/**
 * — after the import, compare every copied collection group's document count in the
 * source (`(default)`) and the new database (`relay`). Exit 1 on any mismatch outside the transient
 * set (rate limits, nonces, leases: a read-only request during maintenance may still touch those).
 * npx tsx scripts/firestore-cutover-verify.ts <comma-separated ids>
 */
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { TRANSIENT_COLLECTIONS } from '../src/core/backup/durable-export';

async function main(): Promise<void> {
  const app = admin.initializeApp({ projectId: process.env.GCP_PROJECT_ID ?? 'provian-ai' });
  const src = getFirestore(app);
  const dst = getFirestore(app, 'relay');
  const transient = new Set(TRANSIENT_COLLECTIONS);
  const ids = (process.argv[2] ?? '').split(',').filter(Boolean);
  let bad = 0; let docs = 0;
  for (const id of ids) {
    const a = (await src.collectionGroup(id).count().get()).data().count;
    const b = (await dst.collectionGroup(id).count().get()).data().count;
    docs += b;
    if (a !== b) {
      const tag = transient.has(id) ? 'transient drift' : 'MISMATCH';
      if (!transient.has(id)) bad++;
      console.log(`${tag} ${id}: default=${a} relay=${b}`);
    }
  }
  console.log(`verified ${ids.length} collection groups, ${docs} documents in relay, mismatches=${bad}`);
  if (ids.length === 0 || bad > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });

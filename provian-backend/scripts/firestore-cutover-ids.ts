/**
 * — print the collection ids the database move copies (comma-separated), from the
 * SOURCE database's live top-level list minus the verified legacy list (`cutoverCollectionIds`).
 * npx tsx scripts/firestore-cutover-ids.ts # source = (default)
 * Then: gcloud firestore export gs://provian-ai-firestore-cutover/<day> --database='(default)' --collection-ids=<ids>
 * gcloud firestore import gs://provian-ai-firestore-cutover/<day> --database=relay
 */
import admin from 'firebase-admin';
import { cutoverCollectionIds } from '../src/core/backup/durable-export';

async function main(): Promise<void> {
  if (admin.apps.length === 0) admin.initializeApp({ projectId: process.env.GCP_PROJECT_ID ?? 'provian-ai' });
  const top = (await admin.firestore().listCollections()).map((c) => c.id);
  process.stdout.write(cutoverCollectionIds(top).join(','));
}
main().catch((err) => { console.error(err); process.exit(1); });

import admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';
import { INITIAL_JURISDICTION_POLICIES } from '../src/core/jurisdiction/jurisdiction-policy';
admin.initializeApp();
const db = scriptDb();
async function seed(): Promise<void> {
  const batch = db.batch();
  batch.delete(db.collection('jurisdiction_policy').doc('SY'));
  for (const [code, entry] of Object.entries(INITIAL_JURISDICTION_POLICIES)) batch.set(db.collection('jurisdiction_policy').doc(code), entry);
  await batch.commit();
  console.log('Jurisdiction table updated: CN deferred; KP IR CU and UA-43 UA-40 UA-14 UA-09 blocked; SY removed.');
}
seed().catch(() => { process.exitCode = 1; });

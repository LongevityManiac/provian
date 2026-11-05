/**
 * One-time migration: pe_history.minted (boolean) → pe_history.mint_status (string)
 *
 * Run once after deploying the jurisdiction update.
 *
 * Logic:
 * - minted === true  → mint_status = 'minted'
 * - minted === false → mint_status = 'eligible' (assume existing PEs are in permitted jurisdictions)
 *
 * Does NOT delete the old `minted` field - the (since-deleted PVTv8) minting
 * engine queried `mint_status == 'eligible'` so the old field is harmless.
 *
 * Usage:
 *   npx ts-node scripts/migrate-mint-status.ts
 */

import admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

async function migrate(): Promise<void> {
  const batchSize = 500;
  let processed = 0;

  // Migrate minted: true → mint_status: 'minted'
  let query = db.collection('pe_history').where('minted', '==', true).limit(batchSize);
  let snapshot = await query.get();

  while (!snapshot.empty) {
    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.update(doc.ref, {
        mint_status: 'minted',
        jurisdiction_context: 'US',  // Assume existing PEs are US (pre-global launch)
        deferred_since: null,
      });
    }
    await batch.commit();
    processed += snapshot.docs.length;
    console.log(`Migrated ${processed} minted PEs`);
    snapshot = await query.get();
  }

  // Migrate minted: false → mint_status: 'eligible'
  query = db.collection('pe_history').where('minted', '==', false).limit(batchSize);
  snapshot = await query.get();

  while (!snapshot.empty) {
    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.update(doc.ref, {
        mint_status: 'eligible',
        jurisdiction_context: 'US',
        deferred_since: null,
      });
    }
    await batch.commit();
    processed += snapshot.docs.length;
    console.log(`Migrated ${processed} unminted PEs`);
    snapshot = await query.get();
  }

  console.log(`Migration complete. Total: ${processed}`);
}

migrate().catch(console.error);

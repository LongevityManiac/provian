import admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';
admin.initializeApp();
const db = scriptDb();

async function check() {
  // Check a migrated doc - does it still have minted: false?
  const sample = await db.collection('pe_history')
    .where('mint_status', '==', 'eligible')
    .limit(1)
    .get();

  if (!sample.empty) {
    const data = sample.docs[0].data();
    console.log('Sample migrated doc:');
    console.log('  mint_status:', data.mint_status);
    console.log('  minted:', data.minted);
    console.log('  jurisdiction_context:', data.jurisdiction_context);
    console.log('  deferred_since:', data.deferred_since);
    console.log('  userId:', data.userId);
  }

  // Count docs that have mint_status field at all
  const withMintStatus = await db.collection('pe_history')
    .where('mint_status', 'in', ['eligible', 'deferred', 'minted', 'ineligible'])
    .count().get();
  console.log('\nDocs with mint_status field:', withMintStatus.data().count);

  // Get a sample non-migrated doc
  const oldSample = await db.collection('pe_history')
    .where('minted', '==', false)
    .limit(1)
    .get();

  if (!oldSample.empty) {
    const data = oldSample.docs[0].data();
    console.log('\nSample old-format doc:');
    console.log('  minted:', data.minted);
    console.log('  mint_status:', data.mint_status);
    console.log('  userId:', data.userId);
  }
}
check().catch(console.error);

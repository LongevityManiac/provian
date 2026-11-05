import admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';
admin.initializeApp();
const db = scriptDb();

async function check() {
  const total = await db.collection('pe_history').count().get();
  console.log('Total pe_history docs:', total.data().count);

  const loadtest = await db.collection('pe_history')
    .where('userId', '>=', 'loadtest_')
    .where('userId', '<', 'loadtesv')
    .count().get();
  console.log('loadtest_* user PEs:', loadtest.data().count);

  const realCount = total.data().count - loadtest.data().count;
  console.log('Real PEs (non-loadtest):', realCount);

  const migrated = await db.collection('pe_history')
    .where('mint_status', '==', 'eligible')
    .count().get();
  console.log('Already migrated (mint_status=eligible):', migrated.data().count);

  const oldFalse = await db.collection('pe_history')
    .where('minted', '==', false)
    .count().get();
  console.log('Still old format (minted=false):', oldFalse.data().count);
}
check().catch(console.error);

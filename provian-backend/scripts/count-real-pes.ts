import admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';
admin.initializeApp();
const db = scriptDb();

async function check() {
  // Count k6_loadtest_ PEs (different from loadtest_)
  const k6Count = await db.collection('pe_history')
    .where('userId', '>=', 'k6_loadtest_')
    .where('userId', '<', 'k6_loadtesv')
    .count().get();
  console.log('k6_loadtest_* PEs:', k6Count.data().count);

  const loadtestCount = await db.collection('pe_history')
    .where('userId', '>=', 'loadtest_')
    .where('userId', '<', 'loadtesv')
    .count().get();
  console.log('loadtest_* PEs:', loadtestCount.data().count);

  const systemCount = await db.collection('pe_history')
    .where('userId', '==', 'system')
    .count().get();
  console.log('system PEs:', systemCount.data().count);

  const total = await db.collection('pe_history').count().get();
  const totalCount = total.data().count;
  const testTotal = k6Count.data().count + loadtestCount.data().count;
  console.log('\nTotal:', totalCount);
  console.log('All test PEs:', testTotal);
  console.log('Non-test PEs:', totalCount - testTotal);

  // Sample some non-test, non-system PEs to see who created them
  // Use a range query that excludes known prefixes
  // Try users that start with letters other than k/l/s
  const sampleA = await db.collection('pe_history')
    .where('userId', '>=', 'a')
    .where('userId', '<', 'k')
    .limit(10)
    .get();

  const sampleM = await db.collection('pe_history')
    .where('userId', '>=', 'm')
    .where('userId', '<', 'z')
    .limit(10)
    .get();

  console.log('\nSample PEs (userId a-k):');
  for (const doc of sampleA.docs) {
    const d = doc.data();
    console.log(`  ${d.userId}  action=${d.actionType}  ts=${new Date(d.timestamp).toISOString()}`);
  }

  console.log('\nSample PEs (userId m-z):');
  for (const doc of sampleM.docs) {
    const d = doc.data();
    console.log(`  ${d.userId}  action=${d.actionType}  ts=${new Date(d.timestamp).toISOString()}`);
  }

  // Check if any non-test PEs exist that aren't 'system'
  const nonTestSnap = await db.collection('pe_history')
    .where('userId', '>=', 'a')
    .where('userId', '<', 'k')
    .count().get();
  console.log('\nPEs with userId a-k:', nonTestSnap.data().count);

  const nonTestSnap2 = await db.collection('pe_history')
    .where('userId', '>=', 'm')
    .where('userId', '<', 'z')
    .count().get();
  console.log('PEs with userId m-z:', nonTestSnap2.data().count);
}
check().catch(console.error);

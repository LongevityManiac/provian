import admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';
admin.initializeApp();
const db = scriptDb();

async function check() {
  // Get all distinct userIds and their PE counts
  // Firestore doesn't have GROUP BY, so sample and aggregate
  const snapshot = await db.collection('pe_history')
    .select('userId')
    .limit(5000)
    .get();

  const userCounts = new Map<string, number>();
  for (const doc of snapshot.docs) {
    const userId = doc.data().userId;
    userCounts.set(userId, (userCounts.get(userId) || 0) + 1);
  }

  // Sort by count descending
  const sorted = [...userCounts.entries()].sort((a, b) => b[1] - a[1]);

  console.log('Top PE creators (sample of 5000 docs):');
  console.log('---');
  for (const [userId, count] of sorted.slice(0, 30)) {
    const isLoadtest = userId.startsWith('loadtest_') || userId.startsWith('k6_loadtest_');
    console.log(`  ${count.toString().padStart(5)} PEs  ${userId}${isLoadtest ? ' [LOADTEST]' : ''}`);
  }
  console.log(`\n${sorted.length} distinct users in sample`);

  // Now specifically check non-loadtest users
  console.log('\n--- Non-loadtest users ---');
  const realUsers = sorted.filter(([id]) => !id.startsWith('loadtest_') && !id.startsWith('k6_loadtest_'));
  for (const [userId, count] of realUsers) {
    // Look up if this is an agent wallet or human wallet
    const agentSnap = await db.collection('agent_wallets').where('agent_id', '==', userId).limit(1).get();
    const walletSnap = await db.collection('wallets').where('user_id', '==', userId).limit(1).get();
    const type = agentSnap.empty ? (walletSnap.empty ? 'unknown' : 'human') : 'agent';
    console.log(`  ${count.toString().padStart(5)} PEs  ${userId}  [${type}]`);
  }
}
check().catch(console.error);

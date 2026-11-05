#!/usr/bin/env node
/**
 * Mint a 5-minute wallet auth token for manual API calls.
 *
 * Usage:
 *   node scripts/mint-wallet-token.js [user_id]
 *
 * Default user_id: user_1ce4bf21-b285-486a-8571-71c789524c93
 *
 * Output: Bearer token + example curl command. No secrets printed.
 */

const path = require('path');

// Resolve firebase-admin from provian-backend
const backendDir = path.join(__dirname, '..', 'provian-backend');
const admin = require(path.join(backendDir, 'node_modules', 'firebase-admin'));
const crypto = require('crypto');

const { getFirestore } = require(path.join(backendDir, 'node_modules', 'firebase-admin', 'lib', 'firestore'));

if (!admin.apps.length) admin.initializeApp({ projectId: 'provian-ai' });
// The relay's database (FIRESTORE_DATABASE_ID; unset/empty = "(default)").
const DATABASE = (process.env.FIRESTORE_DATABASE_ID || '').trim() || '(default)';
if (DATABASE !== '(default)' && !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(DATABASE)) {
  console.error(`invalid FIRESTORE_DATABASE_ID ${JSON.stringify(DATABASE)}`);
  process.exit(1);
}
const db = DATABASE === '(default)' ? admin.firestore() : getFirestore(admin.app(), DATABASE);

const userId = process.argv[2] || 'user_1ce4bf21-b285-486a-8571-71c789524c93';

(async () => {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    console.error(`User ${userId} not found in Firestore`);
    process.exit(1);
  }

  const userData = userDoc.data();
  const auth_secret = userData.auth_secret;
  if (!auth_secret) {
    console.error(`No auth_secret for ${userId}`);
    process.exit(1);
  }

  // device_id from first registered device (required by main authenticate middleware)
  const deviceId = (userData.devices && userData.devices[0] && userData.devices[0].id) || 'cli';

  const payload = JSON.stringify({ user_id: userId, device_id: deviceId, ts: Date.now() });
  const payloadB64 = Buffer.from(payload).toString('base64');
  const signature = crypto.createHmac('sha256', auth_secret)
    .update(payloadB64)
    .digest('hex');

  const token = `${payloadB64}.${signature}`;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toLocaleTimeString();

  console.log(`Token for: ${userId}`);
  console.log(`Expires:   ${expiresAt} (5 minutes)`);
  console.log(`\nBearer ${token}`);
  console.log(`\n--- Example ---`);
  console.log(`curl -s https://api.provian.ai/v1/pvt/allocation/${userId} \\`);
  console.log(`  -H "Authorization: Bearer ${token}" | jq .`);
})();

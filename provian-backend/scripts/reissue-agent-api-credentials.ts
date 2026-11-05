/**
 * reissue-agent-api-credentials — mint a FRESH agent API key/secret for an
 * EXISTING agent wallet WITHOUT changing its signing address or key.
 *
 * Why this exists: a recovery re-key rotates the API credentials server-side and
 * returns the new key/secret ONCE (to the phone's restore command). If that
 * command is not fully applied on the agent host — e.g. a wallet-only recover
 * restore ran instead, or two re-keys happened back to back — the host keeps a
 * stale api_key that now 401s, while the api_secret for the live prefix exists
 * nowhere (scrypt-hashed server-side, shown once). Earning is unaffected (device
 * key), but every agent-API-key operation (recovery-alarm, burn-to-present) fails.
 *
 * This reissue supersedes the current credential in place: it writes a new
 * hash/salt/prefix to the SAME wallet doc, re-points the agent registration index
 * and the api_key_index, and deletes the superseded index — EXACTLY the api-cred
 * subset of executeKeyRotationTransition, with NO address/key/fence/escrow change.
 *
 * Run: npx ts-node scripts/reissue-agent-api-credentials.ts <wallet_id> [--execute]
 * (dry-run prints the plan; --execute performs the transactional write and then
 * prints the raw api_key/api_secret ONCE — capture them, they are not stored.)
 */

import * as admin from 'firebase-admin';
import { generateApiCredentials } from '../src/core/agent-wallet/api-key';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
} from '../src/core/pvt/native-wallet-registration';
import { scriptDb } from './lib/script-db';

async function main(): Promise<void> {
  const walletId = process.argv[2];
  const execute = process.argv.includes('--execute');
  if (!walletId || walletId.startsWith('--')) {
    console.error('usage: reissue-agent-api-credentials.ts <wallet_id> [--execute]');
    process.exit(2);
  }

  if (admin.apps.length === 0) admin.initializeApp();
  const db = scriptDb();

  const walletRef = db.collection('agent_wallets').doc(walletId);
  const walletSnap = await walletRef.get();
  if (!walletSnap.exists) {
    console.error(`agent_wallets/${walletId} not found`);
    process.exit(1);
  }
  const wallet = walletSnap.data() as {
    address?: string; status?: string; api_key_prefix?: string; agent_id?: string;
  };
  const agentId = wallet.agent_id;
  const oldPrefix = wallet.api_key_prefix;
  if (!agentId || !oldPrefix) {
    console.error(`wallet missing agent_id/api_key_prefix (agent_id=${agentId} prefix=${oldPrefix})`);
    process.exit(1);
  }

  const creds = generateApiCredentials();
  const now = Date.now();
  const agentIndexId = nativeAgentRegistrationIndexId(agentId);

  console.log('=== reissue plan ===');
  console.log(`  wallet_id   ${walletId}`);
  console.log(`  address     ${wallet.address} (UNCHANGED)`);
  console.log(`  status        ${wallet.status}`);
  console.log(`  old prefix    ${oldPrefix}  (api_key_index doc deleted)`);
  console.log(`  new prefix    ${creds.api_key_prefix}  (api_key_index doc created)`);
  console.log(`  agent index   ${NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION}/${agentIndexId} (prefix re-pointed)`);
  if (!execute) {
    console.log('\n(dry-run — pass --execute to write)');
    process.exit(0);
  }

  await db.runTransaction(async (txn) => {
    const fresh = await txn.get(walletRef);
    if (!fresh.exists) throw new Error('wallet vanished mid-transaction');
    const cur = fresh.data() as { api_key_prefix?: string };
    // Delete whatever prefix index the wallet currently points at (read inside the
    // txn so a concurrent rotation can't be silently clobbered).
    const curPrefix = cur.api_key_prefix;
    txn.update(walletRef, {
      api_key_hash: creds.api_key_hash,
      api_key_salt: creds.api_key_salt,
      api_key_prefix: creds.api_key_prefix,
      updated_at: now,
    });
    txn.update(
      db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION).doc(agentIndexId),
      { api_key_prefix: creds.api_key_prefix, updated_at_ms: now },
    );
    txn.create(db.collection('api_key_index').doc(creds.api_key_prefix), {
      api_key_prefix: creds.api_key_prefix,
      wallet_id: walletId,
      created_at: now,
    });
    if (curPrefix && curPrefix !== creds.api_key_prefix) {
      txn.delete(db.collection('api_key_index').doc(curPrefix));
    }
  });

  console.log('\n=== WRITTEN — capture these ONCE (not stored) ===');
  console.log(`  api_key     ${creds.api_key}`);
  console.log(`  api_secret  ${creds.api_secret}`);
  console.log(`  wallet_id   ${walletId}`);
  console.log(`  address     ${wallet.address}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

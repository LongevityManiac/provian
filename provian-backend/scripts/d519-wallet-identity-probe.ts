/**
 * follow-up — READ-ONLY probe: which relay account(s) hold a human wallet's PEs.
 *
 * The app's own-PE list (Abundance history, Activity) reads
 * pe_history where userId in [account] ∪ wallets(user_id == account).id
 * for the account the phone is signed in as. When that list is empty but the linked agents
 * (agent_wallets.linked_human_user_id == account) show, the human's PEs are stored under some
 * OTHER userId. This prints every candidate account for an address and how many PEs each holds,
 * so the split is visible before anything is changed.
 *
 * Writes nothing. Usage (from provian-backend/, with gcloud ADC for provian-ai):
 * npx tsx scripts/d519-wallet-identity-probe.ts 0xADDRESS [extraUserId...]
 */
import * as admin from 'firebase-admin';
import { lookupRecoveryUser, type RecoveryLookupDb } from '../src/routes/recovery-user-select';
import { resolveContributorIdentities } from '../src/core/pvt/policy/economic-projection';
import { scriptDb } from './lib/script-db';

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'provian-ai' });
const db = scriptDb();

const ms = (v: unknown): string => {
  if (typeof v === 'number') return new Date(v).toISOString();
  if (v && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return v === undefined ? '-' : String(v);
};

async function main(): Promise<void> {
  const [address, ...extraUserIds] = process.argv.slice(2);
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('usage: d519-wallet-identity-probe.ts 0xADDRESS [extraUserId ...]');
  }
  const addressLc = address.toLowerCase();
  const candidates = new Set<string>(extraUserIds);

  console.log(`\n== wallets docs for ${addressLc}`);
  const walletSnaps = await Promise.all([
    db.collection('wallets').where('address', '==', addressLc).get(),
    db.collection('wallets').where('address', '==', address).get(),
  ]);
  const seenWallets = new Set<string>();
  for (const snap of walletSnaps) {
    for (const d of snap.docs) {
      if (seenWallets.has(d.id)) continue;
      seenWallets.add(d.id);
      const w = d.data();
      if (typeof w.user_id === 'string') candidates.add(w.user_id);
      console.log(`  ${d.id} type=${w.type} user_id=${w.user_id} status=${w.status ?? '-'}`
        + ` created=${ms(w.created_at ?? w.createdAt)} proven=${ms(w.address_proven_at_ms)}`
        + ` displaced=${ms(w.displaced_at_ms)} released=${ms(w.released_at_ms)}`);
    }
  }

  console.log(`\n== users docs with wallet_address ${addressLc}`);
  const users = await db.collection('users').where('wallet_address', '==', addressLc).get();
  for (const d of users.docs) {
    candidates.add(d.id);
    const u = d.data();
    const devices = Array.isArray(u.devices) ? u.devices.length : (u.device_id ? 1 : 0);
    console.log(`  ${d.id} created=${ms(u.created_at ?? u.createdAt)} devices=${devices}`);
  }

  const recovery = await lookupRecoveryUser(db as unknown as RecoveryLookupDb, address);
  const recoveryUser = recovery.kind === 'existing' ? recovery.user.id
    : recovery.kind === 'owner_missing' ? recovery.userId : null;
  console.log(`\n== /v1/users/recover would select: ${recovery.kind}${recoveryUser ? ` → ${recoveryUser}` : ''}`);
  if (recoveryUser) candidates.add(recoveryUser);

  console.log('\n== agents linked to any candidate account');
  for (const userId of candidates) {
    const agents = await db.collection('agent_wallets').where('linked_human_user_id', '==', userId).get();
    for (const d of agents.docs) {
      const a = d.data();
      console.log(`  ${d.id} "${a.display_name ?? ''}" status=${a.status} linked_human_user_id=${userId}`);
    }
  }

  console.log('\n== own PEs visible to each candidate account (what the app lists when signed in as it)');
  for (const userId of candidates) {
    const identities = await resolveContributorIdentities(
      db as unknown as Parameters<typeof resolveContributorIdentities>[0],
      userId,
    );
    const base = db.collection('pe_history').where('userId', 'in', identities);
    const total = (await base.count().get()).data().count;
    const visible = (await base.where('hidden', '==', false).count().get()).data().count;
    const newest = await base.orderBy('timestamp', 'desc').limit(1).get();
    const oldest = await base.orderBy('timestamp', 'asc').limit(1).get();
    const n = newest.docs[0]?.data();
    const o = oldest.docs[0]?.data();
    console.log(`  ${userId}${userId === recoveryUser ? ' (recovery target)' : ''}: identities=${identities.length}`
      + ` total=${total} visible=${visible}`
      + ` oldest=${o ? `${ms(o.timestamp)} ${o.actionType}` : '-'}`
      + ` newest=${n ? `${ms(n.timestamp)} ${n.actionType}` : '-'}`);
  }

  console.log('\n== PEs keyed directly by each candidate userId alone');
  for (const userId of candidates) {
    const c = (await db.collection('pe_history').where('userId', '==', userId).count().get()).data().count;
    console.log(`  ${userId}: ${c}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

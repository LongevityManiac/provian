/**
 * One-shot lookup: is a given EVM address known to the Provian backend?
 *
 * Usage:
 *   GCP_PROJECT_ID=provian-ai npx tsx scripts/lookup-address.ts 0xADDRESS
 *
 * Auth: uses Application Default Credentials (gcloud auth application-default login).
 *
 * Searches:
 *   - users / wallets (wallet_address)
 *   - agent_wallets (address)
 *   - commons_profiles (wallet_address, agent_wallet_address)
 *   - agent_directory (wallet_address)
 *   - devices (wallet_address)
 *   - sessions (wallet_address)
 *   - foundation_membership_grants (wallet_address)
 *
 * Read-only. Never modifies anything.
 */
import admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';

const target = (process.argv[2] || '').toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(target)) {
  console.error('Usage: npx tsx scripts/lookup-address.ts 0x<40-hex>');
  process.exit(2);
}

const projectId = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'provian-ai';
admin.initializeApp({ projectId });
const db = scriptDb();

type Probe = {
  collection: string;
  field: string;
  caseSensitive?: boolean;
};

const probes: Probe[] = [
  { collection: 'users', field: 'wallet_address' },
  { collection: 'wallets', field: 'wallet_address' },
  { collection: 'wallets', field: 'address' },
  { collection: 'agent_wallets', field: 'address' },
  { collection: 'agent_wallets', field: 'wallet_address' },
  { collection: 'commons_profiles', field: 'wallet_address' },
  { collection: 'commons_profiles', field: 'agent_wallet_address' },
  { collection: 'agent_directory', field: 'wallet_address' },
  { collection: 'devices', field: 'wallet_address' },
  { collection: 'sessions', field: 'wallet_address' },
  { collection: 'foundation_membership_grants', field: 'wallet_address' },
  { collection: 'pe_history', field: 'wallet_address' },
  { collection: 'pe_history', field: 'actor_address' },
];

async function probe(p: Probe, value: string) {
  try {
    const snap = await db.collection(p.collection).where(p.field, '==', value).limit(5).get();
    if (snap.empty) return { ...p, value, hits: 0, docs: [] };
    return {
      ...p,
      value,
      hits: snap.size,
      docs: snap.docs.map((d) => ({
        id: d.id,
        keys: Object.keys(d.data()).sort(),
        sample: Object.fromEntries(
          Object.entries(d.data())
            .filter(([k]) =>
              [
                'user_id',
                'wallet_id',
                'agent_id',
                'wallet_address',
                'address',
                'agent_wallet_address',
                'actor_address',
                'owner_type',
                'created_at',
                'createdAt',
                'updated_at',
                'name',
                'display_name',
                'email',
                'recovery_email',
                'iCloud_keychain_backup_id',
                'recovery_method',
              ].includes(k),
            )
            .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : v]),
        ),
      })),
    };
  } catch (e: any) {
    return { ...p, value, error: e?.message || String(e) };
  }
}

async function main() {
  const checksum = admin.firestore.FieldValue; // force-load admin
  void checksum;

  const variants = [target, target.toUpperCase().replace('0X', '0x'), '0x' + target.slice(2)];
  // dedupe
  const uniqueVariants = [...new Set(variants)];

  console.log(`# Provian backend lookup`);
  console.log(`Project:  ${projectId}`);
  console.log(`Target:   ${target}`);
  console.log(`Variants tried: ${uniqueVariants.join(', ')}`);
  console.log('');

  let anyHit = false;
  for (const p of probes) {
    for (const v of uniqueVariants) {
      const res: any = await probe(p, v);
      if (res.error) {
        console.log(`[ERR] ${p.collection}.${p.field} == ${v}: ${res.error}`);
        continue;
      }
      if (res.hits > 0) {
        anyHit = true;
        console.log(`[HIT] ${p.collection}.${p.field} == ${v}  (${res.hits} doc${res.hits > 1 ? 's' : ''})`);
        for (const d of res.docs) {
          console.log(`      docId: ${d.id}`);
          console.log(`      sample: ${JSON.stringify(d.sample)}`);
          console.log(`      fields: ${d.keys.join(', ')}`);
        }
      }
    }
  }
  if (!anyHit) {
    console.log('No matches in any probed collection.');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

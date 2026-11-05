/**
 * app-attest-key-owner-migration — one App Attest key backs ONE account.
 *
 * Before the registry keyed each attested key per (user, key), so one iPhone's key could be
 * registered under N accounts and lift every one to hardware_rooted. The relay now binds each key to
 * one account through `app_attest_key_owner_v1/<sha256(key_id)>` and resolves an un-owned legacy key
 * lazily (earliest `attested_at_ms` wins). This script does the same resolution in BULK:
 *
 * - every key with no owner doc gets one (earliest-attested legacy doc; counter = max seen);
 * - every legacy doc whose key another account owns is DISABLED (`disabled_at_ms`,
 * `disabled_reason: key_bound_to_other_account`) — never deleted, so the record stays;
 * - every key held under more than one account is REPORTED (key id, owner, all user ids).
 *
 * The plan is the pure, unit-tested `planAppAttestKeyOwnerMigration`
 * (src/core/hardware/app-attest-keys.ts). IDEMPOTENT: a second run plans nothing. An existing owner
 * doc is never re-pointed. Owner creation uses `create` (fails if a concurrent register won the race
 * re-run the script; the lazy path already agrees on the same earliest owner).
 *
 * DRY-RUNS by default; writes only with --apply.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/app-attest-key-owner-migration.ts # dry run
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/app-attest-key-owner-migration.ts --apply # LIVE
 */

import admin from 'firebase-admin';
import {
  APP_ATTEST_KEYS_COLLECTION,
  APP_ATTEST_KEY_OWNER_COLLECTION,
  KEY_BOUND_TO_OTHER_ACCOUNT,
  planAppAttestKeyOwnerMigration,
  type AppAttestKeyDoc,
  type AppAttestKeyOwnerDoc,
} from '../src/core/hardware/app-attest-keys';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const nowMs = Date.now();
  console.log(`Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN'}\n`);

  const legacySnap = await db.collection(APP_ATTEST_KEYS_COLLECTION).get();
  const legacy = legacySnap.docs.map((d) => ({ id: d.id, data: d.data() as AppAttestKeyDoc }));
  const ownerSnap = await db.collection(APP_ATTEST_KEY_OWNER_COLLECTION).get();
  const owners = new Map<string, AppAttestKeyOwnerDoc>();
  for (const d of ownerSnap.docs) {
    const o = d.data() as AppAttestKeyOwnerDoc;
    if (typeof o.key_id === 'string') owners.set(o.key_id, o);
  }

  const plan = planAppAttestKeyOwnerMigration(legacy, owners, nowMs);
  console.log(`Registry docs: ${legacy.length}; owner docs: ${owners.size}`);
  console.log(`Keys held under more than one account: ${plan.shared_keys.length}`);
  for (const s of plan.shared_keys) console.log(`  key ${s.key_id}: owner ${s.owner_user_id}; accounts ${s.user_ids.join(', ')}`);
  console.log(`Owner docs to create: ${plan.owners.length}`);
  for (const o of plan.owners) console.log(`  ${o.id}: key ${o.doc.key_id} → ${o.doc.user_id} (counter ${o.doc.counter})`);
  console.log(`Registry docs to disable: ${plan.disable.length}`);
  for (const d of plan.disable) console.log(`  ${d.id}: account ${d.user_id} (key owned by ${d.owner_user_id})`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write.');
    return;
  }

  for (const o of plan.owners) {
    try {
      await db.collection(APP_ATTEST_KEY_OWNER_COLLECTION).doc(o.id).create(o.doc);
    } catch (err) {
      console.log(`  owner ${o.id} already exists (concurrent register) — skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let batch = db.batch();
  let ops = 0;
  for (const d of plan.disable) {
    batch.update(db.collection(APP_ATTEST_KEYS_COLLECTION).doc(d.id), { disabled_at_ms: nowMs, disabled_reason: KEY_BOUND_TO_OTHER_ACCOUNT });
    ops += 1;
    if (ops === 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  console.log(`Done. Created ${plan.owners.length} owner docs; disabled ${plan.disable.length} registry docs.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

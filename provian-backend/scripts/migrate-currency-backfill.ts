/**
 * One-time migration: backfill `currency: 'usdc'` on pre-Workstream-2 records.
 *
 * After Workstream 2 ships, every Agent Bank document carries an explicit
 * `currency` field set at creation time. Records created before this rollout
 * have no currency field; the service code defaults to 'usdc' on read, but
 * persisting the field explicitly:
 *   - keeps Firestore queries (`.where('currency', '==', 'usdc')`) consistent
 *   - removes the implicit-default branch from per-record code paths
 *   - makes the migration auditable (every record carries a written value
 *     rather than relying on language-level coalescing)
 *
 * Also writes `economic_activity_pvt: '0'` on every agent_wallets doc so
 * the new field is non-null on read paths that don't tolerate undefined.
 *
 * Touched collections:
 *   escrows/        - set currency: 'usdc' on docs missing the field
 *   promises/       - same
 *   pools/          - same
 *   jobs/           - same
 *   agent_wallets/  - set economic_activity_pvt: '0' on docs missing the field
 *
 * Per Workstream 2 - Q7: existing docs receive the legacy currency value;
 * NEW *_pvt fields are NOT initialized to null/zero on existing records.
 * Only agent_wallets gets economic_activity_pvt: '0' since that field is
 * read by every wallet-stats path and undefined would surface as NaN in
 * downstream code.
 *
 * Idempotent - re-runnable without side effects (only touches docs that
 * are still missing the target field). Safe to re-run after partial failure.
 *
 * Usage:
 *   DRY_RUN=true npx ts-node scripts/migrate-currency-backfill.ts   # report counts only
 *   npx ts-node scripts/migrate-currency-backfill.ts                # apply writes
 */

import admin from 'firebase-admin';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

const DRY_RUN = process.env.DRY_RUN === 'true';
const BATCH_SIZE = 500; // Firestore commit limit

async function backfillCurrency(collection: string): Promise<number> {
  let processed = 0;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  while (true) {
    let query: FirebaseFirestore.Query = db.collection(collection)
      .orderBy('__name__')
      .limit(BATCH_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    if (snap.empty) break;

    let batch = db.batch();
    let writes = 0;

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (data.currency !== undefined) continue; // already migrated
      if (DRY_RUN) {
        writes++;
      } else {
        batch.update(doc.ref, { currency: 'usdc' });
        writes++;
      }
    }

    if (writes > 0 && !DRY_RUN) {
      await batch.commit();
    }
    processed += writes;
    cursor = snap.docs[snap.docs.length - 1];
    console.log(`[${collection}] processed ${processed} (${DRY_RUN ? 'dry-run' : 'committed'})`);

    if (snap.docs.length < BATCH_SIZE) break;
  }

  return processed;
}

async function backfillEconomicActivityPvt(): Promise<number> {
  let processed = 0;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;

  while (true) {
    let query: FirebaseFirestore.Query = db.collection('agent_wallets')
      .orderBy('__name__')
      .limit(BATCH_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snap = await query.get();
    if (snap.empty) break;

    let batch = db.batch();
    let writes = 0;

    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      if (data.economic_activity_pvt !== undefined) continue;
      if (DRY_RUN) {
        writes++;
      } else {
        batch.update(doc.ref, { economic_activity_pvt: '0' });
        writes++;
      }
    }

    if (writes > 0 && !DRY_RUN) {
      await batch.commit();
    }
    processed += writes;
    cursor = snap.docs[snap.docs.length - 1];
    console.log(`[agent_wallets economic_activity_pvt] processed ${processed} (${DRY_RUN ? 'dry-run' : 'committed'})`);

    if (snap.docs.length < BATCH_SIZE) break;
  }

  return processed;
}

async function main(): Promise<void> {
  console.log(`=== Workstream 2 - Currency Backfill (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===`);
  if (DRY_RUN) {
    console.log('No writes will be performed. Set DRY_RUN=false to apply.');
  }

  const totals = {
    escrows: await backfillCurrency('escrows'),
    promises: await backfillCurrency('promises'),
    pools: await backfillCurrency('pools'),
    jobs: await backfillCurrency('jobs'),
    agent_wallets_economic_activity_pvt: await backfillEconomicActivityPvt(),
  };

  console.log('\n=== Migration summary ===');
  for (const [k, v] of Object.entries(totals)) {
    console.log(`  ${k}: ${v}`);
  }
  if (DRY_RUN) {
    console.log('\nRe-run without DRY_RUN=true to apply.');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

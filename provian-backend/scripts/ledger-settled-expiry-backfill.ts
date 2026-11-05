import { singleScanQuery } from '../src/core/provenance/private-store';
/**
 * PE METER — give SETTLED meter-claim ledger rows that predate `expire_at` their expiry
 * (`src/core/meter/ledger-retention.ts`).
 *
 *   tsx scripts/ledger-settled-expiry-backfill.ts [--execute]
 *
 * DO NOT RUN while the legacy PE migration (`scripts/pe-meter-migrate.ts`) is still retiring rows.
 * Rows settled from the cost pass onward get `expire_at` at settlement; this only catches up the
 * rows settled before it. Only a row whose `pe_id` is a meter claim key (`mb_` / `ma_` / `mt_`), that
 * reads `settled: true` with a numeric `settled_at` and no `expire_at`, is touched; it gets
 * `settled_at + SETTLED_METER_LEDGER_ROW_LIFETIME_MS` (so a row settled long ago expires at once).
 * Legacy (`pe_…`) and Genesis rows are never given an expiry. Dry run unless --execute.
 */
import admin from 'firebase-admin';
import { FieldPath } from 'firebase-admin/firestore';
import { CLAIM_LEDGER_COLLECTION } from '../src/core/pvt/wp4/durable-settlement-store';
import { settledLedgerRowExpiry } from '../src/core/meter/ledger-retention';
import { scriptDb } from './lib/script-db';

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'provian-ai' });
const db = scriptDb();
const execute = process.argv.slice(2).includes('--execute');

async function main(): Promise<void> {
  let scanned = 0;
  let eligible = 0;
  let written = 0;
  let after: string | null = null;
  const source = singleScanQuery(db.collection(CLAIM_LEDGER_COLLECTION).orderBy(FieldPath.documentId()));
  for (;;) {
    let query = source.limit(500);
    if (after !== null) query = query.startAfter(after);
    const page = await query.get();
    if (page.empty) break;
    after = page.docs[page.docs.length - 1].id;
    const batch = db.batch();
    let n = 0;
    for (const doc of page.docs) {
      scanned += 1;
      const row = doc.data();
      if (row.settled !== true || typeof row.settled_at !== 'number' || row.expire_at !== undefined) continue;
      const expiry = settledLedgerRowExpiry(String(row.pe_id ?? ''), row.settled_at);
      if (expiry.expire_at === undefined) continue;
      eligible += 1;
      batch.set(doc.ref, expiry, { merge: true });
      n += 1;
    }
    if (execute && n > 0) {
      await batch.commit();
      written += n;
    }
    if (page.size < 500) break;
  }
  console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry_run', scanned, eligible, written }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * backfill-pe-economic-aggregates — fold every pre-existing `pe_history` row
 * into the accrual-time economic aggregates (M5 close-out).
 *
 * WHAT IT DOES. Walks `pe_history` once to enumerate every identity key (both
 * `userId` and `beneficiary_wallet_id`), then for each identity runs
 * `backfillIdentityAggregate` page transactions that fold every UNMARKED row
 * under all its identities and stamp it `economic_aggregate_applied`, then
 * flag the identity's roles `backfill_complete`. Marked rows are skipped, so
 * the script is IDEMPOTENT and RESUMABLE: re-run it after a crash and it folds
 * only what the previous run did not reach. It is also safe to run while the
 * relay is live — every page is a transaction that reads the aggregate
 * document it writes, so it serialises against concurrent seals.
 *
 * WHY IT IS OPTIONAL. The read path backfills an identity itself on the first
 * dashboard read that finds its aggregate absent or incomplete. This script
 * PRE-WARMS the whole population so no user's first read after the deploy
 * pays the fold, and it gives the operator a per-identity report.
 *
 * CUTOVER ORDER (nothing here is gated — the read path is aggregate-backed the
 * moment the code deploys):
 * 1. deploy the code (the seal marks + applies every new row);
 * 2. deploy the additive Firestore index (beneficiary_wallet_id ASC,
 * timestamp ASC) — `deploy-firestore-indexes.js` does this in the
 * pipeline; the tail fold and roll-forward for the BENEFICIARY role need it;
 * 3. run this script with --apply (dry run first);
 * 4. create the drift-sweep Cloud Scheduler job. `scheduler-jobs.json`
 * classifies `/v1/internal/scheduler/pe-aggregate-drift` as REQUIRED
 * (job `provian-pe-aggregate-drift`, `35 * * * *`), so the deploy gate
 * `scripts/reconcile-scheduler.ts` REFUSES the deploy until the job
 * exists and is ENABLED — the mechanism, on purpose. Create it with
 * the same OIDC identity as every other internal sweep (compare against
 * `gcloud scheduler jobs describe provian-pending-cache-backfill`):
 *
 * gcloud scheduler jobs create http provian-pe-aggregate-drift \
 * --location=us-central1 --project=provian-ai \
 * --schedule="35 * * * *" --time-zone=UTC \
 * --uri="https://provian-api-185909722463.us-central1.run.app/v1/internal/scheduler/pe-aggregate-drift" \
 * --http-method=POST \
 * --oidc-service-account-email=provian-scheduler@provian-ai.iam.gserviceaccount.com \
 * --oidc-token-audience="https://provian-api-185909722463.us-central1.run.app" \
 * --attempt-deadline=300s
 *
 * NO query string on the URI: the reconciler extracts the endpoint with a
 * regex that ends at the path, and a `?sample=` suffix would make the job
 * read as an unrecognized non-HTTP target. The route's default sample is
 * 25 identities per run (600/day); if the population outgrows that
 * cadence, raise the route default, not the URI.
 *
 * DRY-RUNS by default; writes only with --apply.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-pe-economic-aggregates.ts # dry run, all identities
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-pe-economic-aggregates.ts --apply # LIVE
 * … --identity=user_abc,wallet_def --apply # a subset
 */

import admin from 'firebase-admin';
import {
  backfillIdentityAggregate,
  enumerateAggregateIdentities,
} from '../src/core/pvt/policy/economic-aggregate-maintenance';
import {
  AGGREGATE_ROLES,
  AGGREGATE_ROLE_KEY_FIELD,
} from '../src/core/pvt/policy/economic-aggregate';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

function parseArgs(argv: readonly string[]): { apply: boolean; identities: string[] | null; pageSize: number | undefined } {
  const apply = argv.includes('--apply');
  const identityArg = argv.find((a) => a.startsWith('--identity='));
  const identities = identityArg
    ? identityArg.slice('--identity='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const pageArg = argv.find((a) => a.startsWith('--page-size='));
  const pageSize = pageArg ? Number(pageArg.slice('--page-size='.length)) : undefined;
  return { apply, identities, pageSize: pageSize && Number.isFinite(pageSize) ? pageSize : undefined };
}

async function main(): Promise<void> {
  const { apply, identities: requested, pageSize } = parseArgs(process.argv.slice(2));
  console.log(`Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN'}`);

  const identities = requested ?? [...(await enumerateAggregateIdentities(db))].sort();
  console.log(`Identities: ${identities.length}\n`);

  if (!apply) {
    for (const identity of identities) {
      const counts: string[] = [];
      for (const role of AGGREGATE_ROLES) {
        const snap = await db.collection('pe_history')
          .where(AGGREGATE_ROLE_KEY_FIELD[role], '==', identity)
          .count()
          .get();
        counts.push(`${role}=${snap.data().count}`);
      }
      console.log(`  ${identity}: ${counts.join(' ')}`);
    }
    console.log('\nDry run only. Re-run with --apply to fold and mark.');
    return;
  }

  const nowMs = Date.now();
  let totalMarked = 0;
  for (const identity of identities) {
    const report = await backfillIdentityAggregate(db, identity, { nowMs, pageSize });
    const summary = report.roles
      .map((r) => `${r.role}: scanned=${r.rowsScanned} marked=${r.rowsMarked} pages=${r.pages}`)
      .join(' | ');
    totalMarked += report.roles.reduce((sum, r) => sum + r.rowsMarked, 0);
    console.log(`  ${identity}: ${summary}`);
  }
  console.log(`\nDone. Rows newly marked: ${totalMarked}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

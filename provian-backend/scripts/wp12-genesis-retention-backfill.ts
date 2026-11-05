/**
 * activation (H2) — Genesis retention backfill CLI.
 *
 * Promotes durably-retained in-window Genesis qualifications (persist gate
 * refused: activation absent/invalid/killed) into the mint-readable outbox,
 * ONLY for records the FULL persist gate now admits against the current
 * activation, preserving each act's ORIGINAL qualifying timestamp.
 *
 * Fail-closed and idempotent — a retained record alone is never a grant, the
 * gate is re-run per record, and the outbox-existence check dedupes. Explicitly
 * invoked; NOT scheduled. There is no cron/worker wiring for this by design.
 *
 * Handles no key and sends no transaction: this moves off-chain Firestore records
 * only. It does NOT settle or mint anything.
 *
 * Usage:
 * npx ts-node scripts/wp12-genesis-retention-backfill.ts --dry-run [--limit=200]
 * npx ts-node scripts/wp12-genesis-retention-backfill.ts [--limit=200]
 *
 * Default is a DRY RUN unless --commit is passed, so an accidental run writes
 * nothing.
 */
import admin from 'firebase-admin';

import { backfillRetainedGenesisQualifications } from '../src/core/pvt/genesis-retention-backfill';
import { scriptDb } from './lib/script-db';

function parseArgs(argv: readonly string[]): { commit: boolean; limit: number | undefined } {
  let commit = false;
  let limit: number | undefined;
  for (const arg of argv) {
    if (arg === '--commit') commit = true;
    else if (arg === '--dry-run') commit = false;
    else if (arg.startsWith('--limit=')) {
      const value = Number(arg.slice('--limit='.length));
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`invalid --limit: ${arg}`);
      }
      limit = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { commit, limit };
}

async function main(): Promise<void> {
  const { commit, limit } = parseArgs(process.argv.slice(2));
  admin.initializeApp();
  const db = scriptDb();

  const report = await backfillRetainedGenesisQualifications(
    { db },
    { dryRun: !commit, limit },
  );

  console.log(JSON.stringify({
    mode: commit ? 'COMMIT' : 'DRY_RUN',
    ...report,
    promoted_count: report.promoted.length,
    already_present_count: report.already_present.length,
    still_refused_count: report.still_refused.length,
    invalid_count: report.invalid.length,
  }, null, 2));

  if (!commit) {
    console.log('\nDRY RUN — nothing was written. Re-run with --commit to promote.');
  }
}

main().catch((err) => {
  console.error('[genesis-retention-backfill] failed:', err);
  process.exit(1);
});

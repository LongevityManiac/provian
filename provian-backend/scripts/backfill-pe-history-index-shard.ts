/**
 * backfill-pe-history-index-shard — stamp `index_shard` on every existing
 * `pe_history` row and, once nothing is missing, flip the readers to the
 * sharded query shapes (H5 close-out).
 *
 * WHY. The low-cardinality-led, timestamp-ordered composite indexes on
 * pe_history — (mint_status, timestamp), (mint_status, jurisdiction_context,
 * timestamp), (mint_status, timestamp, peId) — take every write at their tail
 * and cap sustained ingestion at Firestore's ~500 writes/sec sequential-index
 * ceiling. Leading each with a write-time shard derived from the doc id
 * (`core/pvt/pe-history-index-shard.ts`, 16 shards) spreads consecutive writes
 * across 16 key ranges and multiplies that ceiling accordingly. The readers of
 * those indexes fan out across every shard and merge.
 *
 * CUTOVER ORDER — the readers switch on DATA, not on a deploy:
 * 1. deploy the code. writePEHistory stamps `index_shard` on every NEW row;
 * every reader still runs its LEGACY (unsharded) query — today's behaviour.
 * 2. deploy the additive composite indexes (deploy-firestore-indexes.js does
 * it in the pipeline): (index_shard, mint_status, timestamp),
 * (index_shard, mint_status, jurisdiction_context, timestamp),
 * (index_shard, mint_status, timestamp, peId). Wait for READY.
 * 3. run this script with --apply until it reports complete (it is
 * idempotent and resumable; a budgeted run prints the id to resume from).
 * 4. run it with --cutover: it performs a FULL verification walk and writes
 * the migration marker ONLY if zero rows are missing or wrong. From the
 * next sweep on, every reader uses the sharded shapes.
 * 5. only after step 4 may the three legacy indexes be deleted — the
 * orchestrator does that by hand (see docs/archive/backend/delete-dead-pe-history-indexes.md);
 * until then they stay declared, so a rollback of the marker (set
 * `sharded_readers_enabled: false`) is a one-field write.
 *
 * DRY-RUNS by default; writes only with --apply / --cutover.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-pe-history-index-shard.ts # dry run: counts rows needing the field
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-pe-history-index-shard.ts --apply # stamp
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-pe-history-index-shard.ts --apply --resume-after=<peId>
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-pe-history-index-shard.ts --cutover # verify + flip readers
 */

import admin from 'firebase-admin';
import {
  backfillPeHistoryIndexShard,
  verifyIndexShardCoverage,
} from '../src/core/pvt/pe-history-index-shard-backfill';
import {
  PE_HISTORY_INDEX_SHARD_COUNT,
  enableShardedReaders,
  readPeHistoryReaderMode,
} from '../src/core/pvt/pe-history-index-shard';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const cutover = argv.includes('--cutover');
  const resumeArg = argv.find((a) => a.startsWith('--resume-after='));
  const startAfterId = resumeArg ? resumeArg.slice('--resume-after='.length) : null;
  const budgetArg = argv.find((a) => a.startsWith('--max-run-ms='));
  const maxRunMs = budgetArg ? Number(budgetArg.slice('--max-run-ms='.length)) : undefined;

  console.log(`Shard count: ${PE_HISTORY_INDEX_SHARD_COUNT}; reader mode now: ${await readPeHistoryReaderMode(db)}`);

  if (cutover) {
    console.log('Cutover requested — verifying coverage with a full walk…');
    const coverage = await verifyIndexShardCoverage(db);
    console.log(`  scanned=${coverage.scanned} missing=${coverage.missing} wrong=${coverage.wrong}`);
    if (coverage.missing > 0 || coverage.wrong > 0) {
      console.error('REFUSED: rows without a correct index_shard remain. Run --apply to completion first.');
      process.exitCode = 1;
      return;
    }
    await enableShardedReaders(db, {
      nowMs: Date.now(),
      evidence: `verifyIndexShardCoverage scanned=${coverage.scanned} missing=0 wrong=0`,
    });
    console.log('Readers flipped to SHARDED. The legacy indexes may now be deleted (by hand, after this).');
    return;
  }

  console.log(`Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN'}${startAfterId ? `; resuming after ${startAfterId}` : ''}\n`);
  const report = await backfillPeHistoryIndexShard(db, {
    apply,
    startAfterId,
    ...(maxRunMs !== undefined && Number.isFinite(maxRunMs) ? { maxRunMs } : {}),
  });
  console.log(`scanned=${report.scanned} ${apply ? 'written' : 'would write'}=${report.written} pages=${report.pages} complete=${report.complete}`);
  if (!report.complete) {
    console.log(`Budget exhausted. Resume with --resume-after=${report.lastId}`);
  } else if (!apply) {
    console.log('\nDry run only. Re-run with --apply to stamp.');
  } else {
    console.log('\nBackfill complete. Run --cutover to verify and flip the readers.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

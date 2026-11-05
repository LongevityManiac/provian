/**
 * Trust Layer build §2.5 / fold the sealed `pe_history` ledger into `actor_stats_v1` (the
 * live vocabulary's counters, actor-stats/v2: lifetime + day buckets + attested measurements +
 * chain-witnessed payment volume) for every actor, or one actor. Idempotent; zero mint effect.
 *
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-actor-stats.ts # dry run (default)
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-actor-stats.ts --dry-run # dry run (explicit)
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-actor-stats.ts --apply # write
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/backfill-actor-stats.ts --actor <userId> # one actor
 *... --max-attempts <n> # per-actor retries (default 5)
 *
 * SAFE while the relay is live: each actor's write is a transaction that commits only if no live
 * bump landed between the pre-fold read and the write (see actor-stats-backfill.ts). An actor that
 * keeps moving is listed in `actors_skipped_busy` re-run with `--actor <id>`. Run AFTER the
 * actor-stats/v2 relay is deployed (an older relay's bump would rewrite a v2 document as v1).
 * Exit code 2 when any actor was skipped busy. Never run two instances at once.
 */
import admin from 'firebase-admin';
import { backfillActorStats } from '../src/core/pvt/actor-stats-backfill';
import { scriptDb } from './lib/script-db';

admin.initializeApp();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (apply && args.includes('--dry-run')) throw new Error('--apply and --dry-run are mutually exclusive');
  const actorIdx = args.indexOf('--actor');
  const actorId = actorIdx >= 0 ? args[actorIdx + 1] ?? null : null;
  const attemptsIdx = args.indexOf('--max-attempts');
  const maxAttemptsPerActor = attemptsIdx >= 0 ? Number(args[attemptsIdx + 1]) : undefined;
  if (maxAttemptsPerActor !== undefined && !(Number.isSafeInteger(maxAttemptsPerActor) && maxAttemptsPerActor > 0)) {
    throw new Error('--max-attempts must be a positive integer');
  }
  const summary = await backfillActorStats(scriptDb(), {
    apply,
    actorId,
    maxAttemptsPerActor,
    log: (line) => { console.log(line); },
  });
  const { per_actor, ...rest } = summary;
  console.log(JSON.stringify({ ...rest, per_actor_count: per_actor.length }, null, 2));
  if (summary.actors_skipped_busy.length > 0 || summary.actors_undecidable.length > 0) process.exitCode = 2;
}

main().catch((err) => { console.error(err); process.exit(1); });

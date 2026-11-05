/**
 * Operator CLI: re-open chain-record observations that parked because the two
 * RPC legs disagreed (still pending on it, or refused when their horizon ran
 * out on it), so the next watcher cycle settles each under the lane's rule.
 * Dry-run by default.
 *
 * FIRESTORE_DATABASE_ID=relay GOOGLE_CLOUD_PROJECT=provian-ai \
 *   npx tsx scripts/reopen-parked-chain-record-observations.ts --since 2026-10-10T00:00:00Z [--execute]
 *
 * See `reopenParkedChainRecordObservations` in `chain-record-watcher.ts`: only
 * disagreement-parked observations requested at or after `--since` move.
 */

import { reopenParkedChainRecordObservations } from '../src/core/pvt/chain-record-watcher';
import { scriptDb } from './lib/script-db';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const sinceArg = process.argv[process.argv.indexOf('--since') + 1];
  const sinceMs = process.argv.includes('--since') ? Date.parse(sinceArg ?? '') : Number.NaN;
  if (!Number.isFinite(sinceMs)) throw new Error('required: --since <ISO time> [--execute]');
  const report = await reopenParkedChainRecordObservations(scriptDb(), { sinceMs, execute });
  console.log(JSON.stringify({ mode: execute ? 'executed' : 'dry_run', since: new Date(sinceMs).toISOString(), ...report }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}

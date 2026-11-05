/**
 * Operator CLI: purge live-proof probe types from the pending-policy queue
 * (— purge, never reject: a rejected row publishes on
 * /proposals as a declined proposal). Dry-run by default.
 *
 * FIRESTORE_DATABASE_ID=relay npx tsx scripts/purge-pending-policy-probe.ts <type> [<type>…] [--execute]
 *
 * Refuses a named matrix type, a type with a prospective policy pointer, and a
 * queue row that is not `pending_policy` (see `pending-policy-probe-purge.ts`).
 * New live proofs purge their own row with `withPendingPolicyProbe`; this CLI is
 * for residue already left behind.
 */

import { purgePendingPolicyProbe } from '../src/core/pvt/policy/pending-policy-probe-purge';
import { scriptDb } from './lib/script-db';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const types = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (types.length === 0) {
    throw new Error('required: <action_type> [<action_type>…] [--execute]');
  }
  const db = scriptDb();
  let refused = 0;
  for (const actionType of types) {
    try {
      const result = await purgePendingPolicyProbe(db, actionType, { dryRun: !execute });
      console.log(JSON.stringify({ mode: execute ? 'executed' : 'dry_run', ...result }));
    } catch (error) {
      refused += 1;
      console.error(JSON.stringify({
        action_type: actionType,
        refused: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  if (refused > 0) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}

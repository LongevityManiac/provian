/**
 * Trust Layer build §2.1 — migrate the retired `cited_pe_ids` vocabulary into the ONE origin graph
 * as `pe:` edges (zero mint effect; idempotent; never touches a sealed PE).
 *
 *   GCP_PROJECT_ID=provian-ai npx tsx scripts/migrate-cited-pe-ids-to-graph.ts            # dry run
 *   GCP_PROJECT_ID=provian-ai npx tsx scripts/migrate-cited-pe-ids-to-graph.ts --apply    # write edges
 */
import admin from 'firebase-admin';
import { migrateCitedPeIdsToGraph } from '../src/core/pvt/migrate-cited-pe-ids';
import { scriptDb } from './lib/script-db';

admin.initializeApp();

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const summary = await migrateCitedPeIdsToGraph(scriptDb(), {
    apply,
    log: (line) => { console.log(line); },
  });
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry_run', ...summary }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });

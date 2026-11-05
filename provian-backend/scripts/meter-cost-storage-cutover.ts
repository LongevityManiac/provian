/** Dry-run is read-only; execute only after the compatible relay serves all traffic and old writers drain. */
import { execFileSync } from 'child_process';
import { scriptDb } from './lib/script-db';
import { cutoverMeterCostStorage } from '../src/core/meter/cost-storage-cutover';
import { rawPrivateFirestore } from '../src/core/provenance/private-store';
import { backfillPrivateArrayLookups } from './lib/private-array-lookup';
async function main(): Promise<void> {
  const execute = process.argv.includes('--execute'), drained = process.argv.includes('--compatible-traffic-drained');
  if (execute && !drained) throw new Error('meter cost cutover requires compatible traffic and old writer drain');
  process.env.RELAY_SIGNING_KEY ??= execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret=relay-signing-key', '--project=provian-ai'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const db = scriptDb();
  try {
    const indexes = await backfillPrivateArrayLookups(rawPrivateFirestore(db), execute);
    const cutover = execute ? await cutoverMeterCostStorage(db, drained) : null;
    console.log(JSON.stringify({ schema: 'provian.meter-cost-storage-cutover.v1', execute, database: process.env.FIRESTORE_DATABASE_ID ?? '(default)', indexes, cutover }));
  } finally { await rawPrivateFirestore(db).terminate(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'meter cost cutover failed'); process.exitCode = 1; });

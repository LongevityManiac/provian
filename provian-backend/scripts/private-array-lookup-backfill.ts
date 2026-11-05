/** Run only after compatible code has 100% traffic and prior requests have drained. Dry-run default. */
import {execFileSync} from 'child_process';
import {scriptDb} from './lib/script-db';
import {rawPrivateFirestore} from '../src/core/provenance/private-store';
import {backfillPrivateArrayLookups} from './lib/private-array-lookup';
async function main():Promise<void> {
  const execute=process.argv.includes('--execute');
  if(execute&&!process.argv.includes('--compatible-traffic-drained'))throw new Error('verify compatible traffic and request drain before backfill');
  process.env.RELAY_SIGNING_KEY ??= execFileSync('gcloud',['secrets','versions','access','latest','--secret=relay-signing-key','--project=provian-ai'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const db=rawPrivateFirestore(scriptDb());
  const result=await backfillPrivateArrayLookups(db,execute);
  console.log(JSON.stringify({schema:'provian.private-array-lookup.v1',execute,database:process.env.FIRESTORE_DATABASE_ID,result,claims_changed:0,repriced:0,ciphertexts_rewritten:0}));
  await db.terminate();
}
void main().catch(e=>{console.error(e instanceof Error?e.message:'private index backfill failed');process.exitCode=1;});

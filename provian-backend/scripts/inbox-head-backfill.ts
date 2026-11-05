import {execFileSync} from 'child_process';
import {scriptDb} from './lib/script-db';
import {rawPrivateFirestore} from '../src/core/provenance/private-store';
import {backfillInboxHeads} from './lib/inbox-head-backfill';
async function main():Promise<void>{
 const execute=process.argv.includes('--execute');if(execute&&!process.argv.includes('--compatible-traffic-drained'))throw new Error('compatible traffic and request drain must be verified');
 process.env.RELAY_SIGNING_KEY??=execFileSync('gcloud',['secrets','versions','access','latest','--secret=relay-signing-key','--project=provian-ai'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const db=rawPrivateFirestore(scriptDb()),result=await backfillInboxHeads(db,execute);
 console.log(JSON.stringify({schema:'provian.inbox-head-backfill.v1',execute,result,events_changed:0}));await db.terminate();
}
void main().catch(e=>{console.error(e instanceof Error?e.message:'inbox head backfill failed');process.exitCode=1;});

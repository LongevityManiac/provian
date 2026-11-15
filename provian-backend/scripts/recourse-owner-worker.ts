#!/usr/bin/env tsx
/** Inspect the durable recovery queue, or run the Recourse transaction lane the
 * relay runs. The lane's own gas key pays; it holds no restoration authority,
 * and the lane lease keeps this the only writer while it runs. */
import { scriptDb } from './lib/script-db';
import { OWNER_OPERATIONS } from '../src/core/recourse/owner-operation-queue';
import { runRecourseLaneFor } from '../src/core/recourse/transaction-lane-runtime';
async function main():Promise<void>{
  const execute=process.argv.includes('--execute'),watch=process.argv.includes('--watch');
  if(watch&&!execute)throw Error('recourse_watch_requires_execution');
  const db=scriptDb();
  do {
    if(execute){for(const report of await runRecourseLaneFor(db,{budgetMs:30_000}))process.stdout.write(JSON.stringify(report)+'\n');}
    else for(const status of ['submitted','queued']){
      const rows=await db.collection(OWNER_OPERATIONS).where('status','==',status).get();
      for(const row of rows.docs)process.stdout.write(JSON.stringify({id:row.id,status})+'\n');
    }
    if(watch)await new Promise<void>(resolve=>setTimeout(resolve,5000));
  }while(watch);
}
void main().catch(error=>{
  const code=error instanceof Error&&/^recourse_[a-z_]+$/.test(error.message)?error.message:'recourse_owner_operation_failed';
  process.stderr.write(code+'\n');process.exitCode=1;
});

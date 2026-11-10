#!/usr/bin/env tsx
/** Inspect the durable recovery queue, or run the same sponsored worker used by
 * the relay. The existing minter secret supplies gas; no restoration-authority
 * key is needed for credential rotation or a bounded owner intent. */
import { scriptDb } from './lib/script-db';
import { OWNER_OPERATIONS } from '../src/core/recourse/owner-operation-queue';
import { runOwnerOperationWorker } from '../src/core/recourse/owner-operation-runtime';
async function main():Promise<void>{
  const execute=process.argv.includes('--execute'),watch=process.argv.includes('--watch');
  if(watch&&!execute)throw Error('recourse_watch_requires_execution');
  const db=scriptDb();
  do {
    if(execute){const result=await runOwnerOperationWorker(db);if(result)process.stdout.write(JSON.stringify(result)+'\n');}
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

import {forEachPrivateMigrationPage} from '../../../scripts/lib/private-migration-page';

it('waits for every started transaction before refusing and never starts the next batch; RED fail-fast leaves work in flight',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const started:number[]=[],finished:number[]=[];let rejected=false;
 const run=forEachPrivateMigrationPage(Array.from({length:20},(_,i)=>i),async i=>{
  started.push(i);if(i===0)throw new Error('exact original ownership conflict');
  await gate;finished.push(i);
 }).catch(e=>{rejected=true;expect(e.message).toBe('exact original ownership conflict');});
 await new Promise(resolve=>setImmediate(resolve));
 expect(started).toEqual([0,1,2,3,4,5,6,7]);expect(rejected).toBe(false);
 release();await run;expect(finished).toHaveLength(7);expect(started).toHaveLength(8);expect(rejected).toBe(true);
 let redFinished=false;const pending=new Promise<void>(resolve=>setImmediate(()=>{redFinished=true;resolve();}));
 await Promise.all([Promise.reject(new Error('RED')),pending]).catch(()=>{});
 expect(redFinished).toBe(false);await pending;
});

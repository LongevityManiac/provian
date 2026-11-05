import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {vi} from 'vitest';
import {commonsRuntime,durableRuntimeCompleted,commonsRuntimeRpcFailure} from './commons-runtime';
import {describe,it,expect} from 'vitest';
import {requireSuccessfulRuntimeResult} from './commons-runtime';
describe('runtime terminal success',()=>{
 it('accepts a successful completed turn',()=>expect(()=>requireSuccessfulRuntimeResult({status:'ok',result:{}})).not.toThrow());
 it.each([{status:'timeout',providerStarted:false},{status:'error'},{status:'accepted'},{status:'in_flight'},{status:'ok',error:'failed'},{},null])('RED: never acknowledges a non-successful runtime result %j',value=>expect(()=>requireSuccessfulRuntimeResult(value)).toThrow('did not complete successfully'));
});


describe('OpenClaw accepted-run recovery',()=>{
 it('submits once and waits for that accepted run across a timeout and process restart',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'commons-runtime-'));
  const event={sequence:1,thread_id:'thr_one',message_id:'msg_'+'a'.repeat(24)};
  const message={thread_id:event.thread_id,message_id:event.message_id,author_id:'human',author_name:null,anchor_kind:null,anchor_id:null,kind:'text',text:'test',attachment:null,created_at:1,delivered_at:2};
  const invoke=vi.fn().mockResolvedValueOnce({stdout:JSON.stringify({session:null})}).mockResolvedValueOnce({stdout:JSON.stringify({status:'accepted',runId:'run_one'})}).mockResolvedValueOnce({stdout:JSON.stringify({status:'timeout'})}).mockResolvedValueOnce({stdout:JSON.stringify({session:null})}).mockResolvedValueOnce({stdout:JSON.stringify({session:null})}).mockResolvedValueOnce({stdout:JSON.stringify({status:'ok'})});
  try{
   await expect(commonsRuntime(home,{execute:invoke}).run(event,message,null)).rejects.toThrow('did not complete successfully');
   await commonsRuntime(home,{execute:invoke}).run(event,message,null);
   await commonsRuntime(home,{execute:invoke}).run(event,message,null);
   expect(invoke.mock.calls.map(c=>c[1][2])).toEqual(['sessions.describe','agent','agent.wait','sessions.describe','sessions.describe','agent.wait']);
   expect(JSON.parse(invoke.mock.calls[5][1][4])).toMatchObject({runId:'run_one'});
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });
});


describe('durable OpenClaw completion',()=>{
 const key='agent:main:commons:one',run='run_one';
 const done={session:{key,lastRunId:run,status:'done',endedAt:100,hasActiveRun:false,lastRunError:null,abortedLastRun:false}};
 it('accepts the exact persisted terminal projection after the volatile cache is gone',()=>expect(durableRuntimeCompleted(done,run,key)).toBe(true));
 it.each([{lastRunId:'other'},{key:'other'},{status:'running'},{status:'failed'},{endedAt:NaN},{hasActiveRun:true},{lastRunError:'failed'},{abortedLastRun:true}])('RED: rejects non-successful or unrelated terminal evidence %j',delta=>expect(durableRuntimeCompleted({session:{...done.session,...delta}},run,key)).toBe(false));
 it('recovers a forgotten run from its exact unique session without submitting or waiting again',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'commons-runtime-durable-'));
  const event={sequence:1,thread_id:'thr_one',message_id:'msg_'+'e'.repeat(24)};
  const message={thread_id:event.thread_id,message_id:event.message_id,author_id:'human',author_name:null,anchor_kind:null,anchor_id:null,kind:'text',text:'test',attachment:null,created_at:1,delivered_at:2};
  let session='';const invoke=vi.fn(async(_command:string,args:string[])=>{
   const params=JSON.parse(args[4]);
   if(args[2]==='agent'){session=params.sessionKey;return {stdout:JSON.stringify({status:'accepted',runId:'durable_run'})};}
   if(args[2]==='agent.wait')return {stdout:JSON.stringify({status:'timeout'})};
   return {stdout:JSON.stringify({session:{key:session,lastRunId:'durable_run',status:'done',endedAt:123,hasActiveRun:false}})};
  });
  try{
   await commonsRuntime(home,{execute:invoke}).run(event,message,null);
   await commonsRuntime(home,{execute:invoke}).run(event,message,null);
   expect(invoke.mock.calls.map(c=>c[1][2])).toEqual(['sessions.describe','agent','agent.wait','sessions.describe']);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });
});


describe('acceptance response loss',()=>{
 it('recovers from intent after the start response is lost, without submitting the completed turn twice',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'commons-runtime-intent-'));
  const event={sequence:1,thread_id:'thr_one',message_id:'msg_'+'f'.repeat(24)};
  const message={thread_id:event.thread_id,message_id:event.message_id,author_id:'human',author_name:null,anchor_kind:null,anchor_id:null,kind:'text',text:'test',attachment:null,created_at:1,delivered_at:2};
  let accepted=false,key='',run='';const invoke=vi.fn(async(_command:string,args:string[])=>{
   const p=JSON.parse(args[4]);
   if(args[2]==='agent'){accepted=true;key=p.sessionKey;run=p.idempotencyKey;throw new Error('response lost');}
   return {stdout:JSON.stringify({session:accepted?{key,lastRunId:run,status:'done',endedAt:100,hasActiveRun:false}:null})};
  });
  try{
   await expect(commonsRuntime(home,{execute:invoke}).run(event,message,null)).rejects.toThrow('Commons runtime agent failed');
   await commonsRuntime(home,{execute:invoke}).run(event,message,null);
   expect(invoke.mock.calls.map(c=>c[1][2])).toEqual(['sessions.describe','agent','sessions.describe']);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
 });
});


describe('private runtime failure diagnostics',()=>{
 it('names a configured-auth failure without retaining private prompt or native error text',()=>{
  const secret='PRIVATE_SENTINEL_API_TOKEN_AND_PROMPT';
  const error=Object.assign(new Error(secret),{code:1,stdout:JSON.stringify({ok:false,error:{type:'gateway_credentials_required',message:secret}}),stderr:secret});
  const safe=commonsRuntimeRpcFailure('sessions.describe',error);
  expect(safe.name).toBe('CommonsRuntimeRpcError:sessions.describe:gateway_credentials_required:1');
  expect(safe.message).toContain('gateway_credentials_required');
  expect(JSON.stringify(safe)+safe.message+safe.stack).not.toContain(secret);
 });
 it('never copies arbitrary method, code or output fields into logs',()=>{
  const secret='PRIVATE_SENTINEL_TOKEN';
  const safe=commonsRuntimeRpcFailure(secret,{code:secret,stdout:JSON.stringify({error:{type:secret}})});
  expect(safe.name).toBe('CommonsRuntimeRpcError:unknown:command_failed:unknown');
  expect(safe.message+safe.stack).not.toContain(secret);
 });
});

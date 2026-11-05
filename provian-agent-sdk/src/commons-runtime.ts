/** Runtime adapters use local configuration only; event content never chooses an executable. */
import {execFile} from 'child_process';
import {promisify} from 'util';
import * as fs from 'fs';
import * as path from 'path';
import {homedir} from 'os';
import {createHash} from 'crypto';
import {atomicReplacePrivateFile} from './durable-private-file';
import {commonsEventPrompt,type CommonsRuntime} from './commons-events';
const execute=promisify(execFile);
interface RuntimeConfig {kind:'openclaw'|'command';command?:string;args?:string[];agentId?:string}
export function requireSuccessfulRuntimeResult(value:unknown):void {
 if(!value||typeof value!=='object'||(value as {status?:unknown}).status!=='ok'||(value as {error?:unknown}).error)throw new Error('Commons runtime did not complete successfully');
}
export function durableRuntimeCompleted(value:unknown,runId:string,sessionKey:string):boolean {
 if(!value||typeof value!=='object')return false;
 const session=(value as {session?:unknown}).session;
 if(!session||typeof session!=='object')return false;
 const s=session as Record<string,unknown>;
 return s.key===sessionKey&&s.lastRunId===runId&&s.status==='done'&&typeof s.endedAt==='number'&&Number.isFinite(s.endedAt)
  &&s.hasActiveRun!==true&&!s.lastRunError&&s.abortedLastRun!==true;
}
/** Never retain native exec errors: their message/stack can contain the full private prompt. */
export function commonsRuntimeRpcFailure(method:string,error:unknown):Error {
 const rpc=['sessions.describe','agent','agent.wait'].includes(method)?method:'unknown';
 const detail=error&&typeof error==='object'?error as Record<string,unknown>:{};
 const allowedCodes=['ENOENT','EACCES','EAGAIN','ETIMEDOUT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'];
 const code=typeof detail.code==='number'&&Number.isSafeInteger(detail.code)?String(detail.code):allowedCodes.includes(String(detail.code))?String(detail.code):'unknown';
 let kind='command_failed';
 try {
  const output=JSON.parse(typeof detail.stdout==='string'?detail.stdout:'null') as {error?:{type?:unknown}}|null;
  if(['gateway_credentials_required','gateway_transport_error','gateway_request_error'].includes(String(output?.error?.type)))kind=String(output?.error?.type);
 }catch{ /* Untrusted command output is never included in diagnostics. */ }
 const safe=new Error(`Commons runtime ${rpc} failed (${kind}, exit ${code})`);
 safe.name=`CommonsRuntimeRpcError:${rpc}:${kind}:${code}`;
 return safe;
}
type RuntimeCommand=(command:string,args:string[],options:{timeout:number;maxBuffer:number})=>Promise<{stdout:string;stderr?:string}>;
export function commonsRuntime(home:string=homedir(),deps:{execute?:RuntimeCommand}={}):CommonsRuntime {
 const invoke=deps.execute??execute;
 let config:RuntimeConfig={kind:'openclaw',agentId:'main'};
 const file=path.join(home,'.provian','commons-runtime.json');
 try{config=JSON.parse(fs.readFileSync(file,'utf8')) as RuntimeConfig;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!['openclaw','command'].includes(config.kind)||config.command!==undefined&&typeof config.command!=='string'
  ||config.args!==undefined&&(!Array.isArray(config.args)||!config.args.every(s=>typeof s==='string'))
  ||config.agentId!==undefined&&(!/^[a-zA-Z0-9_-]+$/.test(config.agentId)))throw new Error('Invalid Commons runtime config');
 return {async run(event,message,policy){
  const id='provian-commons-'+createHash('sha256').update(message.thread_id+'\0'+message.message_id+'\0'+(event.approval_id??'message')).digest('hex');
  const eventFile=path.join(home,'.provian','messages','runtime-event.json');
  const prompt=commonsEventPrompt(event,message,policy);
  atomicReplacePrivateFile(eventFile,JSON.stringify({schema:'provian.commons-runtime.v1',idempotency_key:id,event,message,reply_policy:policy,prompt}));
  if(config.kind==='command'){
   if(!config.command)throw new Error('Commons runtime command missing');
   // Custom adapter contract: await completion and deduplicate this durable key.
   await invoke(config.command,[...(config.args??[]),eventFile,id],{timeout:660_000,maxBuffer:2*1024*1024});
  }else{
   const agentId=config.agentId??'main';
   const sessionKey=`agent:${agentId}:commons:${id}`;
   const receiptFile=path.join(home,'.provian','messages','runtime-receipts',id+'.json');
   let receipt:{id:string;run_id:string;completed?:boolean;accepted?:boolean}|undefined;
   try{receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8')) as typeof receipt;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(receipt?.id===id&&receipt.completed===true)return;
   const call=async(method:string,params:Record<string,unknown>,timeout:number):Promise<Record<string,unknown>>=>{
    let result:{stdout:string;stderr?:string};
    try {result=await invoke(config.command??'openclaw',['gateway','call',method,'--params',JSON.stringify(params),'--timeout',String(timeout),'--json'],{timeout:timeout+10_000,maxBuffer:2*1024*1024});}
    catch(error){throw commonsRuntimeRpcFailure(method,error);}
    try{return JSON.parse(result.stdout) as Record<string,unknown>;}
    catch{throw new Error(`Commons runtime ${method} returned invalid JSON`);}
   };
   const recoverDurable=async():Promise<boolean>=>durableRuntimeCompleted(await call('sessions.describe',{key:sessionKey,agentId,includeDerivedTitles:false,includeLastMessage:false},30_000),receipt!.run_id,sessionKey);
   if(receipt?.id!==id){
    // The runtime's run identity equals its idempotency key, so journal intent before submission.
    receipt={id,run_id:id,accepted:false};atomicReplacePrivateFile(receiptFile,JSON.stringify(receipt));
   }
   const durable=await call('sessions.describe',{key:sessionKey,agentId,includeDerivedTitles:false,includeLastMessage:false},30_000);
   if(durableRuntimeCompleted(durable,receipt.run_id,sessionKey)){
    atomicReplacePrivateFile(receiptFile,JSON.stringify({...receipt,completed:true}));return;
   }
   const active=(durable.session as {activeRunIds?:unknown}|null)?.activeRunIds;
   if(Array.isArray(active)&&active.includes(receipt.run_id))receipt.accepted=true;
   if(receipt.accepted!==true){
    const started=await call('agent',{agentId,sessionKey,idempotencyKey:id,message:prompt,timeout:600,deliver:false},30_000);
    if(started.status==='ok'){
     requireSuccessfulRuntimeResult(started);atomicReplacePrivateFile(receiptFile,JSON.stringify({id,run_id:String(started.runId??id),completed:true}));return;
    }
    if(!['accepted','in_flight'].includes(String(started.status))||typeof started.runId!=='string')throw new Error('Commons runtime did not accept the turn');
    receipt={id,run_id:started.runId,accepted:true};atomicReplacePrivateFile(receiptFile,JSON.stringify(receipt));
   }
   // Reconnects wait for the accepted run; they never submit the turn again.
   const completed=await call('agent.wait',{runId:receipt.run_id,timeoutMs:600_000},610_000);
   if(completed.status!=='ok'&&!await recoverDurable())requireSuccessfulRuntimeResult(completed);
   else if(completed.status==='ok')requireSuccessfulRuntimeResult(completed);
   atomicReplacePrivateFile(receiptFile,JSON.stringify({...receipt,completed:true}));
  }
 }};
}

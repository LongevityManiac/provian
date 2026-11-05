/** Integration proof against an isolated Firestore emulator, never production. */
import {Firestore} from 'firebase-admin/firestore';
import express from 'express';
import type {Server} from 'http';
import {createAgentAuthMiddleware} from './middleware/agent-auth';
import {createThreadsRouter} from './threads';
import {COMMONS_POLL_IDLE_MS,COMMONS_POLL_DRAIN_MS} from './commons-delivery';
import {prepareAgentDelivery,acknowledgeDelivery,deliveryHead,deliverySequence,deliveryWaiting,decodePendingApproval,DELIVERY_PAGE,PENDING_SCAN_PAGE} from '../core/commons/agent-delivery';
import {privateFirestore} from '../core/provenance/private-store';
import {generateApiCredentials} from '../core/agent-wallet/api-key';
import type {AgentBankDeps} from '../core/agent-bank/types';
import {once} from 'events';
import {performance} from 'perf_hooks';
import {writeFileSync} from 'fs';
let mockCachedWallet:unknown=null;
jest.mock('../cache',()=>({cache:{get:async()=>mockCachedWallet,set:async()=>{},del:async()=>{}}}));
type Count={reads:number;writes:number;deletes:number;rpc:Record<string,number>};
let measurementPhase:string|null=null;
const operations:Record<string,Count>={};
const record=(method:string,field?:'reads'|'writes'|'deletes',amount=1)=>{
 if(!measurementPhase)return;
 const c=operations[measurementPhase]??={reads:0,writes:0,deletes:0,rpc:{}};
 if(field)c[field]+=amount;else c.rpc[method]=(c.rpc[method]??0)+1;
};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'?v as Record<string,unknown>:{};
type RequestFn=(this:unknown,method:string,request:unknown,...rest:unknown[])=>Promise<unknown>;
interface CountStream {emit:(event:string|symbol,...args:unknown[])=>boolean}
type StreamFn=(this:unknown,method:string,bidi:unknown,request:unknown,...rest:unknown[])=>Promise<CountStream>;
function countOperations(db:Firestore):()=>void{
 const proto=Object.getPrototypeOf(db) as {request:RequestFn;requestStream:StreamFn};
 const request=proto.request,stream=proto.requestStream;
 proto.request=function(method,body,...rest){record(method);return request.call(this,method,body,...rest).then(result=>{
  if(method==='commit'||method==='batchWrite')for(const write of object(body).writes as unknown[]??[])record(method,object(write).delete?'deletes':'writes');return result;
 });};
 proto.requestStream=function(method,bidi,body,...rest){record(method);return stream.call(this,method,bidi,body,...rest).then(result=>{
  const emit=result.emit.bind(result);let documents=0;
  result.emit=(event,...args)=>{
   if(event==='data'){
    const row=object(args[0]);
    if(method==='batchGetDocuments'&&(row.found||row.missing))record(method,'reads');
    if(method==='runQuery'&&row.document){documents++;record(method,'reads');}
   }
   if(event==='end'&&method==='runQuery'&&!documents)record(method,'reads');
   return emit(event,...args);
  };return result;
 });};
 return()=>{proto.request=request;proto.requestStream=stream;};
}
const integration=process.env.COMMONS_DELIVERY_EMULATOR==='1'?describe:describe.skip;
integration('Commons poll transport integration',()=>{
 let raw:Firestore,db:Firestore,server:Server,base:string,restoreCounter:()=>void;
 const credential=generateApiCredentials(),wallet='wallet_aw_poll_test',other=generateApiCredentials();
 const auth={Authorization:`Bearer ${credential.api_key}:${credential.api_secret}`};
 const measurements:Record<string,unknown>={};
 beforeAll(async()=>{
  if(!process.env.FIRESTORE_EMULATOR_HOST)throw new Error('Emulator required');
  process.env.RELAY_SIGNING_KEY='synthetic-integration-delivery-key';
  raw=new Firestore({projectId:'demo-commons-events',databaseId:'test'+process.pid});db=privateFirestore(raw);restoreCounter=countOperations(raw);await raw.collection('commons_delivery_state_v1').doc('current').set({active:true});
  for(const [id,c] of [[wallet,credential],['wallet_aw_other',other]] as const){
   await raw.collection('agent_wallets').doc(id).set({id,agent_id:id,status:'active',api_key_prefix:c.api_key_prefix,api_key_hash:c.api_key_hash,api_key_salt:c.api_key_salt});
   await raw.collection('api_key_index').doc(c.api_key_prefix).set({wallet_id:id});
  }
  const app=express();app.use(express.json());app.use('/threads',createAgentAuthMiddleware(db),createThreadsRouter({db,cache:{checkRateLimit:async()=>({allowed:true})}} as unknown as AgentBankDeps));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${(server.address() as {port:number}).port}/threads/events`;
 },30_000);
 afterAll(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await new Promise(r=>setTimeout(r,100));await raw.terminate();restoreCounter();measurements.operations=operations;if(process.env.COMMONS_DELIVERY_MEASUREMENT)writeFileSync(process.env.COMMONS_DELIVERY_MEASUREMENT,JSON.stringify(measurements,null,2));});
 async function append(walletId:string,messageId:string){await db.runTransaction(async tx=>(await prepareAgentDelivery(db,tx,walletId))('thr_test',messageId));}
 const post=(path:string,body:unknown,headers:Record<string,string>=auth)=>fetch(base+path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
 async function poll(after:number){const r=await post('/poll',{after});expect(r.status).toBe(200);return await r.json() as {checkpoint:{cursor:number};events:Array<{sequence:number;message_id:string}>;approvals:Array<{approval_id:string}>;next_poll_ms:number};}
 test('no credential, wrong secret, invalid cursor, a cursor ahead and an inactive rollout fail closed',async()=>{
  expect((await post('/poll',{after:0},{})).status).toBe(401);
  expect((await post('/poll',{after:0},{Authorization:`Bearer ${credential.api_key}:pvns_wrong`})).status).toBe(401);
  for(const after of ['0',-1,1.5,'NaN'])expect((await post('/poll',{after})).status).toBe(400);
  expect((await post('/poll',{after:999})).status).toBe(409);
  await raw.collection('commons_delivery_state_v1').doc('current').set({active:false});
  expect((await post('/poll',{after:0})).status).toBe(503);
  await raw.collection('commons_delivery_state_v1').doc('current').set({active:true});
 });
 test('RED: the retired stream route answers at once and holds nothing',async()=>{
  for(const method of ['GET','POST']){
   const start=performance.now();
   const response=await fetch(base,{method,headers:{...auth,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
   expect(response.status).toBe(410);expect(response.headers.get('content-type')).toContain('application/json');
   await response.text();expect(performance.now()-start).toBeLessThan(2000);
  }
 });
 test('an idle poll answers at once with a bounded read budget and no writes',async()=>{
  measurementPhase='idle_poll';
  const start=performance.now();const body=await poll(0);measurements.idle_poll_ms=performance.now()-start;measurementPhase=null;
  expect(body).toEqual({checkpoint:{cursor:0},events:[],approvals:[],next_poll_ms:COMMONS_POLL_IDLE_MS});
  // Credential index, agent wallet (cached for 30s in production), rollout state, delivery head, one empty pending query.
  expect(operations.idle_poll.reads).toBeGreaterThan(0);
  expect(operations.idle_poll.reads).toBeLessThanOrEqual(5);expect(operations.idle_poll.writes).toBe(0);
 });
 test('backlog arrives in order, never another agent\'s, and a full page asks to drain',async()=>{
  await append(wallet,'msg_'+'1'.repeat(24));
  expect((await poll(0)).events.map(e=>e.sequence)).toEqual([1]);
  await append('wallet_aw_other','msg_'+'9'.repeat(24));
  await append(wallet,'msg_'+'2'.repeat(24));await append(wallet,'msg_'+'3'.repeat(24));
  const backlog=await poll(1);
  expect(backlog.events.map(e=>e.sequence)).toEqual([2,3]);expect(JSON.stringify(backlog)).not.toContain('msg_'+'9'.repeat(24));
  expect(backlog.next_poll_ms).toBe(COMMONS_POLL_IDLE_MS);
  for(let i=0;i<DELIVERY_PAGE+2;i++)await append(wallet,'msg_'+String(i).padStart(24,'b'));
  const page=await poll(3);expect(page.events).toHaveLength(DELIVERY_PAGE);expect(page.next_poll_ms).toBe(COMMONS_POLL_DRAIN_MS);
  const rest=await poll(3+DELIVERY_PAGE);expect(rest.events).toHaveLength(2);expect(rest.next_poll_ms).toBe(COMMONS_POLL_IDLE_MS);
  const stored=await deliveryHead(db,wallet).get();expect(stored.get('_provian_store')).toBe(1);expect(JSON.stringify(stored.data())).not.toContain(wallet);
 },30_000);
 test('a pending approval is delivered once resolved, cleared on acknowledgment, and never across agents',async()=>{
  const acked=(await poll(0)).checkpoint.cursor,head=deliverySequence(db,await deliveryHead(db,wallet).get());
  for(let sequence=acked+1;sequence<=head;sequence++)expect((await post('/ack',{sequence})).status).toBe(200);
  const messageId='msg_'+'a'.repeat(24);
  await db.collection('commons_threads').doc('thr_test').set({thread_id:'thr_test',party_a:'human',party_b:wallet,parties:{human:{kind:'human',id:'human'},[wallet]:{kind:'agent',id:wallet}},read_cursors:{},last_message_at:1,message_count:1});
  await db.collection('commons_thread_messages').doc(messageId).set({message_id:messageId,thread_id:'thr_test',author_id:'human',created_at:1,kind:'text',pe_id:'pe_subject',ciphertexts:{}});
  await db.collection('human_approval_requests_v1').doc('req_own').set({request_id:'req_own',agent_wallet_id:wallet,subject_pe_id:'pe_subject',status:'pending',expires_at_ms:Date.now()+100000});
  await append(wallet,messageId);
  const delivered=await poll(0);const sequence=delivered.events.at(-1)!.sequence;expect(delivered.events.at(-1)!.message_id).toBe(messageId);
  const pending={sequence,thread_id:'thr_test',message_id:messageId,approval_id:'req_own'};
  expect((await post('/ack',{sequence,pending})).status).toBe(200);
  expect((await poll(sequence)).approvals).toEqual([]);
  await db.collection('human_approval_requests_v1').doc('req_own').update({status:'satisfied',decision:'approved'});
  expect((await poll(sequence)).approvals).toEqual([pending]);
  expect((await post('/ack',{sequence,resolved_approval_id:'req_own'})).status).toBe(200);
  expect((await poll(sequence)).approvals).toEqual([]);
  // An approval that now names another agent is a corrupt binding: refused, never delivered.
  expect((await post('/ack',{sequence,pending})).status).toBe(200);
  await db.collection('human_approval_requests_v1').doc('req_own').update({agent_wallet_id:'wallet_aw_other'});
  expect((await post('/poll',{after:sequence})).status).toBe(403);
  expect((await post('/ack',{sequence,resolved_approval_id:'req_own'})).status).toBe(200);
  measurementPhase='fresh_resume';
  const resumed=await poll(0);expect(resumed.checkpoint.cursor).toBe(sequence);expect(resumed.events).toEqual([]);measurementPhase=null;
 },30_000);
 test('the heartbeat hint wakes for an unacknowledged event or a decided, expired or vanished approval, never for one still awaiting its owner',async()=>{
  const fresh='wallet_aw_hint',msg='msg_'+'d'.repeat(24);
  measurementPhase='heartbeat_hint';expect(await deliveryWaiting(db,fresh)).toBe(false);measurementPhase=null;
  // A head read and one empty pending query: the hint adds two reads to a heartbeat already sent.
  expect(operations.heartbeat_hint.reads).toBe(2);expect(operations.heartbeat_hint.writes).toBe(0);
  await append(fresh,msg);expect(await deliveryWaiting(db,fresh)).toBe(true);
  await acknowledgeDelivery(db,fresh,1);expect(await deliveryWaiting(db,fresh)).toBe(false);
  const approval=(id:string,row:Record<string,unknown>)=>db.collection('human_approval_requests_v1').doc(id).set({request_id:id,agent_wallet_id:fresh,subject_pe_id:'pe_hint',...row});
  await approval('req_hint',{status:'pending',expires_at_ms:Date.now()+100000});
  await acknowledgeDelivery(db,fresh,1,{sequence:1,thread_id:'thr_test',message_id:msg,approval_id:'req_hint'});
  expect(await deliveryWaiting(db,fresh)).toBe(false);
  await approval('req_hint',{status:'satisfied',decision:'approved',expires_at_ms:Date.now()+100000});expect(await deliveryWaiting(db,fresh)).toBe(true);
  await approval('req_hint',{status:'pending',expires_at_ms:Date.now()-1});expect(await deliveryWaiting(db,fresh)).toBe(true);
  await db.collection('human_approval_requests_v1').doc('req_hint').delete();expect(await deliveryWaiting(db,fresh)).toBe(true);
  await acknowledgeDelivery(db,fresh,1,undefined,'req_hint');expect(await deliveryWaiting(db,fresh)).toBe(false);
 });
 test('a vanished approval is cleared by the next poll instead of waking every heartbeat',async()=>{
  const ack=(await poll(0)).checkpoint.cursor,msg='msg_'+'e'.repeat(24);
  await db.collection('human_approval_requests_v1').doc('req_gone').set({request_id:'req_gone',agent_wallet_id:wallet,subject_pe_id:'pe_gone',status:'pending',expires_at_ms:Date.now()+100000});
  await acknowledgeDelivery(db,wallet,ack,{sequence:ack,thread_id:'thr_test',message_id:msg,approval_id:'req_gone'});
  await db.collection('human_approval_requests_v1').doc('req_gone').delete();
  expect(await deliveryWaiting(db,wallet)).toBe(true);
  expect((await poll(ack)).approvals).toEqual([]);
  expect(await deliveryWaiting(db,wallet)).toBe(false);
 });
 test('decided approvals beyond one page arrive over drain polls, never in a reply the consumer must refuse',async()=>{
  const ack=(await poll(0)).checkpoint.cursor,ids=Array.from({length:DELIVERY_PAGE+1},(_,i)=>'req_page_'+i);
  for(const id of ids){
   await db.collection('human_approval_requests_v1').doc(id).set({request_id:id,agent_wallet_id:wallet,subject_pe_id:'pe_page',status:'satisfied',decision:'approved',expires_at_ms:Date.now()+100000});
   await acknowledgeDelivery(db,wallet,ack,{sequence:ack,thread_id:'thr_test',message_id:'msg_'+'f'.repeat(24),approval_id:id});
  }
  const first=await poll(ack);expect(first.approvals).toHaveLength(DELIVERY_PAGE);expect(first.next_poll_ms).toBe(COMMONS_POLL_DRAIN_MS);
  for(const a of first.approvals)await acknowledgeDelivery(db,wallet,ack,undefined,a.approval_id);
  const rest=await poll(ack);expect(rest.approvals).toHaveLength(1);expect(rest.next_poll_ms).toBe(COMMONS_POLL_IDLE_MS);
  await acknowledgeDelivery(db,wallet,ack,undefined,rest.approvals[0].approval_id);
  expect((await poll(ack)).approvals).toEqual([]);
 },60_000);
 test('a decided approval behind a full page of undecided ones still wakes the heartbeat and is delivered',async()=>{
  const ack=(await poll(0)).checkpoint.cursor,count=PENDING_SCAN_PAGE+5;
  for(let i=0;i<count;i++){
   const id='req_wait_'+i;
   await db.collection('human_approval_requests_v1').doc(id).set({request_id:id,agent_wallet_id:wallet,subject_pe_id:'pe_wait',status:'pending',expires_at_ms:Date.now()+100000});
   await acknowledgeDelivery(db,wallet,ack,{sequence:ack,thread_id:'thr_test',message_id:'msg_'+'0'.repeat(24),approval_id:id});
  }
  // The row read last in storage order, so it sits past the first scan page.
  const rows=(await deliveryHead(db,wallet).collection('pending').orderBy('__name__').get()).docs;
  expect(rows).toHaveLength(count);
  const behind=decodePendingApproval(db,rows[rows.length-1]).approval_id;
  measurementPhase='pending_walk';expect(await deliveryWaiting(db,wallet)).toBe(false);measurementPhase=null;
  // One approval read per page of rows plus the head, never one per row: time cannot grow with the backlog.
  expect(operations.pending_walk.rpc.batchGetDocuments).toBeLessThanOrEqual(1+Math.ceil(count/PENDING_SCAN_PAGE));
  await db.collection('human_approval_requests_v1').doc(behind).update({status:'satisfied',decision:'approved'});
  expect(await deliveryWaiting(db,wallet)).toBe(true);
  expect((await poll(ack)).approvals.map(a=>a.approval_id)).toEqual([behind]);
  for(const row of rows)await acknowledgeDelivery(db,wallet,ack,undefined,decodePendingApproval(db,row).approval_id);
  expect(await deliveryWaiting(db,wallet)).toBe(false);
 },120_000);
 test('a revoked credential receives nothing, even with a page waiting',async()=>{
  const acked=(await poll(0)).checkpoint.cursor;
  // The middleware trusts a short-lived cached wallet; the poll re-reads before handing over a page.
  mockCachedWallet=(await raw.collection('agent_wallets').doc(wallet).get()).data();
  await raw.collection('agent_wallets').doc(wallet).update({status:'revoked'});
  try{
   expect((await poll(acked)).events).toEqual([]);
   await append(wallet,'msg_'+'c'.repeat(24));
   const refused=await post('/poll',{after:acked});expect(refused.status).toBe(401);expect(await refused.text()).not.toContain('msg_'+'c'.repeat(24));
  }finally{mockCachedWallet=null;await raw.collection('agent_wallets').doc(wallet).update({status:'active'});}
  await raw.collection('api_key_index').doc(credential.api_key_prefix).delete();
  expect((await post('/poll',{after:0})).status).toBe(401);
 });
});

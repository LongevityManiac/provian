import {describe,it,expect,vi} from 'vitest';
import * as fs from 'fs';import * as os from 'os';import * as path from 'path';
import {CommonsEventConsumer,parseCommonsPoll,parseCommonsEvent,commonsEventPrompt,startCommonsEvents,signalCommonsMailWaiting,COMMONS_POLL_TIMEOUT_MS,type CommonsRuntime} from './commons-events';
import {deriveMessageKeyPair,sealThreadMessage} from './thread-crypto';
const wallet='wallet_aw_a',thread='thr_123',message='msg_'+'1'.repeat(24);
const event={sequence:1,thread_id:thread,message_id:message};
function fixture(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'commons-event-test-'));
 const keys=deriveMessageKeyPair('1'.repeat(64)),sealed=sealThreadMessage('hello',{[wallet]:keys.pubkeyB64u});
 const relay={acknowledgeCommonsEvent:vi.fn(async()=>{}),markThreadRead:vi.fn(async(_thread?:string,_upTo?:number)=>({})),getDeliveredMessage:vi.fn(async(_messageId?:string,_approvalId?:string)=>({thread:{thread_id:thread,party_a:wallet,party_b:'human',read_cursors:{}},messages:[{message_id:message,thread_id:thread,author_id:'human',ciphertexts:sealed.ciphertexts,created_at:100,kind:'text',pe_id:'pe_1'}],reply_policy:{mode:'answer_anyone'}}))};
 const runtime={run:vi.fn<CommonsRuntime['run']>(async()=>{})};
 return {home,keys,relay,runtime,input:{home,walletId:wallet,apiKey:'a',apiSecret:'b',relayUrl:'https://api.provian.ai',relay,runtime,secretKey:async()=>new Uint8Array(keys.secretKey)}};
}
describe('Commons event delivery',()=>{
 it('starts the runtime immediately, decrypts locally, and never repeats after reconnect or restart',async()=>{
  const f=fixture();try{
   const consumer=new CommonsEventConsumer(f.input);await consumer.accept(event);await consumer.accept(event);
   await new CommonsEventConsumer(f.input).accept(event);
   expect(f.runtime.run).toHaveBeenCalledTimes(1);expect(f.runtime.run.mock.calls[0]).toEqual([event,expect.objectContaining({text:'hello'}),expect.anything()]);
   expect(f.relay.getDeliveredMessage).toHaveBeenCalledTimes(1);expect(consumer.after).toBe(1);
  }finally{fs.rmSync(f.home,{recursive:true,force:true});}
 });
 it('keeps the cursor durable only after a running turn finishes despite a disconnected stream',async()=>{
  const f=fixture();let finish:()=>void=()=>{};f.runtime.run.mockImplementation(()=>new Promise<void>(r=>{finish=r;}));
  const c=new CommonsEventConsumer(f.input),running=c.accept(event);await vi.waitFor(()=>expect(f.runtime.run).toHaveBeenCalledTimes(1));
  expect(c.after).toBe(0);finish();await running;expect(new CommonsEventConsumer(f.input).after).toBe(1);fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('recovers offline backlog in order and rejects a gap without advancing',async()=>{
  const f=fixture(),c=new CommonsEventConsumer(f.input);await expect(c.accept({...event,sequence:2})).rejects.toThrow('gap');expect(c.after).toBe(0);
  await c.accept(event);await c.accept({...event,sequence:2});expect(f.runtime.run).toHaveBeenCalledTimes(2);fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('RED: corrupt state, cross-agent messages, missing keys and runtime failures cannot acknowledge',async()=>{
  const f=fixture(),c=new CommonsEventConsumer(f.input);f.runtime.run.mockRejectedValueOnce(new Error('offline'));
  await expect(c.accept(event)).rejects.toThrow('offline');expect(c.after).toBe(0);
  await expect(new CommonsEventConsumer({...f.input,secretKey:async()=>null}).accept(event)).rejects.toThrow('key unavailable');
  const foreign={acknowledgeCommonsEvent:vi.fn(async()=>{}),markThreadRead:vi.fn(async()=>({})),getDeliveredMessage:async()=>({thread:{thread_id:thread,party_a:'other',party_b:'human'},messages:[{message_id:message,thread_id:thread}]})};
  await expect(new CommonsEventConsumer({...f.input,relay:foreign}).accept(event)).rejects.toThrow('binding');
  fs.writeFileSync(path.join(f.home,'.provian/messages/event-cursor.json'),'{}');expect(()=>new CommonsEventConsumer(f.input)).toThrow('Invalid Commons event cursor');fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('does not wake for a message already read elsewhere',async()=>{
  const f=fixture();const original=await f.relay.getDeliveredMessage();f.relay.getDeliveredMessage.mockResolvedValue({...original,thread:{...original.thread,read_cursors:{[wallet]:100}}});
  const c=new CommonsEventConsumer(f.input);await c.accept(event);expect(f.runtime.run).not.toHaveBeenCalled();expect(c.after).toBe(1);fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('bounds an untrusted poll reply and clamps the relay cadence',()=>{
  const ok={checkpoint:{cursor:3},events:[{...event,sequence:4}],approvals:[{...event,approval_id:'req_1'}],next_poll_ms:60_000};
  expect(parseCommonsPoll(ok)).toEqual(ok);
  expect(parseCommonsPoll({...ok,next_poll_ms:0}).next_poll_ms).toBe(1_000);
  expect(parseCommonsPoll({...ok,next_poll_ms:1e12}).next_poll_ms).toBe(3_600_000);
  expect(()=>parseCommonsPoll({...ok,checkpoint:undefined})).toThrow('checkpoint');
  expect(()=>parseCommonsPoll({...ok,events:[{...event,message_id:'../../credential'}]})).toThrow();
  expect(()=>parseCommonsPoll({...ok,approvals:[event]})).toThrow('approval');
  expect(()=>parseCommonsPoll({...ok,events:Array.from({length:501},()=>event)})).toThrow();
  expect(()=>parseCommonsPoll({...ok,next_poll_ms:'soon'})).toThrow('cadence');
 });
 describe('poll loop',()=>{
  const relayUrl='https://93.184.215.14';
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const idle={checkpoint:{cursor:0},events:[],approvals:[],next_poll_ms:60_000};
  async function run(fetchFn:typeof fetch,f:ReturnType<typeof fixture>){
   const loop=startCommonsEvents({...f.input,relayUrl,fetch:fetchFn});
   return loop;
  }
  it('RED: every request is a short poll that returns, never a held stream',async()=>{
   vi.useFakeTimers();const f=fixture();
   const fetchFn=vi.fn<typeof fetch>(async()=>reply(idle));
   const loop=await run(fetchFn,f);
   try{
    await vi.waitFor(()=>expect(fetchFn).toHaveBeenCalledTimes(1));
    const [url,init]=fetchFn.mock.calls[0];
    expect(String(url)).toBe(relayUrl+'/v1/threads/events/poll');
    expect(JSON.parse(String(init?.body))).toHaveProperty('private_request');
   }finally{loop.stop();await loop.done;vi.useRealTimers();fs.rmSync(f.home,{recursive:true,force:true});}
  });
  it('an idle agent asks once per relay cadence, and a live conversation polls faster',async()=>{
   vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(0);const f=fixture();let n=0;
   const fetchFn=vi.fn<typeof fetch>(async()=>reply(++n===2?{...idle,events:[event]}:{...idle,checkpoint:{cursor:n>2?1:0}}));
   const loop=await run(fetchFn,f);
   try{
    await vi.waitFor(()=>expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(59_000);expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.waitFor(()=>expect(f.runtime.run).toHaveBeenCalledTimes(1));
    // Within the active window the next ask comes 15s later, not 60s.
    await vi.advanceTimersByTimeAsync(14_000);expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);expect(fetchFn).toHaveBeenCalledTimes(3);
    // Once the window passes, the cadence returns to the relay's 60s.
    await vi.advanceTimersByTimeAsync(6*60_000);const settled=fetchFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4*60_000);expect(fetchFn.mock.calls.length-settled).toBe(4);
   }finally{loop.stop();await loop.done;vi.useRealTimers();vi.restoreAllMocks();fs.rmSync(f.home,{recursive:true,force:true});}
  });
  it('the request timeout never cancels a runtime turn started from its reply',async()=>{
   vi.useFakeTimers();const f=fixture();let n=0;
   f.runtime.run.mockImplementation(()=>new Promise<void>(r=>setTimeout(r,COMMONS_POLL_TIMEOUT_MS*3)));
   const fetchFn=vi.fn<typeof fetch>(async(_u,init)=>{
    if(++n>1)return reply({...idle,checkpoint:{cursor:1}});
    expect(init?.signal?.aborted).toBe(false);return reply({...idle,events:[event]});
   });
   const loop=await run(fetchFn,f);
   try{
    await vi.waitFor(()=>expect(f.runtime.run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(COMMONS_POLL_TIMEOUT_MS*3+10);
    await vi.waitFor(()=>expect(f.relay.acknowledgeCommonsEvent).toHaveBeenCalledWith(1,undefined,undefined));
   }finally{loop.stop();await loop.done;vi.useRealTimers();fs.rmSync(f.home,{recursive:true,force:true});}
  });
  it('RED: an idle agent makes no request between heartbeats, and a mail-waiting heartbeat polls at once',async()=>{
   vi.useFakeTimers();const f=fixture();let n=0;
   const fetchFn=vi.fn<typeof fetch>(async()=>reply(++n===2?{...idle,events:[event],next_poll_ms:3_600_000}:{...idle,checkpoint:{cursor:n>2?1:0},next_poll_ms:3_600_000}));
   const loop=await run(fetchFn,f);
   try{
    await vi.waitFor(()=>expect(fetchFn).toHaveBeenCalledTimes(1));
    // Six heartbeat periods with nothing waiting: not one further request.
    await vi.advanceTimersByTimeAsync(60*60_000-1);expect(fetchFn).toHaveBeenCalledTimes(1);
    signalCommonsMailWaiting();
    await vi.waitFor(()=>expect(f.runtime.run).toHaveBeenCalledTimes(1));expect(fetchFn).toHaveBeenCalledTimes(2);
   }finally{loop.stop();await loop.done;vi.useRealTimers();fs.rmSync(f.home,{recursive:true,force:true});}
  });
  it('a refused or failing poll backs off instead of retrying hot',async()=>{
   vi.useFakeTimers();const f=fixture();
   const fetchFn=vi.fn<typeof fetch>(async()=>reply({error:'gone'},410));
   const loop=await run(fetchFn,f);
   try{
    await vi.waitFor(()=>expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    // 2s, 4s, 8s, 16s (+ up to 25% jitter) fit in a minute; a hot loop would not.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(5);expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(f.runtime.run).not.toHaveBeenCalled();
   }finally{loop.stop();await loop.done;vi.useRealTimers();fs.rmSync(f.home,{recursive:true,force:true});}
  });
  it('a resolved approval in the reply runs its follow-up and acknowledges it',async()=>{
   vi.useFakeTimers();const f=fixture();let n=0;
   const fetchFn=vi.fn<typeof fetch>(async()=>reply(++n===1?{...idle,checkpoint:{cursor:1},approvals:[{...event,approval_id:'req_1'}]}:{...idle,checkpoint:{cursor:1}}));
   const loop=await run(fetchFn,f);
   try{
    await vi.waitFor(()=>expect(f.relay.acknowledgeCommonsEvent).toHaveBeenCalledWith(1,undefined,'req_1'));
    expect(f.relay.getDeliveredMessage).toHaveBeenCalledWith(message,'req_1');
   }finally{loop.stop();await loop.done;vi.useRealTimers();fs.rmSync(f.home,{recursive:true,force:true});}
  });
 });
 it.each(['markThreadRead','acknowledgeCommonsEvent'] as const)('a failed %s retries only the acknowledgment after a restart, never the completed runtime',async method=>{
  const f=fixture();f.relay[method].mockRejectedValueOnce(new Error('network'));
  const c=new CommonsEventConsumer(f.input);await expect(c.accept(event)).rejects.toThrow('network');expect(c.after).toBe(0);
  await new CommonsEventConsumer(f.input).accept(event);expect(f.runtime.run).toHaveBeenCalledTimes(1);
  fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('an older completed approval remains journaled when a different thread completes before its retry',async()=>{
  const f=fixture(),original=await f.relay.getDeliveredMessage(),other='msg_'+'2'.repeat(24);
  f.relay.getDeliveredMessage.mockImplementation(async(messageId?:string)=>messageId===other?{...original,thread:{...original.thread,thread_id:'thr_other'},messages:[{...original.messages[0],message_id:other,thread_id:'thr_other'}]}:original);
  f.relay.markThreadRead.mockRejectedValueOnce(new Error('offline'));
  await expect(new CommonsEventConsumer(f.input).approval({...event,approval_id:'apr_old'})).rejects.toThrow('offline');
  await new CommonsEventConsumer(f.input).accept({...event,message_id:other,thread_id:'thr_other'});
  await new CommonsEventConsumer(f.input).approval({...event,approval_id:'apr_old'});
  expect(f.runtime.run).toHaveBeenCalledTimes(2);fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('attachment-only records cannot block the following text message',async()=>{
  const f=fixture();const original=await f.relay.getDeliveredMessage();
  f.relay.getDeliveredMessage.mockResolvedValueOnce({...original,messages:[{...original.messages[0],kind:'presentation_request',ciphertexts:{}}]});
  const c=new CommonsEventConsumer(f.input);await c.accept(event);await c.accept({...event,sequence:2});
  expect(c.after).toBe(2);expect(f.runtime.run.mock.calls[0][1]).toMatchObject({text:null,kind:'presentation_request'});
  fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('an approval completed during the first turn schedules an approved follow-up using a small delta',async()=>{
  const f=fixture(),original=await f.relay.getDeliveredMessage();
  const policy={mode:'ask_me_first',linked_human:'owner'};
  const approved={request_id:'req_1',status:'satisfied',decision:'approved',expires_at_ms:Date.now()+10000};
  f.relay.getDeliveredMessage.mockResolvedValueOnce({...original,reply_policy:policy});
  f.relay.getDeliveredMessage.mockResolvedValue({...original,reply_policy:policy,approval:approved} as typeof original);
  const c=new CommonsEventConsumer(f.input);await c.accept(event);
  expect(f.relay.acknowledgeCommonsEvent).toHaveBeenLastCalledWith(1,{...event,approval_id:'req_1'},undefined);
  await c.approval({...event,approval_id:'req_1'});
  expect(f.runtime.run).toHaveBeenCalledTimes(2);
  expect(f.relay.acknowledgeCommonsEvent).toHaveBeenLastCalledWith(1,undefined,'req_1');
  fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('a relay checkpoint skips acknowledged history after local state loss',async()=>{
  const f=fixture(),c=new CommonsEventConsumer(f.input);c.checkpoint({cursor:10000});
  await c.accept({...event,sequence:10001});expect(f.relay.getDeliveredMessage).toHaveBeenCalledTimes(1);expect(c.after).toBe(10001);
  expect(JSON.stringify(f.relay.acknowledgeCommonsEvent.mock.calls[0]).length).toBeLessThan(200);
  fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('legacy same-time siblings are both consumed after cutover stopped the old consumer',async()=>{
  const f=fixture(),original=await f.relay.getDeliveredMessage();let read=0;
  f.relay.getDeliveredMessage.mockImplementation(async()=>({...original,thread:{...original.thread,read_cursors:{[wallet]:read}},messages:[{...original.messages[0],notification_legacy:true}]}));
  f.relay.markThreadRead.mockImplementation(async(_thread?:string,upTo?:number)=>{read=upTo??0;return {};});
  const c=new CommonsEventConsumer(f.input);await c.accept(event);await c.accept({...event,sequence:2});
  expect(f.runtime.run).toHaveBeenCalledTimes(2);fs.rmSync(f.home,{recursive:true,force:true});
 });
 it('the runtime instruction binds a reply retry key and forbids history polling',()=>{
  expect(commonsEventPrompt(event,{thread_id:thread,message_id:message,author_id:'h',author_name:null,anchor_kind:null,anchor_id:null,kind:'text',text:'hello',attachment:null,created_at:1,delivered_at:2},null)).toContain('--idempotency-key commons-reply:'+message);
 });
});

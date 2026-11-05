import {describe,it,expect,afterEach} from 'vitest';
import fs from 'fs';import os from 'os';import path from 'path';
import {configureProgram,ProgramWitnessRegistry,type SessionDescription} from './program-witness';
import {TranscriptPlugin} from './plugins/transcript/TranscriptPlugin';
import {ProgramProxyTurns} from './plugins/model-proxy/program-turns';
import {OTelPlugin,TRACE_IDLE_FLUSH_MS,type ParsedOtlpSpan} from './plugins/OTelPlugin';
import type {ProvianObserver} from './ProvianObserver';
import type {ModelTurnObservation} from './plugins/model-proxy/parse';
const stamp=1791480000000,homes:string[]=[];
const home=()=>{const h=fs.mkdtempSync(path.join(os.tmpdir(),'response-unit-'));homes.push(h);return h;};
afterEach(()=>{for(const h of homes.splice(0))fs.rmSync(h,{recursive:true,force:true});});
const observer={log:()=>{},observerDeviceWitness:()=>({type:'observer_device',identity:'existing-device',attestation_tier:'software'})} as unknown as ProvianObserver;
const responses=[{id:'r1',calls:[{id:'c1',name:'Read',arguments:{file_path:'/private/config'}},{id:'c2',name:'Bash',arguments:{command:'false'}}]},{id:'r2',calls:[{id:'c3',name:'Read',arguments:{file_path:'/private/config'}}]},{id:'pure',calls:[]}];
const row=(r:unknown)=>JSON.stringify(r)+'\n';
function setup(fragmented=false){
 const h=home(),root=path.join(h,'sessions');fs.mkdirSync(root);const file=path.join(root,'main.jsonl');
 const spec:SessionDescription={root,maxDepth:0,suffix:'.jsonl',timestamp:'timestamp',responseId:'id',atomicResponses:!fragmented,responseParts:'calls.*',rules:[{kind:'model_response',where:[{path:'kind',equals:'response'}]},{kind:'tool_call',at:'calls.*',name:'name',id:'id',input:'arguments'},{kind:'turn_end',where:[{path:'done',equals:true}]}]};
 fs.writeFileSync(file,row({kind:'response',id:'baseline',timestamp:stamp-1,calls:[{id:'baseline-call',name:'Read'}],done:true}));
 const registryFile=path.join(h,'.provian','program-witnesses.json'),raw={program:'demo',processNames:['demo'],lane:'transcript',session:spec};
 configureProgram(raw,registryFile,stamp);return {h,root,file,raw,registryFile,registry:new ProgramWitnessRegistry(registryFile)};
}
async function read(f:ReturnType<typeof setup>){const p=new TranscriptPlugin({home:f.h,registry:f.registry,now:()=>stamp+5000});await p.init(observer);await p.start();return p;}
const span=(id:string,attributes:Record<string,unknown>,parent=''):ParsedOtlpSpan=>({name:id,traceId:'recorded-session',spanId:id,parentSpanId:parent,startTimeUnixMs:stamp+1,endTimeUnixMs:stamp+10,status:'ok',spanKind:null,attributes,resourceAttributes:{},scopeName:null});
const quiet=(p:OTelPlugin)=>{for(const t of (p as unknown as {traces:Map<string,{lastSeenAtMs:number}>}).traces.values())t.lastSeenAtMs=Date.now()-TRACE_IDLE_FLUSH_MS-1;p.tick(null);};
describe(' one PE per tool-calling MODEL RESPONSE, all lanes',()=>{
 it(' stable response IDs keep interleaved fragments separate and close the matching response only (RED)',async()=>{
  const f=setup(true);
  for(const [id,call] of [['A','a'],['B','b'],['A','a2']]) fs.appendFileSync(f.file,row({kind:'response',id,timestamp:stamp+1000,calls:[{id:call,name:'Read'}]}));
  let p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
  for(const id of ['A','B']) fs.appendFileSync(f.file,row({id,done:true,timestamp:stamp+1001}));
  p=await read(f);const pes=p.drainPEs();
  expect(pes.map(pe=>pe.metadata?.tool_count)).toEqual([2,1]);
  expect(new Set(pes.map(pe=>pe.idempotencyKey)).size).toBe(2);
  for(const pe of pes)p.onCommitted(pe,'submitted');await p.stop();
  expect((await read(f)).drainPEs()).toEqual([]);
 });
 it('known non-tool tails consume without minting or a false repair alarm across re-description and restart',async()=>{
  const f=setup();const spec={...f.raw.session,rules:[...f.raw.session.rules,
   {kind:'user_prompt' as const,where:[{path:'kind',equals:'prompt'}]},
   {kind:'ignore' as const,where:[{path:'kind',equals:'custom'}]},
   {kind:'tool_result' as const,where:[{path:'kind',equals:'result'}],id:'call_id',text:'text'}]};
  configureProgram({...f.raw,session:spec},f.registryFile,stamp);
  fs.appendFileSync(f.file,row({kind:'response',id:'observed',timestamp:stamp+1000,calls:[{id:'call',name:'Read'}],done:true}));
  let p=await read(f);const tools=p.drainPEs();expect(tools).toHaveLength(1);p.onCommitted(tools[0],'submitted');await p.stop();
  const tail=row({kind:'response',id:'pure',timestamp:stamp+2000,calls:[],done:true})
   +row({kind:'prompt',timestamp:stamp+2000})+row({kind:'custom',timestamp:stamp+2000})
   +row({kind:'result',timestamp:stamp+2000,call_id:'unknown',text:'not an observed payment'});
  fs.appendFileSync(f.file,tail);fs.writeFileSync(path.join(f.root,'idle.jsonl'),tail);
  // RED: the former blanket no-tool guard holds both real, fully described tails forever.
  for(let n=0;n<2;n++){
   p=await read(f);expect(p.drainPEs()).toEqual([]);expect(p.captureHealth().formatBrokenPrograms).toEqual([]);await p.stop();
   const state=JSON.parse(fs.readFileSync(path.join(f.h,'.provian','described-response-state.json'),'utf8'));
   expect(Object.values(state.sources).map((s:any)=>s.cursor).sort()).toEqual([fs.statSync(f.file).size,Buffer.byteLength(tail)].sort());
   configureProgram({...f.raw,session:spec},f.registryFile,stamp+5000);
  }
 });
 it('same recorded session yields two PEs in each lane; RED old user-task/trace grouping yields one',async()=>{
  const f=setup();for(const r of responses)fs.appendFileSync(f.file,row({kind:'response',timestamp:stamp+1000,...r}));
  const files=await read(f),filePEs=files.drainPEs();expect(filePEs).toHaveLength(2);expect(filePEs.map(p=>p.metadata?.tool_count)).toEqual([2,1]);
  const proxy=new ProgramProxyTurns(path.join(f.h,'proxy.json'));
  for(const r of responses)proxy.observe('demo',{recognized:true,protocol:'openai_chat',model:'recorded-model',provider:'openai',responseId:r.id,streamed:false,toolCalls:r.calls.map(c=>({...c,input:c.arguments})),tokens:{input:1,output:2,total:3}} as ModelTurnObservation,{start:stamp,end:stamp+1000,witness:null,digest:'sha256:'+'a'.repeat(64)});
  const proxyPEs=proxy.drain();expect(proxyPEs).toHaveLength(2);expect(proxyPEs.map(p=>p.metadata?.tool_count)).toEqual([2,1]);
  const reg={allows:(p:string|null,l:string)=>p==='demo'&&l==='otel'} as ProgramWitnessRegistry;
  const otelJournal=path.join(f.h,'otel.json');let otel=new OTelPlugin({forceActive:true,programRegistry:reg,journalPath:otelJournal});await otel.init(observer);
  for(const r of responses)otel.ingestParsedSpans([span(r.id,{'gen_ai.operation.name':'chat','gen_ai.response.id':r.id,'gen_ai.output.messages':JSON.stringify([{role:'assistant',parts:r.calls.map(c=>({type:'tool_call',id:c.id,name:c.name}))}])})],'demo');
  quiet(otel);const otelPEs=otel.drainPEs();expect(otelPEs).toHaveLength(2);expect(otelPEs.map(p=>p.metadata?.tool_count)).toEqual([2,1]);expect(new Set(otelPEs.map(p=>p.idempotencyKey)).size).toBe(2);
  await otel.stop();otel=new OTelPlugin({forceActive:true,programRegistry:reg,journalPath:otelJournal});await otel.init(observer);expect(otel.drainPEs()).toHaveLength(2);for(const pe of otelPEs)otel.onCommitted(pe,'submitted');await otel.stop();otel=new OTelPlugin({forceActive:true,programRegistry:reg,journalPath:otelJournal});await otel.init(observer);expect(otel.drainPEs()).toEqual([]);
  const oldAggregate=responses.filter(r=>r.calls.length).length>0?1:0;expect(oldAggregate).not.toBe(filePEs.length);
  for(const pe of filePEs)files.onCommitted(pe,'submitted');await files.stop();expect((await read(f)).drainPEs()).toEqual([]);
 });
 it('response IDs preserve primitive types; RED a string and numeric ID are distinct tool responses',async()=>{
  const f=setup();for(const id of [17,'17'])fs.appendFileSync(f.file,row({kind:'response',id,timestamp:stamp+1000,calls:[{id:'same-local-call',name:'Read'}],done:true}));
  let p=await read(f);const pes=p.drainPEs();expect(pes).toHaveLength(2);expect(new Set(pes.map(pe=>pe.idempotencyKey)).size).toBe(2);for(const pe of pes)p.onCommitted(pe,'submitted');await p.stop();
  p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
 });
 it('setup is unfinished until a new real turn; RED validation records and another lane cannot complete it',async()=>{
  const f=setup();expect(f.registry.programs()[0].readyAtMs).toBeUndefined();
  f.registry.captured('demo','model_proxy',stamp+1);expect(f.registry.programs()[0].readyAtMs).toBeUndefined();
  const p=await read(f);expect(p.drainPEs()).toEqual([]);expect(f.registry.programs()[0].readyAtMs).toBeUndefined();await p.stop();
  fs.appendFileSync(f.file,row({kind:'response',timestamp:stamp+1000,...responses[0]}));expect((await read(f)).drainPEs()).toHaveLength(1);
  expect(f.registry.programs()[0].readyAtMs).toBe(stamp+5000);
 });
 it('a copied pending fragmented response cannot mint twice; RED a distinct response still mints',async()=>{
  const f=setup(true);const call=row({kind:'response',id:'pending',timestamp:stamp+1000,calls:[{id:'p1',name:'Read'}]});
  fs.appendFileSync(f.file,call);let p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
  fs.writeFileSync(path.join(f.root,'copy.jsonl'),call+row({id:'pending',done:true,timestamp:stamp+1000}));
  fs.appendFileSync(f.file,row({id:'pending',done:true,timestamp:stamp+1000}));p=await read(f);const pes=p.drainPEs();expect(pes).toHaveLength(1);p.onCommitted(pes[0],'submitted');await p.stop();
  p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
  fs.appendFileSync(f.file,row({kind:'response',id:'distinct',timestamp:stamp+1000,calls:[{id:'d1',name:'Read'}],done:true}));expect((await read(f)).drainPEs()).toHaveLength(1);
 });
 it('a format change holds the unknown fragment and keeps every call of the open response; RED no premature mint',async()=>{
  const f=setup(true);fs.appendFileSync(f.file,row({kind:'response',id:'open',timestamp:stamp+1000,calls:[{id:'a',name:'Read'}]}));let p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
  fs.appendFileSync(f.file,row({kind:'response',id:'open',timestamp:stamp+1000,calls:[{id:'b',new_name:'Bash'}],done:true}));p=await read(f);expect(p.drainPEs()).toEqual([]);expect(p.captureHealth().formatBrokenPrograms).toEqual(['demo']);await p.stop();
  configureProgram({...f.raw,session:{...f.raw.session,rules:f.raw.session.rules.map(r=>r.kind==='tool_call'?{...r,where:[{path:'name',exists:true}]}:r).concat([{kind:'tool_call',at:'calls.*',where:[{path:'new_name',exists:true}],name:'new_name',id:'id'}])}},f.registryFile,stamp+5000);
  p=await read(f);const pes=p.drainPEs();expect(pes).toHaveLength(1);expect(pes[0].metadata?.tool_count).toBe(2);expect(p.captureHealth().formatBrokenPrograms).toEqual([]);
 });
 it('a moved tool container flags health and holds its cursor; RED old parts cannot consume it, repair mints once',async()=>{
  const f=setup();fs.appendFileSync(f.file,row({kind:'response',id:'moved',timestamp:stamp+1000,tools:[{id:'new',name:'Read',arguments:{file_path:'/private/path'}}],done:true}));
  let p=await read(f);expect(p.drainPEs()).toEqual([]);expect(p.captureHealth().formatBrokenPrograms).toEqual(['demo']);await p.stop();
  configureProgram({...f.raw,session:{...f.raw.session,responseParts:'tools.*',rules:f.raw.session.rules.map(r=>r.kind==='tool_call'?{...r,at:'tools.*'}:r)}},f.registryFile,stamp+5000);
  p=await read(f);const pes=p.drainPEs();expect(pes).toHaveLength(1);expect(pes[0].metadata?.tool_count).toBe(1);expect(p.captureHealth().formatBrokenPrograms).toEqual([]);p.onCommitted(pes[0],'submitted');await p.stop();
  p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
 });
 it.each([false,true])('mixed records retain a moved tool with an empty old container (name-only=%s); RED pure models and argument data cannot mint',async(nameOnly)=>{
  const f=setup();
  if(nameOnly){f.raw.session.rules=f.raw.session.rules.map(r=>r.kind==='tool_call'?{...r,id:undefined,input:undefined}:r);configureProgram(f.raw,f.registryFile,stamp);}
  fs.appendFileSync(f.file,row({kind:'response',id:'last-old',timestamp:stamp+500,calls:[{id:'old-call',name:'Read',arguments:{payload:[{id:'data',name:'NotATool'}]}}],done:true})+row({kind:'response',id:'pure',timestamp:stamp+750,calls:[],done:true})+row({kind:'response',id:'changed',timestamp:stamp+1000,calls:[],tools:[{id:'new',name:'Read',arguments:{file_path:'/private/path'}}],done:true}));
  let p=await read(f);const first=p.drainPEs();expect(first).toHaveLength(1);expect(first[0].metadata?.tool_count).toBe(1);expect(p.captureHealth().formatBrokenPrograms).toEqual(['demo']);p.onCommitted(first[0],'submitted');await p.stop();
  const state=JSON.parse(fs.readFileSync(path.join(f.h,'.provian','described-response-state.json'),'utf8'));expect(Object.values(state.sources).map((v:any)=>v.cursor)[0]).toBe(fs.readFileSync(f.file,'utf8').indexOf('{"kind":"response","id":"changed"'));
  configureProgram({...f.raw,session:{...f.raw.session,responseParts:'tools.*',rules:f.raw.session.rules.map(r=>r.kind==='tool_call'?{...r,at:'tools.*'}:r)}},f.registryFile,stamp+5000);
  p=await read(f);const repaired=p.drainPEs();expect(repaired).toHaveLength(1);expect(repaired[0].idempotencyKey).not.toBe(first[0].idempotencyKey);expect(p.captureHealth().formatBrokenPrograms).toEqual([]);p.onCommitted(repaired[0],'submitted');await p.stop();
  p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
 });
 it('OTel retains model ancestry after a pure-model flush and restart; RED forgetting ancestry strands the delayed tool',async()=>{
  const h=home(),opts={forceActive:true,programRegistry:{allows:(p:string|null,l:string)=>p==='demo'&&l==='otel'} as ProgramWitnessRegistry,journalPath:path.join(h,'delayed.json')};
  const model=span('model',{'gen_ai.operation.name':'chat','gen_ai.response.id':'response-1'}),tool=span('tool',{'gen_ai.operation.name':'execute_tool','gen_ai.tool.name':'Read','gen_ai.tool.call.id':'call-1'},'model');
  let p=new OTelPlugin(opts);await p.init(observer);p.ingestParsedSpans([model],'demo');quiet(p);expect(p.drainPEs()).toEqual([]);await p.stop();
  p=new OTelPlugin(opts);await p.init(observer);p.ingestParsedSpans([tool],'demo');quiet(p);const pes=p.drainPEs();expect(pes).toHaveLength(1);expect(pes[0].metadata?.tool_count).toBe(1);p.onCommitted(pes[0],'submitted');await p.stop();
  p=new OTelPlugin(opts);await p.init(observer);p.ingestParsedSpans([model,tool],'demo');quiet(p);expect(p.drainPEs()).toEqual([]);await p.stop();
  const q=new OTelPlugin({...opts,journalPath:null});await q.init(observer);q.ingestParsedSpans([model,tool],'demo');quiet(q);const together=q.drainPEs();expect(together).toHaveLength(1);expect(together[0].idempotencyKey).toBe(pes[0].idempotencyKey);await q.stop();
  expect([tool].some(s=>s.spanId===tool.parentSpanId)).toBe(false);
 });
 it('late OTel origins enrich the SAME uncommitted response; RED no second PE and no sealed-row rewrite',async()=>{
  const opts={forceActive:true,programRegistry:{allows:(p:string|null,l:string)=>p==='demo'&&l==='otel'} as ProgramWitnessRegistry,journalPath:path.join(home(),'late-origin.json')};
  const model=span('model',{'gen_ai.operation.name':'chat','gen_ai.response.id':'r1','gen_ai.response.tool_calls':[{type:'tool_call',id:'c1',function:{name:'fetch'}}]}),tool=span('tool',{'gen_ai.operation.name':'execute_tool','gen_ai.tool.name':'fetch','gen_ai.tool.call.id':'c1'},'model'),http={...span('http',{'http.request.method':'GET','server.address':'example.org','http.response.status_code':200},'tool'),spanKind:3};
  let p=new OTelPlugin(opts);await p.init(observer);p.ingestParsedSpans([model],'demo');quiet(p);const early=p.drainPEs();expect(early).toHaveLength(1);expect(early[0].input_origins).toEqual([]);
  p.ingestParsedSpans([tool,http],'demo');quiet(p);expect(p.drainPEs()).toEqual([]);expect(early[0].input_origins?.map(o=>o.origin_identifier)).toEqual(['domain:example.org']);await p.stop();
  p=new OTelPlugin(opts);await p.init(observer);const recovered=p.drainPEs();expect(recovered).toHaveLength(1);expect(recovered[0].input_origins).toEqual(early[0].input_origins);p.onCommitted(recovered[0],'submitted');await p.stop();
  const q=new OTelPlugin({...opts,journalPath:null});await q.init(observer);q.ingestParsedSpans([model,tool,http],'demo');quiet(q);expect(q.drainPEs()[0].input_origins).toEqual(early[0].input_origins);await q.stop();
  p=new OTelPlugin(opts);await p.init(observer);p.ingestParsedSpans([model,tool,http],'demo');quiet(p);expect(p.drainPEs()).toEqual([]);await p.stop();
 });
 it.each(['paid-call',17])('a delayed known tool result (%s) preserves its payment after a closed response and restart; RED an unknown invocation never records a payment',async(callId)=>{
  const f=setup();configureProgram({...f.raw,session:{...f.raw.session,rules:[...f.raw.session.rules,{kind:'tool_result',where:[{path:'kind',equals:'result'}],text:'text',id:'call_id'}]}},f.registryFile,stamp);
  const spendId='lsrq_1AbCdEfGhIjKlMnOpQrStUv';fs.appendFileSync(f.file,row({kind:'response',id:'purchase',timestamp:stamp+1000,calls:[{id:callId,name:'Bash',arguments:{command:'link-cli spend-request retrieve '+spendId}}]}));
  let p=await read(f);const turn=p.drainPEs();expect(turn).toHaveLength(1);p.onCommitted(turn[0],'submitted');await p.stop();
  const result=(call_id:string|number)=>row({kind:'result',call_id,timestamp:stamp+2000,text:JSON.stringify({id:spendId,object:'spend_request',status:'succeeded',amount:3500,currency:'usd',merchant_name:'Stripe Press'})});
  fs.appendFileSync(f.file,result(typeof callId==='number'?String(callId):'unknown-call'));p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
  fs.appendFileSync(f.file,result(callId));p=await read(f);const payment=p.drainPEs();expect(payment).toHaveLength(1);expect(payment[0].actionType).toBe('link_spend');p.onCommitted(payment[0],'submitted');await p.stop();
  p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
 });
 it('reused call IDs pair only an observed matching receipt invocation; RED foreign-program and unknown receipt bindings',async()=>{
  const f=setup(),spec={...f.raw.session,rules:[...f.raw.session.rules,{kind:'tool_result' as const,where:[{path:'kind',equals:'result'}],text:'text',id:'call_id'}]};configureProgram({...f.raw,session:spec},f.registryFile,stamp);
  const otherRoot=path.join(f.h,'other-sessions');fs.mkdirSync(otherRoot);const otherFile=path.join(otherRoot,'other.jsonl');fs.writeFileSync(otherFile,row({kind:'response',id:'other-baseline',timestamp:stamp-1,calls:[{id:'baseline',name:'Read'}]}));configureProgram({program:'other',processNames:['other'],lane:'transcript',session:{...spec,root:otherRoot}},f.registryFile,stamp);
  const oldId='lsrq_9ZyXwVuTsRqPoNmLkJiHgFe',newId='lsrq_1AbCdEfGhIjKlMnOpQrStUv',foreignId='lsrq_8AaBbCcDdEeFfGgHhIiJjKk',unknownId='lsrq_7ZzYyXxWwVvUuTtSsRrQqPp';
  const call=(id:string,spendId:string)=>row({kind:'response',id,timestamp:stamp+1000,calls:[{id:'reused',name:'Bash',arguments:{command:'link-cli spend-request retrieve '+spendId}}]});
  fs.appendFileSync(f.file,call('old-response',oldId)+call('new-response',newId));fs.appendFileSync(otherFile,call('foreign-response',foreignId));
  let p=await read(f);const turns=p.drainPEs();expect(turns).toHaveLength(3);for(const pe of turns)p.onCommitted(pe,'submitted');await p.stop();
  const result=(id:string)=>row({kind:'result',call_id:'reused',timestamp:stamp+2000,text:JSON.stringify({id,object:'spend_request',status:'succeeded',amount:3500,currency:'usd',merchant_name:'Stripe Press'})});
  fs.appendFileSync(f.file,result(foreignId)+result(unknownId));p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
  fs.appendFileSync(f.file,result(newId)+result(oldId));p=await read(f);const payments=p.drainPEs();expect(payments).toHaveLength(2);expect(payments.map(pe=>pe.metadata?.link_spend_id).sort()).toEqual([oldId,newId].sort());for(const pe of payments)p.onCommitted(pe,'submitted');await p.stop();
  p=await read(f);expect(p.drainPEs()).toEqual([]);await p.stop();
 });
 it('a mixed-lane distributed parent never strands the OTel response; RED the proxy parent cannot mint in OTel',async()=>{
  const reg={allows:(p:string|null,l:string)=>p==='files'&&l==='transcript'||p==='otel-child'&&l==='otel'} as ProgramWitnessRegistry;
  const otel=new OTelPlugin({forceActive:true,programRegistry:reg,journalPath:null});await otel.init(observer);
  otel.ingestParsedSpans([span('files-parent',{'gen_ai.operation.name':'invoke_agent'})],'files');
  otel.ingestParsedSpans([span('response',{'gen_ai.operation.name':'chat','gen_ai.output.messages':JSON.stringify([{parts:[{type:'tool_call',id:'a',name:'Read'}]}])},'files-parent')],'otel-child');
  quiet(otel);const pes=otel.drainPEs();expect(pes).toHaveLength(1);expect(pes[0].metadata?.program).toBe('otel-child');
 });
});

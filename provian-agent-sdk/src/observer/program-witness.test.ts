import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configureProgram, ProgramWitnessRegistry, writeLocal, type SessionDescription } from './program-witness';
import { TranscriptPlugin } from './plugins/transcript/TranscriptPlugin';
import { ModelProxyPlugin } from './plugins/ModelProxyPlugin';
import { ProgramProxyTurns } from './plugins/model-proxy/program-turns';
import { OTelPlugin } from './plugins/OTelPlugin';
import { resolveActivePlugins } from './run-daemon';
import type { ProvianObserver } from './ProvianObserver';
import type { ModelTurnObservation } from './plugins/model-proxy/parse';
import type { ParsedOtlpSpan } from './plugins/OTelPlugin';

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) fs.rmSync(h, { recursive:true, force:true }); });
const home = (): string => { const h=fs.mkdtempSync(path.join(os.tmpdir(),'program-witness-'));homes.push(h);return h; };
const observer = { log:()=>{}, observerDeviceWitness:()=>({type:'observer_device',identity:'test-device',attestation_tier:'software'}) } as unknown as ProvianObserver;
const stamp = 1_791_480_000_000;
const line = (kind:string, extra:Record<string,unknown> = {}): string => JSON.stringify({kind,timestamp:stamp+1000,...extra})+'\n';
function fixture(lane:'transcript'|'model_proxy'|'otel'='transcript') {
 const h=home(), root=path.join(h,'sessions');fs.mkdirSync(root);
 const file=path.join(root,'session.jsonl');
 fs.writeFileSync(file,line('prompt')+line('call',{id:'old',name:'Read',args:{file_path:'/private/sentinel'}})+line('final'));
 const registryFile=path.join(h,'.provian','program-witnesses.json');
 const session:SessionDescription={root,maxDepth:0,suffix:'.jsonl',timestamp:'timestamp',atomicResponses:false,rules:[
  {kind:'user_prompt',where:[{path:'kind',equals:'prompt'}]},
  {kind:'tool_call',where:[{path:'kind',equals:'call'}],name:'name',id:'id',input:'args'},
  {kind:'tool_result',where:[{path:'kind',equals:'result'}],id:'id',text:'text'},
  {kind:'turn_end',where:[{path:'kind',equals:'final'}],text:'text'}
 ]};
 const raw={program:'demo',processNames:['demoprogram'],lane,...(lane==='transcript'?{session}:{})};
 const validation=configureProgram(raw,registryFile,stamp);
 return {h,file,root,registryFile,registry:new ProgramWitnessRegistry(registryFile),raw,validation};
}
function toolObs(id='call-a',model='api-model'):ModelTurnObservation {
 return {recognized:true,protocol:'openai_chat',provider:'openai',model,responseId:'response-'+id,streamed:false,toolCalls:[{id,name:'Read',input:{file_path:'/private/sentinel'}}],tokens:{input:1,output:2,total:3}};
}
function finalObs(id='final'):ModelTurnObservation {return {...toolObs(id),toolCalls:[]};}
function feed(proxy:ModelProxyPlugin, p:string, obs:ModelTurnObservation, body:unknown):void {
 (proxy as unknown as {onTurn:(route:unknown,obs:ModelTurnObservation,start:number,end:number,schemas:undefined,digest:string,program:string)=>void}).onTurn({provider:'openai',fromPrefix:true,protocol:'openai'},obs,stamp+1000,stamp+1100,undefined,'sha256:'+'a'.repeat(64),p);
}
const prompt = {messages:[{role:'user',content:'A real task'}]};
const follow = {messages:[{role:'tool',tool_call_id:'call-a',content:'done'}]};
async function reader(f:ReturnType<typeof fixture>) {
 const p=new TranscriptPlugin({home:f.h,registry:f.registry,now:()=>stamp+5000});await p.init(observer);await p.start();return p;
}

describe(' machine-local setup validation and fixed witness',()=>{
 it('validates real records into complete tool turns; RED rejects an invented format and empty store',()=>{
  const f=fixture();expect(f.validation).toMatchObject({records:3,calls:1,turns:1});
  expect(()=>configureProgram({...f.raw,session:{...f.raw.session!,rules:[{kind:'user_prompt'},{kind:'tool_call',at:'madeup',name:'madeup'},{kind:'turn_end'}]}},f.registryFile)).toThrow(/real tool turns/);
  fs.writeFileSync(f.file,'');expect(()=>configureProgram(f.raw,f.registryFile)).toThrow(/real tool turns/);
 });
 it('RED refuses switching a configured program lane, including model/sign-in changes',()=>{
  const f=fixture();expect(()=>configureProgram({...f.raw,lane:'model_proxy',session:undefined},f.registryFile)).toThrow(/fixed at setup/);
  expect(f.registry.lane('demo')).toBe('transcript');expect(f.registry.allows('demo','model_proxy')).toBe(false);
 });
 it('session program mints each API-key then ChatGPT-sign-in turn once, without setup changes; proxy and OTel copies mint nothing',async()=>{
  const f=fixture();let p=await reader(f);const original=fs.readFileSync(f.registryFile,'utf8');
  const proxy=new ModelProxyPlugin({programRegistry:f.registry,journalPath:path.join(f.h,'proxy.json')});await proxy.init(observer);
  for(const [signin,model] of [['api-key','gpt-api'],['ChatGPT','gpt-chatgpt'],['OAuth','other-provider']]){
   fs.appendFileSync(f.file,line('prompt',{signin,model})+line('call',{id:'call-'+signin,name:'Read',args:{file_path:'/private/sentinel'}})+line('final',{text:'output'}));
   await p.stop();p=await reader(f);
   const pes=p.drainPEs();expect(pes).toHaveLength(1);expect(pes[0].metadata).toMatchObject({program:'demo',source:'transcript',tool_count:1});
   expect(JSON.stringify(pes)).not.toContain('/private/sentinel');p.onCommitted(pes[0],'submitted');
   feed(proxy,'demo',toolObs(),prompt);feed(proxy,'demo',finalObs(),follow);expect(proxy.drainPEs()).toEqual([]);
   expect(f.registry.allows('demo','otel')).toBe(false); // RED: a second lane would double this same turn.
  }
  expect(f.registry.programs()[0]).toMatchObject({...JSON.parse(original)[0],readyAtMs:stamp+5000});await p.stop();p=await reader(f);expect(p.drainPEs()).toEqual([]);
 });
 it('proxy program mints through proxy only, even if files are fabricated/edited; model/provider changes keep its lane',async()=>{
  const f=fixture('model_proxy');const p=await reader(f);
  fs.appendFileSync(f.file,line('prompt')+line('call',{name:'Bash',id:'forged'})+line('final'));await p.stop();expect((await reader(f)).drainPEs()).toEqual([]);
  const proxy=new ModelProxyPlugin({programRegistry:f.registry,journalPath:path.join(f.h,'proxy.json')});await proxy.init(observer);
  feed(proxy,'demo',toolObs(),prompt);let pes=proxy.drainPEs();
  feed(proxy,'demo',finalObs(),follow);expect(proxy.drainPEs()).toEqual([]);expect(pes).toHaveLength(1);expect(pes[0].metadata?.program).toBe('demo');proxy.onCommitted(pes[0],'submitted');
  for(const model of ['gpt-chatgpt','other-provider']){
   const id='call-'+model;feed(proxy,'demo',{...toolObs(id,model),provider:'anthropic'},prompt);
   feed(proxy,'demo',finalObs('final-'+model),{messages:[{role:'tool',tool_call_id:id}]});pes=proxy.drainPEs();expect(pes).toHaveLength(1);proxy.onCommitted(pes[0],'submitted');
  }
  feed(proxy,'unconfigured',toolObs('other'),prompt);feed(proxy,'unconfigured',finalObs('otherfinal'),{messages:[{role:'tool',tool_call_id:'other'}]});expect(proxy.drainPEs()).toEqual([]);
 });
 it('each proxy tool-calling response survives restarts; RED a user-task aggregate loses one PE',()=>{
  const h=home(),file=path.join(h,'proxy.json');const ctx={start:stamp,end:stamp+1,witness:null,digest:'sha256:'+'a'.repeat(64)};
  let p=new ProgramProxyTurns(file);p.observe('demo',toolObs('a'),ctx);const a=p.drain();expect(a).toHaveLength(1);
  p=new ProgramProxyTurns(file);expect(p.drain()).toHaveLength(1);p.commit(a[0],false);
  p.observe('demo',toolObs('b'),ctx);const b=p.drain();expect(b).toHaveLength(1);p.commit(b[0],false);
  expect(a.length+b.length).toBe(2);expect(a[0].idempotencyKey).not.toBe(b[0].idempotencyKey);
  p=new ProgramProxyTurns(file);p.observe('demo',toolObs('a'),ctx);p.observe('demo',finalObs(),ctx);expect(p.drain()).toEqual([]);
 });
 it('a format break raises the standing re-description instruction and capture-health flag; RED: quiet files raise neither',async()=>{
  const f=fixture();const p=await reader(f);expect(p.captureHealth().formatBrokenPrograms).toEqual([]);
  fs.appendFileSync(f.file,line('newformat',{work:'tool'}));await p.stop();const next=await reader(f);
  expect(next.drainPEs()).toEqual([]);expect(next.captureHealth().formatBrokenPrograms).toEqual(['demo']);
  expect(fs.readFileSync(path.join(f.h,'.provian','witness-action-required.json'),'utf8')).toMatch(/Re-describe/);
 });
 it('OTel mints only its assigned program; RED proxy/session copies cannot mint, and retries/restarts do not duplicate spans',async()=>{
  const f=fixture('otel'), file=path.join(f.h,'otel.json');
  const tool:ParsedOtlpSpan={name:'execute_tool',traceId:'real-trace',spanId:'span-1',parentSpanId:'',startTimeUnixMs:stamp+1,endTimeUnixMs:stamp+10,status:'ok',spanKind:null,attributes:{'gen_ai.operation.name':'execute_tool','gen_ai.tool.name':'Read','gen_ai.response.id':'real-response'},resourceAttributes:{},scopeName:null};
  let otel=new OTelPlugin({forceActive:true,programRegistry:f.registry,journalPath:file});await otel.init(observer);
  otel.ingestParsedSpans([tool],'demo');otel.ingestParsedSpans([tool],'demo');await otel.stop();
  otel=new OTelPlugin({forceActive:true,programRegistry:f.registry,journalPath:file});await otel.init(observer);
  const flush=(p:OTelPlugin)=>{const x=p as unknown as {traces:Map<string,unknown>;flushTrace:(t:unknown,r:'idle')=>void};for(const t of x.traces.values())x.flushTrace(t,'idle');};
  flush(otel);const pes=otel.drainPEs();expect(pes).toHaveLength(1);expect(pes[0].metadata?.tool_count).toBe(1);otel.onCommitted(pes[0],'submitted');await otel.stop();
  otel=new OTelPlugin({forceActive:true,programRegistry:f.registry,journalPath:file});await otel.init(observer);otel.ingestParsedSpans([tool],'demo');flush(otel);expect(otel.drainPEs()).toEqual([]);
  for(const lane of ['transcript','model_proxy'] as const){const other=fixture(lane);const forbidden=new OTelPlugin({forceActive:true,programRegistry:other.registry,journalPath:null});await forbidden.init(observer);forbidden.ingestParsedSpans([tool],'demo');flush(forbidden);expect(forbidden.drainPEs()).toEqual([]);}
 });
 it('re-description parses changed real records and resumes the held cursor without a second historical mint',async()=>{
  const f=fixture(),p=await reader(f);
  fs.appendFileSync(f.file,line('newprompt')+line('newcall',{id:'after-update',name:'Read'})+line('newfinal'));
  await p.stop();const broken=await reader(f);expect(broken.captureHealth().formatBrokenPrograms).toEqual(['demo']);
  const changed={...f.raw,session:{...f.raw.session!,rules:[{kind:'user_prompt' as const,where:[{path:'kind',equals:'newprompt'}]},{kind:'tool_call' as const,where:[{path:'kind',equals:'newcall'}],id:'id',name:'name'},{kind:'turn_end' as const,where:[{path:'kind',equals:'newfinal'}]}]}};
  configureProgram(changed,f.registryFile,stamp+5000);await broken.stop();const resumed=await reader(f);const pes=resumed.drainPEs();expect(pes).toHaveLength(1);expect(resumed.captureHealth().formatBrokenPrograms).toEqual([]);resumed.onCommitted(pes[0],'submitted');await resumed.stop();expect((await reader(f)).drainPEs()).toEqual([]);
 });
 it('human programs have no tool lanes even when explicitly requested; RED: agent programs retain all tool lanes',()=>{
  const all=['process','git','otel','transcript','model_proxy','llm','llm_session'];const ctx={platform:'darwin',hasLlmLog:true,localInferenceDetected:true};
  const humans=resolveActivePlugins(all,{...ctx,ownerType:'human'});expect([...humans].sort()).toEqual(['git','llm','llm_session']);
  const agents=resolveActivePlugins(all,{...ctx,ownerType:'agent'});for(const name of ['otel','transcript','model_proxy'])expect(agents.has(name)).toBe(true);expect(agents.has('llm')).toBe(false);
 });
 it('pure model calls never mint, even with large token counts',async()=>{
  const f=fixture('model_proxy');const proxy=new ModelProxyPlugin({programRegistry:f.registry,journalPath:path.join(f.h,'proxy.json')});await proxy.init(observer);
  feed(proxy,'demo',{...finalObs(),tokens:{input:1000000,output:1000000,total:2000000}},prompt);expect(proxy.tick(null)).toBeNull();expect(proxy.drainPEs()).toEqual([]);
 });
});

describe(' replay and concurrency regression controls',()=>{
 it('RED rejects overlapping roots, symlink and hardlink aliases, and ambiguous process identities',()=>{
  const f=fixture(); const other={...f.raw,program:'other',processNames:['other']};
  expect(()=>configureProgram(other,f.registryFile,stamp)).toThrow(/belongs/);
  const alias=path.join(f.h,'alias');fs.symlinkSync(f.root,alias);
  expect(()=>configureProgram({...other,session:{...other.session!,root:alias}},f.registryFile,stamp)).toThrow(/belongs/);
  const separate=path.join(f.h,'separate');fs.mkdirSync(separate);fs.linkSync(f.file,path.join(separate,'session.jsonl'));
  expect(()=>configureProgram({...other,session:{...other.session!,root:separate}},f.registryFile,stamp)).toThrow(/belongs/);
  expect(()=>configureProgram({...other,lane:'model_proxy',session:undefined,processNames:['demoprogram']},f.registryFile,stamp)).toThrow(/identity/);
 });
 it('RED invalid timestamps cannot be accepted; real ISO timestamps parse',()=>{
  const f=fixture();fs.writeFileSync(f.file,line('prompt',{timestamp:'garbage'})+line('call',{name:'Read'})+line('final'));
  expect(()=>configureProgram(f.raw,f.registryFile,stamp)).toThrow(/timestamps/);
  fs.writeFileSync(f.file,line('prompt',{timestamp:new Date(stamp+1000).toISOString()})+line('call',{name:'Read'})+line('final'));
  expect(configureProgram(f.raw,f.registryFile,stamp).turns).toBe(1);
 });
 it('truncation/rewrite cannot remint a committed turn; RED a subsequent real prompt still mints',async()=>{
  const f=fixture();const fresh=line('prompt',{task:'first'})+line('call',{name:'Read',id:'fresh'})+line('final');
  fs.appendFileSync(f.file,fresh);let p=await reader(f);const first=p.drainPEs();expect(first).toHaveLength(1);p.onCommitted(first[0],'submitted');await p.stop();
  fs.writeFileSync(f.file,'');p=await reader(f);await p.stop();fs.writeFileSync(f.file,fresh);p=await reader(f);expect(p.drainPEs()).toEqual([]);await p.stop();
  fs.appendFileSync(f.file,line('prompt',{task:'second'})+line('call',{name:'Read',id:'second'})+line('final'));
  p=await reader(f);expect(p.drainPEs()).toHaveLength(1);await p.stop();
 });
 it('a changed call shape cannot hide behind still-recognized prompt and end records',async()=>{
  const f=fixture();fs.appendFileSync(f.file,line('prompt',{task:'break'})+line('changed_call',{name:'Read'})+line('final'));
  const p=await reader(f);expect(p.drainPEs()).toEqual([]);expect(p.captureHealth().formatBrokenPrograms).toEqual(['demo']);await p.stop();
 });
 it('a large real record cannot strand the following tool turn behind the disk buffer',async()=>{
  const f=fixture();fs.appendFileSync(f.file,line('prompt',{task:'large'})+line('call',{name:'Read',id:'large',args:{private:'x'.repeat(5*1024*1024)}})+line('final'));
  const p=await reader(f);expect(p.drainPEs()).toHaveLength(1);await p.stop();
 });
 it('concurrent responses and Gemini responses mint individually; RED pure replies never mint',()=>{
  const p=new ProgramProxyTurns(path.join(home(),'proxy.json')),ctx={start:stamp,end:stamp+1,witness:null,digest:'sha256:'+'a'.repeat(64)};
  const responses=[toolObs('a'),toolObs('b'),{...toolObs('a2'),provider:'gemini' as const}];
  for(const response of responses)p.observe('demo',response,ctx);
  const pes=p.drain();expect(pes).toHaveLength(3);expect(new Set(pes.map(pe=>pe.idempotencyKey)).size).toBe(3);
  for(const pe of pes)p.commit(pe,false);
  for(const response of responses)p.observe('demo',response,ctx);
  p.observe('demo',finalObs(),ctx);expect(p.drain()).toEqual([]);
 });
 it('OTel waits for the completed root across a long tool turn and a restart; late replay has the same action-independent key',async()=>{
  const f=fixture('otel'),file=path.join(f.h,'otel-root.json');
  const child:ParsedOtlpSpan={name:'execute_tool',traceId:'long',spanId:'child',parentSpanId:'root',startTimeUnixMs:stamp,endTimeUnixMs:stamp+10,status:'ok',spanKind:null,attributes:{'gen_ai.operation.name':'execute_tool','gen_ai.tool.name':'Read','gen_ai.response.id':'real-response'},resourceAttributes:{},scopeName:null};
  let p=new OTelPlugin({forceActive:true,programRegistry:f.registry,journalPath:file});await p.init(observer);p.ingestParsedSpans([child],'demo');
  const age=(x:OTelPlugin)=>{for(const t of (x as unknown as {traces:Map<string,{lastSeenAtMs:number}>}).traces.values())t.lastSeenAtMs=Date.now()-60000;};
  age(p);p.tick(null);expect(p.drainPEs()).toEqual([]);await p.stop();p=new OTelPlugin({forceActive:true,programRegistry:f.registry,journalPath:file});await p.init(observer);age(p);p.tick(null);expect(p.drainPEs()).toEqual([]);
  p.ingestParsedSpans([{...child,name:'agent',spanId:'root',parentSpanId:'',endTimeUnixMs:stamp+60000,attributes:{'gen_ai.operation.name':'invoke_agent'}}],'demo');age(p);p.tick(null);const pes=p.drainPEs();expect(pes).toHaveLength(1);p.onCommitted(pes[0],'submitted');await p.stop();
  p=new OTelPlugin({forceActive:true,programRegistry:f.registry,journalPath:file});await p.init(observer);p.ingestParsedSpans([child],'demo');age(p);p.tick(null);expect(p.drainPEs()).toEqual([]);
 });
});

describe(' identical prompt occurrences',()=>{
 it('two legitimate appends with identical prompt and second-resolution time each mint; RED rewriting either never remints',async()=>{
  const f=fixture();const prompt=line('prompt',{timestamp:Math.floor((stamp+1000)/1000)});
  const a=prompt+line('call',{name:'Read',id:'first'})+line('final');const b=prompt+line('call',{name:'Read',id:'second'})+line('final');
  fs.appendFileSync(f.file,a);let p=await reader(f);const first=p.drainPEs();expect(first).toHaveLength(1);p.onCommitted(first[0],'submitted');await p.stop();
  fs.appendFileSync(f.file,b);p=await reader(f);const second=p.drainPEs();expect(second).toHaveLength(1);expect(second[0].idempotencyKey).not.toBe(first[0].idempotencyKey);p.onCommitted(second[0],'submitted');await p.stop();
  fs.writeFileSync(f.file,a+b);p=await reader(f);expect(p.drainPEs()).toEqual([]);await p.stop();
  fs.appendFileSync(f.file,a);p=await reader(f);expect(p.drainPEs()).toHaveLength(1);await p.stop();
 });
});


describe(' program socket identity RED controls',()=>{
 it('matches only the executable or runtime script, including at-end and quoted spaces',()=>{
  const f=fixture('model_proxy');
  configureProgram({...f.raw,processNames:['node'],scriptPaths:['/opt/agent.js','/Users/me/Agent Program']},f.registryFile,stamp);
  expect(f.registry.identify({pid:1,exe:'/usr/bin/node',args:'node /opt/agent.js'})).toBe('demo');
  expect(f.registry.identify({pid:1,exe:'/usr/bin/node',args:"node '/Users/me/Agent Program/index.js'"})).toBe('demo');
  expect(f.registry.identify({pid:1,exe:'/usr/bin/node',args:'node /opt/unassigned.js --prompt /opt/agent.js suffix'})).toBeNull();
  expect(f.registry.identify({pid:1,exe:'/usr/bin/node',args:'node /opt/agent.js-fake'})).toBeNull();
  expect(f.registry.identify({pid:1,exe:'/usr/bin/node',args:'node --require /opt/agent.js /opt/unassigned.js'})).toBeNull();
  expect(f.registry.identify({pid:1,exe:'/usr/bin/node',args:'node --eval /opt/agent.js'})).toBeNull();
  expect(f.registry.identify({pid:1,exe:'/usr/bin/node',args:'node placeholder',argv:['node','/Users/me/Agent Program/index.js']})).toBe('demo');
 });
});

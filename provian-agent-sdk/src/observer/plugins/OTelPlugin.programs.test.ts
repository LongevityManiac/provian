import {describe,it,expect} from 'vitest';
import fs from 'fs';import os from 'os';import path from 'path';
import {OTelPlugin,TRACE_IDLE_FLUSH_MS,type ParsedOtlpSpan} from './OTelPlugin';
import type {ProgramWitnessRegistry} from '../program-witness';
import type {ProvianObserver} from '../ProvianObserver';
const programs={allows:(name:string|null,lane:string)=>['a','b'].includes(name ?? '')&&lane==='otel'} as ProgramWitnessRegistry;
const observer={log:()=>{},observerDeviceWitness:()=>null} as unknown as ProvianObserver;
const span=(id:string,parent='',attributes:Record<string,unknown>={'gen_ai.operation.name':'execute_tool','gen_ai.tool.name':'Read','gen_ai.response.id':'response-'+id}):ParsedOtlpSpan=>({name:id,traceId:'shared',spanId:id,parentSpanId:parent,startTimeUnixMs:Date.now(),endTimeUnixMs:Date.now(),status:'ok',spanKind:null,attributes,resourceAttributes:{},scopeName:null});
function quiet(p:OTelPlugin){for(const t of (p as unknown as {traces:Map<string,{lastSeenAtMs:number}>}).traces.values()) t.lastSeenAtMs=Date.now()-TRACE_IDLE_FLUSH_MS-1;p.tick(null);}
describe(' OTel per-program provenance and unbounded completed-turn evidence',()=>{
 it('two assigned programs sharing a distributed trace each mint once; RED unassigned exporter cannot poison either',async()=>{
  const p=new OTelPlugin({forceActive:true,programRegistry:programs,journalPath:null});await p.init(observer);
  p.ingestParsedSpans([span('root')],'a');p.ingestParsedSpans([span('other','root')],'b');
  p.ingestParsedSpans([span('injected')],'unassigned');quiet(p);
  const pes=p.drainPEs();expect(pes).toHaveLength(2);expect(new Set(pes.map(pe=>pe.metadata?.program))).toEqual(new Set(['a','b']));expect(new Set(pes.map(pe=>pe.idempotencyKey)).size).toBe(2);
  p.ingestParsedSpans([span('root')],'a');p.ingestParsedSpans([span('other','root')],'b');quiet(p);expect(p.drainPEs()).toHaveLength(0);
 });
 it('RED unfinished child never closes, while a root beyond the former cap closes with every call and origin once, even after restart/retry',async()=>{
  const h=fs.mkdtempSync(path.join(os.tmpdir(),'otel-program-proof-'));try{
   const opts={forceActive:true,programRegistry:programs,journalPath:path.join(h,'journal.json')};let p=new OTelPlugin(opts);await p.init(observer);
   const children=Array.from({length:150_001},(_,i)=>span('child-'+i,'root',{'gen_ai.operation.name':'execute_tool','gen_ai.tool.name':'Read','gen_ai.response.id':'response-root'}));p.ingestParsedSpans(children,'a');quiet(p);expect(p.drainPEs()).toHaveLength(0);await p.stop();
   p=new OTelPlugin(opts);await p.init(observer);p.ingestParsedSpans([children.at(-1)!,span('late-api','child-0',{'http.request.method':'GET','server.address':'docs.example.org','http.response.status_code':200}),span('root','',{'gen_ai.operation.name':'chat','gen_ai.response.id':'response-root'})],'a');quiet(p);
   const pes=p.drainPEs();expect(pes).toHaveLength(1);expect(pes[0].metadata?.tool_count).toBe(150_001);expect(pes[0].input_origins?.map(o=>o.origin_identifier)).toContain('domain:docs.example.org');p.onCommitted(pes[0],'journaled');await p.stop();
   p=new OTelPlugin(opts);await p.init(observer);p.ingestParsedSpans([children[0],span('root')],'a');quiet(p);expect(p.drainPEs()).toHaveLength(0);
  }finally{fs.rmSync(h,{recursive:true,force:true});}
 },15_000);
});

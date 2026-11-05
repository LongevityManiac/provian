/** one tool-calling model response, from the program's own described store. */
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ProvianObserver } from '../../ProvianObserver';
import type { ObserverPlugin, PECommitOutcome } from '../PluginInterface';
import type { PluginPE, PluginContribution, SessionState } from '../../types';
import { ProgramWitnessRegistry, programWitnessPath, describedEvents, recordPlacementProblem, recordSources, readSource, sourceCheckpoint, valuesAt, writeLocal, hash, canonicalRecord, type ProgramWitness } from '../../program-witness';
import { toolInputOriginDrafts, stampWitness, mergeInputOrigins } from '../../origin-capture';
import { linkSpendInvocationFromToolCall, pairLinkSpend, linkSpendBindingTag, type LinkSpendInvocation } from '../../../link-invocation';
import { recognizeLinkSpendInText, linkSpendDescription, linkSpendWitnessMetadata } from '../../../link-witness';
import { recognizeOutputSignaturesInText } from '../../../output-citation-recognizer';
import { outputCitationOrigin } from '../../../output-signature';
import { normalizeEpoch, sqliteAvailability } from './record-store';
interface Response { program?:string; key:string; start:number; end:number; calls:string[]; names:string[]; origins:NonNullable<PluginPE['input_origins']>; invocations:Record<string,LinkSpendInvocation>; fingerprints:string[];output_digests?:NonNullable<PluginPE['output_digests']> }
interface SourceState { cursor:number; checkpoint?:string; replay?:boolean; response?:string;origins?:NonNullable<PluginPE['input_origins']> }
interface State { sources:Record<string,SourceState>; pending:Record<string,PluginPE>; responses:Record<string,Response>; closed:Record<string,boolean>; copies:Record<string,boolean>; serial:number; lastReadMs:number }
export const TRANSCRIPT_RESCAN_INTERVAL_MS=5000;
/** Preserve the local store's primitive identity type: 17 and "17" are distinct. */
const recordIdentity=(value:unknown):string|undefined=>typeof value==='string'||typeof value==='number'&&Number.isFinite(value)?JSON.stringify([typeof value,value]):undefined;
export class TranscriptPlugin implements ObserverPlugin {
 readonly name='transcript';
 private observer!:ProvianObserver;
 private readonly registry:ProgramWitnessRegistry;
 private readonly statePath:string;
 private state:State;
 private queue:PluginPE[]=[];
 private lastPoll=-Infinity;
 private records=0;private calls=0;
 private readonly broken=new Set<string>();
 private harnesses:Array<{harness:string;sources:number;containers:string[]}>=[];
 private lastCapture:number|null=null;
 private deviceRegisteredAtMs:number|null=null;
 private readonly now:()=>number;
 constructor(options:{home?:string;registry?:ProgramWitnessRegistry;statePath?:string;now?:()=>number}={}) {
  const home=options.home??os.homedir();this.registry=options.registry??new ProgramWitnessRegistry(programWitnessPath(home));
  this.statePath=options.statePath??path.join(home,'.provian','described-response-state.json');this.now=options.now??Date.now;
  this.state=fs.existsSync(this.statePath)?JSON.parse(fs.readFileSync(this.statePath,'utf8')):{sources:{},pending:{},responses:{},closed:{},copies:{},serial:0,lastReadMs:0};
  try{const r=JSON.parse(fs.readFileSync(path.join(path.dirname(this.statePath),'witness-action-required.json'),'utf8'));for(const p of r.programs??[])if(typeof p==='string')this.broken.add(p);}catch{/* no outstanding instruction */}
 }
 async init(observer:ProvianObserver):Promise<void>{this.observer=observer;}
 async start():Promise<void>{this.queue=Object.values(this.state.pending);this.poll();}
 async stop():Promise<void>{this.save();}
 async finalize():Promise<void>{this.save();}
 tick(_session:SessionState|null):PluginContribution|null{if(this.now()-this.lastPoll>=TRANSCRIPT_RESCAN_INTERVAL_MS)this.poll();return null;}
 setDeviceRegisteredAtMs(ms:number|null):void{this.deviceRegisteredAtMs=ms;}
 drainPEs():PluginPE[]{const out=this.queue;this.queue=[];return out;}
 onCommitted(pe:PluginPE,outcome:PECommitOutcome):void{if(!pe.idempotencyKey)return;if(outcome==='failed'){this.queue.push(pe);return;}delete this.state.pending[pe.idempotencyKey];this.save();}
 private save():void{writeLocal(this.statePath,this.state);}
 private flag(program:string):void{this.broken.add(program);writeLocal(path.join(path.dirname(this.statePath),'witness-action-required.json'),{instruction:'Your observer cannot parse the current session records. Inspect the real files. Re-describe their response/tool format with provian witness configure --description <local-json-file>: it refuses a description that leaves a record the observer will read unplaced and names the first one. Keep the observer running. Never declare work or submit PEs.',programs:[...this.broken]});this.observer.log('warn','capture.session_format_broken — re-describe your session store',{program});}
 private poll():void {
  this.lastPoll=this.now();this.harnesses=[];
  for(const p of this.registry.programs().filter(x=>x.lane==='transcript')) {
   const spec=p.session!;let sources:ReturnType<typeof recordSources>=[];let healthy=true;
   try{sources=recordSources(spec);}catch{this.flag(p.program);healthy=false;}
   this.harnesses.push({harness:p.program,sources:sources.length,containers:[spec.sqlite?'sqlite':'file']});
   for(const src of sources) {
    const source=p.program+':'+src.source;
    const st=this.state.sources[source]??={cursor:p.baseline[src.source]??0,replay:p.baseline[src.source]===undefined};
    try {
     if(src.tip<st.cursor||st.checkpoint&&sourceCheckpoint(spec,src,st.cursor)!==st.checkpoint){st.cursor=0;st.replay=true;delete st.response;}
     const read=readSource(spec,src,st.cursor);
     while(spec.sqlite&&read.tip<src.tip){const next=readSource(spec,src,read.tip);if(next.tip<=read.tip)break;read.records.push(...next.records);read.tip=next.tip;}
     // Known pure responses, user prompts, results and ignored records remain readable
     // without a tool call. The validators below hold genuinely unrecognized formats.
     for(const row of read.records) {
      this.records++;const events=describedEvents(row.record,spec);
      // The same placement check configure applies to every real record (program-witness.ts).
      if(recordPlacementProblem(row.record,spec,row.atMs,events)!==null){this.flag(p.program);healthy=false;break;}
      const ts=(normalizeEpoch(valuesAt(row.record,spec.timestamp)[0])??row.atMs) as number;
      const at=Math.min(ts,this.now());
      if(at<Math.max(p.setupAtMs,this.deviceRegisteredAtMs??0)){st.cursor=row.ordinal;continue;}
      const calls=events.filter(e=>e.rule.kind==='tool_call');
      const stable=spec.responseId?recordIdentity(valuesAt(row.record,spec.responseId)[0]):undefined;
      const fingerprint=hash(p.program+':'+canonicalRecord(row.record));
      if(calls.length) {
       this.calls+=calls.length;
       // Without a response id, fragments join the open response; once its turn_end closed it, the next call opens a new one.
       const id=stable!==undefined?'dr_'+hash(p.program+':'+stable)
        :st.response&&spec.atomicResponses===false&&!this.state.closed[st.response]?st.response:'dr_'+hash(p.program+':'+ ++this.state.serial);
       if(!this.state.closed[id]&&!(st.replay&&this.state.copies[fingerprint])) {
        st.response=id;
        const r=this.state.responses[id]??={program:p.program,key:id,start:at,end:at,calls:[],names:[],origins:st.origins??[],invocations:{},fingerprints:[]};
        if(!r.fingerprints.includes(fingerprint))r.fingerprints.push(fingerprint);
        st.origins=[];
        for(const e of calls) {
         const name=valuesAt(e.value,e.rule.name)[0];if(typeof name!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(name))throw new Error('tool name no longer parses');
         const callId=e.rule.id?valuesAt(e.value,e.rule.id)[0]:undefined;
         const key=recordIdentity(callId)??hash(canonicalRecord(e.value));
         if(r.calls.includes(key))continue;
         r.calls.push(key);r.names.push(name);r.end=at;
         const input=e.rule.input?valuesAt(e.value,e.rule.input)[0]:undefined;
         r.origins=mergeInputOrigins(r.origins,toolInputOriginDrafts(name,input,spec.origins).map(d=>stampWitness(d,this.observer.observerDeviceWitness())))??[];
         const invocation=linkSpendInvocationFromToolCall(name,input);if(invocation)r.invocations[key]=invocation;
        }
        const texts=events.filter(e=>e.rule.kind==='model_response').flatMap(e=>e.rule.text?valuesAt(e.value,e.rule.text):[]).filter((x):x is string=>typeof x==='string');
        if(texts.length)r.output_digests=texts.map(x=>({hash:'sha256:'+hash(x),kind:'response'}));
        if(spec.atomicResponses!==false)this.emit(p,id);
       }
      }
      for(const e of events.filter(e=>e.rule.kind==='tool_result')) {
       const text=e.rule.text?valuesAt(e.value,e.rule.text)[0]:undefined;const callId=e.rule.id?recordIdentity(valuesAt(e.value,e.rule.id)[0]):undefined;
       const latest=st.response?this.state.responses[st.response]:undefined;
       const matches=callId!==undefined?Object.values(this.state.responses).filter(r=>(r.program===p.program||r.key===latest?.key)&&r.calls.includes(callId)):latest?[latest]:[];
       const r=matches.at(-1);
       if(r&&typeof text==='string') {
        const citations=recognizeOutputSignaturesInText(text).map(sig=>outputCitationOrigin(sig,this.observer.observerDeviceWitness()));
        // A tool result is input to the following model response, not an extra mint.
        st.origins=mergeInputOrigins(st.origins,citations)??[];
        const candidate=recognizeLinkSpendInText(text);
        const bound=callId!==undefined?matches.slice().reverse().find(response=>pairLinkSpend(response.invocations[callId],candidate)):undefined;
        const spend=bound&&pairLinkSpend(bound.invocations[callId!],candidate);
        if(spend)this.enqueue({actionType:'link_spend',description:linkSpendDescription(spend),metadata:{...linkSpendWitnessMetadata(spend),source:'transcript',harness:p.program,link_spend_binding:linkSpendBindingTag(bound!.invocations[callId!])},windowStart:at,windowEnd:at+1,identityDecided:true,occurredAtMs:at,idempotencyKey:'ls_'+hash(spend.link_spend_id)});
       }
      }
      const ended=spec.atomicResponses===false&&stable!==undefined?'dr_'+hash(p.program+':'+stable):st.response;
      if(events.some(e=>e.rule.kind==='turn_end')&&ended) {
       const r=this.state.responses[ended];
       const texts=events.filter(e=>e.rule.kind==='turn_end').flatMap(e=>e.rule.text?valuesAt(e.value,e.rule.text):[]).filter((x):x is string=>typeof x==='string');
       if(r&&!this.state.closed[r.key]&&texts.length)r.output_digests=texts.map(x=>({hash:'sha256:'+hash(x),kind:'response'}));
       this.emit(p,ended);
      }
      st.cursor=row.ordinal;
      // State, cursor, pending PE and response ownership are one durable transaction.
      this.save();
     }
     st.checkpoint=sourceCheckpoint(spec,src,st.cursor);if(st.cursor>=src.tip&&src.tip>0)st.replay=false;
    }catch{this.flag(p.program);healthy=false;}
   }
   if(healthy&&this.broken.delete(p.program))writeLocal(path.join(path.dirname(this.statePath),'witness-action-required.json'),{programs:[...this.broken]});
  }
  this.state.lastReadMs=this.now();this.save();
 }
 private emit(p:ProgramWitness,id:string):void {
  const r=this.state.responses[id];if(!r||!r.calls.length||this.state.closed[id]||!this.registry.allows(p.program,'transcript'))return;
  this.state.closed[id]=true;for(const f of r.fingerprints)this.state.copies[f]=true;
  this.enqueue({actionType:'agent_tool_orchestration',description:`${p.program} — ${r.calls.length} tool call(s)`,metadata:{tool:'provian:transcript',source:'transcript',harness:p.program,program:p.program,turn_id:id,capture_unit:'model_response',tool_count:r.calls.length,tool_names:[...new Set(r.names)].slice(0,50)},input_origins:r.origins,...(r.output_digests?{output_digests:r.output_digests}:{}),windowStart:r.start,windowEnd:Math.max(r.end,r.start+1),occurredAtMs:r.end,identityDecided:true,idempotencyKey:id});
  this.registry.captured(p.program,'transcript',this.now());this.lastCapture=this.now();
 }
 private enqueue(pe:PluginPE):void{const key=pe.idempotencyKey!;if(this.state.pending[key])return;this.state.pending[key]=pe;this.save();this.queue.push(pe);}
 captureHealth(){const result={harnesses:this.harnesses,cursorTotal:Object.keys(this.state.sources).length,lastVerdictAtMs:this.lastPoll,lastVerdict:(this.broken.size?'unknown':this.lastCapture?'capturing':'idle') as 'capturing'|'idle'|'unknown',lastCaptureAtMs:this.lastCapture,sqliteReadable:sqliteAvailability().available,recordsConsumedInWindow:this.records,toolCallsRecognizedInWindow:this.calls,formatBrokenPrograms:[...this.broken]};this.records=0;this.calls=0;return result;}
}

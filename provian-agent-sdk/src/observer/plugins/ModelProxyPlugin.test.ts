// This forwarding fixture uses a synthetic loopback upstream. Production guard tests
// exercise private refusal separately; only this file's upstream is adapted for the fixture.
vi.mock('../../egress-guard', async importOriginal => {
  const actual = await importOriginal<typeof import('../../egress-guard')>();
  return { ...actual, validateEgressTarget: async (url: string) => url.startsWith('http://127.0.0.1:')
    ? { ok: true, hostname: '127.0.0.1', resolvedIps: ['127.0.0.1'] }
    : actual.validateEgressTarget(url) };
});
import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ModelProxyPlugin } from './ModelProxyPlugin';
import { configureProgram, ProgramWitnessRegistry } from '../program-witness';
import { PeerAttributor } from '../peer-process';
import type { ProvianObserver } from '../ProvianObserver';
const secretKey='sk-sentinel-secret-key', secretPrompt='private-prompt-sentinel',secretOutput='private-completion-sentinel';
async function request(port:number,body:unknown,headers:Record<string,string>={}) {
 return new Promise<{body:string;status:number}>((resolve,reject)=>{
  const r=http.request({host:'127.0.0.1',port,path:'/openai/v1/chat/completions',method:'POST',headers:{'content-type':'application/json',authorization:secretKey,...headers}},res=>{const b:Buffer[]=[];res.on('data',c=>b.push(c));res.on('end',()=>resolve({body:Buffer.concat(b).toString(),status:res.statusCode!}));});r.on('error',reject);r.end(JSON.stringify(body));
 });
}
async function run(lane:'model_proxy'|'otel',streamed=false,observationCapBytes?:number) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-test-')),reg=path.join(root,'registry.json');configureProgram({program:'demo',lane,processNames:['demo']},reg);
 const registry=new ProgramWitnessRegistry(reg);let response=JSON.stringify({id:'response-tool',model:'api-model',choices:[{message:{role:'assistant',content:secretOutput,tool_calls:[{id:'call-a',type:'function',function:{name:'WebFetch',arguments:JSON.stringify({url:'https://arxiv.org/private-query'})}}]}}],usage:{prompt_tokens:100,completion_tokens:5,total_tokens:105}});
 const requests:Array<{body:string;key:string|undefined}>=[];
 const upstream=http.createServer((req,res)=>{const b:Buffer[]=[];req.on('data',c=>b.push(c));req.on('end',()=>{requests.push({body:Buffer.concat(b).toString(),key:req.headers.authorization});res.writeHead(200,{'content-type':streamed?'text/event-stream':'application/json'});res.end(response);});});
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const port=(upstream.address() as import('net').AddressInfo).port;
 const previous=process.env.PROVIAN_PROXY_UPSTREAM_OPENAI;process.env.PROVIAN_PROXY_UPSTREAM_OPENAI=`http://127.0.0.1:${port}`;
 const logs:unknown[]=[];const plugin=new ModelProxyPlugin({port:0,programRegistry:registry,journalPath:path.join(root,'journal.json'),...(observationCapBytes===undefined?{}:{observationCapBytes}),peerAttributor:new PeerAttributor({lookup:async()=>[{pid:999,args:'demo',exe:'/usr/bin/demo'}],identifyProgram:p=>registry.identify(p)})});
 await plugin.init({log:(...args:unknown[])=>logs.push(args),observerDeviceWitness:()=>({type:'observer_device',identity:'device-test',attestation_tier:'software'})} as unknown as ProvianObserver);await plugin.start();
 return {root,plugin,logs,requests,response:()=>response,setResponse:(s:string)=>{response=s;},close:async()=>{await plugin.stop();await new Promise<void>(r=>upstream.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});if(previous===undefined)delete process.env.PROVIAN_PROXY_UPSTREAM_OPENAI;else process.env.PROVIAN_PROXY_UPSTREAM_OPENAI=previous;}};
}
describe('the real loopback proxy obeys the fixed program witness',()=>{
 it('forwards bytes and keys exactly; each tool-calling model response mints once; RED sentinels never leave in a PE, log or journal',async()=>{
  const f=await run('model_proxy');try {
   const body={model:'api-model',messages:[{role:'user',content:secretPrompt}]};const result=await request(f.plugin.boundPort()!,body);expect(result.status).toBe(200);expect(result.body).toBe(f.response());expect(f.requests[0]).toEqual({body:JSON.stringify(body),key:secretKey});const pes=f.plugin.drainPEs();expect(pes).toHaveLength(1);
   f.setResponse(JSON.stringify({id:'response-final',choices:[{message:{role:'assistant',content:secretOutput}}]}));
   await request(f.plugin.boundPort()!,{messages:[{role:'tool',tool_call_id:'call-a',content:secretOutput}]});expect(f.plugin.drainPEs()).toEqual([]);expect(pes[0].metadata).toMatchObject({program:'demo',source:'model_proxy',tool_count:1});expect(JSON.stringify(pes[0].input_origins)).toContain('domain:arxiv.org');
   const kept=JSON.stringify([pes,f.logs])+fs.readFileSync(path.join(f.root,'journal.json'),'utf8');for(const s of [secretKey,secretPrompt,secretOutput,'private-query'])expect(kept).not.toContain(s);
   f.plugin.onCommitted(pes[0],'submitted');await request(f.plugin.boundPort()!,{messages:[{role:'tool',tool_call_id:'call-a'}]});expect(f.plugin.drainPEs()).toEqual([]);
  } finally {await f.close();}
 });
 it('RED: the same traffic for a program assigned to OTel is forwarded but produces no proxy mint',async()=>{
  const f=await run('otel');try{expect((await request(f.plugin.boundPort()!,{messages:[{role:'user',content:secretPrompt}]})).status).toBe(200);f.setResponse(JSON.stringify({id:'f',choices:[{message:{role:'assistant',content:'done'}}]}));await request(f.plugin.boundPort()!,{messages:[{role:'tool',tool_call_id:'call-a'}]});expect(f.plugin.drainPEs()).toEqual([]);}finally{await f.close();}
 });
 it('the observation copy is bounded: an oversized request forwards byte-exact (schemas skipped, turn still minted); an oversized response forwards byte-exact but is not witnessed',async()=>{
  const f=await run('model_proxy',false,2048);try{
   const big={model:'api-model',messages:[{role:'user',content:'x'.repeat(4096)}]};
   const r1=await request(f.plugin.boundPort()!,big);expect(r1.status).toBe(200);expect(r1.body).toBe(f.response());expect(f.requests[0]).toEqual({body:JSON.stringify(big),key:secretKey});
   expect(f.plugin.drainPEs()).toHaveLength(1);
   f.setResponse(JSON.stringify({id:'response-big',model:'api-model',choices:[{message:{role:'assistant',content:'y'.repeat(4096),tool_calls:[{id:'call-b',type:'function',function:{name:'WebFetch',arguments:JSON.stringify({url:'https://arxiv.org/other'})}}]}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
   const r2=await request(f.plugin.boundPort()!,{model:'api-model',messages:[{role:'user',content:'q'}]});expect(r2.status).toBe(200);expect(r2.body).toBe(f.response());
   // RED control (2026-10-17): the unbounded tee witnessed (and minted) this turn.
   expect(f.plugin.drainPEs()).toEqual([]);expect(JSON.stringify(f.logs)).toContain('observation cap');
  }finally{await f.close();}
 });
 it('RED: browser-origin traffic is refused before any upstream call',async()=>{
  const f=await run('model_proxy');try{expect((await request(f.plugin.boundPort()!,{}, {origin:'https://attacker.example'})).status).toBe(403);expect(f.requests).toEqual([]);expect(f.plugin.drainPEs()).toEqual([]);}finally{await f.close();}
 });
});

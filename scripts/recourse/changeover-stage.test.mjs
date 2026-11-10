import { test } from 'vitest';import assert from 'node:assert/strict';import{Wallet,keccak256}from'ethers';
import{advanceChangeoverStage}from'./changeover-stage.mjs';
const w=new Wallet('0x'+'11'.repeat(32)),from=w.address.toLowerCase(),to='0x'+'22'.repeat(20),planDigest='0x'+'33'.repeat(32);
function fixture(){
 let saved,signatures=0,lease=true,mode='included',nonce=0;const signed=new Map(),sent=[];
 const steps=[0,1,2].map(n=>({from,to,data:'0x123456'+n.toString().padStart(2,'0'),value:'0'}));
 const receipt=raw=>({hash:keccak256(raw),status:mode==='revert'?0:1});
 const signer={chainId:async()=>8453n,signerAddress:async()=>from,nonces:async()=>({latest:nonce,pending:nonce}),
  prepare:async s=>{signatures++;return w.signTransaction({type:2,chainId:8453,to:s.to,data:s.data,value:0,nonce:s.nonce,gasLimit:30000,maxFeePerGas:2,maxPriorityFeePerGas:1});},
  finalized:async raw=>mode==='final'?receipt(raw):null,
  broadcast:async raw=>{sent.push(raw);signed.set(raw,true);nonce++;return keccak256(raw);}};
 const port={assertLease:async()=>{if(!lease)throw Error('lease lost');},assertPlan:async h=>{assert.equal(h,planDigest);},
  forSigner:a=>{assert.equal(a,from);return signer;},included:async raw=>mode==='absent'?null:receipt(raw)};
 return {steps,planDigest,port,persist:async s=>{saved=structuredClone(s);},saved:()=>saved,counts:()=>({signatures,sent:sent.length}),
  mode:v=>mode=v,lease:v=>lease=v,nonce:v=>nonce=v};
}
test('pipelines canonical inclusion, retains exact bytes, and completes only after every receipt finalizes',async()=>{
 const f=fixture();assert.equal((await advanceChangeoverStage(f)).status,'awaiting_finality');assert.equal(f.counts().signatures,3);
 const raw=JSON.stringify(f.saved().attempts);
 assert.equal((await advanceChangeoverStage({...f,journal:f.saved()})).status,'awaiting_finality');assert.equal(JSON.stringify(f.saved().attempts),raw);
 assert.deepEqual(f.counts(),{signatures:3,sent:3});f.mode('final');
 assert.equal((await advanceChangeoverStage({...f,journal:f.saved()})).status,'confirmed');assert.equal(f.saved().completed,true);
});
test('missing earlier inclusion, revoked lease, changed plan and reverted receipt prevent later signatures',async()=>{
 const f=fixture();f.mode('absent');assert.equal((await advanceChangeoverStage(f)).step,0);assert.equal(f.counts().signatures,1);
 f.lease(false);await assert.rejects(advanceChangeoverStage({...f,journal:f.saved()}),/lease lost/);assert.equal(f.counts().signatures,1);
 f.lease(true);await assert.rejects(advanceChangeoverStage({...f,journal:f.saved(),steps:f.steps.slice(1)}),/journal_mismatch/);
 f.mode('revert');await assert.rejects(advanceChangeoverStage({...f,journal:f.saved()}),/inclusion_invalid/);assert.equal(f.counts().signatures,1);
});
test('a reorganization retries the first durable nonce before progressing to later work',async()=>{
 const f=fixture();await advanceChangeoverStage(f);f.mode('absent');f.nonce(0);
 const result=await advanceChangeoverStage({...f,journal:f.saved()});assert.equal(result.step,0);assert.deepEqual(f.counts(),{signatures:3,sent:4});
});

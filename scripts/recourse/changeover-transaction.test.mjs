import { test } from 'vitest';
import assert from 'node:assert/strict';
import {Wallet,keccak256,getCreateAddress} from 'ethers';
import {advanceChangeoverTransaction} from './changeover-transaction.mjs';
const signer=new Wallet('0x'+'11'.repeat(32)); // Public fixture only.
function fixture(){
 let saved=null,sends=0,signatures=0,mode='valid',latest=3;
 const step={from:signer.address.toLowerCase(),nonce:3,value:'0',data:'0x60006000f3',address:getCreateAddress({from:signer.address,nonce:3}).toLowerCase()};
 const port={chainId:async()=>8453n,signerAddress:async()=>step.from,nonces:async()=>({latest,pending:latest}),
  prepare:async s=>{signatures++;return signer.signTransaction({chainId:8453,type:2,nonce:s.nonce,to:mode==='substitute'?signer.address:s.to??null,
   data:s.data,value:0,gasLimit:100000,maxFeePerGas:100,maxPriorityFeePerGas:1});},
  finalized:async()=>mode==='final'||mode==='revert'?{hash:saved.hash,status:mode==='revert'?0:1,contractAddress:step.address}:null,
  broadcast:async raw=>{assert.equal(raw,saved.raw);sends++;if(mode==='timeout')throw Error('response lost');return keccak256(raw);}};
 return {step,port,persist:async v=>{saved=structuredClone(v);},saved:()=>saved,counts:()=>({sends,signatures}),
   mode:v=>mode=v,nonce:v=>latest=v};
}
test('lost CREATE response retries exact bytes and confirms the predicted address without a second signature',async()=>{
 const f=fixture();f.mode('timeout');await assert.rejects(advanceChangeoverTransaction(f),/response lost/);
 const raw=f.saved().raw;f.mode('valid');await advanceChangeoverTransaction({...f,prior:f.saved()});
 assert.equal(f.saved().raw,raw);assert.deepEqual(f.counts(),{sends:2,signatures:1});
 f.mode('final');f.nonce(4);assert.equal((await advanceChangeoverTransaction({...f,prior:f.saved()})).status,'confirmed');
 assert.equal(f.counts().sends,2);
});
test('changed call, substituted signer output and nonce drift cannot produce another deployment',async()=>{
 const f=fixture();await advanceChangeoverTransaction(f);
 await assert.rejects(advanceChangeoverTransaction({...f,prior:f.saved(),step:{...f.step,data:'0x6000'}}),/journal_mismatch/);
 const bad=fixture();bad.mode('substitute');await assert.rejects(advanceChangeoverTransaction(bad),/signed_binding/);assert.equal(bad.counts().sends,0);
 const stale=fixture();stale.nonce(4);await assert.rejects(advanceChangeoverTransaction(stale),/nonce_conflict/);assert.equal(stale.counts().signatures,0);
 const wrong=fixture();await assert.rejects(advanceChangeoverTransaction({...wrong,step:{...wrong.step,address:signer.address.toLowerCase()}}),/create_address/);
 assert.deepEqual(wrong.counts(),{signatures:0,sends:0});
 f.nonce(4);assert.equal((await advanceChangeoverTransaction({...f,prior:f.saved()})).status,'awaiting_finality');
 f.mode('revert');assert.equal((await advanceChangeoverTransaction({...f,prior:f.saved()})).status,'reverted');
 assert.equal(f.counts().signatures,1);
});

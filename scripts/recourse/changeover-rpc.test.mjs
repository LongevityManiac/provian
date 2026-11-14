import { test } from 'vitest';import assert from 'node:assert/strict';import{Wallet,Transaction,keccak256}from'ethers';
import{changeoverRpcPort}from'./changeover-rpc.mjs';
const wallet=new Wallet('0x'+'11'.repeat(32)),to='0x'+'22'.repeat(20),h='0x'+'33'.repeat(32),other='0x'+'44'.repeat(32);
test('a broadcast authority callback is mandatory, not an optional shortcut',()=>{
 assert.throws(()=>changeoverRpcPort({rpcs:[{request:async()=>{}},{request:async()=>{}}],signer:wallet,
  assertLease:async()=>{},approveFee:async()=>{},maxFeePerGas:100n,maxPriorityFeePerGas:1n,maxGas:100000n}),/configuration/);
});
function fixture(){
 let mode='valid',final=101,orphaned=false,lease=true,approved=true,authority=true,signed=0,sent=0,raw;
 const step={from:wallet.address.toLowerCase(),to,value:'0',data:'0x1234',nonce:3};
 const request=i=>async(method,params)=>{
  if(method==='eth_chainId'){if(mode==='expire-lease')lease=false;if(mode==='source-during-chain')authority=false;return mode==='chain'&&i===1?'0x1':'0x2105';}
  if(method==='eth_getTransactionCount')return '0x3';
  if(method==='eth_getBlockByNumber'){if(mode==='finality-race'&&params[0]==='finalized')orphaned=true;const n=params[0]==='finalized'?final:params[0]==='latest'?101:Number(BigInt(params[0]));return{hash:(mode==='reorg'||orphaned)&&n===100?other:h,number:'0x'+n.toString(16)};}
  if(method==='eth_call')return mode==='simulation'&&i===1?'0x01':'0x';
  if(method==='eth_estimateGas')return i===0?'0x7530':'0x9c40';
  if(method==='eth_sendRawTransaction'){sent++;assert.equal(params[0],raw);return keccak256(raw);}
  if(method==='eth_getTransactionReceipt')return mode==='missing'&&i===1?null:{transactionHash:keccak256(raw),blockHash:mode==='receipt'&&i===1?other:h,blockNumber:'0x64',status:'0x1',contractAddress:null};
  if(method==='eth_getTransactionByHash'){const tx=Transaction.from(raw);return{hash:tx.hash,blockHash:h,blockNumber:'0x64',from:mode==='sender'?to:tx.from,to:tx.to,nonce:mode==='nonce'?'0x4':'0x3',value:'0x0',chainId:'0x2105',input:tx.data};}
  throw Error('unexpected '+method);
 };
 const signer={getAddress:async()=>{if(mode==='source-during-address')authority=false;return wallet.address;},signTransaction:async tx=>{signed++;if(mode==="mutating-signer")tx.maxFeePerGas++;raw=await wallet.signTransaction(mode==="oversign"?{...tx,maxFeePerGas:tx.maxFeePerGas+1n}:tx);return raw;}};
 const port=changeoverRpcPort({rpcs:[{request:request(0)},{request:request(1)}],signer,
  assertBroadcast:async()=>{if(!authority)throw Error('source changed');if(mode==='lease-during-authorization')lease=false;},
  assertLease:async()=>{if(!lease)throw Error('lease lost');},approveFee:async quote=>{assert.equal(quote.transaction.gasLimit,48000n);if(!approved)throw Error('fee refused');if(mode==='mutating-fee')quote.transaction.maxFeePerGas++;},
  maxFeePerGas:100n,maxPriorityFeePerGas:1n,maxGas:100000n});
 return{port,step,mode:v=>mode=v,final:v=>final=v,lease:v=>lease=v,approved:v=>approved=v,counts:()=>({signed,sent})};
}
test('simulates independently, reserves fees before signing, and distinguishes inclusion from finality',async()=>{
 const f=fixture(),raw=await f.port.prepare(f.step);assert.deepEqual(f.counts(),{signed:1,sent:0});
 await f.port.broadcast(raw);assert.deepEqual(f.counts(),{signed:1,sent:1});
 f.final(99);assert.ok(await f.port.included(raw));assert.equal(await f.port.finalized(raw),null);
 f.final(101);assert.equal((await f.port.finalized(raw)).hash,keccak256(raw));
});
test('source changes during final broadcast preparation and lease loss after authorization refuse every send',async()=>{
 for(const mode of ['source-during-chain','source-during-address','lease-during-authorization']){
  const f=fixture(),raw=await f.port.prepare(f.step);f.mode(mode);
  await assert.rejects(f.port.broadcast(raw),/source changed|lease lost/);assert.equal(f.counts().sent,0);
  // Retained-byte replay must pass the same final authority boundary.
  await assert.rejects(f.port.broadcast(raw),/source changed|lease lost/);assert.equal(f.counts().sent,0);
 }
});
test('expired lease, refused fee and disagreeing simulation prevent signing or broadcasting',async()=>{
 const f=fixture();f.approved(false);await assert.rejects(f.port.prepare(f.step),/fee refused/);assert.equal(f.counts().signed,0);
 f.approved(true);f.mode('simulation');await assert.rejects(f.port.prepare(f.step),/disagreement/);assert.equal(f.counts().signed,0);
 f.mode('valid');const raw=await f.port.prepare(f.step);f.lease(false);await assert.rejects(f.port.broadcast(raw),/lease lost/);assert.equal(f.counts().sent,0);
});
test('receipt disagreement, reorganization, substituted sender/nonce and wrong chain refuse finality',async()=>{
 for(const mode of ['receipt','reorg','sender','nonce','chain']){const f=fixture(),raw=await f.port.prepare(f.step);f.mode(mode);await assert.rejects(f.port.finalized(raw),/changeover_rpc_/);}
 const f=fixture(),raw=await f.port.prepare(f.step);f.mode('missing');assert.equal(await f.port.included(raw),null);
});

test('rechecks canonical membership after finalized-head reads and lease after broadcast preparation',async()=>{
 const f=fixture(),raw=await f.port.prepare(f.step);f.mode('finality-race');
 await assert.rejects(f.port.finalized(raw),/reorg/);
 const expired=fixture(),pending=await expired.port.prepare(expired.step);expired.mode('expire-lease');
 await assert.rejects(expired.port.broadcast(pending),/lease lost/);assert.equal(expired.counts().sent,0);
});

test('a signer cannot return an unreserved fee transaction',async()=>{
 const f=fixture();f.mode('oversign');await assert.rejects(f.port.prepare(f.step),/signed_fee_binding/);
 assert.deepEqual(f.counts(),{signed:1,sent:0});
});

test('mutable callbacks cannot change the simulated transaction or comparison baseline',async()=>{
 const signer=fixture();signer.mode('mutating-signer');
 await assert.rejects(signer.port.prepare(signer.step),/signed_fee_binding/);
 assert.equal(signer.counts().sent,0);
 const fee=fixture();fee.mode('mutating-fee');const raw=await fee.port.prepare(fee.step);
 assert.equal(Transaction.from(raw).maxFeePerGas,100n);
});

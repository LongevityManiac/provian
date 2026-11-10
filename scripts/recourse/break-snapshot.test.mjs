import { test } from 'vitest';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress, ZeroHash, keccak256, sha256 } from 'ethers';
import { buildBreakOwnershipSnapshot } from './break-snapshot.mjs';
import { verifyProof } from './snapshot.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`, h=s=>sha256(Buffer.from(s));
const kernel=addr(1),registry=addr(2),executor=addr(3),pointer=addr(4),owner=addr(5),alias=addr(6),empty=addr(7);
const id=h('owner TEST ONLY'),emptyId=h('zero balance TEST ONLY'),blockHash=h('last good block TEST ONLY');
const abi=new Interface(['function protocolPointer() view returns(address)','function registryOperator() view returns(address)',
 'function previousRegistry() view returns(address)','function pointer() view returns(address)','function ownerAuthorization() view returns(address)','function ownerOf(address) view returns(bytes32)',
 'function boundBlock(address) view returns(uint256)','function ownerRecoveryCommitment(bytes32) view returns(bytes32)',
 'function ownerSigningRoot(bytes32) view returns(bytes32)','function balanceOf(address) view returns(uint256)',
 'function kernel() view returns(address)','function previousAuthorization() view returns(address)','function totalSupply() view returns(uint256)','function pvt() view returns(address)',
 'function current() view returns(uint256,bytes32,address[10],bytes32[10])',
 'function reversalExecuted(bytes32) view returns(bool)',
 'function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))',
 'event RestorationIntentAuthorized(bytes32 indexed request,bytes32 indexed identity,address indexed destination,bytes32 lossHash,uint256 maximumLoss,bytes32 intentHash)',
 'event OwnershipBound(bytes32 indexed identity,address indexed account,address indexed kernel,bytes32 recoveryCommitment,bytes32 signingRoot,bytes32 digest)']);
function fixture(){
 const institutions=Array.from({length:6},(_,i)=>({source:addr(20+i),destination:addr(40+i),runtimeHash:keccak256('0x6001')}));
 const manifestInstitutions=institutions.map(x=>x.source);
 const logs=[owner,alias,empty].map((account,i)=>({address:registry,blockNumber:'0x5',logIndex:`0x${i.toString(16)}`,removed:false,
  ...abi.encodeEventLog(abi.getEvent('OwnershipBound'),[i===2?emptyId:id,account,kernel,h('commit'),h('root'),h('binding'+i)])}));
 const balances=new Map([[owner,40n],[alias,10n],[empty,0n],[institutions[0].source,7n]]);
 const state={supply:60n,reorg:false,commitment:h('commit'),ownerId:id,intent:null};const executorLogs=[];
 const port={async code(target,pin){return pin===ZeroHash?'0x':'0x6000';},async blockHash(n){return n===0?ZeroHash:state.reorg?ZeroHash:blockHash;},
 async logs(target){return target.toLowerCase()===registry?logs:executorLogs;},async call(target,data,pin){assert.equal(pin,blockHash);const f=abi.parseTransaction({data});let value;
 switch(f.name){
 case 'pointer':value=pointer;break;case 'previousRegistry':value=ZeroAddress;break;case 'kernel':value=kernel;break;case 'previousAuthorization':value=ZeroAddress;break;case 'protocolPointer':value=pointer;break;case 'registryOperator':value=registry;break;case 'ownerAuthorization':value=executor;break;
 case 'ownerOf':value=f.args[0].toLowerCase()===empty?emptyId:state.ownerId;break;case 'boundBlock':value=5n;break;
 case 'ownerRecoveryCommitment':value=state.commitment;break;case 'ownerSigningRoot':value=h('root');break;
 case 'reversalExecuted':value=false;break;case 'restorationIntent':value=state.intent;break;
 case 'balanceOf':value=balances.get(f.args[0].toLowerCase())??0n;break;case 'totalSupply':value=state.supply;break;
 case 'pvt':value=kernel;break;case 'current':return abi.encodeFunctionResult('current',[1,h('manifest'),[kernel,addr(11),addr(12),...manifestInstitutions,addr(13)],Array(10).fill(h('code'))]);
 default:throw Error('unexpected call '+f.name);}
 return abi.encodeFunctionResult(f.name,[value]);}};
 return {input:{port,predecessor:kernel,block:10,blockHash,expectedKernelRuntimeHash:keccak256('0x6000'),registryDeploymentBlock:1,
 expectedRegistryRuntimeHash:keccak256('0x6000'),institutions},logs,executorLogs,state,balances};
}
test('last-good chain ownership aggregates aliases, retains zero owners, separates custody and excludes unbound balances',async()=>{
 const f=fixture(),s=await buildBreakOwnershipSnapshot(f.input);
 assert.equal(s.boundBalance,'50');assert.equal(s.institutionalBalance,'7');assert.equal(s.snapshotBalance,'57');assert.equal(s.unboundBalance,'3');
 assert.deepEqual(s.counts,{bindingEvents:3,accounts:3,owners:2,institutions:6,reversals:0,pendingIntents:0});
 assert.equal(s.entries.find(e=>e.identity===id).accounts.length,2);assert.equal(s.entries.find(e=>e.identity===emptyId).amount,'0');
 for(const e of s.entries)assert.ok(verifyProof(e.leaf,e.proof,s.root));
});
test('pending consent enters the authenticated history count with its original loss and destination',async()=>{
 const f=fixture(),request=h('request');
 f.state.intent=[request,id,owner,h('loss'),25n];
 f.executorLogs.push({address:executor,blockNumber:'0x6',logIndex:'0x0',removed:false,
  ...abi.encodeEventLog(abi.getEvent('RestorationIntentAuthorized'),[...f.state.intent,h('intent')])});
 const s=await buildBreakOwnershipSnapshot(f.input),intent=s.entries.find(e=>e.kind==='intent');
 assert.equal(s.counts.pendingIntents,1);assert.equal(s.entries.find(e=>e.kind==='reversal-count').count,1);
 assert.equal(intent.maximumLoss,'25');assert.equal(intent.destination.toLowerCase(),owner);
 assert.ok(verifyProof(intent.leaf,intent.proof,s.root));
 f.state.intent[1]=h('unknown identity');await assert.rejects(buildBreakOwnershipSnapshot(f.input),/intent_missing/);
});
test('no empty population, forged identity, missing custody, duplicate binding, unbacked total or missing commitment',async()=>{
 for(const mutate of [f=>f.logs.length=0,f=>f.state.ownerId=h('attacker'),f=>f.input.institutions.pop(),
 f=>f.logs.push(f.logs[0]),f=>f.state.supply=1n,f=>f.state.commitment=ZeroHash,
 f=>f.input.institutions[0].source=owner,f=>f.state.reorg=true]){
  const f=fixture();mutate(f);await assert.rejects(buildBreakOwnershipSnapshot(f.input),/break_snapshot_/);
 }
});

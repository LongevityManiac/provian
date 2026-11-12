import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, ZeroHash, keccak256, sha256 } from 'ethers';
import { buildPoolSnapshot, poolSnapshotAbi as abi, standingSnapshotAbi as standing, poolRecordTypes, poolStateLeaf } from './pool-snapshot.mjs';
import { verifyProof } from './snapshot.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,h=s=>sha256(Buffer.from(s));
const pool=addr(1),kernel=addr(2),account=addr(3),id=h('binding TEST ONLY'),request=h('request TEST ONLY'),occurrence=h('occurrence TEST ONLY');
const pin=h('cutoff TEST ONLY'),coder=AbiCoder.defaultAbiCoder();
function fixture(){
 const state={balance:100n,allocated:40n,owner:id,ready:true,primary:account,generation:1n,nonce:1n};
 const events=[['AddressBound',[id,account]],['AddressConsentChanged',[id,1,true,0]],['ReserveContributed',[id,100]],
  ['RestorationAllocated',[request,id,40,40]],['RestorationDetermined',[request,id,occurrence,true,40,h('evidence'),1]]];
 const logs=events.map(([name,args],i)=>({address:pool,blockNumber:'0x5',logIndex:`0x${i.toString(16)}`,removed:false,...abi.encodeEventLog(abi.getEvent(name),args)}));
 const standingLogs=[{address:addr(4),blockNumber:'0x5',logIndex:'0x10',removed:false,...standing.encodeEventLog(standing.getEvent('StandingConsentApproved'),[id,1,100,100,100,100,h('exit'),h('salt')])},
  {address:addr(4),blockNumber:'0x6',logIndex:'0x0',removed:false,...standing.encodeEventLog(standing.getEvent('MonthlyCollectionRecorded'),[id,100,100,100])}];
 const tokenAbi=new Interface(['function balanceOf(address) view returns(uint256)']);
 const port={async code(target,hash){return hash===ZeroHash?'0x':'0x6000';},async blockHash(n){return n===0?ZeroHash:pin;},async logs(target){return target===pool?logs:standingLogs;},
 async call(target,data,hash){assert.equal(hash,pin);if(target===kernel)return tokenAbi.encodeFunctionResult('balanceOf',[state.balance]);
  if(target===addr(4)){const f=standing.parseTransaction({data});
   return standing.encodeFunctionResult(f.name,[f.name==='pool'?pool:f.name==='standingMandate'?[100,100,100,100,0,state.nonce,h('exit'),h('salt'),true]:[100,100]]);}
  const f=abi.parseTransaction({data});let v;
  switch(f.name){
  case 'standingMembership':v=addr(4);break;case 'requiresSnapshotRecovery':v=false;break;case 'pvt':v=kernel;break;case 'poolHistoryReady':v=state.ready;break;
  case 'allocatedRestorations':v=40;break;case 'accountedBacking':v=60;break;
  case 'monthlyRuleCount':v=1;break;case 'monthlyRuleAt':v=[0,100,100,100,h('rule')];break;
  case 'addressConsent':v=[state.nonce,state.generation,true];break;case 'debitNonce':v=9;break;
  case 'primaryAddress':v=state.primary;break;case 'recoveryNonce':v=7;break;case 'outcomeRevision':v=1;break;
  case 'consentPeriods':v=[5,f.args[1]<state.generation?6:0];break;case 'restorationAllocations':v=[id,state.allocated,false];break;
  case 'ownerOf':v=state.owner;break;
  case 'determined':case 'occurrenceDetermined':v=true;break;
  default:throw Error(f.name);}
  return abi.encodeFunctionResult(f.name,[v]);}};
 return {input:{port,pool,kernel,block:10,blockHash:pin,deploymentBlock:1,expectedRuntimeHash:keccak256('0x6000')},state,logs,standingLogs};
}
test('complete pool snapshot binds the same custody cutoff, rules, independent consents and nonrefundable reserves',async()=>{
 const f=fixture(),s=await buildPoolSnapshot(f.input);assert.equal(s.balance,'100');assert.equal(s.counts.bindings,1);
 assert.deepEqual(s.entries.map(e=>e.kind),[0,1,2,4,5,7,8,9,10]);
 const consent=coder.decode(poolRecordTypes[2],s.entries[2].data);assert.equal(consent[1].nonce,1n);assert.equal(consent[5],9n);
 for(const e of s.entries){assert.equal(e.leaf,poolStateLeaf(pool,10,e.kind,e.data));assert.ok(verifyProof(e.leaf,e.proof,s.root));}
});
test('imported key history is sufficient for another succession and values are reread at the new cutoff',async()=>{
 const f=fixture(),first=await buildPoolSnapshot(f.input);f.logs.length=0;f.standingLogs.length=0;
 for(const [i,e] of first.entries.entries())f.logs.push({address:pool,blockNumber:'0x5',logIndex:`0x${i.toString(16)}`,removed:false,
  ...abi.encodeEventLog(abi.getEvent('PoolStateImported'),[e.kind,h('slot '+i),e.leaf,e.data])});
 const second=await buildPoolSnapshot(f.input);assert.deepEqual(second.entries,first.entries);
});
test('missing owners, accounts, current balances and totals are rejected rather than publishing an orphaned reserve',async()=>{
 for(const mutate of [f=>f.logs.shift(),f=>f.state.allocated=39n,f=>f.state.balance=99n,
  f=>f.state.owner=h('someone else'),f=>f.state.ready=false,f=>f.logs.push(f.logs[0]),f=>f.state.primary=addr(99)]){
  const f=fixture();mutate(f);await assert.rejects(buildPoolSnapshot(f.input),/pool_snapshot_/);
 }
});

test('rejoining preserves every historical consent period without publishing private invoices',async()=>{
 const f=fixture();f.state.generation=2n;f.state.nonce=3n;
 f.logs.push({address:pool,blockNumber:'0x6',logIndex:'0x0',removed:false,
  ...abi.encodeEventLog(abi.getEvent('AddressConsentChanged'),[id,2,true,2])});
 const s=await buildPoolSnapshot(f.input),periods=s.entries.filter(e=>e.kind===4).map(e=>coder.decode(poolRecordTypes[4],e.data));
 assert.deepEqual(periods.map(r=>r[1]),[1n,2n]);assert.equal(periods[0][2].endBlock,6n);assert.equal(periods[1][2].endBlock,0n);
 assert.equal(s.entries.some(e=>e.kind===3),false);
});
test('missing consent periods and inconsistent replay nonces refuse a snapshot',async()=>{
 for(const mutate of [f=>f.logs.splice(1,1),f=>f.state.generation=2n,f=>f.state.nonce=0n]){
  const f=fixture();mutate(f);await assert.rejects(buildPoolSnapshot(f.input),/pool_snapshot_(missing_consent_period|consent_nonce)/);
 }
});
test('retired public invoice records cannot be carried through succession',async()=>{
 const f=fixture();f.logs.push({address:pool,blockNumber:'0x6',logIndex:'0x0',removed:false,
  ...abi.encodeEventLog(abi.getEvent('PoolStateImported'),[3,h('slot'),h('leaf'),'0x'])});
 await assert.rejects(buildPoolSnapshot(f.input),/pool_snapshot_import_kind/);
});

test('renewed approval nonces and consumed monthly amounts survive repeated snapshots',async()=>{
 const f=fixture();f.state.nonce=4n;const snapshot=await buildPoolSnapshot(f.input);
 const m=coder.decode(poolRecordTypes[9],snapshot.entries.find(e=>e.kind===9).data)[1];assert.equal(m.consentNonce,4n);
 const c=coder.decode(poolRecordTypes[10],snapshot.entries.find(e=>e.kind===10).data);assert.equal(c[2].burn,100n);assert.equal(c[2].reserve,100n);
});

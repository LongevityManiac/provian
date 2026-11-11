import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, ZeroHash, keccak256, sha256 } from 'ethers';
import { buildPoolSnapshot, poolSnapshotAbi as abi, poolRecordTypes, poolStateLeaf } from './pool-snapshot.mjs';
import { verifyProof } from './snapshot.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,h=s=>sha256(Buffer.from(s));
const pool=addr(1),kernel=addr(2),account=addr(3),id=h('owner TEST ONLY'),request=h('request TEST ONLY'),occurrence=h('occurrence TEST ONLY');
const pin=h('cutoff TEST ONLY'),coder=AbiCoder.defaultAbiCoder();
function fixture(){
 const state={balance:100n,allocated:40n,owner:id,ready:true,primary:account};
 const events=[['AddressBound',[id,account]],['MembershipChanged',[id,true,1,24288]],
  ['MonthlyObligationRecorded',[id,1,24288,100,100]],['ReserveContributed',[id,100]],
  ['RestorationAllocated',[request,id,40,40]],['RestorationDetermined',[request,id,occurrence,true,40,h('evidence'),1]]];
 const logs=events.map(([name,args],i)=>({address:pool,blockNumber:'0x5',logIndex:`0x${i.toString(16)}`,removed:false,...abi.encodeEventLog(abi.getEvent(name),args)}));
 const tokenAbi=new Interface(['function balanceOf(address) view returns(uint256)']);
 const port={async code(target,hash){return hash===ZeroHash?'0x':'0x6000';},async blockHash(n){return n===0?ZeroHash:pin;},async logs(){return logs;},
 async call(target,data,hash){assert.equal(hash,pin);if(target===kernel)return tokenAbi.encodeFunctionResult('balanceOf',[state.balance]);
  const f=abi.parseTransaction({data});let v;
  switch(f.name){
  case 'requiresSnapshotRecovery':v=false;break;case 'pvt':v=kernel;break;case 'poolHistoryReady':v=state.ready;break;
  case 'allocatedRestorations':v=40;break;case 'accountedBacking':v=60;break;
  case 'monthlyRuleCount':v=1;break;case 'monthlyRuleAt':v=[0,100,100,100,h('rule')];break;
  case 'enrollment':v=[true,24288,24288,24288,0,1];break;
  case 'primaryAddress':v=state.primary;break;case 'recoveryNonce':v=7;break;case 'outcomeRevision':v=1;break;
  case 'obligations':v=[true,true,100,100,100,100,100,100,9999];break;
  case 'membershipPeriods':v=[5,0,24288];break;case 'restorationAllocations':v=[id,state.allocated,false];break;
  case 'ownerOf':v=state.owner;break;
  case 'determined':case 'occurrenceDetermined':v=true;break;
  default:throw Error(f.name);}
  return abi.encodeFunctionResult(f.name,[v]);}};
 return {input:{port,pool,kernel,block:10,blockHash:pin,deploymentBlock:1,expectedRuntimeHash:keccak256('0x6000')},state,logs};
}
test('complete pool snapshot binds the same custody cutoff, rules, owners, invoices and nonrefundable reserves',async()=>{
 const f=fixture(),s=await buildPoolSnapshot(f.input);assert.equal(s.balance,'100');assert.equal(s.counts.owners,1);
 assert.deepEqual(s.entries.map(e=>e.kind),[0,1,2,3,4,5,7,8]);
 const invoice=coder.decode(poolRecordTypes[3],s.entries[3].data)[3];assert.equal(invoice.earningsRemainder,9999n);
 for(const e of s.entries){assert.equal(e.leaf,poolStateLeaf(pool,10,e.kind,e.data));assert.ok(verifyProof(e.leaf,e.proof,s.root));}
});
test('imported key history is sufficient for another succession and values are reread at the new cutoff',async()=>{
 const f=fixture(),first=await buildPoolSnapshot(f.input);f.logs.length=0;
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

test('same-month rejoin invoice is exported even when copied without a new obligation event',async()=>{
 const f=fixture();f.logs.push({address:pool,blockNumber:'0x6',logIndex:'0x0',removed:false,
  ...abi.encodeEventLog(abi.getEvent('MembershipChanged'),[id,true,2,24288])});
 const s=await buildPoolSnapshot(f.input);const invoices=s.entries.filter(e=>e.kind===3).map(e=>coder.decode(poolRecordTypes[3],e.data));
 assert.deepEqual(invoices.map(r=>r[1]),[1n,2n]);assert.equal(invoices[1][3].burnPaid,100n);assert.equal(invoices[1][3].earningsRemainder,9999n);
});

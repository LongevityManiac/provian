import { test } from 'vitest';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Interface,ZeroAddress} from 'ethers';
import {LEGACY_INSTITUTIONS,buildInstitutionSnapshot,verifyInstitutionRuntime} from './institution-snapshot.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture(){
 const artifacts={},contracts={},ifaces=new Map(),names=new Map();
 let mode='valid';
 Object.entries(LEGACY_INSTITUTIONS).forEach(([key,name],i)=>{
  const compiled=JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`,import.meta.url)));
  artifacts[name]=compiled;contracts[key]={address:addr(i+1),block:10};ifaces.set(addr(i+1),new Interface(compiled.abi));names.set(addr(i+1),name);
 });
 const deployment={contracts,wiring:{pvt:addr(100),usdc:addr(101),admin:addr(102),epochClock:addr(100),issuanceIndex:addr(100),
   executor:addr(102),feeWallet:addr(103),provianTechWallet:addr(103)}};
 const token=new Interface(['function balanceOf(address) view returns(uint256)']);
 const port={
  blockHash:async n=>mode==='reorg'&&n===20?hash(99):hash(n),
  code:async(a,h)=>h===hash(9)?'0x':mode==='code'?'0x6000':artifacts[names.get(a)].deployedBytecode.object,
  logs:async a=>{
   if(Array.isArray(a))return (await Promise.all(a.map(v=>port.logs(v)))).flat();
   const i=ifaces.get(a),name=names.get(a),rows=[];
   const add=(event,args)=>{const log=i.encodeEventLog(i.getEvent(event),args);rows.push({...log,address:a,blockNumber:'0xc',logIndex:'0x'+rows.length.toString(16)});};
   if(name==='ProvianEscrowV4')add('EscrowCarried',[hash(1),addr(111),addr(112),500,5,1000,1]);
   if(name==='ProvianBondPool'){
    add('BondCarried',[addr(111),500,2,1000]);
    add('DepositFeeBpsScheduled',[mode==='future'?8:0,0]);
    if(mode==='claim')add('ClaimFiled',[hash(2),addr(112),addr(111)]);
   }
   if(mode==='duplicate')rows.push(rows[0]);
   return rows.filter(Boolean);
  },
  call:async(a,data,h)=>{
   assert.equal(h,hash(20));
   if(a===addr(100)||a===addr(101)){
    const owner=token.parseTransaction({data}).args[0].toLowerCase();
    return token.encodeFunctionResult('balanceOf',[a===addr(101)?(mode==='usdc'?1:0):owner===contracts.bondPool.address?(mode==='backing'?501:500):0]);
   }
   const i=ifaces.get(a),fn=i.parseTransaction({data}),name=fn.name;
   let values;
   if(['pvt','epochClock','issuanceIndex'].includes(name))values=[mode==='wiring'&&name==='epochClock'?addr(123):addr(100)];
   else if(name==='admin')values=[addr(102)];
   else if(name==='usdc')values=[mode==='token'?addr(123):addr(101)];
   else if(name==='escrowContract')values=[mode==='court'?addr(123):contracts.escrowV4.address];
   else if(name==='courtContract')values=[contracts.courtV2.address];
   else if(name==='bondPool')values=[contracts.bondPool.address];
   else if(deployment.wiring[name])values=[deployment.wiring[name]];
   else if(name==='escrows')values=[addr(111),addr(112),500,5,1000,0,1,false];
   else if(name==='bonds')values=[500,2,10,20,1000,1,mode==='pending'?1:0];
   else if(name==='requiredAtPost')values=[500];
   else if(name==='earliestSchedulableEpoch')values=[8];
   else if(name==='scheduledDepositFeeBps'||name==='activeDepositFeeBps')values=[true,0];
   else values=i.getFunction(name).outputs.map(o=>o.type==='address'?ZeroAddress:o.type==='bool'?false:o.type==='string'?'v4':0);
   return i.encodeFunctionResult(name,values);
  }
 };
 return {input:{port,deployment,artifacts,block:20,blockHash:hash(20)},mode:v=>mode=v};
}
test('all five actual institution ABIs are inventoried, with nonzero obligations and complete policy getters',async()=>{
 const f=fixture(),result=await buildInstitutionSnapshot(f.input);
 assert.equal(result.inventory.length,5);assert.equal(result.seedBonds.length,1);assert.equal(result.seedEscrows.length,1);
 assert.equal(result.seedBonds[0].amount,'500');assert.deepEqual(result.seedBps,[{param:1,bps:'0'}]);
 for(const row of result.inventory)assert.ok(row.policy.length>0);
 assert.equal(result.inventory[3].schedules[0].values[1],'0');
});
test('unsupported obligations, future terms, wrong backing, runtime/wiring substitution and history corruption refuse',async()=>{
 for(const mode of ['usdc','token','court','future','claim','pending','backing','code','wiring','duplicate','reorg']){
  const f=fixture();f.mode(mode);await assert.rejects(buildInstitutionSnapshot(f.input),/institution_snapshot_/);
 }
});
test('only the compiler metadata IPFS digest may vary; executable bytes and compiler version remain bound',()=>{
 const f=fixture(),a=f.input.artifacts.ProvianEscrowV4,code=a.deployedBytecode.object;
 const changed=code.replace(/(fea2646970667358221220)[0-9a-f]{64}(64736f6c6343)/,'$1'+'00'.repeat(32)+'$2');
 assert.notEqual(changed,code);verifyInstitutionRuntime(a,changed);
 assert.throws(()=>verifyInstitutionRuntime(a,changed.replace(/0008180033$/,'0008190033')),/runtime_mismatch/);
 assert.throws(()=>verifyInstitutionRuntime(a,'0x00'+changed.slice(4)),/runtime_mismatch/);
 assert.throws(()=>verifyInstitutionRuntime(a,changed.replace('fea2646970667358221220','00a2646970667358221220')),/runtime_mismatch/);
});

test('Court data preceding its metadata remains bound without requiring an INVALID byte',()=>{
 const a=fixture().input.artifacts.ProvianCourtV2,code=a.deployedBytecode.object;
 const changed=code.replace(/(a2646970667358221220)[0-9a-f]{64}(64736f6c6343)/,'$1'+'00'.repeat(32)+'$2');
 assert.notEqual(changed,code);verifyInstitutionRuntime(a,changed);
 const start=changed.length-106;
 const preceding=changed.slice(start-2,start);
 assert.throws(()=>verifyInstitutionRuntime(a,changed.slice(0,start-2)+(preceding==='00'?'01':'00')+changed.slice(start)),/runtime_mismatch/);
});

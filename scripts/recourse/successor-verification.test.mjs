import { test } from 'vitest';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Interface,ZeroAddress,ZeroHash} from 'ethers';
import {verifySuccessorPlan} from './successor-verification.mjs';
// Rehearsal-captured independent chain replies, never a fake zero population.
// Run with RECOURSE_SUCCESSOR_FIXTURE pointing at verification-fixture.json.
const fixturePath=process.env.RECOURSE_SUCCESSOR_FIXTURE;
function fixture(){
 const f=JSON.parse(readFileSync(fixturePath)),artifacts={};
 for(const name of [...Object.keys(f.plan.addresses),'RecourseStandingConsent','ProvianHashAccount','ProvianProtocolPointer','ProvianMemberSettlement'])
  artifacts[name]=JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`,import.meta.url)));
 const port={
  logs:async()=>f.logs,
  call:async(a,d,h)=>{assert.equal(h,f.block.hash);const key=a.toLowerCase()+':'+d;assert.ok(key in f.calls,'uncaptured call '+key);return f.calls[key];},
  code:async(a,h)=>{assert.equal(h,f.block.hash);assert.ok(a.toLowerCase() in f.codes);return f.codes[a.toLowerCase()];},
  blockHash:async n=>f.blocks[n],
 };
 return {...f,artifacts,port};
}
function corrupt(f,name,method,change,args=[]){
 const address=name==='ProvianProtocolPointer'?f.plan.pointer:name==='ProvianMemberSettlement'?f.plan.components[9]:
  name==='oldVerifier'?f.plan.snapshot.state.eligibilityVerifier.verifier:f.plan.addresses[name];
 const iface=new Interface(name==='oldVerifier'?['function batchApprover() view returns(address)']:f.artifacts[name].abi);
 const key=address.toLowerCase()+':'+iface.encodeFunctionData(method,args);
 assert.ok(key in f.calls,'negative control never reaches '+name+':'+method);
 const value=iface.decodeFunctionResult(method,f.calls[key]).toArray();
 f.calls[key]=iface.encodeFunctionResult(method,change(value));
}
test('rehearsed successor reconciles a nonempty real snapshot before publication',{skip:!fixturePath},async()=>{
 const f=fixture(),r=await verifySuccessorPlan(f);
 assert.ok(r.holders>0&&r.historyEntries>0);assert.equal(r.institutionCount,5);assert.equal(r.components.length,10);
});
const corruptions=[
 ['pointer controller',f=>corrupt(f,'ProvianProtocolPointer','authority',()=>[ZeroAddress]),/binding/],
 ['already published',f=>corrupt(f,'ProvianProtocolPointer','revision',()=>[1]),/state/],
 ['registry attestor',f=>corrupt(f,'ProvianOwnershipRegistry','identityAttestor',()=>[f.plan.admin]),/binding/],
 ['wrong balance root',f=>corrupt(f,'ProvianRestorationAuthorization','restorationRoot',()=>[ZeroHash]),/state/],
 ['short import',f=>corrupt(f,'ProvianRestorationAuthorization','ordinaryImportedBalance',v=>[v[0]-1n]),/state/],
 ['missing history',f=>corrupt(f,'ProvianRecoveryHistory','importedCount',v=>[v[0]-1n]),/state/],
 ['cursor reset',f=>corrupt(f,'ProvianRecourseKernel','nextFinalizedCursor',()=>[0]),/state/],
 ['extra import mint',f=>corrupt(f,'ProvianRecourseKernel','restoredBalance',v=>[v[0]+1n]),/state/],
 ['unheld successor',f=>corrupt(f,'ProvianRecourseKernel','administrativeHold',()=>[false]),/activation_state/],
 ['curve break mode',f=>corrupt(f,'ProvianRestorationAuthorization','cryptographicBreak',()=>[true]),/wrong_succession_mode/],
 ['settlement submitter',f=>corrupt(f,'ProvianMemberSettlement','submitter',()=>[ZeroAddress]),/binding/],
 ['bond backing',f=>corrupt(f,'ProvianRecourseKernel','balanceOf',()=>[0],[f.plan.addresses.ProvianRecourseBondPool]),/bond_backing/],
 ['extra monthly rule',f=>corrupt(f,'ProvianMemberRecoursePool','monthlyRuleCount',()=>[2]),/state/],
 ['old approver active',f=>corrupt(f,'oldVerifier','batchApprover',()=>[f.plan.admin]),/predecessor_verifier_not_retired/],
 ['runtime replacement',f=>{f.codes[f.plan.addresses.ProvianRecourseKernel]='0x6000';},/runtime_mismatch/],
 ['plan alteration',f=>{f.plan.submitter=ZeroAddress;},/plan_changed/],
 ['inventory alteration',f=>{f.institutions.seedBonds[0].amount='1';},/inventory_changed/],
 ['rule alteration',f=>{f.rule.rule.earningsBps+=1;},/rule_changed/],
 ['new scheduled epoch',f=>{const iface=new Interface(f.artifacts.ProvianRecourseKernel.abi);
  f.logs.push({address:f.plan.addresses.ProvianRecourseKernel,blockNumber:'0x'+f.block.number.toString(16),
   ...iface.encodeEventLog(iface.getEvent('TreasuryDestinationsScheduled'),[100,f.plan.admin,f.plan.admin])});},/unexpected_schedule/],
 ['unexpected schedule type',f=>{const iface=new Interface(f.artifacts.ProvianRecourseKernel.abi);
  f.logs.push({address:f.plan.addresses.ProvianRecourseKernel,blockNumber:'0x'+f.block.number.toString(16),
   ...iface.encodeEventLog(iface.getEvent('MintRateScheduled'),[Number(f.plan.snapshot.state.lastOpenedEpoch)+1,1])});},/unexpected_schedule/],
 ['institution future schedule',f=>{const iface=new Interface(f.artifacts.ProvianRecourseBondPool.abi);
  f.logs.push({address:f.plan.addresses.ProvianRecourseBondPool,blockNumber:'0x'+f.block.number.toString(16),
   ...iface.encodeEventLog(iface.getEvent('DepositFeeBpsScheduled'),[100,500])});},/unexpected_schedule/],
 ['reorg',f=>{f.blocks[f.block.number]=ZeroHash;},/block_invalid/],
];
for(const[label,mutate,error]of corruptions)test('refuses '+label,{skip:!fixturePath},async()=>{
 const f=fixture();mutate(f);await assert.rejects(verifySuccessorPlan(f),error);
});

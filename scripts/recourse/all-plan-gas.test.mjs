import {test,expect} from 'vitest';
import {successorFixture} from './successor-plan.test.mjs';
import {readFileSync} from 'node:fs';
import {Interface,sha256} from 'ethers';
import {GAS_PLAN_SOURCES,CREATION_FAMILIES,FIXED_CALL_FAMILIES,gasArtifactFingerprint,validateGasCertificate,assertGasStep,prepareAllPlanGas} from './all-plan-gas.mjs';
import {batchSuccessorImports} from './successor-plan.mjs';
import {importLeafBound,importGasUpper} from './import-gas-bound.mjs';
import {boundedGasEstimate} from './transaction-gas-limit.mjs';
const h='0x'+'11'.repeat(32),a='0x'+'11'.repeat(20);
function fixture(){
 const names=[...CREATION_FAMILIES,'ProvianPVT9','ProvianPVT9EligibilityVerifier'];
 const artifacts=Object.fromEntries(names.map(n=>[n,JSON.parse(readFileSync(new URL(`../../contracts/out/${n}.sol/${n}.json`,import.meta.url)))]));
 // Synthetic proof values exercise the refusal mechanism only; no gas claim.
 const certificate={schema:'provian.first-changeover-gas.v1',creations:Object.fromEntries(CREATION_FAMILIES.map(n=>[n,'1000000'])),
 calls:Object.fromEntries(FIXED_CALL_FAMILIES.map(n=>[n,'100000'])),publication:'1000000',publicationInner:'1000000',artifacts:Object.fromEntries(names.map(n=>[n,gasArtifactFingerprint(artifacts[n])])),
 sources:Object.fromEntries(GAS_PLAN_SOURCES.map(p=>[p,sha256(readFileSync(new URL('../../'+p,import.meta.url)))]))};
 const inputs={artifacts,callGas:'4000000',legacyTokens:[],executionLimits:{maxGas:'16777216'},pointerPlan:{pointer:a},rule:{},port:{blockHash:async()=>h}};
 return {inputs,certificate,proof:()=>validateGasCertificate(inputs,certificate)};
}
test.each(['missing','family','artifact','source','oversize','inner','targets'])('pre-retirement certificate rejects %s before any transaction',async mode=>{
 const f=fixture();
 if(mode==='missing')f.certificate.schema='unknown';
 if(mode==='family')delete f.certificate.calls[FIXED_CALL_FAMILIES[0]];
 if(mode==='artifact')f.inputs.artifacts.ProvianRecourseKernel.bytecode.object+='00';
 if(mode==='source')f.certificate.sources[GAS_PLAN_SOURCES[0]]=h;
 if(mode==='oversize')f.certificate.creations.ProvianRecourseKernel='16777216';
 if(mode==='inner')f.inputs.callGas='3999999';
 if(mode==='targets')f.inputs.legacyTokens=Array(22).fill(a);
 await expect(prepareAllPlanGas(f.inputs,{state:{verifier:a},steps:[],checkpoint:{number:1,hash:h}},{steps:[]},f.certificate)).rejects.toThrow();
});
test('saved proof binds canonical checkpoint and all future families',async()=>{
 const f=fixture(),retirement={state:{verifier:a},steps:[],checkpoint:{number:1,hash:h}};
 const proof=await prepareAllPlanGas(f.inputs,retirement,{steps:[]},f.certificate);
 expect(proof.coveredCreations).toEqual(CREATION_FAMILIES);expect(proof.coveredCalls).toEqual(FIXED_CALL_FAMILIES);
 f.inputs.port.blockHash=async()=> '0x'+'22'.repeat(32);
 await expect(prepareAllPlanGas(f.inputs,retirement,{steps:[]},f.certificate)).rejects.toThrow('checkpoint_changed');
});
test('unknown selector and noncanonical import bytes cannot enter a certified family',()=>{
 const f=fixture(),iface=new Interface(f.inputs.artifacts.ProvianRecoveryHistory.abi);
 const row={label:'ProvianRecoveryHistory:applyEconomicEntry',value:'0',to:a,data:iface.encodeFunctionData('state',[])};
 expect(()=>assertGasStep(row,f.inputs,f.proof())).toThrow('uncovered_call');
 row.data=iface.encodeFunctionData('applyEconomicEntry',[a,0])+'00';
 expect(()=>assertGasStep(row,f.inputs,f.proof())).toThrow('noncanonical_call');
});
test('canonical adaptive groups honor a lower approved maximum and preserve every leaf in order',()=>{
 const f=fixture(),art=f.inputs.artifacts,iface=new Interface(art.ProvianRecoveryHistory.abi),helper=new Interface(art.ProvianSuccessionImporter.abi);
 const imports=Array.from({length:100},(_,i)=>({label:'ProvianRecoveryHistory:importEntry',data:iface.encodeFunctionData('importEntry',[2,h,i,Array(14).fill(h)])}));
 const plan={imports,deployer:a,addresses:{ProvianSuccessionImporter:a}};
 const normal=batchSuccessorImports(plan,art,128),limited=batchSuccessorImports(plan,art,128,'14000000');
 expect(helper.decodeFunctionData('importHistory',limited[0].data)[0].length).toBeLessThan(helper.decodeFunctionData('importHistory',normal[0].data)[0].length);
 const decoded=limited.flatMap(row=>{
  const data=helper.decodeFunctionData('importHistory',row.data)[0].toArray();
  const leaves=data.map(data=>importLeafBound({data},art.ProvianRecoveryHistory));
  expect(boundedGasEstimate(importGasUpper(leaves,row.data),14000000n)).toBeLessThanOrEqual(14000000n);return data;
 });
 expect(decoded).toEqual(imports.map(row=>row.data));
 expect(()=>batchSuccessorImports(plan,art,128,100000n)).toThrow('single_import_exceeds_gas_cap');
});
test('oversize proof and variable economic record cannot claim a fixed import bound',()=>{
 const f=fixture(),art=f.inputs.artifacts.ProvianRecoveryHistory,iface=new Interface(art.abi);
 expect(()=>importLeafBound({data:iface.encodeFunctionData('importEntry',[0,h,1,Array(257).fill(h)])},art)).toThrow('proof_length');
 expect(()=>importLeafBound({data:iface.encodeFunctionData('importEconomicEntry',[0,'0x11',[]])},art)).toThrow('record_size');
});

test('all constructors emitted by the canonical successor planner satisfy the certified shapes',async()=>{
 const {buildSuccessorPlan}=await import('./successor-plan.mjs');
 const f=fixture(),source=successorFixture(),plan=buildSuccessorPlan(source);
 for(const row of plan.creations)expect(assertGasStep(row,f.inputs,f.proof())).toBeGreaterThan(0n);
 const row=plan.creations.find(row=>row.label==='deploy:ProvianMemberRecoursePool'),art=f.inputs.artifacts.ProvianMemberRecoursePool;
 const {AbiCoder}=await import('ethers'),iface=new Interface(art.abi);
 const args=AbiCoder.defaultAbiCoder().decode(iface.deploy.inputs,'0x'+row.data.slice(art.bytecode.object.length)).toArray(true);
 args[5][3]=1n;
 expect(()=>assertGasStep({...row,data:art.bytecode.object+iface.encodeDeploy(args).slice(2)},f.inputs,f.proof())).toThrow('unsupported_pool_snapshot');
});

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AbiCoder,Interface,ZeroAddress,sha256,toUtf8Bytes} from 'ethers';
import {buildSuccessorPlan,SUCCESSOR_CREATION_ORDER,batchSuccessorImports} from './successor-plan.mjs';
import {LEGACY_INSTITUTIONS} from './institution-snapshot.mjs';
import {balanceLeaf,merkle,verifyProof} from './snapshot.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
const digest=o=>sha256(toUtf8Bytes(JSON.stringify(o)));
export function successorFixture(){
 const artifacts={};for(const name of [...SUCCESSOR_CREATION_ORDER,'ProvianHashAccount'])
  artifacts[name]=JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`,import.meta.url)));
 const contracts=Object.fromEntries(Object.keys(LEGACY_INSTITUTIONS).map((key,i)=>[key,{address:addr(i+1)}]));
 const deployment={contracts,wiring:{pvt:addr(100),usdc:addr(101),admin:addr(102),feeWallet:addr(103),provianTechWallet:addr(103),executor:addr(102)}};
 const pointer=addr(200),rule={schema:'provian-recourse-membership/v1',chainId:8453,pointer,firstMonth:0,
  participationBurnAtomic:'100000000000000000000',noEarningsContributionAtomic:'100000000000000000000',earningsBps:100};
 const signed={rule,ruleHash:sha256(toUtf8Bytes('Provian Recourse Pool membership rule\n'+JSON.stringify(rule)+'\n'))};
 const initial=[{previousOwner:addr(111),destination:addr(111),amount:'700'},
  {previousOwner:contracts.bondPool.address,destination:addr(300),amount:'500'}];
 const tree=merkle(initial.map(r=>balanceLeaf(addr(100),20,r.previousOwner,r.destination,r.amount)));
 // ABI-shaped empty historical state isolates assembly from exporter economics;
 // the exporter has its own populated monetary-history verification suite.
 const value=p=>p.baseType==='tuple'?Object.fromEntries(p.components.map(c=>[c.name,value(c)])):
  p.baseType==='array'?[]:p.type==='address'?ZeroAddress:p.type==='bool'?false:p.type==='bytes32'?hash(0):'0';
 const historyIface=new Interface(artifacts.ProvianRecoveryHistory.abi),state=value(historyIface.deploy.inputs[4]);
 state.administrativeHold=true;
 const snapshot={format:'provian-succession-snapshot',mode:'ordinary',chainId:8453,predecessor:addr(100),block:20,blockHash:hash(20),supply:'1200',
  balanceRoot:tree.root,historyRoot:hash(22),historyCount:1,state,
  balances:initial.map((r,i)=>({...r,proof:tree.proofs[i]})),history:[{type:'entry',kind:0,key:hash(7),value:'1',proof:[]}]};
 const institutions={schema:'provian.institution-snapshot.v1',block:20,blockHash:hash(20),
  inventory:Object.entries(LEGACY_INSTITUTIONS).map(([key,name])=>({key,name,address:contracts[key].address})),
  seedEscrows:[],seedBonds:[],seedBps:[]};institutions.digest=digest(institutions);
 return {snapshot,institutions,deployment,artifacts,pointerPlan:{pointer,authority:addr(201)},rule:signed,
  deployer:addr(202),nonce:3,identityAttestor:addr(203),submitter:addr(204),batchApprover:addr(205)};
}
test('creation plan preserves owner balances and history while moving custody only to predicted successors',()=>{
 const f=successorFixture(),plan=buildSuccessorPlan(f);
 assert.equal(plan.creations.length,12);assert.equal(plan.imports.length,2);
 assert.ok(plan.imports.every(row=>row.label==='ProvianRestorationAuthorization:importBalance'));
 assert.throws(()=>batchSuccessorImports({...plan,imports:[{label:'ProvianRecoveryHistory:importEntry'}]},f.artifacts),/unknown_import_family/);
 const historyCreation=plan.creations.find(row=>row.label==='deploy:ProvianRecoveryHistory');
 const historyArtifact=f.artifacts.ProvianRecoveryHistory;
 const historyArgs=AbiCoder.defaultAbiCoder().decode(new Interface(historyArtifact.abi).deploy.inputs,'0x'+historyCreation.data.slice(historyArtifact.bytecode.object.length));
 assert.equal(historyArgs[5],true);assert.equal(historyArgs[2],f.snapshot.historyRoot);assert.equal(historyArgs[3],1n);
 assert.equal(plan.configuration.length,7);assert.ok(plan.configuration.every(c=>c.from===addr(102)));
 assert.equal(plan.activation.label,'ProvianRecourseKernel:resumeFromAdministrativeHold');
 assert.equal(plan.snapshot.balances[0].destination,addr(111));
 assert.equal(plan.snapshot.balances[1].destination,plan.addresses.ProvianRecourseBondPool);
 assert.equal(plan.snapshot.supply,'1200');assert.deepEqual(plan.snapshot.history,f.snapshot.history);
 for(const r of plan.snapshot.balances)assert.ok(verifyProof(r.leaf,r.proof,plan.snapshot.balanceRoot));
 const auth=new Interface(f.artifacts.ProvianRestorationAuthorization.abi);
 const creation=plan.creations.find(c=>c.label==='deploy:ProvianRestorationAuthorization');
 const args=auth.decodeFunctionData('importBalance',plan.imports[0].data);
 assert.equal(args[1].toLowerCase(),addr(111));assert.equal(args[2],700n);
 assert.equal(creation.nonce,5);
 assert.ok(plan.creations.every(c=>c.value==='0'));assert.equal(plan.pointer,f.pointerPlan.pointer);
 const batches=batchSuccessorImports(plan,f.artifacts),helper=new Interface(f.artifacts.ProvianSuccessionImporter.abi);
 assert.equal(batches.length,1);
 assert.deepEqual(helper.decodeFunctionData('importBalances',batches[0].data)[0].toArray(),plan.imports.map(r=>r.data));
 assert.deepEqual(plan.retireAfterImport,[plan.addresses.ProvianSuccessionImporter]);
 assert.throws(()=>batchSuccessorImports(plan,f.artifacts,0),/import_batch_size/);
});
test('altered ownership, omitted balances, inventory drift, wrong rule and authority conflation refuse',()=>{
 const changes=[f=>{f.snapshot.balances[0].previousOwner=addr(999);},f=>{f.snapshot.balances.pop();},
  f=>{f.snapshot.balances.push(f.snapshot.balances[0]);},f=>{f.institutions.block=21;},
  f=>{f.institutions.seedBps.push({param:1,bps:'99'});},f=>{f.rule.rule.earningsBps=200;},
  f=>{f.rule.rule.pointer=addr(999);},f=>{f.identityAttestor=f.deployment.wiring.admin;},
  f=>{f.snapshot.mode='cryptographic-break';},f=>{f.snapshot.state.administrativeHold=false;}];
 for(const change of changes){const f=successorFixture();change(f);assert.throws(()=>buildSuccessorPlan(f),/successor_plan_/);}
});

test('non-null beneficiary verification is installed before arming',()=>{
 const f=successorFixture();f.snapshot.state.beneficiaryVerifier={verifier:addr(900),configurationId:hash(901),version:'1'};
 const p=buildSuccessorPlan(f),last=p.configuration.slice(-2);
 assert.equal(last[0].label,'ProvianRecourseKernel:installRecoveredBeneficiaryVerifier');
 assert.equal(last[1].label,'ProvianRecourseKernel:armEpochZero');
});

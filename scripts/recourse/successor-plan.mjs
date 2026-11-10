import {Interface,getCreateAddress,keccak256,ZeroAddress,ZeroHash,sha256,toUtf8Bytes} from 'ethers';
import {balanceLeaf,merkle,verifyProof} from './snapshot.mjs';
import {LEGACY_INSTITUTIONS} from './institution-snapshot.mjs';
const ensure=(v,code)=>{if(!v)throw Error('successor_plan_'+code);};
const address=value=>{ensure(typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value)&&value!==ZeroAddress,'address_invalid');return value.toLowerCase();};
const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
export const SUCCESSOR_CREATION_ORDER=Object.freeze(['ProvianOwnershipRegistry','ProvianRecoveryHistory','ProvianRestorationAuthorization',
 'ProvianRecourseKernel','ProvianRecourseEligibilityVerifier','ProvianRecourseEscrow','ProvianPromiseV3',
 'ProvianRecourseProjectPool','ProvianRecourseBondPool','ProvianRecourseCourt','ProvianMemberRecoursePool','ProvianSuccessionImporter']);
const successorNames={escrowV4:'ProvianRecourseEscrow',promiseV3:'ProvianPromiseV3',poolV3:'ProvianRecourseProjectPool',
 bondPool:'ProvianRecourseBondPool',courtV2:'ProvianRecourseCourt'};

/** Re-root only the five institution destinations. Human/agent holdings always
 * carry to the same address; no operator-supplied alternative recipient exists. */
export function remapSuccessionBalances(snapshot,destinations){
 let total=0n;const seen=new Set();
 const balances=snapshot.balances.map(row=>{
  const previousOwner=address(row.previousOwner);
  ensure(!seen.has(previousOwner),'duplicate_holder');seen.add(previousOwner);
  ensure(typeof row.amount==='string'&&/^[1-9][0-9]*$/.test(row.amount),'amount_invalid');
  ensure(verifyProof(balanceLeaf(snapshot.predecessor,snapshot.block,row.previousOwner,row.destination,row.amount),
    row.proof,snapshot.balanceRoot),'balance_proof');
  total+=BigInt(row.amount);
  const destination=destinations[previousOwner]??previousOwner;
  return {...row,previousOwner,destination,leaf:balanceLeaf(snapshot.predecessor,snapshot.block,previousOwner,destination,row.amount)};
 });
 ensure(total===BigInt(snapshot.supply),'supply_mismatch');
 const tree=merkle(balances.map(row=>row.leaf));
 return {...snapshot,balanceRoot:tree.root,balances:balances.map((row,i)=>({...row,proof:tree.proofs[i]}))};
}

/** Assemble reviewable, unsigned first-changeover creation/import calls.
 * A runner must verify the signed rule and inventories, acquire its durable
 * signer lease, and revalidate the nonce and chain before using this plan.
 * This module neither reads a key nor connects to a provider. */
export function buildSuccessorPlan({snapshot,institutions,deployment,artifacts,pointerPlan,rule,
 deployer,nonce,identityAttestor,submitter,batchApprover}){
 deployer=address(deployer);identityAttestor=address(identityAttestor);submitter=address(submitter);batchApprover=address(batchApprover);
 const admin=address(deployment.wiring.admin),pointer=address(pointerPlan.pointer);
 ensure(identityAttestor!==admin,'attestor_is_authority');
 ensure(Number.isSafeInteger(nonce)&&nonce>=0,'nonce_invalid');
 ensure(snapshot.format==='provian-succession-snapshot'&&snapshot.mode==='ordinary'&&snapshot.chainId===8453
   &&snapshot.state.administrativeHold===true,'snapshot_mode');
 ensure(snapshot.predecessor.toLowerCase()===deployment.wiring.pvt.toLowerCase(),'predecessor_mismatch');
 ensure(institutions.block===snapshot.block&&institutions.blockHash===snapshot.blockHash,'inventory_cutoff');
 ensure(institutions.inventory.length===5&&new Set(institutions.inventory.map(r=>r.key)).size===5,'inventory_incomplete');
 const inventoryBody={...institutions};delete inventoryBody.digest;
 ensure(sha256(toUtf8Bytes(stringify(inventoryBody)))===institutions.digest,'inventory_changed');
 ensure(rule.rule.pointer===pointer&&rule.rule.chainId===8453&&rule.rule.firstMonth===0,'membership_domain');
 const signingBytes='Provian Recourse Pool membership rule\n'+JSON.stringify(rule.rule)+'\n';
 ensure(sha256(toUtf8Bytes(signingBytes))===rule.ruleHash,'membership_changed');
 const addresses=Object.fromEntries(SUCCESSOR_CREATION_ORDER.map((name,i)=>[name,getCreateAddress({from:deployer,nonce:nonce+i}).toLowerCase()]));
 const destinations={};
 for(const[key,name]of Object.entries(LEGACY_INSTITUTIONS)){
  const old=address(deployment.contracts[key].address),row=institutions.inventory.find(r=>r.key===key);
  ensure(row&&row.name===name&&row.address===old,'inventory_address');
  destinations[old]=addresses[successorNames[key]];
 }
 const carried=remapSuccessionBalances(snapshot,destinations),a=addresses,kernel=a.ProvianRecourseKernel,state=carried.state;
 const params={
  ProvianOwnershipRegistry:[pointer,identityAttestor,false],
  ProvianRecoveryHistory:[carried.predecessor,carried.block,carried.historyRoot,carried.historyCount,state],
  ProvianRestorationAuthorization:[kernel,carried.balanceRoot,carried.predecessor,carried.block,false,
    keccak256(artifacts.ProvianHashAccount.deployedBytecode.object),0],
  ProvianRecourseKernel:[{authority:admin,root:carried.balanceRoot,previousKernel:carried.predecessor,snapshotBlock:carried.block,
    snapshotTotal:carried.supply,history:a.ProvianRecoveryHistory,pointer,registry:a.ProvianOwnershipRegistry,
    afterCryptographicBreak:false,authorization:a.ProvianRestorationAuthorization}],
  ProvianRecourseEligibilityVerifier:[kernel,state.eligibilityVerifier.configurationId,state.eligibilityVerifier.version],
  ProvianRecourseEscrow:[admin,deployment.wiring.feeWallet,deployment.wiring.usdc,kernel,kernel,kernel,institutions.seedEscrows],
  ProvianPromiseV3:[admin,deployment.wiring.feeWallet,deployment.wiring.usdc,kernel,kernel],
  ProvianRecourseProjectPool:[admin,deployment.wiring.feeWallet,deployment.wiring.usdc,kernel,kernel],
  ProvianRecourseBondPool:[admin,deployment.wiring.provianTechWallet,kernel,kernel,kernel,institutions.seedBonds,institutions.seedBps],
  ProvianRecourseCourt:[admin,a.ProvianRecourseEscrow,kernel,kernel,kernel],
  ProvianMemberRecoursePool:[kernel,a.ProvianOwnershipRegistry,submitter,pointer,
    [0,rule.rule.participationBurnAtomic,rule.rule.noEarningsContributionAtomic,rule.rule.earningsBps,rule.ruleHash],
    [ZeroAddress,0,ZeroHash,0,false]],
  ProvianSuccessionImporter:[a.ProvianRecoveryHistory,a.ProvianRestorationAuthorization],
 };
 const creations=SUCCESSOR_CREATION_ORDER.map((name,i)=>{
  const compiled=artifacts[name];ensure(compiled&&/^0x[0-9a-f]+$/i.test(compiled.bytecode.object),'artifact_missing');
  const data=compiled.bytecode.object+new Interface(compiled.abi).encodeDeploy(params[name]).slice(2);
  ensure((data.length-2)/2<=49152,'initcode_too_large');
  return {label:'deploy:'+name,from:deployer,nonce:nonce+i,address:a[name],data,value:'0'};
 });
 const calls=[];
 const operation=(name,method,args,from=deployer)=>({label:name+':'+method,from,to:a[name],value:'0',
   data:new Interface(artifacts[name].abi).encodeFunctionData(method,args)});
 const call=(name,method,args)=>calls.push(operation(name,method,args));
 for(const row of carried.history)call('ProvianRecoveryHistory',row.type==='batch'?'importBatch':'importEntry',
   row.type==='batch'?[row.key,row.record,row.proof]:[row.kind,row.key,row.value,row.proof]);
 for(const row of carried.balances)call('ProvianRestorationAuthorization','importBalance',[row.previousOwner,row.destination,row.amount,row.proof]);
 const settlement=getCreateAddress({from:a.ProvianMemberRecoursePool,nonce:1}).toLowerCase();
 const configuration=[
  operation('ProvianRecourseEscrow','setCourtContract',[a.ProvianRecourseCourt],admin),
  operation('ProvianRecourseBondPool','setCourtContract',[a.ProvianRecourseCourt],admin),
  operation('ProvianRecourseBondPool','setExecutor',[deployment.wiring.executor],admin),
  operation('ProvianRecourseCourt','setBondPool',[a.ProvianRecourseBondPool],admin),
  operation('ProvianRecourseEligibilityVerifier','appointBatchApprover',[batchApprover],admin),
  operation('ProvianRecourseKernel','appointOperationalMinter',[settlement],admin),
  ...(state.beneficiaryVerifier.verifier.toLowerCase()===ZeroAddress?[]:[
   operation('ProvianRecourseKernel','installRecoveredBeneficiaryVerifier',[state.beneficiaryVerifier],admin)]),
  operation('ProvianRecourseKernel','armEpochZero',[{
    epochZeroStartsAt:state.epochZeroStartsAt,genesisStartsAt:state.genesisStartsAt,genesisEndsAt:state.genesisEndsAt,
    initialMintRate:state.mintRate,provianTreasury:state.provianTreasury,foundationTreasury:state.foundationTreasury,
    eligibilityVerifier:{...state.eligibilityVerifier,verifier:a.ProvianRecourseEligibilityVerifier},
    initialFinalizedCursor:state.nextCursor,combinedCapMode:1,genesisCap:state.genesisCap,fixedCombinedCap:state.combinedCap,
  }],admin),
 ];
 // Publication is a separate hash-authority operation after these creations,
 // imports and complete state reconciliation. No ready-to-sign pointer call is
 // produced before its independently checked component runtimes exist.
 const components=[kernel,a.ProvianRecourseEligibilityVerifier,state.beneficiaryVerifier.verifier,a.ProvianRecourseEscrow,
  a.ProvianPromiseV3,a.ProvianRecourseProjectPool,a.ProvianRecourseBondPool,a.ProvianRecourseCourt,a.ProvianMemberRecoursePool,settlement];
 const plan={schema:'provian.successor-plan.v1',chainId:8453,predecessor:carried.predecessor,cutoff:{number:carried.block,hash:carried.blockHash},
  deployer,nonce,admin,identityAttestor,submitter,batchApprover,pointer,pointerAuthority:pointerPlan.authority,
  ruleHash:rule.ruleHash,institutionDigest:institutions.digest,addresses,components,creations,imports:calls,configuration,
  retireAfterImport:[a.ProvianSuccessionImporter],
  activation:operation('ProvianRecourseKernel','resumeFromAdministrativeHold',[],admin),snapshot:carried};
 return {...plan,digest:sha256(toUtf8Bytes(stringify(plan)))};
}

/** Transport grouping only: the exact original proof calls remain the source.
 * The runner may reduce batch size after a gas estimate, without changing any
 * leaf, destination, amount or proof. Completed leaves are idempotently skipped
 * by the importer, including a permissionless caller winning the same race. */
export function batchSuccessorImports(plan,importerAbi,batchSize=128){
 ensure(Number.isSafeInteger(batchSize)&&batchSize>=1&&batchSize<=128,'import_batch_size');
 const iface=new Interface(importerAbi),batches=[];
 for(const [label,method]of [['ProvianRecoveryHistory:','importHistory'],['ProvianRestorationAuthorization:','importBalances']]){
  const rows=plan.imports.filter(row=>row.label.startsWith(label));
  for(let start=0;start<rows.length;start+=batchSize)batches.push({label:method+':'+start,from:plan.deployer,
   to:plan.addresses.ProvianSuccessionImporter,value:'0',data:iface.encodeFunctionData(method,[rows.slice(start,start+batchSize).map(row=>row.data)])});
 }
 ensure(batches.length>0,'empty_import_population');return batches;
}

import {AbiCoder,Interface,getCreateAddress,keccak256,ZeroAddress,ZeroHash,sha256,toUtf8Bytes} from 'ethers';
import {balanceLeaf,merkle,verifyProof} from './snapshot.mjs';
import {importLeafBound,importGasUpper,importGroupFits} from './import-gas-bound.mjs';
import {LEGACY_INSTITUTIONS} from './institution-snapshot.mjs';
const ensure=(v,code)=>{if(!v)throw Error('successor_plan_'+code);};
const address=value=>{ensure(typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value)&&value!==ZeroAddress,'address_invalid');return value.toLowerCase();};
const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
export const SUCCESSOR_CREATION_ORDER=Object.freeze(['ProvianOwnershipRegistry','ProvianRecoveryHistory','ProvianRestorationAuthorization',
 'ProvianRecourseKernel','ProvianRecourseEligibilityVerifier','ProvianRecourseEscrow','ProvianPromiseV3',
 'ProvianRecourseProjectPool','ProvianRecourseBondPool','ProvianRecourseCourt','ProvianMemberRecoursePool','ProvianSuccessionImporter']);
const successorNames={escrowV4:'ProvianRecourseEscrow',promiseV3:'ProvianPromiseV3',poolV3:'ProvianRecourseProjectPool',
 bondPool:'ProvianRecourseBondPool',courtV2:'ProvianRecourseCourt'};

export function successorLocations(deployment,deployer,nonce){
 deployer=address(deployer);
 ensure(Number.isSafeInteger(nonce)&&nonce>=0,'nonce_invalid');
 const addresses=Object.fromEntries(SUCCESSOR_CREATION_ORDER.map((name,i)=>[name,getCreateAddress({from:deployer,nonce:nonce+i}).toLowerCase()]));
 const destinations=Object.fromEntries(Object.keys(LEGACY_INSTITUTIONS).map(key=>[
  address(deployment.contracts[key].address),addresses[successorNames[key]]]));
 return {addresses,destinations};
}

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

/** Snapshot leaves bind the exact successor token, predecessor, canonical
 * cutoff and institution kind. Import size is independent of inventory size. */
export function custodySeedPlan({kernel,predecessor,block,blockHash,kind,seeds}) {
 const abi=AbiCoder.defaultAbiCoder();
 const domain=sha256(abi.encode(['string','uint256','address','uint8','address','uint256','bytes32'],
  ['Provian custody snapshot',8453,kernel,kind,predecessor,block,blockHash]));
 const tuple=kind===1?'tuple(bytes32 escrowId,address depositor,address recipient,uint256 amount,uint256 fee,uint256 autoReleaseAt,uint8 currency)':
  'tuple(address agent,uint256 amount,uint8 autonomyLevel,uint256 createdAt,uint256 lastRenewalAt,uint256 renewalDeadline,uint256 requiredAtPost)';
 const rows=seeds.map((seed,index)=>{const data=abi.encode([tuple],[seed]);return {index,data,
  leaf:sha256(abi.encode(['bytes32','uint256','bytes32'],[domain,index,sha256(data)]))};});
 const tree=merkle(rows.map(row=>row.leaf));
 return {domain,manifest:{predecessor,cutoffBlock:block,cutoffHash:blockHash,root:rows.length?tree.root:ZeroHash,
  count:rows.length,total:seeds.reduce((total,seed)=>total+BigInt(seed.amount),0n).toString()},
  rows:rows.map((row,index)=>({...row,proof:tree.proofs[index]}))};
}

/** Economic history grows indefinitely. Only scalar state enters creation;
 * authenticated historical epochs and future schedules enter one at a time. */
export function economicSeedPlan({state,predecessor,block,artifact}) {
 const abi=AbiCoder.defaultAbiCoder(),type=new Interface(artifact.abi).deploy.inputs[4];
 const epochs=type.components.find(p=>p.name==='epochs').arrayChildren;
 const schedules=type.components.find(p=>p.name==='schedules').arrayChildren;
 const records=[...state.epochs.map(value=>abi.encode([epochs],[value])),...state.schedules.map(value=>abi.encode([schedules],[value]))];
 const rows=records.map((data,index)=>({index,data,leaf:sha256(abi.encode(['string','address','uint256','uint256','bytes32'],
  ['Provian economic history',predecessor,block,index,sha256(data)]))}));
 const tree=merkle(rows.map(row=>row.leaf)),economicRoot=rows.length?tree.root:ZeroHash;
 return {state:{...state,epochs:[],schedules:[],economicRoot,economicCount:rows.length},
  rows:rows.map((row,index)=>({...row,proof:tree.proofs[index]}))};
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
 const {addresses,destinations}=successorLocations(deployment,deployer,nonce);
 for(const[key,name]of Object.entries(LEGACY_INSTITUTIONS)){
  const old=address(deployment.contracts[key].address),row=institutions.inventory.find(r=>r.key===key);
  ensure(row&&row.name===name&&row.address===old,'inventory_address');
 }
 const carried=remapSuccessionBalances(snapshot,destinations),a=addresses,kernel=a.ProvianRecourseKernel,state=carried.state;
 const economicSeeds=economicSeedPlan({state,predecessor:carried.predecessor,block:carried.block,artifact:artifacts.ProvianRecoveryHistory});
 const custodySeeds=Object.fromEntries([
  ['ProvianRecourseEscrow',1,'escrowV4',institutions.seedEscrows],
  ['ProvianRecourseBondPool',2,'bondPool',institutions.seedBonds],
 ].map(([name,kind,key,seeds])=>[name,custodySeedPlan({kernel,predecessor:deployment.contracts[key].address,
  block:carried.block,blockHash:carried.blockHash,kind,seeds})]));
 const params={
  ProvianOwnershipRegistry:[pointer,identityAttestor,false],
  ProvianRecoveryHistory:[carried.predecessor,carried.block,carried.historyRoot,carried.historyCount,economicSeeds.state],
  ProvianRestorationAuthorization:[kernel,carried.balanceRoot,carried.predecessor,carried.block,false,
    keccak256(artifacts.ProvianHashAccount.deployedBytecode.object),0],
  ProvianRecourseKernel:[{authority:admin,root:carried.balanceRoot,previousKernel:carried.predecessor,snapshotBlock:carried.block,
    snapshotTotal:carried.supply,history:a.ProvianRecoveryHistory,pointer,registry:a.ProvianOwnershipRegistry,
    afterCryptographicBreak:false,authorization:a.ProvianRestorationAuthorization}],
  ProvianRecourseEligibilityVerifier:[kernel,state.eligibilityVerifier.configurationId,state.eligibilityVerifier.version],
  ProvianRecourseEscrow:[admin,deployment.wiring.feeWallet,deployment.wiring.usdc,kernel,kernel,kernel,custodySeeds.ProvianRecourseEscrow.manifest],
  ProvianPromiseV3:[admin,deployment.wiring.feeWallet,deployment.wiring.usdc,kernel,kernel],
  ProvianRecourseProjectPool:[admin,deployment.wiring.feeWallet,deployment.wiring.usdc,kernel,kernel],
  ProvianRecourseBondPool:[admin,deployment.wiring.provianTechWallet,kernel,kernel,kernel,custodySeeds.ProvianRecourseBondPool.manifest,institutions.seedBps],
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
 const economicImports=economicSeeds.rows.flatMap(row=>[
  operation('ProvianRecoveryHistory','importEconomicEntry',[row.index,row.data,row.proof]),
  operation('ProvianRecoveryHistory','applyEconomicEntry',[kernel,row.index])]);
 const custodyImports=Object.entries(custodySeeds).flatMap(([name,seedPlan])=>seedPlan.rows.map(row=>
  operation(name,'importCustodySeed',[row.index,row.data,row.proof])));
 const settlement=getCreateAddress({from:a.ProvianMemberRecoursePool,nonce:2}).toLowerCase();
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
  ruleHash:rule.ruleHash,institutionDigest:institutions.digest,addresses,components,creations,imports:calls,economicSeeds,economicImports,custodySeeds,custodyImports,configuration,
  retireAfterImport:[a.ProvianSuccessionImporter],
  activation:operation('ProvianRecourseKernel','resumeFromAdministrativeHold',[],admin),snapshot:{...carried,deployedHistoryState:{...state,economicRoot:economicSeeds.state.economicRoot,economicCount:economicSeeds.state.economicCount}}};
 return {...plan,digest:sha256(toUtf8Bytes(stringify(plan)))};
}

/** Transport grouping only: the exact original proof calls remain the source.
 * The runner may reduce batch size after a gas estimate, without changing any
 * leaf, destination, amount or proof. Completed leaves are idempotently skipped
 * by the importer, including a permissionless caller winning the same race. */
export function batchSuccessorImports(plan,artifacts,batchSize=128,maximum){
 if(maximum!==undefined)maximum=BigInt(maximum);
 ensure(Number.isSafeInteger(batchSize)&&batchSize>=1&&batchSize<=128,'import_batch_size');
 ensure(plan.imports.every(row=>row.label.startsWith('ProvianRecoveryHistory:')||row.label.startsWith('ProvianRestorationAuthorization:')),'unknown_import_family');
 const iface=new Interface(artifacts.ProvianSuccessionImporter.abi),batches=[];
 for(const [label,method]of [['ProvianRecoveryHistory:','importHistory'],['ProvianRestorationAuthorization:','importBalances']]){
  const rows=plan.imports.filter(row=>row.label.startsWith(label));
  for(let start=0;start<rows.length;){
   let end=start,accepted=null;
   const leaves=[];
   while(end<rows.length&&end-start<batchSize){
    const candidate=[...leaves,importLeafBound(rows[end],artifacts[label.slice(0,-1)])];
    const data=iface.encodeFunctionData(method,[rows.slice(start,end+1).map(row=>row.data)]);
    if(!importGroupFits(importGasUpper(candidate,data),maximum))break;
    leaves.push(candidate[candidate.length-1]);accepted=data;++end;
   }
   ensure(accepted&&end>start,'single_import_exceeds_gas_cap');
   batches.push({label:method+':'+start,from:plan.deployer,to:plan.addresses.ProvianSuccessionImporter,value:'0',data:accepted});
   start=end;
  }
 }
 ensure(batches.length>0,'empty_import_population');return batches;
}

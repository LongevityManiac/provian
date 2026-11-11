import {Interface,keccak256,ZeroAddress,ZeroHash,sha256,toUtf8Bytes} from 'ethers';
import {verifyInstitutionRuntime} from './institution-snapshot.mjs';
const ensure=(v,c)=>{if(!v)throw Error('successor_verify_'+c);};
const lower=v=>String(v).toLowerCase();
/** Pre-publication reconciliation at one independently verified finalized
 * block. It grants no signing authority and publishes no pointer revision. */
export async function verifySuccessorPlan({plan,institutions,rule,artifacts,port,block}){
 const body={...plan};delete body.digest;
 ensure(sha256(toUtf8Bytes(JSON.stringify(body)))===plan.digest,'plan_changed');
 ensure(plan.creations.length===12&&plan.snapshot.balances.length>0&&Number(plan.snapshot.historyCount)>0,'empty_population');
 ensure(block.number>=plan.cutoff.number&&await port.blockHash(block.number)===block.hash,'block_invalid');
 const inventoryBody={...institutions};delete inventoryBody.digest;
 ensure(sha256(toUtf8Bytes(JSON.stringify(inventoryBody)))===plan.institutionDigest,'inventory_changed');
 ensure(rule.ruleHash===plan.ruleHash&&sha256(toUtf8Bytes('Provian Recourse Pool membership rule\n'+JSON.stringify(rule.rule)+'\n'))===rule.ruleHash,'rule_changed');
 const a={...plan.addresses,ProvianMemberSettlement:plan.components[9],ProvianProtocolPointer:plan.pointer},state=plan.snapshot.state;
 const read=async(name,method,args=[])=>{
  const iface=new Interface(artifacts[name].abi);
  return iface.decodeFunctionResult(method,await port.call(a[name],iface.encodeFunctionData(method,args),block.hash));
 };
 const scalar=async(name,method,args=[])=>(await read(name,method,args))[0];
 for(const creation of plan.creations){
  const name=creation.label.slice('deploy:'.length),runtime=await port.code(creation.address,block.hash);
  verifyInstitutionRuntime(artifacts[name],runtime);
 }
 verifyInstitutionRuntime(artifacts.ProvianProtocolPointer,await port.code(plan.pointer,block.hash));
 const bindings={
  ProvianProtocolPointer:{authority:plan.pointerAuthority},
  ProvianOwnershipRegistry:{pointer:plan.pointer,identityAttestor:plan.identityAttestor,previousRegistry:ZeroAddress},
  ProvianRecoveryHistory:{predecessor:plan.predecessor},
  ProvianRestorationAuthorization:{kernel:a.ProvianRecourseKernel,predecessor:plan.predecessor,previousAuthorization:ZeroAddress},
  ProvianRecourseKernel:{BOOTSTRAP_ADMIN:plan.admin,restorationAuthority:plan.admin,predecessorHistory:a.ProvianRecoveryHistory,
   ownerAuthorization:a.ProvianRestorationAuthorization,protocolPointer:plan.pointer,registryOperator:a.ProvianOwnershipRegistry,
   operationalMinter:plan.components[9]},
  ProvianRecourseEligibilityVerifier:{KERNEL:a.ProvianRecourseKernel,batchApprover:plan.batchApprover,BOOTSTRAP_ADMIN:plan.admin},
  ProvianMemberRecoursePool:{token:a.ProvianRecourseKernel,pointer:plan.pointer,registryOperator:a.ProvianOwnershipRegistry,
   bootstrapAdmin:plan.admin,settlement:plan.components[9]},
  ProvianMemberSettlement:{kernel:a.ProvianRecourseKernel,pointer:plan.pointer,submitter:plan.submitter,pool:a.ProvianMemberRecoursePool},
  ProvianSuccessionImporter:{history:a.ProvianRecoveryHistory,authorization:a.ProvianRestorationAuthorization},
 };
 for(const[name,expected]of Object.entries(bindings))for(const[method,value]of Object.entries(expected))
  ensure(lower(await scalar(name,method))===lower(value),`binding:${name}:${method}`);
 for(const[name,method,expected]of [
  ['ProvianProtocolPointer','revision',0],
  ['ProvianRestorationAuthorization','pendingBreakAmount',0],
  ['ProvianRestorationAuthorization','hashAccountCodeHash',keccak256(artifacts.ProvianHashAccount.deployedBytecode.object)],
  ['ProvianRecoveryHistory','root',plan.snapshot.historyRoot],['ProvianRecoveryHistory','entryCount',plan.snapshot.historyCount],
  ['ProvianRecoveryHistory','importedCount',plan.snapshot.historyCount],['ProvianRecoveryHistory','lastGoodBlock',plan.cutoff.number],
  ['ProvianRestorationAuthorization','restorationRoot',plan.snapshot.balanceRoot],
  ['ProvianRestorationAuthorization','ordinaryImportedBalance',plan.snapshot.supply],
  ['ProvianRestorationAuthorization','lastGoodBlock',plan.cutoff.number],
  ['ProvianRecourseKernel','snapshotBalance',plan.snapshot.supply],
  ['ProvianRecourseKernel','restoredBalance',plan.snapshot.supply],
  ['ProvianRecourseEligibilityVerifier','CONFIGURATION_ID',state.eligibilityVerifier.configurationId],
  ['ProvianRecourseEligibilityVerifier','CONFIGURATION_VERSION',state.eligibilityVerifier.version],
  ['ProvianRecourseKernel','epochZeroStartsAt',state.epochZeroStartsAt],
  ['ProvianRecourseKernel','genesisStartsAt',state.genesisStartsAt],['ProvianRecourseKernel','genesisEndsAt',state.genesisEndsAt],
  ['ProvianRecourseKernel','genesisAdmissionCutoff',state.genesisCutoff],
  ['ProvianRecourseKernel','lastOpenedEpoch',state.lastOpenedEpoch],['ProvianRecourseKernel','nextFinalizedCursor',state.nextCursor],
 ])ensure(String(await scalar(name,method))===String(expected),`state:${name}:${method}`);
 ensure(await scalar('ProvianRecoveryHistory','complete')===true&&await scalar('ProvianRestorationAuthorization','successionReady')===true,'imports_incomplete');
 ensure(await scalar('ProvianRecourseKernel','epochZeroArmed')===true&&await scalar('ProvianRecourseKernel','administrativeHold')===true,'activation_state');
 ensure(await scalar('ProvianRecourseKernel','genesisAdmissionClosed')===state.genesisClosed,'genesis_state');
 ensure(await scalar('ProvianRestorationAuthorization','cryptographicBreak')===false
  &&await scalar('ProvianOwnershipRegistry','afterCryptographicBreak')===false
  &&await scalar('ProvianRecoveryHistory','afterCryptographicBreak')===false,'wrong_succession_mode');
 ensure(await scalar('ProvianRecourseEligibilityVerifier','administrativeHold')===false,'verifier_held');
 verifyInstitutionRuntime(artifacts.ProvianMemberSettlement,await port.code(a.ProvianMemberSettlement,block.hash));
 const exact=async(name,method,args,values)=>{
  const iface=new Interface(artifacts[name].abi),actual=await read(name,method,args);
  ensure(iface.encodeFunctionResult(method,actual)===iface.encodeFunctionResult(method,values),`state:${name}:${method}`);
 };
 await exact('ProvianRecoveryHistory','state',[],[state]);
 // Earlier epochs retain their historical settlement hashes. The armed current
 // epoch changes only its verifier and kernel-domain hash, never economics.
 for(const epoch of state.epochs){
  const current=String(epoch.policy.epoch)===String(state.lastOpenedEpoch);
  const got=(await read('ProvianRecourseKernel','getEpochPolicy',[epoch.policy.epoch]))[0];
  const expected={...epoch.policy};
  if(current){expected.eligibilityVerifier={...state.eligibilityVerifier,verifier:a.ProvianRecourseEligibilityVerifier};
   ensure(got.policyHash!==ZeroHash,'current_policy_hash');expected.policyHash=got.policyHash;}
  await exact('ProvianRecourseKernel','getEpochPolicy',[epoch.policy.epoch],[expected]);
  await exact('ProvianRecourseKernel','epochGenesisIssued',[epoch.policy.epoch],[epoch.genesisIssued]);
  await exact('ProvianRecourseKernel','epochTotalIssued',[epoch.policy.epoch],[epoch.totalIssued]);
 }
 const current=(await read('ProvianRecourseKernel','getEpochPolicy',[state.lastOpenedEpoch]))[0];
 const expectedCurrent={opened:true,epoch:state.lastOpenedEpoch,
  startsAt:BigInt(state.epochZeroStartsAt)+BigInt(state.lastOpenedEpoch)*BigInt(await scalar('ProvianRecourseKernel','EPOCH_DURATION')),
  combinedCapMode:1,mintRate:state.mintRate,genesisCap:state.genesisCap,combinedCap:state.combinedCap,
  provianTreasury:state.provianTreasury,foundationTreasury:state.foundationTreasury,agentFoundationBps:state.agentFoundationBps,
  beneficiaryVerifier:state.beneficiaryVerifier,eligibilityVerifier:{...state.eligibilityVerifier,verifier:a.ProvianRecourseEligibilityVerifier},
  policyHash:current.policyHash};
 ensure(current.policyHash!==ZeroHash,'current_policy_hash');
 await exact('ProvianRecourseKernel','getEpochPolicy',[state.lastOpenedEpoch],[expectedCurrent]);
 await exact('ProvianRecourseKernel','epochGenesisIssued',[state.lastOpenedEpoch],[state.epochGenesisIssued]);
 await exact('ProvianRecourseKernel','epochTotalIssued',[state.lastOpenedEpoch],[state.epochTotalIssued]);
 for(const schedule of state.schedules){
  for(const[flag,method,values]of [
   ['mintRateSet','scheduledMintRates',[true,schedule.mintRate]],
   ['foundationRateSet','scheduledAgentFoundationRates',[true,schedule.foundationRate]],
   ['capsSet','scheduledCapPolicies',[true,1,schedule.genesisCap,schedule.combinedCap]],
   ['treasuriesSet','scheduledTreasuries',[true,schedule.provianTreasury,schedule.foundationTreasury]],
   ['beneficiaryVerifierSet','getScheduledBeneficiaryVerifier',[true,schedule.beneficiaryVerifier]],
   ['eligibilityVerifierSet','getScheduledEligibilityVerifier',[true,schedule.eligibilityVerifier]],
  ])if(schedule[flag])await exact('ProvianRecourseKernel',method,[schedule.epoch],values);
 }

 for(const row of plan.snapshot.balances)ensure(await scalar('ProvianRestorationAuthorization','migratedAddress',[row.previousOwner])===true,'missing_holder');
 // Import count/root and the exact nonzero sum prove the entire population.
 // Do not demand balances stay frozen after import: ordinary transfers remain
 // permissionless even while the new settlement lane is administratively held.
 const mapping={escrowV4:'ProvianRecourseEscrow',promiseV3:'ProvianPromiseV3',poolV3:'ProvianRecourseProjectPool',
  bondPool:'ProvianRecourseBondPool',courtV2:'ProvianRecourseCourt'};
 // Imports install kernel schedules without emitting scheduling events. The
 // only planned new schedule events are the BondPool constructor's fee/burn
 // seeds at epoch zero. Refuse every additional pre-publication schedule,
 // including a new epoch or an otherwise absent flag on an imported epoch.
 const scheduledAddresses=new Map([[lower(a.ProvianRecourseKernel),'ProvianRecourseKernel'],
  ...Object.values(mapping).map(name=>[lower(a[name]),name])]);
 const expectedSchedules=new Set(institutions.seedBps.map(seed=>
  `ProvianRecourseBondPool:${['DepositBurnBps','DepositFeeBps','RenewalBurnBps','RenewalFeeBps'][seed.param]}Scheduled:0:${seed.bps}`));
 const seenSchedules=new Set();
 const logs=await port.logs([...scheduledAddresses.keys()],plan.cutoff.number,block.number);
 for(const log of logs){
  const name=scheduledAddresses.get(lower(log.address));
  ensure(name&&!log.removed&&BigInt(log.blockNumber)>=BigInt(plan.cutoff.number)
   &&BigInt(log.blockNumber)<=BigInt(block.number),'schedule_event_domain');
  const event=new Interface(artifacts[name].abi).parseLog(log);
  ensure(event,'unknown_successor_event');
  if(!event.name.endsWith('Scheduled'))continue;
  const key=name+':'+event.name+':'+event.args.toArray().map(String).join(':');
  ensure(expectedSchedules.has(key)&&!seenSchedules.has(key),'unexpected_schedule');seenSchedules.add(key);
 }
 ensure(seenSchedules.size===expectedSchedules.size,'missing_schedule_seed');
 const replacements=new Map([[lower(plan.predecessor),a.ProvianRecourseKernel],
  ...institutions.inventory.map(row=>[row.address,a[mapping[row.key]]])]);
 for(const row of institutions.inventory){
  const name=mapping[row.key];
  for(const wiring of row.wiring)ensure(lower(await scalar(name,wiring.method))===lower(replacements.get(wiring.address)??wiring.address),`institution_wiring:${name}:${wiring.method}`);
  for(const policy of row.policy){
   if(policy.method==='earliestSchedulableEpoch'){
    const iface=new Interface(artifacts[name].abi);
    const original=iface.decodeFunctionResult(policy.method,await port.call(row.address,iface.encodeFunctionData(policy.method),block.hash));
    await exact(name,policy.method,[],original);continue;
   }
   const value=(await read(name,policy.method)).toArray().map(v=>typeof v==='bigint'?v.toString():v);
   ensure(JSON.stringify(value)===JSON.stringify(policy.values),`institution_policy:${name}:${policy.method}`);
  }
 }
 for(const seed of institutions.seedBonds){
  const b=await read('ProvianRecourseBondPool','bonds',[seed.agent]);
  for(const field of ['amount','autonomyLevel','createdAt','lastRenewalAt','renewalDeadline'])ensure(String(b[field])===String(seed[field]),'bond_state');
  ensure(b.status===1n&&b.pendingClaims===0n&&String(await scalar('ProvianRecourseBondPool','requiredAtPost',[seed.agent]))===seed.requiredAtPost,'bond_rights');
 }
 for(const seed of institutions.seedEscrows){
  const e=await read('ProvianRecourseEscrow','escrows',[seed.escrowId]);
  for(const field of ['depositor','recipient','amount','fee','autoReleaseAt','currency'])ensure(lower(e[field])===lower(seed[field]),'escrow_state');
  ensure(e.status===0n,'escrow_rights');
 }
 const liabilities=institutions.seedBonds.reduce((sum,b)=>sum+BigInt(b.amount),0n);
 await exact('ProvianRecourseBondPool','encumberedPVT',[],[liabilities]);
 ensure(BigInt(await scalar('ProvianRecourseKernel','balanceOf',[a.ProvianRecourseBondPool]))>=liabilities,'bond_backing');
 for(const name of ['ProvianRecourseEscrow','ProvianRecourseCourt','ProvianRecourseProjectPool'])
  await exact(name,'encumberedPVT',[],[0]);
 ensure(await scalar('ProvianMemberRecoursePool','poolHistoryReady')===true,'pool_history');
 for(const method of ['accountedBacking','allocatedRestorations','importedPoolEntries'])
  await exact('ProvianMemberRecoursePool',method,[],[0]);
 await exact('ProvianMemberRecoursePool','monthlyRuleCount',[],[1]);
 const poolIface=new Interface(artifacts.ProvianMemberRecoursePool.abi);
 // Decode the rule directly from the pool; the caller has already verified
 // the SSH signature and exact tuple before assembling deployment bytes.
 const ruleMethod=poolIface.getFunction('monthlyRule');
 ensure(ruleMethod!==null,'pool_rule_reader_missing');
 const actual=await read('ProvianMemberRecoursePool','monthlyRule',[0]);
 const tuple=actual[0];
 ensure(String(tuple.firstMonth)===String(rule.rule.firstMonth)&&String(tuple.participationBurn)===rule.rule.participationBurnAtomic
  &&String(tuple.noEarningsContribution)===rule.rule.noEarningsContributionAtomic&&Number(tuple.earningsBps)===rule.rule.earningsBps
  &&tuple.signedRuleHash===rule.ruleHash,'membership_rule');
 const oldAbi=new Interface(['function administrativeHold() view returns(bool)','function operationalMinter() view returns(address)']);
 for(const[method,expected]of [['administrativeHold',true],['operationalMinter',ZeroAddress]]){
  const got=oldAbi.decodeFunctionResult(method,await port.call(plan.predecessor,oldAbi.encodeFunctionData(method),block.hash))[0];
  ensure(lower(got)===lower(expected),'predecessor_not_retired');
 }
 const oldVerifier=new Interface(['function administrativeHold() view returns(bool)','function batchApprover() view returns(address)']);
 for(const[method,expected]of [['administrativeHold',true],['batchApprover',ZeroAddress]]){
  const got=oldVerifier.decodeFunctionResult(method,await port.call(state.eligibilityVerifier.verifier,oldVerifier.encodeFunctionData(method),block.hash))[0];
  ensure(lower(got)===lower(expected),'predecessor_verifier_not_retired');
 }
 const hashes=[];
 for(const component of plan.components)hashes.push(lower(component)===lower(ZeroAddress)?ZeroHash:keccak256(await port.code(component,block.hash)));
 ensure(await port.blockHash(block.number)===block.hash,'reorg');
 return {block,components:plan.components,hashes,historyEntries:plan.snapshot.historyCount,holders:plan.snapshot.balances.length,
  institutionCount:institutions.inventory.length,ruleHash:plan.ruleHash};
}

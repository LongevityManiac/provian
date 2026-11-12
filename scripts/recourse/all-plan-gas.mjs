import {readFileSync} from 'node:fs';
import {AbiCoder,Interface,keccak256,sha256,toUtf8Bytes} from 'ethers';
import {boundedGasEstimate,BASE_TRANSACTION_GAS_LIMIT} from './transaction-gas-limit.mjs';
import {importLeafBound,importGasUpper,IMPORT_EXECUTION_GAS,PROOF_ITERATION_GAS} from './import-gas-bound.mjs';
const ensure=(value,reason)=>{if(!value)throw Error('all_plan_gas_'+reason);};
const root=new URL('../../',import.meta.url);
const digest=value=>sha256(toUtf8Bytes(JSON.stringify(value)));
export const GAS_PLAN_SOURCES=Object.freeze(['scripts/recourse/all-plan-gas.mjs','scripts/recourse/import-gas-bound.mjs','scripts/recourse/transaction-gas-limit.mjs',
 'scripts/recourse/first-changeover.mjs','scripts/recourse/successor-plan.mjs','scripts/recourse/successor-deploy-cli.mjs',
 'scripts/recourse/predecessor-retirement.mjs','scripts/recourse/pointer-deployment.mjs','scripts/recourse/permanent-pointer-plan.mjs',
 'scripts/recourse/pointer-publication.mjs','scripts/recourse/successor-activation.mjs']);
export const CREATION_FAMILIES=Object.freeze(['ProvianOwnershipRegistry','ProvianRecoveryHistory','ProvianRestorationAuthorization',
 'ProvianRecourseKernel','ProvianRecourseEligibilityVerifier','ProvianRecourseEscrow','ProvianPromiseV3','ProvianRecourseProjectPool',
 'ProvianRecourseBondPool','ProvianRecourseCourt','ProvianMemberRecoursePool','ProvianSuccessionImporter','ProvianHashAccount','ProvianProtocolPointer']);
export const FIXED_CALL_FAMILIES=Object.freeze([
 'ProvianPVT9:placeAdministrativeHold','ProvianPVT9:revokeOperationalMinter',
 'ProvianPVT9EligibilityVerifier:placeAdministrativeHold','ProvianPVT9EligibilityVerifier:revokeBatchApprover',
 'ProvianRecourseEscrow:setCourtContract','ProvianRecourseBondPool:setCourtContract','ProvianRecourseBondPool:setExecutor',
 'ProvianRecourseCourt:setBondPool','ProvianRecourseEligibilityVerifier:appointBatchApprover','ProvianRecourseKernel:appointOperationalMinter',
 'ProvianRecourseKernel:installRecoveredBeneficiaryVerifier','ProvianRecourseKernel:armEpochZero',
 'ProvianRecourseKernel:resumeFromAdministrativeHold','ProvianRecoveryHistory:applyEconomicEntry']);
export function gasArtifactFingerprint(artifact){return digest({abi:artifact.abi,init:artifact.bytecode.object,runtime:artifact.deployedBytecode.object,
 compiler:artifact.metadata?.settings});}
export function readGasCertificate(){return JSON.parse(readFileSync(new URL('config/recourse-changeover-gas.json',root),'utf8'));}
function ceiling(value,maximum){ensure(typeof value==='string'&&/^[1-9][0-9]*$/.test(value),'uncertified_family');return boundedGasEstimate(BigInt(value),maximum);}
export function validateGasCertificate(inputs,certificate=readGasCertificate()){
 ensure(certificate.schema==='provian.first-changeover-gas.v1','certificate_missing');
 ensure(JSON.stringify(Object.keys(certificate.creations).sort())===JSON.stringify([...CREATION_FAMILIES].sort())
  &&JSON.stringify(Object.keys(certificate.calls).sort())===JSON.stringify([...FIXED_CALL_FAMILIES].sort()),'uncovered_family');
 const maximum=BigInt(inputs.executionLimits?.maxGas??BASE_TRANSACTION_GAS_LIMIT);
 for(const value of [...Object.values(certificate.creations),...Object.values(certificate.calls),certificate.publication])ceiling(value,maximum);
 for(const name of ['ProvianHashAccount','ProvianProtocolPointer'])boundedGasEstimate(BigInt(certificate.creations[name])+20000n,maximum);
 ensure(inputs.callGas==='4000000','publication_inner_gas');
 ensure(typeof certificate.publicationInner==='string'&&/^[1-9][0-9]*$/.test(certificate.publicationInner)
  &&BigInt(certificate.publicationInner)<=BigInt(inputs.callGas),'publication_inner_bound');
 // One maximally deep proof must fit by itself before the future inventory
 // exists. 16KiB exceeds every canonical single-leaf wrapper in this plan.
 for(const execution of Object.values(IMPORT_EXECUTION_GAS))boundedGasEstimate(importGasUpper([
  {execution:execution+256n*PROOF_ITERATION_GAS,memoryBytes:16384n+512n*256n}], '0x'+'ff'.repeat(16384)),maximum);
 for(const [name,artifact]of Object.entries(inputs.artifacts)){
  ensure(certificate.artifacts[name]===gasArtifactFingerprint(artifact),'artifact_changed:'+name);
  ensure((artifact.deployedBytecode.object.length-2)/2<=24576,'runtime_size:'+name);
 }
 ensure(Object.keys(certificate.artifacts).length===Object.keys(inputs.artifacts).length,'artifact_population');
 for(const path of GAS_PLAN_SOURCES)ensure(certificate.sources[path]===sha256(readFileSync(new URL(path,root))),'source_changed:'+path);
 // Predecessor, verifier, five institutions and one retired import helper,
 // plus every configured legacy token, even those currently absent on Base.
 const retirementBytes=132+64*(8+inputs.legacyTokens.length);
 ensure(retirementBytes<=2048,'publication_calldata');
 return {certificate,maximum};
}
function canonicalCall(row,artifact){
 const iface=new Interface(artifact.abi),parsed=iface.parseTransaction({data:row.data});
 ensure(parsed&&iface.encodeFunctionData(parsed.fragment,parsed.args)===row.data,'noncanonical_call');return parsed;
}
function creationShape(name,row,artifact){
 const iface=new Interface(artifact.abi),code=artifact.bytecode.object;
 ensure(row.data.startsWith(code),'creation_changed');
 const data='0x'+row.data.slice(code.length),args=AbiCoder.defaultAbiCoder().decode(iface.deploy.inputs,data);
 ensure(iface.encodeDeploy(args)===data&&(row.data.length-2)/2<=49152,'creation_encoding');
 if(name==='ProvianRecoveryHistory')ensure(args[4].epochs.length===0&&args[4].schedules.length===0,'unbounded_economics');
 if(name==='ProvianRecourseBondPool')ensure(args[6].length<=4,'unbounded_bps');
 if(name==='ProvianMemberRecoursePool')ensure(args[4].firstMonth===0n&&args[5].predecessor==='0x'+'00'.repeat(20)
  &&args[5].blockNumber===0n&&args[5].root==='0x'+'00'.repeat(32)&&args[5].getValue('entries')===0n&&!args[5].afterBreak,'unsupported_pool_snapshot');
 if(name==='ProvianRestorationAuthorization')ensure(args[4]===false&&args[6]===0n,'unsupported_break');
 if(name==='ProvianOwnershipRegistry')ensure(args[2]===false,'unsupported_break');
 if(name==='ProvianRecourseKernel')ensure(args[0].afterCryptographicBreak===false,'unsupported_break');
}
/** The certificate proves a closed set of bounded future families before the
 * source cutoff exists. This check binds each subsequently constructed call to
 * that set; it never advances the cutoff or chooses an earlier inventory. */
export function assertGasStep(row,inputs,proof){
 ensure(row.value==='0'&&typeof row.data==='string','transaction_shape');
 const {certificate,maximum}=proof,artifacts=inputs.artifacts;
 if(row.label.startsWith('deploy:')){
  const name=row.label.slice(7);ensure(CREATION_FAMILIES.includes(name),'uncovered_creation');
  creationShape(name,row,artifacts[name]);return ceiling(certificate.creations[name],maximum);
 }
 if(['pointer-authority','permanent-pointer'].includes(row.label)){
  const name=row.label==='pointer-authority'?'ProvianHashAccount':'ProvianProtocolPointer';
  creationShape(name,{...row,data:'0x'+row.data.slice(66)},artifacts[name]);
  return boundedGasEstimate(BigInt(certificate.creations[name])+20000n,maximum);
 }
 let name=row.label.split(':')[0];
 if(name==='retire')name=row.label.endsWith('revokeBatchApprover')||row.to===inputs.retirementVerifier?'ProvianPVT9EligibilityVerifier':'ProvianPVT9';
 if(name==='importHistory'||name==='importBalances'){
  const parsed=canonicalCall(row,artifacts.ProvianSuccessionImporter);
  ensure(parsed.name===name&&parsed.args[0].length>0&&parsed.args[0].length<=128,'import_group');
  const target=name==='importHistory'?'ProvianRecoveryHistory':'ProvianRestorationAuthorization';
  const leaves=parsed.args[0].map(data=>{
   const member={data},decoded=canonicalCall(member,artifacts[target]);
   ensure(name==='importHistory'?['importEntry','importBatch'].includes(decoded.name):decoded.name==='importBalance','import_selector');
   return importLeafBound(member,artifacts[target]);
  });
  return boundedGasEstimate(importGasUpper(leaves,row.data),maximum);
 }
 ensure(artifacts[name],'uncovered_contract');
 const parsed=canonicalCall(row,artifacts[name]),family=name+':'+parsed.name;
 if(['ProvianRecourseEscrow:importCustodySeed','ProvianRecourseBondPool:importCustodySeed','ProvianRecoveryHistory:importEconomicEntry'].includes(family)){
  return boundedGasEstimate(importGasUpper([importLeafBound(row,artifacts[name])],row.data),maximum);
 }
 ensure(FIXED_CALL_FAMILIES.includes(family),'uncovered_call');
 return ceiling(certificate.calls[family],maximum);
}
export async function prepareAllPlanGas(inputs,retirement,pointer,certificate){
 const proof=validateGasCertificate(inputs,certificate),context={...inputs,retirementVerifier:retirement.state.verifier};
 const steps=[...retirement.steps,...pointer.steps].map(row=>({label:row.label,declaredUpper:String(assertGasStep(row,context,proof))}));
 const checkpoint=retirement.checkpoint;
 ensure(await inputs.port.blockHash(checkpoint.number)===checkpoint.hash,'checkpoint_changed');
 return {schema:'provian.pre-retirement-gas.v1',checkpoint,certificateDigest:digest(proof.certificate),
  configurationDigest:digest({callGas:inputs.callGas,importBatchSize:inputs.importBatchSize,legacyTokens:inputs.legacyTokens,
    executionLimits:inputs.executionLimits??null,pointer:inputs.pointerPlan.pointer,rule:inputs.rule}),steps,
  coveredCreations:CREATION_FAMILIES,coveredCalls:FIXED_CALL_FAMILIES,publicationDeclaredUpper:String(ceiling(proof.certificate.publication,proof.maximum)),
  variableImports:{proofWords:256,canonicalEncoding:true,adaptiveGrouping:true}};
}

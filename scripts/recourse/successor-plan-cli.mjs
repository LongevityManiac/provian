#!/usr/bin/env node
import { readCompiledArtifact } from './compiled-artifact.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {keccak256} from 'ethers';
import {buildSuccessorPlan,SUCCESSOR_CREATION_ORDER} from './successor-plan.mjs';
import {permanentPointerPlan} from './permanent-pointer-plan.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=path=>JSON.parse(readFileSync(resolve(path),'utf8'));
/** Local assembly only. The runner independently rebuilds chain inventories
 * and verifies the SSH signature before any transaction can be signed. */
async function main(){
 const[inputsPath,output,...extra]=process.argv.slice(2);
 if(inputsPath==='--help'){
  console.log('successor-plan-cli.mjs INPUTS_JSON OUTPUT_JSON\nInputs name snapshotPath, institutionsPath, pointerPlanPath, signedRulePath and public deployer/nonce/identityAttestor/submitter/batchApprover. Produces an unsigned review plan only. No keys, provider calls or broadcast.');return;
 }
 if(!inputsPath||!output||extra.length)throw Error('successor_plan_usage');
 const inputs=read(inputsPath),artifacts={};
 for(const name of [...SUCCESSOR_CREATION_ORDER,'ProvianHashAccount']){
  const compiled=readCompiledArtifact(root,name);
  for(const[path,source]of Object.entries(compiled.metadata.sources)){
   if(keccak256(readFileSync(resolve(root,'contracts',path)))!==source.keccak256)throw Error('successor_plan_stale_artifact');
  }
  if(Object.keys(compiled.bytecode.linkReferences??{}).length)throw Error('successor_plan_unlinked_artifact');
  artifacts[name]=compiled;
 }
 const pointerPlan=read(inputs.pointerPlanPath);
 if(JSON.stringify(pointerPlan)!==JSON.stringify(permanentPointerPlan(pointerPlan.initialRoot)))throw Error('successor_plan_pointer_changed');
 const plan=buildSuccessorPlan({snapshot:read(inputs.snapshotPath),institutions:read(inputs.institutionsPath),
  deployment:read(resolve(root,'contracts/deployments/base-pvt9-institutions.json')),artifacts,pointerPlan,
  rule:read(inputs.signedRulePath),deployer:inputs.deployer,nonce:inputs.nonce,identityAttestor:inputs.identityAttestor,
  submitter:inputs.submitter,batchApprover:inputs.batchApprover});
 writeFileSync(resolve(output),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({digest:plan.digest,creations:plan.creations.length,imports:plan.imports.length,
   pointer:plan.pointer,signatureVerified:false,broadcast:false}));
}
main().catch(error=>{console.error(error.message?.startsWith('successor_plan_')?error.message:'successor_plan_preparation_failed');process.exitCode=1;});

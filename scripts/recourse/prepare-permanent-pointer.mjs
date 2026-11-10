#!/usr/bin/env node
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { permanentPointerPlan,verifyPermanentPointerPlan } from './permanent-pointer-plan.mjs';
import { snapshotRpcPort } from './snapshot-cli.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
async function main(){
  const [source,output,...flags]=process.argv.slice(2);
  if(source==='--help'){
    console.log('prepare-permanent-pointer.mjs PUBLIC_VAULT_ROOT_JSON PLAN_JSON [--write-pin]\nReads both chain operators, verifies source-bound deterministic addresses, and writes a local deployment plan. --write-pin updates only the local build configuration. No transactions, signing calls, service releases or pointer publication occur.');return;
  }
  if(!source||!output||flags.some(v=>v!=='--write-pin'))throw Error('pointer_plan_usage');
  const publicRoot=JSON.parse(readFileSync(resolve(source),'utf8'));
  if(publicRoot.schema!=='provian.hash-authority-root.v1'||typeof publicRoot.itemId!=='string'||!publicRoot.itemId)throw Error('pointer_plan_durable_vault_root_required');
  const plan=permanentPointerPlan(publicRoot.root);
  const port=snapshotRpcPort([process.env.BASE_RPC_URL??'https://mainnet.base.org',
    process.env.BASE_RPC_URL_SECONDARY??process.env.BASE_RPC_SECONDARY_URL??'https://base.drpc.org']);
  const verified=await verifyPermanentPointerPlan(plan,port);
  // A build pin can be staged before deployment. Its resolver remains closed
  // until the matching contract exists and contains a valid current manifest.
  writeFileSync(resolve(output),JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
  if(flags.includes('--write-pin')){
    const target=resolve(root,'config/protocol-pointer.json'),prior=JSON.parse(readFileSync(target,'utf8'));
    if(prior.address!==null&&(prior.address.toLowerCase()!==plan.pointer||prior.runtimeHash!==plan.pointerRuntimeHash))throw Error('pointer_plan_existing_pin_conflict');
    writeFileSync(target,JSON.stringify({chainId:8453,address:plan.pointer,runtimeHash:plan.pointerRuntimeHash},null,2)+'\n');
  }
  console.log(JSON.stringify({pointer:plan.pointer,authority:plan.authority,verifiedBlock:verified.block,
    states:verified.states,pinWritten:flags.includes('--write-pin'),broadcast:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  console.error(/^pointer_plan_[a-z_]+$/.test(error.message)?error.message:'pointer_plan_preparation_failed');process.exitCode=1;
});

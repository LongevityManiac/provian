#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {keccak256} from 'ethers';
import {LEGACY_INSTITUTIONS,buildInstitutionSnapshot} from './institution-snapshot.mjs';
import {snapshotRpcPort} from './snapshot-cli.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
async function main(){
  const[output,...extra]=process.argv.slice(2);
  if(!output||extra.length)throw Error('institution_snapshot_usage');
  const artifacts={};
  for(const name of Object.values(LEGACY_INSTITUTIONS)){
    const artifact=JSON.parse(readFileSync(resolve(root,`contracts/out/${name}.sol/${name}.json`)));
    for(const[path,source]of Object.entries(artifact.metadata.sources)){
      if(keccak256(readFileSync(resolve(root,'contracts',path)))!==source.keccak256)throw Error('institution_snapshot_stale_artifact');
    }
    artifacts[name]=artifact;
  }
  const deployment=JSON.parse(readFileSync(resolve(root,'contracts/deployments/base-pvt9-institutions.json')));
  const port=snapshotRpcPort([process.env.BASE_RPC_URL??'https://base-rpc.publicnode.com',
    process.env.BASE_RPC_URL_SECONDARY??'https://base.drpc.org'],{
      logWindowSize:10_000,
      onLogRange(progress){console.log(JSON.stringify({stage:'history',...progress}));},
    });
  const block=await port.finalizedBlock();
  const result=await buildInstitutionSnapshot({port,deployment,artifacts,block:block.number,blockHash:block.hash});
  writeFileSync(resolve(output),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({block:result.block,institutions:result.inventory.length,
    bonds:result.seedBonds.length,escrows:result.seedEscrows.length,digest:result.digest,broadcast:false}));
}
main().catch(error=>{console.error(error.message?.startsWith('institution_snapshot_')?error.message:'institution_snapshot_read_failed');process.exitCode=1;});

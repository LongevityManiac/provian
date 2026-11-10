import { currentProtocolDeployment } from './runtime';
import { predecessorBurnAcceptances } from './predecessor-burns';
import { baseAssetsForKernel } from '../pvt/wallet-exchange';

/** Observation-only historical assets. This is never a transaction builder,
 * swap quote or spending allowlist. Backlogged work before an immutable
 * succession cutoff retains its original witness; later retired-token activity
 * cannot become current PVT work. Undefined block is discovery's superset. */
export async function observationBaseAssets(block?: number): Promise<Readonly<Record<string,string>>> {
  if(block!==undefined&&(!Number.isSafeInteger(block)||block<0))throw Error('protocol_observation_block_invalid');
  const deployment=await currentProtocolDeployment(),kernel=deployment.addresses.kernel.toLowerCase();
  const assets:Record<string,string>={...baseAssetsForKernel(kernel)};
  for(const previous of await predecessorBurnAcceptances(kernel)){
    if(block===undefined||block<=previous.maxBlock)assets[previous.address]='PVT';
  }
  if((await currentProtocolDeployment()).manifestHash!==deployment.manifestHash)throw Error('protocol_pointer_changed');
  return Object.freeze(assets);
}

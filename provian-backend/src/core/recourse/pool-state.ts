import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { currentProtocolDeployment } from '../protocol/runtime';
import { readRecoursePoolChain, type RecoursePoolState } from './pool-chain';
export { RECOURSE_POOL_ABI } from './pool-abi';
export type { RecoursePoolState } from './pool-chain';

export interface RecoursePoolConfig { readonly address: string; readonly runtimeHash: string }
export async function recoursePoolConfig(): Promise<RecoursePoolConfig> {
  const deployment = await currentProtocolDeployment();
  return { address: deployment.addresses.recoursePool.toLowerCase(), runtimeHash: deployment.runtimeHashes[8].toLowerCase() };
}

/** Only public address consent, current rules and reserves. Authenticated private
 * calendar data is combined separately; it cannot be reconstructed from chain. */
export async function readRecoursePoolState(identity: string): Promise<RecoursePoolState> {
  const legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  return readRecoursePoolChain(identity, { deployment: currentProtocolDeployment, rpcs: [
    { request: (method, params) => legs[0].provider.send(method, [...params]) },
    { request: (method, params) => legs[1].provider.send(method, [...params]) },
  ] });
}

import { keccak256 } from 'ethers';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import { RECOURSE_POOL_ABI } from './recourse-pool-abi';

export interface RestorationExit {
  readonly request: string; readonly identity: string; readonly amountAtomic: string;
  readonly pool: string; readonly manifestHash: string; readonly data: string;
}
/** Anyone may deliver an existing allocation, but only to its contract-bound
 * recovered destination. No relay, membership renewal or new determination is required. */
export async function prepareRestorationExit(identity: string, request: string,
  network: OwnerChainNetwork): Promise<RestorationExit> {
  if (![identity, request].every(value => /^0x[0-9a-f]{64}$/.test(value) && !/^0x0+$/.test(value))) {
    throw new Error('recourse_allocation_identifier_invalid');
  }
  const deployment = await network.deployment();
  const pool = deployment.addresses.recoursePool.toLowerCase();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const results = await Promise.all(network.rpcs.map(async rpc => {
    const code = await rpc.request('eth_getCode', [pool, tag]);
    if (typeof code !== 'string' || keccak256(code) !== deployment.runtimeHashes[8].toLowerCase()) {
      throw new Error('recourse_pool_runtime_mismatch');
    }
    const call = async (method: string, args: readonly unknown[] = []) => {
      const raw = await rpc.request('eth_call', [{ to: pool, data: RECOURSE_POOL_ABI.encodeFunctionData(method, args) }, tag]);
      if (typeof raw !== 'string') throw new Error('recourse_allocation_reply_invalid');
      return RECOURSE_POOL_ABI.decodeFunctionResult(method, raw);
    };
    const [token, allocation] = await Promise.all([call('token'), call('restorationAllocations', [request])]);
    if (String(token[0]).toLowerCase() !== deployment.addresses.kernel.toLowerCase()) throw new Error('recourse_pool_token_mismatch');
    if (allocation[0] !== identity || allocation[1] <= 0n || allocation[2] !== false) throw new Error('recourse_allocation_unavailable');
    return String(allocation[1]);
  }));
  if (results[0] !== results[1]) throw new Error('recourse_pool_rpc_disagreement');
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw new Error('recourse_pool_deployment_changed');
  return { request, identity, amountAtomic: results[0], pool, manifestHash: deployment.manifestHash,
    data: RECOURSE_POOL_ABI.encodeFunctionData('deliverRestoration', [request, identity]) };
}

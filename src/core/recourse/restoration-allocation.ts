import { keccak256 } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import { RECOURSE_POOL_ABI } from './pool-abi';

export interface RestorationAllocationView { amountAtomic: string; withdrawn: boolean }
/** Read-only display evidence. An action always revalidates through prepareRestorationExit. */
export async function readRestorationAllocation(identity: string, request: string,
  network: OwnerChainNetwork): Promise<RestorationAllocationView | null> {
  if (![identity, request].every(value => /^0x[0-9a-f]{64}$/.test(value) && !/^0x0+$/.test(value))) throw Error('recourse_allocation_identifier_invalid');
  const deployment = await network.deployment(), pool = deployment.addresses.recoursePool.toLowerCase();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const values = await Promise.all(network.rpcs.map(async rpc => {
    const code = await rpc.request('eth_getCode', [pool, tag]);
    if (typeof code !== 'string' || keccak256(code) !== deployment.runtimeHashes[8].toLowerCase()) throw Error('recourse_pool_runtime_mismatch');
    const call = async (name: string, args: readonly unknown[] = []) => {
      const raw = await rpc.request('eth_call', [{ to: pool, data: RECOURSE_POOL_ABI.encodeFunctionData(name, args) }, tag]);
      if (typeof raw !== 'string') throw Error('recourse_allocation_reply_invalid');
      return RECOURSE_POOL_ABI.decodeFunctionResult(name, raw);
    };
    const [token, allocation] = await Promise.all([call('token'), call('restorationAllocations', [request])]);
    if (String(token[0]).toLowerCase() !== deployment.addresses.kernel.toLowerCase()) throw Error('recourse_pool_token_mismatch');
    if (/^0x0+$/.test(String(allocation[0]))) return null;
    if (allocation[0] !== identity) throw Error('recourse_allocation_identity_mismatch');
    return { amountAtomic: String(allocation[1]), withdrawn: Boolean(allocation[2]) };
  }));
  if (JSON.stringify(values[0]) !== JSON.stringify(values[1])) throw Error('recourse_pool_rpc_disagreement');
  for (const rpc of network.rpcs) {
    const block = await rpc.request('eth_getBlockByHash', [deployment.blockHash, false]);
    if (!block || typeof block !== 'object' || !('number' in block)) throw Error('recourse_pool_reorg');
    const canonical = await rpc.request('eth_getBlockByNumber', [block.number, false]);
    if (!canonical || typeof canonical !== 'object' || !('hash' in canonical) || canonical.hash !== deployment.blockHash) throw Error('recourse_pool_reorg');
  }
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw Error('recourse_pool_deployment_changed');
  return values[0];
}

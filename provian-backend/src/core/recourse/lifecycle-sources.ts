import { Interface, keccak256 } from 'ethers';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { createRecourseChainPort } from './chain-ledger';

export interface LifecycleSource { readonly address: string; readonly kind: 'pool' | 'registry' | 'restoration'; readonly from: number; readonly through: number }
export interface LifecycleSourcePort {
  deployment: typeof currentProtocolDeployment;
  finalized(): Promise<number>;
  read(method: string, params: readonly unknown[]): Promise<string>;
}
const abi = new Interface(['function poolSnapshot() view returns(address,uint256,bytes32,uint256,bool)',
  'function token() view returns(address)', 'function pointer() view returns(address)',
  'function registryOperator() view returns(address)', 'function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)']);
const zero = `0x${'0'.repeat(40)}`;
function productionPort(): LifecycleSourcePort {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  return { deployment: currentProtocolDeployment, finalized: () => createRecourseChainPort().finalizedBlock(),
    async read(method, params) {
      const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
      if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_lifecycle_rpc_disagreement');
      return values[0];
    } };
}
/** All original events survive ordinary succession and a cryptographic break.
 * Immutable pool predecessors identify the old kernel/registry/executor, and
 * their custody cutoffs exclude activity on retired copies after the snapshot. */
export async function recourseLifecycleSources(port: LifecycleSourcePort = productionPort()): Promise<readonly LifecycleSource[]> {
  const deployment = await port.deployment(), finalized = await port.finalized();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (to: string, name: string) => abi.decodeFunctionResult(name,
    await port.read('eth_call', [{ to, data: abi.encodeFunctionData(name) }, tag]));
  const birth = async (address: string, through: number): Promise<number> => {
    const code = await port.read('eth_getCode', [address, `0x${through.toString(16)}`]);
    if (code === '0x') return through + 1;
    let left = 1, right = through;
    while (left < right) {
      const mid = left + Math.floor((right - left) / 2);
      if (await port.read('eth_getCode', [address, `0x${mid.toString(16)}`]) === '0x') left = mid + 1;
      else right = mid;
    }
    if (await port.read('eth_getCode', [address, `0x${(left - 1).toString(16)}`]) !== '0x'
      || await port.read('eth_getCode', [address, `0x${left.toString(16)}`]) !== code) throw Error('recourse_lifecycle_birth_invalid');
    return left;
  };
  const result: LifecycleSource[] = [], seen = new Set<string>();
  let pool = deployment.addresses.recoursePool.toLowerCase(), through = finalized;
  while (pool !== zero) {
    if (seen.has(pool)) throw Error('recourse_lifecycle_history_cycle');
    seen.add(pool);
    const code = await port.read('eth_getCode', [pool, tag]);
    if (code === '0x' || (seen.size === 1 && keccak256(code) !== deployment.runtimeHashes[8])
      || String((await call(pool, 'pointer'))[0]).toLowerCase() !== deployment.pointer.toLowerCase()) throw Error('recourse_lifecycle_source_invalid');
    const kernel = String((await call(pool, 'token'))[0]).toLowerCase();
    if (seen.size === 1 && kernel !== deployment.addresses.kernel.toLowerCase()) throw Error('recourse_lifecycle_source_invalid');
    const registry = String((await call(kernel, 'registryOperator'))[0]).toLowerCase();
    const executor = String((await call(kernel, 'ownerAuthorization'))[0]).toLowerCase();
    if (String((await call(executor, 'kernel'))[0]).toLowerCase() !== kernel
      || String((await call(registry, 'pointer'))[0]).toLowerCase() !== deployment.pointer.toLowerCase()) throw Error('recourse_lifecycle_source_invalid');
    for (const [address, kind] of [[pool, 'pool'], [registry, 'registry'], [executor, 'restoration']] as const) {
      const from = await birth(address, through);
      if (from <= through) result.push({ address, kind, from, through });
    }
    const ancestry = await call(pool, 'poolSnapshot');
    const previous = String(ancestry[0]).toLowerCase(), cutoff = Number(ancestry[1]);
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || (previous !== zero && (cutoff === 0 || cutoff > through))) throw Error('recourse_lifecycle_cutoff_invalid');
    through = Math.min(through, cutoff); pool = previous;
  }
  if ((await port.deployment()).manifestHash !== deployment.manifestHash) throw Error('protocol_pointer_changed');
  return result.reverse();
}

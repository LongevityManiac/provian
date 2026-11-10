import { Interface } from 'ethers';
import { currentProtocolDeployment } from './runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
const kernelAbi = new Interface(['function ownerAuthorization() view returns(address)']);
const executorAbi = new Interface(['function kernel() view returns(address)', 'function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)', 'function previousAuthorization() view returns(address)']);
const ZERO = `0x${'0'.repeat(40)}`;
/** Historical burns stop at each immutable succession snapshot, not the later
 * pointer publication block. This traverses ordinary successor history without
 * requiring a relay rebuild for each new kernel address. */
export async function predecessorBurnAcceptances(expectedKernel: string): Promise<readonly { address: string; maxBlock: number }[]> {
  const deployment = await currentProtocolDeployment();
  if (deployment.addresses.kernel.toLowerCase() !== expectedKernel.toLowerCase()) throw new Error('protocol_pointer_changed');
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('protocol_rpc_operators_not_independent');
  const call = async (target: string, abi: Interface, method: string) => {
    const params = [{ to: target, data: abi.encodeFunctionData(method) }, { blockHash: deployment.blockHash, requireCanonical: true }];
    const replies: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_call', params)));
    if (typeof replies[0] !== 'string' || replies[0] !== replies[1]) throw new Error('protocol_predecessor_disagreement');
    return abi.decodeFunctionResult(method, replies[0])[0];
  };
  let executor = String(await call(expectedKernel, kernelAbi, 'ownerAuthorization')).toLowerCase();
  let currentKernel = expectedKernel.toLowerCase(), maximumCutoff: number | null = null;
  const seen = new Set<string>(), result: Array<{ address: string; maxBlock: number }> = [];
  while (executor !== ZERO) {
    if (seen.has(executor) || String(await call(executor, executorAbi, 'kernel')).toLowerCase() !== currentKernel) throw new Error('protocol_predecessor_invalid');
    seen.add(executor);
    const previous = String(await call(executor, executorAbi, 'predecessor')).toLowerCase();
    const cutoff = Number(await call(executor, executorAbi, 'lastGoodBlock'));
    if (!Number.isSafeInteger(cutoff) || cutoff < 1 || previous === ZERO || previous === currentKernel
      || maximumCutoff !== null && cutoff > maximumCutoff) throw new Error('protocol_predecessor_invalid');
    result.push({ address: previous, maxBlock: cutoff });
    maximumCutoff = cutoff; currentKernel = previous;
    executor = String(await call(executor, executorAbi, 'previousAuthorization')).toLowerCase();
  }
  if ((await currentProtocolDeployment()).manifestHash !== deployment.manifestHash) throw new Error('protocol_pointer_changed');
  return result;
}

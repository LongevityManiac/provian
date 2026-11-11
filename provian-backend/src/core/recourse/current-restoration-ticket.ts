import { Interface } from 'ethers';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { parseRestorationScope } from './owner-operation';
import type { RestorationTicket } from './determination';
const abi = new Interface([
  'function ownerAuthorization() view returns(address)',
  'function kernel() view returns(address)',
  'function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))',
  'function reversalExecuted(bytes32) view returns(bool)', 'function recoveredDestination(bytes32) view returns(address)',
  'function determined(bytes32) view returns(bool)',
]);
/** The current pointer and exact surviving ticket establish consent. Historical
 * balance tracing is a separate check; an imported ticket does not prove a
 * transfer or turn a cryptographic break into ordinary balance migration. */
export async function readCurrentRestorationTicket(request: string): Promise<RestorationTicket> {
  if (!/^0x[0-9a-f]{64}$/.test(request)) throw Error('recourse_determination_request_invalid');
  const deployment = await currentProtocolDeployment(), kernel = deployment.addresses.kernel.toLowerCase();
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  const headers = await Promise.all(legs.map(leg => leg.provider.send('eth_getBlockByHash', [deployment.blockHash, false])));
  const headerNumber = (raw: unknown): string => {
    if (!raw || typeof raw !== 'object' || !('hash' in raw) || raw.hash !== deployment.blockHash
      || !('number' in raw) || typeof raw.number !== 'string' || !/^0x[0-9a-f]+$/.test(raw.number)
      || BigInt(raw.number) < 1n || BigInt(raw.number) > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('recourse_determination_checkpoint_changed');
    return `0x${BigInt(raw.number).toString(16)}`;
  };
  const height = headerNumber(headers[0]);
  if (headerNumber(headers[1]) !== height) throw Error('recourse_determination_checkpoint_changed');
  const call = async (target: string, method: string, args: readonly unknown[]) => {
    const values: unknown[] = await Promise.all(legs.map(leg => leg.provider.send('eth_call', [{ to: target,
      data: abi.encodeFunctionData(method, args) }, { blockHash: deployment.blockHash, requireCanonical: true }])));
    if (typeof values[0] !== 'string' || !rpcChainFactsEqual(values[0], values[1])) throw Error('recourse_determination_rpc_disagreement');
    return abi.decodeFunctionResult(method, values[0])[0];
  };
  const executor = String(await call(kernel, 'ownerAuthorization', [])).toLowerCase();
  if (String(await call(executor, 'kernel', [])).toLowerCase() !== kernel) throw Error('recourse_determination_ticket_unavailable');
  const row = await call(executor, 'restorationIntent', [request]);
  const scope = parseRestorationScope({ request: String(row.request), lossHash: String(row.lossHash), maximumLoss: String(row.maximumLoss) });
  const identity = String(row.identity).toLowerCase(), destination = String(row.destination).toLowerCase();
  const currentDestination = String(await call(executor, 'recoveredDestination', [identity])).toLowerCase();
  if (scope.request !== request || /^0x0+$/.test(identity) || /^0x0+$/.test(destination)
    || /^0x0+$/.test(currentDestination) || await call(executor, 'reversalExecuted', [request])
    || await call(deployment.addresses.recoursePool.toLowerCase(), 'determined', [request])) throw Error('recourse_determination_ticket_unavailable');
  if ((await currentProtocolDeployment()).manifestHash !== deployment.manifestHash) throw Error('recourse_determination_checkpoint_changed');
  const canonical = await Promise.all(legs.map(leg => leg.provider.send('eth_getBlockByNumber', [height, false])));
  if (canonical.some(header => headerNumber(header) !== height)) throw Error('recourse_determination_checkpoint_changed');
  return { ...scope, identity, destination, currentDestination };
}

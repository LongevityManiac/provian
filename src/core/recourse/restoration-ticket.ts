import { Interface } from 'ethers';
import { readOwnerChainState, type OwnerChainNetwork } from './owner-chain';
import { parseRestorationScope, type RestorationScope } from './owner-operation';
const abi = new Interface(['function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))']);
/** An old bounded authorization remains fixed while its rights follow the
 * current independently recovered destination. No relay assertion creates it. */
export async function verifyContinuedRestoration(identity: string, destination: string, supplied: RestorationScope,
  network: OwnerChainNetwork): Promise<void> {
  const scope = { ...parseRestorationScope(supplied) }, owner = await readOwnerChainState(identity, network);
  if (owner.destination !== destination) throw Error('recourse_restoration_ticket_changed');
  const replies = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to: owner.executor,
    data: abi.encodeFunctionData('restorationIntent', [scope.request]) }, { blockHash: owner.deployment.blockHash, requireCanonical: true }])));
  if (typeof replies[0] !== 'string' || replies[0] !== replies[1]) throw Error('recourse_restoration_ticket_disagreement');
  const row = abi.decodeFunctionResult('restorationIntent', replies[0])[0];
  if (String(row.identity) !== identity || String(row.request) !== scope.request || String(row.lossHash) !== scope.lossHash
    || String(row.maximumLoss) !== scope.maximumLoss || /^0x0{40}$/.test(String(row.destination))) throw Error('recourse_restoration_ticket_changed');
  if ((await network.deployment()).manifestHash !== owner.deployment.manifestHash) throw Error('recourse_restoration_ticket_changed');
}

import { Interface } from 'ethers';
import { readOwnerChainState, type OwnerChainNetwork } from './owner-chain';
import type { OwnerChainState } from './owner-chain';
import { parseRestorationScope, type RestorationScope } from './owner-operation';
const abi = new Interface(['function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))',
  'function reversalExecuted(bytes32) view returns(bool)', 'function determined(bytes32) view returns(bool)',
  'function reversalEvidence(bytes32) view returns(tuple(bytes32 identity,uint256 shortfall,bytes32 evidenceHash))',
  'function occurrenceDetermined(bytes32,bytes32) view returns(bool)']);
/** An old bounded authorization remains fixed while its rights follow the
 * current independently recovered destination. No relay assertion creates it. */
export async function verifyContinuedRestoration(identity: string, destination: string, supplied: RestorationScope,
  network: OwnerChainNetwork): Promise<void> {
  if (!await hasContinuedRestoration(identity, destination, supplied, network)) throw Error('recourse_restoration_ticket_changed');
}
/** An all-zero ticket is absent from the authenticated surviving state. A
 * present but different ticket is a refusal, never a reason to recreate it. */
export async function hasContinuedRestoration(identity: string, destination: string, supplied: RestorationScope,
  network: OwnerChainNetwork): Promise<boolean> {
  return (await readTicket(identity, destination, supplied, network)).exists;
}
async function readTicket(identity: string, destination: string, supplied: RestorationScope,
  network: OwnerChainNetwork): Promise<{ exists: boolean; owner: OwnerChainState }> {
  const scope = { ...parseRestorationScope(supplied) }, owner = await readOwnerChainState(identity, network);
  if (owner.destination !== destination) throw Error('recourse_restoration_ticket_changed');
  const replies = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to: owner.executor,
    data: abi.encodeFunctionData('restorationIntent', [scope.request]) }, { blockHash: owner.deployment.blockHash, requireCanonical: true }])));
  if (typeof replies[0] !== 'string' || replies[0] !== replies[1]) throw Error('recourse_restoration_ticket_disagreement');
  const row = abi.decodeFunctionResult('restorationIntent', replies[0])[0];
  if ((await network.deployment()).manifestHash !== owner.deployment.manifestHash) throw Error('recourse_restoration_ticket_changed');
  if ([row.identity, row.request, row.lossHash, row.destination].every(value => /^0x0+$/.test(String(value))) && String(row.maximumLoss) === '0') return { exists: false, owner };
  if (String(row.identity) !== identity || String(row.request) !== scope.request || String(row.lossHash) !== scope.lossHash
    || String(row.maximumLoss) !== scope.maximumLoss || /^0x0{40}$/.test(String(row.destination))) throw Error('recourse_restoration_ticket_changed');
  return { exists: true, owner };
}

/** An executed reversal can still await its pool allocation, but it must never
 * be resubmitted as a fresh loss. Determined declines are final as well. */
export async function readContinuedRestorationStatus(identity: string, destination: string, supplied: RestorationScope,
  network: OwnerChainNetwork): Promise<'absent' | 'pending' | 'executed'> {
  const scope = { ...parseRestorationScope(supplied) }, { exists, owner } = await readTicket(identity, destination, scope, network);
  const call = async (to: string, method: string, args: readonly unknown[]) => {
    const values = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to, data: abi.encodeFunctionData(method, args) },
      { blockHash: owner.deployment.blockHash, requireCanonical: true }])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_restoration_ticket_disagreement');
    return abi.decodeFunctionResult(method, values[0])[0];
  };
  const [reversed, determined] = await Promise.all([call(owner.executor, 'reversalExecuted', [scope.request]),
    call(owner.deployment.addresses.recoursePool, 'determined', [scope.request])]);
  if (!exists && reversed) {
    // Break snapshots carry completed reversals as history rather than as
    // pending intents. Its owner-bound outcome still closes the occurrence.
    const evidence = await call(owner.executor, 'reversalEvidence', [scope.request]);
    if (String(evidence.identity) !== identity || /^0x0+$/.test(String(evidence.evidenceHash))) throw Error('recourse_restoration_ticket_changed');
  }
  if (!exists && determined && await call(owner.deployment.addresses.recoursePool, 'occurrenceDetermined', [identity, scope.request]) !== true) throw Error('recourse_restoration_ticket_changed');
  if ((await network.deployment()).manifestHash !== owner.deployment.manifestHash) throw Error('recourse_restoration_ticket_changed');
  return reversed || determined ? 'executed' : exists ? 'pending' : 'absent';
}

import { Interface, ZeroAddress } from 'ethers';
import { readOwnerChainState, type OwnerChainNetwork } from './owner-chain';
import { readFinalizedReceipt } from './finalized-receipt';
import { RECOURSE_POOL_ABI } from './pool-abi';
import type { RestorationAllocationView } from './restoration-allocation';
const abi = new Interface([
  'function previousAuthorization() view returns(address)',
  'event TheftReversed(bytes32 indexed request,bytes32 indexed identity,address indexed destination,uint256 amount,bytes32 evidenceHash)',
]);
export interface RestorationBreakdown { reversedAtomic: string; poolAtomic: string; totalAtomic: string }
/** Display only confirmed reversal receipts from the current authorization lineage.
 * The relay supplies a lookup hint, never the amount or authority for an action. */
export async function readRestorationBreakdown(identity: string, request: string, transactionHash: string,
  allocation: RestorationAllocationView | null, network: OwnerChainNetwork): Promise<RestorationBreakdown> {
  const state = await readOwnerChainState(identity, network);
  const receipt = await readFinalizedReceipt(transactionHash, network);
  const topic = abi.getEvent('TheftReversed')!.topicHash;
  const events = receipt.logs.filter(log => log.topics[0] === topic && log.topics[1] === request && log.topics[2] === identity);
  if (events.length !== 1) throw Error('recourse_reversal_event_missing');
  const tag = { blockHash: state.deployment.blockHash, requireCanonical: true };
  const call = async (to: string, iface: Interface, name: string, args: readonly unknown[] = []) => {
    const values = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_call', [{ to, data: iface.encodeFunctionData(name, args) }, tag])));
    if (typeof values[0] !== 'string' || values[0] !== values[1]) throw Error('recourse_reversal_rpc_disagreement');
    return iface.decodeFunctionResult(name, values[0])[0];
  };
  let ancestor = state.executor;
  const seen = new Set<string>();
  while (ancestor !== events[0].address) {
    if (ancestor === ZeroAddress || seen.has(ancestor)) throw Error('recourse_reversal_unrelated_executor');
    seen.add(ancestor);
    ancestor = String(await call(ancestor, abi, 'previousAuthorization')).toLowerCase();
  }
  // A full reversal has no pool allocation, but must have a completed determination.
  if (!await call(state.deployment.addresses.recoursePool, RECOURSE_POOL_ABI, 'determined', [request])) throw Error('recourse_restoration_not_determined');
  const reversed = BigInt(abi.parseLog(events[0])!.args.amount), pool = BigInt(allocation?.amountAtomic ?? '0');
  if ((await network.deployment()).manifestHash !== state.deployment.manifestHash) throw Error('recourse_reversal_protocol_changed');
  return { reversedAtomic: String(reversed), poolAtomic: String(pool), totalAtomic: String(reversed + pool) };
}

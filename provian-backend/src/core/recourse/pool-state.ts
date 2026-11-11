import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { currentProtocolDeployment } from '../protocol/runtime';
import { readRecoursePoolChain, type RecoursePoolState } from './pool-chain';
import type { ProtocolDeployment } from '../protocol/pointer';
export { RECOURSE_POOL_ABI } from './pool-abi';
export type { RecoursePoolState } from './pool-chain';

export interface RecoursePoolConfig { readonly address: string; readonly runtimeHash: string }
export async function recoursePoolConfig(): Promise<RecoursePoolConfig> {
  const deployment = await currentProtocolDeployment();
  return { address: deployment.addresses.recoursePool.toLowerCase(), runtimeHash: deployment.runtimeHashes[8].toLowerCase() };
}

/** Only public address consent, current rules and reserves. Authenticated private
 * calendar data is combined separately; it cannot be reconstructed from chain. */
export async function readRecoursePoolState(identity: string, checkpoint?: ProtocolDeployment): Promise<RecoursePoolState> {
  const legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  // Reuse the caller's authenticated checkpoint for one coherent signing
  // decision. The reader still re-resolves the current manifest afterward.
  let initial = checkpoint;
  return readRecoursePoolChain(identity, { deployment: async () => {
    if (initial) { const selected = initial; initial = undefined; return selected; }
    return currentProtocolDeployment();
  }, rpcs: [
    { request: (method, params) => legs[0].provider.send(method, [...params]) },
    { request: (method, params) => legs[1].provider.send(method, [...params]) },
  ] });
}

/** Canonical historical state for private accounting, never transaction authority. */
export async function readHistoricalRecoursePoolState(identity: string,
  checkpoint: { readonly block: number; readonly blockHash: string }): Promise<RecoursePoolState> {
  const { resolveHistoricalProtocolDeployment } = await import('../protocol/pointer');
  const { PROTOCOL_POINTER_PIN } = await import('../protocol/pointer-pin.generated');
  const { createRecourseChainPort } = await import('./chain-ledger');
  const legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  const rpcs = [{ request: (m: string, p: readonly unknown[]) => legs[0].provider.send(m, [...p]) },
    { request: (m: string, p: readonly unknown[]) => legs[1].provider.send(m, [...p]) }] as const;
  const { address, runtimeHash } = PROTOCOL_POINTER_PIN;
  if (!address || !runtimeHash || checkpoint.block > await createRecourseChainPort().finalizedBlock()) throw Error('recourse_pool_checkpoint_unavailable');
  return readRecoursePoolChain(identity, { rpcs, deployment: () => resolveHistoricalProtocolDeployment(rpcs,
    address, runtimeHash, checkpoint.block, checkpoint.blockHash) });
}

import { Interface } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { resolveHistoricalProtocolDeployment, type PointerRpc } from '../protocol/pointer';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';
import { createRecourseChainPort } from './chain-ledger';
import { RECOURSE_POOL_ABI } from './pool-abi';

export interface MembershipDomainCheckpoint {
  readonly pool: string; readonly kernel: string; readonly block: number; readonly blockHash: string;
}
export interface MembershipSuccessionCheckpoint {
  readonly cutoff: MembershipDomainCheckpoint;
  readonly successor: MembershipDomainCheckpoint;
}
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)', 'function cryptographicBreak() view returns(bool)', 'function kernel() view returns(address)']);
const fail = (reason: string): never => { throw Error(`recourse_membership_checkpoint_${reason}`); };

/** Walk authenticated successor snapshots backwards when a relay owner has
 * missed multiple changes. Return only the immediate successor of its stored
 * domain. The actual calendar bridge separately verifies activation and state. */
export async function findMembershipSuccessionCheckpoint(source: { readonly pool: string; readonly kernel: string }): Promise<MembershipSuccessionCheckpoint | null> {
  if (![source.pool,source.kernel].every(a => /^0x[0-9a-f]{40}$/.test(a))) return fail('source');
  const legs = getOperatorBoundRpcLegs('base');
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) return fail('operators');
  const rpcs: readonly [PointerRpc, PointerRpc] = [{ request: (m,p) => legs[0].provider.send(m,[...p]) }, { request: (m,p) => legs[1].provider.send(m,[...p]) }];
  const agree = async (method: string, params: readonly unknown[]) => {
    const [a,b] = await Promise.all(rpcs.map(r => r.request(method,params)));
    if (!rpcChainFactsEqual(a,b)) return fail('disagreement'); return a;
  };
  const pointer = PROTOCOL_POINTER_PIN.address, pin = PROTOCOL_POINTER_PIN.runtimeHash;
  if (!pointer || !pin) return fail('pointer');
  const chain = createRecourseChainPort(); let block = await chain.finalizedBlock(), blockHash = await chain.blockHash(block);
  if (!blockHash) return fail('block');
  let deployment = await resolveHistoricalProtocolDeployment(rpcs,pointer,pin,block,blockHash);
  const visited = new Set<string>();
  for (;;) {
    const kernel = deployment.addresses.kernel.toLowerCase(), pool = deployment.addresses.recoursePool.toLowerCase();
    if (pool === source.pool && kernel === source.kernel) return null;
    if (visited.has(pool) || pool === source.pool || kernel === source.kernel) return fail('ancestry'); visited.add(pool);
    const tag = { blockHash, requireCanonical: true };
    const call = async (to: string, contract: Interface, method: string) => {
      const raw = await agree('eth_call',[{ to, data: contract.encodeFunctionData(method) },tag]);
      if (typeof raw !== 'string') return fail('reply'); return contract.decodeFunctionResult(method,raw);
    };
    const snapshot = await call(pool,RECOURSE_POOL_ABI,'poolSnapshot'), cutoffBlock = Number(snapshot[1]);
    if (!Number.isSafeInteger(cutoffBlock) || cutoffBlock < 0 || cutoffBlock >= block || snapshot[3] === 0n
      || (await call(pool,RECOURSE_POOL_ABI,'poolHistoryReady'))[0] !== true
      || String((await call(pool,RECOURSE_POOL_ABI,'token'))[0]).toLowerCase() !== kernel) return fail('snapshot');
    const cutoffHash = await chain.blockHash(cutoffBlock); if (!cutoffHash) return fail('block');
    const prior = await resolveHistoricalProtocolDeployment(rpcs,pointer,pin,cutoffBlock,cutoffHash);
    const priorPool = prior.addresses.recoursePool.toLowerCase(), priorKernel = prior.addresses.kernel.toLowerCase();
    const executor = String((await call(kernel,abi,'ownerAuthorization'))[0]).toLowerCase();
    if (String(snapshot[0]).toLowerCase() !== priorPool || String((await call(executor,abi,'kernel'))[0]).toLowerCase() !== kernel
      || String((await call(executor,abi,'predecessor'))[0]).toLowerCase() !== priorKernel
      || (await call(executor,abi,'lastGoodBlock'))[0] !== snapshot[1]
      || (await call(executor,abi,'cryptographicBreak'))[0] !== snapshot[4]) return fail('ancestry');
    if (priorPool === source.pool && priorKernel === source.kernel) {
      return { cutoff: { pool: priorPool, kernel: priorKernel, block: cutoffBlock, blockHash: cutoffHash },
        successor: { pool, kernel, block, blockHash } };
    }
    deployment = prior; block = cutoffBlock; blockHash = cutoffHash;
  }
}

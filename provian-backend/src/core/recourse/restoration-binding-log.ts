import { Interface } from 'ethers';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';
import type { LossSnapshot } from './loss-snapshot';
export const HISTORICAL_BINDING_ABI = new Interface(['function registryOperator() view returns(address)',
  'function protocolPointer() view returns(address)', 'function pointer() view returns(address)',
  'function previousRegistry() view returns(address)', 'function ownerOf(address) view returns(bytes32)',
  'function boundBlock(address) view returns(uint256)',
  'event OwnershipBound(bytes32 indexed identity,address indexed account,address indexed kernel,bytes32 recoveryCommitment,bytes32 signingRoot,bytes32 digest)',
  'event RecoveredAddressBound(bytes32 indexed identity,address indexed account,address indexed kernel)']);
export interface HistoricalBindingLogPort {
  call(target: string, method: string, args: readonly unknown[], pin: string): Promise<unknown>;
  logs(registry: string, identity: string, account: string, block: number): Promise<readonly CanonicalEconomicLog[]>;
  blockHash(block: number): Promise<string | null>;
}
const zero = `0x${'0'.repeat(40)}`;
function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw Error('recourse_execution_binding_invalid');
  return value.toLowerCase();
}
/** The original loss kernel's registry establishes first binding, even after a
 * reset. Never substitute a missing current binding or a latest-state read for
 * this historical fact. An inherited same-block binding is located in its
 * immutable registry ancestry, preserving its exact ordering before the loss. */
export async function readHistoricalBindingLog(loss: LossSnapshot, port: HistoricalBindingLogPort): Promise<number> {
  const account = loss.outflows[0]?.from;
  if (!account || !/^0x[0-9a-f]{64}$/.test(loss.blockHash) || !Number.isSafeInteger(loss.block) || loss.block < 1) throw Error('recourse_execution_loss_missing');
  const call = (target: string, method: string, args: readonly unknown[] = []) => port.call(target, method, args, loss.blockHash);
  const original = address(await call(loss.kernel, 'registryOperator')), pointer = address(await call(loss.kernel, 'protocolPointer'));
  if (original === zero || pointer === zero || address(await call(original, 'pointer')) !== pointer) throw Error('recourse_execution_binding_invalid');
  const bound = await call(original, 'boundBlock', [account]);
  if (typeof bound !== 'bigint' || bound < 1n || bound > BigInt(loss.block) || await call(original, 'ownerOf', [account]) !== loss.identity) {
    throw Error('recourse_execution_binding_invalid');
  }
  let index = 0;
  if (bound === BigInt(loss.block)) {
    const seen = new Set<string>(), positions = new Set<number>(); let registry = original;
    while (registry !== zero) {
      if (seen.has(registry) || address(await call(registry, 'pointer')) !== pointer) throw Error('recourse_execution_binding_invalid');
      seen.add(registry);
      for (const log of await port.logs(registry, loss.identity, account, loss.block)) {
        const decoded = HISTORICAL_BINDING_ABI.parseLog({ topics: [...log.topics], data: log.data });
        if (log.removed || log.address !== registry || log.blockNumber !== loss.block || log.blockHash !== loss.blockHash
          || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || positions.has(log.logIndex)
          || !decoded || !['OwnershipBound', 'RecoveredAddressBound'].includes(decoded.name)
          || decoded.args.identity !== loss.identity || String(decoded.args.account).toLowerCase() !== account) throw Error('recourse_execution_binding_invalid');
        positions.add(log.logIndex);
      }
      registry = address(await call(registry, 'previousRegistry'));
    }
    if (positions.size === 0) throw Error('recourse_execution_binding_invalid');
    index = Number.MAX_SAFE_INTEGER;
    for (const position of positions) index = Math.min(index, position);
    if (index >= loss.firstOutflowLogIndex) throw Error('recourse_execution_binding_invalid');
  }
  if (await port.blockHash(loss.block) !== loss.blockHash) throw Error('recourse_execution_binding_reorg');
  return index;
}

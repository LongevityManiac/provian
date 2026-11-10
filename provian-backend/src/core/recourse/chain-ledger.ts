import { ethers } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import type { EconomicStateRpcLeg } from '../onchain/economic-state';
import { getAgreedBaseLogs, readAgreedBaseBlockHash, ERC20_TRANSFER_TOPIC,
  type CanonicalEconomicLog } from '../onchain/economic-discovery';
import { registeredBalanceAt, type RegisteredAddress, type TransferEvent } from './ownership';

const tokenInterface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

export interface RecourseChainPort {
  finalizedBlock(): Promise<number>;
  blockHash(block: number): Promise<string | null>;
  balance(kernel: string, address: string, blockHash: string): Promise<bigint>;
  transfers(kernel: string, address: string, from: number, through: number): Promise<readonly TransferEvent[]>;
}

function decodeTransfer(log: CanonicalEconomicLog, kernel: string, address: string,
  from: number, through: number): TransferEvent {
  if (log.removed || log.address !== kernel || log.topics.length !== 3
    || log.topics[0] !== ERC20_TRANSFER_TOPIC || !WORD.test(log.data)
    || !/^0x0{24}[0-9a-f]{40}$/.test(log.topics[1])
    || !/^0x0{24}[0-9a-f]{40}$/.test(log.topics[2])
    || log.blockNumber < from || log.blockNumber > through) throw new Error('recourse_transfer_log_invalid');
  const sender = `0x${log.topics[1].slice(26)}`;
  const recipient = `0x${log.topics[2].slice(26)}`;
  if (sender !== address && recipient !== address) throw new Error('recourse_transfer_log_unrelated');
  return { block: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash,
    logIndex: log.logIndex, from: sender, to: recipient, amountAtomic: BigInt(log.data).toString() };
}

/** Uses the existing guarded RPC transport, two independently operated providers and hash-pinned calls. */
export function createRecourseChainPort(testLegs?: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg]): RecourseChainPort {
  const configured = testLegs ? undefined : getOperatorBoundRpcLegs('base');
  const legs: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg] = testLegs ?? [
    { operatorId: configured![0].operatorId, send: (method, params) => configured![0].provider.send(method, [...params]) },
    { operatorId: configured![1].operatorId, send: (method, params) => configured![1].provider.send(method, [...params]) },
  ];
  if (!legs[0].operatorId || !legs[1].operatorId || legs[0].operatorId === legs[1].operatorId) {
    throw new Error('recourse_rpc_operators_not_independent');
  }
  const options = { rpcLegs: legs };
  return {
    async finalizedBlock() {
      const tips = await Promise.all(legs.map(leg => leg.send('eth_getBlockByNumber', ['finalized', false])));
      const heights = tips.map(tip => {
        if (!tip || typeof tip !== 'object' || !('number' in tip) || typeof tip.number !== 'string'
          || !/^0x[0-9a-f]+$/i.test(tip.number)) throw new Error('recourse_finality_unavailable');
        const height = Number(BigInt(tip.number));
        if (!Number.isSafeInteger(height) || height < 0) throw new Error('recourse_finality_unavailable');
        return height;
      });
      const height = Math.min(...heights);
      if (!await readAgreedBaseBlockHash(height, options)) throw new Error('recourse_finality_unavailable');
      return height;
    },
    blockHash: block => readAgreedBaseBlockHash(block, options),
    async balance(kernel, address, blockHash) {
      if (!ADDRESS.test(kernel) || !ADDRESS.test(address) || !HASH.test(blockHash)) throw new Error('recourse_balance_input_invalid');
      const ids = await Promise.all(legs.map(leg => leg.send('eth_chainId', [])));
      if (ids.some(id => id !== '0x2105')) throw new Error('recourse_rpc_chain_invalid');
      const params = [{ to: kernel, data: tokenInterface.encodeFunctionData('balanceOf', [address]) },
        { blockHash, requireCanonical: true }];
      const results = await Promise.all(legs.map(leg => leg.send('eth_call', params)));
      if (results.some(result => typeof result !== 'string' || !WORD.test(result))) throw new Error('recourse_balance_reply_invalid');
      const left = BigInt(results[0] as string);
      if (left !== BigInt(results[1] as string)) throw new Error('recourse_balance_rpc_disagreement');
      return left;
    },
    async transfers(kernel, address, from, through) {
      const topic = ethers.zeroPadValue(address, 32);
      const [outbound, inbound] = await Promise.all([
        getAgreedBaseLogs({ address: kernel, topics: [ERC20_TRANSFER_TOPIC, topic], fromBlock: from, toBlock: through }, options),
        getAgreedBaseLogs({ address: kernel, topics: [ERC20_TRANSFER_TOPIC, null, topic], fromBlock: from, toBlock: through }, options),
      ]);
      // A self-transfer appears once in each query. All other repeated or conflicting logs fail closed.
      const unique = new Map<string, TransferEvent>();
      for (const [lane, logs] of [outbound, inbound].entries()) {
        const laneKeys = new Set<string>();
        for (const log of logs) {
          const event = decodeTransfer(log, kernel, address, from, through);
          const key = `${event.transactionHash}:${event.logIndex}`;
          if (laneKeys.has(key)) throw new Error('recourse_transfer_log_duplicate');
          laneKeys.add(key);
          const previous = unique.get(key);
          if (previous && (lane !== 1 || event.from !== address || event.to !== address
            || JSON.stringify(previous) !== JSON.stringify(event))) throw new Error('recourse_transfer_log_conflict');
          unique.set(key, event);
        }
      }
      return [...unique.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    },
  };
}

export interface RegisteredBalanceSnapshot {
  readonly binding: RegisteredAddress;
  readonly throughBlock: number;
  readonly throughBlockHash: string;
  readonly balanceAtomic: string;
  readonly mintedAtomic: string;
  readonly receivedAtomic: string;
  readonly events: readonly TransferEvent[];
}

/** A ledger is accepted only when both endpoints and every event block remain canonical,
 * and its result equals the independently read token balance at the exact terminal hash. */
export async function snapshotRegisteredBalance(binding: RegisteredAddress, through: number,
  chain: RecourseChainPort = createRecourseChainPort()): Promise<RegisteredBalanceSnapshot> {
  if (!Number.isSafeInteger(through) || through < binding.boundBlock) throw new Error('recourse_snapshot_range_invalid');
  if (through > await chain.finalizedBlock()) throw new Error('recourse_snapshot_not_finalized');
  const [openingHash, terminalHash] = await Promise.all([chain.blockHash(binding.boundBlock), chain.blockHash(through)]);
  if (openingHash !== binding.boundBlockHash || !terminalHash || !HASH.test(terminalHash)) throw new Error('recourse_snapshot_reorg');
  const events = through === binding.boundBlock ? [] : await chain.transfers(binding.kernel, binding.address, binding.boundBlock + 1, through);
  const reduced = registeredBalanceAt(binding, events, through);
  const blocks = new Map<number, string>([[binding.boundBlock, openingHash], [through, terminalHash]]);
  for (const event of events) {
    const existing = blocks.get(event.block);
    if (existing && existing !== event.blockHash) throw new Error('recourse_snapshot_reorg');
    blocks.set(event.block, event.blockHash);
  }
  // Bound concurrent requests: large holders' histories must not fan out unbounded RPCs.
  for (const [block, hash] of blocks) {
    if (await chain.blockHash(block) !== hash) throw new Error('recourse_snapshot_reorg');
  }
  const balance = await chain.balance(binding.kernel, binding.address, terminalHash);
  if (balance !== reduced.balanceAtomic) throw new Error('recourse_ledger_incomplete');
  if (await chain.blockHash(through) !== terminalHash) throw new Error('recourse_snapshot_reorg');
  return { binding, throughBlock: through, throughBlockHash: terminalHash, balanceAtomic: balance.toString(),
    mintedAtomic: reduced.mintedAtomic.toString(), receivedAtomic: reduced.receivedAtomic.toString(), events };
}

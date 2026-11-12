import { Interface, ZeroAddress, formatUnits } from 'ethers';
import type { Transaction } from '../history/TransactionHistoryService';
import type { OwnerChainNetwork } from './owner-chain';

export interface TheftTransfer {
  readonly transactionHash: string; readonly from: string; readonly to: string;
  readonly amount: string; readonly timestamp: number;
}
export interface VerifiedTheftTransfer extends TheftTransfer { readonly block: number }
const TOKEN = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const fail = (): never => { throw Error('recourse_transfer_history_unavailable'); };
/** History supplies the selection, never restoration authority. Burn, incoming,
 * pending and retired-token entries cannot masquerade as an outgoing PVT loss. */
export function theftTransferChoices(rows: readonly Transaction[], account: string, kernel: string): readonly TheftTransfer[] {
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if (row.chain !== 'Base' || row.status !== 'confirmed' || row.isRetiredPvt
      || row.contractAddress?.toLowerCase() !== kernel.toLowerCase() || row.from.toLowerCase() !== account.toLowerCase()
      || row.to.toLowerCase() === account.toLowerCase() || row.to.toLowerCase() === ZeroAddress
      || !/^0x[0-9a-f]{64}$/i.test(row.hash) || !/^0x[0-9a-f]{40}$/i.test(row.to)
      || !Number.isFinite(row.timestamp) || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(row.amount)
      || !/[1-9]/.test(row.amount)) return [];
    const key = `${row.hash.toLowerCase()}:${row.to.toLowerCase()}`;
    if (seen.has(key)) return []; seen.add(key);
    return [{ transactionHash: row.hash.toLowerCase(), from: account.toLowerCase(), to: row.to.toLowerCase(), amount: row.amount, timestamp: row.timestamp }];
  });
}
function record(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string,unknown>;
}
/** Resolve the block and actual transfer from two canonical chain views. No
 * transaction hash or block number is ever requested from the member. */
export async function verifyTheftTransfer(selected: TheftTransfer, account: string, network: OwnerChainNetwork): Promise<VerifiedTheftTransfer> {
  if (selected.from !== account.toLowerCase() || !/^0x[0-9a-f]{64}$/.test(selected.transactionHash)) return fail();
  const deployment = await network.deployment(), kernel = deployment.addresses.kernel.toLowerCase();
  const facts = await Promise.all(network.rpcs.map(async rpc => {
    const receipt = record(await rpc.request('eth_getTransactionReceipt',[selected.transactionHash]));
    if (receipt.transactionHash !== selected.transactionHash || receipt.status !== '0x1'
      || typeof receipt.blockNumber !== 'string' || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber)
      || typeof receipt.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(receipt.blockHash) || !Array.isArray(receipt.logs)) return fail();
    const block = Number(BigInt(receipt.blockNumber));
    const finalized=record(await rpc.request('eth_getBlockByNumber',['finalized',false]));
    if (typeof finalized.number !== 'string' || !/^0x[0-9a-f]+$/i.test(finalized.number)
      || !Number.isSafeInteger(block) || block < 1 || BigInt(block) > BigInt(finalized.number)) return fail();
    const canonical = record(await rpc.request('eth_getBlockByNumber',[receipt.blockNumber,false]));
    if (canonical.hash !== receipt.blockHash || typeof canonical.timestamp !== 'string' || !/^0x[0-9a-f]+$/i.test(canonical.timestamp)) return fail();
    let amount = 0n;
    for (const raw of receipt.logs) {
      const log = record(raw);
      if (typeof log.address !== 'string' || log.address.toLowerCase() !== kernel || !Array.isArray(log.topics)
        || log.topics[0] !== TOKEN.getEvent('Transfer')!.topicHash) continue;
      if (log.removed === true || log.transactionHash !== selected.transactionHash || log.blockHash !== receipt.blockHash
        || typeof log.data !== 'string' || !log.topics.every(t => typeof t === 'string')) return fail();
      const transfer = TOKEN.parseLog({data:log.data,topics:log.topics as string[]});
      if (transfer?.args.from.toLowerCase() === account.toLowerCase() && transfer.args.to.toLowerCase() === selected.to) amount += BigInt(transfer.args.value);
    }
    if (amount <= 0n) return fail();
    const timestamp=Number(BigInt(canonical.timestamp))*1000;
    if (!Number.isSafeInteger(timestamp)) return fail();
    return { ...selected, block, blockHash:receipt.blockHash, timestamp, amount:formatUnits(amount,18) };
  }));
  if (JSON.stringify(facts[0]) !== JSON.stringify(facts[1]) || (await network.deployment()).manifestHash !== deployment.manifestHash) return fail();
  return facts[0];
}

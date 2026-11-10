import type { OwnerChainNetwork } from './recourse-owner-chain';
export interface FinalizedLog { address: string; topics: string[]; data: string; }
export interface FinalizedReceipt { transactionHash: string; blockHash: string; blockNumber: bigint; logs: FinalizedLog[]; }
const hash = /^0x[0-9a-f]{64}$/;
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('finalized_receipt_invalid');
  return raw as Record<string, unknown>;
}
function quantity(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(raw)) throw Error('finalized_receipt_invalid');
  return BigInt(raw);
}
function facts(raw: unknown, transactionHash: string): FinalizedReceipt {
  const r = object(raw);
  if (r.transactionHash !== transactionHash || typeof r.blockHash !== 'string' || !hash.test(r.blockHash)
    || quantity(r.status) !== 1n || !Array.isArray(r.logs)) throw Error('finalized_receipt_invalid');
  return { transactionHash, blockHash: r.blockHash, blockNumber: quantity(r.blockNumber), logs: r.logs.map(rawLog => {
    const log = object(rawLog);
    if (log.removed === true || log.transactionHash !== transactionHash || log.blockHash !== r.blockHash
      || typeof log.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(log.address)
      || typeof log.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(log.data)
      || !Array.isArray(log.topics) || !log.topics.every(t => typeof t === 'string' && hash.test(t))) throw Error('finalized_receipt_invalid');
    return { address: log.address.toLowerCase(), topics: log.topics as string[], data: log.data };
  }) };
}
/** Provider annotations are irrelevant; every consumed chain fact must agree.
 * Receipt status alone cannot establish the success of a nested account call. */
export async function readFinalizedReceipt(transactionHash: string, network: OwnerChainNetwork): Promise<FinalizedReceipt> {
  if (!hash.test(transactionHash)) throw Error('finalized_receipt_invalid');
  const receipts = await Promise.all(network.rpcs.map(async rpc => facts(await rpc.request('eth_getTransactionReceipt', [transactionHash]), transactionHash)));
  const encode = (r: FinalizedReceipt) => JSON.stringify(r, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
  if (encode(receipts[0]) !== encode(receipts[1])) throw Error('finalized_receipt_disagreement');
  const receipt = receipts[0];
  await Promise.all(network.rpcs.map(async rpc => {
    if (quantity(object(await rpc.request('eth_getBlockByNumber', ['finalized', false])).number) < receipt.blockNumber) throw Error('finalized_receipt_pending');
    const header = object(await rpc.request('eth_getBlockByNumber', [`0x${receipt.blockNumber.toString(16)}`, false]));
    if (header.hash !== receipt.blockHash || quantity(header.number) !== receipt.blockNumber) throw Error('finalized_receipt_reorg');
  }));
  return receipt;
}

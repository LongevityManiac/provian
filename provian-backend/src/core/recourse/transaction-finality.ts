import { Transaction, keccak256 } from 'ethers';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import type { EconomicStateRpcLeg } from '../onchain/economic-state';
import { BASE_ECONOMIC_FINALITY_CONFIRMATIONS } from '../onchain/economic-constants';

/** A Recourse transaction is done at the same depth as all other Base economic
 * evidence the relay accepts: twelve confirmations, the inclusion block counted. */
export const RECOURSE_CONFIRMATIONS = BASE_ECONOMIC_FINALITY_CONFIRMATIONS;
/** True when `block` has at least twelve confirmations at `head`. */
export function hasRecourseConfirmations(block: bigint, head: bigint): boolean {
  return block >= 0n && head >= block && head - block + 1n >= BigInt(RECOURSE_CONFIRMATIONS);
}

export interface FinalizedOwnerTransaction {
  readonly transactionHash: string; readonly blockHash: string; readonly block: number;
  readonly status: 0 | 1;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_transaction_reply_invalid');
  return value as Record<string, unknown>;
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('recourse_transaction_reply_invalid');
  return BigInt(value);
}
/** Nonce reconciliation deliberately does not require today's identity state.
 * A canonical confirmed revert consumes a nonce just as a success does. Each
 * independent RPC must see twelve confirmations on its own head. This result
 * never authorizes credential installation or restoration of funds. */
export async function finalizedOwnerTransaction(raw: string,
  testLegs?: readonly [EconomicStateRpcLeg, EconomicStateRpcLeg]): Promise<FinalizedOwnerTransaction | null> {
  const tx = Transaction.from(raw), hash = keccak256(raw);
  if (!tx.signature || tx.chainId !== 8453n || !tx.from) throw new Error('recourse_transaction_invalid');
  const configured = testLegs ? undefined : getOperatorBoundRpcLegs('base');
  const legs = testLegs ?? configured!.map(leg => ({ operatorId: leg.operatorId,
    send: (method: string, params: readonly unknown[]) => leg.provider.send(method, [...params]) }));
  if (legs.length !== 2 || !legs[0].operatorId || legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  const results = await Promise.all(legs.map(async leg => {
    if (quantity(await leg.send('eth_chainId', [])) !== 8453n) throw new Error('recourse_rpc_chain_invalid');
    const value = await leg.send('eth_getTransactionReceipt', [hash]);
    if (value === null) return null;
    const receipt = object(value), status = quantity(receipt.status), block = quantity(receipt.blockNumber);
    if (receipt.transactionHash !== hash || (status !== 0n && status !== 1n)
      || typeof receipt.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(receipt.blockHash)
      || block > BigInt(Number.MAX_SAFE_INTEGER) || receipt.from?.toString().toLowerCase() !== tx.from!.toLowerCase()
      || receipt.to?.toString().toLowerCase() !== tx.to?.toLowerCase()) throw new Error('recourse_transaction_receipt_invalid');
    if (!hasRecourseConfirmations(block, quantity(await leg.send('eth_blockNumber', [])))) throw new Error('recourse_transaction_not_finalized');
    const tag = `0x${block.toString(16)}`;
    const canonical = object(await leg.send('eth_getBlockByNumber', [tag, false]));
    if (canonical.hash !== receipt.blockHash || !Array.isArray(canonical.transactions)
      || !canonical.transactions.includes(hash)) throw new Error('recourse_transaction_reorg');
    const nonce = quantity(await leg.send('eth_getTransactionCount', [tx.from,
      { blockHash: receipt.blockHash, requireCanonical: true }]));
    if (nonce <= BigInt(tx.nonce)) throw new Error('recourse_transaction_nonce_not_consumed');
    if (object(await leg.send('eth_getBlockByNumber', [tag, false])).hash !== receipt.blockHash) throw new Error('recourse_transaction_reorg');
    return { transactionHash: hash, blockHash: receipt.blockHash, block: Number(block), status: Number(status) as 0 | 1 };
  }));
  if (JSON.stringify(results[0]) !== JSON.stringify(results[1])) throw new Error('recourse_transaction_rpc_disagreement');
  return results[0];
}

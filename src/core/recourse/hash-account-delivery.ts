import { sha256, toUtf8Bytes } from 'ethers';
import { hashAccountCall, type SignedHashAccountOperation } from './hash-account-data';
import type { OwnerChainNetwork } from './owner-chain';
import { assertCurrentProtocolTransaction } from '../protocol/transaction';

export type HashDeliveryOutcome = 'succeeded' | 'target_failed' | 'cancelled';
export interface HashDeliveryAttempt { readonly id: string; readonly hash: string | null; readonly reverted: boolean }
export interface HashDeliveryRecord {
  readonly version: 1; readonly operation: string; readonly sender: string;
  readonly attempts: readonly HashDeliveryAttempt[];
  readonly complete: { readonly hash: string; readonly outcome: HashDeliveryOutcome } | null;
}
export interface HashDeliveryPorts {
  readonly network: OwnerChainNetwork;
  readonly sender: string;
  read(id: string): Promise<HashDeliveryRecord | null>;
  /** Durable encrypted write with readback, before broadcasting or rotating. */
  write(id: string, record: HashDeliveryRecord): Promise<void>;
  /** Persist exact signed gas transaction before broadcast. The same id must
   * resume those bytes, including when the caller lost the first response. */
  send(id: string, transaction: { readonly to: string; readonly data: string; readonly value: '0'; readonly chainId: 8453 }): Promise<string>;
  /** Read an already persisted exact gas transaction without rebroadcast. */
  recover(id: string): Promise<string | null>;
  complete(transactionHash: string): Promise<HashDeliveryOutcome>;
}
export type HashDeliveryResult = { readonly status: 'pending' | 'outer_reverted'; readonly transactionHash: string }
  | { readonly status: 'complete'; readonly transactionHash: string; readonly outcome: HashDeliveryOutcome };
const hash = /^0x[0-9a-f]{64}$/;
const fail = (): never => { throw Error('hash_delivery_invalid'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) return fail();
  return BigInt(value);
}
export function hashDeliveryId(operation: SignedHashAccountOperation): string {
  return sha256(toUtf8Bytes(hashAccountCall(operation)));
}
function attemptId(id: string, index: number): string { return sha256(toUtf8Bytes(`${id}:${index}`)); }
/** Verify exact transaction, canonical inclusion and finality with independent
 * readers. A failed outer transaction does not consume the account signing key. */
async function receiptStatus(operation: SignedHashAccountOperation, sender: string, transactionHash: string, network: OwnerChainNetwork): Promise<'unmined' | 'pending' | 'success' | 'reverted'> {
  const raw = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getTransactionReceipt', [transactionHash])));
  if (raw.every(value => value === null)) return 'unmined';
  const receipts = raw.map(value => {
    const row = object(value);
    if (row.transactionHash !== transactionHash || typeof row.blockHash !== 'string' || !hash.test(row.blockHash)) return fail();
    const block = quantity(row.blockNumber), status = quantity(row.status);
    if (status !== 0n && status !== 1n) return fail();
    return { blockHash: row.blockHash, block: String(block), status: String(status) };
  });
  if (JSON.stringify(receipts[0]) !== JSON.stringify(receipts[1])) throw Error('hash_delivery_rpc_disagreement');
  const receipt = receipts[0];
  const finalized = await Promise.all(network.rpcs.map(async rpc => {
    const transaction = object(await rpc.request('eth_getTransactionByHash', [transactionHash]));
    if (transaction.hash !== transactionHash || transaction.blockHash !== receipt.blockHash
      || typeof transaction.from !== 'string' || transaction.from.toLowerCase() !== sender
      || typeof transaction.to !== 'string' || transaction.to.toLowerCase() !== operation.account
      || typeof transaction.input !== 'string' || transaction.input.toLowerCase() !== hashAccountCall(operation)
      || quantity(transaction.value) !== 0n) return fail();
    const head = object(await rpc.request('eth_getBlockByNumber', ['finalized', false]));
    return quantity(head.number) >= BigInt(receipt.block);
  }));
  // Finality reads may cross a reorg. Canonical inclusion is checked again
  // after both heads, before a revert releases this gas attempt.
  await Promise.all(network.rpcs.map(async rpc => {
    const canonical = object(await rpc.request('eth_getBlockByNumber', [`0x${BigInt(receipt.block).toString(16)}`, false]));
    if (canonical.hash !== receipt.blockHash || quantity(canonical.number) !== BigInt(receipt.block)) throw Error('hash_delivery_reorg');
  }));
  if (!finalized.every(Boolean)) return 'pending';
  return receipt.status === '1' ? 'success' : 'reverted';
}
/** Caller serializes access to this journal. One invocation makes one delivery
 * attempt; only a proven finalized outer revert permits a new gas nonce. */
export async function deliverHashAccountOperation(operation: SignedHashAccountOperation, ports: HashDeliveryPorts): Promise<HashDeliveryResult> {
  const id = hashDeliveryId(operation), data = hashAccountCall(operation);
  if (!/^0x[0-9a-f]{40}$/.test(ports.sender)) return fail();
  let record = await ports.read(id);
  if (record) {
    if (record.version !== 1 || record.operation !== id || record.sender !== ports.sender || !Array.isArray(record.attempts)
      || record.attempts.some((a, i) => a.id !== attemptId(id, i) || typeof a.reverted !== 'boolean'
        || (a.hash !== null && !hash.test(a.hash)) || (a.reverted && a.hash === null) || (i < record!.attempts.length - 1 && !a.reverted))) return fail();
    if (record.complete) {
      if (!hash.test(record.complete.hash) || !['succeeded', 'target_failed', 'cancelled'].includes(record.complete.outcome)
        || !record.attempts.some(a => a.hash === record!.complete!.hash && !a.reverted)) return fail();
      return { status: 'complete', transactionHash: record.complete.hash, outcome: record.complete.outcome };
    }
  } else record = { version: 1, operation: id, sender: ports.sender, attempts: [], complete: null };
  let last = record.attempts.at(-1);
  if (last?.hash && !last.reverted) {
    const status = await receiptStatus(operation, ports.sender, last.hash, ports.network);
    if (status === 'pending') return { status: 'pending', transactionHash: last.hash };
    if (status === 'unmined') {
      await assertCurrentProtocolTransaction(ports.network, operation.target, operation.data);
      const replayed = await ports.send(last.id, { to: operation.account, data, value: '0', chainId: 8453 });
      if (replayed !== last.hash) throw Error('hash_delivery_replay_changed');
      return { status: 'pending', transactionHash: last.hash };
    }
    if (status === 'success') {
      // The independently verified inner-call outcome controls key rotation.
      const outcome = await ports.complete(last.hash);
      record = { ...record, complete: { hash: last.hash, outcome } }; await ports.write(id, record);
      return { status: 'complete', transactionHash: last.hash, outcome };
    }
    record = { ...record, attempts: [...record.attempts.slice(0, -1), { ...last, reverted: true }] };
    await ports.write(id, record);
    return { status: 'outer_reverted', transactionHash: last.hash };
  }
  // A lost send response may already have a durable gas transaction. Recover
  // its hash even after retirement, without making a fresh call to that target.
  if (last && !last.reverted && last.hash === null) {
    const recovered = await ports.recover(last.id);
    if (recovered !== null) {
      if (!hash.test(recovered)) return fail();
      record = { ...record, attempts: [...record.attempts.slice(0, -1), { ...last, hash: recovered }] };
      await ports.write(id, record);
      return { status: 'pending', transactionHash: recovered };
    }
  }
  // New sends and retries independently refuse retired inner targets/spenders.
  await assertCurrentProtocolTransaction(ports.network, operation.target, operation.data);
  if (!last || last.reverted) {
    last = { id: attemptId(id, record.attempts.length), hash: null, reverted: false };
    record = { ...record, attempts: [...record.attempts, last] }; await ports.write(id, record);
  }
  const transactionHash = await ports.send(last.id, { to: operation.account, data, value: '0', chainId: 8453 });
  if (!hash.test(transactionHash)) return fail();
  record = { ...record, attempts: [...record.attempts.slice(0, -1), { ...last, hash: transactionHash }] };
  await ports.write(id, record);
  return { status: 'pending', transactionHash };
}

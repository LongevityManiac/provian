import { matchesPlannedCall } from '../protocol/builder-code';
import * as SecureStore from 'expo-secure-store';
import { hexlify, Transaction } from 'ethers';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { ActionWallet } from '../security/ActionWallet';
import { readChainOperation } from '../security/chainNonce';
import { secureNonceStore } from '../security/secureNonceStore';
import SeedManager from '../wallet/SeedManager';
import TransactionService from '../wallet/TransactionService';
import { ownerChainNetwork } from '../protocol/runtime';
import { assertCurrentProtocolTransaction } from '../protocol/transaction';
import type { OwnerChainNetwork } from './owner-chain';
import { auxiliaryAccountKey } from './auxiliary-account';
import { discoverBoundHumanSpendingAccount } from './human-bound-spending';
import type { HumanHashTransferIntent } from './human-hash-transfer';
import type { HashDeliveryResult } from './hash-account-delivery';

export interface HumanCurveTransfer {
  readonly version: 1; readonly intent: HumanHashTransferIntent; readonly cancelling: false;
  readonly result: HashDeliveryResult | null;
}
const address = /^0x[0-9a-f]{40}$/, hash = /^0x[0-9a-f]{64}$/, uint = /^(0|[1-9][0-9]*)$/;
function validate(i: HumanHashTransferIntent): void {
  if (!i || Object.keys(i).sort().join(',') !== 'account,auxiliaryBinding,data,id,target,value' || !hash.test(i.id)
    || !address.test(i.account) || !address.test(i.target) || /^0x0+$/.test(i.target)
    || typeof i.auxiliaryBinding !== 'string' || !hash.test(i.auxiliaryBinding) || /^0x0+$/.test(i.auxiliaryBinding)
    || !uint.test(i.value) || BigInt(i.value) >= 2n ** 256n || !/^0x(?:[0-9a-f]{2})*$/.test(i.data)) throw Error('recourse_transfer_invalid');
}
const keyFor = (account: string) => `provian_curve_transfer_${account.slice(2)}`;
async function load(key: string): Promise<HumanCurveTransfer | null> {
  const raw = await SecureStore.getItemAsync(key); if (raw === null) return null;
  const r = JSON.parse(raw) as HumanCurveTransfer; validate(r.intent);
  if (r.version !== 1 || r.cancelling !== false || (r.result !== null && (!hash.test(r.result.transactionHash)
    || !['pending', 'complete'].includes(r.result.status) || (r.result.status === 'complete'
      && !['succeeded', 'target_failed'].includes(r.result.outcome))))) throw Error('recourse_transfer_journal_invalid');
  return r;
}
async function save(key: string, value: HumanCurveTransfer): Promise<void> {
  const raw = JSON.stringify(value);
  await SecureStore.setItemAsync(key, raw, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (await SecureStore.getItemAsync(key) !== raw) throw Error('recourse_transfer_write_unconfirmed');
}
let tail: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> { const run = tail.then(fn); tail = run.catch(() => undefined); return run; }
export function readHumanCurveTransfer(account: string): Promise<HumanCurveTransfer | null> {
  return locked(async () => {
    if (!address.test(account)) throw Error('recourse_transfer_invalid');
    const record = await load(keyFor(account));
    if (record && record.intent.account !== account) throw Error('recourse_transfer_journal_invalid');
    return record;
  });
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('recourse_transfer_receipt_invalid');
  return raw as Record<string, unknown>;
}
function quantity(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(raw)) throw Error('recourse_transfer_receipt_invalid');
  return BigInt(raw);
}
/** Receipt-only inspection also works after a later recovery. It never signs
 * or replays a transfer just to discover whether the original one completed. */
async function inspect(intent: HumanHashTransferIntent, txHash: string, network: OwnerChainNetwork): Promise<HashDeliveryResult> {
  const pending = { status: 'pending' as const, transactionHash: txHash };
  const rows = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getTransactionReceipt', [txHash])));
  if (rows.every(r => r === null)) return pending;
  const receipts = rows.map(raw => {
    const r = object(raw);
    if (r.transactionHash !== txHash || typeof r.blockHash !== 'string' || !hash.test(r.blockHash)) throw Error('recourse_transfer_receipt_invalid');
    const block = quantity(r.blockNumber), status = quantity(r.status);
    if (status > 1n) throw Error('recourse_transfer_receipt_invalid');
    return { block: String(block), blockHash: r.blockHash, status: String(status) };
  });
  if (JSON.stringify(receipts[0]) !== JSON.stringify(receipts[1])) throw Error('recourse_transfer_receipt_disagreement');
  const receipt = receipts[0];
  for (const rpc of network.rpcs) {
    if (quantity(object(await rpc.request('eth_getBlockByNumber', ['finalized', false])).number) < BigInt(receipt.block)) return pending;
    const tx = object(await rpc.request('eth_getTransactionByHash', [txHash]));
    if (tx.hash !== txHash || tx.from !== intent.account || tx.to !== intent.target || !matchesPlannedCall(typeof tx.input === 'string' ? tx.input : undefined, intent.data)
      || quantity(tx.value) !== BigInt(intent.value) || quantity(tx.chainId) !== 8453n || tx.blockHash !== receipt.blockHash
      || quantity(tx.blockNumber) !== BigInt(receipt.block)) throw Error('recourse_transfer_receipt_invalid');
  }
  // Recheck canonical inclusion after both finality observations and transaction
  // reads. An orphan success or failure must not unlock another reviewed send.
  const blocks = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_getBlockByNumber', [`0x${BigInt(receipt.block).toString(16)}`, false])));
  if (blocks.some(block => object(block).hash !== receipt.blockHash || quantity(object(block).number) !== BigInt(receipt.block))) throw Error('recourse_transfer_receipt_reorg');
  return { status: 'complete', transactionHash: txHash, outcome: receipt.status === '1' ? 'succeeded' : 'target_failed' };
}
async function retainedHash(intent: HumanHashTransferIntent): Promise<string | null> {
  const store = secureNonceStore(), signerKey = `8453_${intent.account}`;
  let doc: Awaited<ReturnType<typeof readChainOperation>>;
  try { doc = await readChainOperation(store, signerKey, intent.id); }
  catch (error) { if (error instanceof Error && error.message === 'chain_operation_not_found') return null; throw error; }
  const index = await store.transact(signerKey, current => current ?? { version: 1, next: 0, attempts: [], owner: null, leaseUntil: 0 });
  const attempt = doc.attempts[0] ?? index.attempts.find(value => value.intent === intent.id);
  if (!attempt) return null;
  const tx = Transaction.from(attempt.raw);
  if (tx.hash !== attempt.hash || tx.from?.toLowerCase() !== intent.account || tx.chainId !== 8453n
    || tx.to?.toLowerCase() !== intent.target || tx.value !== BigInt(intent.value) || !matchesPlannedCall(tx.data, intent.data)) throw Error('recourse_transfer_nonce_invalid');
  return attempt.hash;
}
/** The encrypted nonce coordinator owns the exact signed bytes. A lost send
 * response uses the same id; only an explicitly new reviewed id can pay again. */
export function executeHumanCurveTransfer(reviewed: HumanHashTransferIntent, action: BiometricAction): Promise<HashDeliveryResult> {
  const intent = { ...reviewed };
  return locked(async () => {
    assertBiometricAction(action); validate(intent);
    const key = keyFor(intent.account), archived = await load(`${key}_${intent.id.slice(2)}`);
    let record = archived ?? await load(key);
    if (record?.intent.id === intent.id) {
      if ((Object.keys(intent) as (keyof HumanHashTransferIntent)[]).some(k => record!.intent[k] !== intent[k])) throw Error('recourse_transfer_intent_changed');
      if (record.result?.status === 'complete') return record.result;
    } else if (archived) throw Error('recourse_transfer_journal_invalid');
    else if (record && record.result?.status !== 'complete') throw Error('recourse_transfer_pending');
    else { if (record) await save(`${key}_${record.intent.id.slice(2)}`, record); record = null; }
    const network = ownerChainNetwork();
    if (record) {
      const savedHash = record.result?.transactionHash ?? await retainedHash(intent);
      if (savedHash) {
        const result = await inspect(intent, savedHash, network);
        record = { ...record, result }; await save(key, record);
        if (result.status === 'complete') return result;
      }
    }
    const mnemonic = await SeedManager.getMnemonic(action); if (!mnemonic) throw Error('recourse_seed_unavailable');
    const bound = await discoverBoundHumanSpendingAccount(mnemonic, intent.auxiliaryBinding!, network);
    if (bound.kind !== 'curve' || bound.account !== intent.account) throw Error('recourse_transfer_wrong_account');
    const deployment = await assertCurrentProtocolTransaction(network, intent.target, intent.data);
    if (deployment.manifestHash !== bound.manifestHash) throw Error('recourse_transfer_state_changed');
    const seed = await auxiliaryAccountKey(mnemonic, intent.auxiliaryBinding!, bound.generation);
    try {
      const signer = new ActionWallet(hexlify(seed), action, TransactionService.providerFor(8453), intent.id);
      if (signer.address.toLowerCase() !== intent.account) throw Error('recourse_transfer_wrong_account');
      if (!record) { record = { version: 1, intent, cancelling: false, result: null }; assertBiometricAction(action); await save(key, record); }
      const tx = await signer.sendTransaction({ to: intent.target, value: intent.value, data: intent.data, chainId: 8453 });
      if (!hash.test(tx.hash) || (record.result && record.result.transactionHash !== tx.hash)) throw Error('recourse_transfer_intent_changed');
      record = { ...record, result: { status: 'pending', transactionHash: tx.hash } }; await save(key, record);
      const result = await inspect(intent, tx.hash, network); await save(key, { ...record, result }); return result;
    } finally { seed.fill(0); }
  });
}

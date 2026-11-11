import * as SecureStore from 'expo-secure-store';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { ownerChainNetwork } from '../protocol/runtime';
import { assertCurrentProtocolTransaction } from '../protocol/transaction';
import SeedManager from '../wallet/SeedManager';
import { useWalletStore } from '../../store/walletStore';
import { deriveHumanAccount, readHumanAccountSelection, discoverHumanHashAccountSelection } from './human-account';
import { discoverBoundHumanHashAccount } from './human-bound-hash-account';
import { prepareHumanHashSpending, cancelHumanHashSpending, readHumanHashSpendingDelivery, type HumanHashCall } from './human-hash-spending';
import { deliverHumanHashSpending, reconcileHumanHashSpending } from './human-hash-delivery';
import { hashDeliveryId, type HashDeliveryResult } from './hash-account-delivery';
import type { SignedHashAccountOperation } from './hash-account';

export interface HumanHashTransferIntent {
  readonly id: string; readonly account: string; readonly auxiliaryBinding: string | null;
  readonly target: string; readonly value: string; readonly data: string;
}
export interface HumanHashTransfer {
  readonly version: 1; readonly intent: HumanHashTransferIntent; readonly callGas: string; readonly nonce: string;
  readonly operationId: string | null; readonly cancelling: boolean;
  readonly result: HashDeliveryResult | null;
}
const address = /^0x[0-9a-f]{40}$/, hash = /^0x[0-9a-f]{64}$/, uint = /^(0|[1-9][0-9]*)$/;
const keyFor = (account: string) => `provian_hash_transfer_${account.slice(2)}`;
function validateIntent(i: HumanHashTransferIntent): void {
  if (!i || Object.keys(i).sort().join(',') !== 'account,auxiliaryBinding,data,id,target,value' || !hash.test(i.id)
    || !address.test(i.account) || !address.test(i.target) || /^0x0+$/.test(i.target)
    || (i.auxiliaryBinding !== null && (!hash.test(i.auxiliaryBinding) || /^0x0+$/.test(i.auxiliaryBinding)))
    || !uint.test(i.value) || BigInt(i.value) >= 2n ** 256n || !/^0x(?:[0-9a-f]{2})*$/.test(i.data)) throw Error('recourse_transfer_invalid');
}
function equal(a: HumanHashTransferIntent, b: HumanHashTransferIntent): boolean {
  return (Object.keys(a) as (keyof HumanHashTransferIntent)[]).every(k => a[k] === b[k]);
}
async function load(key: string): Promise<HumanHashTransfer | null> {
  const raw = await SecureStore.getItemAsync(key); if (raw === null) return null;
  const r = JSON.parse(raw) as HumanHashTransfer; validateIntent(r.intent);
  if (r.version !== 1 || !uint.test(r.nonce) || BigInt(r.nonce) >= 2n ** 256n || !uint.test(r.callGas) || BigInt(r.callGas) <= 0n || BigInt(r.callGas) >= 2n ** 256n
    || (r.operationId !== null && !hash.test(r.operationId)) || typeof r.cancelling !== 'boolean'
    || (r.result !== null && (!r.operationId || !hash.test(r.result.transactionHash)
      || !['pending', 'outer_reverted', 'complete'].includes(r.result.status)
      || (r.result.status === 'complete' && !['succeeded', 'target_failed', 'cancelled'].includes(r.result.outcome))))) throw Error('recourse_transfer_journal_invalid');
  return r;
}
async function save(key: string, record: HumanHashTransfer): Promise<void> {
  const raw = JSON.stringify(record);
  await SecureStore.setItemAsync(key, raw, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (await SecureStore.getItemAsync(key) !== raw) throw Error('recourse_transfer_write_unconfirmed');
}
let tail: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> { const run = tail.then(fn); tail = run.catch(() => undefined); return run; }
/** The screen can recover the reviewed transfer without reading seed material.
 * Completed records remain until an explicitly new reviewed intent replaces them. */
export function readHumanHashTransfer(account: string): Promise<HumanHashTransfer | null> {
  return locked(async () => {
    if (!address.test(account)) throw Error('recourse_transfer_invalid');
    const r = await load(keyFor(account));
    if (r && r.intent.account !== account) throw Error('recourse_transfer_journal_invalid');
    return r;
  });
}
function matches(operation: SignedHashAccountOperation, intent: HumanHashTransferIntent, gas: string, nonce: string): boolean {
  return operation.nonce === nonce && operation.account === intent.account && operation.target === intent.target && operation.value === intent.value
    && operation.data === intent.data && operation.callGas === gas;
}
/** One reviewed id owns one transfer, including across process death or a lost
 * completion response. A new id cannot replace an unresolved transfer. */
export function executeHumanHashTransfer(reviewed: HumanHashTransferIntent, action: BiometricAction,
  cancel = false): Promise<HashDeliveryResult> {
  // Snapshot before joining the queue. The caller can edit its form while an
  // earlier action or network read is pending; that must never alter this review.
  const intent = { ...reviewed };
  return locked(async () => {
    assertBiometricAction(action); validateIntent(intent);
    const key = keyFor(intent.account), archived = await load(`${key}_${intent.id.slice(2)}`);
    let record = archived ?? await load(key);
    if (archived && !equal(archived.intent, intent)) throw Error('recourse_transfer_intent_changed');
    if (record?.intent.id === intent.id) {
      if (!equal(record.intent, intent)) throw Error('recourse_transfer_intent_changed');
      if (record.result?.status === 'complete') return record.result;
    } else if (record && record.result?.status !== 'complete') throw Error('recourse_transfer_pending');
    else {
      if (cancel) throw Error('recourse_transfer_missing');
      if (record) await save(`${key}_${record.intent.id.slice(2)}`, record);
      record = null;
    }
    const network = ownerChainNetwork(), mnemonic = await SeedManager.getMnemonic(action);
    if (!mnemonic) throw Error('recourse_seed_unavailable');
    // A caller supplies only a binding, never a signing key or chosen account.
    let nonce: string;
    if (intent.auxiliaryBinding) {
      const bound = await discoverBoundHumanHashAccount(mnemonic, intent.auxiliaryBinding, network);
      if (bound.evm !== intent.account) throw Error('recourse_transfer_wrong_account');
      nonce = bound.hashAccount.nonce;
    } else {
      const root = await deriveHumanAccount(mnemonic, 0), selected = await readHumanAccountSelection(root.evm);
      if (selected?.kind !== 'hash' || useWalletStore.getState().address?.toLowerCase() !== intent.account) throw Error('recourse_transfer_wrong_account');
      const bound = await discoverHumanHashAccountSelection(mnemonic, selected.hashAccount!.identity, selected.requestId, network);
      if (bound.evm !== intent.account) throw Error('recourse_transfer_wrong_account');
      nonce = bound.hashAccount!.nonce;
    }
    if (!record) {
      const existing = await readHumanHashSpendingDelivery(intent.account);
      if (existing.operation && !existing.completed) throw Error('recourse_hash_spending_pending');
      const deployment = await assertCurrentProtocolTransaction(network, intent.target, intent.data);
      const estimates = await Promise.all(network.rpcs.map(rpc => rpc.request('eth_estimateGas', [{ from: intent.account,
        to: intent.target, data: intent.data, value: `0x${BigInt(intent.value).toString(16)}` }])));
      if (!estimates.every(v => typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) && BigInt(v) > 0n)) throw Error('recourse_gas_estimate_unavailable');
      const gas = estimates.map(v => BigInt(String(v))).reduce((a, b) => a > b ? a : b);
      if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw Error('recourse_transfer_state_changed');
      record = { version: 1, intent, nonce, callGas: String(gas + gas / 5n), operationId: null, cancelling: false, result: null };
      assertBiometricAction(action); await save(key, record);
    }
    if (!record.operationId) {
      const previous = await readHumanHashSpendingDelivery(intent.account);
      let operation = previous.operation;
      if (operation && matches(operation, intent, record.callGas, record.nonce)) {
        // Signing or completion can finish before this journal stores its id.
      } else {
        if (operation && !previous.completed) throw Error('recourse_hash_spending_pending');
        if (nonce !== record.nonce) throw Error('recourse_transfer_state_changed');
        const call: HumanHashCall = { target: intent.target, value: intent.value, data: intent.data, callGas: record.callGas };
        operation = await prepareHumanHashSpending(mnemonic, call, action, network, intent.auxiliaryBinding ?? undefined);
      }
      if (!matches(operation, intent, record.callGas, record.nonce)) throw Error('recourse_transfer_intent_changed');
      record = { ...record, operationId: hashDeliveryId(operation) }; await save(key, record);
    }
    const current = await readHumanHashSpendingDelivery(intent.account);
    if (!current.operation || hashDeliveryId(current.operation) !== record.operationId || !matches(current.operation, intent, record.callGas, record.nonce)
      || current.auxiliaryBinding !== intent.auxiliaryBinding) throw Error('recourse_transfer_intent_changed');
    if (cancel && !record.cancelling) { record = { ...record, cancelling: true }; await save(key, record); }
    let id = record.operationId!, variant: 'operation' | 'cancellation' = 'operation';
    if (record.cancelling && !current.completed) {
      const reconcile = async (): Promise<HashDeliveryResult | null> => {
        const variants = current.cancellation ? [
          { id: hashDeliveryId(current.cancellation), variant: 'cancellation' as const },
          { id: record!.operationId!, variant: 'operation' as const },
        ] : [{ id: record!.operationId!, variant: 'operation' as const }];
        for (const candidate of variants) {
          const result = await reconcileHumanHashSpending(intent.account, action, candidate.id, candidate.variant);
          if (result?.status === 'complete') { record = { ...record!, result }; await save(key, record); return result; }
        }
        return null;
      };
      const winner = await reconcile(); if (winner) return winner;
      let cancellation: SignedHashAccountOperation;
      try { cancellation = current.cancellation ?? await cancelHumanHashSpending(mnemonic, action, network, intent.auxiliaryBinding ?? undefined); }
      catch (error) {
        // The original may consume the nonce between inspection and signing.
        // Recheck only receipts; never send it to make cancellation succeed.
        const racedWinner = await reconcile(); if (racedWinner) return racedWinner;
        throw error;
      }
      id = hashDeliveryId(cancellation); variant = 'cancellation';
    }
    const result = await deliverHumanHashSpending(intent.account, action, id, variant);
    record = { ...record, result }; await save(key, record); return result;
  });
}

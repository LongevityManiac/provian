import * as SecureStore from 'expo-secure-store';
import { sha256, toUtf8Bytes } from 'ethers';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { assertCurrentProtocolTransaction } from '../protocol/transaction';
import { ownerChainNetwork } from '../protocol/runtime';
import type { OwnerChainNetwork } from './owner-chain';
import { deriveHumanAccount, readHumanAccountSelection, discoverHumanHashAccountSelection, installHumanHashAccountSelection } from './human-account';
import { humanBreakKey } from './human-secret';
import { prepareHashAccountOperation, hashAccountCall, type HashAccountIntent, type SignedHashAccountOperation } from './hash-account';
import { verifyHashAccountVariantReceipt } from './hash-account-chain';

export interface HumanHashCall { readonly target: string; readonly value: string; readonly callGas: string; readonly data: string; }
interface Journal {
  version: 1; account: string; identity: string; origin: string; requestId: string;
  intent: HashAccountIntent; operation?: SignedHashAccountOperation;
  cancellation?: SignedHashAccountOperation; cancellationReserved?: boolean;
  completed?: { hash: string; outcome: 'succeeded' | 'target_failed' | 'cancelled' };
}
const keyFor = (account: string) => `provian_hash_spending_${account.slice(2)}`;
async function save(key: string, journal: Journal): Promise<void> {
  const encoded = JSON.stringify(journal);
  await SecureStore.setItemAsync(key, encoded, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (await SecureStore.getItemAsync(key) !== encoded) throw Error('recourse_hash_spending_write_unconfirmed');
}
async function load(account: string): Promise<Journal | null> {
  const raw = await SecureStore.getItemAsync(keyFor(account));
  if (raw === null) return null;
  const j = JSON.parse(raw) as Journal;
  if (j.version !== 1 || j.account !== account || j.intent.account !== account
    || !/^0x[0-9a-f]{64}$/.test(j.identity) || !/^0x[0-9a-f]{64}$/.test(j.requestId)
    || !/^0x[0-9a-f]{40}$/.test(j.origin)) throw Error('recourse_hash_spending_journal_invalid');
  if (j.operation) {
    hashAccountCall(j.operation);
    for (const field of ['chainId','account','nonce','target','value','callGas','data','nextCommitment'] as const)
      if (j.operation[field] !== j.intent[field]) throw Error('recourse_hash_spending_journal_invalid');
  }
  if (j.cancellation) hashAccountCall(j.cancellation);
  if (j.completed && (!/^0x[0-9a-f]{64}$/.test(j.completed.hash) || !['succeeded','target_failed','cancelled'].includes(j.completed.outcome)
    || !j.operation)) throw Error('recourse_hash_spending_journal_invalid');
  return j;
}
let tail: Promise<unknown> = Promise.resolve();
function locked<T>(run: () => Promise<T>): Promise<T> { const result = tail.then(run); tail = result.catch(() => undefined); return result; }
async function selected(mnemonic: string, network: OwnerChainNetwork) {
  const root = await deriveHumanAccount(mnemonic, 0), stored = await readHumanAccountSelection(root.evm);
  if (stored?.kind !== 'hash') throw Error('recourse_hash_account_not_selected');
  return discoverHumanHashAccountSelection(mnemonic, stored.hashAccount!.identity, stored.requestId, network);
}
/** Uses the existing encrypted backup to reconstruct both signing generations.
 * Persist the exact intent before publishing its signature. No curve key can
 * authorize this account; any gas sender receives only the public operation. */
export function prepareHumanHashSpending(mnemonic: string, call: HumanHashCall, action: BiometricAction,
  network: OwnerChainNetwork = ownerChainNetwork()): Promise<SignedHashAccountOperation> {
  return locked(async () => {
    assertBiometricAction(action);
    const deployment = await assertCurrentProtocolTransaction(network, call.target, call.data);
    const current = await selected(mnemonic, network), context = current.hashAccount!;
    let journal = await load(current.evm);
    if (journal?.completed) {
      await save(`${keyFor(current.evm)}_${journal.intent.nonce}`, journal);
      journal = null;
    }
    const base = { chainId: '8453', account: current.evm, nonce: context.nonce, ...call };
    if (journal) {
      const { nextCommitment: _next, ...prior } = journal.intent;
      if (journal.identity !== context.identity || journal.origin !== context.breakOrigin
        || (Object.keys(base) as (keyof typeof base)[]).some(field => prior[field] !== base[field])) throw Error('recourse_hash_spending_pending');
    }
    const seed = humanBreakKey(mnemonic, context, 'spending', context.nonce);
    const nextSeed = humanBreakKey(mnemonic, context, 'spending', String(BigInt(context.nonce) + 1n));
    try {
      assertBiometricAction(action);
      const operation = journal?.operation ?? await prepareHashAccountOperation({ intent: base, signingSeed: seed, nextSigningSeed: nextSeed,
        async persistBeforeSigning(intent) {
          assertBiometricAction(action);
          journal = { version: 1, account: current.evm, identity: context.identity, origin: context.breakOrigin,
            requestId: current.requestId, intent };
          await save(keyFor(current.evm), journal);
        },
      });
      if (!journal) throw Error('recourse_hash_spending_journal_missing');
      journal.operation = operation; await save(keyFor(current.evm), journal);
      const confirmed = await selected(mnemonic, network);
      if (confirmed.evm !== current.evm || confirmed.hashAccount!.nonce !== context.nonce
        || (await assertCurrentProtocolTransaction(network, call.target, call.data)).manifestHash !== deployment.manifestHash) {
        throw Error('recourse_hash_spending_state_changed');
      }
      assertBiometricAction(action); return operation;
    } finally { seed.fill(0); nextSeed.fill(0); }
  });
}
export function pendingHumanHashSpending(account: string): Promise<{
  operation: SignedHashAccountOperation | null; cancellation: SignedHashAccountOperation | null;
}> {
  return locked(async () => { const j = await load(account); return { operation: j?.completed ? null : j?.operation ?? null,
    cancellation: j?.completed ? null : j?.cancellation ?? null }; });
}
/** Delivery reconciliation needs the exact signed bytes even if key rotation
 * completed before its own transport journal could save the final outcome. */
export function readHumanHashSpendingDelivery(account: string): Promise<{
  operation: SignedHashAccountOperation | null; cancellation: SignedHashAccountOperation | null;
  completed: Journal['completed'] | null;
}> {
  return locked(async () => {
    const j = await load(account);
    return { operation: j?.operation ?? null, cancellation: j?.cancellation ?? null, completed: j?.completed ?? null };
  });
}
/** Cancellation is a competing signed no-op, never deletion of a published
 * authorization. Both variants install the same next key; either may win. */
export function cancelHumanHashSpending(mnemonic: string, action: BiometricAction,
  network: OwnerChainNetwork = ownerChainNetwork()): Promise<SignedHashAccountOperation> {
  return locked(async () => {
    assertBiometricAction(action);
    const current = await selected(mnemonic, network), context = current.hashAccount!, j = await load(current.evm);
    if (!j?.operation || j.completed || j.intent.nonce !== context.nonce || j.origin !== context.breakOrigin) throw Error('recourse_hash_spending_pending_missing');
    if (j.cancellation) return j.cancellation;
    const seed = humanBreakKey(mnemonic, context, 'spending', context.nonce);
    const nextSeed = humanBreakKey(mnemonic, context, 'spending', String(BigInt(context.nonce) + 1n));
    try {
      const { nextCommitment: _next, ...base } = j.intent;
      const operation = await prepareHashAccountOperation({ intent: { ...base, target: current.evm, value: '0', data: '0x' },
        signingSeed: seed, nextSigningSeed: nextSeed, async persistBeforeSigning() {
          assertBiometricAction(action); j.cancellationReserved = true; await save(keyFor(current.evm), j);
        },
      });
      j.cancellation = operation; await save(keyFor(current.evm), j);
      await assertCurrentProtocolTransaction(network, current.evm, '0x');
      assertBiometricAction(action); return operation;
    } finally { seed.fill(0); nextSeed.fill(0); }
  });
}
/** A successful outer transaction can contain a failed inner call. Verify the
 * exact signed variant and rotate after either outcome, only after finality. */
export function completeHumanHashSpending(mnemonic: string, account: string, transactionHash: string, action: BiometricAction,
  network: OwnerChainNetwork = ownerChainNetwork()): Promise<'succeeded' | 'target_failed' | 'cancelled'> {
  return locked(async () => {
    assertBiometricAction(action);
    const j = await load(account);
    if (!j || !/^0x[0-9a-f]{64}$/.test(transactionHash)) throw Error('recourse_hash_spending_pending_missing');
    if (j.completed) {
      if (j.completed.hash !== transactionHash) throw Error('recourse_hash_spending_receipt_changed');
      return j.completed.outcome;
    }
    const variants = [j.operation, j.cancellation].filter((v): v is SignedHashAccountOperation => v !== undefined);
    const verified = await verifyHashAccountVariantReceipt(variants, transactionHash, network);
    const outcome = verified.operation === j.cancellation ? 'cancelled' : verified.outcome;
    const selected = await installHumanHashAccountSelection(mnemonic, j.identity, j.requestId, action, network);
    if (selected.evm !== account || selected.hashAccount!.nonce !== String(BigInt(j.intent.nonce) + 1n)) throw Error('recourse_hash_spending_selection_changed');
    j.completed = { hash: transactionHash, outcome }; await save(keyFor(account), j);
    return outcome;
  });
}
export function humanHashGasOperationId(operation: SignedHashAccountOperation): string {
  return sha256(toUtf8Bytes(hashAccountCall(operation)));
}

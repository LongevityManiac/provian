import * as SecureStore from 'expo-secure-store';
import { HDKey } from '@scure/bip32';
import { bytesToHex } from '@noble/hashes/utils';
import { Transaction } from 'ethers';
import { mnemonicToSeedPaced } from '../wallet/pacedSeed';
import SeedManager from '../wallet/SeedManager';
import TransactionService from '../wallet/TransactionService';
import { ActionWallet } from '../security/ActionWallet';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { readChainOperation } from '../security/chainNonce';
import { secureNonceStore } from '../security/secureNonceStore';
import { ownerChainNetwork } from '../protocol/runtime';
import { useWalletStore } from '../../store/walletStore';
import { humanAccountPaths } from './human-account';
import { readHumanHashSpendingDelivery, completeHumanHashSpending } from './human-hash-spending';
import { hashAccountCall, type SignedHashAccountOperation } from './hash-account';
import { deliverHashAccountOperation, hashDeliveryId, type HashDeliveryRecord, type HashDeliveryResult } from './hash-account-delivery';

/** The spending journal is the durable authority for the winning variant.
 * Its completed result supersedes an unfinished transport-status write. */
export async function pendingHumanHashDeliveryOperation(account: string): Promise<SignedHashAccountOperation | null> {
  const spending = await readHumanHashSpendingDelivery(account);
  return spending.completed ? null : spending.operation;
}

let tail: Promise<unknown> = Promise.resolve();
/** The original EOA carries only ETH gas. The retained hash authorization alone
 * controls the protected account; the curve key never selects its destination.
 * All signed gas bytes stay in the existing encrypted nonce coordinator. */
export function deliverHumanHashSpending(account: string, action: BiometricAction, expectedOperationId: string,
  variant: 'operation' | 'cancellation' = 'operation'): Promise<HashDeliveryResult> {
  const run = tail.then(async () => {
    assertBiometricAction(action);
    if (useWalletStore.getState().address?.toLowerCase() !== account) throw Error('recourse_hash_delivery_wrong_wallet');
    const spending = await readHumanHashSpendingDelivery(account);
    const operation = spending[variant];
    if (!operation || operation.account !== account) throw Error('recourse_hash_spending_pending_missing');
    if (hashDeliveryId(operation) !== expectedOperationId) throw Error('recourse_hash_delivery_intent_changed');
    if (spending.completed) return { status: 'complete' as const, transactionHash: spending.completed.hash, outcome: spending.completed.outcome };
    const mnemonic = await SeedManager.getMnemonic(action);
    if (!mnemonic) throw Error('recourse_seed_unavailable');
    const seed = await mnemonicToSeedPaced(mnemonic);
    let root: HDKey | undefined, key: HDKey | undefined;
    try {
      root = HDKey.fromMasterSeed(seed); key = root.derive(humanAccountPaths(0).evm);
      if (!key.privateKey) throw Error('recourse_gas_key_unavailable');
      const privateKey = '0x' + bytesToHex(key.privateKey), provider = TransactionService.providerFor(8453);
      const sender = new ActionWallet(privateKey, action, provider).address.toLowerCase();
      return await deliverHashAccountOperation(operation, {
        sender, network: ownerChainNetwork(),
        async read(id) {
          const raw = await SecureStore.getItemAsync(`provian_hash_delivery_${id.slice(2)}`);
          return raw === null ? null : JSON.parse(raw) as HashDeliveryRecord;
        },
        async write(id, record) {
          assertBiometricAction(action);
          const name = `provian_hash_delivery_${id.slice(2)}`, raw = JSON.stringify(record);
          await SecureStore.setItemAsync(name, raw, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
          if (await SecureStore.getItemAsync(name) !== raw) throw Error('recourse_hash_delivery_write_unconfirmed');
        },
        async recover(id) {
          const store = secureNonceStore(), signerKey = `8453_${sender}`;
          let doc: Awaited<ReturnType<typeof readChainOperation>>;
          try { doc = await readChainOperation(store, signerKey, id); }
          catch (error) { if (error instanceof Error && error.message === 'chain_operation_not_found') return null; throw error; }
          const index = await store.transact(signerKey, current => {
            return current ?? { version: 1, next: 0, attempts: [], owner: null, leaseUntil: 0 };
          });
          const attempt = doc.attempts[0] ?? index.attempts.find(value => value.intent === id);
          if (!attempt) return null;
          const decoded = Transaction.from(attempt.raw);
          if (decoded.hash !== attempt.hash || decoded.from?.toLowerCase() !== sender || decoded.chainId !== 8453n
            || decoded.to?.toLowerCase() !== account || decoded.value !== 0n || decoded.data !== hashAccountCall(operation)) throw Error('recourse_hash_delivery_nonce_invalid');
          return attempt.hash;
        },
        async send(id, transaction) {
          assertBiometricAction(action);
          return (await new ActionWallet(privateKey, action, provider, id).sendTransaction(transaction)).hash;
        },
        complete: hash => completeHumanHashSpending(mnemonic, account, hash, action),
      });
    } finally { seed.fill(0); key?.wipePrivateData(); root?.wipePrivateData(); }
  });
  tail = run.catch(() => undefined); return run;
}

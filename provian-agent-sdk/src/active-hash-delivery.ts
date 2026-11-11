import * as path from 'node:path';
import { Transaction } from 'ethers';
import { readHashDeliveryJournal, writeHashDeliveryJournal } from './hash-delivery-journal';
import { durableDirectory } from './durable-directory';
import { tryAcquireFileLock } from './meter/file-lock';
import { loadKeystore, withDecryptedKey } from './keystore';
import { sendTransaction, type SignerOpts } from './evm-signer';
import { fileNonceStore } from './nonce-file-store';
import { readChainOperation } from './chain-nonce';
import { ownerChainNetwork } from './protocol-runtime';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import { readOwnerChainState } from './recourse-owner-chain';
import { readHashAccountState } from './hash-account-chain';
import { hashAccountCall } from './hash-account';
import { readActiveHashWalletDelivery, completeActiveHashWalletOperation } from './break-recovery-store';
import { deliverHashAccountOperation, reconcileHashAccountOperation, hashDeliveryId,
  type HashDeliveryRecord, type HashDeliveryResult } from './hash-account-delivery';

export interface ActiveHashDeliveryInput {
  readonly directory: string; readonly passphrase: string; readonly operationId: string;
  readonly variant?: 'operation' | 'cancellation'; readonly network?: OwnerChainNetwork;
  /** The encrypted EOA pays only ETH gas for the retained hash authorization. */
  readonly gasKeystoreFile?: string;
  readonly gasTransport?: Pick<SignerOpts, 'rpcUrl' | 'transport'>;
}
/** No operation is signed here. The caller selects an exact already-persisted
 * hash authorization; the original EOA provides only its outer ETH gas. */
export async function deliverActiveHashWalletOperation(input: ActiveHashDeliveryInput): Promise<HashDeliveryResult> {
  const result = await run({ ...input }, false);
  if (!result) throw Error('hash_wallet_delivery_missing_result');
  return result;
}
export function reconcileActiveHashWalletOperation(input: ActiveHashDeliveryInput): Promise<HashDeliveryResult | null> {
  return run({ ...input }, true);
}
async function run(input: ActiveHashDeliveryInput, inspectOnly: boolean): Promise<HashDeliveryResult | null> {
  if (!/^0x[0-9a-f]{64}$/.test(input.operationId) || (input.variant !== undefined && !['operation', 'cancellation'].includes(input.variant))) throw Error('hash_wallet_delivery_invalid');
  const directory = path.resolve(input.directory);
  durableDirectory(directory);
  const release = tryAcquireFileLock(path.join(directory, 'hash-delivery.lock'), { timeoutMs: 0, staleMs: 0, syncOnly: false });
  if (!release) throw Error('hash_wallet_delivery_in_progress');
  try {
    const current = await readActiveHashWalletDelivery(input), operation = current[input.variant ?? 'operation'];
    if (!operation || operation.account !== current.active.address || hashDeliveryId(operation) !== input.operationId) throw Error('hash_wallet_delivery_intent_changed');
    if (current.completed) return { status: 'complete', transactionHash: current.completed.transactionHash, outcome: current.completed.outcome };
    const network = input.network ?? ownerChainNetwork(), store = fileNonceStore(path.join(directory, 'evm-nonces'));
    const keystore = loadKeystore(input.gasKeystoreFile ?? path.join(directory, 'agent-keystore.json'));
    if (!keystore) throw Error('hash_wallet_gas_keystore_missing');
    return await withDecryptedKey(keystore, input.passphrase, async key => {
      const sender = key.address.toLowerCase(), signerKey = `8453_${sender}`;
      const ensureActive = async () => {
        const latest = await readActiveHashWalletDelivery(input);
        const held = latest[input.variant ?? 'operation'];
        if (!held || hashDeliveryId(held) !== input.operationId || latest.active.address !== current.active.address
          || latest.active.identity !== current.active.identity || latest.active.context !== current.active.context) throw Error('hash_wallet_delivery_intent_changed');
        return latest;
      };
      const directoryForRecords = path.join(directory, 'hash-deliveries');
      const file = (id: string) => {
        if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('hash_wallet_delivery_invalid');
        return path.join(directoryForRecords, `${id.slice(2)}.json`);
      };
      const read = async (id: string): Promise<HashDeliveryRecord | null> => readHashDeliveryJournal(file(id), input.passphrase, id, sender);
      const deliver = inspectOnly ? reconcileHashAccountOperation : deliverHashAccountOperation;
      return deliver(operation, {
        sender, network, read,
        async write(id, record) {
          durableDirectory(directoryForRecords);
          writeHashDeliveryJournal(file(id), input.passphrase, id, sender, record);
        },
        async recover(id) {
          let doc: Awaited<ReturnType<typeof readChainOperation>>;
          try { doc = await readChainOperation(store, signerKey, id); }
          catch (error) { if (error instanceof Error && error.message === 'chain_operation_not_found') return null; throw error; }
          const index = await store.transact(signerKey, value => value ?? { version: 1, next: 0, attempts: [], owner: null, leaseUntil: 0 });
          const attempt = doc.attempts[0] ?? index.attempts.find(value => value.intent === id);
          if (!attempt) return null;
          const tx = Transaction.from(attempt.raw);
          if (tx.hash !== attempt.hash || tx.from?.toLowerCase() !== sender || tx.chainId !== 8453n || tx.value !== 0n
            || tx.to?.toLowerCase() !== operation.account || tx.data !== hashAccountCall(operation)) throw Error('hash_wallet_delivery_nonce_invalid');
          return attempt.hash;
        },
        async send(id, transaction) {
          const held = await ensureActive();
          if (held.completed) throw Error('hash_wallet_delivery_already_complete');
          const owner = await readOwnerChainState(current.active.identity, network), state = await readHashAccountState(operation.account, network);
          if (owner.destination !== operation.account || state.root !== operation.signingRoot || state.nonce !== operation.nonce
            || owner.deployment.manifestHash !== state.manifestHash) throw Error('hash_wallet_delivery_state_changed');
          // The fixed outer target is our independently verified hash account;
          // the EOA transfers zero value and cannot choose the inner recipient.
          const result = await sendTransaction({ address: sender, privateKeyHex: key.privateKey }, {
            rpcUrl: 'https://mainnet.base.org', ...input.gasTransport, chain: 'base', to: transaction.to, data: transaction.data, value: '0',
            operationId: id, nonceJournalStore: store, allowUnlistedTarget: true,
          });
          return result.hash;
        },
        async complete(transactionHash) {
          await ensureActive();
          return completeActiveHashWalletOperation({ directory, passphrase: input.passphrase, transactionHash, network });
        },
      });
    });
  } finally { release(); }
}

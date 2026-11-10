import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { HDKey } from '@scure/bip32';
import { bytesToHex } from '@noble/hashes/utils';
import { concat, sha256, toUtf8Bytes } from 'ethers';
import SeedManager from '../wallet/SeedManager';
import { mnemonicToSeedPaced } from '../wallet/pacedSeed';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { ActionWallet } from '../security/ActionWallet';
import { invalidateSeedDerivedCaches } from '../security/seedDerivedCache';
import RelayAPIService from '../../services/RelayAPIService';
import { ownerChainNetwork } from '../protocol/runtime';
import { discoverHumanAccount } from './human-discovery';
import { humanOwnershipIdentity } from './ownership';
import { deriveHumanAccount, humanAccountPaths, installHumanAccountSelection } from './human-account';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { recoveryCommitment, recoverySigningRoot, signRecoveryIntent } from './hash-authorization';
import { readOwnerChainState, verifyOwnerOperationReceipt } from './owner-chain';
import { ownerOperationIntent, recoveryOperationId, parseRestorationScope, type RestorationScope, type RecoveryOwnerOperation } from './owner-operation';

interface Journal {
  version: 1; rootAddress: string; identity: string; requestId: string; authSecret: string; deviceId: string;
  kernel: string; revision: string; nonce: number; accountGeneration: number;
  intent?: string; authorizationTxHash?: string; userId?: string; installed?: boolean;
  lossTransaction?: string; lossBlock?: number; restoration?: RestorationScope;
}
const hex32 = () => `0x${bytesToHex(Crypto.getRandomBytes(32))}`;
const journalKey = (root: string) => `provian_recourse_recovery_${root.slice(2)}`;
async function save(journal: Journal): Promise<void> {
  const key = journalKey(journal.rootAddress), serialized = JSON.stringify(journal);
  await SecureStore.setItemAsync(key, serialized, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (await SecureStore.getItemAsync(key) !== serialized) throw new Error('recourse_journal_write_unconfirmed');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_recovery_reply_invalid');
  return value as Record<string, unknown>;
}

/** The seed remains in its existing vault. A small device-encrypted journal
 * fixes the destination and fresh credentials before any authorization leaves.
 * Hash signatures are deterministically regenerated, never kept in public state. */
type RecoveryOptions = { newRecovery?: boolean; lossTransaction?: string; lossBlock?: number; signal?: AbortSignal };
let recoveryTail: Promise<unknown> = Promise.resolve();
export function recoverHumanAccount(action: BiometricAction, options: RecoveryOptions = {}):
Promise<{ destination: string; requestId: string }> {
  const run = recoveryTail.then(() => performHumanRecovery(action, options));
  recoveryTail = run.catch(() => undefined);
  return run;
}
async function performHumanRecovery(action: BiometricAction, options: RecoveryOptions):
Promise<{ destination: string; requestId: string }> {
  assertBiometricAction(action);
  if (options.lossTransaction !== undefined && !/^0x[0-9a-f]{64}$/.test(options.lossTransaction)) throw new Error('recourse_loss_transaction_invalid');
  if (options.lossTransaction !== undefined && (!Number.isSafeInteger(options.lossBlock) || options.lossBlock! < 1)) throw new Error('recourse_loss_block_invalid');
  const mnemonic = await SeedManager.getMnemonic(action);
  if (!mnemonic) throw new Error('recourse_seed_unavailable');
  const root = await deriveHumanAccount(mnemonic, 0);
  const raw = await SecureStore.getItemAsync(journalKey(root.evm));
  let journal: Journal | null = raw === null ? null : JSON.parse(raw) as Journal;
  if (journal && (journal.version !== 1 || journal.rootAddress !== root.evm
    || !/^0x[0-9a-f]{64}$/.test(journal.identity) || !/^0x[0-9a-f]{64}$/.test(journal.requestId)
    || !/^[0-9a-f]{64}$/.test(journal.authSecret))) throw new Error('recourse_journal_invalid');
  if (journal?.installed && (options.newRecovery
    || (options.lossTransaction !== undefined && options.lossTransaction !== journal.lossTransaction))) {
    journal = null;
  }
  if (journal && options.lossTransaction !== undefined && journal.lossTransaction !== options.lossTransaction) {
    throw new Error('recourse_recovery_pending_for_another_request');
  }
  if(journal && options.lossTransaction!==undefined && journal.lossBlock!==options.lossBlock)throw new Error('recourse_loss_block_changed');
  const network = ownerChainNetwork();
  if (!journal) {
    const found = await discoverHumanAccount(mnemonic, network);
    if (!found) throw new Error('recourse_binding_required');
    const state = await readOwnerChainState(found.identity, network);
    journal = { version: 1, rootAddress: root.evm, identity: found.identity, requestId: hex32(),
      authSecret: hex32().slice(2), deviceId: await RelayAPIService.getMeterDeviceId(),
      kernel: state.deployment.addresses.kernel.toLowerCase(), revision: state.deployment.revision.toString(),
      nonce: state.nonce, accountGeneration: state.nonce + 1,
      ...(options.lossTransaction === undefined ? {} : { lossTransaction: options.lossTransaction, lossBlock: options.lossBlock }) };
    if (options.lossTransaction !== undefined) {
      const prepared = object(await RelayAPIService.recourseRequest('restoration-intents', {
        transactionHash: options.lossTransaction, block: options.lossBlock }, action));
      if (prepared.kernel !== journal.kernel) throw new Error('recourse_owner_protocol_changed');
      journal.restoration = parseRestorationScope({ request: prepared.request, lossHash: prepared.lossHash, maximumLoss: prepared.maximumLoss });
    }
    humanAccountPaths(journal.accountGeneration);
    await save(journal);
  }
  const state = journal, next = await deriveHumanAccount(mnemonic, state.accountGeneration);
  if (state.installed) {
    const current = await readOwnerChainState(state.identity, network);
    if (current.destination !== next.evm || current.nonce < state.nonce + 1) throw new Error('recourse_completed_recovery_superseded');
    return { destination: next.evm, requestId: state.requestId };
  }
  const secret = humanRecoverySecret(mnemonic, state.nonce), seed = humanRecoverySigningSeed(mnemonic, state.nonce);
  const nextSecret = humanRecoverySecret(mnemonic, state.nonce + 1), nextSeed = humanRecoverySigningSeed(mnemonic, state.nonce + 1);
  try {
    const signingRoot = await recoverySigningRoot(seed), nextSigningRoot = await recoverySigningRoot(nextSeed);
    const nextCommitment = recoveryCommitment(nextSecret, nextSigningRoot);
    if (!state.authorizationTxHash) {
      const current = await readOwnerChainState(state.identity, network);
      if ((current.deployment.addresses.kernel.toLowerCase() !== state.kernel || current.deployment.revision.toString() !== state.revision)
        && current.nonce === state.nonce && current.commitment === recoveryCommitment(secret, signingRoot) && current.signingRoot === signingRoot) {
        // The pointer's monotonic revision makes the old kind-2 payload
        // unexecutable. Preserve destination/credentials; regenerate only the
        // exact authorization against the independently verified current set.
        state.kernel = current.deployment.addresses.kernel.toLowerCase();
        state.revision = current.deployment.revision.toString();
        delete state.intent;
        await save(state);
      }
    }
    const unsigned: RecoveryOwnerOperation = { kernel: state.kernel, revision: state.revision, identity: state.identity,
      destination: next.evm, nonce: state.nonce, ...(state.restoration ? { restoration: state.restoration } : {}), proof: { recoverySecret: `0x${bytesToHex(secret)}`, signingRoot,
        nextCommitment, nextSigningRoot, publicKey: `0x${'00'.repeat(32)}`, signature: '0x' } };
    const signed = await signRecoveryIntent(seed, ownerOperationIntent(unsigned), { async reserve(_root, intent) {
      assertBiometricAction(action);
      if (state.intent && state.intent !== intent) throw new Error('recourse_recovery_intent_changed');
      state.intent = intent; await save(state);
    } });
    const operation = { ...unsigned, proof: { ...unsigned.proof, ...signed } };
    if (!state.authorizationTxHash) {
      const id = recoveryOperationId(operation);
      let response = await RelayAPIService.recourseRecoveryRequest('owner-operations/recovery', operation);
      while (true) {
        assertBiometricAction(action); options.signal?.throwIfAborted();
        const status = object(response);
        if (status.id !== id || !['queued', 'submitted', 'confirmed', 'failed'].includes(String(status.status))) throw new Error('recourse_recovery_reply_invalid');
        if (status.status === 'failed') throw new Error('recourse_authorization_failed');
        if (status.status === 'confirmed') {
          if (typeof status.transactionHash !== 'string') throw new Error('recourse_recovery_reply_invalid');
          await verifyOwnerOperationReceipt(operation, status.transactionHash, network);
          state.authorizationTxHash = status.transactionHash; await save(state); break;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 5000));
        response = await RelayAPIService.recourseRecoveryRequest(`owner-operations/${id}`);
      }
    }
    await verifyOwnerOperationReceipt(operation, state.authorizationTxHash, network);
    const preimage = concat([operation.proof.recoverySecret, signingRoot]);
    const expiresAtMs = Date.now() + 300000;
    const body = { kernel: state.kernel, identity: state.identity, preimage, destination: next.evm, nextCommitment, nextSigningRoot,
      authorizationTxHash: state.authorizationTxHash, authorizationNonce: state.nonce,
      requestId: state.requestId, deviceId: state.deviceId, authSecret: state.authSecret, expiresAtMs };
    const message = ['Provian human ownership recovery', 'chain:8453', `kernel:${state.kernel}`, `identity:${state.identity}`,
      `recovery:${sha256(preimage)}`, `destination:${next.evm}`, `next:${nextCommitment}`, `next-hash-authority:${nextSigningRoot}`,
      `authorization:${state.authorizationTxHash}`, `authorization-nonce:${state.nonce}`, `device:${state.deviceId}`,
      `credentials:${sha256(toUtf8Bytes(state.authSecret)).slice(2)}`, `request:${state.requestId}`, `expires:${expiresAtMs}`].join('\n');
    const bipSeed = await mnemonicToSeedPaced(mnemonic), hd = HDKey.fromMasterSeed(bipSeed);
    const child = hd.derive(humanAccountPaths(state.accountGeneration).evm);
    let signature: string;
    try {
      if (!child.privateKey) throw new Error('recourse_account_derivation_failed');
      signature = await new ActionWallet(`0x${bytesToHex(child.privateKey)}`, action).signMessage(message);
    } finally { bipSeed.fill(0); child.wipePrivateData(); hd.wipePrivateData(); }
    const result = object(await RelayAPIService.recourseRecoveryRequest('recover-human', { ...body, signature }));
    if (typeof result.userId !== 'string' || humanOwnershipIdentity(result.userId) !== state.identity
      || result.destination !== next.evm || typeof result.generation !== 'number'
      || !Number.isSafeInteger(result.generation) || result.generation < 1) {
      throw new Error('recourse_recovery_reply_invalid');
    }
    // Verify again before any local credentials or signing selector changes.
    await verifyOwnerOperationReceipt(operation, state.authorizationTxHash, network);
    state.userId = result.userId; await save(state);
    assertBiometricAction(action);
    invalidateSeedDerivedCaches();
    await installHumanAccountSelection(mnemonic, { rootAddress: root.evm, generation: state.accountGeneration,
      ...next, recoveryGeneration: state.nonce + 1, recoveryCommitment: nextCommitment, requestId: state.requestId }, action);
    await RelayAPIService.setAuthSecret(state.authSecret, state.userId);
    await RelayAPIService.recordAddressProofAuthorization({ address: next.evm, userId: state.userId });
    state.installed = true; await save(state);
    return { destination: next.evm, requestId: state.requestId };
  } finally { secret.fill(0); seed.fill(0); nextSecret.fill(0); nextSeed.fill(0); }
}

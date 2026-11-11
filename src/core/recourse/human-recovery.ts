import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { HDKey } from '@scure/bip32';
import { bytesToHex } from '@noble/hashes/utils';
import { concat, sha256, toUtf8Bytes, computeAddress } from 'ethers';
import SeedManager from '../wallet/SeedManager';
import { mnemonicToSeedPaced } from '../wallet/pacedSeed';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { ActionWallet } from '../security/ActionWallet';
import { invalidateSeedDerivedCaches } from '../security/seedDerivedCache';
import RelayAPIService from '../../services/RelayAPIService';
import { ownerChainNetwork } from '../protocol/runtime';
import { discoverHumanIdentityHistory, discoverHistoricalCurveGeneration } from './human-break-history';
import { readBreakRecoveryContext } from './break-recovery';
import { prepareHumanReplacementAccount, deployHumanReplacementAccount, signHumanReplacementDestination, type HumanReplacementAccount } from './human-replacement-account';
import { deriveHumanAccount, humanAccountPaths, installHumanAccountSelection, installHumanHashAccountSelection } from './human-account';
import { humanBreakKey, humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { recoveryCommitment, recoverySigningRoot, signRecoveryIntent } from './hash-authorization';
import { readOwnerChainState, verifyOwnerOperationReceipt } from './owner-chain';
import { ownerOperationIntent, recoveryOperationId, parseRestorationScope, type RestorationScope, type RecoveryOwnerOperation } from './owner-operation';
import { auxiliaryAccountKey } from './auxiliary-account';

interface Journal {
  version: 1; rootAddress: string; identity: string; requestId: string; authSecret: string; deviceId: string;
  kernel: string; revision: string; nonce: number; accountGeneration: number;
  intent?: string; authorizationTxHash?: string; userId?: string; installed?: boolean;
  lossTransaction?: string; lossBlock?: number; restoration?: RestorationScope;
  auxiliary?: true; replacement?: HumanReplacementAccount; legacyGeneration?: number;
}
const hex32 = () => `0x${bytesToHex(Crypto.getRandomBytes(32))}`;
const journalKey = (root: string, binding?: string) => `provian_recourse_recovery_${root.slice(2)}${binding ? `_aux_${binding.slice(2)}` : ''}`;
async function save(journal: Journal): Promise<void> {
  const key = journalKey(journal.rootAddress, journal.auxiliary ? journal.identity : undefined), serialized = JSON.stringify(journal);
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
type RecoveryOptions = { newRecovery?: boolean; lossTransaction?: string; lossBlock?: number; signal?: AbortSignal; auxiliaryBinding?: string };
let recoveryTail: Promise<unknown> = Promise.resolve();
export function recoverHumanAccount(action: BiometricAction, options: RecoveryOptions = {}):
Promise<{ destination: string; requestId: string }> {
  const retainedOptions = { ...options };
  const run = recoveryTail.then(() => performHumanRecovery(action, retainedOptions));
  recoveryTail = run.catch(() => undefined);
  return run;
}
async function performHumanRecovery(action: BiometricAction, options: RecoveryOptions):
Promise<{ destination: string; requestId: string }> {
  assertBiometricAction(action);
  if (options.auxiliaryBinding !== undefined) {
    if (!/^0x[0-9a-f]{64}$/.test(options.auxiliaryBinding)) throw Error('recourse_auxiliary_binding_invalid');
    const owned = object(await RelayAPIService.recourseRequest('ownership'));
    if (owned.identity === options.auxiliaryBinding || !Array.isArray(owned.addresses)
      || !owned.addresses.some(value => object(value).identity === options.auxiliaryBinding
        && object(value).chainBindingStatus === 'confirmed')) throw Error('recourse_auxiliary_binding_invalid');
  }
  if (options.lossTransaction !== undefined && !/^0x[0-9a-f]{64}$/.test(options.lossTransaction)) throw new Error('recourse_loss_transaction_invalid');
  if (options.lossTransaction !== undefined && (!Number.isSafeInteger(options.lossBlock) || options.lossBlock! < 1)) throw new Error('recourse_loss_block_invalid');
  const mnemonic = await SeedManager.getMnemonic(action);
  if (!mnemonic) throw new Error('recourse_seed_unavailable');
  const root = await deriveHumanAccount(mnemonic, 0);
  const raw = await SecureStore.getItemAsync(journalKey(root.evm, options.auxiliaryBinding));
  let journal: Journal | null = raw === null ? null : JSON.parse(raw) as Journal;
  if (journal && (journal.version !== 1 || journal.rootAddress !== root.evm
    || !/^0x[0-9a-f]{64}$/.test(journal.identity) || !/^0x[0-9a-f]{64}$/.test(journal.requestId)
    || !/^[0-9a-f]{64}$/.test(journal.authSecret) || Boolean(journal.auxiliary) !== Boolean(options.auxiliaryBinding)
    || (options.auxiliaryBinding !== undefined && journal.identity !== options.auxiliaryBinding))) throw new Error('recourse_journal_invalid');
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
    // Identity discovery does not require the stolen account's spending key.
    const history = options.auxiliaryBinding ? null : await discoverHumanIdentityHistory(mnemonic, network);
    const identity = options.auxiliaryBinding ?? history?.identity;
    if (!identity) throw new Error('recourse_binding_required');
    let breakOrigin: string | null = null;
    try { breakOrigin = await readBreakRecoveryContext(network); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'break_recovery_unavailable') throw error; }
    if (history && (breakOrigin ?? `0x${'00'.repeat(20)}`) !== history.points[0].breakOrigin) throw Error('recourse_break_history_changed');
    const replacement = breakOrigin ? await prepareHumanReplacementAccount(mnemonic, identity, network) : undefined;
    const legacyGeneration = replacement && history ? await discoverHistoricalCurveGeneration(mnemonic, history, network) : undefined;
    const state = await readOwnerChainState(identity, network);
    if (replacement && (replacement.nonce !== state.nonce || replacement.breakOrigin !== breakOrigin)) throw Error('recourse_replacement_state_changed');
    journal = { version: 1, rootAddress: root.evm, identity, requestId: hex32(),
      authSecret: hex32().slice(2), deviceId: await RelayAPIService.getMeterDeviceId(),
      kernel: state.deployment.addresses.kernel.toLowerCase(), revision: state.deployment.revision.toString(),
      nonce: state.nonce, accountGeneration: state.nonce + 1,
      ...(replacement ? { replacement, legacyGeneration } : {}),
      ...(options.auxiliaryBinding ? { auxiliary: true } : {}),
      ...(options.lossTransaction === undefined ? {} : { lossTransaction: options.lossTransaction, lossBlock: options.lossBlock }) };
    if (options.lossTransaction !== undefined) {
      const prepared = object(await RelayAPIService.recourseRequest('restoration-intents', {
        transactionHash: options.lossTransaction, block: options.lossBlock,
        ...(options.auxiliaryBinding ? { identity: options.auxiliaryBinding } : {}) }, action));
      if (prepared.kernel !== journal.kernel) throw new Error('recourse_owner_protocol_changed');
      journal.restoration = parseRestorationScope({ request: prepared.request, lossHash: prepared.lossHash, maximumLoss: prepared.maximumLoss });
    }
    if (!replacement) humanAccountPaths(journal.accountGeneration);
    await save(journal);
  }
  const state = journal;
  if (state.replacement && (state.replacement.identity !== state.identity || state.replacement.nonce !== state.nonce
    || state.replacement.accountGeneration !== String(state.accountGeneration))) throw Error('recourse_journal_invalid');
  const next = await (async () => {
    if (state.replacement) return { evm: state.replacement.account, sol: '' };
    if (!state.auxiliary) return deriveHumanAccount(mnemonic, state.accountGeneration);
    const key = await auxiliaryAccountKey(mnemonic, state.identity, state.accountGeneration);
    try { return { evm: computeAddress(`0x${bytesToHex(key)}`).toLowerCase(), sol: '' }; }
    finally { key.fill(0); }
  })();
  if (state.installed) {
    const current = await readOwnerChainState(state.identity, network);
    if (current.destination !== next.evm || current.nonce < state.nonce + 1) throw new Error('recourse_completed_recovery_superseded');
    return { destination: next.evm, requestId: state.requestId };
  }
  const derive = (purpose: 'recovery-secret' | 'recovery-signing', nonce: number) => state.replacement
    ? humanBreakKey(mnemonic, { identity: state.identity, breakOrigin: state.replacement.breakOrigin, chainId: '8453' }, purpose, String(nonce))
    : (purpose === 'recovery-secret' ? humanRecoverySecret : humanRecoverySigningSeed)(mnemonic, nonce, state.identity);
  const secret = derive('recovery-secret', state.nonce), seed = derive('recovery-signing', state.nonce);
  const nextSecret = derive('recovery-secret', state.nonce + 1), nextSeed = derive('recovery-signing', state.nonce + 1);
  try {
    const signingRoot = await recoverySigningRoot(seed), nextSigningRoot = await recoverySigningRoot(nextSeed);
    const nextCommitment = recoveryCommitment(nextSecret, nextSigningRoot);
    if (!state.authorizationTxHash) {
      const current = await readOwnerChainState(state.identity, network);
      if (state.replacement) {
        if (await readBreakRecoveryContext(network) !== state.replacement.breakOrigin) throw Error('recourse_break_history_changed');
        if (current.nonce === state.nonce && current.commitment === recoveryCommitment(secret, signingRoot) && current.signingRoot === signingRoot) {
          await deployHumanReplacementAccount(mnemonic, state.replacement, action, network, async plan => {
            state.replacement = plan; await save(state);
          }, options.signal);
        } else if (current.nonce !== state.nonce + 1 || current.destination !== next.evm
          || current.commitment !== nextCommitment || current.signingRoot !== nextSigningRoot || !state.intent) {
          throw Error('recourse_replacement_state_changed');
        }
      }
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
      const privateAccess = { identity: state.identity, secret, signingSeed: seed };
      let response = await RelayAPIService.recourseRecoveryRequest('owner-operations/recovery', operation, privateAccess);
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
        response = await RelayAPIService.recourseRecoveryRequest(`owner-operations/${id}`, undefined, privateAccess);
      }
    }
    await verifyOwnerOperationReceipt(operation, state.authorizationTxHash, network);
    const preimage = concat([operation.proof.recoverySecret, signingRoot]);
    const expiresAtMs = Date.now() + 300000;
    if (state.auxiliary) {
      const body = { kernel: state.kernel, identity: state.identity, preimage, destination: next.evm, nextCommitment, nextSigningRoot,
        authorizationTxHash: state.authorizationTxHash, authorizationNonce: state.nonce, requestId: state.requestId, expiresAtMs, ...(state.replacement ? { destinationKind: 'hash' as const } : {}) };
      const message = ['Provian auxiliary ownership recovery', 'chain:8453', `kernel:${state.kernel}`, `identity:${state.identity}`,
        `recovery:${sha256(preimage)}`, `destination:${next.evm}`, `next:${nextCommitment}`, `next-hash-authority:${nextSigningRoot}`,
        `authorization:${state.authorizationTxHash}`, `authorization-nonce:${state.nonce}`, `request:${state.requestId}`, `expires:${expiresAtMs}`,
        ...(state.replacement ? ['destination-signature:hash'] : [])].join('\n');
      const key = state.replacement ? null : await auxiliaryAccountKey(mnemonic, state.identity, state.accountGeneration);
      try {
        const signature = state.replacement
          ? await signHumanReplacementDestination(mnemonic, state.replacement, message, action, network)
          : await new ActionWallet(`0x${bytesToHex(key!)}`, action).signMessage(message);
        const result = object(await RelayAPIService.recourseRequest('recover-address', { ...body, signature }, action));
        if (result.identity !== state.identity || result.destination !== next.evm || typeof result.generation !== 'number'
          || !Number.isSafeInteger(result.generation) || result.generation < 1) throw Error('recourse_recovery_reply_invalid');
        await verifyOwnerOperationReceipt(operation, state.authorizationTxHash, network);
        state.installed = true; await save(state);
        return { destination: next.evm, requestId: state.requestId };
      } finally { key?.fill(0); }
    }
    const body = { kernel: state.kernel, identity: state.identity, preimage, destination: next.evm, nextCommitment, nextSigningRoot,
      authorizationTxHash: state.authorizationTxHash, authorizationNonce: state.nonce,
      requestId: state.requestId, deviceId: state.deviceId, authSecret: state.authSecret, expiresAtMs,
      ...(state.replacement ? { destinationKind: 'hash' as const } : {}) };
    const message = ['Provian human ownership recovery', 'chain:8453', `kernel:${state.kernel}`, `identity:${state.identity}`,
      `recovery:${sha256(preimage)}`, `destination:${next.evm}`, `next:${nextCommitment}`, `next-hash-authority:${nextSigningRoot}`,
      `authorization:${state.authorizationTxHash}`, `authorization-nonce:${state.nonce}`, `device:${state.deviceId}`,
      `credentials:${sha256(toUtf8Bytes(state.authSecret)).slice(2)}`, `request:${state.requestId}`, `expires:${expiresAtMs}`,
      ...(state.replacement ? ['destination-signature:hash'] : [])].join('\n');
    let signature: string;
    if (state.replacement) signature = await signHumanReplacementDestination(mnemonic, state.replacement, message, action, network);
    else {
      const bipSeed = await mnemonicToSeedPaced(mnemonic), hd = HDKey.fromMasterSeed(bipSeed);
      const child = hd.derive(humanAccountPaths(state.accountGeneration).evm);
      try {
        if (!child.privateKey) throw new Error('recourse_account_derivation_failed');
        signature = await new ActionWallet(`0x${bytesToHex(child.privateKey)}`, action).signMessage(message);
      } finally { bipSeed.fill(0); child.wipePrivateData(); hd.wipePrivateData(); }
    }
    const result = object(await RelayAPIService.recourseRecoveryRequest('recover-human', { ...body, signature }));
    // The private login identifier is supplied by the relay that owns it;
    // account selection and spending authority remain independently chain-verified.
    if (result.identity !== state.identity || typeof result.userId !== 'string' || result.userId.length === 0 || result.userId.length > 256
      || (state.userId !== undefined && result.userId !== state.userId)
      || result.destination !== next.evm || typeof result.generation !== 'number'
      || !Number.isSafeInteger(result.generation) || result.generation < 1) {
      throw new Error('recourse_recovery_reply_invalid');
    }
    // Verify again before any local credentials or signing selector changes.
    await verifyOwnerOperationReceipt(operation, state.authorizationTxHash, network);
    state.userId = result.userId; await save(state);
    assertBiometricAction(action);
    invalidateSeedDerivedCaches();
    if (state.replacement) await installHumanHashAccountSelection(mnemonic, state.identity, state.requestId, action, network, state.legacyGeneration);
    else await installHumanAccountSelection(mnemonic, { rootAddress: root.evm, generation: state.accountGeneration,
      ...next, recoveryGeneration: state.nonce + 1, recoveryCommitment: nextCommitment, requestId: state.requestId }, action);
    await RelayAPIService.setAuthSecret(state.authSecret, state.userId);
    await RelayAPIService.recordAddressProofAuthorization({ address: next.evm, userId: state.userId });
    state.installed = true; await save(state);
    return { destination: next.evm, requestId: state.requestId };
  } finally { secret.fill(0); seed.fill(0); nextSecret.fill(0); nextSeed.fill(0); }
}

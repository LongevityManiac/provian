import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { concat, hashMessage, hexlify, sha256, toUtf8Bytes } from 'ethers';
import { assertBiometricAction, type BiometricAction } from '../security/biometricAction';
import { ownerChainNetwork } from '../protocol/runtime';
import RelayAPIService from '../../services/RelayAPIService';
import { humanBreakKey, humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import { discoverHumanIdentityHistory, discoverAddressIdentityHistory, discoverHistoricalCurveGeneration, recoverHumanHistoricalMaterial } from './human-break-history';
import { discoverHumanHashAccountSelection, type HumanAccountSelection } from './human-account';
import { readBreakRecoveryContext, prepareBreakRecovery, type PreparedBreakRecovery } from './break-recovery';
import { parseBreakEntitlement } from './break-entitlement';
import { prepareBreakDeploymentRequest } from './break-deployment-proof';
import { recoverFreeBreak, type FreeBreakRecoveryPhase } from './free-break-recovery';
import { parseBreakRestorationRequest, breakRestorationDetails } from './break-restoration-data';
import { readOwnerChainState, type OwnerChainNetwork } from './owner-chain';
import { verifyBreakRecoveryReceipt } from './break-recovery-receipt';
import { signHashAccountMessage } from './hash-account';
import { discoverHashAccount } from './hash-account-deployment';
import { recoveryCommitment, recoverySigningRoot } from './hash-authorization';

interface Journal {
  version: 1; identity: string; origin: string; requestId: string; authSecret: string; deviceId: string;
  destination?: string; prepared?: PreparedBreakRecovery; transactionHash?: string; userId?: string; credentialsInstalled?: boolean;
  auxiliary?: true; bindingInstalled?: boolean;
}
const hash = /^0x[0-9a-f]{64}$/;
async function save(key: string, value: Journal): Promise<void> {
  const serialized = JSON.stringify(value);
  await SecureStore.setItemAsync(key, serialized, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  if (await SecureStore.getItemAsync(key) !== serialized) throw Error('recourse_break_journal_write_unconfirmed');
}
function reply(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('recourse_break_reply_invalid');
  return value as Record<string, unknown>;
}
let tail: Promise<unknown> = Promise.resolve();
async function privateRequest(mnemonic: string, identity: string, generation: number, path: string, body?: unknown): Promise<unknown> {
  // Chain execution may precede the relay credential cut. Start with the
  // original registered backup; historical credentials retain private access.
  // A seed first bound at a later generation can try its observed predecessors.
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= 0x80000000) throw Error('recourse_account_index_invalid');
  for (let candidate = 0; candidate <= generation; candidate++) {
    const secret = humanRecoverySecret(mnemonic, candidate, identity), signingSeed = humanRecoverySigningSeed(mnemonic, candidate, identity);
    try { return await RelayAPIService.recourseRecoveryRequest(path, body, { identity, secret, signingSeed }); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'recourse_private_unavailable' || candidate === generation) throw error;
    } finally { secret.fill(0); signingSeed.fill(0); }
  }
  throw Error('recourse_private_unavailable');
}
/** Restore screens also resume a cut interrupted after its chain receipt but
 * before the relay credentials were installed. */
export async function discoverHumanAccountForRestore(mnemonic: string, action: BiometricAction,
  network: OwnerChainNetwork = ownerChainNetwork()): Promise<{ identity: string; selection: HumanAccountSelection | null } | null> {
  const { discoverHumanAccount } = await import('./human-discovery');
  let found: Awaited<ReturnType<typeof discoverHumanAccount>>;
  try { found = await discoverHumanAccount(mnemonic, network); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'recourse_break_restoration_required') throw error;
    return recoverHumanBreak(mnemonic, action, { network });
  }
  if (found?.selection?.kind === 'hash') {
    const origin = found.selection.hashAccount!.breakOrigin;
    const raw = await SecureStore.getItemAsync(`provian_break_recovery_${found.identity.slice(2)}_${origin.slice(2)}`);
    if (raw !== null && (JSON.parse(raw) as Journal).credentialsInstalled !== true) return recoverHumanBreak(mnemonic, action, { network });
    if (raw === null) {
      const discovery = reply(await privateRequest(mnemonic, found.identity, found.selection.generation, `break-recovery-state/${origin}/${found.identity}`));
      if (discovery.identity !== found.identity || discovery.origin !== origin) throw Error('recourse_break_discovery_invalid');
      // This hint grants no credentials. If the relay cut already happened,
      // the normal recovery endpoint still verifies a fresh hash signature.
      if (discovery.relayDestination !== found.selection.evm) return recoverHumanBreak(mnemonic, action, { network });
    }
  }
  return found;
}
/** Original backup material reconstructs every replacement key. The protected
 * journal fixes credentials and exact pending intent before publication; a
 * network wait never installs or selects an unverified account. */
interface BreakOptions {
  network?: OwnerChainNetwork; signal?: AbortSignal; phase?(phase: FreeBreakRecoveryPhase): void;
}
export function recoverHumanBreak(mnemonic: string, action: BiometricAction, options: BreakOptions = {}): Promise<{ identity: string; selection: HumanAccountSelection }> {
  const run = tail.then(async () => {
    const result = await perform(mnemonic, action, options);
    if (!('selection' in result)) throw Error('recourse_break_result_invalid');
    return result;
  });
  tail = run.catch(() => undefined); return run;
}
export function recoverHumanAuxiliaryBreak(mnemonic: string, action: BiometricAction,
  binding: { identity: string; originAddress: string }, options: BreakOptions = {}): Promise<{ identity: string; destination: string }> {
  const run = tail.then(async () => {
    const result = await perform(mnemonic, action, { ...options, auxiliary: binding });
    if (!('destination' in result)) throw Error('recourse_break_result_invalid');
    return result;
  });
  tail = run.catch(() => undefined); return run;
}
async function perform(mnemonic: string, action: BiometricAction, options: BreakOptions & {
  auxiliary?: { identity: string; originAddress: string };
}): Promise<{ identity: string; selection: HumanAccountSelection } | { identity: string; destination: string }> {
  assertBiometricAction(action); options.signal?.throwIfAborted();
  const network = options.network ?? ownerChainNetwork();
  if (options.auxiliary) {
    const owned = reply(await RelayAPIService.recourseRequest('ownership'));
    if (!hash.test(options.auxiliary.identity) || owned.identity === options.auxiliary.identity || !Array.isArray(owned.addresses)
      || !owned.addresses.some(value => { const row = reply(value); return row.identity === options.auxiliary!.identity
        && row.address === options.auxiliary!.originAddress && row.recoveryGeneration === 0 && row.chainBindingStatus === 'confirmed'; })) {
      throw Error('recourse_auxiliary_binding_invalid');
    }
  }
  const history = options.auxiliary ? await discoverAddressIdentityHistory(options.auxiliary.originAddress, network)
    : await discoverHumanIdentityHistory(mnemonic, network);
  if (!history) throw Error('recourse_binding_required');
  if (options.auxiliary && history.identity !== options.auxiliary.identity) throw Error('recourse_auxiliary_binding_invalid');
  const identity = history.identity, origin = await readBreakRecoveryContext(network);
  if (history.points[0].breakOrigin !== origin) throw Error('recourse_break_history_changed');
  const key = `provian_break_recovery_${identity.slice(2)}_${origin.slice(2)}${options.auxiliary ? '_aux' : ''}`;
  const stored = await SecureStore.getItemAsync(key);
  const state: Journal = stored === null ? { version: 1, identity, origin,
    requestId: hexlify(Crypto.getRandomBytes(32)), authSecret: hexlify(Crypto.getRandomBytes(32)).slice(2),
    deviceId: await RelayAPIService.getMeterDeviceId(), ...(options.auxiliary ? { auxiliary: true } : {}) } : JSON.parse(stored) as Journal;
  if (state.version !== 1 || state.identity !== identity || state.origin !== origin || !hash.test(state.requestId)
    || !/^[0-9a-f]{64}$/.test(state.authSecret) || !/^[a-zA-Z0-9_-]{1,128}$/.test(state.deviceId)
    || Boolean(state.auxiliary) !== Boolean(options.auxiliary)) throw Error('recourse_break_journal_invalid');
  await save(key, state);
  const legacyGeneration = options.auxiliary ? 0 : await discoverHistoricalCurveGeneration(mnemonic, history, network);
  const context = { identity, breakOrigin: origin, chainId: '8453' };
  const destinationSigningSeed = humanBreakKey(mnemonic, context, 'spending', '0');
  const nextRecoverySecret = humanBreakKey(mnemonic, context, 'recovery-secret', '1');
  const nextRecoverySigningSeed = humanBreakKey(mnemonic, context, 'recovery-signing', '1');
  try {
    if (!state.transactionHash && !/^0x0{40}$/.test((await readOwnerChainState(identity,network)).destination)) {
      const discovery = reply(await privateRequest(mnemonic, identity, legacyGeneration, `break-recovery-state/${origin}/${identity}`));
      if (discovery.identity !== identity || discovery.origin !== origin || !Array.isArray(discovery.candidates)) throw Error('recourse_break_discovery_invalid');
      const initialRoot = await recoverySigningRoot(destinationSigningSeed), nextRoot = await recoverySigningRoot(nextRecoverySigningSeed);
      const nextCommitment = recoveryCommitment(nextRecoverySecret,nextRoot);
      let completed: { prepared: PreparedBreakRecovery; transactionHash: string } | null = null;
      for (const raw of discovery.candidates) {
        const candidate = reply(raw), p = reply(candidate.prepared);
        const request = parseBreakRestorationRequest({kernel:p.kernel,ownerIntent:p.ownerIntent,data:p.data}), details = breakRestorationDetails(request);
        if (details.identity !== identity || details.destinationKeyRoot !== initialRoot
          || details.proof.nextSigningRoot !== nextRoot || details.proof.nextCommitment !== nextCommitment) continue;
        if (typeof candidate.transactionHash !== 'string' || !hash.test(candidate.transactionHash)
          || typeof p.executor !== 'string' || !/^0x[0-9a-f]{40}$/.test(p.executor)
          || typeof p.authority !== 'string' || !/^0x[0-9a-f]{40}$/.test(p.authority)) throw Error('recourse_break_discovery_invalid');
        const prepared: PreparedBreakRecovery = {phase:'restore_balance',...request,executor:p.executor,authority:p.authority,
          identity,destination:details.destination,amount:details.amount,manifestHash:(await network.deployment()).manifestHash};
        await verifyBreakRecoveryReceipt(prepared,candidate.transactionHash,network);
        if (completed) throw Error('recourse_break_discovery_ambiguous');
        completed = {prepared,transactionHash:candidate.transactionHash};
      }
      if (!completed) throw Error('recourse_break_restoration_receipt_missing');
      state.prepared = completed.prepared; state.transactionHash = completed.transactionHash;
      state.destination = completed.prepared.destination; await save(key,state);
    }
    if (!state.transactionHash) {
      const e = parseBreakEntitlement(await privateRequest(mnemonic, identity, legacyGeneration, `break-entitlements/${origin}/${identity}`));
      if (e.identity !== identity) throw Error('recourse_break_identity_changed');
      const material = await recoverHumanHistoricalMaterial(mnemonic, history, e.commitment, network);
      const persistDestination = async (destination: string) => {
        assertBiometricAction(action);
        if (state.destination && state.destination !== destination) throw Error('recourse_break_destination_changed');
        state.destination = destination; await save(key, state);
      };
      try {
        const completed = await recoverFreeBreak({ network, signal: options.signal, phase: options.phase,
          transport: { request: (path, body) => privateRequest(mnemonic, identity, legacyGeneration, path, body) },
          pendingRestoration: async () => state.prepared?.phase === 'restore_balance' ? state.prepared : null,
          prepareDeployment: () => prepareBreakDeploymentRequest({ network, entitlement: e, expectedBreakOrigin: origin,
            recoverySecret: material.secret, recoverySigningSeed: material.signingSeed, destinationSigningSeed,
            persistBeforePublishing: selected => persistDestination(selected.account) }),
          prepareRecovery: async destination => {
            const prepared = await prepareBreakRecovery({ network, entitlement: e, expectedBreakOrigin: origin,
              recoverySecret: material.secret, recoverySigningSeed: material.signingSeed, destination, destinationSigningSeed,
              nextRecoverySecret, nextRecoverySigningSeed, persistBeforePublishing: backup => persistDestination(backup.destination) });
            state.prepared = prepared; await save(key, state); return prepared;
          },
        });
        state.prepared = completed.prepared; state.transactionHash = completed.transactionHash; await save(key, state);
      } finally { material.secret.fill(0); material.signingSeed.fill(0); }
    }
    const prepared = state.prepared;
    if (!prepared || !state.transactionHash || !prepared.ownerIntent) throw Error('recourse_break_journal_invalid');
    await verifyBreakRecoveryReceipt(prepared, state.transactionHash, network);
    const details = breakRestorationDetails(parseBreakRestorationRequest({ kernel: prepared.kernel,
      ownerIntent: prepared.ownerIntent, data: prepared.data }));
    const owner = await readOwnerChainState(identity, network);
    const initialRoot = await recoverySigningRoot(destinationSigningSeed);
    const account = await discoverHashAccount(initialRoot, network, origin);
    if (account.account !== prepared.destination || account.nonce === null) throw Error('recourse_break_destination_changed');
    const signingSeed = humanBreakKey(mnemonic, context, 'spending', account.nonce);
    try {
      if (await recoverySigningRoot(signingSeed) !== account.currentRoot) throw Error('recourse_hash_account_key_mismatch');
      const preimage = concat([details.proof.recoverySecret, details.proof.signingRoot]), expiresAtMs = Date.now() + 300000;
      if (options.auxiliary) {
        // A restored seed can discover a completed chain + relay cut without
        // the device journal. Reuse only the private request ID bound to this
        // independently verified transaction and exact derived destination.
        const owned = reply(await RelayAPIService.recourseRequest('ownership'));
        if (owned.identity === identity || !Array.isArray(owned.addresses)) throw Error('recourse_auxiliary_binding_invalid');
        const completed = owned.addresses.map(reply).filter(row => row.identity === identity
          && row.address === account.account && row.chainBindingStatus === 'confirmed'
          && row.authorizationTxHash === state.transactionHash);
        if (completed.length > 1) throw Error('recourse_break_discovery_ambiguous');
        if (completed.length) {
          const requestId = completed[0].recoveryRequestId;
          if (typeof requestId !== 'string' || !hash.test(requestId)
            || (state.bindingInstalled && requestId !== state.requestId)) throw Error('recourse_break_reply_invalid');
          state.requestId = requestId; await save(key, state);
        }
        const body = { kernel: prepared.kernel, identity, preimage, destination: prepared.destination,
          nextCommitment: details.proof.nextCommitment, nextSigningRoot: details.proof.nextSigningRoot,
          authorizationTxHash: state.transactionHash, authorizationNonce: owner.nonce - 1,
          requestId: state.requestId, expiresAtMs, destinationKind: 'hash' as const, breakDestinationRoot: initialRoot };
        const message = ['Provian auxiliary ownership recovery', 'chain:8453', `kernel:${body.kernel}`, `identity:${identity}`,
          `recovery:${sha256(preimage)}`, `destination:${body.destination}`, `next:${body.nextCommitment}`,
          `next-hash-authority:${body.nextSigningRoot}`, `authorization:${body.authorizationTxHash}`,
          `authorization-nonce:${body.authorizationNonce}`, `request:${state.requestId}`, `expires:${expiresAtMs}`,
          'destination-signature:hash', `break-destination-root:${initialRoot}`].join('\n');
        assertBiometricAction(action);
        const signature = await signHashAccountMessage(account.account, hashMessage(message), signingSeed);
        const result = reply(await RelayAPIService.recourseRequest('recover-address', { ...body, signature }, action));
        if (result.identity !== identity || result.destination !== account.account
          || !Number.isSafeInteger(result.generation) || Number(result.generation) < 1) throw Error('recourse_break_reply_invalid');
        await verifyBreakRecoveryReceipt(prepared, state.transactionHash, network);
        state.bindingInstalled = true; await save(key, state);
        return { identity, destination: account.account };
      }
      const body = { kernel: prepared.kernel, identity, preimage, destination: prepared.destination,
        nextCommitment: details.proof.nextCommitment, nextSigningRoot: details.proof.nextSigningRoot,
        authorizationTxHash: state.transactionHash, authorizationNonce: owner.nonce - 1,
        requestId: state.requestId, deviceId: state.deviceId, authSecret: state.authSecret, expiresAtMs,
        destinationKind: 'hash' as const, breakDestinationRoot: initialRoot };
      const message = ['Provian human ownership recovery', 'chain:8453', `kernel:${body.kernel}`, `identity:${identity}`,
        `recovery:${sha256(preimage)}`, `destination:${body.destination}`, `next:${body.nextCommitment}`,
        `next-hash-authority:${body.nextSigningRoot}`, `authorization:${body.authorizationTxHash}`,
        `authorization-nonce:${body.authorizationNonce}`, `device:${state.deviceId}`,
        `credentials:${sha256(toUtf8Bytes(state.authSecret)).slice(2)}`, `request:${state.requestId}`, `expires:${expiresAtMs}`,
        'destination-signature:hash', `break-destination-root:${initialRoot}`].join('\n');
      assertBiometricAction(action);
      const signature = await signHashAccountMessage(account.account, hashMessage(message), signingSeed);
      const result = reply(await RelayAPIService.recourseRecoveryRequest('recover-human', { ...body, signature }));
      if (result.identity !== identity || typeof result.userId !== 'string' || result.userId.length === 0 || result.userId.length > 256
        || (state.userId !== undefined && result.userId !== state.userId)
        || result.destination !== account.account || !Number.isSafeInteger(result.generation) || Number(result.generation) < 1) throw Error('recourse_break_reply_invalid');
      await verifyBreakRecoveryReceipt(prepared, state.transactionHash, network);
      const selection = await discoverHumanHashAccountSelection(mnemonic, identity, state.requestId, network, legacyGeneration);
      state.userId = result.userId; await save(key, state);
      assertBiometricAction(action);
      await RelayAPIService.setAuthSecret(state.authSecret, result.userId);
      await RelayAPIService.recordAddressProofAuthorization({ address: account.account, userId: result.userId });
      state.credentialsInstalled = true; await save(key, state);
      return { identity, selection };
    } finally { signingSeed.fill(0); }
  } finally { destinationSigningSeed.fill(0); nextRecoverySecret.fill(0); nextRecoverySigningSeed.fill(0); }
}

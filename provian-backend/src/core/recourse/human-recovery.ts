import { createHash } from 'crypto';
import { ethers } from 'ethers';
import type { DocumentReference, DocumentSnapshot } from 'firebase-admin/firestore';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { isActiveHumanWallet } from '../wallet/active-human-wallet';
import { newMobileDeviceRegistration, ownerParticipantClass } from '../identity/participant-class';
import { currentProtocolDeployment } from '../protocol/runtime';
import { readAgreedBaseHead } from '../onchain/economic-discovery';
import { createNativeWalletRegistrationFence, NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId,
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION } from '../pvt/native-wallet-registration';
import { prepareNativeWalletWatcherRegistration, writeNativeWalletWatcherRegistration,
  WATCHER_ADDRESS_ADMISSION_COLLECTION, watcherAddressAdmissionDocId, type NativeWalletWatcherRegistrationPlan } from '../pvt/watcher-address-admission';
import { PROVEN_ADDRESSES_COLLECTION, HUMAN_PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION, humanWalletRegistrationIndexId } from '../pvt/genesis-ingress';
import { identityHash, recoveryHash, prepareRecoveryTransaction, RECOURSE_COLLECTIONS,
  type PreparedRecovery, type RegisteredAddress } from './ownership';
import { verifyRecoveryAuthorization } from './recovery-authorization';
import { createRecourseChainPort, type RecourseChainPort } from './chain-ledger';
import { verifyHashDestinationProof } from './hash-destination-proof';

export interface HumanRecoveryRequest {
  readonly kernel: string; readonly identity: string; readonly preimage: string; readonly destination: string;
  readonly nextCommitment: string; readonly nextSigningRoot: string; readonly requestId: string;
  readonly authorizationTxHash: string; readonly authorizationNonce: number;
  readonly deviceId: string; readonly authSecret: string; readonly expiresAtMs: number; readonly signature: string;
  readonly destinationKind?: 'hash';
  readonly breakDestinationRoot?: string;
}
const hash = /^0x[0-9a-f]{64}$/, address = /^0x[0-9a-f]{40}$/;
export function humanRecoveryMessage(input: Omit<HumanRecoveryRequest, 'signature'>): string {
  if (![input.kernel, input.destination].every(v => address.test(v))
    || ![input.identity, input.nextCommitment, input.nextSigningRoot, input.requestId, input.authorizationTxHash].every(v => hash.test(v))
    || !/^0x[0-9a-f]{128}$/.test(input.preimage) || !/^[0-9a-f]{64}$/.test(input.authSecret)
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.deviceId) || !Number.isSafeInteger(input.expiresAtMs)
    || !Number.isSafeInteger(input.authorizationNonce) || input.authorizationNonce < 0 || input.authorizationNonce >= Number.MAX_SAFE_INTEGER
    || (input.destinationKind !== undefined && input.destinationKind !== 'hash')
    || (input.breakDestinationRoot !== undefined && (input.destinationKind !== 'hash'
      || !hash.test(input.breakDestinationRoot) || /^0x0+$/.test(input.breakDestinationRoot)))) {
    throw new Error('recourse_human_recovery_invalid');
  }
  return ['Provian human ownership recovery', 'chain:8453', `kernel:${input.kernel}`, `identity:${input.identity}`,
    `recovery:${recoveryHash(Buffer.from(input.preimage.slice(2), 'hex'))}`, `destination:${input.destination}`,
    `next:${input.nextCommitment}`, `next-hash-authority:${input.nextSigningRoot}`,
    `authorization:${input.authorizationTxHash}`, `authorization-nonce:${input.authorizationNonce}`,
    `device:${input.deviceId}`, `credentials:${createHash('sha256').update(input.authSecret).digest('hex')}`,
    `request:${input.requestId}`, `expires:${input.expiresAtMs}`,
    ...(input.destinationKind === 'hash' ? ['destination-signature:hash'] : []),
    ...(input.breakDestinationRoot === undefined ? [] : [`break-destination-root:${input.breakDestinationRoot}`])].join('\n');
}
export function parseHumanRecoveryRequest(value: unknown): HumanRecoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recourse_human_recovery_invalid');
  const keys = ['kernel', 'identity', 'preimage', 'destination', 'nextCommitment', 'nextSigningRoot', 'requestId',
    'authorizationTxHash', 'authorizationNonce', 'deviceId', 'authSecret', 'expiresAtMs', 'signature'];
  if ('destinationKind' in value) keys.push('destinationKind');
  if ('breakDestinationRoot' in value) keys.push('breakDestinationRoot');
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error('recourse_human_recovery_invalid');
  const input = value as HumanRecoveryRequest;
  humanRecoveryMessage(input);
  const signaturePattern = input.destinationKind === 'hash' ? /^0x[0-9a-f]{15776}$/ : /^0x[0-9a-fA-F]{130}$/;
  if (typeof input.signature !== 'string' || !signaturePattern.test(input.signature)) throw new Error('recourse_destination_proof_invalid');
  return input;
}
export interface HumanRecoveryPorts {
  readonly chain: RecourseChainPort;
  head(): Promise<number>;
  verify: typeof verifyRecoveryAuthorization;
  verifyHashDestination?: typeof verifyHashDestinationProof;
}
/** Identity, auth, native indexes, prospective earning fence and the owner's
 * append-only recovery PE commit together. Birth/grant records never reissue. */
export async function recoverHumanOwnership(deps: AgentBankDeps, input: HumanRecoveryRequest, nowMs = Date.now(),
  ports: HumanRecoveryPorts = { chain: createRecourseChainPort(), head: readAgreedBaseHead, verify: verifyRecoveryAuthorization }):
Promise<{ userId: string; walletId: string; destination: string; generation: number }> {
  const message = humanRecoveryMessage(input);
  if (input.expiresAtMs < nowMs || input.expiresAtMs > nowMs + 300000) throw new Error('recourse_destination_proof_invalid');
  if (input.destinationKind === 'hash') await (ports.verifyHashDestination ?? verifyHashDestinationProof)(input.destination, message, input.signature);
  else if (ethers.verifyMessage(message, input.signature).toLowerCase() !== input.destination) throw new Error('recourse_destination_proof_invalid');
  const currentKernel = (await currentProtocolDeployment()).addresses.kernel.toLowerCase();
  const owner = await deps.db.collection(RECOURSE_COLLECTIONS.identities).doc(input.identity).get();
  const userId: unknown = owner.get('ownerId'), walletId: unknown = owner.get('walletId');
  if (!owner.exists || owner.get('ownerType') !== 'human' || typeof userId !== 'string' || typeof walletId !== 'string'
    || identityHash('human', userId) !== input.identity) throw new Error('recourse_recovery_proof_invalid');
  const walletRef = deps.db.collection('wallets').doc(walletId), userRef = deps.db.collection('users').doc(userId);
  const authRef = deps.db.collection('auth_secrets').doc(userId);
  const recoveryRef = deps.db.collection(RECOURSE_COLLECTIONS.recoveries).doc(input.requestId);
  const replay = await recoveryRef.get();
  if (replay.exists) {
    const [wallet, auth] = await Promise.all([walletRef.get(), authRef.get()]);
    if (replay.get('identity') !== input.identity || replay.get('destination') !== input.destination
      || replay.get('nextCommitment') !== input.nextCommitment || replay.get('nextSigningRoot') !== input.nextSigningRoot
      || replay.get('authorizationTxHash') !== input.authorizationTxHash || replay.get('consumedCommitment') !== recoveryHash(Buffer.from(input.preimage.slice(2), 'hex'))
      || wallet.get('address') !== input.destination || auth.get('secret') !== input.authSecret) throw new Error('recourse_recovery_replay');
    await deps.cache.setUserAuthSecret(userId, input.authSecret);
    return { userId, walletId, destination: input.destination, generation: Number(replay.get('generation')) };
  }
  const preimage = Buffer.from(input.preimage.slice(2), 'hex');
  try {
    const authorization = await ports.verify({ kernel: input.kernel, currentKernel, identity: input.identity, destination: input.destination,
      consumedCommitment: recoveryHash(preimage), nextCommitment: input.nextCommitment, nextSigningRoot: input.nextSigningRoot,
      nonce: input.authorizationNonce, transactionHash: input.authorizationTxHash,
      ...(input.breakDestinationRoot === undefined ? {} : { breakDestinationRoot: input.breakDestinationRoot }) });
    const observedHead = await ports.head(), observedHash = await ports.chain.blockHash(observedHead);
    if (!observedHash || authorization.block > observedHead) throw new Error('recourse_admission_unavailable');
    const balance = await ports.chain.balance(currentKernel, input.destination, authorization.accountingBlockHash ?? authorization.blockHash);
    const priorWallet = await walletRef.get();
    const previousAddress: unknown = priorWallet.get('address');
    if (!isActiveHumanWallet(priorWallet.data()) || priorWallet.get('user_id') !== userId
      || typeof previousAddress !== 'string' || !address.test(previousAddress.toLowerCase())
      || previousAddress.toLowerCase() === input.destination) throw new Error('recourse_human_wallet_invalid');
    const oldAddress = previousAddress.toLowerCase(), fence = createNativeWalletRegistrationFence(observedHead);
    const ref = (collection: string, id: string) => deps.db.collection(collection).doc(id);
    const refs = {
      oldIndex: ref(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId(oldAddress)),
      newIndex: ref(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId(input.destination)),
      oldRetired: ref(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION, oldAddress),
      newRetired: ref(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION, input.destination),
      agentProven: ref(PROVEN_ADDRESSES_COLLECTION, input.destination), humanProven: ref(HUMAN_PROVEN_ADDRESSES_COLLECTION, input.destination),
      birth: ref(HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION, humanWalletRegistrationIndexId(userId)),
      oldAdmission: ref(WATCHER_ADDRESS_ADMISSION_COLLECTION, watcherAddressAdmissionDocId({ direction: 'inbound', chainId: 8453,
        address: oldAddress, walletId, agentId: userId, eligibilityStartBlock: 0 })),
    };
    const networkClass = await ownerParticipantClass(deps.db, userId);
    let prepared: PreparedRecovery | undefined, watcher: NativeWalletWatcherRegistrationPlan | undefined;
    let devices: Record<string, unknown>[] = [], birthPublicKey = '';
    const proof = { identity: input.identity, preimage, destination: input.destination, nextCommitment: input.nextCommitment,
      nextSigningRoot: input.nextSigningRoot, requestId: input.requestId, nowMs, authorizationTxHash: input.authorizationTxHash, authorization };
    if (await ports.chain.blockHash(observedHead) !== observedHash) throw new Error('recourse_admission_reorg');
    await generatePE(deps, { walletId, agentId: userId, actorAddress: input.destination, ownerType: 'human', walletAddress: input.destination,
      actionType: 'recovery_action', peIdOverride: `pe_human_recovery_${input.requestId.slice(2)}`, timestampOverride: nowMs,
      metadata: { recovery_kind: 'independent_owner_recovery', old_address: oldAddress, new_address: input.destination,
        authorization_transaction: input.authorizationTxHash, recovery_request: input.requestId },
      atomicEntityPrecondition: async tx => {
        const entries = Object.entries(refs) as [keyof typeof refs, DocumentReference][];
        const [wallet, user, ...snapshots] = await Promise.all([tx.get(walletRef), tx.get(userRef), ...entries.map(([, r]) => tx.get(r))]);
        const docs = Object.fromEntries(entries.map(([key], index) => [key, snapshots[index]])) as Record<keyof typeof refs, DocumentSnapshot>;
        if (!isActiveHumanWallet(wallet.data()) || wallet.get('address')?.toLowerCase() !== oldAddress || wallet.get('user_id') !== userId
          || !user.exists || docs.oldIndex.get('owner_type') !== 'human' || docs.oldIndex.get('owner_id') !== userId
          || docs.oldIndex.get('wallet_id') !== walletId || docs.newIndex.exists || docs.oldRetired.exists || docs.newRetired.exists
          || docs.agentProven.exists || docs.humanProven.exists || docs.birth.get('wallet_id') !== walletId
          || docs.birth.get('user_id') !== userId) throw new Error('recourse_human_state_changed');
        const existingDevices: unknown = user.get('devices');
        if (existingDevices !== undefined && !Array.isArray(existingDevices)) throw new Error('recourse_human_state_changed');
        devices = (existingDevices ?? []).map((device: unknown) => {
          if (!device || typeof device !== 'object' || !('id' in device) || typeof device.id !== 'string') throw new Error('recourse_human_state_changed');
          return { ...device };
        });
        const device = devices.find(d => d.id === input.deviceId);
        if (device) Object.assign(device, { last_seen: nowMs, network_class: networkClass });
        else devices.push({ ...newMobileDeviceRegistration(input.deviceId, 'Recovered Device', nowMs), network_class: networkClass });
        const publicKey: unknown = wallet.get('birth_public_key') ?? wallet.get('public_key');
        if (typeof publicKey !== 'string' || createHash('sha256').update(publicKey).digest('hex') !== docs.birth.get('public_key_sha256')) {
          throw new Error('recourse_human_birth_mismatch');
        }
        birthPublicKey = publicKey;
        prepared = await prepareRecoveryTransaction(deps.db, tx, proof);
        if (prepared.replay) throw new Error('recourse_human_state_changed');
        watcher = await prepareNativeWalletWatcherRegistration(deps.db, tx, { direction: 'inbound', chainId: 8453,
          address: input.destination, walletId, agentId: userId, eligibilityStartBlock: fence.eligibility_start_block }, nowMs);
      },
      atomicEntityWrite: (tx, peId) => {
        if (!prepared || !watcher) throw new Error('recourse_human_state_missing');
        prepared.write(tx);
        tx.update(walletRef, { address: input.destination, public_key: input.destination, birth_public_key: birthPublicKey,
          native_watcher_registration: fence, address_proven_at_ms: nowMs, recourse_request_id: input.requestId, recovered_at_ms: nowMs });
        tx.update(userRef, { wallet_address: input.destination, devices });
        tx.set(authRef, { secret: input.authSecret, created_at: nowMs });
        tx.create(refs.newIndex, { schema_version: 'native-wallet-address-index/v1', chain_id: 8453, address: input.destination,
          wallet_id: walletId, owner_type: 'human', owner_id: userId, created_at_ms: nowMs });
        tx.delete(refs.oldIndex);
        tx.create(refs.oldRetired, { schema_version: 'native-wallet-address-retirement/v1', chain_id: 8453, address: oldAddress,
          wallet_id: walletId, owner_type: 'human', owner_id: userId, new_address: input.destination, retired_at_ms: nowMs, rotation_pe_id: peId });
        writeNativeWalletWatcherRegistration(tx, watcher, nowMs); tx.delete(refs.oldAdmission);
        const binding: RegisteredAddress = { identity: input.identity, address: input.destination, kernel: currentKernel,
          boundBlock: authorization.accountingBlock ?? authorization.block, boundBlockHash: authorization.accountingBlockHash ?? authorization.blockHash, boundAtMs: nowMs,
          openingBalanceAtomic: balance.toString(), bindingDigest: ethers.hashMessage(message), recoveryGeneration: prepared.generation,
          chainBindingStatus: 'confirmed', ledgerNeedsCatchup: true };
        tx.create(ref(RECOURSE_COLLECTIONS.addresses, input.destination), binding);
      },
    });
    if (!prepared) throw new Error('recourse_human_state_missing');
    await deps.cache.setUserAuthSecret(userId, input.authSecret);
    return { userId, walletId, destination: input.destination, generation: prepared.generation };
  } finally { preimage.fill(0); }
}

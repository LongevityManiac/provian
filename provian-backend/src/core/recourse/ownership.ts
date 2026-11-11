import { createHash, timingSafeEqual } from 'crypto';
import { assertRecoveryAuthorization, recoveryAuthorizationBreakOrigin, type RecoveryAuthorizationEvidence } from './recovery-authorization';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { ethers } from 'ethers';
import { verifyExternalAddressSignature, type ExternalVerifyDeps } from '../external-address/verify';
import { assertExternalProofFenceEvidence, type ExternalProofFenceEvidence } from '../external-address/proof-head';
import { currentProtocolDeployment } from '../protocol/runtime';
import { NATIVE_WALLET_ADDRESS_INDEX_COLLECTION, nativeWalletAddressIndexId } from '../pvt/native-wallet-registration';
import { PROVEN_ADDRESSES_COLLECTION, HUMAN_PROVEN_ADDRESSES_COLLECTION } from '../external-address/link';
import { addressRecoveryBinding } from './address-binding';

export const RECOURSE_COLLECTIONS = Object.freeze({
  owners: 'recourse_private_owners_v1',
  identities: 'recourse_identities_v1',
  addresses: 'recourse_addresses_v1',
  recoveries: 'recourse_recoveries_v1',
  events: 'recourse_transfer_events_v1',
  commitments: 'recourse_commitments_v1',
});
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO = `0x${'0'.repeat(40)}`;

import { recourseBindingMessage as ownershipBindingMessage, type RecourseBinding as OwnershipBinding } from './binding';
export { recourseBindingMessage as ownershipBindingMessage, type RecourseBinding as OwnershipBinding } from './binding';

export function recoveryHash(preimage: Uint8Array): string {
  if (preimage.length !== 64) throw new Error('recourse_preimage_invalid');
  return `0x${createHash('sha256').update(preimage).digest('hex')}`;
}

export function identityHash(ownerType: 'human' | 'agent', ownerId: string): string {
  if (!ownerId || ownerId.length > 256) throw new Error('recourse_identity_invalid');
  return `0x${createHash('sha256').update(JSON.stringify(['provian ownership', ownerType, ownerId])).digest('hex')}`;
}

/** Resolve the login wallet's binding privately. An auxiliary address can never
 * become the authority for changing the owner's relay login or native wallet. */
export async function primaryBindingIdentity(db: Firestore,
  owner: { readonly type: 'human' | 'agent'; readonly id: string; readonly walletId: string }): Promise<string> {
  const privateOwner = identityHash(owner.type, owner.id);
  const row = await db.collection(RECOURSE_COLLECTIONS.owners).doc(privateOwner).get();
  const binding: unknown = row.get('primaryBinding');
  if (!row.exists || typeof binding !== 'string' || !HASH.test(binding)
    || row.get('ownerType') !== owner.type || row.get('ownerId') !== owner.id || row.get('walletId') !== owner.walletId) {
    throw Error('recourse_primary_binding_required');
  }
  const proof = await db.collection(RECOURSE_COLLECTIONS.identities).doc(binding).get();
  if (!proof.exists || proof.get('identity') !== binding || proof.get('ownerIdentity') !== privateOwner
    || proof.get('primaryBinding') !== true || proof.get('ownerType') !== owner.type
    || proof.get('ownerId') !== owner.id || proof.get('walletId') !== owner.walletId) throw Error('recourse_primary_binding_invalid');
  return binding;
}

export interface RegisteredAddress {
  /** Private portfolio key; never encoded in a contract call or public response. */
  readonly ownerIdentity?: string;
  readonly identity: string;
  readonly address: string;
  readonly kernel: string;
  readonly boundBlock: number;
  readonly boundLogIndex?: number;
  readonly boundAtMs?: number;
  readonly boundBlockHash: string;
  readonly openingBalanceAtomic: string;
  readonly bindingDigest: string;
  readonly recoveryGeneration: number;
  readonly chainBindingStatus?: 'pending' | 'confirmed';
  readonly ledgerNeedsCatchup?: boolean;
}

/**
 * This API re-verifies the actual signature; there is no client-supplied verified flag.
 * Baseline balance and finalized fence are read by the server's independent-RPC chain port.
 */
export async function registerOwnership(
  db: Firestore,
  input: {
    readonly binding: OwnershipBinding;
    readonly signature: string;
    readonly authenticatedIdentity: string;
    readonly owner: { readonly type: 'human' | 'agent'; readonly id: string; readonly walletId: string };
    readonly nowMs: number;
    readonly fence: ExternalProofFenceEvidence;
    readonly balanceAtomic: bigint;
    readonly admissionBlock: number;
    readonly admissionBlockHash: string;
  },
  verifyDeps?: ExternalVerifyDeps,
): Promise<RegisteredAddress> {
  const { binding, fence } = input;
  const deployment = await currentProtocolDeployment();
  if (binding.kernel !== deployment.addresses.kernel.toLowerCase()) throw new Error('recourse_kernel_invalid');
  const message = ownershipBindingMessage(binding);
  assertExternalProofFenceEvidence(fence);
  if (input.authenticatedIdentity !== identityHash(input.owner.type, input.owner.id)
    || binding.identity !== addressRecoveryBinding({ chainId: '8453', pointer: deployment.pointer.toLowerCase(), origin: binding.address })
    || input.balanceAtomic < 0n
    || !Number.isSafeInteger(input.admissionBlock) || input.admissionBlock < fence.observedHeadBlock
    || !HASH.test(input.admissionBlockHash)
    || !Number.isSafeInteger(input.nowMs) || input.nowMs > binding.expiresAtMs
    || binding.expiresAtMs - input.nowMs > 5 * 60_000) throw new Error('recourse_binding_context_invalid');
  const verified = await verifyExternalAddressSignature({
    address: binding.address, signature: input.signature, message, chain: 'base', proof: fence,
  }, verifyDeps);
  if (!verified.ok) throw new Error('recourse_signature_invalid');
  const addressRef = db.collection(RECOURSE_COLLECTIONS.addresses).doc(binding.address);
  const identityRef = db.collection(RECOURSE_COLLECTIONS.identities).doc(binding.identity);
  const ownerRef = db.collection(RECOURSE_COLLECTIONS.owners).doc(input.authenticatedIdentity);
  const baseline = {
    ownerIdentity: input.authenticatedIdentity, identity: binding.identity, address: binding.address, kernel: binding.kernel,
    boundBlock: input.admissionBlock, boundBlockHash: input.admissionBlockHash, boundAtMs: input.nowMs,
    openingBalanceAtomic: input.balanceAtomic.toString(), bindingDigest: ethers.hashMessage(message),
  };
  return db.runTransaction(async transaction => {
    const [addressSnap, identitySnap, native, agentProven, humanProven, ownerSnap] = await Promise.all([
      transaction.get(addressRef), transaction.get(identityRef),
      transaction.get(db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION).doc(nativeWalletAddressIndexId(binding.address))),
      transaction.get(db.collection(PROVEN_ADDRESSES_COLLECTION).doc(binding.address)),
      transaction.get(db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(binding.address)),
      transaction.get(ownerRef),
    ]);
    await assertNoPendingAddressIssuance(db, transaction, [binding.address]);
    // Recourse extends the existing proof registry; it never creates a competing owner.
    const ownsNative = native.exists && native.get('owner_type') === input.owner.type
      && native.get('wallet_id') === input.owner.walletId
      && (input.owner.type === 'agent' || native.get('owner_id') === input.owner.id);
    const ownsProven = input.owner.type === 'agent'
      ? agentProven.exists && agentProven.get('wallet_id') === input.owner.walletId && !humanProven.exists
      : humanProven.exists && humanProven.get('user_id') === input.owner.id && !agentProven.exists;
    // A fresh address can bind on its verified signature alone. Existing native
    // or earning-address ownership cannot be overwritten by another identity.
    if ((native.exists && !ownsNative) || ((agentProven.exists || humanProven.exists) && !ownsProven)) {
      throw new Error('recourse_address_owned_elsewhere');
    }
    if (ownerSnap.exists && (ownerSnap.get('ownerType') !== input.owner.type || ownerSnap.get('ownerId') !== input.owner.id
      || ownerSnap.get('walletId') !== input.owner.walletId)) throw new Error('recourse_owner_record_mismatch');
    if (ownsNative && ownerSnap.get('primaryBinding') !== undefined && ownerSnap.get('primaryBinding') !== binding.identity) {
      throw new Error('recourse_primary_binding_already_registered');
    }
    if (identitySnap.exists && identitySnap.get('ownerIdentity') !== input.authenticatedIdentity) {
      throw new Error('recourse_address_owned_elsewhere');
    }
    const generation = identitySnap.exists ? identitySnap.get('recoveryGeneration') as unknown : 0;
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) throw new Error('recourse_recovery_generation_invalid');
    if (identitySnap.exists && (identitySnap.get('recoveryCommitment') !== binding.recoveryCommitment || identitySnap.get('signingRoot') !== binding.signingRoot)) {
      throw new Error('recourse_commitment_immutable');
    }
    if (addressSnap.exists) {
      const existing = addressSnap.data() as RegisteredAddress;
      if (existing.identity !== binding.identity || existing.kernel !== binding.kernel || existing.ownerIdentity !== input.authenticatedIdentity) {
        throw new Error('recourse_address_already_bound');
      }
      if (existing.recoveryGeneration !== generation) throw new Error('recourse_address_retired');
      if (ownsNative && ownerSnap.get('primaryBinding') === undefined) {
        transaction.update(ownerRef, { primaryBinding: binding.identity });
        transaction.update(identityRef, { primaryBinding: true });
      }
      return existing;
    }
    if (ownerSnap.get('membershipTransition') != null) throw Error('recourse_membership_transition_pending');
    const bindingSetVersion: unknown = ownerSnap.get('bindingSetVersion') ?? 0;
    if (typeof bindingSetVersion !== 'number' || !Number.isSafeInteger(bindingSetVersion) || bindingSetVersion < 0
      || !Number.isSafeInteger(bindingSetVersion + 1)) throw Error('recourse_binding_set_version_invalid');
    if (!identitySnap.exists) transaction.create(identityRef, {
      identity: binding.identity, ownerIdentity: input.authenticatedIdentity, originAddress: binding.address,
      primaryBinding: ownsNative, recoveryCommitment: binding.recoveryCommitment, signingRoot: binding.signingRoot,
      ownerType: input.owner.type, ownerId: input.owner.id, walletId: input.owner.walletId,
      createdAtMs: input.nowMs, boundBlock: input.admissionBlock, recoveryGeneration: 0,
    });
    if (!ownerSnap.exists) transaction.create(ownerRef, {
      ownerIdentity: input.authenticatedIdentity, ownerType: input.owner.type, ownerId: input.owner.id,
      walletId: input.owner.walletId, bindingSetVersion: 1, ...(ownsNative ? { primaryBinding: binding.identity } : {}), createdAtMs: input.nowMs,
    });
    else transaction.update(ownerRef, { bindingSetVersion: bindingSetVersion + 1,
      ...(ownsNative && ownerSnap.get('primaryBinding') === undefined ? { primaryBinding: binding.identity } : {}) });
    const row: RegisteredAddress = { ...baseline, recoveryGeneration: generation, chainBindingStatus: 'pending' };
    transaction.create(addressRef, row);
    return row;
  });
}

export interface TransferEvent {
  readonly block: number;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly from: string;
  readonly to: string;
  readonly amountAtomic: string;
}

/** Strict reducer: a snapshot includes the bind block, so subsequent events start at H+1. */
export function registeredBalanceAt(
  binding: RegisteredAddress, events: readonly TransferEvent[], lastGoodBlock: number,
): { balanceAtomic: bigint; mintedAtomic: bigint; receivedAtomic: bigint } {
  if (!Number.isSafeInteger(lastGoodBlock) || lastGoodBlock < binding.boundBlock
    || !/^(0|[1-9][0-9]*)$/.test(binding.openingBalanceAtomic)) throw new Error('recourse_snapshot_invalid');
  let balance = BigInt(binding.openingBalanceAtomic);
  let minted = 0n;
  let received = 0n;
  let lastBlock = binding.boundBlock;
  let lastIndex = -1;
  let lastHash = '';
  const seen = new Set<string>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.block) || event.block <= binding.boundBlock || event.block > lastGoodBlock
      || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0 || !HASH.test(event.blockHash)
      || !HASH.test(event.transactionHash) || !ADDRESS.test(event.from) || !ADDRESS.test(event.to)
      || !/^(0|[1-9][0-9]*)$/.test(event.amountAtomic)
      || (event.from !== binding.address && event.to !== binding.address)) throw new Error('recourse_event_invalid');
    const key = `${event.transactionHash}:${event.logIndex}`;
    if (seen.has(key)) throw new Error('recourse_event_duplicate');
    seen.add(key);
    if (event.block < lastBlock || (event.block === lastBlock
      && (event.logIndex <= lastIndex || event.blockHash !== lastHash))) throw new Error('recourse_events_not_canonical');
    lastBlock = event.block;
    lastIndex = event.logIndex;
    lastHash = event.blockHash;
    const amount = BigInt(event.amountAtomic);
    if (event.from === binding.address) balance -= amount;
    if (event.to === binding.address) {
      balance += amount;
      if (event.from === ZERO) minted += amount;
      else received += amount;
    }
    if (balance < 0n) throw new Error('recourse_ledger_incomplete');
  }
  return { balanceAtomic: balance, mintedAtomic: minted, receivedAtomic: received };
}

/**
 * Consume a recovery proof atomically with its destination and replacement commitment.
 * The preimage is transient, never stored or returned; transport must keep it confidential.
 * Repeating the exact request is idempotent; a different destination cannot win a replay.
 * Cryptographic-break callers additionally require the frozen, pre-break snapshot authority.
 */
export interface RecoveryInput {
  readonly authorizationTxHash?: string;
  readonly authorization?: RecoveryAuthorizationEvidence;
  readonly identity: string; readonly preimage: Uint8Array; readonly destination: string;
  readonly nextCommitment: string; readonly nextSigningRoot: string; readonly requestId: string; readonly nowMs: number;
}
export interface PreparedRecovery {
  readonly destination: string;
  readonly generation: number;
  readonly replay: boolean;
  /** Applied in the same transaction as the owner's key/auth/index transition. */
  write(transaction: Transaction): void;
}

/** Reads and checks the preimage again on every transaction retry. No caller can
 * manufacture an authorization flag, and no secret enters the write closure. */
export async function prepareRecoveryTransaction(db: Firestore, transaction: Transaction,
  input: RecoveryInput): Promise<PreparedRecovery> {
  if (!HASH.test(input.identity) || !ADDRESS.test(input.destination) || input.destination === ZERO
    || !HASH.test(input.nextCommitment) || !HASH.test(input.nextSigningRoot) || !HASH.test(input.requestId)
    || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error('recourse_recovery_invalid');
  const hash = recoveryHash(input.preimage);
  if (hash === input.nextCommitment) throw new Error('recourse_recovery_requires_fresh_secret');
  const identityRef = db.collection(RECOURSE_COLLECTIONS.identities).doc(input.identity);
  const recoveryRef = db.collection(RECOURSE_COLLECTIONS.recoveries).doc(input.requestId);
  const consumedRef = db.collection(RECOURSE_COLLECTIONS.commitments).doc(`${input.identity}:${hash}`);
  const nextRef = db.collection(RECOURSE_COLLECTIONS.commitments).doc(`${input.identity}:${input.nextCommitment}`);
    const destinationRef = db.collection(RECOURSE_COLLECTIONS.addresses).doc(input.destination);
    const [identitySnap, recoverySnap, consumedSnap, nextSnap, destinationSnap] = await Promise.all([
      transaction.get(identityRef), transaction.get(recoveryRef), transaction.get(consumedRef), transaction.get(nextRef),
      transaction.get(destinationRef),
    ]);
    if (recoverySnap.exists) {
      if (recoverySnap.get('identity') !== input.identity || recoverySnap.get('destination') !== input.destination
        || recoverySnap.get('consumedCommitment') !== hash || recoverySnap.get('nextCommitment') !== input.nextCommitment
        || recoverySnap.get('nextSigningRoot') !== input.nextSigningRoot
        || recoverySnap.get('authorizationTxHash') !== input.authorizationTxHash) {
        throw new Error('recourse_recovery_replay');
      }
      return { destination: input.destination, generation: Number(recoverySnap.get('generation')),
        replay: true, write: () => {} };
    }
    let breakOrigin: string | null = null;
    if (input.authorization) {
      assertRecoveryAuthorization(input.authorization, { identity: input.identity, destination: input.destination,
        consumedCommitment: hash, nextCommitment: input.nextCommitment, nextSigningRoot: input.nextSigningRoot });
      if (input.authorization.transactionHash !== input.authorizationTxHash) throw new Error('recourse_authorization_unverified');
      breakOrigin = recoveryAuthorizationBreakOrigin(input.authorization);
      const observedNonce: unknown = identitySnap.get('lastAuthorizationNonce');
      const newBreak = breakOrigin !== null && identitySnap.get('lastAuthorizationBreakOrigin') !== breakOrigin;
      if (observedNonce !== undefined && (typeof observedNonce !== 'number'
        || (!newBreak && observedNonce >= input.authorization.generation))) {
        throw new Error('recourse_authorization_superseded');
      }
    } else {
      const expected: unknown = identitySnap.get('recoveryCommitment');
      if (identitySnap.get('signingRoot') !== `0x${Buffer.from(input.preimage.subarray(32)).toString('hex')}`
        || typeof expected !== 'string' || !HASH.test(expected)
        || !timingSafeEqual(Buffer.from(expected.slice(2), 'hex'), Buffer.from(hash.slice(2), 'hex'))) {
        throw new Error('recourse_recovery_proof_invalid');
      }
    }
    if (nextSnap.exists) throw new Error('recourse_recovery_commitment_reused');
    if (destinationSnap.exists) throw new Error('recourse_recovery_destination_not_fresh');
    const generation: unknown = identitySnap.get('recoveryGeneration');
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0
      || generation >= Number.MAX_SAFE_INTEGER) throw new Error('recourse_recovery_generation_invalid');
    // Copy public fields: the closure must not retain the transient preimage.
    const { identity, destination, nextCommitment, nextSigningRoot, nowMs, authorizationTxHash } = input;
    const authorizationGeneration = input.authorization?.generation;
    const ownerIdentity: unknown = identitySnap.get('ownerIdentity');
    return { destination, generation: generation + 1, replay: false, write: (transaction) => {
    transaction.update(identityRef, { recoveryCommitment: nextCommitment, signingRoot: nextSigningRoot, recoveryGeneration: generation + 1,
      ...(authorizationGeneration === undefined ? {} : { lastAuthorizationNonce: authorizationGeneration }),
      ...(breakOrigin === null ? {} : { lastAuthorizationBreakOrigin: breakOrigin }) });
    if (!consumedSnap.exists) transaction.create(consumedRef, { identity, commitment: hash });
    transaction.create(nextRef, { identity, commitment: nextCommitment });
    transaction.create(recoveryRef, {
      identity, destination, nextCommitment, nextSigningRoot,
      ...(typeof ownerIdentity === 'string' ? { ownerIdentity } : {}),
      consumedCommitment: hash, generation: generation + 1, createdAtMs: nowMs,
      ...(authorizationTxHash ? { authorizationTxHash, authorizationNonce: authorizationGeneration! - 1 } : {}),
    });
    } };
}

export async function consumeRecovery(db: Firestore, input: RecoveryInput):
Promise<{ readonly destination: string; readonly generation: number }> {
  return db.runTransaction(async transaction => {
    const prepared = await prepareRecoveryTransaction(db, transaction, input);
    prepared.write(transaction);
    return { destination: prepared.destination, generation: prepared.generation };
  });
}
import { assertNoPendingAddressIssuance } from './issuance-lock';

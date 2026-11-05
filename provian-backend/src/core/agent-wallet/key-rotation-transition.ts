/**
 * Atomic agent wallet-key rotation transition (beneficiary routing machinery; LIVE since activation).
 *
 * ROTATION IS LIVE (activation flip). This module is mounted behind the backend
 * `POST /:wallet_id/rotate-key` route (agent wallet auth + ownership + dual
 * ECDSA-SHA256 proof-of-possession + 1/24h rate limit) and the SDK
 * `rotateKey()`; the two were flipped together. Crash/replay safety is proven by
 * `scripts/wp12-key-rotation-canary.ts`. REVERSIBLE: to re-disable, restore the
 * route's fail-closed 503 AND the SDK throw together — never one side alone.
 * See docs/launch/KEY_ROTATION_REENABLEMENT_LAUNCH_STOP.md.
 *
 * The transition moves an agent wallet's economic identity from one Base
 * address to another in a SINGLE Firestore transaction. Because every write
 * rides the same `advanceChainTipAtomic` transaction that seals the
 * `agent_key_rotated` PE, a crash at any point leaves EITHER the old identity
 * fully intact (transaction never committed) OR the new one fully live
 * (transaction committed) — never a split state where one subsystem points at
 * the old address and another at the new. This closes the exact defect that
 * forced the fail-closed 503: the old implementation swapped only the
 * wallet/trust/API records and sealed the rotation PE AFTER the transaction
 * (a null-`pe_id` window), leaving the H+1 fence, native indexes, watcher
 * admission, and membership generation bound to the old address.
 *
 * What one transition commits together:
 * - wallet + trust-wallet identity (address, public key, API credentials,
 * rotation_count, last_rotated_at, fresh H+1 fence)
 * - native address index: NEW address created, OLD address deleted, plus a
 * durable retirement tombstone so the old address cannot be re-registered
 * - watcher admission: fresh registration-fenced admission for the NEW
 * address (bumps membership_generation), OLD admission retired
 * - API credential prefix swap (create new prefix, delete old)
 * - agent registration index re-pointed to the NEW address/prefix (the
 * registration doc + birth PE stay the immutable BIRTH anchor)
 * - rotation_history entry with a NON-NULL pe_id (the sealed PE)
 * - the new key's recovery escrow, when supplied — so a re-keyed
 * agent is recoverable with no un-escrowed window
 * - the `agent_key_rotated` PE itself + chain-tip advance
 *
 * Authority posture: the transition introduces NO admin, settable address,
 * owner, executor, Safe, timelock, or governance call path. It is a wallet-auth
 * operation over the caller's own wallet; the the operator-EOA bootstrap boundary and
 * every economic gate are untouched. The `agent_key_rotated` PE is catalogued
 * `record_only`, so it mints zero PVT.
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import type {
  DocumentReference,
  Firestore,
  Transaction,
} from 'firebase-admin/firestore';

import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import { invalidateHandshakes } from '../rail/invalidation';
import type { AgentWalletDocument } from './types';
import type { ApiCredentials } from './api-key';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  NATIVE_WALLET_REGISTRATION_CHAIN_ID,
  createNativeWalletRegistrationFence,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
  type NativeWalletRegistrationFence,
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
} from '../pvt/native-wallet-registration';
import { externalProofRefs } from '../external-address/link';
import {
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  prepareNativeWalletWatcherRegistration,
  watcherAddressAdmissionDocId,
  writeNativeWalletWatcherRegistration,
  type NativeWalletWatcherRegistrationPlan,
} from '../pvt/watcher-address-admission';
import { readAgreedBaseHead } from '../onchain/economic-discovery';
import {
  AGENT_RECOVERY_ESCROW_COLLECTION,
  RECOVERY_BLOB_VERSION,
  isValidSealedKeyBlobB64u,
  isValidAnchorPubkeyB64u,
  type RecoveryEscrowRecord,
} from '../agent-recovery-escrow';
import { ROTATION_HISTORY_SUBCOLLECTION } from './rotation-history-evidence';

/** Action type + policy: catalogued `record_only`, so a rotation PE mints 0. */
export const AGENT_KEY_ROTATED_ACTION_TYPE = 'agent_key_rotated' as const;
export { ROTATION_HISTORY_SUBCOLLECTION } from './rotation-history-evidence';
/**
 * Durable terminal marker for a retired address. The old native address index
 * is DELETED in the same transaction; this tombstone is the append-only record
 * that the address was retired from an agent, so a re-enablement can also gate
 * fresh registration on it (one address → one agent, permanently).
 */
export { AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION } from '../pvt/native-wallet-registration';
export const AGENT_DIRECTORY_COLLECTION = 'agent_directory' as const;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PUBLIC_KEY = /^[0-9a-f]{128}$/;
const API_PREFIX = /^pvn_live_[0-9a-f]{15}$/;
const API_HASH = /^[0-9a-f]{128}$/;
const API_SALT = /^[0-9a-f]{64}$/;

export class KeyRotationTransitionError extends Error {
  constructor(readonly reason: string) {
    super(`key_rotation_transition:${reason}`);
    this.name = 'KeyRotationTransitionError';
  }
}

function fail(reason: string): never {
  throw new KeyRotationTransitionError(reason);
}

/** Caller-supplied new identity. Address/public-key consistency is re-checked
 * here so the module never trusts an unvalidated pairing. */
export interface KeyRotationNewIdentity {
  readonly newAddress: string;
  readonly newPublicKey: string;
  readonly newApiCredentials: ApiCredentials;
}

export interface KeyRotationExpectedOldIdentity {
  readonly walletId: string;
  readonly agentId: string;
  readonly registrationId: string;
  readonly oldAddress: string;
  readonly oldPublicKey: string;
  readonly oldApiKeyPrefix: string;
  readonly rotationCount: number;
}

/**
 * The sealed recovery escrow of the NEW key, written INSIDE the rotation
 * transaction. Both rotate-key and recovery-rekey re-escrow atomically
 * with the identity cut: a crash leaves EITHER the old identity + old escrow OR
 * the new identity + new escrow, never a re-keyed-but-un-escrowed split. The
 * relay stores ciphertext only (see agent-recovery-escrow.ts).
 */
export interface KeyRotationRecoveryEscrow {
  readonly sealed_key_blob: string;
  readonly recovery_anchor_pubkey: string;
}

export interface KeyRotationPlan {
  readonly expected: KeyRotationExpectedOldIdentity;
  readonly newIdentity: KeyRotationNewIdentity;
  readonly newFence: NativeWalletRegistrationFence;
  readonly rotationId: string;
  readonly rotationPeId: string;
  readonly now: number;
  /** When present, the new key's escrow written atomically in the transition. */
  readonly recoveryEscrow?: KeyRotationRecoveryEscrow;
}

export interface KeyRotationResult {
  readonly walletId: string;
  readonly oldAddress: string;
  readonly newAddress: string;
  readonly rotationCount: number;
  readonly rotationPeId: string;
  readonly rotationId: string;
  readonly newFence: NativeWalletRegistrationFence;
}

function deriveAddress(publicKeyHex: string): string {
  // Uncompressed secp256k1 point (no 04 prefix stored); ethers wants it. A
  // structurally-valid-hex but off-curve key throws — fail closed to a value
  // that can never match, so the caller sees the clean derivation mismatch.
  try {
    return ethers.computeAddress(`0x04${publicKeyHex}`).toLowerCase();
  } catch {
    return '';
  }
}

function assertLowerHexAddress(value: unknown, reason: string): string {
  if (typeof value !== 'string' || !ADDRESS.test(value.toLowerCase())) fail(reason);
  return (value as string).toLowerCase();
}

/** Deterministic rotation PE id: one specific old→new cut per agent. A
 * contention retry recomputes the same id, so the sealed PE is idempotent. */
export function rotationPeId(agentId: string, oldAddress: string, newAddress: string): string {
  return `pe_agent_key_rotated_${crypto.createHash('sha256')
    .update(`${agentId}\n${oldAddress.toLowerCase()}\n${newAddress.toLowerCase()}`, 'utf8')
    .digest('hex')}`;
}

/** Deterministic rotation_history doc id, tied to the PE id so a retry targets
 * the same subcollection doc. */
export function rotationHistoryId(peId: string): string {
  return crypto.createHash('sha256').update(`rotation-history/v1\n${peId}`, 'utf8').digest('hex');
}

/**
 * Read and validate the committed OLD identity, capture a fresh two-operator
 * Base head, and build the transition plan. No writes. The head read reuses the
 * exact `readAgreedBaseHead()` seam the accepted native-wallet registration
 * path uses (two operator-bound RPC legs, BASE_RPC_OPERATOR_ID /
 * BASE_RPC_SECONDARY_OPERATOR_ID); this appoints no new operator.
 */
export async function prepareKeyRotationTransition(params: {
  readonly db: Firestore;
  readonly walletId: string;
  readonly newIdentity: KeyRotationNewIdentity;
  readonly rotationId: string;
  readonly now: number;
  /** When present, the new key's escrow written atomically with the identity cut. */
  readonly recoveryEscrow?: KeyRotationRecoveryEscrow;
  /** Test-only injection, mirroring the registration route's
   * `deps.readBaseRegistrationHead ?? readAgreedBaseHead`. */
  readonly readBaseHead?: () => Promise<number>;
}): Promise<KeyRotationPlan> {
  const { db, walletId, newIdentity, rotationId, now } = params;
  if (!Number.isSafeInteger(now) || now < 0) fail('now_invalid');
  if (typeof rotationId !== 'string' || rotationId.length < 8 || rotationId.length > 128) {
    fail('rotation_id_invalid');
  }
  validateNewIdentityShape(newIdentity);
  if (params.recoveryEscrow !== undefined) {
    if (!isValidSealedKeyBlobB64u(params.recoveryEscrow.sealed_key_blob)
      || !isValidAnchorPubkeyB64u(params.recoveryEscrow.recovery_anchor_pubkey)) {
      fail('recovery_escrow_invalid');
    }
  }
  const newAddress = newIdentity.newAddress.toLowerCase();

  const walletSnap = await db.collection('agent_wallets').doc(walletId).get();
  if (!walletSnap.exists) fail('wallet_missing');
  const wallet = walletSnap.data() as AgentWalletDocument;
  const oldAddress = assertLowerHexAddress(wallet.address, 'wallet_address_invalid');
  const oldPublicKey = String(wallet.public_key ?? '').toLowerCase();
  if (!PUBLIC_KEY.test(oldPublicKey)) fail('wallet_public_key_invalid');
  if (typeof wallet.api_key_prefix !== 'string' || !API_PREFIX.test(wallet.api_key_prefix)) {
    fail('wallet_api_prefix_invalid');
  }
  if (wallet.status !== 'active') fail('wallet_not_active');
  if (wallet.id !== walletId || typeof wallet.agent_id !== 'string' || wallet.agent_id.length === 0) {
    fail('wallet_identity_invalid');
  }
  const rotationCount = wallet.rotation_count ?? 0;
  if (!Number.isSafeInteger(rotationCount) || rotationCount < 0) fail('rotation_count_invalid');

  if (newAddress === oldAddress) fail('new_address_equals_old');
  if (newIdentity.newApiCredentials.api_key_prefix === wallet.api_key_prefix) {
    fail('new_api_prefix_equals_old');
  }
  if (deriveAddress(newIdentity.newPublicKey.toLowerCase()) !== newAddress) {
    fail('new_public_key_derivation_mismatch');
  }

  // registration_id is recovered from the agent registration index (keyed by
  // agent_id, it carries the immutable registration_id even after rotations).
  // The registration doc + birth PE stay the immutable BIRTH anchor; their
  // address is intentionally NOT re-pointed by a rotation.
  const registrationId = await resolveRegistrationId(db, wallet);

  const freshHead = await (params.readBaseHead ?? readAgreedBaseHead)();
  const newFence = createNativeWalletRegistrationFence(freshHead);

  const peId = rotationPeId(wallet.agent_id, oldAddress, newAddress);
  return {
    expected: {
      walletId,
      agentId: wallet.agent_id,
      registrationId,
      oldAddress,
      oldPublicKey,
      oldApiKeyPrefix: wallet.api_key_prefix,
      rotationCount,
    },
    newIdentity: {
      newAddress,
      newPublicKey: newIdentity.newPublicKey.toLowerCase(),
      newApiCredentials: newIdentity.newApiCredentials,
    },
    newFence,
    rotationId,
    rotationPeId: peId,
    now,
    ...(params.recoveryEscrow !== undefined ? { recoveryEscrow: params.recoveryEscrow } : {}),
  };
}

/** The agent registration index (keyed by agent_id) carries the immutable
 * registration_id even after rotations, so recover it there rather than
 * trusting a caller-supplied value. */
async function resolveRegistrationId(db: Firestore, wallet: AgentWalletDocument): Promise<string> {
  const idxSnap = await db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)
    .doc(nativeAgentRegistrationIndexId(wallet.agent_id)).get();
  if (!idxSnap.exists) fail('agent_registration_index_missing');
  const idx = idxSnap.data() as Record<string, unknown>;
  if (idx.wallet_id !== wallet.id
    || typeof idx.registration_id !== 'string'
    || idx.registration_id.length === 0) {
    fail('agent_registration_index_invalid');
  }
  return idx.registration_id as string;
}

function validateNewIdentityShape(newIdentity: KeyRotationNewIdentity): void {
  if (typeof newIdentity.newAddress !== 'string' || !ADDRESS.test(newIdentity.newAddress.toLowerCase())) {
    fail('new_address_invalid');
  }
  if (typeof newIdentity.newPublicKey !== 'string' || !PUBLIC_KEY.test(newIdentity.newPublicKey.toLowerCase())) {
    fail('new_public_key_invalid');
  }
  const creds = newIdentity.newApiCredentials;
  if (!creds
    || typeof creds.api_key_prefix !== 'string' || !API_PREFIX.test(creds.api_key_prefix)
    || typeof creds.api_key_hash !== 'string' || !API_HASH.test(creds.api_key_hash)
    || typeof creds.api_key_salt !== 'string' || !API_SALT.test(creds.api_key_salt)) {
    fail('new_api_credentials_invalid');
  }
}

interface OldIdentityRefs {
  walletRef: DocumentReference;
  trustWalletRef: DocumentReference;
  oldAddressIndexRef: DocumentReference;
  newAddressIndexRef: DocumentReference;
  agentIndexRef: DocumentReference;
  oldApiIndexRef: DocumentReference;
  newApiIndexRef: DocumentReference;
  oldAdmissionRef: DocumentReference;
  retirementRef: DocumentReference;
  directoryRef: DocumentReference;
  rotationHistoryRef: DocumentReference;
  recoveryEscrowRef: DocumentReference;
}

function buildRefs(db: Firestore, plan: KeyRotationPlan): OldIdentityRefs {
  const { expected, newIdentity, rotationPeId: peId } = plan;
  return {
    walletRef: db.collection('agent_wallets').doc(expected.walletId),
    trustWalletRef: db.collection('wallets').doc(expected.walletId),
    oldAddressIndexRef: db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(expected.oldAddress)),
    newAddressIndexRef: db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(newIdentity.newAddress)),
    agentIndexRef: db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)
      .doc(nativeAgentRegistrationIndexId(expected.agentId)),
    oldApiIndexRef: db.collection('api_key_index').doc(expected.oldApiKeyPrefix),
    newApiIndexRef: db.collection('api_key_index').doc(newIdentity.newApiCredentials.api_key_prefix),
    oldAdmissionRef: db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION)
      .doc(watcherAddressAdmissionDocId({
        direction: 'inbound',
        chainId: NATIVE_WALLET_REGISTRATION_CHAIN_ID,
        address: expected.oldAddress,
        walletId: expected.walletId,
        agentId: expected.agentId,
        eligibilityStartBlock: 0,
      })),
    retirementRef: db.collection(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION)
      .doc(expected.oldAddress),
    directoryRef: db.collection(AGENT_DIRECTORY_COLLECTION).doc(expected.walletId),
    rotationHistoryRef: db.collection('agent_wallets').doc(expected.walletId)
      .collection(ROTATION_HISTORY_SUBCOLLECTION).doc(rotationHistoryId(peId)),
    recoveryEscrowRef: db.collection(AGENT_RECOVERY_ESCROW_COLLECTION).doc(expected.walletId),
  };
}

interface TransitionReadState {
  refs: OldIdentityRefs;
  watcherPlan: NativeWalletWatcherRegistrationPlan;
  directoryExists: boolean;
}

/**
 * In-transaction re-read + assertion that the committed OLD identity still
 * matches the plan exactly, that the NEW-address targets are all unclaimed, and
 * (via prepareNativeWalletWatcherRegistration) that the fresh admission +
 * membership-generation bump can be planned. Reads only. Throwing rolls the
 * whole rotation transaction back.
 */
async function readAndAssert(
  db: Firestore,
  txn: Transaction,
  plan: KeyRotationPlan,
): Promise<TransitionReadState> {
  const refs = buildRefs(db, plan);
  const { expected, newIdentity } = plan;
  const [
    walletSnap, trustSnap, oldAddrIdxSnap, newAddrIdxSnap, agentIdxSnap,
    oldApiSnap, newApiSnap, oldAdmissionSnap, retirementSnap, directorySnap,
    historySnap, newAgentProvenSnap, newPersonProvenSnap,
  ] = await Promise.all([
    txn.get(refs.walletRef),
    txn.get(refs.trustWalletRef),
    txn.get(refs.oldAddressIndexRef),
    txn.get(refs.newAddressIndexRef),
    txn.get(refs.agentIndexRef),
    txn.get(refs.oldApiIndexRef),
    txn.get(refs.newApiIndexRef),
    txn.get(refs.oldAdmissionRef),
    txn.get(refs.retirementRef),
    txn.get(refs.directoryRef),
    txn.get(refs.rotationHistoryRef),
    // the new key's address must not be anyone's proven outside wallet.
    ...externalProofRefs(db, newIdentity.newAddress).map((ref) => txn.get(ref)),
  ]);

  if (!walletSnap.exists) fail('wallet_missing');
  const wallet = walletSnap.data() as AgentWalletDocument;
  if (wallet.id !== expected.walletId
    || wallet.agent_id !== expected.agentId
    || String(wallet.address).toLowerCase() !== expected.oldAddress
    || String(wallet.public_key).toLowerCase() !== expected.oldPublicKey
    || wallet.api_key_prefix !== expected.oldApiKeyPrefix
    || wallet.status !== 'active'
    || (wallet.rotation_count ?? 0) !== expected.rotationCount) {
    fail('wallet_state_changed');
  }

  if (!trustSnap.exists) fail('trust_wallet_missing');
  const trust = trustSnap.data() as Record<string, unknown>;
  if (String(trust.address).toLowerCase() !== expected.oldAddress
    || trust.id !== expected.walletId) {
    fail('trust_wallet_state_changed');
  }

  if (!oldAddrIdxSnap.exists) fail('old_address_index_missing');
  const oldAddrIdx = oldAddrIdxSnap.data() as Record<string, unknown>;
  if (oldAddrIdx.wallet_id !== expected.walletId
    || String(oldAddrIdx.address).toLowerCase() !== expected.oldAddress) {
    fail('old_address_index_mismatch');
  }
  if (newAddrIdxSnap.exists || newAgentProvenSnap.exists || newPersonProvenSnap.exists) {
    fail('new_address_in_use');
  }

  if (!agentIdxSnap.exists) fail('agent_registration_index_missing');
  const agentIdx = agentIdxSnap.data() as Record<string, unknown>;
  if (agentIdx.wallet_id !== expected.walletId
    || agentIdx.registration_id !== expected.registrationId
    || String(agentIdx.address).toLowerCase() !== expected.oldAddress
    || agentIdx.api_key_prefix !== expected.oldApiKeyPrefix) {
    fail('agent_registration_index_mismatch');
  }

  if (!oldApiSnap.exists) fail('old_api_index_missing');
  if ((oldApiSnap.data() as Record<string, unknown>).wallet_id !== expected.walletId) {
    fail('old_api_index_mismatch');
  }
  if (newApiSnap.exists) fail('new_api_prefix_in_use');

  if (!oldAdmissionSnap.exists) fail('old_admission_missing');
  const oldAdmission = oldAdmissionSnap.data() as Record<string, unknown>;
  if (oldAdmission.wallet_id !== expected.walletId
    || oldAdmission.agent_id !== expected.agentId
    || String(oldAdmission.address).toLowerCase() !== expected.oldAddress) {
    fail('old_admission_mismatch');
  }

  if (retirementSnap.exists) fail('address_already_retired');
  if (historySnap.exists) fail('rotation_already_applied');

  // Fresh registration-fenced admission for the NEW address + membership
  // generation bump. Reuses the exact machinery the birth path uses.
  const watcherPlan = await prepareNativeWalletWatcherRegistration(
    db,
    txn,
    {
      direction: 'inbound',
      chainId: plan.newFence.chain_id,
      address: newIdentity.newAddress,
      walletId: expected.walletId,
      agentId: expected.agentId,
      eligibilityStartBlock: plan.newFence.eligibility_start_block,
    },
    plan.now,
  );

  return { refs, watcherPlan, directoryExists: directorySnap.exists };
}

function writeTransition(
  txn: Transaction,
  plan: KeyRotationPlan,
  state: TransitionReadState,
  peId: string,
  peHash: string,
): void {
  const { refs, watcherPlan, directoryExists } = state;
  const { expected, newIdentity, newFence, now } = plan;
  const creds = newIdentity.newApiCredentials;
  const nextRotationCount = expected.rotationCount + 1;

  // 1. Wallet identity cut.
  txn.update(refs.walletRef, {
    address: newIdentity.newAddress,
    public_key: newIdentity.newPublicKey,
    api_key_hash: creds.api_key_hash,
    api_key_salt: creds.api_key_salt,
    api_key_prefix: creds.api_key_prefix,
    rotation_count: nextRotationCount,
    last_rotated_at: now,
    native_watcher_registration: newFence,
    updated_at: now,
  });
  // 2. Trust-graph wallet mirror.
  txn.update(refs.trustWalletRef, {
    address: newIdentity.newAddress,
    public_key: newIdentity.newPublicKey,
    native_watcher_registration: newFence,
  });
  // 3. Native address index: NEW created, OLD deleted + tombstoned.
  txn.create(refs.newAddressIndexRef, {
    schema_version: 'native-wallet-address-index/v1',
    chain_id: newFence.chain_id,
    address: newIdentity.newAddress,
    wallet_id: expected.walletId,
    owner_type: 'agent',
    owner_id: expected.agentId,
    created_at_ms: now,
  });
  txn.delete(refs.oldAddressIndexRef);
  txn.create(refs.retirementRef, {
    schema_version: 'agent-wallet-address-retirement/v1',
    chain_id: newFence.chain_id,
    address: expected.oldAddress,
    wallet_id: expected.walletId,
    agent_id: expected.agentId,
    new_address: newIdentity.newAddress,
    retired_at_ms: now,
    rotation_pe_id: peId,
  });
  // 4. Agent registration index re-points to the NEW live address/prefix. The
  //    registration doc + birth PE remain the immutable BIRTH anchor.
  txn.update(refs.agentIndexRef, {
    address: newIdentity.newAddress,
    api_key_prefix: creds.api_key_prefix,
    updated_at_ms: now,
  });
  // 5. API credential prefix swap.
  txn.create(refs.newApiIndexRef, {
    api_key_prefix: creds.api_key_prefix,
    wallet_id: expected.walletId,
    created_at: now,
  });
  txn.delete(refs.oldApiIndexRef);
  // 6. Watcher admission: NEW fenced admission + membership bump, OLD retired.
  writeNativeWalletWatcherRegistration(txn, watcherPlan, now);
  txn.delete(refs.oldAdmissionRef);
  // 7. Directory address (denormalized read cache) follows the live address.
  if (directoryExists) {
    txn.update(refs.directoryRef, { address: newIdentity.newAddress, updated_at: now });
  }
  // 8. rotation_history entry — pe_id is NON-NULL, sealed in THIS transaction.
  txn.create(refs.rotationHistoryRef, {
    rotation_id: plan.rotationId,
    old_address: expected.oldAddress,
    new_address: newIdentity.newAddress,
    rotated_at: now,
    rotation_count: nextRotationCount,
    pe_id: peId,
    pe_hash: peHash,
  });
  // 9. Recovery escrow of the NEW key — written ATOMICALLY with the
  //    identity cut when supplied. The old key is now retired, so its escrow is
  //    stale; re-escrowing the new key here (rather than deleting + orphaning)
  //    keeps the invariant "a re-keyed agent is recoverable" true with no window.
  //    A rotation with NO escrow supplied leaves the escrow untouched (the route
  //    is what refuses to orphan an existing escrow).
  if (plan.recoveryEscrow !== undefined) {
    const escrow: RecoveryEscrowRecord = {
      wallet_id: expected.walletId,
      sealed_key_blob: plan.recoveryEscrow.sealed_key_blob,
      recovery_anchor_pubkey: plan.recoveryEscrow.recovery_anchor_pubkey,
      blob_version: RECOVERY_BLOB_VERSION,
      created_at: now,
      updated_at: now,
    };
    txn.set(refs.recoveryEscrowRef, escrow);
  }
}

/**
 * Execute the atomic transition. Every write above rides the same
 * `advanceChainTipAtomic` transaction that seals the `agent_key_rotated` PE, so
 * the identity cut and the PE are durable-or-nothing together.
 */
export async function executeKeyRotationTransition(
  deps: AgentBankDeps,
  plan: KeyRotationPlan,
): Promise<KeyRotationResult> {
  let captured: TransitionReadState | null = null;
  await generatePE(deps, {
    walletId: plan.expected.walletId,
    agentId: plan.expected.agentId,
    actorAddress: plan.newIdentity.newAddress,
    actionType: AGENT_KEY_ROTATED_ACTION_TYPE,
    peIdOverride: plan.rotationPeId,
    timestampOverride: plan.now,
    metadata: {
      old_address: plan.expected.oldAddress,
      new_address: plan.newIdentity.newAddress,
      rotation_count: plan.expected.rotationCount + 1,
      rotation_id: plan.rotationId,
      observed_head_block: plan.newFence.observed_head_block,
      eligibility_start_block: plan.newFence.eligibility_start_block,
    },
    atomicEntityPrecondition: async (txn) => {
      captured = await readAndAssert(deps.db, txn, plan);
    },
    atomicEntityWrite: (txn, peId, context) => {
      if (!captured || !context) fail('transition_read_state_missing');
      writeTransition(txn, plan, captured, peId, context.newHash);
    },
  });

  // Part C2 (rail handshake event-based invalidation): a signing-key rotation is
  // a presenter-side adverse standing event — every live rail handshake the old
  // key backed must close, so the next commitment re-presents (a fresh burn under
  // the new key). Best-effort, POST-commit: the rotation already durably landed;
  // an advisory floor write must never roll it back.
  try {
    await invalidateHandshakes(deps.db, plan.expected.walletId, 'key_rotation', plan.now, {
      eventId: plan.rotationPeId,
    });
  } catch {
    /* advisory-only; invalidateHandshakes already swallows its own errors */
  }

  return {
    walletId: plan.expected.walletId,
    oldAddress: plan.expected.oldAddress,
    newAddress: plan.newIdentity.newAddress,
    rotationCount: plan.expected.rotationCount + 1,
    rotationPeId: plan.rotationPeId,
    rotationId: plan.rotationId,
    newFence: plan.newFence,
  };
}

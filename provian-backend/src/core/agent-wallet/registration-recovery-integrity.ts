import { participantClass } from '../identity/participant-class';
import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import { ethers } from 'ethers';
import type {
  DocumentReference,
  Firestore,
  Transaction,
} from 'firebase-admin/firestore';
import type { AgentWalletDocument } from './types';
import {
  readIdentityPe,
  type CanonicalAgentStoredPe,
} from './canonical-agent-pe-chain';
import {
  agentGovernanceSourceRef,
  isAgentGovernanceSettings,
  parseAgentGovernanceSource,
  type AgentGovernanceSourceDocument,
} from './governance-source';
import {
  PROVEN_ADDRESSES_COLLECTION,
  isEconomicallyActiveProvenAddress,
  listProvenAddresses,
  type ProvenAddressRecord,
} from '../external-address/link';
import {
  ALL_BADGE_IDS,
  badgeAwardOutboxRef,
  parseBadgeAwardOutbox,
  validateBadgeQualificationSource,
  validateCompletedBadgePe,
  type AgentBadgeAwardOutboxDocument,
} from './badge-provenance';
import {
  beneficiaryRelationshipRef,
  canonicalAgentBeneficiaryShareBps,
  parseBeneficiaryRelationship,
  readValidatedBeneficiaryRelationship,
  readValidatedBeneficiaryRelationshipInTransaction,
  validateBeneficiaryRelationship,
  type AgentBeneficiaryRelationshipDocument,
} from './beneficiary-relationship';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
  nativeWalletAddressIndexId,
  parseNativeWalletRegistrationFence,
  type NativeWalletRegistrationFence,
} from '../pvt/native-wallet-registration';
import {
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  parseWatcherAddressAdmission,
  parseWatcherCheckpointDocument,
  watcherAddressAdmissionDocId,
} from '../pvt/watcher-address-admission';
import {
  ROTATION_HISTORY_SUBCOLLECTION,
  validateRotationHistoryEvidenceCore,
  type RotationHistoryEvidenceBound,
  type RotationHistoryEvidenceEntry as SharedRotationHistoryEvidenceEntry,
} from './rotation-history-evidence';

export const AGENT_WALLET_REGISTRATION_COLLECTION =
  'agent_wallet_registrations' as const;

export interface AgentWalletRegistrationDocument {
  schema_version: 'agent-wallet-registration/v1';
  registration_id: string;
  request_fingerprint_sha256: string;
  wallet_id: string;
  agent_id: string;
  address: string;
  public_key: string;
  pe_id: string;
  pe_hash: string;
  api_key_prefix: string;
  created_at_ms: number;
  credential_recovery_generation: number;
  last_credential_recovered_at_ms?: number;
}

export interface AgentWalletRegistrationRecoveryIdentity {
  registrationId: string;
  requestFingerprint: string;
  agentId: string;
  agentName: string;
  platform: string;
  chains: readonly string[];
  callbackUrl: string | null;
  governance: AgentWalletDocument['governance'];
  parentWalletId: string | null;
  address: string;
  publicKey: string;
  constitutionAccepted: boolean;
  constitutionVersion: string;
  constitutionAcceptedAt: number;
  expectedRecoveryGeneration: number;
  now: number;
}

interface SnapshotLike {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface RecoveryRefs {
  registrationRef: DocumentReference;
  walletRef: DocumentReference;
  trustWalletRef: DocumentReference;
  agentIndexRef: DocumentReference;
  addressIndexRef: DocumentReference;
  admissionRef: DocumentReference;
  checkpointRef: DocumentReference;
  chainTipRef: DocumentReference;
  oldIndexRef: DocumentReference;
  relationshipRef: DocumentReference;
  governanceSourceRef: DocumentReference;
}

interface RecoverySnapshots {
  registration: SnapshotLike;
  wallet: SnapshotLike;
  trustWallet: SnapshotLike;
  agentIndex: SnapshotLike;
  addressIndex: SnapshotLike;
  admission: SnapshotLike;
  checkpoint: SnapshotLike;
  chainTip: SnapshotLike;
  oldIndex: SnapshotLike;
  relationship: SnapshotLike;
  governanceSource: SnapshotLike;
}

export interface ValidatedAgentWalletRegistrationRecovery {
  registration: AgentWalletRegistrationDocument;
  wallet: AgentWalletDocument;
  refs: RecoveryRefs;
  /**
   * The identity PEs this recovery validated (birth, rotations, beneficiary source, governance
   * source, badge sources and badge PEs), as pinned by the identity records — bounded by the
   * agent's identity events, never by its PE history. The install transaction re-derives the
   * same pins and refuses if they moved (`pe_chain_changed`).
   */
  identityPeIds: readonly string[];
  identityPeHashes: readonly string[];
  externalActorAddresses: readonly string[];
  childRelationships: readonly AgentBeneficiaryRelationshipDocument[];
  relationship: AgentBeneficiaryRelationshipDocument;
}

const REGISTRATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,127}$/;
const WALLET_ID = /^wallet_aw_[A-Za-z0-9-]{8,128}$/;
const AGENT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const PUBLIC_KEY = /^[0-9a-f]{128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PE_ID = /^pe_[A-Za-z0-9_-]{1,240}$/;
const API_PREFIX = /^pvn_live_[0-9a-f]{15}$/;
const API_HASH = /^[0-9a-f]{128}$/;
const API_SALT = /^[0-9a-f]{64}$/;
const REGISTRATION_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class AgentWalletRegistrationIntegrityError extends Error {
  constructor(readonly reason: string) {
    super(`agent_wallet_registration_recovery_integrity:${reason}`);
  }
}

function integrityFailure(reason: string): never {
  throw new AgentWalletRegistrationIntegrityError(reason);
}

function plainRecord(value: unknown, reason: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return integrityFailure(reason);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  raw: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  reason: string,
): void {
  const actual = Object.keys(raw).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(raw, key))
    || actual.some((key) => !allowed.has(key))) {
    integrityFailure(reason);
  }
}

function safeTimestamp(value: unknown, now: number, reason: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > now) {
    return integrityFailure(reason);
  }
  return value as number;
}

function safeObservedTimestamp(value: unknown, now: number, reason: string): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > now + REGISTRATION_CLOCK_SKEW_MS) {
    return integrityFailure(reason);
  }
  return value as number;
}

function safeNonNegativeInteger(value: unknown, reason: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return integrityFailure(reason);
  }
  return value as number;
}

function finiteNonNegative(value: unknown, reason: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return integrityFailure(reason);
  }
  return value;
}

function snapshotData(snapshot: SnapshotLike, reason: string): Record<string, unknown> {
  if (!snapshot.exists) return integrityFailure(`${reason}_missing`);
  return plainRecord(snapshot.data(), `${reason}_shape`);
}

function equalFence(
  left: NativeWalletRegistrationFence,
  right: NativeWalletRegistrationFence,
): boolean {
  return left.schema_version === right.schema_version
    && left.chain_id === right.chain_id
    && left.observed_head_block === right.observed_head_block
    && left.eligibility_start_block === right.eligibility_start_block;
}

function parseRegistration(
  snapshot: SnapshotLike,
  identity: AgentWalletRegistrationRecoveryIdentity,
): AgentWalletRegistrationDocument {
  const raw = snapshotData(snapshot, 'registration');
  const generation = safeNonNegativeInteger(
    raw.credential_recovery_generation,
    'registration_generation',
  );
  const required = [
    'schema_version',
    'registration_id',
    'request_fingerprint_sha256',
    'wallet_id',
    'agent_id',
    'address',
    'public_key',
    'pe_id',
    'pe_hash',
    'api_key_prefix',
    'created_at_ms',
    'credential_recovery_generation',
  ];
  exactKeys(
    raw,
    generation === 0 ? required : [...required, 'last_credential_recovered_at_ms'],
    [],
    'registration_keys',
  );
  const createdAt = safeTimestamp(raw.created_at_ms, identity.now, 'registration_created_at');
  if (raw.schema_version !== 'agent-wallet-registration/v1'
    || typeof raw.registration_id !== 'string' || !REGISTRATION_ID.test(raw.registration_id)
    || typeof raw.wallet_id !== 'string' || !WALLET_ID.test(raw.wallet_id)
    || typeof raw.agent_id !== 'string' || !AGENT_ID.test(raw.agent_id)
    || typeof raw.address !== 'string' || !ADDRESS.test(raw.address)
    || typeof raw.public_key !== 'string' || !PUBLIC_KEY.test(raw.public_key)
    || typeof raw.pe_id !== 'string' || !PE_ID.test(raw.pe_id)
    || typeof raw.pe_hash !== 'string' || !SHA256.test(raw.pe_hash)
    || typeof raw.request_fingerprint_sha256 !== 'string'
    || !SHA256.test(raw.request_fingerprint_sha256)
    || typeof raw.api_key_prefix !== 'string' || !API_PREFIX.test(raw.api_key_prefix)
    || raw.registration_id !== identity.registrationId
    || raw.request_fingerprint_sha256 !== identity.requestFingerprint
    || raw.agent_id !== identity.agentId) {
    // NOTE: the recovering party's presented key (identity.address /
    // identity.publicKey) is bound to the wallet's CURRENT identity in
    // computeEffectiveRecoveryIdentity, not here — so a rotated wallet is
    // recovered with its ROTATED key, an un-rotated wallet with its birth key.
    integrityFailure('registration_binding');
  }
  if (generation !== identity.expectedRecoveryGeneration) {
    integrityFailure('registration_generation_changed');
  }
  if (generation > 0) {
    const recoveredAt = safeTimestamp(
      raw.last_credential_recovered_at_ms,
      identity.now,
      'registration_last_recovery',
    );
    if (recoveredAt < createdAt) integrityFailure('registration_last_recovery_order');
  }
  return raw as unknown as AgentWalletRegistrationDocument;
}

function validateGovernance(value: unknown): void {
  const raw = plainRecord(value, 'wallet_governance_shape');
  const keys = [
    'pe_coverage_enabled',
    'attestation_enabled',
    'human_oversight_enabled',
    'spending_limits_enabled',
    'full_governance',
  ];
  exactKeys(raw, keys, [], 'wallet_governance_keys');
  if (keys.some((key) => typeof raw[key] !== 'boolean') || raw.full_governance !== false) {
    integrityFailure('wallet_governance_fields');
  }
}

function validateBadges(value: unknown): void {
  if (!Array.isArray(value)) integrityFailure('wallet_badges_shape');
  const seen = new Set<string>();
  for (const badge of value) {
    const raw = plainRecord(badge, 'wallet_badge_shape');
    exactKeys(raw, ['id', 'earned_at'], [], 'wallet_badge_keys');
    if (typeof raw.id !== 'string' || !ALL_BADGE_IDS.includes(raw.id as never)
      || seen.has(raw.id)
      || !Number.isSafeInteger(raw.earned_at) || (raw.earned_at as number) < 0) {
      integrityFailure('wallet_badge_fields');
    }
    seen.add(raw.id);
  }
}

function stringOrNull(value: unknown, reason: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) return integrityFailure(reason);
  return value;
}

/**
 * Item 5: the wallet's display_name is bound to the registration's agent name UNLESS the linked
 * human has named the agent (`display_name_set_by: 'linked_human'`), in which case it must be a
 * well-formed name (1..100 chars, trimmed, no markup) with a real `display_name_set_at` inside the
 * wallet's own [created_at, updated_at] span. The two marker fields travel together or not at all.
 * The name is display metadata; identity (address, key, API prefix) is still bound exactly.
 */
export function displayNameMatchesRecoveryIdentity(
  raw: Record<string, unknown>,
  registeredName: string,
  createdAt: number,
  updatedAt: number,
): boolean {
  const hasSetBy = raw.display_name_set_by !== undefined;
  const hasSetAt = raw.display_name_set_at !== undefined;
  if (hasSetBy !== hasSetAt) return false;
  if (!hasSetBy) return raw.display_name === registeredName;
  if (raw.display_name_set_by !== 'linked_human') return false;
  const setAt = raw.display_name_set_at;
  if (typeof setAt !== 'number' || !Number.isSafeInteger(setAt) || setAt < createdAt || setAt > updatedAt) {
    return false;
  }
  const name = raw.display_name;
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 100
    && name.trim() === name
    && !/[<>]/.test(name);
}

function validateWallet(
  snapshot: SnapshotLike,
  registration: AgentWalletRegistrationDocument,
  effective: EffectiveRecoveryIdentity,
  identity: AgentWalletRegistrationRecoveryIdentity,
): { wallet: AgentWalletDocument; fence: NativeWalletRegistrationFence } {
  const raw = snapshotData(snapshot, 'wallet');
  const hasCurrentBps = raw.operational_reserve_bps !== undefined;
  const hasLegacyRatio = raw.operational_reserve_ratio !== undefined;
  if (hasCurrentBps === hasLegacyRatio) integrityFailure('wallet_share_encoding');
  const required = [
    'id', 'agent_id', 'display_name', 'platform', 'address', 'public_key',
    'api_key_hash', 'api_key_salt', 'api_key_prefix', 'governance',
    'badges', 'streak_days', 'last_pe_date',
    'chains', 'callback_url', 'linked_human_wallet_id', 'linked_human_user_id',
    'linked_human_address', 'parent_wallet_id',
    hasCurrentBps ? 'operational_reserve_bps' : 'operational_reserve_ratio',
    'children_wallet_ids', 'constitution_accepted_at', 'constitution_version',
    'economic_activity_usd', 'x402_payment_count', 'attestation_count',
    'rotation_count', 'status', 'created_at', 'updated_at',
    'native_watcher_registration',
  ];
  // Rotation is LIVE : a rotated wallet legitimately carries
  // rotation_count > 0 and last_rotated_at. `last_rotated_at` is
  // required exactly when rotation_count > 0 and forbidden when 0, so an
  // un-rotated wallet's key set — and its tamper detection — is unchanged.
  // `governance_score` and `pe_count` are deleted from new wallets but
  // remain on pre- wallets in Firestore, so they are TOLERATED (optional),
  // never required — recovery accepts a wallet with or without them.
  const rotationCount = safeNonNegativeInteger(raw.rotation_count, 'wallet_rotation_count');
  exactKeys(raw, rotationCount > 0 ? [...required, 'last_rotated_at'] : required, [
    'economic_activity_pvt', 'pvt_held_cached', 'pvt_burned_attributable',
    'governance_score', 'pe_count',
    // Item 5: the linked human may name the agent (display metadata, never identity).
    'display_name_set_by', 'display_name_set_at', 'network_class',
  ], 'wallet_keys');
  if (raw.network_class !== undefined && !participantClass(raw.network_class)) integrityFailure('wallet_network_class');
  validateGovernance(raw.governance);
  validateBadges(raw.badges);
  const createdAt = safeTimestamp(raw.created_at, identity.now, 'wallet_created_at');
  const updatedAt = safeTimestamp(raw.updated_at, identity.now, 'wallet_updated_at');
  const constitutionAcceptedAt = safeObservedTimestamp(
    raw.constitution_accepted_at,
    identity.now,
    'wallet_constitution_at',
  );
  const linkedWallet = stringOrNull(raw.linked_human_wallet_id, 'wallet_linked_wallet');
  const linkedUser = stringOrNull(raw.linked_human_user_id, 'wallet_linked_user');
  const linkedAddress = raw.linked_human_address === null
    ? null
    : (typeof raw.linked_human_address === 'string' && ADDRESS.test(raw.linked_human_address)
      ? raw.linked_human_address
      : integrityFailure('wallet_linked_address'));
  const reserveValue = hasCurrentBps
    ? raw.operational_reserve_bps
    : raw.operational_reserve_ratio;
  const agentShareBps = linkedWallet === null
    ? null
    : canonicalAgentBeneficiaryShareBps(hasCurrentBps
      ? { bps: reserveValue }
      : { legacyRatio: reserveValue });
  if ((linkedWallet === null
      && (linkedUser !== null || linkedAddress !== null || reserveValue !== null))
    || (linkedWallet !== null
      && (linkedUser === null || linkedAddress === null || agentShareBps === null))) {
    integrityFailure('wallet_linkage_state');
  }
  if (raw.id !== registration.wallet_id
    || raw.agent_id !== registration.agent_id
    // Address / public key / API prefix follow the CURRENT identity. For an
    // un-rotated wallet `effective` IS the birth registration, so this is the
    // unchanged birth binding; for a rotated wallet these are anchored to the
    // sealed rotation lineage inside computeEffectiveRecoveryIdentity.
    || raw.address !== effective.address
    || raw.public_key !== effective.publicKey
    || raw.api_key_prefix !== effective.apiKeyPrefix
    || typeof raw.api_key_hash !== 'string' || !API_HASH.test(raw.api_key_hash)
    || typeof raw.api_key_salt !== 'string' || !API_SALT.test(raw.api_key_salt)
    || !displayNameMatchesRecoveryIdentity(raw, identity.agentName, createdAt, updatedAt)
    || raw.platform !== identity.platform
    || safeNonNegativeInteger(raw.streak_days, 'wallet_streak_days') < 0
    || (raw.last_pe_date !== null
      && (typeof raw.last_pe_date !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(raw.last_pe_date)))
    || !Array.isArray(raw.chains) || raw.chains.length === 0
    || raw.chains.some((chain) => typeof chain !== 'string' || chain.length === 0)
    || new Set(raw.chains).size !== raw.chains.length
    || JSON.stringify(raw.chains) !== JSON.stringify(identity.chains)
    || (raw.callback_url !== null
      && (typeof raw.callback_url !== 'string' || !raw.callback_url.startsWith('https://')))
    || raw.callback_url !== identity.callbackUrl
    || (raw.parent_wallet_id !== null
      && (typeof raw.parent_wallet_id !== 'string' || !WALLET_ID.test(raw.parent_wallet_id)))
    || raw.parent_wallet_id !== identity.parentWalletId
    || !Array.isArray(raw.children_wallet_ids)
    || raw.children_wallet_ids.some((child) => typeof child !== 'string' || !WALLET_ID.test(child))
    || raw.children_wallet_ids.length > 128
    || new Set(raw.children_wallet_ids).size !== raw.children_wallet_ids.length
    || raw.children_wallet_ids.includes(registration.wallet_id)
    || raw.constitution_version !== identity.constitutionVersion
    || constitutionAcceptedAt !== identity.constitutionAcceptedAt
    || finiteNonNegative(raw.economic_activity_usd, 'wallet_economic_activity') < 0
    || safeNonNegativeInteger(raw.x402_payment_count, 'wallet_x402_count') < 0
    || safeNonNegativeInteger(raw.attestation_count, 'wallet_attestation_count') < 0
    || raw.status !== 'active'
    || createdAt !== registration.created_at_ms
    || updatedAt < createdAt
    || (registration.last_credential_recovered_at_ms !== undefined
      && updatedAt < registration.last_credential_recovered_at_ms)) {
    integrityFailure('wallet_fields');
  }
  for (const optionalAtomic of [
    'economic_activity_pvt', 'pvt_held_cached', 'pvt_burned_attributable',
  ]) {
    if (raw[optionalAtomic] !== undefined
      && (typeof raw[optionalAtomic] !== 'string' || !/^[0-9]+$/.test(raw[optionalAtomic] as string))) {
      integrityFailure(`wallet_${optionalAtomic}`);
    }
  }
  if (constitutionAcceptedAt < 0) integrityFailure('wallet_constitution_at');
  // A rotated wallet's last_rotated_at must be a real observed timestamp no
  // earlier than birth. rotation_count === 0 keeps last_rotated_at forbidden
  // (enforced by exactKeys above), so an un-rotated wallet cannot smuggle one.
  if (rotationCount > 0) {
    const lastRotatedAt = safeTimestamp(raw.last_rotated_at, identity.now, 'wallet_last_rotated_at');
    if (lastRotatedAt < createdAt || updatedAt < lastRotatedAt) {
      integrityFailure('wallet_last_rotated_order');
    }
  }
  const fence = parseNativeWalletRegistrationFence(raw.native_watcher_registration);
  return { wallet: raw as unknown as AgentWalletDocument, fence };
}

function validateTrustWallet(
  snapshot: SnapshotLike,
  registration: AgentWalletRegistrationDocument,
  effective: EffectiveRecoveryIdentity,
  wallet: AgentWalletDocument,
  walletFence: NativeWalletRegistrationFence,
  identity: AgentWalletRegistrationRecoveryIdentity,
): void {
  const raw = snapshotData(snapshot, 'trust_wallet');
  exactKeys(raw, [
    'id', 'type', 'agent_id', 'address', 'public_key', 'created_at', 'pe_count',
    'pvt_earned', 'trust_score', 'foundation_eligible',
    'constitution_accepted_at', 'constitution_version', 'native_watcher_registration',
  ], ['network_class'], 'trust_wallet_keys');
  if (raw.network_class !== undefined && !participantClass(raw.network_class)) integrityFailure('trust_wallet_network_class');
  const fence = parseNativeWalletRegistrationFence(raw.native_watcher_registration);
  if (raw.id !== registration.wallet_id
    || raw.type !== 'agent'
    || raw.agent_id !== registration.agent_id
    // Current identity (birth for un-rotated). The trust mirror follows the
    // wallet's live address/key across a rotation.
    || raw.address !== effective.address
    || raw.public_key !== effective.publicKey
    || safeTimestamp(raw.created_at, identity.now, 'trust_wallet_created_at')
      !== registration.created_at_ms
    || safeNonNegativeInteger(raw.pe_count, 'trust_wallet_pe_count') < 1
    || finiteNonNegative(raw.pvt_earned, 'trust_wallet_pvt') < 0
    || finiteNonNegative(raw.trust_score, 'trust_wallet_score') < 0
    || raw.foundation_eligible !== false
    || raw.constitution_accepted_at !== wallet.constitution_accepted_at
    || raw.constitution_version !== wallet.constitution_version
    || !equalFence(fence, walletFence)) {
    integrityFailure('trust_wallet_binding');
  }
}

function validateAgentIndex(
  snapshot: SnapshotLike,
  registration: AgentWalletRegistrationDocument,
  effective: EffectiveRecoveryIdentity,
  identity: AgentWalletRegistrationRecoveryIdentity,
): void {
  const raw = snapshotData(snapshot, 'agent_index');
  exactKeys(raw, [
    'schema_version', 'registration_id', 'request_fingerprint_sha256', 'agent_id',
    'address', 'wallet_id', 'pe_id', 'pe_hash', 'api_key_prefix', 'created_at_ms',
    'credential_recovery_generation', 'updated_at_ms',
  ], [], 'agent_index_keys');
  const updatedAt = safeTimestamp(raw.updated_at_ms, identity.now, 'agent_index_updated_at');
  // The agent index is re-pointed by BOTH a rotation (address + prefix) and a
  // credential recovery (prefix); its updated_at_ms is the most recent of the
  // two. `credentialSubsystemAnchorMs` folds both in — and reduces to the birth
  // registration's expected updated_at when the wallet is un-rotated.
  // `created_at_ms` / `registration_id` / `pe_id` remain the immutable BIRTH
  // anchor (a rotation never repoints the registration doc or birth PE).
  if (raw.schema_version !== 'native-agent-registration/v1'
    || raw.registration_id !== registration.registration_id
    || raw.request_fingerprint_sha256 !== registration.request_fingerprint_sha256
    || raw.agent_id !== registration.agent_id
    || raw.address !== effective.address
    || raw.wallet_id !== registration.wallet_id
    || raw.pe_id !== registration.pe_id
    || raw.pe_hash !== registration.pe_hash
    || raw.api_key_prefix !== effective.apiKeyPrefix
    || raw.created_at_ms !== registration.created_at_ms
    || raw.credential_recovery_generation !== registration.credential_recovery_generation
    || updatedAt !== effective.credentialSubsystemAnchorMs) {
    integrityFailure('agent_index_binding');
  }
}

function validateAddressIndex(
  snapshot: SnapshotLike,
  registration: AgentWalletRegistrationDocument,
  effective: EffectiveRecoveryIdentity,
  identity: AgentWalletRegistrationRecoveryIdentity,
): void {
  const raw = snapshotData(snapshot, 'address_index');
  exactKeys(raw, [
    'schema_version', 'chain_id', 'address', 'wallet_id', 'owner_type', 'owner_id',
    'created_at_ms',
  ], [], 'address_index_keys');
  // The native address index is created fresh at birth OR at the last rotation
  // (credential recovery never touches it — the address does not change). Its
  // created_at_ms is therefore `addressSubsystemAnchorMs`, which reduces to the
  // birth created_at for an un-rotated wallet.
  if (raw.schema_version !== 'native-wallet-address-index/v1'
    || raw.chain_id !== 8453
    || raw.address !== effective.address
    || raw.wallet_id !== registration.wallet_id
    || raw.owner_type !== 'agent'
    || raw.owner_id !== registration.agent_id
    || safeTimestamp(raw.created_at_ms, identity.now, 'address_index_created_at')
      !== effective.addressSubsystemAnchorMs) {
    integrityFailure('address_index_binding');
  }
}

function parseCheckpoint(
  snapshot: SnapshotLike,
  identity: AgentWalletRegistrationRecoveryIdentity,
): { membershipGeneration: number; lastProcessedBlock: number | null } {
  const raw = snapshotData(snapshot, 'watcher_checkpoint');
  try {
    const parsed = parseWatcherCheckpointDocument(raw, 8453);
    safeTimestamp(parsed.updatedAtMs, identity.now, 'watcher_checkpoint_updated_at');
    return {
      membershipGeneration: parsed.membershipGeneration,
      lastProcessedBlock: parsed.lastProcessedBlock,
    };
  } catch (error) {
    if (error instanceof AgentWalletRegistrationIntegrityError) throw error;
    return integrityFailure('watcher_checkpoint_fields');
  }
}

function validateWatcher(
  admissionSnapshot: SnapshotLike,
  checkpointSnapshot: SnapshotLike,
  registration: AgentWalletRegistrationDocument,
  effective: EffectiveRecoveryIdentity,
  fence: NativeWalletRegistrationFence,
  identity: AgentWalletRegistrationRecoveryIdentity,
): void {
  const admission = parseWatcherAddressAdmission(
    snapshotData(admissionSnapshot, 'watcher_admission'),
  );
  const checkpoint = parseCheckpoint(checkpointSnapshot, identity);
  // The admission is the fresh registration-fenced admission for the CURRENT
  // address — the birth admission for an un-rotated wallet, the rotation
  // admission (new address, bumped membership generation, H+1 rotation fence)
  // for a rotated one. `fence` is the wallet's live fence, which a rotation
  // advances to its own H+1; `addressSubsystemAnchorMs` is its birth-or-rotation
  // created_at. Credential recovery never re-admits (the address is unchanged).
  if (admission.schema_version !== 'pvt-watcher-address-admission/v3'
    || admission.generation_fenced_at_registration !== true
    || admission.direction !== 'inbound'
    || admission.chain_id !== 8453
    || admission.wallet_id !== registration.wallet_id
    || admission.agent_id !== registration.agent_id
    || admission.address !== effective.address
    || admission.eligibility_start_block !== fence.eligibility_start_block
    || admission.created_at_ms !== effective.addressSubsystemAnchorMs
    || admission.updated_at_ms < admission.created_at_ms
    || admission.updated_at_ms > identity.now
    || admission.membership_generation < 1
    || checkpoint.membershipGeneration < admission.membership_generation
    || (checkpoint.lastProcessedBlock !== null
      && admission.catch_up_through_block > checkpoint.lastProcessedBlock
      && admission.catch_up_through_block !== fence.eligibility_start_block - 1)) {
    integrityFailure('watcher_binding');
  }
}

function validateBirthPe(
  identityPes: RecoveryIdentityPes,
  registration: AgentWalletRegistrationDocument,
  wallet: AgentWalletDocument,
  identity: AgentWalletRegistrationRecoveryIdentity,
): Record<string, unknown> {
  const raw = identityPes.byId.get(registration.pe_id);
  if (!raw || raw.hash !== registration.pe_hash) return integrityFailure('pe_missing');
  const metadata = plainRecord(raw.metadata, 'birth_pe_metadata');
  // `governance_score` is gone from new birth-PE metadata but present on
  // pre- births, so it is TOLERATED (optional), never required.
  exactKeys(metadata, [
    'wallet_type', 'platform', 'public_key', 'chains', 'governance', 'badges',
    'beneficiary_relationship', 'constitution',
  ], ['governance_score'], 'birth_pe_metadata_keys');
  const constitution = plainRecord(metadata.constitution, 'birth_pe_constitution');
  validateGovernance(metadata.governance);
  exactKeys(constitution, ['accepted', 'version', 'accepted_at'], [], 'birth_pe_constitution_keys');
  const acceptedAt = typeof constitution.accepted_at === 'string'
    ? Date.parse(constitution.accepted_at)
    : Number.NaN;
  if (raw.action_type !== 'agent_wallet_created'
    || raw.actor_address !== registration.address
    || raw.policy_action_type !== 'wallet_created'
    || raw.prev_hash !== '0x0000'
    || raw.hash !== registration.pe_hash
    || raw.timestamp !== registration.created_at_ms
    || metadata.wallet_type !== 'agent_self_signup'
    || metadata.platform !== wallet.platform
    || metadata.public_key !== registration.public_key
    || !Array.isArray(metadata.chains)
    || JSON.stringify(metadata.chains) !== JSON.stringify(wallet.chains)
    || stableStringify(metadata.governance) !== stableStringify(identity.governance)
    || !Array.isArray(metadata.badges)
    || metadata.badges.some((badge) => typeof badge !== 'string')
    || typeof metadata.beneficiary_relationship !== 'object'
    || metadata.beneficiary_relationship === null
    || Array.isArray(metadata.beneficiary_relationship)
    || constitution.accepted !== identity.constitutionAccepted
    || constitution.version !== wallet.constitution_version
    || !Number.isFinite(acceptedAt)
    || acceptedAt !== wallet.constitution_accepted_at) {
    integrityFailure('birth_pe_binding');
  }
  return raw;
}

/**
 * The relay keeps only the actor's chain-tip HASH (PE meter): the PEs behind it are the owner's
 * to hold and prove, so the tip cannot be resolved to a stored PE any more. What the tip still
 * proves against the identity records this recovery holds:
 *   - it is the agent's tip (owner, shape), written no earlier than the newest identity PE
 *     (the tip advanced through every one of them);
 *   - if it names an identity PE, no identity PE chains onto it (a tip rewound to an earlier
 *     identity record is a forged tip), and its recorded timestamp matches.
 */
function validateChainTip(
  snapshot: SnapshotLike,
  identityPes: RecoveryIdentityPes,
  registration: AgentWalletRegistrationDocument,
  identity: AgentWalletRegistrationRecoveryIdentity,
): void {
  const raw = snapshotData(snapshot, 'chain_tip');
  exactKeys(raw, ['hash', 'user_id', 'updated_at'], ['last_pe_timestamp'], 'chain_tip_keys');
  const updatedAt = safeTimestamp(raw.updated_at, identity.now, 'chain_tip_updated_at');
  const members = [...identityPes.byId.values()];
  const newestTimestamp = Math.max(...members.map((pe) => pe.timestamp));
  const named = members.find((pe) => pe.hash === raw.hash);
  if (typeof raw.hash !== 'string' || !SHA256.test(raw.hash)
    || raw.user_id !== registration.agent_id
    || updatedAt < newestTimestamp
    || (raw.last_pe_timestamp !== undefined
      && (!Number.isSafeInteger(raw.last_pe_timestamp)
        || (named !== undefined && raw.last_pe_timestamp !== named.timestamp)))
    // Chain order, not timestamps (a badge PE carries its earlier earned-at time): a tip whose
    // PE some identity PE already chains onto has been rewound.
    || (named !== undefined && members.some((pe) => pe.prev_hash === named.hash))) {
    integrityFailure('chain_tip_binding');
  }
}

function validateOldApiIndex(
  snapshot: SnapshotLike,
  registration: AgentWalletRegistrationDocument,
  effective: EffectiveRecoveryIdentity,
  identity: AgentWalletRegistrationRecoveryIdentity,
): void {
  const raw = snapshotData(snapshot, 'api_index');
  exactKeys(raw, ['api_key_prefix', 'wallet_id', 'created_at'], [], 'api_index_keys');
  // The current API prefix index is created fresh by the most recent of birth,
  // rotation, and credential recovery — `credentialSubsystemAnchorMs` (which
  // reduces to the birth/recovery expected value for an un-rotated wallet).
  if (raw.api_key_prefix !== effective.apiKeyPrefix
    || raw.wallet_id !== registration.wallet_id
    || safeTimestamp(raw.created_at, identity.now, 'api_index_created_at')
      !== effective.credentialSubsystemAnchorMs) {
    integrityFailure('api_index_binding');
  }
}

function buildRefs(
  db: Firestore,
  registration: AgentWalletRegistrationDocument,
  // The three address/prefix-keyed refs follow the CURRENT identity (rotated or
  // birth). Every other ref keys off wallet_id / agent_id / pe_id, which a
  // rotation never changes, so they stay bound to the immutable birth anchor.
  currentAddress: string,
  currentApiKeyPrefix: string,
): RecoveryRefs {
  return {
    registrationRef: db.collection(AGENT_WALLET_REGISTRATION_COLLECTION)
      .doc(agentWalletRegistrationDocumentId(registration.registration_id)),
    walletRef: db.collection('agent_wallets').doc(registration.wallet_id),
    trustWalletRef: db.collection('wallets').doc(registration.wallet_id),
    agentIndexRef: db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)
      .doc(nativeAgentRegistrationIndexId(registration.agent_id)),
    addressIndexRef: db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
      .doc(nativeWalletAddressIndexId(currentAddress)),
    admissionRef: db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION)
      .doc(watcherAddressAdmissionDocId({
        direction: 'inbound',
        chainId: 8453,
        address: currentAddress,
        walletId: registration.wallet_id,
        agentId: registration.agent_id,
        eligibilityStartBlock: 0,
      })),
    checkpointRef: db.collection(INBOUND_WATCHER_CHECKPOINT_COLLECTION).doc('8453'),
    chainTipRef: db.collection('pe_chain_tips').doc(registration.agent_id),
    oldIndexRef: db.collection('api_key_index').doc(currentApiKeyPrefix),
    relationshipRef: beneficiaryRelationshipRef(db, registration.wallet_id),
    governanceSourceRef: agentGovernanceSourceRef(db, registration.wallet_id),
  };
}

interface ValidatedRecoveryGraph {
  registration: AgentWalletRegistrationDocument;
  wallet: AgentWalletDocument;
  refs: RecoveryRefs;
  relationship: AgentBeneficiaryRelationshipDocument;
  governanceSource: AgentGovernanceSourceDocument | null;
}

function validateSnapshots(
  snapshots: RecoverySnapshots,
  effective: EffectiveRecoveryIdentity,
  refs: RecoveryRefs,
  identity: AgentWalletRegistrationRecoveryIdentity,
): ValidatedRecoveryGraph {
  const registration = parseRegistration(snapshots.registration, identity);
  const { wallet, fence } = validateWallet(snapshots.wallet, registration, effective, identity);
  validateTrustWallet(
    snapshots.trustWallet,
    registration,
    effective,
    wallet,
    fence,
    identity,
  );
  validateAgentIndex(snapshots.agentIndex, registration, effective, identity);
  validateAddressIndex(snapshots.addressIndex, registration, effective, identity);
  validateWatcher(snapshots.admission, snapshots.checkpoint, registration, effective, fence, identity);
  const relationship = parseBeneficiaryRelationship(snapshots.relationship);
  validateOldApiIndex(snapshots.oldIndex, registration, effective, identity);
  let governanceSource: AgentGovernanceSourceDocument | null = null;
  if (snapshots.governanceSource.exists) {
    try {
      governanceSource = parseAgentGovernanceSource(snapshots.governanceSource.data());
    } catch {
      return integrityFailure('governance_source_invalid');
    }
    if (governanceSource.wallet_id !== registration.wallet_id
      || governanceSource.agent_id !== registration.agent_id) {
      integrityFailure('governance_source_binding');
    }
  }
  return { registration, wallet, refs, relationship, governanceSource };
}

function authorizedExternalRecords(
  records: readonly ProvenAddressRecord[],
  registration: AgentWalletRegistrationDocument,
): ProvenAddressRecord[] {
  const byAddress = new Map<string, ProvenAddressRecord>();
  for (const record of records) {
    if (record.agent_id !== registration.agent_id
      || record.wallet_id !== registration.wallet_id) continue;
    if (byAddress.has(record.address)) integrityFailure('external_actor_duplicate');
    byAddress.set(record.address, record);
  }
  return [...byAddress.values()];
}

// PE METER: external-actor provenance. Before the meter, recovery walked the agent's WHOLE chain
// and required every PE authored by a non-lineage address to be preceded by its
// `external_address_proven` PE. The relay no longer keeps the agent's PEs — the owner holds them
// and proves its own chain's continuity — so that walk has nothing to read. What remains is
// bounded: every identity PE this recovery validates must be authored by the wallet's own lineage
// or by an address the agent has proven (`proven_addresses`, re-read inside the install
// transaction and refused if it changed: `external_actor_changed`).

/**
 * The identity PEs one recovery rests on, read by one point read each from the pins the identity
 * records hold. Never a query over the agent's chain.
 */
interface RecoveryIdentityPes {
  readonly byId: ReadonlyMap<string, CanonicalAgentStoredPe>;
  readonly ids: readonly string[];
  readonly hashes: readonly string[];
}

interface IdentityPin {
  readonly peId: string;
  readonly peHash: string;
}

function parseRecoveryBadgeOutboxes(
  snapshots: readonly SnapshotLike[],
): (AgentBadgeAwardOutboxDocument | null)[] {
  return snapshots.map((snapshot) => {
    if (!snapshot.exists) return null;
    try {
      return parseBadgeAwardOutbox(snapshot);
    } catch {
      return integrityFailure('badge_outbox_invalid');
    }
  });
}

/** Every identity PE the recovery's identity records pin, in a deterministic order, deduplicated. */
function recoveryIdentityPins(params: {
  registration: AgentWalletRegistrationDocument;
  effective: EffectiveRecoveryIdentity;
  relationship: AgentBeneficiaryRelationshipDocument;
  governanceSource: AgentGovernanceSourceDocument | null;
  badgeOutboxes: readonly (AgentBadgeAwardOutboxDocument | null)[];
}): IdentityPin[] {
  const raw: IdentityPin[] = [
    { peId: params.registration.pe_id, peHash: params.registration.pe_hash },
    ...params.effective.rotationEntries.map((entry) => ({ peId: entry.pe_id, peHash: entry.pe_hash })),
    { peId: params.relationship.source_pe_id, peHash: params.relationship.source_pe_hash },
    ...(params.governanceSource
      ? [{ peId: params.governanceSource.source_pe_id, peHash: params.governanceSource.source_pe_hash }]
      : []),
  ];
  for (const outbox of params.badgeOutboxes) {
    if (!outbox) continue;
    raw.push({ peId: outbox.source_pe_id, peHash: outbox.source_pe_hash });
    if (outbox.state === 'complete') {
      raw.push({ peId: outbox.badge_pe_id as string, peHash: outbox.badge_pe_hash as string });
    }
  }
  const byId = new Map<string, IdentityPin>();
  for (const pin of raw) {
    const existing = byId.get(pin.peId);
    if (existing && existing.peHash !== pin.peHash) integrityFailure('identity_pe_pin_conflict');
    if (!existing) byId.set(pin.peId, pin);
  }
  return [...byId.values()];
}

async function readRecoveryIdentityPes(params: {
  db: Firestore;
  get: (ref: DocumentReference) => Promise<SnapshotLike>;
  pins: readonly IdentityPin[];
  registration: AgentWalletRegistrationDocument;
  allowedActorAddresses: ReadonlySet<string>;
  now: number;
}): Promise<RecoveryIdentityPes> {
  const pes = await Promise.all(params.pins.map(async (pin) => {
    try {
      return await readIdentityPe(params.db, {
        peId: pin.peId,
        peHash: pin.peHash,
        agentId: params.registration.agent_id,
        walletId: params.registration.wallet_id,
        maxTimestampMs: params.now,
        allowedActorAddresses: params.allowedActorAddresses,
      }, params.get);
    } catch {
      return integrityFailure('pe_chain_invalid');
    }
  }));
  return {
    byId: new Map(pes.map((pe) => [pe.id, pe])),
    ids: params.pins.map((pin) => pin.peId),
    hashes: params.pins.map((pin) => pin.peHash),
  };
}

/**
 * Each rotation_history entry's sealed `agent_key_rotated` identity PE carries the same cut
 * (old → new address, rotation index), the same time, and is authored by the new key.
 */
function validateRotationPes(
  effective: EffectiveRecoveryIdentity,
  identityPes: RecoveryIdentityPes,
): void {
  for (const entry of effective.rotationEntries) {
    const pe = identityPes.byId.get(entry.pe_id);
    if (!pe
      || pe.hash !== entry.pe_hash
      || pe.action_type !== 'agent_key_rotated'
      || pe.timestamp !== entry.rotated_at
      || pe.actor_address.toLowerCase() !== entry.new_address
      || pe.metadata.old_address !== entry.old_address
      || pe.metadata.new_address !== entry.new_address
      || pe.metadata.rotation_count !== entry.rotation_count) {
      integrityFailure('rotation_pe_binding');
    }
  }
}

/**
 * The wallet's governance settings are either the registration's (never changed since birth) or
 * exactly what the governance-source pointer's `policy_updated` identity act set. The act's own
 * `previous_governance` must be well-formed. (Chaining every predecessor back to birth needed the
 * whole chain; the pointer is updated atomically with each change, so the act it names is the
 * one in force.)
 */
function validateGovernanceProvenance(
  wallet: AgentWalletDocument,
  identity: AgentWalletRegistrationRecoveryIdentity,
  governanceSource: AgentGovernanceSourceDocument | null,
  identityPes: RecoveryIdentityPes,
): void {
  if (!governanceSource) {
    if (stableStringify(wallet.governance) !== stableStringify(identity.governance)) {
      integrityFailure('governance_policy_binding');
    }
    return;
  }
  const pe = identityPes.byId.get(governanceSource.source_pe_id);
  const metadata = pe?.metadata;
  if (!pe
    || pe.hash !== governanceSource.source_pe_hash
    || pe.action_type !== 'policy_updated'
    || !metadata
    || metadata.policy_key !== 'agent_governance_settings'
    || pe.timestamp !== governanceSource.updated_at_ms
    || stableStringify(metadata.new_governance) !== stableStringify(governanceSource.governance)
    || stableStringify(wallet.governance) !== stableStringify(governanceSource.governance)) {
    integrityFailure('governance_policy_binding');
  }
  if (!isAgentGovernanceSettings(metadata.previous_governance)) {
    integrityFailure('governance_policy_predecessor');
  }
}

interface RecoveryRelationshipAndBadgeSnapshots {
  human: SnapshotLike | null;
  parent: SnapshotLike | null;
  children: readonly SnapshotLike[];
  badgeOutboxes: readonly SnapshotLike[];
}

async function readRecoveryRelationshipAndBadgeSnapshots(params: {
  db: Firestore;
  wallet: AgentWalletDocument;
  relationship: AgentBeneficiaryRelationshipDocument;
  get: (ref: DocumentReference) => Promise<SnapshotLike>;
}): Promise<RecoveryRelationshipAndBadgeSnapshots> {
  const { db, wallet, relationship, get } = params;
  const humanRef = relationship.human_wallet_id
    ? db.collection('wallets').doc(relationship.human_wallet_id)
    : null;
  const parentRef = wallet.parent_wallet_id
    ? db.collection('agent_wallets').doc(wallet.parent_wallet_id)
    : null;
  const childRefs = wallet.children_wallet_ids.map((childId) =>
    db.collection('agent_wallets').doc(childId));
  const badgeRefs = ALL_BADGE_IDS.map((badgeId) =>
    badgeAwardOutboxRef(db, wallet.id, badgeId));
  const [human, parent, children, badgeOutboxes] = await Promise.all([
    humanRef ? get(humanRef) : Promise.resolve(null),
    parentRef ? get(parentRef) : Promise.resolve(null),
    Promise.all(childRefs.map(get)),
    Promise.all(badgeRefs.map(get)),
  ]);
  return { human, parent, children, badgeOutboxes };
}

async function readCanonicalChildRelationships(
  db: Firestore,
  children: readonly SnapshotLike[],
): Promise<AgentBeneficiaryRelationshipDocument[]> {
  return Promise.all(children.map(async (snapshot) => {
    if (!snapshot.exists) return integrityFailure('child_missing');
    const child = snapshot.data() as AgentWalletDocument | undefined;
    if (!child) return integrityFailure('child_shape');
    try {
      return await readValidatedBeneficiaryRelationship({ db, wallet: child });
    } catch {
      return integrityFailure('child_relationship_invalid');
    }
  }));
}

async function revalidateCanonicalChildRelationshipsInTransaction(params: {
  db: Firestore;
  txn: Transaction;
  children: readonly SnapshotLike[];
  expected: readonly AgentBeneficiaryRelationshipDocument[];
}): Promise<AgentBeneficiaryRelationshipDocument[]> {
  if (params.children.length !== params.expected.length) {
    return integrityFailure('child_relationships_changed');
  }
  return Promise.all(params.children.map(async (snapshot, index) => {
    if (!snapshot.exists) return integrityFailure('child_missing');
    const child = snapshot.data() as AgentWalletDocument | undefined;
    if (!child) return integrityFailure('child_shape');
    try {
      return await readValidatedBeneficiaryRelationshipInTransaction({
        db: params.db,
        txn: params.txn,
        wallet: child,
        expected: params.expected[index],
      });
    } catch {
      return integrityFailure('child_relationship_changed');
    }
  }));
}

function validateRecoveryRelationshipAndBadges(params: {
  wallet: AgentWalletDocument;
  relationship: AgentBeneficiaryRelationshipDocument;
  // The wallet's full address lineage, so a birth-established beneficiary
  // relationship still binds after the address rotated.
  lineageAddresses: ReadonlySet<string>;
  registration: AgentWalletRegistrationDocument;
  identityPes: RecoveryIdentityPes;
  badgeOutboxes: readonly (AgentBadgeAwardOutboxDocument | null)[];
  related: RecoveryRelationshipAndBadgeSnapshots;
  childRelationships: readonly AgentBeneficiaryRelationshipDocument[];
}): void {
  const {
    wallet,
    relationship,
    lineageAddresses,
    registration,
    identityPes,
    badgeOutboxes,
    related,
    childRelationships,
  } = params;

  const relationshipSource = identityPes.byId.get(relationship.source_pe_id);
  if (!relationshipSource) integrityFailure('beneficiary_relationship_source_not_in_chain');
  try {
    validateBeneficiaryRelationship({
      relationship,
      wallet,
      sourceActorAddresses: lineageAddresses,
      sourcePe: relationshipSource,
      humanWallet: related.human?.exists
        ? related.human.data() as Record<string, unknown>
        : relationship.state === 'linked' ? null : undefined,
    });
  } catch {
    integrityFailure('beneficiary_relationship_binding');
  }

  if (wallet.parent_wallet_id) {
    const parent = related.parent?.exists
      ? related.parent.data() as Record<string, unknown>
      : null;
    if (!parent
      || parent.id !== wallet.parent_wallet_id
      || parent.status !== 'active'
      || !Array.isArray(parent.children_wallet_ids)
      || !parent.children_wallet_ids.includes(wallet.id)) {
      integrityFailure('parent_child_binding');
    }
  } else if (related.parent !== null) {
    integrityFailure('unexpected_parent');
  }
  if (related.children.length !== wallet.children_wallet_ids.length) {
    integrityFailure('children_shape');
  }
  if (childRelationships.length !== wallet.children_wallet_ids.length) {
    integrityFailure('child_relationships_shape');
  }
  related.children.forEach((snapshot, index) => {
    const child = snapshot.exists ? snapshot.data() as Record<string, unknown> : null;
    const childRelationship = childRelationships[index];
    if (!child
      || child.id !== wallet.children_wallet_ids[index]
      || child.parent_wallet_id !== wallet.id
      || child.status !== 'active'
      || !childRelationship
      || childRelationship.wallet_id !== child.id
      || childRelationship.agent_id !== child.agent_id
      || childRelationship.parent_wallet_id !== wallet.id) {
      integrityFailure('child_parent_binding');
    }
  });

  // Badge qualifications the bounded identity records themselves declare: the birth PE's
  // creation-time `badges`, and the current beneficiary source's `qualified_badges`. (Before the
  // meter every PE in the chain was scanned; event-derived and governance qualifications are now
  // proven through the outbox's own pinned source PE below.) A badge any of these declares must
  // have its outbox, and that outbox must name this source.
  const qualificationByBadge = new Map<string, string>();
  const declaringPes: Array<{ pe: CanonicalAgentStoredPe | undefined; field: 'badges' | 'qualified_badges' }> = [
    { pe: identityPes.byId.get(registration.pe_id), field: 'badges' },
  ];
  if (relationship.source_pe_id !== registration.pe_id
    && (relationshipSource.action_type === 'agent_linked_to_human'
      || relationshipSource.action_type === 'policy_updated')) {
    declaringPes.push({ pe: relationshipSource, field: 'qualified_badges' });
  }
  for (const { pe, field } of declaringPes) {
    if (!pe) integrityFailure('pe_chain_snapshot_missing');
    const qualified = pe.metadata[field];
    if (qualified === undefined && field === 'qualified_badges') continue;
    if (!Array.isArray(qualified)
      || qualified.some((badgeId) =>
        typeof badgeId !== 'string' || !ALL_BADGE_IDS.includes(badgeId as never))) {
      integrityFailure('badge_qualification_shape');
    }
    for (const badgeId of qualified as string[]) {
      if (qualificationByBadge.has(badgeId)) integrityFailure('badge_qualification_duplicate');
      qualificationByBadge.set(badgeId, pe.id);
    }
  }

  const publicBadges = new Map(wallet.badges.map((badge) => [badge.id, badge]));
  // A badge outbox is bound to the address the badge was AWARDED at. For a
  // creation-time badge (genesis_agent — the only badge earned at wallet birth)
  // that is the BIRTH address, which after a key rotation is no longer the
  // wallet's CURRENT address. So the outbox actor address is validated against
  // the full birth→current address lineage, exactly as rebinds the
  // beneficiary source actor (`sourceActorAddresses: lineageAddresses` above) —
  // not against the current address alone, which would refuse a legitimately
  // rotated wallet's genesis_agent badge and break credential recovery. The set
  // is lowercased to match the outbox's stored lowercase `actor_address`.
  const lineageAddressesLower = new Set([...lineageAddresses].map((address) => address.toLowerCase()));
  badgeOutboxes.forEach((outbox, index) => {
    const badgeId = ALL_BADGE_IDS[index];
    const publicBadge = publicBadges.get(badgeId);
    if (!outbox) {
      if (publicBadge || qualificationByBadge.has(badgeId)) {
        integrityFailure('badge_outbox_missing');
      }
      return;
    }
    const declaredSource = qualificationByBadge.get(badgeId);
    if (outbox.wallet_id !== wallet.id
      || outbox.agent_id !== wallet.agent_id
      || !lineageAddressesLower.has(outbox.actor_address)
      || outbox.badge_id !== badgeId
      || (declaredSource !== undefined && declaredSource !== outbox.source_pe_id)) {
      integrityFailure('badge_outbox_binding');
    }
    const sourcePe = identityPes.byId.get(outbox.source_pe_id);
    if (!sourcePe) integrityFailure('badge_source_not_in_chain');
    try {
      validateBadgeQualificationSource(outbox, sourcePe);
    } catch {
      integrityFailure('badge_source_binding');
    }
    if (outbox.state === 'pending') {
      if (publicBadge) integrityFailure('pending_public_badge');
      return;
    }
    if (!publicBadge || publicBadge.earned_at !== outbox.earned_at_ms) {
      integrityFailure('public_badge_binding');
    }
    const badgePe = identityPes.byId.get(outbox.badge_pe_id as string);
    if (!badgePe) integrityFailure('badge_pe_not_in_chain');
    try {
      validateCompletedBadgePe(outbox, badgePe);
    } catch {
      integrityFailure('badge_pe_binding');
    }
  });
}

async function readDirectSnapshots(
  refs: RecoveryRefs,
  // The wallet is read in phase 1 (to resolve the current identity before the
  // address-keyed refs exist); reuse that exact snapshot so `effective` and the
  // wallet validation see one consistent read.
  wallet: SnapshotLike,
): Promise<Omit<RecoverySnapshots, 'registration'>> {
  const [
    trustWallet, agentIndex, addressIndex, admission, checkpoint,
    chainTip, oldIndex, relationship, governanceSource,
  ] = await Promise.all([
    refs.trustWalletRef.get(),
    refs.agentIndexRef.get(),
    refs.addressIndexRef.get(),
    refs.admissionRef.get(),
    refs.checkpointRef.get(),
    refs.chainTipRef.get(),
    refs.oldIndexRef.get(),
    refs.relationshipRef.get(),
    refs.governanceSourceRef.get(),
  ]);
  return {
    wallet, trustWallet, agentIndex, addressIndex, admission, checkpoint,
    chainTip, oldIndex, relationship, governanceSource,
  };
}

/**
 * Everything that depends on the identity PEs: read them by their pins, then bind birth,
 * rotations, chain tip, governance, beneficiary relationship and badges to them.
 */
async function validateRecoveryIdentityPes(params: {
  db: Firestore;
  get: (ref: DocumentReference) => Promise<SnapshotLike>;
  graph: ValidatedRecoveryGraph;
  effective: EffectiveRecoveryIdentity;
  identity: AgentWalletRegistrationRecoveryIdentity;
  chainTip: SnapshotLike;
  related: RecoveryRelationshipAndBadgeSnapshots;
  childRelationships: readonly AgentBeneficiaryRelationshipDocument[];
  allowedActorAddresses: ReadonlySet<string>;
  /** Pins the prevalidation saw; the install transaction refuses if they moved. */
  expectedPins?: { readonly ids: readonly string[]; readonly hashes: readonly string[] };
}): Promise<RecoveryIdentityPes> {
  const { graph, effective, identity } = params;
  const badgeOutboxes = parseRecoveryBadgeOutboxes(params.related.badgeOutboxes);
  const pins = recoveryIdentityPins({
    registration: graph.registration,
    effective,
    relationship: graph.relationship,
    governanceSource: graph.governanceSource,
    badgeOutboxes,
  });
  if (params.expectedPins
    && (stableStringify(pins.map((pin) => pin.peId)) !== stableStringify(params.expectedPins.ids)
      || stableStringify(pins.map((pin) => pin.peHash)) !== stableStringify(params.expectedPins.hashes))) {
    integrityFailure('pe_chain_changed');
  }
  const identityPes = await readRecoveryIdentityPes({
    db: params.db,
    get: params.get,
    pins,
    registration: graph.registration,
    allowedActorAddresses: params.allowedActorAddresses,
    now: identity.now,
  });
  validateBirthPe(identityPes, graph.registration, graph.wallet, identity);
  validateRotationPes(effective, identityPes);
  validateChainTip(params.chainTip, identityPes, graph.registration, identity);
  validateGovernanceProvenance(graph.wallet, identity, graph.governanceSource, identityPes);
  validateRecoveryRelationshipAndBadges({
    wallet: graph.wallet,
    relationship: graph.relationship,
    lineageAddresses: effective.lineageAddresses,
    registration: graph.registration,
    identityPes,
    badgeOutboxes,
    related: params.related,
    childRelationships: params.childRelationships,
  });
  return identityPes;
}

/** Read the wallet's rotation_history entries (non-transactional read path). */
async function readRotationHistoryRawEntries(
  db: Firestore,
  walletId: string,
): Promise<Record<string, unknown>[]> {
  const snap = await db.collection(rotationHistoryCollectionPath(walletId)).get();
  return snap.docs.map((doc) => doc.data() as Record<string, unknown>);
}

/** Read the wallet's rotation_history entries INSIDE the install transaction, so
 * a concurrent rotation lands as a rotation-count / lineage mismatch (and its
 * new rotation PE additionally trips the chain-changed guard). */
async function readRotationHistoryRawEntriesInTransaction(
  db: Firestore,
  txn: Transaction,
  walletId: string,
): Promise<Record<string, unknown>[]> {
  const snap = await txn.get(db.collection(rotationHistoryCollectionPath(walletId)));
  return snap.docs.map((doc) => doc.data() as Record<string, unknown>);
}

export function agentWalletRegistrationDocumentId(registrationId: string): string {
  return crypto.createHash('sha256')
    .update(`agent-wallet-registration/v1\n${registrationId}`, 'utf8')
    .digest('hex');
}

export type RotationHistoryEvidenceEntry = SharedRotationHistoryEvidenceEntry;

/**
 * beneficiary routing machinery (rotation LIVE since activation). Bind a wallet's rotation_history
 * subcollection to the wallet's declared rotation shape. This is the evidence
 * a rotated wallet must present so `rotation_count > 0` cannot be forged:
 *
 * - exactly `rotationCount` entries, numbered 1..N with no gaps or repeats;
 * - every entry carries a NON-NULL, well-formed pe_id + pe_hash — the atomic
 * seal invariant: a half-rotation that never sealed its PE is rejected;
 * - the address lineage chains birthAddress ->... -> currentAddress with no
 * break, and rotated_at strictly increases and never exceeds `now`;
 * - the final entry's new_address is the wallet's current address and its
 * rotated_at equals the wallet's last_rotated_at.
 *
 * rotationCount === 0 requires an empty history and a null last_rotated_at, so
 * an un-rotated wallet cannot smuggle rotation evidence. Reuses the recovery
 * integrity error so callers catch it uniformly. This validator does not read
 * Firestore; the caller supplies the already-read entries.
 */
export function validateRotationHistoryEvidence(
  rawEntries: readonly (Record<string, unknown> | undefined)[],
  bound: RotationHistoryEvidenceBound,
): RotationHistoryEvidenceEntry[] {
  return validateRotationHistoryEvidenceCore(rawEntries, bound, integrityFailure);
}

/**
 * The wallet's CURRENT economic identity, anchored to its durable history. For
 * an un-rotated wallet this is exactly the birth registration (so un-rotated
 * tamper detection is byte-for-byte unchanged). For a rotated wallet it is the
 * current (rotated) address/key/prefix, proven against the sealed
 * rotation_history lineage — so recovery of an already-rotated wallet passes
 * end-to-end WITHOUT weakening the birth-anchored checks.
 */
export interface EffectiveRecoveryIdentity {
  readonly address: string;
  readonly publicKey: string;
  readonly apiKeyPrefix: string;
  /** Last write time of the current NATIVE-ADDRESS subsystems (native address
   * index, watcher admission): birth, or the last rotation. Credential recovery
   * never re-writes these (it does not change the address). */
  readonly addressSubsystemAnchorMs: number;
  /** Last write time of the API/agent-index subsystems: the most recent of
   * birth, the last rotation, and the last credential recovery — both rotation
   * and recovery re-create the API prefix + re-point the agent index. */
  readonly credentialSubsystemAnchorMs: number;
  /** Every address this wallet has ever held: birth ∪ each rotation new_address.
   * The wallet's own PEs may carry any of these as actor_address. */
  readonly lineageAddresses: ReadonlySet<string>;
  readonly rotationCount: number;
  readonly rotationEntries: readonly RotationHistoryEvidenceEntry[];
}

function deriveAddressFromUncompressedPublicKey(publicKeyHex: string): string | null {
  try {
    return ethers.computeAddress(`0x04${publicKeyHex}`).toLowerCase();
  } catch {
    return null;
  }
}

/** The rotation_history subcollection ref for a wallet (docs are read by the
 * recovery read-path and re-read by id inside the install transaction). */
export function rotationHistoryCollectionPath(walletId: string): string {
  return `agent_wallets/${walletId}/${ROTATION_HISTORY_SUBCOLLECTION}`;
}

/**
 * Compute + prove the wallet's current identity from its birth registration, its
 * live wallet document, and its rotation_history subcollection entries. Rotation
 * evidence is bound by validateRotationHistoryEvidence (exactly N sealed entries,
 * numbered 1..N, birth→current lineage, strictly increasing timestamps, non-null
 * unique pe_ids); the current public key is additionally required to DERIVE to
 * the sealed terminal address, anchoring the key even though the rotation PE
 * seals only the address. An un-rotated wallet (rotation_count 0) rejects any
 * rotation evidence and resolves to the birth registration unchanged.
 */
function computeEffectiveRecoveryIdentity(
  registration: AgentWalletRegistrationDocument,
  walletRaw: Record<string, unknown>,
  rotationRawEntries: readonly (Record<string, unknown> | undefined)[],
  identity: AgentWalletRegistrationRecoveryIdentity,
): EffectiveRecoveryIdentity {
  const rotationCount = safeNonNegativeInteger(walletRaw.rotation_count, 'wallet_rotation_count');
  const recoveryAnchorMs = registration.credential_recovery_generation === 0
    ? registration.created_at_ms
    : (typeof registration.last_credential_recovered_at_ms === 'number'
      ? registration.last_credential_recovered_at_ms
      : integrityFailure('registration_recovery_anchor_missing'));
  let effective: EffectiveRecoveryIdentity;
  if (rotationCount === 0) {
    // Un-rotated: reject any rotation evidence; current identity == birth.
    validateRotationHistoryEvidence(rotationRawEntries, {
      birthAddress: registration.address,
      currentAddress: registration.address,
      rotationCount: 0,
      lastRotatedAt: null,
      now: identity.now,
    });
    effective = {
      address: registration.address,
      publicKey: registration.public_key,
      apiKeyPrefix: registration.api_key_prefix,
      addressSubsystemAnchorMs: registration.created_at_ms,
      credentialSubsystemAnchorMs: recoveryAnchorMs,
      lineageAddresses: new Set([registration.address]),
      rotationCount: 0,
      rotationEntries: [],
    };
  } else {
    // Rotated: bind the current identity to the sealed rotation lineage.
    const currentAddress = typeof walletRaw.address === 'string' && ADDRESS.test(walletRaw.address)
      ? walletRaw.address
      : integrityFailure('wallet_address_shape');
    const currentPublicKey = typeof walletRaw.public_key === 'string' && PUBLIC_KEY.test(walletRaw.public_key)
      ? walletRaw.public_key
      : integrityFailure('wallet_public_key_shape');
    const currentApiPrefix = typeof walletRaw.api_key_prefix === 'string' && API_PREFIX.test(walletRaw.api_key_prefix)
      ? walletRaw.api_key_prefix
      : integrityFailure('wallet_api_prefix_shape');
    const lastRotatedAt = safeTimestamp(walletRaw.last_rotated_at, identity.now, 'wallet_last_rotated_at');
    const entries = validateRotationHistoryEvidence(rotationRawEntries, {
      birthAddress: registration.address,
      currentAddress,
      rotationCount,
      lastRotatedAt,
      now: identity.now,
    });
    if (deriveAddressFromUncompressedPublicKey(currentPublicKey) !== currentAddress) {
      integrityFailure('wallet_rotated_public_key_derivation');
    }
    effective = {
      address: currentAddress,
      publicKey: currentPublicKey,
      apiKeyPrefix: currentApiPrefix,
      addressSubsystemAnchorMs: lastRotatedAt,
      credentialSubsystemAnchorMs: Math.max(lastRotatedAt, recoveryAnchorMs),
      lineageAddresses: new Set([registration.address, ...entries.map((entry) => entry.new_address)]),
      rotationCount,
      rotationEntries: entries,
    };
  }
  // The recovering party must present the wallet's CURRENT key — its birth key
  // when un-rotated, its rotated key when rotated. This is the identity↔request
  // binding moved out of parseRegistration so it follows the live identity
  // (an un-rotated wallet is byte-for-byte unchanged: effective == birth here).
  if (identity.address !== effective.address || identity.publicKey !== effective.publicKey) {
    integrityFailure('registration_binding');
  }
  return effective;
}

/**
 * Validate the complete committed identity before generating replacement API
 * credentials. The transaction repeats the same validation immediately before
 * installation; this first pass keeps ordinary corruption from creating even
 * an in-memory replacement secret.
 */
export async function prevalidateAgentWalletRegistrationRecovery(
  db: Firestore,
  identity: AgentWalletRegistrationRecoveryIdentity,
): Promise<ValidatedAgentWalletRegistrationRecovery> {
  const registrationRef = db.collection(AGENT_WALLET_REGISTRATION_COLLECTION)
    .doc(agentWalletRegistrationDocumentId(identity.registrationId));
  const registrationSnapshot = await registrationRef.get();
  const registration = parseRegistration(registrationSnapshot, identity);
  // Phase 1: resolve the wallet's CURRENT identity (rotated or birth) from the
  // wallet document + its sealed rotation_history, before the address-keyed refs
  // can be built.
  const walletSnapshot = await db.collection('agent_wallets').doc(registration.wallet_id).get();
  const rotationRawEntries = await readRotationHistoryRawEntries(db, registration.wallet_id);
  const effective = computeEffectiveRecoveryIdentity(
    registration,
    snapshotData(walletSnapshot, 'wallet'),
    rotationRawEntries,
    identity,
  );
  // Phase 2: build the three address/prefix-keyed refs off the current identity.
  const refs = buildRefs(db, registration, effective.address, effective.apiKeyPrefix);
  const [direct, allProvenAddresses] = await Promise.all([
    readDirectSnapshots(refs, walletSnapshot),
    listProvenAddresses(db),
  ]);
  const externalRecords = authorizedExternalRecords(allProvenAddresses, registration);
  const allowedActorAddresses = new Set([
    ...effective.lineageAddresses,
    ...externalRecords.map((record) => record.address),
  ]);
  const graph = validateSnapshots({
    registration: registrationSnapshot,
    ...direct,
  }, effective, refs, identity);
  const related = await readRecoveryRelationshipAndBadgeSnapshots({
    db,
    wallet: graph.wallet,
    relationship: graph.relationship,
    get: (ref) => ref.get(),
  });
  const childRelationships = await readCanonicalChildRelationships(db, related.children);
  const identityPes = await validateRecoveryIdentityPes({
    db,
    get: (ref) => ref.get(),
    graph,
    effective,
    identity,
    chainTip: direct.chainTip,
    related,
    childRelationships,
    allowedActorAddresses,
  });
  return {
    registration: graph.registration,
    wallet: graph.wallet,
    refs: graph.refs,
    relationship: graph.relationship,
    identityPeIds: identityPes.ids,
    identityPeHashes: identityPes.hashes,
    externalActorAddresses: externalRecords.map((record) => record.address),
    childRelationships,
  };
}

/** Repeat the exact identity check inside the credential-install transaction. */
export async function validateAgentWalletRegistrationRecoveryTransaction(
  db: Firestore,
  txn: Transaction,
  identity: AgentWalletRegistrationRecoveryIdentity,
  expectedIdentityPeIds: readonly string[],
  expectedIdentityPeHashes: readonly string[],
  expectedExternalActorAddresses: readonly string[],
  expectedChildRelationships: readonly AgentBeneficiaryRelationshipDocument[],
): Promise<ValidatedAgentWalletRegistrationRecovery> {
  if (expectedIdentityPeIds.length === 0
    || expectedIdentityPeIds.length !== expectedIdentityPeHashes.length
    || new Set(expectedIdentityPeIds).size !== expectedIdentityPeIds.length
    || new Set(expectedExternalActorAddresses).size !== expectedExternalActorAddresses.length
    || expectedExternalActorAddresses.some((address) =>
      !ADDRESS.test(address) || address === identity.address)) {
    integrityFailure('pe_chain_shape');
  }
  const registrationRef = db.collection(AGENT_WALLET_REGISTRATION_COLLECTION)
    .doc(agentWalletRegistrationDocumentId(identity.registrationId));
  const registrationSnapshot = await txn.get(registrationRef);
  const registration = parseRegistration(registrationSnapshot, identity);
  // Phase 1: resolve the CURRENT identity in-transaction (wallet + sealed
  // rotation_history) before the address-keyed refs can be built. A concurrent
  // rotation between prevalidate and here lands as a rotation-count / lineage
  // mismatch, and its new rotation PE additionally moves the identity pins.
  const walletSnapshot = await txn.get(
    db.collection('agent_wallets').doc(registration.wallet_id),
  );
  const rotationRawEntries = await readRotationHistoryRawEntriesInTransaction(
    db, txn, registration.wallet_id,
  );
  const effective = computeEffectiveRecoveryIdentity(
    registration,
    snapshotData(walletSnapshot, 'wallet'),
    rotationRawEntries,
    identity,
  );
  // Phase 2: build the address/prefix-keyed refs off the current identity, then
  // read the rest of the graph.
  const refs = buildRefs(db, registration, effective.address, effective.apiKeyPrefix);
  const externalActorRefs = expectedExternalActorAddresses.map((address) =>
    db.collection(PROVEN_ADDRESSES_COLLECTION).doc(address));
  const [
    trustWallet, agentIndex, addressIndex, admission, checkpoint,
    chainTip, oldIndex, relationship, governanceSource, externalActorSnapshots,
  ] = await Promise.all([
    txn.get(refs.trustWalletRef),
    txn.get(refs.agentIndexRef),
    txn.get(refs.addressIndexRef),
    txn.get(refs.admissionRef),
    txn.get(refs.checkpointRef),
    txn.get(refs.chainTipRef),
    txn.get(refs.oldIndexRef),
    txn.get(refs.relationshipRef),
    txn.get(refs.governanceSourceRef),
    Promise.all(externalActorRefs.map((ref) => txn.get(ref))),
  ]);
  externalActorSnapshots.forEach((snapshot, index) => {
    const address = expectedExternalActorAddresses[index];
    const value = snapshot.exists ? snapshot.data() : undefined;
    if (!isEconomicallyActiveProvenAddress(value, address)
      || value.agent_id !== registration.agent_id
      || value.wallet_id !== registration.wallet_id) {
      integrityFailure('external_actor_changed');
    }
  });
  const allowedActorAddresses = new Set([
    ...effective.lineageAddresses,
    ...expectedExternalActorAddresses,
  ]);
  const graph = validateSnapshots({
    registration: registrationSnapshot,
    wallet: walletSnapshot,
    trustWallet,
    agentIndex,
    addressIndex,
    admission,
    checkpoint,
    chainTip,
    oldIndex,
    relationship,
    governanceSource,
  }, effective, refs, identity);
  const related = await readRecoveryRelationshipAndBadgeSnapshots({
    db,
    wallet: graph.wallet,
    relationship: graph.relationship,
    get: (ref) => txn.get(ref),
  });
  const childRelationships = await revalidateCanonicalChildRelationshipsInTransaction({
    db,
    txn,
    children: related.children,
    expected: expectedChildRelationships,
  });
  await validateRecoveryIdentityPes({
    db,
    get: (ref) => txn.get(ref),
    graph,
    effective,
    identity,
    chainTip,
    related,
    childRelationships,
    allowedActorAddresses,
    expectedPins: { ids: expectedIdentityPeIds, hashes: expectedIdentityPeHashes },
  });
  return {
    registration: graph.registration,
    wallet: graph.wallet,
    refs: graph.refs,
    relationship: graph.relationship,
    identityPeIds: [...expectedIdentityPeIds],
    identityPeHashes: [...expectedIdentityPeHashes],
    externalActorAddresses: [...expectedExternalActorAddresses],
    childRelationships,
  };
}

import {readGenesisActivation} from './genesis-activation-store';
import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * Transactional atomic accounting ingress guards for the two local Genesis qualification
 * sources that also create required provenance records.
 *
 * These helpers keep the product action, deterministic idempotency/uniqueness
 * marker, required provisional PE, chain tip, and optional Genesis outbox in one
 * Firestore transaction. Derived `pe_history` accrual is acknowledged by the
 * route after this commit and retried through the same stable marker.
 */
import crypto from 'crypto';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import stableStringify from 'json-stable-stringify';

import type { RecordPEAccrualParams } from '../../pvt-accrual';
import { advanceRelayAct, relayPeOf, METER_RELAY_ACTS_COLLECTION, type RelayActIntake } from '../meter/meter-relay-authored';
import { METER_ACT_KEYS_COLLECTION } from '../meter/meter-store';
import { peHashOf as wirePeHashOf, type PeV2 } from '../meter/meter-wire';
import {
  GENESIS_ACTIVATION_COLLECTION,
  GENESIS_ACTIVATION_DOCUMENT,
  GENESIS_QUALIFICATION_COLLECTION,
  GENESIS_QUALIFICATION_RETENTION_COLLECTION,
  genesisQualificationRef,
  retainedGenesisQualificationRef,
  shouldPersistGenesisQualification,
  writeGenesisQualification,
  writeRetainedGenesisQualification,
  type GenesisQualificationAction,
  type GenesisQualificationDocument,
} from './genesis-award-state-machine';
import type { GenesisActivationApprovalVerifier } from './policy/genesis-policy-engine';
import {
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
  parseNativeWalletRegistrationFence,
  type NativeWalletRegistrationFence,
} from './native-wallet-registration';
import { externalProofRefs } from '../external-address/link';
import {
  INBOUND_WATCHER_CHECKPOINT_COLLECTION,
  WATCHER_ADDRESS_ADMISSION_COLLECTION,
  parseWatcherAddressAdmission,
  parseWatcherCheckpointDocument,
  prepareNativeWalletWatcherRebind,
  prepareNativeWalletWatcherRegistration,
  watcherAddressAdmissionDocId,
  writeNativeWalletWatcherRegistration,
  type NativeWalletWatcherRegistrationPlan,
} from './watcher-address-admission';
import {
  HUMAN_WALLET_ADDRESS_PROOF_COLLECTION,
  type VerifiedHumanWalletAddressProof,
} from '../wallet-registration/human-wallet-address-proof';

export const HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION =
  'human_wallet_registration_by_user_v1';
export const DEVICE_REGISTRATION_REQUEST_COLLECTION =
  'device_registration_requests_v1';

/**
 * review defect 1: ONE Genesis human-signup grant per ADDRESS. A marker doc keyed by the
 * lowercased address is created in the SAME transaction that seals a `genesis_human_signup`
 * qualification (outbox or retained), on every creation path, and read transactionally before
 * any new one is built. Grants sealed before the marker existed are found by an UNBOUNDED,
 * action-type-filtered query (never a bounded address-only scan — every Genesis leg shares
 * `actor_address`, so a `limit(n)` on the address alone can miss the signup row) and the marker
 * is materialized for them in the same transaction. `scripts/genesis-human-signup-address-marker-
 * backfill.ts` writes markers for existing grants in bulk (dry run by default).
 */
export const GENESIS_HUMAN_SIGNUP_BY_ADDRESS_COLLECTION = 'genesis_human_signup_by_address_v1';

export function genesisHumanSignupAddressMarkerId(address: string): string {
  return address.toLowerCase();
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const PE_PREV_HASH = /^(0x0000|[a-f0-9]{64})$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CANONICAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function humanWalletRegistrationIndexId(userId: string): string {
  return `human_${sha256(userId)}`;
}

/** Stable retry identity for one human wallet key/address registration. */
export function humanWalletRegistrationRequestFingerprint(
  userId: string,
  address: string,
  publicKey: string,
): string {
  return sha256(`${userId}\n${address}\n${publicKey}`);
}

export function deterministicDeviceRegistrationIds(
  ownerId: string,
  registrationId: string,
): { requestDocumentId: string; deviceId: string; peId: string } {
  const digest = sha256(`${ownerId}\n${registrationId}`);
  return {
    requestDocumentId: `device_registration_${digest}`,
    deviceId: `dev_${digest}`,
    peId: `pe_device_register_${digest}`,
  };
}

export class GenesisIngressError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'GenesisIngressError';
  }
}

export interface HumanRegistrationMarker {
  readonly schema_version: 'human-wallet-registration/v2';
  readonly user_id: string;
  readonly request_fingerprint: string;
  readonly wallet_id: string;
  readonly pe_id: string;
  readonly pe_hash: string;
  readonly prev_hash: string;
  readonly address: string;
  readonly public_key_sha256: string;
  readonly economic_device_id: string | null;
  readonly created_at_ms: number;
  readonly genesis_qualification_id: string | null;
  readonly standard_accrual_status: 'pending' | 'complete';
  readonly standard_accrual_acknowledged_at_ms: number | null;
}

const HUMAN_REGISTRATION_MARKER_KEYS = Object.freeze([
  'schema_version',
  'user_id',
  'request_fingerprint',
  'wallet_id',
  'pe_id',
  'pe_hash',
  'prev_hash',
  'address',
  'public_key_sha256',
  'economic_device_id',
  'created_at_ms',
  'genesis_qualification_id',
  'standard_accrual_status',
  'standard_accrual_acknowledged_at_ms',
] as const);

function parseHumanRegistrationMarker(value: unknown): HumanRegistrationMarker | null {
  const marker = record(value);
  if (marker === null || !exactKeys(marker, HUMAN_REGISTRATION_MARKER_KEYS)
    || marker.schema_version !== 'human-wallet-registration/v2'
    || typeof marker.user_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(marker.user_id)
    || typeof marker.request_fingerprint !== 'string'
    || !SHA256_HEX.test(marker.request_fingerprint)
    || typeof marker.wallet_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(marker.wallet_id)
    || typeof marker.pe_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(marker.pe_id)
    || typeof marker.pe_hash !== 'string'
    || !SHA256_HEX.test(marker.pe_hash)
    || typeof marker.prev_hash !== 'string'
    || !PE_PREV_HASH.test(marker.prev_hash)
    || typeof marker.address !== 'string'
    || !EVM_ADDRESS.test(marker.address)
    || typeof marker.public_key_sha256 !== 'string'
    || !SHA256_HEX.test(marker.public_key_sha256)
    || (marker.economic_device_id !== null
      && (typeof marker.economic_device_id !== 'string'
        || !CANONICAL_IDENTIFIER.test(marker.economic_device_id)))
    || !safeTimestamp(marker.created_at_ms)
    || (marker.genesis_qualification_id !== null
      && (typeof marker.genesis_qualification_id !== 'string'
        || !/^gq_[a-f0-9]{64}$/.test(marker.genesis_qualification_id)))
    || (marker.standard_accrual_status !== 'pending'
      && marker.standard_accrual_status !== 'complete')
    || (marker.standard_accrual_status === 'pending'
      && marker.standard_accrual_acknowledged_at_ms !== null)
    || (marker.standard_accrual_status === 'complete'
      && (!safeTimestamp(marker.standard_accrual_acknowledged_at_ms)
        || marker.standard_accrual_acknowledged_at_ms < marker.created_at_ms))) return null;
  return marker as unknown as HumanRegistrationMarker;
}

/**
 * What became of an in-window qualifying act at commit time.
 * - `persisted`: the persist gate admitted and the outbox row was written.
 * - `retained`: the persist gate refused (activation absent/invalid/killed) but
 *   the act was in-window and qualified, so it was durably retained for backfill.
 * - `not_qualified`: the act was not an in-window Genesis-bounty act at all.
 * A caller must never report `retained` as a granted award — see the route
 * status mapping. Derived from durable state, so it is honest on replay too.
 */
export type GenesisQualificationDisposition = 'persisted' | 'retained' | 'not_qualified';

/** Read durable state to classify an already-committed registration's act. */
async function deriveGenesisDisposition(
  db: Firestore,
  actionType: GenesisQualificationAction,
  immutableAnchorId: string,
): Promise<GenesisQualificationDisposition> {
  const [outboxSnap, retainedSnap] = await Promise.all([
    genesisQualificationRef(db, actionType, immutableAnchorId).get(),
    retainedGenesisQualificationRef(db, actionType, immutableAnchorId).get(),
  ]);
  if (outboxSnap.exists) return 'persisted';
  if (retainedSnap.exists) return 'retained';
  return 'not_qualified';
}

/**
 * an earlier, UNPROVEN (or released) registration of this address under another account
 * that this proof-carrying registration displaced. Null on every ordinary registration.
 */
export interface HumanWalletDisplacement {
  readonly displacedWalletId: string;
  readonly displacedUserId: string;
  /** The address already carries its one Genesis human-signup grant (outbox or retained). */
  readonly genesisAlreadyGrantedForAddress: boolean;
}

/**
 * PE METER: the human wallet's first PE is a v2 relay act. Its content is fully determined by the
 * registration (wallet, user, address, key), so the relay stores no copy: a replay rebuilds it
 * from the marker and checks it against the marker's pe hash.
 */
export function humanRegistrationPeContent(input: {
  readonly walletId: string;
  readonly userId: string;
  readonly address: string;
  readonly publicKey: string;
}): Record<string, unknown> {
  return {
    wallet_id: input.walletId,
    user_id: input.userId,
    actor_address: input.address,
    // Wallet identity and human linkage do not prove platform attestation.
    attestation_type: 'software',
    metadata: { wallet_type: 'human', public_key: input.publicKey },
  };
}

function humanRegistrationPeV2(marker: HumanRegistrationMarker, publicKey: string): PeV2 {
  return relayPeOf({
    peId: marker.pe_id,
    actorId: marker.user_id,
    prevHash: marker.prev_hash,
    timestamp: marker.created_at_ms,
    actionType: 'wallet_created',
    content: humanRegistrationPeContent({
      walletId: marker.wallet_id, userId: marker.user_id, address: marker.address, publicKey,
    }),
  });
}

/**
 * Rebuild a registration's first PE from its marker. A metered registration rebuilds its v2 PE; a
 * pre-meter one rebuilds its v1 content. Either must hash to the marker's pe hash, or the
 * registration is refused (never trusted on the marker's word).
 */
export function rebuildHumanRegistrationPE(
  marker: HumanRegistrationMarker,
  publicKey: string,
): { readonly meter: boolean; readonly pe: Record<string, unknown> } {
  const v2 = humanRegistrationPeV2(marker, publicKey);
  if (wirePeHashOf(v2) === marker.pe_hash) return { meter: true, pe: { ...v2 } };
  const legacy = {
    id: marker.pe_id,
    wallet_id: marker.wallet_id,
    user_id: marker.user_id,
    action_type: 'wallet_created',
    actor_address: marker.address,
    timestamp: marker.created_at_ms,
    prev_hash: marker.prev_hash,
    attestation_type: 'software',
    metadata: { wallet_type: 'human', public_key: publicKey },
  };
  if (sha256(stableStringify(legacy) || '') === marker.pe_hash) {
    return { meter: false, pe: { ...legacy, hash: marker.pe_hash } };
  }
  throw new GenesisIngressError('human_wallet_registration_pe_invalid');
}

export interface HumanWalletCommitResult {
  readonly created: boolean;
  readonly displacement: HumanWalletDisplacement | null;
  readonly marker: HumanRegistrationMarker;
  readonly walletDocument: Record<string, unknown>;
  /** The registration's first PE (v2 for a metered registration), returned to its owner. */
  readonly peDocument: Record<string, unknown>;
  /** True when the PE is a metered v2 act (priced through its relay intake). */
  readonly peMetered: boolean;
  /** The staged relay intake, on the creation branch only. */
  readonly intake: RelayActIntake | null;
  readonly genesisDisposition: GenesisQualificationDisposition;
}

class ExistingHumanWalletRegistration extends Error {
  constructor(
    readonly marker: HumanRegistrationMarker,
    readonly walletDocument: Record<string, unknown>,
    readonly peDocument: Record<string, unknown>,
    readonly peMetered: boolean,
  ) {
    super('human_wallet_registration_already_exists');
  }
}

export interface CommitHumanWalletRegistrationParams {
  readonly db: Firestore;
  readonly userId: string;
  readonly walletId: string;
  readonly address: string;
  readonly publicKey: string;
  readonly requestFingerprint: string;
  readonly economicDeviceId: string | null;
  readonly createdAtMs: number;
  readonly walletDocument: Record<string, unknown>;
  readonly nativeWatcherRegistration: NativeWalletRegistrationFence;
  readonly peId: string;
  /** The accrual of the first PE (`wallet_created`), from its committed hash. Pure. */
  readonly buildAccrual: (peHash: string) => RecordPEAccrualParams;
  readonly genesisQualification: GenesisQualificationDocument | null;
  /** Explicit test seam. Production always uses structured SSHSIG verification. */
  readonly genesisActivationApprovalVerifier?: GenesisActivationApprovalVerifier;
  /**
   * the route-verified EIP-712 proof that the caller controls `address`. REQUIRED on the
   * creation branch (no marker yet) and consumed there, single-use, in this transaction; ignored
   * on the idempotent replay of an existing registration, which stays proof-free.
   */
  readonly addressProof?: VerifiedHumanWalletAddressProof | null;
}

/**
 * may a proof-carrying registration displace the address's current registration?
 * Only a HUMAN registration held by ANOTHER account, never already displaced, and either never
 * proven, released by its owner's data deletion, or orphaned (its owner's users doc is gone).
 * A proven, live registration is never displaceable — its holder already proved the key.
 * Pure so the rule is unit-testable; the transaction supplies the reads.
 */
export function humanRegistrationDisplaceable(input: {
  readonly addressIndex: Record<string, unknown> | null;
  readonly wallet: Record<string, unknown> | null;
  readonly walletId: string | null;
  readonly ownerUserExists: boolean;
  readonly claimantUserId: string;
  readonly address: string;
}): boolean {
  const index = input.addressIndex;
  const wallet = input.wallet;
  if (index === null || wallet === null || input.walletId === null) return false;
  return index.owner_type === 'human'
    && typeof index.owner_id === 'string'
    && index.owner_id !== input.claimantUserId
    && index.wallet_id === input.walletId
    && index.address === input.address.toLowerCase()
    && wallet.id === input.walletId
    && wallet.type === 'human'
    && wallet.user_id === index.owner_id
    && typeof wallet.address === 'string'
    && wallet.address.toLowerCase() === input.address.toLowerCase()
    && wallet.displaced_at_ms === undefined
    && (wallet.address_proven_at_ms === undefined
      || wallet.released_at_ms !== undefined
      || !input.ownerUserExists);
}

/** Enforce one human wallet per user and co-write its first PE/outbox. */
export async function commitHumanWalletRegistration(
  params: CommitHumanWalletRegistrationParams,
): Promise<HumanWalletCommitResult> {
  const indexRef = params.db.collection(HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION)
    .doc(humanWalletRegistrationIndexId(params.userId));
  const walletRef = params.db.collection('wallets').doc(params.walletId);
  const addressIndexRef = params.db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
    .doc(nativeWalletAddressIndexId(params.address));
  // A fresh PE id must be unused: no staged intake and no act key under it.
  const peRef = privateRetentionCollection(params.db, METER_RELAY_ACTS_COLLECTION).doc(params.peId);
  const peKeyRef = privateRetentionCollection(params.db, METER_ACT_KEYS_COLLECTION).doc(params.peId);
  const activationRef = params.db.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT);
  const humanWalletsQuery = params.db.collection('wallets')
    .where('user_id', '==', params.userId)
    .where('type', '==', 'human')
    .limit(2);
  const walletAddressQuery = params.db.collection('wallets')
    .where('address', '==', params.address)
    .limit(10);
  const agentAddressQuery = params.db.collection('agent_wallets')
    .where('address', '==', params.address.toLowerCase())
    .limit(2);
  // an address someone proved as an outside wallet is never also a Provian wallet.
  const [agentProvenRef, personProvenRef] = externalProofRefs(params.db, params.address);
  let persistQualification = params.genesisQualification !== null;
  const registrationFence = parseNativeWalletRegistrationFence(
    params.nativeWatcherRegistration,
  );
  let watcherRegistrationPlan: NativeWalletWatcherRegistrationPlan | null = null;
  // creation-branch state, reset on every transaction attempt.
  let displacement: HumanWalletDisplacement | null = null;
  let displacedOwnerUsersRef: DocumentReference | null = null;
  let clearDisplacedOwnerAddress = false;
  let genesisForThisWallet: GenesisQualificationDocument | null = params.genesisQualification;
  // The address's existing human-signup grant, when the marker must be MATERIALIZED for it.
  let legacySignupMarker: Record<string, unknown> | null = null;
  const addressLc = params.address.toLowerCase();
  const signupMarkerRef = params.db.collection(GENESIS_HUMAN_SIGNUP_BY_ADDRESS_COLLECTION)
    .doc(genesisHumanSignupAddressMarkerId(params.address));

  try {
    const advanced = await advanceRelayAct(params.db, {
      actorId: params.userId,
      walletId: params.walletId,
      ownerType: 'human',
      peId: params.peId,
      timestamp: params.createdAtMs,
      actionType: 'wallet_created',
      content: humanRegistrationPeContent({
        walletId: params.walletId, userId: params.userId, address: params.address, publicKey: params.publicKey,
      }),
      accrual: params.buildAccrual,
      validateTimestampAgainstTip: true,
      atomicPrecondition: async (txn) => {
        persistQualification = params.genesisQualification !== null;
        displacement = null;
        displacedOwnerUsersRef = null;
        clearDisplacedOwnerAddress = false;
        genesisForThisWallet = params.genesisQualification;
        legacySignupMarker = null;
        const [
          indexSnap,
          proposedWalletSnap,
          peSnap,
          peKeySnap,
          activationSnap,
          humanWalletsSnap,
          addressIndexSnap,
          walletAddressSnap,
          agentAddressSnap,
          agentProvenSnap,
          personProvenSnap,
        ] = await Promise.all([
          txn.get(indexRef),
          txn.get(walletRef),
          txn.get(peRef),
          txn.get(peKeyRef),
          readGenesisActivation(params.db, txn),
          txn.get(humanWalletsQuery),
          txn.get(addressIndexRef),
          txn.get(walletAddressQuery),
          txn.get(agentAddressQuery),
          txn.get(agentProvenRef),
          txn.get(personProvenRef),
        ]);
        if (indexSnap.exists) {
          const marker = parseHumanRegistrationMarker(indexSnap.data());
          if (marker === null
            || marker.user_id !== params.userId
            || marker.request_fingerprint !== params.requestFingerprint
            || marker.address !== params.address
            || marker.public_key_sha256 !== sha256(params.publicKey)
          ) {
            throw new GenesisIngressError('human_wallet_registration_index_invalid');
          }
          if (humanWalletsSnap.size !== 1
            || humanWalletsSnap.docs[0].id !== marker.wallet_id) {
            throw new GenesisIngressError('human_wallet_uniqueness_conflict');
          }
          const addressIndex = record(addressIndexSnap.data());
          if (addressIndex !== null && addressIndex.wallet_id !== marker.wallet_id) {
            // the address's key holder proved control and displaced this unproven
            // registration. Say so, rather than reporting a corrupt index.
            const markerWalletSnap = await txn.get(params.db.collection('wallets').doc(marker.wallet_id));
            if (record(markerWalletSnap.data())?.displaced_at_ms !== undefined) {
              throw new GenesisIngressError('human_wallet_registration_displaced');
            }
          }
          if (!addressIndexSnap.exists || addressIndex === null
            || !exactKeys(addressIndex, [
              'schema_version',
              'chain_id',
              'address',
              'wallet_id',
              'owner_type',
              'owner_id',
              'created_at_ms',
            ])
            || addressIndex.schema_version !== 'native-wallet-address-index/v1'
            || addressIndex.chain_id !== registrationFence.chain_id
            || addressIndex.wallet_id !== marker.wallet_id
            || addressIndex?.owner_type !== 'human'
            || addressIndex.owner_id !== params.userId
            || addressIndex.address !== params.address.toLowerCase()
            || addressIndex.created_at_ms !== marker.created_at_ms) {
            throw new GenesisIngressError('human_wallet_address_index_invalid');
          }
          // PE METER: the registration's first PE is not stored; it is rebuilt from the marker
          // below and checked against the marker's hash.
          const existingWalletSnap = await txn.get(params.db.collection('wallets').doc(marker.wallet_id));
          const existingWallet = existingWalletSnap.data() as Record<string, unknown> | undefined;
          if (!existingWalletSnap.exists
            || existingWallet?.id !== marker.wallet_id
            || existingWallet?.user_id !== marker.user_id
            || existingWallet?.type !== 'human'
            || existingWallet?.address !== marker.address
            || existingWallet?.public_key !== params.publicKey
            || existingWallet?.created_at !== marker.created_at_ms) {
            throw new GenesisIngressError('human_wallet_registration_required_record_missing');
          }
          let existingFence: NativeWalletRegistrationFence;
          try {
            existingFence = parseNativeWalletRegistrationFence(
              existingWallet.native_watcher_registration,
            );
          } catch {
            throw new GenesisIngressError('human_wallet_registration_required_record_missing');
          }
          if (existingFence.observed_head_block !== registrationFence.observed_head_block
            || existingFence.eligibility_start_block !== registrationFence.eligibility_start_block) {
            throw new GenesisIngressError('human_wallet_registration_required_record_missing');
          }
          const watcherTarget = {
            direction: 'inbound' as const,
            chainId: registrationFence.chain_id,
            address: marker.address,
            walletId: marker.wallet_id,
            agentId: marker.user_id,
            eligibilityStartBlock: registrationFence.eligibility_start_block,
          };
          const [admissionSnap, checkpointSnap] = await Promise.all([
            txn.get(params.db.collection(WATCHER_ADDRESS_ADMISSION_COLLECTION)
              .doc(watcherAddressAdmissionDocId(watcherTarget))),
            txn.get(params.db.collection(INBOUND_WATCHER_CHECKPOINT_COLLECTION)
              .doc(String(registrationFence.chain_id))),
          ]);
          try {
            const admission = parseWatcherAddressAdmission(
              admissionSnap.exists
                ? admissionSnap.data() as Record<string, unknown> | undefined
                : undefined,
            );
            const checkpoint = parseWatcherCheckpointDocument(
              checkpointSnap.exists
                ? checkpointSnap.data() as Record<string, unknown> | undefined
                : undefined,
              registrationFence.chain_id,
            );
            if (admission.schema_version !== 'pvt-watcher-address-admission/v3'
              || admission.generation_fenced_at_registration !== true
              || admission.direction !== watcherTarget.direction
              || admission.chain_id !== watcherTarget.chainId
              || admission.address !== marker.address.toLowerCase()
              || admission.wallet_id !== marker.wallet_id
              || admission.agent_id !== marker.user_id
              || admission.eligibility_start_block !== watcherTarget.eligibilityStartBlock
              || admission.created_at_ms !== marker.created_at_ms
              || admission.membership_generation > checkpoint.membershipGeneration
              || checkpoint.updatedAtMs < marker.created_at_ms) {
              throw new Error('binding');
            }
          } catch {
            throw new GenesisIngressError('human_wallet_watcher_registration_invalid');
          }
          if (marker.public_key_sha256 !== sha256(params.publicKey)) {
            throw new GenesisIngressError('human_wallet_registration_pe_invalid');
          }
          const existingPE = rebuildHumanRegistrationPE(marker, params.publicKey);
          throw new ExistingHumanWalletRegistration(
            marker,
            existingWallet,
            existingPE.pe,
            existingPE.meter,
          );
        }
        if (humanWalletsSnap.size !== 0) {
          throw new GenesisIngressError('human_wallet_uniqueness_conflict');
        }
        /**
         * Has this ADDRESS already sealed its one human-signup grant? Reads the marker; with no
         * marker, runs the unbounded action-type-filtered queries over the outbox and retention
         * (a pre-marker grant) and schedules the marker's materialization. A found grant nulls
         * this wallet's qualification. Memoized per attempt so both call sites read once.
         */
        let signupGrantRead: boolean | null = null;
        const readAddressSignupGrant = async (): Promise<boolean> => {
          if (signupGrantRead !== null) return signupGrantRead;
          const markerSnap = await txn.get(signupMarkerRef);
          let granted = markerSnap.exists;
          if (!granted) {
            const [priorOutbox, priorRetained] = await Promise.all([
              txn.get(params.db.collection(GENESIS_QUALIFICATION_COLLECTION)
                .where('actor_address', '==', addressLc)
                .where('action_type', '==', 'genesis_human_signup')),
              txn.get(params.db.collection(GENESIS_QUALIFICATION_RETENTION_COLLECTION)
                .where('qualification.actor_address', '==', addressLc)
                .where('qualification.action_type', '==', 'genesis_human_signup')),
            ]);
            const prior = priorOutbox.docs[0] ?? priorRetained.docs[0] ?? null;
            if (prior !== null) {
              granted = true;
              legacySignupMarker = {
                schema_version: 'genesis-human-signup-by-address/v1',
                address: addressLc,
                qualification_doc_id: prior.id,
                source: priorOutbox.docs.length > 0 ? 'derived_from_outbox' : 'derived_from_retention',
                created_at_ms: params.createdAtMs,
              };
            }
          }
          if (granted) genesisForThisWallet = null;
          signupGrantRead = granted;
          return granted;
        };
        // a NEW registration binds an address only with proof its caller controls it.
        const addressProof = params.addressProof ?? null;
        if (addressProof === null) {
          throw new GenesisIngressError('human_wallet_address_proof_required');
        }
        if (addressProof.user_id !== params.userId || addressProof.signer !== addressLc) {
          throw new GenesisIngressError('human_wallet_address_proof_invalid');
        }
        const proofSnap = await txn.get(params.db.collection(HUMAN_WALLET_ADDRESS_PROOF_COLLECTION)
          .doc(addressProof.digest));
        if (proofSnap.exists) {
          throw new GenesisIngressError('human_wallet_address_proof_replayed');
        }
        if (agentAddressSnap.size !== 0 || agentProvenSnap.exists || personProvenSnap.exists) {
          throw new GenesisIngressError('human_wallet_address_in_use');
        }
        if (addressIndexSnap.exists) {
          // The address is registered. The proof holder may displace it only when that
          // registration is another account's and was never proven (or was released/orphaned).
          const addressIndex = record(addressIndexSnap.data());
          const displacedWalletId = typeof addressIndex?.wallet_id === 'string' ? addressIndex.wallet_id : null;
          const displacedUserId = typeof addressIndex?.owner_id === 'string' ? addressIndex.owner_id : null;
          if (displacedWalletId === null || displacedUserId === null
            || !CANONICAL_IDENTIFIER.test(displacedWalletId) || !CANONICAL_IDENTIFIER.test(displacedUserId)) {
            throw new GenesisIngressError('human_wallet_address_in_use');
          }
          const ownerUsersRef = params.db.collection('users').doc(displacedUserId);
          const [displacedWalletSnap, ownerUserSnap] = await Promise.all([
            txn.get(params.db.collection('wallets').doc(displacedWalletId)),
            txn.get(ownerUsersRef),
          ]);
          if (!humanRegistrationDisplaceable({
            addressIndex,
            wallet: displacedWalletSnap.exists ? record(displacedWalletSnap.data()) : null,
            walletId: displacedWalletId,
            ownerUserExists: ownerUserSnap.exists,
            claimantUserId: params.userId,
            address: params.address,
          })) {
            throw new GenesisIngressError('human_wallet_address_in_use');
          }
          const genesisAlreadyGrantedForAddress = await readAddressSignupGrant();
          displacement = { displacedWalletId, displacedUserId, genesisAlreadyGrantedForAddress };
          displacedOwnerUsersRef = ownerUsersRef;
          clearDisplacedOwnerAddress = ownerUserSnap.exists
            && record(ownerUserSnap.data())?.wallet_address === addressLc;
        }
        // Once per ADDRESS, on EVERY creation path (not only displacement).
        if (displacement === null && await readAddressSignupGrant()) genesisForThisWallet = null;
        // Every OTHER wallets doc carrying this address must be a previously displaced one.
        for (const doc of walletAddressSnap.docs) {
          const current: HumanWalletDisplacement | null = displacement;
          if (current !== null && doc.id === current.displacedWalletId) continue;
          if (record(doc.data())?.displaced_at_ms === undefined) {
            throw new GenesisIngressError('human_wallet_address_in_use');
          }
        }
        if (proposedWalletSnap.exists || peSnap.exists || peKeySnap.exists) {
          throw new GenesisIngressError('human_wallet_registration_id_collision');
        }
        const qualification: GenesisQualificationDocument | null = genesisForThisWallet;
        if (qualification) {
          persistQualification = shouldPersistGenesisQualification(
            qualification.action_type,
            qualification.qualifying_act_evidence.qualifying_act_at_ms,
            activationSnap.exists ? activationSnap.data() : undefined,
            params.genesisActivationApprovalVerifier,
          );
          const outboxSnap = await txn.get(genesisQualificationRef(
            params.db,
            qualification.action_type,
            qualification.immutable_anchor.anchor_id,
          ));
          if (persistQualification && outboxSnap.exists) {
            throw new GenesisIngressError('human_wallet_genesis_outbox_collision');
          }
        } else {
          persistQualification = false;
        }
        const watcherTarget = {
          direction: 'inbound' as const,
          chainId: registrationFence.chain_id,
          address: params.address,
          walletId: params.walletId,
          agentId: params.userId,
          eligibilityStartBlock: registrationFence.eligibility_start_block,
        };
        const displacedForWatcher: HumanWalletDisplacement | null = displacement;
        watcherRegistrationPlan = displacedForWatcher === null
          ? await prepareNativeWalletWatcherRegistration(params.db, txn, watcherTarget, params.createdAtMs)
          : await prepareNativeWalletWatcherRebind(
            params.db,
            txn,
            watcherTarget,
            { walletId: displacedForWatcher.displacedWalletId, agentId: displacedForWatcher.displacedUserId },
            params.createdAtMs,
          );
      },
      atomicCoWrite: (txn, context) => {
        if (!watcherRegistrationPlan) {
          throw new GenesisIngressError('human_wallet_watcher_registration_plan_missing');
        }
        const proof = params.addressProof ?? null;
        if (proof === null) {
          throw new GenesisIngressError('human_wallet_address_proof_required');
        }
        txn.create(walletRef, { ...params.walletDocument, network_class: 'external', address_proven_at_ms: params.createdAtMs });
        // Single-use: the proof's digest is consumed in the SAME transaction that binds.
        txn.create(params.db.collection(HUMAN_WALLET_ADDRESS_PROOF_COLLECTION).doc(proof.digest), {
          schema_version: 'human-wallet-address-proof/v1',
          digest: proof.digest,
          address: addressLc,
          user_id: params.userId,
          device_id: proof.device_id,
          wallet_id: params.walletId,
          signed_at_ms: proof.signed_at_ms,
          consumed_at_ms: params.createdAtMs,
        });
        const displaced: HumanWalletDisplacement | null = displacement;
        if (displaced !== null) {
          txn.update(params.db.collection('wallets').doc(displaced.displacedWalletId), {
            displaced_at_ms: params.createdAtMs,
            displaced_by_user_id: params.userId,
            displaced_by_wallet_id: params.walletId,
          });
          const ownerRef: DocumentReference | null = displacedOwnerUsersRef;
          if (clearDisplacedOwnerAddress && ownerRef !== null) {
            txn.update(ownerRef, {
              wallet_address: null,
              wallet_address_displaced_at_ms: params.createdAtMs,
            });
          }
        }
        const writtenGenesis: GenesisQualificationDocument | null = genesisForThisWallet;
        const marker: HumanRegistrationMarker = {
          schema_version: 'human-wallet-registration/v2',
          user_id: params.userId,
          request_fingerprint: params.requestFingerprint,
          wallet_id: params.walletId,
          pe_id: params.peId,
          pe_hash: context.peHash,
          prev_hash: context.prevHash,
          address: params.address,
          public_key_sha256: sha256(params.publicKey),
          economic_device_id: params.economicDeviceId,
          created_at_ms: params.createdAtMs,
          genesis_qualification_id:
            writtenGenesis && persistQualification
              ? writtenGenesis.qualification_id
              : null,
          standard_accrual_status: 'pending',
          standard_accrual_acknowledged_at_ms: null,
        };
        txn.create(indexRef, marker);
        const addressIndexDocument = {
          schema_version: 'native-wallet-address-index/v1',
          chain_id: registrationFence.chain_id,
          address: params.address.toLowerCase(),
          wallet_id: params.walletId,
          owner_type: 'human',
          owner_id: params.userId,
          created_at_ms: params.createdAtMs,
        };
        // A displacement RE-POINTS the address's one index row; otherwise it is created.
        if (displaced === null) txn.create(addressIndexRef, addressIndexDocument);
        else txn.set(addressIndexRef, addressIndexDocument);
        writeNativeWalletWatcherRegistration(
          txn,
          watcherRegistrationPlan,
          params.createdAtMs,
        );
        const materialize: Record<string, unknown> | null = legacySignupMarker;
        if (materialize !== null) txn.create(signupMarkerRef, materialize);
        if (writtenGenesis) {
          if (writtenGenesis.action_type === 'genesis_human_signup') {
            // Sealed with the grant: the address's ONE human-signup grant (outbox or retained).
            txn.create(signupMarkerRef, {
              schema_version: 'genesis-human-signup-by-address/v1',
              address: addressLc,
              qualification_doc_id: writtenGenesis.qualification_id,
              wallet_id: params.walletId,
              user_id: params.userId,
              source: persistQualification ? 'sealed_outbox' : 'sealed_retention',
              created_at_ms: params.createdAtMs,
            });
          }
          if (persistQualification) {
            writeGenesisQualification(txn, params.db, writtenGenesis);
          } else {
            // In-window act the persist gate refused: retain it durably (with its
            // original qualifying timestamp) rather than drop it. Never the outbox.
            writeRetainedGenesisQualification(
              txn,
              params.db,
              writtenGenesis,
              params.createdAtMs,
            );
          }
        }
      },
    });
    const committedGenesis: GenesisQualificationDocument | null = genesisForThisWallet;
    return {
      created: true,
      displacement,
      marker: {
        schema_version: 'human-wallet-registration/v2',
        user_id: params.userId,
        request_fingerprint: params.requestFingerprint,
        wallet_id: params.walletId,
        pe_id: params.peId,
        pe_hash: advanced.peHash,
        prev_hash: advanced.prevHash,
        address: params.address,
        public_key_sha256: sha256(params.publicKey),
        economic_device_id: params.economicDeviceId,
        created_at_ms: params.createdAtMs,
        genesis_qualification_id:
          committedGenesis && persistQualification
            ? committedGenesis.qualification_id
            : null,
        standard_accrual_status: 'pending',
        standard_accrual_acknowledged_at_ms: null,
      },
      walletDocument: { ...params.walletDocument, address_proven_at_ms: params.createdAtMs },
      peDocument: {
        ...relayPeOf({
          peId: params.peId,
          actorId: params.userId,
          prevHash: advanced.prevHash,
          timestamp: params.createdAtMs,
          actionType: 'wallet_created',
          content: humanRegistrationPeContent({
            walletId: params.walletId, userId: params.userId, address: params.address, publicKey: params.publicKey,
          }),
        }),
      },
      peMetered: true,
      intake: advanced.intake,
      genesisDisposition: committedGenesis === null
        ? 'not_qualified'
        : persistQualification ? 'persisted' : 'retained',
    };
  } catch (error) {
    if (error instanceof ExistingHumanWalletRegistration) {
      return {
        created: false,
        displacement: null,
        marker: error.marker,
        walletDocument: error.walletDocument,
        peDocument: error.peDocument,
        peMetered: error.peMetered,
        intake: null,
        genesisDisposition: await deriveGenesisDisposition(
          params.db,
          'genesis_human_signup',
          error.marker.wallet_id,
        ),
      };
    }
    throw error;
  }
}

/**
 * Seal the route-level acknowledgement that the original wallet_created PE's
 * durable economic effects completed. If this acknowledgement itself fails,
 * the caller returns a retryable response; replaying recordPEAccrual is safe.
 */
export async function acknowledgeHumanWalletStandardAccrual(params: {
  readonly db: Firestore;
  readonly userId: string;
  readonly peId: string;
  readonly peHash: string;
  readonly acknowledgedAtMs: number;
}): Promise<HumanRegistrationMarker> {
  if (!safeTimestamp(params.acknowledgedAtMs)) {
    throw new GenesisIngressError('human_wallet_registration_ack_timestamp_invalid');
  }
  const indexRef = params.db.collection(HUMAN_WALLET_REGISTRATION_INDEX_COLLECTION)
    .doc(humanWalletRegistrationIndexId(params.userId));
  return params.db.runTransaction(async (txn) => {
    const snap = await txn.get(indexRef);
    const marker = parseHumanRegistrationMarker(snap.data());
    if (!snap.exists || marker === null
      || marker.user_id !== params.userId
      || marker.pe_id !== params.peId
      || marker.pe_hash !== params.peHash) {
      throw new GenesisIngressError('human_wallet_registration_ack_marker_invalid');
    }
    if (marker.standard_accrual_status === 'complete') {
      return marker as HumanRegistrationMarker;
    }
    if (marker.standard_accrual_status !== 'pending') {
      throw new GenesisIngressError('human_wallet_registration_ack_state_invalid');
    }
    if (params.acknowledgedAtMs < marker.created_at_ms) {
      throw new GenesisIngressError('human_wallet_registration_ack_timestamp_invalid');
    }
    const completed: HumanRegistrationMarker = {
      ...marker,
      standard_accrual_status: 'complete',
      standard_accrual_acknowledged_at_ms: params.acknowledgedAtMs,
    };
    txn.set(indexRef, completed);
    return completed;
  });
}

export interface DeviceRegistrationMarker {
  readonly schema_version: 'device-registration-request/v1';
  readonly request_id: string;
  readonly request_fingerprint: string;
  readonly owner_user_id: string;
  readonly owner_wallet_id: string;
  readonly owner_type: 'human' | 'agent';
  readonly device_id: string;
  readonly pe_id: string;
  readonly pe_hash: string;
  readonly prev_hash: string;
  readonly device_key_prefix: string;
  readonly created_at_ms: number;
  readonly genesis_qualification_id: string | null;
}

const DEVICE_REGISTRATION_MARKER_KEYS = Object.freeze([
  'schema_version',
  'request_id',
  'request_fingerprint',
  'owner_user_id',
  'owner_wallet_id',
  'owner_type',
  'device_id',
  'pe_id',
  'pe_hash',
  'prev_hash',
  'device_key_prefix',
  'created_at_ms',
  'genesis_qualification_id',
] as const);

function parseDeviceRegistrationMarker(value: unknown): DeviceRegistrationMarker | null {
  const marker = record(value);
  if (marker === null || !exactKeys(marker, DEVICE_REGISTRATION_MARKER_KEYS)
    || marker.schema_version !== 'device-registration-request/v1'
    || typeof marker.request_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(marker.request_id)
    || typeof marker.request_fingerprint !== 'string'
    || !SHA256_HEX.test(marker.request_fingerprint)
    || typeof marker.owner_user_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(marker.owner_user_id)
    || typeof marker.owner_wallet_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(marker.owner_wallet_id)
    || (marker.owner_type !== 'human' && marker.owner_type !== 'agent')
    || typeof marker.device_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(marker.device_id)
    || typeof marker.pe_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(marker.pe_id)
    || typeof marker.pe_hash !== 'string'
    || !SHA256_HEX.test(marker.pe_hash)
    || typeof marker.prev_hash !== 'string'
    || !PE_PREV_HASH.test(marker.prev_hash)
    || typeof marker.device_key_prefix !== 'string'
    || !CANONICAL_IDENTIFIER.test(marker.device_key_prefix)
    || !safeTimestamp(marker.created_at_ms)
    || (marker.genesis_qualification_id !== null
      && (typeof marker.genesis_qualification_id !== 'string'
        || !/^gq_[a-f0-9]{64}$/.test(marker.genesis_qualification_id)))) return null;
  return marker as unknown as DeviceRegistrationMarker;
}

/** PE METER: the device registration PE's content, determined by the marker and the device. */
export function deviceRegistrationPeContent(input: {
  readonly ownerWalletId: string;
  readonly ownerAddress: string;
  readonly ownerType: 'human' | 'agent';
  readonly deviceId: string;
  readonly deviceName: string;
  readonly deviceType: string;
  readonly platform: string;
  readonly attestationCapability: string;
}): Record<string, unknown> {
  return {
    wallet_id: input.ownerWalletId,
    actor_address: input.ownerAddress,
    attestation_type: 'software',
    metadata: {
      device_id: input.deviceId,
      device_name: input.deviceName,
      device_type: input.deviceType,
      platform: input.platform,
      attestation_capability: input.attestationCapability,
      owner_type: input.ownerType,
      attribution_model: 'device_owner',
    },
  };
}

/**
 * Rebuild a device registration's PE from its marker and device record (the relay keeps no
 * copy). A metered registration rebuilds its v2 PE, a pre-meter one its v1 content; either must
 * hash to the marker's pe hash, or the registration is refused.
 */
export function rebuildDeviceRegistrationPE(
  marker: DeviceRegistrationMarker,
  device: Record<string, unknown>,
): { readonly meter: boolean; readonly pe: Record<string, unknown> } {
  if (typeof device.owner_address !== 'string' || typeof device.device_name !== 'string'
    || typeof device.device_type !== 'string' || typeof device.platform !== 'string'
    || typeof device.attestation_capability !== 'string') {
    throw new GenesisIngressError('device_registration_pe_invalid');
  }
  const content = deviceRegistrationPeContent({
    ownerWalletId: marker.owner_wallet_id,
    ownerAddress: device.owner_address,
    ownerType: marker.owner_type,
    deviceId: marker.device_id,
    deviceName: device.device_name,
    deviceType: device.device_type,
    platform: device.platform,
    attestationCapability: device.attestation_capability,
  });
  const v2 = relayPeOf({
    peId: marker.pe_id,
    actorId: marker.owner_user_id,
    prevHash: marker.prev_hash,
    timestamp: marker.created_at_ms,
    actionType: 'device_register',
    content,
  });
  if (wirePeHashOf(v2) === marker.pe_hash) return { meter: true, pe: { ...v2 } };
  const legacy = {
    id: marker.pe_id,
    wallet_id: marker.owner_wallet_id,
    action_type: 'device_register',
    actor_address: device.owner_address,
    timestamp: marker.created_at_ms,
    prev_hash: marker.prev_hash,
    attestation_type: 'software',
    metadata: content.metadata,
  };
  if (sha256(stableStringify(legacy) || '') === marker.pe_hash) {
    return { meter: false, pe: { ...legacy, hash: marker.pe_hash, user_id: marker.owner_user_id } };
  }
  throw new GenesisIngressError('device_registration_pe_invalid');
}

export interface CommitDeviceRegistrationParams {
  readonly db: Firestore;
  readonly requestDocumentId: string;
  readonly registrationId: string;
  readonly requestFingerprint: string;
  readonly ownerId: string;
  readonly ownerWalletId: string;
  readonly ownerType: 'human' | 'agent';
  readonly deviceId: string;
  readonly deviceDocument: Record<string, unknown>;
  readonly deviceKeyPrefix: string;
  readonly peId: string;
  readonly createdAtMs: number;
  readonly maxActiveDevices: number;
  /** The v2 PE content (`deviceRegistrationPeContent`). */
  readonly peContent: Record<string, unknown>;
  /** The accrual of the `device_register` PE, from its committed hash. Pure. */
  readonly buildAccrual: (peHash: string) => RecordPEAccrualParams;
  readonly genesisQualification: GenesisQualificationDocument | null;
  /** Explicit test seam. Production always uses structured SSHSIG verification. */
  readonly genesisActivationApprovalVerifier?: GenesisActivationApprovalVerifier;
}

export type DeviceRegistrationCommitResult = {
  readonly created: boolean;
  readonly marker: DeviceRegistrationMarker;
  readonly deviceDocument: Record<string, unknown>;
  readonly peDocument: Record<string, unknown>;
  /** True when the PE is a metered v2 act (priced through its relay intake). */
  readonly peMetered: boolean;
  /** The staged relay intake, on the creation branch only. */
  readonly intake: RelayActIntake | null;
  readonly genesisDisposition: GenesisQualificationDisposition;
};

class ExistingDeviceRegistration extends Error {
  constructor(
    readonly marker: DeviceRegistrationMarker,
    readonly deviceDocument: Record<string, unknown>,
    readonly peDocument: Record<string, unknown>,
    readonly peMetered: boolean,
  ) {
    super('device_registration_already_exists');
  }
}

/**
 * Atomically enforce the active-device limit/idempotency and create the device,
 * credential index, required registration PE, chain tip, and optional Genesis
 * outbox. A retry returns the exact original device/PE marker and never creates
 * a second qualifying anchor.
 */
export async function commitDeviceRegistration(
  params: CommitDeviceRegistrationParams,
): Promise<DeviceRegistrationCommitResult> {
  const requestRef = params.db.collection(DEVICE_REGISTRATION_REQUEST_COLLECTION)
    .doc(params.requestDocumentId);
  const deviceRef = params.db.collection('devices').doc(params.deviceId);
  const keyRef = params.db.collection('device_key_index').doc(params.deviceKeyPrefix);
  // PE METER: a fresh PE id must be unused (no staged intake, no act key).
  const peRef = privateRetentionCollection(params.db, METER_RELAY_ACTS_COLLECTION).doc(params.peId);
  const peKeyRef = privateRetentionCollection(params.db, METER_ACT_KEYS_COLLECTION).doc(params.peId);
  const activationRef = params.db.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT);
  const activeDevicesQuery = params.db.collection('devices')
    .where('owner_user_id', '==', params.ownerId)
    .where('status', '==', 'active');
  let persistQualification = params.genesisQualification !== null;

  try {
    const advanced = await advanceRelayAct(params.db, {
      actorId: params.ownerId,
      walletId: params.ownerWalletId,
      ownerType: params.ownerType,
      peId: params.peId,
      timestamp: params.createdAtMs,
      actionType: 'device_register',
      content: params.peContent,
      accrual: params.buildAccrual,
      validateTimestampAgainstTip: true,
      atomicPrecondition: async (txn) => {
        persistQualification = params.genesisQualification !== null;
        const [requestSnap, deviceSnap, keySnap, peSnap, peKeySnap, activeSnap, activationSnap] =
          await Promise.all([
            txn.get(requestRef),
            txn.get(deviceRef),
            txn.get(keyRef),
            txn.get(peRef),
            txn.get(peKeyRef),
            txn.get(activeDevicesQuery),
            readGenesisActivation(params.db, txn),
        ]);
        if (requestSnap.exists) {
          const marker = parseDeviceRegistrationMarker(requestSnap.data());
          const stableIds = deterministicDeviceRegistrationIds(
            params.ownerId,
            params.registrationId,
          );
          if (marker === null
            || stableIds.requestDocumentId !== params.requestDocumentId
            || marker.request_id !== params.registrationId
            || marker.request_fingerprint !== params.requestFingerprint
            || marker.owner_user_id !== params.ownerId
            || marker.owner_wallet_id !== params.ownerWalletId
            || marker.owner_type !== params.ownerType
            || marker.device_id !== params.deviceId
            || marker.device_id !== stableIds.deviceId
            || marker.pe_id !== params.peId
            || marker.pe_id !== stableIds.peId
            || marker.device_key_prefix !== params.deviceKeyPrefix
          ) {
            throw new GenesisIngressError('device_registration_request_invalid');
          }
          const device = record(deviceSnap.data());
          const key = record(keySnap.data());
          if (!deviceSnap.exists || !keySnap.exists
            || device === null || key === null
            || device.device_id !== marker.device_id
            || device.owner_user_id !== marker.owner_user_id
            || device.owner_wallet_id !== marker.owner_wallet_id
            || device.owner_type !== marker.owner_type
            || typeof device.owner_address !== 'string'
            || !EVM_ADDRESS.test(device.owner_address)
            || typeof device.device_name !== 'string'
            || typeof device.device_type !== 'string'
            || typeof device.platform !== 'string'
            || (device.attestation_capability !== 'software'
              && device.attestation_capability !== 'hardware_tpm')
            || device.device_key_prefix !== marker.device_key_prefix
            || device.created_at !== marker.created_at_ms
            || !exactKeys(key, ['device_key_prefix', 'device_id', 'created_at'])
            || key.device_id !== marker.device_id
            || key.device_key_prefix !== marker.device_key_prefix
            || key.created_at !== marker.created_at_ms) {
            throw new GenesisIngressError('device_registration_required_record_missing');
          }
          const pe = rebuildDeviceRegistrationPE(marker, device);
          throw new ExistingDeviceRegistration(marker, device, pe.pe, pe.meter);
        }
        if (deviceSnap.exists || keySnap.exists || peSnap.exists || peKeySnap.exists) {
          throw new GenesisIngressError('device_registration_id_collision');
        }
        if (activeSnap.size >= params.maxActiveDevices) {
          throw new GenesisIngressError('device_limit_exceeded');
        }
        if (params.genesisQualification) {
          persistQualification = shouldPersistGenesisQualification(
            params.genesisQualification.action_type,
            params.genesisQualification.qualifying_act_evidence.qualifying_act_at_ms,
            activationSnap.exists ? activationSnap.data() : undefined,
            params.genesisActivationApprovalVerifier,
          );
          const outboxSnap = await txn.get(genesisQualificationRef(
            params.db,
            params.genesisQualification.action_type,
            params.genesisQualification.immutable_anchor.anchor_id,
          ));
          if (persistQualification && outboxSnap.exists) {
            throw new GenesisIngressError('device_genesis_outbox_collision');
          }
        }
      },
      atomicCoWrite: (txn, context) => {
        txn.create(deviceRef, params.deviceDocument);
        txn.create(keyRef, {
          device_key_prefix: params.deviceKeyPrefix,
          device_id: params.deviceId,
          created_at: params.createdAtMs,
        });
        const marker: DeviceRegistrationMarker = {
          schema_version: 'device-registration-request/v1',
          request_id: params.registrationId,
          request_fingerprint: params.requestFingerprint,
          owner_user_id: params.ownerId,
          owner_wallet_id: params.ownerWalletId,
          owner_type: params.ownerType,
          device_id: params.deviceId,
          pe_id: params.peId,
          pe_hash: context.peHash,
          prev_hash: context.prevHash,
          device_key_prefix: params.deviceKeyPrefix,
          created_at_ms: params.createdAtMs,
          genesis_qualification_id:
            params.genesisQualification && persistQualification
              ? params.genesisQualification.qualification_id
              : null,
        };
        txn.create(requestRef, marker);
        if (params.genesisQualification) {
          if (persistQualification) {
            writeGenesisQualification(txn, params.db, params.genesisQualification);
          } else {
            // In-window act the persist gate refused: retain it durably (with its
            // original qualifying timestamp) rather than drop it. Never the outbox.
            writeRetainedGenesisQualification(
              txn,
              params.db,
              params.genesisQualification,
              params.createdAtMs,
            );
          }
        }
      },
    });
    return {
      created: true,
      marker: {
        schema_version: 'device-registration-request/v1',
        request_id: params.registrationId,
        request_fingerprint: params.requestFingerprint,
        owner_user_id: params.ownerId,
        owner_wallet_id: params.ownerWalletId,
        owner_type: params.ownerType,
        device_id: params.deviceId,
        pe_id: params.peId,
        pe_hash: advanced.peHash,
        prev_hash: advanced.prevHash,
        device_key_prefix: params.deviceKeyPrefix,
        created_at_ms: params.createdAtMs,
        genesis_qualification_id:
          params.genesisQualification && persistQualification
            ? params.genesisQualification.qualification_id
            : null,
      },
      deviceDocument: params.deviceDocument,
      peDocument: {
        ...relayPeOf({
          peId: params.peId,
          actorId: params.ownerId,
          prevHash: advanced.prevHash,
          timestamp: params.createdAtMs,
          actionType: 'device_register',
          content: params.peContent,
        }),
      },
      peMetered: true,
      intake: advanced.intake,
      genesisDisposition: params.genesisQualification === null
        ? 'not_qualified'
        : persistQualification ? 'persisted' : 'retained',
    };
  } catch (error) {
    if (error instanceof ExistingDeviceRegistration) {
      return {
        created: false,
        marker: error.marker,
        deviceDocument: error.deviceDocument,
        peDocument: error.peDocument,
        peMetered: error.peMetered,
        intake: null,
        genesisDisposition: await deriveGenesisDisposition(
          params.db,
          'genesis_device_link',
          error.marker.device_id,
        ),
      };
    }
    throw error;
  }
}

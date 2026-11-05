import { privateRetentionCollection } from '../provenance/private-retention';
import stableStringify from 'json-stable-stringify';
import { IDENTITY_ACTS_COLLECTION, validateIdentityAct } from '../meter/identity-acts';
import { LEGACY_IDENTITY_PES_COLLECTION } from '../meter/meter-store';
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import type { AgentWalletDocument } from './types';
import {
  canonicalAgentPeHash,
  validateCanonicalAgentStoredPe,
  type CanonicalAgentStoredPe,
} from './canonical-agent-pe-chain';
import { ROTATION_HISTORY_SUBCOLLECTION } from './rotation-history-evidence';
import {
  AgentAddressLineageError,
  readAgentAddressLineagePes,
  resolveAgentAddressLineage,
} from './agent-address-lineage';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
} from '../pvt/native-wallet-registration';

export const AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION =
  // Keep the established collection so current v1 relationships remain
  // readable. New writes use the v2 integer-BPS document schema below.
  'agent_beneficiary_relationships_v1' as const;

declare const AGENT_BENEFICIARY_SHARE_BPS: unique symbol;
export type AgentBeneficiaryShareBps = number & {
  readonly [AGENT_BENEFICIARY_SHARE_BPS]: true;
};

export const DEFAULT_AGENT_BENEFICIARY_SHARE_BPS = 2_000 as AgentBeneficiaryShareBps;
export const MIN_AGENT_BENEFICIARY_SHARE_BPS = 500 as AgentBeneficiaryShareBps;
export const MAX_AGENT_BENEFICIARY_SHARE_BPS = 5_000 as AgentBeneficiaryShareBps;

export type AgentBeneficiaryShareInput =
  | { readonly bps: unknown; readonly legacyRatio?: never }
  | { readonly bps?: never; readonly legacyRatio: unknown };

/**
 * Return the one canonical beneficiary-share representation: exact integer
 * basis points. Fractions are rejected rather than rounded, so a sub-BPS
 * request can never acquire economic authority through floating-point
 * tolerance or reconstruction.
 */
export function canonicalAgentBeneficiaryShareBps(
  input: AgentBeneficiaryShareInput,
): AgentBeneficiaryShareBps | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  const hasBps = Object.prototype.hasOwnProperty.call(input, 'bps');
  const hasLegacyRatio = Object.prototype.hasOwnProperty.call(input, 'legacyRatio');
  if (keys.length !== 1 || hasBps === hasLegacyRatio) return null;

  let value: unknown;
  if (hasBps) {
    value = input.bps;
  } else {
    const ratio = input.legacyRatio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;

    // Parse the number's canonical decimal spelling. This deliberately avoids
    // ratio * 10_000, Math.round, and floating tolerances. Any non-zero digit
    // below one BPS is rejected. The approved ratio range (0.05-0.50) never
    // requires exponent notation in JavaScript's canonical number spelling.
    const match = /^(\d+)\.(\d+)$/.exec(String(ratio));
    if (!match) return null;
    const [, whole, fractional] = match;
    if (fractional.length > 4 && /[1-9]/.test(fractional.slice(4))) return null;
    const fourPlaces = `${fractional}0000`.slice(0, 4);
    const exactBps = (BigInt(whole) * 10_000n) + BigInt(fourPlaces);
    if (exactBps > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    value = Number(exactBps);
  }

  if (!Number.isSafeInteger(value)
    || (value as number) < MIN_AGENT_BENEFICIARY_SHARE_BPS
    || (value as number) > MAX_AGENT_BENEFICIARY_SHARE_BPS) return null;
  return value as AgentBeneficiaryShareBps;
}

export type BeneficiaryRelationshipState = 'linked' | 'unlinked';

export interface BeneficiaryRelationshipSnapshot {
  state: BeneficiaryRelationshipState;
  human_wallet_id: string | null;
  human_user_id: string | null;
  human_address: string | null;
  agent_share_bps: AgentBeneficiaryShareBps | null;
  parent_wallet_id: string | null;
  revision: number;
}

export interface AgentBeneficiaryRelationshipDocument
  extends BeneficiaryRelationshipSnapshot {
  /** v1 is normalized on read; new writes are always v2. */
  schema_version: 'agent-beneficiary-relationship/v1' | 'agent-beneficiary-relationship/v2';
  wallet_id: string;
  agent_id: string;
  source_action_type:
    | 'agent_wallet_created'
    | 'agent_linked_to_human'
    | 'agent_unlinked_from_human'
    | 'policy_updated';
  source_pe_id: string;
  source_pe_hash: string;
  created_at_ms: number;
  updated_at_ms: number;
}

interface SnapshotLike {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PE_ID = /^pe_[A-Za-z0-9_-]{1,240}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WALLET_ID = /^wallet_aw_[A-Za-z0-9-]{3,128}$/;
const SOURCE_ACTIONS = new Set([
  'agent_wallet_created',
  'agent_linked_to_human',
  'agent_unlinked_from_human',
  'policy_updated',
]);

export class BeneficiaryRelationshipIntegrityError extends Error {
  constructor(readonly reason: string) {
    super(`beneficiary_relationship_integrity:${reason}`);
    this.name = 'BeneficiaryRelationshipIntegrityError';
  }
}

function fail(reason: string): never {
  throw new BeneficiaryRelationshipIntegrityError(reason);
}

function walletRotationCount(wallet: Record<string, unknown> | AgentWalletDocument): number {
  const value = wallet.rotation_count ?? 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('rotation_history_bound_count');
  return value as number;
}

/**
 * Every address the wallet has held, birth through current. An unrotated wallet's lineage is its
 * current address. A ROTATED wallet's lineage is PROVEN from sealed history : the birth
 * address from the `agent_wallet_created` PE the registration index pins, and each rotation from
 * its own sealed `agent_key_rotated` PE (`resolveAgentAddressLineage`, the reader the watchers and
 * badges use). It never reads `chain_addresses` optional (absent when the creating SDK reported
 * none,) and agent-writable (the incident). The registration index and rotation
 * history are the caller's reads (in its transaction where it has one); the pinned PEs are sealed
 * and immutable, so they are point-read here. A lineage failure keeps its own reason.
 */
async function walletAddressLineage(params: {
  db: Firestore;
  wallet: Record<string, unknown> | AgentWalletDocument;
  registrationIndex: Record<string, unknown> | null;
  rawEntries: readonly (Record<string, unknown> | undefined)[];
}): Promise<ReadonlySet<string>> {
  const { db, wallet, rawEntries } = params;
  const currentAddress = typeof wallet.address === 'string'
    ? wallet.address.toLowerCase()
    : fail('wallet_identity');
  const rotationCount = walletRotationCount(wallet);
  if (rotationCount === 0) {
    if (rawEntries.length !== 0) fail('rotation_history_unexpected');
    return new Set([currentAddress]);
  }
  if (typeof wallet.id !== 'string' || typeof wallet.agent_id !== 'string') fail('wallet_identity');
  const registrationIndex = params.registrationIndex;
  if (registrationIndex === null || registrationIndex.wallet_id !== wallet.id) {
    fail('rotation_history_registration_index');
  }
  const now = Date.now();
  try {
    const identityPes = await readAgentAddressLineagePes(db, {
      agentId: wallet.agent_id as string,
      walletId: wallet.id as string,
      registrationIndex,
      rotationHistory: rawEntries,
      maxTimestampMs: now,
    });
    const lineage = resolveAgentAddressLineage({
      walletId: wallet.id as string,
      agentId: wallet.agent_id as string,
      wallet: wallet as Record<string, unknown>,
      registrationIndex,
      rotationHistory: rawEntries,
      identityPes,
      now,
    });
    return new Set(lineage.segments.map((segment) => segment.address));
  } catch (error) {
    if (error instanceof AgentAddressLineageError) fail(error.reason);
    throw error;
  }
}

function registrationIndexRef(db: Firestore, agentId: string): DocumentReference {
  return db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION).doc(nativeAgentRegistrationIndexId(agentId));
}

function exactKeys(raw: Record<string, unknown>, expected: readonly string[], reason: string): void {
  const actual = Object.keys(raw).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    fail(reason);
  }
}

export function beneficiaryRelationshipRef(
  db: Firestore,
  walletId: string,
): DocumentReference {
  return db.collection(AGENT_BENEFICIARY_RELATIONSHIP_COLLECTION).doc(walletId);
}

export function beneficiaryRelationshipSnapshot(params: {
  humanWalletId: string | null;
  humanUserId: string | null;
  humanAddress: string | null;
  agentShareBps: AgentBeneficiaryShareBps | null;
  parentWalletId: string | null;
  revision: number;
}): BeneficiaryRelationshipSnapshot {
  const linked = params.humanWalletId !== null;
  return {
    state: linked ? 'linked' : 'unlinked',
    human_wallet_id: params.humanWalletId,
    human_user_id: params.humanUserId,
    human_address: params.humanAddress?.toLowerCase() ?? null,
    agent_share_bps: params.agentShareBps,
    parent_wallet_id: params.parentWalletId,
    revision: params.revision,
  };
}

export function createBeneficiaryRelationshipDocument(params: {
  walletId: string;
  agentId: string;
  snapshot: BeneficiaryRelationshipSnapshot;
  sourceActionType: AgentBeneficiaryRelationshipDocument['source_action_type'];
  sourcePeId: string;
  sourcePeHash: string;
  createdAtMs: number;
  updatedAtMs: number;
}): AgentBeneficiaryRelationshipDocument {
  return {
    schema_version: 'agent-beneficiary-relationship/v2',
    wallet_id: params.walletId,
    agent_id: params.agentId,
    ...params.snapshot,
    source_action_type: params.sourceActionType,
    source_pe_id: params.sourcePeId,
    source_pe_hash: params.sourcePeHash,
    created_at_ms: params.createdAtMs,
    updated_at_ms: params.updatedAtMs,
  };
}

export function parseBeneficiaryRelationship(
  snapshot: SnapshotLike,
): AgentBeneficiaryRelationshipDocument {
  if (!snapshot.exists) fail('missing');
  const raw = snapshot.data();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('shape');
  const isLegacyV1 = raw.schema_version === 'agent-beneficiary-relationship/v1';
  const isCurrentV2 = raw.schema_version === 'agent-beneficiary-relationship/v2';
  if (!isLegacyV1 && !isCurrentV2) fail('fields');
  exactKeys(raw, [
    'schema_version', 'wallet_id', 'agent_id', 'state', 'human_wallet_id',
    'human_user_id', 'human_address',
    isLegacyV1 ? 'operational_reserve_ratio' : 'agent_share_bps',
    'parent_wallet_id', 'revision', 'source_action_type', 'source_pe_id',
    'source_pe_hash', 'created_at_ms', 'updated_at_ms',
  ], 'keys');
  if ((raw.schema_version !== 'agent-beneficiary-relationship/v1'
      && raw.schema_version !== 'agent-beneficiary-relationship/v2')
    || typeof raw.wallet_id !== 'string' || !WALLET_ID.test(raw.wallet_id)
    || typeof raw.agent_id !== 'string' || raw.agent_id.length === 0
    || (raw.state !== 'linked' && raw.state !== 'unlinked')
    || (raw.parent_wallet_id !== null
      && (typeof raw.parent_wallet_id !== 'string' || !WALLET_ID.test(raw.parent_wallet_id)))
    || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1
    || typeof raw.source_action_type !== 'string'
    || !SOURCE_ACTIONS.has(raw.source_action_type)
    || typeof raw.source_pe_id !== 'string' || !PE_ID.test(raw.source_pe_id)
    || typeof raw.source_pe_hash !== 'string' || !SHA256.test(raw.source_pe_hash)
    || !Number.isSafeInteger(raw.created_at_ms) || (raw.created_at_ms as number) < 0
    || !Number.isSafeInteger(raw.updated_at_ms)
    || (raw.updated_at_ms as number) < (raw.created_at_ms as number)) {
    fail('fields');
  }
  const linked = raw.state === 'linked';
  const agentShareBps = linked
    ? canonicalAgentBeneficiaryShareBps(isLegacyV1
      ? { legacyRatio: raw.operational_reserve_ratio }
      : { bps: raw.agent_share_bps })
    : null;
  if (linked) {
    if (typeof raw.human_wallet_id !== 'string' || raw.human_wallet_id.length === 0
      || typeof raw.human_user_id !== 'string' || raw.human_user_id.length === 0
      || typeof raw.human_address !== 'string' || !ADDRESS.test(raw.human_address)
      || agentShareBps === null) {
      fail('linked_fields');
    }
  } else if (raw.human_wallet_id !== null
    || raw.human_user_id !== null
    || raw.human_address !== null
    || (isLegacyV1 ? raw.operational_reserve_ratio : raw.agent_share_bps) !== null) {
    fail('unlinked_fields');
  }
  return {
    schema_version: raw.schema_version,
    wallet_id: raw.wallet_id,
    agent_id: raw.agent_id,
    state: raw.state,
    human_wallet_id: raw.human_wallet_id,
    human_user_id: raw.human_user_id,
    human_address: raw.human_address,
    agent_share_bps: agentShareBps,
    parent_wallet_id: raw.parent_wallet_id,
    revision: raw.revision,
    source_action_type: raw.source_action_type,
    source_pe_id: raw.source_pe_id,
    source_pe_hash: raw.source_pe_hash,
    created_at_ms: raw.created_at_ms,
    updated_at_ms: raw.updated_at_ms,
  } as AgentBeneficiaryRelationshipDocument;
}

export function validateBeneficiaryRelationship(params: {
  relationship: AgentBeneficiaryRelationshipDocument;
  wallet: Record<string, unknown> | AgentWalletDocument;
  sourcePe: Record<string, unknown>;
  humanWallet?: Record<string, unknown> | null;
  // The source PE was authored by an address the wallet held WHEN the
  // relationship was established. For an un-rotated wallet that is its current
  // address (the default); a rotated wallet passes its full address lineage so
  // a birth-established relationship still binds after the address rotated.
  sourceActorAddresses?: ReadonlySet<string>;
}): void {
  const { relationship, wallet, sourcePe } = params;
  const walletAddress = typeof wallet.address === 'string'
    ? wallet.address.toLowerCase()
    : null;
  const sourceActorAddresses = params.sourceActorAddresses
    ?? new Set(walletAddress === null ? [] : [walletAddress]);
  const walletHasCurrentBps = wallet.operational_reserve_bps !== undefined;
  const walletHasLegacyRatio = wallet.operational_reserve_ratio !== undefined;
  if (walletHasCurrentBps === walletHasLegacyRatio) fail('wallet_share_encoding');
  const walletShareValue = walletHasCurrentBps
    ? wallet.operational_reserve_bps
    : wallet.operational_reserve_ratio;
  const walletAgentShareBps = relationship.state === 'linked'
    ? canonicalAgentBeneficiaryShareBps(walletHasCurrentBps
      ? { bps: walletShareValue }
      : { legacyRatio: walletShareValue })
    : null;
  if (relationship.wallet_id !== wallet.id
    || relationship.agent_id !== wallet.agent_id
    || walletAddress === null || !ADDRESS.test(walletAddress)
    || (wallet.parent_wallet_id ?? null) !== relationship.parent_wallet_id
    || (wallet.linked_human_wallet_id ?? null) !== relationship.human_wallet_id
    || (wallet.linked_human_user_id ?? null) !== relationship.human_user_id
    || (typeof wallet.linked_human_address === 'string'
      ? wallet.linked_human_address.toLowerCase()
      : null) !== relationship.human_address
    || (relationship.state === 'linked'
      ? walletAgentShareBps !== relationship.agent_share_bps
      : walletShareValue !== null)) {
    fail('wallet_binding');
  }
  const metadata = sourcePe.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    fail('source_metadata_shape');
  }
  const relationshipMetadata = (metadata as Record<string, unknown>).beneficiary_relationship;
  if (!relationshipMetadata || typeof relationshipMetadata !== 'object'
    || Array.isArray(relationshipMetadata)) {
    fail('source_pe_binding');
  }
  const relationshipMetadataRecord = relationshipMetadata as Record<string, unknown>;
  const legacyMetadata = relationship.schema_version === 'agent-beneficiary-relationship/v1';
  const metadataShareKey = legacyMetadata ? 'operational_reserve_ratio' : 'agent_share_bps';
  exactKeys(relationshipMetadataRecord, [
    'state', 'human_wallet_id', 'human_user_id', 'human_address', metadataShareKey,
    'parent_wallet_id', 'revision',
  ], 'source_pe_binding');
  const metadataShareValue = relationshipMetadataRecord[metadataShareKey];
  const metadataAgentShareBps = relationship.state === 'linked'
    ? canonicalAgentBeneficiaryShareBps(legacyMetadata
      ? { legacyRatio: metadataShareValue }
      : { bps: metadataShareValue })
    : null;
  if (relationshipMetadataRecord.state !== relationship.state
    || relationshipMetadataRecord.human_wallet_id !== relationship.human_wallet_id
    || relationshipMetadataRecord.human_user_id !== relationship.human_user_id
    || relationshipMetadataRecord.human_address !== relationship.human_address
    || relationshipMetadataRecord.parent_wallet_id !== relationship.parent_wallet_id
    || relationshipMetadataRecord.revision !== relationship.revision
    || (relationship.state === 'linked'
      ? metadataAgentShareBps !== relationship.agent_share_bps
      : metadataShareValue !== null)
    || sourcePe.id !== relationship.source_pe_id
    || sourcePe.wallet_id !== relationship.wallet_id
    || sourcePe.agent_id !== relationship.agent_id
    || sourcePe.user_id !== relationship.agent_id
    || typeof sourcePe.actor_address !== 'string'
    || !sourceActorAddresses.has(sourcePe.actor_address.toLowerCase())
    || sourcePe.action_type !== relationship.source_action_type
    || sourcePe.hash !== relationship.source_pe_hash
    || sourcePe.timestamp !== relationship.updated_at_ms) {
    fail('source_pe_binding');
  }
  if (relationship.state === 'linked') {
    const human = params.humanWallet;
    if (!human
      || human.id !== relationship.human_wallet_id
      || human.type !== 'human'
      || human.user_id !== relationship.human_user_id
      || typeof human.address !== 'string'
      || human.address.toLowerCase() !== relationship.human_address) {
      fail('human_binding');
    }
  } else if (params.humanWallet !== undefined && params.humanWallet !== null) {
    fail('unexpected_human');
  }
}

/**
 * The relationship's source PE, validated against the relationship's pin (id + hash). PE METER:
 * a source written since the meter is an identity act (`identity_acts_v1`, kept as identity
 * state); a pre-meter source is still its envelope until the migration converts it.
 */
function validatedSourcePe(
  relationship: AgentBeneficiaryRelationshipDocument,
  identitySnap: { exists: boolean; data(): unknown },
  legacySnap: { exists: boolean; data(): unknown },
): CanonicalAgentStoredPe {
  if (identitySnap.exists) {
    try {
      return validateIdentityAct({
        raw: identitySnap.data() as Record<string, unknown>,
        peId: relationship.source_pe_id,
        peHash: relationship.source_pe_hash,
        actorId: relationship.agent_id,
        walletId: relationship.wallet_id,
      });
    } catch {
      fail('source_pe_binding');
    }
  }
  if (!legacySnap.exists) fail('source_pe_missing');
  return validateCanonicalAgentStoredPe({
    raw: legacySnap.data() as Record<string, unknown>,
    documentId: relationship.source_pe_id,
    agentId: relationship.agent_id,
    walletId: relationship.wallet_id,
  });
}

export async function readValidatedBeneficiaryRelationship(params: {
  db: Firestore;
  wallet: Record<string, unknown> | AgentWalletDocument;
}): Promise<AgentBeneficiaryRelationshipDocument> {
  const { db, wallet } = params;
  if (typeof wallet.id !== 'string') fail('wallet_identity');
  const relationship = parseBeneficiaryRelationship(
    await beneficiaryRelationshipRef(db, wallet.id).get(),
  );
  const humanRef = relationship.human_wallet_id
    ? db.collection('wallets').doc(relationship.human_wallet_id)
    : null;
  if (typeof wallet.agent_id !== 'string') fail('wallet_identity');
  const rotationCount = walletRotationCount(wallet);
  // PE METER : a bounded read. The relationship pins its source PE by id AND
  // hash, and the source PE is re-verified against that pin and its canonical hash — exactly the
  // standard the in-transaction reader below has always used. The whole-chain walk this replaced
  // read in proportion to the agent's history on every accrual, and the relay no longer keeps
  // agents' PE chains.
  const [identitySnap, sourcePeSnap, humanSnap, rotationSnap, indexSnap] = await Promise.all([
    privateRetentionCollection(db, IDENTITY_ACTS_COLLECTION).doc(relationship.source_pe_id).get(),
    privateRetentionCollection(db, LEGACY_IDENTITY_PES_COLLECTION).doc(relationship.source_pe_id).get(),
    humanRef ? humanRef.get() : Promise.resolve(null),
    rotationCount > 0
      ? db.collection('agent_wallets').doc(wallet.id)
        .collection(ROTATION_HISTORY_SUBCOLLECTION).get()
      : Promise.resolve(null),
    rotationCount > 0 ? registrationIndexRef(db, wallet.agent_id).get() : Promise.resolve(null),
  ]);
  const sourcePe = validatedSourcePe(relationship, identitySnap, sourcePeSnap);
  const sourceActorAddresses = await walletAddressLineage({
    db,
    wallet,
    registrationIndex: indexSnap?.exists ? indexSnap.data() as Record<string, unknown> : null,
    rawEntries: rotationSnap?.docs.map((doc) => doc.data() as Record<string, unknown>) ?? [],
  });
  validateBeneficiaryRelationship({
    relationship,
    wallet,
    sourceActorAddresses,
    sourcePe,
    humanWallet: humanSnap?.exists
      ? humanSnap.data() as Record<string, unknown>
      : relationship.state === 'linked' ? null : undefined,
  });
  return relationship;
}

/**
 * Identity acts that set or change a beneficiary relationship. A wallet whose history holds any
 * of them has (or had) a relationship, so a missing relationship document is a real integrity
 * failure for it, never "unlinked". A legacy `policy_updated` PE bears a relationship only when it
 * carries the `beneficiary_relationship` binding (a badge-policy update does not); a post-meter
 * identity act keeps no metadata, so any `policy_updated` act counts.
 */
const LINK_ACT_TYPES: ReadonlySet<string> = new Set([
  'agent_linked_to_human',
  'agent_unlinked_from_human',
  'agent_share_updated',
]);

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * True only when a wallet with NO relationship document is provably an unlinked agent born before
 * relationship documents existed (2026-10-07, ops follow-up: 13 `platform: 'test'` wallets created
 * 2026-07-08..07-22 have none, so every beneficiary read for them threw and their acts rested in
 * `pending_review` forever). Every condition is evidence the relay holds; any doubt answers false
 * and the caller keeps the integrity failure (Unknown = Block):
 *   - the wallet document carries no link, parent or share value and has never rotated;
 *   - its birth certificate (`agent_wallet_created`, the one legacy identity PE of that type for
 *     this agent) re-validates against its own hash, names this wallet and address, and carries no
 *     `beneficiary_relationship` binding — it was sealed before the relationship invariant;
 *   - no identity record of the agent (legacy identity PE or identity act) sets or changes a
 *     relationship.
 */
export async function isPreRelationshipUnlinkedWallet(params: {
  db: Firestore;
  wallet: Record<string, unknown>;
}): Promise<boolean> {
  const { db, wallet } = params;
  const walletId = wallet.id;
  const agentId = wallet.agent_id;
  const address = typeof wallet.address === 'string' ? wallet.address.toLowerCase() : null;
  if (typeof walletId !== 'string' || typeof agentId !== 'string' || agentId.length === 0
    || address === null || !ADDRESS.test(address)) return false;
  if (!isAbsent(wallet.linked_human_wallet_id) || !isAbsent(wallet.linked_human_user_id)
    || !isAbsent(wallet.linked_human_address) || !isAbsent(wallet.parent_wallet_id)
    || !isAbsent(wallet.operational_reserve_bps) || !isAbsent(wallet.operational_reserve_ratio)
    || !isAbsent(wallet.rotation_count) && wallet.rotation_count !== 0) return false;

  const [legacy, acts] = await Promise.all([
    privateRetentionCollection(db, LEGACY_IDENTITY_PES_COLLECTION).where('user_id', '==', agentId).get(),
    privateRetentionCollection(db, IDENTITY_ACTS_COLLECTION).where('actor_id', '==', agentId).get(),
  ]);
  for (const doc of acts.docs) {
    const actionType = (doc.data() as { act?: { action_type?: unknown } }).act?.action_type;
    if (typeof actionType !== 'string' || LINK_ACT_TYPES.has(actionType)
      || actionType === 'policy_updated') return false;
  }
  let births = 0;
  for (const doc of legacy.docs) {
    const raw = doc.data() as Record<string, unknown>;
    const metadata = raw.metadata;
    if (metadata !== null && typeof metadata === 'object'
      && Object.prototype.hasOwnProperty.call(metadata, 'beneficiary_relationship')) return false;
    if (typeof raw.action_type !== 'string' || LINK_ACT_TYPES.has(raw.action_type)) return false;
    if (raw.action_type !== 'agent_wallet_created') continue;
    births += 1;
    // The birth certificate predates today's stored-PE shape, so it is authenticated by its own
    // hash recipe (canonicalAgentPeHash reproduces every pre-meter agent PE byte-identically) and
    // its bindings, not by the current shape check.
    let hash: string;
    try {
      hash = canonicalAgentPeHash(raw);
    } catch {
      return false;
    }
    if (raw.id !== doc.id || raw.hash !== hash || raw.wallet_id !== walletId
      || raw.agent_id !== agentId || raw.user_id !== agentId
      || typeof raw.actor_address !== 'string' || raw.actor_address.toLowerCase() !== address) {
      return false;
    }
  }
  return births === 1;
}

export async function readValidatedBeneficiaryRelationshipInTransaction(params: {
  db: Firestore;
  txn: Transaction;
  wallet: Record<string, unknown> | AgentWalletDocument;
  expected?: AgentBeneficiaryRelationshipDocument;
}): Promise<AgentBeneficiaryRelationshipDocument> {
  const { db, txn, wallet } = params;
  if (typeof wallet.id !== 'string') fail('wallet_identity');
  const relationship = parseBeneficiaryRelationship(
    await txn.get(beneficiaryRelationshipRef(db, wallet.id)),
  );
  if (params.expected
    && stableStringify(relationship) !== stableStringify(params.expected)) {
    fail('changed');
  }
  const identityRef = privateRetentionCollection(db, IDENTITY_ACTS_COLLECTION).doc(relationship.source_pe_id);
  const sourcePeRef = privateRetentionCollection(db, LEGACY_IDENTITY_PES_COLLECTION).doc(relationship.source_pe_id);
  const humanRef = relationship.human_wallet_id
    ? db.collection('wallets').doc(relationship.human_wallet_id)
    : null;
  const rotationCount = walletRotationCount(wallet);
  const rotationQuery = rotationCount > 0
    ? db.collection('agent_wallets').doc(wallet.id).collection(ROTATION_HISTORY_SUBCOLLECTION)
    : null;
  // An unrotated wallet reads exactly what it always did; only a rotated one reads its index.
  const indexRef = rotationCount > 0 && typeof wallet.agent_id === 'string'
    ? registrationIndexRef(db, wallet.agent_id)
    : null;
  const [identitySnap, sourcePeSnap, humanSnap, rotationSnap, indexSnap] = await Promise.all([
    txn.get(identityRef),
    txn.get(sourcePeRef),
    humanRef ? txn.get(humanRef) : Promise.resolve(null),
    rotationQuery ? txn.get(rotationQuery) : Promise.resolve(null),
    indexRef ? txn.get(indexRef) : Promise.resolve(null),
  ]);
  const sourcePe = validatedSourcePe(relationship, identitySnap, sourcePeSnap);
  const sourceActorAddresses = await walletAddressLineage({
    db,
    wallet,
    registrationIndex: indexSnap?.exists ? indexSnap.data() as Record<string, unknown> : null,
    rawEntries: rotationSnap?.docs.map((doc) => doc.data() as Record<string, unknown>) ?? [],
  });
  validateBeneficiaryRelationship({
    relationship,
    wallet,
    sourceActorAddresses,
    sourcePe,
    humanWallet: humanSnap?.exists
      ? humanSnap.data() as Record<string, unknown>
      : relationship.state === 'linked' ? null : undefined,
  });
  return relationship;
}

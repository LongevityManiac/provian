/** Exact, idempotent Genesis epoch-budget pacing for the daily worker. */

import crypto from 'crypto';
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Transaction,
} from 'firebase-admin/firestore';

import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './policy/proposed-genesis-policy';
import {
  GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256,
} from './policy/genesis-settlement-approval-manifest';
import {
  approvalManifestSha256,
  resolveApprovalManifestBytesByHash,
  resolveVerifiedPvtManifestApprovalBytesByHash,
} from './policy/current-approval';
import type { SshApprovalSignature } from './policy/approval-signature';
import { isRejectedPvtApprovalManifestSha256 } from './policy/rejected-approval-manifests';
import {
  GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE,
  GENESIS_SETTLEMENT_CAMPAIGN_ID,
  GENESIS_SETTLEMENT_CHAIN_ID,
  GENESIS_SETTLEMENT_KERNEL_ID,
  assertGenesisSettlementAuthorizationMatchesEvent,
  parseGenesisSettlementAuthorizationManifest,
} from './policy/genesis-settlement-authorization';

export const GENESIS_SETTLEMENT_EPOCH_COLLECTION = 'genesis_settlement_epochs_v2';
export const GENESIS_SETTLEMENT_RESERVATION_COLLECTION = 'genesis_settlement_reservations_v2';
export const GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION =
  'genesis_settlement_policy_events_v2';
export const INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC =
  PROPOSED_GENESIS_CAMPAIGN_POLICY.settlement.initial_genesis_sub_budget_atomic;

export interface GenesisSettlementBudgetPolicyEvent {
  readonly schema_version: 'pvt-genesis-settlement-policy-event/v2';
  readonly event_id: string;
  readonly policy_version: string;
  /** Contract epoch observed when the signed event was authorized. */
  readonly authorized_at_epoch: number;
  readonly effective_epoch: number;
  readonly cap_atomic: string;
  readonly approval_status: 'approved_by_frank';
  readonly approval_manifest_sha256: string;
  readonly approval_signature: SshApprovalSignature;
  readonly approval_audit_id: string;
  readonly authorization_scope: typeof GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE;
  readonly chain_id: typeof GENESIS_SETTLEMENT_CHAIN_ID;
  readonly campaign_id: typeof GENESIS_SETTLEMENT_CAMPAIGN_ID;
  readonly settlement_kernel_id: typeof GENESIS_SETTLEMENT_KERNEL_ID;
  readonly automation_generated: false;
  readonly previous_event_hash: string | null;
  readonly evented_at_ms: number;
  readonly evented_by: string;
  readonly event_hash: string;
}

export interface GenesisSettlementEpochDocument {
  readonly schema_version: 'pvt-genesis-settlement-epoch/v2';
  readonly epoch: number;
  readonly cap_atomic: string;
  readonly policy_event_id: string;
  readonly policy_event_hash: string;
  readonly approval_manifest_sha256: string;
  readonly reserved_atomic: string;
  readonly committed_atomic: string;
  readonly revision: number;
  readonly updated_at_ms: number;
}

export interface GenesisSettlementReservationBinding {
  readonly claimId: string;
  readonly batchId: string;
  readonly leaseOwnerId: string;
  readonly fencingToken: number;
}

export interface GenesisSettlementReservationDocument {
  readonly schema_version: 'pvt-genesis-settlement-reservation/v2';
  readonly reservation_id: string;
  readonly epoch: number;
  readonly policy_event_id: string;
  readonly policy_event_hash: string;
  readonly requested_atomic: string;
  readonly reserved_atomic: string;
  readonly claim_id: string;
  readonly batch_id: string;
  readonly lease_owner_id: string;
  readonly fencing_token: number;
  readonly state: 'pending' | 'committed' | 'released';
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const BYTES32 = /^0x[a-fA-F0-9]{64}$/;

const POLICY_EVENT_KEYS = Object.freeze([
  'schema_version',
  'event_id',
  'policy_version',
  'authorized_at_epoch',
  'effective_epoch',
  'cap_atomic',
  'approval_status',
  'approval_manifest_sha256',
  'approval_signature',
  'approval_audit_id',
  'authorization_scope',
  'chain_id',
  'campaign_id',
  'settlement_kernel_id',
  'automation_generated',
  'previous_event_hash',
  'evented_at_ms',
  'evented_by',
  'event_hash',
] as const);

const EPOCH_KEYS = Object.freeze([
  'schema_version',
  'epoch',
  'cap_atomic',
  'policy_event_id',
  'policy_event_hash',
  'approval_manifest_sha256',
  'reserved_atomic',
  'committed_atomic',
  'revision',
  'updated_at_ms',
] as const);

const RESERVATION_KEYS = Object.freeze([
  'schema_version',
  'reservation_id',
  'epoch',
  'policy_event_id',
  'policy_event_hash',
  'requested_atomic',
  'reserved_atomic',
  'claim_id',
  'batch_id',
  'lease_owner_id',
  'fencing_token',
  'state',
  'created_at_ms',
  'updated_at_ms',
] as const);

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('non-canonical policy event number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('non-canonical policy event value');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function hashPolicyEventCore(core: Omit<GenesisSettlementBudgetPolicyEvent, 'event_hash'>): string {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(core), 'utf8').digest('hex')}`;
}

export function createGenesisSettlementBudgetPolicyEvent(
  input: Omit<GenesisSettlementBudgetPolicyEvent, 'schema_version' | 'event_hash'>,
): GenesisSettlementBudgetPolicyEvent {
  const core: Omit<GenesisSettlementBudgetPolicyEvent, 'event_hash'> = {
    schema_version: 'pvt-genesis-settlement-policy-event/v2',
    ...input,
  };
  const event = Object.freeze({ ...core, event_hash: hashPolicyEventCore(core) });
  if (!isPolicyEvent(event)) throw new Error('invalid Genesis settlement policy event');
  return event;
}

function isPolicyEvent(value: unknown): value is GenesisSettlementBudgetPolicyEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!hasExactKeys(value as Record<string, unknown>, POLICY_EVENT_KEYS)) return false;
  const event = value as GenesisSettlementBudgetPolicyEvent;
  if (event.schema_version !== 'pvt-genesis-settlement-policy-event/v2'
    || !IDENTIFIER.test(event.event_id)
    || !IDENTIFIER.test(event.policy_version)
    || !Number.isSafeInteger(event.authorized_at_epoch)
    || event.authorized_at_epoch < 0
    || !Number.isSafeInteger(event.effective_epoch)
    || event.effective_epoch < 0
    || !ATOMIC.test(event.cap_atomic)
    || BigInt(event.cap_atomic) <= 0n
    || event.approval_status !== 'approved_by_frank'
    || !SHA256.test(event.approval_manifest_sha256)
    || typeof event.approval_signature !== 'object'
    || event.approval_signature === null
    || Array.isArray(event.approval_signature)
    || !hasExactKeys(event.approval_signature as unknown as Record<string, unknown>, [
      'scheme',
      'signer_identity',
      'namespace',
      'public_key_sha256',
      'armored_signature',
    ])
    || event.approval_signature.scheme !== 'sshsig-ed25519'
    || event.approval_signature.signer_identity !== 'frank'
    || event.approval_signature.namespace !== 'provian-pvt-policy'
    || !SHA256.test(event.approval_signature.public_key_sha256)
    || event.approval_signature.armored_signature.length === 0
    || !IDENTIFIER.test(event.approval_audit_id)
    || event.authorization_scope !== GENESIS_SETTLEMENT_AUTHORIZATION_SCOPE
    || event.chain_id !== GENESIS_SETTLEMENT_CHAIN_ID
    || event.campaign_id !== GENESIS_SETTLEMENT_CAMPAIGN_ID
    || event.settlement_kernel_id !== GENESIS_SETTLEMENT_KERNEL_ID
    || event.automation_generated !== false
    || (event.previous_event_hash !== null && !SHA256.test(event.previous_event_hash))
    || !Number.isSafeInteger(event.evented_at_ms)
    || event.evented_at_ms < 0
    || !IDENTIFIER.test(event.evented_by)
    || !SHA256.test(event.event_hash)) return false;
  const { event_hash: _eventHash, ...core } = event;
  return hashPolicyEventCore(core) === event.event_hash;
}

export type GenesisSettlementApprovalVerifier = (
  approvalManifestSha256: string,
  signature: SshApprovalSignature,
) => Buffer | null | Promise<Buffer | null>;

export async function loadAuthorizedGenesisSettlementPolicyEvent(
  db: Firestore,
  epoch: number,
  approvalVerifier?: GenesisSettlementApprovalVerifier,
): Promise<GenesisSettlementBudgetPolicyEvent> {
  const verifyApproval = approvalVerifier ?? (
    (manifestHash: string, signature: SshApprovalSignature) =>
      resolveVerifiedPvtManifestApprovalBytesByHash(
        manifestHash,
        signature,
        (hash) => resolveApprovalManifestBytesByHash(db, hash),
      )
  );
  const snapshot = await db.collection(GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION).get();
  const allEvents: GenesisSettlementBudgetPolicyEvent[] = [];
  for (const doc of snapshot.docs) {
    const data: unknown = doc.data();
    if (!isPolicyEvent(data) || data.event_id !== doc.id) {
      throw new Error('invalid Genesis settlement policy event document');
    }
    if (data.effective_epoch > epoch) continue;
    if (isRejectedPvtApprovalManifestSha256(data.approval_manifest_sha256)) {
      throw new Error('Genesis settlement policy names a rejected approval manifest');
    }
    const exactManifestBytes = await verifyApproval(
      data.approval_manifest_sha256,
      data.approval_signature,
    );
    if (!Buffer.isBuffer(exactManifestBytes)
      || approvalManifestSha256(exactManifestBytes) !== data.approval_manifest_sha256) {
      throw new Error('Genesis settlement policy approval signature is invalid');
    }
    const signedSubject = parseGenesisSettlementAuthorizationManifest(exactManifestBytes);
    assertGenesisSettlementAuthorizationMatchesEvent(signedSubject, data);
    allEvents.push(data);
  }
  const events = allEvents.sort((a, b) => a.effective_epoch - b.effective_epoch);
  if (events.length === 0) throw new Error('Genesis settlement policy is not authorized');

  let previous: GenesisSettlementBudgetPolicyEvent | null = null;
  for (const event of events) {
    if (previous === null) {
      if (event.effective_epoch !== 0
        || event.authorized_at_epoch !== 0
        || event.previous_event_hash !== null
        || event.cap_atomic !== INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC
        || event.policy_version !== PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version
        || event.approval_manifest_sha256 !== GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256) {
        throw new Error('Genesis initial settlement policy event does not match formal approval');
      }
    } else if (event.effective_epoch <= previous.effective_epoch
      || event.effective_epoch <= event.authorized_at_epoch
      || event.previous_event_hash !== previous.event_hash) {
      throw new Error('Genesis settlement policy event chain is invalid');
    }
    // DEFENCE IN DEPTH, AND CURRENTLY UNREACHABLE — stated plainly rather than left
    // to look load-bearing. `assertGenesisSettlementAuthorizationMatchesEvent` above
    // already compares the event against the manifest's EMBEDDED subject, which fixes
    // `cap_atomic` and `policy_version`, so an event naming the settlement manifest
    // with different economics is refused there and never arrives here. This block is
    // retained deliberately: it is the check that still holds if that embedded-subject
    // binding is ever loosened. It is NOT evidence that economics are locked — the
    // subject match is. Kept rather than deleted because removing a fail-closed check
    // on the money path to tidy away a dead branch is the wrong direction.
    if (event.approval_manifest_sha256 === GENESIS_SETTLEMENT_APPROVAL_MANIFEST_SHA256
      && (event.cap_atomic !== INITIAL_GENESIS_SETTLEMENT_CAP_ATOMIC
        || event.policy_version !== PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version)) {
      throw new Error('Current approval manifest cannot authorize different settlement economics');
    }
    previous = event;
  }
  return events[events.length - 1];
}

function parseAtomic(value: string, field: string): bigint {
  if (!ATOMIC.test(value)) throw new Error(`${field} must be canonical atomic units`);
  return BigInt(value);
}

function assertEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('epoch must be non-negative');
}

function assertReservationId(id: string): void {
  if (!/^gsb_[a-f0-9]{64}$/.test(id)) throw new Error('invalid Genesis settlement reservation id');
}

function emptyEpoch(
  epoch: number,
  now: number,
  policy: GenesisSettlementBudgetPolicyEvent,
): GenesisSettlementEpochDocument {
  return {
    schema_version: 'pvt-genesis-settlement-epoch/v2',
    epoch,
    cap_atomic: policy.cap_atomic,
    policy_event_id: policy.event_id,
    policy_event_hash: policy.event_hash,
    approval_manifest_sha256: policy.approval_manifest_sha256,
    reserved_atomic: '0',
    committed_atomic: '0',
    revision: 0,
    updated_at_ms: now,
  };
}

export function readGenesisSettlementEpoch(
  data: unknown,
  epoch: number,
  now: number,
  expectedPolicy?: GenesisSettlementBudgetPolicyEvent,
): GenesisSettlementEpochDocument {
  if (data === undefined) {
    if (!expectedPolicy) throw new Error('Genesis settlement epoch ledger is missing');
    return emptyEpoch(epoch, now, expectedPolicy);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)
    || !hasExactKeys(data as Record<string, unknown>, EPOCH_KEYS)) {
    throw new Error('invalid Genesis settlement epoch ledger');
  }
  const doc = data as Partial<GenesisSettlementEpochDocument>;
  if (doc.schema_version !== 'pvt-genesis-settlement-epoch/v2'
    || doc.epoch !== epoch
    || typeof doc.cap_atomic !== 'string'
    || !ATOMIC.test(doc.cap_atomic)
    || BigInt(doc.cap_atomic) <= 0n
    || typeof doc.policy_event_id !== 'string'
    || !IDENTIFIER.test(doc.policy_event_id)
    || typeof doc.policy_event_hash !== 'string'
    || !SHA256.test(doc.policy_event_hash)
    || typeof doc.approval_manifest_sha256 !== 'string'
    || !SHA256.test(doc.approval_manifest_sha256)
    || typeof doc.reserved_atomic !== 'string'
    || typeof doc.committed_atomic !== 'string'
    || !Number.isSafeInteger(doc.revision)
    || (doc.revision ?? -1) < 0
    || !Number.isSafeInteger(doc.updated_at_ms)
    || (doc.updated_at_ms ?? -1) < 0) {
    throw new Error('invalid Genesis settlement epoch ledger');
  }
  if (expectedPolicy
    && (doc.cap_atomic !== expectedPolicy.cap_atomic
      || doc.policy_event_id !== expectedPolicy.event_id
      || doc.policy_event_hash !== expectedPolicy.event_hash
      || doc.approval_manifest_sha256 !== expectedPolicy.approval_manifest_sha256)) {
    throw new Error('Genesis settlement epoch policy snapshot mismatch');
  }
  const reserved = parseAtomic(doc.reserved_atomic, 'reserved_atomic');
  const committed = parseAtomic(doc.committed_atomic, 'committed_atomic');
  const cap = BigInt(doc.cap_atomic);
  if (committed > reserved || reserved > cap) {
    throw new Error('Genesis settlement epoch ledger exceeds its cap');
  }
  return doc as GenesisSettlementEpochDocument;
}

export function readGenesisSettlementReservation(
  data: unknown,
  reservationId: string,
): GenesisSettlementReservationDocument {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('invalid Genesis settlement reservation ledger');
  }
  if (!hasExactKeys(data as Record<string, unknown>, RESERVATION_KEYS)) {
    throw new Error('invalid Genesis settlement reservation ledger');
  }
  const doc = data as Partial<GenesisSettlementReservationDocument>;
  if (doc.schema_version !== 'pvt-genesis-settlement-reservation/v2'
    || doc.reservation_id !== reservationId
    || !Number.isSafeInteger(doc.epoch)
    || (doc.epoch ?? -1) < 0
    || typeof doc.policy_event_id !== 'string'
    || !IDENTIFIER.test(doc.policy_event_id)
    || typeof doc.policy_event_hash !== 'string'
    || !SHA256.test(doc.policy_event_hash)
    || typeof doc.requested_atomic !== 'string'
    || !ATOMIC.test(doc.requested_atomic)
    || typeof doc.reserved_atomic !== 'string'
    || !ATOMIC.test(doc.reserved_atomic)
    || BigInt(doc.reserved_atomic) > BigInt(doc.requested_atomic)
    || typeof doc.claim_id !== 'string'
    || !BYTES32.test(doc.claim_id)
    || typeof doc.batch_id !== 'string'
    || !BYTES32.test(doc.batch_id)
    || typeof doc.lease_owner_id !== 'string'
    || !IDENTIFIER.test(doc.lease_owner_id)
    || !Number.isSafeInteger(doc.fencing_token)
    || (doc.fencing_token ?? 0) <= 0
    || !['pending', 'committed', 'released'].includes(doc.state ?? '')
    || (doc.state === 'released' && doc.reserved_atomic !== '0')
    || ((doc.state === 'pending' || doc.state === 'committed')
      && doc.reserved_atomic === '0')
    || !Number.isSafeInteger(doc.created_at_ms)
    || (doc.created_at_ms ?? -1) < 0
    || !Number.isSafeInteger(doc.updated_at_ms)
    || (doc.updated_at_ms ?? -1) < (doc.created_at_ms ?? 0)) {
    throw new Error('invalid Genesis settlement reservation ledger');
  }
  return doc as GenesisSettlementReservationDocument;
}

function assertEpochCoversReservation(
  epoch: GenesisSettlementEpochDocument,
  reservation: GenesisSettlementReservationDocument,
): void {
  const amount = BigInt(reservation.reserved_atomic);
  const reserved = BigInt(epoch.reserved_atomic);
  const committed = BigInt(epoch.committed_atomic);
  if ((reservation.state === 'pending' && reserved - committed < amount)
    || (reservation.state === 'committed' && committed < amount)) {
    throw new Error('Genesis settlement epoch does not cover its reservation');
  }
}

function assertBinding(binding: GenesisSettlementReservationBinding): void {
  if (!BYTES32.test(binding.claimId)
    || !BYTES32.test(binding.batchId)
    || !IDENTIFIER.test(binding.leaseOwnerId)
    || !Number.isSafeInteger(binding.fencingToken)
    || binding.fencingToken <= 0) {
    throw new Error('invalid Genesis settlement reservation ownership binding');
  }
}

export function assertGenesisSettlementReservationBinding(
  reservation: GenesisSettlementReservationDocument,
  binding: GenesisSettlementReservationBinding,
): void {
  assertBinding(binding);
  if (reservation.claim_id !== binding.claimId
    || reservation.batch_id !== binding.batchId
    || reservation.lease_owner_id !== binding.leaseOwnerId
    || reservation.fencing_token !== binding.fencingToken) {
    throw new Error('Genesis settlement reservation ownership mismatch');
  }
}

export interface GenesisSettlementReservationTransactionContext {
  readonly epoch: number;
  readonly policy: GenesisSettlementBudgetPolicyEvent;
  readonly policyRef: DocumentReference;
  readonly epochRef: DocumentReference;
  readonly reservationRef: DocumentReference;
}

export async function getGenesisSettlementReservationTransactionContext(
  db: Firestore,
  epoch: number,
  reservationId: string,
  approvalVerifier?: GenesisSettlementApprovalVerifier,
): Promise<GenesisSettlementReservationTransactionContext> {
  assertEpoch(epoch);
  assertReservationId(reservationId);
  const policy = await loadAuthorizedGenesisSettlementPolicyEvent(db, epoch, approvalVerifier);
  return {
    epoch,
    policy,
    policyRef: db.collection(GENESIS_SETTLEMENT_POLICY_EVENT_COLLECTION).doc(policy.event_id),
    epochRef: db.collection(GENESIS_SETTLEMENT_EPOCH_COLLECTION).doc(String(epoch)),
    reservationRef: db.collection(GENESIS_SETTLEMENT_RESERVATION_COLLECTION).doc(reservationId),
  };
}

export async function readGenesisSettlementBudgetAvailability(
  db: Firestore,
  params: {
    epoch: number;
    now?: number;
    approvalVerifier?: GenesisSettlementApprovalVerifier;
  },
): Promise<{ availableAtomic: string; policyEventHash: string }> {
  assertEpoch(params.epoch);
  const now = params.now ?? Date.now();
  const policy = await loadAuthorizedGenesisSettlementPolicyEvent(
    db,
    params.epoch,
    params.approvalVerifier,
  );
  const epochRef = db.collection(GENESIS_SETTLEMENT_EPOCH_COLLECTION).doc(String(params.epoch));
  const epochSnap = await epochRef.get();
  const epoch = readGenesisSettlementEpoch(epochSnap.data(), params.epoch, now, policy);
  return {
    availableAtomic: (BigInt(epoch.cap_atomic) - BigInt(epoch.reserved_atomic)).toString(),
    policyEventHash: policy.event_hash,
  };
}

export function stageGenesisSettlementReservation(
  txn: Transaction,
  params: {
    context: GenesisSettlementReservationTransactionContext;
    policySnapshot: DocumentSnapshot;
    epochSnapshot: DocumentSnapshot;
    reservationSnapshot: DocumentSnapshot;
    reservationId: string;
    requestedAtomic: string;
    binding: GenesisSettlementReservationBinding;
    now: number;
    requireExact: boolean;
    allowReleasedRebind: boolean;
    /** Required proof that a released tombstone is being rebound by the
     * currently active fenced mint worker, not an arbitrary helper caller. */
    releasedRebindLeaseSnapshot?: DocumentSnapshot;
  },
): { reservedAtomic: string; remainingAtomic: string; idempotent: boolean } {
  assertBinding(params.binding);
  const requested = parseAtomic(params.requestedAtomic, 'requestedAtomic');
  const transactionalPolicy: unknown = params.policySnapshot.data();
  if (!params.policySnapshot.exists
    || !isPolicyEvent(transactionalPolicy)
    || transactionalPolicy.event_hash !== params.context.policy.event_hash) {
    throw new Error('Genesis settlement policy changed during reservation');
  }
  const epoch = readGenesisSettlementEpoch(
    params.epochSnapshot.data(),
    params.context.epoch,
    params.now,
    params.context.policy,
  );
  if (params.reservationSnapshot.exists) {
    const existing = readGenesisSettlementReservation(
      params.reservationSnapshot.data(),
      params.reservationId,
    );
    if (existing.epoch !== epoch.epoch
      || existing.policy_event_id !== params.context.policy.event_id
      || existing.policy_event_hash !== params.context.policy.event_hash
      || existing.requested_atomic !== params.requestedAtomic) {
      throw new Error('Genesis settlement reservation id collision');
    }
    assertEpochCoversReservation(epoch, existing);
    if (existing.state === 'released') {
      if (!params.allowReleasedRebind) {
        assertGenesisSettlementReservationBinding(existing, params.binding);
      } else {
        const lease = params.releasedRebindLeaseSnapshot?.data();
        if (!params.releasedRebindLeaseSnapshot?.exists
          || typeof lease !== 'object'
          || lease === null
          || lease.schema_version !== 'pvt-mint-worker-lease/v1'
          || lease.owner_id !== params.binding.leaseOwnerId
          || lease.fencing_token !== params.binding.fencingToken
          || typeof lease.expires_at_ms !== 'number'
          || lease.expires_at_ms <= params.now
          || lease.released_at_ms !== null) {
          throw new Error('Released Genesis reservation rebind requires the active fenced lease');
        }
      }
      const remaining = BigInt(epoch.cap_atomic) - BigInt(epoch.reserved_atomic);
      if (params.requireExact && requested > remaining) {
        return { reservedAtomic: '0', remainingAtomic: remaining.toString(), idempotent: false };
      }
      const granted = requested < remaining ? requested : remaining;
      if (granted === 0n) {
        return { reservedAtomic: '0', remainingAtomic: remaining.toString(), idempotent: false };
      }
      txn.set(params.context.epochRef, {
        ...epoch,
        reserved_atomic: (BigInt(epoch.reserved_atomic) + granted).toString(),
        revision: epoch.revision + 1,
        updated_at_ms: params.now,
      });
      txn.set(params.context.reservationRef, {
        reserved_atomic: granted.toString(),
        claim_id: params.binding.claimId,
        batch_id: params.binding.batchId,
        lease_owner_id: params.binding.leaseOwnerId,
        fencing_token: params.binding.fencingToken,
        state: 'pending',
        updated_at_ms: params.now,
      }, { merge: true });
      return {
        reservedAtomic: granted.toString(),
        remainingAtomic: (remaining - granted).toString(),
        idempotent: false,
      };
    }
    assertGenesisSettlementReservationBinding(existing, params.binding);
    return {
      reservedAtomic: existing.reserved_atomic,
      remainingAtomic: (BigInt(epoch.cap_atomic) - BigInt(epoch.reserved_atomic)).toString(),
      idempotent: true,
    };
  }
  const remaining = BigInt(epoch.cap_atomic) - BigInt(epoch.reserved_atomic);
  if (params.requireExact && requested > remaining) {
    return { reservedAtomic: '0', remainingAtomic: remaining.toString(), idempotent: false };
  }
  const granted = requested < remaining ? requested : remaining;
  if (granted === 0n) {
    return { reservedAtomic: '0', remainingAtomic: remaining.toString(), idempotent: false };
  }
  txn.set(params.context.epochRef, {
    ...epoch,
    reserved_atomic: (BigInt(epoch.reserved_atomic) + granted).toString(),
    revision: epoch.revision + 1,
    updated_at_ms: params.now,
  });
  txn.set(params.context.reservationRef, {
    schema_version: 'pvt-genesis-settlement-reservation/v2',
    reservation_id: params.reservationId,
    epoch: epoch.epoch,
    policy_event_id: params.context.policy.event_id,
    policy_event_hash: params.context.policy.event_hash,
    requested_atomic: params.requestedAtomic,
    reserved_atomic: granted.toString(),
    claim_id: params.binding.claimId,
    batch_id: params.binding.batchId,
    lease_owner_id: params.binding.leaseOwnerId,
    fencing_token: params.binding.fencingToken,
    state: 'pending',
    created_at_ms: params.now,
    updated_at_ms: params.now,
  } satisfies GenesisSettlementReservationDocument);
  return {
    reservedAtomic: granted.toString(),
    remainingAtomic: (remaining - granted).toString(),
    idempotent: false,
  };
}

export function genesisSettlementReservationId(epoch: number, peIds: readonly string[]): string {
  assertEpoch(epoch);
  if (peIds.length === 0) throw new Error('Genesis settlement reservation needs at least one PE');
  const canonical = [...new Set(peIds)].sort();
  if (canonical.some((id) => !/^pe_[A-Za-z0-9_-]{1,240}$/.test(id))) {
    throw new Error('Genesis settlement reservation contains an invalid PE id');
  }
  return `gsb_${crypto.createHash('sha256')
    .update(`${epoch}\n${canonical.join('\n')}`, 'utf8')
    .digest('hex')}`;
}

export async function reserveGenesisSettlementBudget(
  db: Firestore,
  params: {
    epoch: number;
    reservationId: string;
    requestedAtomic: string;
    binding: GenesisSettlementReservationBinding;
    now?: number;
    approvalVerifier?: GenesisSettlementApprovalVerifier;
  },
): Promise<{ reservedAtomic: string; remainingAtomic: string; idempotent: boolean }> {
  assertEpoch(params.epoch);
  assertReservationId(params.reservationId);
  const now = params.now ?? Date.now();
  const context = await getGenesisSettlementReservationTransactionContext(
    db,
    params.epoch,
    params.reservationId,
    params.approvalVerifier,
  );
  return db.runTransaction(async (txn) => {
    const [policySnap, epochSnap, reservationSnap] = await Promise.all([
      txn.get(context.policyRef),
      txn.get(context.epochRef),
      txn.get(context.reservationRef),
    ]);
    return stageGenesisSettlementReservation(txn, {
      context,
      policySnapshot: policySnap,
      epochSnapshot: epochSnap,
      reservationSnapshot: reservationSnap,
      reservationId: params.reservationId,
      requestedAtomic: params.requestedAtomic,
      binding: params.binding,
      now,
      requireExact: false,
      allowReleasedRebind: false,
    });
  });
}

export async function resizeGenesisSettlementReservation(
  db: Firestore,
  params: {
    reservationId: string;
    targetAtomic: string;
    binding: GenesisSettlementReservationBinding;
    now?: number;
  },
): Promise<void> {
  assertReservationId(params.reservationId);
  const target = parseAtomic(params.targetAtomic, 'targetAtomic');
  const now = params.now ?? Date.now();
  const reservationRef = db.collection(GENESIS_SETTLEMENT_RESERVATION_COLLECTION)
    .doc(params.reservationId);
  await db.runTransaction(async (txn) => {
    const reservationSnap = await txn.get(reservationRef);
    if (!reservationSnap.exists) {
      if (target === 0n) return;
      throw new Error('Genesis settlement reservation is missing');
    }
    const reservation = readGenesisSettlementReservation(
      reservationSnap.data(),
      params.reservationId,
    );
    assertGenesisSettlementReservationBinding(reservation, params.binding);
    const epochRef = db.collection(GENESIS_SETTLEMENT_EPOCH_COLLECTION)
      .doc(String(reservation.epoch));
    const epochSnap = await txn.get(epochRef);
    const epoch = readGenesisSettlementEpoch(epochSnap.data(), reservation.epoch, now);
    if (reservation.policy_event_id !== epoch.policy_event_id
      || reservation.policy_event_hash !== epoch.policy_event_hash) {
      throw new Error('Genesis settlement reservation policy mismatch');
    }
    assertEpochCoversReservation(epoch, reservation);
    const current = parseAtomic(reservation.reserved_atomic, 'reservation.reserved_atomic');
    if (reservation.state === 'committed') {
      if (target !== current) throw new Error('committed Genesis settlement budget cannot be released');
      return;
    }
    if (target > current) throw new Error('Genesis settlement reservation can only shrink');
    if (target === current) return;
    const delta = current - target;
    const nextReserved = BigInt(epoch.reserved_atomic) - delta;
    if (nextReserved < BigInt(epoch.committed_atomic)) {
      throw new Error('Genesis settlement release would underflow committed budget');
    }
    txn.set(epochRef, {
      ...epoch,
      reserved_atomic: nextReserved.toString(),
      revision: epoch.revision + 1,
      updated_at_ms: now,
    });
    txn.set(reservationRef, {
      reserved_atomic: target.toString(),
      state: target === 0n ? 'released' : 'pending',
      updated_at_ms: now,
    }, { merge: true });
  });
}

export async function releaseGenesisSettlementReservation(
  db: Firestore,
  reservationId: string | null,
  binding: GenesisSettlementReservationBinding | null,
): Promise<void> {
  if (!reservationId) return;
  if (!binding) throw new Error('Genesis settlement reservation ownership is required');
  await resizeGenesisSettlementReservation(db, {
    reservationId,
    targetAtomic: '0',
    binding,
  });
}

export async function commitGenesisSettlementReservation(
  db: Firestore,
  reservationId: string | null,
  binding: GenesisSettlementReservationBinding | null,
  now = Date.now(),
): Promise<void> {
  if (!reservationId) return;
  if (!binding) throw new Error('Genesis settlement reservation ownership is required');
  assertReservationId(reservationId);
  const reservationRef = db.collection(GENESIS_SETTLEMENT_RESERVATION_COLLECTION)
    .doc(reservationId);
  await db.runTransaction(async (txn) => {
    const reservationSnap = await txn.get(reservationRef);
    if (!reservationSnap.exists) throw new Error('Genesis settlement reservation is missing');
    const reservation = readGenesisSettlementReservation(reservationSnap.data(), reservationId);
    assertGenesisSettlementReservationBinding(reservation, binding);
    const epochRef = db.collection(GENESIS_SETTLEMENT_EPOCH_COLLECTION)
      .doc(String(reservation.epoch));
    const epochSnap = await txn.get(epochRef);
    const epoch = readGenesisSettlementEpoch(epochSnap.data(), reservation.epoch, now);
    if (reservation.policy_event_id !== epoch.policy_event_id
      || reservation.policy_event_hash !== epoch.policy_event_hash) {
      throw new Error('Genesis settlement reservation policy mismatch');
    }
    assertEpochCoversReservation(epoch, reservation);
    if (reservation.state === 'committed') return;
    if (reservation.state !== 'pending') {
      throw new Error('released Genesis settlement reservation cannot commit');
    }
    const amount = BigInt(reservation.reserved_atomic);
    const nextCommitted = BigInt(epoch.committed_atomic) + amount;
    if (nextCommitted > BigInt(epoch.reserved_atomic)) {
      throw new Error('Genesis settlement commit exceeds reserved budget');
    }
    txn.set(epochRef, {
      ...epoch,
      committed_atomic: nextCommitted.toString(),
      revision: epoch.revision + 1,
      updated_at_ms: now,
    });
    txn.set(reservationRef, { state: 'committed', updated_at_ms: now }, { merge: true });
  });
}

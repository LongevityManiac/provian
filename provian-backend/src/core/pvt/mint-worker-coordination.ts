/**
 * The shared economic-mutation lease and the legacy mint-claim/capacity fence
 * the epoch keeper reads before it advances an epoch.
 *
 * What remains here after the retired PVTv8 mint worker (`minting-engine.ts`,
 * `pvt-minter-badge-projection.ts`) was deleted with the PE meter migration
 * (2026-10-03): exactly what `epoch-keeper.ts` imports and their dependencies —
 *
 * - the single Firestore worker lease (`acquire` / `renew` / `release` /
 * `assertMintWorkerLeaseCurrent`) the epoch keeper fences its transaction
 * state with;
 * - `listOutstandingMintBatchClaims` and `hasPendingMintEpochCapacity`, which
 * refuse an epoch advance while any legacy mint claim is outstanding or any
 * legacy epoch capacity is still reserved. Nothing writes those collections
 * any more; the read stays a fail-closed fence, and the claim parser keeps
 * the full persisted document schema (including its badge-projection
 * commitment field) so a legacy row is judged exactly as before.
 *
 * The claim/authorize/prepare/reconcile/anchor mint flow, the recovery cursor,
 * the integrity quarantine, and every `pe_history` write were deleted with the
 * engine. The PVT9 settlement runtime (`core/pvt/wp4/`) is the live mint path.
 */

import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import {
  assertBaseEconomicFinalityEvidence,
  type EconomicFinalityEvidence,
} from '../onchain/economic-finality';
import {
  assertPreparedEconomicTransaction,
  type PreparedEconomicTransaction,
} from '../onchain/prepared-economic-transaction';

export const MINT_WORKER_LEASE_COLLECTION = 'pvt_mint_worker_leases_v1';

export const MINT_WORKER_LEASE_ID = 'base_single_batch';

export const MINT_BATCH_CLAIM_COLLECTION = 'pvt_mint_claims_v1';

export const MINT_EPOCH_CAPACITY_COLLECTION = 'pvt_mint_epoch_capacity_v1';

export const MINT_BROADCAST_PROTOCOL_V1 = 'persist-prepared-before-broadcast/v1';

export const MAX_ATOMIC_MINT_CLAIM_PES = 480;

export const DEFAULT_MINT_WORKER_LEASE_TTL_MS = 15 * 60 * 1000;

const ATOMIC = /^(0|[1-9][0-9]*)$/;

const SIGNED_ATOMIC = /^(0|-?[1-9][0-9]*)$/;

const BYTES32 = /^0x[a-fA-F0-9]{64}$/;

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;

const MAX_FIRESTORE_DOCUMENT_ID_UTF8_BYTES = 1_500;

export class MintCoordinationError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'MintCoordinationError';
  }
}

export interface MintWorkerLease {
  readonly leaseId: typeof MINT_WORKER_LEASE_ID;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly acquiredAtMs: number;
  readonly renewedAtMs: number;
  readonly expiresAtMs: number;
}

interface MintWorkerLeaseDocument {
  readonly schema_version: 'pvt-mint-worker-lease/v1';
  readonly lease_id: typeof MINT_WORKER_LEASE_ID;
  readonly owner_id: string;
  readonly fencing_token: number;
  readonly acquired_at_ms: number;
  readonly renewed_at_ms: number;
  readonly expires_at_ms: number;
  readonly released_at_ms: number | null;
}

const MINT_WORKER_LEASE_DOCUMENT_KEYS = Object.freeze([
  'schema_version',
  'lease_id',
  'owner_id',
  'fencing_token',
  'acquired_at_ms',
  'renewed_at_ms',
  'expires_at_ms',
  'released_at_ms',
] as const);

export type MintBatchClaimState =
  | 'claimed'
  | 'submission_authorized'
  | 'confirmed'
  | 'finalized'
  | 'materialized'
  | 'released';

const OUTSTANDING_MINT_BATCH_CLAIM_STATES = Object.freeze([
  'claimed',
  'submission_authorized',
  'confirmed',
  'finalized',
] as const satisfies readonly MintBatchClaimState[]);

type OutstandingMintBatchClaimState =
  (typeof OUTSTANDING_MINT_BATCH_CLAIM_STATES)[number];

export interface MintBatchClaimDocument {
  readonly schema_version: 'pvt-mint-claim/v1';
  readonly claim_id: string;
  readonly batch_id: string;
  readonly lease_owner_id: string;
  readonly fencing_token: number;
  readonly epoch: number;
  readonly pe_ids: readonly string[];
  readonly combined_reserved_atomic: string;
  readonly genesis_reserved_atomic: string;
  readonly genesis_settlement_reservation_id: string | null;
  readonly economic_contract_address: string;
  readonly anchor_contract_address: string;
  readonly economic_state_snapshot_hash: string;
  readonly economic_state_block_number: number;
  readonly economic_state_block_hash: string;
  readonly economic_state_agreed_head_number: number;
  readonly economic_state_agreed_head_hash: string;
  readonly economic_state_confirmation_depth: number;
  readonly economic_state_operator_ids: readonly [string, string];
  readonly economic_factor_fingerprint: string;
  readonly badge_projection_input_commitment: string;
  readonly authorization_economic_state_snapshot_hash: string | null;
  readonly mint_broadcast_protocol: typeof MINT_BROADCAST_PROTOCOL_V1 | null;
  readonly mint_payload_hash: string | null;
  readonly anchor_payload_hash: string;
  readonly state: MintBatchClaimState;
  readonly submission_authorized_until_ms: number | null;
  readonly mint_tx_hash: string | null;
  readonly mint_prepared_transaction: PreparedEconomicTransaction | null;
  readonly anchor_tx_hash: string | null;
  readonly anchor_prepared_transaction: PreparedEconomicTransaction | null;
  readonly mint_finality: EconomicFinalityEvidence | null;
  readonly anchor_finality: EconomicFinalityEvidence | null;
  readonly anchor_event: MintAnchorEventEvidence | null;
  readonly actual_minted_atomic: string | null;
  /** actual minted minus reserved gross upper bound; normally zero or negative. */
  readonly reservation_delta_atomic: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

const MINT_CLAIM_DOCUMENT_KEYS = Object.freeze([
  'schema_version',
  'claim_id',
  'batch_id',
  'lease_owner_id',
  'fencing_token',
  'epoch',
  'pe_ids',
  'combined_reserved_atomic',
  'genesis_reserved_atomic',
  'genesis_settlement_reservation_id',
  'economic_contract_address',
  'anchor_contract_address',
  'economic_state_snapshot_hash',
  'economic_state_block_number',
  'economic_state_block_hash',
  'economic_state_agreed_head_number',
  'economic_state_agreed_head_hash',
  'economic_state_confirmation_depth',
  'economic_state_operator_ids',
  'economic_factor_fingerprint',
  'badge_projection_input_commitment',
  'authorization_economic_state_snapshot_hash',
  'mint_broadcast_protocol',
  'mint_payload_hash',
  'anchor_payload_hash',
  'state',
  'submission_authorized_until_ms',
  'mint_tx_hash',
  'mint_prepared_transaction',
  'anchor_tx_hash',
  'anchor_prepared_transaction',
  'mint_finality',
  'anchor_finality',
  'anchor_event',
  'actual_minted_atomic',
  'reservation_delta_atomic',
  'created_at_ms',
  'updated_at_ms',
] as const);

export interface MintAnchorEventEvidence {
  readonly schema_version: 'pvt-mint-anchor-event/v1';
  readonly batch_id: string;
  readonly merkle_root: string;
  readonly pe_count: number;
  readonly timestamp: number;
  readonly epoch_number: number;
}

const MINT_ANCHOR_EVENT_EVIDENCE_KEYS = Object.freeze([
  'schema_version',
  'batch_id',
  'merkle_root',
  'pe_count',
  'timestamp',
  'epoch_number',
] as const);

interface MintEpochCapacityDocument {
  readonly schema_version: 'pvt-mint-epoch-capacity/v1';
  readonly epoch: number;
  readonly threshold_atomic: string;
  readonly safety_bps: number;
  readonly last_observed_onchain_atomic: string;
  readonly pending_reserved_atomic: string;
  readonly committed_atomic: string;
  readonly last_observed_block_number: number;
  readonly last_observed_block_hash: string;
  readonly last_observed_snapshot_hash: string;
  readonly revision: number;
  readonly cap_breach_detected: boolean;
  readonly updated_at_ms: number;
}

const MINT_EPOCH_CAPACITY_DOCUMENT_KEYS = Object.freeze([
  'schema_version',
  'epoch',
  'threshold_atomic',
  'safety_bps',
  'last_observed_onchain_atomic',
  'pending_reserved_atomic',
  'committed_atomic',
  'last_observed_block_number',
  'last_observed_block_hash',
  'last_observed_snapshot_hash',
  'revision',
  'cap_breach_detected',
  'updated_at_ms',
] as const);

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new MintCoordinationError('invalid_time');
  }
}

function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new MintCoordinationError('invalid_lease_ttl');
  }
}

function checkedLeaseExpiry(now: number, ttlMs: number): number {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new MintCoordinationError('invalid_lease_expiry');
  }
  return expiresAt;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function assertOwnerId(ownerId: string): void {
  if (!OWNER_ID.test(ownerId)) throw new MintCoordinationError('invalid_lease_owner');
}

function readLease(data: unknown): MintWorkerLeaseDocument | null {
  if (data === undefined) return null;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new MintCoordinationError('invalid_worker_lease');
  }
  if (!hasExactKeys(
    data as Record<string, unknown>,
    MINT_WORKER_LEASE_DOCUMENT_KEYS,
  )) {
    throw new MintCoordinationError('invalid_worker_lease');
  }
  const doc = data as Partial<MintWorkerLeaseDocument>;
  if (doc.schema_version !== 'pvt-mint-worker-lease/v1'
    || doc.lease_id !== MINT_WORKER_LEASE_ID
    || typeof doc.owner_id !== 'string'
    || !OWNER_ID.test(doc.owner_id)
    || !Number.isSafeInteger(doc.fencing_token)
    || (doc.fencing_token ?? 0) <= 0
    || !Number.isSafeInteger(doc.acquired_at_ms)
    || (doc.acquired_at_ms ?? -1) < 0
    || !Number.isSafeInteger(doc.renewed_at_ms)
    || (doc.renewed_at_ms ?? -1) < (doc.acquired_at_ms ?? 0)
    || !Number.isSafeInteger(doc.expires_at_ms)
    || (doc.expires_at_ms ?? -1) < (doc.renewed_at_ms ?? 0)
    || (doc.released_at_ms !== null
      && (!Number.isSafeInteger(doc.released_at_ms)
        || (doc.released_at_ms ?? -1) < (doc.renewed_at_ms ?? 0)))
    || (doc.released_at_ms === null
      && (doc.expires_at_ms ?? 0) <= (doc.renewed_at_ms ?? 0))
    || (doc.released_at_ms !== null
      && (doc.expires_at_ms ?? Number.MAX_SAFE_INTEGER) > (doc.released_at_ms ?? -1))) {
    throw new MintCoordinationError('invalid_worker_lease');
  }
  return doc as MintWorkerLeaseDocument;
}

function leaseFromDocument(doc: MintWorkerLeaseDocument): MintWorkerLease {
  return Object.freeze({
    leaseId: MINT_WORKER_LEASE_ID,
    ownerId: doc.owner_id,
    fencingToken: doc.fencing_token,
    acquiredAtMs: doc.acquired_at_ms,
    renewedAtMs: doc.renewed_at_ms,
    expiresAtMs: doc.expires_at_ms,
  });
}

function assertLeaseMatches(
  data: unknown,
  lease: MintWorkerLease,
  now: number,
): MintWorkerLeaseDocument {
  const current = readLease(data);
  if (current === null
    || current.owner_id !== lease.ownerId
    || current.fencing_token !== lease.fencingToken
    || current.expires_at_ms <= now
    || current.released_at_ms !== null) {
    throw new MintCoordinationError('mint_worker_lease_lost');
  }
  return current;
}

/** Shared transaction helper for the epoch keeper's exact lease/fence checks. */
export function assertMintWorkerLeaseCurrent(
  data: unknown,
  lease: MintWorkerLease,
  now: number,
): void {
  assertNow(now);
  assertLeaseMatches(data, lease, now);
}

export async function acquireMintWorkerLease(
  db: Firestore,
  params: { ownerId: string; now?: number; ttlMs?: number },
): Promise<MintWorkerLease | null> {
  assertOwnerId(params.ownerId);
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_MINT_WORKER_LEASE_TTL_MS;
  assertNow(now);
  assertTtl(ttlMs);
  const expiresAt = checkedLeaseExpiry(now, ttlMs);
  const ref = db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const current = readLease(snap.data());
    if (current !== null
      && current.expires_at_ms > now
      && current.released_at_ms === null
      && current.owner_id !== params.ownerId) {
      return null;
    }
    if (current !== null
      && current.expires_at_ms > now
      && current.released_at_ms === null
      && current.owner_id === params.ownerId) {
      if (now < current.renewed_at_ms) {
        throw new MintCoordinationError('mint_worker_clock_regression');
      }
      const renewed: MintWorkerLeaseDocument = {
        ...current,
        renewed_at_ms: now,
        expires_at_ms: expiresAt,
      };
      txn.set(ref, renewed);
      return leaseFromDocument(renewed);
    }
    const nextFence = (current?.fencing_token ?? 0) + 1;
    if (!Number.isSafeInteger(nextFence)) {
      throw new MintCoordinationError('mint_worker_fencing_exhausted');
    }
    const created: MintWorkerLeaseDocument = {
      schema_version: 'pvt-mint-worker-lease/v1',
      lease_id: MINT_WORKER_LEASE_ID,
      owner_id: params.ownerId,
      fencing_token: nextFence,
      acquired_at_ms: now,
      renewed_at_ms: now,
      expires_at_ms: expiresAt,
      released_at_ms: null,
    };
    txn.set(ref, created);
    return leaseFromDocument(created);
  });
}

export async function renewMintWorkerLease(
  db: Firestore,
  lease: MintWorkerLease,
  params: { now?: number; ttlMs?: number } = {},
): Promise<MintWorkerLease> {
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_MINT_WORKER_LEASE_TTL_MS;
  assertNow(now);
  assertTtl(ttlMs);
  const expiresAt = checkedLeaseExpiry(now, ttlMs);
  const ref = db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const current = assertLeaseMatches(snap.data(), lease, now);
    if (now < current.renewed_at_ms) {
      throw new MintCoordinationError('mint_worker_clock_regression');
    }
    const renewed: MintWorkerLeaseDocument = {
      ...current,
      renewed_at_ms: now,
      expires_at_ms: expiresAt,
    };
    txn.set(ref, renewed);
    return leaseFromDocument(renewed);
  });
}

export async function releaseMintWorkerLease(
  db: Firestore,
  lease: MintWorkerLease,
  now = Date.now(),
): Promise<boolean> {
  assertNow(now);
  const ref = db.collection(MINT_WORKER_LEASE_COLLECTION).doc(MINT_WORKER_LEASE_ID);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const current = readLease(snap.data());
    if (current === null
      || current.owner_id !== lease.ownerId
      || current.fencing_token !== lease.fencingToken
      || current.released_at_ms !== null) {
      return false;
    }
    if (now < current.renewed_at_ms) {
      throw new MintCoordinationError('mint_worker_clock_regression');
    }
    txn.set(ref, {
      ...current,
      expires_at_ms: Math.min(current.expires_at_ms, now),
      released_at_ms: now,
    });
    return true;
  });
}

function hasExactMintClaimKeys(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, MINT_CLAIM_DOCUMENT_KEYS);
}

function assertMintClaimStateFieldMatrix(
  doc: Partial<MintBatchClaimDocument>,
  mintPrepared: PreparedEconomicTransaction | null,
  anchorPrepared: PreparedEconomicTransaction | null,
): void {
  const authorizationPresent = doc.authorization_economic_state_snapshot_hash !== null;
  const authorizationWindowPresent = doc.submission_authorized_until_ms !== null;
  const mintHashPresent = doc.mint_tx_hash !== null;
  const mintPreparedPresent = mintPrepared !== null;
  const mintFinalityPresent = doc.mint_finality !== null;
  const anchorHashPresent = doc.anchor_tx_hash !== null;
  const anchorPreparedPresent = anchorPrepared !== null;
  const anchorFinalityPresent = doc.anchor_finality !== null;
  const anchorEventPresent = doc.anchor_event !== null;
  const actualMintPresent = doc.actual_minted_atomic !== null;
  const reservationDeltaPresent = doc.reservation_delta_atomic !== null;
  const payloadMarkerPresent = doc.mint_broadcast_protocol !== null
    && doc.mint_payload_hash !== null;
  const payloadMarkerAbsent = doc.mint_broadcast_protocol === null
    && doc.mint_payload_hash === null;
  const noSubmissionEvidence = !authorizationPresent
    && !authorizationWindowPresent
    && !mintHashPresent
    && !mintPreparedPresent
    && !mintFinalityPresent
    && !anchorHashPresent
    && !anchorPreparedPresent
    && !anchorFinalityPresent
    && !anchorEventPresent
    && !actualMintPresent
    && !reservationDeltaPresent;
  const mintPairValid = mintHashPresent === mintPreparedPresent;
  const anchorPairValid = anchorHashPresent === anchorPreparedPresent;

  let valid = false;
  switch (doc.state) {
    case 'claimed':
      valid = noSubmissionEvidence && (payloadMarkerPresent || payloadMarkerAbsent);
      break;
    case 'submission_authorized':
      valid = authorizationPresent
        && authorizationWindowPresent
        && mintPairValid
        && !mintFinalityPresent
        && !anchorHashPresent
        && !anchorPreparedPresent
        && !anchorFinalityPresent
        && !anchorEventPresent
        && !actualMintPresent
        && !reservationDeltaPresent
        && (payloadMarkerPresent || payloadMarkerAbsent);
      break;
    case 'confirmed':
      valid = authorizationPresent
        && authorizationWindowPresent
        && payloadMarkerPresent
        && mintHashPresent
        && mintPreparedPresent
        && mintFinalityPresent
        && anchorPairValid
        && !anchorFinalityPresent
        && !anchorEventPresent
        && actualMintPresent
        && reservationDeltaPresent;
      break;
    case 'finalized':
    case 'materialized':
      valid = authorizationPresent
        && authorizationWindowPresent
        && payloadMarkerPresent
        && mintHashPresent
        && mintPreparedPresent
        && mintFinalityPresent
        && anchorHashPresent
        && anchorPreparedPresent
        && anchorFinalityPresent
        && anchorEventPresent
        && actualMintPresent
        && reservationDeltaPresent;
      break;
    case 'released':
      valid = noSubmissionEvidence && (payloadMarkerPresent || payloadMarkerAbsent);
      break;
    default:
      valid = false;
  }
  if (!valid) {
    throw new MintCoordinationError('mint_claim_state_field_matrix_invalid');
  }
}

function readClaim(data: unknown, claimId: string): MintBatchClaimDocument {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new MintCoordinationError('invalid_mint_claim');
  }
  const doc = data as Partial<MintBatchClaimDocument>;
  if (!hasExactMintClaimKeys(data as Record<string, unknown>)) {
    throw new MintCoordinationError('mint_claim_state_field_matrix_invalid');
  }
  const mintBroadcastProtocol = doc.mint_broadcast_protocol;
  const mintPayloadHash = doc.mint_payload_hash;
  let mintPrepared: PreparedEconomicTransaction | null = null;
  let anchorPrepared: PreparedEconomicTransaction | null = null;
  try {
    mintPrepared = doc.mint_prepared_transaction === undefined
      || doc.mint_prepared_transaction === null
      ? null
      : assertPreparedEconomicTransaction(doc.mint_prepared_transaction);
    anchorPrepared = doc.anchor_prepared_transaction === undefined
      || doc.anchor_prepared_transaction === null
      ? null
      : assertPreparedEconomicTransaction(doc.anchor_prepared_transaction);
  } catch {
    throw new MintCoordinationError('invalid_mint_claim');
  }
  if (doc.schema_version !== 'pvt-mint-claim/v1'
    || doc.claim_id !== claimId
    || !BYTES32.test(doc.claim_id)
    || typeof doc.batch_id !== 'string'
    || !BYTES32.test(doc.batch_id)
    || typeof doc.lease_owner_id !== 'string'
    || !OWNER_ID.test(doc.lease_owner_id)
    || !Number.isSafeInteger(doc.fencing_token)
    || (doc.fencing_token ?? 0) <= 0
    || !Number.isSafeInteger(doc.epoch)
    || (doc.epoch ?? -1) < 0
    || !Array.isArray(doc.pe_ids)
    || doc.pe_ids.length === 0
    || doc.pe_ids.length > MAX_ATOMIC_MINT_CLAIM_PES
    || doc.pe_ids.some((id) => !isBoundedFirestoreDocumentId(id))
    || new Set(doc.pe_ids).size !== doc.pe_ids.length
    || typeof doc.combined_reserved_atomic !== 'string'
    || !ATOMIC.test(doc.combined_reserved_atomic)
    || BigInt(doc.combined_reserved_atomic ?? '0') <= 0n
    || typeof doc.genesis_reserved_atomic !== 'string'
    || !ATOMIC.test(doc.genesis_reserved_atomic)
    || BigInt(doc.genesis_reserved_atomic ?? '0') > BigInt(doc.combined_reserved_atomic ?? '0')
    || (doc.genesis_settlement_reservation_id !== null
      && (typeof doc.genesis_settlement_reservation_id !== 'string'
        || !/^gsb_[a-f0-9]{64}$/.test(doc.genesis_settlement_reservation_id)))
    || ((doc.genesis_settlement_reservation_id === null)
      !== (doc.genesis_reserved_atomic === '0'))
    || typeof doc.economic_contract_address !== 'string'
    || !/^0x[a-fA-F0-9]{40}$/.test(doc.economic_contract_address)
    || typeof doc.anchor_contract_address !== 'string'
    || !/^0x[a-fA-F0-9]{40}$/.test(doc.anchor_contract_address)
    || typeof doc.economic_state_snapshot_hash !== 'string'
    || !BYTES32.test(doc.economic_state_snapshot_hash)
    || !Number.isSafeInteger(doc.economic_state_block_number)
    || (doc.economic_state_block_number ?? -1) < 0
    || typeof doc.economic_state_block_hash !== 'string'
    || !BYTES32.test(doc.economic_state_block_hash)
    || !Number.isSafeInteger(doc.economic_state_agreed_head_number)
    || doc.economic_state_agreed_head_number !== (doc.economic_state_block_number ?? -1) + 11
    || typeof doc.economic_state_agreed_head_hash !== 'string'
    || !BYTES32.test(doc.economic_state_agreed_head_hash)
    || doc.economic_state_confirmation_depth !== 12
    || !Array.isArray(doc.economic_state_operator_ids)
    || doc.economic_state_operator_ids.length !== 2
    || doc.economic_state_operator_ids[0] === doc.economic_state_operator_ids[1]
    || typeof doc.economic_factor_fingerprint !== 'string'
    || !BYTES32.test(doc.economic_factor_fingerprint)
    || typeof doc.badge_projection_input_commitment !== 'string'
    || !/^[a-f0-9]{64}$/.test(doc.badge_projection_input_commitment)
    || (doc.authorization_economic_state_snapshot_hash !== null
      && (typeof doc.authorization_economic_state_snapshot_hash !== 'string'
        || !BYTES32.test(doc.authorization_economic_state_snapshot_hash)))
    || (mintBroadcastProtocol !== null
      && mintBroadcastProtocol !== MINT_BROADCAST_PROTOCOL_V1)
    || (mintPayloadHash !== null
      && (typeof mintPayloadHash !== 'string' || !BYTES32.test(mintPayloadHash)))
    || typeof doc.anchor_payload_hash !== 'string'
    || !BYTES32.test(doc.anchor_payload_hash)
    || ((mintBroadcastProtocol === null) !== (mintPayloadHash === null))
    || !['claimed', 'submission_authorized', 'confirmed', 'finalized', 'materialized', 'released']
      .includes(doc.state ?? '')
    || (doc.submission_authorized_until_ms !== null
      && (!Number.isSafeInteger(doc.submission_authorized_until_ms)
        || (doc.submission_authorized_until_ms ?? -1) < 0))
    || (doc.mint_tx_hash !== null && (typeof doc.mint_tx_hash !== 'string' || !BYTES32.test(doc.mint_tx_hash)))
    || (doc.anchor_tx_hash !== null && (typeof doc.anchor_tx_hash !== 'string' || !BYTES32.test(doc.anchor_tx_hash)))
    || (mintPrepared !== null
      && doc.mint_tx_hash?.toLowerCase() !== mintPrepared.transactionHash.toLowerCase())
    || (anchorPrepared !== null
      && doc.anchor_tx_hash?.toLowerCase() !== anchorPrepared.transactionHash.toLowerCase())
    || (doc.mint_finality !== null && typeof doc.mint_finality !== 'object')
    || (doc.anchor_finality !== null && typeof doc.anchor_finality !== 'object')
    || (doc.actual_minted_atomic !== null
      && (typeof doc.actual_minted_atomic !== 'string' || !ATOMIC.test(doc.actual_minted_atomic)))
    || (doc.reservation_delta_atomic !== null
      && (typeof doc.reservation_delta_atomic !== 'string'
        || !SIGNED_ATOMIC.test(doc.reservation_delta_atomic)))
    || (doc.anchor_event !== null
      && !isMintAnchorEventEvidence(doc.anchor_event))
    || !Number.isSafeInteger(doc.created_at_ms)
    || (doc.created_at_ms ?? -1) < 0
    || !Number.isSafeInteger(doc.updated_at_ms)
    || (doc.updated_at_ms ?? -1) < (doc.created_at_ms ?? 0)) {
    throw new MintCoordinationError('invalid_mint_claim');
  }
  if (doc.actual_minted_atomic !== null
    && (doc.reservation_delta_atomic === null
      || BigInt(doc.actual_minted_atomic) > BigInt(doc.combined_reserved_atomic)
      || BigInt(doc.reservation_delta_atomic)
        !== BigInt(doc.actual_minted_atomic) - BigInt(doc.combined_reserved_atomic))) {
    throw new MintCoordinationError('invalid_mint_claim');
  }
  assertMintClaimStateFieldMatrix(doc, mintPrepared, anchorPrepared);
  try {
    if (doc.mint_finality !== null) {
      if (typeof doc.mint_tx_hash !== 'string') throw new Error('mint tx hash missing');
      assertBaseEconomicFinalityEvidence(doc.mint_finality, doc.mint_tx_hash);
    }
    if (doc.anchor_finality !== null) {
      if (typeof doc.anchor_tx_hash !== 'string') throw new Error('anchor tx hash missing');
      assertBaseEconomicFinalityEvidence(doc.anchor_finality, doc.anchor_tx_hash);
    }
  } catch {
    throw new MintCoordinationError('invalid_mint_claim');
  }
  return {
    ...doc,
    mint_broadcast_protocol: mintBroadcastProtocol,
    mint_payload_hash: mintPayloadHash,
    mint_prepared_transaction: mintPrepared,
    anchor_prepared_transaction: anchorPrepared,
    anchor_event: doc.anchor_event,
  } as MintBatchClaimDocument;
}

function isMintAnchorEventEvidence(value: unknown): value is MintAnchorEventEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Partial<MintAnchorEventEvidence>;
  return hasExactKeys(value as Record<string, unknown>, MINT_ANCHOR_EVENT_EVIDENCE_KEYS)
    && event.schema_version === 'pvt-mint-anchor-event/v1'
    && typeof event.batch_id === 'string'
    && BYTES32.test(event.batch_id)
    && typeof event.merkle_root === 'string'
    && BYTES32.test(event.merkle_root)
    && Number.isSafeInteger(event.pe_count)
    && (event.pe_count ?? 0) > 0
    && Number.isSafeInteger(event.timestamp)
    && (event.timestamp ?? -1) >= 0
    && Number.isSafeInteger(event.epoch_number)
    && (event.epoch_number ?? -1) >= 0;
}

function parseCapacityDocument(data: unknown): MintEpochCapacityDocument {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new MintCoordinationError('invalid_epoch_capacity');
  }
  const doc = data as Partial<MintEpochCapacityDocument>;
  if (!hasExactKeys(data as Record<string, unknown>, MINT_EPOCH_CAPACITY_DOCUMENT_KEYS)) {
    throw new MintCoordinationError('invalid_epoch_capacity');
  }
  if (doc.schema_version !== 'pvt-mint-epoch-capacity/v1'
    || !Number.isSafeInteger(doc.epoch)
    || (doc.epoch ?? -1) < 0
    || typeof doc.threshold_atomic !== 'string'
    || !ATOMIC.test(doc.threshold_atomic)
    || !Number.isSafeInteger(doc.safety_bps)
    || (doc.safety_bps ?? 0) <= 0
    || (doc.safety_bps ?? 10_001) > 10_000
    || typeof doc.last_observed_onchain_atomic !== 'string'
    || !ATOMIC.test(doc.last_observed_onchain_atomic)
    || typeof doc.pending_reserved_atomic !== 'string'
    || !ATOMIC.test(doc.pending_reserved_atomic)
    || typeof doc.committed_atomic !== 'string'
    || !ATOMIC.test(doc.committed_atomic)
    || !Number.isSafeInteger(doc.last_observed_block_number)
    || (doc.last_observed_block_number ?? -1) < 0
    || typeof doc.last_observed_block_hash !== 'string'
    || !BYTES32.test(doc.last_observed_block_hash)
    || typeof doc.last_observed_snapshot_hash !== 'string'
    || !BYTES32.test(doc.last_observed_snapshot_hash)
    || !Number.isSafeInteger(doc.revision)
    || (doc.revision ?? -1) < 0
    || typeof doc.cap_breach_detected !== 'boolean'
    || !Number.isSafeInteger(doc.updated_at_ms)
    || (doc.updated_at_ms ?? -1) < 0) {
    throw new MintCoordinationError('invalid_epoch_capacity');
  }
  return doc as MintEpochCapacityDocument;
}

/** Epoch advancement must not reset counters while any reserved capacity remains. */
export async function hasPendingMintEpochCapacity(db: Firestore): Promise<boolean> {
  const snap = await db.collection(MINT_EPOCH_CAPACITY_COLLECTION).get();
  for (const doc of snap.docs) {
    const data = parseCapacityDocument(doc.data());
    if (doc.id !== String(data.epoch)) {
      throw new MintCoordinationError('invalid_epoch_capacity');
    }
    if (BigInt(data.pending_reserved_atomic) > 0n) return true;
  }
  return false;
}

function isBoundedFirestoreDocumentId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('/')
    && Buffer.byteLength(value, 'utf8') <= MAX_FIRESTORE_DOCUMENT_ID_UTF8_BYTES;
}

export async function listOutstandingMintBatchClaims(
  db: Firestore,
  options: { readonly strict?: boolean } = {},
): Promise<readonly MintBatchClaimDocument[]> {
  const claims: MintBatchClaimDocument[] = [];
  for (const state of OUTSTANDING_MINT_BATCH_CLAIM_STATES) {
    let cursorId: string | null = null;
    for (;;) {
      let query = db.collection(MINT_BATCH_CLAIM_COLLECTION)
        .where('state', '==', state)
        .orderBy(FieldPath.documentId(), 'asc')
        .limit(100);
      if (cursorId !== null) query = query.startAfter(cursorId);
      const snap = await query.get();
      if (snap.empty) break;
      for (const doc of snap.docs) {
        try {
          claims.push(readClaim(doc.data(), doc.id));
        } catch (error) {
          if (options.strict) throw error;
          // Unknown/malformed claims remain fenced, but one corrupt first-page
          // record must not prevent deterministic discovery of later claims.
          console.error(
            `[PVT Mint] Invalid outstanding claim ${doc.id}; leaving it fenced:`,
            error,
          );
        }
      }
      cursorId = snap.docs[snap.docs.length - 1].id;
      if (snap.size < 100) break;
    }
  }
  return Object.freeze(claims.sort((a, b) =>
    OUTSTANDING_MINT_BATCH_CLAIM_STATES.indexOf(
      a.state as OutstandingMintBatchClaimState,
    ) - OUTSTANDING_MINT_BATCH_CLAIM_STATES.indexOf(
      b.state as OutstandingMintBatchClaimState,
    )
    || a.claim_id.localeCompare(b.claim_id)));
}

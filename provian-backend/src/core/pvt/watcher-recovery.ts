import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import {
  FieldPath,
  type DocumentReference,
  type Firestore,
} from 'firebase-admin/firestore';

import { isFirestoreAlreadyExists } from '../../firestore-errors';
import {
  assertBaseUsdcTransferEvidence,
  type BaseUsdcTransferEvidence,
} from '../onchain/economic-discovery';

export const WATCHER_RECOVERY_LEASE_MS = 5 * 60 * 1000;

/**
 * Equal as chain facts: every evidence field except which two agreeing
 * operators produced it (and the hash that covers them). Both sides must
 * already have passed `assertBaseUsdcTransferEvidence` (distinct operators,
 * self-consistent hash).
 */
export function sameBaseUsdcTransferChainFacts(
  a: BaseUsdcTransferEvidence,
  b: BaseUsdcTransferEvidence,
): boolean {
  const facts = (value: BaseUsdcTransferEvidence): string => {
    const { evidenceHash: _hash, providerOperatorIds: _operators, ...rest } = value;
    return stableStringify(rest) ?? '';
  };
  return facts(a) === facts(b);
}

const BASE_CHAIN_ID = 8453;
const TRANSACTION_HASH = /^0x[a-fA-F0-9]{64}$/;
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ATOMIC = /^(0|[1-9][0-9]*)$/;
const BYTES32 = /^0x[a-fA-F0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WATCHER_CLAIM_KEYS = Object.freeze([
  'amount_atomic',
  'attempts',
  'chain_id',
  'claimed_at_ms',
  'completed_at_ms',
  'evidence_snapshot',
  'from_address',
  'last_error',
  'lease_expires_at_ms',
  'lease_token',
  'log_index',
  'payload',
  'payload_hash',
  'pe_id',
  'schema_version',
  'state',
  'to_address',
  'transaction_hash',
  'updated_at_ms',
] as const);

export interface WatcherClaimBinding {
  readonly chainId: typeof BASE_CHAIN_ID;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amountAtomic: string;
}

export interface WatcherClaimHandle {
  readonly ref: DocumentReference;
  readonly leaseToken: string;
  readonly binding: WatcherClaimBinding;
  readonly payload: Record<string, unknown>;
  readonly evidenceSnapshot: BaseUsdcTransferEvidence | null;
  /** 1 for the in-process creator; >=2 identifies a durable recovery lease. */
  readonly attempts: number;
}

export interface WatcherRecoveryIssue {
  readonly collectionName: string;
  readonly documentId: string;
  readonly code: 'watcher_claim_malformed';
  readonly reason: string;
}

export interface WatcherRecoveryLeaseResult {
  readonly handles: readonly WatcherClaimHandle[];
  readonly issues: readonly WatcherRecoveryIssue[];
  /**
   * Pre-durable-schema dedup markers recognized and skipped (see
   * `isLegacySeenMarker`). Counted so a lane's operator report can show the
   * legacy population without those docs blocking the lane as malformed.
   */
  readonly legacyMarkersSkipped: number;
}

/**
 * The pre-durable inbound dedup marker (`genesis_inbound_seen`, written before
 * the economic-watcher-claim schema existed): EXACTLY these five fields. Such
 * a doc is completed history — the transfer it marks was processed by the
 * pre-claim code path, and the doc's existence is what still deduplicates that
 * transfer — so recovery must skip it rather than block the whole lane on it
 * (`structurallyBlocked` had wedged every inbound scan since the durable layer
 * landed). Anything that does not match this shape EXACTLY still fails closed
 * as `watcher_claim_malformed`.
 */
const LEGACY_SEEN_MARKER_KEYS = Object.freeze(
  ['chain_id', 'claimed_at', 'log_index', 'tx_hash', 'wallet_id'] as const,
);

export function isLegacySeenMarker(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== LEGACY_SEEN_MARKER_KEYS.length
    || keys.some((key, index) => key !== LEGACY_SEEN_MARKER_KEYS[index])) {
    return false;
  }
  const doc = value as Record<string, unknown>;
  return doc.chain_id === BASE_CHAIN_ID
    && typeof doc.tx_hash === 'string'
    && TRANSACTION_HASH.test(doc.tx_hash)
    && Number.isSafeInteger(doc.log_index)
    && (doc.log_index as number) >= 0
    && typeof doc.wallet_id === 'string'
    && (doc.wallet_id as string).length > 0
    && Number.isSafeInteger(doc.claimed_at)
    && (doc.claimed_at as number) > 0;
}

interface WatcherClaimDocument {
  readonly schema_version: 'economic-watcher-claim/v1';
  readonly state: 'processing' | 'pending_reverification' | 'complete';
  readonly chain_id: typeof BASE_CHAIN_ID;
  readonly transaction_hash: string;
  readonly log_index: number;
  readonly from_address: string;
  readonly to_address: string;
  readonly amount_atomic: string;
  readonly payload: Record<string, unknown>;
  readonly payload_hash: string;
  readonly evidence_snapshot: BaseUsdcTransferEvidence | null;
  readonly lease_token: string | null;
  readonly lease_expires_at_ms: number | null;
  readonly attempts: number;
  readonly claimed_at_ms: number;
  readonly last_error: string | null;
  readonly pe_id: string | null;
  readonly completed_at_ms: number | null;
  readonly updated_at_ms: number;
}

function canonicalPayload(payload: Record<string, unknown>): string {
  const canonical = stableStringify(payload);
  if (typeof canonical !== 'string') throw new Error('watcher_claim_payload_invalid');
  return canonical;
}

function hashPayloadCanonical(canonical: string): string {
  return `0x${crypto.createHash('sha256').update(canonical).digest('hex')}`;
}

function normalizeBinding(
  value: WatcherClaimBinding,
  payload: Record<string, unknown>,
): WatcherClaimBinding {
  if (value.chainId !== BASE_CHAIN_ID
    || !TRANSACTION_HASH.test(value.transactionHash)
    || !Number.isSafeInteger(value.logIndex)
    || value.logIndex < 0
    || !ADDRESS.test(value.fromAddress)
    || !ADDRESS.test(value.toAddress)
    || !ATOMIC.test(value.amountAtomic)) {
    throw new Error('watcher_claim_binding_invalid');
  }
  const normalized: WatcherClaimBinding = Object.freeze({
    chainId: BASE_CHAIN_ID,
    transactionHash: value.transactionHash.toLowerCase(),
    logIndex: value.logIndex,
    fromAddress: value.fromAddress.toLowerCase(),
    toAddress: value.toAddress.toLowerCase(),
    amountAtomic: value.amountAtomic,
  });
  const event = payload.event;
  if (typeof payload.chainId !== 'number'
    || payload.chainId !== normalized.chainId
    || typeof event !== 'object'
    || event === null
    || Array.isArray(event)) {
    throw new Error('watcher_claim_payload_binding_invalid');
  }
  const eventRecord = event as Record<string, unknown>;
  if (typeof eventRecord.txHash !== 'string'
    || eventRecord.txHash.toLowerCase() !== normalized.transactionHash
    || eventRecord.logIndex !== normalized.logIndex
    || eventRecord.amountAtomic !== normalized.amountAtomic) {
    throw new Error('watcher_claim_payload_binding_invalid');
  }
  const wallet = payload.wallet;
  const addr = payload.addr;
  const inboundMatches = typeof wallet === 'object'
    && wallet !== null
    && !Array.isArray(wallet)
    && typeof (wallet as Record<string, unknown>).address === 'string'
    && ((wallet as Record<string, unknown>).address as string).toLowerCase()
      === normalized.toAddress
    && typeof eventRecord.fromAddress === 'string'
    && eventRecord.fromAddress.toLowerCase() === normalized.fromAddress;
  const outboundMatches = typeof addr === 'object'
    && addr !== null
    && !Array.isArray(addr)
    && typeof (addr as Record<string, unknown>).address === 'string'
    && ((addr as Record<string, unknown>).address as string).toLowerCase()
      === normalized.fromAddress
    && typeof eventRecord.toAddress === 'string'
    && eventRecord.toAddress.toLowerCase() === normalized.toAddress;
  if (inboundMatches === outboundMatches) {
    throw new Error('watcher_claim_payload_binding_invalid');
  }
  canonicalPayload(payload);
  return normalized;
}

export function watcherClaimDocumentId(binding: WatcherClaimBinding): string {
  if (binding.chainId !== BASE_CHAIN_ID
    || !TRANSACTION_HASH.test(binding.transactionHash)
    || !Number.isSafeInteger(binding.logIndex)
    || binding.logIndex < 0) {
    throw new Error('watcher_claim_binding_invalid');
  }
  return `${binding.chainId}_${binding.transactionHash.toLowerCase()}_${binding.logIndex}`;
}

function bindingFromClaim(claim: WatcherClaimDocument): WatcherClaimBinding {
  return Object.freeze({
    chainId: claim.chain_id,
    transactionHash: claim.transaction_hash,
    logIndex: claim.log_index,
    fromAddress: claim.from_address,
    toAddress: claim.to_address,
    amountAtomic: claim.amount_atomic,
  });
}

function assertClaim(value: unknown): WatcherClaimDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('watcher_claim_document_invalid');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [...WATCHER_CLAIM_KEYS].sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('watcher_claim_document_invalid');
  }
  const doc = value as Partial<WatcherClaimDocument>;
  if (doc.schema_version !== 'economic-watcher-claim/v1'
    || !['processing', 'pending_reverification', 'complete'].includes(doc.state ?? '')
    || doc.chain_id !== BASE_CHAIN_ID
    || typeof doc.transaction_hash !== 'string'
    || !TRANSACTION_HASH.test(doc.transaction_hash)
    || doc.transaction_hash !== doc.transaction_hash.toLowerCase()
    || !Number.isSafeInteger(doc.log_index)
    || (doc.log_index ?? -1) < 0
    || typeof doc.from_address !== 'string'
    || !ADDRESS.test(doc.from_address)
    || doc.from_address !== doc.from_address.toLowerCase()
    || typeof doc.to_address !== 'string'
    || !ADDRESS.test(doc.to_address)
    || doc.to_address !== doc.to_address.toLowerCase()
    || typeof doc.amount_atomic !== 'string'
    || !ATOMIC.test(doc.amount_atomic)
    || typeof doc.payload !== 'object'
    || doc.payload === null
    || Array.isArray(doc.payload)
    || typeof doc.payload_hash !== 'string'
    || !BYTES32.test(doc.payload_hash)
    || doc.payload_hash !== doc.payload_hash.toLowerCase()
    || doc.evidence_snapshot === undefined
    || (doc.evidence_snapshot !== null && typeof doc.evidence_snapshot !== 'object')
    || (doc.lease_token !== null
      && (typeof doc.lease_token !== 'string' || !UUID.test(doc.lease_token)))
    || (doc.lease_expires_at_ms !== null
      && (!Number.isSafeInteger(doc.lease_expires_at_ms)
        || (doc.lease_expires_at_ms ?? -1) < 0))
    || !Number.isSafeInteger(doc.attempts)
    || (doc.attempts ?? 0) < 1
    || !Number.isSafeInteger(doc.claimed_at_ms)
    || (doc.claimed_at_ms ?? -1) < 0
    || (doc.last_error !== null && typeof doc.last_error !== 'string')
    || (doc.pe_id !== null
      && (typeof doc.pe_id !== 'string' || doc.pe_id.length === 0 || doc.pe_id.length > 500))
    || (doc.completed_at_ms !== null
      && (!Number.isSafeInteger(doc.completed_at_ms) || (doc.completed_at_ms ?? -1) < 0))
    || !Number.isSafeInteger(doc.updated_at_ms)
    || (doc.updated_at_ms ?? -1) < (doc.claimed_at_ms ?? 0)
    || (doc.state === 'processing'
      ? typeof doc.lease_token !== 'string'
        || !Number.isSafeInteger(doc.lease_expires_at_ms)
        || doc.lease_expires_at_ms! < doc.updated_at_ms!
      : doc.lease_token !== null || doc.lease_expires_at_ms !== null)
    || (doc.state === 'complete'
      ? typeof doc.pe_id !== 'string'
        || !Number.isSafeInteger(doc.completed_at_ms)
        || doc.completed_at_ms !== doc.updated_at_ms
        || doc.last_error !== null
      : doc.pe_id !== null || doc.completed_at_ms !== null)) {
    throw new Error('watcher_claim_document_invalid');
  }
  const claim = {
    ...(doc as WatcherClaimDocument),
    evidence_snapshot: doc.evidence_snapshot ?? null,
  };
  const binding = normalizeBinding(bindingFromClaim(claim), claim.payload);
  const canonical = canonicalPayload(claim.payload);
  if (hashPayloadCanonical(canonical).toLowerCase() !== claim.payload_hash.toLowerCase()) {
    throw new Error('watcher_claim_payload_hash_mismatch');
  }
  if (claim.evidence_snapshot !== null) {
    try {
      assertBaseUsdcTransferEvidence(claim.evidence_snapshot, {
        transactionHash: binding.transactionHash,
        logIndex: binding.logIndex,
        fromAddress: binding.fromAddress,
        toAddress: binding.toAddress,
        amountAtomic: binding.amountAtomic,
      });
    } catch {
      throw new Error('watcher_claim_evidence_binding_mismatch');
    }
  }
  if (claim.state === 'complete' && claim.evidence_snapshot === null) {
    throw new Error('watcher_claim_complete_without_evidence');
  }
  return claim;
}

function leaseExpiry(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0
    || now > Number.MAX_SAFE_INTEGER - WATCHER_RECOVERY_LEASE_MS) {
    throw new Error('watcher_claim_time_invalid');
  }
  return now + WATCHER_RECOVERY_LEASE_MS;
}

function assertActiveLease(
  claim: WatcherClaimDocument,
  handle: WatcherClaimHandle,
  now: number,
): void {
  if (!Number.isSafeInteger(now) || now < claim.updated_at_ms
    || claim.state !== 'processing'
    || claim.lease_token !== handle.leaseToken
    || claim.lease_expires_at_ms === null
    || claim.lease_expires_at_ms <= now) {
    throw new Error('watcher_claim_lease_lost');
  }
}

function assertClaimMatchesExpected(
  claim: WatcherClaimDocument,
  ref: DocumentReference,
  binding: WatcherClaimBinding,
  payload: Record<string, unknown>,
): void {
  const normalized = normalizeBinding(binding, payload);
  if (ref.id !== watcherClaimDocumentId(normalized)
    || claim.chain_id !== normalized.chainId
    || claim.transaction_hash !== normalized.transactionHash
    || claim.log_index !== normalized.logIndex
    || claim.from_address !== normalized.fromAddress
    || claim.to_address !== normalized.toAddress
    || claim.amount_atomic !== normalized.amountAtomic
    || canonicalPayload(claim.payload) !== canonicalPayload(payload)
    || claim.payload_hash.toLowerCase() !== hashPayloadCanonical(canonicalPayload(payload))) {
    throw new Error('watcher_claim_existing_binding_mismatch');
  }
}

/** Create exact ownership; only a transactionally validated exact match is a duplicate. */
export async function createWatcherClaim(
  db: Firestore,
  ref: DocumentReference,
  bindingInput: WatcherClaimBinding,
  payload: Record<string, unknown>,
  now: number,
): Promise<WatcherClaimHandle | null> {
  const expiresAt = leaseExpiry(now);
  const binding = normalizeBinding(bindingInput, payload);
  if (ref.id !== watcherClaimDocumentId(binding)) {
    throw new Error('watcher_claim_document_id_mismatch');
  }
  const payloadHash = hashPayloadCanonical(canonicalPayload(payload));
  const leaseToken = crypto.randomUUID();
  try {
    await ref.create({
      schema_version: 'economic-watcher-claim/v1',
      state: 'processing',
      chain_id: binding.chainId,
      transaction_hash: binding.transactionHash,
      log_index: binding.logIndex,
      from_address: binding.fromAddress,
      to_address: binding.toAddress,
      amount_atomic: binding.amountAtomic,
      payload,
      payload_hash: payloadHash,
      evidence_snapshot: null,
      lease_token: leaseToken,
      lease_expires_at_ms: expiresAt,
      attempts: 1,
      claimed_at_ms: now,
      updated_at_ms: now,
      last_error: null,
      pe_id: null,
      completed_at_ms: null,
    });
  } catch (error) {
    if (isFirestoreAlreadyExists(error)) {
      return db.runTransaction(async (txn) => {
        const snap = await txn.get(ref);
        if (!snap.exists) throw new Error('watcher_claim_existing_row_missing');
        let claim: WatcherClaimDocument;
        try {
          claim = assertClaim(snap.data());
        } catch {
          throw new Error('watcher_claim_existing_malformed');
        }
        assertClaimMatchesExpected(claim, ref, binding, payload);
        return null;
      });
    }
    throw error;
  }
  return { ref, leaseToken, binding, payload, evidenceSnapshot: null, attempts: 1 };
}

/** where the last clean full integrity pass over a claim collection is recorded. */
export const WATCHER_RECOVERY_INTEGRITY_COLLECTION = 'watcher_recovery_integrity_v1';
/** A full pass (every claim ever recorded, malformed ones block the lane) runs at most this often. */
export const WATCHER_RECOVERY_FULL_PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The only states a claim needing recovery can be in (`complete` never needs it). */
const UNFINISHED_CLAIM_STATES = ['processing', 'pending_reverification'] as const;

/**
 * Lease pending or stale-processing claims for durable re-verification.
 *
 * an ordinary run queries only unfinished claims, so it costs what is pending rather than
 * one read per payment ever recorded (it paged the whole collection every run). Once a day, and
 * on every run while the last full pass found a malformed claim, it pages the WHOLE collection as
 * before, so a malformed claim still blocks the lane (`structurallyBlocked`) until it is repaired.
 * The full pass is recorded only when it finds no issue.
 */
export async function leaseWatcherRecoveryClaims(
  db: Firestore,
  collectionName: string,
  now: number,
  limit = 100,
): Promise<WatcherRecoveryLeaseResult> {
  leaseExpiry(now); // validate the clock before scanning; each lease computes its own expiry
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('watcher_claim_recovery_limit_invalid');
  }
  const integrityRef = db.collection(WATCHER_RECOVERY_INTEGRITY_COLLECTION).doc(collectionName);
  const integrity = (await integrityRef.get()).data() as { last_clean_full_pass_ms?: unknown } | undefined;
  const lastFullPass = integrity?.last_clean_full_pass_ms;
  const fullPass = typeof lastFullPass !== 'number' || !Number.isSafeInteger(lastFullPass)
    || lastFullPass > now || now - lastFullPass >= WATCHER_RECOVERY_FULL_PASS_INTERVAL_MS;
  const candidates = new Map<string, {
    ref: DocumentReference;
    claim: WatcherClaimDocument;
  }>();
  let legacyMarkersSkipped = 0;
  const issues: WatcherRecoveryIssue[] = [];
  const issueIds = new Set<string>();
  const addIssue = (documentId: string, error: unknown): void => {
    if (issueIds.has(documentId)) return;
    issueIds.add(documentId);
    issues.push(Object.freeze({
      collectionName,
      documentId,
      code: 'watcher_claim_malformed',
      reason: error instanceof Error ? error.message : String(error),
    }));
  };
  let cursorId: string | null = null;
  for (;;) {
    let query = fullPass
      ? db.collection(collectionName).orderBy(FieldPath.documentId(), 'asc').limit(100)
      : db.collection(collectionName)
        .where('state', 'in', [...UNFINISHED_CLAIM_STATES])
        .orderBy(FieldPath.documentId(), 'asc')
        .limit(100);
    if (cursorId !== null) query = query.startAfter(cursorId);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data = doc.data();
      // Positive recognition BEFORE the claim assertion: a legacy marker is
      // known completed history, not a malformed claim. Near-misses (extra
      // key, wrong type) fall through to assertClaim and fail closed.
      if (isLegacySeenMarker(data)) {
        legacyMarkersSkipped += 1;
        continue;
      }
      try {
        const claim = assertClaim(data);
        if (doc.id !== watcherClaimDocumentId(bindingFromClaim(claim))) {
          throw new Error('watcher_claim_document_id_mismatch');
        }
        if (claim.state !== 'complete') candidates.set(doc.id, { ref: doc.ref, claim });
      } catch (error) {
        addIssue(doc.id, error);
      }
    }
    cursorId = snap.docs[snap.docs.length - 1].id;
    if (snap.size < 100) break;
  }

  if (fullPass && issues.length === 0) {
    await integrityRef.set({ last_clean_full_pass_ms: now, collection: collectionName });
  }

  // Lowest-attempt claims first. A permanently failing first lexical page is
  // incremented and rotates behind untouched later pages on the next drain.
  const ordered = [...candidates.entries()].sort((a, b) =>
    (a[1].claim.attempts - b[1].claim.attempts)
    || (a[1].claim.updated_at_ms - b[1].claim.updated_at_ms)
    || a[0].localeCompare(b[0]));
  const handles: WatcherClaimHandle[] = [];
  for (const [, candidate] of ordered) {
    if (handles.length >= limit) break;
    const { ref } = candidate;
    try {
      const handle = await leaseWatcherClaim(db, ref, now);
      if (handle) handles.push(handle);
    } catch (error) {
      addIssue(ref.id, error);
    }
  }
  return Object.freeze({
    handles: Object.freeze(handles),
    issues: Object.freeze(issues),
    legacyMarkersSkipped,
  });
}

/**
 * Lease ONE durable claim for re-verification (the per-claim body of
 * `leaseWatcherRecoveryClaims`, also used by the lineage backfill to
 * drive a claim stranded behind a key rotation). Returns null when the claim is
 * complete or another worker holds a live lease; the returned handle carries
 * `attempts >= 2`, so the caller's authority re-check applies.
 */
export async function leaseWatcherClaim(
  db: Firestore,
  ref: DocumentReference,
  now: number,
): Promise<WatcherClaimHandle | null> {
  const expiresAt = leaseExpiry(now);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) throw new Error('watcher_claim_missing_during_recovery');
    const claim = assertClaim(snap.data());
    if (ref.id !== watcherClaimDocumentId(bindingFromClaim(claim))) {
      throw new Error('watcher_claim_document_id_mismatch');
    }
    if (claim.state === 'complete') return null;
    const leaseActive = claim.state === 'processing'
      && (claim.lease_expires_at_ms ?? 0) > now;
    if (leaseActive) return null;
    if (claim.attempts >= Number.MAX_SAFE_INTEGER) {
      throw new Error('watcher_claim_attempts_exhausted');
    }
    const leaseToken = crypto.randomUUID();
    txn.set(ref, {
      ...claim,
      state: 'processing',
      lease_token: leaseToken,
      lease_expires_at_ms: expiresAt,
      attempts: claim.attempts + 1,
      updated_at_ms: now,
    });
    return {
      ref,
      leaseToken,
      binding: bindingFromClaim(claim),
      payload: claim.payload,
      evidenceSnapshot: claim.evidence_snapshot,
      attempts: claim.attempts + 1,
    } satisfies WatcherClaimHandle;
  });
}

/** Read-only view of one durable claim (state, sealed PE, payload). Throws on a
 * malformed claim; returns null when the document does not exist. */
export async function readWatcherClaim(
  ref: DocumentReference,
): Promise<{
  state: 'processing' | 'pending_reverification' | 'complete';
  peId: string | null;
  payload: Record<string, unknown>;
  lastError: string | null;
} | null> {
  const snap = await ref.get();
  if (!snap.exists) return null;
  const claim = assertClaim(snap.data());
  if (ref.id !== watcherClaimDocumentId(bindingFromClaim(claim))) {
    throw new Error('watcher_claim_document_id_mismatch');
  }
  return {
    state: claim.state,
    peId: claim.pe_id,
    payload: claim.payload,
    lastError: claim.last_error,
  };
}

/** Persist the first canonical finality snapshot and reject any later drift. */
export async function freezeWatcherClaimEvidence(
  db: Firestore,
  handle: WatcherClaimHandle,
  evidence: BaseUsdcTransferEvidence,
  now: number,
): Promise<WatcherClaimHandle> {
  const expiresAt = leaseExpiry(now);
  const verified = assertBaseUsdcTransferEvidence(evidence, {
    transactionHash: handle.binding.transactionHash,
    logIndex: handle.binding.logIndex,
    fromAddress: handle.binding.fromAddress,
    toAddress: handle.binding.toAddress,
    amountAtomic: handle.binding.amountAtomic,
  });
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(handle.ref);
    if (!snap.exists) throw new Error('watcher_claim_lease_lost');
    const claim = assertClaim(snap.data());
    assertClaimMatchesExpected(claim, handle.ref, handle.binding, handle.payload);
    assertActiveLease(claim, handle, now);
    if (claim.evidence_snapshot !== null) {
      const prior = assertBaseUsdcTransferEvidence(claim.evidence_snapshot);
      // round 2: the re-read must prove the SAME CHAIN FACTS, not come
      // from the same RPC operators. `evidenceHash` also covers
      // `providerOperatorIds`, so a claim frozen under one agreed operator pair
      // (an operator shell, or the relay before an RPC provider change) could
      // never be completed under another: stranded pending forever. The frozen
      // snapshot stays authoritative — it is what the sealed PE embeds — and
      // any differing chain fact still conflicts.
      if (!sameBaseUsdcTransferChainFacts(prior, verified)) {
        throw new Error('watcher_claim_evidence_conflict');
      }
      txn.set(handle.ref, {
        ...claim,
        lease_expires_at_ms: expiresAt,
        updated_at_ms: now,
      });
      return { ...handle, evidenceSnapshot: prior };
    }
    txn.set(handle.ref, {
      ...claim,
      evidence_snapshot: verified,
      lease_expires_at_ms: expiresAt,
      updated_at_ms: now,
    });
    return { ...handle, evidenceSnapshot: verified };
  });
}

export async function markWatcherClaimPending(
  db: Firestore,
  handle: WatcherClaimHandle,
  error: unknown,
  now: number,
): Promise<void> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('watcher_claim_time_invalid');
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(handle.ref);
    if (!snap.exists) throw new Error('watcher_claim_lease_lost');
    const claim = assertClaim(snap.data());
    assertClaimMatchesExpected(claim, handle.ref, handle.binding, handle.payload);
    assertActiveLease(claim, handle, now);
    txn.set(handle.ref, {
      ...claim,
      state: 'pending_reverification',
      lease_token: null,
      lease_expires_at_ms: null,
      last_error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      updated_at_ms: now,
    });
  });
}
export async function markWatcherClaimComplete(
  db: Firestore,
  handle: WatcherClaimHandle,
  peId: string,
  now: number,
): Promise<void> {
  if (!peId || peId.length > 500 || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('watcher_claim_completion_invalid');
  }
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(handle.ref);
    if (!snap.exists) throw new Error('watcher_claim_lease_lost');
    const claim = assertClaim(snap.data());
    assertClaimMatchesExpected(claim, handle.ref, handle.binding, handle.payload);
    assertActiveLease(claim, handle, now);
    txn.set(handle.ref, {
      ...claim,
      state: 'complete',
      lease_token: null,
      lease_expires_at_ms: null,
      last_error: null,
      pe_id: peId,
      completed_at_ms: now,
      updated_at_ms: now,
    });
  });
}

/**
 * External-address proof-of-control link records.
 *
 * Only a fully evidenced `proven-address/v2` record has economic authority.
 * Older rows remain address/agent history and public-resolution evidence, but
 * they are deliberately absent from watcher enumeration until the already-
 * bound agent re-proves control and atomically upgrades the row.
 */

import crypto from 'crypto';
import { ethers } from 'ethers';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { BASE_ECONOMIC_FINALITY_CONFIRMATIONS } from '../onchain/economic-constants';
import type { ProofMethod } from './verify';
import { recordWatchRegistryEntry } from '../pvt/watch-registry';
import {
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
} from '../pvt/native-wallet-registration';

export const PROVEN_ADDRESSES_COLLECTION = 'proven_addresses';
/**
 * 2026-10-01 (carried): a PERSON proves a wallet they
 * already hold. Kept in its own registry so every agent-only consumer of
 * `proven_addresses` is untouched; the doc id is the lowercased address in both,
 * and every writer reads BOTH (plus the native-wallet index) inside its
 * transaction, so one address has exactly one owner across agents, people and
 * Provian wallets. See `human-link.ts`.
 */
export const HUMAN_PROVEN_ADDRESSES_COLLECTION = 'human_proven_addresses';
export const PROVEN_ADDRESS_SCHEMA = 'proven-address/v2' as const;

/**
 * The two external-proof registry docs for an address (doc id = the lowercased
 * address). Every NATIVE wallet writer (agent create, human registration, key
 * rotation) reads both inside its transaction and refuses a proven address, so a
 * Provian wallet is never also someone's proven external address (one address,
 * one owner; review defect 1).
 */
export function externalProofRefs(
  db: Firestore,
  address: string,
): readonly [agentProven: DocumentReference, personProven: DocumentReference] {
  const lower = address.toLowerCase();
  return [
    db.collection(PROVEN_ADDRESSES_COLLECTION).doc(lower),
    db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(lower),
  ];
}
export const PROVEN_ADDRESS_CHAIN = 'base' as const;
export const PROVEN_ADDRESS_CHAIN_ID = 8453 as const;

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const BLOCK_HASH = /^0x[a-f0-9]{64}$/;

export interface ProvenAddressProofEvidence {
  readonly schema_version: 'external-address-control-proof/v1';
  readonly challenge_id_sha256: string;
  readonly challenge_message_sha256: string;
  readonly signature_sha256: string;
  readonly proof_method: ProofMethod;
  readonly verified_at_ms: number;
}

export interface ProvenAddressRecord {
  readonly schema_version: typeof PROVEN_ADDRESS_SCHEMA;
  readonly economic_eligibility: 'active_go_forward_only';
  /** Lowercased EVM address. Also the Firestore doc id. */
  readonly address: string;
  /** The agent that proved control (attribution target for PEs). */
  readonly agent_id: string;
  /** Genesis/per-wallet accounting key. */
  readonly wallet_id: string;
  readonly proven_at_ms: number;
  /** Exact H+1 go-forward economic fence. */
  readonly proven_at_block: number;
  /** Operator-agreed latest head H observed during proof. */
  readonly proof_observed_head_block: number;
  /** Exact finalized state block H-11 under the inclusive 12-block rule. */
  readonly proof_block_number: number;
  readonly proof_block_hash: string;
  readonly proof_min_confirmations: typeof BASE_ECONOMIC_FINALITY_CONFIRMATIONS;
  readonly proof_rpc_operator_ids: readonly [string, string];
  readonly chain: typeof PROVEN_ADDRESS_CHAIN;
  readonly chain_id: typeof PROVEN_ADDRESS_CHAIN_ID;
  readonly proof_method: ProofMethod;
  /** Duplicated top-level commitment retained for existing audit consumers. */
  readonly signature_hash: string;
  readonly proof_evidence: ProvenAddressProofEvidence;
  /** Read-only reputation derived from pre-fence history; never PVT. */
  readonly initial_reputation_tier: number;
  /** Nonce at the exact proof-state block. Required; never lazily initialized. */
  readonly baseline_nonce: number;
  readonly created_at: number;
}

export type WriteProvenAddressResult =
  | {
    ok: true;
    record: ProvenAddressRecord;
    already_proven: boolean;
    upgraded_legacy: boolean;
  }
  | { ok: false; reason: 'address_bound_to_other_agent' | 'address_bound_to_other_owner' | 'address_is_provian_wallet' };

export interface ProvenAddressAtomicCoWrite {
  readonly ref: DocumentReference;
  readonly activationRef?: DocumentReference;
  readonly buildData: (
    record: ProvenAddressRecord,
    activationValue: unknown,
  ) => Record<string, unknown> | null;
}

const PROVEN_ADDRESS_KEYS = Object.freeze([
  'schema_version',
  'economic_eligibility',
  'address',
  'agent_id',
  'wallet_id',
  'proven_at_ms',
  'proven_at_block',
  'proof_observed_head_block',
  'proof_block_number',
  'proof_block_hash',
  'proof_min_confirmations',
  'proof_rpc_operator_ids',
  'chain',
  'chain_id',
  'proof_method',
  'signature_hash',
  'proof_evidence',
  'initial_reputation_tier',
  'baseline_nonce',
  'created_at',
] as const);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((key, index) => key === canonical[index]);
}

function hash(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function createProvenAddressProofEvidence(params: {
  readonly challengeId: string;
  readonly challengeMessage: string;
  readonly signature: string;
  readonly proofMethod: ProofMethod;
  readonly verifiedAtMs: number;
}): ProvenAddressProofEvidence {
  const evidence: ProvenAddressProofEvidence = Object.freeze({
    schema_version: 'external-address-control-proof/v1',
    challenge_id_sha256: hash(params.challengeId),
    challenge_message_sha256: hash(params.challengeMessage),
    signature_sha256: hash(params.signature),
    proof_method: params.proofMethod,
    verified_at_ms: params.verifiedAtMs,
  });
  if (!isProvenAddressProofEvidence(evidence)) {
    throw new Error('proven_address_proof_evidence_invalid');
  }
  return evidence;
}

function isProvenAddressProofEvidence(value: unknown): value is ProvenAddressProofEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return exactKeys(evidence, [
    'schema_version',
    'challenge_id_sha256',
    'challenge_message_sha256',
    'signature_sha256',
    'proof_method',
    'verified_at_ms',
  ])
    && evidence.schema_version === 'external-address-control-proof/v1'
    && typeof evidence.challenge_id_sha256 === 'string'
    && SHA256.test(evidence.challenge_id_sha256)
    && typeof evidence.challenge_message_sha256 === 'string'
    && SHA256.test(evidence.challenge_message_sha256)
    && typeof evidence.signature_sha256 === 'string'
    && SHA256.test(evidence.signature_sha256)
    && (evidence.proof_method === 'eip191_eoa'
      || evidence.proof_method === 'eip1271_contract')
    && Number.isSafeInteger(evidence.verified_at_ms)
    && (evidence.verified_at_ms as number) >= 0;
}

function hasValidIdentity(value: unknown, documentId: string): value is {
  address: string;
  agent_id: string;
  wallet_id: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.address === 'string'
    && ethers.isAddress(record.address)
    && record.address.toLowerCase() === documentId.toLowerCase()
    && typeof record.agent_id === 'string'
    && record.agent_id.length > 0
    && typeof record.wallet_id === 'string'
    && record.wallet_id.length > 0;
}

export function isEconomicallyActiveProvenAddress(
  value: unknown,
  documentId: string,
): value is ProvenAddressRecord {
  if (!hasValidIdentity(value, documentId)) return false;
  const identity = value;
  const record = value as unknown as Record<string, unknown>;
  if (!exactKeys(record, PROVEN_ADDRESS_KEYS)
    || record.schema_version !== PROVEN_ADDRESS_SCHEMA
    || record.economic_eligibility !== 'active_go_forward_only'
    || identity.address !== identity.address.toLowerCase()
    || !Number.isSafeInteger(record.proven_at_ms)
    || (record.proven_at_ms as number) < 0
    || !Number.isSafeInteger(record.proof_observed_head_block)
    || !Number.isSafeInteger(record.proof_block_number)
    || (record.proof_block_number as number) < 1
    || (record.proof_block_number as number)
      !== (record.proof_observed_head_block as number)
        - BASE_ECONOMIC_FINALITY_CONFIRMATIONS + 1
    || !Number.isSafeInteger(record.proven_at_block)
    || record.proven_at_block !== (record.proof_observed_head_block as number) + 1
    || typeof record.proof_block_hash !== 'string'
    || !BLOCK_HASH.test(record.proof_block_hash)
    || record.proof_min_confirmations !== BASE_ECONOMIC_FINALITY_CONFIRMATIONS
    || !Array.isArray(record.proof_rpc_operator_ids)
    || record.proof_rpc_operator_ids.length !== 2
    || typeof record.proof_rpc_operator_ids[0] !== 'string'
    || record.proof_rpc_operator_ids[0].length === 0
    || typeof record.proof_rpc_operator_ids[1] !== 'string'
    || record.proof_rpc_operator_ids[1].length === 0
    || record.proof_rpc_operator_ids[0] === record.proof_rpc_operator_ids[1]
    || record.chain !== PROVEN_ADDRESS_CHAIN
    || record.chain_id !== PROVEN_ADDRESS_CHAIN_ID
    || (record.proof_method !== 'eip191_eoa'
      && record.proof_method !== 'eip1271_contract')
    || typeof record.signature_hash !== 'string'
    || !SHA256.test(record.signature_hash)
    || !isProvenAddressProofEvidence(record.proof_evidence)
    || record.proof_evidence.proof_method !== record.proof_method
    || record.proof_evidence.signature_sha256 !== record.signature_hash
    || record.proof_evidence.verified_at_ms !== record.proven_at_ms
    || !Number.isSafeInteger(record.initial_reputation_tier)
    || (record.initial_reputation_tier as number) < 0
    || (record.initial_reputation_tier as number) > 3
    || !Number.isSafeInteger(record.baseline_nonce)
    || (record.baseline_nonce as number) < 0
    || !Number.isSafeInteger(record.created_at)
    || record.created_at !== record.proven_at_ms) {
    return false;
  }
  return true;
}

function canonicalModernRecord(record: ProvenAddressRecord): ProvenAddressRecord {
  const full: ProvenAddressRecord = Object.freeze({
    ...record,
    address: record.address.toLowerCase(),
    proof_block_hash: record.proof_block_hash.toLowerCase(),
    proof_rpc_operator_ids: Object.freeze([
      record.proof_rpc_operator_ids[0],
      record.proof_rpc_operator_ids[1],
    ]) as readonly [string, string],
  });
  if (!isEconomicallyActiveProvenAddress(full, full.address)) {
    throw new Error('proven_address_modern_record_invalid');
  }
  return full;
}

/**
 * Bind a new address, preserve a valid modern binding idempotently, or let the
 * already-bound agent atomically replace an uneconomic legacy row with fresh
 * complete proof evidence. A different agent can never upgrade or take it.
 */
export async function writeProvenAddress(
  db: Firestore,
  record: ProvenAddressRecord,
  options: { coWriteIfMissing?: ProvenAddressAtomicCoWrite } = {},
): Promise<WriteProvenAddressResult> {
  const full = canonicalModernRecord(record);
  const ref = db.collection(PROVEN_ADDRESSES_COLLECTION).doc(full.address);
  const personRef = db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(full.address);
  const nativeRef = db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
    .doc(nativeWalletAddressIndexId(full.address));
  // An address another agent rotated away from stays that agent's (negative control).
  const retiredRef = db.collection(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION).doc(full.address);
  return db.runTransaction(async (txn) => {
    const [snap, personSnap, nativeSnap, retiredSnap, coWriteSnap, activationSnap] = await Promise.all([
      txn.get(ref),
      txn.get(personRef),
      txn.get(nativeRef),
      txn.get(retiredRef),
      options.coWriteIfMissing
        ? txn.get(options.coWriteIfMissing.ref)
        : Promise.resolve(null),
      options.coWriteIfMissing?.activationRef
        ? txn.get(options.coWriteIfMissing.activationRef)
        : Promise.resolve(null),
    ]);
    const activationValue = activationSnap?.exists ? activationSnap.data() : undefined;
    // One address, one owner (2026-10-01): a person's proven address and a
    // Provian wallet's own address can never also be an agent's.
    if (personSnap.exists) return { ok: false, reason: 'address_bound_to_other_owner' };
    if (!snap.exists && nativeSnap.exists) return { ok: false, reason: 'address_is_provian_wallet' };
    if (!snap.exists && retiredSnap.exists
      && (retiredSnap.data() as { agent_id?: unknown } | undefined)?.agent_id !== full.agent_id) {
      return { ok: false, reason: 'address_is_provian_wallet' };
    }
    if (snap.exists) {
      const existingValue: unknown = snap.data();
      if (!hasValidIdentity(existingValue, full.address)) {
        throw new Error('proven_address_existing_identity_invalid');
      }
      if (existingValue.agent_id !== full.agent_id) {
        return { ok: false, reason: 'address_bound_to_other_agent' };
      }
      if (isEconomicallyActiveProvenAddress(existingValue, full.address)) {
        // idempotent; heals a binding that predates the watch registry.
        recordWatchRegistryEntry(txn, db, 'agent_proven', full.address, Date.now());
        if (options.coWriteIfMissing && coWriteSnap && !coWriteSnap.exists) {
          const data = options.coWriteIfMissing.buildData(existingValue, activationValue);
          if (data !== null) txn.set(options.coWriteIfMissing.ref, data);
        }
        return {
          ok: true,
          record: existingValue,
          already_proven: true,
          upgraded_legacy: false,
        };
      }

      // Identity ownership is preserved, but no legacy proof field carries
      // economic authority. The fresh complete record replaces it atomically.
      txn.set(ref, full);
      // the address enters the watch registry in the commit that makes it watchable.
      recordWatchRegistryEntry(txn, db, 'agent_proven', full.address, Date.now());
      if (options.coWriteIfMissing && coWriteSnap && !coWriteSnap.exists) {
        const data = options.coWriteIfMissing.buildData(full, activationValue);
        if (data !== null) txn.set(options.coWriteIfMissing.ref, data);
      }
      return {
        ok: true,
        record: full,
        already_proven: false,
        upgraded_legacy: true,
      };
    }

    txn.set(ref, full);
    // the address enters the watch registry in the commit that makes it watchable.
    recordWatchRegistryEntry(txn, db, 'agent_proven', full.address, Date.now());
    if (options.coWriteIfMissing && coWriteSnap && !coWriteSnap.exists) {
      const data = options.coWriteIfMissing.buildData(full, activationValue);
      if (data !== null) txn.set(options.coWriteIfMissing.ref, data);
    }
    return {
      ok: true,
      record: full,
      already_proven: false,
      upgraded_legacy: false,
    };
  });
}

/**
 * Retained for the retired legacy milestone adapter, but intentionally cannot
 * initialize economic authority. A modern record already has its exact proof-
 * block nonce; a legacy/missing row must re-prove instead.
 */
export async function setProvenAddressBaselineNonce(
  db: Firestore,
  address: string,
  nonce: number,
): Promise<number> {
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error('proven_address_baseline_nonce_invalid');
  }
  const lower = address.toLowerCase();
  const snap = await db.collection(PROVEN_ADDRESSES_COLLECTION).doc(lower).get();
  if (!snap.exists || !isEconomicallyActiveProvenAddress(snap.data(), lower)) {
    throw new Error('proven_address_reproof_required');
  }
  return snap.data()!.baseline_nonce as number;
}

/** Record/history lookup. This intentionally remains able to return legacy
 * identity rows; callers must use listProvenAddresses for economic authority. */
export async function getProvenAddress(
  db: Firestore,
  address: string,
): Promise<ProvenAddressRecord | null> {
  const snap = await db
    .collection(PROVEN_ADDRESSES_COLLECTION)
    .doc(address.toLowerCase())
    .get();
  return snap.exists ? (snap.data() as ProvenAddressRecord) : null;
}

/** Economic watcher enumeration. Well-formed legacy identities are visible
 * through getProvenAddress but intentionally omitted here until owner reproof. */
export async function listProvenAddresses(db: Firestore): Promise<ProvenAddressRecord[]> {
  const snap = await db.collection(PROVEN_ADDRESSES_COLLECTION).get();
  const out: ProvenAddressRecord[] = [];
  for (const doc of snap.docs) {
    const row = provenAddressRowForWatchers(doc.id, doc.data());
    if (row) out.push(row);
  }
  return out;
}

/**
 * the economic watchers' rule for ONE `proven_addresses` row, shared by the full
 * enumeration above and the per-address resolution the watchers run when the chain shows
 * activity: null for a legacy (record-only) identity, a throw for a row that is not a valid
 * identity or not a complete modern record.
 */
export function provenAddressRowForWatchers(documentId: string, value: unknown): ProvenAddressRecord | null {
  if (!hasValidIdentity(value, documentId)) {
    throw new Error(`proven_address_enumeration_invalid:${documentId}`);
  }
  if ((value as Record<string, unknown>).schema_version !== PROVEN_ADDRESS_SCHEMA) {
    // Explicit record-only legacy identity: no baseline can be initialized
    // and no economic watcher receives it.
    return null;
  }
  if (!isEconomicallyActiveProvenAddress(value, documentId)) {
    throw new Error(`proven_address_enumeration_invalid:${documentId}`);
  }
  return value;
}

/** the one `proven_addresses` row for `address`, under the watchers' rule ([] when absent). */
export async function listProvenAddressesFor(db: Firestore, address: string): Promise<ProvenAddressRecord[]> {
  const lower = address.toLowerCase();
  const snap = await db.collection(PROVEN_ADDRESSES_COLLECTION).doc(lower).get();
  if (!snap.exists) return [];
  const row = provenAddressRowForWatchers(lower, snap.data());
  return row ? [row] : [];
}

/**
 * Display-only: does this agent have at least one economically-active proven
 * external address? Powers the "external wallet linked" indicator on the
 * operator's agent cards (GET /v1/relay/agent/sessions).
 *
 * This is NOT the economic enumerator: it never mints, never gates settlement,
 * and — unlike listProvenAddresses — SKIPS legacy/invalid rows rather than
 * throwing, because a single malformed row must not 500 a read endpoint. It
 * still applies the full modern-record validity check, so a legacy identity row
 * or a test/uneconomic binding reads as "not linked".
 */
export async function hasProvenExternalAddress(
  db: Firestore,
  agentId: string,
): Promise<boolean> {
  if (typeof agentId !== 'string' || agentId.length === 0) return false;
  const snap = await db
    .collection(PROVEN_ADDRESSES_COLLECTION)
    .where('agent_id', '==', agentId)
    .get();
  for (const doc of snap.docs) {
    if (isEconomicallyActiveProvenAddress(doc.data(), doc.id)) return true;
  }
  return false;
}

/**
 * A PERSON proves a wallet they already hold (carried
 * 2026-10-01).
 *
 * Until now only an agent could prove an outside address (`proven_addresses`,
 * `link.ts`). A person's proof uses the SAME proof (`verifyExternalAddressControl` * a one-time challenge bound to `person:<user_id>`, the operator-agreed H / H-11
 * fence, EIP-191 for an EOA and EIP-1271 for a contract wallet at the proof
 * block, the baseline nonce at that block) and is recorded in its own registry,
 * `human_proven_addresses/{address}`, so no agent-only consumer of
 * `proven_addresses` changes meaning.
 *
 * Invariants (the operator, verbatim in the run prompt):
 * - Proving pays nothing: the proof receipt (`external_address_proven`) is a
 * record_only row of the matrix for every owner; `fixedEstimatedPVT: 0`.
 * - Activity counts only from the proof forward: `proven_at_block` is the exact
 * H+1 fence every watcher applies.
 * - Transfers between a person's Provian wallet and their proven addresses are
 * same-owner: `same-owner-detection.ts` resolves this registry to the person.
 * - Every watcher attributes a person's proven address to that person.
 *
 * One address, one owner: the writer reads this registry, the agents'
 * `proven_addresses` and the native-wallet index inside one transaction (and the
 * agents' writer reads this registry), so an address is never both a person's
 * and an agent's, nor a Provian wallet's own address.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { recordWatchRegistryEntry } from '../pvt/watch-registry';
import {
  HUMAN_PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESSES_COLLECTION,
  PROVEN_ADDRESS_SCHEMA,
  isEconomicallyActiveProvenAddress,
  type ProvenAddressProofEvidence,
  type ProvenAddressRecord,
} from './link';
import {
  AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION,
  NATIVE_WALLET_ADDRESS_INDEX_COLLECTION,
  nativeWalletAddressIndexId,
} from '../pvt/native-wallet-registration';

export { HUMAN_PROVEN_ADDRESSES_COLLECTION } from './link';
export const HUMAN_PROVEN_ADDRESS_SCHEMA = 'human-proven-address/v1' as const;

export interface HumanProvenAddressRecord {
  readonly schema_version: typeof HUMAN_PROVEN_ADDRESS_SCHEMA;
  readonly economic_eligibility: 'active_go_forward_only';
  /** Lowercased EVM address. Also the Firestore doc id. */
  readonly address: string;
  /** The person who proved control: their `user_id` (the accrual identity). */
  readonly user_id: string;
  /** The person's own Provian wallet doc id (`wallets/{id}`). */
  readonly wallet_id: string;
  readonly proven_at_ms: number;
  /** Exact H+1 go-forward economic fence. */
  readonly proven_at_block: number;
  readonly proof_observed_head_block: number;
  readonly proof_block_number: number;
  readonly proof_block_hash: string;
  readonly proof_min_confirmations: ProvenAddressRecord['proof_min_confirmations'];
  readonly proof_rpc_operator_ids: readonly [string, string];
  readonly chain: ProvenAddressRecord['chain'];
  readonly chain_id: ProvenAddressRecord['chain_id'];
  readonly proof_method: ProvenAddressRecord['proof_method'];
  readonly signature_hash: string;
  readonly proof_evidence: ProvenAddressProofEvidence;
  readonly initial_reputation_tier: number;
  readonly baseline_nonce: number;
  readonly created_at: number;
}

const HUMAN_KEYS = Object.freeze([
  'schema_version', 'economic_eligibility', 'address', 'user_id', 'wallet_id',
  'proven_at_ms', 'proven_at_block', 'proof_observed_head_block', 'proof_block_number',
  'proof_block_hash', 'proof_min_confirmations', 'proof_rpc_operator_ids', 'chain', 'chain_id',
  'proof_method', 'signature_hash', 'proof_evidence', 'initial_reputation_tier', 'baseline_nonce',
  'created_at',
] as const);

/**
 * The full validity check of a person's record: exactly its keys, and every
 * proof field passes the SAME check an agent's v2 record does (the person
 * record is projected onto the agent shape — `user_id` in the `agent_id` slot —
 * and handed to `isEconomicallyActiveProvenAddress`, one validator for both).
 */
export function isEconomicallyActiveHumanProvenAddress(
  value: unknown,
  documentId: string,
): value is HumanProvenAddressRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...HUMAN_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return false;
  if (record.schema_version !== HUMAN_PROVEN_ADDRESS_SCHEMA) return false;
  if (typeof record.user_id !== 'string' || record.user_id.length === 0) return false;
  const { user_id: userId, ...rest } = record;
  const projected = { ...rest, schema_version: PROVEN_ADDRESS_SCHEMA, agent_id: userId };
  return isEconomicallyActiveProvenAddress(projected, documentId);
}

export type WriteHumanProvenAddressResult =
  | { ok: true; record: HumanProvenAddressRecord; already_proven: boolean }
  | { ok: false; reason: 'address_bound_to_other_owner' | 'address_is_provian_wallet' };

/**
 * Bind an address to a person, or return their existing binding idempotently.
 * Refuses an address an agent has proven, one another person has proven, and
 * any Provian wallet's own address.
 */
export async function writeHumanProvenAddress(
  db: Firestore,
  record: HumanProvenAddressRecord,
): Promise<WriteHumanProvenAddressResult> {
  const full: HumanProvenAddressRecord = Object.freeze({
    ...record,
    address: record.address.toLowerCase(),
    proof_block_hash: record.proof_block_hash.toLowerCase(),
    proof_rpc_operator_ids: Object.freeze([
      record.proof_rpc_operator_ids[0],
      record.proof_rpc_operator_ids[1],
    ]) as readonly [string, string],
  });
  if (!isEconomicallyActiveHumanProvenAddress(full, full.address)) {
    throw new Error('human_proven_address_record_invalid');
  }
  const ref = db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).doc(full.address);
  const agentRef = db.collection(PROVEN_ADDRESSES_COLLECTION).doc(full.address);
  const nativeRef = db.collection(NATIVE_WALLET_ADDRESS_INDEX_COLLECTION)
    .doc(nativeWalletAddressIndexId(full.address));
  // An address an agent rotated away from stays that agent's (negative control).
  const retiredRef = db.collection(AGENT_WALLET_ADDRESS_RETIREMENT_COLLECTION).doc(full.address);
  return db.runTransaction(async (txn) => {
    const [snap, agentSnap, nativeSnap, retiredSnap] = await Promise.all([
      txn.get(ref), txn.get(agentRef), txn.get(nativeRef), txn.get(retiredRef),
    ]);
    if (nativeSnap.exists || retiredSnap.exists) return { ok: false, reason: 'address_is_provian_wallet' };
    if (agentSnap.exists) return { ok: false, reason: 'address_bound_to_other_owner' };
    if (snap.exists) {
      const existing: unknown = snap.data();
      const existingUser = (existing as { user_id?: unknown } | undefined)?.user_id;
      if (existingUser !== full.user_id) return { ok: false, reason: 'address_bound_to_other_owner' };
      if (!isEconomicallyActiveHumanProvenAddress(existing, full.address)) {
        // The person's own binding, but not a valid record: an integrity fault,
        // never silently replaced.
        throw new Error('human_proven_address_existing_invalid');
      }
      // idempotent; heals a binding that predates the watch registry.
      recordWatchRegistryEntry(txn, db, 'human_proven', full.address, Date.now());
      return { ok: true, record: existing, already_proven: true };
    }
    txn.set(ref, { ...full });
    // the address enters the watch registry in the commit that makes it watchable.
    recordWatchRegistryEntry(txn, db, 'human_proven', full.address, Date.now());
    return { ok: true, record: full, already_proven: false };
  });
}

/**
 * Economic watcher enumeration of people's proven addresses. Like
 * `listProvenAddresses`, a malformed row throws (the caller decides whether that
 * stops it or sets the row aside); there is no legacy schema to skip.
 */
export async function listHumanProvenAddresses(db: Firestore): Promise<HumanProvenAddressRecord[]> {
  const snap = await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION).get();
  const out: HumanProvenAddressRecord[] = [];
  for (const doc of snap.docs) {
    const value: unknown = doc.data();
    if (!isEconomicallyActiveHumanProvenAddress(value, doc.id)) {
      throw new Error(`human_proven_address_enumeration_invalid:${doc.id}`);
    }
    out.push(value);
  }
  return out;
}

/** One person's valid proven addresses (display and same-owner reads). */
export async function listHumanProvenAddressesForUser(
  db: Firestore,
  userId: string,
): Promise<HumanProvenAddressRecord[]> {
  if (typeof userId !== 'string' || userId.length === 0) return [];
  const snap = await db.collection(HUMAN_PROVEN_ADDRESSES_COLLECTION)
    .where('user_id', '==', userId).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as unknown }))
    .filter((d) => isEconomicallyActiveHumanProvenAddress(d.data, d.id))
    .map((d) => d.data as HumanProvenAddressRecord);
}

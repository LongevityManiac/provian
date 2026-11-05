/**
 * follow-up — THE SOLANA PROVEN-ADDRESS REGISTRY.
 *
 * the operator’s spec: "Every settlement is a relay-witnessed PE for both buyer and seller under the
 * existing pricing and mint-once rules." On Solana that needs what the relay never had: a verified
 * binding from a Solana address to a Provian owner. This module is that binding's ONE store,
 * `solana_proven_addresses/{base58 address}` one document per proven address (per identity,
 * bounded; never per payment), written only by the ed25519 proof (`solana-proof.ts`).
 *
 * ONE ADDRESS, ONE OWNER. A Solana address and an EVM address can never be the same string, so
 * this registry is the single Solana authority: an address an agent proved can never also be a
 * person's or another agent's (409 `address_bound_to_other_owner`), decided inside one Firestore
 * transaction; the same owner re-proving is idempotent (`already_proven`). Provian's own Solana
 * service wallets (the facilitator's fee/gas wallet, the swap treasury) are never anyone's
 * (409 `address_is_provian_service_wallet`).
 *
 * THE FENCE. `proven_at_slot` is the Solana slot the relay read at proof time; only a transaction
 * in a STRICTLY later slot counts for this owner (the Base proof's `H+1` analogue). Proving pays
 * nothing — the proof's receipt is the record_only `external_address_proven` PE.
 *
 * `origin` ('native' = the Provian wallet's own Solana address, derived from the same seed / the
 * agent key; 'external' = a wallet the owner already held) is recorded for display only. It grants
 * nothing and changes no rule.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { isSolanaAddress } from './solana-keys';
import { FACILITATOR_SOLANA_NETWORK } from '../pvt/x402-facilitator-settlement';
import { provianServiceWallets } from '../pvt/provian-service-wallets';

export const SOLANA_PROVEN_ADDRESSES_COLLECTION = 'solana_proven_addresses';
export const SOLANA_PROVEN_ADDRESS_SCHEMA = 'solana-proven-address/v1' as const;
export const SOLANA_PROOF_EVIDENCE_SCHEMA = 'solana-address-control-proof/v1' as const;
export const SOLANA_PROOF_METHOD = 'ed25519' as const;

export type SolanaProvenOwnerType = 'agent' | 'human';
export type SolanaAddressOrigin = 'native' | 'external';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

export interface SolanaProofEvidence {
  readonly schema_version: typeof SOLANA_PROOF_EVIDENCE_SCHEMA;
  readonly challenge_id_sha256: string;
  readonly challenge_message_sha256: string;
  readonly signature_sha256: string;
  readonly proof_method: typeof SOLANA_PROOF_METHOD;
  readonly verified_at_ms: number;
}

export interface SolanaProvenAddressRecord {
  readonly schema_version: typeof SOLANA_PROVEN_ADDRESS_SCHEMA;
  /** Canonical base58. Also the Firestore doc id (case-sensitive; never lowercased). */
  readonly address: string;
  readonly chain: 'solana';
  readonly network: typeof FACILITATOR_SOLANA_NETWORK;
  readonly owner_type: SolanaProvenOwnerType;
  /** The proving agent's `agent_id` (owner_type 'agent'), else null. */
  readonly agent_id: string | null;
  /** The proving person's `user_id` (owner_type 'human'), else null. */
  readonly user_id: string | null;
  /** The agent's native `agent_wallets/{id}`, or the person's `wallets/{id}`. */
  readonly wallet_id: string;
  /** The owner's canonical EVM address at proof time (lowercased). The lane re-reads the live one. */
  readonly owner_evm_address: string;
  readonly origin: SolanaAddressOrigin;
  readonly proven_at_ms: number;
  /** The fence: only a transaction in a slot STRICTLY greater than this counts. */
  readonly proven_at_slot: number;
  readonly proof_method: typeof SOLANA_PROOF_METHOD;
  readonly signature_hash: string;
  readonly proof_evidence: SolanaProofEvidence;
  readonly created_at: number;
}

const RECORD_KEYS = Object.freeze([
  'schema_version', 'address', 'chain', 'network', 'owner_type', 'agent_id', 'user_id', 'wallet_id',
  'owner_evm_address', 'origin', 'proven_at_ms', 'proven_at_slot', 'proof_method', 'signature_hash',
  'proof_evidence', 'created_at',
] as const);

const EVIDENCE_KEYS = Object.freeze([
  'schema_version', 'challenge_id_sha256', 'challenge_message_sha256', 'signature_sha256',
  'proof_method', 'verified_at_ms',
] as const);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, i) => key === canonical[i]);
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

/**
 * Provian's own Solana wallets — never an owner's proven address. Bound to the ONE service-wallet
 * registry (`pvt/provian-service-wallets.ts`: the facilitator fee/gas wallet, the Solana treasury
 * and its USDC fee account, plus whatever the facilitator configuration currently names), never a
 * restated literal.
 */
export function provianSolanaServiceWallets(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): ReadonlySet<string> {
  return provianServiceWallets(env).solana;
}

export function createSolanaProofEvidence(params: {
  readonly challengeId: string;
  readonly challengeMessage: string;
  readonly signature: string;
  readonly verifiedAtMs: number;
}): SolanaProofEvidence {
  const evidence: SolanaProofEvidence = Object.freeze({
    schema_version: SOLANA_PROOF_EVIDENCE_SCHEMA,
    challenge_id_sha256: sha256(params.challengeId),
    challenge_message_sha256: sha256(params.challengeMessage),
    signature_sha256: sha256(params.signature),
    proof_method: SOLANA_PROOF_METHOD,
    verified_at_ms: params.verifiedAtMs,
  });
  if (!isSolanaProofEvidence(evidence)) throw new Error('solana_proof_evidence_invalid');
  return evidence;
}

function isSolanaProofEvidence(value: unknown): value is SolanaProofEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return exactKeys(e, EVIDENCE_KEYS)
    && e.schema_version === SOLANA_PROOF_EVIDENCE_SCHEMA
    && typeof e.challenge_id_sha256 === 'string' && SHA256.test(e.challenge_id_sha256)
    && typeof e.challenge_message_sha256 === 'string' && SHA256.test(e.challenge_message_sha256)
    && typeof e.signature_sha256 === 'string' && SHA256.test(e.signature_sha256)
    && e.proof_method === SOLANA_PROOF_METHOD
    && Number.isSafeInteger(e.verified_at_ms) && (e.verified_at_ms as number) >= 0;
}

/** The full validity check of a registry record. Anything else is not an identity. */
export function isSolanaProvenAddressRecord(
  value: unknown,
  documentId: string,
): value is SolanaProvenAddressRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (!exactKeys(r, RECORD_KEYS)) return false;
  const ownerOk = (r.owner_type === 'agent'
      && typeof r.agent_id === 'string' && r.agent_id.length > 0 && r.agent_id.length <= 200 && r.user_id === null)
    || (r.owner_type === 'human'
      && typeof r.user_id === 'string' && r.user_id.length > 0 && r.user_id.length <= 200 && r.agent_id === null);
  return r.schema_version === SOLANA_PROVEN_ADDRESS_SCHEMA
    && isSolanaAddress(r.address)
    && r.address === documentId
    && r.chain === 'solana'
    && r.network === FACILITATOR_SOLANA_NETWORK
    && ownerOk
    && typeof r.wallet_id === 'string' && r.wallet_id.length > 0
    && typeof r.owner_evm_address === 'string' && EVM_ADDRESS.test(r.owner_evm_address)
    && (r.origin === 'native' || r.origin === 'external')
    && Number.isSafeInteger(r.proven_at_ms) && (r.proven_at_ms as number) >= 0
    && Number.isSafeInteger(r.proven_at_slot) && (r.proven_at_slot as number) > 0
    && r.proof_method === SOLANA_PROOF_METHOD
    && typeof r.signature_hash === 'string' && SHA256.test(r.signature_hash)
    && isSolanaProofEvidence(r.proof_evidence)
    && r.proof_evidence.signature_sha256 === r.signature_hash
    && r.proof_evidence.verified_at_ms === r.proven_at_ms
    && r.created_at === r.proven_at_ms;
}

/** The owner key a record binds to: `agent:<agent_id>` or `human:<user_id>`. */
export function solanaProvenOwnerKey(record: Pick<SolanaProvenAddressRecord, 'owner_type' | 'agent_id' | 'user_id'>): string {
  return record.owner_type === 'agent' ? `agent:${record.agent_id}` : `human:${record.user_id}`;
}

export type WriteSolanaProvenAddressResult =
  | { ok: true; record: SolanaProvenAddressRecord; already_proven: boolean }
  | { ok: false; reason: 'address_bound_to_other_owner' | 'address_is_provian_service_wallet' };

/**
 * Bind a Solana address to its owner, or return the owner's existing binding idempotently.
 * Refuses an address already bound to anyone else and Provian's own service wallets.
 */
export async function writeSolanaProvenAddress(
  db: Firestore,
  record: SolanaProvenAddressRecord,
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): Promise<WriteSolanaProvenAddressResult> {
  const full: SolanaProvenAddressRecord = Object.freeze({
    ...record,
    owner_evm_address: record.owner_evm_address.toLowerCase(),
  });
  if (!isSolanaProvenAddressRecord(full, full.address)) {
    throw new Error('solana_proven_address_record_invalid');
  }
  if (provianSolanaServiceWallets(env).has(full.address)) {
    return { ok: false, reason: 'address_is_provian_service_wallet' };
  }
  const ref = db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION).doc(full.address);
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) {
      const existing: unknown = snap.data();
      const e = existing as Partial<SolanaProvenAddressRecord> | undefined;
      const sameOwner = e?.owner_type === full.owner_type
        && (full.owner_type === 'agent' ? e?.agent_id === full.agent_id : e?.user_id === full.user_id);
      if (!sameOwner) return { ok: false, reason: 'address_bound_to_other_owner' };
      if (!isSolanaProvenAddressRecord(existing, full.address)) {
        // The owner's own binding, but not a valid record: an integrity fault, never replaced.
        throw new Error('solana_proven_address_existing_invalid');
      }
      return { ok: true, record: existing, already_proven: true };
    }
    txn.set(ref, { ...full });
    return { ok: true, record: full, already_proven: false };
  });
}

/** Early refusal (the binding transaction refuses again, authoritatively). */
export async function solanaAddressRefusal(
  db: Firestore,
  owner: { readonly ownerType: SolanaProvenOwnerType; readonly ownerId: string },
  address: string,
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): Promise<'address_bound_to_other_owner' | 'address_is_provian_service_wallet' | null> {
  if (provianSolanaServiceWallets(env).has(address)) return 'address_is_provian_service_wallet';
  const snap = await db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION).doc(address).get();
  if (!snap.exists) return null;
  const e = snap.data() as Partial<SolanaProvenAddressRecord> | undefined;
  const ownerId = e?.owner_type === 'agent' ? e.agent_id : e?.owner_type === 'human' ? e.user_id : undefined;
  return e?.owner_type === owner.ownerType && ownerId === owner.ownerId ? null : 'address_bound_to_other_owner';
}

/** The proven Solana addresses of one owner (display). Invalid rows are skipped, never thrown. */
export async function listSolanaProvenAddressesForOwner(
  db: Firestore,
  owner: { readonly ownerType: SolanaProvenOwnerType; readonly ownerId: string },
): Promise<SolanaProvenAddressRecord[]> {
  if (typeof owner.ownerId !== 'string' || owner.ownerId.length === 0) return [];
  const field = owner.ownerType === 'agent' ? 'agent_id' : 'user_id';
  const snap = await db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION).where(field, '==', owner.ownerId).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as unknown }))
    .filter((d): d is { id: string; data: SolanaProvenAddressRecord } => isSolanaProvenAddressRecord(d.data, d.id))
    .filter((d) => d.data.owner_type === owner.ownerType)
    .map((d) => d.data);
}

/** One record by address, or null when absent. A present-but-invalid record throws (Unknown = Block). */
export async function readSolanaProvenAddress(
  db: Firestore,
  address: string,
): Promise<SolanaProvenAddressRecord | null> {
  const snap = await db.collection(SOLANA_PROVEN_ADDRESSES_COLLECTION).doc(address).get();
  if (!snap.exists) return null;
  const value: unknown = snap.data();
  if (!isSolanaProvenAddressRecord(value, address)) throw new Error('solana_proven_address_invalid');
  return value;
}

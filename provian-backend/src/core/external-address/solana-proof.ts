/**
 * follow-up — ed25519 PROOF OF CONTROL of a Solana address.
 *
 * The Solana twin of the EVM external-address proof (`challenge.ts` + `index.ts`), in the same
 * shape and under the same rules:
 *
 * - A one-time challenge, cache-backed and FAIL-CLOSED, ten minutes, bound to the subject
 * (`<agent_id>`, or `person:<user_id>`) and the exact base58 address. The stored message is
 * server-authoritative. It is consumed (single use) only AFTER the signature verifies and the
 * fence slot is read, so a wrong key or an unavailable RPC never burns the nonce.
 * - The message is DOMAIN-SEPARATED from the EVM one — its first line is
 * "Provian Solana proof of control", never "Provian proof of control" — so a signature over one
 * can never be replayed as the other (and the two schemes differ anyway: EIP-191 secp256k1 vs
 * raw-message ed25519).
 * - The signer signs the raw UTF-8 bytes with ed25519 (Solana wallet `signMessage`); the signature
 * is submitted base58 and verified against the address's own 32-byte public key. Verification
 * uses Node's `crypto` (RFC 8032 Ed25519) — `@noble/curves` v2 is ESM-only and the relay is
 * CommonJS, so it is not loadable here.
 * - THE FENCE. The relay reads the current Solana slot (`getSlot`, commitment `processed` — the
 * newest slot the RPC has seen, the analogue of the Base proof's latest head H, not of its
 * finalized proof-state block) and records it as `proven_at_slot`; only a transaction in a slot
 * STRICTLY greater counts (the H+1 analogue). An unreadable slot fails closed
 * (`head_slot_unavailable`). Reading the newest slot rather than the finalized one can only move
 * the fence later: activity in the ~13 s between the finalized slot and the tip at proof time
 * happened before the proof and must not count.
 * - Proving pays nothing. The receipt is the existing `external_address_proven` PE (record_only
 * for every owner in the matrix), on the owner's own chain, with `chain: 'solana'` and
 * `no_pvt: true`. No matrix row, no template, no Genesis path is touched.
 *
 * The EVM proof is Base-only and is not changed by any of this.
 */

import crypto from 'crypto';
import type { AgentBankDeps } from '../agent-bank/types';
import { generatePE } from '../agent-bank/pe-utils';
import type { PopCacheDeps } from '../agent-wallet/proof-of-possession';
import { PERSON_SUBJECT_PREFIX, personProofSubject } from './challenge';
import { EXTERNAL_ADDRESS_PROVEN_ACTION } from './index';
import { isSolanaAddress, solanaAddressBytes, solanaSignatureBytes } from './solana-keys';
import {
  SOLANA_PROOF_METHOD,
  SOLANA_PROVEN_ADDRESS_SCHEMA,
  createSolanaProofEvidence,
  writeSolanaProvenAddress,
  type SolanaAddressOrigin,
  type SolanaProvenAddressRecord,
} from './solana-link';
import { FACILITATOR_SOLANA_NETWORK, facilitatorSolanaRpcUrl } from '../pvt/x402-facilitator-settlement';

/** Ten minutes, per the `expires` line in the message. */
export const SOLANA_PROOF_TTL_SECONDS = 600;
export const SOLANA_PROOF_MESSAGE_HEADER = 'Provian Solana proof of control';

const CHALLENGE_PREFIX = 'solana_address_proof:';
const REDEMPTION_PREFIX = 'solana_address_proof_redeemed:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[0-9a-f]{32}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

type Env = NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;

// =============================================================================
// THE MESSAGE + CHALLENGE STORE
// =============================================================================

/**
 * The canonical message. Field order is fixed so the stored message and the signer's message are
 * byte-identical. `subjectKey` is an agent id, or `person:<user_id>` (an agent id can never
 * contain ':'), exactly as the EVM proof binds its subject.
 */
export function buildSolanaProofMessage(input: {
  readonly subjectKey: string;
  readonly address: string;
  readonly nonce: string;
  readonly issuedIso: string;
  readonly expiresIso: string;
}): string {
  const subject = input.subjectKey.startsWith(PERSON_SUBJECT_PREFIX)
    ? `person: ${input.subjectKey.slice(PERSON_SUBJECT_PREFIX.length)}`
    : `agent: ${input.subjectKey}`;
  return [
    SOLANA_PROOF_MESSAGE_HEADER,
    subject,
    `address: ${input.address}`,
    `nonce: ${input.nonce}`,
    `issued: ${input.issuedIso}`,
    `expires: ${input.expiresIso}`,
  ].join('\n');
}

export interface SolanaAddressChallenge {
  readonly challenge_id: string;
  /** The exact plaintext the address's key must sign. Server-authoritative. */
  readonly message: string;
  readonly nonce: string;
  readonly issued_at: number;
  readonly expires_at: number;
}

interface StoredSolanaChallenge {
  subject: string;
  address: string;
  nonce: string;
  message: string;
  issued_at: number;
  expires_at: number;
}

const STORED_KEYS = Object.freeze(['address', 'expires_at', 'issued_at', 'message', 'nonce', 'subject'] as const);

function parseStored(value: unknown): StoredSolanaChallenge | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const keys = Object.keys(s).sort();
  if (keys.length !== STORED_KEYS.length || keys.some((k, i) => k !== STORED_KEYS[i])
    || typeof s.subject !== 'string' || s.subject.length === 0 || s.subject.length > 210
    || !isSolanaAddress(s.address)
    || typeof s.nonce !== 'string' || !NONCE.test(s.nonce)
    || typeof s.message !== 'string'
    || !Number.isSafeInteger(s.issued_at) || (s.issued_at as number) < 0
    || !Number.isSafeInteger(s.expires_at)
    || s.expires_at !== (s.issued_at as number) + SOLANA_PROOF_TTL_SECONDS * 1_000
    || (s.expires_at as number) > MAX_DATE_MS) return null;
  const expected = buildSolanaProofMessage({
    subjectKey: s.subject,
    address: s.address as string,
    nonce: s.nonce,
    issuedIso: new Date(s.issued_at as number).toISOString(),
    expiresIso: new Date(s.expires_at as number).toISOString(),
  });
  return s.message === expected ? (s as unknown as StoredSolanaChallenge) : null;
}

/**
 * Issue a one-time challenge bound to (subjectKey, address). Throws `CACHE_UNAVAILABLE` when the
 * cache is down (fail closed) and `invalid_address` for anything but a canonical base58 key.
 */
export async function issueSolanaAddressChallenge(
  cache: PopCacheDeps,
  params: { readonly subjectKey: string; readonly address: string; readonly now?: number },
): Promise<SolanaAddressChallenge> {
  if (cache.isEnabled && !cache.isEnabled()) throw new Error('CACHE_UNAVAILABLE');
  if (!isSolanaAddress(params.address)) throw new Error('invalid_address');
  if (!params.subjectKey || params.subjectKey.length > 210) throw new Error('SOLANA_PROOF_CHALLENGE_INPUT_INVALID');
  const nonce = crypto.randomBytes(16).toString('hex');
  const challengeId = crypto.randomUUID();
  const issuedAt = params.now ?? Date.now();
  const expiresAt = issuedAt + SOLANA_PROOF_TTL_SECONDS * 1_000;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || expiresAt > MAX_DATE_MS) {
    throw new Error('SOLANA_PROOF_CHALLENGE_TIME_INVALID');
  }
  const message = buildSolanaProofMessage({
    subjectKey: params.subjectKey,
    address: params.address,
    nonce,
    issuedIso: new Date(issuedAt).toISOString(),
    expiresIso: new Date(expiresAt).toISOString(),
  });
  const stored: StoredSolanaChallenge = {
    subject: params.subjectKey, address: params.address, nonce, message, issued_at: issuedAt, expires_at: expiresAt,
  };
  await cache.set(CHALLENGE_PREFIX + challengeId, stored, SOLANA_PROOF_TTL_SECONDS);
  return { challenge_id: challengeId, message, nonce, issued_at: issuedAt, expires_at: expiresAt };
}

/** Load + validate a challenge WITHOUT consuming it. */
export async function loadSolanaAddressChallenge(
  cache: PopCacheDeps,
  params: { readonly challengeId: string; readonly subjectKey: string; readonly address: string; readonly now?: number },
): Promise<{ ok: true; message: string } | { ok: false; reason: string }> {
  if (cache.isEnabled && !cache.isEnabled()) return { ok: false, reason: 'cache_unavailable' };
  if (!UUID.test(params.challengeId)) return { ok: false, reason: 'challenge_not_found' };
  const stored = parseStored(await cache.get<StoredSolanaChallenge>(CHALLENGE_PREFIX + params.challengeId));
  if (!stored) return { ok: false, reason: 'challenge_not_found' };
  const now = params.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: 'challenge_time_invalid' };
  if (now >= stored.expires_at) {
    await cache.del(CHALLENGE_PREFIX + params.challengeId).catch(() => {});
    return { ok: false, reason: 'challenge_expired' };
  }
  if (stored.subject !== params.subjectKey) return { ok: false, reason: 'agent_mismatch' };
  // Exact, case-sensitive: base58 is never lowercased.
  if (stored.address !== params.address) return { ok: false, reason: 'address_mismatch' };
  return { ok: true, message: stored.message };
}

/** Single-use consumption, only after a successful verification. False → fail closed. */
export async function consumeSolanaAddressChallenge(cache: PopCacheDeps, challengeId: string): Promise<boolean> {
  if (!UUID.test(challengeId)) return false;
  if (!cache.setNx || !await cache.setNx(REDEMPTION_PREFIX + challengeId, true, SOLANA_PROOF_TTL_SECONDS)) return false;
  await cache.del(CHALLENGE_PREFIX + challengeId).catch(() => undefined);
  return true;
}

// =============================================================================
// ED25519 + THE SLOT
// =============================================================================

/**
 * Verify a base58 ed25519 signature over the raw UTF-8 message against the address's own public
 * key. Any malformed input is simply "not verified".
 */
export function verifySolanaMessageSignature(address: string, message: string, signatureBase58: string): boolean {
  const pub = solanaAddressBytes(address);
  const sig = solanaSignatureBytes(signatureBase58);
  if (pub === null || sig === null) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub)]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

/** The chain read the proof needs. Injectable for tests; production reads the relay's Solana RPC. */
export interface SolanaProofChainDeps {
  /** The newest slot the RPC has seen; throws when it cannot be read. */
  readonly getHeadSlot: () => Promise<number>;
}

export function buildSolanaHeadSlotReader(
  fetchImpl: typeof fetch = fetch,
  env: Env = process.env,
): () => Promise<number> {
  return async () => {
    const res = await fetchImpl(facilitatorSolanaRpcUrl(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'processed' }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json() as { result?: unknown; error?: unknown };
    if (!res.ok || body.error !== undefined || !Number.isSafeInteger(body.result) || (body.result as number) <= 0) {
      throw new Error('solana_slot_unavailable');
    }
    return body.result as number;
  };
}

export function defaultSolanaProofChainDeps(env: Env = process.env): SolanaProofChainDeps {
  return { getHeadSlot: buildSolanaHeadSlotReader(fetch, env) };
}

// =============================================================================
// THE PROOF
// =============================================================================

export type SolanaAddressControlResult =
  | { readonly ok: true; readonly provenAtSlot: number; readonly message: string; readonly provenAtMs: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Load the challenge bound to `subjectKey`, verify the ed25519 signature, read the fence slot, and
 * only then consume the challenge. Nothing is written here.
 */
export async function verifySolanaAddressControl(
  deps: Pick<AgentBankDeps, 'cache'>,
  params: { readonly subjectKey: string; readonly address: string; readonly challengeId: string; readonly signature: string; readonly now?: number },
  chainDeps: SolanaProofChainDeps,
): Promise<SolanaAddressControlResult> {
  if (!isSolanaAddress(params.address)) return { ok: false, reason: 'invalid_address' };
  const loaded = await loadSolanaAddressChallenge(deps.cache, {
    challengeId: params.challengeId, subjectKey: params.subjectKey, address: params.address, now: params.now,
  });
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  if (!verifySolanaMessageSignature(params.address, loaded.message, params.signature)) {
    return { ok: false, reason: 'signature_invalid' };
  }
  let slot: number;
  try {
    slot = await chainDeps.getHeadSlot();
  } catch {
    return { ok: false, reason: 'head_slot_unavailable' };
  }
  if (!Number.isSafeInteger(slot) || slot <= 0) return { ok: false, reason: 'head_slot_unavailable' };
  const provenAtMs = params.now ?? Date.now();
  if (!await consumeSolanaAddressChallenge(deps.cache, params.challengeId)) {
    return { ok: false, reason: 'challenge_consume_failed' };
  }
  return { ok: true, provenAtSlot: slot, message: loaded.message, provenAtMs };
}

/** Who is proving: the authenticated agent or person, resolved by the route — never the body. */
export type SolanaProofOwner =
  | {
    readonly ownerType: 'agent';
    readonly agentId: string;
    /** The agent's native `agent_wallets/{id}`. */
    readonly walletId: string;
    readonly ownerEvmAddress: string;
  }
  | {
    readonly ownerType: 'human';
    readonly userId: string;
    /** The person's own `wallets/{id}`. */
    readonly walletId: string;
    readonly ownerEvmAddress: string;
  };

export function solanaProofSubjectKey(owner: SolanaProofOwner): string {
  return owner.ownerType === 'agent' ? owner.agentId : personProofSubject(owner.userId);
}

export interface ProveSolanaAddressResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly proven_address?: string;
  readonly proven_at?: number;
  readonly proven_at_slot?: number;
  readonly origin?: SolanaAddressOrigin;
  readonly proof_method?: typeof SOLANA_PROOF_METHOD;
  readonly already_proven?: boolean;
  readonly pe_id?: string;
  readonly pe_hash?: string;
}

/** Issue a challenge for the authenticated owner. */
export async function issueSolanaChallengeFor(
  cache: PopCacheDeps,
  owner: SolanaProofOwner,
  address: string,
  now?: number,
): Promise<SolanaAddressChallenge> {
  return issueSolanaAddressChallenge(cache, { subjectKey: solanaProofSubjectKey(owner), address, now });
}

/**
 * The full proof: verify control, bind the address in `solana_proven_addresses`, and seal the
 * record_only `external_address_proven` receipt on the owner's own chain.
 */
export async function proveSolanaAddress(
  deps: AgentBankDeps,
  params: {
    readonly owner: SolanaProofOwner;
    readonly address: string;
    readonly challengeId: string;
    readonly signature: string;
    readonly origin: SolanaAddressOrigin;
    readonly now?: number;
    readonly env?: Env;
  },
  chainDeps: SolanaProofChainDeps = defaultSolanaProofChainDeps(params.env),
): Promise<ProveSolanaAddressResult> {
  const { owner } = params;
  if (!EVM_ADDRESS.test(owner.ownerEvmAddress)) return { ok: false, reason: 'owner_wallet_address_unavailable' };
  const control = await verifySolanaAddressControl(deps, {
    subjectKey: solanaProofSubjectKey(owner),
    address: params.address,
    challengeId: params.challengeId,
    signature: params.signature,
    now: params.now,
  }, chainDeps);
  if (!control.ok) return { ok: false, reason: control.reason };

  const evidence = createSolanaProofEvidence({
    challengeId: params.challengeId,
    challengeMessage: control.message,
    signature: params.signature,
    verifiedAtMs: control.provenAtMs,
  });
  const record: SolanaProvenAddressRecord = {
    schema_version: SOLANA_PROVEN_ADDRESS_SCHEMA,
    address: params.address,
    chain: 'solana',
    network: FACILITATOR_SOLANA_NETWORK,
    owner_type: owner.ownerType,
    agent_id: owner.ownerType === 'agent' ? owner.agentId : null,
    user_id: owner.ownerType === 'human' ? owner.userId : null,
    wallet_id: owner.walletId,
    owner_evm_address: owner.ownerEvmAddress.toLowerCase(),
    origin: params.origin,
    proven_at_ms: control.provenAtMs,
    proven_at_slot: control.provenAtSlot,
    proof_method: SOLANA_PROOF_METHOD,
    signature_hash: evidence.signature_sha256,
    proof_evidence: evidence,
    created_at: control.provenAtMs,
  };
  const write = await writeSolanaProvenAddress(deps.db, record, params.env);
  if (!write.ok) return { ok: false, reason: write.reason };
  const rec = write.record;

  // The receipt: a RECORD on the owner's chain, never money (the matrix row is record_only for
  // every owner). The binding is already written; a failed emission is retryable — a re-proof
  // finds the binding (fence preserved, idempotent) and seals the receipt again.
  try {
    const emitted = await generatePE(deps, {
      walletId: rec.wallet_id,
      agentId: rec.owner_type === 'agent' ? (rec.agent_id as string) : (rec.user_id as string),
      ...(rec.owner_type === 'human' ? { ownerType: 'human' as const } : {}),
      actorAddress: rec.address,
      actionType: EXTERNAL_ADDRESS_PROVEN_ACTION,
      metadata: {
        external_proven: true,
        proven_address: rec.address,
        ...(rec.owner_type === 'agent' ? { attributed_agent_id: rec.agent_id } : { proven_by: 'person' }),
        chain: 'solana',
        network: rec.network,
        origin: rec.origin,
        proof_method: rec.proof_method,
        proven_at_slot: rec.proven_at_slot,
        signature_hash: rec.signature_hash,
        proof_evidence: rec.proof_evidence,
        already_proven: write.already_proven,
        // This PE attributes provenance; it mints no PVT.
        no_pvt: true,
      },
      fixedEstimatedPVT: 0,
    });
    return {
      ok: true,
      proven_address: rec.address,
      proven_at: rec.proven_at_ms,
      proven_at_slot: rec.proven_at_slot,
      origin: rec.origin,
      proof_method: rec.proof_method,
      already_proven: write.already_proven,
      pe_id: emitted.peId,
      pe_hash: emitted.peHash,
    };
  } catch (err) {
    console.warn('[solana-address] proof PE emission failed after binding', {
      address: rec.address,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: 'pe_emission_failed',
      proven_address: rec.address,
      proven_at: rec.proven_at_ms,
      proven_at_slot: rec.proven_at_slot,
      already_proven: write.already_proven,
    };
  }
}

/** Reasons the prove flow can reject, mapped to HTTP status codes. */
export function solanaProofReasonToStatus(reason: string | undefined): number {
  if (reason === 'address_bound_to_other_owner'
    || reason === 'address_is_provian_service_wallet'
    || reason === 'owner_wallet_address_unavailable') return 409;
  if (reason === 'signature_invalid') return 401;
  if (reason === 'head_slot_unavailable' || reason === 'cache_unavailable'
    || reason === 'challenge_consume_failed' || reason === 'pe_emission_failed') return 503;
  return 400;
}

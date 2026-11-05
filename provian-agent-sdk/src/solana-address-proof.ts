import { guardedFetcher } from './guarded-fetch';
/**
 * Solana address proof-of-control (agent-side).
 *
 * Binds a Solana address to this agent on the relay with an ed25519 signature, so
 * the agent's Solana x402 payments and receipts (settled through Provian's x402
 * facilitator) become witnessed PEs attributed to it. Proving pays nothing — the
 * proof is a record_only receipt — and activity counts only from the proof's slot
 * forward.
 *
 *   POST /v1/agent/solana-address/challenge  { address }
 *     -> { challenge_id, message, nonce, issued_at, expires_at }
 *   (check the message, then sign its raw UTF-8 bytes with ed25519; base58 signature)
 *   POST /v1/agent/solana-address/verify     { address, challenge_id, signature, origin }
 *     -> { ok, proven_address, proven_at, proven_at_slot, origin, pe_id, already_proven? }
 *   GET  /v1/agent/solana-addresses
 *
 * Agent API-key auth (`Bearer <api_key>:<api_secret>`), the same as the EVM
 * external-address proof (external-address.ts). The relay takes the agent id from
 * the authenticated wallet, never from the body.
 *
 * Two origins:
 *   - 'native'   — the agent's OWN Solana address: the ed25519 keypair the x402 SVM
 *                  signer derives from the agent's secp256k1 key (chains.ts
 *                  `deriveSolanaEd25519Seed`, the single KDF — no second derivation);
 *   - 'external' — a Solana keypair the agent already holds (a 32-byte seed / 64-byte
 *                  secret key, or a signer callback for an HSM / hardware wallet).
 *
 * THE ONE THING THIS MODULE REFUSES: it never signs a relay-supplied string that is
 * not exactly the six-line Solana proof message naming the address being proven and
 * this agent's own id (`checkSolanaProofMessage`, solana-proof-message.ts). Refusal
 * happens before any key material is touched.
 *
 * Stays on the light path (noble + scure, no @solana/web3.js) so the hosted bootstrap
 * bundle can run it during onboarding.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { deriveSolanaEd25519Seed } from './chains';
import { ProvianError } from './errors';
import {
  checkSolanaProofMessage,
  type SolanaProofMessageBinding,
} from './solana-proof-message';

export {
  SOLANA_PROOF_MESSAGE_HEADER,
  SOLANA_PROOF_MAX_LIFETIME_MS,
  buildSolanaProofMessage,
  checkSolanaProofMessage,
} from './solana-proof-message';
export type {
  SolanaProofSubject,
  SolanaProofChallengeFields,
  SolanaProofMessageBinding,
  SolanaProofMessageVerdict,
} from './solana-proof-message';

export type SolanaProofOrigin = 'native' | 'external';

/** Anything this module refuses or the relay refused. `code` is stable. */
export class SolanaAddressProofError extends ProvianError {
  /** HTTP status when the relay answered; undefined for local refusals. */
  readonly status?: number;
  /** The relay's `error` string, when it sent one. */
  readonly relayError?: string;
  constructor(message: string, code: string, status?: number, relayError?: string) {
    super(message, code);
    this.name = 'SolanaAddressProofError';
    this.status = status;
    this.relayError = relayError;
  }
}

/** Agent API credentials + relay endpoint. */
export interface SolanaAddressProofConfig {
  relayUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Optional fetch override (tests). */
  fetch?: typeof fetch;
}

/** The relay's one-time challenge. NOT trusted until `checkSolanaProofMessage` passes. */
export interface SolanaAddressChallenge {
  challenge_id: string;
  message: string;
  nonce?: string;
  issued_at?: number | string;
  expires_at?: number | string;
}

/** A completed (or already-standing) proof. */
export interface SolanaAddressProof {
  ok: true;
  proven_address: string;
  origin: SolanaProofOrigin;
  proven_at?: number | string;
  proven_at_slot?: number;
  pe_id?: string;
  /** True when the relay already held this binding for this agent (idempotent re-run). */
  already_proven?: boolean;
}

/** One row of GET /v1/agent/solana-addresses. */
export interface ProvenSolanaAddress {
  address: string;
  origin?: string;
  proven_at?: number | string;
  proven_at_slot?: number;
}

const CHALLENGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Relay `error` strings that mean "this binding already stands for YOU" — benign. */
const SAME_OWNER_ERRORS: ReadonlySet<string> = new Set([
  'already_proven',
  'address_already_proven',
  'address_already_bound_to_you',
  'already_bound_to_caller',
]);

function relayBase(config: SolanaAddressProofConfig): string {
  if (!config || typeof config.relayUrl !== 'string' || config.relayUrl.length === 0) {
    throw new SolanaAddressProofError('relayUrl is required', 'SOLANA_PROOF_CONFIG_INVALID');
  }
  return config.relayUrl.replace(/\/+$/, '');
}

function authHeaders(config: SolanaAddressProofConfig): Record<string, string> {
  if (!config.apiKey || !config.apiSecret) {
    throw new SolanaAddressProofError(
      'Agent API key and secret are required (Bearer <api_key>:<api_secret>)',
      'SOLANA_PROOF_AUTH_MISSING',
    );
  }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}:${config.apiSecret}` };
}

/**
 * A base58 Solana address in canonical form (decodes to exactly 32 bytes and
 * re-encodes to itself). Solana addresses are case-sensitive — never lowercased.
 */
export function normalizeSolanaAddress(address: unknown): string {
  if (typeof address !== 'string') {
    throw new SolanaAddressProofError('address must be a base58 Solana address', 'SOLANA_PROOF_ADDRESS_INVALID');
  }
  const trimmed = address.trim();
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(trimmed);
  } catch {
    throw new SolanaAddressProofError('address must be a base58 Solana address', 'SOLANA_PROOF_ADDRESS_INVALID');
  }
  if (bytes.length !== 32 || base58.encode(bytes) !== trimmed) {
    throw new SolanaAddressProofError('address must be a 32-byte base58 Solana address', 'SOLANA_PROOF_ADDRESS_INVALID');
  }
  return trimmed;
}

/** Map a relay refusal to a stable code. */
function refusalCode(status: number, error: string): string {
  if (status === 409 && error === 'address_bound_to_other_owner') return 'SOLANA_ADDRESS_BOUND_TO_OTHER_OWNER';
  if (status === 409 && error === 'address_is_provian_service_wallet') return 'SOLANA_ADDRESS_IS_SERVICE_WALLET';
  if (status === 503) return 'SOLANA_PROOF_UNAVAILABLE';
  if (/signature/i.test(error)) return 'SOLANA_PROOF_SIGNATURE_REJECTED';
  if (status === 401 || status === 403) return 'SOLANA_PROOF_AUTH_REJECTED';
  return 'SOLANA_PROOF_REFUSED';
}

async function call(
  config: SolanaAddressProofConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; ok: boolean; payload: Record<string, unknown> }> {
  const url = `${relayBase(config)}${path}`;
  const fetchImpl = guardedFetcher(config.fetch);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: authHeaders(config),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new SolanaAddressProofError(`Network error calling ${path}: ${(err as Error).message}`, 'SOLANA_PROOF_NETWORK_ERROR');
  }
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return { status: response.status, ok: response.ok, payload };
}

function throwRefusal(path: string, status: number, payload: Record<string, unknown>): never {
  const error = typeof payload.error === 'string' ? payload.error : `http_${status}`;
  throw new SolanaAddressProofError(`${path} refused: ${error}`, refusalCode(status, error), status, error);
}

/** Ask the relay for a one-time challenge for `address`. The result is NOT yet trusted. */
export async function requestSolanaAddressChallenge(
  config: SolanaAddressProofConfig,
  params: { address: string },
): Promise<SolanaAddressChallenge> {
  const address = normalizeSolanaAddress(params?.address);
  const path = '/v1/agent/solana-address/challenge';
  const r = await call(config, 'POST', path, { address });
  if (!r.ok) throwRefusal(path, r.status, r.payload);
  if (typeof r.payload.challenge_id !== 'string' || typeof r.payload.message !== 'string') {
    throw new SolanaAddressProofError('challenge response is malformed', 'SOLANA_PROOF_CHALLENGE_UNTRUSTED');
  }
  return r.payload as unknown as SolanaAddressChallenge;
}

/**
 * Submit the signature. A 409 that says the binding already stands for this agent is
 * returned as `{ ok: true, already_proven: true }`; every other refusal throws.
 */
export async function verifySolanaAddress(
  config: SolanaAddressProofConfig,
  params: { address: string; challengeId: string; signature: string; origin: SolanaProofOrigin },
): Promise<SolanaAddressProof> {
  const address = normalizeSolanaAddress(params?.address);
  if (typeof params?.challengeId !== 'string' || !CHALLENGE_ID.test(params.challengeId)) {
    throw new SolanaAddressProofError('challengeId must be the challenge_id the relay returned', 'SOLANA_PROOF_CHALLENGE_ID_INVALID');
  }
  if (params.origin !== 'native' && params.origin !== 'external') {
    throw new SolanaAddressProofError("origin must be 'native' or 'external'", 'SOLANA_PROOF_ORIGIN_INVALID');
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base58.decode(params.signature);
  } catch {
    throw new SolanaAddressProofError('signature must be base58', 'SOLANA_PROOF_SIGNATURE_INVALID');
  }
  if (sigBytes.length !== 64) {
    throw new SolanaAddressProofError('signature must be a 64-byte ed25519 signature', 'SOLANA_PROOF_SIGNATURE_INVALID');
  }
  const path = '/v1/agent/solana-address/verify';
  const r = await call(config, 'POST', path, {
    address, challenge_id: params.challengeId, signature: params.signature, origin: params.origin,
  });
  if (!r.ok) {
    const error = typeof r.payload.error === 'string' ? r.payload.error : '';
    if (r.status === 409 && SAME_OWNER_ERRORS.has(error)) {
      return { ok: true, proven_address: address, origin: params.origin, already_proven: true };
    }
    throwRefusal(path, r.status, r.payload);
  }
  if (r.payload.ok !== true) {
    const reason = typeof r.payload.error === 'string' ? r.payload.error : 'unknown';
    throw new SolanaAddressProofError(`Solana address proof refused: ${reason}`, 'SOLANA_PROOF_REFUSED', r.status, reason);
  }
  const p = r.payload;
  return {
    ok: true,
    proven_address: typeof p.proven_address === 'string' ? p.proven_address : address,
    origin: p.origin === 'external' || p.origin === 'native' ? p.origin : params.origin,
    ...(typeof p.proven_at === 'number' || typeof p.proven_at === 'string' ? { proven_at: p.proven_at } : {}),
    ...(typeof p.proven_at_slot === 'number' ? { proven_at_slot: p.proven_at_slot } : {}),
    ...(typeof p.pe_id === 'string' ? { pe_id: p.pe_id } : {}),
    ...(p.already_proven === true ? { already_proven: true } : {}),
  };
}

/** The Solana addresses proven to this agent. */
export async function listSolanaAddresses(config: SolanaAddressProofConfig): Promise<ProvenSolanaAddress[]> {
  const path = '/v1/agent/solana-addresses';
  const r = await call(config, 'GET', path);
  if (!r.ok) throwRefusal(path, r.status, r.payload);
  const rows = Array.isArray(r.payload.addresses) ? r.payload.addresses : [];
  return rows.flatMap((row): ProvenSolanaAddress[] => {
    if (!row || typeof row !== 'object') return [];
    const o = row as Record<string, unknown>;
    const address = typeof o.address === 'string' ? o.address : typeof o.proven_address === 'string' ? o.proven_address : null;
    if (address === null) return [];
    return [{
      address,
      ...(typeof o.origin === 'string' ? { origin: o.origin } : {}),
      ...(typeof o.proven_at === 'number' || typeof o.proven_at === 'string' ? { proven_at: o.proven_at } : {}),
      ...(typeof o.proven_at_slot === 'number' ? { proven_at_slot: o.proven_at_slot } : {}),
    }];
  });
}

/**
 * Check a challenge for `address` and this agent, THROWING on refusal. Exported so a
 * caller that signs elsewhere (hardware wallet) gets the same gate.
 */
export function assertSolanaChallengeForAgent(
  challenge: SolanaAddressChallenge,
  params: { address: string; agentId: string; now?: number },
): SolanaProofMessageBinding {
  const verdict = checkSolanaProofMessage(
    challenge,
    { address: normalizeSolanaAddress(params.address), subject: { kind: 'agent', agentId: params.agentId } },
    params.now ?? Date.now(),
  );
  if (!verdict.ok) throw new SolanaAddressProofError(verdict.reason, verdict.code);
  return verdict.binding;
}

/** ed25519-sign the exact UTF-8 bytes of `message` with a 32-byte seed; base58 signature. */
export function signSolanaProofMessage(seed: Uint8Array, message: string): string {
  return base58.encode(ed25519.sign(new TextEncoder().encode(message), seed));
}

/** The 32-byte ed25519 seed from a 32-byte seed or a 64-byte Solana secret key (seed ‖ pubkey). */
function seedFromSecret(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length === 32) return secretKey;
  if (secretKey.length === 64) {
    const seed = secretKey.slice(0, 32);
    const pub = ed25519.getPublicKey(seed);
    if (!pub.every((b, i) => b === secretKey[32 + i])) {
      throw new SolanaAddressProofError('secretKey is not a consistent ed25519 keypair', 'SOLANA_PROOF_KEY_INVALID');
    }
    return seed;
  }
  throw new SolanaAddressProofError('secretKey must be a 32-byte seed or a 64-byte Solana secret key', 'SOLANA_PROOF_KEY_INVALID');
}

/** How an external Solana address's proof is signed. */
export type ExternalSolanaSigner =
  /** The agent holds the key: a 32-byte ed25519 seed or a 64-byte Solana secret key. */
  | { secretKey: Uint8Array; sign?: never }
  /** An HSM / hardware signer: ed25519 over the exact message bytes; returns raw 64 bytes or base58. */
  | { sign: (messageBytes: Uint8Array) => Uint8Array | string | Promise<Uint8Array | string>; secretKey?: never };

async function proveWith(
  config: SolanaAddressProofConfig,
  params: { address: string; agentId: string; origin: SolanaProofOrigin; now?: number },
  produce: (messageBytes: Uint8Array) => Promise<Uint8Array>,
): Promise<SolanaAddressProof> {
  const address = normalizeSolanaAddress(params.address);
  const challenge = await requestSolanaAddressChallenge(config, { address });
  // The gate: nothing is signed unless the message is exactly ours.
  assertSolanaChallengeForAgent(challenge, { address, agentId: params.agentId, now: params.now });
  const messageBytes = new TextEncoder().encode(challenge.message);
  const signature = await produce(messageBytes);
  // Never submit a signature that does not verify against the address being proven.
  if (signature.length !== 64 || !ed25519.verify(signature, messageBytes, base58.decode(address))) {
    throw new SolanaAddressProofError('the signature does not verify against the address being proven', 'SOLANA_PROOF_KEY_MISMATCH');
  }
  return verifySolanaAddress(config, {
    address, challengeId: challenge.challenge_id, signature: base58.encode(signature), origin: params.origin,
  });
}

/**
 * Prove the agent's OWN Solana address (origin 'native'): the ed25519 keypair derived
 * from its secp256k1 wallet key by the same KDF the x402 SVM signer uses. Idempotent:
 * a re-run for an address already bound to this agent resolves `already_proven`.
 *
 * @param params.privateKeyHex  the agent's secp256k1 wallet key (key-per-call; never retained)
 * @param params.agentId        this agent's id, pinned in the message's `agent:` line
 */
export async function proveSolanaAddress(
  config: SolanaAddressProofConfig,
  params: { privateKeyHex: string; agentId: string; now?: number },
): Promise<SolanaAddressProof> {
  let seed: Uint8Array;
  try {
    seed = deriveSolanaEd25519Seed(params.privateKeyHex);
  } catch (err) {
    throw new SolanaAddressProofError(`privateKeyHex is not a usable key: ${(err as Error).message}`, 'SOLANA_PROOF_KEY_INVALID');
  }
  try {
    const address = base58.encode(ed25519.getPublicKey(seed));
    return await proveWith(
      config,
      { address, agentId: params.agentId, origin: 'native', now: params.now },
      async (bytes) => ed25519.sign(bytes, seed),
    );
  } finally {
    seed.fill(0);
  }
}

/**
 * Prove a Solana address the agent already holds (origin 'external'). Pass the key
 * (`secretKey`) or a `sign` callback; either way the signature is checked against the
 * address before it is submitted.
 */
export async function proveExternalSolanaAddress(
  config: SolanaAddressProofConfig,
  params: { address: string; agentId: string; now?: number } & ExternalSolanaSigner,
): Promise<SolanaAddressProof> {
  const address = normalizeSolanaAddress(params?.address);
  const hasKey = params.secretKey instanceof Uint8Array;
  const hasSigner = typeof params.sign === 'function';
  if (hasKey === hasSigner) {
    throw new SolanaAddressProofError('pass exactly one of secretKey or sign', 'SOLANA_PROOF_SIGNER_AMBIGUOUS');
  }
  if (hasKey) {
    const seed = seedFromSecret(params.secretKey as Uint8Array);
    // Fail fast on the wrong key, before a challenge is spent.
    if (base58.encode(ed25519.getPublicKey(seed)) !== address) {
      throw new SolanaAddressProofError('secretKey does not control the address being proven', 'SOLANA_PROOF_KEY_MISMATCH');
    }
    return proveWith(config, { address, agentId: params.agentId, origin: 'external', now: params.now },
      async (bytes) => ed25519.sign(bytes, seed));
  }
  const sign = params.sign as (b: Uint8Array) => Uint8Array | string | Promise<Uint8Array | string>;
  return proveWith(config, { address, agentId: params.agentId, origin: 'external', now: params.now }, async (bytes) => {
    const out = await sign(bytes);
    if (out instanceof Uint8Array) return out;
    if (typeof out === 'string') {
      try { return base58.decode(out); } catch { /* fall through */ }
    }
    throw new SolanaAddressProofError('signer returned neither 64 raw bytes nor a base58 signature', 'SOLANA_PROOF_SIGNATURE_INVALID');
  });
}

/**
 * This agent's id as the relay records it (`GET /v1/agent/wallet/:wallet_id` → agent_id),
 * for callers that do not hold it locally (the catch-up verb). The `agent:` line is still
 * pinned: a challenge naming any other agent is refused.
 */
export async function fetchOwnAgentId(config: SolanaAddressProofConfig, walletId: string): Promise<string> {
  const path = `/v1/agent/wallet/${encodeURIComponent(walletId)}`;
  const r = await call(config, 'GET', path);
  if (!r.ok) throwRefusal(path, r.status, r.payload);
  const agentId = r.payload.agent_id;
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(agentId)) {
    throw new SolanaAddressProofError('the relay did not return a usable agent id', 'SOLANA_PROOF_AGENT_ID_UNAVAILABLE');
  }
  return agentId;
}

/** The outcome shape the best-effort onboarding step reports. Never throws. */
export interface SolanaProofStepResult {
  ok: boolean;
  status?: 'proven' | 'already_proven';
  provenAddress?: string;
  code?: string;
}

/**
 * Best-effort, idempotent native proof for onboarding: never throws. An
 * `already_proven` answer (a 200 with already_proven, or a same-owner 409) is benign.
 */
export async function proveSolanaAddressBestEffort(
  config: SolanaAddressProofConfig,
  params: { privateKeyHex: string; agentId: string; now?: number },
): Promise<SolanaProofStepResult> {
  try {
    const proof = await proveSolanaAddress(config, params);
    return { ok: true, status: proof.already_proven ? 'already_proven' : 'proven', provenAddress: proof.proven_address };
  } catch (err) {
    return { ok: false, code: err instanceof ProvianError ? err.code : 'SOLANA_PROOF_FAILED' };
  }
}

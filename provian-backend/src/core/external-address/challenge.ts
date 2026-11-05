/**
 * External-address proof-of-control - nonce challenge store (Unit 2).
 *
 * An agent proves it controls an arbitrary external EVM address (Coinbase
 * agent wallet, AgentKit, MetaMask, ...) by signing a one-time challenge with
 * that address's key. This module issues + consumes those challenges.
 *
 * The challenge is an EIP-4361 (Sign-In-With-Ethereum) style plaintext message
 * bound to (agent_id, address). The nonce + 10-minute expiry are the replay
 * defense: a captured signature is useless after expiry and the stored message
 * is server-authoritative, so a signature can never be rebound to a different
 * agent or address.
 *
 * Cache-backed (the same `PopCacheDeps` structural interface the agent-wallet
 * proof-of-possession flow uses) and FAIL-CLOSED: if the cache is unavailable,
 * issuance and consumption both refuse. Single-use is enforced by deleting the
 * challenge on a successful proof (the orchestrator deletes only AFTER the
 * signature verifies, so a bad signature does not burn the agent's nonce).
 *
 * IMPORTANT: the signature is an Ethereum EIP-191 / EIP-1271 signature over the
 * stored `message`, NOT the ECDSA-SHA256-over-a-registered-key scheme used by
 * proof-of-possession.ts. We reuse that module's nonce/cache PATTERN, not its
 * crypto - signature verification lives in ./verify.ts.
 */

import crypto from 'crypto';
import type { PopCacheDeps } from '../agent-wallet/proof-of-possession';

/** 10 minutes, per the EIP-4361-style `expires` line in the message. */
export const EXTERNAL_PROOF_TTL_SECONDS = 600;

const CHALLENGE_PREFIX = 'external_address_proof:';
/** The challenge subject key of a person (2026-10-01): `person:<user_id>`. */
export const PERSON_SUBJECT_PREFIX = 'person:';
export function personProofSubject(userId: string): string {
  return `${PERSON_SUBJECT_PREFIX}${userId}`;
}
const CHALLENGE_REDEMPTION_PREFIX = 'external_address_proof_redeemed:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface ExternalAddressChallenge {
  challenge_id: string;
  /** The exact plaintext the agent must sign. Server-authoritative. */
  message: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
}

interface StoredChallenge {
  agent_id: string;
  address: string; // lowercased
  nonce: string;
  message: string;
  issued_at: number;
  expires_at: number;
}

const STORED_CHALLENGE_KEYS = Object.freeze([
  'address',
  'agent_id',
  'expires_at',
  'issued_at',
  'message',
  'nonce',
] as const);

function parseStoredChallenge(value: unknown): StoredChallenge | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  const keys = Object.keys(stored).sort();
  const expected = [...STORED_CHALLENGE_KEYS].sort();
  if (keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || typeof stored.agent_id !== 'string'
    || stored.agent_id.length === 0
    || stored.agent_id.length > 200
    || typeof stored.address !== 'string'
    || !ADDRESS.test(stored.address)
    || typeof stored.nonce !== 'string'
    || !NONCE.test(stored.nonce)
    || typeof stored.message !== 'string'
    || !Number.isSafeInteger(stored.issued_at)
    || (stored.issued_at as number) < 0
    || !Number.isSafeInteger(stored.expires_at)
    || stored.expires_at !== (stored.issued_at as number) + EXTERNAL_PROOF_TTL_SECONDS * 1_000
    || (stored.expires_at as number) > MAX_DATE_MS) return null;
  const issuedAt = stored.issued_at as number;
  const expiresAt = stored.expires_at as number;
  const expectedMessage = buildProofMessage({
    agentId: stored.agent_id,
    address: stored.address,
    nonce: stored.nonce,
    issuedIso: new Date(issuedAt).toISOString(),
    expiresIso: new Date(expiresAt).toISOString(),
  });
  if (stored.message !== expectedMessage) return null;
  return stored as unknown as StoredChallenge;
}

/**
 * Build the canonical EIP-4361-style proof message. Field order is fixed so
 * the stored message and the agent's signed message are byte-identical.
 */
export function buildProofMessage(input: {
  agentId: string;
  address: string;
  nonce: string;
  issuedIso: string;
  expiresIso: string;
}): string {
  // 2026-10-01: a PERSON's challenge is bound to `person:<user_id>` (an agent id
  // can never contain ':' — `/^[a-zA-Z0-9._-]+$/` at creation), and the line the
  // signer reads names a person, not an agent. Agent messages are byte-identical.
  const subject = input.agentId.startsWith(PERSON_SUBJECT_PREFIX)
    ? `person: ${input.agentId.slice(PERSON_SUBJECT_PREFIX.length)}`
    : `agent: ${input.agentId}`;
  return [
    'Provian proof of control',
    subject,
    `address: ${input.address}`,
    `nonce: ${input.nonce}`,
    `issued: ${input.issuedIso}`,
    `expires: ${input.expiresIso}`,
  ].join('\n');
}

/**
 * Issue a one-time proof challenge bound to (agentId, address). Throws
 * `CACHE_UNAVAILABLE` (fail-closed) when the cache is down.
 */
export async function issueExternalAddressChallenge(
  cache: PopCacheDeps,
  params: { agentId: string; address: string; now?: number },
): Promise<ExternalAddressChallenge> {
  if (cache.isEnabled && !cache.isEnabled()) {
    throw new Error('CACHE_UNAVAILABLE');
  }
  const address = params.address.toLowerCase();
  if (!params.agentId || params.agentId.length > 200 || !ADDRESS.test(address)) {
    throw new Error('EXTERNAL_PROOF_CHALLENGE_INPUT_INVALID');
  }
  const nonce = crypto.randomBytes(16).toString('hex'); // 128-bit
  const challengeId = crypto.randomUUID();
  const issuedAt = params.now ?? Date.now();
  const expiresAt = issuedAt + EXTERNAL_PROOF_TTL_SECONDS * 1000;
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0
    || !Number.isSafeInteger(expiresAt) || expiresAt > MAX_DATE_MS) {
    throw new Error('EXTERNAL_PROOF_CHALLENGE_TIME_INVALID');
  }
  const message = buildProofMessage({
    agentId: params.agentId,
    address,
    nonce,
    issuedIso: new Date(issuedAt).toISOString(),
    expiresIso: new Date(expiresAt).toISOString(),
  });
  const stored: StoredChallenge = {
    agent_id: params.agentId,
    address,
    nonce,
    message,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  await cache.set(CHALLENGE_PREFIX + challengeId, stored, EXTERNAL_PROOF_TTL_SECONDS);
  return { challenge_id: challengeId, message, nonce, issued_at: issuedAt, expires_at: expiresAt };
}

export type LoadChallengeResult =
  | { ok: true; message: string }
  | { ok: false; reason: string };

/**
 * Load + validate a challenge WITHOUT consuming it. Confirms it exists, is
 * unexpired, and was issued for this exact (agentId, address). Returns the
 * server-stored message to verify the signature against. Does not delete, so
 * the caller verifies the signature first and only then consumes (a bad
 * signature must not burn the agent's nonce).
 */
export async function loadExternalAddressChallenge(
  cache: PopCacheDeps,
  params: { challengeId: string; agentId: string; address: string; now?: number },
): Promise<LoadChallengeResult> {
  if (cache.isEnabled && !cache.isEnabled()) {
    return { ok: false, reason: 'cache_unavailable' };
  }
  if (!UUID.test(params.challengeId)) return { ok: false, reason: 'challenge_not_found' };
  const stored = parseStoredChallenge(
    await cache.get<StoredChallenge>(CHALLENGE_PREFIX + params.challengeId),
  );
  if (!stored) {
    return { ok: false, reason: 'challenge_not_found' };
  }
  const now = params.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: 'challenge_time_invalid' };
  }
  if (now >= stored.expires_at) {
    // Expired - best-effort purge so it can't linger.
    await cache.del(CHALLENGE_PREFIX + params.challengeId).catch(() => {});
    return { ok: false, reason: 'challenge_expired' };
  }
  if (stored.agent_id !== params.agentId) {
    return { ok: false, reason: 'agent_mismatch' };
  }
  if (stored.address !== params.address.toLowerCase()) {
    return { ok: false, reason: 'address_mismatch' };
  }
  return { ok: true, message: stored.message };
}

/**
 * Delete a challenge (single-use consumption). Called only after a successful
 * signature verification. Returns false if the delete failed so the caller can
 * fail closed rather than risk replay.
 */
export async function consumeExternalAddressChallenge(
  cache: PopCacheDeps,
  challengeId: string,
): Promise<boolean> {
  if (!UUID.test(challengeId)) return false;
  if (!cache.setNx || !await cache.setNx(
    CHALLENGE_REDEMPTION_PREFIX + challengeId,
    true,
    EXTERNAL_PROOF_TTL_SECONDS,
  )) return false;
  await cache.del(CHALLENGE_PREFIX + challengeId).catch(() => undefined);
  return true;
}

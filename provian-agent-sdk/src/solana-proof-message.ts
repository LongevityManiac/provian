/**
 * The Solana proof-of-control MESSAGE check — pure, dependency-free.
 *
 * The relay binds a Solana address to its owner with an ed25519 signature over a
 * six-line UTF-8 message it issues:
 *
 *   Provian Solana proof of control
 *   agent: <agent_id>          (person: <user_id> on the person route)
 *   address: <base58 address>
 *   nonce: <32 lowercase hex>
 *   issued: <ISO-8601>
 *   expires: <ISO-8601>
 *
 * ("\n"-joined, no trailing newline). The relay RETURNS that exact message; the
 * signer signs the server's bytes. This module is the one gate in front of the
 * signing key: it refuses any message that is not exactly this shape, that names
 * an address other than the one being proven, or whose subject line is not the
 * expected one (`agent: <own agent id>`, or a `person:` line). A wallet key never
 * signs an arbitrary relay-supplied string.
 *
 * Mirrored in the app (`src/core/chains/solana/solanaProofMessage.ts`); the app's
 * parity test runs both against the same vectors.
 */

export const SOLANA_PROOF_MESSAGE_HEADER = 'Provian Solana proof of control';

/** A challenge's lifetime above this is refused (the relay's TTL is minutes). */
export const SOLANA_PROOF_MAX_LIFETIME_MS = 60 * 60 * 1000;

/** No message we would sign is anywhere near this long. */
const MAX_MESSAGE_LENGTH = 1024;
const MAX_SUBJECT_ID_LENGTH = 200;
const NONCE = /^[0-9a-f]{32}$/;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** An agent id as the relay admits it at creation (`/^[a-zA-Z0-9._-]+$/`). */
const AGENT_ID = /^[A-Za-z0-9._-]{1,200}$/;
/** A person's subject id: printable ASCII, no spaces. */
const PERSON_ID = /^[\x21-\x7e]{1,200}$/;

/** Whose proof this is: an agent (its own id, pinned) or a person (any well-formed id, optionally pinned). */
export type SolanaProofSubject =
  | { kind: 'agent'; agentId: string }
  | { kind: 'person'; userId?: string };

/** The fields of a challenge the check reads. `message` is server-authoritative. */
export interface SolanaProofChallengeFields {
  message: unknown;
  nonce?: unknown;
  issued_at?: unknown;
  expires_at?: unknown;
}

/** What a message that passed every check binds. */
export interface SolanaProofMessageBinding {
  subjectLine: string;
  address: string;
  nonce: string;
  issuedIso: string;
  expiresIso: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type SolanaProofMessageVerdict =
  | { ok: true; binding: SolanaProofMessageBinding }
  | { ok: false; code: 'SOLANA_PROOF_CHALLENGE_UNTRUSTED' | 'SOLANA_PROOF_CHALLENGE_EXPIRED'; reason: string };

/** Rebuild the canonical message from its parts (field order fixed). */
export function buildSolanaProofMessage(parts: {
  subjectLine: string; address: string; nonce: string; issuedIso: string; expiresIso: string;
}): string {
  return [
    SOLANA_PROOF_MESSAGE_HEADER,
    parts.subjectLine,
    `address: ${parts.address}`,
    `nonce: ${parts.nonce}`,
    `issued: ${parts.issuedIso}`,
    `expires: ${parts.expiresIso}`,
  ].join('\n');
}

/** A strict ISO-8601 instant: parses AND round-trips through toISOString (so no free-form dates). */
function isoInstantMs(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === value ? ms : null;
}

/** A challenge's own timestamp field (epoch ms or ISO string) as ms; undefined when absent. */
function fieldMs(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function untrusted(reason: string): SolanaProofMessageVerdict {
  return { ok: false, code: 'SOLANA_PROOF_CHALLENGE_UNTRUSTED', reason };
}

/**
 * Check a relay challenge before signing it. Never throws; returns a verdict.
 *
 * @param challenge  the relay's challenge response, as received
 * @param expected.address  the base58 address the caller is proving (its OWN address)
 * @param expected.subject  the expected subject line
 * @param now  clock (ms)
 */
export function checkSolanaProofMessage(
  challenge: SolanaProofChallengeFields | null | undefined,
  expected: { address: string; subject: SolanaProofSubject },
  now: number = Date.now(),
): SolanaProofMessageVerdict {
  if (!challenge || typeof challenge !== 'object') return untrusted('challenge response was not an object');
  const message = challenge.message;
  if (typeof message !== 'string' || message.length === 0) return untrusted('challenge message is missing');
  if (message.length > MAX_MESSAGE_LENGTH) return untrusted('challenge message is too long');
  if (typeof expected?.address !== 'string' || !BASE58_ADDRESS.test(expected.address)) {
    return untrusted('the address being proven is not a base58 Solana address');
  }

  const lines = message.split('\n');
  if (lines.length !== 6) return untrusted('challenge message is not six lines');
  if (lines[0] !== SOLANA_PROOF_MESSAGE_HEADER) return untrusted('challenge message does not open with the Solana proof header');

  // Subject line.
  const subjectLine = lines[1];
  const subject = expected.subject;
  if (subject?.kind === 'agent') {
    if (typeof subject.agentId !== 'string' || !AGENT_ID.test(subject.agentId)) {
      return untrusted('this agent has no usable agent id to check the message against');
    }
    if (subjectLine !== `agent: ${subject.agentId}`) return untrusted('challenge message names a different agent');
  } else if (subject?.kind === 'person') {
    if (!subjectLine.startsWith('person: ')) return untrusted('challenge message does not name a person');
    const id = subjectLine.slice('person: '.length);
    if (!PERSON_ID.test(id) || id.length > MAX_SUBJECT_ID_LENGTH) return untrusted('challenge message carries no usable person id');
    if (subject.userId !== undefined && id !== subject.userId) return untrusted('challenge message names a different person');
  } else {
    return untrusted('no expected subject');
  }

  // Address line: pinned to the caller's own address (never read out of the message).
  if (lines[2] !== `address: ${expected.address}`) return untrusted('challenge message names a different address');

  // Nonce line.
  if (!lines[3].startsWith('nonce: ')) return untrusted('challenge message has no nonce line');
  const nonce = lines[3].slice('nonce: '.length);
  if (!NONCE.test(nonce)) return untrusted('challenge nonce is not 128 bits of lowercase hex');
  if (challenge.nonce !== undefined && challenge.nonce !== nonce) return untrusted('challenge nonce does not match its message');

  // Time lines.
  if (!lines[4].startsWith('issued: ') || !lines[5].startsWith('expires: ')) {
    return untrusted('challenge message has no issued/expires lines');
  }
  const issuedIso = lines[4].slice('issued: '.length);
  const expiresIso = lines[5].slice('expires: '.length);
  const issuedAtMs = isoInstantMs(issuedIso);
  const expiresAtMs = isoInstantMs(expiresIso);
  if (issuedAtMs === null || expiresAtMs === null) return untrusted('challenge times are not ISO-8601 instants');
  if (expiresAtMs <= issuedAtMs) return untrusted('challenge expires before it was issued');
  if (expiresAtMs - issuedAtMs > SOLANA_PROOF_MAX_LIFETIME_MS) return untrusted('challenge lifetime is longer than a proof challenge lives');
  const fieldIssued = fieldMs(challenge.issued_at);
  const fieldExpires = fieldMs(challenge.expires_at);
  if (fieldIssued === null || fieldExpires === null) return untrusted('challenge timestamps are malformed');
  if (fieldIssued !== undefined && fieldIssued !== issuedAtMs) return untrusted('challenge issued_at does not match its message');
  if (fieldExpires !== undefined && fieldExpires !== expiresAtMs) return untrusted('challenge expires_at does not match its message');
  if (!Number.isFinite(now) || now >= expiresAtMs) {
    return { ok: false, code: 'SOLANA_PROOF_CHALLENGE_EXPIRED', reason: 'challenge is already expired' };
  }

  const binding: SolanaProofMessageBinding = {
    subjectLine, address: expected.address, nonce, issuedIso, expiresIso, issuedAtMs, expiresAtMs,
  };
  // The one equality that carries the check: the message must be EXACTLY the canonical rebuild
  // (no trailing newline, no carriage return, no extra whitespace anywhere).
  if (buildSolanaProofMessage(binding) !== message) return untrusted('challenge message is not the canonical form');
  return { ok: true, binding };
}

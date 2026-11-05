/**
 * Email suppression + one-click unsubscribe tokens.
 *
 * Real suppression, not a stub (audit 2026-08-05, finding 17). Every marketing
 * invite (`sendAgentInvite`, `sendBeneficiaryInvite`) now carries a signed,
 * per-recipient unsubscribe link. Clicking it — or an email client auto-POSTing
 * the RFC 8058 `List-Unsubscribe-Post` header — records the address in the
 * `email_suppressions` collection, and the send path consults that collection
 * before every marketing send. Transactional mail the user requested
 * (`sendConnectCommand`) is exempt and carries no unsubscribe link, per CAN-SPAM.
 *
 * PRIVACY. The suppression document is keyed by `sha256(lowercased email)` and
 * stores only that hash + metadata — never the raw address. The collection is
 * therefore not a reversible mailing list; it answers exactly one question
 * ("is this address suppressed?") and nothing else.
 *
 * FAIL CLOSED. The token is HMAC-signed with `UNSUBSCRIBE_TOKEN_SECRET`. When the
 * secret is unset, `signUnsubscribeToken` returns null and the caller MUST NOT
 * send the marketing email — "no invite email goes out before a working
 * unsubscribe exists." `verifyUnsubscribeToken` likewise returns null, so the
 * endpoint refuses. A tampered or wrong-secret token never verifies.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';

export const EMAIL_SUPPRESSION_COLLECTION = 'email_suppressions';

const TOKEN_SECRET_ENV = 'UNSUBSCRIBE_TOKEN_SECRET';
/** Domain separation: the HMAC input is prefixed so the signature is only ever
 * valid as an unsubscribe token, never reusable for any other purpose. */
const TOKEN_PURPOSE = 'provian-unsubscribe-v1';
/** A secret shorter than this is treated as absent (fail closed). */
const MIN_SECRET_LENGTH = 16;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailHash(email: string): string {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function unsubscribeSecret(): string | null {
  const secret = process.env[TOKEN_SECRET_ENV];
  if (typeof secret !== 'string') return null;
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/**
 * True when the unsubscribe machinery is fully configured. The marketing-email
 * senders gate on this: unconfigured means no unsubscribe link can be minted, so
 * no marketing email is sent.
 */
export function isUnsubscribeConfigured(): boolean {
  return unsubscribeSecret() !== null;
}

/** Sign a per-recipient unsubscribe token, or null when unconfigured. */
export function signUnsubscribeToken(email: string): string | null {
  const secret = unsubscribeSecret();
  if (!secret) return null;
  const normalized = normalizeEmail(email);
  if (normalized.length === 0) return null;
  const payload = Buffer.from(normalized, 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${TOKEN_PURPOSE}:${normalized}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

/** Verify a token and return the normalized email it authorizes, or null. */
export function verifyUnsubscribeToken(token: string): string | null {
  const secret = unsubscribeSecret();
  if (!secret) return null;
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  let normalized: string;
  try {
    normalized = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (normalized.length === 0 || normalized !== normalizeEmail(normalized)) return null;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${TOKEN_PURPOSE}:${normalized}`)
    .digest('base64url');
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;
  return normalized;
}

export async function isEmailSuppressed(db: Firestore, email: string): Promise<boolean> {
  const snap = await db.collection(EMAIL_SUPPRESSION_COLLECTION).doc(emailHash(email)).get();
  return snap.exists;
}

/** Idempotent: re-suppressing an already-suppressed address is a no-op merge. */
export async function suppressEmail(
  db: Firestore,
  email: string,
  source: string,
): Promise<void> {
  const hash = emailHash(email);
  await db.collection(EMAIL_SUPPRESSION_COLLECTION).doc(hash).set(
    {
      email_hash: hash,
      suppressed_at: Date.now(),
      source,
    },
    { merge: true },
  );
}

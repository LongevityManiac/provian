/**
 * — the shared secret Provian's x402 facilitator presents to the relay
 * (`Authorization: Bearer <FACILITATOR_RELAY_SECRET>`; Secret Manager `facilitator-relay-secret`).
 *
 * Fail closed: an unset (or too-short) secret answers `unconfigured` (the route returns 503) and
 * nothing is compared. The comparison hashes both sides to equal-length digests first, so
 * `timingSafeEqual` never throws on a length mismatch and the compare leaks no length.
 */

import crypto from 'crypto';

export const FACILITATOR_RELAY_SECRET_ENV = 'FACILITATOR_RELAY_SECRET';
/** A secret shorter than this is treated as unset (a typo'd or placeholder value never authenticates). */
export const FACILITATOR_RELAY_SECRET_MIN_LENGTH = 32;

export type FacilitatorRelayAuth = 'ok' | 'unconfigured' | 'denied';

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export function verifyFacilitatorRelaySecret(
  authorization: string | undefined,
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): FacilitatorRelayAuth {
  const secret = env[FACILITATOR_RELAY_SECRET_ENV];
  if (typeof secret !== 'string' || secret.length < FACILITATOR_RELAY_SECRET_MIN_LENGTH) return 'unconfigured';
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return 'denied';
  const presented = authorization.slice('Bearer '.length);
  if (presented.length === 0) return 'denied';
  return crypto.timingSafeEqual(digest(presented), digest(secret)) ? 'ok' : 'denied';
}

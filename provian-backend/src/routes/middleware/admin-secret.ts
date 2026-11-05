/**
 * Admin Secret Comparison Helper
 *
 * Constant-time comparison for shared admin secrets (AGENT_BANK_ADMIN_SECRET,
 * SCHEDULER_SECRET, etc). Centralizes the timingSafeEqual + length-check
 * pattern so every admin-secret-protected endpoint goes through one
 * implementation. Using `===` against the secret leaks bytes via timing,
 * which is why this helper exists.
 */

import crypto from 'crypto';

/**
 * Constant-time compare a caller-provided secret against an expected secret.
 *
 * Returns false if either side is missing, the types are wrong, or the
 * lengths differ. Otherwise compares with crypto.timingSafeEqual.
 *
 * BYTE-LENGTH SAFE (F1). The gate MUST compare UTF-8 BYTE lengths, not JS
 * `.length` (UTF-16 code units). Node decodes an incoming header as latin1, so
 * a header byte 0x80-0xFF is one JS char but two UTF-8 bytes; when the char
 * count equals the secret's `.length`, `Buffer.from(provided)` and
 * `Buffer.from(expected)` have DIFFERENT byte lengths and `timingSafeEqual`
 * throws `RangeError [ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH]`. In an async
 * handler that throw becomes an unhandled rejection that (Node's default) exits
 * the process — an unauthenticated remote crash. Mirror the already-correct
 * copy in the tree (routes/admin-pvt-policy.ts):
 * build both buffers first and gate on their byte lengths so timingSafeEqual is
 * only ever handed equal-length inputs. Never throws for any header value.
 */
export function safeSecretCompare(
  provided: string | string[] | undefined,
  expected: string | undefined,
): boolean {
  if (!provided || !expected || typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

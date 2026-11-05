/**
 * connection-token-format — the canonical human→agent connection-code shape,
 * mirrored on the SDK side.
 *
 * A connection code is what the phone mints on "Invite an agent" and hands to the
 * agent; the agent presents it back (as `connectionToken`) when it onboards. The
 * relay owns the single source of truth (`provian-backend/src/core/connection-token-format.ts`),
 * but the SDK is a separate published package and cannot import across it, so this
 * module MIRRORS that exact shape. Both sides must agree.
 *
 * THE 14-vs-16 TRAP (do not reintroduce): a real code is a 14-char `PROV-XXXX-XXXX`,
 * but validators here and in the relay historically guarded with
 * `/^[A-Za-z0-9_-]{16,256}$/`, whose 16-char minimum REJECTS every real code before
 * any lookup. The relay resolvers were fixed to delegate to `isValidConnectionTokenFormat`;
 * the SDK durable-registration snapshot validator (`pending-wallet-registration.ts`)
 * had NOT been, so a persisted `connectionToken` failed on resume. This module closes
 * that gap — validate against the canonical shape, never a hand-rolled length regex.
 */

/**
 * Crockford-style alphabet: 32 symbols, no 0/O or 1/I, so a human can read a code
 * aloud without ambiguity. None of these characters is regex-special.
 */
export const CONNECTION_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const GROUP = `[${CONNECTION_TOKEN_ALPHABET}]{4}`;

/** Exact canonical shape: `PROV-XXXX-XXXX` (14 chars, two 4-symbol groups). */
export const CONNECTION_TOKEN_PATTERN = new RegExp(`^PROV-${GROUP}-${GROUP}$`);

/** The full character length of a canonical code (`PROV-` + 4 + `-` + 4). */
export const CONNECTION_TOKEN_LENGTH = 14;

/**
 * True iff `token` is a well-formed connection code. Use this as the guard
 * everywhere the SDK accepts a connection token — never a hand-rolled length/charset
 * regex, which is exactly how the 14-vs-16 defect got in.
 */
export function isValidConnectionTokenFormat(token: unknown): token is string {
  return typeof token === 'string' && CONNECTION_TOKEN_PATTERN.test(token);
}

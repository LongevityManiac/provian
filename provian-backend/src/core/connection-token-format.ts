

import crypto from 'crypto';

/**
 * Crockford-style alphabet: 32 symbols, no 0/O or 1/I, so a human can read a
 * code aloud without ambiguity. None of these characters is regex-special, so
 * it embeds directly in the character class below.
 */
export const CONNECTION_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const GROUP = `[${CONNECTION_TOKEN_ALPHABET}]{4}`;

/** Exact canonical shape: `PROV-XXXX-XXXX` (14 chars, two 4-symbol groups). */
export const CONNECTION_TOKEN_PATTERN = new RegExp(`^PROV-${GROUP}-${GROUP}$`);

/** The full character length of a canonical code (`PROV-` + 4 + `-` + 4). */
export const CONNECTION_TOKEN_LENGTH = 14;

/**
 * True iff `token` is a well-formed connection code. Use this as the pre-lookup
 * guard in every resolver — never a hand-rolled length/charset regex.
 */
export function isValidConnectionTokenFormat(token: unknown): token is string {
  return typeof token === 'string' && CONNECTION_TOKEN_PATTERN.test(token);
}

/**
 * Mint a fresh connection code. The ONLY minter — every code in the system comes
 * from here, which is what lets the resolvers guard on the exact format above.
 */
export function generateConnectionToken(): string {
  const bytes = crypto.randomBytes(8);
  let token = 'PROV-';
  for (let i = 0; i < 4; i++) {
    token += CONNECTION_TOKEN_ALPHABET[bytes[i] % CONNECTION_TOKEN_ALPHABET.length];
  }
  token += '-';
  for (let i = 4; i < 8; i++) {
    token += CONNECTION_TOKEN_ALPHABET[bytes[i] % CONNECTION_TOKEN_ALPHABET.length];
  }
  return token;
}

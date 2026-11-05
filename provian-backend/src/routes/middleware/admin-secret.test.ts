/**
 * Audit 2026-08-05 (finding 8) — the AgentBank admin auth gate.
 *
 * Every x-admin-secret route (escrow dispute-resolve, /v1/admin/health, court
 * panel-assign) authenticates with `safeSecretCompare(header, AGENT_BANK_ADMIN_SECRET)`.
 * The finding: the secret was never mounted, so `expected` was undefined and the gate
 * returned false for EVERY request — the routes were permanently 401-dead. These controls
 * prove (a) the missing-secret dead state, and (b) that a mounted secret admits the exact
 * value and rejects everything else, so mounting `agent-bank-admin-secret` lights the routes.
 */
import { describe, expect, it } from '@jest/globals';

import { safeSecretCompare } from './admin-secret';

describe('safeSecretCompare — the admin auth gate (finding 8)', () => {
  const SECRET = 'a'.repeat(48);

  // RED / the dead state the finding fixes: with the secret UNMOUNTED, every call is refused,
  // so the admin routes 401 no matter what header a caller sends.
  it('refuses EVERY request when the secret is not mounted (expected undefined)', () => {
    expect(safeSecretCompare(SECRET, undefined)).toBe(false);
    expect(safeSecretCompare('', undefined)).toBe(false);
    expect(safeSecretCompare(undefined, undefined)).toBe(false);
  });

  it('admits the exact mounted secret and rejects everything else', () => {
    // Mounted + matching header → authorized.
    expect(safeSecretCompare(SECRET, SECRET)).toBe(true);
    // Wrong value of the same length → rejected (a real compare, not a length-only check).
    expect(safeSecretCompare('b'.repeat(48), SECRET)).toBe(false);
    // Wrong length → rejected before the timing-safe compare.
    expect(safeSecretCompare(`${SECRET}x`, SECRET)).toBe(false);
    // Missing / malformed header → rejected.
    expect(safeSecretCompare(undefined, SECRET)).toBe(false);
    expect(safeSecretCompare('', SECRET)).toBe(false);
    expect(safeSecretCompare([SECRET], SECRET)).toBe(false); // header arrays are not accepted
  });

  // F1 — the unauthenticated remote-crash RED control. A header whose UTF-16
  // char length EQUALS the secret's but whose UTF-8 BYTE length differs (a high
  // byte 0x80-0xFF is one JS char, two UTF-8 bytes) used to reach
  // crypto.timingSafeEqual with mismatched buffer lengths and throw a RangeError
  // — an uncaught rejection that crashed the process. It MUST now return false,
  // never throw.
  it('RED: a latin1-byte header of equal char-length returns false, never throws (F1)', () => {
    const S32 = 'a'.repeat(32);
    // 'é' is ONE JS char but TWO UTF-8 bytes → 32 chars, 33 bytes vs the 32-byte secret.
    const provided = 'é' + 'a'.repeat(31);
    expect(provided.length).toBe(S32.length); // char lengths match — the old length gate passed
    expect(() => safeSecretCompare(provided, S32)).not.toThrow();
    expect(safeSecretCompare(provided, S32)).toBe(false);

    // Sweep the byte-length attack across a range of secret lengths: none throws.
    for (let n = 1; n <= 64; n++) {
      const secret = 'a'.repeat(n);
      const attack = 'ÿ' + 'a'.repeat(n - 1); // 0xFF, one char, two UTF-8 bytes
      expect(() => safeSecretCompare(attack, secret)).not.toThrow();
      expect(safeSecretCompare(attack, secret)).toBe(false);
    }
  });

  // A multibyte secret still admits its own exact value (byte compare is correct,
  // not just crash-safe).
  it('a multibyte secret admits its exact value and rejects a byte-length collision', () => {
    const secret = 'café' + 'z'.repeat(28); // 32 chars, 33 bytes
    expect(safeSecretCompare(secret, secret)).toBe(true);
    expect(safeSecretCompare('cafe' + 'z'.repeat(29), secret)).toBe(false); // 33 chars, 33 bytes, different content
  });
});

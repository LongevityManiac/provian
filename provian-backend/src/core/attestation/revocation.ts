/**
 * Revocation check for an Android attestation chain.
 *
 * Google publishes a single status list of all non-valid (REVOKED / SUSPENDED)
 * attestation keys, keyed by certificate serial number, at
 * https://android.googleapis.com/attestation/status. A key absent from the list
 * is valid. This module checks each chain serial against an INJECTED source so
 * the core stays pure; production wraps a cached fetch (see adapter.ts).
 *
 * Fail-closed: if the source is unavailable we return REVOCATION_UNAVAILABLE so
 * the verifier refuses to promote - per "Unknown = Block, Not Warn", an
 * unverifiable revocation status must never read as "not revoked".
 */
import type { RevocationStatusSource, AndroidAttestationFailure } from './types';
import { failure } from './types';

/**
 * Normalize a certificate serial to the form Google's status list uses:
 * lowercase hex, no leading zeros, no `0x` prefix. @peculiar/x509 returns the
 * serial as a hex string that may carry leading zeros; routing it through
 * BigInt canonicalizes both representations so a revoked serial cannot slip
 * through on a formatting mismatch.
 */
export function normalizeSerial(serialHex: string): string {
  const clean = serialHex.startsWith('0x') ? serialHex.slice(2) : serialHex;
  // BigInt parse strips leading zeros and lowercases; empty/invalid -> '0'.
  try {
    return BigInt('0x' + (clean.length === 0 ? '0' : clean)).toString(16);
  } catch {
    return clean.toLowerCase().replace(/^0+(?=.)/, '');
  }
}

export type RevocationResult =
  | { ok: true; checked: number }
  | AndroidAttestationFailure;

export function checkRevocation(input: {
  serials: readonly string[];
  source: RevocationStatusSource;
}): RevocationResult {
  if (!input.source.available) {
    return failure(
      'REVOCATION_UNAVAILABLE',
      'revocation status list unavailable; refusing to promote (fail closed)',
    );
  }
  let checked = 0;
  for (const raw of input.serials) {
    const serial = normalizeSerial(raw);
    const status = input.source.isRevoked(serial);
    checked += 1;
    if (status.revoked) {
      return failure(
        'REVOKED',
        `certificate serial ${serial} is revoked${status.reason ? ` (${status.reason})` : ''}`,
      );
    }
  }
  return { ok: true, checked };
}

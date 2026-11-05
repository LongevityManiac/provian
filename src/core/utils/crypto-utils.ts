/**
 * Cryptographic utilities for secure operations.
 *
 * These utilities provide security-critical primitives that must be
 * implemented correctly to avoid timing attacks and other side-channels.
 */

import { p256 } from '@noble/curves/p256';

/**
 * Validate that (x, y) is a point on the P-256 curve.
 * Call this before createWallet() to prevent permanent fund lockout.
 * [SEC-audit-1.6]
 */
export function isValidP256Point(x: bigint, y: bigint): boolean {
  try {
    // ProjectivePoint.fromAffine throws if point is not on curve
    p256.ProjectivePoint.fromAffine({ x, y });
    return true;
  } catch {
    return false;
  }
}

/**
 * [M-13] Validate that a hex-encoded public key is a valid P-256 point.
 * Accepts compressed (33 bytes), uncompressed (65 bytes), or raw (64 bytes) formats.
 * Throws on invalid input for fail-closed behavior at key import boundaries.
 */
export function validateP256PublicKeyHex(publicKeyHex: string): void {
    try {
        p256.ProjectivePoint.fromHex(publicKeyHex);
    } catch {
        throw new Error('Invalid P-256 public key: not a valid curve point');
    }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Standard string comparison (===, !==) leaks timing information about
 * which byte position differs, allowing attackers to forge values one
 * byte at a time. This function compares all bytes regardless of match.
 *
 * @param a First string to compare
 * @param b Second string to compare
 * @returns true if strings are equal, false otherwise
 */
export function constantTimeEqual(a: string, b: string): boolean {
    // Length check is unavoidable, but comparison itself is constant-time
    if (a.length !== b.length) return false;

    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

/**
 * Constant-time Uint8Array comparison.
 *
 * @param a First array to compare
 * @param b Second array to compare
 * @returns true if arrays are equal, false otherwise
 */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;

    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
    }
    return result === 0;
}

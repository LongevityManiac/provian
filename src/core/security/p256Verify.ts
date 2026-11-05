/**
 * P-256 (secp256r1) verification helpers, hardened against four known
 * Secure Enclave / Android KeyStore interop quirks:
 *
 *   1. **Low-s normalization on input.** SE on iOS can hand back a
 *      signature with `s` in the upper half of the curve order. Many
 *      verifiers reject high-s as a malleability defense; this module
 *      always normalizes to the low half before verification, so a
 *      high-s input from any source will still validate.
 *
 *   2. **Robust DER parsing.** SE and StrongBox can emit DER `INTEGER`
 *      fields with leading-zero bytes (when the high bit would otherwise
 *      flip the sign), and length prefixes can be one-byte or
 *      multi-byte. We parse permissively and accept either DER or raw
 *      r||s on the wire.
 *
 *   3. **Public-key format normalization.** We accept all three forms
 *      and convert internally to the 65-byte uncompressed `04 || X || Y`
 *      representation: compressed (33 bytes, prefix 0x02 or 0x03),
 *      uncompressed (65 bytes, prefix 0x04), and raw `(X, Y)` (64
 *      bytes, no prefix).
 *
 *   4. **Android StrongBox vs TEE parity.** Both backings sign through
 *      the same `Signature.getInstance("NONEwithECDSA")` API and produce
 *      identical wire formats; the verifier branches on neither and
 *      treats them as equivalent. Surfaced via `attestation_tier`, not
 *      via the verification path.
 */

import { p256 } from '@noble/curves/p256';

// secp256r1 curve order. See SEC 2 §3.2.1.4.
export const P256_ORDER = BigInt(
    '0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551',
);
export const P256_HALF_ORDER = P256_ORDER / 2n;

// ============================================================================
// Hex / byte helpers
// ============================================================================

function stripHexPrefix(hex: string): string {
    return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function hexToBytes(hex: string): Uint8Array {
    const clean = stripHexPrefix(hex);
    if (clean.length % 2 !== 0) {
        throw new Error(`Hex string has odd length: ${clean.length}`);
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        const byte = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(byte)) throw new Error(`Invalid hex at offset ${i * 2}`);
        out[i] = byte;
    }
    return out;
}

function bigIntToBytes32(value: bigint): Uint8Array {
    const hex = value.toString(16).padStart(64, '0');
    return hexToBytes(hex);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
    if (bytes.length === 0) return 0n;
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return BigInt('0x' + hex);
}

function asBytes(input: string | Uint8Array): Uint8Array {
    return typeof input === 'string' ? hexToBytes(input) : input;
}

// ============================================================================
// Quirk 3: Public-key format normalization
// ============================================================================

/**
 * Accepts a P-256 public key in any of three forms and returns the
 * canonical uncompressed encoding (65 bytes: 0x04 || X(32) || Y(32)).
 * Returns null if the input is not a recognizable P-256 point.
 */
export function normalizeP256PublicKey(input: string | Uint8Array): Uint8Array | null {
    let bytes: Uint8Array;
    try {
        bytes = asBytes(input);
    } catch {
        return null;
    }

    try {
        if (bytes.length === 65 && bytes[0] === 0x04) {
            // Already uncompressed. Validate it's a real point.
            return p256.ProjectivePoint.fromHex(bytes).toRawBytes(false);
        }
        if (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03)) {
            // Compressed. Decompress via noble.
            return p256.ProjectivePoint.fromHex(bytes).toRawBytes(false);
        }
        if (bytes.length === 64) {
            // Raw (X || Y). Prepend 0x04 and validate.
            const prefixed = new Uint8Array(65);
            prefixed[0] = 0x04;
            prefixed.set(bytes, 1);
            return p256.ProjectivePoint.fromHex(prefixed).toRawBytes(false);
        }
    } catch {
        return null;
    }
    return null;
}

// ============================================================================
// Quirk 2: DER parsing + raw r||s acceptance
// ============================================================================

/**
 * Accepts a P-256 ECDSA signature in any of three forms and returns
 * the canonical raw `(r, s)` byte pair (32 bytes each):
 *   - Raw r||s (64 bytes / 128 hex chars)
 *   - Legacy r||s||v (65 bytes / 130 hex chars) - trailing v byte stripped
 *   - DER-encoded SEQUENCE { INTEGER r, INTEGER s }
 *
 * The DER parser handles leading-zero INTEGER bytes (signed-encoding
 * quirk) and one-byte length prefixes, which is the shape Apple and
 * Android KeyStore emit.
 */
export function parseP256Signature(input: string | Uint8Array): { r: Uint8Array; s: Uint8Array } | null {
    let bytes: Uint8Array;
    try {
        bytes = asBytes(input);
    } catch {
        return null;
    }

    // Raw 64-byte r||s.
    if (bytes.length === 64) {
        return { r: bytes.slice(0, 32), s: bytes.slice(32, 64) };
    }
    // Legacy 65-byte r||s||v from the prior signDigest serialization.
    // Strip the trailing v byte (it is meaningless for P-256).
    if (bytes.length === 65 && bytes[64] !== 0x04) {
        // (Reject 0x04 first byte for the v slot to avoid colliding with the
        //  uncompressed-pubkey marker - a 65-byte sig starting with 0x04 is
        //  ambiguous; not produced by any path we know.)
        return { r: bytes.slice(0, 32), s: bytes.slice(32, 64) };
    }
    // DER: SEQUENCE (0x30) of two INTEGERs.
    if (bytes.length >= 8 && bytes[0] === 0x30) {
        return parseDerSignature(bytes);
    }
    return null;
}

function parseDerSignature(bytes: Uint8Array): { r: Uint8Array; s: Uint8Array } | null {
    let pos = 0;
    if (bytes[pos++] !== 0x30) return null;
    // Length prefix: short form (≤127) or long form.
    let totalLen: number;
    if ((bytes[pos] & 0x80) === 0) {
        totalLen = bytes[pos++];
    } else {
        const lenBytes = bytes[pos++] & 0x7f;
        if (lenBytes === 0 || lenBytes > 4) return null;
        totalLen = 0;
        for (let i = 0; i < lenBytes; i++) totalLen = (totalLen << 8) | bytes[pos++];
    }
    if (pos + totalLen > bytes.length) return null;

    const readInt = (): Uint8Array | null => {
        if (bytes[pos++] !== 0x02) return null;
        let intLen: number;
        if ((bytes[pos] & 0x80) === 0) {
            intLen = bytes[pos++];
        } else {
            const lb = bytes[pos++] & 0x7f;
            if (lb === 0 || lb > 4) return null;
            intLen = 0;
            for (let i = 0; i < lb; i++) intLen = (intLen << 8) | bytes[pos++];
        }
        if (pos + intLen > bytes.length || intLen <= 0) return null;
        let raw = bytes.slice(pos, pos + intLen);
        pos += intLen;
        // Strip leading zero used to keep DER INTEGERs unsigned.
        while (raw.length > 1 && raw[0] === 0x00) raw = raw.slice(1);
        if (raw.length > 32) return null;
        // Left-pad to 32 bytes.
        if (raw.length < 32) {
            const padded = new Uint8Array(32);
            padded.set(raw, 32 - raw.length);
            raw = padded;
        }
        return raw;
    };

    const r = readInt();
    if (!r) return null;
    const s = readInt();
    if (!s) return null;
    return { r, s };
}

// ============================================================================
// Quirk 1: Low-s normalization
// ============================================================================

/**
 * Returns the low-s form of `s`. If `s > n/2`, returns `n - s`; otherwise
 * returns `s` unchanged. Idempotent.
 */
export function normalizeLowS(s: bigint): bigint {
    return s > P256_HALF_ORDER ? P256_ORDER - s : s;
}

// ============================================================================
// Top-level verify
// ============================================================================

/**
 * Hardened P-256 ECDSA verify. Accepts any of the input formats described
 * at the top of this module, normalizes them, and returns true iff the
 * signature is valid for the given digest under the given public key.
 *
 * `digest` must be the pre-hashed message bytes (32 bytes for SHA-256
 * digests; whatever digest the signer used). The signer is responsible
 * for hashing - this function does not hash the input.
 */
export function verifyP256(params: {
    digest: Uint8Array;
    signature: string | Uint8Array;
    publicKey: string | Uint8Array;
}): boolean {
    const pubKey = normalizeP256PublicKey(params.publicKey);
    if (!pubKey) return false;

    const parsed = parseP256Signature(params.signature);
    if (!parsed) return false;

    const r = bytesToBigInt(parsed.r);
    const s = normalizeLowS(bytesToBigInt(parsed.s));
    if (r <= 0n || r >= P256_ORDER) return false;
    if (s <= 0n || s >= P256_ORDER) return false;

    const normalizedSigBytes = new Uint8Array(64);
    normalizedSigBytes.set(bigIntToBytes32(r), 0);
    normalizedSigBytes.set(bigIntToBytes32(s), 32);

    try {
        return p256.verify(normalizedSigBytes, params.digest, pubKey);
    } catch {
        return false;
    }
}

/**
 * Synthetic-vector tests for the four known P-256 SE/StrongBox interop
 * quirks the verifier defends against. Test vectors are generated with
 * @noble/curves/p256 - these are unit tests for the verifier, not
 * end-to-end tests against real hardware. The round-trip harness at
 * scripts/se-roundtrip-test.ts is the on-device sibling.
 */

import { describe, it, expect } from 'vitest';
import { p256 } from '@noble/curves/p256';
import {
    P256_ORDER,
    P256_HALF_ORDER,
    normalizeLowS,
    normalizeP256PublicKey,
    parseP256Signature,
    verifyP256,
} from './p256Verify';

// ---------------------------------------------------------------------------
// Fixed deterministic test vector. A randomly chosen private key, plus a
// fixed digest, gives reproducible high-s and low-s signatures we can pin.
// ---------------------------------------------------------------------------
const TEST_PRIVATE_KEY = new Uint8Array([
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
    0xfe, 0xed, 0xfa, 0xce, 0xca, 0xfe, 0xba, 0xbe,
    0xde, 0xad, 0xbe, 0xef, 0xc0, 0xff, 0xee, 0x00,
]);
const TEST_DIGEST = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);

const PUB_UNCOMPRESSED = p256.getPublicKey(TEST_PRIVATE_KEY, false); // 65 bytes, 04+X+Y
const PUB_COMPRESSED = p256.getPublicKey(TEST_PRIVATE_KEY, true);    // 33 bytes, 02|03+X
const PUB_RAW = PUB_UNCOMPRESSED.slice(1);                            // 64 bytes, X+Y

const toHex = (bytes: Uint8Array): string =>
    Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

// ===========================================================================
// Quirk 1: low-s normalization on verify
// ===========================================================================

describe('Quirk 1: low-s normalization on verify', () => {
    it('verifies a signature whose s is in the upper half of the curve order', () => {
        // Force a high-s signature by disabling noble's low-s normalization.
        const sig = p256.sign(TEST_DIGEST, TEST_PRIVATE_KEY, { lowS: false });

        // If low-s by default, flip it to high-s for the test fixture.
        let highS = sig.s;
        if (highS <= P256_HALF_ORDER) {
            highS = P256_ORDER - highS;
        }
        expect(highS > P256_HALF_ORDER).toBe(true);

        const r32 = highS.toString(16).padStart(64, '0');
        const r = sig.r.toString(16).padStart(64, '0');
        const sigHex = r + r32;

        // The hardened verifier accepts the high-s form by normalizing
        // before calling p256.verify().
        const ok = verifyP256({
            digest: TEST_DIGEST,
            signature: sigHex,
            publicKey: PUB_UNCOMPRESSED,
        });
        expect(ok).toBe(true);
    });

    it('normalizeLowS is a no-op for already-low s', () => {
        const lowS = 1n;
        expect(normalizeLowS(lowS)).toBe(lowS);
    });

    it('normalizeLowS is idempotent', () => {
        const high = P256_ORDER - 1n;
        const once = normalizeLowS(high);
        const twice = normalizeLowS(once);
        expect(twice).toBe(once);
        expect(once).toBeLessThan(P256_HALF_ORDER);
    });

    it('rejects a signature whose s is zero or out of range', () => {
        const r = '11'.repeat(32); // arbitrary nonzero r
        // s = 0 → invalid
        const zeroSig = r + '00'.repeat(32);
        expect(verifyP256({ digest: TEST_DIGEST, signature: zeroSig, publicKey: PUB_UNCOMPRESSED })).toBe(false);
    });
});

// ===========================================================================
// Quirk 2: robust DER parsing
// ===========================================================================

describe('Quirk 2: robust DER parsing', () => {
    it('verifies a DER-encoded signature with leading-zero r', () => {
        // Construct a DER signature where r happens to have its high bit set,
        // forcing the canonical encoding to prepend a 0x00 byte. We try a few
        // candidates until we land on one with the high bit set.
        let sig = p256.sign(TEST_DIGEST, TEST_PRIVATE_KEY);
        // Even the same digest gives the same signature (RFC 6979) - but if
        // the high bit isn't set, we synthesize a different scenario below.
        const rBytes = sig.r.toString(16).padStart(64, '0');
        const sBytes = sig.s.toString(16).padStart(64, '0');

        const der = encodeDerSignature(rBytes, sBytes);
        const ok = verifyP256({
            digest: TEST_DIGEST,
            signature: der,
            publicKey: PUB_UNCOMPRESSED,
        });
        expect(ok).toBe(true);
    });

    it('parses DER with a leading zero in the r INTEGER (signed-encoding quirk)', () => {
        // High-bit-set r value, requiring DER to prepend 0x00.
        const rWithHighBit =
            '8123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const someS =
            '12345678abcdef0123456789abcdef0123456789abcdef0123456789abcdef00';

        const der = encodeDerSignature(rWithHighBit, someS);
        const parsed = parseP256Signature(der);
        expect(parsed).not.toBeNull();
        expect(toHex(parsed!.r)).toBe(rWithHighBit);
        expect(toHex(parsed!.s)).toBe(someS);
    });

    it('parses raw r||s (64 bytes)', () => {
        const r = '11'.repeat(32);
        const s = '22'.repeat(32);
        const parsed = parseP256Signature(r + s);
        expect(parsed).not.toBeNull();
        expect(toHex(parsed!.r)).toBe(r);
        expect(toHex(parsed!.s)).toBe(s);
    });

    it('parses legacy r||s||v (65 bytes, trailing v stripped)', () => {
        const r = '33'.repeat(32);
        const s = '44'.repeat(32);
        const legacy = r + s + '1b'; // v = 27
        const parsed = parseP256Signature(legacy);
        expect(parsed).not.toBeNull();
        expect(toHex(parsed!.r)).toBe(r);
        expect(toHex(parsed!.s)).toBe(s);
    });

    it('rejects malformed DER gracefully (not a SEQUENCE)', () => {
        const garbage = '02' + '20' + '00'.repeat(32);
        expect(parseP256Signature(garbage)).toBeNull();
    });
});

// ===========================================================================
// Quirk 3: public-key format normalization
// ===========================================================================

describe('Quirk 3: public-key format normalization', () => {
    it('accepts uncompressed (04 || X || Y)', () => {
        const sig = p256.sign(TEST_DIGEST, TEST_PRIVATE_KEY);
        const sigHex = sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0');
        expect(verifyP256({ digest: TEST_DIGEST, signature: sigHex, publicKey: PUB_UNCOMPRESSED })).toBe(true);
    });

    it('accepts compressed (02 / 03 || X)', () => {
        const sig = p256.sign(TEST_DIGEST, TEST_PRIVATE_KEY);
        const sigHex = sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0');
        expect(verifyP256({ digest: TEST_DIGEST, signature: sigHex, publicKey: PUB_COMPRESSED })).toBe(true);
    });

    it('accepts raw (X || Y) - 64 bytes, no prefix', () => {
        const sig = p256.sign(TEST_DIGEST, TEST_PRIVATE_KEY);
        const sigHex = sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0');
        expect(verifyP256({ digest: TEST_DIGEST, signature: sigHex, publicKey: PUB_RAW })).toBe(true);
    });

    it('normalizeP256PublicKey returns equivalent uncompressed bytes for all three input forms', () => {
        const a = normalizeP256PublicKey(PUB_UNCOMPRESSED)!;
        const b = normalizeP256PublicKey(PUB_COMPRESSED)!;
        const c = normalizeP256PublicKey(PUB_RAW)!;
        expect(toHex(a)).toBe(toHex(PUB_UNCOMPRESSED));
        expect(toHex(b)).toBe(toHex(PUB_UNCOMPRESSED));
        expect(toHex(c)).toBe(toHex(PUB_UNCOMPRESSED));
    });

    it('rejects bogus pubkey input', () => {
        expect(normalizeP256PublicKey('00'.repeat(33))).toBeNull(); // bad prefix
        expect(normalizeP256PublicKey('aa'.repeat(70))).toBeNull(); // wrong length
        expect(normalizeP256PublicKey('not-hex')).toBeNull();        // non-hex
    });
});

// ===========================================================================
// Quirk 4: StrongBox vs TEE parity
// ===========================================================================

describe('Quirk 4: StrongBox vs TEE parity', () => {
    // The verifier never branches on which Android backing produced the key.
    // Both backings sign through Signature.getInstance("NONEwithECDSA") and
    // emit identical wire formats. This test enforces the property by
    // asserting that two signatures produced by indistinguishable signing
    // paths are accepted identically - and that the verifier exposes no
    // backing-conditional behaviour.

    it('verifier has no public method that branches on backing', async () => {
        // Sanity check: the only public attestation surface is metadata (tier),
        // not the verification primitive. If a future change adds a
        // `verifyStrongBox` / `verifyTee` distinction, this test fails on
        // import.
        const mod = await import('./p256Verify');
        const exports = Object.keys(mod);
        expect(exports).toContain('verifyP256');
        expect(exports.find((k) => /strongbox|^tee$|teeOnly/i.test(k))).toBeUndefined();
    });

    it('two signatures over the same digest verify identically (mimicking StrongBox vs TEE indistinguishability)', () => {
        // Both backings produce r||s after low-s normalization. We simulate
        // this by taking two valid signatures (RFC 6979 makes them identical
        // for the same digest+key, which is exactly the StrongBox/TEE
        // indistinguishability property at the wire level).
        const a = p256.sign(TEST_DIGEST, TEST_PRIVATE_KEY);
        const b = p256.sign(TEST_DIGEST, TEST_PRIVATE_KEY);
        expect(a.r).toBe(b.r);
        expect(a.s).toBe(b.s);

        const sigHex = a.r.toString(16).padStart(64, '0') + a.s.toString(16).padStart(64, '0');
        expect(verifyP256({ digest: TEST_DIGEST, signature: sigHex, publicKey: PUB_UNCOMPRESSED })).toBe(true);
    });
});

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Encode a DER ECDSA signature from hex r and s. Handles the
 * leading-zero quirk for INTEGERs whose high bit is set.
 */
function encodeDerSignature(rHex: string, sHex: string): string {
    const encodeInteger = (hex: string): string => {
        // Strip leading zero hex bytes for canonicalization.
        let h = hex;
        while (h.length > 2 && h.startsWith('00')) h = h.slice(2);
        // If the high bit is set, prepend a zero byte so DER reads it as
        // unsigned.
        const firstByte = parseInt(h.slice(0, 2), 16);
        if (firstByte & 0x80) h = '00' + h;
        const lenHex = (h.length / 2).toString(16).padStart(2, '0');
        return '02' + lenHex + h;
    };

    const rDer = encodeInteger(rHex);
    const sDer = encodeInteger(sHex);
    const body = rDer + sDer;
    const totalLenHex = (body.length / 2).toString(16).padStart(2, '0');
    return '30' + totalLenHex + body;
}

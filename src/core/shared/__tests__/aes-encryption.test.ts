import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
    encrypt,
    decrypt,
    deriveSubkeys,
    parsePayload,
    isCurrentVersion,
    getCurrentVersion,
    constantTimeEqualBytes,
} from '../aes-encryption';

/**
 * Generate random bytes for testing.
 */
function generateRandomBytes(length: number): Uint8Array {
    return new Uint8Array(randomBytes(length));
}

describe('AES-256-CTR + HMAC-SHA256 Encryption', () => {
    // =========================================================================
    // BASIC ENCRYPT/DECRYPT
    // =========================================================================

    describe('encrypt and decrypt', () => {
        it('should encrypt and decrypt round-trip correctly', async () => {
            const plaintext = new TextEncoder().encode('Hello, World!');
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);
            const decrypted = await decrypt(encrypted, key);

            expect(new TextDecoder().decode(decrypted)).toBe('Hello, World!');
        });

        it('should encrypt and decrypt binary data', async () => {
            const plaintext = generateRandomBytes(256);
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);
            const decrypted = await decrypt(encrypted, key);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });

        it('should encrypt and decrypt empty data', async () => {
            const plaintext = new Uint8Array(0);
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);
            const decrypted = await decrypt(encrypted, key);

            expect(decrypted.length).toBe(0);
        });

        it('should encrypt and decrypt large data (1MB)', async () => {
            const plaintext = generateRandomBytes(1024 * 1024);
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);
            const decrypted = await decrypt(encrypted, key);

            expect(decrypted.length).toBe(plaintext.length);
            // Check first and last 1KB to avoid slow full comparison
            expect(Array.from(decrypted.slice(0, 1024))).toEqual(
                Array.from(plaintext.slice(0, 1024))
            );
            expect(Array.from(decrypted.slice(-1024))).toEqual(
                Array.from(plaintext.slice(-1024))
            );
        });

        it('should produce different ciphertext for same plaintext (random IV)', async () => {
            const plaintext = new TextEncoder().encode('Same message');
            const key = generateRandomBytes(32);

            const encrypted1 = await encrypt(plaintext, key);
            const encrypted2 = await encrypt(plaintext, key);

            // Ciphertexts should be different due to random IV
            expect(Array.from(encrypted1)).not.toEqual(Array.from(encrypted2));

            // But both should decrypt to the same plaintext
            const decrypted1 = await decrypt(encrypted1, key);
            const decrypted2 = await decrypt(encrypted2, key);

            expect(new TextDecoder().decode(decrypted1)).toBe('Same message');
            expect(new TextDecoder().decode(decrypted2)).toBe('Same message');
        });
    });

    // =========================================================================
    // AUTHENTICATION (HMAC)
    // =========================================================================

    describe('HMAC authentication', () => {
        it('should fail with tampered ciphertext', async () => {
            const plaintext = new TextEncoder().encode('Sensitive data');
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);

            // Tamper with a byte in the ciphertext (after version + IV + HMAC)
            const tampered = new Uint8Array(encrypted);
            tampered[tampered.length - 1] ^= 0xff; // Flip bits in last byte

            await expect(decrypt(tampered, key)).rejects.toThrow(
                'HMAC verification failed'
            );
        });

        it('should fail with tampered HMAC', async () => {
            const plaintext = new TextEncoder().encode('Sensitive data');
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);

            // Tamper with the HMAC (bytes 17-48, after version byte and IV)
            const tampered = new Uint8Array(encrypted);
            tampered[20] ^= 0xff; // Flip bits in HMAC

            await expect(decrypt(tampered, key)).rejects.toThrow(
                'HMAC verification failed'
            );
        });

        it('should fail with tampered IV', async () => {
            const plaintext = new TextEncoder().encode('Sensitive data');
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);

            // Tamper with the IV (bytes 1-16, after version byte)
            const tampered = new Uint8Array(encrypted);
            tampered[5] ^= 0xff; // Flip bits in IV

            await expect(decrypt(tampered, key)).rejects.toThrow(
                'HMAC verification failed'
            );
        });

        it('should fail with tampered version byte', async () => {
            const plaintext = new TextEncoder().encode('Sensitive data');
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);

            // Tamper with version byte
            const tampered = new Uint8Array(encrypted);
            tampered[0] = 0x99; // Invalid version

            await expect(decrypt(tampered, key)).rejects.toThrow(
                'Unsupported encryption version'
            );
        });
    });

    // =========================================================================
    // WRONG KEY
    // =========================================================================

    describe('wrong key', () => {
        it('should fail with wrong decryption key', async () => {
            const plaintext = new TextEncoder().encode('Secret message');
            const correctKey = generateRandomBytes(32);
            const wrongKey = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, correctKey);

            await expect(decrypt(encrypted, wrongKey)).rejects.toThrow(
                'HMAC verification failed'
            );
        });

        it('should fail with partially wrong key', async () => {
            const plaintext = new TextEncoder().encode('Secret message');
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);

            // Create a key with only one byte different
            const almostCorrectKey = new Uint8Array(key);
            almostCorrectKey[0] ^= 0x01;

            await expect(decrypt(encrypted, almostCorrectKey)).rejects.toThrow(
                'HMAC verification failed'
            );
        });
    });

    // =========================================================================
    // PAYLOAD PARSING
    // =========================================================================

    describe('payload parsing', () => {
        it('should fail with too-short payload', async () => {
            const key = generateRandomBytes(32);
            const shortPayload = new Uint8Array(10); // Too short

            await expect(decrypt(shortPayload, key)).rejects.toThrow(
                'Encrypted payload too short'
            );
        });

        it('should parse payload correctly', async () => {
            const plaintext = new TextEncoder().encode('Test data');
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);
            const parsed = parsePayload(encrypted);

            expect(parsed.version).toBe(getCurrentVersion());
            expect(parsed.iv.length).toBe(16);
            expect(parsed.hmac.length).toBe(32);
            expect(parsed.ciphertext.length).toBe(plaintext.length);
        });

        it('should detect current version', async () => {
            const plaintext = new TextEncoder().encode('Test');
            const key = generateRandomBytes(32);

            const encrypted = await encrypt(plaintext, key);

            expect(isCurrentVersion(encrypted)).toBe(true);
        });

        it('should reject non-current version', () => {
            const oldVersionPayload = new Uint8Array(100);
            oldVersionPayload[0] = 0x01; // Old version

            expect(isCurrentVersion(oldVersionPayload)).toBe(false);
        });
    });

    // =========================================================================
    // SUBKEY DERIVATION
    // =========================================================================

    describe('subkey derivation', () => {
        it('should derive different enc and mac keys', async () => {
            const masterKey = generateRandomBytes(32);

            const { encKey, macKey } = await deriveSubkeys(masterKey);

            expect(encKey.length).toBe(32);
            expect(macKey.length).toBe(32);
            expect(Array.from(encKey)).not.toEqual(Array.from(macKey));
        });

        it('should derive deterministic subkeys', async () => {
            const masterKey = generateRandomBytes(32);

            const result1 = await deriveSubkeys(masterKey);
            const result2 = await deriveSubkeys(masterKey);

            expect(Array.from(result1.encKey)).toEqual(Array.from(result2.encKey));
            expect(Array.from(result1.macKey)).toEqual(Array.from(result2.macKey));
        });

        it('should derive different subkeys for different master keys', async () => {
            const masterKey1 = generateRandomBytes(32);
            const masterKey2 = generateRandomBytes(32);

            const result1 = await deriveSubkeys(masterKey1);
            const result2 = await deriveSubkeys(masterKey2);

            expect(Array.from(result1.encKey)).not.toEqual(Array.from(result2.encKey));
            expect(Array.from(result1.macKey)).not.toEqual(Array.from(result2.macKey));
        });
    });

    // =========================================================================
    // CONSTANT-TIME COMPARISON
    // =========================================================================

    describe('constantTimeEqualBytes', () => {
        it('should return true for equal arrays', () => {
            const a = new Uint8Array([1, 2, 3, 4, 5]);
            const b = new Uint8Array([1, 2, 3, 4, 5]);

            expect(constantTimeEqualBytes(a, b)).toBe(true);
        });

        it('should return false for different arrays', () => {
            const a = new Uint8Array([1, 2, 3, 4, 5]);
            const b = new Uint8Array([1, 2, 3, 4, 6]);

            expect(constantTimeEqualBytes(a, b)).toBe(false);
        });

        it('should return false for different length arrays', () => {
            const a = new Uint8Array([1, 2, 3]);
            const b = new Uint8Array([1, 2, 3, 4]);

            expect(constantTimeEqualBytes(a, b)).toBe(false);
        });

        it('should return true for empty arrays', () => {
            const a = new Uint8Array(0);
            const b = new Uint8Array(0);

            expect(constantTimeEqualBytes(a, b)).toBe(true);
        });

        it('should detect single bit difference', () => {
            const a = new Uint8Array([0xff, 0xff, 0xff]);
            const b = new Uint8Array([0xff, 0xfe, 0xff]); // One bit different

            expect(constantTimeEqualBytes(a, b)).toBe(false);
        });
    });
});

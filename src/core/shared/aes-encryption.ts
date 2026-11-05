/**
 * Standard AES-256-CTR + HMAC-SHA256 encryption.
 * Used by ShareStorage for authenticated encryption.
 *
 * Format: version (1 byte) || IV (16 bytes) || HMAC (32 bytes) || ciphertext
 *
 * Uses @noble/hashes and @noble/ciphers for React Native compatibility
 * (no Web Crypto / crypto.subtle dependency).
 *
 * Security properties:
 * - Encrypt-then-MAC construction (verified before decryption)
 * - Constant-time HMAC comparison to prevent timing attacks
 * - Separate encryption and MAC keys derived via HMAC expansion
 * - Random IV for each encryption (no IV reuse)
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { ctr } from '@noble/ciphers/aes';

const ENCRYPTION_VERSION = 0x02;
const IV_LENGTH = 16;
const HMAC_LENGTH = 32;

export interface EncryptedPayload {
    version: number;
    iv: Uint8Array;
    hmac: Uint8Array;
    ciphertext: Uint8Array;
}

/**
 * Derive encryption key and MAC key from master key using HMAC expansion.
 * encKey = HMAC-SHA256(masterKey, "enc")
 * macKey = HMAC-SHA256(masterKey, "mac")
 */
export async function deriveSubkeys(
    masterKey: Uint8Array
): Promise<{ encKey: Uint8Array; macKey: Uint8Array }> {
    const enc = new TextEncoder();
    return {
        encKey: hmac(sha256, masterKey, enc.encode('enc')),
        macKey: hmac(sha256, masterKey, enc.encode('mac')),
    };
}

/**
 * Encrypt plaintext using AES-256-CTR with HMAC-SHA256 authentication.
 */
export async function encrypt(
    plaintext: Uint8Array,
    masterKey: Uint8Array
): Promise<Uint8Array> {
    const { encKey, macKey } = await deriveSubkeys(masterKey);

    // Random IV
    const iv = new Uint8Array(IV_LENGTH);
    crypto.getRandomValues(iv);

    // AES-256-CTR encrypt
    const cipher = ctr(encKey, iv);
    const ciphertext = cipher.encrypt(plaintext);

    // HMAC over version || IV || ciphertext
    const hmacInput = new Uint8Array(1 + IV_LENGTH + ciphertext.length);
    hmacInput[0] = ENCRYPTION_VERSION;
    hmacInput.set(iv, 1);
    hmacInput.set(ciphertext, 1 + IV_LENGTH);

    const mac = hmac(sha256, macKey, hmacInput);

    // Pack: version || IV || HMAC || ciphertext
    const result = new Uint8Array(1 + IV_LENGTH + HMAC_LENGTH + ciphertext.length);
    result[0] = ENCRYPTION_VERSION;
    result.set(iv, 1);
    result.set(mac, 1 + IV_LENGTH);
    result.set(ciphertext, 1 + IV_LENGTH + HMAC_LENGTH);

    return result;
}

/**
 * Decrypt payload using AES-256-CTR with HMAC-SHA256 verification.
 */
export async function decrypt(
    packed: Uint8Array,
    masterKey: Uint8Array
): Promise<Uint8Array> {
    if (packed.length < 1 + IV_LENGTH + HMAC_LENGTH) {
        throw new Error('Encrypted payload too short');
    }

    const version = packed[0];
    if (version !== ENCRYPTION_VERSION) {
        throw new Error(`Unsupported encryption version: ${version}`);
    }

    const iv = packed.slice(1, 1 + IV_LENGTH);
    const storedHmac = packed.slice(1 + IV_LENGTH, 1 + IV_LENGTH + HMAC_LENGTH);
    const ciphertext = packed.slice(1 + IV_LENGTH + HMAC_LENGTH);

    const { encKey, macKey } = await deriveSubkeys(masterKey);

    // Verify HMAC first (encrypt-then-MAC)
    const hmacInput = new Uint8Array(1 + IV_LENGTH + ciphertext.length);
    hmacInput[0] = version;
    hmacInput.set(iv, 1);
    hmacInput.set(ciphertext, 1 + IV_LENGTH);

    const expectedHmac = hmac(sha256, macKey, hmacInput);

    if (!constantTimeEqualBytes(storedHmac, expectedHmac)) {
        throw new Error('HMAC verification failed - data may be tampered');
    }

    // Decrypt
    const decipher = ctr(encKey, iv);
    return decipher.decrypt(ciphertext);
}

/**
 * Parse a packed payload without decrypting (for version checking).
 */
export function parsePayload(packed: Uint8Array): EncryptedPayload {
    if (packed.length < 1 + IV_LENGTH + HMAC_LENGTH) {
        throw new Error('Encrypted payload too short');
    }

    return {
        version: packed[0],
        iv: packed.slice(1, 1 + IV_LENGTH),
        hmac: packed.slice(1 + IV_LENGTH, 1 + IV_LENGTH + HMAC_LENGTH),
        ciphertext: packed.slice(1 + IV_LENGTH + HMAC_LENGTH),
    };
}

/**
 * Get the current encryption version number.
 */
export function getCurrentVersion(): number {
    return ENCRYPTION_VERSION;
}

/**
 * Constant-time comparison of two byte arrays.
 * Prevents timing side-channel attacks on HMAC verification.
 */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i] ^ b[i];
    }
    return diff === 0;
}

/**
 * Check if a packed payload uses the current encryption version.
 */
export function isCurrentVersion(packed: Uint8Array): boolean {
    return packed.length > 0 && packed[0] === ENCRYPTION_VERSION;
}

// Re-export with shorter aliases for backward compatibility
export { encrypt as aesEncrypt, decrypt as aesDecrypt };

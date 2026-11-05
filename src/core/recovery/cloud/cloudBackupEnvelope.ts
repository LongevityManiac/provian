/**
 * cloudBackupEnvelope - the pure crypto seam of the cloud backup.
 *
 * Everything in this file is deliberately dependency-light (noble libs only,
 * no react-native / SeedManager / native-sync imports) so the encrypt →
 * decrypt round trip — including the legacy 100K-iteration, 6-digit-PIN
 * envelopes — is testable directly. CloudBackupV2.ts owns the device I/O
 * (biometric session, keychain sync, verification) and consumes this module.
 *
 * Envelope format (StoredBackup) is unchanged from the original in-line
 * implementation: PBKDF2-HMAC-SHA256 → AES-256-GCM, all binary fields hex.
 * The backup password is any string of 6+ characters; a legacy 6-digit PIN
 * is simply a short password to the KDF, so old blobs decrypt unchanged.
 */

import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { gcm } from '@noble/ciphers/aes';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export interface CloudBackupPayload {
    /** The BIP-39 mnemonic - the seed material required to restore the wallet */
    mnemonic: string;
    wallet_address: string;
    chain_ids: number[];
    created_at: string;
    device_info: {
        platform: 'ios' | 'android';
        attestation_tier: string;
    };
}

/**
 * Serialized format stored in SecureStore.
 * All binary fields are hex-encoded for safe JSON serialization.
 *
 * `iterations` is optional. New backups (chunk-i and later) write it.
 * Legacy backups created without it are decrypted with
 * LEGACY_PBKDF2_ITERATIONS so existing users keep working after the
 * iteration bump.
 */
export interface StoredBackup {
    version: 2;
    salt: string;       // 32 bytes hex
    nonce: string;      // 12 bytes hex
    ciphertext: string; // AES-256-GCM output hex (includes 16-byte auth tag)
    iterations?: number; // PBKDF2 iteration count used for this backup
    /**
     * The backed-up wallet's EVM address, in clear (public material), so a device can tell
     * WHOSE backup the cloud account holds without the password — the guard that stops a
     * second wallet on the same account from silently replacing the first's only cloud
     * recovery (2026-10-17). Absent on backups written before then.
     */
    wallet_address?: string;
}

/**
 * PBKDF2-HMAC-SHA256 iteration count for new backups. Bumped from 100K to
 * 600K (chunk-i, audit H-2) to match the OWASP Password Storage Cheat
 * Sheet recommendation for PBKDF2-SHA256, so exfiltration of the cloud
 * blob from a compromised iCloud or Google account is not trivially
 * brute-forceable on consumer GPU.
 */
export const PBKDF2_ITERATIONS = 600_000;

/**
 * Legacy PBKDF2 iteration count used by backups created before chunk-i.
 * Read path falls back to this value when the stored envelope has no
 * `iterations` field. Do not encrypt new blobs with this count.
 */
export const LEGACY_PBKDF2_ITERATIONS = 100_000;

export const SALT_LENGTH = 32;
export const NONCE_LENGTH = 12;
export const MIN_PIN_LENGTH = 6;

/**
 * Validate the backup password. Accepts any characters - numeric or
 * alphanumeric - subject only to a 6-character minimum. The digits-only
 * restriction was removed because Android stores the encrypted blob on
 * Google Drive, and a 6-digit keyspace (1 million combos) is too shallow
 * for a blob that could be exfiltrated from a compromised Google account.
 * Both platforms now collect 6-64 character passwords at creation; legacy
 * iOS 6-digit PINs remain valid inputs here forever.
 */
export function validatePin(pin: string): void {
    if (!pin || pin.length < MIN_PIN_LENGTH) {
        throw new Error(`Backup password must be at least ${MIN_PIN_LENGTH} characters`);
    }
}

/**
 * Derive a 32-byte AES key from the backup password using PBKDF2-HMAC-SHA256.
 *
 * The iteration count is supplied per-call so that decrypting a legacy
 * blob can use LEGACY_PBKDF2_ITERATIONS while new encryption uses the
 * current PBKDF2_ITERATIONS. Uses the async variant so the 600K-iteration
 * derivation yields to the event loop instead of freezing the JS thread
 * for the full multi-second (older devices: multi-minute) run.
 */
export async function deriveKey(
    pin: string,
    salt: Uint8Array,
    iterations: number,
): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    return pbkdf2Async(sha256, encoder.encode(pin), salt, {
        c: iterations,
        dkLen: 32,
    });
}

function randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

/**
 * Encrypt a backup payload into the stored envelope with a fresh salt and
 * nonce at the current iteration count.
 */
export async function encryptBackupEnvelope(
    payload: CloudBackupPayload,
    pin: string,
): Promise<StoredBackup> {
    validatePin(pin);

    const salt = randomBytes(SALT_LENGTH);
    const nonce = randomBytes(NONCE_LENGTH);
    const key = await deriveKey(pin, salt, PBKDF2_ITERATIONS);

    const encoder = new TextEncoder();
    const plaintext = encoder.encode(JSON.stringify(payload));

    const cipher = gcm(key, nonce);
    const ciphertext = cipher.encrypt(plaintext);

    return {
        version: 2,
        salt: bytesToHex(salt),
        nonce: bytesToHex(nonce),
        ciphertext: bytesToHex(ciphertext),
        iterations: PBKDF2_ITERATIONS,
    };
}

/**
 * Decrypt a stored envelope. Uses the iteration count recorded in the
 * envelope; legacy blobs without one fall back to LEGACY_PBKDF2_ITERATIONS.
 *
 * @throws If the password is wrong (GCM auth tag mismatch) or the
 *         ciphertext was tampered with.
 */
export async function decryptBackupEnvelope(
    stored: StoredBackup,
    pin: string,
): Promise<CloudBackupPayload> {
    const salt = hexToBytes(stored.salt);
    const nonce = hexToBytes(stored.nonce);
    const ciphertext = hexToBytes(stored.ciphertext);

    const iterations = stored.iterations ?? LEGACY_PBKDF2_ITERATIONS;
    const key = await deriveKey(pin, salt, iterations);

    const decipher = gcm(key, nonce);
    const plaintext = decipher.decrypt(ciphertext);

    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(plaintext)) as CloudBackupPayload;
}

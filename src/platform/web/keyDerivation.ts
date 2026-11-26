/**
 * Key derivation shared by the browser vault and the passkey backup.
 *
 *   pinKey = PBKDF2-SHA256(PIN, pinSalt, 600 000 iterations, 32 bytes)
 *   key    = HKDF-SHA256(ikm = secret || pinKey, salt, info) → AES-256-GCM
 *
 * `secret` is the passkey's PRF output (32 bytes only the authenticator can produce). A browser
 * whose passkey has no PRF uses a random device secret kept under the browser's own key instead;
 * such a browser cannot make a passkey backup (that key must open on another computer).
 * The PIN alone never opens anything, and neither does the passkey alone.
 */
import { bufferOf, utf8 } from './webKv';

export const PIN_KDF_ITERATIONS = 600_000;
export const VAULT_INFO = 'provian-web-vault-v1';
export const BACKUP_INFO = 'provian-passkey-backup-v1';

export async function pinKeyBytes(pin: string, salt: Uint8Array, iterations = PIN_KDF_ITERATIONS): Promise<Uint8Array> {
    const base = await crypto.subtle.importKey('raw', bufferOf(utf8(pin.normalize('NFKC'))), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bufferOf(salt), iterations }, base, 256);
    return new Uint8Array(bits);
}

export async function deriveAesKey(secret: Uint8Array, pinKey: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
    if (secret.length < 32 || pinKey.length !== 32) throw new Error('key_material_invalid');
    const ikm = new Uint8Array(secret.length + pinKey.length);
    ikm.set(secret, 0);
    ikm.set(pinKey, secret.length);
    const base = await crypto.subtle.importKey('raw', bufferOf(ikm), 'HKDF', false, ['deriveKey']);
    ikm.fill(0);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: bufferOf(salt), info: bufferOf(utf8(info)) },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/** PIN policy, the same as the phone's backup password: 6 to 64 characters. */
export const MIN_PIN_LENGTH = 6;
export const MAX_PIN_LENGTH = 64;

export function pinIsAcceptable(pin: string): boolean {
    return typeof pin === 'string' && pin.length >= MIN_PIN_LENGTH && pin.length <= MAX_PIN_LENGTH;
}

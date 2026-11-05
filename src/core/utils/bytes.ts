/**
 * Shared byte manipulation utilities.
 * [Fix 9A] Extracted to eliminate duplication and ensure consistent behavior
 * across EVM transaction builders.
 */

/**
 * Convert a Uint8Array to a hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Convert a hex string to a Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(cleanHex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Concatenate multiple Uint8Arrays into one.
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

/**
 * Base64 decode that works in React Native Hermes (atob not available).
 */
export function base64ToBytes(base64: string): Uint8Array {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup = new Uint8Array(256);
    for (let i = 0; i < CHARS.length; i++) {
        lookup[CHARS.charCodeAt(i)] = i;
    }

    // Remove padding and calculate output length
    const paddingLength = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const byteLength = (base64.length * 3) / 4 - paddingLength;
    const bytes = new Uint8Array(byteLength);

    let p = 0;
    for (let i = 0; i < base64.length; i += 4) {
        const a = lookup[base64.charCodeAt(i)];
        const b = lookup[base64.charCodeAt(i + 1)];
        const c = lookup[base64.charCodeAt(i + 2)];
        const d = lookup[base64.charCodeAt(i + 3)];

        if (p < byteLength) bytes[p++] = (a << 2) | (b >> 4);
        if (p < byteLength) bytes[p++] = ((b & 15) << 4) | (c >> 2);
        if (p < byteLength) bytes[p++] = ((c & 3) << 6) | d;
    }

    return bytes;
}

/**
 * Base64 encode a Uint8Array.
 */
export function bytesToBase64(bytes: Uint8Array): string {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';

    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = bytes[i + 1] ?? 0;
        const c = bytes[i + 2] ?? 0;

        result += CHARS[a >> 2];
        result += CHARS[((a & 3) << 4) | (b >> 4)];
        result += i + 1 < bytes.length ? CHARS[((b & 15) << 2) | (c >> 6)] : '=';
        result += i + 2 < bytes.length ? CHARS[c & 63] : '=';
    }

    return result;
}

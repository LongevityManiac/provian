/**
 * The HARDWARE-WITNESS BINDING NONCE (Trust Layer §2.9) — the phone's copy of the relay's
 * `hardwareBindingNonce`: sha256 over the canonical JSON (sorted keys, no whitespace, undefined
 * dropped) of the submit body WITHOUT `hardware_witness`. A Secure-Enclave assertion over this
 * nonce witnesses exactly this submission and nothing else. Byte-identical to
 * provian-backend/src/core/hardware/binding.ts and the SDK's hardware-witness.ts.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const HARDWARE_WITNESS_FIELD = 'hardware_witness';

export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
        const v = obj[k];
        if (v === undefined) continue;
        parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
    }
    return '{' + parts.join(',') + '}';
}

/** Excluded from the binding on every side: the slot, and the client-asserted identity keys the relay strips in place. */
export const HARDWARE_BINDING_EXCLUDED_FIELDS: readonly string[] = [HARDWARE_WITNESS_FIELD, 'user_id', 'wallet_id', 'actor_address'];

export function hardwareBindingNonceBytes(body: Record<string, unknown>): Uint8Array {
    const rest: Record<string, unknown> = { ...body };
    for (const k of HARDWARE_BINDING_EXCLUDED_FIELDS) delete rest[k];
    return sha256(utf8ToBytes(canonicalJson(rest)));
}

export function hardwareBindingNonceHex(body: Record<string, unknown>): string {
    return bytesToHex(hardwareBindingNonceBytes(body));
}

export function bytesToBase64(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    // RN has global btoa (Hermes); fall back to Buffer where present.
    if (typeof btoa === 'function') return btoa(bin);
    return Buffer.from(bytes).toString('base64');
}

export function hardwareBindingNonceBase64(body: Record<string, unknown>): string {
    return bytesToBase64(hardwareBindingNonceBytes(body));
}

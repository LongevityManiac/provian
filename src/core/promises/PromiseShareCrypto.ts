/**
 * PromiseShareCrypto — E2E-encrypted REMOTE promise share link (C3).
 * ==================================================================
 *
 * The remote promise path (two people NOT co-located) previously delivered NO
 * terms: the relay doc carries only signatures (PromiseRelayService), and the
 * share text was a bare `download?p=<id>` link. The counterparty therefore had
 * nothing to import — the first hop dropped the body.
 *
 * This module closes that gap by carrying the encrypted body in the share link
 * itself, end-to-end encrypted so no server ever sees the terms OR the key:
 *
 *   https://provian.ai/p?d=<base64url(ciphertext)>#k=<base64url(key)>
 *                          └── query (encrypted body) ─┘  └ fragment (key) ┘
 *
 * - `d` (the query) is the AES-256-GCM ciphertext of the promise terms. It can
 *   safely pass through any server, link unfurler, or the relay — it is opaque
 *   without the key.
 * - `k` (the URL FRAGMENT) is a FRESH RANDOM 256-bit key. Browsers and OSes
 *   NEVER send the fragment to a server, so the key travels only peer-to-peer
 *   through the messaging channel the user already chose (SMS/Signal/etc).
 *   Firestore / the relay stay content-free — no promise_sync rule change.
 *
 * Crypto: the SAME vetted primitive the PE cloud backup uses —
 * `gcm` from `@noble/ciphers/aes` (authenticated AES-256-GCM; decrypt THROWS on
 * any tamper or wrong key). This deliberately does NOT use ecdh-encryption.ts
 * (a dead XOR-masquerading-as-GCM helper). Unlike the PE archive key (seed-
 * derived, recoverable), the share key is fresh-random per promise and never
 * persisted — it exists only in the link.
 *
 * SECURITY: never log `d` or `k`. The key is the whole secret; a leaked fragment
 * defeats the encryption.
 */

import * as Crypto from 'expo-crypto';
// Authenticated AES-256-GCM — the same primitive PECloudSync uses for cloud PE
// backup. GCM ciphertext includes the 16-byte auth tag; decrypt throws on tamper.
import { gcm } from '@noble/ciphers/aes';
// Type-only import (erased at runtime → no PromiseService runtime dependency,
// so importing this module never drags in Firestore).
import type { PromiseQRPayload } from './PromiseService';

/** Layout version of the packed `d` blob. Bump only on a breaking format change. */
const SHARE_PAYLOAD_VERSION = 1;
const NONCE_BYTES = 12; // 96-bit GCM nonce
const KEY_BYTES = 32; // AES-256
const TAG_BYTES = 16; // GCM auth tag (appended to ciphertext by noble)

// Universal (HTTPS) link + custom-scheme fallback. Kept in sync with the strict
// allowlist in deepLinkValidator (PROMISE_IMPORT_*).
const PROMISE_IMPORT_HTTPS = 'https://provian.ai/p';
const PROMISE_IMPORT_FALLBACK = 'provian://promise';

/** The two halves of an encrypted share: ciphertext blob + the fragment key. */
export interface EncryptedPromiseShare {
    /** base64url( version(1) || nonce(12) || ciphertext+tag ) — server-safe. */
    d: string;
    /** base64url(32-byte AES key) — MUST live only in the URL fragment. */
    k: string;
}

export interface PromiseShareUrls {
    /** Universal link (preferred; needs AASA/assetlinks to open the app). */
    universalUrl: string;
    /** Custom-scheme fallback (works without AASA/assetlinks). */
    fallbackUrl: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// base64url (no padding) — RN-safe (the RN `buffer` polyfill lacks 'base64url',
// so we go through standard base64 + URL-safe substitution, byte-identical to
// Node's 'base64url'). Mirrors the established idiom in DAIBuilder.ts.
// ──────────────────────────────────────────────────────────────────────────────

function bytesToBase64Url(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = (globalThis as { btoa?: (s: string) => string }).btoa?.(binary) ?? '';
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
    // Only base64url alphabet is valid; reject anything else so a crafted link
    // fails closed rather than smuggling unexpected bytes through the decoder.
    if (!/^[A-Za-z0-9_-]*$/.test(s)) {
        throw new Error('PromiseShare: invalid base64url input');
    }
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    const bin = (globalThis as { atob?: (s: string) => string }).atob?.(b64) ?? '';
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function toUint8(raw: Uint8Array | ArrayBufferLike): Uint8Array {
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

// ──────────────────────────────────────────────────────────────────────────────
// Encrypt / decrypt
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Encrypt a promise payload (the same shape the QR flow uses) under a FRESH
 * random 256-bit key. Returns the ciphertext blob `d` and the key `k`; the
 * caller puts `d` in the query and `k` in the URL fragment.
 */
export async function encryptPromisePayload(
    payload: PromiseQRPayload,
): Promise<EncryptedPromiseShare> {
    const key = toUint8(await Crypto.getRandomBytesAsync(KEY_BYTES));
    const nonce = toUint8(await Crypto.getRandomBytesAsync(NONCE_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));

    const ciphertext = gcm(key, nonce).encrypt(plaintext); // includes auth tag

    const packed = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
    packed[0] = SHARE_PAYLOAD_VERSION;
    packed.set(nonce, 1);
    packed.set(ciphertext, 1 + NONCE_BYTES);

    return { d: bytesToBase64Url(packed), k: bytesToBase64Url(key) };
}

/**
 * Decrypt a share blob back into a promise payload. THROWS on a wrong/short key,
 * a tampered blob (GCM auth failure), an unknown version, or malformed JSON —
 * "Unknown = Block": a link we cannot fully verify yields no import.
 */
export function decryptPromisePayload(d: string, k: string): PromiseQRPayload {
    const key = base64UrlToBytes(k);
    if (key.length !== KEY_BYTES) {
        throw new Error('PromiseShare: bad key length');
    }

    const packed = base64UrlToBytes(d);
    if (packed.length < 1 + NONCE_BYTES + TAG_BYTES) {
        throw new Error('PromiseShare: blob too short');
    }
    if (packed[0] !== SHARE_PAYLOAD_VERSION) {
        throw new Error(`PromiseShare: unsupported version ${packed[0]}`);
    }

    const nonce = packed.slice(1, 1 + NONCE_BYTES);
    const ciphertext = packed.slice(1 + NONCE_BYTES);
    const plaintext = gcm(key, nonce).decrypt(ciphertext); // throws on auth failure

    const obj = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    assertPromisePayload(obj);
    return obj;
}

/**
 * Validate the decrypted object has the fields the import path needs. Authentic
 * ciphertext that decodes to a wrong shape (e.g. a future format) is rejected.
 */
function assertPromisePayload(o: unknown): asserts o is PromiseQRPayload {
    if (!o || typeof o !== 'object') {
        throw new Error('PromiseShare: payload is not an object');
    }
    const p = o as Record<string, unknown>;
    if (typeof p.promiseId !== 'string' || p.promiseId.length === 0) {
        throw new Error('PromiseShare: missing promiseId');
    }
    if (typeof p.creatorAddress !== 'string' || p.creatorAddress.length === 0) {
        throw new Error('PromiseShare: missing creatorAddress');
    }
    if (typeof p.creatorSignature !== 'string' || p.creatorSignature.length === 0) {
        throw new Error('PromiseShare: missing creatorSignature');
    }
    if (typeof p.theyGave !== 'string' || typeof p.theyOwe !== 'string') {
        throw new Error('PromiseShare: missing terms');
    }
    // Pass-3 #46: `who` (required) and `creatorName` (optional) MUST be strings.
    // The import path derives the local record's display name from creatorName /
    // who; an object-shaped value previously slipped through (validateTextField
    // no-opped on non-strings) and rendered "[object Object]".
    if (typeof p.who !== 'string') {
        throw new Error('PromiseShare: missing recipient');
    }
    if (p.creatorName !== undefined && typeof p.creatorName !== 'string') {
        throw new Error('PromiseShare: creatorName must be a string');
    }
    // Pass-3 #14: numeric date fields must be finite numbers, or `format(new
    // Date(bad))` throws at render — a persistent whole-app ErrorBoundary crash.
    if (typeof p.timestamp !== 'number' || !Number.isFinite(p.timestamp)) {
        throw new Error('PromiseShare: missing/invalid timestamp');
    }
    if (p.dueDate !== undefined && (typeof p.dueDate !== 'number' || !Number.isFinite(p.dueDate))) {
        throw new Error('PromiseShare: invalid dueDate');
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Link build
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the universal + fallback share URLs from an encrypted share. The key
 * ALWAYS rides the fragment (`#k=`), never the query. base64url is URL-safe, so
 * no percent-encoding is applied (and the fragment never reaches a server).
 */
export function buildPromiseShareUrls(share: EncryptedPromiseShare): PromiseShareUrls {
    const query = `d=${share.d}`;
    const fragment = `k=${share.k}`;
    return {
        universalUrl: `${PROMISE_IMPORT_HTTPS}?${query}#${fragment}`,
        fallbackUrl: `${PROMISE_IMPORT_FALLBACK}?${query}#${fragment}`,
    };
}

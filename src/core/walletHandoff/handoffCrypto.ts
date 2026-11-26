/**
 * Moving a wallet between the phone app and the web app with a QR code (both directions).
 *
 * The web app always shows the code and the phone always scans it. The code carries the relay's
 * session id and a 32-byte secret `k` that never reaches the relay. The receiving device makes a
 * fresh X25519 key pair for this one handoff and sends its public key through the relay with an
 * HMAC under `k`, so the relay cannot swap in a key of its own. The sending device seals the seed
 * to that key: X25519 with a one-time key of its own, then HKDF-SHA256 (salt `k`, bound to the
 * session and both public keys) to an AES-256-GCM key. The relay only ever holds ciphertext it
 * cannot open; without the receiver's private key and `k` nobody can.
 *
 * Both screens show the same six-digit code (an HMAC under `k` over the session and the receiver's
 * key), so the person can see the two devices are talking to each other before the seed is sent.
 *
 * Pure functions over @noble: the same code runs in Hermes on the phone and in the browser.
 */
import { gcm } from '@noble/ciphers/aes';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

export const HANDOFF_QR_PREFIX = 'PROVIAN-HANDOFF';
const QR_VERSION = '1';
const KEY_MAC_LABEL = 'provian-handoff-key-v1';
const MATCH_LABEL = 'provian-handoff-match-v1';
const SEAL_INFO = 'provian-handoff-seal-v1';
const ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

const enc = new TextEncoder();
const dec = new TextDecoder();

function randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

// Base64url through the Buffer shim (index.ts installs it first): Hermes has no reliable atob.
export function toB64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(value: string): Uint8Array {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('handoff_encoding_invalid');
    return new Uint8Array(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

/** The secret the code carries. Never sent to the relay. */
export function newHandoffSecret(): Uint8Array {
    return randomBytes(32);
}

export interface HandoffQr {
    id: string;
    secret: Uint8Array;
}

export function encodeHandoffQr({ id, secret }: HandoffQr): string {
    if (!ID_PATTERN.test(id) || secret.length !== 32) throw new Error('handoff_qr_invalid');
    return `${HANDOFF_QR_PREFIX}:${QR_VERSION}:${id}:${toB64Url(secret)}`;
}

/** Null for anything that is not a Provian handoff code (another QR the camera happened to see). */
export function decodeHandoffQr(text: string): HandoffQr | null {
    const parts = typeof text === 'string' ? text.trim().split(':') : [];
    if (parts.length !== 4 || parts[0] !== HANDOFF_QR_PREFIX || parts[1] !== QR_VERSION || !ID_PATTERN.test(parts[2])) return null;
    try {
        const secret = fromB64Url(parts[3]);
        return secret.length === 32 ? { id: parts[2], secret } : null;
    } catch {
        return null;
    }
}

export interface ReceiverKeyPair {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
}

/** The receiving device's key for this one handoff. */
export function newReceiverKeyPair(): ReceiverKeyPair {
    const privateKey = x25519.utils.randomSecretKey();
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** HMAC under the code's secret binding the receiver's key to this session. */
export function receiverKeyMac(secret: Uint8Array, id: string, receiverPublicKey: Uint8Array): string {
    return toB64Url(hmac(sha256, secret, concat(enc.encode(KEY_MAC_LABEL), enc.encode(id), receiverPublicKey)));
}

/** Throws unless the receiver key arrived exactly as the receiver sent it. */
export function verifyReceiverKey(secret: Uint8Array, id: string, receiverKeyB64: string, macB64: string): Uint8Array {
    const key = fromB64Url(receiverKeyB64);
    if (key.length !== 32) throw new Error('handoff_receiver_key_invalid');
    const expected = fromB64Url(receiverKeyMac(secret, id, key));
    if (!timingSafeEqual(expected, fromB64Url(macB64))) throw new Error('handoff_receiver_key_mismatch');
    return key;
}

/** The six-digit code both screens show. */
export function handoffMatchCode(secret: Uint8Array, id: string, receiverPublicKey: Uint8Array): string {
    const mac = hmac(sha256, secret, concat(enc.encode(MATCH_LABEL), enc.encode(id), receiverPublicKey));
    const value = ((mac[0] << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) >>> 0;
    const digits = String(value % 1_000_000).padStart(6, '0');
    return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export interface HandoffEnvelope {
    v: 1;
    epk: string;
    iv: string;
    ct: string;
}

export interface HandoffPayload {
    v: 1;
    mnemonic: string;
    wallet_address: string;
}

function sealKey(secret: Uint8Array, id: string, shared: Uint8Array, receiverPublicKey: Uint8Array, ephemeralPublicKey: Uint8Array): Uint8Array {
    return hkdf(sha256, shared, secret, concat(enc.encode(SEAL_INFO), enc.encode(id), receiverPublicKey, ephemeralPublicKey), 32);
}

/** Seal the seed for the receiver. Only the receiver's private key with the code's secret opens it. */
export function sealHandoff(input: { secret: Uint8Array; id: string; receiverPublicKey: Uint8Array; mnemonic: string; walletAddress: string }): HandoffEnvelope {
    const ephemeral = x25519.utils.randomSecretKey();
    const ephemeralPublicKey = x25519.getPublicKey(ephemeral);
    const shared = x25519.getSharedSecret(ephemeral, input.receiverPublicKey);
    const key = sealKey(input.secret, input.id, shared, input.receiverPublicKey, ephemeralPublicKey);
    const iv = randomBytes(12);
    const payload: HandoffPayload = { v: 1, mnemonic: input.mnemonic, wallet_address: input.walletAddress.toLowerCase() };
    const ct = gcm(key, iv, enc.encode(input.id)).encrypt(enc.encode(JSON.stringify(payload)));
    ephemeral.fill(0);
    shared.fill(0);
    key.fill(0);
    return { v: 1, epk: toB64Url(ephemeralPublicKey), iv: toB64Url(iv), ct: toB64Url(ct) };
}

/** Open a sealed seed. Throws on any tampering or a wrong key. */
export function openHandoff(input: { secret: Uint8Array; id: string; receiver: ReceiverKeyPair; envelope: HandoffEnvelope }): { mnemonic: string; walletAddress: string } {
    const { envelope } = input;
    if (!envelope || envelope.v !== 1) throw new Error('handoff_envelope_invalid');
    const ephemeralPublicKey = fromB64Url(envelope.epk);
    const iv = fromB64Url(envelope.iv);
    if (ephemeralPublicKey.length !== 32 || iv.length !== 12) throw new Error('handoff_envelope_invalid');
    const shared = x25519.getSharedSecret(input.receiver.privateKey, ephemeralPublicKey);
    const key = sealKey(input.secret, input.id, shared, input.receiver.publicKey, ephemeralPublicKey);
    let plain: Uint8Array;
    try {
        plain = gcm(key, iv, enc.encode(input.id)).decrypt(fromB64Url(envelope.ct));
    } catch {
        throw new Error('handoff_open_failed');
    } finally {
        shared.fill(0);
        key.fill(0);
    }
    const payload = JSON.parse(dec.decode(plain)) as HandoffPayload;
    if (payload?.v !== 1 || typeof payload.mnemonic !== 'string' || typeof payload.wallet_address !== 'string') throw new Error('handoff_envelope_invalid');
    return { mnemonic: payload.mnemonic, walletAddress: payload.wallet_address };
}

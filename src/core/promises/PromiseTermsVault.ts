import { registerSeedDerivedCache } from '../security/seedDerivedCache';
import { withBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * PromiseTermsVault — seed-derived, recoverable E2E encryption of promise terms
 * for the RELAY copy.
 *
 * When human promises moved to the relay, the terms had to move too — but the
 * relay must hold BYTES IT CANNOT READ, and a party who restores their wallet on
 * a new phone must recover their terms. This module encrypts each party's terms
 * under a key DERIVED FROM THE WALLET SEED (HKDF-SHA256 over the mnemonic, the
 * same construction PECloudSync uses for the PE archive), so:
 * - only that party's wallet key can decrypt their copy ("decryptable only by
 * the two parties' wallet keys" each party stores their OWN copy);
 * - the key is deterministic per seed, so a restored seed re-derives it and
 * recovers the terms; and
 * - Provian sees only opaque AES-256-GCM ciphertext.
 *
 * This is distinct from PromiseShareCrypto (the out-of-band SHARE LINK, keyed by
 * a fresh random fragment key) — that transport is unchanged; this is the
 * relay-stored, seed-recoverable copy.
 *
 * SECURITY: never log the plaintext terms or the derived key.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';
import * as Crypto from 'expo-crypto';
import SeedManager from '../wallet/SeedManager';
import { translate } from '../../i18n/translate';

const VERSION = 1;
const NONCE_BYTES = 12; // 96-bit GCM nonce
const KEY_BYTES = 32; // AES-256
const TAG_BYTES = 16; // GCM auth tag

// Fixed, non-secret domain separators. A fixed salt is fine for HKDF (the salt
// need not be secret or random); fixing it is what makes the key deterministic
// per seed and therefore recoverable from the seed ALONE — no salt to store.
const KDF_SALT = utf8ToBytes('provian.promise.terms.v1.salt');
const KDF_INFO = utf8ToBytes('provian.promise.terms.v1');

/** The party's own local view of the agreed terms (what a restore must rebuild). */
export interface PromiseTermsPayload {
  promiseId: string;
  theyGave: string;
  theyOwe: string;
  who: string;
  whoAddress?: string;
  creatorAddress: string;
  creatorName?: string;
  dueDate?: number;
  /** This party's OWN direction (creator and acceptor see opposite directions). */
  direction: 'i_owe' | 'owed_to_me';
  createdAt: number;
}

registerSeedDerivedCache(clearPromiseTermsKey);

let cachedKey: Uint8Array | null = null;

function toUint8(raw: Uint8Array | ArrayBufferLike): Uint8Array {
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return (globalThis as { btoa?: (s: string) => string }).btoa?.(binary) ?? '';
}

function base64ToBytes(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = (globalThis as { atob?: (s: string) => string }).atob?.(s) ?? '';
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Derive (and cache) the seed-derived AES-256-GCM key. Biometric-gated via
 * SeedManager.getMnemonic — callers encrypt right after signing (an active
 * biometric session) and decrypt inside an unlocked/recovery context.
 */
async function getTermsKey(biometricAction?: BiometricAction): Promise<Uint8Array> {
    if (cachedKey) return cachedKey;
    return await withBiometricAction(translate('biometricPrompts.unlockWalletKey', 'Unlock your wallet key'), async (biometricAction) => {

        if (cachedKey) return cachedKey;
        const mnemonic = await SeedManager.getMnemonic(biometricAction); // biometric-gated
        if (!mnemonic) throw new Error('[PromiseTermsVault] no wallet seed available');
        cachedKey = hkdf(sha256, utf8ToBytes(mnemonic), KDF_SALT, KDF_INFO, KEY_BYTES);
        return cachedKey;

    }, biometricAction);
}

/** Clear the cached key (call on lock / key rotation / emergency stop). */
export function clearPromiseTermsKey(): void {
  cachedKey?.fill(0);
  cachedKey = null;
}

/** Encrypt the party's own terms view → base64 blob for the relay. */
export async function encryptTermsToSelf(payload: PromiseTermsPayload, biometricAction?: BiometricAction): Promise<string> {
  const key = await getTermsKey(biometricAction);
  const nonce = toUint8(await Crypto.getRandomBytesAsync(NONCE_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = gcm(key, nonce).encrypt(plaintext); // includes the 16-byte tag
  const packed = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
  packed[0] = VERSION;
  packed.set(nonce, 1);
  packed.set(ciphertext, 1 + NONCE_BYTES);
  return bytesToBase64(packed);
}

/**
 * Decrypt a self-encrypted terms blob. THROWS on a wrong key (different seed),
 * a tampered blob (GCM auth failure), an unknown version, or malformed JSON —
 * Unknown = Block. Returns null for an empty/absent blob (nothing to restore).
 */
export function decryptTermsFromSelfWithKey(blob: string, key: Uint8Array): PromiseTermsPayload | null {
  if (!blob) return null;
  const packed = base64ToBytes(blob);
  if (packed.length < 1 + NONCE_BYTES + TAG_BYTES) throw new Error('[PromiseTermsVault] blob too short');
  if (packed[0] !== VERSION) throw new Error(`[PromiseTermsVault] unsupported version ${packed[0]}`);
  const nonce = packed.slice(1, 1 + NONCE_BYTES);
  const ciphertext = packed.slice(1 + NONCE_BYTES);
  const plaintext = gcm(key, nonce).decrypt(ciphertext); // throws on auth failure
  const obj = JSON.parse(new TextDecoder().decode(plaintext)) as PromiseTermsPayload;
  return obj;
}

export async function decryptTermsFromSelf(blob: string, biometricAction?: BiometricAction): Promise<PromiseTermsPayload | null> {
  const key = await getTermsKey(biometricAction);
  return decryptTermsFromSelfWithKey(blob, key);
}

/** Prime the derived terms key as part of unlock; never keeps a seed authorization. */
export async function initializePromiseTermsKey(action: BiometricAction): Promise<void> { await getTermsKey(action); }

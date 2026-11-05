/**
 * HMAC-protected AsyncStorage wrapper.
 *
 * Phase 2.10 - Theme 4 fix. Several modules persist policy / baseline /
 * rate-limit data in AsyncStorage without any integrity check, so a
 * device with filesystem access (rooted Android, jailbroken iOS, malware
 * in another sandboxed app, app clone via cloud-restore) can mutate the
 * data and the app will load it as-is on the next launch.
 *
 * This wrapper appends an HMAC over the value, computed with a key
 * derived from a per-install secret stored in expo-secure-store. On
 * read, the HMAC is verified before the value is returned. Tampered or
 * missing HMACs are treated as "value not present" so the caller's
 * existing initialise-from-server code path runs again.
 *
 * Storage format:
 *   { v: 1, payload: "<json>", mac: "<hex hmac-sha256>" }
 *
 * The per-install HMAC key is generated lazily on first use and stored
 * under SecureStore key 'provian_hmac_storage_key'. It never leaves the
 * device.
 *
 * NOTE: This is integrity, not confidentiality. Anyone with filesystem
 * access can still READ the stored values. For secrets (mnemonic, card
 * credentials, wallet keys) keep using expo-secure-store directly.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

const HMAC_KEY_STORE = 'provian_hmac_storage_key';
const FORMAT_VERSION = 1;

interface HmacEnvelope<T> {
  v: number;
  payload: T;
  mac: string;
}

let cachedKey: Uint8Array | null = null;

/**
 * Lazily fetch (or create) the per-install HMAC key. Stored in
 * expo-secure-store, hardware-backed where available.
 */
async function getHmacKey(): Promise<Uint8Array> {
  if (cachedKey) return cachedKey;

  const existing = await SecureStore.getItemAsync(HMAC_KEY_STORE);
  if (existing) {
    cachedKey = hexToBytes(existing);
    return cachedKey;
  }

  // Generate a fresh 32-byte key. crypto.getRandomValues is available
  // in React Native via the global crypto polyfill.
  const fresh = new Uint8Array(32);
  crypto.getRandomValues(fresh);
  await SecureStore.setItemAsync(HMAC_KEY_STORE, bytesToHex(fresh), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  cachedKey = fresh;
  return cachedKey;
}

/**
 * Compute the HMAC tag over a JSON payload string.
 */
function computeMac(key: Uint8Array, payloadJson: string): string {
  const tag = hmac(sha256, key, utf8ToBytes(payloadJson));
  return bytesToHex(tag);
}

/**
 * Constant-time comparison for two hex strings of equal length. Falls
 * back to a length check + xor accumulator. (We can't use Node's
 * timingSafeEqual in React Native.)
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Persist a JSON-serialisable value at `key` along with an HMAC tag
 * over its serialisation. Replaces any prior value at the same key.
 */
export async function setItemHmac<T>(key: string, value: T): Promise<void> {
  const hmacKey = await getHmacKey();
  const payloadJson = JSON.stringify(value);
  const mac = computeMac(hmacKey, payloadJson);
  const envelope: HmacEnvelope<T> = { v: FORMAT_VERSION, payload: value, mac };
  await AsyncStorage.setItem(key, JSON.stringify(envelope));
}

/**
 * Read and HMAC-verify a value at `key`. Returns null if:
 *   - The key is absent
 *   - The stored envelope is malformed
 *   - The HMAC tag doesn't verify (tamper detected)
 *   - The format version is unrecognised
 *
 * Tamper detection logs a security warning and removes the corrupt
 * entry so the next launch starts from a clean slate.
 */
export async function getItemHmac<T>(key: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;

  let parsed: HmacEnvelope<T>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not in our envelope format - treat as missing.
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || parsed.v !== FORMAT_VERSION || typeof parsed.mac !== 'string') {
    return null;
  }

  const hmacKey = await getHmacKey();
  const expectedMac = computeMac(hmacKey, JSON.stringify(parsed.payload));
  if (!constantTimeEqualHex(expectedMac, parsed.mac)) {
    console.warn(`[hmacAsyncStorage] HMAC mismatch on key "${key}" - discarding tampered value.`);
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return null;
  }

  return parsed.payload;
}

/**
 * Delete a key from HMAC-protected storage.
 */
export async function removeItemHmac(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}

/**
 * Read an HMAC-protected value with a one-time migration from plain
 * AsyncStorage. Used for keys that existed in plaintext before chunk-i
 * rolled out HMAC protection.
 *
 * Resolution order:
 *  1. Try to read+verify the HMAC envelope at `key`. If present and valid,
 *     return its payload.
 *  2. Otherwise, read plain AsyncStorage at the same `key`. If present
 *     and parseable, immediately re-write it as an HMAC envelope (silent
 *     migration), then return the parsed value.
 *  3. Otherwise return null.
 *
 * The legacy parser defaults to JSON.parse. Pass a custom `parseLegacy`
 * for keys whose plaintext format was not JSON.
 *
 * Migration is silent: callers always see either the parsed value or
 * null. Subsequent reads are pure HMAC.
 */
export async function getItemHmacWithLegacyFallback<T>(
  key: string,
  parseLegacy: (raw: string) => T = (raw) => JSON.parse(raw) as T,
): Promise<T | null> {
  const hmacValue = await getItemHmac<T>(key);
  if (hmacValue !== null) return hmacValue;

  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;

  // Skip legacy migration if the raw value looks like our envelope wrapper
  // (HMAC mismatch already caused getItemHmac to return null and remove
  // the key, so this branch is for plaintext leftovers only).
  try {
    const parsed = parseLegacy(raw);
    await setItemHmac(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Test-only: clear the cached HMAC key so the next access reads from
 * SecureStore again. Should not be called from production code.
 */
export function _resetHmacKeyCacheForTests(): void {
  cachedKey = null;
}

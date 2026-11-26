/**
 * expo-secure-store for the web app (Metro resolves `expo-secure-store` here when bundling for web).
 *
 * The phone keychain holds these items encrypted by the OS and readable by the app without a
 * prompt (WHEN_UNLOCKED_THIS_DEVICE_ONLY). In the browser each value is sealed with AES-256-GCM
 * under this browser profile's non-extractable device key (webKv.deviceAesKey) and the item name
 * is bound as associated data, so a value moved to another name does not open. The wallet seed
 * never lands here: it lives in the passkey + PIN vault (secureSeedWeb / webVault).
 */
import { deviceAesKey, seal, open, utf8, fromUtf8, type Sealed } from './webKv';

const PREFIX = 'provian_ss:';

export const AFTER_FIRST_UNLOCK = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const ALWAYS_THIS_DEVICE_ONLY = 4;
export const WHEN_UNLOCKED = 5;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;

export type KeychainAccessibilityConstant = number;

export interface SecureStoreOptions {
    keychainService?: string;
    keychainAccessible?: KeychainAccessibilityConstant;
    requireAuthentication?: boolean;
    authenticationPrompt?: string;
}

function storageKey(key: string, options?: SecureStoreOptions): string {
    return PREFIX + (options?.keychainService ? `${options.keychainService}:` : '') + key;
}

function assertKey(key: string): void {
    if (typeof key !== 'string' || !/^[\w.-]+$/.test(key)) {
        throw new Error(`Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".`);
    }
}

export async function isAvailableAsync(): Promise<boolean> {
    return typeof window !== 'undefined' && !!window.localStorage && !!globalThis.crypto?.subtle;
}

export async function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null> {
    assertKey(key);
    const raw = window.localStorage.getItem(storageKey(key, options));
    if (raw === null) return null;
    let sealed: Sealed;
    try {
        sealed = JSON.parse(raw) as Sealed;
    } catch {
        return null;
    }
    const bytes = await open(await deviceAesKey(), sealed, utf8(storageKey(key, options)));
    return fromUtf8(bytes);
}

export async function setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void> {
    assertKey(key);
    if (typeof value !== 'string') throw new Error('Invalid value provided to SecureStore. Values must be strings.');
    const sealed = await seal(await deviceAesKey(), utf8(value), utf8(storageKey(key, options)));
    window.localStorage.setItem(storageKey(key, options), JSON.stringify(sealed));
}

export async function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void> {
    assertKey(key);
    window.localStorage.removeItem(storageKey(key, options));
}

export function getItem(): string | null {
    throw new Error('SecureStore.getItem (synchronous) is not available on the web. Use getItemAsync.');
}

export function setItem(): void {
    throw new Error('SecureStore.setItem (synchronous) is not available on the web. Use setItemAsync.');
}

export function canUseBiometricAuthentication(): boolean {
    return false;
}

/** Every secure-store item this origin holds (Delete All Data). */
export function clearAllWebSecureStoreItems(): void {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
}

export default {
    AFTER_FIRST_UNLOCK,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    ALWAYS,
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    ALWAYS_THIS_DEVICE_ONLY,
    WHEN_UNLOCKED,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    isAvailableAsync,
    getItemAsync,
    setItemAsync,
    deleteItemAsync,
    getItem,
    setItem,
    canUseBiometricAuthentication,
};

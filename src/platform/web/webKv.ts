/**
 * Browser storage primitives for the web app.
 *
 * - `idbGet` / `idbSet` / `idbDelete`: one IndexedDB object store that can hold structured
 * values, including non-extractable WebCrypto keys (the browser keeps the key material out of
 * reach of page script; only the key handle is stored).
 * - `deviceAesKey()`: this browser profile's own AES-256-GCM key, created once and never
 * exportable. It encrypts the ordinary secure-store items (the relay credentials, the device
 * identity) the way the phone keychain holds them: readable on this device without a prompt.
 * - `seal` / `open`: AES-GCM with a fresh 96-bit IV, as `{ iv, ct }` base64 strings.
 */

const DB_NAME = 'provian-web';
const STORE = 'kv';
const DEVICE_KEY_ID = 'device-aes-key-v1';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { dbPromise = null; reject(request.error ?? new Error('indexeddb_unavailable')); };
    });
    return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    return openDb().then(db => new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result as T);
        transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('indexeddb_failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('indexeddb_aborted'));
    }));
}

export function idbGet<T>(key: string): Promise<T | undefined> {
    return tx<T | undefined>('readonly', store => store.get(key));
}

export function idbSet(key: string, value: unknown): Promise<void> {
    return tx<unknown>('readwrite', store => store.put(value, key)).then(() => undefined);
}

export function idbDelete(key: string): Promise<void> {
    return tx<unknown>('readwrite', store => store.delete(key)).then(() => undefined);
}

/** Remove every IndexedDB record this app keeps (Delete All Data). */
export async function idbClearAll(): Promise<void> {
    await tx<unknown>('readwrite', store => store.clear());
    deviceKeyPromise = null;
}

let deviceKeyPromise: Promise<CryptoKey> | null = null;

export function deviceAesKey(): Promise<CryptoKey> {
    if (deviceKeyPromise) return deviceKeyPromise;
    deviceKeyPromise = (async () => {
        const existing = await idbGet<CryptoKey>(DEVICE_KEY_ID);
        if (existing) return existing;
        const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await idbSet(DEVICE_KEY_ID, created);
        // Another tab may have raced us; whichever landed is the one every tab uses.
        return (await idbGet<CryptoKey>(DEVICE_KEY_ID)) ?? created;
    })();
    deviceKeyPromise.catch(() => { deviceKeyPromise = null; });
    return deviceKeyPromise;
}

export interface Sealed { iv: string; ct: string }

export function toB64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

export function fromB64(value: string): Uint8Array {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

export function toB64Url(bytes: Uint8Array): string {
    return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    return fromB64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function seal(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: bufferOf(iv), ...(aad ? { additionalData: bufferOf(aad) } : {}) },
        key,
        bufferOf(plaintext),
    ));
    return { iv: toB64(iv), ct: toB64(ct) };
}

export async function open(key: CryptoKey, sealed: Sealed, aad?: Uint8Array): Promise<Uint8Array> {
    const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bufferOf(fromB64(sealed.iv)), ...(aad ? { additionalData: bufferOf(aad) } : {}) },
        key,
        bufferOf(fromB64(sealed.ct)),
    );
    return new Uint8Array(pt);
}

export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export { bufferOf };

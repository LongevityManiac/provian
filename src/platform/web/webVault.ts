/**
 * The web app's wallet vault: where the seed lives in a browser.
 *
 * Creating the vault makes a passkey and takes the person's PIN. A random 256-bit data key (DEK)
 * encrypts every seed item; the DEK itself is stored only wrapped under
 *   KEK = HKDF(passkey PRF secret || PBKDF2(PIN)),
 * so opening the wallet always takes both the passkey (Touch ID / Windows Hello) and the PIN.
 * While the vault is open the DEK is held in memory only; locking (or closing the tab) drops it.
 *
 * The passkey must support the WebAuthn PRF extension. A passkey without PRF is refused rather
 * than replaced by a secret kept in the browser, because a secret in the browser would let a copy of
 * the browser's storage be attacked with PIN guesses alone. With PRF every guess needs the
 * authenticator, so the store on disk cannot be attacked offline. Wrong PINs: after five in a row
 * the vault makes the person wait, doubling each time (capped at one hour).
 */
import { createPasskey, getPasskey, PasskeyUnavailableError, type PasskeyAssertion } from './passkey';
import { deriveAesKey, pinKeyBytes, pinIsAcceptable, VAULT_INFO } from './keyDerivation';
import { bufferOf, fromB64, fromB64Url, fromUtf8, open, seal, toB64, toB64Url, utf8, type Sealed } from './webKv';

const VAULT_KEY = 'provian_web_vault_v1';
const SEED_PREFIX = 'provian_seed:';

export interface VaultRecord {
    v: 1;
    credentialId: string;
    /** Always true: a vault exists only for a PRF passkey. */
    prf: boolean;
    pinSalt: string;
    wrappedDek: Sealed;
    publicKeySpki?: string | null;
    publicKeyAlgorithm?: number | null;
    createdAt: number;
    failures?: number;
    lockedUntil?: number;
}

export class WrongPinError extends Error {
    constructor(readonly remainingBeforeWait: number) { super('wrong_pin'); this.name = 'WrongPinError'; }
}
export class VaultLockedOutError extends Error {
    constructor(readonly until: number) { super('vault_wait'); this.name = 'VaultLockedOutError'; }
}
export class VaultMissingError extends Error {
    constructor() { super('vault_missing'); this.name = 'VaultMissingError'; }
}
export class VaultClosedError extends Error {
    constructor() { super('vault_closed'); this.name = 'VaultClosedError'; }
}
/** The passkey has no PRF secret, so it cannot protect a wallet in this browser. */
export class PasskeyNoPrfError extends Error {
    constructor() { super('passkey_prf_unsupported'); this.name = 'PasskeyNoPrfError'; }
}

interface OpenState {
    dek: CryptoKey;
    /** Kept only while open, so a passkey backup can be made without asking again. */
    prf: Uint8Array;
    pin: string;
    verifiedAt: number;
}

let state: OpenState | null = null;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

export function onVaultChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function readVault(): VaultRecord | null {
    const raw = window.localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as VaultRecord;
        return parsed && parsed.v === 1 && typeof parsed.credentialId === 'string' ? parsed : null;
    } catch {
        return null;
    }
}

function writeVault(record: VaultRecord): void {
    window.localStorage.setItem(VAULT_KEY, JSON.stringify(record));
}

export const hasVault = (): boolean => readVault() !== null;
export const isVaultOpen = (): boolean => state !== null;

function secretFor(record: VaultRecord, assertion: { prf: Uint8Array | null }): Uint8Array {
    if (!record.prf) throw new Error('vault_corrupt');
    if (!assertion.prf) throw new PasskeyNoPrfError();
    return assertion.prf;
}

async function kekFor(record: VaultRecord, secret: Uint8Array, pin: string): Promise<CryptoKey> {
    const salt = fromB64(record.pinSalt);
    return deriveAesKey(secret, await pinKeyBytes(pin, salt), salt, VAULT_INFO);
}

/**
 * Create the vault: a new passkey (one prompt) and the PIN. Leaves the vault open.
 * If the passkey returned no PRF at creation, one more passkey prompt fetches it; a passkey that
 * has no PRF at all is refused (PasskeyNoPrfError) and no vault is written.
 */
export async function createVault(pin: string, label: string): Promise<{ credentialId: string; prf: boolean }> {
    if (!pinIsAcceptable(pin)) throw new Error('pin_invalid');
    const created = await createPasskey(label);
    let prf = created.prf;
    if (!prf) {
        try {
            prf = (await getPasskey({ allow: [created.credentialId] })).prf;
        } catch (err) {
            if (err instanceof PasskeyUnavailableError) throw err;
            prf = null;
        }
    }
    if (!prf) throw new PasskeyNoPrfError();
    const pinSalt = crypto.getRandomValues(new Uint8Array(32));
    const record: VaultRecord = {
        v: 1,
        credentialId: toB64Url(created.credentialId),
        prf: true,
        pinSalt: toB64(pinSalt),
        wrappedDek: { iv: '', ct: '' },
        publicKeySpki: created.publicKeySpki ? toB64(created.publicKeySpki) : null,
        publicKeyAlgorithm: created.publicKeyAlgorithm,
        createdAt: Date.now(),
    };
    const dekRaw = crypto.getRandomValues(new Uint8Array(32));
    record.wrappedDek = await seal(await kekFor(record, prf, pin), dekRaw, utf8('dek'));
    const dek = await crypto.subtle.importKey('raw', bufferOf(dekRaw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    dekRaw.fill(0);
    writeVault(record);
    state = { dek, prf, pin, verifiedAt: Date.now() };
    notify();
    return { credentialId: record.credentialId, prf: record.prf };
}

/**
 * Create this browser's vault from a passkey the person already has (restoring with the passkey
 * backup on a new computer): no new passkey, the same PIN, the same PRF secret. `publicKey` is the
 * passkey's public key as the relay holds it, so this browser can refresh the passkey backup later.
 */
export async function createVaultFromPasskey(
    pin: string,
    assertion: PasskeyAssertion,
    publicKey?: { spki: string; algorithm: number } | null,
): Promise<void> {
    if (!pinIsAcceptable(pin)) throw new Error('pin_invalid');
    if (!assertion.prf) throw new PasskeyNoPrfError();
    const pinSalt = crypto.getRandomValues(new Uint8Array(32));
    const record: VaultRecord = {
        v: 1,
        credentialId: toB64Url(assertion.credentialId),
        prf: true,
        pinSalt: toB64(pinSalt),
        wrappedDek: { iv: '', ct: '' },
        publicKeySpki: publicKey?.spki ?? null,
        publicKeyAlgorithm: publicKey?.algorithm ?? null,
        createdAt: Date.now(),
    };
    const dekRaw = crypto.getRandomValues(new Uint8Array(32));
    record.wrappedDek = await seal(await kekFor(record, assertion.prf, pin), dekRaw, utf8('dek'));
    const dek = await crypto.subtle.importKey('raw', bufferOf(dekRaw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    dekRaw.fill(0);
    writeVault(record);
    state = { dek, prf: assertion.prf, pin, verifiedAt: Date.now() };
    notify();
}

function waitFor(failures: number): number {
    if (failures < 5) return 0;
    return Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** (failures - 5));
}

/**
 * Open the vault with the passkey and the PIN. Call from a click handler: Safari only shows the
 * passkey sheet in response to a user gesture, so the passkey is asked for first.
 */
export async function unlockVault(pin: string, assertion?: PasskeyAssertion): Promise<void> {
    const record = readVault();
    if (!record) throw new VaultMissingError();
    if (record.lockedUntil && record.lockedUntil > Date.now()) throw new VaultLockedOutError(record.lockedUntil);
    const passkey = assertion ?? await getPasskey({ allow: [fromB64Url(record.credentialId)] });
    const secret = secretFor(record, passkey);
    let dekRaw: Uint8Array;
    try {
        dekRaw = await open(await kekFor(record, secret, pin), record.wrappedDek, utf8('dek'));
    } catch {
        const failures = (record.failures ?? 0) + 1;
        const wait = waitFor(failures);
        writeVault({ ...record, failures, lockedUntil: wait ? Date.now() + wait : undefined });
        throw wait ? new VaultLockedOutError(Date.now() + wait) : new WrongPinError(5 - failures);
    }
    const dek = await crypto.subtle.importKey('raw', bufferOf(dekRaw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    dekRaw.fill(0);
    if (record.failures || record.lockedUntil) writeVault({ ...record, failures: 0, lockedUntil: undefined });
    state = { dek, prf: secret, pin, verifiedAt: Date.now() };
    notify();
}

/** A fresh passkey check while the vault is open (each sensitive action, like Face ID per action on the phone). */
export async function confirmPresence(): Promise<void> {
    const record = readVault();
    if (!record) throw new VaultMissingError();
    if (!state) throw new VaultClosedError();
    const passkey = await getPasskey({ allow: [fromB64Url(record.credentialId)] });
    if (record.prf && passkey.prf) state.prf = passkey.prf;
    state.verifiedAt = Date.now();
}

export function lastVerifiedAt(): number {
    return state?.verifiedAt ?? 0;
}

export function lockVault(): void {
    if (!state) return;
    state = null;
    notify();
}

/** The open vault's passkey secret and PIN, for making a passkey backup right after setup/unlock. */
export function openVaultSecrets(): { prf: Uint8Array; pin: string; credentialId: string; publicKeySpki: string | null; publicKeyAlgorithm: number | null } | null {
    const record = readVault();
    if (!state || !record) return null;
    return {
        prf: state.prf,
        pin: state.pin,
        credentialId: record.credentialId,
        publicKeySpki: record.publicKeySpki ?? null,
        publicKeyAlgorithm: record.publicKeyAlgorithm ?? null,
    };
}

export function vaultHasPrf(): boolean {
    return readVault()?.prf === true;
}

export function vaultHasPublicKey(): boolean {
    const record = readVault();
    return typeof record?.publicKeySpki === 'string' && typeof record.publicKeyAlgorithm === 'number';
}

const seedKey = (key: string): string => SEED_PREFIX + key;

export function hasSeedItem(key: string): boolean {
    return window.localStorage.getItem(seedKey(key)) !== null;
}

export async function writeSeedItem(key: string, value: string): Promise<void> {
    if (!state) throw new VaultClosedError();
    const sealed = await seal(state.dek, utf8(value), utf8(seedKey(key)));
    window.localStorage.setItem(seedKey(key), JSON.stringify(sealed));
}

export async function readSeedItem(key: string): Promise<string | null> {
    const raw = window.localStorage.getItem(seedKey(key));
    if (raw === null) return null;
    if (!state) throw new VaultClosedError();
    return fromUtf8(await open(state.dek, JSON.parse(raw) as Sealed, utf8(seedKey(key))));
}

export function deleteSeedItem(key: string): void {
    window.localStorage.removeItem(seedKey(key));
}

/** Remove the vault, every seed item and the open state (Delete All Data). */
export function wipeVault(): void {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && (key === VAULT_KEY || key.startsWith(SEED_PREFIX))) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
    state = null;
    notify();
}

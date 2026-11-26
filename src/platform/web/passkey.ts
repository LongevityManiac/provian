/**
 * Passkeys (WebAuthn) for the web app: Touch ID / Face ID / Windows Hello / a security key.
 *
 * One passkey per wallet on this origin. Its PRF extension gives 32 secret bytes that only the
 * authenticator can produce, the same on every device the passkey syncs to (iCloud Keychain,
 * Google Password Manager). Those bytes plus the person's PIN derive the keys that encrypt the
 * seed: in this browser (webVault) and in the passkey backup Provian stores (passkeyBackup).
 * Every call asks for user verification, so each use is a fingerprint, face or device PIN.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bufferOf, toB64Url, utf8 } from './webKv';

/** The PRF input. Constant, so a synced passkey yields the same secret on any computer. */
export const PRF_SALT: Uint8Array = sha256(utf8('provian-passkey-prf-v1'));

export class PasskeyUnavailableError extends Error {
    constructor() { super('passkey_unavailable'); this.name = 'PasskeyUnavailableError'; }
}
export class PasskeyCancelledError extends Error {
    constructor() { super('passkey_cancelled'); this.name = 'PasskeyCancelledError'; }
}

export function webAuthnAvailable(): boolean {
    return typeof window !== 'undefined'
        && typeof window.PublicKeyCredential === 'function'
        && !!navigator.credentials?.create;
}

export async function platformAuthenticatorAvailable(): Promise<boolean> {
    if (!webAuthnAvailable()) return false;
    try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
        return false;
    }
}

export function rpId(): string {
    return window.location.hostname;
}

interface PrfOutputs { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } }

function prfBytes(credential: PublicKeyCredential): Uint8Array | null {
    const ext = credential.getClientExtensionResults() as { prf?: PrfOutputs };
    const first = ext.prf?.results?.first;
    if (!first) return null;
    const bytes = first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
    return bytes.length >= 32 ? bytes.slice(0, 32) : null;
}

function mapError(err: unknown): never {
    const name = (err as { name?: string })?.name;
    if (name === 'NotAllowedError' || name === 'AbortError') throw new PasskeyCancelledError();
    throw err instanceof Error ? err : new Error(String(err));
}

export interface CreatedPasskey {
    credentialId: Uint8Array;
    prf: Uint8Array | null;
    publicKeySpki: Uint8Array | null;
    publicKeyAlgorithm: number | null;
}

export async function createPasskey(label: string): Promise<CreatedPasskey> {
    if (!webAuthnAvailable()) throw new PasskeyUnavailableError();
    const userId = crypto.getRandomValues(new Uint8Array(16));
    let credential: PublicKeyCredential | null;
    try {
        credential = await navigator.credentials.create({
            publicKey: {
                rp: { id: rpId(), name: 'Provian' },
                user: { id: bufferOf(userId), name: label, displayName: label },
                challenge: bufferOf(crypto.getRandomValues(new Uint8Array(32))),
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
                authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
                timeout: 120000,
                attestation: 'none',
                extensions: { prf: { eval: { first: bufferOf(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
            },
        }) as PublicKeyCredential | null;
    } catch (err) {
        mapError(err);
    }
    if (!credential) throw new PasskeyCancelledError();
    const response = credential.response as AuthenticatorAttestationResponse;
    const spki = typeof response.getPublicKey === 'function' ? response.getPublicKey() : null;
    const alg = typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : null;
    return {
        credentialId: new Uint8Array(credential.rawId),
        prf: prfBytes(credential),
        publicKeySpki: spki ? new Uint8Array(spki) : null,
        publicKeyAlgorithm: alg,
    };
}

export interface PasskeyAssertion {
    credentialId: Uint8Array;
    prf: Uint8Array | null;
    authenticatorData: Uint8Array;
    clientDataJSON: Uint8Array;
    signature: Uint8Array;
}

/**
 * Ask for the passkey. `allow` limits the choice to known credentials (this browser's vault);
 * omit it to let the person pick any Provian passkey (restoring on a new computer).
 */
export async function getPasskey(options: { allow?: Uint8Array[]; challenge?: Uint8Array } = {}): Promise<PasskeyAssertion> {
    if (!webAuthnAvailable()) throw new PasskeyUnavailableError();
    let credential: PublicKeyCredential | null;
    try {
        credential = await navigator.credentials.get({
            publicKey: {
                rpId: rpId(),
                challenge: bufferOf(options.challenge ?? crypto.getRandomValues(new Uint8Array(32))),
                userVerification: 'required',
                timeout: 120000,
                ...(options.allow?.length
                    ? { allowCredentials: options.allow.map(id => ({ type: 'public-key' as const, id: bufferOf(id) })) }
                    : {}),
                extensions: { prf: { eval: { first: bufferOf(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
            },
        }) as PublicKeyCredential | null;
    } catch (err) {
        mapError(err);
    }
    if (!credential) throw new PasskeyCancelledError();
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
        credentialId: new Uint8Array(credential.rawId),
        prf: prfBytes(credential),
        authenticatorData: new Uint8Array(response.authenticatorData),
        clientDataJSON: new Uint8Array(response.clientDataJSON),
        signature: new Uint8Array(response.signature),
    };
}

export const credentialIdString = (id: Uint8Array): string => toB64Url(id);

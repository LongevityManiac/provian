/**
 * The passkey backup, browser side.
 *
 * Making one: the seed (and the wallet address it derives) is sealed with AES-256-GCM under
 *   HKDF(passkey PRF secret || PBKDF2(PIN, fresh salt)), info 'provian-passkey-backup-v1'
 * and sent to the relay with the passkey's public key. Provian stores ciphertext it can never open.
 *
 * Restoring on another computer: one passkey prompt (any Provian passkey on this site) signs the
 * relay's challenge AND yields the PRF secret; the relay checks the signature and returns the
 * envelope; the PIN opens it here. The passkey then becomes this browser's vault passkey too.
 */
import { pinKeyBytes, deriveAesKey, BACKUP_INFO, PIN_KDF_ITERATIONS, pinIsAcceptable } from './keyDerivation';
import { getPasskey, rpId, type PasskeyAssertion } from './passkey';
import { fromB64, fromB64Url, fromUtf8, open, seal, toB64, toB64Url, utf8 } from './webKv';
import { openVaultSecrets, vaultHasPrf, vaultHasPublicKey } from './webVault';

export interface PasskeyBackupEnvelope {
    v: 1;
    kdf: 'pbkdf2-sha256+hkdf-sha256';
    iterations: number;
    pin_salt: string;
    iv: string;
    ct: string;
}

interface BackupPayload { v: 1; mnemonic: string; wallet_address: string; created_at: string }

const AAD = utf8('provian-passkey-backup-v1');

export class PasskeyBackupUnsupportedError extends Error {
    constructor() { super('passkey_prf_unsupported'); this.name = 'PasskeyBackupUnsupportedError'; }
}
export class PasskeyBackupWrongPinError extends Error {
    constructor() { super('wrong_pin'); this.name = 'PasskeyBackupWrongPinError'; }
}

/** True when this browser's vault can make a passkey backup: a PRF passkey whose public key it knows. */
export function canMakePasskeyBackup(): boolean {
    return vaultHasPrf() && vaultHasPublicKey();
}

export async function sealPasskeyBackup(prf: Uint8Array, pin: string, mnemonic: string, walletAddress: string): Promise<PasskeyBackupEnvelope> {
    if (!pinIsAcceptable(pin)) throw new Error('pin_invalid');
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const key = await deriveAesKey(prf, await pinKeyBytes(pin, salt), salt, BACKUP_INFO);
    const payload: BackupPayload = { v: 1, mnemonic, wallet_address: walletAddress.toLowerCase(), created_at: new Date().toISOString() };
    const sealed = await seal(key, utf8(JSON.stringify(payload)), AAD);
    return { v: 1, kdf: 'pbkdf2-sha256+hkdf-sha256', iterations: PIN_KDF_ITERATIONS, pin_salt: toB64(salt), iv: sealed.iv, ct: sealed.ct };
}

export async function openPasskeyBackup(prf: Uint8Array, pin: string, envelope: PasskeyBackupEnvelope): Promise<{ mnemonic: string; walletAddress: string }> {
    if (envelope?.v !== 1 || envelope.kdf !== 'pbkdf2-sha256+hkdf-sha256') throw new Error('passkey_backup_format_unknown');
    const salt = fromB64(envelope.pin_salt);
    const key = await deriveAesKey(prf, await pinKeyBytes(pin, salt, envelope.iterations), salt, BACKUP_INFO);
    let bytes: Uint8Array;
    try {
        bytes = await open(key, { iv: envelope.iv, ct: envelope.ct }, AAD);
    } catch {
        throw new PasskeyBackupWrongPinError();
    }
    const payload = JSON.parse(fromUtf8(bytes)) as BackupPayload;
    if (payload.v !== 1 || typeof payload.mnemonic !== 'string' || typeof payload.wallet_address !== 'string') throw new Error('passkey_backup_format_unknown');
    return { mnemonic: payload.mnemonic, walletAddress: payload.wallet_address };
}

export interface PasskeyBackupRelay {
    storePasskeyBackup(body: Record<string, unknown>): Promise<void>;
}

/**
 * Make (or refresh) the passkey backup of the open vault's wallet. `mnemonic` comes from the
 * caller's own seed read; it is sealed here and never leaves the browser in the clear.
 */
export async function makePasskeyBackup(relay: PasskeyBackupRelay, mnemonic: string, walletAddress: string): Promise<void> {
    const secrets = openVaultSecrets();
    if (!secrets) throw new Error('vault_closed');
    if (!secrets.publicKeySpki || secrets.publicKeyAlgorithm === null) throw new Error('passkey_public_key_unavailable');
    const envelope = await sealPasskeyBackup(secrets.prf, secrets.pin, mnemonic, walletAddress);
    await relay.storePasskeyBackup({
        credential_id: secrets.credentialId,
        public_key_spki: secrets.publicKeySpki,
        public_key_alg: secrets.publicKeyAlgorithm,
        rp_id: rpId(),
        wallet_address: walletAddress.toLowerCase(),
        envelope,
    });
}

export interface PasskeyRestoreRelay {
    passkeyBackupChallenge(): Promise<string>;
    fetchPasskeyBackup(assertion: { credential_id: string; authenticator_data: string; client_data_json: string; signature: string }): Promise<{ wallet_address: string; envelope: Record<string, unknown>; public_key_spki?: string; public_key_alg?: number }>;
}

/** Ask for the passkey over a relay challenge (call from a click with a challenge fetched beforehand). */
export async function assertForRestore(challenge: string): Promise<PasskeyAssertion> {
    return getPasskey({ challenge: fromB64Url(challenge) });
}

export async function fetchAndOpenPasskeyBackup(
    relay: PasskeyRestoreRelay,
    assertion: PasskeyAssertion,
    pin: string,
): Promise<{ mnemonic: string; walletAddress: string; publicKey: { spki: string; algorithm: number } | null }> {
    if (!assertion.prf) throw new PasskeyBackupUnsupportedError();
    const backup = await relay.fetchPasskeyBackup({
        credential_id: toB64Url(assertion.credentialId),
        authenticator_data: toB64Url(assertion.authenticatorData),
        client_data_json: toB64Url(assertion.clientDataJSON),
        signature: toB64Url(assertion.signature),
    });
    const opened = await openPasskeyBackup(assertion.prf, pin, backup.envelope as unknown as PasskeyBackupEnvelope);
    if (opened.walletAddress.toLowerCase() !== backup.wallet_address.toLowerCase()) throw new Error('passkey_backup_wallet_mismatch');
    const publicKey = typeof backup.public_key_spki === 'string' && typeof backup.public_key_alg === 'number'
        ? { spki: backup.public_key_spki, algorithm: backup.public_key_alg }
        : null;
    return { ...opened, publicKey };
}

/**
 * Passkey backup: the web app's way to restore a wallet on another computer with the person's
 * passkey and PIN.
 *
 * The browser encrypts the seed under a key derived from the passkey's PRF secret (which only the
 * person's authenticator can produce) and their PIN, and stores the ciphertext here. Provian holds
 * only that ciphertext and the passkey's PUBLIC key: it can never open a backup.
 *
 * Handing a backup out takes a WebAuthn assertion from the same passkey, signed over a fresh,
 * single-use challenge from this relay, made on an allowed origin with user verification. The
 * envelope alone is useless without the passkey and the PIN; the assertion keeps it from being
 * handed to anyone who merely knows a credential id.
 *
 * Delete All Data erases every backup of the account (core/wallet/delete-user-data.ts).
 */
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';

export const PASSKEY_BACKUPS_COLLECTION = 'passkey_backups';
export const PASSKEY_BACKUP_CHALLENGES_COLLECTION = 'passkey_backup_challenges';
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_BACKUPS_PER_USER = 10;

/** Where the web app runs. A passkey is bound to its RP id; an assertion names its origin. */
export function allowedWebAuthnOrigins(env: NodeJS.ProcessEnv = process.env): { origins: string[]; rpIds: string[] } {
    const origins = ['https://app.provian.ai'];
    const rpIds = ['app.provian.ai'];
    if (env.NODE_ENV !== 'production') {
        origins.push('http://localhost:8081');
        rpIds.push('localhost');
    }
    return { origins, rpIds };
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function b64urlToBuffer(value: string): Buffer {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function backupDocId(credentialId: string): string {
    return crypto.createHash('sha256').update(credentialId).digest('hex');
}

export interface PasskeyBackupEnvelope {
    v: 1;
    kdf: 'pbkdf2-sha256+hkdf-sha256';
    iterations: number;
    pin_salt: string;
    iv: string;
    ct: string;
}

export interface StoredPasskeyBackup {
    user_id: string;
    wallet_address: string;
    credential_id: string;
    public_key_spki: string;
    public_key_alg: number;
    rp_id: string;
    envelope: PasskeyBackupEnvelope;
    created_at: number;
    updated_at: number;
}

export class PasskeyBackupError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); this.name = 'PasskeyBackupError'; }
}

function bad(code: string): never {
    throw new PasskeyBackupError(400, code);
}

export function validateEnvelope(raw: unknown): PasskeyBackupEnvelope {
    if (!raw || typeof raw !== 'object') bad('envelope_invalid');
    const e = raw as Record<string, unknown>;
    if (e.v !== 1 || e.kdf !== 'pbkdf2-sha256+hkdf-sha256') bad('envelope_invalid');
    if (typeof e.iterations !== 'number' || !Number.isInteger(e.iterations) || e.iterations < 100_000 || e.iterations > 10_000_000) bad('envelope_invalid');
    for (const field of ['pin_salt', 'iv', 'ct'] as const) {
        const value = e[field];
        if (typeof value !== 'string' || !B64.test(value) || value.length > 4096) bad('envelope_invalid');
    }
    if ((e.iv as string).length !== 16 || (e.pin_salt as string).length < 24) bad('envelope_invalid');
    return { v: 1, kdf: 'pbkdf2-sha256+hkdf-sha256', iterations: e.iterations as number, pin_salt: e.pin_salt as string, iv: e.iv as string, ct: e.ct as string };
}

function validPublicKey(spkiB64: unknown, alg: unknown): crypto.KeyObject {
    if (typeof spkiB64 !== 'string' || !B64.test(spkiB64) || spkiB64.length > 1024) bad('public_key_invalid');
    if (alg !== -7 && alg !== -257) bad('public_key_alg_unsupported');
    let key: crypto.KeyObject;
    try {
        key = crypto.createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' });
    } catch {
        bad('public_key_invalid');
    }
    const type = key.asymmetricKeyType;
    if ((alg === -7 && type !== 'ec') || (alg === -257 && type !== 'rsa')) bad('public_key_alg_mismatch');
    if (alg === -7 && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') bad('public_key_alg_mismatch');
    return key;
}

/** Store (or replace) the backup a passkey of this account protects. */
export async function storePasskeyBackup(db: Firestore, input: {
    userId: string; accountWalletAddress: string | null; body: Record<string, unknown>; nowMs?: number;
}): Promise<{ credential_id: string }> {
    const { body } = input;
    const credentialId = body.credential_id;
    if (typeof credentialId !== 'string' || !B64URL.test(credentialId) || credentialId.length < 16 || credentialId.length > 1400) bad('credential_id_invalid');
    const walletAddress = typeof body.wallet_address === 'string' ? body.wallet_address.toLowerCase() : '';
    if (!/^0x[0-9a-f]{40}$/.test(walletAddress)) bad('wallet_address_invalid');
    // A backup belongs to the account's own wallet, never to another address.
    if (!input.accountWalletAddress || input.accountWalletAddress.toLowerCase() !== walletAddress) {
        throw new PasskeyBackupError(403, 'wallet_address_not_this_account');
    }
    const rpId = body.rp_id;
    if (typeof rpId !== 'string' || !allowedWebAuthnOrigins().rpIds.includes(rpId)) bad('rp_id_not_allowed');
    validPublicKey(body.public_key_spki, body.public_key_alg);
    const envelope = validateEnvelope(body.envelope);

    const nowMs = input.nowMs ?? Date.now();
    const ref = db.collection(PASSKEY_BACKUPS_COLLECTION).doc(backupDocId(credentialId));
    const existing = await ref.get();
    if (existing.exists && existing.data()?.user_id !== input.userId) throw new PasskeyBackupError(409, 'credential_belongs_to_another_account');
    if (!existing.exists) {
        const count = await db.collection(PASSKEY_BACKUPS_COLLECTION).where('user_id', '==', input.userId).limit(MAX_BACKUPS_PER_USER).get();
        if (count.size >= MAX_BACKUPS_PER_USER) throw new PasskeyBackupError(409, 'too_many_passkey_backups');
    }
    const record: StoredPasskeyBackup = {
        user_id: input.userId,
        wallet_address: walletAddress,
        credential_id: credentialId,
        public_key_spki: body.public_key_spki as string,
        public_key_alg: body.public_key_alg as number,
        rp_id: rpId,
        envelope,
        created_at: existing.exists ? Number(existing.data()?.created_at ?? nowMs) : nowMs,
        updated_at: nowMs,
    };
    await ref.set(record);
    return { credential_id: credentialId };
}

/** Expired challenges removed per issued challenge: more than are issued, so the collection cannot grow. */
export const CHALLENGE_SWEEP_LIMIT = 25;

export async function issuePasskeyChallenge(db: Firestore, nowMs = Date.now()): Promise<{ challenge: string; expires_at: number }> {
    const challenge = crypto.randomBytes(32).toString('base64url');
    const expires = nowMs + CHALLENGE_TTL_MS;
    const challenges = db.collection(PASSKEY_BACKUP_CHALLENGES_COLLECTION);
    await challenges.doc(backupDocId(challenge)).set({ expires_at: expires, created_at: nowMs });
    // A challenge that is never used is never consumed. Each issue clears up to
    // CHALLENGE_SWEEP_LIMIT expired ones, before answering (no work runs after the response).
    try {
        const expired = await challenges.where('expires_at', '<', nowMs).limit(CHALLENGE_SWEEP_LIMIT).get();
        await Promise.all(expired.docs.map(doc => doc.ref.delete()));
    } catch {
        // A failed sweep never blocks a restore; the next issue sweeps again.
    }
    return { challenge, expires_at: expires };
}

async function consumeChallenge(db: Firestore, challenge: string, nowMs: number): Promise<boolean> {
    const ref = db.collection(PASSKEY_BACKUP_CHALLENGES_COLLECTION).doc(backupDocId(challenge));
    try {
        return await db.runTransaction(async tx => {
            const doc = await tx.get(ref);
            if (!doc.exists) return false;
            tx.delete(ref);
            return Number(doc.data()?.expires_at ?? 0) >= nowMs;
        });
    } catch {
        return false;
    }
}

export interface AssertionInput {
    credential_id: string;
    authenticator_data: string;
    client_data_json: string;
    signature: string;
}

/** Pure check of a WebAuthn assertion against a stored public key. Throws PasskeyBackupError. */
export function verifyAssertionSignature(stored: Pick<StoredPasskeyBackup, 'public_key_spki' | 'public_key_alg' | 'rp_id'>, input: AssertionInput, expected: { challenge: string; origins: string[] }): void {
    for (const field of ['authenticator_data', 'client_data_json', 'signature'] as const) {
        const value = input[field];
        if (typeof value !== 'string' || !B64URL.test(value) || value.length > 4096) bad('assertion_invalid');
    }
    const clientDataBytes = b64urlToBuffer(input.client_data_json);
    let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
    try {
        clientData = JSON.parse(clientDataBytes.toString('utf8'));
    } catch {
        bad('assertion_invalid');
    }
    if (clientData.type !== 'webauthn.get') throw new PasskeyBackupError(401, 'assertion_type_invalid');
    if (clientData.challenge !== expected.challenge) throw new PasskeyBackupError(401, 'assertion_challenge_mismatch');
    if (typeof clientData.origin !== 'string' || !expected.origins.includes(clientData.origin)) throw new PasskeyBackupError(401, 'assertion_origin_not_allowed');
    const authData = b64urlToBuffer(input.authenticator_data);
    if (authData.length < 37) bad('assertion_invalid');
    const rpIdHash = crypto.createHash('sha256').update(stored.rp_id).digest();
    if (!crypto.timingSafeEqual(authData.subarray(0, 32), rpIdHash)) throw new PasskeyBackupError(401, 'assertion_rp_mismatch');
    const flags = authData[32];
    if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw new PasskeyBackupError(401, 'assertion_user_not_verified');
    const key = validPublicKey(stored.public_key_spki, stored.public_key_alg);
    const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataBytes).digest()]);
    const ok = crypto.verify('sha256', signed, key, b64urlToBuffer(input.signature));
    if (!ok) throw new PasskeyBackupError(401, 'assertion_signature_invalid');
}

/** Hand a backup to the holder of its passkey. */
export async function fetchPasskeyBackup(
    db: Firestore,
    input: AssertionInput,
    nowMs = Date.now(),
): Promise<{ wallet_address: string; envelope: PasskeyBackupEnvelope; credential_id: string; public_key_spki: string; public_key_alg: number }> {
    if (typeof input?.credential_id !== 'string' || !B64URL.test(input.credential_id) || input.credential_id.length > 1400) bad('credential_id_invalid');
    if (typeof input.client_data_json !== 'string' || !B64URL.test(input.client_data_json) || input.client_data_json.length > 4096) bad('assertion_invalid');
    let challenge: unknown;
    try {
        challenge = JSON.parse(b64urlToBuffer(input.client_data_json).toString('utf8')).challenge;
    } catch {
        bad('assertion_invalid');
    }
    if (typeof challenge !== 'string' || !B64URL.test(challenge) || challenge.length > 128) bad('assertion_invalid');
    // Single use, before anything else: a refused attempt still burns its challenge.
    if (!await consumeChallenge(db, challenge, nowMs)) throw new PasskeyBackupError(401, 'challenge_unknown_or_expired');
    const doc = await db.collection(PASSKEY_BACKUPS_COLLECTION).doc(backupDocId(input.credential_id)).get();
    if (!doc.exists) throw new PasskeyBackupError(404, 'no_passkey_backup');
    const stored = doc.data() as StoredPasskeyBackup;
    verifyAssertionSignature(stored, input, { challenge, origins: allowedWebAuthnOrigins().origins });
    // The passkey's public key goes back too, so the restoring browser can refresh this backup later.
    return {
        wallet_address: stored.wallet_address,
        envelope: stored.envelope,
        credential_id: stored.credential_id,
        public_key_spki: stored.public_key_spki,
        public_key_alg: stored.public_key_alg,
    };
}

export async function listPasskeyBackups(db: Firestore, userId: string): Promise<{ credential_id: string; created_at: number; updated_at: number }[]> {
    const snap = await db.collection(PASSKEY_BACKUPS_COLLECTION).where('user_id', '==', userId).limit(MAX_BACKUPS_PER_USER).get();
    return snap.docs.map(doc => {
        const data = doc.data() as StoredPasskeyBackup;
        return { credential_id: data.credential_id, created_at: data.created_at, updated_at: data.updated_at };
    });
}

export async function deletePasskeyBackups(db: Firestore, userId: string): Promise<number> {
    const snap = await db.collection(PASSKEY_BACKUPS_COLLECTION).where('user_id', '==', userId).get();
    for (const doc of snap.docs) await doc.ref.delete();
    return snap.size;
}

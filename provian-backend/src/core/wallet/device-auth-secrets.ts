/**
 * Per-device sign-in secrets: one wallet signed in on several devices at once.
 *
 * The account's original secret (`auth_secrets/{userId}`) is the one every phone app signs with,
 * and a phone's recovery sign-in still replaces it. A device that asks for its OWN credential
 * (`credential_scope: 'device'` on the signature-proven `POST /v1/users/recover`; the web app does)
 * gets a secret here instead, keyed by account and device, and the account secret is left alone.
 * So a browser joining the account never signs the phone out, and a phone recovering never signs
 * the browser out.
 *
 * A device secret is bound to the wallet address it was issued for. It stops working the moment
 * the account's wallet address changes (an owner recovery under Recourse moves the account to a
 * new address) or the account is deleted, without either of those flows having to know about it.
 *
 * Wallet-auth verification picks the secret by the token's `device_id`: the device's own when it
 * has one, otherwise the account secret.
 */
import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';

export const DEVICE_AUTH_SECRETS_COLLECTION = 'device_auth_secrets';
/** The most devices one account may hold a device secret for at once. */
export const MAX_DEVICE_SECRETS_PER_USER = 20;

export function deviceSecretDocId(userId: string, deviceId: string): string {
    return `${userId}__${crypto.createHash('sha256').update(deviceId).digest('hex').slice(0, 40)}`;
}

export interface DeviceSecretRecord {
    user_id: string;
    device_id: string;
    wallet_address: string;
    secret: string;
    created_at: number;
}

export type ResolvedSecret =
    | { ok: true; secret: string; scope: 'device' | 'account' }
    | { ok: false; status: number; error: string };

/**
 * The secret a token signed by `deviceId` must verify against. A database failure answers 503 and
 * never falls back to anything cached.
 */
export async function resolveWalletAuthSecret(db: Firestore, userId: string, deviceId: string): Promise<ResolvedSecret> {
    try {
        const [deviceDoc, accountDoc] = await Promise.all([
            db.collection(DEVICE_AUTH_SECRETS_COLLECTION).doc(deviceSecretDocId(userId, deviceId)).get(),
            db.collection('auth_secrets').doc(userId).get(),
        ]);
        const device = deviceDoc.exists ? deviceDoc.data() as Partial<DeviceSecretRecord> | undefined : undefined;
        if (device && typeof device.secret === 'string' && device.secret
            && device.user_id === userId && device.device_id === deviceId) {
            const user = await db.collection('users').doc(userId).get();
            const bound = typeof device.wallet_address === 'string' ? device.wallet_address.toLowerCase() : '';
            const current = user.exists ? String(user.data()?.wallet_address ?? '').toLowerCase() : '';
            if (!bound || bound !== current) {
                return { ok: false, status: 401, error: 'Device credential no longer valid. Sign in again.' };
            }
            return { ok: true, secret: device.secret, scope: 'device' };
        }
        if (!accountDoc.exists) {
            return { ok: false, status: 401, error: 'Auth secret not configured. Re-register device.' };
        }
        const secret = accountDoc.data()?.secret;
        if (typeof secret !== 'string' || !secret) {
            return { ok: false, status: 401, error: 'Auth secret not configured. Re-register device.' };
        }
        return { ok: true, secret, scope: 'account' };
    } catch {
        return { ok: false, status: 503, error: 'Auth state unavailable' };
    }
}

/** Issue (or replace) the device's own secret for this account. Returns the new secret. */
export async function issueDeviceAuthSecret(db: Firestore, input: { userId: string; deviceId: string; walletAddress: string; nowMs?: number }): Promise<string> {
    const nowMs = input.nowMs ?? Date.now();
    const secret = crypto.randomBytes(32).toString('hex');
    const ref = db.collection(DEVICE_AUTH_SECRETS_COLLECTION).doc(deviceSecretDocId(input.userId, input.deviceId));
    const existing = await db.collection(DEVICE_AUTH_SECRETS_COLLECTION).where('user_id', '==', input.userId).limit(MAX_DEVICE_SECRETS_PER_USER + 1).get();
    const others = existing.docs.filter(doc => doc.id !== ref.id);
    if (others.length >= MAX_DEVICE_SECRETS_PER_USER) {
        // Make room by retiring the device that signed in longest ago.
        const oldest = [...others].sort((a, b) => Number(a.data().created_at ?? 0) - Number(b.data().created_at ?? 0))[0];
        await oldest.ref.delete();
    }
    const record: DeviceSecretRecord = {
        user_id: input.userId,
        device_id: input.deviceId,
        wallet_address: input.walletAddress.toLowerCase(),
        secret,
        created_at: nowMs,
    };
    await ref.set(record);
    return secret;
}

/** The devices signed in with their own credential (never the secrets). */
export async function listDeviceSessions(db: Firestore, userId: string): Promise<{ device_id: string; created_at: number }[]> {
    const snap = await db.collection(DEVICE_AUTH_SECRETS_COLLECTION).where('user_id', '==', userId).limit(MAX_DEVICE_SECRETS_PER_USER).get();
    return snap.docs.map(doc => ({ device_id: String(doc.data().device_id), created_at: Number(doc.data().created_at ?? 0) }));
}

/** Sign one device out. True when it held a device credential. */
export async function revokeDeviceAuthSecret(db: Firestore, userId: string, deviceId: string): Promise<boolean> {
    const ref = db.collection(DEVICE_AUTH_SECRETS_COLLECTION).doc(deviceSecretDocId(userId, deviceId));
    const doc = await ref.get();
    if (!doc.exists) return false;
    await ref.delete();
    return true;
}

/** Every device credential of the account (Delete All Data). Returns how many were removed. */
export async function deleteAllDeviceAuthSecrets(db: Firestore, userId: string): Promise<number> {
    const snap = await db.collection(DEVICE_AUTH_SECRETS_COLLECTION).where('user_id', '==', userId).get();
    for (const doc of snap.docs) await doc.ref.delete();
    return snap.docs.length;
}

/**
 * Which credential a wallet-signature recovery (`POST /v1/users/recover`) hands out.
 * - Absent or 'account' (every phone app): the account secret is replaced, as it always has been.
 *   Phone apps never send a scope, so their behavior does not change.
 * - 'device' (the web app): this device gets its own secret and the account secret is left alone,
 *   so the phone and every other signed-in device keep working.
 * Anything else is refused (null).
 */
export type CredentialScope = 'account' | 'device';

export function parseCredentialScope(raw: unknown): CredentialScope | null {
    if (raw === undefined || raw === 'account') return 'account';
    if (raw === 'device') return 'device';
    return null;
}

export interface RecoveryBatch {
    set(ref: unknown, data: Record<string, unknown>): unknown;
    commit(): Promise<unknown>;
}

/**
 * Commit `batch` with the recovery's credential write and return the secret to hand back.
 * A new account always gets an account secret (for a device-scoped recovery it is held by no one
 * until a phone restores the wallet and replaces it). An existing account's secret is replaced only
 * for an account-scoped recovery.
 */
export async function commitRecoveryCredential(
    db: Firestore,
    batch: RecoveryBatch,
    input: { scope: CredentialScope; newAccount: boolean; userId: string; deviceId: string; walletAddress: string; accountSecret: string; nowMs?: number },
): Promise<string> {
    const nowMs = input.nowMs ?? Date.now();
    if (input.newAccount || input.scope === 'account') {
        batch.set(db.collection('auth_secrets').doc(input.userId), { secret: input.accountSecret, created_at: nowMs });
    }
    await batch.commit();
    if (input.scope === 'device') {
        return issueDeviceAuthSecret(db, { userId: input.userId, deviceId: input.deviceId, walletAddress: input.walletAddress, nowMs });
    }
    return input.accountSecret;
}

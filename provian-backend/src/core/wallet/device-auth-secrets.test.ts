/**
 * One wallet signed in on several devices at once: each device that asks for its own credential
 * verifies against its own secret, the phone's account secret keeps working beside it, and a
 * device secret dies with the wallet address it was issued for.
 */
import { createHash, createHmac, randomUUID } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
    DEVICE_AUTH_SECRETS_COLLECTION,
    MAX_DEVICE_SECRETS_PER_USER,
    commitRecoveryCredential,
    deleteAllDeviceAuthSecrets,
    deviceSecretDocId,
    issueDeviceAuthSecret,
    listDeviceSessions,
    parseCredentialScope,
    resolveWalletAuthSecret,
    revokeDeviceAuthSecret,
} from './device-auth-secrets';
import { verifyWalletAuthTokenWithBinding, type WalletAuthDeps } from '../../routes/middleware/wallet-auth';

type Data = Record<string, unknown>;

function memoryDb() {
    const store = new Map<string, Map<string, Data>>();
    const col = (name: string) => {
        if (!store.has(name)) store.set(name, new Map());
        return store.get(name)!;
    };
    let failNextGet = false;
    const docRef = (name: string, id: string) => ({
        id,
        async get() {
            if (failNextGet) { failNextGet = false; throw new Error('offline'); }
            const data = col(name).get(id);
            return { id, exists: data !== undefined, data: () => (data ? { ...data } : undefined), ref: docRef(name, id) };
        },
        async set(data: Data) { col(name).set(id, { ...data }); },
        async delete() { col(name).delete(id); },
    });
    const query = (name: string, field: string, value: unknown, max = Infinity) => ({
        limit: (n: number) => query(name, field, value, n),
        async get() {
            const docs = [...col(name).entries()].filter(([, d]) => d[field] === value).slice(0, max)
                .map(([id, d]) => ({ id, data: () => ({ ...d }), ref: docRef(name, id) }));
            return { size: docs.length, docs };
        },
    });
    const db = {
        collection: (name: string) => ({
            doc: (id: string) => docRef(name, id),
            where: (field: string, _op: string, value: unknown) => query(name, field, value),
        }),
    } as unknown as Firestore;
    return { db, col, failNext: () => { failNextGet = true; } };
}

const ADDRESS = '0x' + 'ab'.repeat(20);
const binding = { method: 'GET', path: '/v1/users/sessions', bodyHash: createHash('sha256').update('').digest('hex') };

function token(secret: string, sub: string, deviceId: string): string {
    const payload = Buffer.from(JSON.stringify({ sub, device_id: deviceId, iat: Date.now(),
        exp: Date.now() + 90000, jti: randomUUID(), mth: binding.method, pth: binding.path, bh: binding.bodyHash })).toString('base64');
    return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function deps(db: Firestore): WalletAuthDeps {
    return { db, cache: { isEnabled: () => true, setNx: async () => true } } as unknown as WalletAuthDeps;
}

function seedAccount(mem: ReturnType<typeof memoryDb>, accountSecret = 'a'.repeat(64)) {
    mem.col('users').set('user_1', { id: 'user_1', wallet_address: ADDRESS });
    mem.col('auth_secrets').set('user_1', { secret: accountSecret });
}

describe('per-device wallet credentials', () => {
    it('a browser with its own secret and the phone with the account secret both verify', async () => {
        const mem = memoryDb();
        seedAccount(mem, 'phone-secret');
        const webSecret = await issueDeviceAuthSecret(mem.db, { userId: 'user_1', deviceId: 'web_1', walletAddress: ADDRESS });
        expect(await verifyWalletAuthTokenWithBinding(token(webSecret, 'user_1', 'web_1'), binding, deps(mem.db)))
            .toEqual({ ok: true, userId: 'user_1', deviceId: 'web_1' });
        expect(await verifyWalletAuthTokenWithBinding(token('phone-secret', 'user_1', 'device_phone'), binding, deps(mem.db)))
            .toEqual({ ok: true, userId: 'user_1', deviceId: 'device_phone' });
    });

    it('RED: the account secret cannot sign for a device that has its own credential', async () => {
        const mem = memoryDb();
        seedAccount(mem, 'phone-secret');
        await issueDeviceAuthSecret(mem.db, { userId: 'user_1', deviceId: 'web_1', walletAddress: ADDRESS });
        expect(await verifyWalletAuthTokenWithBinding(token('phone-secret', 'user_1', 'web_1'), binding, deps(mem.db)))
            .toMatchObject({ ok: false, status: 401, error: 'Invalid token signature' });
    });

    it('RED: a device secret cannot sign as another device', async () => {
        const mem = memoryDb();
        seedAccount(mem, 'phone-secret');
        const webSecret = await issueDeviceAuthSecret(mem.db, { userId: 'user_1', deviceId: 'web_1', walletAddress: ADDRESS });
        expect(await verifyWalletAuthTokenWithBinding(token(webSecret, 'user_1', 'device_phone'), binding, deps(mem.db)))
            .toMatchObject({ ok: false, status: 401 });
    });

    it('a phone recovery replacing the account secret leaves the browser signed in', async () => {
        const mem = memoryDb();
        seedAccount(mem, 'old-phone-secret');
        const webSecret = await issueDeviceAuthSecret(mem.db, { userId: 'user_1', deviceId: 'web_1', walletAddress: ADDRESS });
        mem.col('auth_secrets').set('user_1', { secret: 'new-phone-secret' });
        expect(await verifyWalletAuthTokenWithBinding(token(webSecret, 'user_1', 'web_1'), binding, deps(mem.db))).toMatchObject({ ok: true });
        expect(await verifyWalletAuthTokenWithBinding(token('old-phone-secret', 'user_1', 'device_phone'), binding, deps(mem.db))).toMatchObject({ ok: false });
    });

    it('RED: a device secret stops working once the account moves to another wallet address', async () => {
        const mem = memoryDb();
        seedAccount(mem);
        const webSecret = await issueDeviceAuthSecret(mem.db, { userId: 'user_1', deviceId: 'web_1', walletAddress: ADDRESS });
        mem.col('users').set('user_1', { id: 'user_1', wallet_address: '0x' + 'cd'.repeat(20) });
        expect(await verifyWalletAuthTokenWithBinding(token(webSecret, 'user_1', 'web_1'), binding, deps(mem.db)))
            .toMatchObject({ ok: false, status: 401, error: 'Device credential no longer valid. Sign in again.' });
    });

    it('RED: a device secret stops working once the account is deleted', async () => {
        const mem = memoryDb();
        seedAccount(mem);
        const webSecret = await issueDeviceAuthSecret(mem.db, { userId: 'user_1', deviceId: 'web_1', walletAddress: ADDRESS });
        mem.col('users').delete('user_1');
        mem.col('auth_secrets').delete('user_1');
        expect(await verifyWalletAuthTokenWithBinding(token(webSecret, 'user_1', 'web_1'), binding, deps(mem.db))).toMatchObject({ ok: false, status: 401 });
    });

    it('a database outage answers 503 and never falls back', async () => {
        const mem = memoryDb();
        seedAccount(mem);
        mem.failNext();
        expect(await resolveWalletAuthSecret(mem.db, 'user_1', 'web_1')).toEqual({ ok: false, status: 503, error: 'Auth state unavailable' });
    });

    it('lists, revokes and deletes device sessions; the oldest makes room past the cap', async () => {
        const mem = memoryDb();
        seedAccount(mem);
        for (let i = 0; i < MAX_DEVICE_SECRETS_PER_USER; i++) {
            await issueDeviceAuthSecret(mem.db, { userId: 'user_1', deviceId: `web_${i}`, walletAddress: ADDRESS, nowMs: 1000 + i });
        }
        await issueDeviceAuthSecret(mem.db, { userId: 'user_1', deviceId: 'web_new', walletAddress: ADDRESS, nowMs: 5000 });
        const sessions = await listDeviceSessions(mem.db, 'user_1');
        expect(sessions).toHaveLength(MAX_DEVICE_SECRETS_PER_USER);
        expect(sessions.map(s => s.device_id)).not.toContain('web_0');
        expect(sessions.map(s => s.device_id)).toContain('web_new');
        expect(await revokeDeviceAuthSecret(mem.db, 'user_1', 'web_new')).toBe(true);
        expect(await revokeDeviceAuthSecret(mem.db, 'user_1', 'web_new')).toBe(false);
        expect(mem.col(DEVICE_AUTH_SECRETS_COLLECTION).has(deviceSecretDocId('user_1', 'web_new'))).toBe(false);
        expect(await deleteAllDeviceAuthSecrets(mem.db, 'user_1')).toBe(MAX_DEVICE_SECRETS_PER_USER - 1);
        expect(mem.col(DEVICE_AUTH_SECRETS_COLLECTION).size).toBe(0);
    });
});

describe('recovery credential scope (POST /v1/users/recover)', () => {
    function batchFor(mem: ReturnType<typeof memoryDb>) {
        const writes: Array<() => Promise<void>> = [];
        return {
            set(ref: unknown, data: Data) { writes.push(() => (ref as { set(d: Data): Promise<void> }).set(data)); },
            async commit() { for (const write of writes) await write(); },
        };
    }

    it('a request with no scope (every phone app) is account-scoped; only device and account are accepted', () => {
        expect(parseCredentialScope(undefined)).toBe('account');
        expect(parseCredentialScope('account')).toBe('account');
        expect(parseCredentialScope('device')).toBe('device');
        // RED: anything else is refused, never quietly treated as either scope.
        for (const bad of ['', 'Device', 'browser', null, 1, true, {}, ['device']]) expect(parseCredentialScope(bad)).toBeNull();
    });

    it('phone recovery replaces the account secret and issues no device secret, as before', async () => {
        const mem = memoryDb();
        mem.col('auth_secrets').set('user_1', { secret: 'old-phone-secret', created_at: 1 });
        const secret = await commitRecoveryCredential(mem.db, batchFor(mem), {
            scope: 'account', newAccount: false, userId: 'user_1', deviceId: 'phone_2', walletAddress: ADDRESS, accountSecret: 'new-account-secret',
        });
        expect(secret).toBe('new-account-secret');
        expect(mem.col('auth_secrets').get('user_1')?.secret).toBe('new-account-secret');
        expect(mem.col(DEVICE_AUTH_SECRETS_COLLECTION).size).toBe(0);
    });

    it('RED: a browser sign-in leaves the phone\'s account secret untouched and gets its own device secret', async () => {
        const mem = memoryDb();
        mem.col('users').set('user_1', { wallet_address: ADDRESS });
        mem.col('auth_secrets').set('user_1', { secret: 'phone-secret', created_at: 1 });
        const secret = await commitRecoveryCredential(mem.db, batchFor(mem), {
            scope: 'device', newAccount: false, userId: 'user_1', deviceId: 'web_1', walletAddress: ADDRESS, accountSecret: 'unused-account-secret',
        });
        expect(mem.col('auth_secrets').get('user_1')?.secret).toBe('phone-secret');
        expect(secret).not.toBe('unused-account-secret');
        expect(mem.col(DEVICE_AUTH_SECRETS_COLLECTION).get(deviceSecretDocId('user_1', 'web_1'))?.secret).toBe(secret);
        // Both credentials resolve: the phone with the account secret, the browser with its own.
        expect(await resolveWalletAuthSecret(mem.db, 'user_1', 'phone_1')).toMatchObject({ ok: true, secret: 'phone-secret' });
        expect(await resolveWalletAuthSecret(mem.db, 'user_1', 'web_1')).toMatchObject({ ok: true, secret });
    });

    it('a new account always gets an account secret; a device-scoped one also gets the device secret', async () => {
        const mem = memoryDb();
        mem.col('users').set('user_2', { wallet_address: ADDRESS });
        const secret = await commitRecoveryCredential(mem.db, batchFor(mem), {
            scope: 'device', newAccount: true, userId: 'user_2', deviceId: 'web_1', walletAddress: ADDRESS, accountSecret: 'held-by-no-one',
        });
        expect(mem.col('auth_secrets').get('user_2')?.secret).toBe('held-by-no-one');
        expect(secret).not.toBe('held-by-no-one');
        expect(mem.col(DEVICE_AUTH_SECRETS_COLLECTION).size).toBe(1);
    });
});

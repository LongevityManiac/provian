/**
 * one cloud account, two wallets — Keep must leave the other wallet's backup
 * intact AND finish with this wallet backed up, so both wallets restore. Exercised against an
 * emulation of each platform's native backend:
 * - iOS: iCloud Keychain synchronizable items in one service (account = key), `listKeys`
 * added in;
 * - Android: Google Drive appDataFolder files (`provian_backup_<key>.enc`); a read while no
 * Google account is signed in answers `null`, and a write signs in first — the shape that
 * let the A7 guard read "empty" and then overwrite the signed-in account's primary.
 *
 * The envelope crypto is replaced by a fast stand-in (it has its own suite,
 * cloudBackupEnvelope.test.ts); what is under test is which key holds which wallet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const WALLET_A = '0xAaAaaAAAaAaaAaAaAAAAAAAAAaAAAaaaAAaaaaAa';
const WALLET_B = '0xbBbBBBbbBbBBbbbBbbbBbBBBBbbbbbBbBBbBbbBb';
const MNEMONIC_A = 'alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha about';
const MNEMONIC_B = 'bravo bravo bravo bravo bravo bravo bravo bravo bravo bravo bravo bravo';

const device = { address: WALLET_A, mnemonic: MNEMONIC_A };
const platform = { OS: 'ios' as 'ios' | 'android' };

/** One cloud account's backend, as each native module presents it. */
class FakeCloud {
    readonly items = new Map<string, string>();
    signedIn = true;
    failVerifyFor: string | null = null;
    signInCalls = 0;
    constructor(readonly os: 'ios' | 'android') {}
    private fileOf(key: string) { return this.os === 'android' ? `provian_backup_${key}.enc` : key; }
    module() {
        return {
            store: async (key: string, value: string) => {
                if (this.os === 'android' && !this.signedIn) { this.signedIn = true; this.signInCalls += 1; }
                this.items.set(this.fileOf(key), value);
                return true;
            },
            retrieve: async (key: string) => {
                if (this.os === 'android' && !this.signedIn) return null;
                return this.items.get(this.fileOf(key)) ?? null;
            },
            deleteSyncedItem: async (key: string) => { this.items.delete(this.fileOf(key)); return true; },
            verifySync: async (key: string) => key !== this.failVerifyFor && this.items.has(this.fileOf(key)),
            isSyncVerified: async () => this.signedIn,
            listKeys: async () => {
                if (this.os === 'android' && !this.signedIn) throw new Error('Google Drive not signed in');
                const keys = [...this.items.keys()];
                return this.os === 'android'
                    ? keys.filter(n => n.startsWith('provian_backup_') && n.endsWith('.enc')).map(n => n.slice('provian_backup_'.length, -'.enc'.length))
                    : keys;
            },
            ...(this.os === 'android' ? { signIn: async () => { this.signInCalls += 1; this.signedIn = true; return true; } } : {}),
        };
    }
}

let cloud = new FakeCloud('ios');

vi.mock('react-native', () => ({
    get Platform() { return platform; },
    get NativeModules() { return { ProvianCloudKeychainSync: cloud.module() }; },
}));
vi.mock('../../wallet/SeedManager', () => ({ default: {
    getMnemonic: async () => device.mnemonic,
    getEVMAddress: async () => device.address,
} }));
vi.mock('../../security/KeyManager', () => ({ default: { getKeyAttestation: async () => ({ tier: 'software' }) } }));
vi.mock('../../security/securityLogger', () => ({ default: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../security/hmacAsyncStorage', () => ({ setItemHmac: async () => undefined }));
vi.mock('../../security/biometricAction', () => ({
    withBiometricAction: async (_label: string, fn: (a: unknown) => Promise<unknown>) => fn({ id: 'test' }),
    assertBiometricAction: () => undefined,
}));
vi.mock('./cloudBackupEnvelope', () => ({
    validatePin: (pin: string) => { if (pin.length < 6) throw new Error('short'); },
    encryptBackupEnvelope: async (payload: unknown, pin: string) => ({
        version: 2, salt: 's', nonce: 'n', iterations: 600_000,
        ciphertext: Buffer.from(JSON.stringify({ pin, payload })).toString('base64'),
    }),
    decryptBackupEnvelope: async (stored: { ciphertext: string }, pin: string) => {
        const inner = JSON.parse(Buffer.from(stored.ciphertext, 'base64').toString());
        if (inner.pin !== pin) throw new Error('aes/gcm: invalid ghash tag');
        return inner.payload;
    },
}));

async function loadBackup() {
    vi.resetModules();
    return import('./CloudBackupV2');
}

const asA = () => { device.address = WALLET_A; device.mnemonic = MNEMONIC_A; };
const asB = () => { device.address = WALLET_B; device.mnemonic = MNEMONIC_B; };

describe.each(['ios', 'android'] as const)('cloud backup slots on %s ', (os) => {
    beforeEach(() => {
        platform.OS = os;
        cloud = new FakeCloud(os);
        asA();
    });

    it('Keep: the other wallet\'s backup stays byte-identical, this wallet is backed up, both restore', async () => {
        const B = await loadBackup();
        await B.createCloudBackup('pin-aaaa');
        const primaryKey = os === 'android' ? 'provian_backup_provian_cloud_backup_v2.enc' : 'provian_cloud_backup_v2';
        const primaryBefore = cloud.items.get(primaryKey);
        expect(primaryBefore).toBeDefined();

        asB();
        // Not asked yet: the person must choose; nothing is written.
        await expect(B.createCloudBackup('pin-bbbb')).rejects.toBeInstanceOf(B.CloudBackupBelongsToOtherWalletError);
        expect(cloud.items.size).toBe(1);

        await B.createCloudBackup('pin-bbbb', undefined, { keepExisting: true });
        expect(cloud.items.get(primaryKey)).toBe(primaryBefore);
        expect(cloud.items.size).toBe(2);
        expect(await B.hasCloudBackup(WALLET_B)).toBe(true);
        expect(await B.hasCloudBackup(WALLET_A)).toBe(true);

        const { entries, complete } = await B.listCloudBackups();
        expect(complete).toBe(true);
        expect(entries.map(e => e.walletAddress)).toEqual([WALLET_A.toLowerCase(), WALLET_B.toLowerCase()]);
        const restoredA = await B.retrieveCloudBackup('pin-aaaa', entries[0].key);
        const restoredB = await B.retrieveCloudBackup('pin-bbbb', entries[1].key);
        expect(restoredA?.mnemonic).toBe(MNEMONIC_A);
        expect(restoredB?.mnemonic).toBe(MNEMONIC_B);
    });

    it('a wallet with its own key re-backs-up there without asking, and the primary is untouched', async () => {
        const B = await loadBackup();
        await B.createCloudBackup('pin-aaaa');
        asB();
        await B.createCloudBackup('pin-bbbb', undefined, { keepExisting: true });
        const snapshot = new Map(cloud.items);
        await B.createCloudBackup('pin-bbbb-new');
        const { entries } = await B.listCloudBackups();
        expect(entries).toHaveLength(2);
        expect((await B.retrieveCloudBackup('pin-bbbb-new', entries[1].key))?.mnemonic).toBe(MNEMONIC_B);
        expect((await B.retrieveCloudBackup('pin-aaaa', entries[0].key))?.mnemonic).toBe(MNEMONIC_A);
        expect([...cloud.items.keys()].sort()).toEqual([...snapshot.keys()].sort());
    });

    it('Replace overwrites the primary only on the person\'s say-so', async () => {
        const B = await loadBackup();
        await B.createCloudBackup('pin-aaaa');
        asB();
        await B.createCloudBackup('pin-bbbb', undefined, { replaceExisting: true });
        const { entries } = await B.listCloudBackups();
        expect(entries).toEqual([{ key: 'provian_cloud_backup_v2', walletAddress: WALLET_B.toLowerCase() }]);
    });

    it('deleting one wallet\'s backup never deletes the other wallet\'s', async () => {
        const B = await loadBackup();
        await B.createCloudBackup('pin-aaaa');
        asB();
        await B.createCloudBackup('pin-bbbb', undefined, { keepExisting: true });
        await B.deleteCloudBackup(WALLET_B);
        expect(await B.hasCloudBackup(WALLET_B)).toBe(false);
        expect((await B.retrieveCloudBackup('pin-aaaa'))?.mnemonic).toBe(MNEMONIC_A);

        asB();
        await B.createCloudBackup('pin-bbbb', undefined, { keepExisting: true });
        await B.deleteCloudBackup(WALLET_A);
        expect(await B.hasCloudBackup(WALLET_A)).toBe(false);
        expect(await B.hasCloudBackup(WALLET_B)).toBe(true);
    });

    it('a failed sync check on this wallet\'s own key rolls back only that key', async () => {
        const B = await loadBackup();
        await B.createCloudBackup('pin-aaaa');
        const before = new Map(cloud.items);
        asB();
        cloud.failVerifyFor = 'provian_cloud_backup_v2__' + WALLET_B.toLowerCase();
        await expect(B.createCloudBackup('pin-bbbb', undefined, { keepExisting: true })).rejects.toThrow(/did not land/);
        expect(cloud.items).toEqual(before);
    });

    it('a key that is not a backup key is never read as one', async () => {
        const B = await loadBackup();
        await expect(B.retrieveCloudBackup('pin-aaaa', 'provian_pe_cloud_index')).rejects.toThrow(/Not a cloud backup key/);
    });
});

describe.each(['ios', 'android'] as const)('a pre-2026-10-17 primary that names no wallet, on %s ( )', (os) => {
    beforeEach(() => {
        platform.OS = os;
        cloud = new FakeCloud(os);
    });

    const primaryKey = () => (os === 'android' ? 'provian_backup_provian_cloud_backup_v2.enc' : 'provian_cloud_backup_v2');
    const seedLegacyPrimary = () => cloud.items.set(primaryKey(), JSON.stringify({
        version: 2, salt: 's', nonce: 'n',
        ciphertext: Buffer.from(JSON.stringify({ pin: 'pin-aaaa', payload: { mnemonic: MNEMONIC_A, wallet_address: WALLET_A } })).toString('base64'),
    }));

    it('a restored wallet is not "backed up" by it, and Keep backs it up while leaving it intact', async () => {
        seedLegacyPrimary();
        const legacy = cloud.items.get(primaryKey());
        const B = await loadBackup();
        expect(await B.hasCloudBackup(WALLET_B)).toBe(false);
        expect(await B.cloudBackupStatus(WALLET_B)).toBe('unidentified');
        asB();
        await expect(B.createCloudBackup('pin-bbbb')).rejects.toBeInstanceOf(B.CloudBackupBelongsToOtherWalletError);
        await B.createCloudBackup('pin-bbbb', undefined, { keepExisting: true });
        expect(await B.hasCloudBackup(WALLET_B)).toBe(true);
        expect(cloud.items.get(primaryKey())).toBe(legacy);
    });

    it('deleting a wallet\'s backup never deletes it, and says so', async () => {
        seedLegacyPrimary();
        const B = await loadBackup();
        expect(await B.deleteCloudBackup(WALLET_B)).toEqual({ deletedKeys: [], keptUnidentifiedBackup: true });
        expect(cloud.items.has(primaryKey())).toBe(true);
        asB();
        await B.createCloudBackup('pin-bbbb', undefined, { keepExisting: true });
        const result = await B.deleteCloudBackup(WALLET_B);
        expect(result.keptUnidentifiedBackup).toBe(true);
        expect(result.deletedKeys).toEqual(['provian_cloud_backup_v2__' + WALLET_B.toLowerCase()]);
        expect((await B.retrieveCloudBackup('pin-aaaa'))?.mnemonic).toBe(MNEMONIC_A);
    });
});

describe('Android: the ownership check reads the account the write lands on ', () => {
    beforeEach(() => {
        platform.OS = 'android';
        cloud = new FakeCloud('android');
        asA();
    });

    it('signed out at backup time: it signs in first and asks instead of overwriting the other wallet', async () => {
        const B = await loadBackup();
        await B.createCloudBackup('pin-aaaa');
        const primary = cloud.items.get('provian_backup_provian_cloud_backup_v2.enc');
        cloud.signedIn = false;
        asB();
        await expect(B.createCloudBackup('pin-bbbb')).rejects.toBeInstanceOf(B.CloudBackupBelongsToOtherWalletError);
        expect(cloud.items.get('provian_backup_provian_cloud_backup_v2.enc')).toBe(primary);
        expect(cloud.signInCalls).toBeGreaterThan(0);
    });
});

describe('slot decisions (pure)', () => {
    it('resolveBackupTarget: empty / own primary / own key / keep / replace / ask', async () => {
        const S = await import('./cloudBackupSlots');
        const blob = (w: string | null) => JSON.stringify({ version: 2, ciphertext: 'x', ...(w ? { wallet_address: w.toLowerCase() } : {}) });
        const own = S.walletBackupKey(WALLET_B);
        expect(S.resolveBackupTarget({ address: WALLET_B, primaryRaw: null, walletKeyRaw: null })).toEqual({ kind: 'write', key: S.PRIMARY_BACKUP_KEY });
        expect(S.resolveBackupTarget({ address: WALLET_B, primaryRaw: blob(WALLET_B), walletKeyRaw: null })).toEqual({ kind: 'write', key: S.PRIMARY_BACKUP_KEY });
        expect(S.resolveBackupTarget({ address: WALLET_B, primaryRaw: blob(WALLET_A), walletKeyRaw: blob(WALLET_B) })).toEqual({ kind: 'write', key: own });
        expect(S.resolveBackupTarget({ address: WALLET_B, primaryRaw: blob(WALLET_A), walletKeyRaw: null, choice: 'keep' })).toEqual({ kind: 'write', key: own });
        expect(S.resolveBackupTarget({ address: WALLET_B, primaryRaw: blob(WALLET_A), walletKeyRaw: null, choice: 'replace' })).toEqual({ kind: 'write', key: S.PRIMARY_BACKUP_KEY });
        expect(S.resolveBackupTarget({ address: WALLET_B, primaryRaw: blob(WALLET_A), walletKeyRaw: null })).toEqual({ kind: 'ask', existingWalletAddress: WALLET_A.toLowerCase() });
        // A legacy blob that names nobody, or an unreadable one, is somebody's: ask.
        expect(S.resolveBackupTarget({ address: WALLET_B, primaryRaw: blob(null), walletKeyRaw: null })).toEqual({ kind: 'ask', existingWalletAddress: null });
        expect(S.resolveBackupTarget({ address: WALLET_B, primaryRaw: 'garbage', walletKeyRaw: null })).toEqual({ kind: 'ask', existingWalletAddress: null });
    });

    it('backupKeysToDelete never names another wallet\'s primary, nor one that names no wallet', async () => {
        const S = await import('./cloudBackupSlots');
        const blob = (w: string | null) => JSON.stringify({ version: 2, ...(w ? { wallet_address: w.toLowerCase() } : {}) });
        expect(S.backupKeysToDelete({ address: WALLET_B, primaryRaw: blob(WALLET_A), walletKeyRaw: blob(WALLET_B) })).toEqual({ keys: [S.walletBackupKey(WALLET_B)], keptUnidentifiedPrimary: false });
        expect(S.backupKeysToDelete({ address: WALLET_B, primaryRaw: blob(null), walletKeyRaw: blob(WALLET_B) })).toEqual({ keys: [S.walletBackupKey(WALLET_B)], keptUnidentifiedPrimary: true });
        // , defect 2: a legacy primary that names nobody may be another wallet's only backup.
        expect(S.backupKeysToDelete({ address: WALLET_A, primaryRaw: blob(null), walletKeyRaw: null })).toEqual({ keys: [], keptUnidentifiedPrimary: true });
        expect(S.backupKeysToDelete({ address: WALLET_A, primaryRaw: blob(WALLET_A), walletKeyRaw: null })).toEqual({ keys: [S.PRIMARY_BACKUP_KEY], keptUnidentifiedPrimary: false });
    });

    it('walletBackupStatus: a primary that names no wallet is unidentified, never proof for this wallet', async () => {
        const S = await import('./cloudBackupSlots');
        const blob = (w: string | null) => JSON.stringify({ version: 2, ...(w ? { wallet_address: w.toLowerCase() } : {}) });
        expect(S.walletBackupStatus({ address: WALLET_B, primaryRaw: blob(null), walletKeyRaw: null })).toBe('unidentified');
        expect(S.walletHasBackup({ address: WALLET_B, primaryRaw: blob(null), walletKeyRaw: null })).toBe(false);
        expect(S.walletBackupStatus({ address: WALLET_B, primaryRaw: blob(WALLET_A), walletKeyRaw: null })).toBe('missing');
        expect(S.walletBackupStatus({ address: WALLET_B, primaryRaw: blob(WALLET_B), walletKeyRaw: null })).toBe('backed_up');
        expect(S.walletBackupStatus({ address: WALLET_B, primaryRaw: blob(null), walletKeyRaw: blob(WALLET_B) })).toBe('backed_up');
        expect(S.walletBackupStatus({ address: WALLET_B, primaryRaw: null, walletKeyRaw: null })).toBe('missing');
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { hexToBytes, randomBytes } from '@noble/hashes/utils';
import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../../security/biometricAction';
const { memory, lifecycle } = vi.hoisted(() => ({ memory: new Map<string,string>(), lifecycle: { state: 'active', listeners: new Set<(state: string) => void>() } }));
vi.mock('expo-modules-core', async importOriginal => ({ ...(await importOriginal<typeof import('expo-modules-core')>()), requireOptionalNativeModule: () => null }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, NativeModules: {}, AppState: {
    get currentState() { return lifecycle.state; },
    addEventListener: (_event: string, listener: (state: string) => void) => { lifecycle.listeners.add(listener); return { remove: () => lifecycle.listeners.delete(listener) }; },
} }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: vi.fn(async k => memory.get(k) ?? null), setItem: vi.fn(async (k,v) => { memory.set(k,v); }),
    removeItem: vi.fn(async k => { memory.delete(k); }),
} }));
vi.mock('../../wallet/SeedManager', () => ({ default: { getMnemonic: vi.fn(async (action) => {
    assertBiometricAction(action); return 'legal winner thank year wave sausage worth useful legal winner thank yellow';
}) } }));
vi.mock('../../recovery/cloud/CloudBackupV2', () => ({ hasCloudBackup: vi.fn(async () => false) }));
vi.mock('../../recovery/cloud/ProvianCloudKeychainSync', () => ({ retrieveSynced: vi.fn(async () => null) }));
vi.mock('../../provenance/ProvenanceEnvelopeManager', () => ({ default: { verifyAllPESignatures: vi.fn(async () => ({ tamperedIds: [], missingSignatureIds: [], unverifiableIds: [] })) } }));
vi.mock('../../../services/NotificationService', () => ({ default: { getBackendUrl: async () => 'https://relay.test', getPushToken: async () => null } }));
vi.mock('../../network/apiFetch', () => ({ apiFetch: vi.fn(), default: vi.fn() }));
vi.mock('../../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: '0x' + '11'.repeat(20) }) } }));
import SeedManager from '../../wallet/SeedManager';
import PECloudSync from '../../provenance/PECloudSync';
import RelayAPIService from '../../../services/RelayAPIService';
import { apiFetch } from '../../network/apiFetch';
import { MemoryCloudFiles } from '../cloudFiles';
import { MemoryMeterFiles } from '../meterFiles';
import { PhoneMeter, type KeyValue } from '../phoneMeter';
import { PeCloudBackup, deriveArchiveKey, type BackupKeyProvider } from '../peCloudBackup';
import { meterTransportForAction, restoreMyPes, backUpMyPes } from '../phoneMeterRuntime';
import { FakeRelay, openStore, recordPes, envelope, T0 } from './meterTestkit';

const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const localSalt = 'ab'.repeat(16), foreignSalt = 'cd'.repeat(16);
const service = RelayAPIService as unknown as { getUserId(): Promise<string | null>; getDeviceId(): Promise<string> };
const keyProvider: BackupKeyProvider = {
    async current(options) { const k = await PECloudSync.getArchiveKeyForBackup(options); return k ? { saltHex: k.saltHex, key: hexToBytes(k.keyHex) } : null; },
    async forSalt(salt, options) { const key = await PECloudSync.getArchiveKeyForSalt(salt, options); return key ? hexToBytes(key) : null; },
    async adopt(k) { await PECloudSync.adoptArchiveKey(k.saltHex, Buffer.from(k.key).toString('hex')); },
};
function kv(): KeyValue { const m = new Map<string,string>(); return { getItem: async k => m.get(k) ?? null, setItem: async (k,v) => {m.set(k,v);}, removeItem: async k => {m.delete(k);} }; }
function newMeter(cloud: MemoryCloudFiles, restored: unknown[] = []) {
    return new PhoneMeter({
        files: new MemoryMeterFiles(), cloud, transport: new FakeRelay(), actionTransport: meterTransportForAction,
        backupKeys: keyProvider, kv: kv(),
        activity: { hot: async () => [], archived: async options => { await keyProvider.current(options); return []; }, restore: async (envs, action) => { assertBiometricAction(action); restored.push(...envs); return envs.length; } },
        deviceId: async () => 'new-phone', detailHash: async () => 'd'.repeat(64),
        messageSecretKey: async () => null, openBox: () => null, randomBytes,
        isForeground: () => true, now: () => T0 + 50_000_000,
    });
}
beforeEach(async () => {
    lifecycle.state = 'active';
    vi.restoreAllMocks(); memory.clear(); vi.mocked(apiFetch).mockReset(); vi.mocked(SeedManager.getMnemonic).mockClear();
    (PECloudSync as unknown as { encryptionKey: string | null }).encryptionKey = null;
    await AsyncStorage.setItem('provian_pe_encryption_salt', localSalt);
    vi.spyOn(LocalAuthentication, 'hasHardwareAsync').mockResolvedValue(true);
    vi.spyOn(LocalAuthentication, 'isEnrolledAsync').mockResolvedValue(true);
    vi.spyOn(LocalAuthentication, 'authenticateAsync').mockResolvedValue({ success: true });
    vi.spyOn(service, 'getUserId').mockResolvedValue('fixture_user'); vi.spyOn(service, 'getDeviceId').mockResolvedValue('fixture_device');
});
async function foreignBackup() {
    const cloud = new MemoryCloudFiles(), { store } = await openStore();
    await recordPes(store, 2); await store.addLegacy([envelope({ envelope_id: 'legacy-foreign-phone' })]);
    const keys: BackupKeyProvider = { current: async () => ({ saltHex: foreignSalt, key: await deriveArchiveKey(phrase, foreignSalt) }), forSalt: async s => deriveArchiveKey(phrase,s), adopt: async () => {} };
    expect((await new PeCloudBackup({ store, cloud, keys, randomBytes }).backup()).ok).toBe(true);
    return cloud;
}
describe('meter operations retain one explicit approval', () => {
    it('restores a foreign-salt backup inside the already running action without queueing a second authentication', async () => {
        const cloud = await foreignBackup(), restored: unknown[] = [], meter = newMeter(cloud, restored);
        let approved!: BiometricAction;
        const result = await withBiometricAction('Restore', async action => {
            approved = action; await keyProvider.current({ allowPrompt: false, biometricAction: action });
            return meter.restoreAfterRecovery(action);
        });
        expect(result.found).toBe(true); expect(result.devices.reduce((n,d) => n+d.imported,0)).toBe(2);
        expect(result.legacy).toBe(1); expect(restored).toHaveLength(3);
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        expect(SeedManager.getMnemonic).toHaveBeenCalledTimes(2);
        expect(vi.mocked(SeedManager.getMnemonic).mock.calls.every(([action]) => action === approved)).toBe(true);
        expect(await AsyncStorage.getItem('provian_pe_encryption_salt')).toBe(foreignSalt);
    }, 3000);
    it('a user backup joins a foreign salt with that same approval', async () => {
        const cloud = await foreignBackup(), meter = newMeter(cloud);
        const report = await withBiometricAction('Backup', action => meter.backupNow({ allowPrompt: true, biometricAction: action }));
        expect(report.ok).toBe(true); expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        expect(await AsyncStorage.getItem('provian_pe_encryption_salt')).toBe(foreignSalt);
    }, 3000);
    it('Google sign-in backgrounds before approval, then the explicit restore prompts once and reads the foreign key', async () => {
        const cloud = await foreignBackup();
        const prepare = vi.fn(async () => {
            lifecycle.state = 'background'; lifecycle.listeners.forEach(fn => fn('background'));
            setTimeout(() => { lifecycle.state = 'active'; lifecycle.listeners.forEach(fn => fn('active')); }, 0);
            return true;
        });
        (cloud as MemoryCloudFiles & { prepare: () => Promise<boolean> }).prepare = prepare;
        const report = await restoreMyPes(newMeter(cloud));
        expect(report.found).toBe(true); expect(report.devices.reduce((n,d) => n+d.imported,0)).toBe(2);
        expect(prepare).toHaveBeenCalledTimes(1); expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    }, 3000);
    it('cancelled/offline cloud setup does not authenticate or read a seed for Backup/Restore buttons', async () => {
        const cloud = new MemoryCloudFiles(); cloud.online = false;
        (cloud as MemoryCloudFiles & { prepare: () => Promise<boolean> }).prepare = async () => { throw new Error('user cancelled Google'); };
        const meter = newMeter(cloud);
        expect((await backUpMyPes(meter)).state).toBe('cloud_unavailable');
        await expect(restoreMyPes(meter)).rejects.toThrow('cloud_unavailable');
        expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled(); expect(SeedManager.getMnemonic).not.toHaveBeenCalled();
    });
    it('RED: signing in to Google after approval revokes that grant before foreign-salt restore', async () => {
        const cloud = await foreignBackup();
        (cloud as MemoryCloudFiles & { prepare: () => Promise<boolean> }).prepare = async () => {
            lifecycle.state = 'background'; lifecycle.listeners.forEach(fn => fn('background'));
            lifecycle.state = 'active'; lifecycle.listeners.forEach(fn => fn('active')); return true;
        };
        const meter = newMeter(cloud);
        await expect(withBiometricAction('Unsafe old order', async action => {
            await meter.backup.prepareCloud(); return meter.restoreAfterRecovery(action);
        })).rejects.toThrow('backup_key_unavailable');
        expect(SeedManager.getMnemonic).not.toHaveBeenCalled();
    });
    it('unlock primes the foreign salt inside its approval, so scheduled backup later uses only the cache', async () => {
        const cloud = await foreignBackup(), meter = newMeter(cloud);
        await withBiometricAction('Unlock', action => meter.backup.primeKey(action));
        const reads = vi.mocked(SeedManager.getMnemonic).mock.calls.length;
        const result = await meter.backupNow({ allowPrompt: false });
        expect(result.ok).toBe(true); expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        expect(SeedManager.getMnemonic).toHaveBeenCalledTimes(reads);
        expect(await AsyncStorage.getItem('provian_pe_encryption_salt')).toBe(foreignSalt);
    });
    it.each(['cold', 'rotated'])('export uses its explicit transport for %s credentials and preserves all local records', async mode => {
        let secret: string | null = mode === 'cold' ? null : 'old-secret';
        vi.spyOn(RelayAPIService, 'getAuthSecret').mockImplementation(async () => secret);
        let approved!: BiometricAction;
        const recover = vi.spyOn(RelayAPIService, 'recoverRelayCredentials').mockImplementation(async (_wallet, action) => {
            assertBiometricAction(action); expect(action).toBe(approved); secret = 'new-secret'; return { userId: 'fixture_user', authSecret: secret, recovered: true };
        });
        let count = 0;
        vi.mocked(apiFetch).mockImplementation(async () => { count++; return new Response(JSON.stringify({ items: [], next: null }), { status: mode === 'rotated' && count === 1 ? 401 : 200 }); });
        const meter = newMeter(new MemoryCloudFiles()); await meter.start();
        await meter.store.addLegacy([envelope({ envelope_id: 'preserved-private-record' })]);
        const result = await withBiometricAction('Export', action => { approved = action; return meter.exportAllPes({ owner: { walletId: 'fixture_user', address: null }, appVersion: 'test', biometricAction: action }); });
        expect(result.text).toContain('preserved-private-record');
        expect(result.text).not.toContain('mailbox_not_checked');
        expect(recover).toHaveBeenCalledTimes(1); expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    });
    it('RED: scheduling permission alone cannot authenticate a missing current or foreign-salt key', async () => {
        expect(await PECloudSync.getArchiveKeyForBackup({ allowPrompt: true })).toBe(null);
        expect(await PECloudSync.getArchiveKeyForSalt(foreignSalt, { allowPrompt: true })).toBe(null);
        expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled(); expect(SeedManager.getMnemonic).not.toHaveBeenCalled();
    });
    it('RED: a completed action cannot unlock an uncached foreign salt later', async () => {
        let ended!: BiometricAction;
        await withBiometricAction('Earlier', async action => { ended = action; });
        expect(await PECloudSync.getArchiveKeyForSalt(foreignSalt, { allowPrompt: true, biometricAction: ended })).toBe(null);
        expect(SeedManager.getMnemonic).not.toHaveBeenCalled(); expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    });
});

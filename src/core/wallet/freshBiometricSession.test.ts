/** Regression: approvals are capabilities for one action, never a time-based global session. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
    kv: new Map<string, string>(), prompts: 0, next: 0, ended: [] as string[], live: new Set<string>(), store: new Map<string,string>(),
    listener: null as null | ((state: string) => void), state: 'active', platform: 'ios', fallback: false,
    beginWait: null as null | (() => Promise<void>), readWait: null as null | (() => Promise<void>), cancel: false,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: async (k: string) => h.kv.get(k) ?? null,
    setItem: async (k: string, v: string) => { h.kv.set(k, v); },
    removeItem: async (k: string) => { h.kv.delete(k); },
    multiSet: async (pairs: [string, string][]) => { for (const [k,v] of pairs) h.kv.set(k,v); },
    multiRemove: async (keys: string[]) => { for (const k of keys) h.kv.delete(k); },
    clear: async () => { h.kv.clear(); },
} }));
vi.mock('react-native', () => ({
    NativeModules: {},
    AppState: { get currentState() { return h.state; }, addEventListener: (_: string, fn: (state: string) => void) => { h.listener = fn; return { remove: vi.fn() }; } },
    Platform: { get OS() { return h.platform; } },
}));
vi.mock('../security/requireBiometric', () => ({
    requireBiometric: vi.fn(),
    authenticateBiometricAction: async (fn: (fallback: boolean) => Promise<string>) => fn(h.fallback),
}));
vi.mock('../recovery/cloud/CloudBackupV2', () => ({ hasCloudBackup: async () => false }));
vi.mock('../recovery/cloud/ProvianCloudKeychainSync', () => ({ retrieveSynced: async () => null }));
vi.mock('../provenance/ProvenanceEnvelopeManager', () => ({ default: {} }));
vi.mock('../security/securityLogger', () => ({ default: { log: vi.fn() } }));
vi.mock('../security/KeyManager', () => ({ default: {} }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => ({
    isAvailable: () => true,
    beginActionAsync: async () => { h.prompts++; if (h.cancel) throw new Error('cancelled'); await h.beginWait?.(); const id = String(++h.next); h.live.add(id); return id; },
    endActionAsync: async (id: string) => { h.live.delete(id); h.ended.push(id); },
    hasItemAsync: async (key: string) => h.store.has(key),
    probeItemAsync: async (key: string) => h.store.has(key) ? 'present' : 'absent',
    hasLegacyItemAsync: async () => false,
    getLegacyItemAsync: async () => null,
    setItemAsync: async (key: string, value: string, _prompt: string, id: string) => { if (!h.live.has(id)) throw new Error('no native approval'); if (h.store.has(key)) throw new Error('exists'); h.store.set(key,value); return true; },
    getItemAsync: async (key: string, _prompt: string, id: string) => { if (!h.live.has(id)) throw new Error('no native approval'); await h.readWait?.(); return h.store.get(key) ?? null; },
    deleteItemAsync: async (key: string) => { h.store.delete(key); return true; },
}) }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import SeedManager from './SeedManager';
import { withBiometricAction, assertBiometricAction, isBiometricActionValid, type BiometricAction } from '../security/biometricAction';
import { getMessageKeyPair, clearMessageKeyCache } from '../commons/threadCrypto';
import PECloudSync from '../provenance/PECloudSync';
import { encryptTermsToSelf, decryptTermsFromSelf, type PromiseTermsPayload } from '../promises/PromiseTermsVault';
import { ActionWallet } from '../security/ActionWallet';
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
function background() { h.state = 'background'; h.listener?.('background'); }
function foreground() { h.state = 'active'; h.listener?.('active'); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve=r; }); return { promise, resolve }; }
beforeEach(async () => {
    SeedManager.clearBiometricSession(); clearMessageKeyCache();
    h.state='active'; h.platform='ios'; h.fallback=false; h.cancel=false; h.beginWait=null; h.readWait=null;
    h.store.clear(); h.ended.length=0; await AsyncStorage.clear();
    await SeedManager.importMnemonic(phrase); h.prompts=0; h.ended.length=0;
});
describe('one biometric prompt per action', () => {
    it('seed replacement clears warmed domain keys before rederiving under the same one-prompt recovery action', async () => {
        const salt = 'ab'.repeat(16);
        await AsyncStorage.setItem('provian_pe_encryption_salt', salt);
        const terms: PromiseTermsPayload = { promiseId: 'test', theyGave: 'work', theyOwe: 'payment', who: 'peer', creatorAddress: '0x123', direction: 'i_owe', createdAt: 1 };
        const old = await withBiometricAction('warm A', async action => ({
            message: await getMessageKeyPair('message', action),
            archive: await PECloudSync.getArchiveKeyForBackup({ allowPrompt: false, biometricAction: action }),
            terms: await encryptTermsToSelf(terms, action),
        }));
        const oldPublic = [...old.message.publicKey];
        await AsyncStorage.setItem('provian_meter_message_key_published_v1', 'published-A');
        h.prompts = 0;
        await withBiometricAction('recover B', async action => {
            await SeedManager.importMnemonic('legal winner thank year wave sausage worth useful legal winner thank yellow', { force: true }, action);
            expect(await AsyncStorage.getItem('provian_meter_message_key_published_v1')).toBeNull();
            expect(await AsyncStorage.getItem('provian_pe_encryption_salt')).toBe(salt);
            expect([...old.message.secretKey]).toEqual(Array(32).fill(0));
            const message = await getMessageKeyPair('message', action);
            expect([...message.publicKey]).not.toEqual(oldPublic);
            const archive = await PECloudSync.getArchiveKeyForBackup({ allowPrompt: false, biometricAction: action });
            expect(archive?.saltHex).toBe(salt);
            expect(archive?.keyHex).not.toBe(old.archive?.keyHex);
            await expect(decryptTermsFromSelf(old.terms, action)).rejects.toThrow();
            expect(await decryptTermsFromSelf(await encryptTermsToSelf(terms, action), action)).toEqual(terms);
        });
        expect(h.prompts).toBe(1);
        await SeedManager.deleteAll();
        expect(await PECloudSync.getArchiveKeyForBackup({ allowPrompt: false })).toBeNull();
        expect(await AsyncStorage.getItem('provian_pe_encryption_salt')).toBe(salt);
        expect(h.prompts).toBe(1);
    });
    it('unlock verification, messaging-key initialization and multiple chain key reads reuse one native authentication', async () => {
        let saved!: BiometricAction;
        await withBiometricAction('Unlock', async action => {
            saved = action; await SeedManager.verifySeedReadable(action);
            expect((await getMessageKeyPair('message key', action)).secretKey).toHaveLength(32);
            const evm = await SeedManager.getEVMKey(action); evm.privateKey.fill(0);
            const sol = await SeedManager.getSolanaSeed(action); sol.fill(0);
            await withBiometricAction('nested work', async same => { expect(same).toBe(action); expect(await SeedManager.getMnemonic(same)).toBe(phrase); }, action);
        });
        expect(h.prompts).toBe(1); expect(h.live.size).toBe(0);
        expect(isBiometricActionValid(saved)).toBe(false);
        await expect(SeedManager.getMnemonic(saved)).rejects.toThrow('live biometric action');
    });
    it('RED controls: a forged capability and an ended real approval cannot read; each later action prompts again', async () => {
        await expect(SeedManager.getMnemonic({ nativeId: 'forged' })).rejects.toThrow('live biometric action');
        for (const reason of ['send', 'sign', 'export']) await withBiometricAction(reason, async action => { expect(await SeedManager.getMnemonic(action)).toBe(phrase); });
        expect(h.prompts).toBe(3);
        await expect(SeedManager.getMnemonic()).rejects.toThrow('live biometric action');
    });
    it('simultaneous distinct actions serialize without sharing approval', async () => {
        const entered = deferred(), finish = deferred();
        const a = withBiometricAction('first', async () => { entered.resolve(); await finish.promise; });
        await entered.promise;
        const b = withBiometricAction('second', async () => { });
        await Promise.resolve(); expect(h.prompts).toBe(1);
        finish.resolve(); await Promise.all([a, b]); expect(h.prompts).toBe(2);
    });
    it('cancellation performs no secret work and a subsequent action still works', async () => {
        h.cancel = true; const work = vi.fn();
        await expect(withBiometricAction('cancel', work)).rejects.toThrow('cancelled'); expect(work).not.toHaveBeenCalled();
        h.cancel = false; await withBiometricAction('retry', async action => { expect(await SeedManager.getMnemonic(action)).toBe(phrase); });
        expect(h.prompts).toBe(2);
    });
    it('RED: background during an in-flight read prevents returning the secret even when the native result arrives late', async () => {
        const read = deferred(), finish = deferred(); h.readWait = async () => { read.resolve(); await finish.promise; };
        const result = withBiometricAction('read', action => SeedManager.getMnemonic(action));
        await read.promise; background(); finish.resolve();
        await expect(result).rejects.toThrow(/live biometric action|no native approval/); foreground();
    });
    it('RED: background during pending iOS authentication cannot resurrect an approval', async () => {
        const entered = deferred(), finish = deferred(); h.beginWait = async () => { entered.resolve(); await finish.promise; };
        const work = vi.fn(); const result = withBiometricAction('pending', work);
        await entered.promise; background(); foreground(); finish.resolve();
        await expect(result).rejects.toThrow('live biometric action'); expect(work).not.toHaveBeenCalled(); expect(h.live.size).toBe(0);
    });
    it('Android fallback can finish its first system credential Activity transition, but the resulting grant still ends on background', async () => {
        h.platform = 'android'; h.fallback = true;
        h.beginWait = async () => { background(); foreground(); };
        await withBiometricAction('credential', async action => { assertBiometricAction(action); background(); expect(isBiometricActionValid(action)).toBe(false); });
        expect(h.prompts).toBe(1); foreground();
    });
    it('RED: a background after asynchronous EVM preparation blocks broadcast with the actual signer', async () => {
        const broadcast = vi.fn();
        await expect(withBiometricAction('send', async action => {
            const signer = new ActionWallet('0x' + '1'.repeat(64), action, { broadcastTransaction: broadcast, getNetwork: async () => { background(); return { chainId: 8453n }; } } as never);
            vi.spyOn(signer, 'populateTransaction').mockImplementation(async () => { background(); return { to: '0x' + '2'.repeat(40), value: 0n }; });
            await signer.sendTransaction({});
        })).rejects.toThrow('live biometric action');
        expect(broadcast).not.toHaveBeenCalled(); foreground();
    });
    it('a completed action cannot retain a reusable signer', async () => {
        let signer!: ActionWallet;
        await withBiometricAction('sign', async action => { signer = new ActionWallet('0x' + '1'.repeat(64), action); expect(await signer.signMessage('approved')).toMatch(/^0x/); });
        await expect(signer.signMessage('later')).rejects.toThrow('live biometric action'); expect(h.prompts).toBe(1);
    });
});

/**
 * the seed keychain item: re-enrollment, passcode-only devices, the one-way move, and
 * (round 2) staged replacement with an atomic identity commit.
 *
 * Two storage MODELS stand in for native code, each reproducing the semantics this change turns on:
 *
 * ExpoSecureStoreModel — expo-secure-store 15.0.8 for `requireAuthentication: true` items:
 * * the ACL is bound to the biometric set current at write time (iOS `.biometryCurrentSet`,
 * SecureStoreModule.swift:105; Android per-use Keystore key invalidated on enrollment,
 * AESEncryptor.kt:59-64) — after a re-enrollment the read returns null
 * (SecureStoreModule.kt:156-158 / item inaccessible on iOS);
 * * the write THROWS when no biometric is enrolled (iOS SecItemAdd fails; Android
 * AuthenticationHelper.kt:59-67 `No biometrics are currently enrolled`).
 * NativeSeedModel — provian-secure-seed (modules/provian-secure-seed): user-presence ACL that
 * survives re-enrollment and admits the device passcode; `get` returns null only when absent;
 * a per-item "key invalidated" state (Android: lock screen removed); a no-prompt probe. Like the
 * ROUND-1 native module it still performs an in-place overwrite if asked — so a caller that
 * relies on overwriting is caught by the monitor below rather than masked by the model.
 *
 * MONITORS (checked after EVERY test; each has its own negative control below):
 * - legacy deletion: a delete of the legacy item is a violation unless some native slot holds the
 * identical value, read back since written — or the user confirmed replacing exactly that value;
 * - in-place overwrite: a native `set` over an existing item is a violation (the old value would be
 * destroyed before the new one is proven);
 * - live-slot deletion: deleting the slot the committed identity names is a violation (only the
 * explicit wallet wipe may).
 * - read-before-delete (round 4): deleting an item this process neither read nor wrote is a
 * violation — except (round 5/6) an Android native slot whose key really was permanently
 * INVALIDATED and for which this process saw BOTH signals (a read rejecting ERR_SEED_UNRECOVERABLE
 * and a probe answering 'invalidated' or, under round-1 native semantics, 'unrecoverable');
 * such deletes are recorded in `unrecoverableDeletes`. A key that was only transiently reported
 * missing is never "really gone".
 *
 * The native model drives the two signals from SEPARATE fault sources: `unrecoverableKeys` (the key
 * really was permanently invalidated — both the probe and the read see it), `probeKeyMissing` (the
 * probe's Keystore lookup transiently answers "no key") and `readKeyMissing` (the read's lookup does).
 * `semantics` selects the native module being modelled: 'current' (probe 'invalidated' only on
 * KeyPermanentlyInvalidatedException, 'unknown' on a missing key; read messages tagged `[cause:…]`)
 * or 'round1' (the module before round 6: probe 'unrecoverable' for both, untagged messages).
 *
 * CRASH SWEEPS kill the process at EVERY storage call (native, expo, AsyncStorage) of an operation —
 * after the kill every later call fails, as in a dead process — then restart the module and require:
 * the address the app shows equals the address of the seed a read returns, the seed is one of the two
 * wallets involved, and no monitor fired.
 *
 * Item and bookkeeping names are written literally here (not imported) so this file can be run
 * against the ROUND-1 code for the RED record; one test binds them to the module's constants.
 *
 * RED controls, recorded in DECISIONS (round 2) against f3056b17 (round 1) and master.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';

// ── device + storage models ───────────────────────────────────────────────────────────────────

const models = vi.hoisted(() => {
    type Device = { biometricsEnrolled: boolean; passcodeSet: boolean; enrollmentGeneration: number };
    const device: Device = { biometricsEnrolled: true, passcodeSet: true, enrollmentGeneration: 1 };

    const LEGACY = 'provian_bip39_mnemonic';
    const SLOT_KEYS: Record<string, string> = { a: 'provian_bip39_mnemonic_v2', b: 'provian_bip39_mnemonic_v2b' };
    const IDENTITY = 'provian_seed_identity';

    /** Provenance per item: the process (epoch) that last wrote it and that last read its value. */
    type Provenance = {
        writtenEpoch?: number;
        readEpoch?: number;
        /** Native only: the process in which a read rejected ERR_SEED_UNRECOVERABLE / a probe answered 'unrecoverable'. */
        unrecoverableReadEpoch?: number;
        unrecoverableProbeEpoch?: number;
    };
    /** The platform the app believes it runs on (react-native Platform.OS). */
    const platform = { OS: 'android' as string };
    /** Slots deleted on the "key permanently gone" proof (both signals seen in this process). */
    const unrecoverableDeletes: string[] = [];
    type ExpoItem = { value: string; auth: boolean; boundGeneration: number } & Provenance;
    const expoItems = new Map<string, ExpoItem>();
    const expoFaults = { deleteThrowsOnce: false, readThrows: null as string | null };

    type NativeItem = { value: string; readBackSinceWrite: boolean } & Provenance;
    const nativeItems = new Map<string, NativeItem>();
    const nativeFaults = {
        writeThrows: false,
        /** The next get of an existing item returns this value instead (a read-back mismatch). */
        readOverride: null as string | null,
        /** The next N gets reject as a dismissed prompt. */
        cancelReads: 0,
        /** Items whose Keystore key was permanently invalidated (Android: lock screen removed). */
        unrecoverableKeys: new Set<string>(),
        /** The no-prompt probe answers this for an item regardless of its real state. */
        probeOverride: new Map<string, 'absent' | 'present' | 'invalidated' | 'unrecoverable' | 'unknown'>(),
        /** The probe's Keystore lookup transiently reports "no key" for these items (daemon hiccup). */
        probeKeyMissing: new Set<string>(),
        /** The read's Keystore lookup transiently reports "no key" for these items (daemon hiccup). */
        readKeyMissing: new Set<string>(),
        /** Which native module is modelled (see the header). */
        semantics: 'current' as 'current' | 'round1',
        /** The no-prompt probe rejects for these items. */
        probeThrows: new Set<string>(),
    };

    const kv = new Map<string, string>();
    const violations: string[] = [];
    /** A user-confirmed overwrite (import { force }) may retire THIS legacy value once its replacement read back. */
    const replacement = { authorized: null as string | null };
    const flags = { clearing: false, setup: false };
    /** The current app process. Items planted by test setup belong to no process (-1). */
    const proc = { epoch: 1 };
    function writtenNow(): number {
        return flags.setup ? -1 : proc.epoch;
    }
    /**
     * Monitor: a seed item may be deleted only if THIS process read its value (or wrote it) — or, for
     * a native slot on Android whose key really is permanently gone, this process saw BOTH signals.
     */
    function checkProvenDelete(key: string, item: Provenance | undefined, nativeSlot: boolean): void {
        if (flags.clearing || !item) return;
        if (item.readEpoch === proc.epoch || item.writtenEpoch === proc.epoch) return;
        if (nativeSlot && (item.unrecoverableReadEpoch === proc.epoch || item.unrecoverableProbeEpoch === proc.epoch)) {
            const bothSignals = item.unrecoverableReadEpoch === proc.epoch && item.unrecoverableProbeEpoch === proc.epoch;
            if (bothSignals && platform.OS === 'android' && nativeFaults.unrecoverableKeys.has(key)) {
                unrecoverableDeletes.push(key);
                return;
            }
            violations.push(`deleted ${key} as unrecoverable without proof (both signals, Android, key really gone)`);
            return;
        }
        violations.push(`deleted ${key} without reading it in this process`);
    }

    /** Process-death injection: the op numbered `crashAt` throws, and so does every op after it. */
    const ops = { count: 0, crashAt: 0, dead: false };
    function tick(): void {
        if (ops.dead) throw new Error('process is dead');
        ops.count += 1;
        if (ops.crashAt > 0 && ops.count === ops.crashAt) {
            ops.dead = true;
            throw new Error('process killed');
        }
    }

    function liveSlotKey(): string | null {
        const raw = kv.get(IDENTITY);
        if (!raw) return null;
        try {
            const slot = (JSON.parse(raw) as { slot?: string }).slot;
            return slot ? SLOT_KEYS[slot] ?? null : null;
        } catch {
            return null;
        }
    }

    const expo = {
        WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
        async setItemAsync(key: string, value: string, options?: { requireAuthentication?: boolean }) {
            tick();
            if (options?.requireAuthentication) {
                if (!device.biometricsEnrolled) throw new Error('No biometrics are currently enrolled');
                expoItems.set(key, { value, auth: true, boundGeneration: device.enrollmentGeneration, writtenEpoch: writtenNow() });
            } else {
                expoItems.set(key, { value, auth: false, boundGeneration: 0, writtenEpoch: writtenNow() });
            }
        },
        async getItemAsync(key: string) {
            tick();
            if (expoFaults.readThrows) throw new Error(expoFaults.readThrows);
            const item = expoItems.get(key);
            if (!item) return null;
            if (item.auth && item.boundGeneration !== device.enrollmentGeneration) return null; // invalidated
            item.readEpoch = proc.epoch;
            return item.value;
        },
        async deleteItemAsync(key: string) {
            tick();
            if (key === LEGACY) checkProvenDelete(key, expoItems.get(key), false);
            if (key === LEGACY && expoItems.has(key)) {
                if (expoFaults.deleteThrowsOnce) {
                    expoFaults.deleteThrowsOnce = false;
                    throw new Error('delete failed');
                }
                const deleted = expoItems.get(key)!.value;
                const verifiedCopy = [...nativeItems.entries()].some(
                    ([k, it]) => Object.values(SLOT_KEYS).includes(k) && it.value === deleted && it.readBackSinceWrite,
                );
                if (!flags.clearing && !verifiedCopy && replacement.authorized !== deleted) {
                    violations.push('legacy deleted without a verified native copy of the same value');
                }
            }
            expoItems.delete(key);
        },
    };

    const native = {
        isAvailable: () => true,
        async hasItemAsync(key: string) {
            tick();
            return nativeItems.has(key);
        },
        async probeItemAsync(key: string) {
            tick();
            if (nativeFaults.probeThrows.has(key)) throw Object.assign(new Error('probe failed'), { code: 'ERR_SEED_KEYCHAIN' });
            const item = nativeItems.get(key);
            const round1 = nativeFaults.semantics === 'round1';
            let answer: 'absent' | 'present' | 'invalidated' | 'unrecoverable' | 'unknown';
            if (nativeFaults.probeOverride.has(key)) answer = nativeFaults.probeOverride.get(key)!;
            else if (!item) answer = 'absent';
            else if (nativeFaults.probeKeyMissing.has(key)) answer = round1 ? 'unrecoverable' : 'unknown';
            else if (nativeFaults.unrecoverableKeys.has(key)) answer = round1 ? 'unrecoverable' : 'invalidated';
            else answer = 'present';
            if (item && (answer === 'invalidated' || answer === 'unrecoverable')) item.unrecoverableProbeEpoch = proc.epoch;
            return answer;
        },
        async setItemAsync(key: string, value: string, _prompt: string) {
            tick();
            if (!device.passcodeSet) throw Object.assign(new Error('no passcode'), { code: 'ERR_SEED_WRITE_FAILED' });
            if (nativeFaults.writeThrows) throw Object.assign(new Error('write failed'), { code: 'ERR_SEED_WRITE_FAILED' });
            if (nativeItems.has(key)) violations.push(`in-place overwrite of native item ${key}`);
            nativeItems.set(key, { value, readBackSinceWrite: false, writtenEpoch: writtenNow() });
            nativeFaults.unrecoverableKeys.delete(key); // a new write generates a new key
            return true;
        },
        async getItemAsync(key: string, _prompt: string) {
            tick();
            if (nativeFaults.cancelReads > 0) {
                nativeFaults.cancelReads -= 1;
                throw Object.assign(new Error('cancelled'), { code: 'ERR_SEED_AUTH_CANCELLED' });
            }
            const item = nativeItems.get(key);
            if (!item) return null;
            const round1 = nativeFaults.semantics === 'round1';
            if (nativeFaults.readKeyMissing.has(key)) {
                item.unrecoverableReadEpoch = proc.epoch;
                const text = 'the Keystore key for this seed record was not found';
                throw Object.assign(new Error(round1 ? text : `[cause:key_missing] ${text}`), { code: 'ERR_SEED_UNRECOVERABLE' });
            }
            if (nativeFaults.unrecoverableKeys.has(key)) {
                item.unrecoverableReadEpoch = proc.epoch;
                const text = 'the Keystore key was permanently invalidated';
                throw Object.assign(new Error(round1 ? text : `[cause:invalidated] ${text}`), { code: 'ERR_SEED_UNRECOVERABLE' });
            }
            if (nativeFaults.readOverride !== null) {
                const v = nativeFaults.readOverride;
                nativeFaults.readOverride = null;
                return v;
            }
            item.readBackSinceWrite = true; // re-enrollment has no effect on this ACL
            item.readEpoch = proc.epoch;
            return item.value;
        },
        async deleteItemAsync(key: string) {
            tick();
            if (Object.values(SLOT_KEYS).includes(key)) checkProvenDelete(key, nativeItems.get(key), true);
            if (!flags.clearing && nativeItems.has(key) && liveSlotKey() === key) {
                violations.push(`deleted the live seed slot ${key}`);
            }
            nativeItems.delete(key);
            nativeFaults.unrecoverableKeys.delete(key);
            return true;
        },
    };

    const asyncStorage = {
        getItem: async (k: string) => { tick(); return kv.has(k) ? kv.get(k)! : null; },
        setItem: async (k: string, v: string) => { tick(); kv.set(k, v); },
        removeItem: async (k: string) => { tick(); kv.delete(k); },
        multiSet: async (pairs: [string, string][]) => { tick(); for (const [k, v] of pairs) kv.set(k, v); },
        multiRemove: async (keys: string[]) => { tick(); for (const k of keys) kv.delete(k); },
        clear: async () => { tick(); kv.clear(); },
    };

    return {
        device, expoItems, expoFaults, nativeItems, nativeFaults, kv, violations, replacement, flags, ops, proc,
        platform, unrecoverableDeletes,
        expo, native, asyncStorage, SLOT_KEYS, IDENTITY,
        nativeEnabled: { value: true },
        reenroll() { device.enrollmentGeneration += 1; },
        /** The app process restarts: nothing it read before counts as read any more. */
        newProcess() { proc.epoch += 1; },
        reset() {
            device.biometricsEnrolled = true;
            device.passcodeSet = true;
            device.enrollmentGeneration = 1;
            expoItems.clear();
            nativeItems.clear();
            kv.clear();
            violations.length = 0;
            replacement.authorized = null;
            flags.clearing = false;
            flags.setup = false;
            proc.epoch = 1;
            ops.count = 0;
            ops.crashAt = 0;
            ops.dead = false;
            expoFaults.deleteThrowsOnce = false;
            expoFaults.readThrows = null;
            nativeFaults.writeThrows = false;
            nativeFaults.readOverride = null;
            nativeFaults.cancelReads = 0;
            nativeFaults.unrecoverableKeys.clear();
            nativeFaults.probeOverride.clear();
            nativeFaults.probeThrows.clear();
            nativeFaults.probeKeyMissing.clear();
            nativeFaults.readKeyMissing.clear();
            nativeFaults.semantics = 'current';
            platform.OS = 'android';
            unrecoverableDeletes.length = 0;
        },
    };
});

vi.mock('expo-secure-store', () => models.expo);
vi.mock('react-native', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Platform: models.platform,
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: models.asyncStorage }));
vi.mock('expo-modules-core', () => ({
    requireOptionalNativeModule: (name: string) =>
        name === 'ProvianSecureSeed' && models.nativeEnabled.value ? models.native : null,
}));
vi.mock('../security/requireBiometric', () => ({ requireBiometric: vi.fn().mockResolvedValue(true) }));
vi.mock('../security/securityLogger', () => ({ default: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../security/KeyManager', () => ({
    default: { getKeyAttestation: vi.fn().mockResolvedValue({ tier: 'software' }) },
}));

import SeedManager, {
    SeedUnreadableError,
    SeedWriteVerificationError,
    MultipleUnidentifiedWalletsError,
    UnidentifiedStoredKeyError,
} from './SeedManager';
import WalletCreationService from './WalletCreationService';
import {
    applyCloudRecovery,
    OverwriteConfirmationRequired,
    REQUIRED_CONFIRMATION_PHRASE,
} from '../recovery/applyCloudRecovery';
import * as seedStore from './secureSeedStore';

type SM = typeof SeedManager;

const LEGACY = 'provian_bip39_mnemonic';
const SLOT_A = 'provian_bip39_mnemonic_v2';
const SLOT_B = 'provian_bip39_mnemonic_v2b';
const EVM_CACHE = 'provian_public_evm_address';
const UNREADABLE = 'provian_seed_unreadable';
// Canonical, checksum-valid BIP-39 test vectors (never real wallets).
const M_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const M_B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
/** iOS expo-secure-store error for errSecAuthFailed (an F14 item whose biometry set changed). */
const IOS_AUTH_FAILED =
    "Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: Authentication failed. Provided passphrase/PIN is incorrect or there is no user authentication method configured for this device.";
const IOS_CANCELLED = "Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: User canceled the operation.";

/** Independent EVM-address oracle (BIP-44 m/44'/60'/0'/0/0), anchored to the published vector below. */
function evmAddress(mnemonic: string): string {
    const key = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive("m/44'/60'/0'/0/0");
    const pub = secp256k1.ProjectivePoint.fromHex(key.publicKey!).toRawBytes(false).slice(1);
    return `0x${bytesToHex(keccak_256(pub).slice(-20))}`;
}

function nativeValues(): string[] {
    return [SLOT_A, SLOT_B].map((k) => models.nativeItems.get(k)?.value).filter((v): v is string => v !== undefined);
}

/** An installed wallet from the F14 build: auth-gated expo item + public-address cache. */
/** An F14 expo item as an older build left it (belongs to no current process). */
async function plantLegacy(mnemonic: string): Promise<void> {
    models.flags.setup = true;
    try {
        await models.expo.setItemAsync(LEGACY, mnemonic, { requireAuthentication: true });
    } finally {
        models.flags.setup = false;
    }
}

async function installF14Wallet(mnemonic: string, sm: SM = SeedManager): Promise<string> {
    await plantLegacy(mnemonic);
    await sm.cachePublicAddresses(mnemonic);
    const address = await sm.getEVMAddress();
    models.newProcess();
    return address;
}

/** A wallet that has already moved to the native store (round-2 identity or round-1 bookkeeping). */
async function installMigratedWallet(mnemonic: string, sm: SM = SeedManager): Promise<void> {
    await installF14Wallet(mnemonic, sm);
    expect(await sm.migrateSeedStorageIfNeeded()).toBe('migrated');
    expect(models.expoItems.has(LEGACY)).toBe(false);
    models.newProcess();
}

async function readSeed(sm: SM = SeedManager): Promise<string | null> {
    return sm.withBiometricAction('test', action => sm.getMnemonic(action));
}

/** The WalletCreationService of the most recent `restart()` (the same module instance as its SeedManager). */
let currentWcs: typeof WalletCreationService = WalletCreationService;

/** A fresh module instance: what the app is after the process restarts. */
async function restart(): Promise<SM> {
    models.newProcess();
    vi.resetModules();
    const sm = (await import('./SeedManager')).default;
    currentWcs = (await import('./WalletCreationService')).default;
    return sm;
}

/**
 * What onboarding does next after a relaunch (BiometricSetupScreen): use the stored wallet if the app
 * already recorded one, else createWallet(). Must succeed, and name the stored seed.
 */
async function onboardingRetry(sm: SM): Promise<void> {
    const service = currentWcs.getInstance();
    const existing = await service.getStoredWallet();
    const address = existing ? existing.walletAddress : (await service.createWallet()).walletAddress;
    expect((await sm.getEVMAddress()).toLowerCase()).toBe(address.toLowerCase());
    const seed = await readSeed(sm);
    expect(seed).not.toBeNull();
    expect(evmAddress(seed!)).toBe(address.toLowerCase());
}

/** The core invariant after any interruption: what is shown is what is stored. */
async function expectShownIsStored(sm: SM, allowed: readonly string[]): Promise<string> {
    const shown = await sm.getEVMAddress();
    const seed = await readSeed(sm);
    expect(seed).not.toBeNull();
    expect(allowed).toContain(seed);
    expect(evmAddress(seed!).toLowerCase()).toBe(shown.toLowerCase());
    return seed!;
}

/**
 * Kill the process at storage call 1, 2, 3, … of `act`, restart, and run `check`. Stops at the first
 * N at which `act` completes without being killed. Returns how many kill points were exercised.
 */
async function crashSweep(setup: (sm: SM) => Promise<void>, act: (sm: SM) => Promise<unknown>, check: (sm: SM) => Promise<void>): Promise<number> {
    for (let n = 1; n <= 400; n++) {
        models.reset();
        const before = await restart();
        await setup(before);
        models.ops.count = 0;
        models.ops.crashAt = n;
        try {
            await act(before);
        } catch (err) {
            if (!models.ops.dead) throw err;
        }
        const killed = models.ops.dead;
        models.ops.crashAt = 0;
        models.ops.dead = false;
        const after = await restart();
        try {
            await check(after);
            expect(models.violations).toEqual([]);
        } catch (err) {
            throw new Error(`kill point ${n}${killed ? '' : ' (completed)'}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!killed) {
            // The evaluated population, printed: a sweep over zero kill points proves nothing.
            console.info(`crash sweep: ${n - 1} kill points exercised`);
            return n - 1;
        }
    }
    throw new Error('crash sweep did not terminate');
}

beforeEach(() => {
    models.reset();
    models.nativeEnabled.value = true;
    SeedManager.clearBiometricSession();
});

afterEach(() => {
    // The money-safety invariants, checked after EVERY test in this file.
    expect(models.violations).toEqual([]);
});

describe('fixtures', () => {
    it('the address oracle matches the published BIP-44 vector, and the item names are the module constants', () => {
        expect(evmAddress(M_A)).toBe('0x9858effd232b4033e47d90003d41ec34ecaeda94');
        expect(seedStore.SEED_ITEMS).toEqual({ LEGACY, SLOT_A, SLOT_B });
        expect(seedStore.SEED_STATE_KEYS).toEqual({ IDENTITY: models.IDENTITY, UNREADABLE });
        expect(Object.values(models.SLOT_KEYS)).toEqual([SLOT_A, SLOT_B]);
    });
});

describe('requirements', () => {
    it('a passcode-only device (no enrolled biometrics) can create a wallet end to end', async () => {
        models.device.biometricsEnrolled = false;

        const result = await WalletCreationService.getInstance().createWallet();

        expect(result.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
        const seed = await readSeed();
        expect(seed).not.toBeNull();
        expect(seed!.split(' ')).toHaveLength(12);
        expect(nativeValues()).toEqual([seed]);
        expect(evmAddress(seed!).toLowerCase()).toBe(result.walletAddress.toLowerCase());
    });

    it('re-enrolling Face ID / a fingerprint never makes the seed unreadable', async () => {
        const mnemonic = await SeedManager.generate();
        models.reenroll();
        expect(await readSeed()).toBe(mnemonic);
        models.reenroll();
        models.device.biometricsEnrolled = false; // all biometrics removed — passcode still opens it
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(mnemonic);
    });

    it('an installed F14 wallet carries over at unlock with no user action, then survives re-enrollment', async () => {
        const address = await installF14Wallet(M_A);
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('migrated');

        models.reenroll();
        expect(await readSeed()).toBe(M_A);
        expect(await SeedManager.getEVMAddress()).toBe(address);
        expect(models.expoItems.has(LEGACY)).toBe(false);
        expect(nativeValues()).toEqual([M_A]);
        // Second unlock: the live slot is probed without a prompt — no seed read at all
        // (a cancel-armed read would have consumed the arm).
        models.nativeFaults.cancelReads = 1;
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('already_migrated');
        expect(models.nativeFaults.cancelReads).toBe(1);
        models.nativeFaults.cancelReads = 0;
    });

    it('an F14 wallet also carries over lazily on its first seed read (signing), same proof', async () => {
        await installF14Wallet(M_A);
        expect(await readSeed()).toBe(M_A);
        expect(models.expoItems.has(LEGACY)).toBe(false);
        expect(nativeValues()).toEqual([M_A]);
    });

    it('a known wallet whose seed is gone is SeedUnreadable — never "no wallet", never overwritten', async () => {
        // The pre-fix failure mode itself: an F14 item invalidated by a re-enrollment before the update.
        await installF14Wallet(M_A);
        models.reenroll();

        await expect(readSeed()).rejects.toBeInstanceOf(SeedUnreadableError);
        expect(await SeedManager.isSeedUnreadable()).toBe(true);
        expect(await SeedManager.hasSeed()).toBe(true);
        await expect(WalletCreationService.getInstance().createWallet()).rejects.toThrow(/already exists/);
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('unreadable');
        expect(models.nativeItems.size).toBe(0);
    });

    it('restore from cloud backup repairs an unreadable seed of the SAME wallet (was a silent no-op)', async () => {
        await installF14Wallet(M_A);
        models.reenroll();
        await expect(readSeed()).rejects.toBeInstanceOf(SeedUnreadableError);

        const r = await applyCloudRecovery(M_A, {
            hasSeed: () => SeedManager.hasSeed(),
            seedMatches: (m) => SeedManager.seedMatches(m),
            importMnemonic: (m, o) => SeedManager.importMnemonic(m, o),
            verifySeedReadable: () => SeedManager.verifySeedReadable(),
        });

        expect(r).toEqual({ overwroteExistingWallet: false, alreadyPresent: true });
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_A);
        expect(await SeedManager.isSeedUnreadable()).toBe(false);
    });
});

describe(' round 2 — defect 1: a read never returns a seed that is not the wallet shown', () => {
    it('kill at EVERY step of a confirmed import over an UNMIGRATED (F14) wallet: shown == stored after restart', async () => {
        const points = await crashSweep(
            async (sm) => {
                await installF14Wallet(M_A, sm);
                models.replacement.authorized = M_A; // the user passed the overwrite gate for wallet A
            },
            (sm) => sm.importMnemonic(M_B, { force: true }),
            async (sm) => { await expectShownIsStored(sm, [M_A, M_B]); },
        );
        expect(points).toBeGreaterThanOrEqual(8);
    });

    it('kill at EVERY step of a confirmed import over a MIGRATED wallet: shown == stored after restart', async () => {
        const points = await crashSweep(
            async (sm) => {
                await installMigratedWallet(M_A, sm);
                models.replacement.authorized = M_A;
            },
            (sm) => sm.importMnemonic(M_B, { force: true }),
            async (sm) => { await expectShownIsStored(sm, [M_A, M_B]); },
        );
        expect(points).toBeGreaterThanOrEqual(8);
    });

    it('kill at EVERY step of the unlock-time carry-over: the wallet stays readable and shown == stored', async () => {
        const points = await crashSweep(
            async (sm) => { await installF14Wallet(M_A, sm); },
            (sm) => sm.migrateSeedStorageIfNeeded(),
            async (sm) => { await expectShownIsStored(sm, [M_A]); },
        );
        expect(points).toBeGreaterThanOrEqual(8);
    });

    it('kill at EVERY step of createWallet(): the relaunched onboarding RETRY succeeds with a consistent wallet', async () => {
        const points = await crashSweep(
            async () => undefined,
            () => currentWcs.getInstance().createWallet(),
            async (sm) => { await onboardingRetry(sm); },
        );
        expect(points).toBeGreaterThanOrEqual(8);
    });

    it('a legacy seed that is not the known wallet is never returned (SeedUnreadable instead)', async () => {
        await models.expo.setItemAsync(LEGACY, M_A, { requireAuthentication: true });
        await SeedManager.cachePublicAddresses(M_B); // the device's wallet is B
        await expect(readSeed()).rejects.toBeInstanceOf(SeedUnreadableError);
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A); // and never deleted
        expect(models.nativeItems.size).toBe(0);
    });

    it('a public-address cache that lags the stored wallet never makes the good seed unreadable', async () => {
        await installMigratedWallet(M_A);
        await SeedManager.cachePublicAddresses(M_B); // stale/foreign F14 cache
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_A);
        expect((await SeedManager.getEVMAddress()).toLowerCase()).toBe(evmAddress(M_A));
    });

    it('the persisted display address is reconciled to the stored wallet (Receive never shows the old one)', async () => {
        await installMigratedWallet(M_A);
        await models.asyncStorage.multiSet([
            ['provian_wallet_address', evmAddress(M_A)],
            ['provian_evm_address', evmAddress(M_A)],
        ]);
        models.replacement.authorized = M_A;
        await SeedManager.importMnemonic(M_B, { force: true }); // screen killed before it saved B's address
        const state = await WalletCreationService.getInstance().getStoredWallet();
        expect(state?.walletAddress.toLowerCase()).toBe(evmAddress(M_B));
        expect(models.kv.get('provian_wallet_address')?.toLowerCase()).toBe(evmAddress(M_B));
    });
});

describe(' round 3 — an interrupted creation is ADOPTED, never cleared, never a dead end', () => {
    const M_C = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

    it('a creation killed during its read-back prompt: the retry adopts the stored phrase (not "already exists")', async () => {
        // The state the kill leaves: one unnamed, never-committed phrase in slot A; no identity, no cache.
        models.nativeItems.set(SLOT_A, { value: M_C, readBackSinceWrite: false });
        const result = await WalletCreationService.getInstance().createWallet();
        expect(result.walletAddress.toLowerCase()).toBe(evmAddress(M_C));
        expect(nativeValues()).toEqual([M_C]); // nothing generated over it, nothing deleted
        expect(await readSeed()).toBe(M_C);
    });

    it('two DIFFERENT unnamed phrases: create refuses ("already exists"), picks nothing, deletes nothing', async () => {
        models.nativeItems.set(SLOT_A, { value: M_A, readBackSinceWrite: true });
        models.nativeItems.set(SLOT_B, { value: M_B, readBackSinceWrite: true });
        const err = await WalletCreationService.getInstance().createWallet().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MultipleUnidentifiedWalletsError);
        expect((err as Error).message).toMatch(/already exists/); // → the conflict panel's Restore
        expect(nativeValues()).toEqual([M_A, M_B]);
        expect(models.kv.has(models.IDENTITY)).toBe(false);
        await expect(readSeed()).rejects.toBeInstanceOf(MultipleUnidentifiedWalletsError);
    });

    it('…restoring one of them adopts it and KEEPS the other; a later import never drops the unidentified one', async () => {
        models.nativeItems.set(SLOT_A, { value: M_A, readBackSinceWrite: true });
        models.nativeItems.set(SLOT_B, { value: M_B, readBackSinceWrite: true });
        await SeedManager.importMnemonic(M_B, { force: true }); // the user restores B from its phrase
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_B);
        expect((await SeedManager.getEVMAddress()).toLowerCase()).toBe(evmAddress(M_B));
        expect(nativeValues()).toEqual([M_A, M_B]);

        // Replacing B with a third wallet would need the other slot, which holds a wallet nobody identified.
        await expect(SeedManager.importMnemonic(M_C, { force: true })).rejects.toThrow(/could not be identified/);
        expect(nativeValues()).toEqual([M_A, M_B]);
        expect(await readSeed()).toBe(M_B);
    });

    it('an undecodable unnamed item is kept and blocks generation ("already exists"); only the explicit wipe gets past', async () => {
        models.nativeItems.set(SLOT_A, { value: 'not a recovery phrase', readBackSinceWrite: true });
        const err = await WalletCreationService.getInstance().createWallet().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnidentifiedStoredKeyError);
        expect((err as Error).message).toMatch(/already exists/);
        expect(nativeValues()).toEqual(['not a recovery phrase']);
        expect(models.kv.has(models.IDENTITY)).toBe(false);

        // The conflict panel's biometric + destructive-confirm "Delete and retry" is the one way past.
        models.flags.clearing = true;
        await WalletCreationService.getInstance().deleteWallet();
        models.flags.clearing = false;
        const result = await WalletCreationService.getInstance().createWallet();
        expect(evmAddress((await readSeed())!)).toBe(result.walletAddress.toLowerCase());
    });

    it('an unreadable (invalidated-key) unnamed item is kept and blocks generation', async () => {
        models.nativeItems.set(SLOT_A, { value: M_A, readBackSinceWrite: true });
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        await expect(WalletCreationService.getInstance().createWallet()).rejects.toBeInstanceOf(UnidentifiedStoredKeyError);
        expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_A);
        expect(models.nativeItems.has(SLOT_B)).toBe(false);
    });

    it('an unproven item in the staging slot is kept and a replacement import refuses (nothing changes)', async () => {
        await installMigratedWallet(M_A);
        models.nativeItems.set(SLOT_B, { value: 'not a recovery phrase', readBackSinceWrite: true });
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.get(SLOT_B)?.value).toBe('not a recovery phrase');
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_A);
    });

    it('a KNOWN wallet whose seed cannot be read still refuses creation (restore, never create over it)', async () => {
        await installF14Wallet(M_A);
        models.reenroll();
        await expect(WalletCreationService.getInstance().createWallet()).rejects.toThrow(/already exists/);
        expect(models.expoItems.has(LEGACY)).toBe(true);
        expect(models.nativeItems.size).toBe(0);
    });

    it('an unidentified legacy item is never retired by an import next to it', async () => {
        await models.expo.setItemAsync(LEGACY, M_A, { requireAuthentication: true }); // no cache: unidentified
        models.nativeItems.set(SLOT_A, { value: M_B, readBackSinceWrite: true }); // a second, different phrase
        await expect(readSeed()).rejects.toBeInstanceOf(MultipleUnidentifiedWalletsError);
        await SeedManager.importMnemonic(M_C, { force: true });
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_B);
        expect(await readSeed()).toBe(M_C);
    });
});

describe(' round 4 — nothing is generated beside, adopted beside, or deleted without reading, an existing item', () => {
    const M_C = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

    it('reinstall + F14 wallet W answering errSecAuthFailed (e.g. Face ID lockout): createWallet does NOT generate', async () => {
        await plantLegacy(M_A); // W: the keychain survived the reinstall; AsyncStorage (identity, cache) did not
        models.expoFaults.readThrows = IOS_AUTH_FAILED;
        const err = await WalletCreationService.getInstance().createWallet().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnidentifiedStoredKeyError);
        expect((err as Error).message).toMatch(/already exists/); // → Restore / explicit Delete and retry
        expect(models.nativeItems.size).toBe(0);
        expect(models.kv.has(models.IDENTITY)).toBe(false);
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
    });

    it('…and a later confirmed import never deletes the unread W', async () => {
        // A wallet X that an older build generated beside W (the state the reviewer traced).
        await plantLegacy(M_A);
        models.nativeItems.set(SLOT_A, { value: M_C, readBackSinceWrite: true });
        models.kv.set(models.IDENTITY, JSON.stringify({ v: 1, slot: 'a', evm: evmAddress(M_C), sol: '' }));
        models.newProcess();
        models.expoFaults.readThrows = IOS_AUTH_FAILED; // W cannot be read in this process
        await SeedManager.importMnemonic(M_B, { force: true }); // Z, user-confirmed (replacing X)
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        models.expoFaults.readThrows = null;
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_B);
    });

    it('stale staged S next to an unread W: createWallet neither adopts S nor generates', async () => {
        await plantLegacy(M_A);
        models.nativeItems.set(SLOT_A, { value: M_C, readBackSinceWrite: true }); // S
        models.expoFaults.readThrows = IOS_AUTH_FAILED;
        await expect(WalletCreationService.getInstance().createWallet()).rejects.toBeInstanceOf(UnidentifiedStoredKeyError);
        expect(models.kv.has(models.IDENTITY)).toBe(false);
        expect(nativeValues()).toEqual([M_C]);
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
    });

    it('adoptLegacy beside a stale S, then a confirmed import: S is never deleted unread (defect 2)', async () => {
        await installF14Wallet(M_A); // W, known (F14 cache)
        models.nativeItems.set(SLOT_A, { value: M_C, readBackSinceWrite: true }); // stale S
        expect(await readSeed()).toBe(M_A); // W carried over into slot B, v1 retired (read + matched)
        expect(models.nativeItems.get(SLOT_B)?.value).toBe(M_A);
        expect(models.expoItems.has(LEGACY)).toBe(false);

        models.newProcess();
        SeedManager.clearBiometricSession();
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_C);
        expect(await readSeed()).toBe(M_A);
    });

    it('a retirement whose item no longer reads as the replaced wallet keeps the item', async () => {
        await installMigratedWallet(M_A);
        // A replacement committed with the old slot pending retirement, then the old slot changed under it.
        models.kv.set(models.IDENTITY, JSON.stringify({ v: 1, slot: 'b', evm: evmAddress(M_B), sol: '', retireSlot: evmAddress(M_A) }));
        models.nativeItems.set(SLOT_B, { value: M_B, readBackSinceWrite: true });
        models.nativeItems.set(SLOT_A, { value: M_C, readBackSinceWrite: true });
        models.newProcess();
        expect(await readSeed()).toBe(M_B);
        expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_C);
        expect(JSON.parse(models.kv.get(models.IDENTITY)!).retireSlot).toBeUndefined();
    });

    it('MONITOR negative control: deleting an item this process never read IS reported', async () => {
        await plantLegacy(M_A);
        models.nativeItems.set(SLOT_A, { value: M_C, readBackSinceWrite: true });
        models.newProcess();
        await models.native.deleteItemAsync(SLOT_A);
        await models.expo.deleteItemAsync(LEGACY);
        expect(models.violations).toContain(`deleted ${SLOT_A} without reading it in this process`);
        expect(models.violations).toContain(`deleted ${LEGACY} without reading it in this process`);
        models.violations.length = 0;
    });
});

describe(' round 5 — Restore always works where it should: an unreadable F14 item exists, and a dead Android slot never blocks repair', () => {
    const M_C = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

    /** What ImportRecoveryPhraseScreen does: the same-wallet probe, then the gated restore. */
    async function phraseRestore(sm: SM, mnemonic: string): Promise<'gated'> {
        const sameWallet = (await sm.hasSeed()) && (await sm.seedMatches(mnemonic));
        expect(sameWallet).toBe(false); // nothing readable to compare against
        await expect(sm.importMnemonic(mnemonic)).rejects.toBeInstanceOf(OverwriteConfirmationRequired);
        await sm.importMnemonic(mnemonic, { force: true }); // the typed-phrase + biometric panel passed
        return 'gated';
    }

    function cloudDeps(sm: SM) {
        return {
            hasSeed: () => sm.hasSeed(),
            seedMatches: (m: string) => sm.seedMatches(m),
            importMnemonic: (m: string, o?: { force?: boolean }) => sm.importMnemonic(m, o),
            verifySeedReadable: () => sm.verifySeedReadable(),
        };
    }

    async function reinstalledWithAuthFailedW(): Promise<void> {
        await plantLegacy(M_A); // W: keychain survived the reinstall; AsyncStorage did not
        models.newProcess();
        models.expoFaults.readThrows = IOS_AUTH_FAILED; // e.g. a Face ID lockout — stays for the whole flow
    }

    it('reinstall + errSecAuthFailed F14 item: hasSeed() says a wallet exists (does not reject)', async () => {
        await reinstalledWithAuthFailedW();
        await expect(SeedManager.hasSeed()).resolves.toBe(true);
    });

    it('…phrase Restore of W succeeds end to end; the F14 item is KEPT', async () => {
        await reinstalledWithAuthFailedW();
        expect(await phraseRestore(SeedManager, M_A)).toBe('gated');
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_A);
        expect((await SeedManager.getEVMAddress()).toLowerCase()).toBe(evmAddress(M_A));
        expect(await SeedManager.isSeedUnreadable()).toBe(false);
    });

    it('…phrase Restore of a DIFFERENT wallet also succeeds and still keeps the unread F14 item', async () => {
        await reinstalledWithAuthFailedW();
        await phraseRestore(SeedManager, M_B);
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_B);
    });

    it('…cloud Restore of W succeeds end to end (through the overwrite panel); the F14 item is KEPT', async () => {
        await reinstalledWithAuthFailedW();
        await expect(applyCloudRecovery(M_A, cloudDeps(SeedManager))).rejects.toBeInstanceOf(OverwriteConfirmationRequired);
        const r = await applyCloudRecovery(M_A, cloudDeps(SeedManager), {
            typedPhrase: REQUIRED_CONFIRMATION_PHRASE,
            biometricSuccess: true,
        });
        expect(r).toEqual({ overwroteExistingWallet: true, alreadyPresent: false });
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_A);
    });

    it('a dismissed prompt during the existence check still rejects (transient — nothing decided)', async () => {
        await plantLegacy(M_A);
        models.newProcess();
        models.expoFaults.readThrows = IOS_CANCELLED;
        await expect(SeedManager.hasSeed()).rejects.toThrow(/canceled/);
    });

    it('a device with no item at all: hasSeed() is false (a clean null is the only "no")', async () => {
        await expect(SeedManager.hasSeed()).resolves.toBe(false);
    });

    /** Migrated wallet on slot A; A's Keystore key then invalidated; the same-wallet cloud Restore repairs it. */
    async function firstInvalidationAndRepair(): Promise<void> {
        await installMigratedWallet(M_A);
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        expect(await applyCloudRecovery(M_A, cloudDeps(SeedManager))).toEqual({ overwroteExistingWallet: false, alreadyPresent: true });
        expect(JSON.parse(models.kv.get(models.IDENTITY)!).slot).toBe('b');
    }

    it('double Android invalidation: the second Restore succeeds (the dead slot was removed on proof)', async () => {
        await firstInvalidationAndRepair();
        expect(models.nativeItems.has(SLOT_A)).toBe(false); // read UNRECOVERABLE + probe unrecoverable
        expect(models.unrecoverableDeletes).toEqual([SLOT_A]);

        models.newProcess();
        models.nativeFaults.unrecoverableKeys.add(SLOT_B); // the second invalidation
        SeedManager.clearBiometricSession();
        expect(await applyCloudRecovery(M_A, cloudDeps(SeedManager))).toEqual({ overwroteExistingWallet: false, alreadyPresent: true });
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_A);
        expect(models.unrecoverableDeletes).toEqual([SLOT_A, SLOT_B]);
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('already_migrated');
    });

    it('double invalidation where the first repair had to KEEP the dead slot: staging removes it on proof and succeeds', async () => {
        await installMigratedWallet(M_A);
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        models.nativeFaults.probeOverride.set(SLOT_A, 'unknown'); // no second signal at the first repair
        await applyCloudRecovery(M_A, cloudDeps(SeedManager));
        expect(models.nativeItems.has(SLOT_A)).toBe(true); // kept: one signal is not proof
        models.nativeFaults.probeOverride.clear();

        models.newProcess();
        models.nativeFaults.unrecoverableKeys.add(SLOT_B);
        SeedManager.clearBiometricSession();
        await applyCloudRecovery(M_A, cloudDeps(SeedManager));
        // A removed while staging (both signals), then B retired after the commit (both signals).
        expect(models.unrecoverableDeletes).toEqual([SLOT_A, SLOT_B]);
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_A);
    });

    /** Live slot B (readable), dead slot A kept from an earlier repair — the state a later import stages into. */
    async function deadSlotAKept(): Promise<void> {
        await installMigratedWallet(M_A);
        models.nativeItems.set(SLOT_B, { value: M_A, readBackSinceWrite: true });
        models.kv.set(models.IDENTITY, JSON.stringify({ v: 1, slot: 'b', evm: evmAddress(M_A), sol: '' }));
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        models.newProcess();
    }

    it('probe says unrecoverable but the read is only DISMISSED → the dead slot is kept, nothing changes', async () => {
        await deadSlotAKept();
        models.nativeFaults.cancelReads = 1; // the staging read of slot A
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toMatchObject({ code: 'ERR_SEED_AUTH_CANCELLED' });
        expect(models.nativeItems.has(SLOT_A)).toBe(true);
        expect(models.unrecoverableDeletes).toEqual([]);
        expect(await readSeed()).toBe(M_A);
    });

    it('the read says UNRECOVERABLE but the probe says present → kept; the import refuses', async () => {
        await deadSlotAKept();
        models.nativeFaults.probeOverride.set(SLOT_A, 'present');
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.has(SLOT_A)).toBe(true);
        expect(await readSeed()).toBe(M_A);
    });

    it('the probe cannot answer (unknown / error) → kept', async () => {
        await deadSlotAKept();
        models.nativeFaults.probeOverride.set(SLOT_A, 'unknown');
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.has(SLOT_A)).toBe(true);
    });

    it('the probe REJECTS → kept', async () => {
        await deadSlotAKept();
        models.nativeFaults.probeThrows.add(SLOT_A);
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.has(SLOT_A)).toBe(true);
    });

    it('a slot that READS (another wallet) is never removed on a probe claim alone', async () => {
        await deadSlotAKept();
        models.nativeFaults.unrecoverableKeys.delete(SLOT_A);
        models.nativeItems.set(SLOT_A, { value: M_C, readBackSinceWrite: true }); // a real, different wallet
        models.nativeFaults.probeOverride.set(SLOT_A, 'invalidated');
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_C);
    });

    it('iOS: both signals are never proof (a .userPresence item is not invalidated) → kept', async () => {
        await deadSlotAKept();
        models.platform.OS = 'ios';
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.has(SLOT_A)).toBe(true);
    });

    it('a dead slot holding nothing to lose is removed on proof, and an import over it then succeeds', async () => {
        await deadSlotAKept();
        await SeedManager.importMnemonic(M_C, { force: true });
        expect(models.unrecoverableDeletes).toEqual([SLOT_A]);
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_C);
    });

    it('MONITOR negative controls: an "unrecoverable" delete without both signals, or on iOS, IS reported', async () => {
        await deadSlotAKept();
        await models.native.getItemAsync(SLOT_A, 'p').catch(() => undefined); // read signal only
        await models.native.deleteItemAsync(SLOT_A);
        expect(models.violations).toEqual([`deleted ${SLOT_A} as unrecoverable without proof (both signals, Android, key really gone)`]);
        models.violations.length = 0;

        models.nativeItems.set(SLOT_A, { value: M_C, readBackSinceWrite: true });
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        models.newProcess();
        models.platform.OS = 'ios';
        await models.native.getItemAsync(SLOT_A, 'p').catch(() => undefined);
        await models.native.probeItemAsync(SLOT_A);
        await models.native.deleteItemAsync(SLOT_A);
        expect(models.violations).toEqual([`deleted ${SLOT_A} as unrecoverable without proof (both signals, Android, key really gone)`]);
        models.violations.length = 0;
        expect(models.unrecoverableDeletes).toEqual([]);
    });
});

describe(' round 6 — a Keystore key reported MISSING is never proof: only KeyPermanentlyInvalidatedException on both signals', () => {
    const M_C = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

    /** Live slot B (readable, this wallet); slot A holds another, healthy wallet key. */
    async function healthyOtherSlot(): Promise<void> {
        await installMigratedWallet(M_A);
        models.nativeItems.set(SLOT_B, { value: M_A, readBackSinceWrite: true });
        models.kv.set(models.IDENTITY, JSON.stringify({ v: 1, slot: 'b', evm: evmAddress(M_A), sol: '' }));
        models.nativeItems.set(SLOT_A, { value: M_C, readBackSinceWrite: true });
        models.newProcess();
    }

    for (const semantics of ['round1', 'current'] as const) {
        it(`a transient key-missing on BOTH the probe and the read keeps a healthy slot (native ${semantics})`, async () => {
            await healthyOtherSlot();
            models.nativeFaults.semantics = semantics;
            models.nativeFaults.probeKeyMissing.add(SLOT_A); // the keystore daemon hiccups for both lookups
            models.nativeFaults.readKeyMissing.add(SLOT_A);
            await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
            expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_C);
            expect(models.unrecoverableDeletes).toEqual([]);

            // The hiccup passes: the slot reads again, and nothing was lost.
            models.nativeFaults.probeKeyMissing.clear();
            models.nativeFaults.readKeyMissing.clear();
            expect(await models.native.getItemAsync(SLOT_A, 'p')).toBe(M_C);
        });
    }

    it("probe 'invalidated' + read UNRECOVERABLE [cause:invalidated] → removed, and the import succeeds", async () => {
        await healthyOtherSlot();
        models.nativeFaults.unrecoverableKeys.add(SLOT_A); // the lock screen was removed
        await SeedManager.importMnemonic(M_B, { force: true });
        expect(models.unrecoverableDeletes).toEqual([SLOT_A]);
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_B);
    });

    it("probe 'invalidated' + a transient (dismissed) read → kept", async () => {
        await healthyOtherSlot();
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        models.nativeFaults.cancelReads = 1; // the staging read of slot A
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toMatchObject({ code: 'ERR_SEED_AUTH_CANCELLED' });
        expect(models.nativeItems.has(SLOT_A)).toBe(true);
        expect(models.unrecoverableDeletes).toEqual([]);
    });

    it("probe 'invalidated' + a read that failed for ANOTHER cause (key missing) → kept", async () => {
        await healthyOtherSlot();
        models.nativeFaults.probeOverride.set(SLOT_A, 'invalidated');
        models.nativeFaults.readKeyMissing.add(SLOT_A);
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_C);
    });

    it("read [cause:invalidated] but the probe hits a transient key-missing ('unknown') → kept", async () => {
        await healthyOtherSlot();
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        models.nativeFaults.probeKeyMissing.add(SLOT_A);
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.has(SLOT_A)).toBe(true);
    });

    it("only the exact 'invalidated' probe verdict counts: 'unrecoverable' (an unparseable record) beside an invalidated read → kept", async () => {
        await healthyOtherSlot();
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        models.nativeFaults.probeOverride.set(SLOT_A, 'unrecoverable');
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.has(SLOT_A)).toBe(true);
    });

    it('an older native module (untagged, probe "unrecoverable") is never proof, even for a truly invalidated key', async () => {
        await healthyOtherSlot();
        models.nativeFaults.semantics = 'round1';
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toThrow(/could not be identified/);
        expect(models.nativeItems.has(SLOT_A)).toBe(true);
    });

    it('a retirement whose key lookup hiccups keeps the item AND the pending retirement; the next read retires it', async () => {
        await installMigratedWallet(M_A);
        models.nativeItems.set(SLOT_B, { value: M_B, readBackSinceWrite: true });
        models.kv.set(models.IDENTITY, JSON.stringify({ v: 1, slot: 'b', evm: evmAddress(M_B), sol: '', retireSlot: evmAddress(M_A) }));
        models.newProcess();
        models.nativeFaults.probeKeyMissing.add(SLOT_A);
        models.nativeFaults.readKeyMissing.add(SLOT_A);
        expect(await readSeed()).toBe(M_B);
        expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_A);
        expect(JSON.parse(models.kv.get(models.IDENTITY)!).retireSlot).toBe(evmAddress(M_A));

        models.nativeFaults.probeKeyMissing.clear();
        models.nativeFaults.readKeyMissing.clear();
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_B);
        expect(models.nativeItems.has(SLOT_A)).toBe(false); // read, matched the replaced wallet, retired
        expect(JSON.parse(models.kv.get(models.IDENTITY)!).retireSlot).toBeUndefined();
    });

    it('MONITOR negative control: deleting a slot whose key was only transiently missing IS reported', async () => {
        await healthyOtherSlot();
        models.nativeFaults.semantics = 'round1';
        models.nativeFaults.probeKeyMissing.add(SLOT_A);
        models.nativeFaults.readKeyMissing.add(SLOT_A);
        await models.native.getItemAsync(SLOT_A, 'p').catch(() => undefined);
        await models.native.probeItemAsync(SLOT_A);
        await models.native.deleteItemAsync(SLOT_A); // both "signals" seen, but the key was never gone
        expect(models.violations).toEqual([`deleted ${SLOT_A} as unrecoverable without proof (both signals, Android, key really gone)`]);
        models.violations.length = 0;
    });
});

describe(' round 2 — defect 2: unlock and cloud restore detect an unreadable seed for real', () => {
    it('a migrated wallet whose Keystore key was invalidated is reported unreadable at unlock (routes to restore)', async () => {
        await installMigratedWallet(M_A);
        models.nativeFaults.unrecoverableKeys.add(SLOT_A); // lock screen removed, PIN re-added
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('unreadable');
        expect(await SeedManager.isSeedUnreadable()).toBe(true);
        expect(models.nativeItems.has(SLOT_A)).toBe(true); // nothing deleted
    });

    it('a migrated wallet whose seed item vanished is reported unreadable at unlock', async () => {
        await installMigratedWallet(M_A);
        models.nativeItems.delete(SLOT_A);
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('unreadable');
    });

    it('a dismissed prompt during the unlock check is NOT unreadable (deferred, no flag)', async () => {
        await installMigratedWallet(M_A);
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        models.nativeFaults.cancelReads = 1; // the verifying read is dismissed
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('deferred');
        expect(models.kv.has(UNREADABLE)).toBe(false);
    });

    it('cloud restore of the same wallet REPAIRS an invalidated key even when no read has failed yet', async () => {
        await installMigratedWallet(M_A);
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        expect(models.kv.has(UNREADABLE)).toBe(false); // no earlier read marked it

        const r = await applyCloudRecovery(M_A, {
            hasSeed: () => SeedManager.hasSeed(),
            seedMatches: (m) => SeedManager.seedMatches(m),
            importMnemonic: (m, o) => SeedManager.importMnemonic(m, o),
            verifySeedReadable: () => SeedManager.verifySeedReadable(),
        });

        expect(r).toEqual({ overwroteExistingWallet: false, alreadyPresent: true });
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_A);
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('already_migrated');
    });

    it('cloud restore of a same, READABLE wallet stays a no-op; a dismissed check prompt aborts without writing', async () => {
        await installMigratedWallet(M_A);
        const deps = {
            hasSeed: () => SeedManager.hasSeed(),
            seedMatches: (m: string) => SeedManager.seedMatches(m),
            importMnemonic: vi.fn((m: string, o?: { force?: boolean }) => SeedManager.importMnemonic(m, o)),
            verifySeedReadable: () => SeedManager.verifySeedReadable(),
        };
        expect(await applyCloudRecovery(M_A, deps)).toEqual({ overwroteExistingWallet: false, alreadyPresent: true });
        expect(deps.importMnemonic).not.toHaveBeenCalled();

        models.nativeFaults.cancelReads = 1;
        await expect(applyCloudRecovery(M_A, deps)).rejects.toMatchObject({ code: 'ERR_SEED_AUTH_CANCELLED' });
        expect(deps.importMnemonic).not.toHaveBeenCalled();
    });

    it('iOS: an F14 item answering errSecAuthFailed (biometry set changed) routes to restore; nothing is deleted', async () => {
        await installF14Wallet(M_A);
        models.expoFaults.readThrows = IOS_AUTH_FAILED;
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('unreadable');
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        models.expoFaults.readThrows = null;

        // …and the restore of the same wallet repairs it (the legacy item goes only after the new copy reads back).
        await applyCloudRecovery(M_A, {
            hasSeed: () => SeedManager.hasSeed(),
            seedMatches: (m) => SeedManager.seedMatches(m),
            importMnemonic: (m, o) => SeedManager.importMnemonic(m, o),
            verifySeedReadable: async () => 'unreadable' as const,
        });
        expect(await readSeed()).toBe(M_A);
    });

    it('iOS: a DISMISSED F14 prompt (errSecUserCanceled) is transient — deferred, not unreadable', async () => {
        await installF14Wallet(M_A);
        models.expoFaults.readThrows = IOS_CANCELLED;
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('deferred');
        expect(models.kv.has(UNREADABLE)).toBe(false);
    });
});

describe(' round 2 — defect 3: the live seed is never overwritten in place', () => {
    it('a confirmed import over a MIGRATED wallet whose read-back is dismissed leaves the old seed live', async () => {
        await installMigratedWallet(M_A);
        models.nativeFaults.cancelReads = 1; // the new value's read-back prompt is dismissed
        const err = await SeedManager.importMnemonic(M_B, { force: true }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SeedWriteVerificationError);
        expect((err as Error).message).toMatch(/existing wallet key, if any, was not changed/);
        SeedManager.clearBiometricSession();
        expect(await readSeed()).toBe(M_A);
        expect((await SeedManager.getEVMAddress()).toLowerCase()).toBe(evmAddress(M_A));
        expect(nativeValues()).toEqual([M_A]);
    });

    it('a confirmed import over a MIGRATED wallet, once verified, retires the old slot', async () => {
        await installMigratedWallet(M_A);
        models.replacement.authorized = M_A;
        await SeedManager.importMnemonic(M_B, { force: true });
        expect(nativeValues()).toEqual([M_B]);
        expect(await readSeed()).toBe(M_B);
        // and the next replacement goes back to the first slot — never over the live one
        await SeedManager.importMnemonic(M_A, { force: true });
        expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_A);
        expect(models.nativeItems.has(SLOT_B)).toBe(false);
    });
});

describe('the legacy item is removed only after the native copy reads back verified', () => {
    it('read-back MISMATCH → legacy retained, nothing committed, seed still served from legacy', async () => {
        await installF14Wallet(M_A);
        models.nativeFaults.readOverride = M_B;

        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('deferred');
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        expect(models.kv.has(models.IDENTITY)).toBe(false);
        expect(models.nativeItems.size).toBe(0); // the unverified staging copy was removed
        expect(await readSeed()).toBe(M_A); // this read retries the move — and now it verifies
        expect(models.expoItems.has(LEGACY)).toBe(false);
    });

    it('read-back bytes differ but derive the SAME wallet (NFKD twin) → still not proof; legacy retained', async () => {
        await installF14Wallet(M_A);
        // U+FF41 FULLWIDTH 'a' normalises (NFKD) to 'a': same BIP-39 seed, same address, different bytes.
        // Only the byte-for-byte comparison can catch this; the address check alone cannot.
        models.nativeFaults.readOverride = 'ａ' + M_A.slice(1);
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('deferred');
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        expect(models.kv.has(models.IDENTITY)).toBe(false);
    });

    it('native WRITE fails → legacy retained; retried and completed next time', async () => {
        await installF14Wallet(M_A);
        models.nativeFaults.writeThrows = true;
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('deferred');
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);

        models.nativeFaults.writeThrows = false;
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('migrated');
        expect(models.expoItems.has(LEGACY)).toBe(false);
    });

    it('read-back prompt DISMISSED → legacy retained; nothing committed', async () => {
        await installF14Wallet(M_A);
        models.nativeFaults.cancelReads = 1;
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('deferred');
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        expect(models.kv.has(models.IDENTITY)).toBe(false);
    });

    it('the legacy delete fails after the native copy is committed → it is retried on the next verified read', async () => {
        await installF14Wallet(M_A);
        models.expoFaults.deleteThrowsOnce = true;
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('migrated');
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);

        expect(await readSeed()).toBe(M_A);
        expect(models.expoItems.has(LEGACY)).toBe(false);
    });

    it('legacy seed that is NOT this wallet (cache says otherwise) → never migrated, never deleted', async () => {
        await models.expo.setItemAsync(LEGACY, M_B, { requireAuthentication: true });
        await SeedManager.cachePublicAddresses(M_A);
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('unreadable');
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_B);
        expect(models.nativeItems.size).toBe(0);
    });

    it('a live slot holding another wallet is never used; the retained legacy copy is, and is re-copied', async () => {
        await installF14Wallet(M_A);
        models.expoFaults.deleteThrowsOnce = true; // keep legacy around after committing the native copy
        await SeedManager.migrateSeedStorageIfNeeded();
        models.nativeItems.set(SLOT_A, { value: M_B, readBackSinceWrite: true }); // foreign value in the live slot
        expect(await readSeed()).toBe(M_A);
        expect(models.nativeItems.get(SLOT_B)?.value).toBe(M_A); // re-copied, verified, committed
        expect(models.nativeItems.get(SLOT_A)?.value).toBe(M_B); // the foreign value is not destroyed by a read
    });

    it('live slot unreadable + the other slot holding ANOTHER wallet (a replaced one) → SeedUnreadable, never that seed', async () => {
        await installMigratedWallet(M_A);
        models.nativeItems.set(SLOT_B, { value: M_B, readBackSinceWrite: true }); // e.g. a replaced wallet not yet retired
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        await expect(readSeed()).rejects.toBeInstanceOf(SeedUnreadableError);
        expect(models.nativeItems.get(SLOT_B)?.value).toBe(M_B); // and nothing was destroyed by the read
    });

    it('live slot unreadable + the other slot holding THIS wallet → served from it, identity re-pointed', async () => {
        await installMigratedWallet(M_A);
        models.nativeItems.set(SLOT_B, { value: M_A, readBackSinceWrite: true });
        models.nativeFaults.unrecoverableKeys.add(SLOT_A);
        expect(await readSeed()).toBe(M_A);
        expect(JSON.parse(models.kv.get(models.IDENTITY)!).slot).toBe('b');
        expect(await SeedManager.migrateSeedStorageIfNeeded()).toBe('already_migrated');
    });

    it('a live slot holding another wallet, with no other copy → SeedUnreadable, never the foreign seed', async () => {
        await installMigratedWallet(M_A);
        models.nativeItems.set(SLOT_A, { value: M_B, readBackSinceWrite: true });
        await expect(readSeed()).rejects.toBeInstanceOf(SeedUnreadableError);
    });

    it('MONITOR negative controls: each monitor reports its violation', async () => {
        await installF14Wallet(M_A);
        await models.expo.deleteItemAsync(LEGACY); // unverified legacy delete
        expect(models.violations).toContain('legacy deleted without a verified native copy of the same value');
        models.violations.length = 0;

        await models.native.setItemAsync(SLOT_A, M_A, 'p');
        await models.native.setItemAsync(SLOT_A, M_B, 'p'); // overwrite in place
        expect(models.violations).toEqual([`in-place overwrite of native item ${SLOT_A}`]);
        models.violations.length = 0;

        models.kv.set(models.IDENTITY, JSON.stringify({ v: 1, slot: 'a', evm: evmAddress(M_B), sol: '' }));
        await models.native.deleteItemAsync(SLOT_A); // the live slot
        expect(models.violations).toEqual([`deleted the live seed slot ${SLOT_A}`]);
        models.violations.length = 0; // consumed; afterEach checks the rest of the file stays clean
    });

    it('CRASH-SWEEP negative control: a store that commits before its read-back IS caught', async () => {
        // A deliberately broken store: identity committed first, value written after (the defect class).
        const broken = async (sm: SM) => {
            await models.asyncStorage.setItem(models.IDENTITY, JSON.stringify({ v: 1, slot: 'b', evm: evmAddress(M_B), sol: '' }));
            await models.native.setItemAsync(SLOT_B, M_B, 'p');
            void sm;
        };
        await expect(
            crashSweep(async (sm) => { await installMigratedWallet(M_A, sm); }, broken, async (sm) => { await expectShownIsStored(sm, [M_A, M_B]); }),
        ).rejects.toThrow(/kill point 2/);
        models.violations.length = 0;
    });
});

describe('new wallets: nothing is a wallet until it reads back', () => {
    it('generate() with a read-back mismatch throws and leaves NO wallet (retry is clean)', async () => {
        models.nativeFaults.readOverride = M_B;
        await expect(SeedManager.generate()).rejects.toBeInstanceOf(SeedWriteVerificationError);
        expect(models.nativeItems.size).toBe(0);
        expect(await SeedManager.hasSeed()).toBe(false);

        const mnemonic = await SeedManager.generate();
        expect(await readSeed()).toBe(mnemonic);
    });

    it('importMnemonic(force) whose read-back fails leaves the OLD (F14) wallet intact and served', async () => {
        await installF14Wallet(M_A);
        models.nativeFaults.cancelReads = 1;
        await expect(SeedManager.importMnemonic(M_B, { force: true })).rejects.toBeInstanceOf(SeedWriteVerificationError);
        expect(models.expoItems.get(LEGACY)?.value).toBe(M_A);
        expect(await readSeed()).toBe(M_A); // (and this read carries A over, verified)
    });

    it('importMnemonic(force) over an F14 wallet retires the legacy item only after the new seed reads back', async () => {
        await installF14Wallet(M_A);
        models.replacement.authorized = M_A; // the user passed the overwrite gate for wallet A
        await SeedManager.importMnemonic(M_B, { force: true });
        expect(models.expoItems.has(LEGACY)).toBe(false);
        expect(await readSeed()).toBe(M_B);
        expect((await SeedManager.getEVMAddress()).toLowerCase()).toBe(evmAddress(M_B));
    });

    it('deleteAll() (explicit wipe) clears every item and the bookkeeping', async () => {
        await installF14Wallet(M_A);
        models.expoFaults.deleteThrowsOnce = true;
        await SeedManager.migrateSeedStorageIfNeeded(); // native copy committed, legacy still present
        models.flags.clearing = true; // the user's explicit, confirmed destruction of the wallet
        await SeedManager.deleteAll();
        models.flags.clearing = false;
        expect(models.nativeItems.size).toBe(0);
        expect(models.expoItems.has(LEGACY)).toBe(false);
        expect(await SeedManager.hasSeed()).toBe(false);
    });
});

describe('PECloudSync archive-key cache (same move, same proof)', () => {
    const KEYS = { legacy: 'provian_pe_archive_key', current: 'provian_pe_archive_key_v2' };
    const deps = () => ({ native: () => models.native, legacy: models.expo });
    const value = JSON.stringify({ salt: 'aa', key: 'bb' });

    it('migrates a valid legacy copy: write → read back equal → only then delete', async () => {
        await models.expo.setItemAsync(KEYS.legacy, value, { requireAuthentication: true });
        expect(await seedStore.readGatedSecret(deps(), KEYS, 'p', () => true)).toBe(value);
        expect(models.nativeItems.get(KEYS.current)?.value).toBe(value);
        expect(models.expoItems.has(KEYS.legacy)).toBe(false);
    });

    it('read-back mismatch → legacy copy retained', async () => {
        await models.expo.setItemAsync(KEYS.legacy, value, { requireAuthentication: true });
        models.nativeFaults.readOverride = 'x';
        // The prefer-current read finds no native item (override untouched); the override hits the read-back.
        expect(await seedStore.readGatedSecret(deps(), KEYS, 'p', () => true)).toBe(value);
        expect(models.expoItems.get(KEYS.legacy)?.value).toBe(value);
    });

    it('an invalidated legacy copy (re-enrolled) is a cache miss, not a deletion', async () => {
        await models.expo.setItemAsync(KEYS.legacy, value, { requireAuthentication: true });
        models.reenroll();
        expect(await seedStore.readGatedSecret(deps(), KEYS, 'p', () => true)).toBeNull();
        expect(models.expoItems.has(KEYS.legacy)).toBe(true);
    });

    it('replacing a stale native copy deletes then adds (never an in-place overwrite)', async () => {
        await seedStore.writeGatedSecret(deps(), KEYS, 'old', 'p');
        await seedStore.writeGatedSecret(deps(), KEYS, value, 'p');
        expect(models.nativeItems.get(KEYS.current)?.value).toBe(value);
    });
});

describe('build without the native store keeps the previous behaviour', () => {
    it('falls back to the F14 expo item (no silent loss, no native writes)', async () => {
        models.nativeEnabled.value = false;
        const mnemonic = await SeedManager.generate();
        expect(models.expoItems.get(LEGACY)?.value).toBe(mnemonic);
        expect(models.nativeItems.size).toBe(0);
        expect(await readSeed()).toBe(mnemonic);
    });
});

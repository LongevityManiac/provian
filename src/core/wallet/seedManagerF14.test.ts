/**
 * [F14] The BIP-39 seed must be stored behind an OS presence gate
 * (`requireAuthentication: true`), and public-address reads must NOT trip that
 * gate — they read a persisted AsyncStorage cache instead.
 *
 * Before F14 the mnemonic was written with no `requireAuthentication` ACL, so
 * "the seed is biometric-gated" was aspirational: a JS bug or a removed session
 * check could read the seed with no OS prompt. Adding the ACL makes the gate
 * hardware-enforced — but a naive add would make `getEVMAddress()` (called all
 * over the UI for a *public* address) prompt for biometrics on every render. The
 * fix caches the derived public addresses in AsyncStorage at write time and reads
 * them from there, never touching the auth-gated seed for public material.
 *
 * SeedManager imports cleanly under vitest (pure @scure/@noble crypto), so this
 * drives the real methods. The RED for the cache-first claim is its opposite: a
 * cache MISS provably DOES fall back to the (unprompted-for-legacy) seed read, so
 * "cache hit skips the seed" is a real discrimination, not a vacuous pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn().mockResolvedValue(undefined),
    deleteItemAsync: vi.fn().mockResolvedValue(undefined),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

// AsyncStorage backed by a real in-memory store so multiSet/getItem interoperate.
const store: Record<string, string> = {};
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => (k in store ? store[k] : null)),
        setItem: vi.fn(async (k: string, v: string) => { store[k] = v; }),
        removeItem: vi.fn(async (k: string) => { delete store[k]; }),
        multiSet: vi.fn(async (pairs: [string, string][]) => { for (const [k, v] of pairs) store[k] = v; }),
        multiRemove: vi.fn(async (keys: string[]) => { for (const k of keys) delete store[k]; }),
    },
}));

vi.mock('../security/requireBiometric', () => ({ requireBiometric: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../security/securityLogger', () => ({ default: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import SeedManager from './SeedManager';
import * as SecureStore from 'expo-secure-store';

const EVM_CACHE_KEY = 'provian_public_evm_address';
const SOLANA_CACHE_KEY = 'provian_public_solana_address';
// A canonical, checksum-valid BIP-39 test mnemonic (never a real wallet).
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

function clearStore() { for (const k of Object.keys(store)) delete store[k]; }

describe('[F14] seed is written behind requireAuthentication and caches public addresses', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearStore();
    });

    it('generate() stores the mnemonic with requireAuthentication:true (device-only) and caches both addresses', async () => {
        await SeedManager.generate();

        // The mnemonic write carries the OS presence ACL.
        const mnemonicWrite = (SecureStore.setItemAsync as unknown as { mock: { calls: unknown[][] } })
            .mock.calls.find((c) => (c[2] as { requireAuthentication?: boolean } | undefined)?.requireAuthentication === true);
        expect(mnemonicWrite).toBeDefined();
        expect((mnemonicWrite![2] as { keychainAccessible?: string }).keychainAccessible)
            .toBe('WHEN_UNLOCKED_THIS_DEVICE_ONLY');

        // Public addresses were derived and cached at write time (so reads never
        // need the seed).
        expect(store[EVM_CACHE_KEY]).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(typeof store[SOLANA_CACHE_KEY]).toBe('string');
        expect(store[SOLANA_CACHE_KEY].length).toBeGreaterThan(0);
    });

    it('importMnemonic() also writes the seed with requireAuthentication:true', async () => {
        await SeedManager.importMnemonic(TEST_MNEMONIC, { force: true });
        const authWrite = (SecureStore.setItemAsync as unknown as { mock: { calls: unknown[][] } })
            .mock.calls.some((c) => (c[2] as { requireAuthentication?: boolean } | undefined)?.requireAuthentication === true);
        expect(authWrite).toBe(true);
    });

    it('getEVMAddress() returns the CACHED address without ever reading the auth-gated seed', async () => {
        store[EVM_CACHE_KEY] = '0x00000000000000000000000000000000deadbeef';
        const addr = await SeedManager.getEVMAddress();
        expect(addr).toBe('0x00000000000000000000000000000000deadbeef');
        // The whole point of F14: a public read does NOT touch SecureStore, so the
        // requireAuthentication ACL is never tripped for a public address.
        expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    });

    it('getSolanaAddress() is cache-first too — no seed read on a cache hit', async () => {
        store[SOLANA_CACHE_KEY] = 'SoLanaCachedAddr1111111111111111111111111111';
        const addr = await SeedManager.getSolanaAddress();
        expect(addr).toBe('SoLanaCachedAddr1111111111111111111111111111');
        expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    });

    it('RED — on a cache MISS getEVMAddress DOES fall back to the seed read (proves the cache-hit skip is real)', async () => {
        clearStore(); // no cached address
        (SecureStore.getItemAsync as unknown as { mockResolvedValue: (v: string) => void })
            .mockResolvedValue(TEST_MNEMONIC);
        const addr = await SeedManager.withBiometricAction('address cache miss', action => SeedManager.getEVMAddress(action));
        // Real derivation ran off the seed …
        expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
        // … which required reading the (auth-gated) seed — the exact path the cache
        // hit avoids. If this were also zero-reads, the cache-hit assertions above
        // would be vacuous.
        expect(SecureStore.getItemAsync).toHaveBeenCalled();
        // And the derived address is backfilled into the cache for next time.
        expect(store[EVM_CACHE_KEY]).toBe(addr);
    });
});

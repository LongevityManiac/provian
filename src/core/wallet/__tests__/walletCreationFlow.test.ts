/**
 * Wallet creation + cloud backup integration tests
 *
 * Covers the BIP-39 EOA wallet flow:
 *   - WalletCreationService.createWallet() generates a mnemonic
 *   - The stored wallet address matches the seed-derived EVM address
 *   - TransactionService.sendETH signs from the same seed-derived key
 *   - CloudBackupV2 encrypts the mnemonic with a PIN, decrypts it back
 *   - After wipe + restore the wallet address is the same
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory mocks for SecureStore + AsyncStorage so the BIP-39 store layer
// behaves like a real device without touching native code.
// ─────────────────────────────────────────────────────────────────────────────

const secureStoreBacking = new Map<string, string>();
const asyncStorageBacking = new Map<string, string>();

vi.mock('expo-secure-store', () => {
    return {
        WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
        getItemAsync: vi.fn(async (key: string) => secureStoreBacking.get(key) ?? null),
        setItemAsync: vi.fn(async (key: string, value: string) => {
            secureStoreBacking.set(key, value);
        }),
        deleteItemAsync: vi.fn(async (key: string) => {
            secureStoreBacking.delete(key);
        }),
    };
});

vi.mock('@react-native-async-storage/async-storage', () => {
    return {
        default: {
            getItem: vi.fn(async (key: string) => asyncStorageBacking.get(key) ?? null),
            setItem: vi.fn(async (key: string, value: string) => {
                asyncStorageBacking.set(key, value);
            }),
            removeItem: vi.fn(async (key: string) => {
                asyncStorageBacking.delete(key);
            }),
            multiSet: vi.fn(async (pairs: [string, string][]) => {
                for (const [k, v] of pairs) asyncStorageBacking.set(k, v);
            }),
            multiRemove: vi.fn(async (keys: string[]) => {
                for (const k of keys) asyncStorageBacking.delete(k);
            }),
        },
    };
});

// KeyManager performs device attestation - only the tier matters here.
vi.mock('../../security/KeyManager', () => ({
    default: {
        getKeyAttestation: vi.fn(async () => ({ tier: 'software', platform: 'ios' })),
    },
}));

// securityLogger is a side-effect logger; the wallet creation tests don't care.
vi.mock('../../security/securityLogger', () => ({
    default: { log: vi.fn(), error: vi.fn() },
}));

// AppModeManager - TransactionService.sendETH guards on this.
vi.mock('../../AppModeManager', () => ({
    assertWalletEnabled: vi.fn(),
}));

// EVM chain config - we only need the Base mainnet chain entry for the
// provider-resolution path. The provider itself is mocked below.
vi.mock('../../chains/evm/config', () => ({
    ALL_CHAINS: [
        {
            chainId: 8453,
            name: 'Base',
            shortName: 'base',
            symbol: 'ETH',
            decimals: 18,
            rpcUrl: 'https://mainnet.base.org',
            explorerUrl: 'https://basescan.org',
            isTestnet: false,
        },
    ],
}));

import { ActionWallet } from '../../security/ActionWallet';
import SeedManager from '../SeedManager';
import WalletCreationService from '../WalletCreationService';
import TransactionService from '../TransactionService';
import * as CloudBackupV2 from '../../recovery/cloud/CloudBackupV2';

// ─────────────────────────────────────────────────────────────────────────────
// Cloud keychain native sync is a native module - give it a JS-only fake that
// behaves like a key/value store backed by Map.
// ─────────────────────────────────────────────────────────────────────────────

const cloudBacking = new Map<string, string>();
vi.mock('../../recovery/cloud/ProvianCloudKeychainSync', () => ({
    storeSynced: vi.fn(async (key: string, value: string) => {
        cloudBacking.set(key, value);
    }),
    retrieveSynced: vi.fn(async (key: string) => cloudBacking.get(key) ?? null),
    deleteSynced: vi.fn(async (key: string) => {
        cloudBacking.delete(key);
    }),
    verifySync: vi.fn(async () => true),
    isCloudKeychainAvailable: vi.fn(() => true),
}));

// React Native's Platform module: CloudBackupV2 reads it as 'ios'.
// [Drift D fix] Preserve TurboModuleRegistry and NativeModules from the
// global stub so transitive expo-modules-core loads do not fail at the
// requireNativeModule step (ExpoModulesCoreJSLogger and similar).
vi.mock('react-native', () => ({
    AppState: { currentState: 'active', addEventListener: vi.fn() },
    Platform: { OS: 'ios' },
    NativeModules: {},
    TurboModuleRegistry: {
        getEnforcing: (_name: string) => ({}),
        get: (_name: string) => ({}),
    },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

function resetAllStorage(): void {
    secureStoreBacking.clear();
    asyncStorageBacking.clear();
    cloudBacking.clear();
}

describe('WalletCreationService - BIP-39 EOA flow', () => {
    beforeEach(() => {
        resetAllStorage();
    });

    it('createWallet generates a mnemonic and stores the seed-derived EVM address', async () => {
        const service = WalletCreationService.getInstance();

        // Pre-condition: nothing stored yet
        expect(await SeedManager.hasSeed()).toBe(false);
        expect(await service.hasWallet()).toBe(false);

        // Create wallet
        const result = await service.createWallet();

        // Post-condition: a mnemonic now exists in SecureStore.
        // [Drift D fix] getMnemonic gates on a valid biometric session
        // (chunk-B M-2). The expo-local-authentication test stub resolves
        // authenticateAsync with success: true, so this proceeds.
        const storedMnemonic = await SeedManager.withBiometricAction('test: read mnemonic', action => SeedManager.getMnemonic(action));
        expect(storedMnemonic).not.toBeNull();
        expect(storedMnemonic!.split(' ').length).toBe(12);

        // The wallet address must match the BIP-44 m/44'/60'/0'/0/0 derivation.
        // getEVMKey() is gated by the biometric session established above.
        const derived = await SeedManager.withBiometricAction('derive key', action => SeedManager.getEVMKey(action));
        expect(result.walletAddress.toLowerCase()).toBe(derived.address.toLowerCase());
        derived.privateKey.fill(0);

        // Stored state matches return value
        const stored = await service.getStoredWallet();
        expect(stored).not.toBeNull();
        expect(stored!.walletAddress).toBe(result.walletAddress);
        expect(stored!.keySource).toBe('bip39_seed');

        // Attestation tier comes from KeyManager.getKeyAttestation (mocked → 'software')
        expect(result.attestationTier).toBe('software');
    });

    it('refuses to create a second wallet when one already exists', async () => {
        const service = WalletCreationService.getInstance();
        await service.createWallet();

        await expect(service.createWallet()).rejects.toThrow(/already exists/i);
    });

    it('deleteWallet wipes both the seed and the AsyncStorage state', async () => {
        const service = WalletCreationService.getInstance();
        await service.createWallet();
        expect(await SeedManager.hasSeed()).toBe(true);
        expect(await service.getWalletAddress()).not.toBeNull();

        await service.deleteWallet();

        expect(await SeedManager.hasSeed()).toBe(false);
        expect(await service.getWalletAddress()).toBeNull();
    });
});

describe('TransactionService - signs from the seed-derived key', () => {
    beforeEach(() => {
        resetAllStorage();
        vi.restoreAllMocks();
    });

    it('sendETH signs with the BIP-44 EVM key and broadcasts the resulting transaction', async () => {
        // Set up a fresh wallet
        await WalletCreationService.getInstance().createWallet();
        const expectedAddress = await WalletCreationService.getInstance().getWalletAddress();
        expect(expectedAddress).not.toBeNull();

        // Mock the underlying ethers JsonRpcProvider so no network call is made.
        let capturedFromAddress: string | null = null;
        const fakeReceipt = { status: 1, blockNumber: 100 };
        const fakeTxResponse = {
            hash: '0xdeadbeef',
            wait: vi.fn(async () => fakeReceipt),
        };

        const sendTransactionSpy = vi
            .spyOn(ActionWallet.prototype, 'sendTransaction')
            .mockImplementation(async function (this: ethers.Wallet, _tx) {
                // `this.address` is the seed-derived EOA - capture it for the assertion below.
                capturedFromAddress = this.address;
                return fakeTxResponse as unknown as ethers.TransactionResponse;
            });

        try {
            const result = await TransactionService.sendETH({
                to: '0x000000000000000000000000000000000000dEaD',
                amount: '0.001',
                chainId: 8453,
            });

            expect(result.txHash).toBe('0xdeadbeef');
            expect(sendTransactionSpy).toHaveBeenCalledTimes(1);

            // The signing key must be the BIP-44 derivation, not some random key.
            expect(capturedFromAddress!.toLowerCase()).toBe(expectedAddress!.toLowerCase());
        } finally {
            sendTransactionSpy.mockRestore();
        }
    });
});

describe('CloudBackupV2 - encrypted mnemonic round-trip', () => {
    beforeEach(() => {
        resetAllStorage();
    });

    it('encrypts the mnemonic with the PIN and decrypts it back to the same value', async () => {
        await WalletCreationService.getInstance().createWallet();
        const originalMnemonic = await SeedManager.withBiometricAction('read phrase', action => SeedManager.getMnemonic(action));
        const originalAddress = await WalletCreationService.getInstance().getWalletAddress();
        expect(originalMnemonic).not.toBeNull();
        expect(originalAddress).not.toBeNull();

        const PIN = 'correct horse battery';
        await CloudBackupV2.createCloudBackup(PIN);

        // The cloud blob stores ciphertext, never plaintext.
        const ciphertextBlob = Array.from(cloudBacking.values())[0];
        expect(ciphertextBlob).toBeDefined();
        expect(ciphertextBlob).not.toContain(originalMnemonic);

        // Decrypt with the right PIN - payload includes the mnemonic
        const decrypted = await CloudBackupV2.retrieveCloudBackup(PIN);
        expect(decrypted).not.toBeNull();
        expect(decrypted!.mnemonic).toBe(originalMnemonic);
        expect(decrypted!.wallet_address.toLowerCase()).toBe(originalAddress!.toLowerCase());

        // Wrong PIN → decryption throws (GCM auth tag mismatch)
        await expect(CloudBackupV2.retrieveCloudBackup('wrong-pin-xyz'))
            .rejects.toThrow();
    });

    it('round-trips wallet across wipe + restore via cloud blob', async () => {
        // 1. Initial wallet
        await WalletCreationService.getInstance().createWallet();
        const initialMnemonic = await SeedManager.withBiometricAction('read phrase', action => SeedManager.getMnemonic(action));
        const initialAddress = await WalletCreationService.getInstance().getWalletAddress();
        expect(initialMnemonic).not.toBeNull();
        expect(initialAddress).not.toBeNull();

        // 2. Backup to cloud
        const PIN = '123456';
        await CloudBackupV2.createCloudBackup(PIN);

        // 3. Wipe the device - but leave the cloud blob intact (simulate new device)
        secureStoreBacking.clear();
        asyncStorageBacking.clear();
        // cloudBacking intentionally NOT cleared - that's iCloud Keychain on iOS / Google Drive encrypted app folder on Android.

        expect(await SeedManager.hasSeed()).toBe(false);
        expect(await WalletCreationService.getInstance().getWalletAddress()).toBeNull();

        // 4. Restore from cloud
        const recovered = await CloudBackupV2.retrieveCloudBackup(PIN);
        expect(recovered).not.toBeNull();
        await SeedManager.importMnemonic(recovered!.mnemonic);

        const restoredAddress = await SeedManager.getEVMAddress();

        // 5. Same wallet address as before - round-trip preserves identity
        expect(restoredAddress.toLowerCase()).toBe(initialAddress!.toLowerCase());

        // 6. Mnemonic is byte-identical
        expect(await SeedManager.withBiometricAction('read phrase', action => SeedManager.getMnemonic(action))).toBe(initialMnemonic);
    });
});

describe('SeedManager - biometric gating of key material (audit 2026-06-10)', () => {
    beforeEach(() => {
        resetAllStorage();
        SeedManager.clearBiometricSession();
    });

    it('getEVMKey and getEVMPrivateKey throw without a biometric session', async () => {
        await WalletCreationService.getInstance().createWallet();
        SeedManager.clearBiometricSession();

        await expect(SeedManager.getEVMKey()).rejects.toThrow(/biometric action/i);
        await expect(SeedManager.getEVMPrivateKey()).rejects.toThrow(/biometric action/i);
        await expect(SeedManager.getMnemonic()).rejects.toThrow(/biometric action/i);
    });

    it('getEVMAddress works without a session and returns public material only', async () => {
        const result = await WalletCreationService.getInstance().createWallet();
        SeedManager.clearBiometricSession();

        const address = await SeedManager.getEVMAddress();
        expect(address.toLowerCase()).toBe(result.walletAddress.toLowerCase());
    });

    it('getEVMKey returns key material once a session is established', async () => {
        await WalletCreationService.getInstance().createWallet();
        const key = await SeedManager.withBiometricAction('test: derive key', action => SeedManager.getEVMKey(action));
        expect(key.privateKeyHex).toMatch(/^[0-9a-f]{64}$/);
        expect(key.address).toMatch(/^0x[0-9a-f]{40}$/i);
        key.privateKey.fill(0);
    });
});

/**
 * SeedManager.importMnemonic - overwrite-confirmation guard.
 *
 * B-1 sibling fix (2026-05-12). The CloudRecoveryScreen path was closed
 * in commit 09804c8 via applyCloudRecovery, but ImportRecoveryPhraseScreen
 * called SeedManager.importMnemonic directly with no hasSeed() check,
 * meaning a returning user with a funded wallet who typed any valid
 * BIP-39 phrase silently overwrote their seed. The guard now lives at
 * the SeedManager layer so every caller - current and future - inherits
 * it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory SecureStore so we don't touch native code.
const secureStoreBacking = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    getItemAsync: vi.fn(async (key: string) => secureStoreBacking.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
        secureStoreBacking.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
        secureStoreBacking.delete(key);
    }),
}));

vi.mock('../../security/requireBiometric', () => ({
    requireBiometric: vi.fn(async () => undefined),
}));

vi.mock('../../security/securityLogger', () => ({
    default: { log: vi.fn() },
}));

// Two distinct, real BIP-39 mnemonics with valid checksums. We import
// MNEMONIC_A first, then attempt to overwrite with MNEMONIC_B to assert
// the guard fires only on the second write.
const MNEMONIC_A =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_B =
    'legal winner thank year wave sausage worth useful legal winner thank yellow';
const INVALID_MNEMONIC = 'not a valid bip39 seed at all please reject me thanks bye';

const MNEMONIC_KEY = 'provian_bip39_mnemonic';

describe('SeedManager.importMnemonic - overwrite guard', () => {
    beforeEach(() => {
        secureStoreBacking.clear();
        vi.resetModules();
    });

    it('imports successfully on a fresh device (no existing seed)', async () => {
        const { default: SeedManager } = await import('../SeedManager');

        await SeedManager.importMnemonic(MNEMONIC_A);

        expect(secureStoreBacking.get(MNEMONIC_KEY)).toBe(MNEMONIC_A);
    });

    it('refuses to overwrite an existing seed without { force: true }', async () => {
        const { default: SeedManager, OverwriteConfirmationRequired } = await import('../SeedManager');

        await SeedManager.importMnemonic(MNEMONIC_A);
        expect(secureStoreBacking.get(MNEMONIC_KEY)).toBe(MNEMONIC_A);

        await expect(SeedManager.importMnemonic(MNEMONIC_B)).rejects.toBeInstanceOf(
            OverwriteConfirmationRequired,
        );

        // SecureStore must NOT have been touched by the rejected call.
        expect(secureStoreBacking.get(MNEMONIC_KEY)).toBe(MNEMONIC_A);
    });

    it('overwrites the existing seed when called with { force: true }', async () => {
        const { default: SeedManager } = await import('../SeedManager');

        await SeedManager.importMnemonic(MNEMONIC_A);
        expect(secureStoreBacking.get(MNEMONIC_KEY)).toBe(MNEMONIC_A);

        await SeedManager.importMnemonic(MNEMONIC_B, { force: true });

        expect(secureStoreBacking.get(MNEMONIC_KEY)).toBe(MNEMONIC_B);
    });

    it('rejects an invalid BIP-39 mnemonic regardless of the force flag', async () => {
        const { default: SeedManager } = await import('../SeedManager');

        await expect(
            SeedManager.importMnemonic(INVALID_MNEMONIC, { force: true }),
        ).rejects.toThrow(/checksum/i);

        expect(secureStoreBacking.has(MNEMONIC_KEY)).toBe(false);
    });

    it('rejects an invalid BIP-39 mnemonic before checking the overwrite guard', async () => {
        // If a caller passes garbage, we want the checksum error - not the
        // overwrite error - so the user gets actionable feedback.
        const { default: SeedManager } = await import('../SeedManager');

        await SeedManager.importMnemonic(MNEMONIC_A);

        await expect(SeedManager.importMnemonic(INVALID_MNEMONIC)).rejects.toThrow(/checksum/i);

        expect(secureStoreBacking.get(MNEMONIC_KEY)).toBe(MNEMONIC_A);
    });
});

describe('SeedManager.seedMatches - same-wallet detection (UX-1)', () => {
    beforeEach(() => {
        secureStoreBacking.clear();
        vi.resetModules();
    });

    it('returns false when no seed is stored', async () => {
        const { default: SeedManager } = await import('../SeedManager');
        expect(await SeedManager.seedMatches(MNEMONIC_A)).toBe(false);
    });

    it('returns true when the candidate derives the resident wallet', async () => {
        const { default: SeedManager } = await import('../SeedManager');
        await SeedManager.importMnemonic(MNEMONIC_A);
        expect(await SeedManager.withBiometricAction('compare wallet', action => SeedManager.seedMatches(MNEMONIC_A, action))).toBe(true);
    });

    it('matches regardless of whitespace and case differences', async () => {
        const { default: SeedManager } = await import('../SeedManager');
        await SeedManager.importMnemonic(MNEMONIC_A);
        const noisy = '  ' + MNEMONIC_A.toUpperCase().replace(/ /g, '  ') + '  ';
        expect(await SeedManager.withBiometricAction('compare wallet', action => SeedManager.seedMatches(noisy, action))).toBe(true);
    });

    it('returns false for a different valid wallet', async () => {
        const { default: SeedManager } = await import('../SeedManager');
        await SeedManager.importMnemonic(MNEMONIC_A);
        expect(await SeedManager.seedMatches(MNEMONIC_B)).toBe(false);
    });

    it('fails safe (false) for an invalid candidate rather than throwing', async () => {
        const { default: SeedManager } = await import('../SeedManager');
        await SeedManager.importMnemonic(MNEMONIC_A);
        expect(await SeedManager.seedMatches(INVALID_MNEMONIC)).toBe(false);
    });
});

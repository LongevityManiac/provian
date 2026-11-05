import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateAnchorKeyPair, toB64u } from './agentKeyRecovery';

/**
 * agentAnchorStore — proves the FUND-SAFETY property: the anchor secret is
 * written to the CLOUD-backed keychain (the same mechanism as the human's
 * wallet mnemonic → survives phone loss), keyed by its pubkey, and is NEVER
 * stored device-only. The device-local index (by connection token / wallet id)
 * carries pubkeys only, never the secret.
 *
 * The native cloud module and AsyncStorage are replaced with in-memory maps so
 * the store's real logic (keying, verify-then-commit, rollback, index) runs.
 */

const h = vi.hoisted(() => ({
    cloud: new Map<string, string>(),
    async: new Map<string, string>(),
    state: { available: true, verifyResult: true },
}));

vi.mock('../recovery/cloud/ProvianCloudKeychainSync', () => ({
    isCloudKeychainAvailable: () => h.state.available,
    cloudTargetLabel: () => 'iCloud Keychain',
    storeSynced: async (k: string, v: string) => { h.cloud.set(k, v); },
    retrieveSynced: async (k: string) => (h.cloud.has(k) ? h.cloud.get(k)! : null),
    deleteSynced: async (k: string) => { h.cloud.delete(k); },
    verifySync: async (_k: string) => h.state.verifyResult,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (k: string) => (h.async.has(k) ? h.async.get(k)! : null),
        setItem: async (k: string, v: string) => { h.async.set(k, v); },
        removeItem: async (k: string) => { h.async.delete(k); },
        clear: async () => { h.async.clear(); },
    },
}));

// The anchor-wrap key derives from the human wallet seed behind a biometric
// session (Security Invariant #1 — only ciphertext reaches the cloud store).
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
vi.mock('../wallet/SeedManager', () => ({
    default: {
        requireBiometricSession: async () => undefined,
        getMnemonic: async () => TEST_MNEMONIC,
    },
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, so this is safe).
import {
    persistRecoveryAnchor,
    loadRecoveryAnchorSecret,
    isRecoveryAnchorStorageAvailable,
    linkAnchorToWallet,
    findAnchorPubkeyByConnectionToken,
    findAnchorPubkeyByWalletId,
} from './agentAnchorStore';

const b64uOfSecret = (secret: Uint8Array) => toB64u(secret);

beforeEach(() => {
    h.cloud.clear();
    h.async.clear();
    h.state.available = true;
    h.state.verifyResult = true;
});

describe('agentAnchorStore — cloud-backed anchor custody (fund safety)', () => {
    it('persists to the CLOUD keychain and reads the SAME secret back by pubkey', async () => {
        const { publicKey, secretKey } = generateAnchorKeyPair();
        const { pubkeyB64u } = await persistRecoveryAnchor({ publicKey, secretKey });

        expect(pubkeyB64u).toBe(toB64u(publicKey));
        const loaded = await loadRecoveryAnchorSecret(pubkeyB64u);
        expect(loaded).not.toBeNull();
        expect(toB64u(loaded as Uint8Array)).toBe(toB64u(secretKey)); // non-vacuous byte equality
    });

    it('FUND-SAFETY: only CIPHERTEXT lands in cloud-synced storage — never the raw secret, never device-only', async () => {
        const { publicKey, secretKey } = generateAnchorKeyPair();
        await persistRecoveryAnchor({ publicKey, secretKey, connectionToken: 'PROV-AAAA-BBBB' });

        // The cloud record exists for this anchor…
        expect(h.cloud.size).toBeGreaterThan(0);
        // …but the raw secret appears NOWHERE in the cloud values (Security
        // Invariant #1: the native transport does not encrypt, so a raw secret
        // here would reach iCloud/Drive in the clear — the pre-fix behavior).
        const cloudValues = [...h.cloud.values()].join('|');
        expect(cloudValues).not.toContain(b64uOfSecret(secretKey));
        // The stored record is the sealed v2 shape…
        const stored = JSON.parse([...h.cloud.values()][0]) as { v: number; boxB64u?: string; nonceB64u?: string };
        expect(stored.v).toBe(2);
        expect(typeof stored.boxB64u).toBe('string');
        expect(typeof stored.nonceB64u).toBe('string');
        // …and the device-local AsyncStorage index NEVER contains the secret.
        const asyncValues = [...h.async.values()].join('|');
        expect(asyncValues).not.toContain(b64uOfSecret(secretKey));
    });

    it('FUND-SAFETY RED CONTROL: a v1 (raw-secret) record is refused on read, never returned', async () => {
        const { publicKey, secretKey } = generateAnchorKeyPair();
        const pub = toB64u(publicKey);
        h.cloud.set(`provian_agent_recovery_anchor::${pub}`, JSON.stringify({
            v: 1, secretKeyB64u: b64uOfSecret(secretKey), createdAtMs: Date.now(),
        }));
        expect(await loadRecoveryAnchorSecret(pub)).toBeNull();
    });

    it('FUND-SAFETY RED CONTROL: a blob re-filed under a different pubkey fails AEAD and returns null', async () => {
        const a = generateAnchorKeyPair();
        const b = generateAnchorKeyPair();
        await persistRecoveryAnchor({ publicKey: a.publicKey, secretKey: a.secretKey });
        const aKey = `provian_agent_recovery_anchor::${toB64u(a.publicKey)}`;
        const bKey = `provian_agent_recovery_anchor::${toB64u(b.publicKey)}`;
        h.cloud.set(bKey, h.cloud.get(aKey)!);
        expect(await loadRecoveryAnchorSecret(toB64u(b.publicKey))).toBeNull();
    });

    it('RED CONTROL: fail-closed when cloud storage is unavailable (no device-only fallback)', async () => {
        h.state.available = false;
        const { publicKey, secretKey } = generateAnchorKeyPair();
        await expect(persistRecoveryAnchor({ publicKey, secretKey })).rejects.toThrow('cloud_backup_unavailable');
        expect(h.cloud.size).toBe(0);
        expect(h.async.size).toBe(0);
        // Positive control: with cloud available it DOES persist.
        h.state.available = true;
        await expect(persistRecoveryAnchor({ publicKey, secretKey })).resolves.toBeTruthy();
        expect(h.cloud.size).toBe(1);
    });

    it('RED CONTROL: a write that does not sync is rolled back and throws', async () => {
        h.state.verifyResult = false;
        const { publicKey, secretKey } = generateAnchorKeyPair();
        await expect(persistRecoveryAnchor({ publicKey, secretKey })).rejects.toThrow('anchor_backup_not_synced');
        expect(h.cloud.size).toBe(0); // rolled back — no orphaned local-only blob
        // Positive control: verified writes are kept.
        h.state.verifyResult = true;
        await persistRecoveryAnchor({ publicKey, secretKey });
        expect(h.cloud.size).toBe(1);
    });

    it('RED CONTROL: an unknown pubkey has no secret (returns null, not a wrong key)', async () => {
        const { publicKey, secretKey } = generateAnchorKeyPair();
        await persistRecoveryAnchor({ publicKey, secretKey });
        const other = generateAnchorKeyPair();
        expect(await loadRecoveryAnchorSecret(toB64u(other.publicKey))).toBeNull();
    });

    it('indexes the anchor by connection token and by wallet id (convenience lookup)', async () => {
        const { publicKey, secretKey } = generateAnchorKeyPair();
        const pub = toB64u(publicKey);
        await persistRecoveryAnchor({ publicKey, secretKey, connectionToken: 'PROV-ABCD-2345' });
        expect(await findAnchorPubkeyByConnectionToken('PROV-ABCD-2345')).toBe(pub);

        await linkAnchorToWallet(pub, 'wallet_aw_test');
        expect(await findAnchorPubkeyByWalletId('wallet_aw_test')).toBe(pub);
        // Unknown lookups are null, never a stray pubkey.
        expect(await findAnchorPubkeyByConnectionToken('PROV-ZZZZ-9999')).toBeNull();
    });

    it('reports storage availability from the native module', () => {
        expect(isRecoveryAnchorStorageAvailable()).toBe(true);
        h.state.available = false;
        expect(isRecoveryAnchorStorageAvailable()).toBe(false);
    });
});

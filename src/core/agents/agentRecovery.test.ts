import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import {
    generateAnchorKeyPair,
    sealToAnchor,
    toB64u,
    fromB64u,
} from '../security/agentKeyRecovery';

/**
 * agentRecovery — proves the end-to-end recovery ROUND TRIP the two-touch
 * onboarding depends on:
 * generateAnchorKeyPair → (SDK) sealToAnchor → store secret (cloud-backed) →
 * relay returns the blob → openWithAnchor recovers the exact plaintext →
 * build a one-paste restore command.
 * Plus RED negative controls: a tampered blob and a missing anchor both
 * fail closed and surface a plain sentence (never a raw code).
 *
 * The cloud module + AsyncStorage are in-memory so the real store logic runs.
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

// The anchor store seals the secret under a seed-derived wrap key (Security
// Invariant #1) behind a biometric session; both come from SeedManager.
vi.mock('../wallet/SeedManager', () => ({
    default: {
        requireBiometricSession: async () => undefined,
        getMnemonic: async () =>
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    },
}));

// Item 11: recovery's derived-anchor fallback lives beside the relay client; the relay is not used here.
vi.mock('../../services/RelayAPIService', () => ({ default: {} }));

import { persistRecoveryAnchor } from '../security/agentAnchorStore';
import { deriveHumanRecoveryAnchor } from './humanRecoveryAnchor';
import {
    recoverAgentKeyHex,
    buildAgentRestoreCommand,
    mintAndPersistRecoveryAnchor,
    AgentRecoveryError,
} from './agentRecovery';
import { mapAgentOnboardingError } from './agentOnboardingErrors';

// A stand-in for the agent's real 32-byte secp256k1 private key.
const AGENT_KEY = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 3) & 0xff);
const detRng = (n: number) => Uint8Array.from({ length: n }, (_v, i) => (i + 11) & 0xff);

beforeEach(() => {
    h.cloud.clear();
    h.async.clear();
    h.state.available = true;
    h.state.verifyResult = true;
});

describe('agentRecovery — recovery round trip', () => {
    it('recovers the EXACT agent key the SDK sealed (generate → seal → store → open)', async () => {
        // Touch 1: mint anchor + persist secret (cloud-backed).
        const anchor = generateAnchorKeyPair();
        await persistRecoveryAnchor({ publicKey: anchor.publicKey, secretKey: anchor.secretKey });

        // Agent side (SDK): seal a copy of its wallet key to the anchor pubkey.
        const blob = sealToAnchor(anchor.publicKey, AGENT_KEY);
        // Relay hands the phone back the blob + the anchor pubkey.
        const sealedKeyBlobB64u = toB64u(blob);
        const recoveryAnchorPubkeyB64u = toB64u(anchor.publicKey);

        // Touch 2: recover.
        const recoveredHex = await recoverAgentKeyHex({ sealedKeyBlobB64u, recoveryAnchorPubkeyB64u });
        expect(recoveredHex).toBe(bytesToHex(AGENT_KEY)); // non-vacuous exact match
    });

    it('mintAndPersistRecoveryAnchor produces an anchor that actually opens a sealed blob', async () => {
        const minted = await mintAndPersistRecoveryAnchor({ randomBytes: detRng });
        expect(minted.recoveryEnabled).toBe(true);
        if (!minted.recoveryEnabled) throw new Error('unreachable');

        // Seal to the minted pubkey, then recover via the same pubkey.
        const anchorPub = fromB64u(minted.recoveryAnchorPubkeyB64u);
        const blob = sealToAnchor(anchorPub, AGENT_KEY);
        const recoveredHex = await recoverAgentKeyHex({
            sealedKeyBlobB64u: toB64u(blob),
            recoveryAnchorPubkeyB64u: minted.recoveryAnchorPubkeyB64u,
            walletId: 'wallet_aw_test',
        });
        expect(recoveredHex).toBe(bytesToHex(AGENT_KEY));
    });

    it('reports recovery DISABLED when cloud storage is unavailable (never device-only)', async () => {
        h.state.available = false;
        const minted = await mintAndPersistRecoveryAnchor({ randomBytes: detRng });
        expect(minted.recoveryEnabled).toBe(false);
        if (minted.recoveryEnabled) throw new Error('unreachable');
        expect(minted.reason).toBe('cloud_backup_unavailable');
        expect(h.cloud.size).toBe(0);
    });

    // --- RED negative controls ---

    it('RED CONTROL: a tampered blob fails closed AND surfaces a plain sentence', async () => {
        const anchor = generateAnchorKeyPair();
        await persistRecoveryAnchor({ publicKey: anchor.publicKey, secretKey: anchor.secretKey });
        const blob = sealToAnchor(anchor.publicKey, AGENT_KEY);
        const tampered = Uint8Array.from(blob);
        tampered[tampered.length - 1] ^= 0x01;

        let threw = false;
        try {
            await recoverAgentKeyHex({
                sealedKeyBlobB64u: toB64u(tampered),
                recoveryAnchorPubkeyB64u: toB64u(anchor.publicKey),
            });
        } catch (e) {
            threw = true;
            const { message } = mapAgentOnboardingError(e);
            expect(message.length).toBeGreaterThan(0);
            // Never leak the raw thrown text.
            expect(message).not.toContain('invalid tag');
        }
        expect(threw).toBe(true);

        // Non-vacuous: the untampered blob still recovers.
        const ok = await recoverAgentKeyHex({
            sealedKeyBlobB64u: toB64u(blob),
            recoveryAnchorPubkeyB64u: toB64u(anchor.publicKey),
        });
        expect(ok).toBe(bytesToHex(AGENT_KEY));
    });

    it('RED CONTROL: no anchor secret on this device → anchor_secret_not_found → plain message', async () => {
        // Store nothing; the pubkey has no matching secret.
        const orphan = generateAnchorKeyPair();
        const blob = sealToAnchor(orphan.publicKey, AGENT_KEY);

        await expect(
            recoverAgentKeyHex({
                sealedKeyBlobB64u: toB64u(blob),
                recoveryAnchorPubkeyB64u: toB64u(orphan.publicKey),
            }),
        ).rejects.toBeInstanceOf(AgentRecoveryError);

        try {
            await recoverAgentKeyHex({
                sealedKeyBlobB64u: toB64u(blob),
                recoveryAnchorPubkeyB64u: toB64u(orphan.publicKey),
            });
        } catch (e) {
            expect((e as AgentRecoveryError).code).toBe('anchor_secret_not_found');
            const { message, action } = mapAgentOnboardingError(e);
            expect(`${message} ${action}`).not.toContain('anchor_secret_not_found');
        }
    });
});

describe('buildAgentRestoreCommand — restore instructions shape (key never in the command)', () => {
    it('emits a KEYLESS interactive command + the key separately (stripped of 0x)', () => {
        const { command, key } = buildAgentRestoreCommand({
            walletId: 'wallet_aw_abc',
            recoveredKeyHex: '0x' + bytesToHex(AGENT_KEY),
            relayUrl: 'https://api.provian.ai/',
        });
        expect(command).toContain('PROVIAN_WALLET_ID=wallet_aw_abc');
        expect(command).toContain('node /tmp/provian-restore.js restore-wallet');
        // The HOSTED bundle (registry 404 pre-publish); trailing slash must not double-slash.
        expect(command).toContain('curl -fsSL "https://api.provian.ai/v1/bootstrap/agent.js"');
        expect(command).not.toContain('npx');
        // Interactive: NO heredoc, NO --from-stdin — the key is read from a hidden prompt.
        expect(command).not.toContain('--from-stdin');
        expect(command).not.toContain("<<'PROVIAN_RESTORE'");
        // The key rides SEPARATELY, 0x-stripped.
        expect(key).toBe(bytesToHex(AGENT_KEY));
    });

    it('RED CONTROL: the KEY must never appear in the command (the leak that shipped before)', () => {
        const { command } = buildAgentRestoreCommand({
            walletId: 'wallet_aw_abc',
            recoveredKeyHex: bytesToHex(AGENT_KEY),
            relayUrl: 'https://api.provian.ai',
        });
        // If the key ever re-enters the command (a regression to the heredoc form),
        // it becomes screenshottable / clipboard / shell-history — exactly this test's guard.
        expect(command).not.toContain(bytesToHex(AGENT_KEY));
        expect(command).not.toContain('0x' + bytesToHex(AGENT_KEY));
    });
});

describe('item 11 — an escrow sealed to the human\'s ONE recovery key (fleet agents)', () => {
    it('recovers with no stored anchor at all: the secret is re-derived from the seed', async () => {
        h.cloud.clear();
        const anchor = deriveHumanRecoveryAnchor('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
        const agentKey = new Uint8Array(32).map((_, i) => i + 1);
        const blob = sealToAnchor(anchor.publicKey, agentKey);
        const hex = await recoverAgentKeyHex({ sealedKeyBlobB64u: toB64u(blob), recoveryAnchorPubkeyB64u: anchor.publicKeyB64u });
        expect(hex).toBe(Buffer.from(agentKey).toString('hex'));
    });

    it('RED control: an anchor that is neither stored nor this seed\'s is still anchor_secret_not_found', async () => {
        h.cloud.clear();
        const foreign = generateAnchorKeyPair();
        const blob = sealToAnchor(foreign.publicKey, new Uint8Array(32).fill(7));
        await expect(recoverAgentKeyHex({ sealedKeyBlobB64u: toB64u(blob), recoveryAnchorPubkeyB64u: toB64u(foreign.publicKey) }))
            .rejects.toMatchObject({ code: 'anchor_secret_not_found' });
    });
});

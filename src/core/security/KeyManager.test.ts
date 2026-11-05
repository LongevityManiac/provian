/**
 * KeyManager P-256 round-trip tests.
 *
 * Covers the verification bugs that GPT's audit surfaced:
 *   1. signDigest must serialize as raw r||s (128 hex chars), not r||s||v.
 *   2. verifySignature must route to the P-256 verifier when the stored
 *      device key is P-256, regardless of signature length.
 *   3. verifyP256Signature must derive the actor address with
 *      keccak256(X||Y)[-20:] (matching getAddress), not ethers.computeAddress
 *      which validates against the secp256k1 curve and rejects P-256 points.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
// Setup file (test/vitest.setup.ts) resets the SecureStore stub between tests;
// our own beforeEach handles the in-memory KeyManager singleton state.

const fixtures = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { p256 } = require('@noble/curves/p256');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getBytes } = require('ethers');

    const privateKey: Uint8Array = p256.utils.randomPrivateKey();
    const pubKeyPoint: Uint8Array = p256.getPublicKey(privateKey, false);
    const pubKeyHex = Array.from(pubKeyPoint)
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join('');
    const pubKeyXHex = pubKeyHex.slice(2, 66);
    const pubKeyYHex = pubKeyHex.slice(66, 130);

    let keyExists = false;
    // Audit Pass 2, Fix 3 fixtures. Mutable so individual tests can swap
    // the reported backing without re-mocking the module.
    const state: {
        backing: 'strongbox' | 'tee' | 'software' | undefined;
        backingThrows: boolean;
        getKeyBackingDefined: boolean;
        hardwareBacked: boolean;
    } = {
        backing: 'strongbox',
        backingThrows: false,
        getKeyBackingDefined: true,
        hardwareBacked: true,
    };
    const fakeNativeModule: Record<string, unknown> = {
        generateKey: async () => {
            keyExists = true;
            return { publicKeyX: pubKeyXHex, publicKeyY: pubKeyYHex };
        },
        signDigest: async (_keyId: string, digestHex: string, _frictionLevel: string) => {
            const digestBytes: Uint8Array = getBytes(
                digestHex.startsWith('0x') ? digestHex : '0x' + digestHex,
            );
            const sig = p256.sign(digestBytes, privateKey, { lowS: true });
            const rHex = sig.r.toString(16).padStart(64, '0');
            const sHex = sig.s.toString(16).padStart(64, '0');
            return { r: rHex, s: sHex };
        },
        hasKey: async () => keyExists,
        deleteKey: async () => {
            keyExists = false;
        },
        isHardwareBacked: async () => state.hardwareBacked,
        isCloudBackupAvailable: async () => true,
        // Define get/configurable so tests can delete it to simulate older
        // app builds without `getKeyBacking`.
        getKeyBacking: async (_keyId: string) => {
            if (state.backingThrows) throw new Error('test backing failure');
            return state.backing ?? 'software';
        },
    };

    function setBacking(opts: {
        backing?: 'strongbox' | 'tee' | 'software' | undefined;
        backingThrows?: boolean;
        getKeyBackingDefined?: boolean;
        hardwareBacked?: boolean;
    }): void {
        if (opts.backing !== undefined) state.backing = opts.backing;
        if (opts.backingThrows !== undefined) state.backingThrows = opts.backingThrows;
        if (opts.hardwareBacked !== undefined) state.hardwareBacked = opts.hardwareBacked;
        if (opts.getKeyBackingDefined !== undefined) {
            state.getKeyBackingDefined = opts.getKeyBackingDefined;
            if (opts.getKeyBackingDefined) {
                fakeNativeModule.getKeyBacking = async (_keyId: string) => {
                    if (state.backingThrows) throw new Error('test backing failure');
                    return state.backing ?? 'software';
                };
            } else {
                delete fakeNativeModule.getKeyBacking;
            }
        }
    }

    return { privateKey, pubKeyXHex, pubKeyYHex, fakeNativeModule, setBacking };
});

vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (obj: any) => obj?.default ?? obj },
    NativeModules: { ProvianSecureEnclaveP256: fixtures.fakeNativeModule },
    TurboModuleRegistry: {
        getEnforcing: () => ({}),
        get: () => ({}),
    },
    Linking: { openURL: async () => {}, canOpenURL: async () => false },
    Alert: { alert: () => {} },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Dimensions: { get: () => ({ width: 0, height: 0 }) },
    default: {},
}));

const { pubKeyXHex, pubKeyYHex, setBacking } = fixtures;

// Import KeyManager AFTER the mock is registered so it picks up the fake module.
import KeyManager from './KeyManager';

const expectedActorAddress = ethers.getAddress(
    '0x' + ethers.keccak256('0x' + pubKeyXHex + pubKeyYHex).slice(-40),
);

describe('KeyManager P-256 round-trip', () => {
    beforeEach(async () => {
        // Force a fresh generateKey() so the stored public key matches our
        // fake module's keypair and the in-memory cache is populated.
        // KeyManager is a singleton; clear cached state from any prior run.
        await (KeyManager as any).deleteKey();
        (KeyManager as any).cachedAddress = null;
        (KeyManager as any).cachedPublicKey = null;
        await KeyManager.generateKey();
    });

    it('signDigest returns 128-hex r||s with v: null', async () => {
        const digest = ethers.keccak256(ethers.toUtf8Bytes('test-digest-payload'));
        const result = await KeyManager.signDigest(digest);

        expect(result.signature.startsWith('0x')).toBe(true);
        // 128 hex chars + '0x' prefix = 130-character string. The previous
        // implementation appended a v=27 byte and produced 132 chars, which
        // verifySignature would misroute to the secp256k1 verifier.
        expect(result.signature.length).toBe(2 + 128);
        expect(result.v).toBeNull();
        expect(result.r.length).toBeGreaterThan(0);
        expect(result.s.length).toBeGreaterThan(0);
    });

    it('verifySignature accepts a freshly-signed payload (signMessage path)', async () => {
        const message = 'hello provian';
        const signature = await KeyManager.signMessage(message);
        const result = await KeyManager.verifySignature(message, signature);

        expect(result.isValid).toBe(true);
        expect(result.recoveredAddress?.toLowerCase()).toBe(expectedActorAddress.toLowerCase());
    });

    it('verifySignature accepts an explicit expectedAddress that matches the actor address', async () => {
        const message = 'with-expected-address';
        const signature = await KeyManager.signMessage(message);
        const result = await KeyManager.verifySignature(message, signature, expectedActorAddress);

        expect(result.isValid).toBe(true);
    });

    it('verifySignature rejects a payload whose signature does not match', async () => {
        const message = 'original';
        const signature = await KeyManager.signMessage(message);
        const result = await KeyManager.verifySignature('tampered', signature);

        expect(result.isValid).toBe(false);
    });

    it('verifySignature tolerates a legacy 130-char r||s||v hardware signature', async () => {
        const message = 'legacy-shape';
        const rawSig = await KeyManager.signMessage(message);
        // Append a fake v byte (1 hex byte = 2 hex chars) the way the buggy
        // signDigest used to.
        const legacySig = rawSig + '1b';

        const result = await KeyManager.verifySignature(message, legacySig);
        expect(result.isValid).toBe(true);
    });

    it('getAddress and verifyP256Signature derive the same address', async () => {
        const stored = await KeyManager.getAddress();
        expect(stored).toBe(expectedActorAddress);

        const message = 'address-derivation-check';
        const signature = await KeyManager.signMessage(message);
        const result = await KeyManager.verifySignature(message, signature);

        expect(result.recoveredAddress).toBe(expectedActorAddress);
    });
});

// ===========================================================================
// Audit Pass 2, Fix 3: getKeyAttestation distinguishes StrongBox vs TEE.
// Pre-fix this collapsed both Android backings into 'hardware_full'.
// ===========================================================================

describe('Audit Pass 2 / Fix 3: KeyManager.getKeyAttestation', () => {
    beforeEach(async () => {
        // Reset backing fixture to defaults before each test.
        setBacking({
            backing: 'strongbox',
            backingThrows: false,
            getKeyBackingDefined: true,
            hardwareBacked: true,
        });
        await (KeyManager as any).deleteKey();
        (KeyManager as any).cachedAddress = null;
        (KeyManager as any).cachedPublicKey = null;
        await KeyManager.generateKey();
    });

    it("returns hardware_full when getKeyBacking reports 'strongbox'", async () => {
        setBacking({ backing: 'strongbox' });
        const attestation = await KeyManager.getKeyAttestation();
        expect(attestation.tier).toBe('hardware_full');
    });

    it("returns hardware_tpm when getKeyBacking reports 'tee'", async () => {
        setBacking({ backing: 'tee' });
        const attestation = await KeyManager.getKeyAttestation();
        expect(attestation.tier).toBe('hardware_tpm');
    });

    it("returns software when getKeyBacking reports 'software'", async () => {
        setBacking({ backing: 'software' });
        const attestation = await KeyManager.getKeyAttestation();
        expect(attestation.tier).toBe('software');
    });

    it('falls back to hardware_tpm (NOT hardware_full) when the native module is older and lacks getKeyBacking', async () => {
        setBacking({ getKeyBackingDefined: false, hardwareBacked: true });
        const attestation = await KeyManager.getKeyAttestation();
        expect(attestation.tier).toBe('hardware_tpm');
    });

    it('falls back to software when the native module lacks getKeyBacking AND isHardwareBacked is false', async () => {
        setBacking({ getKeyBackingDefined: false, hardwareBacked: false });
        const attestation = await KeyManager.getKeyAttestation();
        expect(attestation.tier).toBe('software');
    });

    it('falls back to legacy capability when getKeyBacking throws', async () => {
        setBacking({ backingThrows: true, hardwareBacked: true });
        const attestation = await KeyManager.getKeyAttestation();
        // The legacy fallback caps at hardware_tpm.
        expect(attestation.tier).toBe('hardware_tpm');
    });
});

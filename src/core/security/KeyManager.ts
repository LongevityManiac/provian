/**
 * KeyManager - Device Attestation and PE Signing Module
 *
 * Provides device-key signing for Provenance Envelopes. On supported human
 * mobile devices, the key can be hardware-bound in the Secure Enclave (iOS)
 * or StrongBox / TEE (Android). This module reports signing capability and
 * evidence signals; the relay, not this client, assigns the PE attestation
 * tier. Signing capability alone never selects a hardware tier.
 *
 * Signs:
 * - Device-originated Provenance Envelopes
 * - Decision receipts
 * (Agent session messages and agent action authorizations were removed with
 * the agent governance layer in.)
 *
 * The actor address derived from the P-256 public key identifies *the device*
 * in the PE chain (separate from the wallet address - see below).
 *
 * DO NOT use this module for:
 * - Wallet creation → use WalletCreationService
 * - Key derivation → use SeedManager
 * - Transaction signing → use TransactionService
 * - Mnemonic/seed access → use SeedManager
 *
 * The wallet's signing identity is a BIP-39-derived secp256k1 EOA managed by
 * SeedManager. This module's P-256 key is independent and used only for PE
 * attestation. They are not the same key, and they do not produce the same
 * address.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import { p256 } from '@noble/curves/p256';
import { assertBiometricAction, type BiometricAction } from './biometricAction';
import type { ProvianSecureSeedModule } from '../../../modules/provian-secure-seed';
import { NativeModules, Platform } from 'react-native';
import { ethers } from 'ethers';
import * as SecureStore from 'expo-secure-store';
import { verifyP256, normalizeP256PublicKey } from './p256Verify';

// [Chunk I native pass] Native modules reject unknown frictionLevel values
// (fail-closed). Mirror that allowlist here so callers get a compile-time
// error instead of a runtime INVALID_FRICTION_LEVEL rejection.
export type FrictionLevel = 'auto_approve' | 'soft_confirm' | 'hard_confirm';

interface SecureEnclaveModule {
    generateKey(keyId: string): Promise<{ publicKeyX: string; publicKeyY: string }>;
    signDigest(keyId: string, digest: string, frictionLevel: FrictionLevel): Promise<{ r: string; s: string }>;
    hasKey(keyId: string): Promise<boolean>;
    deleteKey(keyId: string): Promise<void>;
    isHardwareBacked(): Promise<boolean>;
    /**
     * Audit Pass 2, Fix 3: report the actual backing of the named key.
     * iOS returns 'strongbox' (Secure Enclave is the platform's strongbox)
     * or 'software' (no SE). Android returns 'strongbox' / 'tee' / 'software'
     * based on the live KeyInfo.securityLevel of the existing key.
     * Older app builds may not implement this method; callers must
     * tolerate undefined and fall back conservatively.
     */
    getKeyBacking?(keyId: string): Promise<'strongbox' | 'tee' | 'software'>;
    isCloudBackupAvailable(): Promise<boolean>;
    authenticateForSigning?(reason: string): Promise<boolean>;
}

const PE_ATTESTATION_KEY_ID = 'provian_pe_attestation';
const HW_PUBLIC_KEY_STORE_KEY = 'provian_hw_public_key';

const SecureEnclave: SecureEnclaveModule | null = NativeModules.ProvianSecureEnclaveP256 || null;

export type AttestationTier = 'hardware_full' | 'hardware_tpm' | 'software';

export interface KeyAttestation {
    tier: AttestationTier;
    platform: 'ios' | 'android';
}

export interface KeyInfo {
    address: string;
    publicKey: string;
    publicKeyX: string;
    publicKeyY: string;
    isHardwareBacked: boolean;
    securityLevel: 'strongbox' | 'tee' | 'software';
}

export interface SignatureResult {
    signature: string;
    r: string;
    s: string;
    // v is meaningful only for secp256k1 recovery. P-256 hardware signatures
    // have no recovery byte; the SE path returns v: null and serializes the
    // signature as raw r||s (128 hex chars). The software (secp256k1) fallback
    // returns v: 27 | 28 and serializes as r||s||v (130 hex chars).
    v: number | null;
}

class KeyManager {
    private static instance: KeyManager;
    private cachedAddress: string | null = null;
    private cachedPublicKey: string | null = null;

    private constructor() {}

    static getInstance(): KeyManager {
        if (!KeyManager.instance) {
            KeyManager.instance = new KeyManager();
        }
        return KeyManager.instance;
    }

    /**
     * Check if native Secure Enclave module is available.
     */
    isNativeModuleAvailable(): boolean {
        return SecureEnclave !== null;
    }

    /**
     * Generate a new P-256 key pair inside the Secure Enclave for PE attestation.
     * The private key is non-exportable - never accessible to JS.
     * Returns the public key and derived actor address used in PE chains.
     */
    async generateKey(): Promise<KeyInfo> {
        if (!SecureEnclave) {
            // WS8: gate the software fallback at the SOURCE. On a real production
            // build the native module is always present, so a null here means a
            // broken native bridge — silently minting a software-backed PE key
            // would degrade attestation without anyone noticing (M-17 only rejects
            // such keys downstream at the authorization gate). Per "Unknown =
            // Block", fail closed in production; allow the fallback only in a dev
            // build (simulator / Expo Go). Gated on __DEV__ alone, NOT
            // !Device.isDevice, so on-device development builds still work.
            if (!__DEV__) {
                throw new Error(
                    'Secure Enclave native module unavailable; refusing to generate a software-backed PE key in production. This indicates a broken native build.',
                );
            }
            console.warn('[KeyManager] Native Secure Enclave not available - using SecureStore fallback (dev build only)');
            return this.generateKeyFallback();
        }

        const existingKey = await SecureEnclave.hasKey(PE_ATTESTATION_KEY_ID);
        if (existingKey) {
            throw new Error('PE attestation key already exists. Delete existing key first.');
        }

        const { publicKeyX, publicKeyY } = await SecureEnclave.generateKey(PE_ATTESTATION_KEY_ID);

        const pubKeyXPadded = publicKeyX.padStart(64, '0');
        const pubKeyYPadded = publicKeyY.padStart(64, '0');
        const publicKey = '0x04' + pubKeyXPadded + pubKeyYPadded;

        // Derive a deterministic actor address from the P-256 public key.
        // ethers.computeAddress() validates on secp256k1 which rejects P-256 points.
        // Instead, keccak256 the raw coordinates and take last 20 bytes - this is
        // the actor address used to identify the device in the PE chain. It is
        // NOT the wallet address (the wallet address is the BIP-39-derived
        // secp256k1 EOA managed by SeedManager).
        const address = ethers.getAddress(
            '0x' + ethers.keccak256('0x' + pubKeyXPadded + pubKeyYPadded).slice(-40)
        );

        const isHardwareBacked = await SecureEnclave.isHardwareBacked();

        await SecureStore.setItemAsync(HW_PUBLIC_KEY_STORE_KEY, publicKey, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });

        this.cachedPublicKey = publicKey;
        this.cachedAddress = address;

        return {
            address,
            publicKey,
            publicKeyX: pubKeyXPadded,
            publicKeyY: pubKeyYPadded,
            isHardwareBacked,
            securityLevel: isHardwareBacked ? 'tee' : 'software',
        };
    }

    /**
     * Get the device's key attestation tier and platform.
     * - iOS Secure Enclave + relay-verified App Attest = hardware_full
     * - Android StrongBox + relay-verified platform evidence = hardware_full
     * - Android TEE (no StrongBox) = hardware_tpm
     * - Software fallback = software
     * Hardware backing alone does not prove a full platform-attestation chain;
     * the relay applies the authoritative tier and owner-policy cap. In
     * particular, agent-owned devices remain software-only.
     *
     * Audit Pass 2, Fix 3: route by the actual key backing reported by
     * `getKeyBacking()`, not the device-level `isHardwareBacked()` capability
     * flag. The previous implementation collapsed StrongBox and TEE to
     * `hardware_full` for any Android device that *could* do StrongBox or
     * was on API ≥23. With `getKeyBacking()` the JS side now distinguishes
     * StrongBox (`hardware_full`) from TEE (`hardware_tpm`).
     *
     * If the native module is older and doesn't expose `getKeyBacking()`,
     * fall back to the conservative cap (`hardware_tpm`) when the device
     * is hardware-backed at all. The `hardware_full` ceiling lowers when
     * the platform can't prove the higher tier - same shape as the desktop
     * SE cap in Fix 1.
     */
    async getKeyAttestation(): Promise<KeyAttestation> {
        const platform = Platform.OS === 'ios' ? 'ios' : 'android';

        if (!SecureEnclave) {
            return { tier: 'software', platform };
        }

        // Preferred path: ask the native module for the actual backing.
        if (typeof SecureEnclave.getKeyBacking === 'function') {
            try {
                const backing = await SecureEnclave.getKeyBacking(PE_ATTESTATION_KEY_ID);
                if (backing === 'strongbox') return { tier: 'hardware_full', platform };
                if (backing === 'tee') return { tier: 'hardware_tpm', platform };
                return { tier: 'software', platform };
            } catch {
                // Fall through to the legacy capability flag below.
            }
        }

        // Legacy fallback for older app builds. Cap at hardware_tpm because
        // isHardwareBacked() conflates StrongBox and TEE; over-claiming
        // hardware_full would let a TEE-only key earn the full tier.
        const hwBacked = await SecureEnclave.isHardwareBacked();
        if (!hwBacked) return { tier: 'software', platform };
        return { tier: 'hardware_tpm', platform };
    }

    /**
     * Get the actor address derived from the P-256 PE attestation public key.
     * This identifies the *device* in the PE chain. It is independent of the
     * wallet address (the BIP-39-derived secp256k1 EOA managed by SeedManager).
     * Returns null if the attestation key has not been generated yet.
     */
    async getAddress(): Promise<string | null> {
        if (this.cachedAddress) {
            return this.cachedAddress;
        }

        const publicKey = await this.getPublicKey();
        if (!publicKey) return null;

        // Derive address from public key. If this is a P-256 key (hardware path,
        // starts with 0x04 and is 130 hex chars), we cannot use ethers.computeAddress
        // which validates on secp256k1. Instead, keccak the raw coordinates.
        const keyHex = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;
        if (keyHex.length === 130 && keyHex.startsWith('04')) {
            // P-256 uncompressed key - derive address from raw coordinates
            this.cachedAddress = ethers.getAddress(
                '0x' + ethers.keccak256('0x' + keyHex.slice(2)).slice(-40)
            );
        } else {
            // secp256k1 key (software fallback) - standard derivation
            this.cachedAddress = ethers.computeAddress(publicKey);
        }
        return this.cachedAddress;
    }

    /**
     * Get the device-identity P-256 public key (uncompressed, 04 || X || Y).
     * Used for PE attestation, not wallet signing - see module header.
     * The private key never leaves the Secure Enclave.
     */
    async getPublicKey(): Promise<string | null> {
        if (this.cachedPublicKey) {
            return this.cachedPublicKey;
        }

        if (!SecureEnclave) {
            return this.getPublicKeyFallback();
        }

        try {
            const publicKey = await SecureStore.getItemAsync(HW_PUBLIC_KEY_STORE_KEY);
            if (publicKey) {
                this.cachedPublicKey = publicKey;
            }
            return publicKey;
        } catch (err) {
            console.warn('[KeyManager] SecureStore read failed:', err);
            return null;
        }
    }

    /**
     * Sign a message using the Secure Enclave P-256 PE attestation key.
     * Computes keccak256 EIP-191 hash in JS, signs the digest in hardware.
     */
    private async signHardwareDigest(digest: string, friction: FrictionLevel, action?: BiometricAction): Promise<{ r: string; s: string }> {
        if (action) {
            assertBiometricAction(action);
            const native = requireOptionalNativeModule<ProvianSecureSeedModule>('ProvianSecureSeed');
            if (native && action.nativeId) {
                const der = await native.signDeviceDigestAsync(PE_ATTESTATION_KEY_ID, digest, action.nativeId);
                const signature = p256.Signature.fromDER(der).normalizeS();
                assertBiometricAction(action);
                return { r: signature.r.toString(16).padStart(64, '0'), s: signature.s.toString(16).padStart(64, '0') };
            }
        }
        return SecureEnclave!.signDigest(PE_ATTESTATION_KEY_ID, digest, friction);
    }

    async signMessage(message: string, action?: BiometricAction): Promise<string> {
        if (!SecureEnclave) {
            return this.signMessageFallback(message);
        }

        const messageHash = ethers.hashMessage(message);
        const { r, s } = await this.signHardwareDigest(messageHash, 'auto_approve', action);

        const rHex = r.startsWith('0x') ? r.slice(2) : r;
        const sHex = s.startsWith('0x') ? s.slice(2) : s;
        return '0x' + rHex.padStart(64, '0') + sHex.padStart(64, '0');
    }

    /**
     * Sign an arbitrary payload string (PE attestation, decision receipts).
     */
    async signPayload(payload: string, action?: BiometricAction): Promise<string> {
        return this.signMessage(payload, action);
    }

    /**
     * Sign a raw 32-byte digest using the Secure Enclave P-256 PE attestation key.
     * Used for EIP-712 typed data and other digest-based signing flows.
     *
     * The native module signs the digest DIRECTLY - no additional hashing.
     * Caller must provide a pre-computed 32-byte hash.
     */
    async signDigest(digest: string, frictionLevel: FrictionLevel = 'auto_approve', action?: BiometricAction): Promise<SignatureResult> {
        if (!SecureEnclave) {
            return this.signDigestFallback(digest);
        }

        const { r, s } = await this.signHardwareDigest(digest, frictionLevel, action);

        // P-256 has no recovery byte. Serialize as raw r||s (128 hex chars) so
        // verifySignature's secp256k1 path is never reachable on hardware sigs
        // that lack a meaningful v. Previously this used
        // ethers.Signature.from({r,s,v:27}).serialized which produced a 130-char
        // string and caused verifySignature() to misroute hardware-signed
        // digests to the secp256k1 verifier.
        const rHex = r.startsWith('0x') ? r.slice(2) : r;
        const sHex = s.startsWith('0x') ? s.slice(2) : s;
        const signature = '0x' + rHex.padStart(64, '0') + sHex.padStart(64, '0');

        return { signature, r, s, v: null };
    }

    /**
     * Verify a signature against a payload and expected signer.
     * Supports both P-256 (hardware) and secp256k1 (software fallback).
     */
    async verifySignature(
        payload: string,
        signature: string,
        expectedAddress?: string
    ): Promise<{ isValid: boolean; recoveredAddress: string | null; error?: string }> {
        try {
            // Route by the stored public-key shape, not by signature length.
            // A P-256 device key normalizes to the uncompressed encoding
            // (0x04 || X || Y, 130 hex chars). Quirk 4 (StrongBox vs TEE
            // parity): both Android backings produce identical wire formats,
            // and this verifier never branches on which one signed - the
            // attestation tier reflects the backing in metadata, not in
            // verification logic.
            const storedPublicKey = await this.getPublicKey();
            const isP256Key =
                storedPublicKey !== null &&
                normalizeP256PublicKey(storedPublicKey) !== null;

            if (isP256Key && storedPublicKey) {
                return this.verifyP256Signature(payload, signature, expectedAddress, storedPublicKey);
            }

            const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
            const SECP256K1_N_HALF = SECP256K1_N / 2n;
            try {
                const sig = ethers.Signature.from(signature);
                const sValue = BigInt(sig.s);
                if (sValue > SECP256K1_N_HALF) {
                    return { isValid: false, recoveredAddress: null, error: 'Signature malleability: s > n/2' };
                }
            } catch { /* verifyMessage will also fail */ }

            const recoveredAddress = ethers.verifyMessage(payload, signature);
            const addressToCheck = expectedAddress || await this.getAddress();

            if (!addressToCheck) {
                return { isValid: false, recoveredAddress, error: 'No expected address' };
            }

            const isValid = recoveredAddress.toLowerCase() === addressToCheck.toLowerCase();
            return { isValid, recoveredAddress };
        } catch (error) {
            return { isValid: false, recoveredAddress: null, error: error instanceof Error ? error.message : 'Verification failed' };
        }
    }

    private async verifyP256Signature(
        payload: string,
        signature: string,
        expectedAddress: string | undefined,
        storedPublicKey: string,
    ): Promise<{ isValid: boolean; recoveredAddress: string | null; error?: string }> {
        try {
            // Hardened verify: accepts raw r||s, legacy r||s||v, or DER for
            // the signature; accepts compressed / uncompressed / raw (X||Y)
            // for the public key; normalizes high-s to low-s before verify
            // so signatures from any source validate. See p256Verify.ts.
            const messageHash = ethers.hashMessage(payload);
            const digestBytes = ethers.getBytes(messageHash);

            const sigValid = verifyP256({
                digest: digestBytes,
                signature,
                publicKey: storedPublicKey,
            });
            if (!sigValid) {
                return { isValid: false, recoveredAddress: null };
            }

            // Derive the actor address from the P-256 public key the same way
            // generateKey() and getAddress() do: keccak256(X||Y)[-20:].
            // ethers.computeAddress validates against the secp256k1 curve and
            // rejects P-256 points, so the keccak path is the only correct
            // one for hardware-attested keys.
            const recoveredAddress = await this.getAddress();
            if (!recoveredAddress) {
                return { isValid: false, recoveredAddress: null, error: 'Cannot derive P-256 actor address' };
            }

            const addressToCheck = expectedAddress ?? recoveredAddress;
            const isValid = recoveredAddress.toLowerCase() === addressToCheck.toLowerCase();
            return { isValid, recoveredAddress };
        } catch (error) {
            return { isValid: false, recoveredAddress: null, error: error instanceof Error ? error.message : 'P-256 verification failed' };
        }
    }

    /**
     * Open hardware-backed auth window for subsequent silent signing.
     * Android: BiometricPrompt with duration-based validity.
     * iOS: no-op (LAContext manages the window internally).
     */
    async authenticateForSigning(reason: string): Promise<boolean> {
        if (!SecureEnclave || !SecureEnclave.authenticateForSigning) {
            return true;
        }
        if (Platform.OS !== 'android') {
            return true;
        }
        try {
            return await SecureEnclave.authenticateForSigning(reason);
        } catch {
            return false;
        }
    }

    /**
     * Startup health check: verify cached public key has a corresponding private key.
     */
    async reconcileKeyState(): Promise<void> {
        const cachedPublicKey = await this.getPublicKey();
        if (!cachedPublicKey) return;

        const hasPrivateKey = await this.hasKey();
        if (!hasPrivateKey) {
            console.warn('[KeyManager] Stale public key cache - clearing');
            await SecureStore.deleteItemAsync(HW_PUBLIC_KEY_STORE_KEY);
            this.cachedPublicKey = null;
            this.cachedAddress = null;
            await SecureStore.deleteItemAsync(this.DEV_STORAGE_KEY).catch(() => {});
        }
    }

    async hasKey(): Promise<boolean> {
        if (!SecureEnclave) {
            return this.hasKeyFallback();
        }
        return SecureEnclave.hasKey(PE_ATTESTATION_KEY_ID);
    }

    async deleteKey(): Promise<void> {
        if (!SecureEnclave) {
            return this.deleteKeyFallback();
        }

        await SecureEnclave.deleteKey(PE_ATTESTATION_KEY_ID);
        await SecureStore.deleteItemAsync(HW_PUBLIC_KEY_STORE_KEY);
        this.cachedAddress = null;
        this.cachedPublicKey = null;
    }

    async isHardwareBacked(): Promise<boolean> {
        if (!SecureEnclave) return false;
        return SecureEnclave.isHardwareBacked();
    }

    async getSecurityLevel(): Promise<'strongbox' | 'tee' | 'software'> {
        if (!SecureEnclave) return 'software';
        const hwBacked = await SecureEnclave.isHardwareBacked();
        return hwBacked ? 'tee' : 'software';
    }

    async performDeviceAttestation(): Promise<{
        deviceId: string;
        securityLevel: 'strongbox' | 'tee' | 'software';
        isHardwareBacked: boolean;
        timestamp: number;
    }> {
        const securityLevel = await this.getSecurityLevel();
        const isHardwareBacked = securityLevel !== 'software';

        const DEVICE_ID_KEY = 'provian_device_id';
        let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);

        if (!deviceId) {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            deviceId = Array.from(bytes)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            });
        }

        return { deviceId, securityLevel, isHardwareBacked, timestamp: Date.now() };
    }

    /**
     * Get device key material for HKDF-based key derivation.
     * Used by AgentSessionManager and AgentAuthorizationGate.
     */
    async getDeviceKeyMaterial(): Promise<string> {
        const DEVICE_KEY_MATERIAL_KEY = 'provian_device_key_material';

        let material = await SecureStore.getItemAsync(DEVICE_KEY_MATERIAL_KEY);
        if (!material) {
            const bytes = new Uint8Array(32);
            crypto.getRandomValues(bytes);
            material = Array.from(bytes)
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
            await SecureStore.setItemAsync(DEVICE_KEY_MATERIAL_KEY, material, {
                keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            });
        }

        return material;
    }

    // =========================================================================
    // SECURESTORE FALLBACKS (dev environments without native module)
    // =========================================================================

    private devWallet: ethers.BaseWallet | null = null;
    private DEV_STORAGE_KEY = '__provian_dev_wallet__';

    private async generateKeyFallback(): Promise<KeyInfo> {
        const stored = await SecureStore.getItemAsync(this.DEV_STORAGE_KEY);
        if (stored) {
            throw new Error('PE attestation key already exists. Delete existing key first.');
        }

        const wallet = ethers.Wallet.createRandom();
        this.devWallet = wallet;
        // [Group 6 / M-5] Pin keychain accessibility to
        // WHEN_UNLOCKED_THIS_DEVICE_ONLY so the dev wallet key cannot
        // accidentally land in iCloud Keychain sync. Mirrors the rest of
        // the SecureStore writes in this codebase.
        await SecureStore.setItemAsync(this.DEV_STORAGE_KEY, wallet.privateKey, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });

        this.cachedAddress = wallet.address;
        this.cachedPublicKey = wallet.signingKey.publicKey;

        return {
            address: wallet.address,
            publicKey: wallet.signingKey.publicKey,
            publicKeyX: '0'.repeat(64),
            publicKeyY: '0'.repeat(64),
            isHardwareBacked: false,
            securityLevel: 'software',
        };
    }

    private async getPublicKeyFallback(): Promise<string | null> {
        await this.loadDevWallet();
        return this.devWallet?.signingKey.publicKey || null;
    }

    private async signMessageFallback(message: string): Promise<string> {
        await this.loadDevWallet();
        if (!this.devWallet) throw new Error('No wallet key found');
        return this.devWallet.signMessage(message);
    }

    private async signDigestFallback(digest: string): Promise<SignatureResult> {
        await this.loadDevWallet();
        if (!this.devWallet) throw new Error('No wallet key found');
        const sig = this.devWallet.signingKey.sign(digest);
        return { signature: sig.serialized, r: sig.r, s: sig.s, v: sig.v };
    }

    private async hasKeyFallback(): Promise<boolean> {
        const stored = await SecureStore.getItemAsync(this.DEV_STORAGE_KEY);
        return stored !== null;
    }

    private async deleteKeyFallback(): Promise<void> {
        await SecureStore.deleteItemAsync(this.DEV_STORAGE_KEY);
        this.devWallet = null;
        this.cachedAddress = null;
        this.cachedPublicKey = null;
    }

    private async loadDevWallet(): Promise<void> {
        if (this.devWallet) return;
        const stored = await SecureStore.getItemAsync(this.DEV_STORAGE_KEY);
        if (stored) {
            const wallet = new ethers.Wallet(stored);
            this.devWallet = wallet;
            this.cachedAddress = wallet.address;
            this.cachedPublicKey = wallet.signingKey.publicKey;
        }
    }
}

export default KeyManager.getInstance();

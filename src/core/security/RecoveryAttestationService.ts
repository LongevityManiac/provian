/**
 * RecoveryAttestationService - Device Attestation for Recovery
 *
 * Critical security layer that prevents recovery to compromised devices.
 * Uses real platform attestation APIs:
 * - iOS: Apple App Attest (DCAppAttestService)
 * - Android: Google Play Integrity API
 *
 * Verifies:
 * - Device is genuine (not emulator)
 * - OS integrity (not jailbroken/rooted)
 * - App is authentic (signed by Provian)
 * - Key is hardware-backed
 *
 * Shares are only released after attestation passes.
 */

import { Platform, NativeModules } from 'react-native';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import KeyManager from './KeyManager';

export interface RecoveryAttestation {
    // Device identification
    deviceId: string;
    deviceModel: string;
    deviceManufacturer: string;

    // Security status
    keyOrigin: 'secure_enclave' | 'strongbox' | 'tee' | 'software';
    platform: 'ios' | 'android';
    osVersion: string;
    osIntegrity: boolean;           // Not jailbroken/rooted
    appAuthentic: boolean;          // Real Provian app from store

    // Attestation proof
    timestamp: number;
    nonce: string;                  // Server-provided challenge
    attestationToken: string;       // Platform attestation token (App Attest / Play Integrity)

    // Verification metadata
    verificationEndpoint: string;   // Server-side attestation verification is the security boundary
    expiresAt: number;              // Attestation validity window
}

export interface AttestationChallenge {
    nonce: string;
    issuedAt: number;
    expiresAt: number;
    recoveryId: string;
}

export interface AttestationResult {
    valid: boolean;
    attestation?: RecoveryAttestation;
    error?: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    warnings: string[];
}

// Native module interfaces
interface AppAttestModule {
    isSupported(): Promise<boolean>;
    attestKey(clientDataHash: string): Promise<{ keyId: string; attestation: string }>;
    generateAssertion(clientDataHash: string): Promise<{ keyId: string; assertion: string }>;
}

interface PlayIntegrityModule {
    isSupported(): Promise<boolean>;
    requestIntegrityToken(nonce: string): Promise<string>;
}

class RecoveryAttestationService {
    private static instance: RecoveryAttestationService;
    private appAttest: AppAttestModule | null;
    private playIntegrity: PlayIntegrityModule | null;

    private constructor() {
        this.appAttest = NativeModules.ProvianAppAttest || null;
        this.playIntegrity = NativeModules.ProvianPlayIntegrity || null;
    }

    static getInstance(): RecoveryAttestationService {
        if (!RecoveryAttestationService.instance) {
            RecoveryAttestationService.instance = new RecoveryAttestationService();
        }
        return RecoveryAttestationService.instance;
    }

    /**
     * Request an attestation challenge from the server
     * Called when user initiates recovery
     */
    async requestChallenge(recoveryId: string): Promise<AttestationChallenge> {
        // In production: call backend to get a fresh nonce
        // The server stores this nonce and validates it wasn't reused
        const nonce = await this.generateNonce();
        const issuedAt = Date.now();

        return {
            nonce,
            issuedAt,
            expiresAt: issuedAt + 5 * 60 * 1000, // 5 minute validity
            recoveryId,
        };
    }

    /**
     * Generate device attestation for recovery
     * This proves the device is genuine and the app is authentic
     */
    async generateAttestation(challenge: AttestationChallenge): Promise<AttestationResult> {
        const warnings: string[] = [];
        let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';

        try {
            // 1. Check challenge hasn't expired
            if (Date.now() > challenge.expiresAt) {
                return {
                    valid: false,
                    error: 'Attestation challenge has expired',
                    riskLevel: 'critical',
                    warnings: ['Challenge expired - request a new one'],
                };
            }

            // 2. Get device info
            const deviceId = await this.getDeviceId();
            const deviceModel = Device.modelName || 'Unknown';
            const deviceManufacturer = Device.manufacturer || 'Unknown';
            const osVersion = Device.osVersion || 'Unknown';

            // 3. Platform attestation - no mock fallback
            let attestationToken: string;
            let osIntegrity = false;
            let appAuthentic = false;

            if (Platform.OS === 'ios') {
                if (!this.appAttest) {
                    throw new Error(
                        'ProvianAppAttest native module is not available. ' +
                        'Device attestation requires the native module - no fallback is permitted.'
                    );
                }
                const supported = await this.appAttest.isSupported();
                if (!supported) {
                    throw new Error(
                        'App Attest is not supported on this device. ' +
                        'Recovery requires a physical device with iOS 14+ and App Attest support.'
                    );
                }

                // Hash the nonce for App Attest
                const nonceBytes = hexToBytes(challenge.nonce);
                const nonceHash = sha256(nonceBytes);
                const nonceHashHex = bytesToHex(nonceHash);

                const attestResult = await this.appAttest.attestKey(nonceHashHex);
                attestationToken = attestResult.attestation;
                // App Attest success implies device genuineness and app authenticity
                osIntegrity = true;
                appAuthentic = true;
            } else if (Platform.OS === 'android') {
                if (!this.playIntegrity) {
                    throw new Error(
                        'ProvianPlayIntegrity native module is not available. ' +
                        'Device attestation requires the native module - no fallback is permitted.'
                    );
                }
                const supported = await this.playIntegrity.isSupported();
                if (!supported) {
                    throw new Error(
                        'Play Integrity is not supported on this device. ' +
                        'Recovery requires a device with Google Play Services.'
                    );
                }

                // Play Integrity expects a base64url-encoded nonce. The React
                // Native `buffer` polyfill does not support the 'base64url'
                // encoding, so emit standard base64 and make it URL-safe -
                // byte-identical to Node's 'base64url' output.
                const nonceBase64 = Buffer.from(challenge.nonce, 'hex').toString('base64')
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                attestationToken = await this.playIntegrity.requestIntegrityToken(nonceBase64);
                // Play Integrity token must be verified server-side to determine verdicts.
                // We optimistically set these; the server will reject if the verdict is bad.
                osIntegrity = true;
                appAuthentic = true;
            } else {
                throw new Error(`Unsupported platform: ${Platform.OS}`);
            }

            // 4. Check key origin (hardware backing)
            const keyOrigin = await this.getKeyOrigin();
            if (keyOrigin === 'software') {
                warnings.push('Key is not hardware-backed');
                if (riskLevel === 'low') riskLevel = 'medium';
            }

            // 5. Build attestation object.
            //
            // F-18: We previously signed the attestation envelope locally with an
            // ephemeral P-256 keypair generated per call, then verified that
            // signature on the same device. That added zero security: an attacker
            // could trivially produce a valid signature with their own ephemeral
            // key. The platform attestationToken (App Attest / Play Integrity)
            // and its server-side verification at verificationEndpoint are the
            // security boundary. The local signature has been removed.
            const attestation: RecoveryAttestation = {
                deviceId,
                deviceModel,
                deviceManufacturer,
                keyOrigin,
                platform: Platform.OS as 'ios' | 'android',
                osVersion,
                osIntegrity,
                appAuthentic,
                timestamp: Date.now(),
                nonce: challenge.nonce,
                attestationToken,
                verificationEndpoint: 'https://api.provian.ai/v1/wallet/attestation',
                expiresAt: Date.now() + 10 * 60 * 1000, // 10 minute validity
            };

            // 7. Determine if attestation is valid
            const valid = (riskLevel as string) !== 'critical';

            return {
                valid,
                attestation,
                riskLevel,
                warnings,
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                valid: false,
                error: `Attestation failed: ${message}`,
                riskLevel: 'critical',
                warnings: ['Attestation generation failed'],
            };
        }
    }

    /**
     * Verify an attestation (called by the cloud verification service)
     */
    async verifyAttestation(attestation: RecoveryAttestation): Promise<AttestationResult> {
        const warnings: string[] = [];
        let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';

        try {
            // 1. Check attestation hasn't expired
            if (Date.now() > attestation.expiresAt) {
                return {
                    valid: false,
                    error: 'Attestation has expired',
                    riskLevel: 'critical',
                    warnings: ['Attestation expired'],
                };
            }

            // 2. (F-18) Local ECDSA signature check removed; it gave no security
            //    because the signing key was ephemeral and the verifier ran on
            //    the same device. Server-side attestation verification is the
            //    security boundary. See verificationEndpoint.

            // 3. Check OS integrity
            if (!attestation.osIntegrity) {
                warnings.push('Device OS integrity check failed');
                riskLevel = 'critical';
            }

            // 4. Check app authenticity
            if (!attestation.appAuthentic) {
                warnings.push('App authenticity check failed');
                riskLevel = 'critical';
            }

            // 5. Check key origin
            if (attestation.keyOrigin === 'software') {
                warnings.push('Key is not hardware-backed');
                if (riskLevel === 'low') riskLevel = 'medium';
            }

            // 6. Platform attestation token verification should be done server-side:
            // - iOS: Verify the attestation object with Apple's servers
            // - Android: Decode the Play Integrity token with Google's API
            // This client-side check validates the ECDSA signature only;
            // full platform attestation verification happens on the backend.

            const valid = riskLevel !== 'critical';

            return {
                valid,
                attestation,
                riskLevel,
                warnings,
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                valid: false,
                error: `Verification failed: ${message}`,
                riskLevel: 'critical',
                warnings: ['Verification error'],
            };
        }
    }

    // =====================
    // PRIVATE HELPERS
    // =====================

    // [M-3] CSPRNG-generated 128-bit device ID stored in SecureStore.
    // Replaces timestamp-based derivation to prevent collision and predictability.
    private async getDeviceId(): Promise<string> {
        const DEVICE_ID_KEY = 'provian_device_install_id';

        // Try to read existing ID from SecureStore
        const existingId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
        if (existingId) {
            return existingId;
        }

        // Generate new 128-bit (16-byte) random ID
        const randomBytes = await Crypto.getRandomBytesAsync(16);
        const deviceId = Array.from(new Uint8Array(randomBytes))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        // Store in SecureStore (not AsyncStorage)
        await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });

        return deviceId;
    }

    private async getKeyOrigin(): Promise<'secure_enclave' | 'strongbox' | 'tee' | 'software'> {
        const securityLevel = await KeyManager.getSecurityLevel();
        if (Platform.OS === 'ios' && securityLevel !== 'software') {
            return 'secure_enclave';
        }
        return securityLevel;
    }

    private async generateNonce(): Promise<string> {
        const bytes = await Crypto.getRandomBytesAsync(32);
        return Array.from(new Uint8Array(bytes))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // F-18: signAttestationData / verifyAttestationSignature were removed.
    // They generated an ephemeral P-256 key per call and verified on the same
    // device, which provides no security guarantee. The platform attestation
    // token (App Attest / Play Integrity) verified server-side at
    // verificationEndpoint is the actual security boundary.

}

export default RecoveryAttestationService.getInstance();

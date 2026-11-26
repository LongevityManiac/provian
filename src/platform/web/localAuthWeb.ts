/**
 * expo-local-authentication for the web app (Metro resolves the package here for web).
 * "Biometric" on the web is the wallet's passkey: Touch ID, Face ID, Windows Hello or a security
 * key, always with user verification. The prompt itself is WebUnlockHost.
 */
import { webAuthnAvailable } from './passkey';
import { hasVault, isVaultOpen } from './webVault';
import { requestVaultAccess } from './unlockRequests';

export enum AuthenticationType {
    FINGERPRINT = 1,
    FACIAL_RECOGNITION = 2,
    IRIS = 3,
}

export enum SecurityLevel {
    NONE = 0,
    SECRET = 1,
    BIOMETRIC_WEAK = 2,
    BIOMETRIC_STRONG = 3,
    BIOMETRIC = 2,
}

export interface LocalAuthenticationOptions {
    promptMessage?: string;
    cancelLabel?: string;
    disableDeviceFallback?: boolean;
    requireConfirmation?: boolean;
    fallbackLabel?: string;
    biometricsSecurityLevel?: string;
}

export type LocalAuthenticationResult =
    | { success: true }
    | { success: false; error: string; warning?: string };

export async function hasHardwareAsync(): Promise<boolean> {
    return webAuthnAvailable();
}

export async function isEnrolledAsync(): Promise<boolean> {
    return webAuthnAvailable();
}

export async function supportedAuthenticationTypesAsync(): Promise<AuthenticationType[]> {
    return webAuthnAvailable() ? [AuthenticationType.FINGERPRINT] : [];
}

export async function getEnrolledLevelAsync(): Promise<SecurityLevel> {
    return webAuthnAvailable() ? SecurityLevel.BIOMETRIC_STRONG : SecurityLevel.NONE;
}

export async function authenticateAsync(options: LocalAuthenticationOptions = {}): Promise<LocalAuthenticationResult> {
    if (!webAuthnAvailable()) return { success: false, error: 'not_available' };
    if (!hasVault()) return { success: false, error: 'not_enrolled' };
    try {
        await requestVaultAccess(options.promptMessage ?? '', isVaultOpen() ? 'presence' : 'unlock');
        return { success: true };
    } catch (err) {
        const code = (err as { code?: string })?.code;
        return { success: false, error: code === 'ERR_SEED_AUTH_CANCELLED' ? 'user_cancel' : 'authentication_failed' };
    }
}

export async function cancelAuthenticate(): Promise<void> {
    return undefined;
}

export default {
    AuthenticationType,
    SecurityLevel,
    hasHardwareAsync,
    isEnrolledAsync,
    supportedAuthenticationTypesAsync,
    getEnrolledLevelAsync,
    authenticateAsync,
    cancelAuthenticate,
};

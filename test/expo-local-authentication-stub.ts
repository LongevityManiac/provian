/**
 * Test stub for expo-local-authentication.
 *
 * The real package calls requireNativeModule('ExpoLocalAuthentication') at
 * load time, which throws in the node test environment because the native
 * module is not registered. This stub intercepts the import via vi.mock so
 * the package never executes its native bootstrap.
 *
 * Default behavior: hardware present, user enrolled, authenticateAsync
 * resolves with success: true. Tests that need rejection or other shapes
 * can override per-test with vi.mocked(...).mockResolvedValueOnce(...).
 */

export const AuthenticationType = {
    FINGERPRINT: 1,
    FACIAL_RECOGNITION: 2,
    IRIS: 3,
} as const;

export const SecurityLevel = {
    NONE: 0,
    SECRET: 1,
    BIOMETRIC_WEAK: 2,
    BIOMETRIC_STRONG: 3,
} as const;

export async function hasHardwareAsync(): Promise<boolean> {
    return true;
}

export async function isEnrolledAsync(): Promise<boolean> {
    return true;
}

export async function supportedAuthenticationTypesAsync(): Promise<number[]> {
    return [AuthenticationType.FINGERPRINT];
}

export async function getEnrolledLevelAsync(): Promise<number> {
    return SecurityLevel.BIOMETRIC_STRONG;
}

export interface LocalAuthenticationResult {
    success: boolean;
    error?: string;
    warning?: string;
}

export async function authenticateAsync(
    _options?: Record<string, unknown>,
): Promise<LocalAuthenticationResult> {
    return { success: true };
}

export async function cancelAuthenticate(): Promise<void> {
    return;
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

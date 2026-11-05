/**
 * ProvianAppAttest — JS interface for the native App Attest bridge (Trust Layer §2.9).
 *
 * App code goes through `src/core/security/AppAttest.ts`, which loads this module via
 * `requireOptionalNativeModule('ProvianAppAttest')` so it degrades cleanly (no witness, ordinary
 * class) when the native module is not in the build (Expo Go, simulator, Android).
 */
export interface ProvianAppAttestModule {
    isSupported(): boolean;
    /** Returns Apple's key identifier (base64). */
    generateKey(): Promise<string>;
    /** One-time attestation object (base64 CBOR) over a 32-byte clientDataHash (base64). */
    attestKey(keyId: string, clientDataHashBase64: string): Promise<string>;
    /** Per-request assertion (base64 CBOR) over a 32-byte clientDataHash (base64). */
    generateAssertion(keyId: string, clientDataHashBase64: string): Promise<string>;
}

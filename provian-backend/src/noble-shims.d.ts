/**
 * Type declarations for @noble subpath imports.
 *
 * The @noble packages use package.json "exports" for subpath resolution
 * (e.g. @noble/curves/p256), which requires moduleResolution "node16" or "bundler".
 * Since this codebase uses moduleResolution "node" (for CommonJS compatibility),
 * we provide manual declarations here.
 *
 * At runtime, Node.js resolves these correctly via the "exports" field -
 * this shim only fixes the TypeScript compilation.
 */

declare module '@noble/curves/nist.js' {
    export const p256: {
        ProjectivePoint: {
            fromHex(hex: string | Uint8Array): unknown;
        };
        verify(
            signature: Uint8Array,
            messageHash: Uint8Array,
            publicKey: Uint8Array,
        ): boolean;
        sign(
            messageHash: Uint8Array,
            privateKey: Uint8Array,
        ): { toCompactRawBytes(): Uint8Array };
        getPublicKey(privateKey: Uint8Array, isCompressed?: boolean): Uint8Array;
        utils: {
            randomPrivateKey(): Uint8Array;
        };
    };
}

declare module '@noble/hashes/utils.js' {
    export function hexToBytes(hex: string): Uint8Array;
    export function bytesToHex(bytes: Uint8Array): string;
}

// STEP 9 (Wave 4): the bare `@noble/curves/p256`, `@noble/hashes/sha256`,
// and `@noble/hashes/utils` subpaths are NOT in @noble/curves v2 / @noble/hashes
// v2 exports maps. `await import(...)` of those paths throws
// ERR_PACKAGE_PATH_NOT_EXPORTED at runtime. The previous shim made the
// compile-time experience deceptive by allowing imports that crash on
// first execution. All Wave-4 code paths use Node's webcrypto + Node's
// crypto.createHash instead, so these shims are gone.
//
// Tests that must touch noble go through the v2-correct paths
// (./nist.js / ./utils.js) declared above.

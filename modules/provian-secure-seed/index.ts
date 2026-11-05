/**
 * ProvianSecureSeed — JS interface for the native seed store.
 *
 * App code goes through `src/core/wallet/secureSeedStore.ts`, which loads this module via
 * `requireOptionalNativeModule('ProvianSecureSeed')`.
 *
 * Native contract (identical on iOS and Android):
 * - `setItemAsync` stores behind a user-authentication ACL that SURVIVES biometric re-enrollment
 * and admits the device passcode (iOS `.userPresence`; Android Keystore key with
 * `setInvalidatedByBiometricEnrollment(false)` + BIOMETRIC_STRONG | DEVICE_CREDENTIAL). It never
 * deletes any other item and never replaces an existing one (ERR_SEED_ITEM_EXISTS): a slot is
 * reused only after an explicit delete.
 * - `getItemAsync` resolves `null` ONLY when no item exists; every other failure rejects with one
 * of `SecureSeedErrorCode`. It never deletes anything.
 * - `hasItemAsync` and `probeItemAsync` never prompt. `probeItemAsync` reports 'invalidated' ONLY
 * when initialising a decrypt throws KeyPermanentlyInvalidatedException (Android); 'unrecoverable'
 * when the record file itself cannot be parsed; a key the Keystore reports MISSING is 'unknown'
 * (that lookup can be false transiently). iOS reports existence only.
 * - Android ERR_SEED_UNRECOVERABLE messages carry a stable `[cause:…]` tag: `invalidated`
 * (KeyPermanentlyInvalidatedException), `key_missing`, `unwrap_failed`, `integrity`, `malformed`.
 */
export type SecureSeedErrorCode =
    /** The user dismissed the prompt. Transient — retry later. */
    | 'ERR_SEED_AUTH_CANCELLED'
    /** Authentication did not succeed. Transient. */
    | 'ERR_SEED_AUTH_FAILED'
    /** No prompt could be shown right now (background, another prompt up, no authenticator). Transient. */
    | 'ERR_SEED_AUTH_UNAVAILABLE'
    /** The item exists but can never be decrypted (key missing/invalidated, integrity failure). */
    | 'ERR_SEED_UNRECOVERABLE'
    | 'ERR_SEED_WRITE_FAILED'
    /** `setItemAsync` refused: the named item exists. Nothing was changed. */
    | 'ERR_SEED_ITEM_EXISTS'
    | 'ERR_SEED_KEYCHAIN';

/** No-prompt classification of a stored item. */
export type SecureSeedProbe = 'absent' | 'present' | 'invalidated' | 'unrecoverable' | 'unknown';

export interface ProvianSecureSeedModule {
    isAvailable(): boolean;
    beginActionAsync(reason: string, allowPasscode: boolean, primarySlot: string): Promise<string>;
    endActionAsync(id: string): Promise<void>;
    isActionKeyAsync?(key: string, actionId: string): Promise<boolean>;
    signDeviceDigestAsync(keyId: string, digestHex: string, actionId: string): Promise<string>;
    hasLegacyItemAsync(key: string): Promise<boolean>;
    getLegacyItemAsync(key: string, prompt: string, actionId: string): Promise<string | null>;
    hasItemAsync(key: string): Promise<boolean>;
    probeItemAsync(key: string): Promise<SecureSeedProbe>;
    /** Adds a NEW item; rejects with ERR_SEED_ITEM_EXISTS if one exists. `prompt` is unused (kept for ABI). */
    setItemAsync(key: string, value: string, prompt: string, actionId?: string | null): Promise<boolean>;
    getItemAsync(key: string, prompt: string, actionId?: string | null): Promise<string | null>;
    deleteItemAsync(key: string): Promise<boolean>;
}

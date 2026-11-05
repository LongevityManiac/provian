/**
 * ProvianCloudKeychainSync - JS wrapper for the native iCloud Keychain / Drive module.
 *
 * The native modules live directly in the committed bare-workflow tree:
 *   - iOS: ios/Provian/ProvianCloudKeychainSync.swift uses SecItemAdd with
 *     kSecAttrSynchronizable = kCFBooleanTrue, using the keychain-access-group
 *     "$(AppIdentifierPrefix)ai.provian.cloudkeychain". This is what actually
 *     makes items sync via iCloud Keychain; expo-secure-store does NOT expose
 *     the synchronizable flag.
 *   - Android: android/app/src/main/java/com/provian/wallet/
 *     ProvianCloudKeychainSyncModule.kt uses Google Drive's appDataFolder
 *     (DriveScopes.DRIVE_APPDATA). Block Store was the previous backend, but
 *     it only restores during the OS setup wizard; Drive is retrievable any
 *     time the user is signed into the right Google account, which is what
 *     a sideloaded-APK install or fresh-phone recovery actually needs.
 *
 * Methods mirror the Swift/Kotlin surface: all calls return native promises.
 */

import { NativeModules, Platform } from 'react-native';

interface ProvianCloudKeychainSyncNative {
    /** Store utf8 `value` under `key`, sync-enabled. Resolves true on success. */
    store(key: string, value: string): Promise<boolean>;

    /** Retrieve utf8 value for `key`, or `null` if not found. */
    retrieve(key: string): Promise<string | null>;

    /** Delete the item under `key` from both sync and legacy locations. */
    deleteSyncedItem(key: string): Promise<boolean>;

    /**
     * Verify that `key` exists AND carries kSecAttrSynchronizable=true (iOS) or is
     * present in the Drive appDataFolder (Android). Resolves false when the item
     * was written but ended up in a local-only keychain - which indicates the
     * sync flag did not stick (usually an entitlements / access-group problem).
     */
    verifySync(key: string): Promise<boolean>;

    /**
     * Every key this module holds (iCloud Keychain synchronizable items in the service on iOS,
     * Drive appDataFolder backup files on Android). Keys only, never values. Absent on a native
     * build older than 2026-10-17 on iOS.
     */
    listKeys?(): Promise<string[]>;

    /** True iff the device is signed into iCloud (iOS) / signed into a Google account with Drive appDataFolder access (Android). */
    isSyncVerified(): Promise<boolean>;

    /**
     * iOS-only: read a legacy no-access-group keychain item and re-store it in the
     * correct access group with sync enabled. Noop on Android (the Drive
     * appDataFolder backend has no legacy local namespace to migrate from).
     */
    migrateAccessibility?(key: string): Promise<boolean>;

    /**
     * Android-only: explicitly trigger Google sign-in for the drive.appdata
     * scope. Resolves true once an account is available (already signed in
     * or completed sign-in). Rejects on cancel / no-activity. Required for
     * the recovery path on a fresh device install (F-04). iOS does not
     * implement this method; iCloud Keychain has no equivalent UI gate.
     */
    signIn?(): Promise<boolean>;
}

const nativeModule: ProvianCloudKeychainSyncNative | null =
    NativeModules.ProvianCloudKeychainSync || null;

/**
 * Whether the native module is linked. Returns false on web and on Expo Go
 * (where custom native modules are unavailable). Callers must branch on this
 * and surface an actionable error rather than silently losing data.
 */
export function isCloudKeychainAvailable(): boolean {
    return nativeModule !== null;
}

function requireModule(): ProvianCloudKeychainSyncNative {
    if (!nativeModule) {
        throw new Error(
            'ProvianCloudKeychainSync native module is not linked. ' +
                'Rebuild the native app (Expo Go does not include custom native modules).',
        );
    }
    return nativeModule;
}

/**
 * Store a value under `key` with cloud sync enabled (iCloud Keychain on iOS,
 * Google Drive encrypted app folder on Android).
 */
export async function storeSynced(key: string, value: string): Promise<void> {
    const mod = requireModule();
    await mod.store(key, value);
}

/**
 * Retrieve a previously stored value, or null if no item exists under `key`.
 */
export async function retrieveSynced(key: string): Promise<string | null> {
    const mod = requireModule();
    return mod.retrieve(key);
}

/**
 * Delete the item at `key` from both the sync-enabled and any legacy location.
 */
export async function deleteSynced(key: string): Promise<void> {
    const mod = requireModule();
    await mod.deleteSyncedItem(key);
}

/**
 * Every key held by the native store. Throws when the native build cannot enumerate (an iOS
 * build older than 2026-10-17): a caller that must find every wallet's backup cannot treat
 * "unknown" as "none".
 */
export async function listSyncedKeys(): Promise<string[]> {
    const mod = requireModule();
    if (!mod.listKeys) throw new Error('cloud_keychain_list_unsupported');
    const keys = await mod.listKeys();
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
}

/**
 * Post-write sanity check: confirm the item landed in the sync pool (iCloud
 * Keychain on iOS, Drive appDataFolder on Android). Returns false if the write
 * succeeded but the item did NOT end up synchronizable - that indicates
 * entitlement / access-group misconfiguration, and the caller should surface
 * the failure instead of letting the user believe they have cloud backup.
 */
export async function verifySync(key: string): Promise<boolean> {
    const mod = requireModule();
    return mod.verifySync(key);
}

/**
 * Check whether the OS-level sync path is available (iCloud account signed in
 * on iOS; Google account signed in with Drive appDataFolder access on Android).
 * When false, the device cannot successfully sync the backup to the cloud even
 * if store() succeeds locally.
 */
export async function isSyncAvailable(): Promise<boolean> {
    const mod = requireModule();
    return mod.isSyncVerified();
}

/**
 * Trigger Google Drive sign-in (Android only). Resolves true when an account
 * is available; rejects if the user cancels or no activity is present. On
 * iOS this is a no-op that resolves true (iCloud Keychain has no UI gate).
 *
 * F-04: recovery flows must invoke this before retrieve() on a fresh device
 * install, otherwise retrieve() returns null and the user is told there's no
 * backup when in fact they just need to authenticate.
 */
export async function signInForRecovery(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    const mod = requireModule();
    if (!mod.signIn) {
        // Older native module without signIn(); fall through to isSyncVerified
        // semantics. Caller will see false and surface the "sign in" prompt.
        return false;
    }
    return mod.signIn();
}

/**
 * Platform-aware label for the cloud target, used in user-facing copy.
 * Android previously read "Google Backup" when the Android implementation
 * was Block Store; with the Drive appDataFolder implementation we name the
 * actual destination so the recovery story ("sign into the same Google
 * account and open Provian") is legible to the user.
 */
export function cloudTargetLabel(): string {
    return Platform.OS === 'ios' ? 'iCloud Keychain' : 'Google Drive';
}

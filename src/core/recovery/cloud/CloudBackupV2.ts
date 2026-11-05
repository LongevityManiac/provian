import { withBiometricAction, assertBiometricAction, type BiometricAction } from '../../security/biometricAction';
/**
 * CloudBackupV2 - PIN-encrypted cloud backup of the BIP-39 mnemonic
 *
 * WHAT IS BACKED UP:
 * - The 12-word BIP-39 mnemonic (the only thing required to restore the wallet)
 * - Wallet address, chain IDs, device info (for display during recovery)
 *
 * ENCRYPTION:
 * - User-chosen backup password (6–64 characters) → PBKDF2 (600K iterations,
 *   SHA-256; legacy blobs record 100K and still decrypt) → 32-byte key
 * - AES-256-GCM encrypts the JSON payload (mnemonic included)
 * - Salt (32 bytes) + nonce (12 bytes) stored alongside ciphertext
 * - The cloud provider only ever sees opaque ciphertext
 *
 * STORAGE:
 * - iOS: native ProvianCloudKeychainSync module, which issues SecItemAdd with
 *   kSecAttrSynchronizable = kCFBooleanTrue in the "ai.provian.cloudkeychain"
 *   access group. This is what actually makes the item sync via iCloud Keychain.
 *   expo-secure-store does NOT expose the synchronizable flag, so an earlier
 *   revision that used SecureStore was writing device-local items despite the
 *   comment claiming otherwise. That bug is fixed here.
 * - Android: same native module, backed by Google Drive's appDataFolder
 *   (DriveScopes.DRIVE_APPDATA, app-private encrypted scope). Block Store was
 *   the previous backend; Drive replaces it because Block Store only restores
 *   during the OS setup wizard, while Drive is retrievable any time the user
 *   is signed into the right Google account.
 *
 * RECOVERY FLOW:
 * 1. Retrieve encrypted blob from cloud keychain (same native module, any device
 *    signed into the same Apple/Google account).
 * 2. User enters PIN → PBKDF2 derive key → AES-GCM decrypt (auth tag failure
 *    surfaces as a wrong-PIN error in the caller).
 * 3. SeedManager.importMnemonic(decrypted.mnemonic) restores the wallet.
 */

import { Platform } from 'react-native';
import SeedManager from '../../wallet/SeedManager';
import KeyManager from '../../security/KeyManager';
import securityLog from '../../security/securityLogger';
import { setItemHmac } from '../../security/hmacAsyncStorage';
import {
    storeSynced,
    retrieveSynced,
    deleteSynced,
    verifySync,
    isCloudKeychainAvailable,
    listSyncedKeys,
    signInForRecovery,
} from './ProvianCloudKeychainSync';
import {
    PRIMARY_BACKUP_KEY,
    WALLET_BACKUP_KEY_PREFIX,
    walletBackupKey,
    backupOwnerOf,
    resolveBackupTarget,
    listBackupEntries,
    walletHasBackup,
    walletBackupStatus,
    type WalletBackupStatus,
    backupKeysToDelete,
    type CloudBackupEntry,
    type OtherWalletBackupChoice,
} from './cloudBackupSlots';
import {
    encryptBackupEnvelope,
    decryptBackupEnvelope,
    validatePin,
    type CloudBackupPayload,
    type StoredBackup,
} from './cloudBackupEnvelope';
import { translate } from '../../../i18n/translate';

// The envelope crypto (types, KDF, encrypt/decrypt, iteration constants)
// lives in cloudBackupEnvelope.ts — a dependency-light module so the
// round trip is testable without the native module graph. This file owns
// device I/O: biometric session, keychain sync, verification, rollback.
export type { CloudBackupPayload, StoredBackup } from './cloudBackupEnvelope';
export type { CloudBackupEntry, OtherWalletBackupChoice, WalletBackupStatus } from './cloudBackupSlots';

// =============================================================================
// CONSTANTS
// =============================================================================

// The primary key; a wallet past the first on one cloud account has its own key (cloudBackupSlots.ts).
const STORE_KEY = PRIMARY_BACKUP_KEY;
const LAST_BACKUP_AT_KEY = '@provian_last_cloud_backup_at';

// Base, Arbitrum, Optimism - the three supported EVM chains. This array is
// EVM chain IDs only (used for display); the same single BIP-39 seed also
// derives the wallet's Solana address (ed25519, m/44'/501'/0'/0'), so one
// encrypted backup restores every chain including Solana.
const DEFAULT_CHAIN_IDS = [8453, 42161, 10];

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Create an encrypted cloud backup of the wallet's BIP-39 mnemonic.
 *
 * Reads the mnemonic from SeedManager, the wallet address from AsyncStorage,
 * encrypts the whole payload with the PIN-derived key, and stores it in
 * the cloud-synced keychain.
 *
 * @param pin - User-chosen PIN (6+ characters)
 */
/** The cloud account already holds a backup of a DIFFERENT wallet (or one whose owner it cannot tell). */
export class CloudBackupBelongsToOtherWalletError extends Error {
    readonly code = 'CLOUD_BACKUP_OTHER_WALLET' as const;
    constructor(readonly existingWalletAddress: string | null) {
        super(existingWalletAddress
            ? `The cloud account already holds a backup for wallet ${existingWalletAddress}`
            : 'The cloud account already holds a backup whose wallet cannot be identified');
        this.name = 'CloudBackupBelongsToOtherWalletError';
    }
}

export interface CreateCloudBackupOptions {
    /**
     * Replace a backup the cloud account holds for ANOTHER wallet (or one it cannot identify).
     * Never the default: the person confirms, knowing that wallet loses its cloud recovery.
     */
    replaceExisting?: boolean;
    /**
     * Keep the backup the cloud account holds for ANOTHER wallet and back this wallet up under
     * its own key : both wallets stay recoverable.
     */
    keepExisting?: boolean;
}

export async function createCloudBackup(pin: string, biometricAction?: BiometricAction, options: CreateCloudBackupOptions = {}): Promise<void> {
    validatePin(pin);

    // [Group 1 / M-2] Reading the mnemonic requires a biometric session.
    return await withBiometricAction(translate('biometricPrompts.confirmCloudBackup', 'Confirm cloud backup'), async (biometricAction) => {
        assertBiometricAction(biometricAction);

        const mnemonic = await SeedManager.getMnemonic(biometricAction);
        if (!mnemonic) {
            throw new Error('No mnemonic found: wallet not created');
        }

        // The wallet address is derived from the same seed, but we cache it in
        // the payload for fast display during recovery before the seed is rehydrated.
        // getEVMAddress() returns public material only and wipes the derived
        // private key internally.
        const address = await SeedManager.getEVMAddress(biometricAction);

        // A second wallet created on the same iCloud / Google account used to overwrite the
        // first wallet's only cloud recovery without a word. The primary is replaced freely only
        // for its own wallet (a re-backup); when it holds another wallet's backup — or one
        // written before the owner was recorded — the person chooses: Keep (this wallet gets its
        // own key, the other backup untouched) or Replace. A wallet that already has its own key
        // re-backs-up there without asking. A read failure is never taken as "empty"
        // writing the primary over a backup we could not read could destroy it.
        // Android: Drive answers `null` to a read while no Google account is signed in, and the
        // write below then signs in — so the check would see "empty" and the write would land on
        // the signed-in account's primary, over another wallet's backup. Sign in first so
        // the check reads the account the write will land on.
        if (Platform.OS === 'android' && !(await signInForRecovery())) {
            throw new Error('Sign in to Google Drive to back up this wallet.');
        }
        const choice: OtherWalletBackupChoice | undefined = options.keepExisting === true
            ? 'keep'
            : options.replaceExisting === true ? 'replace' : undefined;
        const target = resolveBackupTarget({
            address,
            primaryRaw: await retrieveSynced(STORE_KEY),
            walletKeyRaw: await retrieveSynced(walletBackupKey(address)),
            choice,
        });
        if (target.kind === 'ask') {
            throw new CloudBackupBelongsToOtherWalletError(target.existingWalletAddress);
        }
        const targetKey = target.key;

        const attestation = await KeyManager.getKeyAttestation();

        const payload: CloudBackupPayload = {
            mnemonic,
            wallet_address: address,
            chain_ids: DEFAULT_CHAIN_IDS,
            created_at: new Date().toISOString(),
            device_info: {
                platform: Platform.OS === 'ios' ? 'ios' : 'android',
                attestation_tier: attestation.tier,
            },
        };

        // Encrypt (async KDF — yields to the event loop so the UI stays live
        // through the 600K-iteration derivation).
        const stored: StoredBackup = { ...(await encryptBackupEnvelope(payload, pin)), wallet_address: address.toLowerCase() };

        if (!isCloudKeychainAvailable()) {
            throw new Error(
                'Cloud keychain native module is not linked. Rebuild the native app ' +
                '(Expo Go does not include custom native modules).',
            );
        }

        // Store as JSON via the native sync module (iCloud Keychain / Google Drive).
        await storeSynced(targetKey, JSON.stringify(stored));

        // Post-write verification: confirm the item carries the synchronizable flag
        // (iOS) or is retrievable from the Drive appDataFolder (Android). A write
        // that lands in a local-only keychain is worse than no backup - it gives
        // the user false confidence. If verification fails, we roll back and surface
        // the error.
        const synced = await verifySync(targetKey);
        if (!synced) {
            // Roll back the local-only write. Make a failed cleanup OBSERVABLE - a
            // swallowed delete error leaves an orphaned (unverified) backup blob
            // behind, which we should be able to see in logs. The user-facing error
            // below is unchanged.
            // Only the key this call wrote: a failed write under this wallet's own key never
            // touches the primary (another wallet's backup).
            await deleteSynced(targetKey).catch((err) => {
                securityLog.warn(
                    'CloudBackupV2',
                    `Failed to delete unverified backup during rollback (orphaned blob may remain): ${err instanceof Error ? err.message : String(err)
                    }`,
                );
            });
            throw new Error(
                'Backup did not land in the cloud-synced keychain. Verify iCloud / Google ' +
                'account is signed in and try again.',
            );
        }

        securityLog.log('CloudBackupV2', `Cloud backup created, stored, and sync verified (${targetKey === STORE_KEY ? 'primary' : 'own key'})`);

        // Last-backup timestamp for the Settings status indicator. Written only
        // after the cloud-side write and verifySync both succeed; not stored
        // inside the encrypted blob since reading it would otherwise require the
        // PIN. [Group 8 / chunk-i] HMAC-protected so a filesystem-access attacker
        // cannot spoof a recent timestamp to mislead the user about backup status.
        await setItemHmac(LAST_BACKUP_AT_KEY, new Date().toISOString());

    }, biometricAction);
}

/**
 * Retrieve and decrypt the cloud backup.
 *
 * @param pin - The PIN used during backup creation
 * @returns The decrypted backup payload (including the mnemonic), or null if no backup exists
 * @throws If the PIN is wrong (GCM auth tag verification fails)
 */
export async function retrieveCloudBackup(pin: string, key: string = STORE_KEY): Promise<CloudBackupPayload | null> {
    validatePin(pin);
    if (key !== STORE_KEY && !key.startsWith(WALLET_BACKUP_KEY_PREFIX)) {
        throw new Error('Not a cloud backup key');
    }

    const raw = await retrieveSynced(key);
    if (!raw) {
        securityLog.log('CloudBackupV2', 'No cloud backup found');
        return null;
    }

    let stored: StoredBackup;
    try {
        stored = JSON.parse(raw);
    } catch {
        securityLog.error('CloudBackupV2', 'Failed to parse stored backup');
        return null;
    }

    if (stored.version !== 2) {
        securityLog.error('CloudBackupV2', `Unsupported backup version: ${stored.version}`);
        return null;
    }

    // Decrypt (envelope-recorded iteration count, legacy fallback inside).
    // Throws if the password is wrong (GCM auth tag mismatch).
    const payload: CloudBackupPayload = await decryptBackupEnvelope(stored, pin);

    securityLog.log('CloudBackupV2', `Cloud backup retrieved for ${payload.wallet_address}`);
    return payload;
}

/**
 * Every backup the cloud account holds, without decrypting : the primary
 * and each wallet's own key. When the native build cannot enumerate keys, only the primary is
 * known — the caller is told so via `complete: false`.
 */
export async function listCloudBackups(): Promise<{ entries: CloudBackupEntry[]; complete: boolean }> {
    const primaryRaw = await retrieveSynced(STORE_KEY);
    let keys: string[] | null = null;
    try {
        keys = await listSyncedKeys();
    } catch (err) {
        securityLog.warn('CloudBackupV2', `Backup keys could not be listed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const walletKeys: Array<{ key: string; raw: string | null }> = [];
    for (const key of keys ?? []) {
        if (!key.startsWith(WALLET_BACKUP_KEY_PREFIX)) continue;
        walletKeys.push({ key, raw: await retrieveSynced(key).catch(() => null) });
    }
    return { entries: listBackupEntries({ primaryRaw, walletKeys }), complete: keys !== null };
}

/**
 * Check if a cloud backup exists (without decrypting). With a wallet address: whether THAT
 * wallet has a completed backup (the primary names it, or its own key holds one).
 */
export async function hasCloudBackup(forWalletAddress?: string): Promise<boolean> {
    if (forWalletAddress) {
        return walletHasBackup({
            address: forWalletAddress,
            primaryRaw: await retrieveSynced(STORE_KEY),
            walletKeyRaw: await retrieveSynced(walletBackupKey(forWalletAddress)),
        });
    }
    return (await listCloudBackups()).entries.length > 0;
}

/**
 * What the account holds for `forWalletAddress` (for display): `unidentified` is a
 * pre-2026-10-17 primary that names no wallet — possibly this wallet's backup, unprovable.
 */
export async function cloudBackupStatus(forWalletAddress: string): Promise<WalletBackupStatus> {
    return walletBackupStatus({
        address: forWalletAddress,
        primaryRaw: await retrieveSynced(STORE_KEY),
        walletKeyRaw: await retrieveSynced(walletBackupKey(forWalletAddress)),
    });
}

/** Which wallet the cloud account's primary backup is for, when the blob says; null when none or unknown. */
export async function cloudBackupWalletAddress(): Promise<string | null> {
    return backupOwnerOf(await retrieveSynced(STORE_KEY).catch(() => null));
}

/**
 * Delete a wallet's cloud backup: its own key, and the primary only when the primary names this
 * wallet. Another wallet's backup — or a primary that names no wallet, which may be another
 * wallet's only backup — is never deleted; `keptUnidentifiedBackup` says one was left.
 * Without an address (no wallet on the device), the primary alone, as before.
 */
export async function deleteCloudBackup(forWalletAddress?: string): Promise<{ deletedKeys: string[]; keptUnidentifiedBackup: boolean }> {
    const plan = forWalletAddress
        ? backupKeysToDelete({
            address: forWalletAddress,
            primaryRaw: await retrieveSynced(STORE_KEY),
            walletKeyRaw: await retrieveSynced(walletBackupKey(forWalletAddress)),
        })
        : { keys: [STORE_KEY], keptUnidentifiedPrimary: false };
    for (const key of plan.keys) await deleteSynced(key);
    securityLog.log('CloudBackupV2', `Cloud backup deleted (${plan.keys.length} key${plan.keys.length === 1 ? '' : 's'}${plan.keptUnidentifiedPrimary ? '; an unidentified backup was kept' : ''})`);
    return { deletedKeys: plan.keys, keptUnidentifiedBackup: plan.keptUnidentifiedPrimary };
}

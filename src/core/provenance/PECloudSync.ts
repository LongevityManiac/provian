import { registerSeedDerivedCache } from '../security/seedDerivedCache';
import { assertBiometricAction, withBiometricAction, isBiometricActionValid, type BiometricAction } from '../security/biometricAction';
/**
 * PECloudSync - month archives of the app's v1 activity records (on this device).
 *
 * - Batches the activity envelopes that leave the hot tier by month, into local files
 *   (`<documents>/pe_archives/`), encrypted AES-256-GCM with the seed-derived archive key.
 * - Those files are never deleted. Their cloud copy is no longer made here: the PE meter's
 *   encrypted file backup (core/meter/peCloudBackup.ts) puts every PE — and these envelopes —
 *   in the person's own iCloud / Google Drive, using this module's archive key so a recovered
 *   wallet can decrypt it.
 * - Archives an older build pushed to synced keychain items stay readable for recovery.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { ProvenanceEnvelope } from './types';
import { hashEnvelopeCanonical } from './peHash';

// Lazy-load expo-file-system/legacy. The static import previously here forced
// expo-file-system → expo-modules-core to resolve at module load, which both
// inflates startup cost (filesystem code is unused unless cloud sync runs) and
// breaks Vitest because expo-modules-core's source TS uses syntax the test
// transformer rejects. Loading on first use keeps PE machinery cheap.
type FSModule = typeof import('expo-file-system/legacy');
let _fsCache: FSModule | null = null;
async function getFS(): Promise<FSModule> {
    if (!_fsCache) {
        _fsCache = await import('expo-file-system/legacy');
    }
    return _fsCache;
}
import {
    CloudArchiveIndex,
    CloudArchiveFile,
    MonthlyArchiveEntry,
    getMonthKey,
    isLowPriorityPE,
} from './lifecycleTypes';
import { hasCloudBackup } from '../recovery/cloud/CloudBackupV2';
// Legacy cloud transport (synced iCloud Keychain items on iOS / Drive on Android): READ-ONLY now,
// for month archives a wallet pushed before the PE meter. New backups are files in the person's
// own iCloud Documents / Google Drive (core/meter/peCloudBackup.ts).
import { retrieveSynced } from '../recovery/cloud/ProvianCloudKeychainSync';
import SeedManager from '../wallet/SeedManager';
// AES-256-GCM (authenticated) — same primitive the seed cloud backup uses.
import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
// SECURITY FIX: F-5 - Import for PE signature verification
import ProvenanceEnvelopeManager from './ProvenanceEnvelopeManager';
import { translate } from '../../i18n/translate';

// Storage keys
const STORAGE_KEYS = {
    /** Local cache of cloud archive index */
    indexCache: 'provian_pe_cloud_index',
    /** Encryption key derivation salt (also mirrored into the cloud index so a
     *  restored device derives the SAME archive key from the same seed). */
    encryptionSalt: 'provian_pe_encryption_salt',
};

// Cloud transport keys (one entry per month archive + one index).
const CLOUD_INDEX_KEY = 'provian_pe_index';
const CLOUD_ARCHIVE_PREFIX = 'provian_pe_archive_';
// HKDF info label binding the derived key to this purpose + version.
const PE_ARCHIVE_KDF_INFO = 'provian-pe-archive-v2';
// Auth-gated device-only cache of the derived archive key so archival does not
// need the seed itself. [] It lives in the provian-secure-seed native store
// (user-presence ACL that survives biometric re-enrollment and admits the device
// passcode); the F14 expo-secure-store copy is migrated with a verified read-back
// and only then removed.
const archiveKeyPrompt = (): string => translate('biometricPrompts.unlockActivityArchive', 'Unlock your activity archive');

// File naming
const FILE_PREFIX = 'provian_pe_archive_';
const INDEX_FILE = 'provian_pe_index.enc';

// Local document directory for encrypted archives
const getArchiveDir = async (): Promise<string> => {
    const fs = await getFS();
    return `${fs.documentDirectory}pe_archives/`;
};

class PECloudSync {
    private static instance: PECloudSync;
    private encryptionKey: string | null = null;

    private constructor() {}

    static getInstance(): PECloudSync {
        if (!PECloudSync.instance) {
            PECloudSync.instance = new PECloudSync();
        }
        return PECloudSync.instance;
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    /**
     * Initialize cloud sync.
     * Ensures archive directory exists and loads encryption key.
     */
    /** Forget derived memory material on seed replacement; encrypted files and salts remain. */
    clearArchiveKeyCache(): void { this.encryptionKey = null; }

    async initialize(): Promise<void> {
        // Ensure archive directory exists
        const fs = await getFS();
        const archiveDir = await getArchiveDir();
        const dirInfo = await fs.getInfoAsync(archiveDir);
        if (!dirInfo.exists) {
            await fs.makeDirectoryAsync(archiveDir, { intermediates: true });
        }

        // NOTE: the archive encryption salt is NOT pre-generated here. It is
        // resolved lazily by getArchiveSalt() with cloud-recovery precedence
        // (local cache -> cloud index -> generate). Pre-generating a fresh salt
        // on a recovered device would derive the WRONG key and make the cloud
        // archives undecryptable.

        console.log('[PECloudSync] Initialized');
    }

    // =========================================================================
    // SYNC TO CLOUD
    // =========================================================================

    /**
     * Sync PEs to cloud storage.
     * Groups by month and updates archives.
     */
    async syncPEsToCloud(pes: ProvenanceEnvelope[], biometricAction?: BiometricAction): Promise<void> {
        if (pes.length === 0) return;

        console.log(`[PECloudSync] Syncing ${pes.length} PEs to cloud...`);

        // Group PEs by month
        const byMonth = new Map<string, ProvenanceEnvelope[]>();
        for (const pe of pes) {
            const month = getMonthKey(pe.timestamp);
            if (!byMonth.has(month)) {
                byMonth.set(month, []);
            }
            byMonth.get(month)!.push(pe);
        }

        // Load current index
        let index = await this.getCloudArchiveIndex();
        if (!index) {
            index = this.createEmptyIndex();
        }

        // Update each month's archive
        for (const [monthKey, monthPEs] of byMonth) {
            await this.updateMonthArchive(monthKey, monthPEs, index, biometricAction);
        }

        // Update index totals
        index.totalPECount = index.archives.reduce((sum, a) => sum + a.peCount, 0);
        index.lastSyncAt = Date.now();
        // Mirror the archive salt into the index so a restored device can derive
        // the SAME key from the same seed. The salt is not secret.
        index.encryptionSalt = await this.getArchiveSalt();

        // Update boundary hashes
        if (index.archives.length > 0) {
            const sorted = [...index.archives].sort((a, b) => a.firstTimestamp - b.firstTimestamp);
            index.oldestArchiveFirstHash = sorted[0].firstPEHash;
            index.newestArchiveLastHash = sorted[sorted.length - 1].lastPEHash;
        }

        // Save updated index
        await this.saveCloudArchiveIndex(index);

        // Sync to actual cloud storage
        await this.pushToCloud();

        console.log(`[PECloudSync] Sync complete: ${pes.length} PEs across ${byMonth.size} months`);
    }

    /**
     * Update a single month's archive.
     */
    private async updateMonthArchive(
        monthKey: string,
        newPEs: ProvenanceEnvelope[],
        index: CloudArchiveIndex, biometricAction?: BiometricAction
    ): Promise<void> {
        const fileName = `${FILE_PREFIX}${monthKey.replace('-', '_')}.enc`;
        const filePath = `${await getArchiveDir()}${fileName}`;

        // Load existing archive or create new
        let archive: CloudArchiveFile;
        let existingEntry = index.archives.find(a => a.monthKey === monthKey);

        if (existingEntry) {
            // Load and decrypt existing archive
            archive = await this.loadArchiveFile(filePath, biometricAction);
        } else {
            // Create new archive
            archive = {
                version: 1,
                monthKey,
                envelopes: [],
                checksum: '',
            };
        }

        // Add new PEs (avoid duplicates)
        const existingIds = new Set(archive.envelopes.map(pe => pe.envelope_id));
        for (const pe of newPEs) {
            if (!existingIds.has(pe.envelope_id)) {
                archive.envelopes.push(pe);
            }
        }

        // Sort by timestamp
        archive.envelopes.sort((a, b) => a.timestamp - b.timestamp);

        // Update checksum
        archive.checksum = await this.computeArchiveChecksum(archive.envelopes);

        // Save encrypted archive
        await this.saveArchiveFile(filePath, archive, biometricAction);

        // Update index entry
        const lowPriorityCount = archive.envelopes.filter(isLowPriorityPE).length;
        const firstPE = archive.envelopes[0];
        const lastPE = archive.envelopes[archive.envelopes.length - 1];

        const entry: MonthlyArchiveEntry = {
            fileName,
            monthKey,
            peCount: archive.envelopes.length,
            firstPEHash: await this.hashEnvelope(firstPE),
            lastPEHash: await this.hashEnvelope(lastPE),
            firstPEId: firstPE.envelope_id,
            lastPEId: lastPE.envelope_id,
            firstTimestamp: firstPE.timestamp,
            lastTimestamp: lastPE.timestamp,
            sizeBytes: new TextEncoder().encode(JSON.stringify(archive.envelopes)).length,
            lowPriorityCount,
        };

        if (existingEntry) {
            Object.assign(existingEntry, entry);
        } else {
            index.archives.push(entry);
        }
    }

    // =========================================================================
    // RETRIEVAL FROM CLOUD
    // =========================================================================

    /**
     * Fetch PEs by month.
     */
    async fetchPEsByMonth(monthKey: string, biometricAction?: BiometricAction): Promise<ProvenanceEnvelope[]> {
        const index = await this.getCloudArchiveIndex();
        if (!index) return [];

        const entry = index.archives.find(a => a.monthKey === monthKey);
        if (!entry) return [];

        const filePath = `${await getArchiveDir()}${entry.fileName}`;

        // Check if we need to pull from cloud
        const fs = await getFS();
        const fileInfo = await fs.getInfoAsync(filePath);
        if (!fileInfo.exists) {
            await this.pullFromCloud(entry.fileName);
        }

        const archive = await this.loadArchiveFile(filePath, biometricAction);
        return archive.envelopes;
    }

    /**
     * Fetch PEs by date range.
     */
    async fetchPEsByDateRange(startDate: number, endDate: number, biometricAction?: BiometricAction): Promise<ProvenanceEnvelope[]> {
        const index = await this.getCloudArchiveIndex();
        if (!index) return [];

        const result: ProvenanceEnvelope[] = [];

        // Find relevant month archives
        for (const entry of index.archives) {
            // Check if this archive overlaps with the date range
            if (entry.lastTimestamp < startDate || entry.firstTimestamp > endDate) {
                continue;
            }

            const pes = await this.fetchPEsByMonth(entry.monthKey, biometricAction);
            for (const pe of pes) {
                if (pe.timestamp >= startDate && pe.timestamp <= endDate) {
                    result.push(pe);
                }
            }
        }

        return result;
    }

    /**
     * Fetch a specific PE by ID (searches all archives).
     */
    async fetchPEById(envelopeId: string, biometricAction?: BiometricAction): Promise<ProvenanceEnvelope | null> {
        const index = await this.getCloudArchiveIndex();
        if (!index) return null;

        for (const entry of index.archives) {
            // Check if this archive might contain the PE
            if (entry.firstPEId === envelopeId || entry.lastPEId === envelopeId) {
                const pes = await this.fetchPEsByMonth(entry.monthKey, biometricAction);
                const found = pes.find(pe => pe.envelope_id === envelopeId);
                if (found) return found;
            }
        }

        // Full search if not found by quick check
        for (const entry of index.archives) {
            const pes = await this.fetchPEsByMonth(entry.monthKey, biometricAction);
            const found = pes.find(pe => pe.envelope_id === envelopeId);
            if (found) return found;
        }

        return null;
    }

    // =========================================================================
    // INDEX MANAGEMENT
    // =========================================================================

    /**
     * Get cloud archive index.
     */
    async getCloudArchiveIndex(): Promise<CloudArchiveIndex | null> {
        const cached = await AsyncStorage.getItem(STORAGE_KEYS.indexCache);
        if (cached) {
            return JSON.parse(cached);
        }
        // Recovery path: local cache empty (e.g. fresh device after reinstall).
        // Pull the index from the cloud if a backup exists and repopulate the
        // cache. The index is plaintext metadata (hashes / counts / salt) — no
        // PE payloads — so it needs no decryption key to read.
        try {
            if (await hasCloudBackup()) {
                const remote = await retrieveSynced(CLOUD_INDEX_KEY);
                if (remote) {
                    await AsyncStorage.setItem(STORAGE_KEYS.indexCache, remote);
                    return JSON.parse(remote);
                }
            }
        } catch (err) {
            console.warn('[PECloudSync] Cloud index pull failed:', err);
        }
        return null;
    }

    /**
     * Save cloud archive index.
     */
    private async saveCloudArchiveIndex(index: CloudArchiveIndex): Promise<void> {
        await AsyncStorage.setItem(STORAGE_KEYS.indexCache, JSON.stringify(index));
    }

    /**
     * Create empty index.
     */
    private createEmptyIndex(): CloudArchiveIndex {
        return {
            version: 1,
            walletAddress: '', // Will be set on first sync
            totalPECount: 0,
            lastSyncAt: Date.now(),
            archives: [],
            oldestArchiveFirstHash: '',
            newestArchiveLastHash: '',
        };
    }

    // =========================================================================
    // FILE OPERATIONS
    // =========================================================================

    /**
     * Load and decrypt an archive file.
     * SECURITY FIX: F-5 - Verify archive checksum after decryption.
     */
    private async loadArchiveFile(filePath: string, biometricAction?: BiometricAction): Promise<CloudArchiveFile> {
        const fs = await getFS();
        const encrypted = await fs.readAsStringAsync(filePath);
        const decrypted = await this.decrypt(encrypted, biometricAction);
        const archive: CloudArchiveFile = JSON.parse(decrypted);

        // SECURITY FIX: F-5 - Verify the archive checksum matches computed checksum
        if (archive.checksum && archive.envelopes.length > 0) {
            const computedChecksum = await this.computeArchiveChecksum(archive.envelopes);
            if (computedChecksum !== archive.checksum) {
                console.error(
                    `[PECloudSync] INTEGRITY FAILURE: Archive checksum mismatch for ${archive.monthKey}`,
                    `Expected: ${archive.checksum.slice(0, 16)}..., Got: ${computedChecksum.slice(0, 16)}...`
                );
                throw new Error(`Archive integrity check failed: checksum mismatch for ${archive.monthKey}`);
            }
        }

        // SECURITY FIX: F-5 - Verify PE signatures for cloud archives
        if (archive.envelopes.length > 0) {
            const sigResult = await ProvenanceEnvelopeManager.verifyAllPESignatures(archive.envelopes);
            if (sigResult.tamperedIds.length > 0) {
                console.error(
                    `[PECloudSync] SIGNATURE TAMPERING DETECTED in archive ${archive.monthKey}:`,
                    `${sigResult.tamperedIds.length} tampered PEs`
                );
                // Log the tampered IDs but don't throw - let caller decide how to handle
                // This preserves access to valid PEs while flagging the issue
            }
        }

        return archive;
    }

    /**
     * Encrypt and save an archive file.
     */
    private async saveArchiveFile(filePath: string, archive: CloudArchiveFile, biometricAction?: BiometricAction): Promise<void> {
        const json = JSON.stringify(archive);
        const encrypted = await this.encrypt(json, biometricAction);
        const fs = await getFS();
        await fs.writeAsStringAsync(filePath, encrypted);
    }

    // =========================================================================
    // CLOUD STORAGE OPERATIONS
    // =========================================================================

    /**
     * Map a local archive file name (or the index file) to its cloud transport
     * key. Handles both the underscore form on disk (provian_pe_archive_2026_06)
     * and a dash form, normalising to a dash key.
     */
    private cloudKeyForFile(fileName: string): string {
        if (fileName === INDEX_FILE) return CLOUD_INDEX_KEY;
        const match = fileName.match(/(\d{4})[-_](\d{2})\.enc$/);
        if (!match) throw new Error(`Unrecognised archive filename: ${fileName}`);
        return `${CLOUD_ARCHIVE_PREFIX}${match[1]}-${match[2]}`;
    }

    /**
     * Formerly: push the month archives + a plaintext index to synced keychain items. Retired by
     * the PE meter (see the body). Moving a PE from the hot tier into a month archive no longer
     * depends on any upload, because the archive is a local file that is never deleted, and the
     * cloud copy is made by the PE meter's own encrypted file backup.
     */
    private async pushToCloud(): Promise<void> {
        // PE METER : the month archives are no longer pushed to synced keychain
        // items. That transport is size-limited and is not app storage (it is why iCloud showed no
        // Provian storage at all). Every PE — these v1 envelopes included, as legacy history and as
        // each PE v2's detail record — is now backed up, encrypted, as FILES in the person's own
        // iCloud Documents container / Google Drive appDataFolder by `core/meter/peCloudBackup.ts`.
        // The month archive written above stays on this device (it is never deleted); archives a
        // wallet already pushed to the keychain remain readable by `pullFromCloud` for recovery.
        return;
    }

    // =========================================================================
    // PE METER — the archive key, for the encrypted PE backup (core/meter/peCloudBackup.ts)
    // =========================================================================

    /**
     * The archive salt + key WITHOUT any prompt: the in-memory key, or one derived from the seed
     * while a biometric session is already live. Null when neither is available right now.
     * A scheduling flag never opens UI; an explicit user action must supply its live capability.
     */
    async getArchiveKeyForBackup(options: { allowPrompt: boolean; biometricAction?: BiometricAction }, biometricAction?: BiometricAction): Promise<{ saltHex: string; keyHex: string } | null> {
        biometricAction ??= options.biometricAction;
        const saltHex = await this.getArchiveSalt();
        if (this.encryptionKey) return { saltHex, keyHex: this.encryptionKey };
        if (isBiometricActionValid(biometricAction)) {
            return { saltHex, keyHex: await this.getEncryptionKey(biometricAction) };
        }
        // Scheduling flags never authorize new native UI. Explicit actions own their gate.
        return null;
    }

    /** The archive key for a given salt (a backup started by another phone of this wallet). Needs the seed. */
    async getArchiveKeyForSalt(saltHex: string, options: { allowPrompt: boolean; biometricAction?: BiometricAction }, biometricAction?: BiometricAction): Promise<string | null> {
        biometricAction ??= options.biometricAction;
        if (this.encryptionKey && saltHex === (await AsyncStorage.getItem(STORAGE_KEYS.encryptionSalt))) return this.encryptionKey;
        if (!isBiometricActionValid(biometricAction)) return null;
        return await withBiometricAction(archiveKeyPrompt(), async action => {
            const mnemonic = await SeedManager.getMnemonic(action);
            if (!mnemonic) return null;
            return bytesToHex(hkdf(sha256, utf8ToBytes(mnemonic), hexToBytes(saltHex), utf8ToBytes(PE_ARCHIVE_KDF_INFO), 32));
        }, biometricAction);
    }

    /** Use this salt + key from now on (the backup this phone joined or restored from). */
    async adoptArchiveKey(saltHex: string, keyHex: string): Promise<void> {
        await AsyncStorage.setItem(STORAGE_KEYS.encryptionSalt, saltHex);
        this.encryptionKey = keyHex;
    }

    /**
     * Pull a specific archive file (or the index) from cloud storage and write
     * it to the local archive dir so loadArchiveFile can read it. Throws if the
     * cloud item is missing.
     */
    private async pullFromCloud(fileName: string): Promise<void> {
        if (!(await hasCloudBackup())) {
            throw new Error('Cloud backup not configured');
        }

        const cloudKey = this.cloudKeyForFile(fileName);
        const content = await retrieveSynced(cloudKey);
        if (content === null || content === undefined) {
            throw new Error(`Cloud archive not found: ${fileName}`);
        }

        const fs = await getFS();
        const archiveDir = await getArchiveDir();
        const dirInfo = await fs.getInfoAsync(archiveDir);
        if (!dirInfo.exists) {
            await fs.makeDirectoryAsync(archiveDir, { intermediates: true });
        }
        await fs.writeAsStringAsync(`${archiveDir}${fileName}`, content);
    }

    // =========================================================================
    // ENCRYPTION
    // =========================================================================

    /**
     * Encrypt an archive for cloud storage with AES-256-GCM (authenticated).
     * The key is derived from the wallet seed (recoverable after seed restore),
     * NOT a per-device secret — see getEncryptionKey. Replaces the prior XOR
     * stream cipher, which was not encryption.
     */
    private async encrypt(data: string, biometricAction?: BiometricAction): Promise<string> {
        const key = hexToBytes(await this.getEncryptionKey(biometricAction)); // 32 bytes
        const nonceRaw = await Crypto.getRandomBytesAsync(12); // 96-bit GCM nonce
        const nonce = nonceRaw instanceof Uint8Array ? nonceRaw : new Uint8Array(nonceRaw);
        const cipher = gcm(key, nonce);
        const ciphertext = cipher.encrypt(new TextEncoder().encode(data));
        return JSON.stringify({
            version: 2,
            alg: 'AES-256-GCM',
            nonce: bytesToHex(nonce),
            data: bytesToHex(ciphertext), // GCM ciphertext includes the auth tag
        });
    }

    /**
     * Decrypt an archive. Version 2 = AES-256-GCM (authenticated: decrypt throws
     * on any tamper or wrong key). Version 1 = legacy XOR — read-only support so
     * archives written on-device before the AES migration still load; those used
     * a per-device key (getLegacyDeviceKey).
     */
    private async decrypt(encryptedJson: string, biometricAction?: BiometricAction): Promise<string> {
        const parsed = JSON.parse(encryptedJson);

        if (parsed.version === 2 || parsed.alg === 'AES-256-GCM') {
            const key = hexToBytes(await this.getEncryptionKey(biometricAction));
            const nonce = hexToBytes(parsed.nonce);
            const decipher = gcm(key, nonce);
            const plaintext = decipher.decrypt(hexToBytes(parsed.data)); // throws on auth failure
            return new TextDecoder().decode(plaintext);
        }

        // Legacy v1 (XOR) — local-only archives from before the AES migration.
        const { iv, data, hmac } = parsed;
        const legacyKey = await this.getLegacyDeviceKey();
        const expectedHmac = await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            iv + data + legacyKey
        );
        if (hmac !== expectedHmac) {
            throw new Error('Archive integrity check failed');
        }
        return this.xorDecrypt(data, legacyKey, iv);
    }

    /**
     * Derive the AES-256-GCM archive key from the WALLET SEED (recoverable),
     * not a per-device secret.
     *
     * This is the fix that makes cross-device recovery possible: the previous
     * key was SHA256(per-device-salt + per-device-secret), so archives encrypted
     * on one device could never be decrypted on a restored device — the "backup"
     * was unrecoverable by construction. Now key = HKDF-SHA256(mnemonic, salt,
     * info) with the salt mirrored into the cloud index, so any device that
     * restores the same seed derives the identical key.
     */
    private async getEncryptionKey(biometricAction?: BiometricAction): Promise<string> {
        if (this.encryptionKey) return this.encryptionKey;
        assertBiometricAction(biometricAction); // Background archival never initiates authentication.
        return await withBiometricAction(archiveKeyPrompt(), async action => {
            const saltHex = await this.getArchiveSalt();
            const mnemonic = await SeedManager.getMnemonic(action);
            if (!mnemonic) throw new Error('[PECloudSync] Cannot derive archive key: no wallet seed available');
            const bytes = hkdf(sha256, utf8ToBytes(mnemonic), hexToBytes(saltHex), utf8ToBytes(PE_ARCHIVE_KDF_INFO), 32);
            try { this.encryptionKey = bytesToHex(bytes); return this.encryptionKey; }
            finally { bytes.fill(0); }
        }, biometricAction);
    }

    /**
     * Resolve the archive KDF salt with cloud-recovery precedence:
     *   1. local cache (normal operation)
     *   2. the cloud index's `encryptionSalt` (restored device — derives the
     *      SAME key as the device that wrote the archives)
     *   3. generate a fresh salt (first-ever use; it gets mirrored into the
     *      index on the next push)
     * The salt is not secret; storing it in the plaintext index is safe.
     */
    private async getArchiveSalt(): Promise<string> {
        const cached = await AsyncStorage.getItem(STORAGE_KEYS.encryptionSalt);
        if (cached) return cached;

        try {
            const index = await this.getCloudArchiveIndex();
            if (index?.encryptionSalt) {
                await AsyncStorage.setItem(STORAGE_KEYS.encryptionSalt, index.encryptionSalt);
                return index.encryptionSalt;
            }
        } catch (err) {
            console.warn('[PECloudSync] Could not recover archive salt from cloud index:', err);
        }

        const saltRaw = await Crypto.getRandomBytesAsync(16);
        const salt = this.bytesToHex(saltRaw instanceof Uint8Array ? saltRaw : new Uint8Array(saltRaw));
        await AsyncStorage.setItem(STORAGE_KEYS.encryptionSalt, salt);
        return salt;
    }

    /**
     * Legacy per-device archive key (SHA256(salt + device-secret + label)).
     * Read-only: used solely to decrypt v1 (XOR) archives written on this device
     * before the AES-256-GCM migration. Never used for new writes.
     */
    private async getLegacyDeviceKey(): Promise<string> {
        const salt = await AsyncStorage.getItem(STORAGE_KEYS.encryptionSalt);
        const SECURE_KEY = 'provian_device_secret';
        const deviceSecret = await SecureStore.getItemAsync(SECURE_KEY);
        if (!deviceSecret) {
            throw new Error('Legacy archive key unavailable (no device secret)');
        }
        return Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            salt + deviceSecret + 'pe_archive_key'
        );
    }

    /**
     * XOR decrypt (legacy v1 archives only).
     */
    private xorDecrypt(encrypted: string, key: string, iv: string): string {
        const combined = iv + key;
        const data = Buffer.from(encrypted, 'base64').toString();
        let result = '';
        for (let i = 0; i < data.length; i++) {
            const charCode = data.charCodeAt(i) ^ combined.charCodeAt(i % combined.length);
            result += String.fromCharCode(charCode);
        }
        return result;
    }

    // =========================================================================
    // HELPERS
    // =========================================================================

    /**
     * Hash a PE. Delegates to the single canonical hasher (peHash.ts) so the
     * archive-index firstPEHash/lastPEHash match the chain hashes used
     * everywhere else (the prior local JSON.stringify(pe) included the
     * signature and was non-canonical).
     */
    private async hashEnvelope(pe: ProvenanceEnvelope): Promise<string> {
        return hashEnvelopeCanonical(pe);
    }

    /**
     * Compute archive checksum.
     */
    private async computeArchiveChecksum(pes: ProvenanceEnvelope[]): Promise<string> {
        const ids = pes.map(pe => pe.envelope_id).join('|');
        return await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            ids
        );
    }

    /**
     * Convert bytes to hex string.
     */
    private bytesToHex(bytes: Uint8Array): string {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }
}

const cloudSync = PECloudSync.getInstance();
registerSeedDerivedCache(() => cloudSync.clearArchiveKeyCache());
export default cloudSync;

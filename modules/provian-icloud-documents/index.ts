/**
 * ProvianICloudDocuments — JS interface for the iCloud ubiquity-container bridge (PE meter backup).
 *
 * App code goes through `src/core/meter/cloudFiles.ts` (`createICloudFiles`), which loads this module
 * with `requireOptionalNativeModule('ProvianICloudDocuments')` so a build without it (Expo Go,
 * Android, tests) reports the cloud as unavailable instead of crashing. The interface the app uses is
 * declared there (`ProvianICloudDocumentsModule`); this file only names the module.
 *
 * Every file this module writes is ciphertext produced by `peCloudBackup.ts` (AES-256-GCM, key derived
 * from the recovery phrase). The module never sees a key or a readable PE.
 */
export const MODULE_NAME = 'ProvianICloudDocuments';
export const ICLOUD_CONTAINER_ID = 'iCloud.com.provian.wallet';
export const PE_BACKUP_FOLDER = 'PEBackup';

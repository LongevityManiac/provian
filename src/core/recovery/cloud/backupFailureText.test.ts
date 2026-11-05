import { describe, it, expect } from 'vitest';
import { backupFailureKey } from './backupFailureText';

describe('a failed cloud backup reads in plain words', () => {
    it('each technical failure the backup layer throws maps to its own plain message', () => {
        expect(backupFailureKey(new Error('Sign in to Google Drive to back up this wallet.'))).toBe('cloudBackupConfirm.errorSignIn');
        expect(backupFailureKey(new Error('Cloud keychain native module is not linked. Rebuild the native app (Expo Go does not include custom native modules).'))).toBe('cloudBackupConfirm.errorCloudUnavailable');
        expect(backupFailureKey(new Error('Backup did not land in the cloud-synced keychain. Verify iCloud / Google account is signed in and try again.'))).toBe('cloudBackupConfirm.errorNotSynced');
    });
    it('anything else is the generic message, never the raw text', () => {
        expect(backupFailureKey(new Error('errSecInteractionNotAllowed -25308'))).toBe('cloudBackupConfirm.errorGeneric');
        expect(backupFailureKey(undefined)).toBe('cloudBackupConfirm.errorGeneric');
    });
});

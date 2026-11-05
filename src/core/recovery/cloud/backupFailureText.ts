/**
 * What a failed cloud backup says to a person. The backup layer throws technical messages (for
 * logs); the screen shows what happened in plain words, and every one of them offers the
 * recovery-phrase backup instead.
 */
export type BackupFailureKey =
    | 'cloudBackupConfirm.errorSignIn'
    | 'cloudBackupConfirm.errorCloudUnavailable'
    | 'cloudBackupConfirm.errorNotSynced'
    | 'cloudBackupConfirm.errorGeneric';

export function backupFailureKey(error: unknown): BackupFailureKey {
    const text = error instanceof Error ? error.message : String(error ?? '');
    if (/sign in|signed in|sign-in|signin|account/i.test(text) && !/did not land/i.test(text)) return 'cloudBackupConfirm.errorSignIn';
    if (/not linked|native module|unavailable|not available|no icloud|Expo Go/i.test(text)) return 'cloudBackupConfirm.errorCloudUnavailable';
    if (/did not land|sync|verify/i.test(text)) return 'cloudBackupConfirm.errorNotSynced';
    return 'cloudBackupConfirm.errorGeneric';
}

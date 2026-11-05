/**
 * What a failed wallet creation says to a person. The key and keychain layers throw technical
 * messages (for logs); the screen shows what happened in plain words.
 */
export type WalletCreateFailureKey = 'biometricSetup.errorNoScreenLock' | 'biometricSetup.errorCreateFailed';

export function walletCreateFailureKey(error: unknown): WalletCreateFailureKey {
    const text = error instanceof Error ? error.message : String(error ?? '');
    // Android: a key that needs user authentication cannot exist without a secure lock screen, and
    // the keystore says so. iOS reports a phone with no passcode as a failed authentication
    // (ERR_SEED_AUTH_FAILED), which reads as the plain generic message; the passcode patterns only
    // match if a lower layer ever passes that text through.
    if (/lock screen|passcode not set|passcodenotset|no passcode|-25291/i.test(text)) return 'biometricSetup.errorNoScreenLock';
    return 'biometricSetup.errorCreateFailed';
}

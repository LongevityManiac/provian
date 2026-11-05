/**
 * The recovery-phrase backup: the fallback for everyone whose phone cannot reach iCloud Keychain or
 * Google Drive. The person sees the wallet's recovery phrase, writes it down, and proves it by
 * entering three of its words. That counts as this wallet's backup, on the create path and the
 * restore path alike, and clears the backup gate exactly as a cloud backup does.
 *
 * The confirmation (the wallet's address, lowercase) is not sensitive and lives in AsyncStorage;
 * the phrase itself is never stored by this module.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const PHRASE_BACKUP_KEY = '@provian_phrase_backup_confirmed_v1';
/** The "no backup yet" banner's flag (`BackupNotConfiguredBanner`); a confirmed phrase is a backup. */
export const BACKUP_SKIPPED_KEY = '@provian_backup_skipped';

export async function markPhraseBackupConfirmed(address: string): Promise<void> {
    await AsyncStorage.setItem(PHRASE_BACKUP_KEY, address.toLowerCase());
    await AsyncStorage.setItem(BACKUP_SKIPPED_KEY, 'false');
}

export async function hasPhraseBackup(address: string): Promise<boolean> {
    const value = await AsyncStorage.getItem(PHRASE_BACKUP_KEY);
    return value !== null && value === address.toLowerCase();
}

/** Three distinct word positions (0-based, ascending) to ask for. `random` is injectable for tests. */
export function pickCheckPositions(wordCount: number, random: () => number = Math.random): number[] {
    if (wordCount < 3) throw new Error('recovery phrase too short');
    const picked = new Set<number>();
    while (picked.size < 3) picked.add(Math.min(wordCount - 1, Math.floor(random() * wordCount)));
    return [...picked].sort((a, b) => a - b);
}

/** Whether every answer matches its word (trimmed, case-insensitive). Any missing answer fails. */
export function checkWords(words: readonly string[], positions: readonly number[], answers: readonly string[]): boolean {
    if (positions.length === 0 || answers.length !== positions.length) return false;
    return positions.every((p, i) => {
        const want = words[p];
        const got = (answers[i] ?? '').trim().toLowerCase();
        return typeof want === 'string' && want.length > 0 && got === want.toLowerCase();
    });
}

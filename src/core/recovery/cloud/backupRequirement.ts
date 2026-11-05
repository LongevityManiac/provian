/**
 * Mandatory cloud backup after a phrase restore.
 *
 * A wallet created on this phone cannot finish onboarding without a completed cloud backup
 * (CloudBackupConfirm precedes the completion step and has no skip). A wallet restored from
 * its recovery phrase finished onboarding with or without one — it only raised a banner. The
 * phrase-restore path now marks the wallet as owing a backup and routes to the backup screen;
 * the mark persists, so a force-quit on that screen lands on it again at the next unlock
 * rather than in the app. The mark clears only once this wallet's backup exists: a cloud backup, or
 * (where no cloud is available) a recovery phrase the person wrote down and proved (`phraseBackup`).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { hasPhraseBackup } from '../phraseBackup';

export const BACKUP_REQUIRED_KEY = '@provian_cloud_backup_required_v1';

export async function markBackupRequired(address: string): Promise<void> {
    await AsyncStorage.setItem(BACKUP_REQUIRED_KEY, address.toLowerCase());
}

export async function clearBackupRequired(): Promise<void> {
    await AsyncStorage.removeItem(BACKUP_REQUIRED_KEY);
}

export async function pendingBackupRequirement(): Promise<string | null> {
    const value = await AsyncStorage.getItem(BACKUP_REQUIRED_KEY);
    return value && /^0x[0-9a-f]{40}$/.test(value) ? value : null;
}

/**
 * Where a ready wallet goes: the app, or the backup screen first.
 *  - nothing owed → the app;
 *  - owed by a wallet that is no longer on the phone → the app (that wallet's mark is stale);
 *  - owed by this wallet and its backup exists → the app (the mark clears);
 *  - owed by this wallet and its backup is missing, or could not be checked → the backup
 *    screen (unknown = block).
 */
export function decideBackupGate(input: {
    pendingAddress: string | null;
    currentAddress: string | null;
    /** null when the backup could not be checked. */
    hasBackup: boolean | null;
}): { route: 'app' | 'backup'; clearMark: boolean } {
    if (!input.pendingAddress) return { route: 'app', clearMark: false };
    if (!input.currentAddress || input.pendingAddress !== input.currentAddress.toLowerCase()) {
        return { route: 'app', clearMark: true };
    }
    if (input.hasBackup === true) return { route: 'app', clearMark: true };
    return { route: 'backup', clearMark: false };
}

/**
 * Resolve the gate for the wallet on the phone. `hasBackup` is CloudBackupV2.hasCloudBackup,
 * injected so this module stays free of the native backup graph. A confirmed recovery-phrase
 * backup of this wallet (the fallback when no cloud is available) counts as its backup.
 */
export async function resolveBackupGate(
    currentAddress: string | null,
    hasBackup: (address: string) => Promise<boolean>,
): Promise<'app' | 'backup'> {
    const pendingAddress = await pendingBackupRequirement().catch(() => null);
    if (!pendingAddress) return 'app';
    let backedUp: boolean | null = null;
    if (currentAddress && pendingAddress === currentAddress.toLowerCase()) {
        backedUp = (await hasPhraseBackup(currentAddress).catch(() => false))
            ? true
            : await hasBackup(currentAddress).catch(() => null);
    }
    const decision = decideBackupGate({ pendingAddress, currentAddress, hasBackup: backedUp });
    if (decision.clearMark) await clearBackupRequired().catch(() => undefined);
    return decision.route;
}

/**
 * Delete All Data, browser part: the passkey + PIN vault and the seed it holds, every secure-store
 * item, this browser's device key and Google Drive sign-in. (The relay deletes the account and the
 * passkey backups it stores; the passkey itself stays in the person's passkey manager, where they
 * can remove it.)
 */
import { wipeVault } from './web/webVault';
import { clearAllWebSecureStoreItems } from './web/secureStoreWeb';
import { idbClearAll } from './web/webKv';
import { signOut } from './web/googleDriveWeb';

export async function wipeWebStorage(): Promise<void> {
    wipeVault();
    clearAllWebSecureStoreItems();
    signOut();
    await idbClearAll().catch(() => undefined);
}

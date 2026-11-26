/**
 * ProvianSecureSeed for the web app: the same contract as the native module
 * (modules/provian-secure-seed/index.ts), backed by the passkey + PIN vault.
 *
 * - `beginActionAsync` is the Face ID moment: it opens the vault (passkey + PIN) when it is
 * closed, or asks for the passkey again when the last check is older than a minute. The returned
 * action id is what lets `getItemAsync` / `signDeviceDigestAsync` read or sign; it ends with
 * `endActionAsync`.
 * - `setItemAsync` only ADDS (ERR_SEED_ITEM_EXISTS on an existing item), like the native store.
 * - `getItemAsync` resolves null only when no item exists.
 */
import type { ProvianSecureSeedModule, SecureSeedProbe } from '../../../modules/provian-secure-seed';
import { confirmPresence, deleteSeedItem, hasSeedItem, hasVault, isVaultOpen, lastVerifiedAt, readSeedItem, writeSeedItem } from './webVault';
import { requestVaultAccess, takePinForAction } from './unlockRequests';
import { secureEnclaveWeb } from './secureEnclaveWeb';

const PRESENCE_WINDOW_MS = 60 * 1000;
const actions = new Set<string>();

function codedError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function requireAction(actionId?: string | null): void {
    if (!actionId || !actions.has(actionId)) throw codedError('ERR_SEED_AUTH_FAILED', 'Authentication did not succeed.');
}

export const secureSeedWeb: ProvianSecureSeedModule = {
    isAvailable(): boolean {
        return typeof window !== 'undefined' && !!globalThis.crypto?.subtle && !!window.localStorage;
    },
    async beginActionAsync(reason: string): Promise<string> {
        if (!hasVault()) throw codedError('ERR_SEED_AUTH_UNAVAILABLE', 'No wallet is set up in this browser.');
        const pinPurpose = takePinForAction(reason);
        if (!isVaultOpen()) await requestVaultAccess(reason, 'unlock');
        else if (pinPurpose) await requestVaultAccess(reason, pinPurpose);
        else if (Date.now() - lastVerifiedAt() > PRESENCE_WINDOW_MS) await requestVaultAccess(reason, 'presence');
        const id = crypto.randomUUID();
        actions.add(id);
        return id;
    },
    async endActionAsync(id: string): Promise<void> {
        actions.delete(id);
    },
    async isActionKeyAsync(): Promise<boolean> {
        return false;
    },
    async signDeviceDigestAsync(keyId: string, digestHex: string, actionId: string): Promise<string> {
        requireAction(actionId);
        return secureEnclaveWeb.signDigestDer(keyId, digestHex);
    },
    async hasLegacyItemAsync(): Promise<boolean> {
        return false;
    },
    async getLegacyItemAsync(): Promise<string | null> {
        return null;
    },
    async hasItemAsync(key: string): Promise<boolean> {
        return hasSeedItem(key);
    },
    async probeItemAsync(key: string): Promise<SecureSeedProbe> {
        return hasSeedItem(key) ? 'present' : 'absent';
    },
    async setItemAsync(key: string, value: string, _prompt: string, actionId?: string | null): Promise<boolean> {
        if (hasSeedItem(key)) throw codedError('ERR_SEED_ITEM_EXISTS', 'The item already exists.');
        if (!isVaultOpen()) {
            if (actionId) requireAction(actionId);
            throw codedError('ERR_SEED_AUTH_UNAVAILABLE', 'The wallet is locked.');
        }
        try {
            await writeSeedItem(key, value);
        } catch (err) {
            throw codedError('ERR_SEED_WRITE_FAILED', err instanceof Error ? err.message : String(err));
        }
        return true;
    },
    async getItemAsync(key: string, _prompt: string, actionId?: string | null): Promise<string | null> {
        if (!hasSeedItem(key)) return null;
        requireAction(actionId);
        try {
            return await readSeedItem(key);
        } catch (err) {
            throw codedError('ERR_SEED_UNRECOVERABLE', `[cause:unwrap_failed] ${err instanceof Error ? err.message : String(err)}`);
        }
    },
    async deleteItemAsync(key: string): Promise<boolean> {
        const existed = hasSeedItem(key);
        deleteSeedItem(key);
        return existed;
    },
};

/** Ask for the passkey now (used by the expo-local-authentication shim when the vault is open). */
export async function confirmPresenceNow(): Promise<void> {
    await confirmPresence();
}

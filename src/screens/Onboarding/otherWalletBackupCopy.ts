/**
 * The message of the alert shown when the cloud account's primary backup belongs to another wallet.
 *
 * A backup that names its wallet is identified by that wallet's short address. A backup that names
 * no wallet gets its own sentence: no placeholder is filled with a stand-in noun, so the copy can
 * never read "a backup for wallet another wallet".
 */
export type OtherWalletBackupMessage =
    | { key: 'cloudBackupConfirm.otherWalletMessage'; values: { address: string } }
    | { key: 'cloudBackupConfirm.otherWalletMessageUnknown' };

export function shortWalletAddress(address: string): string {
    return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function otherWalletBackupMessage(existingWalletAddress: string | null | undefined): OtherWalletBackupMessage {
    const existing = typeof existingWalletAddress === 'string' ? existingWalletAddress.trim() : '';
    return existing
        ? { key: 'cloudBackupConfirm.otherWalletMessage', values: { address: shortWalletAddress(existing) } }
        : { key: 'cloudBackupConfirm.otherWalletMessageUnknown' };
}

type Translate = (key: string, values?: Record<string, string>) => string;

export function renderOtherWalletBackupMessage(t: Translate, existingWalletAddress: string | null | undefined): string {
    const message = otherWalletBackupMessage(existingWalletAddress);
    return 'values' in message ? t(message.key, message.values) : t(message.key);
}

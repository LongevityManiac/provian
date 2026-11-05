/**
 * Cloud backup slots — which cloud key holds which wallet's backup.
 *
 * One iCloud / Google account can back up more than one wallet. The PRIMARY key
 * (`provian_cloud_backup_v2`) holds the first wallet backed up on the account — every build
 * since the v2 backup reads and writes it. A wallet whose account's primary already holds
 * ANOTHER wallet's backup, and whose owner chose to KEEP that backup, is written to its own
 * key, `provian_cloud_backup_v2__<address>`, so both wallets stay recoverable. Replacing the
 * primary stays possible, as the owner's explicit choice.
 *
 * Dependency-light (no native module, no React Native) so the decisions are testable on both
 * platform backends; CloudBackupV2.ts does the I/O.
 */

/** The primary backup key (the only key before 2026-10-17). */
export const PRIMARY_BACKUP_KEY = 'provian_cloud_backup_v2';

/** Prefix of a per-wallet backup key; the suffix is the wallet's lowercase 0x address. */
export const WALLET_BACKUP_KEY_PREFIX = `${PRIMARY_BACKUP_KEY}__`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The per-wallet backup key for `address`. */
export function walletBackupKey(address: string): string {
    if (!ADDRESS_RE.test(address)) throw new Error('walletBackupKey: not an EVM address');
    return `${WALLET_BACKUP_KEY_PREFIX}${address.toLowerCase()}`;
}

/** The wallet a per-wallet key names (lowercase), or null for any other key. */
export function walletOfBackupKey(key: string): string | null {
    if (!key.startsWith(WALLET_BACKUP_KEY_PREFIX)) return null;
    const address = key.slice(WALLET_BACKUP_KEY_PREFIX.length);
    return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

/** Whether a stored value is a v2 backup blob at all. */
export function isV2Backup(raw: string | null): boolean {
    if (!raw) return false;
    try {
        return (JSON.parse(raw) as { version?: unknown }).version === 2;
    } catch {
        return false;
    }
}

/** The wallet a stored blob backs up, when the blob says (lowercase); null for a pre-2026-10-17 blob. */
export function backupOwnerOf(raw: string | null): string | null {
    if (!raw) return null;
    try {
        const stored = JSON.parse(raw) as { version?: unknown; wallet_address?: unknown };
        if (stored.version !== 2) return null;
        return typeof stored.wallet_address === 'string' && ADDRESS_RE.test(stored.wallet_address)
            ? stored.wallet_address.toLowerCase()
            : null;
    } catch {
        return null;
    }
}

/**
 * What the owner said when the primary holds another wallet's backup: keep that backup (this
 * wallet gets its own key) or replace it. Undefined = not asked yet.
 */
export type OtherWalletBackupChoice = 'keep' | 'replace';

export type BackupTarget =
    | { kind: 'write'; key: string }
    /** The primary holds another wallet's backup and the owner has not chosen Keep or Replace. */
    | { kind: 'ask'; existingWalletAddress: string | null };

/**
 * Where this wallet's backup is written.
 *  - the primary when it is empty or already this wallet's (a re-backup);
 *  - this wallet's own key when it already has one (a re-backup — never asks again);
 *  - otherwise the primary holds another wallet's backup (or one that does not say whose):
 *    Keep → this wallet's own key, the primary untouched; Replace → the primary; no choice → ask.
 */
export function resolveBackupTarget(input: {
    address: string;
    primaryRaw: string | null;
    walletKeyRaw: string | null;
    choice?: OtherWalletBackupChoice;
}): BackupTarget {
    const me = input.address.toLowerCase();
    // Anything in the primary counts as in use — an unreadable blob is still somebody's.
    const primaryInUse = input.primaryRaw !== null && input.primaryRaw !== '';
    const primaryOwner = backupOwnerOf(input.primaryRaw);
    if (!primaryInUse || primaryOwner === me) return { kind: 'write', key: PRIMARY_BACKUP_KEY };
    if (isV2Backup(input.walletKeyRaw)) return { kind: 'write', key: walletBackupKey(me) };
    if (input.choice === 'keep') return { kind: 'write', key: walletBackupKey(me) };
    if (input.choice === 'replace') return { kind: 'write', key: PRIMARY_BACKUP_KEY };
    return { kind: 'ask', existingWalletAddress: primaryOwner };
}

/** One backup the cloud account holds. */
export interface CloudBackupEntry {
    /** The cloud key to read it from. */
    key: string;
    /** The wallet it backs up (lowercase), or null for a primary blob written before 2026-10-17. */
    walletAddress: string | null;
}

/**
 * Every backup the account holds: the primary first (when it is a v2 blob), then each
 * per-wallet key in address order. A per-wallet key whose blob is not a v2 backup is skipped,
 * and a wallet already named by the primary is not listed twice.
 */
export function listBackupEntries(input: {
    primaryRaw: string | null;
    walletKeys: Array<{ key: string; raw: string | null }>;
}): CloudBackupEntry[] {
    const entries: CloudBackupEntry[] = [];
    const seen = new Set<string>();
    if (isV2Backup(input.primaryRaw)) {
        const owner = backupOwnerOf(input.primaryRaw);
        entries.push({ key: PRIMARY_BACKUP_KEY, walletAddress: owner });
        if (owner) seen.add(owner);
    }
    const slots = input.walletKeys
        .map(({ key, raw }) => ({ key, raw, wallet: walletOfBackupKey(key) }))
        .filter((s): s is { key: string; raw: string | null; wallet: string } => s.wallet !== null && isV2Backup(s.raw))
        .sort((a, b) => a.wallet.localeCompare(b.wallet));
    for (const s of slots) {
        if (seen.has(s.wallet)) continue;
        seen.add(s.wallet);
        entries.push({ key: s.key, walletAddress: s.wallet });
    }
    return entries;
}

/**
 * What the account holds for `address`:
 *  - `backed_up`: its own key holds a v2 blob, or the primary names it;
 *  - `unidentified`: the primary is a pre-2026-10-17 blob that names no wallet and this wallet
 *    has no key of its own — it may be this wallet's backup or another's; nothing here can tell
 *    without the backup password;
 *  - `missing`: nothing that could be its backup.
 */
export type WalletBackupStatus = 'backed_up' | 'unidentified' | 'missing';

export function walletBackupStatus(input: { address: string; primaryRaw: string | null; walletKeyRaw: string | null }): WalletBackupStatus {
    const me = input.address.toLowerCase();
    if (isV2Backup(input.walletKeyRaw)) return 'backed_up';
    if (!isV2Backup(input.primaryRaw)) return 'missing';
    const owner = backupOwnerOf(input.primaryRaw);
    if (owner === me) return 'backed_up';
    return owner === null ? 'unidentified' : 'missing';
}

/**
 * Whether `address` PROVABLY has a completed backup. A blob that names no wallet proves nothing
 * about this one (unknown = block): a restored wallet facing one still owes its own backup
 * ( ).
 */
export function walletHasBackup(input: { address: string; primaryRaw: string | null; walletKeyRaw: string | null }): boolean {
    return walletBackupStatus(input) === 'backed_up';
}

/**
 * What deleting `address`'s cloud backup removes: its own key, and the primary only when the
 * primary NAMES this wallet. A primary that names no wallet is never deleted — it may be another
 * wallet's only backup — and the caller is told it was kept ( ).
 */
export function backupKeysToDelete(input: { address: string; primaryRaw: string | null; walletKeyRaw: string | null }): {
    keys: string[];
    keptUnidentifiedPrimary: boolean;
} {
    const me = input.address.toLowerCase();
    const keys: string[] = [];
    if (input.walletKeyRaw !== null) keys.push(walletBackupKey(me));
    let keptUnidentifiedPrimary = false;
    if (input.primaryRaw !== null) {
        const owner = backupOwnerOf(input.primaryRaw);
        if (owner === me) keys.push(PRIMARY_BACKUP_KEY);
        else if (owner === null) keptUnidentifiedPrimary = true;
    }
    return { keys, keptUnidentifiedPrimary };
}

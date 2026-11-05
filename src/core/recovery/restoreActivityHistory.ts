import { withBiometricAction, type BiometricAction } from '../security/biometricAction';
/**
 * restoreActivityHistory — shared post-recovery PE restore with EXPLICIT session handling.
 *
 * The wallet is ALREADY recovered (seed in SecureStore, address set, onboarding marked complete)
 * before this runs — restoring PEs is layered on top and must NEVER block wallet access.
 *
 * PE METER : the relay stops storing PEs, so recovery never asks it for any.
 * PEs come back from the person's OWN cloud:
 * 1. the PE meter's encrypted backup files (iCloud Documents / Google Drive appDataFolder) —
 * every device chain re-verified link by link before it is accepted, plus receipts, proofs,
 * the PEs agents sealed to this person, and pre-meter history (`PhoneMeter.restoreAfterRecovery`);
 * 2. month archives an older build pushed to synced keychain items (pre-meter wallets).
 * Both are encrypted with a SEED-DERIVED key (HKDF over the mnemonic), and reading the mnemonic is
 * biometric-SESSION gated, so a restore needs a session:
 *
 * mode 'with_session' prompt for a session, then restore. A declined prompt returns
 * { status: 'session_declined' } WITHOUT restoring, so the caller surfaces Retry / Skip
 * (never a silent empty-Activity success).
 * mode 'skip' the person EXPLICITLY continued without their history. Nothing is restored (the
 * former seedless path rebuilt history from the relay's PE summaries, which no longer exist);
 * the backup stays in their cloud and a later restore can still bring it back.
 *
 * Both recovery screens (CloudRecoveryScreen, ImportRecoveryPhraseScreen) call this.
 */

import SeedManager from '../wallet/SeedManager';
import PELifecycleManager from '../provenance/PELifecycleManager';
import PromiseService from '../promises/PromiseService';
import { translate } from '../../i18n/translate';

export type RestoreSource = 'cloud' | 'none';

export type HistoryRestoreOutcome =
    | { status: 'restored'; restoredCount: number; source: RestoreSource }
    | { status: 'session_declined' }
    | { status: 'skipped'; restoredCount: number; source: RestoreSource };

/** Biometric prompt reason shown when restoring activity history. */
export const restoreActivityReason = (): string => translate('biometricPrompts.restoreActivityHistory', 'Restore your activity history');

/** The PE meter's restore, injectable for tests (production loads the runtime lazily). */
export type MeterRestore = (biometricAction?: BiometricAction) => Promise<{ readonly found: boolean; readonly activityRestored: number; readonly received: number; readonly devices: readonly { readonly imported: number }[] }>;

const defaultMeterRestore: MeterRestore = async (biometricAction) => {
    const { getPhoneMeter } = await import('../meter/phoneMeterRuntime');
    return getPhoneMeter().restoreAfterRecovery(biometricAction);
};

/**
 * Restore PEs after wallet recovery. Never throws and never blocks wallet access — a restore
 * failure resolves to a 0-count outcome, and a declined biometric resolves to `session_declined`.
 */
export async function restoreActivityHistory(
    mode: 'with_session' | 'skip',
    meterRestore: MeterRestore = defaultMeterRestore, biometricAction?: BiometricAction,
): Promise<HistoryRestoreOutcome> {
    if (mode === 'skip') return { status: 'skipped', restoredCount: 0, source: 'none' };
    if (!biometricAction && meterRestore === defaultMeterRestore) {
        await (await import('../meter/phoneMeterRuntime')).preparePeCloudAccess().catch(() => false);
    }
    try {
        return await withBiometricAction(restoreActivityReason(), async action => {
            const PECloudSync = (await import('../provenance/PECloudSync')).default;
            await PECloudSync.getArchiveKeyForBackup({ allowPrompt: false, biometricAction: action });
            await (await import('../commons/threadCrypto')).getMessageKeyPair(restoreActivityReason(), action);
            const restored = await safeRestore(meterRestore, action);
            await safeRestorePromises(action);
            return { status: 'restored', restoredCount: restored.restoredCount, source: restored.source };
        }, biometricAction);
    } catch (err) {
        console.warn('[restoreActivityHistory] authentication unavailable:', err);
        return { status: 'session_declined' };
    }
}

async function safeRestore(meterRestore: MeterRestore, biometricAction?: BiometricAction): Promise<{ restoredCount: number; source: RestoreSource }> {
    let count = 0;
    try {
        const meter = await meterRestore(biometricAction);
        count += meter.devices.reduce((n, d) => n + d.imported, 0) + meter.received + meter.activityRestored;
    } catch (err) {
        console.warn('[restoreActivityHistory] PE backup restore failed (non-blocking):', err);
    }
    try {
        const legacy = await PELifecycleManager.restorePEsAfterRecovery(biometricAction);
        count += legacy.restoredCount;
    } catch (err) {
        console.warn('[restoreActivityHistory] pre-meter archive restore failed (non-blocking):', err);
    }
    return { restoredCount: count, source: count > 0 ? 'cloud' : 'none' };
}

/**
 * Restore human promises + their seed-derived E2E terms from the relay. Best-effort and
 * non-blocking: a failure resolves to 0 and never blocks wallet access. Must be called only AFTER a
 * biometric session is established (the terms are decrypted with the seed).
 */
async function safeRestorePromises(biometricAction?: BiometricAction): Promise<number> {
    try {
        return await PromiseService.restoreFromRelay(biometricAction);
    } catch (err) {
        console.warn('[restoreActivityHistory] promise restore failed (non-blocking):', err);
        return 0;
    }
}

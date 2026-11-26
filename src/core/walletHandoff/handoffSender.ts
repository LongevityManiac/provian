/**
 * The sending device's side of a QR handoff: read the seed under its own unlock (Face ID / Touch ID
 * on the phone; the passkey AND the PIN in the web app, as for showing the recovery phrase) and seal
 * it to the receiver the person just confirmed. The seed leaves this function only sealed.
 */
import { Platform } from 'react-native';
import { withBiometricAction, assertBiometricAction } from '../security/biometricAction';
import { BiometricAuthError } from '../security/requireBiometric';
import SeedManager from '../wallet/SeedManager';
import { translate } from '../../i18n/translate';
import { requirePinForAction } from '../../platform/web/unlockRequests';
import { sendWallet, type HandoffPeer, type HandoffRelay, type HandoffSession } from './handoffFlow';

/** The person dismissed the unlock (Cancel, or the system closed the prompt): back to the confirm step. */
export class HandoffUnlockCancelledError extends Error {
    constructor() { super('handoff_unlock_cancelled'); this.name = 'HandoffUnlockCancelledError'; }
}

const CANCELLED = new Set(['user_cancel', 'system_cancel', 'app_cancel']);

/** True for every way an unlock prompt reports that the person dismissed it, on the phone and the web. */
export function isUnlockCancel(err: unknown): boolean {
    if (err instanceof BiometricAuthError) return err.authError !== undefined && CANCELLED.has(err.authError);
    return (err as { code?: string } | null)?.code === 'ERR_SEED_AUTH_CANCELLED';
}

export async function confirmAndSendWallet(relay: HandoffRelay, session: HandoffSession, peer: HandoffPeer, walletAddress: string): Promise<void> {
    const reason = translate('handoff.unlockReason', 'Confirm to move your wallet to {{label}}', { label: peer.device.label });
    if (Platform.OS === 'web') requirePinForAction(reason, 'move');
    try {
        await withBiometricAction(reason, async action => {
            assertBiometricAction(action);
            const mnemonic = await SeedManager.getMnemonic(action);
            if (!mnemonic) throw new Error('handoff_no_seed');
            await sendWallet(relay, session, peer, mnemonic, walletAddress);
        });
    } catch (err) {
        if (isUnlockCancel(err)) throw new HandoffUnlockCancelledError();
        // A failed match reports its raw code; show the app's own words for it.
        if (err instanceof BiometricAuthError) throw new Error(translate('biometricErrors.authFailed', 'Biometric authentication failed.'));
        throw err;
    }
}

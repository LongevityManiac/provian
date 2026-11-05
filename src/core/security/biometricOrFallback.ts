import { withBiometricAction, type BiometricAction } from './biometricAction';
import { BiometricNotAvailableError, enableBiometricFallback } from './requireBiometric';

/**
 * Run a biometric-gated action, switching the wallet to the seed-phrase fallback mode when the
 * device has no enrolled biometric — the same switch onboarding makes for a NEW wallet
 * (BiometricSetupScreen). Until 2026-10-17 a RESTORE on such a device (a new phone before Face
 * ID is set up, a phone without the hardware) failed with the raw "no biometric is enrolled"
 * error and left the person with no way in; now it proceeds the way a fresh wallet would.
 */
export async function withBiometricOrFallback<T>(
    reason: string,
    fn: (action: BiometricAction) => Promise<T>,
    existing?: BiometricAction,
    biometricOnly = false,
): Promise<T> {
    try {
        return await withBiometricAction(reason, fn, existing, biometricOnly);
    } catch (err) {
        // The seed-phrase fallback is for the ORDINARY gate. A strict native gate (`biometricOnly`)
        // ignores the fallback flag, so switching the wallet into fallback mode here would change its
        // security mode and still fail ; such callers pre-check enrolment.
        if (!biometricOnly && err instanceof BiometricNotAvailableError && (!err.hasHardware || !err.isEnrolled)) {
            await enableBiometricFallback();
            return await withBiometricAction(reason, fn, existing, biometricOnly);
        }
        throw err;
    }
}

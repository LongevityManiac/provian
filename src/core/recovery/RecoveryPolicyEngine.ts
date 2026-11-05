import { RecoveryPolicy, RecoveryFactorResult, TrustedDeviceFactorStatus } from './types';

/**
 * [Opus-audit M-2] Uses factorType discriminator for type-safe factor matching.
 *
 * The current recovery model is PIN-encrypted cloud backup of the BIP-39
 * seed (AES-256-GCM) synced to iCloud Keychain on iOS or to Google Drive's
 * app data folder on Android. An optional seed-phrase export is available
 * in Settings as an offline escape hatch.
 */
export class RecoveryPolicyEngine {
    constructor(private policy: RecoveryPolicy) { }

    isSatisfiedBy(factors: RecoveryFactorResult[]): boolean {
        let satisfiedCount = 0;
        let hasNonDeviceFactor = false;

        // [Opus-audit M-2] Use factorType discriminator for type-safe checks
        // 1. Check Trusted Device
        if (this.policy.trustedDevicesEnabled) {
            const deviceFactor = factors.find(f => f.factorType === 'trustedDevice') as TrustedDeviceFactorStatus | undefined;
            if (deviceFactor?.satisfied) {
                satisfiedCount++;
            }
        }

        // 2. Check Cloud
        if (this.policy.cloudBackupEnabled) {
            const cloudFactor = factors.find(f => f.factorType === 'cloud');
            if (cloudFactor?.satisfied) {
                satisfiedCount++;
                hasNonDeviceFactor = true;
            }
        }

        // 3. Check Breakglass
        if (this.policy.breakGlassEnabled) {
            const breakGlassFactor = factors.find(f => f.factorType === 'breakglass');
            if (breakGlassFactor?.satisfied) {
                satisfiedCount++;
                hasNonDeviceFactor = true;
            }
        }

        // Check if we met the minimum distinct factors count
        const countMet = satisfiedCount >= this.policy.minDistinctFactors;

        // Enforce: at least one non-device factor (cloud or breakglass) - a
        // bare trusted-device-only chain is not a valid recovery posture.
        const structureMet = hasNonDeviceFactor;

        return countMet && structureMet;
    }
}

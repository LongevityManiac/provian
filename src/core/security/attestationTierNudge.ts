/**
 * Attestation-tier recalculation nudge.
 *
 * Audit Pass 2 fix 3 (commit `6e5e9b3`) shipped a native `getKeyBacking`
 * method that distinguishes StrongBox-backed from TEE-backed Android keys.
 * Existing Android users whose key was registered before that commit may
 * have earned `hardware_full` while their key was actually TEE-backed; the
 * new reader picks up the real backing and surfaces `hardware_tpm` on TEE.
 *
 * This module owns the one-time UI nudge that closes the loop. The banner
 * is informational only; no re-registration required, no wallet/key/seed
 * changes. Dismissed-once-forever via AsyncStorage.
 *
 * Scoped to Android intentionally: iOS Secure Enclave reporting did not
 * change, so iOS users never need the message.
 */

/**
 * Minimal storage shape; matches AsyncStorage but lets tests pass a
 * plain in-memory object instead of mocking the native module.
 */
export interface NudgeStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

export const ATTESTATION_TIER_NUDGE_KEY =
    '@provian_attestation_tier_recalc_seen_v1';

/**
 * Should the nudge banner render on Security Settings right now?
 *
 * - iOS: never (no tier reporting change on iOS).
 * - Android with flag set: no (user already dismissed).
 * - Android with flag absent: yes.
 *
 * Pure function over `platform` + a storage port so it's trivially testable
 * without rendering a screen or touching the real AsyncStorage.
 */
export async function shouldShowAttestationNudge(
    platform: 'ios' | 'android',
    storage: NudgeStorage,
): Promise<boolean> {
    if (platform !== 'android') return false;
    const flag = await storage.getItem(ATTESTATION_TIER_NUDGE_KEY);
    return flag !== '1';
}

/**
 * Record that the user has dismissed the nudge. Idempotent.
 */
export async function dismissAttestationNudge(
    storage: NudgeStorage,
): Promise<void> {
    await storage.setItem(ATTESTATION_TIER_NUDGE_KEY, '1');
}

/**
 * Consent state for the mobile Chat-tab capture pipeline.
 *
 * Persists a tri-state value under AsyncStorage:
 *   null   : never asked (first-run path for Chat tab)
 *   true   : user accepted capture
 *   false  : user declined or explicitly disabled via Settings
 *
 * A user who never taps Chat never sees a consent screen. A user who
 * taps Chat for the first time hits the consent gate in ChatHomeScreen.
 * The Settings row lets users toggle either direction at any time.
 *
 * When the value is not `true`, the whole capture pipeline is bypassed
 * at the screen layer: ChatWebViewScreen does not instantiate the state
 * machine, does not inject the MutationObserver script, and does not
 * attach onMessage. See design notes docs/PHASE_2C_DESIGN_NOTES.md §5.M6.
 *
 * Malformed storage values (including JSON parse errors and AsyncStorage
 * throws) are treated as `null` rather than throwing; the Chat tab
 * gracefully re-prompts the user rather than crashing.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const CAPTURE_CONSENT_KEY = '@provian_capture_mobile_chat_enabled';

/**
 * Second, independent consent for the Android UsageStats surface (Phase
 * 2c M7). A user can accept wrapper capture and decline UsageStats, or
 * vice versa. Keyed separately so the two decisions do not alias.
 */
export const USAGE_STATS_CONSENT_KEY = '@provian_capture_usage_stats_enabled';

export type MobileChatConsent = boolean | null;

export async function getMobileChatConsent(): Promise<MobileChatConsent> {
    try {
        const raw = await AsyncStorage.getItem(CAPTURE_CONSENT_KEY);
        if (raw === null || raw === undefined) return null;
        const parsed = JSON.parse(raw);
        if (parsed === true || parsed === false) return parsed;
        return null;
    } catch {
        return null;
    }
}

export async function setMobileChatConsent(value: boolean): Promise<void> {
    try {
        await AsyncStorage.setItem(CAPTURE_CONSENT_KEY, JSON.stringify(value));
    } catch {
        // Swallow: AsyncStorage write failures should not crash the UI.
        // The user can retry via the Settings row.
    }
}

export async function clearMobileChatConsent(): Promise<void> {
    try {
        await AsyncStorage.removeItem(CAPTURE_CONSENT_KEY);
    } catch {
        // Swallow.
    }
}

/**
 * Rendering decision for ChatHomeScreen. Pure function, exported for
 * direct test. Callers map this to a concrete view.
 *
 *   'loading'  : initial AsyncStorage read in flight
 *   'decision' : consent is null, show ChatCaptureConsentScreen
 *   'picker'   : consent is true, show provider list (existing behavior)
 *   'declined' : consent is false, show DeclinedState with Settings deeplink
 */
export type ChatHomeGate = 'loading' | 'decision' | 'picker' | 'declined';

export function chatHomeGate(consent: MobileChatConsent | 'loading'): ChatHomeGate {
    if (consent === 'loading') return 'loading';
    if (consent === null) return 'decision';
    if (consent === true) return 'picker';
    return 'declined';
}

/**
 * Whether the capture pipeline (state machine + MutationObserver +
 * emitter + onMessage) should be instantiated at all on the current
 * ChatWebViewScreen mount. Only `true` passes.
 */
export function shouldRunCapturePipeline(
    consent: MobileChatConsent | 'loading',
): boolean {
    return consent === true;
}

// =========================================================================
// UsageStats consent (Phase 2c M7, Android-only)
// =========================================================================

export async function getUsageStatsConsent(): Promise<MobileChatConsent> {
    try {
        const raw = await AsyncStorage.getItem(USAGE_STATS_CONSENT_KEY);
        if (raw === null || raw === undefined) return null;
        const parsed = JSON.parse(raw);
        if (parsed === true || parsed === false) return parsed;
        return null;
    } catch {
        return null;
    }
}

export async function setUsageStatsConsent(value: boolean): Promise<void> {
    try {
        await AsyncStorage.setItem(USAGE_STATS_CONSENT_KEY, JSON.stringify(value));
    } catch {
        // Swallow: AsyncStorage write failures should not crash the UI.
    }
}

export async function clearUsageStatsConsent(): Promise<void> {
    try {
        await AsyncStorage.removeItem(USAGE_STATS_CONSENT_KEY);
    } catch {
        // Swallow.
    }
}

/**
 * Same strict `=== true` contract as `shouldRunCapturePipeline`. On iOS
 * the scheduler is a no-op regardless, so this function is only
 * consulted on Android.
 */
export function shouldRunUsageStatsPipeline(
    consent: MobileChatConsent | 'loading',
): boolean {
    return consent === true;
}

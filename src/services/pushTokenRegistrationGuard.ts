/**
 * Pure loop-guard for the push-token rotation listener (no native imports).
 *
 * Why this exists (2026-08-12 incident): NotificationService subscribes to
 * expo-notifications' `addPushTokenListener` and, on each fire, re-mints the
 * Expo push token via `getExpoPushTokenAsync()`. On some OS builds (observed on
 * iOS / Darwin 25.6.0) that mint RE-EMITS the very token-changed event the
 * listener is subscribed to, so re-registering on every emit recurses without
 * bound — tens of POSTs/sec to `/v1/users/:id/fcm-token`, which trips the relay
 * rate limiter (429) and starves every other relay call sharing that budget
 * (the Abundance/Wallet dashboard reads, balances, etc.). The device token
 * itself does NOT change between those echoes, so deduping on its VALUE breaks
 * the cycle while still honouring a genuine rotation (a new value) exactly once.
 *
 * Kept pure + dependency-free so the loop-breaking behaviour is unit-testable
 * without the native expo-notifications module — the same DI pattern as
 * pushRegistration.ts.
 */

/**
 * Collapse a `DevicePushToken` (or any shape the listener hands us) to a stable
 * string key. iOS/Android carry the token string in `.data`; anything else is
 * stringified so two structurally-identical emits compare equal.
 */
export function normalizeDeviceToken(token: unknown): string {
    const data =
        token && typeof token === 'object' && 'data' in token
            ? (token as { data: unknown }).data
            : token;
    return typeof data === 'string' ? data : JSON.stringify(data ?? null);
}

/**
 * Create a stateful gate. Returns `true` the first time it sees a given device
 * token value (the caller should re-register) and `false` for any immediately
 * repeated value (a re-emit / echo — the caller must do nothing). A new distinct
 * value returns `true` again, so a genuine token rotation still re-registers.
 *
 * This is the load-bearing loop breaker: an emit -> re-mint -> emit echo carries
 * the SAME device token, so the second fire gates to `false` and the storm can
 * never start.
 */
export function createDeviceTokenGate(): (token: unknown) => boolean {
    let last: string | null = null;
    return (token: unknown): boolean => {
        const value = normalizeDeviceToken(token);
        if (value === last) return false;
        last = value;
        return true;
    };
}

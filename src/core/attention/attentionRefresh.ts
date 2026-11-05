/**
 * Attention refresh signal (item 4). The bell and the tab badge used to refresh only when the
 * Dashboard gained focus (and every 30 s on the tab badge), so a push that just delivered a new
 * request — or an item the human just resolved — left a stale count until the next focus. Anything
 * that knows the attention set may have changed calls `requestAttentionRefresh()`: a received push
 * (NotificationService), the app returning to the foreground, and screens that accept / decline /
 * resolve an item.
 *
 * Deliberately dependency-free: NotificationService imports this, and RelayAPIService imports
 * NotificationService, so this module must not import RelayAPIService (or anything that does).
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * review 2 #8: the refresh generation. Every `requestAttentionRefresh()` bumps it BEFORE
 * notifying anyone, so a load that began before the request (and may read pre-mutation state) is
 * never handed to a consumer as the answer to that request: `loadAttentionShared` shares an
 * in-flight load only when it began at the current generation.
 */
let refreshGeneration = 0;

/** The current refresh generation (monotonic). */
export function attentionRefreshGeneration(): number {
    return refreshGeneration;
}

/** Ask every mounted attention count to reload from a load that begins now. Never throws. */
export function requestAttentionRefresh(): void {
    refreshGeneration += 1;
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            // A listener's failure never blocks the others.
        }
    }
}

/** Subscribe to refresh requests; returns the unsubscribe function. */
export function onAttentionRefresh(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

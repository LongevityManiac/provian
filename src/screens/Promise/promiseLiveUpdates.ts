/**
 * Live updates for the promise on screen: sync once, then subscribe to the relay poller.
 *
 * The relay keeps ONE poller per promise and hands a second subscriber a no-op. So the poller
 * must be released exactly when the screen leaves — including when it leaves while the first sync
 * is still running. A subscription started after the screen left would never be released, and
 * every later visit would be the "second subscriber" and get no live updates.
 */
export interface PromiseLiveUpdateDeps {
    /** Catch up with the relay before subscribing. A failure is not fatal. */
    sync: () => Promise<unknown>;
    /** Start the poller; returns its release. */
    subscribe: () => () => void;
    /** Re-read the promise after the catch-up sync. */
    reload: () => void;
}

/** Returns the stop function for the screen's effect cleanup. Safe to call at any time, repeatedly. */
export function startPromiseLiveUpdates(deps: PromiseLiveUpdateDeps): () => void {
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
        try { await deps.sync(); } catch { /* offline: the in-person flow is unaffected */ }
        if (stopped) return;
        unsubscribe = deps.subscribe();
        deps.reload();
    })();
    return () => {
        stopped = true;
        const release = unsubscribe;
        unsubscribe = undefined;
        release?.();
    };
}

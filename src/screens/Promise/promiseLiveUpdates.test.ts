import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startPromiseLiveUpdates } from './promiseLiveUpdates';

/** A relay stand-in with the real rule: one poller per promise; a second subscriber gets a no-op. */
function relay() {
    let polling = false;
    return {
        isPolling: () => polling,
        subscribe: vi.fn((): (() => void) => {
            if (polling) return () => undefined;
            polling = true;
            return () => { polling = false; };
        }),
    };
}
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
    let resolveFn!: () => void;
    let rejectFn!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => { resolveFn = res; rejectFn = rej; });
    return { promise, resolve: resolveFn, reject: rejectFn };
}
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('promise live updates', () => {
    it('leaving while the first sync is still running leaves no poller behind', async () => {
        const r = relay();
        const sync = deferred();
        const stop = startPromiseLiveUpdates({ sync: () => sync.promise, subscribe: r.subscribe, reload: vi.fn() });
        stop(); // the screen left before the sync answered
        sync.resolve();
        await settle();
        expect(r.isPolling()).toBe(false);

        // The next visit gets a real subscription, not the no-op handed to a second subscriber.
        const stopAgain = startPromiseLiveUpdates({ sync: async () => undefined, subscribe: r.subscribe, reload: vi.fn() });
        await settle();
        expect(r.isPolling()).toBe(true);
        stopAgain();
        expect(r.isPolling()).toBe(false);
    });

    it('subscribes and reloads after the sync, and releases the poller on leave', async () => {
        const r = relay();
        const reload = vi.fn();
        const stop = startPromiseLiveUpdates({ sync: async () => undefined, subscribe: r.subscribe, reload });
        await settle();
        expect(r.subscribe).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(r.isPolling()).toBe(true);
        stop();
        stop(); // repeat-safe
        expect(r.isPolling()).toBe(false);
    });

    it('a failed sync still subscribes (offline now, live later)', async () => {
        const r = relay();
        const stop = startPromiseLiveUpdates({ sync: async () => { throw new Error('offline'); }, subscribe: r.subscribe, reload: vi.fn() });
        await settle();
        expect(r.isPolling()).toBe(true);
        stop();
    });

    it('the detail screen starts its live updates only through startPromiseLiveUpdates', () => {
        const src = readFileSync(resolve(__dirname, 'PromiseDetailScreen.tsx'), 'utf8');
        expect(src).toMatch(/return startPromiseLiveUpdates\(\{/);
        // The only subscribeToUpdates call is the one handed to it.
        expect((src.match(/PromiseService\.subscribeToUpdates\(/g) ?? []).length).toBe(1);
        expect(src).toMatch(/subscribe: \(\) => PromiseService\.subscribeToUpdates\(promiseId,/);
        expect(src).not.toMatch(/unsubscribe = PromiseService\.subscribeToUpdates/);
    });
});

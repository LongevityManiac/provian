/**
 * useAttentionCount — the bell refresh (review 2 #8).
 *
 * `requestAttentionRefresh()` is called right after a mutation (accept / decline / resolve). The
 * count it triggers must come from a load that BEGAN AFTER that mutation: sharing a load that was
 * already in flight hands back the pre-mutation snapshot, and the bell shows the declined item
 * until the next 30 s poll. RED control: the first test resolves to the pre-decline snapshot on the
 * pre-fix coalescing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionSnapshot } from './attention';

const loadAttention = vi.fn<() => Promise<AttentionSnapshot>>();
vi.mock('./attention', () => ({ loadAttention: () => loadAttention() }));

import { createNewestLoadGate, loadAttentionShared } from './useAttentionCount';
import { requestAttentionRefresh } from './attentionRefresh';

function snapshot(count: number): AttentionSnapshot {
    return { items: [], count, counts: {} as AttentionSnapshot['counts'] };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

describe('loadAttentionShared — a refresh after a mutation starts a fresh load', () => {
    beforeEach(() => {
        loadAttention.mockReset();
    });

    it('in-flight load, then decline, then refresh: the refresh resolves to the POST-decline snapshot', async () => {
        const preDecline = deferred<AttentionSnapshot>();
        loadAttention.mockReturnValueOnce(preDecline.promise);
        const polling = loadAttentionShared(); // a poll began before the decline
        // The human declines the one waiting item; the screen asks for a refresh.
        loadAttention.mockReturnValueOnce(Promise.resolve(snapshot(0)));
        requestAttentionRefresh();
        const afterDecline = loadAttentionShared();
        preDecline.resolve(snapshot(1));
        expect((await afterDecline).count).toBe(0);
        expect((await polling).count).toBe(1);
        expect(loadAttention).toHaveBeenCalledTimes(2);
    });

    it('control: without a refresh request, overlapping callers still share ONE load', async () => {
        const one = deferred<AttentionSnapshot>();
        loadAttention.mockReturnValueOnce(one.promise);
        const a = loadAttentionShared();
        const b = loadAttentionShared();
        one.resolve(snapshot(3));
        expect((await a).count).toBe(3);
        expect((await b).count).toBe(3);
        expect(loadAttention).toHaveBeenCalledTimes(1);
    });

    it('one refresh request, many consumers (bell + tab badge): they share the one fresh load', async () => {
        const stale = deferred<AttentionSnapshot>();
        loadAttention.mockReturnValueOnce(stale.promise);
        void loadAttentionShared();
        loadAttention.mockReturnValueOnce(Promise.resolve(snapshot(0)));
        requestAttentionRefresh();
        const bell = loadAttentionShared();
        const badge = loadAttentionShared();
        stale.resolve(snapshot(1));
        expect((await bell).count).toBe(0);
        expect((await badge).count).toBe(0);
        expect(loadAttention).toHaveBeenCalledTimes(2);
    });
});

describe('createNewestLoadGate — a late older load never overwrites a newer count', () => {
    it('accepts in order, refuses an older sequence after a newer one', () => {
        const accept = createNewestLoadGate();
        expect(accept(2)).toBe(true);
        expect(accept(1)).toBe(false); // RED control: the stale pre-mutation round is refused
        expect(accept(2)).toBe(true); // a shared round delivered to a second consumer path
        expect(accept(3)).toBe(true);
    });
});

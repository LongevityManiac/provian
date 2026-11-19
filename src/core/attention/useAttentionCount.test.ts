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
    return { items: [], count, counts: {} as AttentionSnapshot['counts'], answered: true };
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

import { attentionLoadApplies } from './useAttentionCount';

describe('attentionLoadApplies — the bell shows only an answered count for the wallet shown', () => {
    const answered = { answered: true };
    it('applies an answered load for the same wallet, in any letter case', () => {
        expect(attentionLoadApplies({ snapshot: answered, address: '0xAbC' }, '0xabc')).toBe(true);
    });
    it('a failed load (read as 0) never sets or replaces the count', () => {
        expect(attentionLoadApplies({ snapshot: { answered: false }, address: '0xabc' }, '0xabc')).toBe(false);
    });
    it('a load begun for another wallet never sets this wallet\'s bell', () => {
        expect(attentionLoadApplies({ snapshot: answered, address: '0xaaa' }, '0xbbb')).toBe(false);
        expect(attentionLoadApplies({ snapshot: answered, address: null }, '0xbbb')).toBe(false);
    });
});

import { AttentionCountController, type SequencedAttention } from './useAttentionCount';
import { useWalletStore } from '../../store/walletStore';

function controllerHarness(saved: Record<string, number> = {}) {
    const loads: Array<{ resolve: (r: SequencedAttention) => void }> = [];
    const counts: number[] = [];
    let seq = 0;
    const c = new AttentionCountController({
        load: () => { const d = deferred<SequencedAttention>(); loads.push(d); return d.promise; },
        readSaved: async (address) => (address !== null && address in saved ? saved[address] : null),
        setCount: (n) => { counts.push(n); },
    });
    const answer = (i: number, count: number, address: string | null, answered = true) =>
        loads[i].resolve({ snapshot: { ...snapshot(count), answered }, seq: ++seq, address });
    return { c, loads, counts, answer, shown: () => counts.at(-1) };
}
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('AttentionCountController — the bell for the wallet shown', () => {
    it('opens on the saved count, then an answered load replaces it', async () => {
        const h = controllerHarness({ A: 3 });
        h.c.setAddress('A');
        await settle();
        expect(h.shown()).toBe(3);
        h.c.refresh();
        h.answer(0, 5, 'A');
        await settle();
        expect(h.shown()).toBe(5);
    });

    it('a failed load (answered: false) keeps the known count', async () => {
        const h = controllerHarness({ A: 3 });
        h.c.setAddress('A');
        await settle();
        h.c.refresh();
        h.answer(0, 0, 'A', false);
        await settle();
        expect(h.shown()).toBe(3);
    });

    it('a wallet switch empties the bell, starts that wallet\'s own load, and ignores the old wallet\'s', async () => {
        const h = controllerHarness({ B: 1 });
        h.c.setAddress('A');
        h.c.refresh();
        expect(h.loads).toHaveLength(1);
        h.c.setAddress('B');
        expect(h.loads).toHaveLength(2); // the switch loads B itself
        await settle();
        expect(h.shown()).toBe(1);
        h.answer(0, 9, 'A'); // A's load lands late
        await settle();
        expect(h.shown()).toBe(1);
        h.answer(1, 2, 'B');
        await settle();
        expect(h.shown()).toBe(2);
    });

    it('a saved count arriving after a load answered never replaces it', async () => {
        let releaseSaved!: (n: number | null) => void;
        const counts: number[] = [];
        const loads: Array<{ resolve: (r: SequencedAttention) => void }> = [];
        const c = new AttentionCountController({
            load: () => { const d = deferred<SequencedAttention>(); loads.push(d); return d.promise; },
            readSaved: () => new Promise((r) => { releaseSaved = r; }),
            setCount: (n) => { counts.push(n); },
        });
        c.setAddress('A');
        c.refresh();
        loads[0].resolve({ snapshot: snapshot(4), seq: 1, address: 'A' });
        await settle();
        releaseSaved(7);
        await settle();
        expect(counts.at(-1)).toBe(4);
    });
});

describe('loadAttentionShared — a load in flight is shared only by the same wallet', () => {
    beforeEach(() => loadAttention.mockReset());
    it('after a wallet switch a new load starts instead of joining the old wallet\'s', async () => {
        const first = deferred<AttentionSnapshot>();
        loadAttention.mockReturnValueOnce(first.promise).mockResolvedValueOnce(snapshot(2));
        useWalletStore.setState({ address: '0xaaa' });
        const a = loadAttentionShared();
        useWalletStore.setState({ address: '0xbbb' });
        const b = loadAttentionShared();
        expect(loadAttention).toHaveBeenCalledTimes(2);
        first.resolve(snapshot(9));
        expect((await a).count).toBe(9);
        expect((await b).count).toBe(2);
    });
});

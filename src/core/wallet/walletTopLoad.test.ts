import { describe, expect, it, vi } from 'vitest';
import {
    failWalletTop, initialWalletTop, readWithRetry, seedWalletTop, startWalletTop, succeedWalletTop,
    WALLET_TOP_RETRY_DELAYS_MS, type WalletTopShown,
} from './walletTopLoad';

type V = { n: number };
const noSleep = async () => undefined;

describe('wallet-top shown state', () => {
    it('opens on a saved answer marked as updating, then shows the fresh one', () => {
        let s: WalletTopShown<V> = initialWalletTop();
        s = startWalletTop(s);
        expect(s).toEqual({ value: null, savedAtMs: null, phase: 'loading' });
        s = seedWalletTop(s, { n: 1 }, 100);
        expect(s).toEqual({ value: { n: 1 }, savedAtMs: 100, phase: 'updating' });
        s = succeedWalletTop(s, { n: 2 }, 200);
        expect(s).toEqual({ value: { n: 2 }, savedAtMs: 200, phase: 'fresh' });
    });

    it('a saved answer arriving late never replaces one read now', () => {
        const fresh = succeedWalletTop(initialWalletTop<V>(), { n: 9 }, 500);
        expect(seedWalletTop(fresh, { n: 1 }, 100)).toBe(fresh);
    });

    it('a failed refresh keeps the answer on screen and says when it was saved', () => {
        const shown = seedWalletTop(startWalletTop(initialWalletTop<V>()), { n: 3 }, 100);
        expect(failWalletTop(shown)).toEqual({ value: { n: 3 }, savedAtMs: 100, phase: 'saved' });
        // Refreshing a fresh answer keeps it quiet (no "Updating…" flash on every visit).
        const fresh = succeedWalletTop(shown, { n: 4 }, 300);
        expect(startWalletTop(fresh).phase).toBe('fresh');
        expect(failWalletTop(startWalletTop(fresh))).toEqual({ value: { n: 4 }, savedAtMs: 300, phase: 'saved' });
    });

    it('"couldn\'t load" only when there is nothing to show, and a saved answer then replaces it', () => {
        const failed = failWalletTop(startWalletTop(initialWalletTop<V>()));
        expect(failed).toEqual({ value: null, savedAtMs: null, phase: 'failed' });
        expect(seedWalletTop(failed, { n: 5 }, 100)).toEqual({ value: { n: 5 }, savedAtMs: 100, phase: 'saved' });
    });

    it('RED control: a state that dropped the answer on a failed refresh is caught', () => {
        const dropping = (s: WalletTopShown<V>): WalletTopShown<V> => ({ value: null, savedAtMs: null, phase: 'failed' });
        const shown = seedWalletTop(initialWalletTop<V>(), { n: 3 }, 100);
        expect(dropping(shown)).not.toEqual(failWalletTop(shown));
        expect(failWalletTop(shown).value).toEqual({ n: 3 });
    });
});

describe('readWithRetry', () => {
    it('retries a failed or throwing read until it answers', async () => {
        const answers: Array<V | null | Error> = [null, new Error('timeout'), { n: 7 }];
        const read = vi.fn(async () => {
            const next = answers.shift();
            if (next instanceof Error) throw next;
            return next ?? null;
        });
        const sleep = vi.fn(async (_ms: number) => undefined);
        await expect(readWithRetry(read, { sleep })).resolves.toEqual({ n: 7 });
        expect(read).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls.map(c => c[0])).toEqual(WALLET_TOP_RETRY_DELAYS_MS.slice(0, 2));
    });

    it('gives up after every retry, answering null', async () => {
        const read = vi.fn(async () => null);
        await expect(readWithRetry<V>(read, { sleep: noSleep })).resolves.toBeNull();
        expect(read).toHaveBeenCalledTimes(WALLET_TOP_RETRY_DELAYS_MS.length + 1);
        expect(WALLET_TOP_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    });

    it('stops once cancelled', async () => {
        let cancelled = false;
        const read = vi.fn(async () => { cancelled = true; return null; });
        await expect(readWithRetry<V>(read, { sleep: noSleep, isCancelled: () => cancelled })).resolves.toBeNull();
        expect(read).toHaveBeenCalledTimes(1);
    });
});

import { WalletTopLoader, walletTopNote, type WalletTopSaved } from './walletTopLoad';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function harness(saved: Record<string, WalletTopSaved<V>> = {}) {
    const reads: Array<{ resolve: (v: V | null) => void }> = [];
    const savedReads: Record<string, ReturnType<typeof deferred<WalletTopSaved<V> | null>>> = {};
    const writes: Array<[string, V]> = [];
    const emits: Array<{ shown: WalletTopShown<V>; busy: boolean }> = [];
    const loader = new WalletTopLoader<V>({
        read: () => { const d = deferred<V | null>(); reads.push(d); return d.promise; },
        readSaved: (address) => {
            savedReads[address] = deferred<WalletTopSaved<V> | null>();
            return savedReads[address].promise;
        },
        save: (address, value) => { writes.push([address, value]); },
        onChange: (shown, busy) => { emits.push({ shown, busy }); },
        delaysMs: [],
        sleep: async () => undefined,
        now: () => 999,
    });
    const releaseSaved = async (address: string) => { savedReads[address].resolve(saved[address] ?? null); await flush(); };
    return { loader, reads, writes, emits, releaseSaved };
}

describe('WalletTopLoader', () => {
    it('opens on the saved answer, then shows and saves the fresh one; the spinner ends', async () => {
        const h = harness({ A: { value: { n: 1 }, savedAtMs: 100 } });
        h.loader.setAddress('A');
        const load = h.loader.load();
        await h.releaseSaved('A');
        expect(h.loader.state).toEqual({ value: { n: 1 }, savedAtMs: 100, phase: 'updating' });
        h.reads[0].resolve({ n: 2 });
        await load;
        expect(h.loader.state).toEqual({ value: { n: 2 }, savedAtMs: 999, phase: 'fresh' });
        expect(h.writes).toEqual([['A', { n: 2 }]]);
        expect(h.emits.at(-1)?.busy).toBe(false);
    });

    it('a saved answer arriving after the fresh one never replaces it', async () => {
        const h = harness({ A: { value: { n: 1 }, savedAtMs: 100 } });
        h.loader.setAddress('A');
        const load = h.loader.load();
        h.reads[0].resolve({ n: 2 });
        await load;
        await h.releaseSaved('A');
        expect(h.loader.state.value).toEqual({ n: 2 });
    });

    it('a read begun for one wallet changes nothing when it lands after a switch', async () => {
        const h = harness({ B: { value: { n: 7 }, savedAtMs: 50 } });
        h.loader.setAddress('A');
        const loadA = h.loader.load();
        h.loader.setAddress('B');
        await h.releaseSaved('B');
        h.reads[0].resolve({ n: 1 }); // A's answer, late
        await loadA;
        expect(h.loader.state).toEqual({ value: { n: 7 }, savedAtMs: 50, phase: 'updating' });
        expect(h.writes).toEqual([]);
    });

    it('a saved answer for the previous wallet never seeds the new one', async () => {
        const h = harness({ A: { value: { n: 1 }, savedAtMs: 100 } });
        h.loader.setAddress('A');
        h.loader.setAddress('B');
        await h.releaseSaved('A');
        expect(h.loader.state.value).toBeNull();
    });

    it('a failed read keeps the saved answer and saves nothing; with nothing saved it is the error', async () => {
        const withSaved = harness({ A: { value: { n: 1 }, savedAtMs: 100 } });
        withSaved.loader.setAddress('A');
        await withSaved.releaseSaved('A');
        const load = withSaved.loader.load();
        withSaved.reads[0].resolve(null);
        await load;
        expect(withSaved.loader.state).toEqual({ value: { n: 1 }, savedAtMs: 100, phase: 'saved' });
        expect(withSaved.writes).toEqual([]);

        const empty = harness();
        empty.loader.setAddress('A');
        await empty.releaseSaved('A');
        const load2 = empty.loader.load();
        empty.reads[0].resolve(null);
        await load2;
        expect(empty.loader.state.phase).toBe('failed');
        expect(empty.emits.at(-1)?.busy).toBe(false);
    });

    it('overlapping loads share one read', async () => {
        const h = harness();
        h.loader.setAddress('A');
        const one = h.loader.load();
        const two = h.loader.load();
        expect(h.reads).toHaveLength(1);
        h.reads[0].resolve({ n: 3 });
        await Promise.all([one, two]);
        const three = h.loader.load();
        expect(h.reads).toHaveLength(2);
        h.reads[1].resolve({ n: 4 });
        await three;
    });

    it('the note: "Updating…" while refreshing a saved answer, "Updated <age>" after a failed refresh, none when fresh', () => {
        const t = (key: string, o?: Record<string, unknown>) => (o ? `${key}:${String(o.age ?? o.count)}` : key);
        expect(walletTopNote({ value: { n: 1 }, savedAtMs: 1, phase: 'updating' }, t, 'u', 'a')).toBe('u');
        expect(walletTopNote({ value: { n: 1 }, savedAtMs: 1_000, phase: 'saved' }, t, 'u', 'a', 1_000 + 5 * 60_000)).toBe('a:commonsHome.minutesAgo:5');
        expect(walletTopNote({ value: { n: 1 }, savedAtMs: 1, phase: 'fresh' }, t, 'u', 'a')).toBeUndefined();
    });
});

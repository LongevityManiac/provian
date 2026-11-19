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

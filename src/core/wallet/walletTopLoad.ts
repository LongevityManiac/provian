/**
 * How a relay-loaded value at the top of the Wallet screen is shown while it loads, refreshes and
 * fails. The rule: once the screen holds an answer (saved earlier or loaded now) it keeps showing
 * it. A refresh in flight is a quiet "Updating…" note, a refresh that finally failed is a quiet
 * "Updated <age>" note, and the "couldn't load" error appears only when there is nothing to show.
 */

export type WalletTopPhase =
    /** Nothing to show yet; the first read is on its way. */
    | 'loading'
    /** Showing a saved answer while a read is on its way. */
    | 'updating'
    /** Showing the answer this screen just read. */
    | 'fresh'
    /** Every retry failed; showing the last saved answer. */
    | 'saved'
    /** Every retry failed and there is nothing to show. */
    | 'failed';

export interface WalletTopShown<T> {
    readonly value: T | null;
    readonly savedAtMs: number | null;
    readonly phase: WalletTopPhase;
}

export function initialWalletTop<T>(): WalletTopShown<T> {
    return { value: null, savedAtMs: null, phase: 'loading' };
}

/** A saved answer arrived from storage. It never replaces an answer read in this session. */
export function seedWalletTop<T>(shown: WalletTopShown<T>, value: T, savedAtMs: number): WalletTopShown<T> {
    if (shown.value !== null) return shown;
    return { value, savedAtMs, phase: shown.phase === 'failed' ? 'saved' : 'updating' };
}

/** A read started. An answer on screen stays on screen. */
export function startWalletTop<T>(shown: WalletTopShown<T>): WalletTopShown<T> {
    if (shown.value === null) return { ...shown, phase: 'loading' };
    return { ...shown, phase: shown.phase === 'fresh' ? 'fresh' : 'updating' };
}

export function succeedWalletTop<T>(_shown: WalletTopShown<T>, value: T, nowMs: number): WalletTopShown<T> {
    return { value, savedAtMs: nowMs, phase: 'fresh' };
}

/** Every retry failed. Keep what is on screen; the error is only for an empty screen. */
export function failWalletTop<T>(shown: WalletTopShown<T>): WalletTopShown<T> {
    return { ...shown, phase: shown.value === null ? 'failed' : 'saved' };
}

/** Waits between a failed read and its next try. Three retries, about 12 s in all. */
export const WALLET_TOP_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000];

/**
 * Run `read` until it answers (anything but null), retrying after each wait in `delaysMs`. A
 * throw counts as no answer. Stops early, answering null, once `isCancelled()` is true.
 */
export async function readWithRetry<T>(
    read: () => Promise<T | null>,
    options: {
        readonly delaysMs?: readonly number[];
        readonly isCancelled?: () => boolean;
        readonly sleep?: (ms: number) => Promise<void>;
    } = {},
): Promise<T | null> {
    const delays = options.delaysMs ?? WALLET_TOP_RETRY_DELAYS_MS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const cancelled = options.isCancelled ?? (() => false);
    for (let attempt = 0; ; attempt++) {
        if (cancelled()) return null;
        let answer: T | null = null;
        try {
            answer = await read();
        } catch {
            answer = null;
        }
        if (answer !== null) return answer;
        if (attempt >= delays.length) return null;
        await sleep(delays[attempt]);
    }
}

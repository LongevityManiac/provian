import { timeAgo } from '../../utils/timeAgo';

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

export interface WalletTopSaved<T> {
    readonly value: T;
    readonly savedAtMs: number;
}

export interface WalletTopLoaderOptions<T> {
    /** One relay read. `null` or a throw means the relay did not answer — never an empty answer. */
    readonly read: () => Promise<T | null>;
    readonly readSaved: (address: string) => Promise<WalletTopSaved<T> | null>;
    readonly save: (address: string, value: T) => unknown;
    readonly onChange: (shown: WalletTopShown<T>, busy: boolean) => void;
    readonly delaysMs?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
}

/**
 * One relay-loaded value at the top of the Wallet screen, for one wallet at a time.
 *
 * - `setAddress` switches wallets: the screen empties, the new wallet's saved answer seeds it, and
 *   every read begun for the previous wallet is ignored when it lands.
 * - `load` reads with retries. Overlapping calls share the read in flight; a read that lands after
 *   a newer one began, or after a wallet switch, changes nothing.
 * - A saved answer never replaces an answer read in this session.
 */
export class WalletTopLoader<T> {
    private shown: WalletTopShown<T> = initialWalletTop<T>();
    private address: string | null = null;
    /** Bumped on every wallet switch. */
    private epoch = 0;
    /** Bumped on every read begun. */
    private run = 0;
    private inFlight: Promise<void> | null = null;

    constructor(private readonly options: WalletTopLoaderOptions<T>) {}

    get state(): WalletTopShown<T> {
        return this.shown;
    }

    setAddress(address: string | null): void {
        if (address === this.address) return;
        this.address = address;
        this.epoch += 1;
        this.run += 1;
        this.inFlight = null;
        this.set(initialWalletTop<T>());
        if (!address) return;
        const epoch = this.epoch;
        void this.options.readSaved(address).then(saved => {
            if (saved && this.epoch === epoch) this.set(seedWalletTop(this.shown, saved.value, saved.savedAtMs));
        }, () => undefined);
    }

    load(): Promise<void> {
        if (this.inFlight) return this.inFlight;
        const address = this.address;
        if (!address) return Promise.resolve();
        const epoch = this.epoch;
        const run = ++this.run;
        const current = () => this.epoch === epoch && this.run === run;
        this.set(startWalletTop(this.shown), true);
        const flight = (async () => {
            const data = await readWithRetry(this.options.read, {
                delaysMs: this.options.delaysMs,
                sleep: this.options.sleep,
                isCancelled: () => !current(),
            });
            if (!current()) return;
            if (data !== null) {
                this.set(succeedWalletTop(this.shown, data, (this.options.now ?? Date.now)()), false);
                void this.options.save(address, data);
            } else {
                this.set(failWalletTop(this.shown), false);
            }
        })().finally(() => {
            if (this.inFlight === flight) this.inFlight = null;
        });
        this.inFlight = flight;
        return flight;
    }

    private set(shown: WalletTopShown<T>, busy: boolean = this.inFlight !== null): void {
        this.shown = shown;
        this.options.onChange(shown, busy);
    }
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The quiet line under a shown answer: "Updating…" while it refreshes, "Updated <age>" after a failed refresh. */
export function walletTopNote<T>(
    shown: WalletTopShown<T>,
    t: Translate,
    updatingKey: string,
    updatedAgoKey: string,
    nowMs: number = Date.now(),
): string | undefined {
    if (shown.phase === 'updating') return t(updatingKey);
    if (shown.phase === 'saved' && shown.savedAtMs !== null) return t(updatedAgoKey, { age: timeAgo(shown.savedAtMs, t, nowMs) });
    return undefined;
}

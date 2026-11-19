/**
 * useAttentionCount (item 4) — the ONE attention count the Dashboard bell and the Wallet-tab badge
 * both show. It loads on mount, every 30 s, whenever the app returns to the foreground, and whenever
 * anything calls `requestAttentionRefresh()` (a received push, an item accepted/declined/resolved).
 * Concurrent consumers share one in-flight load, so the bell and the tab badge never disagree and
 * never double the relay traffic. Opens on the count saved for this wallet and degrades to the last
 * known count (0 when nothing was ever saved).
 *
 * review 2 #8: a refresh REQUESTED after a mutation is answered by a load that begins after
 * it. An in-flight load is shared only when it began at the current refresh generation
 * (`attentionRefreshGeneration`); otherwise a fresh load starts (and every consumer of the same
 * request shares that one). Each consumer applies a result only when it is newer than the last one
 * it applied, so an older load resolving late can never put a pre-mutation count back.
 */
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { loadAttention, type AttentionSnapshot } from './attention';
import { attentionRefreshGeneration, onAttentionRefresh } from './attentionRefresh';
import { isSavedCount, readWalletTop, saveWalletTop } from '../wallet/walletTopCache';
import { useWalletStore } from '../../store/walletStore';

const POLL_MS = 30_000;

/** A load's result with its start order (monotonic per process) and the wallet it was read for. */
export interface SequencedAttention {
    readonly snapshot: AttentionSnapshot;
    readonly seq: number;
    readonly address: string | null;
}

let loadSeq = 0;
let inFlight: { generation: number; address: string | null; run: Promise<SequencedAttention> } | null = null;

const sameWallet = (a: string | null | undefined, b: string | null | undefined): boolean =>
    (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

function loadAttentionSequenced(): Promise<SequencedAttention> {
    const generation = attentionRefreshGeneration();
    const address = useWalletStore.getState().address ?? null;
    // Join a load in flight only for the same wallet; a switch starts its own.
    if (inFlight && inFlight.generation >= generation && sameWallet(inFlight.address, address)) return inFlight.run;
    const seq = ++loadSeq;
    const run = loadAttention().then((snapshot) => {
        // The bell opens on this count next time, for this wallet only — and only a count the
        // relay actually answered (a failed load reads as 0 and must never replace a known count).
        if (snapshot.answered) void saveWalletTop('attentionCount', address, snapshot.count);
        return { snapshot, seq, address };
    });
    const entry = { generation, address, run };
    inFlight = entry;
    void run.then(
        () => { if (inFlight === entry) inFlight = null; },
        () => { if (inFlight === entry) inFlight = null; },
    );
    return run;
}

/**
 * Whether a finished load may set the bell for the wallet now shown: the relay must have answered
 * (a failed load reads as 0) and the load must have been for this same wallet.
 */
export function attentionLoadApplies(
    result: { readonly snapshot: Pick<AttentionSnapshot, 'answered'>; readonly address: string | null },
    currentAddress: string | null | undefined,
): boolean {
    return result.snapshot.answered && sameWallet(result.address, currentAddress);
}

/**
 * A consumer's newest-wins gate: accepts a load's sequence number only when it is at least the
 * newest already accepted, so an older round resolving late never overwrites a newer count.
 */
export function createNewestLoadGate(): (seq: number) => boolean {
    let applied = 0;
    return (seq: number) => {
        if (seq < applied) return false;
        applied = seq;
        return true;
    };
}

/**
 * loadAttention(), coalesced: callers that overlap share one relay round — unless a refresh was
 * requested after that round began, in which case a fresh round starts (review 2 #8).
 */
export function loadAttentionShared(): Promise<AttentionSnapshot> {
    return loadAttentionSequenced().then((r) => r.snapshot);
}

/**
 * The bell's count for the wallet now shown, outside React so its rules are testable:
 * - a wallet switch empties the count, seeds that wallet's saved count and starts its own load;
 * - only an answered load for the wallet now shown sets the count (a failed one keeps it);
 * - an older load resolving late never overwrites a newer count;
 * - the saved count never replaces a count read in this session.
 */
export class AttentionCountController {
    private address: string | null = null;
    private started = false;
    private epoch = 0;
    private loaded = false;
    private active = true;
    private readonly accept = createNewestLoadGate();

    constructor(private readonly deps: {
        readonly load: () => Promise<SequencedAttention>;
        readonly readSaved: (address: string | null) => Promise<number | null>;
        readonly setCount: (count: number) => void;
    }) {}

    setAddress(address: string | null): void {
        if (this.started && sameWallet(address, this.address)) return;
        const first = !this.started;
        this.started = true;
        this.address = address;
        this.epoch += 1;
        this.loaded = false;
        this.deps.setCount(0); // never another wallet's count
        const epoch = this.epoch;
        void this.deps.readSaved(address).then((saved) => {
            if (saved !== null && this.active && this.epoch === epoch && !this.loaded) this.deps.setCount(saved);
        }, () => undefined);
        // The first wallet is loaded by the mount; a switch loads its own.
        if (!first) this.refresh();
    }

    refresh(): void {
        void this.deps.load().then((r) => {
            if (!this.active || !attentionLoadApplies(r, this.address)) return;
            if (!this.accept(r.seq)) return;
            this.loaded = true;
            this.deps.setCount(r.snapshot.count);
        }, () => {
            // Degrade to the last known count.
        });
    }

    setActive(active: boolean): void {
        this.active = active;
    }
}

export function useAttentionCount(): { count: number; refresh: () => void } {
    const [count, setCount] = React.useState(0);
    const controller = React.useRef<AttentionCountController | null>(null);
    controller.current ??= new AttentionCountController({
        load: loadAttentionSequenced,
        readSaved: async (wallet) => (await readWalletTop('attentionCount', wallet, isSavedCount))?.value ?? null,
        setCount,
    });
    const address = useWalletStore((state) => state.address);

    React.useEffect(() => {
        controller.current!.setAddress(address ?? null);
    }, [address]);

    const refresh = React.useCallback(() => controller.current!.refresh(), []);

    React.useEffect(() => {
        controller.current!.setActive(true);
        refresh();
        const id = setInterval(refresh, POLL_MS);
        const unsubscribe = onAttentionRefresh(refresh);
        const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
            if (state === 'active') refresh();
        });
        return () => {
            controller.current!.setActive(false);
            clearInterval(id);
            unsubscribe();
            appStateSub.remove();
        };
    }, [refresh]);

    return { count, refresh };
}

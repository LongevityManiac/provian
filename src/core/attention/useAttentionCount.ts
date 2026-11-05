/**
 * useAttentionCount (item 4) — the ONE attention count the Dashboard bell and the Wallet-tab badge
 * both show. It loads on mount, every 30 s, whenever the app returns to the foreground, and whenever
 * anything calls `requestAttentionRefresh()` (a received push, an item accepted/declined/resolved).
 * Concurrent consumers share one in-flight load, so the bell and the tab badge never disagree and
 * never double the relay traffic. Degrades to the last known count (0 before the first load).
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

const POLL_MS = 30_000;

/** A load's result with its start order (monotonic per process). */
interface SequencedAttention {
    readonly snapshot: AttentionSnapshot;
    readonly seq: number;
}

let loadSeq = 0;
let inFlight: { generation: number; run: Promise<SequencedAttention> } | null = null;

function loadAttentionSequenced(): Promise<SequencedAttention> {
    const generation = attentionRefreshGeneration();
    if (inFlight && inFlight.generation >= generation) return inFlight.run;
    const seq = ++loadSeq;
    const run = loadAttention().then((snapshot) => ({ snapshot, seq }));
    const entry = { generation, run };
    inFlight = entry;
    void run.then(
        () => { if (inFlight === entry) inFlight = null; },
        () => { if (inFlight === entry) inFlight = null; },
    );
    return run;
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

export function useAttentionCount(): { count: number; refresh: () => void } {
    const [count, setCount] = React.useState(0);
    const mounted = React.useRef(true);
    const accept = React.useRef(createNewestLoadGate()).current;

    const refresh = React.useCallback(() => {
        void loadAttentionSequenced().then((r) => {
            // Newest load wins: an older round resolving late never overwrites a newer count.
            if (!mounted.current || !accept(r.seq)) return;
            setCount(r.snapshot.count);
        }, () => {
            // Degrade to the last known count.
        });
    }, [accept]);

    React.useEffect(() => {
        mounted.current = true;
        refresh();
        const id = setInterval(refresh, POLL_MS);
        const unsubscribe = onAttentionRefresh(refresh);
        const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
            if (state === 'active') refresh();
        });
        return () => {
            mounted.current = false;
            clearInterval(id);
            unsubscribe();
            appStateSub.remove();
        };
    }, [refresh]);

    return { count, refresh };
}

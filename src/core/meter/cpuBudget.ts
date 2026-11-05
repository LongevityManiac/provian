/**
 * A time budget for meter work on the JS thread (findings, 2026-10-23).
 *
 * React Native runs every tap, navigation and network callback on the one JS thread the meter's
 * crypto also uses. Live, a single synchronous proofs loop held that thread for minutes. A loop that
 * may do unbounded work calls `pace()` between units: once the current slice has run for
 * `sliceMs`, the loop gives the thread back for one macrotask, so the screens never wait longer than
 * one slice plus one unit. Bounded by elapsed time, not by a count of items.
 */

export interface CpuBudget {
    /** Give the thread back if this slice has used its time. Cheap when it has not. */
    pace(): Promise<void>;
}

/** The longest the meter holds the JS thread in one slice. */
export const METER_SLICE_MS = 8;
/**
 * How long the meter stays off the JS thread when it gives it back: one frame. A zero-delay timer
 * on iOS can fire again at once (React Native's native timer), which gives the screens almost no
 * room; a frame-long pause lets every pending touch, navigation and render run (live, 2026-10-23).
 */
export const METER_YIELD_MS = 16;

export function macrotask(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, METER_YIELD_MS));
}

export function cpuBudget(options: { readonly sliceMs?: number; readonly now?: () => number; readonly yieldToUi?: () => Promise<void> } = {}): CpuBudget {
    const sliceMs = options.sliceMs ?? METER_SLICE_MS;
    const now = options.now ?? (() => Date.now());
    const yieldToUi = options.yieldToUi ?? macrotask;
    let sliceStart = now();
    return {
        async pace(): Promise<void> {
            if (now() - sliceStart < sliceMs) return;
            await yieldToUi();
            sliceStart = now();
        },
    };
}

/** For callers (and tests) that must not pause: never yields. */
export const UNPACED: CpuBudget = { pace: async () => undefined };

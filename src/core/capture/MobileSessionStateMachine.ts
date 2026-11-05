/**
 * MobileSessionStateMachine: pure TypeScript session state machine for the
 * mobile Chat WebView surface. Structurally mirrors the desktop
 * LLMSessionStateMachine at
 * `provian-agent-sdk/src/observer/plugins/llm-session/stateMachine.ts`,
 * with one deliberate functional difference: the Grok timestamp-gap check
 * delegates to `detectGrokBoundary` from `./GrokSessionBoundary.ts`, which
 * uses strict-greater-than semantics. Desktop uses `>=`. The two surfaces
 * therefore finalize Grok sessions one millisecond apart at the exact-gap
 * boundary. This is intentional per M2 sign-off.
 *
 * No React Native imports. No I/O. Time is passed in by the caller so
 * tests drive the machine deterministically.
 *
 * Mobile event source mapping (documented here so callers know what to feed):
 *   - `foreground_changed` : WebView navigation changes the active provider
 *     or session ID, AND app foreground/background transitions. App-
 *     backgrounded => emit with `providerContext: null`; app-foregrounded
 *     onto a matching provider URL => emit with the ProviderContext.
 *   - `input_event`        : keyboard input signals. M3 supplies these from
 *     `Keyboard.addListener('keyboardDidShow', ...)` or from the
 *     MutationObserver bridge installed in M4. M3 ships only the event
 *     type; actual wiring lands downstream.
 *   - `tick`               : 1 Hz clock from the caller, same as desktop.
 *   - `system_state`       : phone lock / unlock, sleep / wake. Retained
 *     for parity with desktop; on iOS and Android these events are rarer
 *     and often subsumed by app-background, but callers can feed them
 *     when they surface.
 *   - `shutdown`           : app terminate signal.
 *
 * Spec of record: docs/PHASE_2C_DESIGN_NOTES.md §5.M3 and
 * docs/PHASE_2B_DESIGN_NOTES.md §7.
 */

import { detectGrokBoundary } from './GrokSessionBoundary';

export type InputFidelity = 'full' | 'presence_only';

export type SessionBoundaryMode = 'url_session_id' | 'timestamp_gap';

export interface ProviderContext {
    provider: string;
    sessionId: string | null;
    boundaryMode: SessionBoundaryMode;
    /** Required when boundaryMode is 'timestamp_gap', else null. */
    timestampGapMs: number | null;
}

export type MachineInput =
    | { t: 'foreground_changed'; ts: number; providerContext: ProviderContext | null }
    | { t: 'input_event'; ts: number }
    | { t: 'tick'; ts: number }
    | { t: 'system_state'; ts: number; state: 'sleep' | 'wake' | 'lock' | 'unlock' }
    | { t: 'shutdown'; ts: number };

export interface EmissionPayload {
    provider: string;
    sessionId: string | null;
    windowStart: number;
    windowEnd: number;
    inputEventCount: number;
    turnCount: number;
    activeDurationMs: number;
    inputFidelity: InputFidelity;
}

export type MachineOutput =
    | ({ t: 'emit_heartbeat' } & EmissionPayload)
    | ({ t: 'emit_session_end' } & EmissionPayload);

export interface StateMachineConfig {
    /** Candidate to Active promotion window. Default 30s. */
    candidateWindowMs: number;
    /** Active to Idle grace after foreground loss. Default 60s. */
    closingWindowMs: number;
    /** Heartbeat interval for sustained active sessions. Default 30min. */
    heartbeatIntervalMs: number;
    /** Input gap threshold for turn-count clustering. Default 10s. */
    turnGapMs: number;
}

export const DEFAULT_STATE_MACHINE_CONFIG: StateMachineConfig = {
    candidateWindowMs: 30_000,
    closingWindowMs: 60_000,
    heartbeatIntervalMs: 30 * 60 * 1000,
    turnGapMs: 10_000,
};

interface ActiveLikeBase {
    provider: string;
    sessionId: string | null;
    boundaryMode: SessionBoundaryMode;
    timestampGapMs: number | null;
    startedAt: number;
    lastInputAt: number;
    lastHeartbeatAt: number;
    windowStart: number;
    inputEventTimestamps: number[];
}

export type PluginState =
    | { kind: 'idle' }
    | {
          kind: 'candidate';
          provider: string;
          sessionId: string | null;
          boundaryMode: SessionBoundaryMode;
          timestampGapMs: number | null;
          since: number;
          inputSeen: boolean;
          inputEventTimestamps: number[];
      }
    | ({ kind: 'active' } & ActiveLikeBase)
    | ({ kind: 'closing'; foregroundLostAt: number } & ActiveLikeBase);

export interface StateMachineOptions {
    config?: Partial<StateMachineConfig>;
    inputFidelity?: InputFidelity;
}

export class MobileSessionStateMachine {
    private state: PluginState = { kind: 'idle' };
    private readonly config: StateMachineConfig;
    private inputFidelity: InputFidelity;
    /**
     * The provider on screen, kept while the WebView stays foregrounded. Typing after a session
     * ended on this surface (a Grok timestamp gap, or a candidate that was dropped for silence)
     * used to be lost until the next foreground change: the machine sat idle with nowhere to put
     * the input (2026-10-17 bug check). With the context kept, input on the same surface opens a
     * fresh candidate.
     */
    private foregroundContext: ProviderContext | null = null;

    constructor(opts: StateMachineOptions = {}) {
        this.config = { ...DEFAULT_STATE_MACHINE_CONFIG, ...(opts.config ?? {}) };
        this.inputFidelity = opts.inputFidelity ?? 'full';
    }

    getState(): PluginState {
        return this.state;
    }

    getConfig(): StateMachineConfig {
        return { ...this.config };
    }

    getInputFidelity(): InputFidelity {
        return this.inputFidelity;
    }

    setInputFidelity(f: InputFidelity): void {
        this.inputFidelity = f;
    }

    step(input: MachineInput): MachineOutput[] {
        switch (input.t) {
            case 'foreground_changed':
                return this.onForegroundChanged(input.ts, input.providerContext);
            case 'input_event':
                return this.onInputEvent(input.ts);
            case 'tick':
                return this.onTick(input.ts);
            case 'system_state':
                return this.onSystemState(input.ts, input.state);
            case 'shutdown':
                return this.onShutdown(input.ts);
        }
    }

    // --- handlers ---------------------------------------------------------

    private onForegroundChanged(ts: number, ctx: ProviderContext | null): MachineOutput[] {
        const s = this.state;
        this.foregroundContext = ctx;

        if (s.kind === 'idle') {
            if (ctx) this.state = this.newCandidate(ts, ctx);
            return [];
        }

        if (s.kind === 'candidate') {
            if (!ctx) {
                this.state = { kind: 'idle' };
                return [];
            }
            if (ctx.provider === s.provider && sameSessionId(ctx, s)) {
                return [];
            }
            this.state = this.newCandidate(ts, ctx);
            return [];
        }

        if (s.kind === 'active') {
            if (ctx && ctx.provider === s.provider && sameSessionId(ctx, s)) {
                return [];
            }
            if (!ctx) {
                this.state = { kind: 'closing', foregroundLostAt: ts, ...pickActiveFields(s) };
                return [];
            }
            const outputs: MachineOutput[] = [];
            if (ts > s.windowStart) {
                outputs.push(this.buildEmission('emit_session_end', s, ts));
            }
            this.state = this.newCandidate(ts, ctx);
            return outputs;
        }

        // closing
        if (!ctx) {
            return [];
        }
        if (ctx.provider === s.provider && sameSessionId(ctx, s)) {
            this.state = { kind: 'active', ...pickActiveFields(s) };
            return [];
        }
        const outputs: MachineOutput[] = [];
        if (s.foregroundLostAt > s.windowStart) {
            outputs.push(this.buildEmission('emit_session_end', s, s.foregroundLostAt));
        }
        this.state = this.newCandidate(ts, ctx);
        return outputs;
    }

    private onInputEvent(ts: number): MachineOutput[] {
        const s = this.state;
        if (s.kind === 'candidate') {
            s.inputSeen = true;
            s.inputEventTimestamps.push(ts);
            // Real input is the engagement signal. At full fidelity, promote
            // immediately rather than waiting out the candidate window: the
            // window's noise-filtering job (accidental opens, app switching)
            // is already done by the input requirement, and waiting silently
            // drops short real sessions ("quick question, then close").
            // This gate is client-side and so is not an anti-farming control;
            // economic protection lives in the relay's weight framework
            // (duration/turn-count weights, diminishing returns, device rate
            // limits). presence_only surfaces cannot observe input, so they
            // still earn promotion only by time (see onTick).
            if (this.inputFidelity === 'full') {
                this.state = {
                    kind: 'active',
                    provider: s.provider,
                    sessionId: s.sessionId,
                    boundaryMode: s.boundaryMode,
                    timestampGapMs: s.timestampGapMs,
                    startedAt: s.since,
                    lastInputAt: ts,
                    lastHeartbeatAt: s.since,
                    windowStart: s.since,
                    inputEventTimestamps: s.inputEventTimestamps.slice(),
                };
            }
            return [];
        }
        if (s.kind === 'active') {
            s.inputEventTimestamps.push(ts);
            s.lastInputAt = ts;
            return [];
        }
        if (s.kind === 'idle' && this.foregroundContext !== null) {
            // Input on a surface that is still on screen: a new conversation begins where the
            // last one ended. The candidate then promotes exactly as a fresh open would.
            this.state = this.newCandidate(ts, this.foregroundContext);
            return this.onInputEvent(ts);
        }
        return [];
    }

    private onTick(ts: number): MachineOutput[] {
        const s = this.state;
        if (s.kind === 'candidate') {
            const elapsed = ts - s.since;
            const canPromote =
                elapsed >= this.config.candidateWindowMs &&
                (this.inputFidelity === 'presence_only' || s.inputSeen);
            const shouldDrop = elapsed >= this.config.candidateWindowMs && !canPromote;
            if (canPromote) {
                this.state = {
                    kind: 'active',
                    provider: s.provider,
                    sessionId: s.sessionId,
                    boundaryMode: s.boundaryMode,
                    timestampGapMs: s.timestampGapMs,
                    startedAt: s.since,
                    lastInputAt:
                        s.inputEventTimestamps.length > 0
                            ? s.inputEventTimestamps[s.inputEventTimestamps.length - 1]
                            : s.since,
                    lastHeartbeatAt: s.since,
                    windowStart: s.since,
                    inputEventTimestamps: s.inputEventTimestamps.slice(),
                };
            } else if (shouldDrop) {
                this.state = { kind: 'idle' };
            }
            return [];
        }

        if (s.kind === 'active') {
            const outputs: MachineOutput[] = [];
            if (ts - s.lastHeartbeatAt >= this.config.heartbeatIntervalMs) {
                outputs.push(this.buildEmission('emit_heartbeat', s, ts));
                s.windowStart = ts;
                s.lastHeartbeatAt = ts;
                s.inputEventTimestamps = [];
            }
            if (
                s.boundaryMode === 'timestamp_gap' &&
                s.timestampGapMs !== null &&
                detectGrokBoundary(s.lastInputAt, ts, s.timestampGapMs / 1000)
            ) {
                const endAt = s.lastInputAt;
                if (endAt > s.windowStart) {
                    outputs.push(this.buildEmission('emit_session_end', s, endAt));
                }
                this.state = { kind: 'idle' };
            }
            return outputs;
        }

        if (s.kind === 'closing') {
            if (ts - s.foregroundLostAt >= this.config.closingWindowMs) {
                const outputs: MachineOutput[] = [];
                if (s.foregroundLostAt > s.windowStart) {
                    outputs.push(this.buildEmission('emit_session_end', s, s.foregroundLostAt));
                }
                this.state = { kind: 'idle' };
                return outputs;
            }
            return [];
        }

        return [];
    }

    private onSystemState(
        ts: number,
        state: 'sleep' | 'wake' | 'lock' | 'unlock',
    ): MachineOutput[] {
        if (state !== 'sleep' && state !== 'lock') return [];
        const s = this.state;
        if (s.kind === 'active') {
            const outputs: MachineOutput[] = [];
            if (ts > s.windowStart) outputs.push(this.buildEmission('emit_session_end', s, ts));
            this.state = { kind: 'idle' };
            return outputs;
        }
        if (s.kind === 'closing') {
            const outputs: MachineOutput[] = [];
            if (s.foregroundLostAt > s.windowStart) {
                outputs.push(this.buildEmission('emit_session_end', s, s.foregroundLostAt));
            }
            this.state = { kind: 'idle' };
            return outputs;
        }
        if (s.kind === 'candidate') {
            this.state = { kind: 'idle' };
        }
        return [];
    }

    private onShutdown(ts: number): MachineOutput[] {
        const s = this.state;
        if (s.kind === 'active') {
            const outputs: MachineOutput[] = [];
            if (ts > s.windowStart) outputs.push(this.buildEmission('emit_session_end', s, ts));
            this.state = { kind: 'idle' };
            return outputs;
        }
        if (s.kind === 'closing') {
            const outputs: MachineOutput[] = [];
            if (s.foregroundLostAt > s.windowStart) {
                outputs.push(this.buildEmission('emit_session_end', s, s.foregroundLostAt));
            }
            this.state = { kind: 'idle' };
            return outputs;
        }
        if (s.kind === 'candidate') {
            this.state = { kind: 'idle' };
        }
        return [];
    }

    // --- construction helpers --------------------------------------------

    private newCandidate(ts: number, ctx: ProviderContext): PluginState {
        return {
            kind: 'candidate',
            provider: ctx.provider,
            sessionId: ctx.sessionId,
            boundaryMode: ctx.boundaryMode,
            timestampGapMs: ctx.timestampGapMs,
            since: ts,
            inputSeen: false,
            inputEventTimestamps: [],
        };
    }

    private buildEmission(
        kind: 'emit_heartbeat' | 'emit_session_end',
        state: ActiveLikeBase,
        windowEnd: number,
    ): MachineOutput {
        const windowStart = state.windowStart;
        const windowEvents = state.inputEventTimestamps.filter(
            t => t >= windowStart && t <= windowEnd,
        );
        const durationMs = Math.max(0, windowEnd - windowStart);

        let turnCount: number;
        let activeDurationMs: number;
        if (this.inputFidelity === 'presence_only') {
            turnCount = 0;
            activeDurationMs = durationMs;
        } else {
            turnCount = computeTurnCount(windowEvents, this.config.turnGapMs);
            activeDurationMs = computeActiveDurationMs(
                windowEvents,
                windowStart,
                windowEnd,
                this.config.turnGapMs,
            );
        }

        return {
            t: kind,
            provider: state.provider,
            sessionId: state.sessionId,
            windowStart,
            windowEnd,
            inputEventCount: windowEvents.length,
            turnCount,
            activeDurationMs,
            inputFidelity: this.inputFidelity,
        };
    }
}

// --- pure helpers (exported for direct testing) -------------------------

export function computeTurnCount(events: number[], turnGapMs: number): number {
    if (events.length === 0) return 0;
    const sorted = [...events].sort((a, b) => a - b);
    let turns = 1;
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - sorted[i - 1] > turnGapMs) turns++;
    }
    return turns;
}

/**
 * Active duration: union of [t_i, t_i + turnGapMs] intervals clipped to
 * [windowStart, windowEnd]. Tick-rate independent.
 */
export function computeActiveDurationMs(
    events: number[],
    windowStart: number,
    windowEnd: number,
    turnGapMs: number,
): number {
    if (events.length === 0 || windowEnd <= windowStart) return 0;
    const intervals = events
        .map(
            t =>
                [Math.max(t, windowStart), Math.min(t + turnGapMs, windowEnd)] as [number, number],
        )
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);

    if (intervals.length === 0) return 0;

    let total = 0;
    let [curStart, curEnd] = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
        const [s, e] = intervals[i];
        if (s <= curEnd) {
            if (e > curEnd) curEnd = e;
        } else {
            total += curEnd - curStart;
            curStart = s;
            curEnd = e;
        }
    }
    total += curEnd - curStart;
    return total;
}

// --- local utilities --------------------------------------------------

function sameSessionId(
    ctx: ProviderContext,
    state: { sessionId: string | null; boundaryMode: SessionBoundaryMode },
): boolean {
    if (state.boundaryMode === 'timestamp_gap') return true;
    return ctx.sessionId === state.sessionId;
}

function pickActiveFields(s: ActiveLikeBase): ActiveLikeBase {
    return {
        provider: s.provider,
        sessionId: s.sessionId,
        boundaryMode: s.boundaryMode,
        timestampGapMs: s.timestampGapMs,
        startedAt: s.startedAt,
        lastInputAt: s.lastInputAt,
        lastHeartbeatAt: s.lastHeartbeatAt,
        windowStart: s.windowStart,
        inputEventTimestamps: s.inputEventTimestamps,
    };
}

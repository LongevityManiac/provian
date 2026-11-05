/**
 * MobileSessionStateMachine tests. Structure mirrors
 * `provian-agent-sdk/src/observer/plugins/llm-session/stateMachine.test.ts`
 * adapted for mobile event sources, plus coverage of the Grok detector
 * wiring.
 *
 * Important Grok semantic: the mobile port delegates the timestamp-gap
 * check to `detectGrokBoundary`, which uses strict greater-than. Desktop
 * uses `>=`. The exact-gap boundary differs by one millisecond. Tests
 * reflect the mobile semantic explicitly.
 */

import { describe, it, expect } from 'vitest';
import {
    MobileSessionStateMachine,
    computeTurnCount,
    computeActiveDurationMs,
    type MachineInput,
    type MachineOutput,
    type ProviderContext,
} from '../MobileSessionStateMachine';

const URL_CTX = (sessionId: string | null = 'abc-123'): ProviderContext => ({
    provider: 'claude',
    sessionId,
    boundaryMode: 'url_session_id',
    timestampGapMs: null,
});

const GROK_CTX = (gapMs = 300_000): ProviderContext => ({
    provider: 'grok',
    sessionId: null,
    boundaryMode: 'timestamp_gap',
    timestampGapMs: gapMs,
});

function drive(sm: MobileSessionStateMachine, inputs: MachineInput[]): MachineOutput[] {
    const out: MachineOutput[] = [];
    for (const i of inputs) out.push(...sm.step(i));
    return out;
}

describe('MobileSessionStateMachine: candidate promotion', () => {
    it('returns to idle when no input event arrives in the 30s window', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'tick', ts: 10_000 },
            { t: 'tick', ts: 20_000 },
            { t: 'tick', ts: 30_000 },
        ]);
        expect(out).toEqual([]);
        expect(sm.getState().kind).toBe('idle');
    });

    it('promotes to active when input arrives and 30s elapses', () => {
        const sm = new MobileSessionStateMachine();
        drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
        ]);
        expect(sm.getState().kind).toBe('active');
    });

    it('promotes immediately on first input at full fidelity', () => {
        const sm = new MobileSessionStateMachine();
        drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 1_000 },
        ]);
        expect(sm.getState().kind).toBe('active');
    });

    it('emits a session for a quick question followed by an early close', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'foreground_changed', ts: 12_000, providerContext: null },
            { t: 'shutdown', ts: 13_000 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].t).toBe('emit_session_end');
        expect(out[0].windowStart).toBe(0);
        expect(out[0].windowEnd).toBe(12_000);
        expect(out[0].inputEventCount).toBe(1);
    });

    it('does not promote presence_only on tick before the candidate window elapses', () => {
        const sm = new MobileSessionStateMachine({ inputFidelity: 'presence_only' });
        drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'tick', ts: 29_000 },
        ]);
        expect(sm.getState().kind).toBe('candidate');
    });

    it('presence_only bypasses the input requirement for promotion', () => {
        const sm = new MobileSessionStateMachine({ inputFidelity: 'presence_only' });
        drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'tick', ts: 30_000 },
        ]);
        expect(sm.getState().kind).toBe('active');
    });

    it('drops candidate when the Chat tab is backgrounded before promotion', () => {
        const sm = new MobileSessionStateMachine();
        drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'foreground_changed', ts: 10_000, providerContext: null },
        ]);
        expect(sm.getState().kind).toBe('idle');
    });
});

describe('MobileSessionStateMachine: heartbeat', () => {
    it('emits a heartbeat after 30 minutes of continuous active session', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'input_event', ts: 1_000_000 },
            { t: 'tick', ts: 1_800_000 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].t).toBe('emit_heartbeat');
        expect(out[0].windowStart).toBe(0);
        expect(out[0].windowEnd).toBe(1_800_000);
    });

    it('resets windowStart after heartbeat so the next emission covers only the new window', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'tick', ts: 1_800_000 },
            { t: 'foreground_changed', ts: 2_000_000, providerContext: null },
            { t: 'tick', ts: 2_060_000 },
        ]);
        expect(out).toHaveLength(2);
        expect(out[0].t).toBe('emit_heartbeat');
        expect(out[0].windowStart).toBe(0);
        expect(out[0].windowEnd).toBe(1_800_000);
        expect(out[1].t).toBe('emit_session_end');
        expect(out[1].windowStart).toBe(1_800_000);
        expect(out[1].windowEnd).toBe(2_000_000);
    });
});

describe('MobileSessionStateMachine: closing grace window', () => {
    it('returns to active when foreground returns within 60s with same session id', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX('s1') },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'foreground_changed', ts: 100_000, providerContext: null },
            { t: 'foreground_changed', ts: 120_000, providerContext: URL_CTX('s1') },
        ]);
        expect(out).toEqual([]);
        expect(sm.getState().kind).toBe('active');
    });

    it('ends the session after 60s of continuous foreground loss', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'foreground_changed', ts: 100_000, providerContext: null },
            { t: 'tick', ts: 160_000 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].t).toBe('emit_session_end');
        expect(out[0].windowStart).toBe(0);
        expect(out[0].windowEnd).toBe(100_000);
        expect(sm.getState().kind).toBe('idle');
    });

    it('ends the session and starts a new candidate when foreground switches to a different session id', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX('s1') },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'foreground_changed', ts: 100_000, providerContext: URL_CTX('s2') },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].t).toBe('emit_session_end');
        expect(out[0].sessionId).toBe('s1');
        expect(sm.getState().kind).toBe('candidate');
    });

    it('closing returns to active when foreground_changed arrives with the same provider before closingWindowMs', () => {
        const m = new MobileSessionStateMachine();
        const ctx: ProviderContext = {
            provider: 'claude',
            sessionId: 'abc',
            boundaryMode: 'url_session_id',
            timestampGapMs: null,
        };

        // Enter candidate, promote to active
        m.step({ t: 'foreground_changed', ts: 0, providerContext: ctx });
        m.step({ t: 'input_event', ts: 5_000 });
        m.step({ t: 'tick', ts: 30_000 });
        expect(m.getState().kind).toBe('active');

        // Backgrounded: enter closing
        m.step({ t: 'foreground_changed', ts: 60_000, providerContext: null });
        expect(m.getState().kind).toBe('closing');

        // Re-foreground after 45s (inside 60s closingWindowMs) with same provider.
        // This is what the AppState listener synthesizes.
        m.step({ t: 'foreground_changed', ts: 105_000, providerContext: ctx });
        expect(m.getState().kind).toBe('active');

        // A later tick past the old closingWindowMs should NOT emit session_end
        // since we resumed the active session.
        const outputs = m.step({ t: 'tick', ts: 200_000 });
        expect(outputs.filter(o => o.t === 'emit_session_end')).toEqual([]);
    });
});

describe('MobileSessionStateMachine: termination on system_state and shutdown', () => {
    it('ends session immediately on sleep during active', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'system_state', ts: 500_000, state: 'sleep' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].t).toBe('emit_session_end');
        expect(out[0].windowEnd).toBe(500_000);
        expect(sm.getState().kind).toBe('idle');
    });

    it('ends session immediately on lock during active', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'system_state', ts: 500_000, state: 'lock' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].t).toBe('emit_session_end');
    });

    it('ignores wake and unlock events', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'system_state', ts: 100_000, state: 'wake' },
            { t: 'system_state', ts: 200_000, state: 'unlock' },
        ]);
        expect(out).toEqual([]);
        expect(sm.getState().kind).toBe('active');
    });

    it('ends session on shutdown during active', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'shutdown', ts: 900_000 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].t).toBe('emit_session_end');
        expect(out[0].windowEnd).toBe(900_000);
    });

    it('finalizes a closing session at foregroundLostAt on shutdown', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'foreground_changed', ts: 100_000, providerContext: null },
            { t: 'shutdown', ts: 130_000 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].windowEnd).toBe(100_000);
    });
});

describe('MobileSessionStateMachine: Grok timestamp-gap boundaries', () => {
    it('ends session when input gap exceeds timestampGapMs (strict >)', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: GROK_CTX(300_000) },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'input_event', ts: 100_000 },
            { t: 'tick', ts: 400_001 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].t).toBe('emit_session_end');
        expect(out[0].provider).toBe('grok');
        expect(out[0].windowEnd).toBe(100_000);
        expect(sm.getState().kind).toBe('idle');
    });

    it('does NOT end at exact gap boundary (mobile semantic differs from desktop)', () => {
        // detectGrokBoundary uses strict > so an exact 300_000 ms gap does
        // not trigger a boundary; one more millisecond does.
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: GROK_CTX(300_000) },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'input_event', ts: 100_000 },
            { t: 'tick', ts: 400_000 },
        ]);
        expect(out).toEqual([]);
        expect(sm.getState().kind).toBe('active');
    });

    it('does not end session when within timestamp gap', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: GROK_CTX(300_000) },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'input_event', ts: 100_000 },
            { t: 'input_event', ts: 200_000 },
            { t: 'tick', ts: 250_000 },
        ]);
        expect(out).toEqual([]);
        expect(sm.getState().kind).toBe('active');
    });

    it('treats any Grok foreground return as same-session during closing window', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: GROK_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'foreground_changed', ts: 50_000, providerContext: null },
            { t: 'foreground_changed', ts: 60_000, providerContext: GROK_CTX() },
        ]);
        expect(out).toEqual([]);
        expect(sm.getState().kind).toBe('active');
    });

});

describe('MobileSessionStateMachine: double-counting invariant', () => {
    it('covers a 100-minute session with exactly three heartbeats and one end, no gaps, no overlaps', () => {
        const sm = new MobileSessionStateMachine();
        const events: MachineInput[] = [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 1_000 },
            { t: 'tick', ts: 30_000 },
        ];
        for (let m = 1; m <= 100; m++) {
            events.push({ t: 'input_event', ts: m * 60_000 });
            events.push({ t: 'tick', ts: m * 60_000 });
        }
        events.push({ t: 'foreground_changed', ts: 100 * 60_000 + 5_000, providerContext: null });
        events.push({ t: 'tick', ts: 100 * 60_000 + 70_000 });

        const out = drive(sm, events);

        const heartbeats = out.filter(o => o.t === 'emit_heartbeat');
        const ends = out.filter(o => o.t === 'emit_session_end');

        expect(heartbeats).toHaveLength(3);
        expect(ends).toHaveLength(1);

        const ordered = [...heartbeats, ...ends].sort((a, b) => a.windowStart - b.windowStart);
        const firstStart = ordered[0].windowStart;
        const lastEnd = ordered[ordered.length - 1].windowEnd;

        for (let i = 1; i < ordered.length; i++) {
            expect(ordered[i].windowStart).toBe(ordered[i - 1].windowEnd);
        }

        const totalCovered = ordered.reduce((sum, o) => sum + (o.windowEnd - o.windowStart), 0);
        expect(totalCovered).toBe(lastEnd - firstStart);

        expect(firstStart).toBe(0);
        expect(lastEnd).toBe(100 * 60_000 + 5_000);
    });
});

describe('MobileSessionStateMachine: turn count and active_duration_ms in emissions', () => {
    it('reports turn count and active duration correctly', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 1_000 },
            { t: 'input_event', ts: 2_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'input_event', ts: 60_000 },
            { t: 'input_event', ts: 61_000 },
            { t: 'input_event', ts: 120_000 },
            { t: 'foreground_changed', ts: 125_000, providerContext: null },
            { t: 'tick', ts: 200_000 },
        ]);
        expect(out).toHaveLength(1);
        const end = out[0];
        expect(end.t).toBe('emit_session_end');
        expect(end.inputEventCount).toBe(5);
        expect(end.turnCount).toBe(3);
        expect(end.activeDurationMs).toBe(27_000);
        expect(end.inputFidelity).toBe('full');
    });

    it('in presence_only mode, turn_count is 0 and active_duration_ms equals duration_ms', () => {
        const sm = new MobileSessionStateMachine({ inputFidelity: 'presence_only' });
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'tick', ts: 30_000 },
            { t: 'foreground_changed', ts: 500_000, providerContext: null },
            { t: 'tick', ts: 565_000 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].turnCount).toBe(0);
        expect(out[0].activeDurationMs).toBe(500_000);
        expect(out[0].inputFidelity).toBe('presence_only');
    });
});

describe('MobileSessionStateMachine: candidate-phase inputs carry into the first session window', () => {
    it('includes input events during the candidate window in the first emission', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'input_event', ts: 10_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'foreground_changed', ts: 40_000, providerContext: null },
            { t: 'tick', ts: 110_000 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].inputEventCount).toBe(2);
        expect(out[0].turnCount).toBe(1);
    });
});

describe('MobileSessionStateMachine: input events during closing are not counted', () => {
    it('ignores input events while state is closing', () => {
        const sm = new MobileSessionStateMachine();
        const out = drive(sm, [
            { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
            { t: 'input_event', ts: 5_000 },
            { t: 'tick', ts: 30_000 },
            { t: 'foreground_changed', ts: 100_000, providerContext: null },
            { t: 'input_event', ts: 110_000 },
            { t: 'input_event', ts: 130_000 },
            { t: 'tick', ts: 160_000 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].inputEventCount).toBe(1);
        expect(out[0].windowEnd).toBe(100_000);
    });
});

describe('computeTurnCount', () => {
    it('returns 0 for empty input', () => {
        expect(computeTurnCount([], 10_000)).toBe(0);
    });

    it('returns 1 for a single event', () => {
        expect(computeTurnCount([5_000], 10_000)).toBe(1);
    });

    it('clusters events within the gap into a single turn', () => {
        expect(computeTurnCount([0, 1_000, 5_000, 9_000], 10_000)).toBe(1);
    });

    it('counts a new turn when gap exceeds threshold', () => {
        expect(computeTurnCount([0, 5_000, 20_000, 25_000, 50_000], 10_000)).toBe(3);
    });

    it('handles out-of-order inputs by sorting', () => {
        expect(computeTurnCount([50_000, 0, 25_000, 20_000, 5_000], 10_000)).toBe(3);
    });
});

describe('computeActiveDurationMs', () => {
    it('returns 0 for empty input', () => {
        expect(computeActiveDurationMs([], 0, 100_000, 10_000)).toBe(0);
    });

    it('returns 0 when window is empty', () => {
        expect(computeActiveDurationMs([5_000], 10_000, 10_000, 10_000)).toBe(0);
    });

    it('counts up to turnGapMs per isolated event', () => {
        expect(computeActiveDurationMs([0], 0, 100_000, 10_000)).toBe(10_000);
    });

    it('merges overlapping intervals without double-counting', () => {
        expect(computeActiveDurationMs([0, 5_000], 0, 100_000, 10_000)).toBe(15_000);
    });

    it('sums two disjoint active intervals', () => {
        expect(computeActiveDurationMs([0, 50_000], 0, 100_000, 10_000)).toBe(20_000);
    });

    it('clips to the window at both ends', () => {
        expect(computeActiveDurationMs([0, 95_000], 0, 100_000, 10_000)).toBe(15_000);
    });

    it('clips events before windowStart', () => {
        expect(computeActiveDurationMs([-5_000], 0, 100_000, 10_000)).toBe(5_000);
    });
});

describe('MobileSessionStateMachine: input on a surface still on screen reopens a session (2026-10-17)', () => {
    const grok = { provider: 'grok', sessionId: null, boundaryMode: 'timestamp_gap' as const, timestampGapMs: 60_000 };

    it('RED: after a Grok timestamp gap ends the session, typing again starts a new one without a foreground change', () => {
        const m = new MobileSessionStateMachine({ config: { turnGapMs: 10_000 } });
        m.step({ t: 'foreground_changed', ts: 0, providerContext: grok });
        m.step({ t: 'input_event', ts: 1_000 });
        expect(m.getState().kind).toBe('active');
        const ended = m.step({ t: 'tick', ts: 80_000 });
        expect(ended.map((o) => o.t)).toEqual(['emit_session_end']);
        expect((ended[0] as { windowEnd: number }).windowEnd).toBe(1_000);
        expect(m.getState().kind).toBe('idle');
        m.step({ t: 'input_event', ts: 90_000 });
        expect(m.getState().kind).toBe('active');
        const next = m.getState();
        expect(next.kind === 'active' && next.startedAt).toBe(90_000);
    });

    it('a candidate dropped for silence is reopened by later input on the same surface', () => {
        const m = new MobileSessionStateMachine();
        m.step({ t: 'foreground_changed', ts: 0, providerContext: { provider: 'claude', sessionId: null, boundaryMode: 'url_session_id' as const, timestampGapMs: null } });
        m.step({ t: 'tick', ts: 31_000 }); // candidate window elapsed, no input → dropped
        expect(m.getState().kind).toBe('idle');
        m.step({ t: 'input_event', ts: 40_000 });
        expect(m.getState().kind).toBe('active');
    });

    it('input with nothing on screen is still ignored (RED control for the reopen)', () => {
        const m = new MobileSessionStateMachine();
        m.step({ t: 'foreground_changed', ts: 0, providerContext: grok });
        m.step({ t: 'foreground_changed', ts: 5_000, providerContext: null });
        m.step({ t: 'input_event', ts: 6_000 });
        expect(m.getState().kind).toBe('idle');
    });
});

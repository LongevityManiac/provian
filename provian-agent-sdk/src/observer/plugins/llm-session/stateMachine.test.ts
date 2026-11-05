import { describe, it, expect } from 'vitest';
import {
  LLMSessionStateMachine,
  computeTurnCount,
  computeActiveDurationMs,
  type MachineInput,
  type MachineOutput,
  type ProviderContext,
} from './stateMachine';

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

function drive(sm: LLMSessionStateMachine, inputs: MachineInput[]): MachineOutput[] {
  const out: MachineOutput[] = [];
  for (const i of inputs) out.push(...sm.step(i));
  return out;
}

describe('LLMSessionStateMachine: candidate promotion', () => {
  it('returns to idle when no input event arrives in the 30s window', () => {
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine();
    drive(sm, [
      { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
      { t: 'input_event', ts: 5_000 },
      { t: 'tick', ts: 30_000 },
    ]);
    expect(sm.getState().kind).toBe('active');
  });

  it('promotes immediately on first input at full fidelity', () => {
    const sm = new LLMSessionStateMachine();
    drive(sm, [
      { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
      { t: 'input_event', ts: 1_000 },
    ]);
    expect(sm.getState().kind).toBe('active');
  });

  it('emits a session for a quick question followed by an early close', () => {
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine({ inputFidelity: 'presence_only' });
    drive(sm, [
      { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
      { t: 'tick', ts: 29_000 },
    ]);
    expect(sm.getState().kind).toBe('candidate');
  });

  it('presence_only bypasses the input requirement for promotion', () => {
    const sm = new LLMSessionStateMachine({ inputFidelity: 'presence_only' });
    drive(sm, [
      { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
      { t: 'tick', ts: 30_000 },
    ]);
    expect(sm.getState().kind).toBe('active');
  });

  it('drops candidate when user switches to unsupported app before promotion', () => {
    const sm = new LLMSessionStateMachine();
    drive(sm, [
      { t: 'foreground_changed', ts: 0, providerContext: URL_CTX() },
      { t: 'foreground_changed', ts: 10_000, providerContext: null },
    ]);
    expect(sm.getState().kind).toBe('idle');
  });
});

describe('LLMSessionStateMachine: heartbeat', () => {
  it('emits a heartbeat after 30 minutes of continuous active session', () => {
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine();
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

describe('LLMSessionStateMachine: closing grace window', () => {
  it('returns to active when foreground returns within 60s with same session id', () => {
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine();
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
});

describe('LLMSessionStateMachine: termination on sleep, lock, shutdown', () => {
  it('ends session immediately on sleep during active', () => {
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine();
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

describe('LLMSessionStateMachine: Grok timestamp-gap boundaries', () => {
  it('ends session when input gap exceeds timestampGapMs', () => {
    const sm = new LLMSessionStateMachine();
    const out = drive(sm, [
      { t: 'foreground_changed', ts: 0, providerContext: GROK_CTX(300_000) },
      { t: 'input_event', ts: 5_000 },
      { t: 'tick', ts: 30_000 },
      { t: 'input_event', ts: 100_000 },
      { t: 'tick', ts: 405_000 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].t).toBe('emit_session_end');
    expect(out[0].provider).toBe('grok');
    expect(out[0].windowEnd).toBe(100_000);
    expect(sm.getState().kind).toBe('idle');
  });

  it('does not end session when within timestamp gap', () => {
    const sm = new LLMSessionStateMachine();
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

  it('does NOT end at exact gap boundary, ends one ms past (strict > parity with mobile)', () => {
    // Historical desktop semantic was `>=`, which fired at elapsed == gap.
    // Parity with the mobile port (which delegates to detectGrokBoundary's
    // strict `>`) requires the exact-gap tick to leave the session active
    // and the next millisecond to close it.
    const smAtBoundary = new LLMSessionStateMachine();
    const atBoundary = drive(smAtBoundary, [
      { t: 'foreground_changed', ts: 0, providerContext: GROK_CTX(300_000) },
      { t: 'input_event', ts: 5_000 },
      { t: 'tick', ts: 30_000 },
      { t: 'input_event', ts: 100_000 },
      { t: 'tick', ts: 400_000 },
    ]);
    expect(atBoundary).toEqual([]);
    expect(smAtBoundary.getState().kind).toBe('active');

    const smPastBoundary = new LLMSessionStateMachine();
    const pastBoundary = drive(smPastBoundary, [
      { t: 'foreground_changed', ts: 0, providerContext: GROK_CTX(300_000) },
      { t: 'input_event', ts: 5_000 },
      { t: 'tick', ts: 30_000 },
      { t: 'input_event', ts: 100_000 },
      { t: 'tick', ts: 400_001 },
    ]);
    expect(pastBoundary).toHaveLength(1);
    expect(pastBoundary[0].t).toBe('emit_session_end');
    expect(pastBoundary[0].windowEnd).toBe(100_000);
    expect(smPastBoundary.getState().kind).toBe('idle');
  });

  it('treats any Grok foreground return as same-session during closing window', () => {
    const sm = new LLMSessionStateMachine();
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

describe('LLMSessionStateMachine: double-counting invariant', () => {
  it('covers a 100-minute session with exactly three heartbeats and one end, no gaps, no overlaps', () => {
    const sm = new LLMSessionStateMachine();
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

describe('LLMSessionStateMachine: turn count and active_duration_ms in emissions', () => {
  it('reports turn count and active duration correctly', () => {
    const sm = new LLMSessionStateMachine();
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
    const sm = new LLMSessionStateMachine({ inputFidelity: 'presence_only' });
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

describe('LLMSessionStateMachine: candidate-phase inputs carry into the first session window', () => {
  it('includes input events during the candidate window in the first emission', () => {
    const sm = new LLMSessionStateMachine();
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

describe('LLMSessionStateMachine: input events during closing are not counted', () => {
  it('ignores input events while state is closing (inputs belong to another app)', () => {
    const sm = new LLMSessionStateMachine();
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

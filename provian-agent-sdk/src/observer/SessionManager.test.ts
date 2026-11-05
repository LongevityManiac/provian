import { describe, it, expect } from 'vitest';
import { SessionManager } from './SessionManager';

describe('SessionManager', () => {
  it('stays idle when cpu never crosses the threshold', () => {
    const sm = new SessionManager(30_000, 15 * 60 * 1000);
    let now = 0;
    for (let i = 0; i < 10; i++) {
      const ev = sm.tick({ cpuLoad: 0.01, rssMb: 50, now: now += 1000 });
      expect(ev.type).toBe('noop');
    }
    expect(sm.current()).toBeNull();
  });

  it('starts a session when cpu crosses the threshold', () => {
    const sm = new SessionManager(30_000, 15 * 60 * 1000);
    const ev = sm.tick({ cpuLoad: 0.5, rssMb: 100, now: 1000 });
    expect(ev.type).toBe('session_started');
    expect(sm.current()).not.toBeNull();
    expect(sm.current()!.startedAt).toBe(1000);
  });

  it('ends a session after idle threshold is reached', () => {
    const sm = new SessionManager(3000, 60_000);
    let ev = sm.tick({ cpuLoad: 0.5, rssMb: 100, now: 1000 });
    expect(ev.type).toBe('session_started');
    sm.tick({ cpuLoad: 0.5, rssMb: 110, now: 2000 });
    sm.tick({ cpuLoad: 0.02, rssMb: 90, now: 3000 });
    sm.tick({ cpuLoad: 0.02, rssMb: 90, now: 4000 });
    ev = sm.tick({ cpuLoad: 0.02, rssMb: 90, now: 5500 });
    expect(ev.type).toBe('session_ended');
    if (ev.type === 'session_ended') {
      expect(ev.reason).toBe('idle');
      expect(ev.state.startedAt).toBe(1000);
      expect(ev.state.peakMemoryMb).toBeGreaterThanOrEqual(110);
    }
    expect(sm.current()).toBeNull();
  });

  it('forces a session end when max duration is exceeded', () => {
    const sm = new SessionManager(30_000, 5000);
    sm.tick({ cpuLoad: 0.5, rssMb: 100, now: 1000 });
    sm.tick({ cpuLoad: 0.5, rssMb: 100, now: 4000 });
    const ev = sm.tick({ cpuLoad: 0.5, rssMb: 100, now: 6500 });
    expect(ev.type).toBe('session_ended');
    if (ev.type === 'session_ended') expect(ev.reason).toBe('max_duration');
  });

  it('accumulates cpu seconds and plugin artifacts', () => {
    const sm = new SessionManager(30_000, 60_000);
    sm.tick({ cpuLoad: 0.5, rssMb: 100, now: 1000 });
    sm.addCpuSeconds(0.25);
    sm.addCpuSeconds(0.5);
    sm.addTokens(1500);
    sm.setArtifact('llm', { model: 'claude' });
    const s = sm.current()!;
    expect(s.accumulatedCpu).toBeCloseTo(0.75);
    expect(s.tokensProcessed).toBe(1500);
    expect(s.pluginArtifacts.get('llm')).toEqual({ model: 'claude' });
  });
});

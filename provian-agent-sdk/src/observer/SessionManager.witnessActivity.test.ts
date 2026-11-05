/**
 * SessionManager.witnessActivity / expire — the non-CPU session driver the
 * local-inference producer needs. On a human device ProcessPlugin is gated
 * off, so before these two methods NO session could ever open there and every
 * LLM-plugin contribution was dropped (`addTokens` no-ops with no state).
 */
import { describe, it, expect } from 'vitest';
import { SessionManager } from './SessionManager';

function attested(): SessionManager {
  let ordinal = 0;
  return new SessionManager(30_000, 15 * 60 * 1000, 0.05, 'dev_attested', () => ++ordinal);
}

describe('SessionManager.witnessActivity', () => {
  it('opens a session with a minted lineage when none is open (no CPU sample involved)', () => {
    const sm = attested();
    const ev = sm.witnessActivity(1_000);
    expect(ev.type).toBe('session_started');
    const s = sm.current()!;
    expect(s.startedAt).toBe(1_000);
    expect(s.inference).toBeNull();
    expect(s.lineage).not.toBeNull();
    expect(s.lineage!.id.startsWith('pesl2_')).toBe(true);
    expect(s.lineage!.session_ordinal).toBe(1);
  });

  it('extends an open session (lastActivityAt moves; the lineage does NOT re-mint)', () => {
    const sm = attested();
    sm.witnessActivity(1_000);
    const lineage = sm.current()!.lineage!.id;
    const ev = sm.witnessActivity(20_000);
    expect(ev.type).toBe('noop');
    expect(sm.current()!.lastActivityAt).toBe(20_000);
    expect(sm.current()!.lineage!.id).toBe(lineage);
  });

  it('keeps a session alive that a CPU-idle tick would otherwise close', () => {
    const sm = new SessionManager(3_000, 60_000);
    sm.tick({ cpuLoad: 0.5, now: 1_000 });
    // CPU goes idle, but inference keeps being witnessed every 2s.
    sm.tick({ cpuLoad: 0, now: 2_000 });
    sm.witnessActivity(3_000);
    expect(sm.tick({ cpuLoad: 0, now: 5_000 }).type).toBe('noop');   // 2s since witness
    sm.witnessActivity(5_500);
    expect(sm.tick({ cpuLoad: 0, now: 8_000 }).type).toBe('noop');   // 2.5s since witness
    // Now nothing for 3s → idle close.
    const ev = sm.tick({ cpuLoad: 0, now: 8_600 });
    expect(ev.type).toBe('session_ended');
  });
});

describe('SessionManager.expire', () => {
  it('RED: is a noop with no open session and never opens one', () => {
    const sm = attested();
    expect(sm.expire(99_999).type).toBe('noop');
    expect(sm.current()).toBeNull();
  });

  it('closes an inference-opened session after the idle threshold with reason idle', () => {
    const sm = attested();
    sm.witnessActivity(1_000);
    expect(sm.expire(30_999).type).toBe('noop');
    const ev = sm.expire(31_000);
    expect(ev.type).toBe('session_ended');
    if (ev.type === 'session_ended') {
      expect(ev.reason).toBe('idle');
      expect(ev.state.startedAt).toBe(1_000);
    }
    expect(sm.current()).toBeNull();
  });

  it('closes at max duration even while activity keeps arriving', () => {
    const sm = new SessionManager(30_000, 10_000);
    sm.witnessActivity(0);
    sm.witnessActivity(9_000);
    const ev = sm.expire(10_000);
    expect(ev.type).toBe('session_ended');
    if (ev.type === 'session_ended') expect(ev.reason).toBe('max_duration');
  });
});

describe('SessionManager.addInference', () => {
  it('accumulates requests, unions models/runtimes/sources, latches tokensObserved', () => {
    const sm = attested();
    sm.witnessActivity(1_000);
    sm.addInference({ runtime: 'ollama', source: 'ollama_server_log', requests: 2, models: ['llama3.1:8b'], tokensObserved: false });
    sm.addInference({ runtime: 'ollama', source: 'ollama_server_log', requests: 1, models: ['llama3.1:8b', 'qwen2.5:7b'], tokensObserved: false });
    sm.addInference({ runtime: 'llamacpp', source: 'llamacpp_server_log', requests: 1, models: [], tokensObserved: true });
    expect(sm.current()!.inference).toEqual({
      requests: 4,
      models: ['llama3.1:8b', 'qwen2.5:7b'],
      runtimes: ['ollama', 'llamacpp'],
      sources: ['ollama_server_log', 'llamacpp_server_log'],
      tokensObserved: true,
    });
  });

  it('RED: with no open session the contribution is dropped, never buffered onto a later session', () => {
    const sm = attested();
    sm.addInference({ runtime: 'ollama', source: 'ollama_server_log', requests: 5, models: [], tokensObserved: false });
    sm.witnessActivity(1_000);
    expect(sm.current()!.inference).toBeNull();
  });
});

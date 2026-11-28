import { describe, it, expect } from 'vitest';
import { deriveAgentStatus, AGENT_ACTIVE_HEARTBEAT_MS } from './agentStatus';

const SIX_HOURS = 6 * 60 * 60 * 1000;

const NOW = 1_800_000_000_000;

describe('deriveAgentStatus (capture heartbeat, no relay session)', () => {
  it('setup_pending when the agent is linked but no device has ever reported', () => {
    const s = deriveAgentStatus({ linked: { pe_count: 5 }, now: NOW });
    expect(s.key).toBe('setup_pending');
    expect(s.tone).toBe('warning');
    expect(s.hasWork).toBe(true);
  });

  it('active when the device captured work within the heartbeat window', () => {
    const s = deriveAgentStatus({
      linked: { pe_count: 6, last_capture_at_ms: NOW - 60_000 },
      now: NOW,
    });
    expect(s.key).toBe('active');
    expect(s.tone).toBe('positive');
  });

  it('active when the device reports receiving now, even before its first capture', () => {
    const s = deriveAgentStatus({
      linked: { pe_count: 0, capture_reported_at_ms: NOW - 30_000, capture_receiving: true },
      now: NOW,
    });
    expect(s.key).toBe('active');
  });

  it('an idle daemon that declared a 6-hour check-in stays active until it misses it (RED: a 10-minute daemon is stale after an hour)', () => {
    const linked = { pe_count: 0, capture_reported_at_ms: NOW - 3 * 60 * 60 * 1000, capture_receiving: true };
    expect(deriveAgentStatus({ linked: { ...linked, capture_report_interval_ms: SIX_HOURS }, now: NOW }).key).toBe('active');
    expect(deriveAgentStatus({ linked, now: NOW }).key).toBe('attention');
    expect(deriveAgentStatus({ linked: { ...linked, capture_report_interval_ms: SIX_HOURS, capture_reported_at_ms: NOW - SIX_HOURS - AGENT_ACTIVE_HEARTBEAT_MS + 10 * 60 * 1000 - 1 }, now: NOW }).key).toBe('attention');
  });

  it('idle when the device has reported, has work, but the last capture is stale', () => {
    const s = deriveAgentStatus({
      linked: { pe_count: 6, last_capture_at_ms: NOW - AGENT_ACTIVE_HEARTBEAT_MS - 1 },
      now: NOW,
    });
    expect(s.key).toBe('idle');
    expect(s.tone).toBe('neutral');
  });

  it('attention when the device reports but no work was ever produced', () => {
    const s = deriveAgentStatus({
      linked: { pe_count: 0, capture_reported_at_ms: NOW - AGENT_ACTIVE_HEARTBEAT_MS - 1, capture_receiving: false },
      now: NOW,
    });
    expect(s.key).toBe('attention');
    expect(s.tone).toBe('warning');
  });

  // RED controls: broken / stale capture must NOT read as active.
  it('RED: broken capture (even with a fresh capture timestamp) is not "active"', () => {
    const s = deriveAgentStatus({
      linked: { pe_count: 3, last_capture_at_ms: NOW - 1000, capture_broken: true },
      now: NOW,
    });
    expect(s.key).not.toBe('active');
    expect(s.key).toBe('attention');
  });

  it('RED: a stale capture with a stale receiving report is not "active"', () => {
    const s = deriveAgentStatus({
      linked: {
        pe_count: 3,
        last_capture_at_ms: NOW - AGENT_ACTIVE_HEARTBEAT_MS - 1,
        capture_reported_at_ms: NOW - AGENT_ACTIVE_HEARTBEAT_MS - 1,
        capture_receiving: true,
      },
      now: NOW,
    });
    expect(s.key).not.toBe('active');
  });

  it('livePeCount overrides linked.pe_count for hasWork', () => {
    const s = deriveAgentStatus({ linked: { pe_count: 0 }, livePeCount: 6, now: NOW });
    expect(s.hasWork).toBe(true);
  });
});

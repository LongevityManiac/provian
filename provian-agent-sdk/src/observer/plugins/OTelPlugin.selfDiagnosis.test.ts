import { describe, it, expect } from 'vitest';
import {
  OTelPlugin,
  shouldWarnNoSpans,
  NO_SPAN_WARN_MS,
  type ParsedOtlpSpan,
} from './OTelPlugin';
import type { ProvianObserver } from '../ProvianObserver';

// Lever 4: the "receiver up, zero spans" self-diagnosis — the anti-silent-failure
// signal that would have surfaced Atlas's zero-capture immediately.

function toolSpan(traceId: string, spanId: string): ParsedOtlpSpan {
  return {
    name: 'execute_tool probe',
    traceId,
    spanId,
    parentSpanId: 'root',
    startTimeUnixMs: 1_700_000_000_000,
    endTimeUnixMs: 1_700_000_001_000,
    status: 'ok',
    spanKind: null,
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'probe' },
    resourceAttributes: {},
    scopeName: null,
  };
}

/** A log-capturing observer double. */
function capturingObserver(): { observer: ProvianObserver; warns: Array<{ msg: string; extra?: Record<string, unknown> }> } {
  const warns: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const observer = {
    log: (level: string, msg: string, extra?: Record<string, unknown>) => {
      if (level === 'warn') warns.push({ msg, extra });
    },
  } as unknown as ProvianObserver;
  return { observer, warns };
}

describe('shouldWarnNoSpans (pure predicate)', () => {
  const base = {
    active: true,
    receiverListening: true,
    spansEverSeen: false,
    alreadyWarned: false,
    receiverUpSinceMs: 1_000,
    nowMs: 1_000 + NO_SPAN_WARN_MS,
    thresholdMs: NO_SPAN_WARN_MS,
  };

  it('fires exactly at the threshold with a listening receiver and no spans', () => {
    expect(shouldWarnNoSpans(base)).toBe(true);
  });

  // NEGATIVE CONTROLS — each condition that MUST suppress the warning:
  it('does NOT fire before the threshold elapses', () => {
    expect(shouldWarnNoSpans({ ...base, nowMs: base.receiverUpSinceMs + NO_SPAN_WARN_MS - 1 })).toBe(false);
  });
  it('does NOT fire once any span has been seen', () => {
    expect(shouldWarnNoSpans({ ...base, spansEverSeen: true })).toBe(false);
  });
  it('does NOT fire twice (one-shot latch)', () => {
    expect(shouldWarnNoSpans({ ...base, alreadyWarned: true })).toBe(false);
  });
  it('does NOT fire when the receiver never bound (another collector on 4318)', () => {
    expect(shouldWarnNoSpans({ ...base, receiverListening: false })).toBe(false);
    expect(shouldWarnNoSpans({ ...base, receiverUpSinceMs: null })).toBe(false);
  });
  it('does NOT fire when the plugin is dormant', () => {
    expect(shouldWarnNoSpans({ ...base, active: false })).toBe(false);
  });
});

describe('OTelPlugin.tick self-diagnosis wiring', () => {
  it('emits exactly ONE no-span warning after the threshold, and none once spans arrive', async () => {
    const { observer, warns } = capturingObserver();
    const plugin = new OTelPlugin({ journalPath: null, forceActive: true });
    await plugin.init(observer);
    // Simulate a receiver that bound NO_SPAN_WARN_MS+1 ago without touching a port.
    (plugin as unknown as { listeningPort: number | null }).listeningPort = 4318;
    (plugin as unknown as { receiverUpSinceMs: number | null }).receiverUpSinceMs =
      Date.now() - NO_SPAN_WARN_MS - 1000;

    plugin.tick(null);
    plugin.tick(null); // second tick must NOT re-warn (one-shot)
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain('no agent spans');
    expect(String(warns[0].extra?.hint)).toContain('npx @provian/agent-sdk doctor');
  });

  it('never warns once a span has been received (harness IS emitting)', async () => {
    const { observer, warns } = capturingObserver();
    const plugin = new OTelPlugin({ journalPath: null, forceActive: true });
    await plugin.init(observer);
    (plugin as unknown as { listeningPort: number | null }).listeningPort = 4318;
    (plugin as unknown as { receiverUpSinceMs: number | null }).receiverUpSinceMs =
      Date.now() - NO_SPAN_WARN_MS - 1000;

    // A span arrives → spansEverSeen latches true.
    plugin.ingestParsedSpans([toolSpan('trace-real', 's1')]);
    plugin.tick(null);
    expect(warns).toHaveLength(0);
  });
});

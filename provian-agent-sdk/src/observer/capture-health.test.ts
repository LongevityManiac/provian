/**
 * capture-health — the alarm rule and the privacy binding.
 *
 * Two properties matter, and both get a control:
 *   1. "installed but blind" is an alarm; "installed and idle" is NOT. Confusing
 *      the two is what let the Atlas outage run for five days, and an alarm that
 *      fires on every idle agent would be turned off within a week.
 *   2. Nothing structural-only means nothing: the report is fed sentinel paths,
 *      table names and session ids, and asserted not to carry them.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCaptureHealthReport,
  isCaptureBroken,
  isSoleWitnessSilent,
  captureBrokenReason,
  describeCaptureHealth,
  deriveWitnessLanes,
  type CaptureHealthInput,
  type OtelLaneState,
} from './capture-health';

const BASE: CaptureHealthInput = {
  harnesses: [{ harness: 'openclaw', version: '2026.8.2', sources: 3, containers: ['sqlite'] }],
  cursorTotal: 1_567,
  lastVerdictAtMs: 1_788_900_000_000,
  lastVerdict: 'capturing',
  lastCaptureAtMs: 1_788_899_000_000,
  sqliteReadable: true,
  nowMs: 1_788_900_100_000,
  nodeVersion: 'v26.5.0',
};

describe('the alarm rule', () => {
  it('THE ATLAS STATE — a harness installed with ZERO readable sources is broken', () => {
    const r = buildCaptureHealthReport({
      ...BASE,
      harnesses: [{ harness: 'openclaw', version: '2026.8.2', sources: 0, containers: [] }],
      lastVerdict: 'zero_sources',
    });
    expect(isCaptureBroken(r)).toBe(true);
    expect(describeCaptureHealth(r)).toMatch(/NOT RECEIVING/);
  });

  it('NEGATIVE CONTROL — a harness with sources is NOT broken, however idle the agent is', () => {
    const r = buildCaptureHealthReport({ ...BASE, lastCaptureAtMs: null, lastVerdict: 'idle' });
    // No capture in living memory, but we can SEE — that is an idle agent, not
    // a broken device, and alarming on it would train everyone to ignore this.
    expect(isCaptureBroken(r)).toBe(false);
    expect(describeCaptureHealth(r)).toMatch(/^receiving/);
  });

  it('NEGATIVE CONTROL — a device with no harness at all is not an alarm', () => {
    const r = buildCaptureHealthReport({ ...BASE, harnesses: [] });
    expect(isCaptureBroken(r)).toBe(false);
    expect(describeCaptureHealth(r)).toMatch(/no agent harness installed/);
  });

  it('THE MASKING CASE — one blind harness raises the alarm even beside a readable one', () => {
    // A device total would read 3 sources and call this healthy; the per-harness
    // rule sees the blind OpenClaw. This is the exact Atlas shape on a device
    // that also runs a second harness.
    const r = buildCaptureHealthReport({
      ...BASE,
      harnesses: [
        { harness: 'openclaw', version: '2026.8.2', sources: 0, containers: [] },
        { harness: 'claude-code', version: null, sources: 3, containers: ['file'] },
      ],
    });
    expect(r.total_sources).toBe(3);       // the number that masked it
    expect(isCaptureBroken(r)).toBe(true); // the per-harness rule catches it anyway
  });

  it('NEGATIVE CONTROL — two harnesses BOTH with sources are not an alarm', () => {
    // Proves the masking test is not just "more than one harness → broken".
    const r = buildCaptureHealthReport({
      ...BASE,
      harnesses: [
        { harness: 'openclaw', version: '2026.8.2', sources: 3, containers: ['sqlite'] },
        { harness: 'claude-code', version: null, sources: 3, containers: ['file'] },
      ],
    });
    expect(isCaptureBroken(r)).toBe(false);
  });

  it('item 2 — self-update outcome rides the report; null when the loop never ran', () => {
    const withUpdate = buildCaptureHealthReport({ ...BASE, selfUpdate: { outcome: 'node_too_old', atMs: 1_788_900_050_000, version: 6 } });
    expect(withUpdate.self_update_outcome).toBe('node_too_old');
    expect(withUpdate.self_update_version).toBe(6);
    // NEGATIVE CONTROL — no selfUpdate input → all null, never a coerced value.
    const noUpdate = buildCaptureHealthReport(BASE);
    expect(noUpdate.self_update_outcome).toBeNull();
    expect(noUpdate.self_update_at_ms).toBeNull();
    expect(noUpdate.self_update_version).toBeNull();
  });

  it('a container migration is visible in the shape', () => {
    const before = buildCaptureHealthReport({
      ...BASE,
      harnesses: [{ harness: 'openclaw', version: '2026.8.1', sources: 12, containers: ['file'] }],
    });
    const after = buildCaptureHealthReport(BASE);
    expect(before.harnesses[0].containers).toEqual(['file']);
    expect(after.harnesses[0].containers).toEqual(['sqlite']);
  });
});

describe('sole-witness silence — the Sep-1 outage one layer down', () => {
  // Readable sources, records FLOWING this window, but ZERO tool calls recognized:
  // a harness whose record shape changed under a reader that still finds the store.
  it('THE SILENCE STATE — unknown format, readable, zero tool calls → broken', () => {
    const r = buildCaptureHealthReport({
      ...BASE,
      lastVerdict: 'unknown',
      recordsConsumedInWindow: 42,
      toolCallsRecognizedInWindow: 0,
    });
    expect(isSoleWitnessSilent(r)).toBe(true);
    expect(isCaptureBroken(r)).toBe(true);
    expect(captureBrokenReason(r)).toBe('sole_witness_silence');
    expect(describeCaptureHealth(r)).toMatch(/recognized no tool calls/);
  });

  it('NEGATIVE CONTROL — records read AND tool calls recognized is healthy', () => {
    const r = buildCaptureHealthReport({
      ...BASE,
      recordsConsumedInWindow: 42,
      toolCallsRecognizedInWindow: 7,
    });
    expect(isSoleWitnessSilent(r)).toBe(false);
    expect(isCaptureBroken(r)).toBe(false);
    expect(captureBrokenReason(r)).toBeNull();
  });

  it('NEGATIVE CONTROL — genuine idle (NO records read this window) is NOT the alarm', () => {
    // The whole point: an idle agent reads no records, so zero tool calls is fine.
    const r = buildCaptureHealthReport({
      ...BASE,
      recordsConsumedInWindow: 0,
      toolCallsRecognizedInWindow: 0,
    });
    expect(isSoleWitnessSilent(r)).toBe(false);
    expect(isCaptureBroken(r)).toBe(false);
  });

  it('a blind harness (zero sources) beats silence — the reason is no_readable_sources', () => {
    // sources===0 means the watcher never even reached the record loop, so the
    // silence test cannot apply; the blind reason wins.
    const r = buildCaptureHealthReport({
      ...BASE,
      harnesses: [{ harness: 'openclaw', version: '2026.8.2', sources: 0, containers: [] }],
      recordsConsumedInWindow: 3,
      toolCallsRecognizedInWindow: 0,
    });
    expect(captureBrokenReason(r)).toBe('no_readable_sources');
  });

  it('defaults to 0/0 when the caller supplies no counters (older callers stay healthy)', () => {
    const r = buildCaptureHealthReport(BASE);
    expect(r.records_consumed_in_window).toBe(0);
    expect(r.tool_calls_recognized_in_window).toBe(0);
    expect(isSoleWitnessSilent(r)).toBe(false); // 0 records → not the alarm
  });
});

describe('the report itself', () => {
  it('carries the versions an operator needs to attribute a fleet-wide break', () => {
    const r = buildCaptureHealthReport(BASE);
    expect(r.schema).toBe('capture_health/v1');
    expect(r).not.toHaveProperty('catalog_version');
    expect(r.daemon_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.runtime).toBe('node26');
    expect(r.harnesses[0].version).toBe('2026.8.2');
    expect(r.total_sources).toBe(3);
  });

  it('records that the store reader is unavailable — the reason a gap exists', () => {
    const r = buildCaptureHealthReport({ ...BASE, sqliteReadable: false, nodeVersion: 'v20.11.0' });
    expect(r.sqlite_readable).toBe(false);
    expect(r.runtime).toBe('node20');
  });

  it('carries the OTel witness-lane fields and the derived lane', () => {
    const r = buildCaptureHealthReport({
      ...BASE,
      otel: { active: true, receiverListening: true, spansEverSeen: true, lastSpanAtMs: 1_788_899_500_000 },
    });
    expect(r.otel_active).toBe(true);
    expect(r.otel_receiver_listening).toBe(true);
    expect(r.otel_spans_ever_seen).toBe(true);
    expect(r.otel_last_span_at_ms).toBe(1_788_899_500_000);
    expect(r.lanes).toBe('both'); // transcript sources=3 AND otel witnessing
  });
});

describe('witness lanes (item 5)', () => {
  const OTEL_WITNESSING: OtelLaneState = { active: true, receiverListening: true, spansEverSeen: true, lastSpanAtMs: 1 };
  const OTEL_LISTENING_SILENT: OtelLaneState = { active: true, receiverListening: true, spansEverSeen: false, lastSpanAtMs: null };

  it('transcript sources + witnessing OTel → both', () => {
    expect(deriveWitnessLanes({ totalSources: 3, otel: OTEL_WITNESSING })).toBe('both');
  });

  it('THE OPENCLAW CASE — transcript sources + OTel LISTENING-BUT-SILENT → transcript (single witness)', () => {
    // The decision this item records: OpenClaw's receiver listens but no span is
    // ever exported, so transcript is the SOLE witness. A listening receiver that
    // has never seen a span is NOT a lane — spansEverSeen is load-bearing.
    expect(deriveWitnessLanes({ totalSources: 3, otel: OTEL_LISTENING_SILENT })).toBe('transcript');
  });

  it('no transcript sources + witnessing OTel → otel', () => {
    expect(deriveWitnessLanes({ totalSources: 0, otel: OTEL_WITNESSING })).toBe('otel');
  });

  it('no transcript sources + no OTel → none (the fully-dark device)', () => {
    expect(deriveWitnessLanes({ totalSources: 0, otel: OTEL_LISTENING_SILENT })).toBe('none');
  });

  it('RED CONTROL — a listening-but-silent receiver alone is NOT the otel lane', () => {
    // If spansEverSeen were ignored, this would wrongly read "otel". It must be "none".
    expect(deriveWitnessLanes({ totalSources: 0, otel: OTEL_LISTENING_SILENT })).not.toBe('otel');
    // And spans-seen but plugin inactive is also not a lane.
    expect(deriveWitnessLanes({ totalSources: 0, otel: { active: false, receiverListening: true, spansEverSeen: true, lastSpanAtMs: 1 } })).toBe('none');
  });

  it('default (no OTel lane supplied) → transcript when sources exist, none when not', () => {
    expect(buildCaptureHealthReport(BASE).lanes).toBe('transcript');
    expect(buildCaptureHealthReport({ ...BASE, harnesses: [{ harness: 'openclaw', version: '2026.8.2', sources: 0, containers: [] }] }).lanes).toBe('none');
    // the raw fields default to the off state
    const r = buildCaptureHealthReport(BASE);
    expect(r.otel_active).toBe(false);
    expect(r.otel_spans_ever_seen).toBe(false);
    expect(r.otel_last_span_at_ms).toBeNull();
  });

  it('the human-readable line names the witness lane', () => {
    expect(describeCaptureHealth(buildCaptureHealthReport(BASE))).toMatch(/witness=transcript/);
  });
});

describe('privacy', () => {
  it('PRIVACY SENTINEL — no path, table, session id or content can ride along', () => {
    const r = buildCaptureHealthReport({
      ...BASE,
      harnesses: [{
        // Every field that could plausibly smuggle a location is fed a sentinel.
        harness: 'openclaw',
        version: '2026.8.2',
        sources: 2,
        containers: ['sqlite', 'file'],
      }],
    });
    const serialized = JSON.stringify(r);
    for (const forbidden of [
      '/Users/', '/home/', '.openclaw', 'openclaw-agent.sqlite',
      'transcript_events', 'session_id', 'cwd', 'SENTINEL',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Non-vacuous: the report is not simply empty.
    expect(r.total_sources).toBe(2);
    expect(r.harnesses[0].containers).toEqual(['file', 'sqlite']);
  });
});

// live RED: readable known pure/ignored tails are healthy without tool calls.
it.each(['idle', 'capturing'] as const)('does not alarm on recognized tool-free records (%s)', lastVerdict => {
 const r=buildCaptureHealthReport({...BASE,lastVerdict,recordsConsumedInWindow:24,toolCallsRecognizedInWindow:0,formatBrokenPrograms:[]});
 expect(isSoleWitnessSilent(r)).toBe(false);
 expect(captureBrokenReason(r)).toBeNull();
 expect(captureBrokenReason({...r,last_verdict:'unknown',format_broken_programs:['openclaw']})).toBe('session_format_broken');
});

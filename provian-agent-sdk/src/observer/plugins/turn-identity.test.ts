/**
 * turn-identity — the shared, cross-source turn key both tool-orchestration
 * lanes stamp so the relay can enforce mint-once for one agent turn.
 *
 * The invariants the operator named, expressed at the identity layer (the relay RED
 * controls i/ii/iii live in the backend device-witnessed-earning suite):
 * - distinct turns → distinct turn_id (distinct work is NEVER merged);
 * - the same turn from either source → the SAME turn_id (mint-once);
 * - a turn with no call id falls back to the source's own key (safe, never a
 * value a different turn collides with).
 */
import { describe, it, expect } from 'vitest';
import { computeTurnId, TURN_ID_ANCHOR_PREFIX, TURN_ID_MAX_CHARS } from './turn-identity';

const HEX64 = /^tc:[0-9a-f]{64}$/;

describe('computeTurnId — the call-id anchor (cross-source)', () => {
  it('CROSS-SOURCE (iii): the OTel side and the transcript side of ONE turn agree', () => {
    // Same tool-call ids, DIFFERENT fallback self keys (trace id vs fingerprint/
    // turn) — the anchor makes the two lanes derive the identical turn_id.
    const ids = ['toolu_1', 'toolu_2', 'toolu_3'];
    const otelSide = computeTurnId(ids, 'otel-trace-abc');
    const transcriptSide = computeTurnId(ids, 'tf:deadbeef:1');
    expect(otelSide).toBe(transcriptSide);
    expect(otelSide).toMatch(HEX64);
  });

  it('order- and duplicate-independent (a partial/reordered observation still matches)', () => {
    expect(computeTurnId(['b', 'a', 'a', 'c'], 'k')).toBe(computeTurnId(['c', 'a', 'b'], 'k2'));
  });

  it('normalizes away empties, whitespace, and null/undefined ids', () => {
    expect(computeTurnId(['x', '', '  ', null, undefined, 'y'], 'k'))
      .toBe(computeTurnId(['y', 'x'], 'other'));
  });

  it('RED (i): DIFFERENT call-id sets → DIFFERENT turn_id (distinct work is never merged)', () => {
    expect(computeTurnId(['a', 'b'], 'k')).not.toBe(computeTurnId(['a', 'c'], 'k'));
    expect(computeTurnId(['a', 'b'], 'k')).not.toBe(computeTurnId(['a'], 'k'));
  });
});

describe('computeTurnId — the self-key fallback (no shared anchor available)', () => {
  it('no call id → the fallback self key VERBATIM (OTel back-compat: turn_id === trace_id)', () => {
    expect(computeTurnId([], 'otel-trace-abc')).toBe('otel-trace-abc');
    expect(computeTurnId([null, '', '  '], 'otel-trace-abc')).toBe('otel-trace-abc');
  });

  it('RED (i) for the fallback: two id-less turns with DIFFERENT self keys never collide', () => {
    expect(computeTurnId([], 'tf:fp:1')).not.toBe(computeTurnId([], 'tf:fp:2'));
  });

  it('the anchored and fallback forms are distinguishable (prefix) and never collide', () => {
    const anchored = computeTurnId(['a', 'b'], 'k');
    const fallback = computeTurnId([], 'k');
    expect(anchored.startsWith(TURN_ID_ANCHOR_PREFIX)).toBe(true);
    expect(fallback).toBe('k');
    expect(anchored).not.toBe(fallback);
  });

  it('bounds an oversized fallback self key to TURN_ID_MAX_CHARS', () => {
    const huge = 'z'.repeat(TURN_ID_MAX_CHARS + 50);
    expect(computeTurnId([], huge).length).toBe(TURN_ID_MAX_CHARS);
  });
});

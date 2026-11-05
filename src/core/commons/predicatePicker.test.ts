/**
 * §5 — the guided "prove it" sentences map 1:1 to vocabulary predicates, and the Advanced
 * raw form refuses anything outside the vocabulary before a burn.
 */
import { describe, it, expect } from 'vitest';
import {
  GUIDED_CLAIMS,
  VOCABULARY_FIELD_RE,
  buildGuidedPredicate,
  buildRawPredicate,
  describePredicate,
  matchGuidedClaim,
  parseClaimNumber,
} from './predicatePicker';

const t = (key: string, opts?: Record<string, unknown>) => `${key}|${String(opts?.n ?? '')}`;

describe('guided claims', () => {
  it('every sentence names a real vocabulary field and a unique (field, op)', () => {
    const seen = new Set<string>();
    expect(GUIDED_CLAIMS.length).toBeGreaterThanOrEqual(4);
    expect(GUIDED_CLAIMS.length).toBeLessThanOrEqual(6);
    for (const c of GUIDED_CLAIMS) {
      expect(VOCABULARY_FIELD_RE.test(c.field)).toBe(true);
      const key = `${c.field}|${c.op}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
  it('round-trips: sentence → predicate → the same sentence', () => {
    for (const c of GUIDED_CLAIMS) {
      const r = buildGuidedPredicate(c.id, String(c.defaultN));
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.predicate.field).toBe(c.field);
      expect(matchGuidedClaim(r.predicate)?.claim.id).toBe(c.id);
    }
  });
  it('maps "at least 10 pieces of work" exactly', () => {
    expect(buildGuidedPredicate('work_total', '10')).toEqual({ ok: true, predicate: { field: 'work.total', op: 'gte', threshold: 10 } });
  });
  it('a fixed sentence ignores the typed number', () => {
    expect(buildGuidedPredicate('clean_record', 'banana')).toEqual({ ok: true, predicate: { field: 'standing.adverse_events', op: 'eq', threshold: 0 } });
  });
  it('RED: an unknown sentence id and a bad number are refused', () => {
    expect(buildGuidedPredicate('governance_score', '1')).toEqual({ ok: false, error: 'unknown_claim' });
    expect(buildGuidedPredicate('work_total', '-3')).toEqual({ ok: false, error: 'bad_number' });
    expect(buildGuidedPredicate('work_total', '1.5')).toEqual({ ok: false, error: 'bad_number' });
    expect(buildGuidedPredicate('work_total', '')).toEqual({ ok: false, error: 'bad_number' });
    expect(parseClaimNumber('99999999')).toBeNull();
    expect(parseClaimNumber(' 42 ')).toBe(42);
  });
});

describe('raw (Advanced) predicates', () => {
  it('accepts a vocabulary field', () => {
    expect(buildRawPredicate('work.hardware_rooted', 'gt', '3')).toEqual({ ok: true, predicate: { field: 'work.hardware_rooted', op: 'gt', threshold: 3 } });
  });
  it('RED: out-of-vocabulary fields are refused', () => {
    for (const f of ['governance_score', 'wallet.balance', 'work', 'work.', 'Work.total', 'work.total; drop', 'work.__proto__', 'standing..x', 'x.work.total']) {
      expect(buildRawPredicate(f, 'gte', '1')).toEqual({ ok: false, error: 'field_out_of_vocabulary' });
    }
  });
  it('RED: an unknown op or a non-number threshold is refused', () => {
    expect(buildRawPredicate('work.total', 'contains', '1')).toEqual({ ok: false, error: 'bad_op' });
    expect(buildRawPredicate('work.total', 'gte', 'ten')).toEqual({ ok: false, error: 'bad_number' });
    expect(buildRawPredicate('work.total', 'gte', 'Infinity')).toEqual({ ok: false, error: 'bad_number' });
  });
});

describe('describePredicate', () => {
  it('uses the plain sentence for a guided predicate', () => {
    expect(describePredicate({ field: 'work.total', op: 'gte', threshold: 5 }, t)).toBe('commonsForum.claim.work_total|5');
  });
  it('falls back to the raw form (never hidden) otherwise', () => {
    expect(describePredicate({ field: 'work.hardware_rooted', op: 'gte', threshold: 3 }, t)).toBe('work.hardware_rooted ≥ 3');
    expect(describePredicate({ field: 'standing.adverse_events', op: 'eq', threshold: 2 }, t)).toBe('standing.adverse_events = 2');
  });
});

describe('picker drafts', () => {
  it('starts on the first sentence and builds its predicate', async () => {
    const { initialPredicateDraft, predicateFromDraft, selectGuidedClaim } = await import('./predicatePicker');
    const d = initialPredicateDraft();
    expect(predicateFromDraft(d)).toEqual({ ok: true, predicate: { field: 'work.total', op: 'gte', threshold: 10 } });
    const s = selectGuidedClaim({ ...d, nText: '999' }, 'active_days');
    expect(s.nText).toBe('30');
    expect(predicateFromDraft(s)).toEqual({ ok: true, predicate: { field: 'continuity.active_days', op: 'gte', threshold: 30 } });
  });
  it('RED: the Advanced form refuses an out-of-vocabulary field from the draft', async () => {
    const { initialPredicateDraft, predicateFromDraft } = await import('./predicatePicker');
    const d = { ...initialPredicateDraft(), mode: 'advanced' as const, field: 'governance_score', thresholdText: '1' };
    expect(predicateFromDraft(d)).toEqual({ ok: false, error: 'field_out_of_vocabulary' });
  });
});

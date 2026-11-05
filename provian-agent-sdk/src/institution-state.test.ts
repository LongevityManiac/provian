import { describe, it, expect } from 'vitest';
import {
  INSTITUTION_KINDS,
  INSTITUTION_STATES,
  INSTITUTION_TRANSITIONS,
  INITIAL,
  classifyTransition,
  isEconomicTransition,
  isLegalTransition,
} from './institution-state';

describe('institution-state (SDK mirror) — vocabulary + classification', () => {
  it('classifies the core economic vs record-only edges', () => {
    expect(classifyTransition('escrow', 'created', 'funded')).toBe('economic');
    expect(classifyTransition('escrow', INITIAL, 'created')).toBe('record_only');
    expect(classifyTransition('bond', INITIAL, 'active')).toBe('economic');
    expect(classifyTransition('job', 'open', 'assigned')).toBe('record_only');
  });

  it('linked-job settlement: job + human-job settlement edges are economic; drafts stay record-only', () => {
    expect(classifyTransition('job', 'delivered', 'completed')).toBe('economic');
    expect(classifyTransition('job', 'assigned', 'completed')).toBe('economic');
    expect(classifyTransition('job', 'delivered', 'refunded')).toBe('economic');
    expect(classifyTransition('human_job', 'open', 'in_progress')).toBe('record_only');
    expect(classifyTransition('human_job', 'in_progress', 'disputed')).toBe('record_only');
    expect(classifyTransition('human_job', 'in_progress', 'completed')).toBe('economic');
    expect(classifyTransition('human_job', 'disputed', 'refunded')).toBe('economic');
    // Terminal states have no outgoing edges; undeclared cancel edges are illegal.
    expect(classifyTransition('job', 'completed', 'open')).toBeNull();
    expect(classifyTransition('human_job', 'in_progress', 'cancelled')).toBeNull();
  });

  it('returns null for illegal / unknown edges', () => {
    expect(classifyTransition('escrow', 'created', 'completed')).toBeNull();
    expect(classifyTransition('promise', 'settled', 'funded')).toBeNull();
    expect(classifyTransition('nope' as never, 'a', 'b')).toBeNull();
  });

  it('isEconomicTransition / isLegalTransition agree with classifyTransition', () => {
    expect(isEconomicTransition('promise', 'funded', 'settled')).toBe(true);
    expect(isEconomicTransition('escrow', 'funded', 'disputed')).toBe(false);
    expect(isLegalTransition('escrow', 'funded', 'disputed')).toBe(true);
    expect(isLegalTransition('escrow', 'created', 'completed')).toBe(false);
  });

  it('every declared transition references declared states (or INITIAL) on both ends', () => {
    for (const [kind, from, to] of INSTITUTION_TRANSITIONS) {
      const states = INSTITUTION_STATES[kind];
      expect(from === INITIAL || states.includes(from)).toBe(true);
      expect(states.includes(to)).toBe(true);
    }
  });

  it('INITIAL is never a member of any state set; states are unique + non-empty', () => {
    for (const kind of INSTITUTION_KINDS) {
      const states = INSTITUTION_STATES[kind];
      expect(states.includes(INITIAL)).toBe(false);
      expect(states.length).toBeGreaterThan(0);
      expect(new Set(states).size).toBe(states.length);
    }
  });

  it('the transition table has no duplicate edges', () => {
    const keys = INSTITUTION_TRANSITIONS.map(([k, f, t]) => `${k}|${f}|${t}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

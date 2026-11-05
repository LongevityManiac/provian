/**
 * Client-side staleness evaluation + nudge.
 *
 * Every "flags/logs X" assertion is paired with a control proving the guard can
 * be quiet — a hard-wired "always warn" would fail those. The task's
 * required RED control is here explicitly: a below-minSupported version triggers
 * the loud (error) nudge.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSemver,
  compareSemver,
  evaluateStaleness,
  stalenessMessage,
  logStaleness,
  type StalenessLogger,
} from './sdk-staleness';

function collector(): { logger: StalenessLogger; warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return { logger: { warn: (m) => warns.push(m), error: (m) => errors.push(m) }, warns, errors };
}

describe('semver primitives', () => {
  it('parses and compares', () => {
    expect(parseSemver('1.5.0')).toEqual([1, 5, 0]);
    expect(parseSemver('nope')).toBeNull();
    expect(compareSemver('1.4.0', '1.5.0')).toBeLessThan(0);
    expect(compareSemver('1.5.0', '1.5.0')).toBe(0);
  });
});

describe('evaluateStaleness', () => {
  it('flags stale when current < latest', () => {
    const v = evaluateStaleness('1.4.0', '1.5.0', '1.0.0');
    expect(v.stale).toBe(true);
    expect(v.belowMin).toBe(false);
  });

  it('flags belowMin when current < minSupported', () => {
    const v = evaluateStaleness('0.9.0', '1.5.0', '1.0.0');
    expect(v.belowMin).toBe(true);
    expect(v.stale).toBe(true);
  });

  it('CONTROL: up-to-date is neither stale nor belowMin (guard can be quiet)', () => {
    const v = evaluateStaleness('1.5.0', '1.5.0', '1.0.0');
    expect(v.stale).toBe(false);
    expect(v.belowMin).toBe(false);
  });

  it('fail-open: null advertised values -> nothing flagged', () => {
    const v = evaluateStaleness('1.4.0', null, null);
    expect(v.stale).toBe(false);
    expect(v.belowMin).toBe(false);
  });

  it('fail-open: unparseable current -> nothing flagged', () => {
    const v = evaluateStaleness('dev', '1.5.0', '1.0.0');
    expect(v.stale).toBe(false);
    expect(v.belowMin).toBe(false);
  });
});

describe('stalenessMessage', () => {
  it('mentions upgrade command for a stale version', () => {
    const msg = stalenessMessage(evaluateStaleness('1.4.0', '1.5.0', '1.0.0'), 'npm i @provian/agent-sdk@latest');
    expect(msg).toContain('1.4.0');
    expect(msg).toContain('1.5.0');
    expect(msg).toContain('npm i @provian/agent-sdk@latest');
  });

  it('CONTROL: returns null when up to date (nothing to say)', () => {
    expect(stalenessMessage(evaluateStaleness('1.5.0', '1.5.0', '1.0.0'))).toBeNull();
  });
});

describe('logStaleness (the nudge)', () => {
  it('RED CONTROL: a below-minSupported version triggers a loud (error) nudge', () => {
    const { logger, warns, errors } = collector();
    const logged = logStaleness(evaluateStaleness('0.9.0', '1.5.0', '1.0.0'), logger);
    expect(logged).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/BELOW the minimum/i);
    expect(warns).toHaveLength(0);
  });

  it('a stale-but-supported version triggers a WARN (not error)', () => {
    const { logger, warns, errors } = collector();
    const logged = logStaleness(evaluateStaleness('1.4.0', '1.5.0', '1.0.0'), logger);
    expect(logged).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/newer @provian\/agent-sdk/i);
    expect(errors).toHaveLength(0);
  });

  it('CONTROL: an up-to-date SDK logs NOTHING (proves logger is not hardwired)', () => {
    const { logger, warns, errors } = collector();
    const logged = logStaleness(evaluateStaleness('1.5.0', '1.5.0', '1.0.0'), logger);
    expect(logged).toBe(false);
    expect(warns).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

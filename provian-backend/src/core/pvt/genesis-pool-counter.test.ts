/**
 * Q3/C6 — the Genesis pool counter chokepoint.
 *
 * The claim is "the counter can only go up". A test that only ever feeds it
 * increases would pass identically if the guard were `return proposed`, so
 * every admitting case here is paired with the decrease that must be refused,
 * and the refusal population is asserted non-empty at the end.
 *
 * The parameters are `unknown` precisely so the violating inputs — a missing
 * document reading as `undefined`, a `NaN` from a bad parse, a negative value,
 * a string — are constructible. A guard whose violation cannot be constructed
 * has never been shown to work.
 */

import {
  decideMonotonicPoolCounterWrite,
  admitMonotonicPoolCounterWrite,
  GenesisPoolCounterMonotonicityError,
  POOL_COUNTER_REVERSAL_REFUSED,
  type PoolCounterVerdict,
} from './genesis-pool-counter';

const SITE = 'test';

describe('decideMonotonicPoolCounterWrite', () => {
  it('ADMITS an increase and returns the proposed value', () => {
    expect(decideMonotonicPoolCounterWrite(100, 175, SITE)).toEqual({
      admitted: true, verdict: 'admitted_monotonic', next: 175, site: SITE,
    });
  });

  it('ADMITS an unchanged value (monotonic is non-decreasing, not strictly increasing)', () => {
    expect(decideMonotonicPoolCounterWrite(100, 100, SITE).admitted).toBe(true);
  });

  it('ADMITS the first write from zero', () => {
    expect(decideMonotonicPoolCounterWrite(0, 75, SITE).next).toBe(75);
  });

  // ---- RED controls: the paired decrease for each admitted case -------------

  it('RED: a decrease is refused, with no fallback value', () => {
    const d = decideMonotonicPoolCounterWrite(100, 25, SITE);
    expect(d.admitted).toBe(false);
    expect(d.verdict).toBe('refused_decrease');
    expect(d.next).toBeNull();
  });

  it('RED: a decrease of the smallest representable step is still refused', () => {
    expect(decideMonotonicPoolCounterWrite(100, 100 - Number.EPSILON * 100, SITE).verdict)
      .toBe('refused_decrease');
  });

  it('RED: a decrease to zero is refused, not treated as a reset', () => {
    expect(decideMonotonicPoolCounterWrite(424.74, 0, SITE).verdict).toBe('refused_decrease');
  });

  it('RED: a negative proposed value is refused', () => {
    expect(decideMonotonicPoolCounterWrite(10, -1, SITE).verdict).toBe('refused_proposed_unknown');
  });

  // ---- UNKNOWN refuses under its own verdict, never coerced to zero ---------

  it.each<[string, unknown, PoolCounterVerdict]>([
    ['undefined (absent document)', undefined, 'refused_previous_unknown'],
    ['null', null, 'refused_previous_unknown'],
    ['NaN', NaN, 'refused_previous_unknown'],
    ['Infinity', Infinity, 'refused_previous_unknown'],
    ['a numeric string', '100', 'refused_previous_unknown'],
    ['negative', -1, 'refused_previous_unknown'],
  ])('RED: previous = %s is refused, NOT read as 0', (_label, previous, verdict) => {
    const d = decideMonotonicPoolCounterWrite(previous, 500, SITE);
    expect(d.admitted).toBe(false);
    expect(d.verdict).toBe(verdict);
    expect(d.next).toBeNull();
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a numeric string', '175'],
  ])('RED: proposed = %s is refused', (_label, proposed) => {
    expect(decideMonotonicPoolCounterWrite(100, proposed, SITE).verdict)
      .toBe('refused_proposed_unknown');
  });

  it('an unknown PREVIOUS is refused even when the proposed value is an increase', () => {
    // The dangerous coercion: `Number(undefined || 0)` would make this admit,
    // silently resetting a counter whose real value was never read.
    expect(decideMonotonicPoolCounterWrite(undefined, 1_000_000, SITE).admitted).toBe(false);
  });

  it('carries the caller site through to the decision, for logs', () => {
    expect(decideMonotonicPoolCounterWrite(1, 0, 'rollbackGenesisIssuance').site)
      .toBe('rollbackGenesisIssuance');
  });

  it('the refusal population is non-empty AND the admit population is non-empty', () => {
    const cases: Array<[unknown, unknown]> = [
      [100, 175], [100, 100], [0, 75],
      [100, 25], [100, -1], [undefined, 5], [NaN, 5], [100, NaN],
    ];
    const verdicts = cases.map(([p, n]) => decideMonotonicPoolCounterWrite(p, n, SITE).admitted);
    // Neither branch is vacuous: a guard hard-wired either way fails here.
    expect(verdicts.filter(Boolean).length).toBe(3);
    expect(verdicts.filter((v) => !v).length).toBe(5);
  });
});

describe('admitMonotonicPoolCounterWrite', () => {
  it('returns the value on an admitted move', () => {
    expect(admitMonotonicPoolCounterWrite(100, 175, SITE)).toBe(175);
  });

  it('RED: THROWS on a decrease, so a transaction aborts rather than half-applying', () => {
    expect(() => admitMonotonicPoolCounterWrite(100, 25, 'reserveGenesisIssuance'))
      .toThrow(GenesisPoolCounterMonotonicityError);
  });

  it('RED: the thrown error names the verdict and the site', () => {
    try {
      admitMonotonicPoolCounterWrite(undefined, 5, 'somewhere');
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(GenesisPoolCounterMonotonicityError);
      expect((err as GenesisPoolCounterMonotonicityError).verdict).toBe('refused_previous_unknown');
      expect((err as GenesisPoolCounterMonotonicityError).site).toBe('somewhere');
    }
  });

  it('there is no override parameter — the refusal cannot be argued past', () => {
    // Two parameters plus the site label. An override flag would be exactly the
    // authority this module removes, so its absence is asserted, not assumed.
    expect(admitMonotonicPoolCounterWrite.length).toBe(3);
    expect(decideMonotonicPoolCounterWrite.length).toBe(3);
  });
});

describe('POOL_COUNTER_REVERSAL_REFUSED', () => {
  it('states the direction of the trade rather than calling it temporary', () => {
    expect(POOL_COUNTER_REVERSAL_REFUSED).toMatch(/monotonic/);
    expect(POOL_COUNTER_REVERSAL_REFUSED).toMatch(/EARLIER/);
    expect(POOL_COUNTER_REVERSAL_REFUSED).not.toMatch(/temporar/i);
  });
});

/**
 * settlement runtime — the cap-death clock.
 *
 * The property under test: a run of zero-issuance epochs is DETECTED and escalates, and the
 * one fact that clears it (issuance) is the only thing that does.
 *
 * Every alarm assertion carries its RED control — an alarm that cannot fail is not a watch.
 * The live epoch-zero arming instant is used as the fixture so the suite is bound to the real
 * clock rather than to a convenient round number.
 */

import {
  AUTOMATIC_TRAILING_EPOCHS,
  CombinedCapMode,
  EPOCH_DURATION_SEC,
  evaluateCapClock,
  type CapClockObservation,
} from './cap-clock';

/** `epochZeroStartsAt()` as armed on Base: 2026-07-27T00:00:00Z. */
const EPOCH_ZERO_SEC = 1_785_110_400;

function observation(overrides?: Partial<CapClockObservation>): CapClockObservation {
  return {
    epochZeroArmed: true,
    epochZeroStartsAtSec: EPOCH_ZERO_SEC,
    combinedCapMode: CombinedCapMode.Automatic,
    totalIssuedAtomic: 0n,
    nextFinalizedCursor: 0n,
    observedAtSec: EPOCH_ZERO_SEC,
    ...overrides,
  };
}

const atEpoch = (n: number): number => EPOCH_ZERO_SEC + n * EPOCH_DURATION_SEC;

describe('cap-death clock', () => {
  it('computes the death instant as exactly twelve epochs after arming', () => {
    const verdict = evaluateCapClock(observation());
    expect(verdict.capDeathAtSec).toBe(EPOCH_ZERO_SEC + AUTOMATIC_TRAILING_EPOCHS * EPOCH_DURATION_SEC);
    // 2026-07-27 + 84 days.
    expect(new Date(verdict.capDeathAtSec * 1000).toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('at arming: watching, twelve epochs remaining, no alarm yet', () => {
    const verdict = evaluateCapClock(observation());
    expect(verdict.level).toBe('watch');
    expect(verdict.alarm).toBe(false);
    expect(verdict.elapsedEpochs).toBe(0);
    expect(verdict.epochsRemaining).toBe(AUTOMATIC_TRAILING_EPOCHS);
    expect(verdict.hasIssued).toBe(false);
  });

  it('escalates to warn at six epochs remaining', () => {
    const verdict = evaluateCapClock(observation({ observedAtSec: atEpoch(6) }));
    expect(verdict.epochsRemaining).toBe(6);
    expect(verdict.level).toBe('warn');
    expect(verdict.alarm).toBe(true);
  });

  it('escalates to critical at two epochs remaining', () => {
    const verdict = evaluateCapClock(observation({ observedAtSec: atEpoch(10) }));
    expect(verdict.epochsRemaining).toBe(2);
    expect(verdict.level).toBe('critical');
    expect(verdict.alarm).toBe(true);
  });

  it('declares the cap DEAD once twelve zero-issuance epochs elapse', () => {
    const verdict = evaluateCapClock(observation({ observedAtSec: atEpoch(12) }));
    expect(verdict.level).toBe('cap_dead');
    expect(verdict.alarm).toBe(true);
    expect(verdict.epochsRemaining).toBe(0);
    expect(verdict.message).toContain('scheduleCapPolicy');
  });

  it('stays dead past the deadline rather than wrapping to a lower level', () => {
    const verdict = evaluateCapClock(observation({ observedAtSec: atEpoch(40) }));
    expect(verdict.level).toBe('cap_dead');
    expect(verdict.epochsRemaining).toBe(0);
    expect(verdict.secondsRemaining).toBeLessThan(0);
  });

  it('RED CONTROL: issuance via totalIssued clears the alarm at the same instant', () => {
    const dead = evaluateCapClock(observation({ observedAtSec: atEpoch(12) }));
    const issued = evaluateCapClock(observation({
      observedAtSec: atEpoch(12),
      totalIssuedAtomic: 1n,
    }));
    expect(dead.level).toBe('cap_dead');
    expect(issued.level).toBe('ok');
    expect(issued.alarm).toBe(false);
    expect(issued.hasIssued).toBe(true);
  });

  it('RED CONTROL: a finalized cursor alone also clears it — one stale read cannot silence the watch', () => {
    const verdict = evaluateCapClock(observation({
      observedAtSec: atEpoch(12),
      totalIssuedAtomic: 0n,
      nextFinalizedCursor: 1n,
    }));
    expect(verdict.hasIssued).toBe(true);
    expect(verdict.level).toBe('ok');
  });

  it('RED CONTROL: a Fixed cap makes the absorbing zero inapplicable', () => {
    const automatic = evaluateCapClock(observation({ observedAtSec: atEpoch(12) }));
    const fixed = evaluateCapClock(observation({
      observedAtSec: atEpoch(12),
      combinedCapMode: CombinedCapMode.Fixed,
    }));
    expect(automatic.alarm).toBe(true);
    expect(fixed.level).toBe('not_applicable');
    expect(fixed.alarm).toBe(false);
  });

  it('RED CONTROL: an unarmed kernel is not on the clock', () => {
    const armed = evaluateCapClock(observation({ observedAtSec: atEpoch(12) }));
    const unarmed = evaluateCapClock(observation({
      observedAtSec: atEpoch(12),
      epochZeroArmed: false,
    }));
    expect(armed.alarm).toBe(true);
    expect(unarmed.level).toBe('not_applicable');
    expect(unarmed.alarm).toBe(false);
  });

  it('treats pre-arming observation time as zero elapsed, never negative', () => {
    const verdict = evaluateCapClock(observation({ observedAtSec: EPOCH_ZERO_SEC - 86_400 }));
    expect(verdict.elapsedEpochs).toBe(0);
    expect(verdict.epochsRemaining).toBe(AUTOMATIC_TRAILING_EPOCHS);
    expect(verdict.secondsRemaining).toBeGreaterThan(0);
  });

  it('does not escalate one second before an epoch boundary', () => {
    const justBefore = evaluateCapClock(observation({ observedAtSec: atEpoch(6) - 1 }));
    const atBoundary = evaluateCapClock(observation({ observedAtSec: atEpoch(6) }));
    expect(justBefore.epochsRemaining).toBe(7);
    expect(justBefore.level).toBe('watch');
    expect(atBoundary.level).toBe('warn');
  });
});

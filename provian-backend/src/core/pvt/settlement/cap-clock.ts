/**
 * settlement runtime — the cap-death clock.
 *
 * `ProvianPVT9` epoch zero is armed in `CombinedCapMode.Automatic`. Automatic derives each
 * epoch's combined cap from the trailing twelve epochs' issuance: twelve flat epochs first,
 * then exactly 2x the floored trailing 12-epoch average. **A zero average produces a zero
 * cap, and zero is absorbing** once the cap reaches zero, every subsequent trailing window
 * is also zero, and the only exit is a `scheduleCapPolicy` call placing a Fixed cap.
 *
 * That is not a hypothetical. PVT9 is armed and has never settled, so the trailing window is
 * all zeros today. If twelve epochs elapse with no issuance, the combined cap becomes
 * permanently zero and no qualifying act can ever mint — the pipeline would be complete,
 * correct, and worth nothing.
 *
 * Nothing in the repo watched for this. This module is the watch. It is pure arithmetic over
 * an observation — it reads no chain, writes nothing, and sends nothing; the caller supplies
 * the observation and decides what to do with the alarm.
 *
 * WHY THE DEADLINE IS COMPUTED, NOT CONFIGURED
 *
 * `EPOCH_DURATION` is a contract constant with no setter and `epochZeroStartsAt` is fixed at
 * arming, so the death epoch and its wall-clock instant are fully determined by two on-chain
 * reads. A configured deadline would be a second source of truth that can drift from the
 * contract; there is no reason to have one.
 */

/** `ProvianPVT9.EPOCH_DURATION` — a constant with no setter. */
export const EPOCH_DURATION_SEC = 7 * 24 * 60 * 60;

/**
 * The trailing window Automatic mode averages over, and therefore the number of consecutive
 * zero-issuance epochs that drives the cap to a permanent zero.
 */
export const AUTOMATIC_TRAILING_EPOCHS = 12;

export enum CombinedCapMode {
  Automatic = 0,
  Fixed = 1,
}

/** What the watch needs to know, all of it read straight off the kernel. */
export interface CapClockObservation {
  readonly epochZeroArmed: boolean;
  /** `epochZeroStartsAt()`, unix seconds. */
  readonly epochZeroStartsAtSec: number;
  /** `getEpochPolicy(lastOpenedEpoch).combinedCapMode`. */
  readonly combinedCapMode: CombinedCapMode;
  /** Cumulative PVT issued since arming, atomic. Zero means nothing has ever settled. */
  readonly totalIssuedAtomic: bigint;
  /** `nextFinalizedCursor()`. Zero means no batch has ever been finalized. */
  readonly nextFinalizedCursor: bigint;
  /** Observation instant, unix seconds. */
  readonly observedAtSec: number;
}

export type CapClockLevel =
  /** Not armed, or already on a Fixed cap: the absorbing zero cannot be reached. */
  | 'not_applicable'
  /** Armed, Automatic, issuance has happened. The trailing window is not all-zero. */
  | 'ok'
  /** Armed, Automatic, zero issuance, and the deadline is still comfortably ahead. */
  | 'watch'
  /** Zero issuance and inside the warning horizon. Acting late is acting never. */
  | 'warn'
  /** Zero issuance and the final epoch is running. The next boundary is the last one. */
  | 'critical'
  /** Twelve zero-issuance epochs have elapsed. The cap is zero and only Fixed exits. */
  | 'cap_dead';

export interface CapClockVerdict {
  readonly level: CapClockLevel;
  /** True when an operator must be paged. `warn` and above. */
  readonly alarm: boolean;
  /** Epochs elapsed since `epochZeroStartsAt`, floored. Negative time yields 0. */
  readonly elapsedEpochs: number;
  /** Epochs remaining before the cap becomes permanently zero. 0 once dead. */
  readonly epochsRemaining: number;
  /** Unix seconds at which the twelfth zero-issuance epoch completes. */
  readonly capDeathAtSec: number;
  /** Seconds until `capDeathAtSec`. Negative once past. */
  readonly secondsRemaining: number;
  /** Whether anything has ever settled. The single fact that clears the alarm. */
  readonly hasIssued: boolean;
  /** One line, safe to put straight into a page or a log. */
  readonly message: string;
}

/** Epochs remaining at which the level escalates to `warn`. */
export const WARN_AT_EPOCHS_REMAINING = 6;
/** Epochs remaining at which the level escalates to `critical`. */
export const CRITICAL_AT_EPOCHS_REMAINING = 2;

function elapsedEpochsAt(observedAtSec: number, epochZeroStartsAtSec: number): number {
  if (observedAtSec < epochZeroStartsAtSec) return 0;
  return Math.floor((observedAtSec - epochZeroStartsAtSec) / EPOCH_DURATION_SEC);
}

/**
 * Evaluate the cap-death clock.
 *
 * Fail-closed in the direction that matters: anything that cannot be shown to be safe is
 * reported at a HIGHER level, never a lower one. Issuance is the only thing that clears the
 * alarm, and it is read from two independent facts (`totalIssuedAtomic` and
 * `nextFinalizedCursor`) so a single stale read cannot silence the watch.
 */
export function evaluateCapClock(observation: CapClockObservation): CapClockVerdict {
  const elapsedEpochs = elapsedEpochsAt(
    observation.observedAtSec,
    observation.epochZeroStartsAtSec,
  );
  const capDeathAtSec = observation.epochZeroStartsAtSec
    + AUTOMATIC_TRAILING_EPOCHS * EPOCH_DURATION_SEC;
  const secondsRemaining = capDeathAtSec - observation.observedAtSec;
  const epochsRemaining = Math.max(0, AUTOMATIC_TRAILING_EPOCHS - elapsedEpochs);

  // Either fact proving issuance clears the alarm; requiring BOTH to be zero is what makes a
  // single stale or mis-decoded read unable to silence the watch.
  const hasIssued = observation.totalIssuedAtomic > 0n || observation.nextFinalizedCursor > 0n;

  const base = {
    elapsedEpochs,
    epochsRemaining,
    capDeathAtSec,
    secondsRemaining,
    hasIssued,
  };

  if (!observation.epochZeroArmed) {
    return {
      ...base,
      level: 'not_applicable',
      alarm: false,
      message: 'Epoch zero is not armed; the Automatic cap clock is not running.',
    };
  }

  if (observation.combinedCapMode === CombinedCapMode.Fixed) {
    return {
      ...base,
      level: 'not_applicable',
      alarm: false,
      message: 'Combined cap is Fixed; the absorbing zero of Automatic mode does not apply.',
    };
  }

  if (hasIssued) {
    return {
      ...base,
      level: 'ok',
      alarm: false,
      message: `Issuance has occurred; the trailing ${AUTOMATIC_TRAILING_EPOCHS}-epoch window is not all-zero.`,
    };
  }

  const deadline = new Date(capDeathAtSec * 1000).toISOString();

  if (epochsRemaining === 0) {
    return {
      ...base,
      level: 'cap_dead',
      alarm: true,
      message: `CAP DEAD: ${AUTOMATIC_TRAILING_EPOCHS} zero-issuance epochs elapsed as of ${deadline}. `
        + 'The Automatic combined cap is permanently zero and no batch can settle. '
        + 'The ONLY exit is scheduleCapPolicy with CombinedCapMode.Fixed from the bootstrap admin EOA.',
    };
  }

  const level: CapClockLevel = epochsRemaining <= CRITICAL_AT_EPOCHS_REMAINING
    ? 'critical'
    : epochsRemaining <= WARN_AT_EPOCHS_REMAINING
      ? 'warn'
      : 'watch';

  return {
    ...base,
    level,
    alarm: level !== 'watch',
    message: `${level.toUpperCase()}: zero issuance with ${epochsRemaining} of `
      + `${AUTOMATIC_TRAILING_EPOCHS} epochs remaining. If nothing settles by ${deadline} the `
      + 'Automatic combined cap becomes permanently zero and only a Fixed cap can restore minting.',
  };
}

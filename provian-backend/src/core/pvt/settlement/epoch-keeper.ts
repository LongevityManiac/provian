/**
 * settlement runtime — THE EPOCH KEEPER. The thing that actually calls `openNextEpoch()`.
 *
 * `epoch-orchestration.ts` has always computed which `openNextEpoch()` calls are due, and
 * nothing ever made one. That is not a cosmetic gap. Two live consequences:
 *
 * 1. A scheduled cap policy does not self-apply. the operator’s `scheduleCapPolicy(effectiveEpoch=1,
 * Fixed, MAX, MAX)` sits unapplied until epoch 1 is OPENED, and epoch 1 opens only
 * when someone calls this function. Until then the Automatic caps stay in force.
 * 2. `settleStandardPEBatch` requires `wallClockEpoch == epoch == lastOpenedEpoch`. Once wall
 * time crosses a boundary and nobody has opened the new epoch, EVERY settle reverts with
 * `EpochMismatch`. Settlement stops dead at the first 7-day boundary.
 *
 * WHAT MAKES THIS SAFE TO RUN ON A TIMER
 *
 * `openNextEpoch()` is the only kernel entrypoint with NO modifier — not `whenNotHeld`, not
 * `onlyOperationalMinter`. It cannot mint, cannot move value, cannot change policy, and cannot
 * be made to open an epoch ahead of chain time (`EpochNotReady`). The worst outcome of running
 * it wrongly is a reverted transaction and its gas. So this keeper is permissionless by
 * construction and its failure mode is bounded to gas.
 *
 * IDEMPOTENT BY RE-OBSERVATION, NOT BY MEMORY
 *
 * The chain is re-read before EVERY call, and the plan is recomputed from that read. If another
 * keeper (or the operator, or a stranger) opened the epoch a second earlier, this run simply sees
 * `lastOpenedEpoch` already advanced and has nothing to do. There is no local "I already did
 * this" state that can disagree with the chain. Running it twice a minute forever is safe.
 *
 * IT HANDLES EVERY FUTURE EPOCH, NOT THE NEXT ONE
 *
 * The kernel advances exactly one epoch per call, so a keeper that was down for three weeks owes
 * three calls. `planEpochAdvance` already computes that catch-up; this module executes it in
 * ascending order, bounded by `maxCallsPerRun`, and reports what is still owed.
 *
 * IT ALARMS ON THE STATE AFTER THE RUN, NOT BEFORE IT
 *
 * The alarm asks "is an epoch that should be open still closed?" evaluated on a FINAL
 * observation taken after the last attempt. Alarming on the opening observation would page an
 * operator for a lag this very run just fixed, and — much worse — would stay quiet about a run
 * that tried and failed. Unknown alarms: an unreadable observation is an alarm, never a pass.
 *
 * Nothing here signs, encodes calldata, or opens a connection: the chain is an injected port.
 */

import {
  PVT9_EPOCH_DURATION_SEC,
  planEpochAdvance,
  wallClockEpoch,
  type EpochAdvancePlan,
  type EpochClockObservation,
} from './epoch-orchestration';
import type { SettlementDb } from './durable-settlement-store';

/** Where the keeper's single-flight lease and its last verdict live. */
export const EPOCH_KEEPER_COLLECTION = 'pvt9_epoch_keeper_v1';
export const EPOCH_KEEPER_LEASE_DOCUMENT = 'lease';
export const EPOCH_KEEPER_SCHEMA = 'pvt9-epoch-keeper/v1' as const;

/**
 * How long an epoch may be due-but-unopened before it is an ALARM rather than ordinary lag.
 *
 * An operating parameter, not an economic one. It exists because a keeper firing hourly will
 * legitimately observe a few minutes of lag every seventh day, and paging for that trains an
 * operator to ignore the page. Callers must pass one explicitly — there is no ambient default
 * at a call site.
 */
export const DEFAULT_EPOCH_LAG_GRACE_SEC = 3_600;

export type EpochLagLevel =
  /** Not armed, or chain time is still before epoch zero. There is no epoch to owe. */
  | 'not_applicable'
  /** `lastOpenedEpoch` equals the wall-clock epoch. Nothing is owed. */
  | 'ok'
  /** Exactly one epoch owed, inside the grace window. Ordinary; the keeper will take it. */
  | 'due'
  /** One epoch owed for longer than the grace window. Something is stopping the keeper. */
  | 'late'
  /** Two or more epochs owed. Settlement has been impossible for at least a full epoch. */
  | 'critical'
  /** The observation is self-inconsistent or unreadable. Unknown alarms. */
  | 'unreadable';

export interface EpochLagVerdict {
  readonly level: EpochLagLevel;
  /** True when an operator must be paged. `late` and above. */
  readonly alarm: boolean;
  /** The epoch chain time says we are in, or null before epoch zero / unreadable. */
  readonly wallClockEpoch: number | null;
  readonly lastOpenedEpoch: number;
  /** Epochs owed right now. Zero when nothing is due. */
  readonly epochsOwed: number;
  /**
   * Seconds since the OLDEST owed epoch became openable. Zero when nothing is owed.
   * This is the number that decides `due` vs `late`, and it is measured from the boundary,
   * never from when this process happened to start.
   */
  readonly overdueSec: number;
  /** One line, safe to put straight into a page or a log. */
  readonly message: string;
}

const ALARM_LEVELS: ReadonlySet<EpochLagLevel> = new Set<EpochLagLevel>([
  'late',
  'critical',
  'unreadable',
]);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Decide whether an epoch that should be open is still closed, and how badly.
 *
 * Pure. Fail-closed in the direction that matters: anything that cannot be shown to be fine is
 * reported at a HIGHER level, never a lower one.
 */
export function evaluateEpochLag(
  observation: EpochClockObservation,
  graceSec: number,
): EpochLagVerdict {
  const lastOpenedEpoch = isNonNegativeInteger(observation?.lastOpenedEpoch)
    ? observation.lastOpenedEpoch
    : -1;

  if (!isNonNegativeInteger(graceSec)) {
    return {
      level: 'unreadable',
      alarm: true,
      wallClockEpoch: null,
      lastOpenedEpoch,
      epochsOwed: 0,
      overdueSec: 0,
      message: 'EPOCH KEEPER: grace window is not a non-negative integer; refusing to judge lag.',
    };
  }

  if (observation?.epochZeroArmed !== true) {
    return {
      level: 'not_applicable',
      alarm: false,
      wallClockEpoch: null,
      lastOpenedEpoch,
      epochsOwed: 0,
      overdueSec: 0,
      message: 'Epoch zero is not armed; no epoch can be owed.',
    };
  }

  const epoch = wallClockEpoch(observation);
  if (epoch === null) {
    // Two very different causes, and they must not be conflated. Before epoch zero there is
    // genuinely nothing owed; an unreadable observation is an alarm.
    const readable = isNonNegativeInteger(observation.epochZeroStartsAtSec)
      && isNonNegativeInteger(observation.observedAtSec)
      && isNonNegativeInteger(observation.lastOpenedEpoch);
    return readable
      ? {
        level: 'not_applicable',
        alarm: false,
        wallClockEpoch: null,
        lastOpenedEpoch,
        epochsOwed: 0,
        overdueSec: 0,
        message: 'Chain time is before epoch zero; no epoch can be owed yet.',
      }
      : {
        level: 'unreadable',
        alarm: true,
        wallClockEpoch: null,
        lastOpenedEpoch,
        epochsOwed: 0,
        overdueSec: 0,
        message: 'EPOCH KEEPER: kernel epoch state is unreadable. Unknown = alarm.',
      };
  }

  if (lastOpenedEpoch > epoch) {
    // The kernel refuses to open an epoch ahead of chain time, so this is structurally
    // impossible; observing it means the snapshot is lying and nothing below it is trustworthy.
    return {
      level: 'unreadable',
      alarm: true,
      wallClockEpoch: epoch,
      lastOpenedEpoch,
      epochsOwed: 0,
      overdueSec: 0,
      message: `EPOCH KEEPER: lastOpenedEpoch ${lastOpenedEpoch} is AHEAD of wall-clock epoch `
        + `${epoch}. The kernel cannot do this; the observation is untrustworthy.`,
    };
  }

  const epochsOwed = epoch - lastOpenedEpoch;
  if (epochsOwed === 0) {
    return {
      level: 'ok',
      alarm: false,
      wallClockEpoch: epoch,
      lastOpenedEpoch,
      epochsOwed: 0,
      overdueSec: 0,
      message: `Epoch ${epoch} is open and current.`,
    };
  }

  // Measured from the boundary of the OLDEST owed epoch — the moment it first became
  // openable — so a keeper that has been failing for a week reports a week, not one run.
  const oldestOwedOpenableAtSec = observation.epochZeroStartsAtSec
    + (lastOpenedEpoch + 1) * PVT9_EPOCH_DURATION_SEC;
  const overdueSec = Math.max(0, observation.observedAtSec - oldestOwedOpenableAtSec);

  const level: EpochLagLevel = epochsOwed >= 2
    ? 'critical'
    : overdueSec >= graceSec
      ? 'late'
      : 'due';

  const detail = `epoch ${lastOpenedEpoch + 1} has been openable for ${overdueSec}s `
    + `(${epochsOwed} owed, wall-clock epoch ${epoch}, last opened ${lastOpenedEpoch})`;

  return {
    level,
    alarm: ALARM_LEVELS.has(level),
    wallClockEpoch: epoch,
    lastOpenedEpoch,
    epochsOwed,
    overdueSec,
    message: level === 'due'
      ? `Epoch advance is due: ${detail}.`
      : `EPOCH KEEPER ${level.toUpperCase()}: ${detail}. Scheduled policy is NOT in force and `
        + 'every settlement batch reverts with EpochMismatch until the epoch is opened.',
  };
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export type EpochOpenOutcome =
  | { readonly kind: 'opened'; readonly txHash: string }
  /** The transaction was mined and reverted, or was rejected before mining. */
  | { readonly kind: 'refused'; readonly reason: string; readonly txHash: string | null };

/** The chain access the keeper needs. Deliberately two methods and nothing else. */
export interface EpochKeeperChain {
  observe(): Promise<EpochClockObservation>;
  /**
   * Send `openNextEpoch()` and wait for its receipt.
   *
   * `expectedEpoch` is passed so the implementation can log/assert what it believed it was
   * opening; the kernel takes no argument and derives the epoch itself, which is why this
   * keeper can never open the wrong one.
   */
  openNextEpoch(expectedEpoch: number): Promise<EpochOpenOutcome>;
}

export interface EpochKeeperConfig {
  /** Identifies this worker in the lease. Same id re-acquires its own lease. */
  readonly workerId: string;
  /** Hard ceiling on `openNextEpoch()` calls in one run. Bounds gas per run. */
  readonly maxCallsPerRun: number;
  /** How long a due-but-unopened epoch may sit before the verdict is an alarm. */
  readonly lagGraceSec: number;
  /** Single-flight lease TTL. A crashed keeper's lease expires and another may take it. */
  readonly leaseTtlMs: number;
}

export interface EpochKeeperDeps {
  readonly db: SettlementDb;
  readonly chain: EpochKeeperChain;
  readonly now: () => number;
  readonly log?: (message: string) => void;
}

export type EpochKeeperStopReason =
  /** Nothing was owed, or everything owed was opened. */
  | 'up_to_date'
  /** Epoch zero is not armed, or chain time is before it. */
  | 'nothing_to_open'
  /** `maxCallsPerRun` reached with epochs still owed. Run again. */
  | 'call_limit'
  /** A call was refused on-chain. Stop; do not burn gas on the same refusal repeatedly. */
  | 'refused'
  /** Another keeper holds a live lease. */
  | 'lease_held'
  /** The chain port threw. */
  | 'chain_unreadable';

export interface EpochKeeperReport {
  readonly outcome: 'completed' | 'stopped';
  readonly stopReason: EpochKeeperStopReason;
  /** Epochs opened by THIS run, ascending. Empty is the ordinary steady state. */
  readonly opened: readonly { readonly epoch: number; readonly txHash: string }[];
  /** Epochs still owed after this run. Non-zero means run again. */
  readonly stillOwed: number;
  /** Refusal detail when `stopReason` is `refused`. */
  readonly detail: string | null;
  /** The verdict on the FINAL observation. This is what pages an operator. */
  readonly lag: EpochLagVerdict;
}

interface KeeperLeaseDoc {
  readonly schema_version: typeof EPOCH_KEEPER_SCHEMA;
  readonly owner: string;
  readonly acquired_at_ms: number;
  readonly expires_at_ms: number;
}

/**
 * Take the single-flight lease, or refuse.
 *
 * The keeper is idempotent without this — it re-observes before every call — so the lease is
 * not a correctness requirement. What it buys is NONCE hygiene: the keeper signs from the same
 * EOA as the settlement approver, and two keepers racing would allocate the same nonce and
 * throw one transaction away. Same worker id re-acquires (a crash-restart resumes immediately).
 */
export async function acquireEpochKeeperLease(
  db: SettlementDb,
  params: { workerId: string; nowMs: number; leaseTtlMs: number },
): Promise<boolean> {
  const ref = db.collection(EPOCH_KEEPER_COLLECTION).doc(EPOCH_KEEPER_LEASE_DOCUMENT);
  return db.runTransaction<boolean>(async (txn) => {
    const snap = await txn.get(ref);
    const fresh: KeeperLeaseDoc = {
      schema_version: EPOCH_KEEPER_SCHEMA,
      owner: params.workerId,
      acquired_at_ms: params.nowMs,
      expires_at_ms: params.nowMs + params.leaseTtlMs,
    };
    if (!snap.exists) {
      txn.create(ref, fresh as unknown as Record<string, unknown>);
      return true;
    }
    const existing = (snap.data() ?? {}) as Partial<KeeperLeaseDoc>;
    const live = typeof existing.expires_at_ms === 'number'
      && existing.expires_at_ms > params.nowMs;
    if (live && existing.owner !== params.workerId) return false;
    txn.set(ref, fresh as unknown as Record<string, unknown>, { merge: true });
    return true;
  });
}

/**
 * Release the lease this worker holds.
 *
 * A single-flight lease must be RELEASED when the work finishes, not left to expire. Making the
 * worker id unique per invocation (so the guard can actually refuse a concurrent run) means a
 * lease left standing would block the NEXT run for the whole TTL — including a Cloud Scheduler
 * retry 30 seconds after a transient failure, which is precisely when the keeper most needs to
 * run. Expiry stays as the crash backstop; this is the ordinary path.
 *
 * Only the owner may release, so a lease that has already been taken over by another worker
 * after expiry is never yanked out from under it.
 */
export async function releaseEpochKeeperLease(
  db: SettlementDb,
  params: { workerId: string; nowMs: number },
): Promise<void> {
  const ref = db.collection(EPOCH_KEEPER_COLLECTION).doc(EPOCH_KEEPER_LEASE_DOCUMENT);
  await db.runTransaction<void>(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return;
    const existing = (snap.data() ?? {}) as Partial<KeeperLeaseDoc>;
    if (existing.owner !== params.workerId) return;
    txn.set(ref, {
      schema_version: EPOCH_KEEPER_SCHEMA,
      owner: params.workerId,
      acquired_at_ms: existing.acquired_at_ms ?? params.nowMs,
      // Expired as of now: the next run acquires immediately, whoever it is.
      expires_at_ms: params.nowMs,
    } as unknown as Record<string, unknown>, { merge: true });
  });
}

/**
 * Run the keeper once.
 *
 * Safe to call on any cadence and from any number of processes. Opens at most
 * `maxCallsPerRun` epochs, re-reading the chain before each one, and returns the alarm verdict
 * on the state it leaves behind.
 */
export async function runEpochKeeper(
  deps: EpochKeeperDeps,
  config: EpochKeeperConfig,
): Promise<EpochKeeperReport> {
  if (!Number.isSafeInteger(config.maxCallsPerRun) || config.maxCallsPerRun <= 0) {
    throw new Error('runEpochKeeper: maxCallsPerRun must be a positive integer');
  }

  const opened: { epoch: number; txHash: string }[] = [];
  let detail: string | null = null;
  /** Only release what we actually took; the `lease_held` exit must not clear someone else's. */
  let heldLease = false;

  const finish = async (
    stopReason: EpochKeeperStopReason,
    finalObservation: EpochClockObservation | null,
  ): Promise<EpochKeeperReport> => {
    const lag = finalObservation === null
      ? evaluateEpochLag(
        { epochZeroArmed: true, epochZeroStartsAtSec: -1, lastOpenedEpoch: -1, observedAtSec: -1 },
        config.lagGraceSec,
      )
      : evaluateEpochLag(finalObservation, config.lagGraceSec);
    const report: EpochKeeperReport = {
      outcome: stopReason === 'up_to_date' || stopReason === 'nothing_to_open'
        ? 'completed'
        : 'stopped',
      stopReason,
      opened,
      stillOwed: lag.epochsOwed,
      detail,
      lag,
    };
    deps.log?.(
      `epoch-keeper: outcome=${report.outcome} stop=${stopReason} opened=${opened.length} `
      + `stillOwed=${report.stillOwed} lag=${lag.level}${lag.alarm ? ' ALARM' : ''}`,
    );
    if (lag.alarm) deps.log?.(`epoch-keeper ALARM: ${lag.message}`);
    // Release on EVERY exit, including the failure exits. Holding a lease after the work is
    // done blocks the next run — and after a failure the next run is the retry.
    if (heldLease) {
      try {
        await releaseEpochKeeperLease(deps.db, { workerId: config.workerId, nowMs: deps.now() });
      } catch {
        // A failed release is not a failed run: the lease expires on its own. Never let it
        // turn a completed keeper run into a reported failure.
      }
    }
    return report;
  };

  const leased = await acquireEpochKeeperLease(deps.db, {
    workerId: config.workerId,
    nowMs: deps.now(),
    leaseTtlMs: config.leaseTtlMs,
  });
  heldLease = leased;
  if (!leased) {
    // Still observe, so a lease held by a WEDGED keeper cannot silence the alarm. A run that
    // says nothing because another run holds the lease is exactly how a stuck keeper hides.
    let observation: EpochClockObservation | null = null;
    try {
      observation = await deps.chain.observe();
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    return finish('lease_held', observation);
  }

  let observation: EpochClockObservation;
  // Counts every ATTEMPT, not every success. A refusal that a competing keeper turned into a
  // success still consumed a run slot; without this the race branch below could loop forever.
  let attempts = 0;
  for (;;) {
    try {
      observation = await deps.chain.observe();
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
      return finish('chain_unreadable', null);
    }

    // One call at a time, re-planned from a fresh read. `planEpochAdvance` returns null for
    // "nothing due" AND for "not armed / before epoch zero / unreadable", so the distinction
    // is recovered from the lag verdict rather than assumed here.
    const plan: EpochAdvancePlan | null = planEpochAdvance(observation, 1);
    if (plan === null) {
      const lag = evaluateEpochLag(observation, config.lagGraceSec);
      return finish(lag.level === 'not_applicable' ? 'nothing_to_open' : 'up_to_date', observation);
    }

    if (attempts >= config.maxCallsPerRun) return finish('call_limit', observation);
    attempts += 1;

    const target = plan.calls[0];
    const outcome = await deps.chain.openNextEpoch(target);
    if (outcome.kind === 'refused') {
      detail = `openNextEpoch(${target}) refused: ${outcome.reason}`;
      deps.log?.(`epoch-keeper: ${detail}`);
      // Re-observe before judging: a refusal because a competing keeper opened the epoch
      // first is a SUCCESS of the system, and must not be reported as a failure of it.
      let after: EpochClockObservation | null = null;
      try {
        after = await deps.chain.observe();
      } catch {
        after = null;
      }
      if (after !== null && after.lastOpenedEpoch >= target) {
        detail = `${detail} (epoch ${target} is open — another keeper won the race)`;
        continue;
      }
      return finish('refused', after);
    }

    opened.push({ epoch: target, txHash: outcome.txHash });
    deps.log?.(`epoch-keeper: opened epoch ${target} in ${outcome.txHash}`);
  }
}

/**
 * Epoch keeper — behaviour, and the RED control for every assertion that matters.
 *
 * The run contract's rule applies with full force here: a keeper test that has only ever been
 * observed green proves nothing, because the ordinary steady state of this module is "nothing
 * to do". Every claim below is paired with a deliberately violating input that makes the same
 * assertion fail, so "no epochs opened" can never be confused with "the keeper does nothing".
 */

import { describe, expect, it, jest } from '@jest/globals';
import {
  DEFAULT_EPOCH_LAG_GRACE_SEC,
  EPOCH_KEEPER_COLLECTION,
  EPOCH_KEEPER_LEASE_DOCUMENT,
  acquireEpochKeeperLease,
  evaluateEpochLag,
  runEpochKeeper,
  type EpochKeeperChain,
  type EpochOpenOutcome,
} from './epoch-keeper';
import { PVT9_EPOCH_DURATION_SEC, type EpochClockObservation } from './epoch-orchestration';
import { newKeeperWorkerId } from './operator-runtime';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import type { SettlementDb } from './durable-settlement-store';

/** The live kernel's arming instant: 2026-07-27T00:00:00Z. */
const EPOCH_ZERO = 1_785_110_400;

function observationAt(params: {
  secondsAfterEpochZero: number;
  lastOpenedEpoch: number;
  armed?: boolean;
}): EpochClockObservation {
  return {
    epochZeroArmed: params.armed ?? true,
    epochZeroStartsAtSec: EPOCH_ZERO,
    lastOpenedEpoch: params.lastOpenedEpoch,
    observedAtSec: EPOCH_ZERO + params.secondsAfterEpochZero,
  };
}

function fakeDb(): SettlementDb {
  return createFakeFirestore() as unknown as SettlementDb;
}

/**
 * A chain that opens epochs for real: `lastOpenedEpoch` advances on success, exactly as the
 * kernel does. A stub that never advanced would make "opened everything owed" unfalsifiable.
 */
function movingChain(params: {
  startSecondsAfterEpochZero: number;
  lastOpenedEpoch: number;
  refuseAt?: number;
  refuseReason?: string;
}): EpochKeeperChain & { readonly calls: number[]; lastOpenedEpoch: number } {
  const state = {
    lastOpenedEpoch: params.lastOpenedEpoch,
    calls: [] as number[],
    async observe(): Promise<EpochClockObservation> {
      return observationAt({
        secondsAfterEpochZero: params.startSecondsAfterEpochZero,
        lastOpenedEpoch: state.lastOpenedEpoch,
      });
    },
    async openNextEpoch(expectedEpoch: number): Promise<EpochOpenOutcome> {
      state.calls.push(expectedEpoch);
      if (params.refuseAt !== undefined && expectedEpoch === params.refuseAt) {
        return { kind: 'refused', reason: params.refuseReason ?? 'EpochNotReady', txHash: null };
      }
      state.lastOpenedEpoch = expectedEpoch;
      return { kind: 'opened', txHash: `0x${expectedEpoch.toString(16).padStart(64, '0')}` };
    },
  };
  return state;
}

const CONFIG = {
  workerId: 'test-keeper',
  maxCallsPerRun: 8,
  lagGraceSec: DEFAULT_EPOCH_LAG_GRACE_SEC,
  leaseTtlMs: 60_000,
};

describe('evaluateEpochLag', () => {
  it('is not_applicable before epoch zero, and that is NOT how it reports an unreadable read', () => {
    const before = evaluateEpochLag(
      { ...observationAt({ secondsAfterEpochZero: 0, lastOpenedEpoch: 0 }), observedAtSec: EPOCH_ZERO - 1 },
      DEFAULT_EPOCH_LAG_GRACE_SEC,
    );
    expect(before.level).toBe('not_applicable');
    expect(before.alarm).toBe(false);

    // RED CONTROL: the same "wallClockEpoch === null" branch, reached by an UNREADABLE
    // observation instead of by an early one, must alarm. If these two collapsed onto one
    // verdict, a broken adapter would be reported as "too early" forever.
    const broken = evaluateEpochLag(
      { epochZeroArmed: true, epochZeroStartsAtSec: Number.NaN, lastOpenedEpoch: 0, observedAtSec: EPOCH_ZERO },
      DEFAULT_EPOCH_LAG_GRACE_SEC,
    );
    expect(broken.level).toBe('unreadable');
    expect(broken.alarm).toBe(true);
  });

  it('is ok when the open epoch is current, and due -> late -> critical as lag grows', () => {
    const ok = evaluateEpochLag(
      observationAt({ secondsAfterEpochZero: 100, lastOpenedEpoch: 0 }),
      DEFAULT_EPOCH_LAG_GRACE_SEC,
    );
    expect(ok.level).toBe('ok');
    expect(ok.alarm).toBe(false);
    expect(ok.epochsOwed).toBe(0);

    // One epoch owed, ten seconds past the boundary: ordinary.
    const due = evaluateEpochLag(
      observationAt({ secondsAfterEpochZero: PVT9_EPOCH_DURATION_SEC + 10, lastOpenedEpoch: 0 }),
      DEFAULT_EPOCH_LAG_GRACE_SEC,
    );
    expect(due.level).toBe('due');
    expect(due.alarm).toBe(false);
    expect(due.epochsOwed).toBe(1);
    expect(due.overdueSec).toBe(10);

    // RED CONTROL for the grace window: the SAME single owed epoch, one second past grace,
    // must alarm. Without this, a grace window of Infinity would pass the `due` case above.
    const late = evaluateEpochLag(
      observationAt({
        secondsAfterEpochZero: PVT9_EPOCH_DURATION_SEC + DEFAULT_EPOCH_LAG_GRACE_SEC,
        lastOpenedEpoch: 0,
      }),
      DEFAULT_EPOCH_LAG_GRACE_SEC,
    );
    expect(late.level).toBe('late');
    expect(late.alarm).toBe(true);

    // Two owed epochs alarm immediately, whatever the grace window says.
    const critical = evaluateEpochLag(
      observationAt({ secondsAfterEpochZero: 2 * PVT9_EPOCH_DURATION_SEC + 1, lastOpenedEpoch: 0 }),
      Number.MAX_SAFE_INTEGER,
    );
    expect(critical.level).toBe('critical');
    expect(critical.alarm).toBe(true);
    expect(critical.epochsOwed).toBe(2);
  });

  it('alarms when lastOpenedEpoch is ahead of wall-clock time', () => {
    const ahead = evaluateEpochLag(
      observationAt({ secondsAfterEpochZero: 10, lastOpenedEpoch: 3 }),
      DEFAULT_EPOCH_LAG_GRACE_SEC,
    );
    expect(ahead.level).toBe('unreadable');
    expect(ahead.alarm).toBe(true);

    // RED CONTROL: the identical shape with a truthful lastOpenedEpoch is quiet, so the
    // assertion above is testing the ahead-ness and not something incidental to the fixture.
    expect(evaluateEpochLag(
      observationAt({ secondsAfterEpochZero: 10, lastOpenedEpoch: 0 }),
      DEFAULT_EPOCH_LAG_GRACE_SEC,
    ).alarm).toBe(false);
  });

  it('refuses to judge on a malformed grace window rather than defaulting to one', () => {
    const verdict = evaluateEpochLag(
      observationAt({ secondsAfterEpochZero: 10, lastOpenedEpoch: 0 }),
      -1,
    );
    expect(verdict.level).toBe('unreadable');
    expect(verdict.alarm).toBe(true);
  });
});

describe('runEpochKeeper', () => {
  it('opens nothing and stays quiet when the current epoch is already open', async () => {
    const chain = movingChain({ startSecondsAfterEpochZero: 60, lastOpenedEpoch: 0 });
    const report = await runEpochKeeper(
      { db: fakeDb(), chain, now: () => 1 },
      CONFIG,
    );
    expect(report.outcome).toBe('completed');
    expect(report.stopReason).toBe('up_to_date');
    expect(chain.calls).toEqual([]);
    expect(report.lag.alarm).toBe(false);

    // RED CONTROL: "no calls" must not be the keeper's only behaviour. The same keeper, one
    // second past the boundary, MUST call. Without this the assertion above would pass
    // identically against a keeper hard-wired to do nothing.
    const dueChain = movingChain({
      startSecondsAfterEpochZero: PVT9_EPOCH_DURATION_SEC + 1,
      lastOpenedEpoch: 0,
    });
    const dueReport = await runEpochKeeper({ db: fakeDb(), chain: dueChain, now: () => 1 }, CONFIG);
    expect(dueChain.calls).toEqual([1]);
    expect(dueReport.opened.map((o) => o.epoch)).toEqual([1]);
  });

  it('opens EVERY owed epoch in ascending order, not just the next one', async () => {
    // Down for five weeks: five epochs owed.
    const chain = movingChain({
      startSecondsAfterEpochZero: 5 * PVT9_EPOCH_DURATION_SEC + 30,
      lastOpenedEpoch: 0,
    });
    const report = await runEpochKeeper({ db: fakeDb(), chain, now: () => 1 }, CONFIG);

    expect(chain.calls).toEqual([1, 2, 3, 4, 5]);
    expect(report.opened.map((o) => o.epoch)).toEqual([1, 2, 3, 4, 5]);
    expect(report.stopReason).toBe('up_to_date');
    expect(report.stillOwed).toBe(0);
    expect(report.lag.level).toBe('ok');
    expect(report.lag.alarm).toBe(false);
  });

  it('is bounded by maxCallsPerRun and reports what is still owed', async () => {
    const chain = movingChain({
      startSecondsAfterEpochZero: 5 * PVT9_EPOCH_DURATION_SEC + 30,
      lastOpenedEpoch: 0,
    });
    const report = await runEpochKeeper(
      { db: fakeDb(), chain, now: () => 1 },
      { ...CONFIG, maxCallsPerRun: 2 },
    );
    expect(chain.calls).toEqual([1, 2]);
    expect(report.outcome).toBe('stopped');
    expect(report.stopReason).toBe('call_limit');
    expect(report.stillOwed).toBe(3);
    // Still owed after the run => still alarming. A bounded run must not report all-clear.
    expect(report.lag.alarm).toBe(true);
    expect(report.lag.level).toBe('critical');
  });

  it('is idempotent: a second run against the same chain opens nothing', async () => {
    const chain = movingChain({
      startSecondsAfterEpochZero: 2 * PVT9_EPOCH_DURATION_SEC + 30,
      lastOpenedEpoch: 0,
    });
    const db = fakeDb();
    const first = await runEpochKeeper({ db, chain, now: () => 1 }, CONFIG);
    expect(first.opened.map((o) => o.epoch)).toEqual([1, 2]);

    const callsAfterFirst = chain.calls.length;
    const second = await runEpochKeeper({ db, chain, now: () => 2 }, CONFIG);
    expect(chain.calls.length).toBe(callsAfterFirst);
    expect(second.opened).toEqual([]);
    expect(second.stopReason).toBe('up_to_date');
    expect(second.lag.alarm).toBe(false);
  });

  it('stops on a genuine refusal and ALARMS rather than reporting completion', async () => {
    const chain = movingChain({
      startSecondsAfterEpochZero: 3 * PVT9_EPOCH_DURATION_SEC + 30,
      lastOpenedEpoch: 0,
      refuseAt: 2,
      refuseReason: 'execution reverted: EpochNotReady',
    });
    const report = await runEpochKeeper({ db: fakeDb(), chain, now: () => 1 }, CONFIG);

    expect(report.opened.map((o) => o.epoch)).toEqual([1]);
    expect(report.outcome).toBe('stopped');
    expect(report.stopReason).toBe('refused');
    expect(report.detail).toContain('EpochNotReady');
    expect(report.stillOwed).toBe(2);
    expect(report.lag.alarm).toBe(true);
  });

  it('treats a refusal that another keeper already satisfied as a race, not a failure', async () => {
    let opened = 0;
    const chain: EpochKeeperChain = {
      async observe() {
        return observationAt({
          secondsAfterEpochZero: PVT9_EPOCH_DURATION_SEC + 30,
          lastOpenedEpoch: opened,
        });
      },
      async openNextEpoch() {
        // Our transaction lost, but the epoch IS open — a competing keeper won.
        opened = 1;
        return { kind: 'refused', reason: 'nonce too low', txHash: null };
      },
    };
    const report = await runEpochKeeper({ db: fakeDb(), chain, now: () => 1 }, CONFIG);
    expect(report.outcome).toBe('completed');
    expect(report.stopReason).toBe('up_to_date');
    expect(report.opened).toEqual([]);
    expect(report.lag.alarm).toBe(false);
  });

  it('reports nothing_to_open when epoch zero is not armed', async () => {
    const chain: EpochKeeperChain = {
      async observe() {
        return observationAt({ secondsAfterEpochZero: 10, lastOpenedEpoch: 0, armed: false });
      },
      async openNextEpoch() {
        throw new Error('must not be called');
      },
    };
    const report = await runEpochKeeper({ db: fakeDb(), chain, now: () => 1 }, CONFIG);
    expect(report.stopReason).toBe('nothing_to_open');
    expect(report.lag.level).toBe('not_applicable');
    expect(report.lag.alarm).toBe(false);
  });

  it('alarms — never silently passes — when the chain port throws', async () => {
    const chain: EpochKeeperChain = {
      async observe() {
        throw new Error('rpc down');
      },
      async openNextEpoch() {
        throw new Error('must not be called');
      },
    };
    const report = await runEpochKeeper({ db: fakeDb(), chain, now: () => 1 }, CONFIG);
    expect(report.stopReason).toBe('chain_unreadable');
    expect(report.detail).toContain('rpc down');
    expect(report.lag.level).toBe('unreadable');
    expect(report.lag.alarm).toBe(true);
  });

  it('refuses a lease another worker holds, but still reports that worker\'s lag', async () => {
    const db = fakeDb();
    expect(await acquireEpochKeeperLease(db, {
      workerId: 'other-worker', nowMs: 1_000, leaseTtlMs: 60_000,
    })).toBe(true);

    const chain = movingChain({
      startSecondsAfterEpochZero: 3 * PVT9_EPOCH_DURATION_SEC + 30,
      lastOpenedEpoch: 0,
    });
    const report = await runEpochKeeper({ db, chain, now: () => 2_000 }, CONFIG);

    expect(report.stopReason).toBe('lease_held');
    expect(chain.calls).toEqual([]);
    // THE POINT: a wedged keeper holding the lease must not silence the alarm.
    expect(report.lag.alarm).toBe(true);
    expect(report.lag.epochsOwed).toBe(3);

    // RED CONTROL: an EXPIRED lease from the same other worker must be takeable, so the
    // refusal above is about liveness and not about the doc merely existing.
    const later = await runEpochKeeper({ db, chain, now: () => 1_000_000 }, CONFIG);
    expect(later.stopReason).toBe('up_to_date');
    expect(chain.calls).toEqual([1, 2, 3]);
  });

  it('lets the SAME worker re-acquire its own live lease (crash-restart resumes)', async () => {
    const db = fakeDb();
    expect(await acquireEpochKeeperLease(db, {
      workerId: 'w', nowMs: 1_000, leaseTtlMs: 60_000,
    })).toBe(true);
    expect(await acquireEpochKeeperLease(db, {
      workerId: 'w', nowMs: 1_100, leaseTtlMs: 60_000,
    })).toBe(true);
    expect(await acquireEpochKeeperLease(db, {
      workerId: 'other', nowMs: 1_200, leaseTtlMs: 60_000,
    })).toBe(false);

    const snap = await db.collection(EPOCH_KEEPER_COLLECTION)
      .doc(EPOCH_KEEPER_LEASE_DOCUMENT).get();
    expect(snap.exists).toBe(true);
    expect((snap.data() ?? {}).owner).toBe('w');
  });

  it('SINGLE-FLIGHT holds in the PRODUCTION shape, not just with hand-picked ids', async () => {
    // The lease tests below this one prove refusal using two literal ids ('w' vs 'other'). That
    // shape is not what production produces, and the reviewer caught what it hid: the only
    // production caller passed NO workerId, `runEpochKeeperRuntime` defaulted it to the constant
    // `'pvt9-epoch-keeper'`, so every invocation presented the same owner and
    // `live && owner !== workerId` was never true. The single-flight guard could not refuse
    // anybody and `stopReason: 'lease_held'` was unreachable.
    //
    // This test binds to the id the RUNTIME generates rather than to one the test chose.
    const first = newKeeperWorkerId();
    const second = newKeeperWorkerId();
    expect(first).not.toBe(second);
    expect(first.startsWith('pvt9-epoch-keeper:')).toBe(true);

    const db = fakeDb();
    expect(await acquireEpochKeeperLease(db, {
      workerId: first, nowMs: 1_000, leaseTtlMs: 60_000,
    })).toBe(true);
    // A concurrent invocation — which is exactly two calls to the same route — is refused.
    expect(await acquireEpochKeeperLease(db, {
      workerId: second, nowMs: 1_100, leaseTtlMs: 60_000,
    })).toBe(false);

    // RED CONTROL: with the OLD constant id, both "invocations" acquire — the defect, made
    // executable. If `newKeeperWorkerId` ever regresses to a constant, the assertion above
    // fails and this one still passes, so the pair cannot both go green on a broken build.
    const constantDb = fakeDb();
    expect(await acquireEpochKeeperLease(constantDb, {
      workerId: 'pvt9-epoch-keeper', nowMs: 1_000, leaseTtlMs: 60_000,
    })).toBe(true);
    expect(await acquireEpochKeeperLease(constantDb, {
      workerId: 'pvt9-epoch-keeper', nowMs: 1_100, leaseTtlMs: 60_000,
    })).toBe(true);
  });

  it('RELEASES its lease so the very next run is not blocked by it', async () => {
    // Making the worker id unique per invocation (the fix above) means a lease left standing
    // would block the NEXT run for the whole TTL — including the Cloud Scheduler retry 30s
    // after a transient failure, which is exactly when the keeper most needs to run. The fork
    // harness caught this: the post-warp keeper run reported `lease_held` and opened nothing.
    const db = fakeDb();
    const first = newKeeperWorkerId();
    const chain = movingChain({ startSecondsAfterEpochZero: 60, lastOpenedEpoch: 0 });
    const run = await runEpochKeeper({ db, chain, now: () => 1_000 },
      { ...CONFIG, workerId: first, leaseTtlMs: 600_000 });
    expect(run.stopReason).toBe('up_to_date');

    // A DIFFERENT worker, one millisecond later, well inside the 10-minute TTL.
    const second = newKeeperWorkerId();
    expect(await acquireEpochKeeperLease(db, {
      workerId: second, nowMs: 1_001, leaseTtlMs: 600_000,
    })).toBe(true);

    // RED CONTROL: a lease that was NOT released does block the next worker, so the assertion
    // above is testing the release and not something incidental to the fixture.
    const unreleased = fakeDb();
    expect(await acquireEpochKeeperLease(unreleased, {
      workerId: newKeeperWorkerId(), nowMs: 1_000, leaseTtlMs: 600_000,
    })).toBe(true);
    expect(await acquireEpochKeeperLease(unreleased, {
      workerId: newKeeperWorkerId(), nowMs: 1_001, leaseTtlMs: 600_000,
    })).toBe(false);
  });

  it('releases even when the run FAILS — the retry must not be locked out', async () => {
    const db = fakeDb();
    const broken: EpochKeeperChain = {
      async observe() { throw new Error('rpc down'); },
      async openNextEpoch() { throw new Error('must not be called'); },
    };
    const worker = newKeeperWorkerId();
    const report = await runEpochKeeper({ db, chain: broken, now: () => 1_000 },
      { ...CONFIG, workerId: worker, leaseTtlMs: 600_000 });
    expect(report.stopReason).toBe('chain_unreadable');

    expect(await acquireEpochKeeperLease(db, {
      workerId: newKeeperWorkerId(), nowMs: 1_001, leaseTtlMs: 600_000,
    })).toBe(true);
  });

  it('a run REFUSED for lease_held does not release the holder\'s lease', async () => {
    const db = fakeDb();
    const holder = newKeeperWorkerId();
    expect(await acquireEpochKeeperLease(db, {
      workerId: holder, nowMs: 1_000, leaseTtlMs: 600_000,
    })).toBe(true);

    const chain = movingChain({ startSecondsAfterEpochZero: 60, lastOpenedEpoch: 0 });
    const refused = await runEpochKeeper({ db, chain, now: () => 1_100 },
      { ...CONFIG, workerId: newKeeperWorkerId(), leaseTtlMs: 600_000 });
    expect(refused.stopReason).toBe('lease_held');

    // The holder still holds it — a refused run must never clear someone else's lease.
    expect(await acquireEpochKeeperLease(db, {
      workerId: newKeeperWorkerId(), nowMs: 1_200, leaseTtlMs: 600_000,
    })).toBe(false);
  });

  it('rejects a non-positive call budget instead of looping', async () => {
    const chain = movingChain({ startSecondsAfterEpochZero: 60, lastOpenedEpoch: 0 });
    await expect(runEpochKeeper(
      { db: fakeDb(), chain, now: () => 1 },
      { ...CONFIG, maxCallsPerRun: 0 },
    )).rejects.toThrow('maxCallsPerRun');
  });

  it('logs the alarm line whenever the final verdict alarms', async () => {
    const log = jest.fn();
    const chain = movingChain({
      startSecondsAfterEpochZero: 3 * PVT9_EPOCH_DURATION_SEC + 30,
      lastOpenedEpoch: 0,
      refuseAt: 1,
    });
    await runEpochKeeper({ db: fakeDb(), chain, now: () => 1, log }, CONFIG);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((line) => line.includes('epoch-keeper ALARM'))).toBe(true);

    // RED CONTROL: a healthy run must NOT emit the alarm line.
    const quietLog = jest.fn();
    await runEpochKeeper(
      {
        db: fakeDb(),
        chain: movingChain({ startSecondsAfterEpochZero: 60, lastOpenedEpoch: 0 }),
        now: () => 1,
        log: quietLog,
      },
      CONFIG,
    );
    expect(quietLog.mock.calls.map((c) => String(c[0])).some((l) => l.includes('ALARM'))).toBe(false);
  });
});

/**
 * /the settlement-run alarm classifier. Observability only: it does not
 * settle, mint, or move a cursor; it decides whether a produced outcome pages.
 * RED-controlled : the exact production failure (`stopped`/`resumption_abort`,
 * the 2026-08-17 & 08-24 scheduled aborts) MUST alarm, and every non-`stopped`
 * terminal (`completed`, `refused`, dry-run) must NOT. folded
 * `awaiting_finality` INTO the alarm set — after the deadline-bounded reflect it is
 * reached only when the run spent its whole budget waiting on a stalled chain.
 */

import { describe, expect, it } from '@jest/globals';
import { settlementRunNeedsAlarm } from './operator-runtime';
import type { SettlementRunResult } from './operator-runtime';

/**
 * Fixture — the classifier reads `result.settlement.{outcome,stopReason}` plus
 * (OP-1) `result.standardLaneAdmission` and `result.standardInlet`. The defaults
 * here are the benign shape: the standard lane ADMITTED and an empty inlet, so
 * these cases exercise only the outcome branch.
 */
function withSettlement(outcome: string | null, stopReason: string | null): SettlementRunResult {
  return {
    settlement: outcome === null ? null : { outcome, stopReason },
    standardLaneAdmission: { admitted: true },
    standardInlet: { registered: 0, alreadyRegistered: 0 },
  } as unknown as SettlementRunResult;
}

/** OP-1 fixture: a standard lane held by a refused recon gate, with backlog.
 * `lane` defaults to the 'both' run — the run that MUST page on held
 * standard backlog. A 'genesis'-scoped daily run is the exemption. */
function withStandardHold(
  opts: {
    outcome: string;
    refused: boolean;
    registered: number;
    alreadyRegistered?: number;
    lane?: 'both' | 'genesis' | 'standard';
  },
): SettlementRunResult {
  return {
    lane: opts.lane ?? 'both',
    settlement: { outcome: opts.outcome, stopReason: 'backlog_exhausted' },
    standardLaneAdmission: opts.refused
      ? { admitted: false, reason: 'report_stale_tree', detail: 'deploy without re-publish' }
      : { admitted: true },
    standardInlet: {
      registered: opts.registered,
      alreadyRegistered: opts.alreadyRegistered ?? 0,
    },
  } as unknown as SettlementRunResult;
}

describe('settlementRunNeedsAlarm ', () => {
  it('RED CONTROL: a real production abort (stopped / resumption_abort) ALARMS', () => {
    // The exact 08-17 + 08-24 scheduled-cron failure that left backlog unsettled.
    expect(settlementRunNeedsAlarm(withSettlement('stopped', 'resumption_abort'))).toBe(true);
  });

  it('every non-benign stop alarms', () => {
    for (const reason of [
      'resumption_abort', 'batch_approval_refused', 'batch_unsettleable', 'epoch_cap_deferral',
      'broadcast_failed', 'run_time_limit', 'standard_lane_refused', 'transaction_limit',
      'fee_limit', 'claim_identity_violations',
    ]) {
      expect(settlementRunNeedsAlarm(withSettlement('stopped', reason))).toBe(true);
    }
  });

  it('awaiting_finality now ALARMS (deadline-bounded reflect made it a genuine stall)', () => {
    // Post- the reflect wait is bounded by the run deadline, so awaiting_finality is
    // reached only after the run spent its ENTIRE budget waiting on a stalled chain — a
    // real "no silent partial completion" condition. RED CONTROL for the → flip:
    // under the OLD classifier this asserted `false`.
    expect(settlementRunNeedsAlarm(withSettlement('stopped', 'awaiting_finality'))).toBe(true);
  });

  it('a completed run (backlog_exhausted) and a refused run (epoch boundary) do NOT alarm', () => {
    expect(settlementRunNeedsAlarm(withSettlement('completed', 'backlog_exhausted'))).toBe(false);
    expect(settlementRunNeedsAlarm(withSettlement('refused', 'epoch_advance_required'))).toBe(false);
    expect(settlementRunNeedsAlarm(withSettlement('refused', 'boundary_margin'))).toBe(false);
  });

  it('RED CONTROL: only a `stopped` outcome alarms — a completed run never does', () => {
    // Guards against a regression that pages on every run: `completed`/`refused` must stay quiet.
    expect(settlementRunNeedsAlarm(withSettlement('completed', 'backlog_exhausted'))).toBe(false);
  });

  it('a dry run / inlet-only result (no settlement) does NOT alarm', () => {
    expect(settlementRunNeedsAlarm(withSettlement(null, null))).toBe(false);
  });
});

describe('settlementRunNeedsAlarm — OP-1: a silently-held standard lane pages', () => {
  it('RED CONTROL: a REFUSED standard lane with registered backlog alarms even when the run reports `completed`', () => {
    // The footgun: a recon report not re-published after a gated deploy refuses
    // the standard lane; Genesis settles and the run reports `completed`, so the
    // outcome branch alone would page NOTHING while standard backlog waits.
    // Pre-fix (outcome-only classifier) this asserted `false`.
    expect(settlementRunNeedsAlarm(
      withStandardHold({ outcome: 'completed', refused: true, registered: 5 }),
    )).toBe(true);
    // Backlog carried from prior runs (registered 0 this run) still counts.
    expect(settlementRunNeedsAlarm(
      withStandardHold({ outcome: 'completed', refused: true, registered: 0, alreadyRegistered: 3 }),
    )).toBe(true);
  });

  it('RED CONTROL: a refused lane with NO standard backlog does NOT alarm (nothing is held)', () => {
    expect(settlementRunNeedsAlarm(
      withStandardHold({ outcome: 'completed', refused: true, registered: 0, alreadyRegistered: 0 }),
    )).toBe(false);
  });

  it('RED CONTROL: an ADMITTED lane with backlog never trips the OP-1 branch (a healthy run stays quiet)', () => {
    expect(settlementRunNeedsAlarm(
      withStandardHold({ outcome: 'completed', refused: false, registered: 42 }),
    )).toBe(false);
  });
});

describe('settlementRunNeedsAlarm — a Genesis-scoped daily run does not page on held standard backlog', () => {
  it('a genesis-scoped run with a REFUSED, registered standard lane does NOT alarm (standard waits for the both-lanes run)', () => {
    // The daily Genesis run deliberately leaves the standard lane unsettled. Held
    // standard backlog is EXPECTED there, not a stall — so it must stay quiet.
    expect(settlementRunNeedsAlarm(
      withStandardHold({ outcome: 'completed', refused: true, registered: 5, lane: 'genesis' }),
    )).toBe(false);
    expect(settlementRunNeedsAlarm(
      withStandardHold({ outcome: 'completed', refused: true, registered: 0, alreadyRegistered: 9, lane: 'genesis' }),
    )).toBe(false);
  });

  it('RED CONTROL: the IDENTICAL held-standard state on the `both` run DOES alarm (the skip is scope-driven, not a swallowed hold)', () => {
    // Same refused+registered standard lane, only the scope differs. If this paged
    // `false` too, the exemption would be silencing the both-lanes run's genuine
    // held-backlog alarm — the exact regression this control guards.
    expect(settlementRunNeedsAlarm(
      withStandardHold({ outcome: 'completed', refused: true, registered: 5, lane: 'both' }),
    )).toBe(true);
  });

  it('a genesis-scoped run that STOPS still alarms (the scope exemption is only for the held-standard clause)', () => {
    // The lane exemption narrows ONLY the OP-1 standard-held branch; a genesis run
    // that actually stopped (e.g. resumption_abort) must still page.
    const stopped = {
      lane: 'genesis',
      settlement: { outcome: 'stopped', stopReason: 'resumption_abort' },
      standardLaneAdmission: { admitted: true },
      standardInlet: { registered: 0, alreadyRegistered: 0 },
    } as unknown as SettlementRunResult;
    expect(settlementRunNeedsAlarm(stopped)).toBe(true);
  });
});

describe('settlementRunNeedsAlarm — held claims and reorgs page', () => {
  const run = (settlement: Record<string, unknown>): SettlementRunResult => ({
    lane: 'both',
    settlement,
    standardLaneAdmission: { admitted: true },
    standardInlet: { registered: 0, alreadyRegistered: 0 },
  } as unknown as SettlementRunResult);

  it('a COMPLETED run that held a poisoned claim ALARMS (unpaid work waits on a retry)', () => {
    expect(settlementRunNeedsAlarm(run({
      outcome: 'completed', stopReason: 'backlog_exhausted', claimsHeld: 1, reconciliation: null,
    }))).toBe(true);
  });

  it('a COMPLETED run whose reconciler unwound a reorged settle ALARMS', () => {
    expect(settlementRunNeedsAlarm(run({
      outcome: 'completed', stopReason: 'backlog_exhausted', claimsHeld: 0,
      reconciliation: { appliedReorged: 1 },
    }))).toBe(true);
  });

  it('RED CONTROL: a completed run with nothing held and no reorg stays quiet', () => {
    expect(settlementRunNeedsAlarm(run({
      outcome: 'completed', stopReason: 'backlog_exhausted', claimsHeld: 0,
      reconciliation: { appliedReorged: 0 },
    }))).toBe(false);
  });

  it('a run stopped on a stranded batch (stranded_batch_pending) ALARMS', () => {
    expect(settlementRunNeedsAlarm(run({
      outcome: 'stopped', stopReason: 'stranded_batch_pending', claimsHeld: 0, reconciliation: null,
    }))).toBe(true);
  });
});

describe('settlementRunNeedsAlarm — review: chain-evidence and the PRE-CYCLE reconciliation', () => {
  const run = (settlement: Record<string, unknown>, pre: Record<string, unknown> | null): SettlementRunResult => ({
    lane: 'both',
    settlement,
    standardLaneAdmission: { admitted: true },
    standardInlet: { registered: 0, alreadyRegistered: 0 },
    preCycleReconciliation: pre,
  } as unknown as SettlementRunResult);
  const quiet = { outcome: 'completed', stopReason: 'backlog_exhausted', claimsHeld: 0, reconciliation: { appliedReorged: 0, heldSettledOnChain: 0 } };

  it('a held claim the kernel had PAID (recorded from chain evidence) ALARMS — the ledger missed a payment', () => {
    expect(settlementRunNeedsAlarm(run({ ...quiet, reconciliation: { appliedReorged: 0, heldSettledOnChain: 1 } }, null))).toBe(true);
  });

  it('a reorg or chain-evidence settlement found by the PRE-CYCLE reconciliation ALARMS (it resolves most of a run)', () => {
    expect(settlementRunNeedsAlarm(run(quiet, { appliedReorged: 1, heldSettledOnChain: 0 }))).toBe(true);
    expect(settlementRunNeedsAlarm(run(quiet, { appliedReorged: 0, heldSettledOnChain: 2 }))).toBe(true);
  });

  it('RED CONTROL: both reconciliations quiet — no alarm', () => {
    expect(settlementRunNeedsAlarm(run(quiet, { appliedReorged: 0, heldSettledOnChain: 0 }))).toBe(false);
  });
});

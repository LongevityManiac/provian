/**
 * — how one scoped settlement run maps onto a payout request. A run that settled
 * claims is `settled`; a run that completed with nothing for this payee is `nothing`; anything else
 * (a stop, no run) WAITS for the sweep — never `settled`, so a stopped run cannot close a request.
 */
import { describe, it, expect } from '@jest/globals';
import { payoutOutcomeOf } from './payout-runtime';

type Run = Parameters<typeof payoutOutcomeOf>[0];
function run(settlement: Record<string, unknown> | null, meterInlet?: Record<string, unknown>): Run {
  return { settlement, ...(meterInlet ? { meterInlet } : {}) } as unknown as Run;
}
const base = { cycleId: 'epoch1-2026-10-04-payout-po_x', batchesConfirmed: 1, feeWeiSpent: 7n };

describe('payoutOutcomeOf', () => {
  it('settled when claims settled (even if the run then stopped)', () => {
    expect(payoutOutcomeOf(run({ ...base, outcome: 'stopped', stopReason: 'run_time_limit', claimsSettled: 2 })))
      .toEqual({ kind: 'settled', cycleId: base.cycleId, claimsSettled: 2, batchesConfirmed: 1, feeWeiSpent: '7' });
  });
  it('nothing when the run completed with nothing to settle', () => {
    expect(payoutOutcomeOf(run({ ...base, outcome: 'completed', stopReason: 'backlog_exhausted', claimsSettled: 0 })))
      .toEqual({ kind: 'nothing', cycleId: base.cycleId });
  });
  it('RED: a run that settled nothing while a demotion held some of the payee\'s work waits ', () => {
    expect(payoutOutcomeOf(run({ ...base, outcome: 'completed', stopReason: 'backlog_exhausted', claimsSettled: 0 }, { held: 2 })))
      .toEqual({ kind: 'wait', reason: 'demotion_hold' });
    expect(payoutOutcomeOf(run({ ...base, outcome: 'completed', stopReason: 'backlog_exhausted', claimsSettled: 0 }, { held: 0 })))
      .toEqual({ kind: 'nothing', cycleId: base.cycleId });
  });
  it('RED: a stopped run with nothing settled waits (never closes the request)', () => {
    expect(payoutOutcomeOf(run({ ...base, outcome: 'stopped', stopReason: 'epoch_cap_deferral', claimsSettled: 0 })))
      .toEqual({ kind: 'wait', reason: 'epoch_cap_deferral' });
    expect(payoutOutcomeOf(run({ ...base, outcome: 'refused', stopReason: 'lease_refused', claimsSettled: 0 })))
      .toEqual({ kind: 'wait', reason: 'lease_refused' });
    expect(payoutOutcomeOf(run(null))).toEqual({ kind: 'wait', reason: 'settlement_not_run' });
  });
});

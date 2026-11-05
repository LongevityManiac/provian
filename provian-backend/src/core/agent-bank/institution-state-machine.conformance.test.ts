/**
 * beneficiary routing — conformance: the ONE state machine's state sets are bound to the live
 * institution status enums in `types.ts`, so the machine can never silently
 * drift from the institutions it governs.
 *
 * Two independent guards per institution:
 * 1. compile-time exhaustive coverage — a `Record<Status, true>` literal is
 * byte-exhaustive over the union (ts-jest type-checks this file with
 * diagnostics on): if `types.ts` ADDS or REMOVES a status, the literal has
 * a missing/extra key and fails to compile;
 * 2. run-time equality — the coverage keys equal the machine's `*_STATES`
 * tuple, so a machine-side drift (a renamed/added/dropped state) fails the
 * assertion.
 * Together they pin machine ⇔ enum in both directions.
 */

import type {
  EscrowStatus,
  PromiseStatus,
  PoolStatus,
  BondStatus,
  BondClaimStatus,
  JobStatus,
  CourtDisputeStatus,
  GeneralDisputeStatus,
} from './types';
import type { HumanJobStatus } from '../commons/types';
import {
  ESCROW_STATES,
  PROMISE_STATES,
  POOL_STATES,
  BOND_STATES,
  BOND_CLAIM_STATES,
  JOB_STATES,
  HUMAN_JOB_STATES,
  COURT_DISPUTE_STATES,
  GENERAL_DISPUTE_STATES,
} from './institution-state-machine';

// -- Compile-time exhaustive coverage: a missing key (enum grew) OR an extra key
//    (enum shrank) fails to compile. The runtime keys are then compared to the
//    machine's own tuple.
const ESCROW_COVERAGE: Record<EscrowStatus, true> = {
  created: true,
  funded: true,
  completed: true,
  disputed: true,
  resolved: true,
  cancelled: true,
};
const PROMISE_COVERAGE: Record<PromiseStatus, true> = {
  open: true,
  funded: true,
  settled: true,
  defaulted: true,
  cancelled: true,
};
const POOL_COVERAGE: Record<PoolStatus, true> = {
  open: true,
  funded: true,
  executed: true,
  refunded: true,
  cancelled: true,
};
const BOND_COVERAGE: Record<BondStatus, true> = {
  active: true,
  expired: true,
  withdrawn: true,
  abandoned: true,
};
const BOND_CLAIM_COVERAGE: Record<BondClaimStatus, true> = {
  filed: true,
  upheld: true,
  dismissed: true,
  expired: true,
};
const JOB_COVERAGE: Record<JobStatus, true> = {
  open: true,
  assigned: true,
  delivered: true,
  completed: true,
  cancelled: true,
  refunded: true,
};
// linked-job settlement: the human-job board is governed by the same machine; its state set binds
// to the live Commons HumanJobStatus union exactly like the agent board's.
const HUMAN_JOB_COVERAGE: Record<HumanJobStatus, true> = {
  open: true,
  in_progress: true,
  completed: true,
  disputed: true,
  cancelled: true,
  refunded: true,
};

// agent directory: the Court process records are governed by the same machine; their state
// sets bind to the live CourtDisputeStatus / GeneralDisputeStatus unions.
const COURT_DISPUTE_COVERAGE: Record<CourtDisputeStatus, true> = {
  pending: true,
  resolved: true,
  escalated: true,
};
const GENERAL_DISPUTE_COVERAGE: Record<GeneralDisputeStatus, true> = {
  filed: true,
  panel_assigned: true,
  evidence_period: true,
  voting: true,
  resolved: true,
  escalated: true,
};

describe('institution-state-machine conformance — machine states ⇔ live enums', () => {
  it.each([
    ['escrow', ESCROW_STATES, ESCROW_COVERAGE],
    ['promise', PROMISE_STATES, PROMISE_COVERAGE],
    ['pool', POOL_STATES, POOL_COVERAGE],
    ['bond', BOND_STATES, BOND_COVERAGE],
    ['bond_claim', BOND_CLAIM_STATES, BOND_CLAIM_COVERAGE],
    ['job', JOB_STATES, JOB_COVERAGE],
    ['human_job', HUMAN_JOB_STATES, HUMAN_JOB_COVERAGE],
    ['court_dispute', COURT_DISPUTE_STATES, COURT_DISPUTE_COVERAGE],
    ['general_dispute', GENERAL_DISPUTE_STATES, GENERAL_DISPUTE_COVERAGE],
  ] as const)('%s machine states equal the %s status enum exactly', (_kind, states, coverage) => {
    expect([...states].sort()).toEqual(Object.keys(coverage).sort());
  });

  it('every machine state set is non-empty and free of duplicates', () => {
    for (const states of [
      ESCROW_STATES,
      PROMISE_STATES,
      POOL_STATES,
      BOND_STATES,
      BOND_CLAIM_STATES,
      JOB_STATES,
      HUMAN_JOB_STATES,
      COURT_DISPUTE_STATES,
      GENERAL_DISPUTE_STATES,
    ]) {
      expect(states.length).toBeGreaterThan(0);
      expect(new Set(states).size).toBe(states.length);
    }
  });
});

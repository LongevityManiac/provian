import type { AutomaticMembershipSweepOptions, AutomaticMembershipSweepResult } from './automatic-membership';

/** One scheduler minute: send what is queued, collect memberships while the lane
 * keeps up, then send the debits that collection queued. Debit authorizations
 * are valid for five minutes, so the sweep yields to the lane's backlog. */
export const RECOURSE_MINUTE = { laneMs: 10_000, sweepUntilMs: 30_000, drainUntilMs: 52_000, maxDebitBacklog: 40 } as const;
export interface RecourseMinuteDeps<R> {
  now(): number;
  lane(budgetMs: number): Promise<R>;
  sweep(options: AutomaticMembershipSweepOptions): Promise<AutomaticMembershipSweepResult>;
  debitBacklog(): Promise<number>;
}
export async function runRecourseMinute<R>(deps: RecourseMinuteDeps<R>): Promise<{ lane: R; automatic_membership: AutomaticMembershipSweepResult | { error: string }; drain: R }> {
  const started = deps.now();
  const lane = await deps.lane(RECOURSE_MINUTE.laneMs);
  // A sweep failure is reported and retried next minute; it never holds up the lane.
  let automaticMembership: AutomaticMembershipSweepResult | { error: string };
  try {
    automaticMembership = await deps.sweep({ deadlineMs: started + RECOURSE_MINUTE.sweepUntilMs,
      backlog: deps.debitBacklog, maxBacklog: RECOURSE_MINUTE.maxDebitBacklog, now: deps.now });
  } catch (error) { automaticMembership = { error: error instanceof Error ? error.message : 'error' }; }
  const drain = await deps.lane(Math.max(0, started + RECOURSE_MINUTE.drainUntilMs - deps.now()));
  return { lane, automatic_membership: automaticMembership, drain };
}

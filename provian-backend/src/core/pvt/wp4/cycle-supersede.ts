/**
 * settlement runtime — un-wedging the refused UTC day.
 *
 * `runSettlement` derives its cycle id as `epoch{N}-{YYYY-MM-DD}`, so every run on one UTC
 * day shares ONE cycle id. Every stop except `broadcast_failed` closes the cycle, and
 * `acquireCycleLease` refuses a non-`active` cycle forever with `cycle_closed` so a single
 * `batch_approval_refused` / `batch_unsettleable` / `fee_limit` / `transaction_limit` stop
 * used to block EVERY later settlement run until UTC midnight. One ineligible PE in one
 * batch was enough. (Found by M7's fork harness; carried in OPEN_ITEMS until this module.)
 *
 * THE FIX, AND WHY IT IS SHAPED THIS WAY: on `cycle_closed`, supersede with a suffixed cycle
 * id (`-r2`, `-r3`, …) ONLY when the closed cycle has NO unresolved batch at all. This is
 * deliberately STRICTER than "no batch in a submitted state" *
 * - `submitted` a recorded attempt whose transaction may have been accepted by the node.
 * Abandoning it is exactly the deadlock exists to prevent: if that transaction
 * mines, the kernel carries settled claims the durable ledger records as unsettled, and
 * every later cycle dies on `ClaimAlreadySettled`. Never supersede past one.
 * - `reserved` a crash orphan between reservation and first record. Nothing signed was
 * durably recorded, but its allocated nonce and crash-recovery adjudication belong to
 * the cycle that owns it. The runner's own resume path is the only code that may repair
 * it; superseding around it would strand that adjudication. Refuse these too.
 *
 * - `mined` a success receipt seen but not yet at the safe-head depth; it is
 * unresolved until final, exactly like `submitted`.
 *
 * CORRECTED. This comment used to claim every cycle-closing stop happens before
 * reserve/sign, so a closed cycle always had an empty unresolved set. That was false:
 * `replacement_budget_exhausted`, `transaction_limit` on a replacement, an approval refusal on
 * a replacement, a post-revert `epoch_gate_closed` / `resumption_abort`, and `run_time_limit`
 * all stop AFTER a transaction was broadcast, and all closed the cycle around a live
 * `submitted` batch — which nothing then ever looked at again (the July residual). The
 * cross-cycle reconciler (`reconcileStrandedSettlements` in `settlement-cycle-runner.ts`) now
 * runs BEFORE this resolution on every run and adopts every unresolved batch in any cycle, so a
 * closed cycle reaching this check with an unresolved batch means the reconciler could not
 * resolve it THIS run (its nonce is still live): refusing is correct, and the next run adopts
 * it again at the same nonce — it is no longer an operator's manual job.
 *
 * READ-ONLY by construction: this module writes nothing. The superseded cycle keeps its
 * history; its unsettled claims stay `settled:false` in the ledger and are re-selected by
 * the fresh cycle exactly as backlog is on any other day.
 */

import {
  SETTLEMENT_CYCLES_COLLECTION,
  listUnresolvedBatches,
  type SettlementDb,
} from './durable-settlement-store';

/**
 * Runaway backstop, far above any real day: a UTC day that refuses twenty times over has a
 * systemic problem a new cycle id will not fix, and an unbounded loop over Firestore reads
 * is its own defect.
 */
export const MAX_CYCLE_SUPERSESSIONS = 20;

export type EffectiveCycleResolution =
  | {
    readonly kind: 'ok';
    readonly cycleId: string;
    /** Closed-and-empty cycle ids skipped to reach `cycleId`. Empty on a normal day. */
    readonly supersededCycleIds: readonly string[];
  }
  | {
    readonly kind: 'refused';
    readonly reason: 'closed_cycle_has_unresolved_batches' | 'supersede_limit';
    readonly cycleId: string;
    /** Statuses of the unresolved batches that blocked supersession. */
    readonly unresolvedStatuses: readonly string[];
  };

function suffixedCycleId(baseCycleId: string, ordinal: number): string {
  return ordinal === 1 ? baseCycleId : `${baseCycleId}-r${ordinal}`;
}

/**
 * Resolve the cycle id a settlement run may actually use.
 *
 * Walks `base`, `base-r2`, `base-r3`, … and returns the first id that is fresh (no doc) or
 * still `active` (normal resume; the lease machinery owns contention from there). A closed
 * cycle is stepped over ONLY when `listUnresolvedBatches` returns nothing for it; a closed
 * cycle holding a `submitted` or `reserved` batch refuses resolution entirely — that state
 * needs an operator, not a fresh id.
 */
export async function resolveEffectiveCycleId(
  db: SettlementDb,
  baseCycleId: string,
  log: (line: string) => void = () => {},
): Promise<EffectiveCycleResolution> {
  const superseded: string[] = [];

  for (let ordinal = 1; ordinal <= MAX_CYCLE_SUPERSESSIONS; ordinal += 1) {
    const cycleId = suffixedCycleId(baseCycleId, ordinal);
    const snap = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(cycleId).get();
    const data = snap.exists ? snap.data() : undefined;

    if (data === undefined) {
      return { kind: 'ok', cycleId, supersededCycleIds: superseded };
    }
    if ((data as { status?: unknown }).status === 'active') {
      // An active cycle is resumable; whether THIS worker may run it is the lease's call.
      return { kind: 'ok', cycleId, supersededCycleIds: superseded };
    }

    // Closed (completed / stopped / malformed — all fail toward the batch check).
    const unresolved = await listUnresolvedBatches(db, cycleId);
    if (unresolved.length > 0) {
      const statuses = unresolved.map((batch) => batch.status);
      log(`CYCLE SUPERSEDE refused: ${cycleId} is closed holding ${unresolved.length} `
        + `unresolved batch(es) [${statuses.join(', ')}] — an operator must reconcile them.`);
      return {
        kind: 'refused',
        reason: 'closed_cycle_has_unresolved_batches',
        cycleId,
        unresolvedStatuses: statuses,
      };
    }
    superseded.push(cycleId);
  }

  return {
    kind: 'refused',
    reason: 'supersede_limit',
    cycleId: suffixedCycleId(baseCycleId, MAX_CYCLE_SUPERSESSIONS),
    unresolvedStatuses: [],
  };
}

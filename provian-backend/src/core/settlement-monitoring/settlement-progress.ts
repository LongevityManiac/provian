/**
 * Operator-side progress for a relay settlement run (`scripts/pvt9-settlement-trigger.ts`).
 *
 * `POST /v1/internal/settlement/pvt9-run` answers only when the whole run is over, which is
 * several minutes for a real standard-lane backlog (2026-09-30: 04:23:09Z → 04:29:05Z). A client
 * that waits silently looks hung, and one whose wait is shorter than the run reports a timeout on
 * a run that completes. So the trigger follows the run's own durable records while the request is
 * open, and judges the outcome from those records when the HTTP answer is lost.
 *
 * Nothing here decides or moves value. The relay keeps every gate; this module only reads the
 * cycle, batch and claim-ledger records the settlement runner already writes, and turns them into
 * lines a person can follow. It lives outside `core/pvt/` because it is not settlement logic.
 */

export interface CycleView {
  readonly cycle_id: string;
  readonly status: string; // 'active' | 'completed' | 'stopped'
  readonly stop_reason: string | null;
  readonly batches_confirmed: number;
  readonly claims_settled: number;
  readonly lease_expires_at_ms: number | null;
}

export interface BatchView {
  readonly batch_id: string;
  readonly cycle_id: string;
  readonly lane: string;
  readonly status: string; // 'reserved' | 'submitted' | 'mined' | 'confirmed' | 'dead'
  readonly claim_count: number;
  readonly total_minted_atomic: string;
  readonly attempt_tx_hashes: readonly string[];
  readonly confirmed_tx_hash: string | null;
  readonly confirmed_block_number: number | null;
  readonly dead_reason: string | null;
}

export interface ProgressSnapshot {
  /** Claim-ledger rows created since the run started (registration by the inlets). */
  readonly claimsRegistered: number;
  readonly cycles: readonly CycleView[];
  readonly batches: readonly BatchView[];
}

export interface NarratorState {
  readonly claimsRegistered: number;
  readonly cycleStatus: Readonly<Record<string, string>>;
  readonly batchStatus: Readonly<Record<string, string>>;
  readonly batchTxs: Readonly<Record<string, readonly string[]>>;
}

export function initialNarratorState(): NarratorState {
  return { claimsRegistered: 0, cycleStatus: {}, batchStatus: {}, batchTxs: {} };
}

/** Atomic (1e18) PVT → a short decimal string, e.g. "25.4686". */
export function formatPvt(atomic: string): string {
  let value: bigint;
  try {
    value = BigInt(atomic);
  } catch {
    return '?';
  }
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

function short(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 10)}…` : hash;
}

/**
 * Lines for everything that changed since `state`. The same snapshot twice yields nothing, so the
 * trigger can poll freely without repeating itself.
 */
export function narrateProgress(
  state: NarratorState,
  snap: ProgressSnapshot,
): { lines: string[]; state: NarratorState } {
  const lines: string[] = [];

  let claimsRegistered = state.claimsRegistered;
  if (snap.claimsRegistered > claimsRegistered) {
    lines.push(`claims registered: ${snap.claimsRegistered}`);
    claimsRegistered = snap.claimsRegistered;
  }

  const cycleStatus: Record<string, string> = { ...state.cycleStatus };
  const batchStatus: Record<string, string> = { ...state.batchStatus };
  const batchTxs: Record<string, readonly string[]> = { ...state.batchTxs };

  const narrateCycle = (cycle: CycleView, terminalOnly: boolean): void => {
    const prior = cycleStatus[cycle.cycle_id];
    if (prior === cycle.status) return;
    const terminal = cycle.status !== 'active';
    if (terminalOnly !== terminal) return;
    if (terminal) {
      const why = cycle.stop_reason ? ` (${cycle.stop_reason})` : '';
      lines.push(
        `settlement cycle ${cycle.cycle_id} ${cycle.status}${why}: `
        + `${cycle.batches_confirmed} batch(es) confirmed, ${cycle.claims_settled} claims settled`,
      );
    } else {
      lines.push(`settlement cycle ${cycle.cycle_id} running`);
    }
    cycleStatus[cycle.cycle_id] = cycle.status;
  };

  // A cycle's start is told before its batches; its end after them.
  for (const cycle of snap.cycles) narrateCycle(cycle, false);

  const batches = [...snap.batches].sort((a, b) => a.batch_id.localeCompare(b.batch_id));
  for (const batch of batches) {
    const id = batch.batch_id;
    const label = `batch ${short(id)}`;
    if (batchStatus[id] === undefined) {
      lines.push(
        `${label}: ${batch.claim_count} claims, ${formatPvt(batch.total_minted_atomic)} PVT (${batch.lane} lane)`,
      );
    }
    const seen = batchTxs[id] ?? [];
    const fresh = batch.attempt_tx_hashes.filter((tx) => !seen.includes(tx));
    for (const tx of fresh) {
      const replacement = seen.length > 0 || batch.attempt_tx_hashes.indexOf(tx) > 0;
      lines.push(`${label}: ${replacement ? 'replacement tx' : 'tx'} sent ${tx}`);
    }
    if (fresh.length > 0) batchTxs[id] = [...seen, ...fresh];
    if (batchStatus[id] !== batch.status) {
      if (batch.status === 'mined') lines.push(`${label}: mined, waiting for finality`);
      if (batch.status === 'confirmed') {
        const block = batch.confirmed_block_number === null ? '' : ` in block ${batch.confirmed_block_number}`;
        lines.push(`${label}: confirmed${block} (tx ${batch.confirmed_tx_hash ?? '?'})`);
      }
      if (batch.status === 'dead') lines.push(`${label}: dead (${batch.dead_reason ?? 'no reason recorded'})`);
      batchStatus[id] = batch.status;
    }
  }

  for (const cycle of snap.cycles) narrateCycle(cycle, true);

  return { lines, state: { claimsRegistered, cycleStatus, batchStatus, batchTxs } };
}

/** Margin past the longest the relay can hold the request open. */
export const SETTLEMENT_WAIT_MARGIN_MS = 2 * 60 * 1000;

/**
 * How long the trigger waits for the relay's answer. It must outlast a normal run: never less than
 * the settlement cycle's own run budget, and never less than the request timeout of the service
 * (the relay cannot answer later than that), plus a margin. A null timeout (not readable) falls
 * back to the cycle budget alone.
 */
export function settlementWaitBudgetMs(requestTimeoutMs: number | null, cycleMaxRunMs: number): number {
  const serviceMs = requestTimeoutMs !== null && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
    ? requestTimeoutMs
    : 0;
  return Math.max(serviceMs, cycleMaxRunMs) + SETTLEMENT_WAIT_MARGIN_MS;
}

/** How long, after the HTTP answer is lost, to keep looking for a cycle that never appeared. */
export const NO_CYCLE_GRACE_MS = 2 * 60 * 1000;

export type HttpOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'answered'; readonly status: number; readonly atMs: number }
  | { readonly kind: 'lost'; readonly reason: string; readonly atMs: number };

export interface FollowJudgement {
  readonly done: boolean;
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Whether the trigger can stop following, and whether the run succeeded. A 5xx or a dropped
 * connection is NOT a failed run: the relay keeps settling after the answer is lost, so the
 * durable cycle record decides.
 */
export function judgeFollow(params: {
  readonly http: HttpOutcome;
  readonly cycles: readonly CycleView[];
  readonly nowMs: number;
  readonly deadlineMs: number;
}): FollowJudgement {
  const { http, cycles, nowMs, deadlineMs } = params;
  const active = cycles.filter((c) => c.status === 'active');
  const allTerminal = cycles.length > 0 && active.length === 0;
  const allCompleted = allTerminal && cycles.every((c) => c.status === 'completed');

  if (http.kind === 'answered' && http.status >= 200 && http.status < 300) {
    return { done: true, ok: true, reason: 'relay_answered' };
  }
  if (http.kind === 'answered' && http.status >= 400 && http.status < 500) {
    return { done: true, ok: false, reason: `relay_refused_${http.status}` };
  }
  if (nowMs >= deadlineMs) {
    return { done: true, ok: false, reason: 'wait_budget_exhausted' };
  }
  if (http.kind === 'pending') {
    return { done: false, ok: false, reason: 'waiting_for_relay' };
  }

  // The answer was lost (5xx or transport). Follow the records.
  if (allTerminal) {
    return allCompleted
      ? { done: true, ok: true, reason: 'cycle_completed_after_lost_answer' }
      : { done: true, ok: false, reason: 'cycle_stopped' };
  }
  if (active.length > 0) {
    const leaseLive = active.some(
      (c) => c.lease_expires_at_ms === null || c.lease_expires_at_ms + NO_CYCLE_GRACE_MS > nowMs,
    );
    return leaseLive
      ? { done: false, ok: false, reason: 'cycle_still_running' }
      : { done: true, ok: false, reason: 'cycle_lease_expired' };
  }
  return nowMs - http.atMs >= NO_CYCLE_GRACE_MS
    ? { done: true, ok: false, reason: 'no_cycle_observed' }
    : { done: false, ok: false, reason: 'looking_for_cycle' };
}

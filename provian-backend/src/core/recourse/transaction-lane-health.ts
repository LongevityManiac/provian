import type { Firestore } from 'firebase-admin/firestore';
import { RECOURSE_LANE_COLLECTION, type LaneReport } from './transaction-lane';

/**
 * The lane's own health record, read by the operator's alerting.
 *
 * Every lane run that had the lane to itself updates it. A run that sent or settled a
 * transaction clears any stall. A run that had work and sent nothing starts a stall, or
 * extends one. A request that runs out unsent counts against the lane only when a stall from
 * an earlier run was already under way: a binding admitted with seconds left, or a request
 * superseded elsewhere, closes on a healthy lane too. An idle run ends a stall only when no
 * request ran out unsent during it: a queue that emptied because its signatures expired while
 * the lane could not send is a stopped lane, not a caught-up one.
 * The record is stale when the scheduled run itself stops.
 */
export const LANE_HEALTH_DOC = 'health';
export interface LaneHealth {
  readonly checked_at_ms: number;
  readonly last_progress_at_ms: number | null;
  /** The first run since the last send that had work and sent nothing; null while sending. */
  readonly stalled_since_ms: number | null;
  /** Requests that ran out unsent since the stall began. */
  readonly lapsed_while_stalled: number;
  readonly stop_reason: string | null;
}

function readHealth(data: Record<string, unknown> | undefined): Omit<LaneHealth, 'checked_at_ms'> {
  const n = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  return { last_progress_at_ms: n(data?.last_progress_at_ms), stalled_since_ms: n(data?.stalled_since_ms),
    lapsed_while_stalled: n(data?.lapsed_while_stalled) ?? 0,
    stop_reason: typeof data?.stop_reason === 'string' ? data.stop_reason : null };
}

/** The next record, or null when no run had the lane (another worker held it). */
export function nextLaneHealth(previous: Record<string, unknown> | undefined, reports: readonly LaneReport[], now: number): LaneHealth | null {
  const ran = reports.filter(report => report.skipped !== 'lane_busy');
  if (ran.length === 0) return null;
  const prior = readHealth(previous);
  const busy = ran.filter(report => report.skipped === undefined);
  // Unsigned closures also count as confirmed or failed; only transactions the lane sent are progress.
  const sent = busy.reduce((total, r) => total + r.signed + r.confirmed + r.failed - r.closedUnsigned, 0);
  const lapsed = busy.reduce((total, r) => total + r.lapsed, 0);
  const stopReason = [...busy].reverse().find(r => r.stopReason !== null)?.stopReason ?? null;
  if (sent > 0) return { checked_at_ms: now, last_progress_at_ms: now, stalled_since_ms: null, lapsed_while_stalled: 0, stop_reason: stopReason };
  if (busy.length > 0) {
    return { checked_at_ms: now, last_progress_at_ms: prior.last_progress_at_ms, stalled_since_ms: prior.stalled_since_ms ?? now,
      lapsed_while_stalled: prior.lapsed_while_stalled + (prior.stalled_since_ms !== null ? lapsed : 0), stop_reason: stopReason ?? prior.stop_reason };
  }
  if (prior.stalled_since_ms !== null && prior.lapsed_while_stalled > 0) return { ...prior, checked_at_ms: now };
  return { checked_at_ms: now, last_progress_at_ms: prior.last_progress_at_ms, stalled_since_ms: null, lapsed_while_stalled: 0, stop_reason: null };
}

/** Best-effort: a failed write never stops the lane; the record then goes stale and alerts. */
export async function recordLaneHealth(db: Firestore, reports: readonly LaneReport[], now: () => number = Date.now): Promise<void> {
  try {
    const ref = db.collection(RECOURSE_LANE_COLLECTION).doc(LANE_HEALTH_DOC);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const next = nextLaneHealth(snap.exists ? snap.data() : undefined, reports, now());
      if (next) tx.set(ref, next);
    });
  } catch (error) {
    console.warn('[recourse-lane] health record deferred:', error instanceof Error ? error.message : 'error');
  }
}

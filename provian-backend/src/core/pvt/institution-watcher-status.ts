import type { Firestore } from 'firebase-admin/firestore';

export const INSTITUTION_WATCHER_STATUS_COLLECTION = 'pvt_institution_watcher_status_v1';
export type InstitutionWatcherKind = 'funding' | 'completion';
export type WatcherHoldReason = 'head_unavailable' | 'safe_head_unavailable' | 'provider_disagreement' | 'scan_incomplete' | 'activity_mapping_disabled' | 'cycle_failed';
export interface WatcherCycleState {
  status: 'held' | 'completed' | 'caught_up';
  hold_reason: WatcherHoldReason | null;
}
export function watcherReadHold(error: unknown, fallback: WatcherHoldReason): WatcherHoldReason {
  return error instanceof Error && error.message === 'economic_discovery_rpc_disagreement:safe_head'
    ? 'provider_disagreement' : fallback;
}

/** Persist semantic outcomes before replying. Held/failed scans must be visible
 * independently of transport success and can retry through existing mint-once locks. */
export async function runInstitutionWatcherScheduler<T extends WatcherCycleState>(
  db: Firestore,
  kind: InstitutionWatcherKind,
  enabled: () => Promise<boolean>,
  run: () => Promise<T>,
  now: () => number = Date.now,
): Promise<{ httpStatus: number; report: T | WatcherCycleState }> {
  const ref = db.collection(INSTITUTION_WATCHER_STATUS_COLLECTION).doc(kind);
  let report: T | WatcherCycleState;
  try {
    report = await enabled() ? await run() : { status: 'held', hold_reason: 'activity_mapping_disabled' };
  } catch (error) {
    await ref.set({ status: 'held', hold_reason: watcherReadHold(error, 'cycle_failed'), updated_at_ms: now() });
    throw error;
  }
  await ref.set({ ...report, updated_at_ms: now() });
  return { httpStatus: report.status === 'held' ? 503 : 200, report };
}

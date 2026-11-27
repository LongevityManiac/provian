import type { Firestore } from 'firebase-admin/firestore';
import { RECOURSE_RATIO_COLLECTION } from './pool-ratio';

/** The pool figures the app shows (reserve, ratio, current rule) are display
 * checkpoints. Binding, membership and restoration paths read the chain
 * themselves, so these checkpoints refresh once per 15-minute discovery run.
 * A checkpoint is due at 10 minutes old, below the job's cadence, so scheduling
 * jitter never makes a run skip it; an extra run inside the window does not
 * refresh again. The display also refreshes on every run while its month is not
 * the current UTC calendar month, so a new month's rule shows on the first run
 * whose finalized block has crossed into it. */
export const RECOURSE_DISPLAY_REFRESH_MS = 10 * 60_000;

/** The pool contract's calendar month: year * 12 + zero-based UTC month. */
export function utcCalendarMonth(ms: number): string {
  const date = new Date(ms);
  return String(date.getUTCFullYear() * 12 + date.getUTCMonth());
}

/** A missing, malformed or future-dated checkpoint is due. */
export function checkpointDue(row: unknown, nowMs: number, options: { readonly month?: boolean } = {}): boolean {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
  const { observedAtMs, month } = row as Record<string, unknown>;
  if (typeof observedAtMs !== 'number' || !Number.isSafeInteger(observedAtMs) || observedAtMs < 0 || observedAtMs > nowMs) return true;
  if (nowMs - observedAtMs >= RECOURSE_DISPLAY_REFRESH_MS) return true;
  return options.month === true && month !== utcCalendarMonth(nowMs);
}

export interface RecourseDisplayRefreshers {
  readonly ratio: () => Promise<void>;
  readonly display: () => Promise<void>;
  readonly monthlyApprovals: () => Promise<void>;
}
export interface RecourseDisplayRefreshReport { readonly ratio: 'refreshed' | 'fresh'; readonly display: 'refreshed' | 'fresh' }

/** Reads only stored checkpoints to decide, so a run that skips both makes no
 * chain calls for them. A failed read refreshes both. The monthly-approval queue
 * runs every time: it does chain work only for members waiting on a display. */
export async function refreshRecourseDisplays(db: Firestore, nowMs: number,
  refresh: RecourseDisplayRefreshers): Promise<RecourseDisplayRefreshReport> {
  let due = { ratio: true, display: true };
  try {
    const collection = db.collection(RECOURSE_RATIO_COLLECTION);
    const display = (await collection.doc('display').get()).data();
    const pool: unknown = display?.pool;
    const ratio = typeof pool === 'string' && /^0x[0-9a-f]{40}$/.test(pool) ? (await collection.doc(pool).get()).data() : undefined;
    due = { ratio: checkpointDue(ratio, nowMs), display: checkpointDue(display, nowMs, { month: true }) };
  } catch {
    // Unknown freshness refreshes.
  }
  const [ratio] = await Promise.allSettled([
    due.ratio ? refresh.ratio() : Promise.resolve(),
    due.display ? refresh.display().catch(() => console.warn('[Recourse] Pool display refresh unavailable')) : Promise.resolve(),
    refresh.monthlyApprovals().catch(() => console.warn('[Recourse] Monthly display queue unavailable')),
  ]);
  if (ratio.status === 'rejected') throw ratio.reason;
  return { ratio: due.ratio ? 'refreshed' : 'fresh', display: due.display ? 'refreshed' : 'fresh' };
}

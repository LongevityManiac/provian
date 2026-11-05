/**
 * COMMONS presentation surfacing (burn-to-present, Part D).
 *
 * the standing rule (decided): EXACTLY TWO aggregates surface on Commons, and
 * nothing else.
 * 1. Profile: presentations PRODUCED — lifetime and recent — labeled as the
 * wallet's own ACTIVITY, never as third-party validation of it.
 * 2. Ecosystem: network-wide presentation VOLUME (a single total).
 *
 * NOTHING ELSE surfaces — not contents, not timing, not requester identity, not
 * the interaction graph, not handshake records. These are pure COUNTS over
 * `commons_presentations` (the doc a produced presentation already writes); no
 * field of any individual presentation is read out. The handshake STATE read
 * (live/lapsed/invalidated) is a separate private counterparty surface and is
 * deliberately NOT here — it never touches Commons.
 *
 * Cheap: Firestore `.count()` aggregations, not document scans. Fail-safe: any
 * read error returns zeros (a surfacing aggregate must never throw a profile or
 * ecosystem read).
 */

import type { Firestore } from 'firebase-admin/firestore';
import { COMMONS_PRESENTATIONS_COLLECTION } from '../presentation/service';

/** The "recent" window for the profile activity aggregate. */
export const PRESENTATION_ACTIVITY_RECENT_WINDOW_DAYS = 30;
export const PRESENTATION_ACTIVITY_RECENT_WINDOW_MS =
  PRESENTATION_ACTIVITY_RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** A wallet's own presentation activity (produced count). Activity, not validation. */
export interface PresentationActivity {
  /** Presentations this wallet has produced, all time. */
  readonly lifetime: number;
  /** Produced within the recent window. */
  readonly recent: number;
  readonly recent_window_days: number;
}

function readCount(snap: unknown): number {
  const c = (snap as { data?: () => { count?: unknown } } | undefined)?.data?.().count;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : 0;
}

/**
 * STRICT (item 2): the number of presentations a wallet has PRODUCED since `sinceMs`
 * (`null` = all time). One `.count()` keyed on `wallet_id` (+ `recorded_at >= sinceMs`). THROWS on a
 * read failure or a malformed aggregate — the reputation vocabulary must never read a failure as an
 * observed zero. An empty wallet id is refused (there is no such presenter to count).
 */
export async function countPresentationsProducedSince(
  db: Pick<Firestore, 'collection'>,
  walletId: string,
  sinceMs: number | null,
): Promise<number> {
  if (!walletId) throw new Error('presentation_activity_missing_wallet_id');
  const col = db.collection(COMMONS_PRESENTATIONS_COLLECTION);
  const q = sinceMs === null
    ? col.where('wallet_id', '==', walletId)
    : col.where('wallet_id', '==', walletId).where('recorded_at', '>=', sinceMs);
  const snap = await (q as unknown as { count(): { get(): Promise<unknown> } }).count().get();
  const c = (snap as { data?: () => { count?: unknown } } | undefined)?.data?.().count;
  if (typeof c !== 'number' || !Number.isSafeInteger(c) || c < 0) throw new Error('presentation_activity_malformed_count');
  return c;
}

/**
 * Presentations a wallet has PRODUCED — lifetime and within the recent window.
 * Two `.count()` aggregations keyed on `wallet_id` (the recent one also on
 * `recorded_at`). Fail-safe to zeros so a profile read never throws on this.
 * (The reputation vocabulary uses the strict {@link countPresentationsProducedSince}.)
 */
export async function getPresentationActivity(
  db: Pick<Firestore, 'collection'>,
  walletId: string,
  nowMs: number = Date.now(),
): Promise<PresentationActivity> {
  const base: PresentationActivity = {
    lifetime: 0,
    recent: 0,
    recent_window_days: PRESENTATION_ACTIVITY_RECENT_WINDOW_DAYS,
  };
  if (!walletId) return base;
  try {
    const [lifetime, recent] = await Promise.all([
      countPresentationsProducedSince(db, walletId, null),
      countPresentationsProducedSince(db, walletId, nowMs - PRESENTATION_ACTIVITY_RECENT_WINDOW_MS),
    ]);
    return { ...base, lifetime, recent };
  } catch {
    return base;
  }
}

/** The network-wide presentation volume (a single total). */
export interface NetworkPresentationVolume {
  readonly total: number;
}

/**
 * Network-wide presentation VOLUME — the total number of presentations produced
 * across the network. One `.count()` over the whole collection. Fail-safe to
 * zero so the ecosystem read never throws on this.
 */
export async function getNetworkPresentationVolume(
  db: Pick<Firestore, 'collection'>,
): Promise<NetworkPresentationVolume> {
  try {
    const snap = await (db.collection(COMMONS_PRESENTATIONS_COLLECTION) as unknown as {
      count(): { get(): Promise<unknown> };
    }).count().get();
    return { total: readCount(snap) };
  } catch {
    return { total: 0 };
  }
}

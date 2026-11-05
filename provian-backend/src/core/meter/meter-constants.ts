/**
 * PE meter constants and the anchor batch-id preimage, in a module with no Firestore import.
 *
 * `core/schema/pe-schema.ts` reads these to publish the schema, and `schema:check` runs in the
 * root typecheck leg, which does not install the backend's dependencies (`firebase-admin`).
 * `meter-store.ts` and `meter-anchor.ts` re-export them, so every other importer is unchanged.
 */

import { DAILY_PE_ANCHOR_NAMESPACE } from '../pvt/daily-pe-anchor';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Baseline lifetime for retained evidence keys; new unpaid keys remain until payment. */
export const METER_KEY_LIFETIME_MS = 31 * DAY_MS;
/** Legacy mailbox lifetime only. New transit copies remain until acknowledgement. */
export const PE_MAILBOX_LIFETIME_MS = 30 * DAY_MS;
/** A device may land at most one batch per this interval (clients send daily, plus before a presentation or payout). */
export const METER_MIN_BATCH_INTERVAL_MS = 5 * 60 * 1000;

/** The `meter_anchor_days_v1` document holding the anchor's watermark (`last_anchored_day`). */
export const METER_ANCHOR_STATE_DOC = 'state';

/** The preimage of a UTC day's meter anchor batch id (the id is its domain-separated keccak). */
export function meterAnchorBatchIdPreimage(dayKey: string, segment?: number): string {
  const base = `${DAILY_PE_ANCHOR_NAMESPACE}:meter:${dayKey}`;
  if (segment === undefined) return base;
  // 2026-10-10: an intra-day anchor SEGMENT (operator-run `meter-anchor-now`) commits the open day's
  // accepted-but-unanchored batches under `<day>:<n>`; the day's close anchors the remainder under
  // the plain day id. A segment number is a positive integer; 0 / negative / fractional never names one.
  if (!Number.isSafeInteger(segment) || segment < 1) throw new Error('invalid_anchor_segment');
  return `${base}:${segment}`;
}

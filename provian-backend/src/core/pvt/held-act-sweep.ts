/**
 * PE METER — the one bounded, resumable walk every hold sweep uses over METERED held acts.
 *
 * Since the PE meter a new act keeps no `pe_history` row: an act that waits
 * (pending evidence / review / cache, beneficiary pending, deferred, or an eligible act whose
 * payee could not resolve) is a never-expiring held record `meter_held_acts_v1/{relay_pe_id}`
 * (`core/meter/held-acts.ts`). Every sweep that walks `pe_history` for its hold status keeps doing
 * exactly that for the pre-meter rows, AND walks the held acts of the same status here, judging
 * each with the same rule and applying the transition through `resolveHeldAct`.
 *
 * The walk is `listHeldActs` pages (held_reason equality, relay-pe-id order — served by the
 * `(held_reason ASC, relay_pe_id ASC)` composite index), resumed from a durable cursor so
 * successive passes WALK the population instead of re-reading its head (the lesson), and
 * bounded by a page budget per pass. Reaching the end resets the cursor to the head; a resumed
 * cursor past the end wraps to the head once in the same pass, so a row left held by a transient
 * refusal is re-judged on the next cycle. Its cost is proportional to the held population of ONE
 * status, never to an actor's history.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { HeldActRow } from '../meter/held-acts';

/** Default home of a held-act sweep cursor (a sweep with its own bookkeeping collection passes it). */
export const HELD_ACT_SWEEP_CURSOR_COLLECTION = 'pvt_held_act_sweep_cursor_v1';
const CURSOR_SCHEMA = 'pvt-held-act-sweep-cursor/v1';

export const DEFAULT_HELD_ACT_PAGE_LIMIT = 100;
export const DEFAULT_HELD_ACT_MAX_PAGES = 10;

export interface HeldActSweepCursorDocument {
  readonly schema_version: typeof CURSOR_SCHEMA;
  readonly held_reason: string;
  /** The last held act examined, or null at the head of a cycle. */
  readonly last_relay_pe_id: string | null;
  readonly updated_at_ms: number;
  readonly cycles_completed: number;
}

export interface HeldActWalkOptions {
  /** Where the cursor lives: the sweep's own bookkeeping collection and a doc id. */
  readonly cursor: { readonly collection: string; readonly docId: string };
  readonly nowMs: number;
  readonly limit?: number;
  readonly maxPages?: number;
  /**
   * Checked after every visited act. Returning true stops the walk and resumes the next pass
   * strictly after the last act visited (a ceiling or a wall-clock budget).
   */
  readonly stop?: () => boolean;
}

export interface HeldActWalkResult {
  /** Held acts visited this pass. */
  readonly scanned: number;
  readonly pages: number;
  /** The resumed cursor was past the end and the walk restarted at the head. */
  readonly wrapped: boolean;
  /** The walk reached the end of the population (the cursor resets to the head). */
  readonly reached_end: boolean;
  /** A `stop()` ended the walk early. */
  readonly stopped: boolean;
  readonly next_relay_pe_id: string | null;
}

export async function readHeldActSweepCursor(
  db: Firestore,
  cursor: HeldActWalkOptions['cursor'],
  heldReason: string,
): Promise<HeldActSweepCursorDocument | null> {
  const snap = await db.collection(cursor.collection).doc(cursor.docId).get();
  if (!snap.exists) return null;
  const row = snap.data() as Partial<HeldActSweepCursorDocument> | undefined;
  // Fail FORWARD (the resolver-cursor rule): losing our place costs a cheap re-walk.
  if (row === undefined || row.schema_version !== CURSOR_SCHEMA || row.held_reason !== heldReason) return null;
  return row as HeldActSweepCursorDocument;
}

/**
 * Visit held acts of one status, page by page, from the durable cursor. A visit that throws is
 * the caller's to handle (each sweep already fails a row closed and keeps going); the walk never
 * swallows one.
 */
export async function walkHeldActs(
  db: Firestore,
  heldReason: string,
  options: HeldActWalkOptions,
  visit: (row: HeldActRow) => Promise<void>,
): Promise<HeldActWalkResult> {
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? DEFAULT_HELD_ACT_PAGE_LIMIT)));
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_HELD_ACT_MAX_PAGES));
  const cursor = await readHeldActSweepCursor(db, options.cursor, heldReason);
  // Lazy, like every settlement-side caller of the meter: its module graph reaches the record path.
  const { listHeldActs, createHeldActSource } = await import('../meter/held-acts');

  let startAfter: string | null = cursor?.last_relay_pe_id ?? null;
  const budget = limit * maxPages;
  const maxResults = Number.isSafeInteger(budget) ? budget : undefined;
  // The sweep's existing page budget also bounds retained decoded bodies; read every candidate
  // once, but retain only the logical rows this pass can visit after its durable cursor.
  let source = createHeldActSource(db, heldReason, { startAfter, maxResults });
  let scanned = 0;
  let pages = 0;
  let wrapped = false;
  let reachedEnd = false;
  let stopped = false;
  let next: string | null = startAfter;

  while (pages < maxPages) {
    const page = await listHeldActs(db, heldReason, { limit, startAfter, source });
    if (page.rows.length === 0 && page.next === null) {
      if (startAfter !== null && !wrapped) {
        // Past the end: wrap to the head once, so a row a transient refusal left held is
        // re-judged rather than never seen again.
        startAfter = null;
        wrapped = true;
        const remaining = limit * (maxPages - pages);
        source = createHeldActSource(db, heldReason, {
          maxResults: Number.isSafeInteger(remaining) ? remaining : undefined,
        });
        continue;
      }
      reachedEnd = true;
      next = null;
      break;
    }
    pages += 1;
    for (const row of page.rows) {
      await visit(row);
      scanned += 1;
      next = row.relayPeId;
      if (options.stop?.() === true) {
        stopped = true;
        break;
      }
    }
    if (stopped) break;
    if (page.next === null) {
      reachedEnd = true;
      next = null;
      break;
    }
    startAfter = page.next;
    next = page.next;
  }

  await db.collection(options.cursor.collection).doc(options.cursor.docId).set({
    schema_version: CURSOR_SCHEMA,
    held_reason: heldReason,
    last_relay_pe_id: next,
    updated_at_ms: options.nowMs,
    cycles_completed: (cursor?.cycles_completed ?? 0) + (reachedEnd || wrapped ? 1 : 0),
  } satisfies HeldActSweepCursorDocument);

  return { scanned, pages, wrapped, reached_end: reachedEnd, stopped, next_relay_pe_id: next };
}

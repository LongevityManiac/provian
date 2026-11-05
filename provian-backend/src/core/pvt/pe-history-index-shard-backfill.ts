/**
 * Backfill of the `pe_history.index_shard` field (H5 close-out) — the
 * logic behind `scripts/backfill-pe-history-index-shard.ts`, kept here so it
 * is executable under test (the script does `admin.initializeApp()` at module
 * scope and cannot be imported by a suite).
 *
 * Walks `pe_history` by document id with narrow reads and stamps the shard on
 * every row that lacks it or carries a wrong value. IDEMPOTENT: a second walk
 * writes nothing (the RED control in `pe-history-index-shard.test.ts` runs it
 * twice and asserts the second write count is zero). RESUMABLE: the walk
 * returns its last id so a budgeted run can continue where it stopped.
 *
 * `verifyIndexShardCoverage` is the cutover gate: a full walk that finds ZERO
 * rows missing or wrong is the only evidence on which the script may flip
 * readers to the sharded query shapes.
 */

import { FieldPath } from 'firebase-admin/firestore';
import type { Firestore, Query } from 'firebase-admin/firestore';
import {
  PE_HISTORY_INDEX_SHARD_FIELD,
  hasCorrectIndexShard,
  peHistoryIndexShard,
} from './pe-history-index-shard';

export const INDEX_SHARD_BACKFILL_PAGE_SIZE = 400;

export interface IndexShardBackfillReport {
  readonly scanned: number;
  readonly written: number;
  readonly pages: number;
  readonly complete: boolean;
  readonly lastId: string | null;
}

/**
 * One backfill run. `apply: false` counts what WOULD be written and writes
 * nothing. Stops early when `maxRunMs` is exhausted (reported as
 * `complete: false` with the id to resume from).
 */
export async function backfillPeHistoryIndexShard(
  db: Firestore,
  options: {
    readonly apply: boolean;
    readonly pageSize?: number;
    readonly startAfterId?: string | null;
    readonly maxRunMs?: number;
    readonly now?: () => number;
  },
): Promise<IndexShardBackfillReport> {
  const pageSize = options.pageSize ?? INDEX_SHARD_BACKFILL_PAGE_SIZE;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let scanned = 0;
  let written = 0;
  let pages = 0;
  let lastId: string | null = options.startAfterId ?? null;
  for (;;) {
    let query: Query = db.collection('pe_history')
      .orderBy(FieldPath.documentId())
      .select(PE_HISTORY_INDEX_SHARD_FIELD)
      .limit(pageSize);
    if (lastId !== null) query = query.startAfter(lastId);
    const snap = await query.get();
    if (snap.empty) return { scanned, written, pages, complete: true, lastId };
    pages += 1;
    scanned += snap.size;
    const batch = db.batch();
    let queued = 0;
    for (const doc of snap.docs) {
      if (hasCorrectIndexShard(doc.id, doc.data())) continue;
      if (options.apply) {
        batch.set(doc.ref, { [PE_HISTORY_INDEX_SHARD_FIELD]: peHistoryIndexShard(doc.id) }, { merge: true });
      }
      queued += 1;
    }
    if (options.apply && queued > 0) await batch.commit();
    written += queued;
    const next = snap.docs[snap.docs.length - 1].id;
    if (lastId !== null && next === lastId) {
      throw new Error(`pe_history_index_shard_backfill_cursor_not_advancing at ${next}`);
    }
    lastId = next;
    if (snap.size < pageSize) return { scanned, written, pages, complete: true, lastId };
    if (options.maxRunMs !== undefined && now() - startedAt >= options.maxRunMs) {
      return { scanned, written, pages, complete: false, lastId };
    }
  }
}

export interface IndexShardCoverageReport {
  readonly scanned: number;
  readonly missing: number;
  readonly wrong: number;
}

/** A full walk that counts rows without the field (missing) or with a wrong value (wrong). */
export async function verifyIndexShardCoverage(
  db: Firestore,
  pageSize = INDEX_SHARD_BACKFILL_PAGE_SIZE,
): Promise<IndexShardCoverageReport> {
  let scanned = 0;
  let missing = 0;
  let wrong = 0;
  let lastId: string | null = null;
  for (;;) {
    let query: Query = db.collection('pe_history')
      .orderBy(FieldPath.documentId())
      .select(PE_HISTORY_INDEX_SHARD_FIELD)
      .limit(pageSize);
    if (lastId !== null) query = query.startAfter(lastId);
    const snap = await query.get();
    if (snap.empty) break;
    scanned += snap.size;
    for (const doc of snap.docs) {
      const value = doc.data()[PE_HISTORY_INDEX_SHARD_FIELD];
      if (typeof value !== 'number') missing += 1;
      else if (value !== peHistoryIndexShard(doc.id)) wrong += 1;
    }
    const next = snap.docs[snap.docs.length - 1].id;
    if (lastId !== null && next === lastId) {
      throw new Error(`pe_history_index_shard_verify_cursor_not_advancing at ${next}`);
    }
    lastId = next;
    if (snap.size < pageSize) break;
  }
  return { scanned, missing, wrong };
}

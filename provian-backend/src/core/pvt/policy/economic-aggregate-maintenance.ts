/**
 * Maintenance of the accrual-time economic aggregates: BACKFILL (fold and mark
 * pre-existing rows), ROLL-FORWARD (move rows across the 72h watermark as their
 * windows close), and DRIFT DETECTION / REPAIR (compare a stored aggregate to
 * the paged reference fold and rewrite it under a version CAS).
 *
 * Every write here is a Firestore transaction that READS the aggregate document
 * it will write, so it serialises against the seal path and the mutation hooks
 * on that same document: a seal that lands between a page read and its commit
 * conflicts, retries, and sees the new state. That single document is the
 * serialisation point for everything that touches an identity's totals.
 *
 * BACKFILL IS IDEMPOTENT BY THE MARKER. A page folds only rows not yet stamped
 * `economic_aggregate_applied`, and stamps the ones it folds in the same
 * transaction. Re-running folds nothing already marked; a crash mid-walk loses
 * nothing (the next run resumes from wherever the marker stops). A row found
 * under one identity is applied under ALL its identities (contributor AND
 * beneficiary) when it is marked, so the beneficiary's walk later finds it
 * marked and skips it — "marked" means "in every aggregate it belongs to".
 *
 * ROLL-FORWARD advances `frozen_through_ms` only to at most `now − 72h`, in
 * pages ordered by (timestamp, __name__). A page boundary never splits a
 * millisecond: rows sharing the page's last timestamp are deferred to the next
 * page, unless the WHOLE page shares one timestamp, in which case that
 * millisecond is drained to its end inside the same transaction. The watermark
 * is the largest folded timestamp, so a row sealed later with a timestamp
 * inside a folded page's range is impossible to lose: it is either above the
 * watermark (tail) or was read by the page (frozen).
 *
 * DRIFT REPAIR is a CAS on `version` the reference fold is computed outside a
 * transaction (it may be 50k rows), then a transaction re-reads the document
 * and writes the expected aggregate ONLY if the version is the one the fold
 * started from. An identity that accrued during the fold reports
 * `identity_active_retry_later` instead of clobbering a live increment (the
 * M8 lesson: never write an absolute over a moving counter).
 */

import { FieldPath } from 'firebase-admin/firestore';
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { getWeekStart } from '../week-start';
import {
  AGGREGATE_ROLES,
  AGGREGATE_ROLE_KEY_FIELD,
  ECONOMIC_AGGREGATE_COLLECTION,
  ECONOMIC_AGGREGATE_SCHEMA_VERSION,
  EconomicAggregateWriter,
  PE_HISTORY_AGGREGATE_MARKER_FIELD,
  applyFrozenContribution,
  applyRowContribution,
  emptyRoleAggregate,
  isAggregateMarked,
  isFrozenUnder,
  parseAggregateDocument,
  rowContribution,
  type AggregateRole,
  type EconomicAggregateDocument,
  type RoleAggregate,
} from './economic-aggregate';

/** ≤ 400 row marks + a handful of aggregate docs stays under the 500-write cap. */
export const AGGREGATE_BACKFILL_PAGE_SIZE = 400;
export const AGGREGATE_ROLL_PAGE_SIZE = 200;

function rowTimestamp(row: Record<string, unknown>): number {
  const value = row.timestamp;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN;
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export interface BackfillIdentityReport {
  readonly identity: string;
  readonly roles: ReadonlyArray<{
    readonly role: AggregateRole;
    readonly rowsScanned: number;
    readonly rowsMarked: number;
    readonly pages: number;
  }>;
}

/**
 * Fold and mark every unmarked row read under `identity` for the given roles,
 * then flag those roles `backfill_complete`. Safe to run concurrently with
 * accrual and with itself.
 */
export async function backfillIdentityAggregate(
  db: Firestore,
  identity: string,
  options: {
    readonly nowMs: number;
    readonly roles?: readonly AggregateRole[];
    readonly pageSize?: number;
  },
): Promise<BackfillIdentityReport> {
  const pageSize = options.pageSize ?? AGGREGATE_BACKFILL_PAGE_SIZE;
  const roles = options.roles ?? AGGREGATE_ROLES;
  const reports: Array<BackfillIdentityReport['roles'][number]> = [];
  for (const role of roles) {
    let cursor: QueryDocumentSnapshot | null = null;
    let rowsScanned = 0;
    let rowsMarked = 0;
    let pages = 0;
    for (;;) {
      const page = await db.runTransaction(async (txn) => {
        let query: Query = db.collection('pe_history')
          .where(AGGREGATE_ROLE_KEY_FIELD[role], '==', identity)
          .orderBy(FieldPath.documentId())
          .limit(pageSize);
        if (cursor !== null) query = query.startAfter(cursor);
        const snap = await txn.get(query);
        const unmarked = snap.docs.filter((doc) => !isAggregateMarked(doc.data()));
        const writer = new EconomicAggregateWriter(db, txn, options.nowMs);
        await writer.load([
          identity,
          ...EconomicAggregateWriter.identitiesOf(...unmarked.map((doc) => doc.data())),
        ]);
        for (const doc of unmarked) {
          writer.applyRow(doc.data() as unknown as PEHistoryDocument, 1);
          txn.set(doc.ref, { [PE_HISTORY_AGGREGATE_MARKER_FIELD]: ECONOMIC_AGGREGATE_SCHEMA_VERSION }, { merge: true });
        }
        // The identity's own document must exist after a backfill even when it
        // has zero rows — a missing document is "never backfilled", not "empty".
        writer.touch(identity);
        writer.commit();
        return {
          size: snap.size,
          last: snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null,
          marked: unmarked.length,
        };
      });
      pages += 1;
      rowsScanned += page.size;
      rowsMarked += page.marked;
      if (page.size < pageSize || page.last === null) break;
      // PROGRESS GUARD (the streamQuery lesson): a cursor that stops advancing
      // would re-read page one forever.
      if (cursor !== null && page.last.id === cursor.id) {
        throw new Error(`economic_aggregate_backfill_cursor_not_advancing at ${page.last.id}`);
      }
      cursor = page.last;
    }
    await db.runTransaction(async (txn) => {
      const writer = new EconomicAggregateWriter(db, txn, options.nowMs);
      await writer.load([identity]);
      const current = writer.roleAggregate(identity, role);
      writer.setRoleAggregate(identity, role, { ...current, backfill_complete: true });
      writer.commit();
    });
    reports.push({ role, rowsScanned, rowsMarked, pages });
  }
  return { identity, roles: reports };
}

/**
 * Every identity key present in `pe_history` (both `userId` and
 * `beneficiary_wallet_id`), by one paged walk with narrow reads. For the
 * one-time backfill script; the read path never needs this.
 */
export async function enumerateAggregateIdentities(
  db: Firestore,
  pageSize = 1000,
): Promise<Set<string>> {
  const identities = new Set<string>();
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let query: Query = db.collection('pe_history')
      .orderBy(FieldPath.documentId())
      .select(AGGREGATE_ROLE_KEY_FIELD.contributor, AGGREGATE_ROLE_KEY_FIELD.beneficiary)
      .limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data = doc.data();
      for (const role of AGGREGATE_ROLES) {
        const key = data[AGGREGATE_ROLE_KEY_FIELD[role]];
        if (typeof key === 'string' && key.length > 0) identities.add(key);
      }
    }
    if (snap.size < pageSize) break;
    const last = snap.docs[snap.docs.length - 1];
    if (cursor !== null && last.id === cursor.id) {
      throw new Error(`economic_aggregate_enumerate_cursor_not_advancing at ${last.id}`);
    }
    cursor = last;
  }
  return identities;
}

// ---------------------------------------------------------------------------
// Roll-forward
// ---------------------------------------------------------------------------

export interface RollForwardReport {
  readonly identity: string;
  readonly role: AggregateRole;
  readonly rowsFrozen: number;
  readonly pages: number;
  readonly frozenThroughMs: number;
}

/**
 * Advance one role aggregate's watermark towards `cutoffMs` (≤ now − 72h),
 * folding the settlement input of every MARKED row that crosses it into the
 * frozen sums. Never advances past `cutoffMs`; never writes when nothing crossed.
 */
export async function rollForwardFrozenAggregate(
  db: Firestore,
  identity: string,
  role: AggregateRole,
  options: { readonly cutoffMs: number; readonly nowMs: number; readonly pageSize?: number },
): Promise<RollForwardReport> {
  const pageSize = options.pageSize ?? AGGREGATE_ROLL_PAGE_SIZE;
  const keyField = AGGREGATE_ROLE_KEY_FIELD[role];
  let rowsFrozen = 0;
  let pages = 0;
  let frozenThroughMs = 0;
  for (;;) {
    const step = await db.runTransaction(async (txn) => {
      const writer = new EconomicAggregateWriter(db, txn, options.nowMs);
      await writer.load([identity]);
      const agg = writer.roleAggregate(identity, role);
      const watermark = agg.frozen_through_ms;
      if (watermark >= options.cutoffMs) return { done: true, folded: 0, watermark };
      const snap = await txn.get(
        db.collection('pe_history')
          .where(keyField, '==', identity)
          .where('timestamp', '>', watermark)
          .where('timestamp', '<=', options.cutoffMs)
          .orderBy('timestamp', 'asc')
          .orderBy(FieldPath.documentId(), 'asc')
          .limit(pageSize),
      );
      if (snap.empty) return { done: true, folded: 0, watermark };

      let rows: QueryDocumentSnapshot[] = snap.docs;
      let nextWatermark: number;
      if (snap.size < pageSize) {
        nextWatermark = options.cutoffMs;
      } else {
        const lastTs = rowTimestamp(snap.docs[snap.size - 1].data());
        const below = snap.docs.filter((doc) => rowTimestamp(doc.data()) < lastTs);
        if (below.length > 0) {
          rows = below;
          nextWatermark = rowTimestamp(below[below.length - 1].data());
        } else {
          // The whole page shares one millisecond: drain it to its end so the
          // watermark can sit ON it without splitting rows across pages.
          let tailCursor: QueryDocumentSnapshot = snap.docs[snap.size - 1];
          for (;;) {
            const more = await txn.get(
              db.collection('pe_history')
                .where(keyField, '==', identity)
                .where('timestamp', '==', lastTs)
                .orderBy(FieldPath.documentId(), 'asc')
                .startAfter(tailCursor)
                .limit(pageSize),
            );
            rows = rows.concat(more.docs);
            if (more.size < pageSize) break;
            const next = more.docs[more.size - 1];
            if (next.id === tailCursor.id) {
              throw new Error(`economic_aggregate_roll_cursor_not_advancing at ${next.id}`);
            }
            tailCursor = next;
          }
          nextWatermark = lastTs;
        }
      }

      let next: RoleAggregate = { ...agg };
      let folded = 0;
      for (const doc of rows) {
        const data = doc.data();
        // Unmarked rows are in no aggregate (totals included); the backfill
        // owns them. Freezing their projection here would count a projection
        // for a row whose count is absent — the two halves must move together.
        if (!isAggregateMarked(data)) continue;
        const c = rowContribution(data as unknown as PEHistoryDocument, role, options.nowMs);
        next = applyFrozenContribution(next, c, 1);
        folded += 1;
      }
      next.frozen_through_ms = nextWatermark;
      writer.setRoleAggregate(identity, role, next);
      writer.commit();
      return { done: snap.size < pageSize, folded, watermark: nextWatermark };
    });
    pages += 1;
    rowsFrozen += step.folded;
    frozenThroughMs = step.watermark;
    if (step.done) break;
  }
  return { identity, role, rowsFrozen, pages, frozenThroughMs };
}

// ---------------------------------------------------------------------------
// Drift detection and repair
// ---------------------------------------------------------------------------

export interface RoleDriftReport {
  readonly role: AggregateRole;
  readonly evaluatedRows: number;
  readonly unmarkedRows: number;
  /** Field names whose stored value differs from the reference fold. Empty = no drift. */
  readonly mismatches: readonly string[];
}

export type DriftRepairOutcome =
  | 'not_needed'
  | 'repaired'
  | 'identity_active_retry_later'
  | 'aggregate_missing_backfilled'
  | 'repair_disabled';

export interface IdentityDriftReport {
  readonly identity: string;
  readonly aggregatePresent: boolean;
  readonly drift: boolean;
  readonly roles: readonly RoleDriftReport[];
  readonly repair: DriftRepairOutcome;
}

const COMPARED_SCALARS: ReadonlyArray<keyof RoleAggregate> = [
  'total_pes',
  'integrity_failures',
  'record_points_atomic',
  'genesis_gross_atomic',
  'frozen_pes',
  'frozen_projection_failures',
  'frozen_projection_rated_atomic',
  'frozen_projection_fixed_atomic',
];

const COMPARED_RECORDS: ReadonlyArray<keyof RoleAggregate> = [
  'pes_by_category',
  'record_points_by_category_atomic',
  'genesis_gross_by_category_atomic',
  'frozen_projection_rated_by_category_atomic',
  'frozen_projection_fixed_by_category_atomic',
];

function canonicalRecord(value: unknown): string {
  if (!value || typeof value !== 'object') return '{}';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== 0 && v !== '0')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Field-level comparison of a stored role aggregate against its reference.
 * Pure and EXPORTED so the suite can feed it a deliberately corrupted
 * aggregate and see the corruption named (the drift-detection RED control).
 */
export function compareRoleAggregates(
  stored: RoleAggregate,
  expected: RoleAggregate,
  nowMs: number,
): string[] {
  const mismatches: string[] = [];
  for (const field of COMPARED_SCALARS) {
    if (stored[field] !== expected[field]) mismatches.push(field);
  }
  for (const field of COMPARED_RECORDS) {
    if (canonicalRecord(stored[field]) !== canonicalRecord(expected[field])) mismatches.push(field);
  }
  const weekKey = String(getWeekStart(nowMs));
  if ((stored.pes_by_week_start[weekKey] ?? 0) !== (expected.pes_by_week_start[weekKey] ?? 0)) {
    mismatches.push('pes_by_week_start');
  }
  return mismatches;
}

async function foldReferenceRoleAggregate(
  db: Firestore,
  identity: string,
  role: AggregateRole,
  frozenThroughMs: number,
  nowMs: number,
  pageSize: number,
): Promise<{ expected: RoleAggregate; evaluatedRows: number; unmarkedRows: number }> {
  let expected: RoleAggregate = { ...emptyRoleAggregate(), frozen_through_ms: frozenThroughMs, backfill_complete: true };
  let evaluatedRows = 0;
  let unmarkedRows = 0;
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let query: Query = db.collection('pe_history')
      .where(AGGREGATE_ROLE_KEY_FIELD[role], '==', identity)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data = doc.data();
      evaluatedRows += 1;
      if (!isAggregateMarked(data)) {
        unmarkedRows += 1;
        continue;
      }
      const c = rowContribution(data as unknown as PEHistoryDocument, role, nowMs);
      expected = applyRowContribution(expected, c, 1, nowMs);
    }
    if (snap.size < pageSize) break;
    const last = snap.docs[snap.docs.length - 1];
    if (cursor !== null && last.id === cursor.id) {
      throw new Error(`economic_aggregate_drift_cursor_not_advancing at ${last.id}`);
    }
    cursor = last;
  }
  return { expected, evaluatedRows, unmarkedRows };
}

/**
 * Compare one identity's stored aggregate to the paged reference fold and,
 * when asked, repair it under a version CAS. Unmarked rows are reported (they
 * are the backfill's, not drift), and a missing aggregate is backfilled rather
 * than "repaired" from nothing.
 */
export async function detectIdentityAggregateDrift(
  db: Firestore,
  identity: string,
  options: { readonly nowMs: number; readonly repair: boolean; readonly pageSize?: number },
): Promise<IdentityDriftReport> {
  const pageSize = options.pageSize ?? 1000;
  const ref = db.collection(ECONOMIC_AGGREGATE_COLLECTION).doc(identity);
  const snap0 = await ref.get();
  const doc0 = snap0.exists ? parseAggregateDocument(identity, snap0.data()) : null;
  if (doc0 === null) {
    if (options.repair) await backfillIdentityAggregate(db, identity, { nowMs: options.nowMs });
    return {
      identity,
      aggregatePresent: false,
      drift: true,
      roles: [],
      repair: options.repair ? 'aggregate_missing_backfilled' : 'repair_disabled',
    };
  }

  const roles: RoleDriftReport[] = [];
  const expectedByRole: Partial<Record<AggregateRole, RoleAggregate>> = {};
  for (const role of AGGREGATE_ROLES) {
    const stored = doc0.roles[role];
    const { expected, evaluatedRows, unmarkedRows } = await foldReferenceRoleAggregate(
      db, identity, role, stored.frozen_through_ms, options.nowMs, pageSize,
    );
    expectedByRole[role] = expected;
    roles.push({
      role,
      evaluatedRows,
      unmarkedRows,
      mismatches: compareRoleAggregates(stored, expected, options.nowMs),
    });
  }
  const drift = roles.some((r) => r.mismatches.length > 0);
  if (!drift) return { identity, aggregatePresent: true, drift: false, roles, repair: 'not_needed' };

  console.error(JSON.stringify({
    severity: 'ERROR',
    event: 'pvt_economic_aggregate_drift_detected',
    identity,
    roles: roles.map((r) => ({ role: r.role, mismatches: r.mismatches, unmarked_rows: r.unmarkedRows })),
  }));

  if (!options.repair) {
    await ref.set({ drift_detected_at_ms: options.nowMs }, { merge: true });
    return { identity, aggregatePresent: true, drift: true, roles, repair: 'repair_disabled' };
  }

  const repair = await db.runTransaction(async (txn) => {
    const current = await txn.get(ref);
    const live = current.exists ? parseAggregateDocument(identity, current.data()) : null;
    if (live === null || live.version !== doc0.version) return 'identity_active_retry_later' as const;
    const next: EconomicAggregateDocument = {
      ...live,
      roles: {
        contributor: {
          ...(expectedByRole.contributor ?? live.roles.contributor),
          backfill_complete: live.roles.contributor.backfill_complete,
        },
        beneficiary: {
          ...(expectedByRole.beneficiary ?? live.roles.beneficiary),
          backfill_complete: live.roles.beneficiary.backfill_complete,
        },
      },
      version: live.version + 1,
      updated_at_ms: options.nowMs,
      drift_detected_at_ms: options.nowMs,
      drift_repaired_at_ms: options.nowMs,
    };
    txn.set(ref, next as unknown as Record<string, unknown>);
    return 'repaired' as const;
  });
  return { identity, aggregatePresent: true, drift: true, roles, repair };
}

// The periodic drift SWEEP (`sweepAggregateDrift`, cron `provian-pe-aggregate-drift`) is RETIRED by
// the PE meter (2026-10-03). It walked every aggregate and re-folded each identity's whole
// `pe_history` — a job proportional to history whose only purpose was to recompute totals. Under
// the meter the batch commit applies each fresh act's aggregate delta exactly once, in the same
// transaction as its act key, and there is no history to fold. The per-identity detector above
// stays only for the pre-meter read path until the migration.

// Re-exported so the read path and the scripts bind to one membership rule.
export { isFrozenUnder };

/**
 * The `pe_history` INDEX SHARD — the write-time prefix that breaks the
 * sequential-index hotspot on the low-cardinality-led, timestamp-ordered
 * composite indexes (H5 close-out).
 *
 * THE HOTSPOT. Firestore sustains roughly 500 writes/sec into an index whose
 * keys arrive in sequence. Every pe_history write lands at the END of any
 * index that starts with a low-cardinality field and ends with `timestamp` * (mint_status, timestamp), (mint_status, jurisdiction_context, timestamp),
 * (mint_status, timestamp, peId). Those three are the ceiling. The
 * `userId`-led indexes are partitioned per user (bounded by C3's ~1 PE/sec/user)
 * and are not the problem. (actionType, timestamp) is declared but has NO
 * reader in the tree — it is a deletion candidate, not a migration target; see
 * docs/archive/backend/delete-dead-pe-history-indexes.md.)
 *
 * THE MITIGATION is the standard one: a shard field derived from the document
 * id at write time leads each of those indexes, so consecutive writes spread
 * across `PE_HISTORY_INDEX_SHARD_COUNT` distinct key ranges and the ceiling
 * multiplies by that count. Readers fan out across EVERY shard and merge.
 * The shard is deterministic from `peId` (sha256 prefix mod N) — no counter,
 * no coordination, and a backfill can compute it for any existing row.
 *
 * CUTOVER IS DATA-DRIVEN, not a deploy flag. Readers stay on the legacy
 * (unsharded) query shapes — exactly today's behaviour — until the migration
 * state document says every row carries the field
 * (`sharded_readers_enabled: true`, written by the backfill script's --cutover
 * once a full walk finds zero rows missing it). A sharded reader run before
 * that would simply not see unbackfilled rows, so the switch is gated on the
 * one fact that makes it safe. Rows sealed after the deploy always carry the
 * field (writePEHistory stamps it), so the backfill only ever has a finite
 * population to catch up. The legacy indexes stay declared until the cutover;
 * the ORDER is written in the backfill script's header.
 *
 * READERS THAT FAN OUT (each reads its mode once per sweep):
 * deferred-release (mint_status=deferred, jurisdiction, timestamp asc)
 * pending-cache-backfill (mint_status=pending_cache, timestamp<=cutoff, timestamp asc)
 * pending-evidence-resolver (mint_status=pending_evidence, timestamp asc, peId asc)
 * A reader that forgets one shard silently misses rows; the RED control in
 * `pe-history-index-shard.test.ts` constructs exactly that and shows the miss.
 */

import crypto from 'crypto';
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';

export const PE_HISTORY_INDEX_SHARD_FIELD = 'index_shard';
/**
 * 16 shards: ~16× the sequential ceiling on the three hot indexes, at the cost
 * of 16 bounded queries per reader sweep. Raising it later is a backfill
 * (every row's shard changes), so it is not a casual knob; lowering it is the
 * same. Readers derive their fan-out from this constant, never a literal.
 */
export const PE_HISTORY_INDEX_SHARD_COUNT = 16;
export const PE_HISTORY_INDEX_SHARD_IDS: readonly number[] = Object.freeze(
  Array.from({ length: PE_HISTORY_INDEX_SHARD_COUNT }, (_, i) => i),
);

export const PE_HISTORY_INDEX_SHARD_MIGRATION_COLLECTION = 'pe_history_index_shard_migration';
export const PE_HISTORY_INDEX_SHARD_MIGRATION_DOC = 'state';
export const PE_HISTORY_INDEX_SHARD_MIGRATION_SCHEMA = 'pe-history-index-shard-migration/v1';

export function peHistoryIndexShard(peId: string): number {
  const prefix = crypto.createHash('sha256').update(peId, 'utf8').digest('hex').slice(0, 8);
  return Number.parseInt(prefix, 16) % PE_HISTORY_INDEX_SHARD_COUNT;
}

/** Does this row carry the shard its id derives? (Absent or wrong → needs backfill.) */
export function hasCorrectIndexShard(peId: string, row: Record<string, unknown> | undefined): boolean {
  return row?.[PE_HISTORY_INDEX_SHARD_FIELD] === peHistoryIndexShard(peId);
}

export type PeHistoryReaderMode = 'legacy' | 'sharded';

export interface IndexShardMigrationState {
  readonly schema_version: typeof PE_HISTORY_INDEX_SHARD_MIGRATION_SCHEMA;
  readonly sharded_readers_enabled: boolean;
  readonly shard_count: number;
  readonly cutover_at_ms: number | null;
  readonly cutover_evidence: string | null;
  readonly updated_at_ms: number;
}

/**
 * Which query shape readers must use. Fail-CLOSED to legacy: a missing,
 * malformed, or foreign-shard-count state document keeps every reader on the
 * unsharded queries, which is today's behaviour and cannot lose a row.
 */
export async function readPeHistoryReaderMode(db: Firestore): Promise<PeHistoryReaderMode> {
  const snap = await db.collection(PE_HISTORY_INDEX_SHARD_MIGRATION_COLLECTION)
    .doc(PE_HISTORY_INDEX_SHARD_MIGRATION_DOC)
    .get();
  if (!snap.exists) return 'legacy';
  const state = snap.data() as Partial<IndexShardMigrationState> | undefined;
  if (state?.schema_version !== PE_HISTORY_INDEX_SHARD_MIGRATION_SCHEMA) return 'legacy';
  if (state.shard_count !== PE_HISTORY_INDEX_SHARD_COUNT) return 'legacy';
  return state.sharded_readers_enabled === true ? 'sharded' : 'legacy';
}

/** Flip readers to the sharded shapes. Only the backfill script calls this, after a zero-missing walk. */
export async function enableShardedReaders(
  db: Firestore,
  params: { readonly nowMs: number; readonly evidence: string },
): Promise<void> {
  const state: IndexShardMigrationState = {
    schema_version: PE_HISTORY_INDEX_SHARD_MIGRATION_SCHEMA,
    sharded_readers_enabled: true,
    shard_count: PE_HISTORY_INDEX_SHARD_COUNT,
    cutover_at_ms: params.nowMs,
    cutover_evidence: params.evidence,
    updated_at_ms: params.nowMs,
  };
  await db.collection(PE_HISTORY_INDEX_SHARD_MIGRATION_COLLECTION)
    .doc(PE_HISTORY_INDEX_SHARD_MIGRATION_DOC)
    .set(state);
}

/**
 * The fan-out: run `build(shard)` for every shard in `shards`, merge the rows
 * by `orderBy`, and cut to `limit`. `shards` is a parameter (default: every
 * shard) PRECISELY so a test can hand it N−1 shards and watch rows go missing
 * — the guard's violating case must be constructible. Production callers pass
 * nothing and get the full set.
 */
export async function collectAcrossShards<T>(
  build: (shard: number) => Query,
  options: {
    readonly limit: number;
    readonly orderBy: (doc: QueryDocumentSnapshot) => number;
    readonly map: (doc: QueryDocumentSnapshot) => T;
    readonly shards?: readonly number[];
  },
): Promise<T[]> {
  const shards = options.shards ?? PE_HISTORY_INDEX_SHARD_IDS;
  const pages = await Promise.all(shards.map((shard) => build(shard).limit(options.limit).get()));
  const rows: Array<{ key: number; doc: QueryDocumentSnapshot }> = [];
  for (const page of pages) {
    for (const doc of page.docs) rows.push({ key: options.orderBy(doc), doc });
  }
  rows.sort((a, b) => a.key - b.key);
  return rows.slice(0, options.limit).map((row) => options.map(row.doc));
}

/** Apply the shard prefix to a query when in sharded mode; identity in legacy mode. */
export function withIndexShard(query: Query, shard: number | null): Query {
  return shard === null ? query : query.where(PE_HISTORY_INDEX_SHARD_FIELD, '==', shard);
}

/** The shard plan for a sweeping reader: one pass per shard when sharded, one unsharded pass otherwise. */
export function shardPlan(mode: PeHistoryReaderMode): ReadonlyArray<number | null> {
  return mode === 'sharded' ? PE_HISTORY_INDEX_SHARD_IDS : [null];
}

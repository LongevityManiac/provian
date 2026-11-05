/**
 * Operator-console disposition rollup — a seal-time count, not a query.
 *
 * The operator console needs "PEs by disposition, per day" cheaply. A query
 * would need a `pe_history` composite index led by the disposition and carrying
 * `timestamp`, which `firestore-dead-index-guard.ts` REFUSES (the monotonic-
 * timestamp-led hot-partition anti-pattern). So the count is maintained at seal
 * time instead:
 *
 *   - At seal (`pe-history.ts writePEHistory`) the row's contribution is added to
 *     its SEAL-DAY bucket under its sealed `mint_disposition`, inside the same
 *     transaction that writes the row — so the count can never disagree with the
 *     chain (a crash leaves the row counted-and-written or neither).
 *   - On a later disposition change (`economic-aggregate.ts
 *     mutatePeHistoryRowWithAggregate`, e.g. pending_evidence → eligible) the
 *     bucket is adjusted (−old, +new) on the SAME seal-day bucket, so the rollup
 *     always reflects the CURRENT disposition of the PEs sealed that day.
 *
 * Writes are BLIND `FieldValue.increment` merges — no read — so they add no new
 * transaction-abort mode to the seal beyond marginal write contention, which the
 * 16-way day sharding keeps below the sequential-write ceiling. Buckets are flat
 * docs `pvt_console_rollups/{yyyy-mm-dd}__{shard}` (one collection, one hop) so
 * the ref is buildable from the narrow `collection(name).doc(id)` shape the seal
 * and the mutation primitive both hand us. Settlement flips `mint_status`, not
 * `mint_disposition`, so a mint never moves a row out of its `eligible` bucket.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { MINT_DISPOSITIONS, type MintDisposition } from './policy/monetary-accounting';

export const CONSOLE_ROLLUP_COLLECTION = 'pvt_console_rollups';
export const CONSOLE_ROLLUP_SHARDS = 16;

/**
 * The minimal db/txn shapes these in-transaction helpers need, generic over the
 * document-reference type `R`. `R` is inferred from the caller, so both the full
 * Firestore transaction (from the seal) and the narrow `AggregateMutationDb`/
 * `AggregateTxnLike` (from the mutation primitive) work without a cast and
 * without importing — hence without a cycle with — `economic-aggregate.ts`.
 */
export interface RollupDbLike<R> { collection(name: string): { doc(id: string): R } }
export interface RollupTxnLike<R> {
  set(ref: R, data: Record<string, unknown>, opts?: { merge?: boolean }): void;
}

/** UTC calendar day `YYYY-MM-DD` for an epoch-ms instant. */
export function consoleRollupDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Deterministic 0..15 shard from a stable key (the pe_id), to spread blind writes. */
export function consoleRollupShard(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) & 0x7fffffff;
  }
  return hash % CONSOLE_ROLLUP_SHARDS;
}

/** Flat bucket doc id: `{yyyy-mm-dd}__{shard}`. */
export function consoleRollupDocId(day: string, shard: number): string {
  return `${day}__${shard}`;
}

function isMintDisposition(value: unknown): value is MintDisposition {
  return typeof value === 'string'
    && (MINT_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * Add one PE to its seal-day / sealed-disposition bucket. Call INSIDE the seal
 * transaction with the transaction handle; the write is blind (no read).
 */
export function incrementConsoleDispositionRollupInTransaction<R>(
  txn: RollupTxnLike<R>,
  db: RollupDbLike<R>,
  input: { disposition: MintDisposition; sealMs: number; peId: string },
): void {
  const day = consoleRollupDay(input.sealMs);
  const shard = consoleRollupShard(input.peId);
  txn.set(
    db.collection(CONSOLE_ROLLUP_COLLECTION).doc(consoleRollupDocId(day, shard)),
    {
      day,
      total: FieldValue.increment(1),
      counts: { [input.disposition]: FieldValue.increment(1) },
    },
    { merge: true },
  );
}

/**
 * Move one PE from one disposition to another WITHIN its seal-day bucket after a
 * post-seal disposition change. No-op unless BOTH sides are valid dispositions
 * and they differ. Call INSIDE the mutation transaction; blind write. `sealMs`
 * is the row's ORIGINAL seal timestamp so the adjustment lands on the same day
 * bucket the seal-time increment used.
 */
export function adjustConsoleDispositionRollupInTransaction<R>(
  txn: RollupTxnLike<R>,
  db: RollupDbLike<R>,
  input: {
    fromDisposition: unknown;
    toDisposition: unknown;
    sealMs: number;
    peId: string;
  },
): void {
  if (!isMintDisposition(input.fromDisposition) || !isMintDisposition(input.toDisposition)) return;
  if (input.fromDisposition === input.toDisposition) return;
  if (!Number.isFinite(input.sealMs)) return;
  const day = consoleRollupDay(input.sealMs);
  const shard = consoleRollupShard(input.peId);
  txn.set(
    db.collection(CONSOLE_ROLLUP_COLLECTION).doc(consoleRollupDocId(day, shard)),
    {
      day,
      counts: {
        [input.fromDisposition]: FieldValue.increment(-1),
        [input.toDisposition]: FieldValue.increment(1),
      },
    },
    { merge: true },
  );
}

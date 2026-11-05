/**
 * Durable event counters — `ops_counters/{YYYY-MM-DD}__shard{0-7}`.
 *
 * Every hot-path hook is a single `Map.set` (zero I/O on the request path). A per-instance
 * shard doc is flushed with `FieldValue.increment` at most once per 30 s (lazy, `unref`'d
 * timer), fire-and-forget, errors swallowed; also flushable by the attention job and on
 * SIGTERM. The reader sums `days × 8` docs by EXACT id — no query, no index (the dead-index
 * guard only refuses timestamp-led composites; there is no query here at all).
 *
 * Deliberately NOT imported by `core/pvt/**`, `cache.ts`, or an agent-bank money root (the
 * brief's hot-path rule). The bump sites are auth / push / email / webhook / rpc / mcp /
 * jurisdiction / killswitch / ratelimit / scheduler — none on the settlement path. Weakening
 * or moving a money-path test is cheaper than editing the money path, so this stays outside it.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { relayDb } from '../../firestore-db';

export const OPS_COUNTERS_COLLECTION = 'ops_counters';

const SHARDS = 8;
const FLUSH_INTERVAL_MS = 30_000;
// One stable shard per process instance, so an instance always increments the same doc
// (no cross-instance contention on a single hot key; the reader fans the 8 shards back in).
const INSTANCE_SHARD = Math.floor(Math.random() * SHARDS);

let accumulator = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let sigtermHooked = false;

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function shardDocId(now: number, shard: number): string {
  return `${dayKey(now)}__shard${shard}`;
}

function ensureTimer(): void {
  if (timer) return;
  // Never arm a background flush timer under jest: a lingering interval that fires after a
  // test file's environment is torn down throws "import a file after the Jest environment has
  // been torn down" (the flush would touch firebase-admin post-teardown). Tests that need a
  // flush call flushOpsCounters() explicitly. Production is unaffected (JEST_WORKER_ID unset).
  if (process.env.JEST_WORKER_ID !== undefined) return;
  timer = setInterval(() => { void flushOpsCounters(); }, FLUSH_INTERVAL_MS);
  // unref so a live buffer never keeps the process (or a jest run) alive on its own.
  if (typeof timer.unref === 'function') timer.unref();
  if (!sigtermHooked) {
    sigtermHooked = true;
    process.once('SIGTERM', () => { void flushOpsCounters(); });
  }
}

/**
 * Hot-path safe: a single `Map.set`, no I/O. `delta` defaults to 1. A zero / non-finite
 * delta or empty key is a no-op (never writes a `NaN` into a durable counter).
 */
export function bumpOpsCounter(key: string, delta = 1): void {
  if (!key || !Number.isFinite(delta) || delta === 0) return;
  accumulator.set(key, (accumulator.get(key) ?? 0) + delta);
  ensureTimer();
}

function resolveDb(dbOverride?: Firestore): Firestore | null {
  if (dbOverride) return dbOverride;
  try { return relayDb(); } catch { return null; }
}

/**
 * Merge-flush the accumulator into this instance's shard doc. Best-effort: the buffer is
 * swapped out FIRST (so bumps arriving mid-flush land in a fresh map), and any write error
 * is swallowed — these are advisory counters and must never throw on a timer or a hot path.
 * Injectable `dbOverride` / `now` for tests.
 */
export async function flushOpsCounters(dbOverride?: Firestore, now: number = Date.now()): Promise<void> {
  if (accumulator.size === 0) return;
  const pending = accumulator;
  accumulator = new Map();
  const db = resolveDb(dbOverride);
  if (!db) return; // no Firestore available → drop (advisory telemetry, never a crash)
  const update: Record<string, unknown> = { day: dayKey(now) };
  for (const [key, value] of pending) update[key] = FieldValue.increment(value);
  try {
    await db.collection(OPS_COUNTERS_COLLECTION).doc(shardDocId(now, INSTANCE_SHARD)).set(update, { merge: true });
  } catch {
    // fire-and-forget: swallow. Losing a flush window of advisory counts is acceptable;
    // re-throwing on a background timer is not.
  }
}

/** Test-only: clear the in-memory buffer and stop the flush timer between cases. */
export function __resetOpsCountersForTest(): void {
  accumulator = new Map();
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * Transient-collection purge (ops hardening 2026-07-06).
 *
 * Several Firestore collections are append-only "work queue" / ephemeral records
 * that NO code path prunes:
 *   - relay_requests    agent authorization inbox (decided rows are dead weight;
 *                       the durable record of the decision is its Provenance
 *                       Envelope in pe_history / provenance_envelopes)
 *   - connection_tokens short-lived (1 h) agent link codes (human- or fleet-issued)
 *   - setup_tokens      short-lived (1 h) device/agent registration tokens
 *   - consumed_nonces   replay-protection markers (safe to drop once expired)
 *   - rate_limits       60-second sliding-window counters
 *
 * Left unbounded they accumulate forever. A load-test burst in Feb–Apr 2026 left
 * 342k stale relay_requests (~1.7 GiB incl. Firestore auto-indexes) — the bulk of
 * the database's stored bytes and therefore of its backup/PITR cost. This job
 * keeps the collections bounded going forward so that never recurs.
 *
 * Why not native Firestore TTL: TTL only deletes documents whose TTL field is a
 * `Timestamp`. Every collection here stores its time field as an epoch-millis
 * INTEGER (Date.now()), so native TTL is a no-op against them. We prune by query
 * instead. (If these are ever migrated to write a Timestamp field, native TTL can
 * replace this job.)
 *
 * Trigger: POST /v1/internal/scheduler/purge-transients (daily Cloud Scheduler).
 */

import { relayDb } from '../../firestore-db';
import { FieldPath } from 'firebase-admin/firestore';
import type { QueryDocumentSnapshot, Firestore } from 'firebase-admin/firestore';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PurgeRule {
  /** Collection to prune. */
  collection: string;
  /** The epoch-millis INTEGER field the retention is measured against. */
  field: string;
  /** Delete docs whose `field` is strictly older than `now - retentionMs`. */
  retentionMs: number;
}

/**
 * Per-collection retention windows.
 *  - relay_requests keeps a 30-day audit/debug window; its decisions are already
 *    sealed as PEs, so older rows carry no durable value.
 *  - The auth-handoff and replay collections self-expire in minutes-to-hours, so
 *    a 2-day floor past their own expiry is comfortably clear of any still-valid
 *    token/nonce (no risk of dropping a live one).
 *  - rate_limits windows are 60 s; 2 days is far past any live window.
 */
export const TRANSIENT_PURGE_RULES: PurgeRule[] = [
  { collection: 'relay_requests', field: 'created_at', retentionMs: 30 * DAY_MS },
  { collection: 'connection_tokens', field: 'expires_at', retentionMs: 2 * DAY_MS },
  { collection: 'setup_tokens', field: 'expires_at', retentionMs: 2 * DAY_MS },
  { collection: 'consumed_nonces', field: 'expires_at', retentionMs: 2 * DAY_MS },
  { collection: 'rate_limits', field: 'window_start', retentionMs: 2 * DAY_MS },
];

/**
 * Max docs deleted per collection per run — a safety valve so a single invocation
 * can never delete unbounded volume (e.g. if the job had been off for a long time
 * and a huge backlog built up). A run that hits this reports the collection in
 * `capped`; the next daily run keeps draining. Never silently truncates.
 */
export const MAX_DELETES_PER_COLLECTION = 25_000;
const PAGE_SIZE = 500;

export interface PurgeResult {
  /** Docs deleted per collection this run. */
  deleted: Record<string, number>;
  /** Collections that hit MAX_DELETES_PER_COLLECTION (more remain for next run). */
  capped: string[];
  /** The `field < cutoff` boundary used per collection (epoch ms), for telemetry. */
  cutoffs: Record<string, number>;
}

/**
 * Delete aged docs from each transient collection. Pure over (db, now, rules) so
 * it is unit-testable against the in-memory fake. A per-collection failure is
 * logged and that collection is skipped (0 deleted) without aborting the others,
 * so one bad collection can't block the rest of the sweep.
 *
 * The query is a single-field inequality (`field < cutoff`), which uses the
 * automatic single-field index — no composite index required. Docs missing the
 * field are never matched (so never deleted, and can't loop the drain).
 */
export async function purgeTransientCollections(
  db: Firestore = relayDb(),
  now: number = Date.now(),
  rules: PurgeRule[] = TRANSIENT_PURGE_RULES,
): Promise<PurgeResult> {
  const deleted: Record<string, number> = {};
  const capped: string[] = [];
  const cutoffs: Record<string, number> = {};

  for (const rule of rules) {
    const cutoff = now - rule.retentionMs;
    cutoffs[rule.collection] = cutoff;
    let removed = 0;
    try {
      // Drain in pages. Each page re-queries the head of the aged range and
      // deletes it; deleting the matched docs is what advances the loop (no
      // cursor needed — the next query returns the following aged docs). Bounded
      // by MAX_DELETES_PER_COLLECTION so a single run can't run away.
      while (removed < MAX_DELETES_PER_COLLECTION) {
        const pageLimit = Math.min(PAGE_SIZE, MAX_DELETES_PER_COLLECTION - removed);
        const snap = await db
          .collection(rule.collection)
          .where(rule.field, '<', cutoff)
          .limit(pageLimit)
          .get();
        if (snap.empty) break;
        await Promise.all(snap.docs.map((d) => d.ref.delete()));
        removed += snap.size;
        if (snap.size < pageLimit) break; // fully drained this range
      }
    } catch (err) {
      console.warn(`[PurgeTransients] ${rule.collection} prune failed`, err);
    }
    deleted[rule.collection] = removed;
    if (removed >= MAX_DELETES_PER_COLLECTION) capped.push(rule.collection);
  }

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  console.info('[PurgeTransients] complete', { total, deleted, capped });
  return { deleted, capped, cutoffs };
}

// ---------------------------------------------------------------------------
// api_key_index orphan sweep (referential integrity — NOT age-based)
// ---------------------------------------------------------------------------
//
// `api_key_index/{prefix}` maps an API-key prefix → agent `wallet_id`. Agent auth
// (routes/middleware/agent-auth.ts) looks up the index, then loads
// `agent_wallets/{wallet_id}` and returns 401 if that wallet doc is absent — so
// an index entry whose `wallet_id` has NO backing `agent_wallets` doc is DEAD: it
// can never authenticate anyone. A since-removed k6 load test (the old
// `load-test/` harness, deleted in it drove the retired agent-session
// channel — but historically pointed at prod) created ~106k such entries whose
// `agent_wallets` docs were later cleared, orphaning the index. This sweep removes ONLY those
// orphans. It is deliberately conservative because it touches a live auth index:
//   - Loads the FULL live `agent_wallets` id set; if that load throws or returns
//     EMPTY, it ABORTS and deletes nothing (never risk nuking live keys on a bad
//     read — "unknown = block").
//   - Only considers entries older than a 24h grace (never races a fresh key).
//   - Keeps any entry whose `wallet_id` is live, or that is missing `wallet_id`.
//   - Per-run delete cap; logs when hit.
// Note: age alone is NEVER the delete key here (a real key created months ago is
// still valid) — the delete key is "wallet_id has no live agent_wallets doc".

/** Don't delete an orphan younger than this — grace against create races. */
export const ORPHAN_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
export const MAX_ORPHAN_DELETES_PER_RUN = 25_000;

export interface OrphanSweepResult {
  /** True if the sweep refused to run (bad/empty live set) and deleted nothing. */
  aborted: boolean;
  reason?: string;
  /** Size of the live agent_wallets keep-set. */
  liveWallets: number;
  /** api_key_index docs examined. */
  scanned: number;
  /** Orphan entries deleted. */
  deleted: number;
  /** Hit MAX_ORPHAN_DELETES_PER_RUN (more remain for the next run). */
  capped: boolean;
}

/**
 * Delete `api_key_index` entries that point at a `wallet_id` with no live
 * `agent_wallets` doc (dead auth-index entries). Safe by construction: a deleted
 * entry could only have produced a 401 anyway. Uses a cursor over the aged range: each entry is examined once, including
 * pages made entirely of live entries. Wallet keep-set and grace rules remain exact.
 */
export async function purgeOrphanedApiKeyIndex(
  db: Firestore = relayDb(),
  now: number = Date.now(),
): Promise<OrphanSweepResult> {
  const result: OrphanSweepResult = {
    aborted: false, liveWallets: 0, scanned: 0, deleted: 0, capped: false,
  };

  // 1. Build the live keep-set from agent_wallets. ABORT (delete nothing) if the
  //    read fails or the set is empty — refusing to sweep against an unknown or
  //    empty live set is the safety property that prevents nuking real keys.
  let live: Set<string>;
  try {
    const snap = await db.collection('agent_wallets').select().get();
    live = new Set<string>(snap.docs.map((d) => d.id));
  } catch (err) {
    result.aborted = true;
    result.reason = 'agent_wallets load failed';
    console.warn('[OrphanSweep] ABORT — agent_wallets load failed, deleting nothing', err);
    return result;
  }
  if (live.size === 0) {
    result.aborted = true;
    result.reason = 'agent_wallets empty';
    console.warn('[OrphanSweep] ABORT — agent_wallets empty, deleting nothing');
    return result;
  }
  result.liveWallets = live.size;

  // 2. Walk the aged range once. Kept entries must not be re-read on each deletion page.
  const cutoff = now - ORPHAN_SWEEP_GRACE_MS;
  const source = db.collection('api_key_index').where('created_at', '<', cutoff)
    .orderBy('created_at').orderBy(FieldPath.documentId());
  let after: QueryDocumentSnapshot | undefined;
  while (result.deleted < MAX_ORPHAN_DELETES_PER_RUN) {
    let query = source.limit(500);
    if (after) query = query.startAfter(after);
    const page = await query.get();
    if (page.empty) break;
    result.scanned += page.size;
    const orphans = page.docs.filter((d) => {
      const wid = (d.data() as { wallet_id?: string }).wallet_id;
      return typeof wid === 'string' && wid.length > 0 && !live.has(wid);
    });
    after = page.docs.at(-1);
    const room = MAX_ORPHAN_DELETES_PER_RUN - result.deleted;
    const toDelete = orphans.slice(0, room);
    await Promise.all(toDelete.map((d) => d.ref.delete()));
    result.deleted += toDelete.length;
    if (toDelete.length < orphans.length || page.size < 500) break; // cap or exhausted range
  }
  result.capped = result.deleted >= MAX_ORPHAN_DELETES_PER_RUN;
  console.info('[OrphanSweep] complete', result);
  return result;
}

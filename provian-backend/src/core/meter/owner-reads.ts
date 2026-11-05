import { singleScanQuery, visitQueryDocuments } from '../provenance/private-store';
import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * PE METER — the relay's user-facing READS, answered from what the meter keeps.
 *
 * The relay no longer stores PEs : a PE lives with its owner (the
 * daemon/SDK local store; the phone's cloud backup). What a read surface can still answer from
 * the relay, and how:
 *
 * "how many / how much" → running totals (`actor_stats_v1`, the economic aggregate,
 * `actor_meter_totals_v1`, the day counters) — a fixed number of
 * point reads, independent of the actor's history;
 * "what happened recently" → the actor's 31-day act keys, newest first, behind a small limit
 * on an indexed `(actor_id, timestamp)` query — PRICED rows (type,
 * time, disposition, points), never content;
 * "give me my PEs" → nothing: 410 `pe_kept_by_owner`. The full listing is the
 * device's job; the relay never serves a readable PE it doesn't have.
 */

import { FieldPath } from 'firebase-admin/firestore';
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { encodeKeysetCursor, type KeysetCursor } from '../pagination/keyset-cursor';
import { ACTOR_STATS_COLLECTION, coerceActorStats, windowStartDay, type ActorStatsDoc } from '../pvt/actor-stats';
import { COUNTERPARTY_PAIRS_COLLECTION } from './counterparty-pairs';
import { IDENTITY_ACTS_COLLECTION } from './identity-acts';
import type { MeterActKeyDoc } from './meter-act-key';
import { actKeyOfPageAct, METER_BATCH_ACTS_COLLECTION, type MeterActPageDoc } from './meter-act-pages';
import { PARTICIPATION_WINDOW_DAYS, readActorMeterWindow } from './actor-meter-totals';
import {
  METER_ACT_KEYS_COLLECTION,
  METER_HELD_ACTS_COLLECTION,
  PE_MAILBOX_COLLECTION,
} from './meter-store';

// =============================================================================
// Full PE listings: kept by the owner
// =============================================================================

export const PE_KEPT_BY_OWNER_STATUS = 410;

export const PE_KEPT_BY_OWNER_BODY = Object.freeze({
  error: 'pe_kept_by_owner',
  detail: 'PEs are kept on the owner’s devices; read the local PE store (SDK/daemon) or the app',
});

export interface StatusJsonSink {
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Answer a request for PE bodies the relay no longer has. `extra` adds context (the wallet, where
 * proofs live); it can never replace the `error`/`detail` contract.
 */
export function sendPeKeptByOwner(res: StatusJsonSink, extra?: Readonly<Record<string, unknown>>): void {
  res.status(PE_KEPT_BY_OWNER_STATUS).json({ ...(extra ?? {}), ...PE_KEPT_BY_OWNER_BODY });
}

// =============================================================================
// Recent activity: the act keys of the last ≤31 days, newest first, bounded
// =============================================================================

export const RECENT_ACTS_MAX_LIMIT = 100;
/** An offset caller may skip at most this many keys (the 31-day window; never a history walk). */
export const RECENT_ACTS_MAX_OFFSET = 1000;

export interface RecentActKey {
  readonly id: string;
  readonly key: MeterActKeyDoc;
}

export interface RecentActsPage {
  readonly acts: readonly RecentActKey[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

function actKeyQuery(db: Firestore, field: 'actor_id' | 'beneficiary_id', id: string): Query {
  return privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION)
    .where(field, '==', id)
    .orderBy('timestamp', 'desc')
    .orderBy(FieldPath.documentId(), 'desc');
}

function compareNewestFirst(a: RecentActKey, b: RecentActKey): number {
  if (a.key.timestamp !== b.key.timestamp) return b.key.timestamp - a.key.timestamp;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * One page of an actor's live act keys (any of its ids), newest first. One bounded query per id
 * on the `(actor_id, timestamp desc)` index, merged — at most `ids × (offset + limit + 1)` keys,
 * all inside the 31-day TTL window. Never reads past the page.
 */
export async function listRecentActKeys(
  db: Firestore,
  actorIds: readonly string[],
  options: { readonly limit: number; readonly cursor?: KeysetCursor | null; readonly offset?: number },
): Promise<RecentActsPage> {
  const limit = Math.max(1, Math.min(RECENT_ACTS_MAX_LIMIT, Math.floor(options.limit) || 1));
  const cursor = options.cursor ?? null;
  const offset = cursor === null ? Math.max(0, Math.min(RECENT_ACTS_MAX_OFFSET, Math.floor(options.offset ?? 0) || 0)) : 0;
  const ids = [...new Set(actorIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const fetchEach = offset + limit + 1;
  const pages = await Promise.all(ids.map(async (id) => {
    let query = actKeyQuery(db, 'actor_id', id);
    if (cursor !== null) query = query.startAfter(cursor.sortValue, cursor.documentId);
    const snap = await query.limit(fetchEach).get();
    return snap.docs.map((doc: QueryDocumentSnapshot) => ({ id: doc.id, key: doc.data() as MeterActKeyDoc }));
  }));
  // : single-lane acts live on their batches' act pages, not in act keys.
  const paged = await Promise.all(ids.map((id) => recentPageActs(db, id, fetchEach, cursor)));
  const byId = new Map<string, RecentActKey>();
  for (const page of [...pages, ...paged]) for (const act of page) byId.set(act.id, act);
  const merged = [...byId.values()].sort(compareNewestFirst);
  const acts = merged.slice(offset, offset + limit);
  const hasMore = merged.length > offset + limit;
  let nextCursor: string | null = null;
  const last = acts.length > 0 ? acts[acts.length - 1] : null;
  if (hasMore && last !== null) {
    try {
      nextCursor = encodeKeysetCursor(last.key.timestamp, last.id);
    } catch {
      console.error(`[OwnerReads] cursor unencodable at ${last.id}; walk truncated here`);
    }
  }
  return { acts, hasMore, nextCursor };
}

function beforeCursor(act: RecentActKey, cursor: KeysetCursor | null): boolean {
  if (cursor === null) return true;
  const ts = Number(cursor.sortValue);
  if (act.key.timestamp !== ts) return act.key.timestamp < ts;
  return act.id < cursor.documentId;
}

/**
 * Stream each matching act page once and retain only the requested newest acts. Physical
 * encrypted-document order is unrelated to activity time; the bounded reduction preserves
 * the old newest-page order even for equal act keys with different priced metadata.
 */
async function recentPageActs(
  db: Firestore,
  actorId: string,
  want: number,
  cursor: KeysetCursor | null,
): Promise<RecentActKey[]> {
  type Candidate = { entry: RecentActKey; pageMaxTs: number; pageId: string; index: number };
  const held: Candidate[] = [];
  const compare = (a: Candidate, b: Candidate): number =>
    compareNewestFirst(a.entry, b.entry) || b.pageMaxTs - a.pageMaxTs ||
    Buffer.compare(Buffer.from(b.pageId), Buffer.from(a.pageId)) || a.index - b.index;
  const source = privateRetentionCollection(db, METER_BATCH_ACTS_COLLECTION)
    .where('actor_id', '==', actorId).orderBy('max_ts', 'desc');
  await visitQueryDocuments(source, (doc) => {
    const page = doc.data() as MeterActPageDoc;
    // Skip this page's acts only: a later physical page may contain newer activity.
    if (held.length >= want && page.max_ts < held[want - 1].entry.key.timestamp) return;
    Object.values(page.acts).forEach((act, index) => {
      const entry = { id: act.relay_pe_id, key: actKeyOfPageAct(act) };
      if (beforeCursor(entry, cursor)) held.push({ entry, pageMaxTs: page.max_ts, pageId: doc.id, index });
    });
    held.sort(compare);
    held.length = Math.min(held.length, want);
  });
  return held.map(({ entry }) => entry);
}

/** The priced view of one act key: what a recent-activity list may show (never content). */
export interface PricedActView {
  readonly peId: string;
  readonly clientPeId: string | null;
  readonly actionType: string;
  readonly timestamp: number;
  readonly mintStatus: string | null;
  readonly mintDisposition: string | null;
  readonly recordPointsAtomic: string | null;
  readonly attestationDepth: string | null;
  readonly commitSha: string | null;
  readonly peHash: string;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function pricedActView(act: RecentActKey): PricedActView {
  const row = act.key.row ?? {};
  return {
    peId: act.id,
    clientPeId: strOrNull(act.key.client_pe_id),
    actionType: strOrNull(row.actionType) ?? strOrNull(act.key.action_type) ?? 'unknown',
    timestamp: act.key.timestamp,
    mintStatus: strOrNull(row.mint_status),
    mintDisposition: strOrNull(row.mint_disposition),
    recordPointsAtomic: strOrNull(row.record_points_atomic),
    attestationDepth: strOrNull(row.attestationDepth),
    commitSha: strOrNull(row.commit_sha),
    peHash: act.key.pe_hash,
  };
}

/**
 * Every live act key of an identity (contributor: `actor_id`; beneficiary: `beneficiary_id`)
 * with `timestamp > afterMs`, streamed in pages. Bounded by the act keys' 31-day TTL — the read
 * reaches only the live window, never history.
 */
export async function streamLiveActKeys(
  db: Firestore,
  field: 'actor_id' | 'beneficiary_id',
  id: string,
  afterMs: number,
  pageSize: number,
  onKey: (key: MeterActKeyDoc) => void,
): Promise<void> {
  const source = singleScanQuery(actKeyQuery(db, field, id).where('timestamp', '>', afterMs));
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let query = source.limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor.get('timestamp'), cursor.id);
    const snap = await query.get();
    if (snap.empty) return;
    for (const doc of snap.docs) onKey(doc.data() as MeterActKeyDoc);
    if (snap.size < pageSize) return;
    const next = snap.docs[snap.docs.length - 1];
    if (cursor !== null && next.id === cursor.id) {
      throw new Error(`live_act_keys_cursor_not_advancing at ${next.id}`);
    }
    cursor = next;
  }
  // : and every live single-lane act on the identity's act pages.
  await streamLivePageActs(db, field, id, afterMs, pageSize, onKey);
}

async function streamLivePageActs(
  db: Firestore,
  field: 'actor_id' | 'beneficiary_id',
  id: string,
  afterMs: number,
  pageSize: number,
  onKey: (key: MeterActKeyDoc) => void,
): Promise<void> {
  const base = field === 'actor_id'
    ? privateRetentionCollection(db, METER_BATCH_ACTS_COLLECTION).where('actor_id', '==', id)
    : privateRetentionCollection(db, METER_BATCH_ACTS_COLLECTION).where('beneficiary_ids', 'array-contains', id);
  const source = singleScanQuery(base.where('max_ts', '>', afterMs).orderBy('max_ts', 'asc'));
  const size = Math.max(1, Math.min(50, pageSize));
  let after: QueryDocumentSnapshot | null = null;
  for (;;) {
    let query = source.limit(size);
    if (after !== null) query = query.startAfter(after);
    const snap = await query.get();
    for (const doc of snap.docs) {
      const page = doc.data() as MeterActPageDoc;
      for (const act of Object.values(page.acts)) {
        if (act.timestamp <= afterMs) continue;
        if (field === 'beneficiary_id' && act.beneficiary_id !== id) continue;
        onKey(actKeyOfPageAct(act));
      }
    }
    if (snap.size < size) return;
    after = snap.docs[snap.docs.length - 1];
  }
}

// =============================================================================
// Running totals
// =============================================================================

async function readStats(db: Firestore, actorId: string): Promise<ActorStatsDoc> {
  const snap = await db.collection(ACTOR_STATS_COLLECTION).doc(actorId).get();
  return coerceActorStats(actorId, snap.exists ? snap.data() : null);
}

/** PE counts summed across an identity's actor ids (disjoint: a PE has exactly one actor). */
export async function readActorPeTotals(
  db: Firestore,
  actorIds: readonly string[],
): Promise<{ readonly peCount: number; readonly byType: Readonly<Record<string, number>> }> {
  const ids = [...new Set(actorIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const docs = await Promise.all(ids.map((id) => readStats(db, id)));
  let peCount = 0;
  const byType: Record<string, number> = {};
  for (const doc of docs) {
    peCount += doc.pe_count;
    for (const [type, n] of Object.entries(doc.by_type)) byType[type] = (byType[type] ?? 0) + n;
  }
  return { peCount, byType };
}

/** The live PE count of one actor (lifetime, from its running total). */
export async function readActorPeCount(db: Firestore, actorId: string): Promise<number> {
  return (await readStats(db, actorId)).pe_count;
}

export interface ParticipationSummary {
  readonly pe_count_total: number;
  readonly pe_count_this_month: number;
  readonly corroboration_rate: number;
  readonly agent_hours_this_month: 0;
  readonly agent_actions_this_month: number;
  readonly promises_kept: number;
  readonly foundation_member_since: number | null;
}

/**
 * The Abundance dashboard's participation summary from running totals: `actor_stats_v1` (lifetime
 * count, the day buckets, `promise_fulfilled`, first PE) and the 30 day counters (agent actions,
 * corroborated acts). 31 point reads, whatever the actor's history.
 */
export async function readParticipationSummary(
  db: Firestore,
  userId: string,
  nowMs: number,
): Promise<ParticipationSummary> {
  const [stats, window] = await Promise.all([
    readStats(db, userId),
    readActorMeterWindow(db, userId, nowMs, PARTICIPATION_WINDOW_DAYS),
  ]);
  const oldestDay = windowStartDay(nowMs, PARTICIPATION_WINDOW_DAYS);
  let month = 0;
  for (const [day, bucket] of Object.entries(stats.days)) {
    if (day >= oldestDay) month += bucket.n;
  }
  const rate = month > 0 ? Math.min(1, window.corroborated / month) : 0;
  return {
    pe_count_total: stats.pe_count,
    pe_count_this_month: month,
    corroboration_rate: Math.round(rate * 100) / 100,
    // No metered-time feature exists; retained for API compatibility.
    agent_hours_this_month: 0,
    agent_actions_this_month: window.agentActions,
    promises_kept: stats.by_type.promise_fulfilled ?? 0,
    foundation_member_since: stats.first_pe_at_ms,
  };
}

// =============================================================================
// DELETE /v1/user/data — the owner's per-actor meter state, by actor
// =============================================================================

const DELETE_PAGE = 300;

interface DeletableQuery {
  readonly query: Query;
  /** Keep a document the money path still needs (it is never deleted here). */
  readonly keep?: (data: Record<string, unknown>) => boolean;
}

/**
 * Would deleting this act key (or held act) risk earned PVT? An act whose row is `eligible` has
 * earnings not yet minted: a Genesis grant settles from a key kept until it mints, and a held act
 * waiting for its payee (`payee_*`) is earned work in escrow. Those stay — they
 * expire on their own (a minted act key 31 days after its mint). The pending claims themselves are
 * never touched here.
 */
export function rowHasUnmintedEarnings(row: unknown): boolean {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    && ['eligible', 'pending_compliance', 'deferred'].includes(String((row as Record<string, unknown>).mint_status));
}

async function deleteMatching(db: Firestore, spec: DeletableQuery): Promise<number> {
  let deleted = 0;
  const source = singleScanQuery(spec.query.orderBy(FieldPath.documentId()));
  let after: QueryDocumentSnapshot | null = null;
  for (;;) {
    let query = source.limit(DELETE_PAGE);
    if (after !== null) query = query.startAfter(after.id);
    const snap = await query.get();
    if (snap.empty) return deleted;
    const batch = db.batch();
    let staged = 0;
    for (const doc of snap.docs) {
      if (spec.keep?.(doc.data() as Record<string, unknown>) === true) continue;
      // Never delete a record changed since the traversal snapshot.
      batch.delete(doc.ref, ...(doc.updateTime ? [{ lastUpdateTime: doc.updateTime }] : []));
      staged += 1;
    }
    if (staged > 0) await batch.commit();
    deleted += staged;
    if (snap.size < DELETE_PAGE) return deleted;
    after = snap.docs[snap.docs.length - 1];
  }
}

/**
 * Delete the owner's per-actor meter state: its live act keys, held acts, mailbox items (to and
 * from it), identity acts and counterparty pairs — each found by an indexed equality on the
 * actor, never by a history scan. Earnings are kept: pending claims are not touched, and an act
 * key or held act whose row still carries unminted earnings stays (see `rowHasUnmintedEarnings`).
 */
export async function deleteOwnerMeterState(db: Firestore, userId: string): Promise<number> {
  const col = (name: string) => db.collection(name);
  const specs: DeletableQuery[] = [
    { query: col(METER_ACT_KEYS_COLLECTION).where('actor_id', '==', userId), keep: (d) => rowHasUnmintedEarnings(d.row) },
    {
      // : a batch's act page goes with its actor unless an act on it is still unminted.
      query: col(METER_BATCH_ACTS_COLLECTION).where('actor_id', '==', userId),
      keep: (d) => Object.values((d.acts ?? {}) as Record<string, { row?: unknown }>).some((a) => rowHasUnmintedEarnings(a.row)),
    },
    {
      query: col(METER_HELD_ACTS_COLLECTION).where('actor_id', '==', userId),
      keep: (d) => {
        const key = d.key as { row?: unknown } | undefined;
        return rowHasUnmintedEarnings(key?.row);
      },
    },
    { query: col(PE_MAILBOX_COLLECTION).where('to', '==', `human:${userId}`) },
    { query: col(PE_MAILBOX_COLLECTION).where('from_actor', '==', userId) },
    { query: col(IDENTITY_ACTS_COLLECTION).where('actor_id', '==', userId) },
    { query: col(COUNTERPARTY_PAIRS_COLLECTION).where('actor_id', '==', userId) },
  ];
  let total = 0;
  for (const spec of specs) total += await deleteMatching(db, spec);
  return total;
}

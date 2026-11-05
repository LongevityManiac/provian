/**
 * Trust Layer build §2.5 / backfill `actor_stats_v1` from the sealed `pe_history` ledger.
 *
 * The vocabulary is a LIVE query over per-actor counters the accrual bumps at every seal. PEs
 * sealed before that bump existed — and, since (actor-stats/v2), every PE's contribution to
 * the new fields (day buckets, attested measurements, chain-witnessed payment volume,
 * attested-only regions) — are folded in here, per actor, with the SAME pure fold the accrual uses
 * (`applyActorStatsBump`), so a backfilled actor's counters are what the live path would have
 * produced had it been running from the first PE. A backfilled document is marked
 * `history_complete: true`; until then an upgraded v1 document is unavailable to the vocabulary.
 *
 * Facts and their sources (metadata-only, §3):
 * - counts / family × class / continuity / day buckets ← pe_history (`actionType`, `category`,
 * `witness_class`, `timestamp`, `attestationDepth`); a legacy row with no `witness_class` but a
 * server-verified attestation is `relay_verified`, otherwise `actor_declared` (Unknown = Block).
 * - witnessed compute / independent origins ← the sealed `economic_snapshot.recordTimeFactors`
 * (`observedComputeTokens`, `independentOriginCount`); the declared figure is not on
 * pe_history and stays 0 for backfilled rows.
 * - composition ← the canonical `provenance_envelopes` doc — model FAMILY / environment class /
 * supervision turns from its `metadata` (or `action_report.metadata`) and `execution_env`.
 * - attested region / measurement ← the envelope's SEALED hardware-witness summary (the top-level
 * `hardware_witness` the action / work-product lanes store, else `metadata.hardware_witness`,
 * which the device / mobile / sovereign lanes seal after stripping any body copy), counted when the server-sealed summary says `admitted === true`, independently
 * of its pricing class. Actor-declared rows and raw action-report slots
 * never supply facts; legacy metadata fallback is limited to hardware_rooted rows.
 * - witnessed payment volume ← the envelope's `metadata.economic_evidence` under
 * `metadata.verified === true`, counted ONLY when the row's sealed `witness_class` is
 * `chain_witnessed` and the evidence passes `assertBaseUsdcTransferEvidence` (a legacy row with
 * no sealed class contributes nothing — Unknown = not counted).
 * - approvals_cited stays 0: `human_approval` is new in this build; no historical `pe:` edge
 * can resolve to one.
 *
 * SAFE AGAINST LIVE BUMPS (production-runnable): every live bump increments `pe_count` or, for a
 * chain-continuity record, `continuity_records` by exactly one and is the only
 * other writer of the document. Per actor the backfill (1) reads the live sequence
 * (`pe_count + continuity_records`) BEFORE reading the ledger, (2) folds the ledger, (3) writes in a
 * transaction that re-reads the sequence and writes ONLY if it is unchanged — so no bump landed during the fold; a
 * bump whose ledger row the fold did not see is therefore impossible to overwrite (the seal writes
 * pe_history BEFORE it bumps). The opposite race — a row the fold DID read whose bump lands after
 * the write — is closed by the fold's own coverage, written IN the document : the ids of
 * every folded row created (server `createTime`) inside {@link ACTOR_STATS_BUMP_MAX_LAG_MS}
 * (`fold_recent_pe_ids`) and the creation-time floor every other folded row sits below
 * (`fold_floor_ms`). A bump that finds its row covered skips (`countedByFold`). No marker document
 * per row is written, so an actor of ANY size folds in one write. That requires the live bump to
 * read the coverage, so RUN THIS ONLY AGAINST A RELAY WHOSE EVERY REVISION IS OR LATER. A moved count retries the actor (bounded); an actor that keeps moving is reported in
 * `actors_skipped_busy` and left untouched (re-run it). Do not run two backfills at once.
 *
 * Zero mint effect: this touches `actor_stats_v1` only — never pe_history, never a sealed PE.
 */
import { FieldPath } from 'firebase-admin/firestore';
import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  ACTOR_STATS_COLLECTION,
  ACTOR_STATS_APPLIED_COLLECTION,
  adverseDecisionNeedsEnvelope,
  applyActorStatsBump,
  deriveCompositionSignals,
  emptyActorStats,
  isContinuityStatsRow,
  serializeActorStats,
  type ActorStatsBump,
  type ActorStatsDoc,
  type CompositionSignals,
} from './actor-stats';
import { isWitnessClass, type WitnessClass } from './policy/evidence-class';

export interface ActorStatsBackfillOptions {
  readonly apply: boolean;
  /** Restrict to one actor (a `pe_history.userId`). */
  readonly actorId?: string | null;
  readonly pageSize?: number;
  readonly log?: (line: string) => void;
  /** Injectable clock (tests). */
  readonly nowMs?: () => number;
  /** Attempts per actor before it is reported busy (default 5). */
  readonly maxAttemptsPerActor?: number;
  /** Test seam: runs after an actor's fold and before its write transaction. */
  readonly afterFold?: (actorId: string, attempt: number) => Promise<void>;
}

/**
 * The longest a live bump can trail its `pe_history` write: both run inside the one sealing
 * request, which Cloud Run bounds at 3600 s (the service's request timeout), plus margin. A folded
 * row created (server `createTime`) inside this window may still have its bump in flight, so the
 * backfill marks it as counted in the SAME transaction as its write; the late bump then skips.
 */
export const ACTOR_STATS_BUMP_MAX_LAG_MS = 2 * 60 * 60 * 1000;

export interface ActorStatsBackfillSummary {
  readonly mode: 'dry_run' | 'apply';
  readonly actors_scanned: number;
  readonly pes_folded: number;
  readonly pes_skipped_no_actor: number;
  readonly envelopes_missing: number;
  readonly actors_written: number;
  readonly actors_refolded_after_live_bump: number;
  readonly actors_skipped_busy: readonly string[];
  /** Actors holding an adverse row whose envelope is missing — never rewritten. */
  readonly actors_undecidable: readonly string[];
  readonly per_actor: ReadonlyArray<{
    actor_id: string;
    pe_count: number;
    witnessed: number;
    first_pe_at_ms: number | null;
    day_buckets: number;
    measurements: number;
    payment_volume_atomic: string;
  }>;
}

interface PeHistoryRow {
  readonly peId?: unknown;
  readonly userId?: unknown;
  readonly timestamp?: unknown;
  readonly actionType?: unknown;
  readonly category?: unknown;
  readonly attestationDepth?: unknown;
  readonly attestation_verified?: unknown;
  readonly witness_class?: unknown;
  readonly economic_snapshot?: { recordTimeFactors?: { observedComputeTokens?: unknown; independentOriginCount?: unknown } } | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** The witness class a sealed pe_history row stands in (legacy rows: verified → relay, else declared). */
export function witnessClassOfHistoryRow(row: PeHistoryRow): WitnessClass {
  if (isWitnessClass(row.witness_class)) return row.witness_class;
  return row.attestation_verified === true ? 'relay_verified' : 'actor_declared';
}

/** Pure: the bump one pe_history row contributes (null when the row names no actor). */
export function bumpFromHistoryRow(row: PeHistoryRow, composition: CompositionSignals | null): ActorStatsBump | null {
  const actorId = str(row.userId);
  const actionType = str(row.actionType);
  if (actorId === null || actionType === null) return null;
  const factors = row.economic_snapshot?.recordTimeFactors ?? null;
  const observed = num(factors?.observedComputeTokens);
  const origins = num(factors?.independentOriginCount);
  return {
    actorId,
    peId: str(row.peId),
    actionType,
    family: str(row.category) ?? 'other',
    witnessClass: witnessClassOfHistoryRow(row),
    timestampMs: num(row.timestamp) ?? 0,
    attestationTier: str(row.attestationDepth),
    witnessObservedTokens: observed !== null && observed > 0 ? Math.floor(observed) : null,
    bodyDeclaredTokens: null,
    independentOriginCount: origins !== null && origins > 0 ? Math.floor(origins) : 0,
    approvalsCited: 0,
    composition,
    // a continuity record re-folds as continuity, exactly as the live seal folds it.
    ...(isContinuityStatsRow(row as unknown as Record<string, unknown>) ? { continuity: true } : {}),
  };
}

/**
 * Pure: the composition signals of one stored envelope, under the row's SEALED witness class. The
 * attested facts read the envelope's SEALED summary (top-level first — on the action / work-product
 * lanes `action_report.metadata.hardware_witness` is the client's raw slot and is never read).
 */
export function compositionFromEnvelope(envelope: unknown, witnessClass: WitnessClass): CompositionSignals | null {
  const d = rec(envelope) ?? {};
  const metadata = rec(d.metadata) ?? rec(rec(d.action_report)?.metadata) ?? {};
  const env = rec(d.execution_env);
  const sealed = witnessClass==='actor_declared'?null:rec(d.hardware_witness) ?? (witnessClass==='hardware_rooted'?rec(rec(d.metadata)?.hardware_witness):null);
  return deriveCompositionSignals(metadata, env, { witnessClass, sealedHardwareWitness: sealed });
}

/** Pure: fold rows (any order) into one actor's stats — the fold sorts by timestamp first. */
export function foldActorStats(
  actorId: string,
  rows: ReadonlyArray<{ row: PeHistoryRow; composition: CompositionSignals | null }>,
  nowMs: number,
): ActorStatsDoc {
  const ordered = [...rows].sort((a, b) => (num(a.row.timestamp) ?? 0) - (num(b.row.timestamp) ?? 0));
  let stats = emptyActorStats(actorId);
  for (const { row, composition } of ordered) {
    const bump = bumpFromHistoryRow(row, composition);
    if (bump === null || bump.actorId !== actorId) continue;
    stats = applyActorStatsBump(stats, bump, nowMs);
  }
  return stats;
}

async function readComposition(db: Firestore, peId: string, witnessClass: WitnessClass): Promise<{ composition: CompositionSignals | null; missing: boolean }> {
  const snap = await db.collection('provenance_envelopes').doc(peId).get();
  if (!snap.exists) return { composition: null, missing: true };
  return { composition: compositionFromEnvelope(snap.data(), witnessClass), missing: false };
}

interface ActorRow {
  readonly row: PeHistoryRow;
  /** The row's server-assigned creation time (Firestore metadata — never a client timestamp). */
  readonly createTimeMs: number | null;
}

async function readActorRows(db: Firestore, actorId: string, pageSize: number): Promise<ActorRow[]> {
  const rows: ActorRow[] = [];
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('pe_history').where('userId', '==', actorId).orderBy('timestamp', 'asc').limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    for (const doc of page.docs) {
      const ct = (doc as { createTime?: { toMillis?: () => number } }).createTime;
      rows.push({ row: doc.data() as PeHistoryRow, createTimeMs: typeof ct?.toMillis === 'function' ? ct.toMillis() : null });
    }
    if (page.docs.length < pageSize) break;
    cursor = page.docs[page.docs.length - 1];
  }
  return rows;
}

async function listActors(db: Firestore, pageSize: number, log: (l: string) => void): Promise<{ actors: string[]; skipped: number }> {
  const actors = new Set<string>();
  let skipped = 0;
  let cursor: QueryDocumentSnapshot | null = null;
  let scanned = 0;
  for (;;) {
    // Paginate by document id: a legacy row with no `timestamp` field must still be LISTED (and
    // is then excluded from the fold by the timestamp-ordered per-actor read, never crashing the scan).
    let q = db.collection('pe_history').orderBy(FieldPath.documentId(), 'asc').select('userId').limit(pageSize);
    if (cursor) q = q.startAfter(cursor);
    const page = await q.get();
    for (const doc of page.docs) {
      scanned += 1;
      const id = str((doc.data() as PeHistoryRow).userId);
      if (id === null) skipped += 1; else actors.add(id);
    }
    if (page.docs.length < pageSize) break;
    cursor = page.docs[page.docs.length - 1];
    if (scanned % (pageSize * 10) === 0) log(`scanned ${scanned} pe_history rows, ${actors.size} actors so far`);
  }
  return { actors: [...actors].sort(), skipped };
}

/** The live document's bump sequence: `pe_count + continuity_records` (-1 when there is no document). */
function liveSequence(raw: unknown, exists: boolean): number {
  if (!exists) return -1;
  const n = num(rec(raw)?.pe_count);
  // Every live bump moves exactly one of the two counts by one (: a continuity
  // record moves `continuity_records`, never `pe_count`), so their sum is the bump sequence.
  const c = num(rec(raw)?.continuity_records) ?? 0;
  return n === null ? -1 : n + c;
}

export async function backfillActorStats(db: Firestore, opts: ActorStatsBackfillOptions): Promise<ActorStatsBackfillSummary> {
  const log = opts.log ?? (() => undefined);
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 500, 2000));
  const now = opts.nowMs ?? (() => Date.now());
  const maxAttempts = Math.max(1, opts.maxAttemptsPerActor ?? 5);

  const actorList = opts.actorId ? { actors: [opts.actorId], skipped: 0 } : await listActors(db, pageSize, log);
  let pesFolded = 0;
  let envelopesMissing = 0;
  let written = 0;
  let refolded = 0;
  const busy: string[] = [];
  const undecidableActors: string[] = [];
  const perActor: Array<ActorStatsBackfillSummary['per_actor'][number]> = [];

  const foldActor = async (actorId: string): Promise<{ stats: ActorStatsDoc; rows: number; missing: number; recentPeIds: string[]; lagFloor: number; undecidable: string[] }> => {
    const actorRows = await readActorRows(db, actorId, pageSize);
    const rows = actorRows.map((r) => r.row);
    // Rows whose live bump may still be in flight (created inside the max bump lag, or with no
    // server createTime at all — Unknown = treated as in flight). Their markers ride the write.
    const lagFloor = now() - ACTOR_STATS_BUMP_MAX_LAG_MS;
    const recentPeIds = actorRows
      .filter((r) => r.createTimeMs === null || r.createTimeMs >= lagFloor)
      .map((r) => str(r.row.peId))
      .filter((id): id is string => id !== null);
    const withComposition: Array<{ row: PeHistoryRow; composition: CompositionSignals | null }> = [];
    let missing = 0;
    const undecidable = new Set<string>();
    for (const row of rows) {
      const peId = str(row.peId);
      const c = peId ? await readComposition(db, peId, witnessClassOfHistoryRow(row)) : { composition: null, missing: true };
      if (c.missing) missing += 1;
      // whether such a row counts against the actor is decided by its envelope. With the
      // envelope missing the answer is UNKNOWN, and an actor whose fold cannot be decided is NOT
      // rewritten (Unknown = block): the live document and its markers stay as they are.
      if (c.missing && adverseDecisionNeedsEnvelope(str(row.actionType))) undecidable.add(peId ?? '(no pe id)');
      withComposition.push({ row, composition: c.composition });
    }
    return { stats: foldActorStats(actorId, withComposition, now()), rows: rows.length, missing, recentPeIds, lagFloor, undecidable: [...undecidable] };
  };

  for (const actorId of actorList.actors) {
    const ref = db.collection(ACTOR_STATS_COLLECTION).doc(actorId);
    let done = false;
    for (let attempt = 1; attempt <= maxAttempts && !done; attempt += 1) {
      // (1) the live bump sequence BEFORE the ledger read …
      const before = await ref.get();
      const seq = liveSequence(before.data(), before.exists);
      // (2) … the fold …
      const folded = await foldActor(actorId);
      const { stats } = folded;
      if (attempt === 1 || !opts.apply) {
        pesFolded += folded.rows;
        envelopesMissing += folded.missing;
      }
      const witnessed = Object.entries(stats.by_family_class)
        .filter(([k]) => !k.endsWith('__actor_declared'))
        .reduce((a, [, v]) => a + v, 0);
      log(`${opts.apply ? 'WRITE' : 'dry'} ${actorId}: pe_count=${stats.pe_count} witnessed=${witnessed} active_days=${stats.active_days} streak=${stats.streak_days} day_buckets=${Object.keys(stats.days).length} measurements=${Object.keys(stats.measurements).length} payment_volume_atomic=${stats.payment_volume_atomic}`);
      const summaryRow = {
        actor_id: actorId,
        pe_count: stats.pe_count,
        witnessed,
        first_pe_at_ms: stats.first_pe_at_ms,
        day_buckets: Object.keys(stats.days).length,
        measurements: Object.keys(stats.measurements).length,
        payment_volume_atomic: stats.payment_volume_atomic,
      };
      if (folded.undecidable.length > 0) {
        undecidableActors.push(actorId);
        log(`UNDECIDABLE ${actorId}: ${folded.undecidable.length} adverse row(s) have no envelope (${folded.undecidable.slice(0, 5).join(', ')}) — left untouched`);
        done = true;
        break;
      }
      if (!opts.apply) { perActor.push(summaryRow); done = true; break; }
      if (opts.afterFold) await opts.afterFold(actorId, attempt);
      // (3) … written ONLY if no live bump landed since (1). What the fold covered rides the SAME
      // write : the ids of every folded row whose seal-time bump may still be in flight, and
      // the creation-time floor every other folded row sits below. A late bump — or the Standing
      // reconcile — for a row this fold counted then skips (`countedByFold`), with no marker
      // document per row, so an actor of any size folds in one write.
      const outcome = await db.runTransaction(async (txn) => {
        const live = await txn.get(ref);
        if (liveSequence(live.data(), live.exists) !== seq) return 'moved' as const;
        txn.set(ref, serializeActorStats({
          ...stats,
          history_complete: true,
          fold_floor_ms: folded.lagFloor,
          fold_recent_pe_ids: folded.recentPeIds,
          updated_at_ms: now(),
        }));
        return 'written' as const;
      });
      if (outcome === 'written') {
        perActor.push(summaryRow);
        written += 1;
        done = true;
      } else {
        refolded += 1;
        log(`moved ${actorId}: a live bump landed during the fold — re-folding (attempt ${attempt}/${maxAttempts})`);
      }
    }
    if (!done) {
      busy.push(actorId);
      log(`BUSY ${actorId}: still moving after ${maxAttempts} attempts — left untouched; re-run with --actor ${actorId}`);
    }
  }

  return {
    mode: opts.apply ? 'apply' : 'dry_run',
    actors_scanned: actorList.actors.length,
    pes_folded: pesFolded,
    pes_skipped_no_actor: actorList.skipped,
    envelopes_missing: envelopesMissing,
    actors_written: written,
    actors_refolded_after_live_bump: refolded,
    actors_skipped_busy: busy,
    actors_undecidable: undecidableActors,
    per_actor: perActor,
  };
}

// =============================================================================
// Standing reconcile — RETIRED by the PE meter
// =============================================================================
//
// `reconcileAdverseStanding` re-read every adverse-type `pe_history` row of the last 30 days to
// repair an `actor_stats_v1` bump lost between a row's seal and its separate, best-effort bump.
// Under the meter there is no such gap: the batch commit (`core/meter/meter-commit.ts`) applies
// each fresh act's stats bump IN THE SAME TRANSACTION as its act key, so an adverse act is counted
// exactly when it exists. A sweep whose only job was to recompute totals from history is obsolete;
// it is retired rather than ported (there is no history left to read).

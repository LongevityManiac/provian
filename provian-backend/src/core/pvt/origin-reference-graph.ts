import { singleScanQuery, visitQueryDocuments } from '../provenance/private-store';
import { privateRetentionCollection,protectedRetentionId } from '../provenance/private-retention';
/**
 * origin-reference-graph — the persistent origin edge store (, Prompt 3; Trust Layer build
 * 2026-09-16 §2.1/§2.4: ONE graph, forward AND reverse).
 *
 * Every PE records one edge per `input_origin` `signer → owner`, tagged with what the mint decided
 * (witnessed / counted / reason), INCLUDING `witnessed:false` and unresolved-owner edges. It exists
 * for presentation, incident tracing, the closed-loop detector, and the reputation vocabulary. It
 * is the LOAD-BEARING piece: it cannot be added retroactively, so it runs from envelope one.
 *
 * §2.1 — a `pe:` origin is a CONSUMPTION edge: the citer built on the cited PE's output. Such an
 * edge additionally carries `cited_pe_id` / `cited_signer` / `cited_action_type` and its owner is
 * `signer:<cited signer>`, so the same store answers the REVERSE questions (§2.4) by index, not by
 * scan: "who cited this actor's outputs" = `where owner == signer:<actor>`; "who cited this PE" =
 * `where cited_pe_id == <pe>`. `closed_loop` is materialized so consumption counts can exclude
 * ring-flagged edges with a plain equality filter.
 *
 * Edges are idempotent (a deterministic doc id over the PE + origin), so a replay of the same PE
 * overwrites identically and never duplicates.
 *
 * PE METER (, ruling item 7: per actor the relay keeps "citation relationships as
 * per-pair counts", never edges). An edge now lives as long as the act's keys — 31 days, a Firestore
 * TTL on the Timestamp `expire_at` and every edge is FOLDED, exactly once, into one permanent
 * per-(signer, owner) count document (`meter_pair_counts_v1`, `cite_…`). Everything that must see an
 * actor's whole citation history (the closed-loop detector's out-edges, the vocabulary's Coupling
 * and Consumption, the ops reverse index) reads the counts, which grow with relationships and never
 * with history. The 31-day edges remain for incident tracing and the ops window.
 *
 * SIGNED CONSUMPTION : a citation counts toward the producer's Consumption only
 * when it carries the producer's signature over the output's hash — an `out:<address>` edge whose
 * signature the relay recovered at intake (`output-citation.ts`). A declared `pe:` citation is
 * unsigned: it still records (its pair's `edges`, and `cite_unsigned`) and still carries the
 * Accountability counts for a cited `human_approval`, but it never adds to `pe_consumption`. Pairs
 * folded before this rule keep the counts they were folded with (history is never re-counted).
 *
 * Exactly once: on the meter path the edges and their counts are written by the BATCH commit, only
 * for an act whose key that commit creates (a retried batch re-prices nothing it already counted);
 * on the legacy accrual path `recordOriginEdges` folds only edges its transaction finds absent.
 * Edges written before this change are folded by `foldUnfoldedOriginEdges`
 * (`scripts/origin-pair-counts-backfill.ts`), which then opens the gate the readers check
 * (`citationPairCountsReady`); until it is open, readers keep reading the edges, so no reader ever
 * sees a partial history.
 */

import { FieldPath, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { createHash } from 'crypto';
import type { OriginNotCountedReason, SealedOriginRef } from './origin-independence';
import {
  expireAt,
  METER_KEY_LIFETIME_MS,
  METER_PAIR_COUNTS_COLLECTION,
} from '../meter/meter-store';

export const ORIGIN_REFERENCE_GRAPH_COLLECTION = 'origin_reference_graph_v1';
const SCHEMA = 'origin-reference-graph-edge/v1';

/** An edge lives exactly as long as an act key (31 days past its record time). */
export const ORIGIN_EDGE_LIFETIME_MS = METER_KEY_LIFETIME_MS;
/** The permanent per-(signer, owner) citation counts (ruling item 7). */
export const CITATION_PAIR_COUNTS_COLLECTION = METER_PAIR_COUNTS_COLLECTION;
/** The one-shot state of the edge → count fold (`foldUnfoldedOriginEdges`). */
export const CITATION_PAIR_COUNTS_STATE_COLLECTION = 'meter_pair_counts_state_v1';
export const CITATION_PAIR_COUNTS_STATE_DOC = 'citation_backfill';

/** One recorded citation edge: this PE's signer cited an origin owned by `owner`. */
export interface OriginEdge {
  readonly schema_version: typeof SCHEMA;
  readonly signer: string;
  /** The resolved owner party, or null when no resolver mapped it (still recorded). */
  readonly owner: string | null;
  readonly origin_identifier: string;
  readonly hash: string;
  readonly witnessed: boolean;
  readonly counted: boolean;
  readonly pe_id: string;
  readonly recorded_at_ms: number;
  // --- Trust Layer build (§2.1) additions. Absent on edges written before the build. ---
  /** The origin scheme (`pe`, `evm`, `domain`, `repo`, `doi`, `pkg`, `commit`, `private`, ...). */
  readonly scheme?: string;
  /** Why the edge was not counted; null when counted. */
  readonly reason?: OriginNotCountedReason | null;
  /** True iff the closed-loop detector flagged this edge's owner as a ring member. */
  readonly closed_loop?: boolean;
  /** `pe:` edges only — the cited PE and its signer/type (the reverse-index keys). */
  readonly cited_pe_id?: string;
  readonly cited_signer?: string;
  readonly cited_action_type?: string;
  // --- PE meter additions. Absent on edges written before the meter's cost pass. ---
  /** TTL (Firestore Timestamp): record time + 31 days. */
  readonly expire_at?: FirebaseFirestore.Timestamp;
  /** True once this edge has been added to its pair's counts (exactly once). */
  readonly pair_folded?: boolean;
}

/** Deterministic, idempotent edge id: a replay of the same PE's origin overwrites identically. */
export function legacyOriginEdgeId(peId: string, originIdentifier: string, hash: string): string {
  const digest = createHash('sha256')
    .update(`${peId} ${originIdentifier} ${hash}`)
    .digest('hex')
    .slice(0, 32);
  return `edge_${digest}`;
}

export function originEdgeId(peId: string, originIdentifier: string, hash: string): string {
 return legacyOriginEdgeId(peId,originIdentifier,hash);
}

/** The origin scheme of an identifier (`pe:x` → `pe`; a private tag → `private`; else `other`). */
export function originScheme(originIdentifier: string): string {
  if (originIdentifier.startsWith('private_')) return 'private';
  const i = originIdentifier.indexOf(':');
  if (i <= 0) return 'other';
  const s = originIdentifier.slice(0, i).toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(s) ? s : 'other';
}

/** Per-origin citation detail the orchestrator resolved for a `pe:` origin (keyed by identifier). */
export interface CitedPeDetail {
  readonly citedPeId: string;
  readonly citedSigner: string;
  readonly citedActionType: string;
}

/** Build (never write) the edges one PE records: one per sealed origin. */
export function buildOriginEdges(params: {
  signer: string;
  peId: string;
  origins: readonly SealedOriginRef[];
  nowMs: number;
  citedPeDetail?: ReadonlyMap<string, CitedPeDetail>;
}): OriginEdge[] {
  return params.origins.map((o) => {
    const cited = params.citedPeDetail?.get(o.origin_identifier);
    return {
      schema_version: SCHEMA,
      signer: params.signer,
      owner: o.owner,
      origin_identifier: o.origin_identifier,
      hash: o.hash,
      witnessed: o.witnessed,
      counted: o.counted,
      pe_id: params.peId,
      recorded_at_ms: params.nowMs,
      scheme: originScheme(o.origin_identifier),
      reason: o.reason,
      closed_loop: o.reason === 'closed_loop',
      ...(cited
        ? {
          cited_pe_id: cited.citedPeId,
          cited_signer: cited.citedSigner,
          cited_action_type: cited.citedActionType,
        }
        : {}),
    };
  });
}

/** The doc id of an edge (deterministic over the PE + origin). */
export function edgeDocId(edge: Pick<OriginEdge, 'pe_id' | 'origin_identifier' | 'hash'>): string {
  return originEdgeId(edge.pe_id, edge.origin_identifier, edge.hash);
}

// ---------------------------------------------------------------------------
// Per-pair citation counts (ruling item 7)
// ---------------------------------------------------------------------------

type CitationCounter = 'edges' | 'counted' | 'witnessed' | 'pe_consumption' | 'pe_ring_excluded' | 'pe_unwitnessed'
  | 'pe_approvals_cited' | 'pe_approvals_cited_witnessed' | 'cite_unsigned';
export type CitationIncrements = Readonly<Record<CitationCounter, number>>;

/** One (signer, owner) citation relationship: counts only, never an edge. */
export interface CitationPairCounts extends CitationIncrements {
  readonly kind: 'citation';
  readonly signer: string;
  readonly owner: string;
  readonly last_at_ms: number;
}
// Counter meanings: `edges` every edge signer → owner; `counted` edges that counted toward
// independence; `witnessed` edges a non-actor witnessed (counted from 2026-10-04: pairs folded
// earlier carry no `witnessed` count for those edges); `pe_consumption` / `pe_ring_excluded` / `pe_unwitnessed` / `pe_approvals_cited` the
// citation edges `summarizeConsumption` counts in each bucket (`pe_consumption` = SIGNED `out:`
// citations only, from 2026-10-04); `pe_approvals_cited_witnessed` the edges
// `countHumanApprovalsCited` counts for the CITER; `cite_unsigned` the witnessed, resolved,
// non-ring, non-self citations that carried no producer signature (declared `pe:`) — recorded,
// never Consumption.

const COUNTERS: readonly CitationCounter[] = ['edges', 'counted', 'witnessed', 'pe_consumption', 'pe_ring_excluded',
  'pe_unwitnessed', 'pe_approvals_cited', 'pe_approvals_cited_witnessed', 'cite_unsigned'];

function zeroIncrements(): Record<CitationCounter, number> {
  return {
    edges: 0, counted: 0, witnessed: 0, pe_consumption: 0, pe_ring_excluded: 0, pe_unwitnessed: 0,
    pe_approvals_cited: 0, pe_approvals_cited_witnessed: 0, cite_unsigned: 0,
  };
}

/** The citation schemes: a declared `pe:` citation and a SIGNED `out:` citation. */
function isCitationScheme(scheme: string | undefined): boolean {
  return scheme === 'pe' || scheme === 'out';
}

/** Pair-count doc id for (signer, owner). Hashed: an owner may hold any character. */
export function legacyCitationPairId(signer:string,owner:string):string {
 return `cite_${createHash('sha256').update(`${signer}\n${owner}`).digest('hex').slice(0,40)}`;
}
export function citationPairId(signer:string,owner:string):string {
 const id=legacyCitationPairId(signer,owner);
 return id;
}

/**
 * What ONE edge adds to its pair's counts — the exact per-edge rules of `summarizeConsumption`
 * (in-edges) and `countHumanApprovalsCited` (out-edges), so a summary over counts equals the
 * summary over the edges they were folded from. Null for an edge with no resolved owner (no
 * reader keys on it).
 */
export function citationIncrementsOf(edge: Pick<OriginEdge, 'owner' | 'counted' | 'scheme' | 'cited_action_type'
  | 'closed_loop' | 'reason' | 'witnessed'>): CitationIncrements | null {
  if (typeof edge.owner !== 'string' || edge.owner.length === 0) return null;
  const inc = zeroIncrements();
  inc.edges = 1;
  inc.counted = edge.counted === true ? 1 : 0;
  inc.witnessed = edge.witnessed === true ? 1 : 0;
  if (!isCitationScheme(edge.scheme)) return inc;
  if (edge.scheme === 'pe' && edge.cited_action_type === 'human_approval') {
    inc.pe_approvals_cited = 1;
    if (edge.witnessed === true && edge.reason !== 'closed_loop' && edge.reason !== 'unresolvable_owner') {
      inc.pe_approvals_cited_witnessed = 1;
    }
  }
  if (edge.closed_loop === true || edge.reason === 'closed_loop') {
    inc.pe_ring_excluded = 1;
    return inc;
  }
  if (edge.reason === 'same_party' || edge.reason === 'owner_set_unresolvable' || edge.reason === 'unresolvable_owner') return inc;
  if (edge.witnessed !== true) {
    inc.pe_unwitnessed = 1;
    return inc;
  }
  if (edge.reason !== 'consumption_edge' && edge.reason !== 'migrated_citation') return inc;
  // only a citation carrying the producer's verified signature is Consumption.
  if (edge.scheme === 'out') inc.pe_consumption = 1;
  else inc.cite_unsigned = 1;
  return inc;
}

export interface FoldedCitationPair {
  readonly signer: string;
  readonly owner: string;
  readonly inc: CitationIncrements;
  readonly lastAtMs: number;
}

/** Sum edges' increments per pair (one write per pair, however many edges). */
export function foldCitationIncrements(edges: readonly OriginEdge[]): Map<string, FoldedCitationPair> {
  const out = new Map<string, FoldedCitationPair>();
  for (const edge of edges) {
    const inc = citationIncrementsOf(edge);
    if (inc === null) continue;
    const owner = edge.owner as string;
    const id = citationPairId(edge.signer, owner);
    const prior = out.get(id);
    const sum = zeroIncrements();
    for (const k of COUNTERS) sum[k] = (prior?.inc[k] ?? 0) + inc[k];
    out.set(id, { signer: edge.signer, owner, inc: sum, lastAtMs: Math.max(prior?.lastAtMs ?? 0, edge.recorded_at_ms) });
  }
  return out;
}

/** Anything that can `set` a document (a Transaction or a WriteBatch). */
export interface DocWriter {
  set(ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData, options: FirebaseFirestore.SetOptions): unknown;
  set(ref: FirebaseFirestore.DocumentReference, data: FirebaseFirestore.DocumentData): unknown;
}

/** Stage the pair increments of `edges` (merge + FieldValue.increment: no read). Returns pairs written. */
export function stageCitationPairIncrements(writer: DocWriter, db: Firestore, edges: readonly OriginEdge[]): number {
  let n = 0;
  for (const [id, pair] of foldCitationIncrements(edges)) {
    const data: Record<string, unknown> = {
      kind: 'citation', signer: pair.signer, owner: pair.owner, last_at_ms: pair.lastAtMs,
    };
    for (const k of COUNTERS) data[k] = FieldValue.increment(pair.inc[k]);
    // The indexed marker the ops ring read filters on (the counters themselves are not indexed).
    if (pair.inc.pe_ring_excluded > 0) data.ring_flagged = true;
    writer.set(privateRetentionCollection(db,CITATION_PAIR_COUNTS_COLLECTION).doc(id), data, { merge: true });
    n += 1;
  }
  return n;
}

/** The edge doc as written: with its 31-day TTL and, when its counts commit with it, folded. */
export function edgeDocOf(edge: OriginEdge, folded: boolean): OriginEdge {
  return { ...edge, expire_at: expireAt(edge.recorded_at_ms + ORIGIN_EDGE_LIFETIME_MS), pair_folded: folded };
}

/**
 * Stage new edges' pair counts — and only their counts (PE meter cost pass, 2026-10-04). ONLY for
 * edges the caller knows are new (the meter batch commit stages the edges of acts whose keys it is
 * creating), so each counts exactly once. No edge document is written: every reader of an actor's
 * citation history reads the per-pair counts (the gate `citationPairCountsReady` is open and never
 * closes), the closed-loop walk sees the batch's own edges in memory (`BatchOriginEdges`), and the
 * ops panel reads the counts — so a per-act edge document served no guard and cost a write per
 * origin plus its expiry.
 */
export function stageNewOriginEdges(writer: DocWriter, db: Firestore, edges: readonly OriginEdge[]): void {
  stageCitationPairIncrements(writer, db, edges);
}

/**
 * Record every origin edge for a PE (the legacy, non-meter accrual path). Idempotent: its
 * transaction writes and counts only the edges it finds absent, so a replay neither duplicates an
 * edge nor counts it twice. Never throws into the accrual seal (the caller catches) — a graph-write
 * failure must not fail the mint. Returns the count of edges the PE carries.
 *
 * A store without transactions (a unit-test fake) writes the edges unfolded; the fold sweep
 * (`foldUnfoldedOriginEdges`) counts them.
 */
export async function recordOriginEdges(
  db: Firestore,
  params: {
    signer: string;
    peId: string;
    origins: readonly SealedOriginRef[];
    nowMs: number;
    /** §2.1: cited-PE detail per `pe:` identifier (absent for every other scheme). */
    citedPeDetail?: ReadonlyMap<string, CitedPeDetail>;
  },
): Promise<number> {
  if (params.origins.length === 0) return 0;
  const edges = buildOriginEdges(params);
  const col = privateRetentionCollection(db, ORIGIN_REFERENCE_GRAPH_COLLECTION);
  if (typeof (db as { runTransaction?: unknown }).runTransaction !== 'function') {
    const batch = db.batch();
    for (const edge of edges) batch.set(col.doc(edgeDocId(edge)), edgeDocOf(edge, false));
    await batch.commit();
    return edges.length;
  }
  return db.runTransaction(async (txn) => {
    const refs = edges.map((edge) => col.doc(edgeDocId(edge)));
    const snaps = await Promise.all(refs.map((ref) => txn.get(ref)));
    const legacy = await Promise.all(edges.map(edge => txn.get(col.doc(legacyOriginEdgeId(edge.pe_id,edge.origin_identifier,edge.hash)))));
    // This (non-meter) path's exactly-once rests on the edge document existing, so it keeps writing
    // it, folded, beside the counts.
    const absent = edges.filter((_, i) => !snaps[i].exists && !legacy[i].exists);
    for (const edge of absent) txn.set(col.doc(edgeDocId(edge)), edgeDocOf(edge, true));
    stageCitationPairIncrements(txn, db, absent);
    return edges.length;
  });
}

// ---------------------------------------------------------------------------
// Readers over the counts (gated on the fold of pre-existing edges)
// ---------------------------------------------------------------------------

let pairCountsReadyCache = false;

/** Test-only: forget the in-process gate cache. */
export function resetCitationPairGateForTests(): void {
  pairCountsReadyCache = false;
}

/**
 * True once every edge written before the counts existed has been folded into them
 * (`foldUnfoldedOriginEdges` opens it). Until then a reader of an actor's whole citation history
 * keeps reading the edges, so it never sees a partial history. Cached in-process once open (it
 * never closes). A failed read answers false (the edge read is the conservative, complete path).
 */
export async function citationPairCountsReady(db: Firestore): Promise<boolean> {
  if (pairCountsReadyCache) return true;
  try {
    const snap = await db.collection(CITATION_PAIR_COUNTS_STATE_COLLECTION).doc(CITATION_PAIR_COUNTS_STATE_DOC).get();
    const ready = snap.exists && (snap.data() as { complete?: unknown } | undefined)?.complete === true;
    if (ready) pairCountsReadyCache = true;
    return ready;
  } catch {
    return false;
  }
}

/** A page of pair-count documents matching one equality, paged by document id. */
async function readPairsWhere(
  db: Firestore,
  field: 'signer' | 'owner',
  value: string,
  limit: number,
): Promise<CitationPairCounts[]> {
  const out: CitationPairCounts[] = [];
  const source = singleScanQuery(privateRetentionCollection(db, CITATION_PAIR_COUNTS_COLLECTION)
    .where(field, '==', value).orderBy(FieldPath.documentId()));
  let lastId: string | null = null;
  while (out.length < limit) {
    const want = Math.min(OUT_EDGE_PAGE_SIZE, limit - out.length);
    let query = source.limit(want);
    if (lastId !== null) query = query.startAfter(lastId);
    const snap = await query.get();
    for (const doc of snap.docs) out.push(doc.data() as CitationPairCounts);
    if (snap.size < want) break;
    const nextId = snap.docs[snap.docs.length - 1].id;
    if (nextId === lastId) throw new Error(`citation_pair_cursor_not_advancing at ${nextId}`);
    lastId = nextId;
  }
  return out;
}

/** Most distinct owners one signer's out-pairs are read for (relationships, not history). */
export const PAIR_READ_LIMIT = 100_000;

/**
 * The distinct owners a signer has cited and whether each was ever counted — from its pair counts,
 * which grow with relationships, never with history. Identical to `readSignerOutEdges` over the
 * same history (every non-null-owner edge was folded into exactly one pair).
 */
export async function readSignerOutPairs(db: Firestore, signer: string): Promise<SignerOutEdges> {
  const pairs = await readPairsWhere(db, 'signer', signer, PAIR_READ_LIMIT);
  const owners = new Map<string, boolean>();
  let totalEdges = 0;
  for (const p of pairs) {
    if (typeof p.owner !== 'string' || p.owner.length === 0) continue;
    owners.set(p.owner, (owners.get(p.owner) ?? false) || Number(p.counted ?? 0) > 0);
    totalEdges += Number(p.edges ?? 0);
  }
  return { signer, owners, totalEdges };
}

/** The citing signer's out-edges for an actor's whole history: counts once folded, else edges. */
export async function readSignerCitedOwners(db: Firestore, signer: string): Promise<SignerOutEdges> {
  return (await citationPairCountsReady(db)) ? readSignerOutPairs(db, signer) : readSignerOutEdges(db, signer);
}

/** Summarize an actor's in-pairs exactly as `summarizeConsumption` summarizes the in-edges. */
export function summarizeConsumptionFromPairs(pairs: readonly CitationPairCounts[], limit: number = REVERSE_READ_LIMIT): ConsumptionSummary {
  let consumers = 0;
  let consumptionEdges = 0;
  let ringExcluded = 0;
  let unwitnessed = 0;
  let unsigned = 0;
  let ownApprovalsCited = 0;
  for (const p of pairs) {
    const consumption = Number(p.pe_consumption ?? 0);
    if (consumption > 0) consumers += 1;
    consumptionEdges += consumption;
    ringExcluded += Number(p.pe_ring_excluded ?? 0);
    unwitnessed += Number(p.pe_unwitnessed ?? 0);
    unsigned += Number(p.cite_unsigned ?? 0);
    ownApprovalsCited += Number(p.pe_approvals_cited ?? 0);
  }
  return {
    independent_consumers: consumers,
    consumption_edges: consumptionEdges,
    ring_excluded_edges: ringExcluded,
    unwitnessed_edges: unwitnessed,
    unsigned_edges: unsigned,
    own_approvals_cited: ownApprovalsCited,
    truncated: pairs.length >= limit,
  };
}

/**
 * "Who built on this actor's outputs" over its whole history: from its in-pairs once the fold is
 * complete (bounded by distinct citers), else from the in-edges (the pre-meter read).
 */
export async function readActorConsumption(
  db: Firestore,
  actorId: string,
  limit: number = REVERSE_READ_LIMIT,
): Promise<ConsumptionSummary> {
  if (await citationPairCountsReady(db)) {
    return summarizeConsumptionFromPairs(await readPairsWhere(db, 'owner', `signer:${actorId}`, limit), limit);
  }
  return summarizeConsumption(await readOwnerInEdges(db, actorId, limit), limit);
}

// ---------------------------------------------------------------------------
// The one-shot fold of pre-existing edges (run by scripts/origin-pair-counts-backfill.ts)
// ---------------------------------------------------------------------------

export interface FoldReport {
  readonly scanned: number;
  readonly folded: number;
  readonly alreadyFolded: number;
  readonly ttlStamped: number;
}

/**
 * Fold every edge not yet counted into its pair (one transaction per page: re-read each edge,
 * count only those still unfolded, mark them folded), then open the reader gate, then stamp the
 * 31-day TTL on every edge that lacks one. The TTL is stamped only AFTER the gate opens, so an
 * edge a gated-off reader still needs is never expired out from under it. Idempotent and
 * resumable: a re-run counts nothing twice.
 */
export async function foldUnfoldedOriginEdges(
  db: Firestore,
  options: { readonly pageSize?: number; readonly nowMs: number; readonly log?: (m: string) => void },
): Promise<FoldReport> {
  const pageSize = options.pageSize ?? 200;
  const log = options.log ?? (() => {});
  let scanned = 0;
  let folded = 0;
  let alreadyFolded = 0;
  let after: string | null = null;
  let source = singleScanQuery(privateRetentionCollection(db, ORIGIN_REFERENCE_GRAPH_COLLECTION).orderBy(FieldPath.documentId()));
  for (;;) {
    let query = source.limit(pageSize);
    if (after !== null) query = query.startAfter(after);
    const page = await query.get();
    if (page.empty) break;
    const lastId: string = page.docs[page.docs.length - 1].id;
    if (lastId === after) throw new Error(`origin_edge_fold_cursor_not_advancing at ${lastId}`);
    after = lastId;
    scanned += page.size;
    const candidates = page.docs
      .filter((d) => (d.data() as OriginEdge).pair_folded !== true)
      .map((d) => privateRetentionCollection(db, ORIGIN_REFERENCE_GRAPH_COLLECTION).doc(d.id));
    alreadyFolded += page.size - candidates.length;
    if (candidates.length > 0) {
      folded += await db.runTransaction(async (txn) => {
        const snaps = await Promise.all(candidates.map((ref) => txn.get(ref)));
        const fresh = candidates
          .map((ref, i) => ({ ref, snap: snaps[i] }))
          .filter(({ snap }) => snap.exists && (snap.data() as OriginEdge).pair_folded !== true);
        stageCitationPairIncrements(txn, db, fresh.map(({ snap }) => snap.data() as OriginEdge));
        for (const { ref } of fresh) txn.set(ref, { pair_folded: true }, { merge: true });
        return fresh.length;
      });
    }
    log(`[pair-counts] scanned ${scanned}, folded ${folded}`);
    if (page.size < pageSize) break;
  }
  await db.collection(CITATION_PAIR_COUNTS_STATE_COLLECTION).doc(CITATION_PAIR_COUNTS_STATE_DOC)
    .set({ complete: true, completed_at_ms: options.nowMs, edges_folded: folded }, { merge: true });
  let ttlStamped = 0;
  after = null;
  // A fresh traversal observes the completed fold before TTL stamping.
  source = singleScanQuery(privateRetentionCollection(db, ORIGIN_REFERENCE_GRAPH_COLLECTION).orderBy(FieldPath.documentId()));
  for (;;) {
    let query = source.limit(pageSize);
    if (after !== null) query = query.startAfter(after);
    const page = await query.get();
    if (page.empty) break;
    const lastId: string = page.docs[page.docs.length - 1].id;
    if (lastId === after) throw new Error(`origin_edge_ttl_cursor_not_advancing at ${lastId}`);
    after = lastId;
    const batch = db.batch();
    let n = 0;
    for (const d of page.docs) {
      const e = d.data() as OriginEdge;
      if (e.expire_at !== undefined || typeof e.recorded_at_ms !== 'number') continue;
      batch.set(privateRetentionCollection(db, ORIGIN_REFERENCE_GRAPH_COLLECTION).doc(d.id), { expire_at: expireAt(e.recorded_at_ms + ORIGIN_EDGE_LIFETIME_MS) }, { merge: true });
      n += 1;
    }
    if (n > 0) await batch.commit();
    ttlStamped += n;
    if (page.size < pageSize) break;
  }
  log(`[pair-counts] gate open; ${ttlStamped} pre-existing edge(s) given their 31-day TTL`);
  return { scanned, folded, alreadyFolded, ttlStamped };
}

/** The distinct owners a signer has cited (its out-edges), and whether each was counted. */
export interface SignerOutEdges {
  readonly signer: string;
  /** owner party → true if ANY edge to it was counted (a real independent citation). */
  readonly owners: ReadonlyMap<string, boolean>;
  /** Total edges (including unresolved/unwitnessed). */
  readonly totalEdges: number;
}

/**
 * Page size for the out-edge walk. The walk folds each page into the owner map and drops it, so
 * the heap held is one page of two-field projections, never the signer's whole edge history.
 */
export const OUT_EDGE_PAGE_SIZE = 1000;

/**
 * Read a signer's out-edges from the graph — the citing side the detector walks.
 *
 * Paged and PROJECTED to the two fields it folds (`owner`, `counted`). It used to read every edge
 * the signer ever wrote as a full document in one `get()`: on 2026-09-24 one signer held 18,411
 * edges (22 distinct owners), so one read held ~47 MB of heap for 12.7 s, and it runs on every
 * origin-bearing PE submission — a few concurrent submissions exhausted the relay's ~259 MB heap
 * (12 OOM crashes in 24 h). Same result, bounded memory.
 */
export async function readSignerOutEdges(db: Firestore, signer: string): Promise<SignerOutEdges> {
  const owners = new Map<string, boolean>();
  let totalEdges = 0;
  await visitQueryDocuments(privateRetentionCollection(db, ORIGIN_REFERENCE_GRAPH_COLLECTION)
    .where('signer', '==', signer).orderBy(FieldPath.documentId()).select('owner', 'counted'), (doc) => {
      const e = doc.data() as Pick<OriginEdge, 'owner' | 'counted'>;
      if (typeof e.owner === 'string' && e.owner.length > 0) {
        owners.set(e.owner, (owners.get(e.owner) ?? false) || e.counted === true);
      }
      totalEdges += 1;
    });
  return { signer, owners, totalEdges };
}

// ---------------------------------------------------------------------------
// §2.4 — the REVERSE index. Indexed equality reads, never a collection scan.
// ---------------------------------------------------------------------------

/** Default page for reverse reads (a presentation never needs the whole in-edge history). */
export const REVERSE_READ_LIMIT = 2000;

/** Every edge whose OWNER is this signer — "who cited this actor's outputs". */
export async function readOwnerInEdges(
  db: Firestore,
  signerId: string,
  limit: number = REVERSE_READ_LIMIT,
): Promise<OriginEdge[]> {
  const snap = await privateRetentionCollection(db, ORIGIN_REFERENCE_GRAPH_COLLECTION)
    .where('owner', '==', `signer:${signerId}`)
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data() as OriginEdge);
}

/** Every edge that cites this PE — "who cited this PE". */
export async function readPeInEdges(
  db: Firestore,
  peId: string,
  limit: number = REVERSE_READ_LIMIT,
): Promise<OriginEdge[]> {
  const snap = await privateRetentionCollection(db, ORIGIN_REFERENCE_GRAPH_COLLECTION)
    .where('cited_pe_id', '==', peId)
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data() as OriginEdge);
}

/** The vocabulary's Consumption + Accountability inputs for one actor, from the reverse index. */
export interface ConsumptionSummary {
  /** Distinct INDEPENDENT signers who built on this actor's outputs (witnessed, not ring-flagged). */
  readonly independent_consumers: number;
  /** Count of such consumption edges. */
  readonly consumption_edges: number;
  /** Edges excluded because the detector flagged them `closed_loop`. */
  readonly ring_excluded_edges: number;
  /** Edges recorded but not witnessed (a body claim with no non-actor witness) — recorded, not counted. */
  readonly unwitnessed_edges: number;
  /** Citations that carried no producer signature (declared `pe:`) — recorded, never Consumption. */
  readonly unsigned_edges: number;
  /** In-edges citing one of THIS actor's `human_approval` PEs (a human's approvals being built on). */
  readonly own_approvals_cited: number;
  /** True when the read hit the page limit (counts are a lower bound). */
  readonly truncated: boolean;
}

/**
 * Summarize this actor's in-edges. A consumption edge counts iff it is a SIGNED `out:` citation
 *, witnessed by the producer's recovered signature, and not ring-flagged
 * (`closed_loop` true edges are EXCLUDED — the operator §2.2). `same_party` edges (the actor citing itself,
 * or its linked principal/siblings) are never consumption. An unsigned `pe:` citation records as
 * `unsigned_edges` and never counts.
 */
export function summarizeConsumption(edges: readonly OriginEdge[], limit: number = REVERSE_READ_LIMIT): ConsumptionSummary {
  const consumers = new Set<string>();
  let consumptionEdges = 0;
  let ringExcluded = 0;
  let unwitnessed = 0;
  let unsigned = 0;
  let ownApprovalsCited = 0;
  for (const e of edges) {
    if (!isCitationScheme(e.scheme)) continue;
    if (e.scheme === 'pe' && e.cited_action_type === 'human_approval') ownApprovalsCited += 1;
    if (e.closed_loop === true || e.reason === 'closed_loop') { ringExcluded += 1; continue; }
    if (e.reason === 'same_party' || e.reason === 'owner_set_unresolvable' || e.reason === 'unresolvable_owner') continue;
    if (e.witnessed !== true) { unwitnessed += 1; continue; }
    if (e.reason !== 'consumption_edge' && e.reason !== 'migrated_citation') continue;
    if (e.scheme !== 'out') { unsigned += 1; continue; }
    consumers.add(e.signer);
    consumptionEdges += 1;
  }
  return {
    independent_consumers: consumers.size,
    consumption_edges: consumptionEdges,
    ring_excluded_edges: ringExcluded,
    unwitnessed_edges: unwitnessed,
    unsigned_edges: unsigned,
    own_approvals_cited: ownApprovalsCited,
    truncated: edges.length >= limit,
  };
}

/** The Accountability input for one CITER: how many `human_approval` PEs its own edges cite. */
export function countHumanApprovalsCited(outEdges: readonly OriginEdge[]): number {
  let n = 0;
  for (const e of outEdges) {
    if (e.scheme === 'pe' && e.cited_action_type === 'human_approval' && e.witnessed === true
      && e.reason !== 'closed_loop' && e.reason !== 'unresolvable_owner') n += 1;
  }
  return n;
}

/** Every edge this signer wrote (its out-edges, full docs) — the Coupling/Accountability read. */
export async function readSignerOutEdgeDocs(
  db: Firestore,
  signerId: string,
  limit: number = REVERSE_READ_LIMIT,
): Promise<OriginEdge[]> {
  const snap = await privateRetentionCollection(db, ORIGIN_REFERENCE_GRAPH_COLLECTION)
    .where('signer', '==', signerId)
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data() as OriginEdge);
}

/**
 * Ring-flagged citations + their owners — the ops read. From the per-pair counts: one document per
 * ring-flagged relationship (`ring_flagged`, set when a ring-excluded edge is folded in; the pairs
 * flagged before the marker existed were given it once, at the cost pass's deploy).
 */
export async function readClosedLoopEdges(
  db: Firestore,
  limit: number = REVERSE_READ_LIMIT,
): Promise<{ edges: number; owners: string[]; truncated: boolean }> {
  const snap = await privateRetentionCollection(db,CITATION_PAIR_COUNTS_COLLECTION).where('ring_flagged', '==', true).limit(limit).get();
  const owners = new Set<string>();
  let edges = 0;
  for (const doc of snap.docs) {
    const p = doc.data() as CitationPairCounts;
    edges += Number(p.pe_ring_excluded ?? 0);
    if (typeof p.owner === 'string' && p.owner.length > 0) owners.add(p.owner);
  }
  return { edges, owners: [...owners].sort(), truncated: snap.size >= limit };
}

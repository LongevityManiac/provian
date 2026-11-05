/**
 * cutover reconciliation — final read-only inventory at the PVTv8 → PVT9 cut line.
 *
 * Pure enumeration + per-row derivation over an injected Firestore. NOTHING
 * here writes, mints, settles, anchors, or transitions any record: every
 * function is a read. The inventory is the input to the cutover
 * reconciliation (`cutover-reconciliation.ts`) and the cursor derivation
 * (`cutover-cursors.ts`).
 *
 * Classification model (the controlling zero-carry decision, plan lines
 * 264–271: every legacy Genesis, PVT, and PE record is controlled test data
 * excluded from PVT9 — carry-forward is zero by policy):
 *
 * - `legacy_pvtv8` PVTv8-era mint batches, batch snapshots, mint claims,
 * daily PE anchors, the legacy Genesis campaign pool ledger, and legacy
 * Genesis wallet ledgers. ALL zero-carry: record-only test history, never
 * a PVT9 migration input, never presentable as PVT9 state.
 * - `pvt9_genesis_backlog` the PVT9-era durable Genesis outbox +
 * reservations (schema v2). These are NOT balance migrations and NOT
 * ordinary-PE migrations — they are the preserved durable outbox whose
 * eligibility/payability is decided solely by the activation arming decision
 * (approved dates, epoch caps, admission policy). cutover reconciliation only inventories
 * them and asserts no reconciliation path can settle them.
 * - `pvt9_posture` the generated base config's structural zero-carry
 * evidence (kernel undeployed/unconfigured, legacy_migration=false).
 */

import type admin from 'firebase-admin';
import { FieldPath } from 'firebase-admin/firestore';
import { isPrivateFirestore, isPrivateCollection } from '../../provenance/private-store';
import { PVT9_BASE_CONFIG } from '../pvt9-base-config.generated';
import {
  CLAIM_LEDGER_COLLECTION,
  CLAIM_LEDGER_SCHEMA,
  SETTLEMENT_BATCHES_COLLECTION,
  SETTLEMENT_BATCH_SCHEMA,
  SETTLEMENT_CYCLES_COLLECTION,
  SETTLEMENT_CYCLE_SCHEMA,
} from '../wp4/durable-settlement-store';
import {
  ANCHOR_DAYS_COLLECTION,
  ANCHOR_SEGMENTS_COLLECTION,
  reconcileSegmentedDay,
  type AnchorDayDoc,
  type AnchorSegmentDoc,
} from '../wp4/segmented-pe-anchor';
import { isRetiredBacklogStub } from './cutover-documented-variances';

// Legacy PVTv8 collections (read-only here).
export const LEGACY_MINT_BATCHES_COLLECTION = 'pvt_mint_batches';
export const LEGACY_MINT_BATCH_SNAPSHOTS_COLLECTION = 'pvt_mint_batch_snapshots';
export const LEGACY_MINT_CLAIMS_COLLECTION = 'pvt_mint_claims_v1';
export const LEGACY_DAILY_ANCHOR_BATCHES_COLLECTION = 'pe_daily_anchor_batches';
export const LEGACY_GENESIS_STATE_COLLECTION = 'genesis_campaign_state';
export const LEGACY_GENESIS_STATE_DOC = 'global';
export const LEGACY_GENESIS_WALLET_LEDGER_COLLECTION = 'genesis_wallet_ledger';
export const BONDS_COLLECTION = 'bonds';
// PVT9-era Genesis durable backlog (read-only here).
export const GENESIS_QUALIFICATION_OUTBOX_COLLECTION = 'genesis_qualification_outbox_v2';
export const GENESIS_RESERVATIONS_COLLECTION = 'genesis_reservations_v2';

/**
 * Paged read size : the inventory never issues an unbounded
 * full-collection get — at 25k–50k PE scale one query would hold the whole
 * collection in a single response. Ordering is by document id, which every
 * collection has and which is stable across runs (determinism preserved).
 */
export const INVENTORY_PAGE_SIZE = 500;

/**
 * EXPORTED (): the ONE well-formed-EVM-address rule this inventory
 * applies, so any test asserting address shape binds to it rather than keeping a
 * copy that stops moving when this one does.
 */
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asSafeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** Parse a non-negative integer BigInt string; null on anything else. */
function asAtomic(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Which durable-finality shape a legacy batch document actually carries.
 * `marked_field` is the later PVTv8 schema; `legacy_inline_tx_hash` is the
 * pre-snapshot schema that records the mint tx as `tx_hash`. added
 * this because reading only the later spelling emptied C11's population.
 */
export type LegacyFinalityEvidence = 'marked_field' | 'legacy_inline_tx_hash' | 'none';

export interface LegacyMintBatchInventoryRow {
  readonly batch_id: string;
  readonly marked: boolean;
  /** Which field shape established `marked`; `none` when nothing did. */
  readonly finality_evidence: LegacyFinalityEvidence;
  readonly mint_tx_hash: string | null;
  /** marked && mint_tx_hash present — the durable-finality shape, either spelling. */
  readonly finalized: boolean;
  readonly has_snapshot: boolean;
  readonly epoch: number | null;
  readonly pe_count: number | null;
  readonly contributor_count: number | null;
  /** Σ snapshot.pe_points (BigInt string), null when unparseable. */
  readonly total_pe_points_atomic: string | null;
  /** Σ snapshot.leaves[].basePoints (BigInt string), null when unparseable. */
  readonly total_leaf_points_atomic: string | null;
  /** Max leaf timestamp (ms) in the snapshot; null when absent. */
  readonly max_leaf_timestamp_ms: number | null;
  /** contributor_addresses / pe_points / pe_action_types same length. */
  readonly parallel_arrays_consistent: boolean;
  /** leaves[].peId as a set equals sorted_pe_ids as a set (and counts match). */
  readonly leaves_match_sorted_pe_ids: boolean;
  /** Per-contributor Σ leaf.basePoints equals the parallel pe_points entry. */
  readonly per_contributor_points_consistent: boolean;
  /** Every recipient is a well-formed lowercase EVM address. */
  readonly recipients_all_valid_addresses: boolean;
  /** Legacy PVT contract address the snapshot was built against. */
  readonly pvt_contract_address: string | null;
  readonly pe_anchor_contract_address: string | null;
}

export interface LegacyMintClaimInventoryRow {
  readonly claim_id: string;
  readonly batch_id: string | null;
  readonly schema_version: string | null;
  /** True iff schema_version is the PVTv8 'pvt-mint-claim/v1'. */
  readonly is_legacy_schema: boolean;
  readonly has_batch: boolean;
}

export interface LegacyAnchorInventoryRow {
  readonly batch_id: string;
  readonly day: string | null;
  readonly kind: string | null;
  readonly status: string | null;
  readonly anchor_tx_hash: string | null;
  readonly pe_count: number | null;
  readonly members_count: number | null;
  readonly merkle_root_present: boolean;
  /** status==='anchored' ⇒ anchor_tx_hash present; pe_count === members len. */
  readonly internally_consistent: boolean;
  /**
   * a day with ZERO PEs has nothing to anchor, so requiring a
   * merkle root of it is a CHECKER defect, not a data defect. This flag fires
   * ONLY when every one of six conjuncts holds — `status==='empty'`,
   * `pe_count===0`, an EMPTY `members` array, NO merkle root, NO anchor tx
   * hash, AND a PE probe over the day's own UTC bounds (PE meter: anchored membership + skipped_no_hash)
   * returning zero PEs. If any single conjunct fails the day still requires a
   * root and still reports inconsistent. This CLASSIFIES; it never suppresses:
   * `internally_consistent` stays false and C5 lists every no_pe_day by date.
   */
  readonly no_pe_day: boolean;
  /**
   * PEs found by the direct probe for this day (capped at
   * `PE_PROBE_LIMIT` — only "zero or not" is load-bearing). `null` when the
   * probe was not run because a cheaper conjunct already failed, or when the
   * day key is unusable. `null` NEVER counts as zero (fail-closed).
   */
  readonly direct_pe_probe_count: number | null;
}

export interface LegacyGenesisInventory {
  readonly pool_minted_pvt: number | null;
  readonly wallet_ledger_count: number;
  /** Σ genesis_wallet_ledger.issued_pvt (legacy float PVT). */
  readonly wallet_ledger_issued_total_pvt: number;
}

export interface BondLockInventory {
  readonly count: number;
  readonly count_by_status: Readonly<Record<string, number>>;
  /** Σ bonds.amount_pvt (BigInt string; unparseable rows counted below). */
  readonly total_amount_atomic: string;
  readonly unparseable_amount_count: number;
}

export interface Pvt9GenesisBacklogInventory {
  readonly outbox_count: number;
  readonly outbox_count_by_status: Readonly<Record<string, number>>;
  readonly reservation_count: number;
  readonly reservation_count_by_state: Readonly<Record<string, number>>;
  /** Σ reservations.reservation.reserved_atomic where parseable. */
  readonly reserved_atomic_total: string;
  readonly unparseable_reserved_count: number;
  /** Rows whose schema_version is NOT the expected v2 shape (must be 0). */
  readonly unknown_schema_count: number;
  /**
   * outbox documents matched EXACTLY (id + complete content) to a
   * retired operator stub in `cutover-documented-variances.ts`. Listed by id,
   * never silently dropped; they are not counted as unknown-schema rows.
   */
  readonly retired_stub_ids: readonly string[];
}

/**
 * PVT9-side settlement-store inventory (the coupling landed): the settlement runtime
 * durable claim ledger, cycle docs, and batch reservations. At the activation cut
 * line these stores must be PRISTINE — no settlement authority consumed, no
 * identifier bleed from the legacy claim space — which reconciliation check
 * C12 asserts over these counts.
 */
export interface Pvt9SettlementStoreInventory {
  readonly claim_ledger_count: number;
  readonly claim_ledger_settled_count: number;
  /** Rows whose schema_version is not the expected ledger schema. */
  readonly claim_ledger_unknown_schema_count: number;
  /** Rows carrying the LEGACY 'pvt-mint-claim/v1' schema — identifier bleed. */
  readonly claim_ledger_legacy_schema_count: number;
  /** Settled rows whose settled_batch_id is a LEGACY mint batch id. */
  readonly claim_ledger_legacy_batch_binding_count: number;
  readonly cycle_count: number;
  readonly cycle_active_count: number;
  readonly cycle_unknown_schema_count: number;
  readonly batch_count: number;
  readonly batch_confirmed_count: number;
  readonly batch_unknown_schema_count: number;
}

/**
 * Per-day summary of the settlement runtime segmented anchors (the coupling landed):
 * each row is the verdict of `reconcileSegmentedDay` over the stored day +
 * segment docs — partition continuity (no gap/overlap), exact counts,
 * per-segment root recompute, aggregate root recompute. Bounded: violations
 * are truncated to the first five per day (the verdict boolean is complete).
 */
export interface SegmentedAnchorDayInventoryRow {
  readonly day_doc_id: string;
  readonly day: string | null;
  readonly pe_count: number | null;
  readonly segment_count: number | null;
  readonly segment_docs_found: number;
  readonly partition_ok: boolean;
  readonly violations: readonly string[];
}

export interface SegmentedAnchorInventory {
  readonly day_rows: readonly SegmentedAnchorDayInventoryRow[];
  /** Segment docs whose (day, segment_count) matches NO day doc. */
  readonly orphan_segment_doc_ids: readonly string[];
}

/** Structural zero-carry posture read from the generated base config. */
export interface Pvt9PostureInventory {
  readonly pvt9_address: string | null;
  readonly pvt9_deployment_status: string;
  readonly legacy_fallback: boolean;
  readonly legacy_migration: boolean;
  readonly genesis_armed: boolean;
  readonly genesis_window_approved: boolean;
  readonly canonical_usdc_address: string;
}

export interface CutoverInventory {
  /**
   * v4 : batch rows gain `finality_evidence`; orphan snapshots gain
   * full derived rows so C2/C3 stop skipping them.
   * v3 (): anchor rows gain `no_pe_day` + `direct_pe_probe_count`.
   * v2 added pvt9_settlement + pvt9_anchor_segments (settlement runtime acceptance landed).
   */
  readonly schema_version: 'pvt-cutover-inventory/v4';
  readonly cut_line_ms: number;
  readonly legacy_pvtv8: {
    readonly mint_batches: readonly LegacyMintBatchInventoryRow[];
    readonly orphan_snapshot_batch_ids: readonly string[];
    /**
     * Full derived rows for those same orphan snapshots (). Carries
     * the structural fields C2/C3 validate; the id list above is retained
     * unchanged so C1's population is untouched.
     */
    readonly orphan_snapshot_rows: readonly LegacyMintBatchInventoryRow[];
    readonly mint_claims: readonly LegacyMintClaimInventoryRow[];
    readonly anchors: readonly LegacyAnchorInventoryRow[];
    readonly genesis: LegacyGenesisInventory;
    /** Distinct legacy contract addresses observed across batch snapshots. */
    readonly observed_legacy_contract_addresses: readonly string[];
  };
  readonly locks: BondLockInventory;
  readonly pvt9_genesis_backlog: Pvt9GenesisBacklogInventory;
  readonly pvt9_settlement: Pvt9SettlementStoreInventory;
  readonly pvt9_anchor_segments: SegmentedAnchorInventory;
  readonly pvt9_posture: Pvt9PostureInventory;
}

export interface CutoverInventoryQuery {
  where(field: string, op: string, value: unknown): CutoverInventoryQuery;
  limit(n: number): CutoverInventoryQuery;
  startAfter(...values: unknown[]): CutoverInventoryQuery;
  get(): Promise<{
    docs: Array<{ id: string; data(): Record<string, unknown> | undefined }>;
  }>;
}

export interface CutoverInventoryDb {
  collection(name: string): {
    get(): Promise<{
      docs: Array<{ id: string; data(): Record<string, unknown> | undefined }>;
    }>;
    where(field: string, op: string, value: unknown): CutoverInventoryQuery;
    orderBy(field: unknown, dir?: 'asc' | 'desc'): CutoverInventoryQuery;
    doc(id: string): { get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }> };
  };
}

/** Only "zero or not" is load-bearing, so the probe never reads more than this. */
export const PE_PROBE_LIMIT = 2;

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * UTC day bounds for an anchor day key. Deliberately re-derived here rather
 * than imported from `daily-pe-anchor`: that module pulls in `ethers` and the
 * QUARANTINED `anchor-recovery`, and this inventory must stay a pure read with
 * a minimal import graph. The rule is identical (midnight-to-midnight UTC,
 * round-trip validated), and `cutover-wp12r.test.ts` pins it against every live
 * anchor day key plus the malformed-key rejections.
 * Returns null — never a guess — for an unusable key, which fails closed.
 */
export function anchorDayBounds(dayKey: string | null): { startMs: number; endMs: number } | null {
  if (dayKey === null || !DAY_KEY_RE.test(dayKey)) return null;
  const startMs = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(startMs) || new Date(startMs).toISOString().slice(0, 10) !== dayKey) return null;
  return { startMs, endMs: startMs + DAY_MS };
}

/**
 * The five CHEAP conjuncts of the R1 `no_pe_day` classification, evaluated
 * over the stored anchor-batch row alone. Extracted so the predicate is one
 * named thing a mutation can target and a test can pin conjunct-by-conjunct.
 * The sixth conjunct (the direct PE probe) is applied by the caller, which is
 * the only place the store is reachable.
 */
export function anchorRowLooksEmpty(row: {
  status: string | null;
  pe_count: number | null;
  members_count: number | null;
  merkle_root_present: boolean;
  anchor_tx_hash: string | null;
}): boolean {
  return row.status === 'empty'
    && row.pe_count === 0
    && row.members_count === 0
    && row.merkle_root_present === false
    && row.anchor_tx_hash === null;
}

/**
 * Every anchored member's timestamp, from the anchor records this inventory already read: the
 * legacy one-document day batches and the settlement runtime segment docs. The retired per-PE anchor put EVERY
 * PE with an envelope hash into exactly one anchored batch (its own day's, or a later day's as a
 * swept straggler), so this is the anchored PE population — without reading a PE store (PE METER:
 * the relay no longer keeps `pe_history`).
 */
export function anchoredMemberTimestamps(rows: ReadonlyArray<{ row: Record<string, unknown> }>): number[] {
  const out: number[] = [];
  for (const { row } of rows) {
    if (!Array.isArray(row.members)) continue;
    for (const m of row.members as unknown[]) {
      const ts = m !== null && typeof m === 'object' ? (m as { timestamp?: unknown }).timestamp : undefined;
      if (typeof ts === 'number' && Number.isFinite(ts)) out.push(ts);
    }
  }
  return out;
}

/**
 * PE probe for one anchor day: how many PEs are known to fall inside that day's own UTC bounds?
 * Deliberately the day's OWN window — a PE from an earlier day belongs to that earlier day.
 *
 * PE METER: the probe no longer queries `pe_history` (the relay keeps no PE store). Its evidence is
 * (a) anchored members whose timestamp is in the day, from EVERY anchor batch and segment (a PE that
 * missed its own day was swept into a later batch, and is counted for its own day here), plus (b)
 * the row's own `skipped_no_hash` — PEs the anchor collected for that window but could not make a
 * leaf, which are PEs all the same. Either one being nonzero defeats the exemption.
 *
 * Fail-closed by construction: a malformed day key returns `null`. `null` is not zero anywhere
 * downstream. Capped at `PE_PROBE_LIMIT` — only "zero or not" is load-bearing.
 */
function probePeCountForDay(
  dayKey: string | null,
  row: Record<string, unknown>,
  anchoredTimestamps: readonly number[],
): number | null {
  const bounds = anchorDayBounds(dayKey);
  if (bounds === null) return null;
  let count = typeof row.skipped_no_hash === 'number' && row.skipped_no_hash > 0 ? row.skipped_no_hash : 0;
  for (const ts of anchoredTimestamps) {
    if (count >= PE_PROBE_LIMIT) break;
    if (ts >= bounds.startMs && ts < bounds.endMs) count += 1;
  }
  return Math.min(count, PE_PROBE_LIMIT);
}

/**
 * Paged full-collection read : document-id ordered pages of
 * `INVENTORY_PAGE_SIZE`, deterministic for a fixed store state. The result is
 * the complete collection — pagination bounds each round trip, not coverage.
 */
async function readAll(
  db: CutoverInventoryDb,
  name: string,
): Promise<Array<{ id: string; row: Record<string, unknown> }>> {
  // The private adapter already reads bounded physical pages at one snapshot
  // and supplies logical order. Paging its logical view would rescan every
  // physical row for each inventory page, with no additional coverage.
  if (isPrivateFirestore(db as unknown as admin.firestore.Firestore) && isPrivateCollection(name)) {
    const snap = await db.collection(name).get();
    return snap.docs.map(doc => ({ id: doc.id, row: doc.data() ?? {} }));
  }
  const rows: Array<{ id: string; row: Record<string, unknown> }> = [];
  let lastId: string | null = null;
  for (;;) {
    let query = db.collection(name)
      .orderBy(FieldPath.documentId(), 'asc')
      .limit(INVENTORY_PAGE_SIZE);
    if (lastId !== null) query = query.startAfter(lastId);
    const snap = await query.get();
    for (const doc of snap.docs) rows.push({ id: doc.id, row: doc.data() ?? {} });
    if (snap.docs.length < INVENTORY_PAGE_SIZE) return rows;
    lastId = snap.docs[snap.docs.length - 1].id;
  }
}

function deriveBatchRow(
  batchId: string,
  batch: Record<string, unknown> | null,
  snapshot: Record<string, unknown> | null,
): LegacyMintBatchInventoryRow {
  // C11's SECOND defect, independent of the contract binding.
  // The two surviving legacy batch documents carry NEITHER `marked` NOR
  // `mint_tx_hash`: they predate that schema and record durable finality inline
  // as `tx_hash` beside `merkle_root` and `total_pvt_minted`. Reading only the
  // later field names made `finalized` false for EVERY legacy batch, so C11's
  // population was empty by field-name mismatch while both documents carried a
  // real mint that `batchMinted` confirms true on their own contracts. Accept
  // either spelling, and record which evidence shape answered.
  const mintTxHash = asString(batch?.mint_tx_hash) ?? asString(batch?.tx_hash);
  const markedField = batch?.marked === true;
  const legacyInlineFinality = batch !== null
    && asString(batch?.mint_tx_hash) === null
    && asString(batch?.tx_hash) !== null
    && asString(batch?.merkle_root) !== null;
  const finalityEvidence: LegacyFinalityEvidence = markedField
    ? 'marked_field'
    : legacyInlineFinality ? 'legacy_inline_tx_hash' : 'none';
  const marked = markedField || legacyInlineFinality;
  let epoch: number | null = null;
  let peCount: number | null = null;
  let contributorCount: number | null = null;
  let totalPePoints: bigint | null = null;
  let totalLeafPoints: bigint | null = null;
  let maxLeafTs: number | null = null;
  let parallelOk = false;
  let leavesMatch = false;
  let perContributorOk = false;
  let recipientsOk = false;
  let pvtAddress: string | null = null;
  let anchorAddress: string | null = null;

  if (snapshot !== null) {
    epoch = asSafeInt(snapshot.epoch);
    pvtAddress = asString(snapshot.pvt_contract_address);
    anchorAddress = asString(snapshot.pe_anchor_contract_address);
    const sortedPeIds = Array.isArray(snapshot.sorted_pe_ids) ? snapshot.sorted_pe_ids : null;
    const leaves = Array.isArray(snapshot.leaves) ? snapshot.leaves : null;
    const contributors = Array.isArray(snapshot.contributor_addresses)
      ? snapshot.contributor_addresses : null;
    const pePoints = Array.isArray(snapshot.pe_points) ? snapshot.pe_points : null;
    const peActionTypes = Array.isArray(snapshot.pe_action_types) ? snapshot.pe_action_types : null;
    peCount = sortedPeIds !== null ? sortedPeIds.length : null;
    contributorCount = contributors !== null ? contributors.length : null;

    parallelOk = contributors !== null && pePoints !== null && peActionTypes !== null
      && contributors.length === pePoints.length;

    if (leaves !== null && sortedPeIds !== null) {
      const leafPeIds = leaves.map((leaf) => asString((leaf as Record<string, unknown>)?.peId));
      const sortedSet = new Set(sortedPeIds.filter((v): v is string => typeof v === 'string'));
      leavesMatch = leaves.length === sortedPeIds.length
        && leafPeIds.every((id) => id !== null && sortedSet.has(id))
        && new Set(leafPeIds).size === leaves.length;
    }

    if (leaves !== null) {
      let sum: bigint | null = 0n;
      let maxTs: number | null = null;
      for (const rawLeaf of leaves) {
        const leaf = rawLeaf as Record<string, unknown>;
        const points = asAtomic(leaf?.basePoints);
        sum = sum !== null && points !== null ? sum + points : null;
        const ts = asSafeInt(leaf?.timestamp);
        if (ts !== null) maxTs = maxTs === null ? ts : Math.max(maxTs, ts);
      }
      totalLeafPoints = sum;
      maxLeafTs = maxTs;
    }

    if (pePoints !== null) {
      let sum: bigint | null = 0n;
      for (const raw of pePoints) {
        const points = asAtomic(raw);
        sum = sum !== null && points !== null ? sum + points : null;
      }
      totalPePoints = sum;
    }

    if (contributors !== null && pePoints !== null && leaves !== null
      && contributors.length === pePoints.length) {
      const byContributor = new Map<string, bigint>();
      let leafParseOk = true;
      for (const rawLeaf of leaves) {
        const leaf = rawLeaf as Record<string, unknown>;
        const wallet = asString(leaf?.walletAddress);
        const points = asAtomic(leaf?.basePoints);
        if (wallet === null || points === null) { leafParseOk = false; break; }
        const key = wallet.toLowerCase();
        byContributor.set(key, (byContributor.get(key) ?? 0n) + points);
      }
      if (leafParseOk) {
        perContributorOk = contributors.every((rawAddr, index) => {
          const addr = asString(rawAddr);
          const expected = asAtomic(pePoints[index]);
          if (addr === null || expected === null) return false;
          return (byContributor.get(addr.toLowerCase()) ?? 0n) === expected;
        }) && byContributor.size === contributors.length;
      }
    }

    recipientsOk = contributors !== null && contributors.length > 0
      && contributors.every((rawAddr) => {
        const addr = asString(rawAddr);
        return addr !== null && EVM_ADDRESS_RE.test(addr) && addr === addr.toLowerCase();
      });
  }

  return {
    batch_id: batchId,
    marked,
    finality_evidence: finalityEvidence,
    mint_tx_hash: mintTxHash,
    finalized: marked && mintTxHash !== null,
    has_snapshot: snapshot !== null,
    epoch,
    pe_count: peCount,
    contributor_count: contributorCount,
    total_pe_points_atomic: totalPePoints === null ? null : totalPePoints.toString(),
    total_leaf_points_atomic: totalLeafPoints === null ? null : totalLeafPoints.toString(),
    max_leaf_timestamp_ms: maxLeafTs,
    parallel_arrays_consistent: parallelOk,
    leaves_match_sorted_pe_ids: leavesMatch,
    per_contributor_points_consistent: perContributorOk,
    recipients_all_valid_addresses: recipientsOk,
    pvt_contract_address: pvtAddress,
    pe_anchor_contract_address: anchorAddress,
  };
}

function countBy(
  rows: Array<{ row: Record<string, unknown> }>,
  field: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { row } of rows) {
    const key = asString(row[field]) ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Take the final read-only inventory at the cut line. Deterministic for a
 * fixed store state: rows are sorted by document id, so two runs over the
 * same data produce byte-identical inventories.
 */
export async function takeCutoverInventory(
  db: CutoverInventoryDb | admin.firestore.Firestore,
  options: { cutLineMs: number },
): Promise<CutoverInventory> {
  const reader = db as CutoverInventoryDb;
  const [batches, snapshots, claims, anchors, ledgers, bonds, outbox, reservations,
    settlementLedger, settlementCycles, settlementBatches, anchorDays, anchorSegments] =
    await Promise.all([
      readAll(reader, LEGACY_MINT_BATCHES_COLLECTION),
      readAll(reader, LEGACY_MINT_BATCH_SNAPSHOTS_COLLECTION),
      readAll(reader, LEGACY_MINT_CLAIMS_COLLECTION),
      readAll(reader, LEGACY_DAILY_ANCHOR_BATCHES_COLLECTION),
      readAll(reader, LEGACY_GENESIS_WALLET_LEDGER_COLLECTION),
      readAll(reader, BONDS_COLLECTION),
      readAll(reader, GENESIS_QUALIFICATION_OUTBOX_COLLECTION),
      readAll(reader, GENESIS_RESERVATIONS_COLLECTION),
      readAll(reader, CLAIM_LEDGER_COLLECTION),
      readAll(reader, SETTLEMENT_CYCLES_COLLECTION),
      readAll(reader, SETTLEMENT_BATCHES_COLLECTION),
      readAll(reader, ANCHOR_DAYS_COLLECTION),
      readAll(reader, ANCHOR_SEGMENTS_COLLECTION),
    ]);
  const globalState = await reader
    .collection(LEGACY_GENESIS_STATE_COLLECTION)
    .doc(LEGACY_GENESIS_STATE_DOC)
    .get();

  const snapshotById = new Map(snapshots.map(({ id, row }) => [id, row]));
  const batchIds = new Set(batches.map(({ id }) => id));

  const batchRows = [...batches]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, row }) => deriveBatchRow(id, row, snapshotById.get(id) ?? null));

  const orphanSnapshotEntries = snapshots
    .filter(({ id }) => !batchIds.has(id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const orphanSnapshots = orphanSnapshotEntries.map(({ id }) => id);
  // C2/C3 were DEFECTIVE by scope: they iterated `mint_batches`
  // joined to a snapshot, so an orphan snapshot (a snapshot whose batch doc is
  // gone) was never structurally checked at all — even though it carries the
  // exact `leaves` / `contributor_addresses` / `pe_points` arrays those checks
  // exist to validate. All three surviving snapshots are orphans, which is why
  // both checks evaluated ZERO items. Derive full rows for them; `deriveBatchRow`
  // already takes a null batch.
  const orphanSnapshotRows = orphanSnapshotEntries
    .map(({ id, row }) => deriveBatchRow(id, null, row));

  const claimRows: LegacyMintClaimInventoryRow[] = [...claims]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, row }) => {
      const batchId = asString(row.batch_id);
      const schema = asString(row.schema_version);
      return {
        claim_id: id,
        batch_id: batchId,
        schema_version: schema,
        is_legacy_schema: schema === 'pvt-mint-claim/v1',
        has_batch: batchId !== null && batchIds.has(batchId),
      };
    });

  const anchoredTimestamps = anchoredMemberTimestamps([...anchors, ...anchorSegments]);
  const anchorRows: LegacyAnchorInventoryRow[] = [];
  for (const { id, row } of [...anchors].sort((a, b) => a.id.localeCompare(b.id))) {
    const status = asString(row.status);
    const txHash = asString(row.anchor_tx_hash);
    const peCount = asSafeInt(row.pe_count);
    const members = Array.isArray(row.members) ? row.members.length : null;
    const rootPresent = asString(row.merkle_root) !== null;
    const day = asString(row.day);
    const consistent = (status !== 'anchored' || txHash !== null)
      && peCount !== null && members !== null && peCount === members
      && rootPresent;

    // R1: probe ONLY when all five cheap conjuncts already hold — that bounds
    // the probe to zero-PE candidates and keeps the inventory's read cost flat.
    const cheapConjunctsHold = anchorRowLooksEmpty({
      status, pe_count: peCount, members_count: members, merkle_root_present: rootPresent,
      anchor_tx_hash: txHash,
    });
    const probeCount = cheapConjunctsHold ? probePeCountForDay(day, row, anchoredTimestamps) : null;
    // `probeCount === null` (never probed, or an unusable day key) is NOT zero.
    const noPeDay = cheapConjunctsHold && probeCount === 0;

    anchorRows.push({
      batch_id: id,
      day,
      kind: asString(row.kind),
      status,
      anchor_tx_hash: txHash,
      pe_count: peCount,
      members_count: members,
      merkle_root_present: rootPresent,
      internally_consistent: consistent,
      no_pe_day: noPeDay,
      direct_pe_probe_count: probeCount,
    });
  }

  let ledgerTotal = 0;
  for (const { row } of ledgers) {
    ledgerTotal += typeof row.issued_pvt === 'number' && Number.isFinite(row.issued_pvt)
      ? row.issued_pvt : 0;
  }
  const globalData = globalState.exists ? (globalState.data() ?? {}) : {};
  const genesisInventory: LegacyGenesisInventory = {
    pool_minted_pvt: typeof globalData.pool_minted_pvt === 'number'
      ? globalData.pool_minted_pvt : null,
    wallet_ledger_count: ledgers.length,
    wallet_ledger_issued_total_pvt: ledgerTotal,
  };

  let bondTotal = 0n;
  let bondUnparseable = 0;
  for (const { row } of bonds) {
    const amount = asAtomic(row.amount_pvt);
    if (amount === null) bondUnparseable += 1;
    else bondTotal += amount;
  }
  const lockInventory: BondLockInventory = {
    count: bonds.length,
    count_by_status: countBy(bonds, 'status'),
    total_amount_atomic: bondTotal.toString(),
    unparseable_amount_count: bondUnparseable,
  };

  let reservedTotal = 0n;
  let reservedUnparseable = 0;
  let unknownSchema = 0;
  for (const { row } of reservations) {
    if (row.schema_version !== 'pvt-genesis-reservation/v2') unknownSchema += 1;
    const reservation = (row.reservation ?? {}) as Record<string, unknown>;
    const reserved = asAtomic(reservation.reserved_atomic ?? row.reserved_atomic);
    if (reserved === null) reservedUnparseable += 1;
    else reservedTotal += reserved;
  }
  const retiredStubIds: string[] = [];
  for (const { id, row } of outbox) {
    if (isRetiredBacklogStub(GENESIS_QUALIFICATION_OUTBOX_COLLECTION, id, row)) {
      retiredStubIds.push(id);
      continue;
    }
    if (row.schema_version !== 'pvt-genesis-qualification/v2') unknownSchema += 1;
  }
  const backlog: Pvt9GenesisBacklogInventory = {
    outbox_count: outbox.length,
    outbox_count_by_status: countBy(outbox, 'status'),
    reservation_count: reservations.length,
    reservation_count_by_state: countBy(reservations, 'state'),
    reserved_atomic_total: reservedTotal.toString(),
    unparseable_reserved_count: reservedUnparseable,
    unknown_schema_count: unknownSchema,
    retired_stub_ids: retiredStubIds.sort(),
  };

  // ── PVT9 settlement stores (coupling; consumed by check C12).
  let ledgerSettled = 0;
  let ledgerUnknownSchema = 0;
  let ledgerLegacySchema = 0;
  let ledgerLegacyBinding = 0;
  for (const { row } of settlementLedger) {
    if (row.schema_version !== CLAIM_LEDGER_SCHEMA) {
      ledgerUnknownSchema += 1;
      if (row.schema_version === 'pvt-mint-claim/v1') ledgerLegacySchema += 1;
    }
    if (row.settled === true) {
      ledgerSettled += 1;
      const boundBatch = asString(row.settled_batch_id);
      if (boundBatch !== null && batchIds.has(boundBatch)) ledgerLegacyBinding += 1;
    }
  }
  let cyclesActive = 0;
  let cyclesUnknownSchema = 0;
  for (const { row } of settlementCycles) {
    if (row.schema_version !== SETTLEMENT_CYCLE_SCHEMA) cyclesUnknownSchema += 1;
    if (row.status === 'active') cyclesActive += 1;
  }
  let batchesConfirmed = 0;
  let batchesUnknownSchema = 0;
  for (const { row } of settlementBatches) {
    if (row.schema_version !== SETTLEMENT_BATCH_SCHEMA) batchesUnknownSchema += 1;
    if (row.status === 'confirmed') batchesConfirmed += 1;
  }
  const settlementInventory: Pvt9SettlementStoreInventory = {
    claim_ledger_count: settlementLedger.length,
    claim_ledger_settled_count: ledgerSettled,
    claim_ledger_unknown_schema_count: ledgerUnknownSchema,
    claim_ledger_legacy_schema_count: ledgerLegacySchema,
    claim_ledger_legacy_batch_binding_count: ledgerLegacyBinding,
    cycle_count: settlementCycles.length,
    cycle_active_count: cyclesActive,
    cycle_unknown_schema_count: cyclesUnknownSchema,
    batch_count: settlementBatches.length,
    batch_confirmed_count: batchesConfirmed,
    batch_unknown_schema_count: batchesUnknownSchema,
  };

  // ── PVT9 segmented anchors (coupling; consumed by check C13).
  // Segments pair to their day doc by (day, segment_count); complete over the
  // empty set until segmented anchoring runs (stated plainly, not papered over).
  const segmentsByDayKey = new Map<string, AnchorSegmentDoc[]>();
  for (const { row } of anchorSegments) {
    const seg = row as unknown as AnchorSegmentDoc;
    const key = `${String(seg.day)}__${String(seg.segment_count)}`;
    const list = segmentsByDayKey.get(key) ?? [];
    list.push(seg);
    segmentsByDayKey.set(key, list);
  }
  const pairedDayKeys = new Set<string>();
  const dayRows: SegmentedAnchorDayInventoryRow[] = [...anchorDays]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, row }) => {
      const dayDoc = row as unknown as AnchorDayDoc;
      const key = `${String(dayDoc.day)}__${String(dayDoc.segment_count)}`;
      const segments = segmentsByDayKey.get(key) ?? [];
      pairedDayKeys.add(key);
      // A malformed stored doc must classify as a violation, never a crash of
      // the whole inventory (Unknown = Block on the specific day row).
      let verdict: { ok: boolean; violations: readonly string[] };
      try {
        verdict = reconcileSegmentedDay(dayDoc, segments);
      } catch (error) {
        verdict = { ok: false, violations: [`unreconcilable day doc: ${(error as Error).message}`] };
      }
      return {
        day_doc_id: id,
        day: asString(dayDoc.day as unknown),
        pe_count: asSafeInt(dayDoc.pe_count as unknown),
        segment_count: asSafeInt(dayDoc.segment_count as unknown),
        segment_docs_found: segments.length,
        partition_ok: verdict.ok,
        violations: verdict.violations.slice(0, 5),
      };
    });
  const orphanSegmentIds = anchorSegments
    .filter(({ row }) => {
      const seg = row as unknown as AnchorSegmentDoc;
      return !pairedDayKeys.has(`${String(seg.day)}__${String(seg.segment_count)}`);
    })
    .map(({ id }) => id)
    .sort((a, b) => a.localeCompare(b));
  const segmentedAnchorInventory: SegmentedAnchorInventory = {
    day_rows: dayRows,
    orphan_segment_doc_ids: orphanSegmentIds,
  };

  const posture: Pvt9PostureInventory = {
    pvt9_address: PVT9_BASE_CONFIG.assets.pvt9.address,
    pvt9_deployment_status: PVT9_BASE_CONFIG.assets.pvt9.deployment_status,
    legacy_fallback: PVT9_BASE_CONFIG.compatibility.legacy_fallback,
    legacy_migration: PVT9_BASE_CONFIG.compatibility.legacy_migration,
    genesis_armed: PVT9_BASE_CONFIG.genesis.armed,
    genesis_window_approved: PVT9_BASE_CONFIG.genesis.window_approved,
    canonical_usdc_address: PVT9_BASE_CONFIG.assets.usdc.address,
  };

  const observedAddresses = [...new Set(
    [...batchRows, ...orphanSnapshotRows]
      .map((row) => row.pvt_contract_address)
      .filter((addr): addr is string => addr !== null)
      .map((addr) => addr.toLowerCase()),
  )].sort((a, b) => a.localeCompare(b));

  return {
    schema_version: 'pvt-cutover-inventory/v4',
    cut_line_ms: options.cutLineMs,
    legacy_pvtv8: {
      mint_batches: batchRows,
      orphan_snapshot_batch_ids: orphanSnapshots,
      orphan_snapshot_rows: orphanSnapshotRows,
      mint_claims: claimRows,
      anchors: anchorRows,
      genesis: genesisInventory,
      observed_legacy_contract_addresses: observedAddresses,
    },
    locks: lockInventory,
    pvt9_genesis_backlog: backlog,
    pvt9_settlement: settlementInventory,
    pvt9_anchor_segments: segmentedAnchorInventory,
    pvt9_posture: posture,
  };
}

import { prepareLocationCopyFence } from '../../jurisdiction/location-copy-erasure';
import { planComplianceRetention, prepareComplianceRetention } from '../../jurisdiction/location-retention';
import { complianceForRow } from '../../jurisdiction/mint-compliance';
import type { BatchPricingCounters } from '../../meter/batch-pricing-counters';
import type { Firestore, Transaction, DocumentSnapshot } from 'firebase-admin/firestore';
import { prepareDemotedMeterRetention } from '../../meter/retire-demoted-meter-keys';
import { privateRetentionCollection } from '../../provenance/private-retention';
/**
 * Per-identity economic aggregates, maintained AT ACCRUAL TIME (M5
 * close-out — the subsystem `economic-projection.ts`'s header returned rather
 * than half-build).
 *
 * WHAT IT IS. One document per `pe_history` identity key
 * (`pe_economic_aggregates/{identity}`), holding — for each of the two roles a
 * row can be read under (contributor: `pe_history.userId`; beneficiary:
 * `pe_history.beneficiary_wallet_id`) — the running totals the dashboard fold
 * used to recompute from every row on every uncached read: PE counts (total,
 * by category, by week), sealed record points, exact Genesis reserved gross,
 * integrity failures, and the FROZEN part of the settlement projection.
 *
 * FROZEN vs LIVE TAIL. The settlement projection of a row depends on
 * state that can still change inside the 72h attestation-enhancement window
 * (a corroboration lifting the tier). Past that window no later witness can
 * reprice the row, so its rate-free settlement input is a constant that can be
 * summed once. `frozen_through_ms` is the watermark: rows with
 * `timestamp <= frozen_through_ms` are IN the frozen sums; rows above it are
 * the live tail the read still folds. The watermark only ever advances, and
 * only to at most `now - 72h` (`rollForwardFrozenAggregate`, in the maintenance
 * module). The window constant is IMPORTED from the settlement kernel — the
 * same 72h `computeSettlement` enforces — never re-declared here.
 *
 * WHAT WRITES IT, AND WHEN.
 * 1. THE SEAL. `writePEHistory` applies the new row's contribution in the SAME
 * Firestore transaction that creates the row, and stamps the row with
 * `economic_aggregate_applied` (the marker). A crash cannot leave a row
 * counted-but-unwritten or written-but-uncounted: both land or neither.
 * 2. EVERY POST-SEAL MUTATION of an economic field goes through
 * `mutatePeHistoryRowWithAggregate`, which re-reads the row inside a
 * transaction, applies (−before, +after) to the aggregate, and writes the
 * patch — atomically. The live mutation sites are the pending-cache
 * recovery (incl. the novelty-corrected repricing), deferred release,
 * the PVT9 settlement writeback (`eligible` → `minted`), the commit-takeover
 * demotion (inside the taker's seal transaction), and the provisional
 * re-key. A mutation of an UNMARKED row is not applied — the row is not in
 * any aggregate yet; the backfill folds its post-mutation state.
 * 3. ROLL-FORWARD (read path) moves rows across the watermark as their windows
 * close, adding their now-constant settlement input to the frozen sums.
 * 4. BACKFILL folds pre-existing rows (once per identity; also on first read of
 * an identity whose aggregate is not `backfill_complete`).
 *
 * THE MARKER. A row is in the aggregates of ALL its identities, or in none:
 * `economic_aggregate_applied === ECONOMIC_AGGREGATE_SCHEMA_VERSION`. The seal
 * marks; the backfill marks; nothing unmarks. This is what makes the backfill
 * idempotent and lets a mutation hook know whether a delta is owed.
 *
 * ONE PRICING SOURCE. A row's contribution is computed by
 * `foldRowIntoTotals` the exact function the full fold uses — so the
 * aggregate and the reference fold cannot price a row differently. The parity
 * control in `economic-aggregate-read.test.ts` asserts frozen + tail == fold,
 * and its RED control shows the equality FAIL when the aggregate is wrong.
 *
 * DRIFT IS ASSUMED, NOT HOPED AWAY. An aggregate that silently diverges shows
 * a user the WRONG earnings, which is worse than a slow correct read. So the
 * read compares `total_pes + integrity_failures` to a `count()` of the
 * identity's rows on every uncached read (cheap: one aggregation read per
 * ~1,000 index entries), and a periodic sweep compares whole aggregates to the
 * paged reference fold and repairs under a version CAS — see
 * `economic-aggregate-maintenance.ts`.
 *
 * CONTENTION, STATED. The contributor doc is per identity and sits at C3's
 * ~1 PE/sec/user structural ceiling. The beneficiary doc serialises every
 * linked agent's seal for one human — but `pvt_accrual/{humanUserId}` and
 * `wallets/{human}.pe_count` already serialise those same PEs in the derived-
 * effects transaction, so no NEW ceiling is introduced; one moves into the seal.
 */

import type { PEHistoryDocument } from '../../../pe-history';
import { adjustConsoleDispositionRollupInTransaction } from '../disposition-rollup';
import { getWeekStart, WEEK_MS } from '../week-start';
import {
  expireAt,
  METER_ACT_KEYS_COLLECTION,
  METER_BATCHES_COLLECTION,
  METER_HELD_ACTS_COLLECTION,
  METER_KEY_LIFETIME_MS,
  METER_PENDING_CLAIMS_COLLECTION,
  type MeterPendingClaim,
} from '../../meter/meter-store';
import { actClaimKeysOf, withoutAct } from '../../meter/meter-claims';
import type { MeterActKeyDoc } from '../../meter/meter-act-key';
import { METER_BATCH_ACTS_COLLECTION, meterActPageId, type MeterPageAct } from '../../meter/meter-act-pages';

/** Statuses that withdraw an eligible act's earnings (the settlement gate's former per-act check). */
const DEMOTED_ACT_STATUSES: ReadonlySet<string> = new Set(['corroborated_duplicate', 'record_only', 'ineligible', 'ineligible_terminal']);
import { ATTESTATION_ENHANCEMENT_HORIZON_MS } from './monetary-accounting';
import {
  addSettlementInput,
  emptyEconomicAccrualTotals,
  foldRowIntoTotals,
  ZERO_SETTLEMENT_INPUT,
  type SettlementInputAtomic,
} from './economic-projection';

export const ECONOMIC_AGGREGATE_COLLECTION = 'pe_economic_aggregates';
export const ECONOMIC_AGGREGATE_SCHEMA_VERSION = 'pe-economic-aggregate/v1';
/** The pe_history marker: present (with the schema version) once a row is in its aggregates. */
export const PE_HISTORY_AGGREGATE_MARKER_FIELD = 'economic_aggregate_applied';
/**
 * The frozen window IS the settlement kernel's enhancement window. Re-used, not
 * copied: if the kernel's window ever moved, the frozen/tail split would move
 * with it, which is the only correct behaviour.
 */
export const FROZEN_CONTRIBUTION_WINDOW_MS = ATTESTATION_ENHANCEMENT_HORIZON_MS;

export type AggregateRole = 'contributor' | 'beneficiary';
export const AGGREGATE_ROLES: readonly AggregateRole[] = Object.freeze(['contributor', 'beneficiary']);
/** Which pe_history field keys an identity for each role. */
export const AGGREGATE_ROLE_KEY_FIELD: Readonly<Record<AggregateRole, 'userId' | 'beneficiary_wallet_id'>> = Object.freeze({
  contributor: 'userId',
  beneficiary: 'beneficiary_wallet_id',
});

export interface RoleAggregate {
  total_pes: number;
  integrity_failures: number;
  pes_by_category: Record<string, number>;
  /** Keyed by Monday-00:00-UTC week start (ms, as a string); pruned to the current and previous week on write. */
  pes_by_week_start: Record<string, number>;
  /**
   * PE METER: PE count by CURRENT `mint_status` (eligible / minted / record_only / …). Every status
   * transition already moves through this aggregate as (−before, +after), so this is the running
   * answer to "how many of this identity's acts are unminted / minted" without reading any act.
   * Empty on a document last written before it existed.
   */
  pes_by_mint_status: Record<string, number>;
  record_points_atomic: string;
  record_points_by_category_atomic: Record<string, string>;
  genesis_gross_atomic: string;
  genesis_gross_by_category_atomic: Record<string, string>;
  /** Watermark: rows with `timestamp <= frozen_through_ms` are in the frozen sums below. */
  frozen_through_ms: number;
  frozen_pes: number;
  frozen_projection_failures: number;
  /** Rate-bearing settlement input of frozen rows (meets the live mint rate at read). */
  frozen_projection_rated_atomic: string;
  /** Fixed-grant (rate-neutral) settlement input of frozen rows. */
  frozen_projection_fixed_atomic: string;
  frozen_projection_rated_by_category_atomic: Record<string, string>;
  frozen_projection_fixed_by_category_atomic: Record<string, string>;
  /** True once every pre-existing row of this identity/role has been folded and marked. */
  backfill_complete: boolean;
  /** Outputless batch earnings have no act row to fold as a live tail. */
  batch_pending_rated_atomic?: string;
  batch_pending_fixed_atomic?: string;
  batch_pending_rated_by_category_atomic?: Record<string, string>;
  batch_pending_fixed_by_category_atomic?: Record<string, string>;
}

export interface EconomicAggregateDocument {
  schema_version: typeof ECONOMIC_AGGREGATE_SCHEMA_VERSION;
  identity: string;
  roles: Record<AggregateRole, RoleAggregate>;
  /** Monotonic; every write increments it. The repair CAS keys on it. */
  version: number;
  updated_at_ms: number;
  drift_detected_at_ms: number | null;
  drift_repaired_at_ms: number | null;
}

const SIGNED_ATOMIC = /^-?(0|[1-9][0-9]*)$/;

function parseAtomic(value: unknown): bigint {
  return typeof value === 'string' && SIGNED_ATOMIC.test(value) ? BigInt(value) : 0n;
}

function parseAtomicRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && SIGNED_ATOMIC.test(raw)) out[key] = raw;
  }
  return out;
}

function parseNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function emptyRoleAggregate(): RoleAggregate {
  return {
    total_pes: 0,
    integrity_failures: 0,
    pes_by_category: {},
    pes_by_week_start: {},
    pes_by_mint_status: {},
    record_points_atomic: '0',
    record_points_by_category_atomic: {},
    genesis_gross_atomic: '0',
    genesis_gross_by_category_atomic: {},
    frozen_through_ms: 0,
    frozen_pes: 0,
    frozen_projection_failures: 0,
    frozen_projection_rated_atomic: '0',
    frozen_projection_fixed_atomic: '0',
    frozen_projection_rated_by_category_atomic: {},
    frozen_projection_fixed_by_category_atomic: {},
    backfill_complete: false,
  };
}

export function emptyAggregateDocument(identity: string): EconomicAggregateDocument {
  return {
    schema_version: ECONOMIC_AGGREGATE_SCHEMA_VERSION,
    identity,
    roles: { contributor: emptyRoleAggregate(), beneficiary: emptyRoleAggregate() },
    version: 0,
    updated_at_ms: 0,
    drift_detected_at_ms: null,
    drift_repaired_at_ms: null,
  };
}

function parseRoleAggregate(raw: unknown): RoleAggregate {
  const empty = emptyRoleAggregate();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const r = raw as Record<string, unknown>;
  return {
    total_pes: numberOrZero(r.total_pes),
    integrity_failures: numberOrZero(r.integrity_failures),
    pes_by_category: parseNumberRecord(r.pes_by_category),
    pes_by_week_start: parseNumberRecord(r.pes_by_week_start),
    pes_by_mint_status: parseNumberRecord(r.pes_by_mint_status),
    record_points_atomic: parseAtomic(r.record_points_atomic).toString(10),
    record_points_by_category_atomic: parseAtomicRecord(r.record_points_by_category_atomic),
    genesis_gross_atomic: parseAtomic(r.genesis_gross_atomic).toString(10),
    genesis_gross_by_category_atomic: parseAtomicRecord(r.genesis_gross_by_category_atomic),
    frozen_through_ms: numberOrZero(r.frozen_through_ms),
    frozen_pes: numberOrZero(r.frozen_pes),
    frozen_projection_failures: numberOrZero(r.frozen_projection_failures),
    frozen_projection_rated_atomic: parseAtomic(r.frozen_projection_rated_atomic).toString(10),
    frozen_projection_fixed_atomic: parseAtomic(r.frozen_projection_fixed_atomic).toString(10),
    frozen_projection_rated_by_category_atomic:
      parseAtomicRecord(r.frozen_projection_rated_by_category_atomic),
    frozen_projection_fixed_by_category_atomic:
      parseAtomicRecord(r.frozen_projection_fixed_by_category_atomic),
    backfill_complete: r.backfill_complete === true,
    batch_pending_rated_atomic: parseAtomic(r.batch_pending_rated_atomic).toString(),
    batch_pending_fixed_atomic: parseAtomic(r.batch_pending_fixed_atomic).toString(),
    batch_pending_rated_by_category_atomic: parseAtomicRecord(r.batch_pending_rated_by_category_atomic),
    batch_pending_fixed_by_category_atomic: parseAtomicRecord(r.batch_pending_fixed_by_category_atomic),
  };
}

/**
 * Parse a stored aggregate. Returns null for a missing document or a document
 * of another schema version — a caller treats null as "no aggregate" and takes
 * the backfill path; it never guesses.
 */
export function parseAggregateDocument(
  identity: string,
  raw: unknown,
): EconomicAggregateDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.schema_version !== ECONOMIC_AGGREGATE_SCHEMA_VERSION) return null;
  const roles = (doc.roles && typeof doc.roles === 'object' ? doc.roles : {}) as Record<string, unknown>;
  return {
    schema_version: ECONOMIC_AGGREGATE_SCHEMA_VERSION,
    identity,
    roles: {
      contributor: parseRoleAggregate(roles.contributor),
      beneficiary: parseRoleAggregate(roles.beneficiary),
    },
    version: numberOrZero(doc.version),
    updated_at_ms: numberOrZero(doc.updated_at_ms),
    drift_detected_at_ms: typeof doc.drift_detected_at_ms === 'number' ? doc.drift_detected_at_ms : null,
    drift_repaired_at_ms: typeof doc.drift_repaired_at_ms === 'number' ? doc.drift_repaired_at_ms : null,
  };
}

export function isAggregateMarked(row: Record<string, unknown> | PEHistoryDocument): boolean {
  return (row as Record<string, unknown>)[PE_HISTORY_AGGREGATE_MARKER_FIELD]
    === ECONOMIC_AGGREGATE_SCHEMA_VERSION;
}

/** Every (identity, role) a row is read under. A row with no beneficiary has one. */
export function rowIdentityKeys(
  row: Record<string, unknown> | PEHistoryDocument,
): Array<{ identity: string; role: AggregateRole }> {
  const out: Array<{ identity: string; role: AggregateRole }> = [];
  const r = row as Record<string, unknown>;
  for (const role of AGGREGATE_ROLES) {
    const key = r[AGGREGATE_ROLE_KEY_FIELD[role]];
    if (typeof key === 'string' && key.length > 0) out.push({ identity: key, role });
  }
  return out;
}

export interface RowContribution {
  readonly category: string;
  /** The row's current `mint_status` ('unknown' when absent) — keys `pes_by_mint_status`. */
  readonly mintStatus: string;
  readonly timestampMs: number;
  readonly weekStartMs: number;
  /** When true, only `integrity_failures` moves — mirrors the fold's early return. */
  readonly integrityFailure: boolean;
  readonly recordPointsAtomic: bigint;
  readonly genesisGrossAtomic: bigint;
  /** Rate-free settlement input; null = the row cannot be priced (a projection failure). */
  readonly settlementInput: SettlementInputAtomic | null;
}

/**
 * ONE row's contribution for ONE role, priced by the fold's own row function.
 * `nowMs` is the settlement clock for the projection input; for a row past the
 * 72h window the input is a constant and the clock is irrelevant.
 */
export function rowContribution(
  pe: PEHistoryDocument,
  role: AggregateRole,
  nowMs: number,
): RowContribution {
  const totals = emptyEconomicAccrualTotals();
  foldRowIntoTotals(totals, pe, role, {
    nowMs,
    withProjection: true,
    userIdForLog: typeof pe.userId === 'string' ? pe.userId : '',
  });
  const timestampMs = typeof pe.timestamp === 'number' && Number.isFinite(pe.timestamp)
    ? pe.timestamp
    : Number.NaN;
  const category = pe.category || 'other';
  const mintStatus = typeof pe.mint_status === 'string' && pe.mint_status.length > 0 ? pe.mint_status : 'unknown';
  if (totals.integrityFailures > 0) {
    return {
      category,
      mintStatus,
      timestampMs,
      weekStartMs: Number.isNaN(timestampMs) ? Number.NaN : getWeekStart(timestampMs),
      integrityFailure: true,
      recordPointsAtomic: 0n,
      genesisGrossAtomic: 0n,
      settlementInput: null,
    };
  }
  return {
    category,
    mintStatus,
    timestampMs,
    weekStartMs: Number.isNaN(timestampMs) ? Number.NaN : getWeekStart(timestampMs),
    integrityFailure: false,
    recordPointsAtomic: totals.totalRecordPoints,
    genesisGrossAtomic: totals.exactGenesisReservedGross,
    settlementInput: totals.projectionFailures > 0 ? null : totals.settlementInput,
  };
}

function bumpCount(record: Record<string, number>, key: string, delta: number): void {
  const next = (record[key] ?? 0) + delta;
  if (next === 0) delete record[key];
  else record[key] = next;
}

function bumpAtomic(record: Record<string, string>, key: string, delta: bigint): void {
  const next = parseAtomic(record[key]) + delta;
  if (next === 0n) delete record[key];
  else record[key] = next.toString(10);
}

function cloneRoleAggregate(agg: RoleAggregate): RoleAggregate {
  return {
    ...agg,
    pes_by_category: { ...agg.pes_by_category },
    pes_by_week_start: { ...agg.pes_by_week_start },
    pes_by_mint_status: { ...agg.pes_by_mint_status },
    record_points_by_category_atomic: { ...agg.record_points_by_category_atomic },
    genesis_gross_by_category_atomic: { ...agg.genesis_gross_by_category_atomic },
    frozen_projection_rated_by_category_atomic: { ...agg.frozen_projection_rated_by_category_atomic },
    frozen_projection_fixed_by_category_atomic: { ...agg.frozen_projection_fixed_by_category_atomic },
  };
}

/** Is this row's settlement input part of the FROZEN sums under this watermark? */
export function isFrozenUnder(c: Pick<RowContribution, 'timestampMs'>, frozenThroughMs: number): boolean {
  return !Number.isNaN(c.timestampMs) && c.timestampMs <= frozenThroughMs;
}

/**
 * Apply the time-independent totals of a contribution (counts, record points,
 * Genesis gross, integrity failures). Pure: returns a new aggregate.
 */
export function applyTotalsContribution(
  agg: RoleAggregate,
  c: RowContribution,
  sign: 1 | -1,
  nowMs: number,
): RoleAggregate {
  const next = cloneRoleAggregate(agg);
  if (c.integrityFailure) {
    next.integrity_failures += sign;
    return next;
  }
  next.total_pes += sign;
  bumpCount(next.pes_by_category, c.category, sign);
  bumpCount(next.pes_by_mint_status, c.mintStatus, sign);
  if (!Number.isNaN(c.weekStartMs)) {
    bumpCount(next.pes_by_week_start, String(c.weekStartMs), sign);
  }
  // Prune: only the current and previous week are ever read. A key is a
  // week-start in ms, so the numeric comparison is exact.
  const keep = getWeekStart(nowMs) - WEEK_MS;
  for (const key of Object.keys(next.pes_by_week_start)) {
    if (Number(key) < keep) delete next.pes_by_week_start[key];
  }
  next.record_points_atomic = (parseAtomic(next.record_points_atomic)
    + BigInt(sign) * c.recordPointsAtomic).toString(10);
  bumpAtomic(next.record_points_by_category_atomic, c.category, BigInt(sign) * c.recordPointsAtomic);
  next.genesis_gross_atomic = (parseAtomic(next.genesis_gross_atomic)
    + BigInt(sign) * c.genesisGrossAtomic).toString(10);
  bumpAtomic(next.genesis_gross_by_category_atomic, c.category, BigInt(sign) * c.genesisGrossAtomic);
  return next;
}

/**
 * Apply the FROZEN settlement-input part of a contribution. Callers decide
 * membership (`isFrozenUnder`); this only does the arithmetic. Pure.
 */
export function applyFrozenContribution(
  agg: RoleAggregate,
  c: RowContribution,
  sign: 1 | -1,
): RoleAggregate {
  const next = cloneRoleAggregate(agg);
  if (c.integrityFailure) return next;
  next.frozen_pes += sign;
  if (c.settlementInput === null) {
    next.frozen_projection_failures += sign;
    return next;
  }
  const s = BigInt(sign);
  next.frozen_projection_rated_atomic = (parseAtomic(next.frozen_projection_rated_atomic)
    + s * c.settlementInput.rated).toString(10);
  next.frozen_projection_fixed_atomic = (parseAtomic(next.frozen_projection_fixed_atomic)
    + s * c.settlementInput.fixed).toString(10);
  bumpAtomic(next.frozen_projection_rated_by_category_atomic, c.category, s * c.settlementInput.rated);
  bumpAtomic(next.frozen_projection_fixed_by_category_atomic, c.category, s * c.settlementInput.fixed);
  return next;
}

/** Totals always; frozen part iff the row sits at or below the watermark. */
export function applyRowContribution(
  agg: RoleAggregate,
  c: RowContribution,
  sign: 1 | -1,
  nowMs: number,
): RoleAggregate {
  const withTotals = applyTotalsContribution(agg, c, sign, nowMs);
  return isFrozenUnder(c, withTotals.frozen_through_ms)
    ? applyFrozenContribution(withTotals, c, sign)
    : withTotals;
}

export function frozenSettlementInput(agg: RoleAggregate): SettlementInputAtomic {
  return {
    rated: parseAtomic(agg.frozen_projection_rated_atomic),
    fixed: parseAtomic(agg.frozen_projection_fixed_atomic),
  };
}

export function frozenSettlementInputByCategory(agg: RoleAggregate): Record<string, SettlementInputAtomic> {
  const out: Record<string, SettlementInputAtomic> = {};
  for (const [key, raw] of Object.entries(agg.frozen_projection_rated_by_category_atomic)) {
    out[key] = addSettlementInput(out[key] ?? ZERO_SETTLEMENT_INPUT, { rated: parseAtomic(raw), fixed: 0n });
  }
  for (const [key, raw] of Object.entries(agg.frozen_projection_fixed_by_category_atomic)) {
    out[key] = addSettlementInput(out[key] ?? ZERO_SETTLEMENT_INPUT, { rated: 0n, fixed: parseAtomic(raw) });
  }
  return out;
}

export { parseAtomic as parseSignedAtomic };

// ---------------------------------------------------------------------------
// Transactional writer — the narrow shape admin Firestore, the wp4 SettlementDb
// and the test fake all satisfy.
// ---------------------------------------------------------------------------

export interface AggregateSnapLike {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface AggregateRefLike {
  get(): Promise<AggregateSnapLike>;
}

export interface AggregateTxnLike {
  get(ref: AggregateRefLike): Promise<AggregateSnapLike>;
  set(ref: AggregateRefLike, data: Record<string, unknown>, opts?: { merge?: boolean }): void;
}

export interface AggregateDbLike {
  collection(name: string): { doc(id: string): AggregateRefLike };
}

export interface AggregateMutationDb extends AggregateDbLike {
  runTransaction<T>(fn: (txn: AggregateTxnLike) => Promise<T>): Promise<T>;
}

interface LoadedAggregate {
  readonly ref: AggregateRefLike;
  readonly version: number;
  doc: EconomicAggregateDocument;
  touched: boolean;
}

/**
 * Read-modify-write of aggregate documents INSIDE a caller's transaction.
 *
 * Usage discipline (Firestore: all reads before any write):
 *   const writer = new EconomicAggregateWriter(db, txn, nowMs);
 *   await writer.load([...every identity the rows below touch...]);
 *   writer.applyRow(row, +1) / writer.applyMutation(before, after) ...
 *   writer.commit();
 * `applyRow` on an identity that was not loaded THROWS — a silent skip would
 * be exactly the silent divergence this subsystem exists to prevent.
 */
export class EconomicAggregateWriter {
  private readonly loaded = new Map<string, LoadedAggregate>();

  constructor(
    private readonly db: AggregateDbLike,
    private readonly txn: AggregateTxnLike,
    private readonly nowMs: number,
  ) {}

  async load(identities: Iterable<string>): Promise<void> {
    const pending: string[] = [];
    for (const identity of identities) {
      if (typeof identity === 'string' && identity.length > 0 && !this.loaded.has(identity)) {
        pending.push(identity);
      }
    }
    const unique = [...new Set(pending)];
    const refs = unique.map((identity) => this.db.collection(ECONOMIC_AGGREGATE_COLLECTION).doc(identity));
    const snaps = await Promise.all(refs.map((ref) => this.txn.get(ref)));
    unique.forEach((identity, index) => {
      const snap = snaps[index];
      const parsed = snap.exists ? parseAggregateDocument(identity, snap.data()) : null;
      this.loaded.set(identity, {
        ref: refs[index],
        version: parsed?.version ?? 0,
        doc: parsed ?? emptyAggregateDocument(identity),
        touched: false,
      });
    });
  }

  has(identity: string): boolean {
    return this.loaded.has(identity);
  }

  private entry(identity: string): LoadedAggregate {
    const entry = this.loaded.get(identity);
    if (entry === undefined) {
      throw new Error(`economic_aggregate_identity_not_loaded:${identity}`);
    }
    return entry;
  }

  /** The current (in-transaction) view of one role aggregate. */
  roleAggregate(identity: string, role: AggregateRole): RoleAggregate {
    return this.entry(identity).doc.roles[role];
  }

  /** Replace one role aggregate wholesale (roll-forward / repair / completion). */
  setRoleAggregate(identity: string, role: AggregateRole, next: RoleAggregate): void {
    const entry = this.entry(identity);
    entry.doc.roles[role] = next;
    entry.touched = true;
  }

  /** Mark a loaded doc for write even when nothing changed (creates it). */
  touch(identity: string): void {
    this.entry(identity).touched = true;
  }

  /** Apply a row under EVERY identity/role it is read under. */
  applyRow(pe: PEHistoryDocument, sign: 1 | -1): void {
    for (const { identity, role } of rowIdentityKeys(pe)) {
      const entry = this.entry(identity);
      const c = rowContribution(pe, role, this.nowMs);
      entry.doc.roles[role] = applyRowContribution(entry.doc.roles[role], c, sign, this.nowMs);
      entry.touched = true;
    }
  }

  /**
   * (−before, +after) for a marked row; nothing for an unmarked one (it is in
   * no aggregate — the backfill will fold its post-mutation state).
   */
  applyMutation(before: PEHistoryDocument, after: PEHistoryDocument): 'applied' | 'unmarked' {
    if (!isAggregateMarked(before)) return 'unmarked';
    this.applyRow(before, -1);
    this.applyRow(after, 1);
    return 'applied';
  }

  /** A row compacted into batch economics leaves the retained frozen projection exactly once. */
  detachRetainedProjection(pe: PEHistoryDocument): void {
    for (const { identity, role } of rowIdentityKeys(pe)) {
      const entry = this.entry(identity), prior = entry.doc.roles[role], contribution = rowContribution(pe, role, this.nowMs);
      if (!isFrozenUnder(contribution, prior.frozen_through_ms)) continue;
      entry.doc.roles[role] = applyFrozenContribution(prior, contribution, -1);
      entry.touched = true;
    }
  }

  /** Apply a compact batch total, never a reconstructed or repriced PE. */
  applyBatchPending(identity: string, role: AggregateRole, category: string,
    rated: bigint, fixed: bigint, count: number, sign: 1 | -1, moveStatus: boolean): void {
    const entry = this.entry(identity);
    const prior = entry.doc.roles[role];
    const next = { ...prior,
      pes_by_mint_status: { ...prior.pes_by_mint_status },
      batch_pending_rated_atomic: (parseAtomic(prior.batch_pending_rated_atomic) + BigInt(sign) * rated).toString(),
      batch_pending_fixed_atomic: (parseAtomic(prior.batch_pending_fixed_atomic) + BigInt(sign) * fixed).toString(),
      batch_pending_rated_by_category_atomic: { ...prior.batch_pending_rated_by_category_atomic },
      batch_pending_fixed_by_category_atomic: { ...prior.batch_pending_fixed_by_category_atomic },
    };
    bumpAtomic(next.batch_pending_rated_by_category_atomic, category, BigInt(sign) * rated);
    bumpAtomic(next.batch_pending_fixed_by_category_atomic, category, BigInt(sign) * fixed);
    if (moveStatus) {
      bumpCount(next.pes_by_mint_status, 'eligible', sign * count);
      bumpCount(next.pes_by_mint_status, 'minted', -sign * count);
    }
    entry.doc.roles[role] = next;
    entry.touched = true;
  }

  /** Every identity a mutation would need loaded. */
  static identitiesOf(...rows: ReadonlyArray<Record<string, unknown> | PEHistoryDocument>): string[] {
    const out = new Set<string>();
    for (const row of rows) for (const { identity } of rowIdentityKeys(row)) out.add(identity);
    return [...out];
  }

  /** Write every touched document with `version + 1`. Returns how many were written. */
  commit(): number {
    let written = 0;
    for (const entry of this.loaded.values()) {
      if (!entry.touched) continue;
      const next: EconomicAggregateDocument = {
        ...entry.doc,
        version: entry.version + 1,
        updated_at_ms: this.nowMs,
      };
      this.txn.set(entry.ref, next as unknown as Record<string, unknown>);
      written += 1;
    }
    return written;
  }
}

export type PeHistoryMutationOutcome = 'applied' | 'missing' | 'precondition_failed';

/**
 * THE mutation primitive for pe_history economic fields. Re-reads the row in a
 * transaction, applies the aggregate delta, and writes the patch — atomically.
 *
 * `expect` is an optional precondition on the FRESH row (e.g. "still
 * pending_cache"); a false return leaves everything untouched and reports
 * `precondition_failed`, so two workers racing on one row cannot both apply.
 */
export async function mutatePeHistoryRowWithAggregate(
  db: AggregateMutationDb,
  peId: string,
  patch: Record<string, unknown>,
  options: {
    readonly nowMs: number;
    readonly expect?: (before: Record<string, unknown>) => boolean;
    /**
     * A single-lane act keeps no act key: its row lives on its batch's act page
     * (`meter_batch_acts_v1/{batch_hash}~{page}`). Naming the batch lets this primitive find it
     * there — read in the same transaction, after the act key and the legacy row were found absent.
     */
    readonly pageBatchHash?: string;
    readonly noveltyCounters?: BatchPricingCounters;
    /**
     * A precondition on every non-void pending claim carrying the act, read in this transaction
     * (: a demotion requires its run's live hold on each, checked where the act's
     * share is withdrawn, so a hold that lapsed after an earlier check can never be written past).
     */
    readonly claimExpect?: (claim: Record<string, unknown>) => boolean;
  },
): Promise<{ outcome: PeHistoryMutationOutcome; before: Record<string, unknown> | null }> {
  // PE METER: an act's priced row lives in its act key (`meter_act_keys_v1/{id}.row`), on its
  // batch's act page (a single-lane act, when the caller names the batch), or — pre-meter — in
  // `pe_history` until the migration retires it. Same mutation, same aggregate delta, whichever
  // home holds it — every home read before any write.
  // A HELD metered act transitions only through the held-act engine: a promotion there creates
  // the act's pending claims and removes the hold (a plain row patch would leave it unpayable).
  const held = await privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(peId).get();
  if (held.exists) {
    const { resolveHeldAct } = await import('../../meter/held-acts');
    const result = await resolveHeldAct(db as unknown as import('firebase-admin/firestore').Firestore, peId, patch, options);
    if (result.outcome === 'missing') return { outcome: 'missing', before: null };
    if (result.outcome === 'precondition_failed' || result.outcome === 'still_held') {
      return { outcome: 'precondition_failed', before: result.before };
    }
    // `promotion_refused` APPLIED the patch (the row is eligible); the act waits for its payee
    // under `payee_<reason>` until the payee retry pass creates its claims — the metered twin of
    // a pre-meter eligible row whose payee the settlement inlet cannot yet resolve.
    return { outcome: 'applied', before: result.before };
  }
  const keyRef = privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(peId);
  const legacyRef = db.collection('pe_history').doc(peId);
  return db.runTransaction(async (txn) => {
    const [keySnap, legacySnap] = [await txn.get(keyRef), await txn.get(legacyRef)];
    const keyRow = keySnap.exists ? (keySnap.data() ?? {}).row : undefined;
    const meterHome = keyRow !== null && typeof keyRow === 'object' && !Array.isArray(keyRow);
    // The act's page, when it has neither an act key nor a legacy row and the caller named its batch.
    let page: { ref: AggregateRefLike; act: MeterPageAct } | null = null;
    if (!meterHome && !legacySnap.exists && typeof options.pageBatchHash === 'string' && options.pageBatchHash.length > 0) {
      const batchHash = options.pageBatchHash;
      const batchSnap = await txn.get(db.collection(METER_BATCHES_COLLECTION).doc(batchHash));
      const pageCount = batchSnap.exists ? Number((batchSnap.data() ?? {}).act_pages ?? 0) : 0;
      for (let i = 0; i < pageCount && page === null; i += 1) {
        const ref = privateRetentionCollection(db, METER_BATCH_ACTS_COLLECTION).doc(meterActPageId(batchHash, i));
        const snap = await txn.get(ref);
        const acts = snap.exists ? (snap.data() ?? {}).acts : undefined;
        const act = acts !== null && typeof acts === 'object' ? (acts as Record<string, unknown>)[peId] : undefined;
        const actRow = act !== null && typeof act === 'object' ? (act as { row?: unknown }).row : undefined;
        if (actRow !== null && typeof actRow === 'object' && !Array.isArray(actRow)
          && (act as MeterPageAct).batch_hash === batchHash) {
          page = { ref, act: act as MeterPageAct };
        }
      }
    }
    if (!meterHome && !legacySnap.exists && page === null) return { outcome: 'missing' as const, before: null };
    const before = meterHome
      ? (keyRow as Record<string, unknown>)
      : page !== null ? (page.act.row as Record<string, unknown>) : (legacySnap.data() ?? {});
    if (options.expect && !options.expect(before)) {
      return { outcome: 'precondition_failed' as const, before };
    }
    await options.noveltyCounters?.inspect(txn as unknown as FirebaseFirestore.Transaction);
    const after = { ...before, ...patch };
    const recoveryCompliance = patch.mint_status === 'eligible' ? await complianceForRow(after, db as unknown as Firestore) : null;
    if (recoveryCompliance && recoveryCompliance.policy !== 'immediate') {
      const retention = await planComplianceRetention(db as unknown as Firestore, peId, after, options.nowMs, recoveryCompliance);
      const retainLocation = await prepareComplianceRetention(db as unknown as Firestore, txn as unknown as Transaction, retention, options.nowMs);
      retainLocation();
      return { outcome: 'precondition_failed' as const, before };
    }
    // PE meter cost pass (2026-10-04): settlement no longer re-reads each act's status, so DEMOTING
    // a metered act is where its earnings are withdrawn — in this transaction. Every claim carrying
    // the act must still be `pending` (or already void): each is voided, or trimmed of the act; a
    // claim that has gone further (registered, aggregated into a payout, settled) refuses the
    // demotion, as the bug-demotion tool refuses a registered or settled pre-meter claim.
    const claimPatches: { ref: AggregateRefLike; patch: Record<string, unknown> }[] = [];
    const terminalClaims = new Map<string, MeterPendingClaim>();
    if ((meterHome || page !== null) && before.mint_status === 'eligible' && DEMOTED_ACT_STATUSES.has(String(after.mint_status))) {
      const key = meterHome ? keySnap.data() as unknown as MeterActKeyDoc : page!.act;
      const claimKeys = actClaimKeysOf(key);
      const claimRefs = claimKeys.map((k) => db.collection(METER_PENDING_CLAIMS_COLLECTION).doc(k));
      const claimSnaps = await Promise.all(claimRefs.map((ref) => txn.get(ref)));
      for (let i = 0; i < claimRefs.length; i += 1) {
        if (!claimSnaps[i].exists) continue;
        const claim = claimSnaps[i].data() as unknown as MeterPendingClaim;
        if (claim.state === 'void') continue;
        if (claim.state !== 'pending') return { outcome: 'precondition_failed' as const, before };
        if (options.claimExpect && !options.claimExpect(claim as unknown as Record<string, unknown>)) {
          return { outcome: 'precondition_failed' as const, before };
        }
        const claimPatch = withoutAct(claim, peId, options.nowMs);
        if (claimPatch !== null) {
          claimPatches.push({ ref: claimRefs[i], patch: claimPatch });
          terminalClaims.set(claimKeys[i], { ...claim, ...claimPatch });
        }
        // : a window claim that no longer carries the act gave it to a slice a
        // settlement run cut — the act's share has gone on to settle, so the demotion is refused
        // exactly as for a claim that left `pending`.
        else if (claim.unit === 'window') return { outcome: 'precondition_failed' as const, before };
      }
    }
    // A checked bug demotion ends unpaid retention just as a cross-witness takeover does.
    // The aggregate interfaces also admit test doubles; production supplies native references.
    const retireTerminal = meterHome
      && before.mint_status === 'eligible' && DEMOTED_ACT_STATUSES.has(String(after.mint_status))
      ? await prepareDemotedMeterRetention(db as unknown as Firestore, txn as unknown as Transaction,
        [keySnap as unknown as DocumentSnapshot], terminalClaims, options.nowMs) : () => {};
    const writer = new EconomicAggregateWriter(db, txn, options.nowMs);
    await writer.load(EconomicAggregateWriter.identitiesOf(before, after));
    writer.applyMutation(
      before as unknown as PEHistoryDocument,
      after as unknown as PEHistoryDocument,
    );
    const retention = await planComplianceRetention(db as unknown as Firestore, peId, after, options.nowMs);
    const retainLocation = await prepareComplianceRetention(db as unknown as Firestore, txn as unknown as Transaction, retention, options.nowMs);
    await prepareLocationCopyFence(db as unknown as Firestore, txn as unknown as Transaction, String(after.userId ?? ''), [after], options.nowMs, true, retainLocation.actorDeadlines.get(String(after.userId ?? '')));
    if (patch.jurisdiction_context !== undefined || patch.jurisdiction_region !== undefined) patch = { ...patch, jurisdiction_context: after.jurisdiction_context, jurisdiction_region: after.jurisdiction_region };
    retainLocation();
    options.noveltyCounters?.commit(txn as unknown as FirebaseFirestore.Transaction);
    for (const c of claimPatches) txn.set(c.ref, c.patch, { merge: true });
    if (meterHome) {
      // A Genesis grant's key is kept until the grant mints (its reservation is earnings not yet
      // minted); from the mint it expires like any act key. A reorg un-mints it and keeps it again.
      const genesisLifetime = before.is_genesis_grant === true && patch.mint_status !== undefined
        ? { expire_at: after.mint_status === 'minted' ? expireAt(options.nowMs + METER_KEY_LIFETIME_MS) : null }
        : {};
      txn.set(keyRef, { row: patch, ...genesisLifetime }, { merge: true });
    } else if (page !== null) {
      // The page keeps every act of the batch; only this act's row moves (a nested-map merge).
      txn.set(page.ref, { acts: { [peId]: { row: patch } } }, { merge: true });
    } else {
      txn.set(legacyRef, patch, { merge: true });
    }
    retireTerminal();
    // Phase 1: keep the operator-console disposition rollup current when a
    // post-seal change moves a row's mint_disposition (e.g. pending_evidence →
    // eligible). Blind, same-transaction, keyed on the row's ORIGINAL seal day
    // (before.timestamp) so it lands on the bucket the seal-time increment used.
    // No-op unless both sides are valid dispositions and differ.
    adjustConsoleDispositionRollupInTransaction(txn, db, {
      fromDisposition: before.mint_disposition,
      toDisposition: after.mint_disposition,
      sealMs: typeof before.timestamp === 'number' ? before.timestamp : NaN,
      peId,
    });
    writer.commit();
    return { outcome: 'applied' as const, before };
  });
}

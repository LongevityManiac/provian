/**
 * the registry-hold SWEEP: one pass over `pending_review` rows, resolving those held
 * by the registry gate (the tip_pe_missing defect) and re-pricing genuinely-linked ones.
 *
 * Ordered by DOCUMENT ID and resumed from a durable cursor (walks pe_history rather than
 * re-reading its head). Document-id order is deliberate : the sweep filters on
 * `mint_status == 'pending_review'` alone, and a `mint_status`-led composite — e.g. ordering by
 * `timestamp`, or adding a `timestamp` range — is the -forbidden write-hotspot index shape
 * (low-cardinality equality + monotonic key → a hot index tail). Ordering by document id is served
 * by the AUTOMATIC single-field `mint_status` index (no composite in firestore.indexes.json) and has
 * no hotspot; sweep correctness never depended on order (each row is independent and mint-once
 * fenced). The sweep DECIDES nothing about money: it runs the verifier
 * (`registry-hold-verifier.ts`) and, on a resolve verdict, the sole sanctioned writer
 * (`registry-hold-promotion.ts`) inside one transaction. Every registry-hold row that does
 * NOT resolve — verifier left it pending, or the promoter refused it — is listed in
 * `pending_rows` with its reason; nothing stays unresolved silently (directive 3).
 */

import type admin from 'firebase-admin';
import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import { verifyRegistryHold } from './registry-hold-verifier';
import {
  applyRegistryHoldResolutionInTransaction,
  applyRegistryHoldResolutionToHeldAct,
  type RegistryHoldResolutionInput,
  type RegistryHoldResolutionOutcome,
} from './registry-hold-promotion';
import { walkHeldActs } from './held-act-sweep';
import { resolveActionPolicyAtRecordTime } from './policy/action-policy-gate';
import { loadRuntimeMonetaryPolicy } from './policy/runtime-monetary-policy';
import type { RecordEconomicSnapshot } from './policy/monetary-accounting';

export const REGISTRY_HOLD_RESOLUTION_COLLECTION = 'pvt_registry_hold_resolution_v1';
export const REGISTRY_HOLD_RESOLVER_CURSOR_COLLECTION = 'pvt_registry_hold_resolver_cursor_v1';
export const REGISTRY_HOLD_RESOLVER_CURSOR_DOC = 'sweep';
/** PE METER — the cursor of the walk over metered held acts (held_reason `pending_review`). */
export const REGISTRY_HOLD_RESOLVER_HELD_CURSOR_DOC = 'held_sweep';
/**
 * One immutable per-run summary doc, so the ops console can show self-heal
 * FRESHNESS (when the sweep last ran, and how much it healed / left pending)
 * without re-scanning. Keyed by run start (`run_at_ms`) — a plain doc-id write,
 * not a low-cardinality-equality + monotonic composite, so it carries no
 * -forbidden index hotspot. Read-only observability; grants no authority.
 */
export const REGISTRY_HOLD_RESOLVER_RUN_COLLECTION = 'pvt_registry_hold_resolver_run_v1';
const RUN_SUMMARY_SCHEMA = 'pvt-registry-hold-resolver-run/v1';
const CURSOR_SCHEMA = 'pvt-registry-hold-resolver-cursor/v1';
const MAX_PENDING_ROWS_LISTED = 1_000;

export interface RegistryHoldResolverCursorDocument {
  readonly schema_version: typeof CURSOR_SCHEMA;
  readonly last_timestamp_ms: number | null;
  readonly last_pe_id: string | null;
  readonly updated_at_ms: number;
}

export interface RegistryHoldResolverDeps {
  readonly db: Firestore;
  readonly cache: RedisCache;
}

export interface RegistryHoldResolverOptions {
  readonly nowMs: number;
  readonly limit?: number;
}

export interface RegistryHoldPendingRow {
  readonly pe_id: string;
  readonly reason: string;
}

export interface RegistryHoldResolverResult {
  scanned: number;
  resolved_unlinked: number;
  resolved_linked: number;
  left_pending: number;
  skipped_not_registry_hold: number;
  skipped_zero_points: number;
  refused_not_pending: number;
  refused_snapshot_unbound: number;
  refused_not_registry_hold: number;
  refused_other_record_gates: number;
  refused_operational_hold: number;
  refused_not_mint_once_owner: number;
  /** A claimless linked speech act whose speech-window booking could not vouch for its points. */
  refused_booking_unverified: number;
  refused_no_verdict: number;
  population_empty: boolean;
  cursor_advanced: boolean;
  cursor_wrapped: boolean;
  pending_rows: RegistryHoldPendingRow[];
  pending_rows_overflow: number;
  /** PE METER — metered held acts examined (also counted in `scanned` and the tallies). */
  held_acts_scanned: number;
  held_acts_cursor_wrapped: boolean;
}

function emptyResult(): RegistryHoldResolverResult {
  return {
    scanned: 0,
    resolved_unlinked: 0,
    resolved_linked: 0,
    left_pending: 0,
    skipped_not_registry_hold: 0,
    skipped_zero_points: 0,
    refused_not_pending: 0,
    refused_snapshot_unbound: 0,
    refused_not_registry_hold: 0,
    refused_other_record_gates: 0,
    refused_operational_hold: 0,
    refused_not_mint_once_owner: 0,
    refused_booking_unverified: 0,
    refused_no_verdict: 0,
    population_empty: true,
    cursor_advanced: false,
    cursor_wrapped: false,
    pending_rows: [],
    pending_rows_overflow: 0,
    held_acts_scanned: 0,
    held_acts_cursor_wrapped: false,
  };
}

export async function readRegistryHoldResolverCursor(
  db: Firestore,
): Promise<RegistryHoldResolverCursorDocument | null> {
  const snap = await db.collection(REGISTRY_HOLD_RESOLVER_CURSOR_COLLECTION)
    .doc(REGISTRY_HOLD_RESOLVER_CURSOR_DOC)
    .get();
  if (!snap.exists) return null;
  const row = snap.data() as Partial<RegistryHoldResolverCursorDocument> | undefined;
  // Fail forward (same as pending-evidence): losing our place costs a cheap re-scan.
  if (row === undefined || row.schema_version !== CURSOR_SCHEMA) return null;
  return row as RegistryHoldResolverCursorDocument;
}

/** A registry hold: unverifiable linkage + a 'registry' unresolved gate, with real points. */
function registryHoldFactors(
  raw: Record<string, unknown>,
): { snapshot: RecordEconomicSnapshot; hasPoints: boolean } | null {
  const snapshot = raw.economic_snapshot as RecordEconomicSnapshot | undefined;
  const factors = snapshot?.recordTimeFactors;
  if (!snapshot || !factors) return null;
  if (factors.linkageState !== 'unverifiable') return null;
  if (!Array.isArray(factors.unresolvedRecordGates)
    || !factors.unresolvedRecordGates.includes('registry')) return null;
  let hasPoints = false;
  try {
    hasPoints = BigInt(snapshot.recordPointsAtomic) > 0n;
  } catch {
    hasPoints = false;
  }
  return { snapshot, hasPoints };
}

function resolutionRecord(
  input: RegistryHoldResolutionInput,
  options: RegistryHoldResolverOptions,
): Record<string, unknown> {
  return {
    schema_version: 'pvt-registry-hold-resolution/v1',
    pe_id: input.peId,
    economic_actor_id: input.economicActorId,
    linkage: input.verdict.kind === 'resolve' ? input.verdict.linkage : null,
    resolved_at_ms: options.nowMs,
  };
}

/**
 * Judge ONE held row — a pre-meter `pe_history` row or a metered held act's row — and apply its
 * resolution through `apply` (the pre-meter transaction, or the held-act path). One body, so the
 * two populations are judged by exactly the same rule and tallied the same way.
 */
async function resolveOneRegistryHold(
  deps: RegistryHoldResolverDeps,
  options: RegistryHoldResolverOptions,
  result: RegistryHoldResolverResult,
  peId: string,
  raw: Record<string, unknown>,
  apply: (input: RegistryHoldResolutionInput) => Promise<RegistryHoldResolutionOutcome>,
): Promise<void> {
  const hold = registryHoldFactors(raw);
  if (hold === null) { result.skipped_not_registry_hold += 1; return; }
  if (!hold.hasPoints) { result.skipped_zero_points += 1; return; }

  const economicActorId = hold.snapshot.economicActorId;
  const verdict = await verifyRegistryHold({ db: deps.db, cache: deps.cache, economicActorId });
  if (verdict.kind === 'leave_pending') {
    result.left_pending += 1;
    pushPending(result, peId, verdict.reason);
    return;
  }

  const resolution = await resolveActionPolicyAtRecordTime(deps.db, {
    actionType: hold.snapshot.actionType,
    recordedAtMs: hold.snapshot.recordedAtMs,
  });
  const policy = await loadRuntimeMonetaryPolicy(deps.db, hold.snapshot.recordedAtMs, resolution);

  const outcome = await apply({
    peId,
    economicActorId,
    economicSnapshotHash: (raw.economic_snapshot_hash as string | null) ?? null,
    verdict,
    policy,
    nowMs: options.nowMs,
  });

  switch (outcome) {
    case 'resolved':
      if (verdict.linkage === 'beneficiary_linked') result.resolved_linked += 1;
      else result.resolved_unlinked += 1;
      break;
    case 'refused_not_pending':
      result.refused_not_pending += 1;
      pushPending(result, peId, 'refused_not_pending');
      break;
    case 'refused_snapshot_unbound':
      result.refused_snapshot_unbound += 1;
      pushPending(result, peId, 'refused_snapshot_unbound');
      break;
    case 'refused_not_registry_hold':
      result.refused_not_registry_hold += 1;
      pushPending(result, peId, 'refused_not_registry_hold');
      break;
    case 'refused_other_record_gates':
      result.refused_other_record_gates += 1;
      pushPending(result, peId, 'refused_other_record_gates');
      break;
    case 'refused_operational_hold':
      result.refused_operational_hold += 1;
      pushPending(result, peId, 'refused_operational_hold');
      break;
    case 'refused_not_mint_once_owner':
      result.refused_not_mint_once_owner += 1;
      pushPending(result, peId, 'refused_not_mint_once_owner');
      break;
    case 'refused_booking_unverified':
      result.refused_booking_unverified += 1;
      pushPending(result, peId, 'refused_booking_unverified');
      break;
    case 'refused_no_verdict':
      result.refused_no_verdict += 1;
      pushPending(result, peId, 'refused_no_verdict');
      break;
  }
}

function pushPending(result: RegistryHoldResolverResult, peId: string, reason: string): void {
  if (result.pending_rows.length < MAX_PENDING_ROWS_LISTED) {
    result.pending_rows.push({ pe_id: peId, reason });
  } else {
    result.pending_rows_overflow += 1;
  }
}

/** One sweep pass. Resolvable registry holds are released; the rest are reported. */
export async function sweepRegistryHolds(
  deps: RegistryHoldResolverDeps,
  options: RegistryHoldResolverOptions,
): Promise<RegistryHoldResolverResult> {
  const startedAtMs = Date.now();
  const result = emptyResult();
  const limit = options.limit ?? 100;
  const cursor = await readRegistryHoldResolverCursor(deps.db);

  // mint_status alone + orderBy(documentId): the automatic single-field mint_status index serves
  // this (no composite), and document-id order carries no write hotspot — unlike a mint_status-led
  // timestamp order, which is the -forbidden shape (see the module docblock).
  const base = deps.db.collection('pe_history')
    .where('mint_status', '==', 'pending_review')
    .orderBy(FieldPath.documentId());
  const resumable = cursor !== null && cursor.last_pe_id !== null;
  let snapshot = await (resumable
    ? base.startAfter(cursor.last_pe_id)
    : base).limit(limit).get();
  if (snapshot.empty && resumable) {
    // Wrap to the head so a later transient leave_pending is retried on the next cycle.
    snapshot = await base.limit(limit).get();
    result.cursor_wrapped = true;
  }

  let lastTimestampMs: number | null = null;
  let lastPeId: string | null = null;

  for (const doc of snapshot.docs) {
    result.scanned += 1;
    const raw = doc.data() as Record<string, unknown>;
    // Advance the cursor past EVERY scanned row so no row becomes a permanent occupant.
    lastTimestampMs = typeof raw.timestamp === 'number' ? raw.timestamp : lastTimestampMs;
    lastPeId = doc.id;
    await resolveOneRegistryHold(deps, options, result, doc.id, raw, async (input) => (
      deps.db.runTransaction(async (txn) => {
        // Firestore requires ALL reads before ALL writes in a transaction. Read the
        // audit marker FIRST — the promoter below both reads and WRITES, so a
        // txn.get after it would throw "reads must precede writes". This is an
        // idempotent audit doc; the promoter's mint_status CAS is the real
        // one-mint-per-row guard, so reading it up front changes no semantics.
        const resolutionRef = deps.db.collection(REGISTRY_HOLD_RESOLUTION_COLLECTION).doc(doc.id);
        const existingResolution = await txn.get(resolutionRef);
        const o = await applyRegistryHoldResolutionInTransaction(deps.db, txn, input);
        if (o === 'resolved' && !existingResolution.exists) {
          txn.set(resolutionRef, resolutionRecord(input, options));
        }
        return o;
      })
    ));
  }

  if (lastPeId !== null) {
    await deps.db.collection(REGISTRY_HOLD_RESOLVER_CURSOR_COLLECTION)
      .doc(REGISTRY_HOLD_RESOLVER_CURSOR_DOC)
      .set({
        schema_version: CURSOR_SCHEMA,
        last_timestamp_ms: lastTimestampMs,
        last_pe_id: lastPeId,
        updated_at_ms: options.nowMs,
      });
    result.cursor_advanced = true;
  }

  // PE METER — the second population: metered acts held at `pending_review`. Same filters, same
  // verifier, same judgement; the transition is the held-act path of the sanctioned promoter, and a
  // resolution writes the same audit record. Its own resumable cursor, one page of `limit` per pass.
  const held = await walkHeldActs(deps.db, 'pending_review', {
    cursor: { collection: REGISTRY_HOLD_RESOLVER_CURSOR_COLLECTION, docId: REGISTRY_HOLD_RESOLVER_HELD_CURSOR_DOC },
    nowMs: options.nowMs,
    limit,
    maxPages: 1,
  }, async (heldAct) => {
    result.scanned += 1;
    result.held_acts_scanned += 1;
    await resolveOneRegistryHold(deps, options, result, heldAct.relayPeId, heldAct.row, async (input) => {
      const o = await applyRegistryHoldResolutionToHeldAct(deps.db, input);
      if (o === 'resolved') {
        const resolutionRef = deps.db.collection(REGISTRY_HOLD_RESOLUTION_COLLECTION).doc(heldAct.relayPeId);
        await deps.db.runTransaction(async (txn) => {
          const existingResolution = await txn.get(resolutionRef);
          if (!existingResolution.exists) txn.set(resolutionRef, resolutionRecord(input, options));
        });
      }
      return o;
    });
  });
  result.held_acts_cursor_wrapped = held.wrapped;
  result.population_empty = result.scanned === 0;

  // Per-run summary (self-heal freshness for the ops console). Written
  // UNCONDITIONALLY — even a 0-row scan records that the sweep ran, so the
  // console can distinguish "healthy, nothing to heal" from "sweep stalled".
  // Best-effort: a summary-write failure must never fail the sweep itself.
  try {
    await deps.db.collection(REGISTRY_HOLD_RESOLVER_RUN_COLLECTION)
      .doc(String(options.nowMs))
      .set({
        schema_version: RUN_SUMMARY_SCHEMA,
        run_at_ms: options.nowMs,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        limit,
        scanned: result.scanned,
        resolved_linked: result.resolved_linked,
        resolved_unlinked: result.resolved_unlinked,
        left_pending: result.left_pending,
        skipped_not_registry_hold: result.skipped_not_registry_hold,
        skipped_zero_points: result.skipped_zero_points,
        refused_not_pending: result.refused_not_pending,
        refused_snapshot_unbound: result.refused_snapshot_unbound,
        refused_not_registry_hold: result.refused_not_registry_hold,
        refused_other_record_gates: result.refused_other_record_gates,
        refused_operational_hold: result.refused_operational_hold,
        refused_not_mint_once_owner: result.refused_not_mint_once_owner,
        refused_booking_unverified: result.refused_booking_unverified,
        refused_no_verdict: result.refused_no_verdict,
        pending_rows_listed: result.pending_rows.length,
        pending_rows_overflow: result.pending_rows_overflow,
        held_acts_scanned: result.held_acts_scanned,
        held_acts_cursor_wrapped: result.held_acts_cursor_wrapped,
        cursor_advanced: result.cursor_advanced,
        cursor_wrapped: result.cursor_wrapped,
        population_empty: result.population_empty,
      });
  } catch (err) {
    console.warn('[RegistryHoldResolver] run-summary write failed:', (err as Error)?.message);
  }

  return result;
}

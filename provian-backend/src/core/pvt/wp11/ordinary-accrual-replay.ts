/**
 * THE REPLAY DRIVER for the ordinary accrual intake.
 *
 * WHY IT EXISTS. `ordinary-accrual-intake.ts` has co-committed an exact replay
 * payload with every mainline PE since cutover reconciliation, and its own docblock said, in as
 * many words, that nothing consumed it. A durable record nobody replays is not
 * durability — it is a filing cabinet. That was tolerable while the mainline
 * sealed `record_only` and minted 0 no matter what; the moment those PEs carry
 * a real disposition, an accrual lost to a crash between the tip
 * commit and the fire-and-forget call is lost participation that can never be
 * reconstructed, because the PE it belonged to is already sealed and sealed
 * snapshots do not reprice.
 *
 * So this is the other half: find the rows whose accrual did not complete, and
 * finish them from the committed payload.
 *
 * ── EXACTLY ONCE, AND WHY IT ALREADY IS ──────────────────────────────────────
 * This module adds no new idempotency. It relies on two that ship today and are
 * exercised by the acceptance suites:
 *
 * - `writePEHistory` is a create-if-absent seal. A replay after the seal
 * returns `didWrite: false` and never re-seals or re-prices.
 * - `resumeDurableAccrualEffects` is a per-PE state machine
 * (pending → firestore_committed → complete). A fully-applied outbox is a
 * no-op; a partially-applied one finishes exactly the omitted part.
 *
 * Which is why the replay simply CALLS `recordPEAccrual` with the stored params
 * verbatim, rather than reimplementing any part of it. The stored params carry
 * `durableReplaySource`, so the replay is classified and priced identically to
 * the live call — one payload, one kernel, no second lane to drift.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
 * - NOT retroactive. It only ever completes an accrual that was ALREADY
 * initiated for a committed PE. It cannot reprice a sealed pe_history row,
 * and there is deliberately no path here that touches one.
 * - NOT a mint or settlement path. It writes no claim, consumes no epoch
 * headroom, and submits no transaction.
 * - NOT a way to make an act eligible. Whatever the disposition table says for
 * that action type at its RECORD time is what the replay seals, because the
 * replay runs the same kernel over the same recorded timestamp.
 */

import type admin from 'firebase-admin';
import {
  DURABLE_ACCRUAL_EFFECTS_COLLECTION,
  type DurableAccrualEffectDocument,
} from '../durable-accrual-effects';
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  isOrdinaryAccrualIntakeDocument,
  verifyOrdinaryAccrualIntakeBinding,
  type OrdinaryAccrualIntakeDocument,
  type OrdinaryAccrualReplayParams,
} from './ordinary-accrual-intake';

/** Per-PE replay bookkeeping. Separate doc so the intake row stays write-once. */
export const ORDINARY_ACCRUAL_REPLAY_STATE_COLLECTION = 'pvt_ordinary_accrual_replay_state_v1';

/**
 * THE SWEEP CURSOR, and why the sweep was worthless without one.
 *
 * The first cut of this driver queried `recorded_at_ms <= cutoff` ordered
 * ASCENDING with a page limit and no other filter. The intake collection is
 * `create`-only — nothing in this tree deletes, prunes or TTLs a row — and
 * completion lives in a DIFFERENT collection the query cannot join. So the page
 * was the same oldest N rows on every run, forever. Once the collection passed
 * N (it did, months ago), a stranded accrual outside that window could never be
 * reached: the sweep reported `scanned: N, already_complete: N, recovered: 0`
 * and looked perfectly healthy while doing nothing at all. `binding_rejected`
 * and `exhausted` rows were permanent occupants of the window, shrinking its
 * reach further on every pass.
 *
 * 's live production proof — `{"scanned" 3,"already_complete" 3}` did not
 * catch it precisely because the whole backlog was 3 rows, i.e. smaller than the
 * page. A sweep that cannot advance is indistinguishable from a healthy one
 * until the collection outgrows one page.
 *
 * The fix is a durable cursor: each pass resumes strictly AFTER the last row the
 * previous pass examined, and wraps to the beginning when it reaches the end of
 * the eligible range. Coverage is therefore complete over successive passes,
 * work per pass stays bounded, and no row can occupy the window permanently.
 */
export const ORDINARY_ACCRUAL_REPLAY_CURSOR_COLLECTION = 'pvt_ordinary_accrual_replay_cursor_v1';
export const ORDINARY_ACCRUAL_REPLAY_CURSOR_DOC = 'sweep';

export interface OrdinaryAccrualReplayCursorDocument {
  readonly schema_version: 'pvt-ordinary-accrual-replay-cursor/v1';
  /** `recorded_at_ms` of the last row examined, or null at the start of a cycle. */
  readonly last_recorded_at_ms: number | null;
  /** `pe_id` of the last row examined — the tiebreak within one millisecond. */
  readonly last_pe_id: string | null;
  readonly updated_at_ms: number;
  /** How many times the cursor has wrapped back to the beginning. */
  readonly cycles_completed: number;
}

/**
 * How long an intake row is left alone before it is considered abandoned. The
 * live fire-and-forget accrual runs milliseconds after the tip commit; this is
 * generous so a replay can never race an in-flight first attempt and land a
 * concurrent duplicate reservation attempt on the same PE.
 */
export const ORDINARY_ACCRUAL_REPLAY_GRACE_MS = 10 * 60 * 1000;

/**
 * Bounded retries. A payload that cannot complete after this many passes is a
 * defect to look at, not a job to run forever; it is parked `exhausted` and
 * counted, never silently dropped and never retried into a hot loop.
 */
export const ORDINARY_ACCRUAL_REPLAY_MAX_ATTEMPTS = 5;

export type OrdinaryAccrualReplayOutcome =
  | 'already_complete'
  | 'recovered'
  | 'incomplete'
  | 'binding_rejected'
  | 'exhausted'
  | 'failed';

export interface OrdinaryAccrualReplayStateDocument {
  readonly schema_version: 'pvt-ordinary-accrual-replay-state/v1';
  readonly pe_id: string;
  readonly attempts: number;
  readonly first_attempt_at_ms: number;
  readonly last_attempt_at_ms: number;
  readonly last_outcome: OrdinaryAccrualReplayOutcome;
  readonly state: 'pending' | 'complete' | 'exhausted' | 'rejected';
}

export interface OrdinaryAccrualReplayResult {
  /** Intake rows examined this pass (candidates, before completeness checks). */
  scanned: number;
  /** Rows already fully applied — the expected steady-state outcome. */
  already_complete: number;
  /** Rows whose omitted effects this pass finished. */
  recovered: number;
  /** Replayed but still not complete; left for the next pass. */
  incomplete: number;
  /** Rows refused by the binding check (mutated after commit). */
  binding_rejected: number;
  /** Rows parked after exhausting the attempt bound. */
  exhausted: number;
  /** Replays that threw. */
  failed: number;
}

export interface OrdinaryAccrualReplayDeps {
  readonly db: admin.firestore.Firestore;
  /**
   * Injected rather than imported so this module does not pull the accrual (and
   * its whole dependency tree) into every consumer, and so the suite can drive
   * a crash without monkey-patching a module. Production passes the real
   * `recordPEAccrual`.
   */
  readonly recordPEAccrual: (params: OrdinaryAccrualReplayParams) => Promise<unknown>;
}

export interface OrdinaryAccrualReplayOptions {
  /** Evaluation instant. Required — this module performs no implicit clock read. */
  readonly nowMs: number;
  readonly limit?: number;
  readonly graceMs?: number;
  readonly maxAttempts?: number;
}

function emptyResult(): OrdinaryAccrualReplayResult {
  return {
    scanned: 0,
    already_complete: 0,
    recovered: 0,
    incomplete: 0,
    binding_rejected: 0,
    exhausted: 0,
    failed: 0,
  };
}

/**
 * Is this PE's accrual fully applied? TRUE only when its derived-effect outbox
 * exists AND reports `complete`.
 *
 * Deliberately NOT "does pe_history exist". A crash between the seal and the
 * derived aggregates leaves a sealed row with an unapplied outbox — the exact
 * gap this driver closes — so treating the seal as completion would skip
 * precisely the rows that need work.
 */
async function isAccrualComplete(
  db: admin.firestore.Firestore,
  peId: string,
): Promise<boolean> {
  const snapshot = await db.collection(DURABLE_ACCRUAL_EFFECTS_COLLECTION).doc(peId).get();
  if (!snapshot.exists) return false;
  const effect = snapshot.data() as DurableAccrualEffectDocument | undefined;
  return effect?.state === 'complete';
}

async function readReplayState(
  db: admin.firestore.Firestore,
  peId: string,
): Promise<OrdinaryAccrualReplayStateDocument | null> {
  const snapshot = await db.collection(ORDINARY_ACCRUAL_REPLAY_STATE_COLLECTION).doc(peId).get();
  if (!snapshot.exists) return null;
  return (snapshot.data() ?? null) as OrdinaryAccrualReplayStateDocument | null;
}

async function writeReplayState(
  db: admin.firestore.Firestore,
  peId: string,
  prior: OrdinaryAccrualReplayStateDocument | null,
  nowMs: number,
  outcome: OrdinaryAccrualReplayOutcome,
  state: OrdinaryAccrualReplayStateDocument['state'],
): Promise<void> {
  const doc: OrdinaryAccrualReplayStateDocument = {
    schema_version: 'pvt-ordinary-accrual-replay-state/v1',
    pe_id: peId,
    attempts: (prior?.attempts ?? 0) + 1,
    first_attempt_at_ms: prior?.first_attempt_at_ms ?? nowMs,
    last_attempt_at_ms: nowMs,
    last_outcome: outcome,
    state,
  };
  await db.collection(ORDINARY_ACCRUAL_REPLAY_STATE_COLLECTION).doc(peId).set({ ...doc });
}

/**
 * Replay ONE intake row. Exported so the acceptance suite can drive a single
 * recovery without a query, and so a future operator tool can re-run one PE.
 *
 * The binding check runs FIRST and is fatal for the row: a payload that no
 * longer hashes to its committed digest was mutated after commit, and replaying
 * a mutated economic input is exactly the thing an outbox exists to prevent.
 */
export async function replayOrdinaryAccrual(
  deps: OrdinaryAccrualReplayDeps,
  intake: OrdinaryAccrualIntakeDocument,
  options: OrdinaryAccrualReplayOptions,
): Promise<OrdinaryAccrualReplayOutcome> {
  const { db } = deps;
  const peId = intake.pe_id;
  const maxAttempts = options.maxAttempts ?? ORDINARY_ACCRUAL_REPLAY_MAX_ATTEMPTS;

  if (await isAccrualComplete(db, peId)) return 'already_complete';

  const prior = await readReplayState(db, peId);
  if (prior !== null && prior.state === 'rejected') return 'binding_rejected';
  if (prior !== null && prior.attempts >= maxAttempts) {
    if (prior.state !== 'exhausted') {
      await writeReplayState(db, peId, prior, options.nowMs, 'exhausted', 'exhausted');
      console.error('[OrdinaryAccrualReplay] attempt bound reached, parking PE', {
        peId, attempts: prior.attempts,
      });
    }
    return 'exhausted';
  }

  if (!verifyOrdinaryAccrualIntakeBinding(intake)) {
    await writeReplayState(db, peId, prior, options.nowMs, 'binding_rejected', 'rejected');
    console.error('[OrdinaryAccrualReplay] intake integrity FAILED, refusing replay', { peId });
    return 'binding_rejected';
  }

  try {
    // The stored payload, verbatim. No field is added, removed or defaulted
    // here: any perturbation would break the digest binding the accrual itself
    // re-checks, and the row would stop being classified durable — a silent
    // downgrade to record_only rather than an error.
    await deps.recordPEAccrual(intake.accrual_params);
  } catch (error) {
    await writeReplayState(db, peId, prior, options.nowMs, 'failed', 'pending');
    console.error('[OrdinaryAccrualReplay] replay threw for PE', peId, error);
    return 'failed';
  }

  const complete = await isAccrualComplete(db, peId);
  await writeReplayState(
    db,
    peId,
    prior,
    options.nowMs,
    complete ? 'recovered' : 'incomplete',
    complete ? 'complete' : 'pending',
  );
  return complete ? 'recovered' : 'incomplete';
}

export async function readReplayCursor(
  db: admin.firestore.Firestore,
): Promise<OrdinaryAccrualReplayCursorDocument | null> {
  const snapshot = await db.collection(ORDINARY_ACCRUAL_REPLAY_CURSOR_COLLECTION)
    .doc(ORDINARY_ACCRUAL_REPLAY_CURSOR_DOC)
    .get();
  if (!snapshot.exists) return null;
  const row = snapshot.data() as Partial<OrdinaryAccrualReplayCursorDocument> | undefined;
  if (row === undefined || row.schema_version !== 'pvt-ordinary-accrual-replay-cursor/v1') {
    // Fail-FORWARD here, not fail-closed, and the direction is deliberate: an
    // unreadable cursor must never wedge the sweep. Losing our place costs a
    // re-scan of already-complete rows (cheap, idempotent, no writes); refusing
    // to sweep costs the recovery this driver exists for.
    return null;
  }
  return row as OrdinaryAccrualReplayCursorDocument;
}

async function writeReplayCursor(
  db: admin.firestore.Firestore,
  next: OrdinaryAccrualReplayCursorDocument,
): Promise<void> {
  await db.collection(ORDINARY_ACCRUAL_REPLAY_CURSOR_COLLECTION)
    .doc(ORDINARY_ACCRUAL_REPLAY_CURSOR_DOC)
    .set({ ...next });
}

/**
 * One sweep: find intake rows older than the grace window and finish any whose
 * accrual did not complete.
 *
 * Ordered oldest-first and resumed from the durable cursor, so successive passes
 * WALK the collection instead of re-reading its head. When a pass runs off the
 * end of the eligible range the cursor wraps, which is what makes coverage
 * complete rather than merely bounded — see the cursor docblock above for the
 * defect this shape exists to prevent.
 */
export async function replayIncompleteOrdinaryAccruals(
  deps: OrdinaryAccrualReplayDeps,
  options: OrdinaryAccrualReplayOptions,
): Promise<OrdinaryAccrualReplayResult> {
  const result = emptyResult();
  const graceMs = options.graceMs ?? ORDINARY_ACCRUAL_REPLAY_GRACE_MS;
  const cutoff = options.nowMs - graceMs;
  const limit = options.limit ?? 200;

  const cursor = await readReplayCursor(deps.db);
  const base = deps.db.collection(ORDINARY_ACCRUAL_INTAKE_COLLECTION)
    .where('recorded_at_ms', '<=', cutoff)
    .orderBy('recorded_at_ms', 'asc')
    .orderBy('pe_id', 'asc');

  const resumable = cursor !== null
    && cursor.last_recorded_at_ms !== null
    && cursor.last_pe_id !== null;
  let snapshot = await (resumable
    ? base.startAfter(cursor.last_recorded_at_ms, cursor.last_pe_id)
    : base).limit(limit).get();

  // End of the eligible range: wrap to the beginning so the next region (and any
  // row that became incomplete BEHIND the cursor) is reached on THIS pass rather
  // than deferred to a pass that would start from the same exhausted position.
  let wrapped = false;
  if (snapshot.empty && resumable) {
    wrapped = true;
    snapshot = await base.limit(limit).get();
  }

  let lastRecordedAtMs: number | null = null;
  let lastPeId: string | null = null;

  for (const doc of snapshot.docs) {
    result.scanned += 1;
    const row: unknown = doc.data();
    if (!isOrdinaryAccrualIntakeDocument(row)) {
      // Fail-closed on the ROW: an unrecognized shape is never guessed at or
      // "repaired". The cursor still advances past it — a row we refuse to act
      // on must not become a permanent occupant of the window, which is the
      // second half of the defect the cursor fixes.
      result.binding_rejected += 1;
      const raw = row as { recorded_at_ms?: unknown } | null;
      if (raw !== null && typeof raw.recorded_at_ms === 'number') {
        lastRecordedAtMs = raw.recorded_at_ms;
        lastPeId = doc.id;
      }
      console.error('[OrdinaryAccrualReplay] malformed intake row, skipping', { peId: doc.id });
      continue;
    }
    lastRecordedAtMs = row.recorded_at_ms;
    lastPeId = row.pe_id;
    const outcome = await replayOrdinaryAccrual(deps, row, options);
    result[outcome] += 1;
  }

  // A short page means we reached the end of the eligible range: reset so the
  // next pass starts a fresh cycle rather than sitting past the last row.
  const reachedEnd = snapshot.size < limit;
  await writeReplayCursor(deps.db, {
    schema_version: 'pvt-ordinary-accrual-replay-cursor/v1',
    last_recorded_at_ms: reachedEnd ? null : lastRecordedAtMs,
    last_pe_id: reachedEnd ? null : lastPeId,
    updated_at_ms: options.nowMs,
    cycles_completed: (cursor?.cycles_completed ?? 0) + (reachedEnd || wrapped ? 1 : 0),
  });

  return result;
}

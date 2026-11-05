/**
 * cutover reconciliation — durable ordinary-PE accrual intake (the source outbox for every
 * ordinary best-effort accrual path that is intended to mint post-activation).
 *
 * WHAT THIS IS: a write-once, per-PE durable capture of the EXACT
 * `RecordPEAccrualParams` a best-effort caller fires at `recordPEAccrual`,
 * co-committed in the SAME Firestore transaction that advances the caller's PE
 * hash-chain tip and persists the provisional PE document. Because the intake
 * rides the tip transaction, the invariant is: the PE product record exists
 * ⟺ its intake row exists. A process crash after the tip commit but before
 * (or during) the fire-and-forget accrual leaves a complete, deterministic
 * replay source behind.
 *
 * ── THIS IS NOW A CONSUMED REPLAY SOURCE ─────────────────────────────
 * When it was written, nothing read this collection and the docblock said so.
 * found the consequence: the mainline agent path had a durable record
 * behind it and still sealed `record_only`, because `durableEconomicPath` was
 * computed from `throwOnError` alone. Two things changed, and neither of them
 * is the disposition rule:
 *
 * 1. A caller that co-commits an intake row MAY say so, by putting
 * `durableReplaySource: 'ordinary_accrual_intake'` in the very params it
 * stores here. The claim is VERIFIED at accrual time against this row —
 * existence, shape, hash integrity, and byte-equality with the live params
 * and a claim that fails any check is refused (record_only, fail-closed).
 * `verifyOrdinaryAccrualIntakeReplaySource` below is that check.
 * 2. `ordinary-accrual-replay.ts` replays incomplete rows from here. Because
 * the marker lives INSIDE the stored params, a replay prices identically
 * to the live call by construction — there is no lane to drift between.
 *
 * WHAT THIS IS STILL NOT — read carefully before touching:
 * - NOT eligibility authority. It decides that a caller is REPLAYABLE, never
 * that an act is payable. The action-policy disposition table is untouched:
 * an action type whose policy is `record_only` still seals `record_only`
 * through this path, and an evidence-requiring type with no verified
 * evidence still seals `pending_evidence`. The outbox makes eligible acts
 * price; it makes nothing eligible that was not.
 * - NOT mint or settlement authority. `status` remains the single terminal
 * literal 'recorded'; no processor in this tree transitions it, and PVT9
 * settlement still consumes only the reservation outbox / claim inlet.
 * - NOT retroactive. PEs sealed record_only before their path gained a
 * verified marker stay record_only forever ("a later cache recovery must
 * never turn an unclassified identifier into money" pe-history.ts). There
 * is no backfill here and there must never be one: a sealed snapshot is
 * sealed.
 *
 * Builders are PURE and synchronous: they run inside Firestore transactions
 * (which may re-run on contention), so they derive every field from their
 * inputs — no Date.now(), no reads, no I/O.
 */

import * as crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import type admin from 'firebase-admin';
import type { RecordPEAccrualParams } from '../../../pvt-accrual';

/** Firestore collection holding ordinary-accrual intake rows. Keyed by pe_id. */
export const ORDINARY_ACCRUAL_INTAKE_COLLECTION = 'pvt_ordinary_accrual_intake_v1';

export const ORDINARY_ACCRUAL_INTAKE_SCHEMA_VERSION = 'pvt-ordinary-accrual-intake/v1';

/**
 * The ONLY value `RecordPEAccrualParams.durableReplaySource` may carry, and the
 * only durable replay source this collection can vouch for. A single literal on
 * purpose: an open string would let a caller name a source that does not exist,
 * which is the failure mode the verification below exists to prevent.
 */
export const ORDINARY_ACCRUAL_REPLAY_SOURCE = 'ordinary_accrual_intake';
export type OrdinaryAccrualReplaySource = typeof ORDINARY_ACCRUAL_REPLAY_SOURCE;

/**
 * The exact replay payload: the caller's `RecordPEAccrualParams` with the two
 * transport-only fields stripped (`throwOnError` marks a durable caller —
 * these rows exist precisely because the caller is NOT durable — and
 * `durableTestCrashAt` is test-only crash injection). JSON-serializable by
 * construction; `undefined` members are dropped at serialization time so the
 * stored object round-trips byte-identically through the params hash.
 */
export type OrdinaryAccrualReplayParams = Omit<
  RecordPEAccrualParams,
  'throwOnError' | 'durableTestCrashAt'
>;

export interface OrdinaryAccrualIntakeDocument {
  readonly schema_version: typeof ORDINARY_ACCRUAL_INTAKE_SCHEMA_VERSION;
  readonly pe_id: string;
  readonly user_id: string;
  readonly action_type: string;
  readonly integration_source: string;
  /** The committed PE hash (chain-tip value) this intake is bound to. */
  readonly pe_hash: string;
  /** The chain-tip hash the PE chained from (binding to the exact commit). */
  readonly prev_hash: string;
  /** The PE's own timestamp — also this row's deterministic creation time. */
  readonly recorded_at_ms: number;
  /** Exact replay input (sanitized `RecordPEAccrualParams`). */
  readonly accrual_params: OrdinaryAccrualReplayParams;
  /** sha256 over stableStringify(accrual_params); replay integrity binding. */
  readonly accrual_params_sha256: string;
  /**
   * Terminal in cutover reconciliation. A future settlement processor (activation-canaried,
   * separately activated) owns any transition; none exists in this codebase.
   */
  readonly status: 'recorded';
}

/**
 * Drop `undefined` members (Firestore rejects them) and strip transport-only
 * fields, without perturbing any present value. Pure.
 */
export function sanitizeOrdinaryAccrualReplayParams(
  params: RecordPEAccrualParams,
): OrdinaryAccrualReplayParams {
  const { throwOnError: _throwOnError, durableTestCrashAt: _crashAt, ...replay } = params;
  const serialized = stableStringify(replay);
  if (serialized === undefined) {
    throw new Error('ordinary_accrual_intake_params_unserializable');
  }
  return JSON.parse(serialized) as OrdinaryAccrualReplayParams;
}

export function hashOrdinaryAccrualReplayParams(
  params: OrdinaryAccrualReplayParams,
): string {
  const serialized = stableStringify(params);
  if (serialized === undefined) {
    throw new Error('ordinary_accrual_intake_params_unserializable');
  }
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Build the intake row. PURE — safe inside a transaction retry. The caller
 * supplies the exact params object it will later fire at `recordPEAccrual`
 * (built from the same committed prevHash/peHash), so the stored replay input
 * and the live accrual input cannot drift.
 */
export function buildOrdinaryAccrualIntake(input: {
  prevHash: string;
  peHash: string;
  accrualParams: RecordPEAccrualParams;
}): OrdinaryAccrualIntakeDocument {
  if (input.accrualParams.throwOnError === true) {
    // A durable caller has its own outbox (durable-accrual-effects / Genesis);
    // writing an ordinary intake for it would create two replay authorities.
    throw new Error('ordinary_accrual_intake_durable_caller_rejected');
  }
  if (input.accrualParams.peHash !== input.peHash) {
    throw new Error('ordinary_accrual_intake_pe_hash_binding_mismatch');
  }
  // A durable-source marker naming anything other than THIS collection would be
  // vouched for by a row that cannot back it. Refuse at build time rather than
  // storing a claim the verifier will later reject.
  const claim: unknown = (input.accrualParams as { durableReplaySource?: unknown })
    .durableReplaySource;
  if (claim !== undefined && claim !== ORDINARY_ACCRUAL_REPLAY_SOURCE) {
    throw new Error('ordinary_accrual_intake_unknown_replay_source');
  }
  const replay = sanitizeOrdinaryAccrualReplayParams(input.accrualParams);
  return {
    schema_version: ORDINARY_ACCRUAL_INTAKE_SCHEMA_VERSION,
    pe_id: input.accrualParams.peId,
    user_id: input.accrualParams.userId,
    action_type: input.accrualParams.actionType,
    integration_source: input.accrualParams.integrationSource ?? 'unspecified',
    pe_hash: input.peHash,
    prev_hash: input.prevHash,
    recorded_at_ms: input.accrualParams.timestamp,
    accrual_params: replay,
    accrual_params_sha256: hashOrdinaryAccrualReplayParams(replay),
    status: 'recorded',
  };
}

/**
 * Synchronous transactional co-write. `create` (not `set`) so a duplicate
 * intake for an existing pe_id fails the WHOLE transaction — the tip advance,
 * the provisional PE, and the intake commit or roll back together.
 */
export function createOrdinaryAccrualIntakeInTransaction(
  txn: admin.firestore.Transaction,
  db: admin.firestore.Firestore,
  doc: OrdinaryAccrualIntakeDocument,
): void {
  txn.create(
    db.collection(ORDINARY_ACCRUAL_INTAKE_COLLECTION).doc(doc.pe_id),
    { ...doc },
  );
}

const INTAKE_KEYS: readonly string[] = [
  'schema_version',
  'pe_id',
  'user_id',
  'action_type',
  'integration_source',
  'pe_hash',
  'prev_hash',
  'recorded_at_ms',
  'accrual_params',
  'accrual_params_sha256',
  'status',
];

/**
 * Intake-side validator (the read half of outbox+intake). Exact-keys and
 * binding-checked, mirroring the Genesis outbox validators: a future
 * processor must reject any row that fails this BEFORE considering it a
 * replay source. Fail-closed: unknown shape ⇒ not a valid intake.
 */
export function isOrdinaryAccrualIntakeDocument(
  value: unknown,
): value is OrdinaryAccrualIntakeDocument {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.length !== INTAKE_KEYS.length
    || [...INTAKE_KEYS].sort().some((k, i) => keys[i] !== k)) {
    return false;
  }
  if (row.schema_version !== ORDINARY_ACCRUAL_INTAKE_SCHEMA_VERSION) return false;
  if (row.status !== 'recorded') return false;
  if (typeof row.pe_id !== 'string' || row.pe_id.length === 0) return false;
  if (typeof row.user_id !== 'string' || row.user_id.length === 0) return false;
  if (typeof row.action_type !== 'string' || row.action_type.length === 0) return false;
  if (typeof row.integration_source !== 'string') return false;
  if (typeof row.pe_hash !== 'string' || row.pe_hash.length === 0) return false;
  if (typeof row.prev_hash !== 'string') return false;
  if (typeof row.recorded_at_ms !== 'number' || !Number.isSafeInteger(row.recorded_at_ms)) {
    return false;
  }
  if (typeof row.accrual_params !== 'object' || row.accrual_params === null) return false;
  if (typeof row.accrual_params_sha256 !== 'string') return false;
  const params = row.accrual_params as Record<string, unknown>;
  if (params.peId !== row.pe_id) return false;
  if (params.userId !== row.user_id) return false;
  if (params.actionType !== row.action_type) return false;
  if (params.peHash !== row.pe_hash) return false;
  if (params.timestamp !== row.recorded_at_ms) return false;
  // A durable-transport marker inside a stored replay payload is corruption.
  if ('throwOnError' in params || 'durableTestCrashAt' in params) return false;
  // The replay-source marker, when present, may only name THIS collection.
  if ('durableReplaySource' in params
    && params.durableReplaySource !== ORDINARY_ACCRUAL_REPLAY_SOURCE) {
    return false;
  }
  return true;
}

/**
 * Replay-integrity verification: the stored params must re-hash to the stored
 * digest. A mismatch means the row was mutated after commit and must never be
 * replayed.
 *
 * When `expected` is supplied, the row is ALSO bound to a specific committed
 * chain tip: its `pe_hash`/`prev_hash` (and the pe_hash inside the stored replay
 * params) must equal the expected commit. A future replay processor passes the
 * tip it is replaying so it can never resurrect a row against a different
 * commit; callers that only need the integrity check omit it.
 */
export function verifyOrdinaryAccrualIntakeBinding(
  doc: OrdinaryAccrualIntakeDocument,
  expected?: { peHash: string; prevHash: string },
): boolean {
  if (hashOrdinaryAccrualReplayParams(doc.accrual_params) !== doc.accrual_params_sha256) {
    return false;
  }
  if (expected !== undefined) {
    if (doc.pe_hash !== expected.peHash
      || doc.prev_hash !== expected.prevHash
      || doc.accrual_params.peHash !== expected.peHash) {
      return false;
    }
  }
  return true;
}

/** Why a durable-replay-source claim was refused. Every arm is reachable. */
export type OrdinaryDurableSourceRejection =
  | 'not_claimed'
  | 'unknown_source'
  | 'read_failed'
  | 'intake_missing'
  | 'intake_malformed'
  | 'intake_integrity_failed'
  | 'intake_commit_mismatch'
  | 'params_unserializable'
  | 'params_drifted';

export type OrdinaryDurableSourceVerdict =
  | { readonly durable: true }
  | { readonly durable: false; readonly reason: OrdinaryDurableSourceRejection };

/**
 * THE CHECK THAT MAKES A DURABILITY CLAIM EVIDENCE.
 *
 * `resolveOperationalDisposition`'s rule is unchanged and stays exactly as
 * written: a caller with no durable replay source seals `record_only`. What
 * this answers is the factual question that rule asks — does a durable replay
 * source actually exist for THIS accrual? — and it answers it by reading the
 * committed row, never by trusting the caller's word.
 *
 * The parameter is deliberately widened to `unknown` so a bogus marker is
 * CONSTRUCTIBLE in a test ('s unreachable-branch shape: a guard whose
 * violating case a literal type forbids is a guard that cannot fail). Call
 * sites keep the narrow type.
 *
 * Four independent bindings must all hold, and the last is the load-bearing
 * one:
 *
 * 1. the row EXISTS at `<collection>/<peId>` a claim with no row is a lie;
 * 2. it has the exact intake SHAPE (fail-closed on anything unrecognized);
 * 3. its stored params re-hash to its stored digest — the row was not mutated
 * after commit;
 * 4. the LIVE params hash to that same digest — so what would be replayed is
 * byte-identical to what is being priced now. This is what makes "a replay
 * prices wei-identically" structurally true rather than asserted: there is
 * one payload, and both the live call and the replay run it.
 *
 * Plus the commit binding (`pe_hash`), so a row cannot vouch for a different
 * chain commit than the one being sealed.
 *
 * FAIL-CLOSED IN EVERY ARM, including a Firestore read failure: an unreadable
 * intake is an unproven claim, and an unproven claim is `record_only`. That
 * direction can only under-state — it can never turn an unpayable act payable.
 */
export async function verifyOrdinaryAccrualIntakeReplaySource(
  db: admin.firestore.Firestore,
  params: Omit<RecordPEAccrualParams, 'durableReplaySource'>
    & { readonly durableReplaySource?: unknown },
): Promise<OrdinaryDurableSourceVerdict> {
  const claim = params.durableReplaySource;
  if (claim === undefined || claim === null) return { durable: false, reason: 'not_claimed' };
  if (claim !== ORDINARY_ACCRUAL_REPLAY_SOURCE) {
    return { durable: false, reason: 'unknown_source' };
  }

  let snapshot: admin.firestore.DocumentSnapshot;
  try {
    snapshot = await db.collection(ORDINARY_ACCRUAL_INTAKE_COLLECTION).doc(params.peId).get();
  } catch {
    return { durable: false, reason: 'read_failed' };
  }
  if (!snapshot.exists) return { durable: false, reason: 'intake_missing' };

  const row: unknown = snapshot.data();
  if (!isOrdinaryAccrualIntakeDocument(row)) return { durable: false, reason: 'intake_malformed' };
  if (!verifyOrdinaryAccrualIntakeBinding(row)) {
    return { durable: false, reason: 'intake_integrity_failed' };
  }
  if (row.pe_hash !== params.peHash) return { durable: false, reason: 'intake_commit_mismatch' };

  let liveDigest: string;
  try {
    liveDigest = hashOrdinaryAccrualReplayParams(
      sanitizeOrdinaryAccrualReplayParams(params as RecordPEAccrualParams),
    );
  } catch {
    return { durable: false, reason: 'params_unserializable' };
  }
  if (liveDigest !== row.accrual_params_sha256) return { durable: false, reason: 'params_drifted' };

  return { durable: true };
}

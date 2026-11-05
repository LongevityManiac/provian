/**
 * RAIL HANDSHAKE — event-based window invalidation (burn-to-present, Part C2).
 *
 * the standing rule : a rail-handshake window closes EARLY, in addition
 * to its time bound, on any discrete adverse PRESENTER-SIDE standing event that
 * already exists in the system:
 * (a) presenter signing-key rotation;
 * (b) a slash or forfeiture (BondPool / CourtV2 upheld claim);
 * (c) a bond abandonment or expiry the presentation relied on;
 * (d) an oracle reputation-tier downgrade.
 *
 * PROPERTIES (all decided, not reopened here):
 * - NO MATERIALITY THRESHOLD. Any listed event closes the window — no magnitude,
 * no protective judgement call.
 * - PRESENTER-SIDE ONLY. Positive standing changes and requester-side events
 * never invalidate. Keyed on the presenter (committer) wallet id — the exact
 * key `commons_presentations.wallet_id` carries.
 * - FORWARD-LOOKING ONLY. Invalidation raises a per-presenter "invalidation
 * floor" timestamp. A presentation whose `recorded_at <= floor` is dead; the
 * next commitment between that pair needs a FRESH presentation (a fresh burn).
 * Already-committed actions are NEVER unwound (the gate is only consulted at
 * the next commit; a raised floor cannot reach back into a settled action).
 * - REASON CLASS is stored with the floor and is readable by BOTH parties via
 * the handshake-state read (never on Commons).
 * - CONFIG-DRIVEN, NO ARMING GATE. The enabled event set and the window length
 * are resolved from config (env) with launch-literal defaults, live by
 * default — mirrors the `burn_floor_policy` shape (a NOTICE, not a freeze).
 * - SYMMETRIC for agents and humans; agents primary. (Every one of the four
 * concrete events is agent-side today; a human presenter simply never trips
 * one, and the same floor read applies to a human handshake.)
 *
 * This module writes ONLY the per-presenter floor doc — it never touches a burn
 * ledger, a PE, a presentation record, or a money-path literal. Its writers are
 * best-effort, post-commit, and never throw into a caller's committing path: a
 * slash / rotation / expiry that already committed must never be rolled back
 * because the (advisory) floor write hiccupped.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { RAIL_HANDSHAKE_WINDOW_MS } from './handshake';

/** One doc per presenter wallet id: the floor and the latest reason class. */
export const RAIL_HANDSHAKE_INVALIDATIONS_COLLECTION = 'rail_handshake_invalidations';

/**
 * The reason classes an invalidation can carry — one per discrete adverse event.
 * A closed union so a new reason is a deliberate addition and the stored
 * `reason_class` is auditable and safe to surface to both parties.
 *   - key_rotation        — the presenter rotated its signing key (a)
 *   - bond_slashed        — a BondPool/CourtV2 slash or forfeiture upheld (b)
 *   - bond_abandoned      — a bond the presentation relied on was abandoned (c)
 *   - bond_expired        — a bond the presentation relied on expired (c)
 *   - reputation_downgrade— an oracle reputation-tier downgrade (d)
 */
export type HandshakeInvalidationReason =
  | 'key_rotation'
  | 'bond_slashed'
  | 'bond_abandoned'
  | 'bond_expired'
  | 'reputation_downgrade';

/** Runtime enumeration of {@link HandshakeInvalidationReason} (the type is erased). */
export const ALL_INVALIDATION_REASONS: readonly HandshakeInvalidationReason[] = Object.freeze([
  'key_rotation',
  'bond_slashed',
  'bond_abandoned',
  'bond_expired',
  'reputation_downgrade',
]);

/** Runtime guard for a reason string (rejects anything off the closed union). */
export function isInvalidationReason(x: unknown): x is HandshakeInvalidationReason {
  return typeof x === 'string' && (ALL_INVALIDATION_REASONS as readonly string[]).includes(x);
}

/** Hard bounds on a config-supplied window (fail-safe against a fat-fingered env). */
export const HANDSHAKE_WINDOW_MIN_MS = 60 * 60 * 1000; // 1 hour
export const HANDSHAKE_WINDOW_MAX_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** The resolved, config-driven rail-handshake policy. */
export interface RailHandshakeConfig {
  /** Finite handshake window (ms). Env `RAIL_HANDSHAKE_WINDOW_MS` overrides the
   *  {@link RAIL_HANDSHAKE_WINDOW_MS} default, clamped to [MIN, MAX]. */
  readonly windowMs: number;
  /** The reason classes that actually close a window. Env
   *  `RAIL_HANDSHAKE_INVALIDATION_EVENTS` (comma list) overrides the default set
   *  (all reasons). An invalidation with a reason OUTSIDE this set is a no-op. */
  readonly enabledReasons: ReadonlySet<HandshakeInvalidationReason>;
}

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Resolve the config-driven window + enabled-event set. Live by default (no
 * arming gate): with no env set, the window is the 7-day default and every listed
 * reason is enabled. A malformed override falls back to the default — fail-safe,
 * never a wider window or a silently-empty event set.
 */
export function resolveRailHandshakeConfig(env: Env = process.env): RailHandshakeConfig {
  let windowMs = RAIL_HANDSHAKE_WINDOW_MS;
  const rawWindow = env.RAIL_HANDSHAKE_WINDOW_MS;
  if (typeof rawWindow === 'string' && /^[0-9]+$/.test(rawWindow)) {
    const v = Number(rawWindow);
    if (Number.isFinite(v) && v >= HANDSHAKE_WINDOW_MIN_MS && v <= HANDSHAKE_WINDOW_MAX_MS) {
      windowMs = v;
    }
  }

  let enabled: HandshakeInvalidationReason[] = [...ALL_INVALIDATION_REASONS];
  const rawEvents = env.RAIL_HANDSHAKE_INVALIDATION_EVENTS;
  if (typeof rawEvents === 'string' && rawEvents.trim().length > 0) {
    const parsed = rawEvents
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is HandshakeInvalidationReason => isInvalidationReason(s));
    // A non-empty override wins; an override that names ZERO valid reasons is
    // treated as malformed and falls back to the default set (never empties the
    // set by accident, which would silently disable the whole feature).
    if (parsed.length > 0) enabled = parsed;
  }

  return { windowMs, enabledReasons: new Set(enabled) };
}

/** The per-presenter invalidation floor fact. */
export interface HandshakeInvalidationFloor {
  readonly walletId: string;
  /** A presentation recorded at or before this ms is invalidated (dead). */
  readonly invalidatedAfterMs: number;
  /** The reason class of the latest event that raised the floor. */
  readonly reasonClass: HandshakeInvalidationReason;
  /** When the floor was last raised (ms). */
  readonly updatedAt: number;
}

function readNumber(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/**
 * STRICT (item 2): the invalidation floor for a presenter wallet id, or null when there is
 * none (a missing doc / a non-positive floor is an OBSERVED "no invalidation"). THROWS on a read
 * failure — the reputation vocabulary's `standing.invalidation_active` must never read a failure as
 * "not invalidated".
 */
export async function readInvalidationFloorStrict(
  db: Pick<Firestore, 'collection'>,
  walletId: string,
): Promise<HandshakeInvalidationFloor | null> {
  if (!walletId) throw new Error('invalidation_floor_missing_wallet_id');
  const snap = await db.collection(RAIL_HANDSHAKE_INVALIDATIONS_COLLECTION).doc(walletId).get();
  if (!snap.exists) return null;
  const d = (snap.data() ?? {}) as Record<string, unknown>;
  const invalidatedAfterMs = readNumber(d.invalidated_after_ms);
  if (invalidatedAfterMs <= 0) return null;
  const reasonClass = isInvalidationReason(d.reason_class) ? d.reason_class : 'reputation_downgrade';
  return {
    walletId,
    invalidatedAfterMs,
    reasonClass,
    updatedAt: readNumber(d.updated_at),
  };
}

/**
 * Read the invalidation floor for a presenter wallet id, or null if none. Reads
 * ONE doc (`rail_handshake_invalidations/{walletId}`) — fail-closed to null on any
 * error so a floor read never breaks a handshake read. Callers treat null as "no
 * invalidation" (the common case). (The reputation vocabulary uses
 * {@link readInvalidationFloorStrict}.)
 */
export async function readInvalidationFloor(
  db: Pick<Firestore, 'collection'>,
  walletId: string,
): Promise<HandshakeInvalidationFloor | null> {
  if (!walletId) return null;
  try {
    return await readInvalidationFloorStrict(db, walletId);
  } catch {
    return null;
  }
}

/**
 * Close a presenter's live handshake windows on a discrete adverse event by
 * raising their invalidation floor to `nowMs`. Forward-looking: presentations
 * recorded at/before the new floor stop being live handshakes; the parties must
 * re-present. Idempotent and monotonic — the floor only ever moves FORWARD
 * (`max(existing, nowMs)`), so a later event never un-invalidates.
 *
 * BEST-EFFORT, NEVER THROWS. Called AFTER the adverse event's own transaction has
 * committed; an already-committed slash / rotation / expiry must never be rolled
 * back because this advisory write failed. Returns whether the floor was written.
 *
 * CONFIG-GATED: a reason outside the enabled set is a no-op (the config can
 * disable a class without a redeploy). Every listed reason is enabled by default.
 */
export async function invalidateHandshakes(
  db: Pick<Firestore, 'collection'>,
  walletId: string,
  reason: HandshakeInvalidationReason,
  nowMs: number,
  opts?: { env?: Env; eventId?: string },
): Promise<{ written: boolean; reason?: string }> {
  if (!walletId || !isInvalidationReason(reason) || !Number.isFinite(nowMs) || nowMs <= 0) {
    return { written: false, reason: 'invalid_args' };
  }
  const config = resolveRailHandshakeConfig(opts?.env ?? process.env);
  if (!config.enabledReasons.has(reason)) {
    return { written: false, reason: 'reason_disabled' };
  }

  const ref = db.collection(RAIL_HANDSHAKE_INVALIDATIONS_COLLECTION).doc(walletId);
  try {
    // Transaction so a concurrent event can't lower the floor: read-max-write.
    const runTxn = (db as unknown as {
      runTransaction?: <T>(fn: (t: FirebaseFirestore.Transaction) => Promise<T>) => Promise<T>;
    }).runTransaction;
    if (typeof runTxn === 'function') {
      await runTxn(async (txn) => {
        const snap = await txn.get(ref as unknown as FirebaseFirestore.DocumentReference);
        const prior = snap.exists ? readNumber((snap.data() as Record<string, unknown>).invalidated_after_ms) : 0;
        const floor = Math.max(prior, nowMs);
        txn.set(
          ref as unknown as FirebaseFirestore.DocumentReference,
          {
            wallet_id: walletId,
            invalidated_after_ms: floor,
            reason_class: reason,
            ...(opts?.eventId ? { last_event_id: opts.eventId } : {}),
            updated_at: nowMs,
          },
          { merge: true },
        );
      });
    } else {
      // Non-transactional fallback (test doubles): still monotonic via a read.
      const snap = await ref.get();
      const prior = snap.exists ? readNumber((snap.data() as Record<string, unknown>).invalidated_after_ms) : 0;
      const floor = Math.max(prior, nowMs);
      await ref.set(
        {
          wallet_id: walletId,
          invalidated_after_ms: floor,
          reason_class: reason,
          ...(opts?.eventId ? { last_event_id: opts.eventId } : {}),
          updated_at: nowMs,
        },
        { merge: true },
      );
    }
    return { written: true };
  } catch (err) {
    // Advisory-only: log and swallow. The adverse event already committed.
    console.warn(
      `[RailHandshake] invalidateHandshakes(${walletId}, ${reason}) best-effort write failed:`,
      err instanceof Error ? err.message : err,
    );
    return { written: false, reason: 'write_failed' };
  }
}

/**
 * RAIL HANDSHAKE — the on-rail commitment gate (burn-to-present, Part 1).
 *
 * the standing rule : every PVT-native RAIL-MEDIATED action class
 * (escrow, jobs, bonds, pledges, subscriptions, standing export) requires a
 * COMPLETED presentation handshake before the committing action commits. Raw
 * ERC-20 PVT transfer / swap / trade stays permissionless and ungated — a raw
 * token move is NOT a rail-mediated product and is never gated here.
 *
 * WHAT A HANDSHAKE IS. A handshake is a live, burn-backed PRESENTATION from the
 * committer to the counterparty. It is established by producing a presentation
 * (the shipped burn-to-present primitive: the committer burns PVT and signs a
 * requester-bound presentation to the counterparty), which is recorded in
 * `commons_presentations`. This module does NOT burn or write anything — a
 * handshake is DERIVED, read-only, from the presentation records the primitive
 * already writes. That is what makes it "consume a presentation as its burn
 * artifact — no stacked burns" the single burn is the presentation's own burn
 * (already consumed globally-single-use in `burn_consumptions`); the commitment
 * rides that presentation, it never burns again.
 *
 * PER-RELATIONSHIP, BOUNDED, FINITE (NOT per-action). One handshake covers ALL
 * of the relationship's committing actions within a finite window — it is NOT a
 * per-packet / per-action burn. The window is {@link RAIL_HANDSHAKE_WINDOW_MS}
 * (7 days), anchored to the existing relationship-scoped consent window
 * (`COMMONS_SAFETY_LIMITS.CONSENT_EXPIRY_DAYS`). It is TIME-BOUNDED and NEVER
 * renewed in place: expiry is `recorded_at + window`, computed from the backing
 * presentation's own record time, so keeping a relationship alive past the window
 * requires PRODUCING A NEW PRESENTATION (a fresh burn) — the parties re-present.
 * EVENT-BASED INVALIDATION (Part C2, 2026-09-04) closes the window EARLY, in
 * addition to the time bound, on any discrete adverse presenter-side event
 * (key rotation / slash / forfeiture / bond abandonment or expiry / reputation-
 * tier downgrade): those raise a per-presenter invalidation floor
 * ({@link./invalidation}) that {@link findLiveHandshake} honors — a presentation
 * recorded at/before the floor is dead. Forward-looking only: already-committed
 * actions are never unwound. The window length and the enabled event set are
 * config-driven ({@link resolveRailHandshakeConfig}); no arming gate.
 *
 * THE PRESENTER IS THE COMMITTER. "Whoever seeks trust for the action" is the
 * party taking the committing action: it must hold a live presentation to the
 * counterparty. This is presenter-side skin-in-the-game (a real burn precedes the
 * commitment), NOT a two-party consent handshake — each action class keeps its
 * own two-sided protections (ownership, applicant-match, non-custodial escrow).
 *
 * WINDOW BINDING. A handshake binds to a (committer walletId, counterparty)
 * relationship: the committer's OWN presentation, whose `audience` equals the
 * counterparty reference. For a pairwise action the counterparty ref is the
 * counterparty's wallet id (escrow recipient, job applicant). For a commons-
 * facing action with no single counterparty (bond, pledge, subscription) it is
 * the canonical {@link RAIL_COMMONS_AUDIENCE}: one commons handshake covers the
 * committer's commons commitments in the window.
 *
 * NOT money-path, NOT a PE: reads only, touches no burn ledger, no action-type
 * literal, no matrix/monetary signature.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { bumpOpsCounter } from '../observability/ops-counters';
import { COMMONS_SAFETY_LIMITS } from '../commons/types';
// Import from the light types module, NOT '../presentation/service': service.ts
// transitively loads the PE-anchor chain, and pulling that into the
// rail/key-rotation module graph regressed the genesis-rollback suite via a
// load-order cycle (then at the init of the since-deleted PVTv8 minting engine).
// The rail handshake needs only the collection name, which now lives in ./types.
import { COMMONS_PRESENTATIONS_COLLECTION } from '../presentation/types';
import {
  readInvalidationFloor,
  resolveRailHandshakeConfig,
  type HandshakeInvalidationReason,
} from './invalidation';

/**
 * The canonical counterparty reference for a commons-facing commitment with no
 * single counterparty (bond, pledge, subscription). A committer opens a commons
 * handshake by presenting with this string as the presentation `audience`.
 */
export const RAIL_COMMONS_AUDIENCE = 'provian:commons' as const;

/**
 * The finite handshake window (ms). Anchored to the existing relationship-scoped
 * consent window (`CONSENT_EXPIRY_DAYS`, 7 days) — the same duration Provian
 * already uses for a relationship-scoped credential (PE-publication mutual
 * consent). NOT an invented number. A newcomer re-presents at most once per week,
 * which keeps the gate affordable at the presentation floor while remaining a
 * hard, finite bound.
 */
export const RAIL_HANDSHAKE_WINDOW_MS =
  COMMONS_SAFETY_LIMITS.CONSENT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

/** HTTP 428 Precondition Required — the commitment must be preceded by a handshake. */
export const RAIL_HANDSHAKE_REQUIRED_STATUS = 428;
export const RAIL_HANDSHAKE_REQUIRED =
  'a live rail handshake is required before this commitment: present (burn-to-present) to the counterparty first';
/** Machine-readable reason surfaced to the client alongside the message. */
export const RAIL_HANDSHAKE_REQUIRED_REASON = 'rail_handshake_required';

/** The two presentation tiers a handshake can be backed by (mirrors the
 *  presentation primitive's `tier`). Declared locally so the rail module keeps
 *  its light import graph (no dependency on presentation/service). */
export type HandshakeTier = 'pe_fact' | 'reputation';

/** The live-handshake fact returned when the gate passes (audit / provenance). */
export interface RailHandshake {
  /** The committer's wallet id (the presenter). */
  readonly committerWalletId: string;
  /** The counterparty reference the presentation's audience matched. */
  readonly counterparty: string;
  /** The backing presentation's burn id (the single verified on-chain burn). */
  readonly burnId: string;
  /** The backing presentation id (jti). */
  readonly presentationId: string;
  /** The backing presentation's tier (`pe_fact` / `reputation`), when recorded. */
  readonly tier?: HandshakeTier;
  /** When the backing presentation was recorded (handshake start, ms). */
  readonly establishedAt: number;
  /** When the handshake window lapses (`establishedAt + WINDOW`, ms). */
  readonly expiresAt: number;
}

/** Narrow an untrusted stored `tier` field to the closed {@link HandshakeTier}. */
function readTier(raw: unknown): HandshakeTier | undefined {
  return raw === 'pe_fact' || raw === 'reputation' ? raw : undefined;
}

/** Thrown when a rail-mediated commitment has no live handshake. */
export class RailHandshakeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'RailHandshakeError';
  }
}

function readNumber(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/**
 * Find the freshest LIVE handshake for (committerWalletId → counterparty), or
 * null if none is live. A handshake is live iff the committer produced a
 * presentation whose `audience` equals `counterparty`, whose record time is
 * within the (config-driven) window of now, AND whose record time is AFTER the
 * presenter's invalidation floor (Part C2: an adverse presenter-side event raises
 * that floor, killing every presentation recorded at/before it).
 *
 * Two equality filters only (no orderBy / range) so Firestore serves it from the
 * automatic single-field indexes — no composite index to deploy — plus ONE
 * fail-closed floor read. The result set per (wallet, audience) is tiny; the
 * freshest live one is picked in memory. Fail-closed: any missing `recorded_at`
 * is treated as 0 (expired), never live.
 *
 * `requiredTier` (optional) restricts the backing presentation's tier. Tier-
 * agnostic by default (any live presentation satisfies escrow/jobs/bonds/pledge/
 * subscription — the matrix's "5/15"). VOUCH passes `'reputation'`: a vouch is a
 * trust act whose folded burn must *prove standing* and preserve the 15-PVT
 * scarcity floor, which a 5-PVT `pe_fact` handshake would undercut. Fail-closed:
 * a presentation with a missing/unknown `tier` never satisfies a `requiredTier`.
 */
export async function findLiveHandshake(
  db: Pick<Firestore, 'collection'>,
  committerWalletId: string,
  counterparty: string,
  nowMs: number,
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
  requiredTier?: HandshakeTier,
): Promise<RailHandshake | null> {
  if (!committerWalletId || !counterparty) return null;
  const windowMs = resolveRailHandshakeConfig(env).windowMs;
  const [snap, floor] = await Promise.all([
    db
      .collection(COMMONS_PRESENTATIONS_COLLECTION)
      .where('wallet_id', '==', committerWalletId)
      .where('audience', '==', counterparty)
      .get(),
    readInvalidationFloor(db, committerWalletId),
  ]);
  const floorMs = floor?.invalidatedAfterMs ?? 0;

  let best: RailHandshake | null = null;
  for (const doc of snap.docs) {
    const d = doc.data() as Record<string, unknown>;
    const tier = readTier(d.tier);
    if (requiredTier && tier !== requiredTier) continue; // wrong tier (fail-closed on unknown)
    const establishedAt = readNumber(d.recorded_at);
    if (establishedAt <= floorMs) continue; // invalidated by a presenter-side event
    const expiresAt = establishedAt + windowMs;
    if (expiresAt <= nowMs) continue; // lapsed — the parties must re-present
    if (best && establishedAt <= best.establishedAt) continue;
    best = {
      committerWalletId,
      counterparty,
      burnId: typeof d.burn_id === 'string' ? d.burn_id : doc.id,
      presentationId: typeof d.presentation_id === 'string' ? d.presentation_id : doc.id,
      tier,
      establishedAt,
      expiresAt,
    };
  }
  return best;
}

/** The state of a directed (committer → counterparty) handshake, for the
 *  HANDSHAKE STATE READ both parties can consult (never a Commons surface). */
export type HandshakeStateKind = 'live' | 'lapsed' | 'invalidated' | 'none';

export interface HandshakeState {
  readonly committerWalletId: string;
  readonly counterparty: string;
  readonly state: HandshakeStateKind;
  /** For `invalidated`: the reason class that closed the window (both parties see it). */
  readonly reasonClass?: HandshakeInvalidationReason;
  /** The freshest backing presentation's record time (if any). */
  readonly establishedAt?: number;
  /** When the live handshake would lapse by time (`establishedAt + window`). */
  readonly expiresAt?: number;
  /** The invalidation floor in effect for this presenter (if any). */
  readonly invalidatedAfterMs?: number;
  /** The live handshake's backing burn / presentation ids (only when `live`). */
  readonly burnId?: string;
  readonly presentationId?: string;
}

/**
 * Read the handshake state for a directed (committer → counterparty) pair —
 * `live` / `lapsed` / `invalidated` / `none` — plus the reason class when
 * invalidated. Both parties in the pair may call this (auth is enforced at the
 * route). It is a private counterparty read; it NEVER surfaces on Commons.
 *
 * `live` reuses {@link findLiveHandshake} exactly (so the read can never disagree
 * with the gate). Otherwise the freshest presentation (ignoring liveness) decides:
 * if it was recorded at/before the invalidation floor the state is `invalidated`
 * (with the floor's reason); if it exists but is out of the time window it is
 * `lapsed`; if none exists it is `none`.
 */
export async function readHandshakeState(
  db: Pick<Firestore, 'collection'>,
  committerWalletId: string,
  counterparty: string,
  nowMs: number,
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<HandshakeState> {
  const base = { committerWalletId, counterparty };
  if (!committerWalletId || !counterparty) return { ...base, state: 'none' };

  const live = await findLiveHandshake(db, committerWalletId, counterparty, nowMs, env);
  if (live) {
    return {
      ...base,
      state: 'live',
      establishedAt: live.establishedAt,
      expiresAt: live.expiresAt,
      burnId: live.burnId,
      presentationId: live.presentationId,
    };
  }

  const windowMs = resolveRailHandshakeConfig(env).windowMs;
  const [snap, floor] = await Promise.all([
    db
      .collection(COMMONS_PRESENTATIONS_COLLECTION)
      .where('wallet_id', '==', committerWalletId)
      .where('audience', '==', counterparty)
      .get(),
    readInvalidationFloor(db, committerWalletId),
  ]);

  let freshest = 0;
  for (const doc of snap.docs) {
    const at = readNumber((doc.data() as Record<string, unknown>).recorded_at);
    if (at > freshest) freshest = at;
  }
  if (freshest <= 0) return { ...base, state: 'none' };

  const floorMs = floor?.invalidatedAfterMs ?? 0;
  // The freshest presentation is the max; if it is at/before the floor, every
  // presentation for this pair is invalidated.
  if (floorMs > 0 && freshest <= floorMs) {
    return {
      ...base,
      state: 'invalidated',
      reasonClass: floor?.reasonClass,
      establishedAt: freshest,
      invalidatedAfterMs: floorMs,
    };
  }
  // Freshest is after the floor but not live → it timed out.
  return { ...base, state: 'lapsed', establishedAt: freshest, expiresAt: freshest + windowMs };
}

/**
 * Assert a live handshake exists for (committerWalletId → counterparty), or throw
 * {@link RailHandshakeError} (428). Call this at the COMMITMENT point of every
 * rail-mediated action class, before the action commits. Returns the live
 * handshake fact so the caller can record its provenance if it wishes.
 *
 * `requiredTier` (optional) restricts the backing presentation's tier — VOUCH
 * passes `'reputation'` (see {@link findLiveHandshake}); the other classes stay
 * tier-agnostic.
 */
export async function assertLiveHandshake(
  db: Pick<Firestore, 'collection'>,
  committerWalletId: string,
  counterparty: string,
  nowMs: number,
  requiredTier?: HandshakeTier,
): Promise<RailHandshake> {
  const hs = await findLiveHandshake(db, committerWalletId, counterparty, nowMs, undefined, requiredTier);
  if (!hs) {
    // Ops observability (Part D): count the 428 so the console can see a rail that is
    // repeatedly refusing for want of a live handshake. Structure-only — no party ids.
    bumpOpsCounter('rail.handshake_428');
    throw new RailHandshakeError(
      RAIL_HANDSHAKE_REQUIRED_STATUS,
      RAIL_HANDSHAKE_REQUIRED,
      RAIL_HANDSHAKE_REQUIRED_REASON,
    );
  }
  return hs;
}

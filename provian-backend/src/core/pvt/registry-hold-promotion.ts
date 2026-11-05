import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * THE SANCTIONED REGISTRY-HOLD PROMOTER: the one module that flips a row held at
 * `pending_review` by the registry gate (linkageState 'unverifiable' + a 'registry' gate) to
 * `eligible`, re-pricing a genuinely-linked row to its true live value (a claimless linked
 * speech act releases at the points its speech-window budget booked, with the linked split).
 *
 * WHY ITS OWN FILE (mirrors completion-promotion.ts). The active settlement runtime/PVT9 settlement lane
 * reads the mint amount from the MUTABLE `record_points_atomic` and the split from the MUTABLE
 * `beneficiary_routing_snapshot`, with NO cross-check against the sealed economic snapshot.
 * That is exactly why a re-price is possible — and exactly why it is dangerous. Concentrating
 * every write here keeps the one dangerous path auditable and lets a static fence prove no
 * SECOND registry promoter ever appears.
 *
 * WHAT ONE RESOLUTION COMMITS, IN ONE TRANSACTION:
 * 1. re-reads the row and CAS-guards it: still `pending_review` (one-mint-per-ROW), sealed
 * `economic_snapshot_hash` unmoved (TOCTOU), and it is genuinely a registry hold
 * (linkageState 'unverifiable' + `unresolvedRecordGates` ⊇ {registry});
 * 2. asserts from the row's OWN sealed `mint_once_claim_evidence` that this pe_id OWNS the
 * mint-once claim of its economic event — any kind but `artifact` (novelty, not event
 * identity) — and is a duplicate of none (one-mint-per-TURN belt; generalized it from
 * `device_occurrence` only, which refused every chain-witnessed act: x402, financial
 * settlement, commit, occurrence, completion). Duplicates are terminal and never reach here;
 * this is a pure read, no false-race;
 * 2b. requires `registry` to be the row's ONLY unresolved record gate : a row also
 * awaiting evidence, a canonical event or session lineage is held for those too, and the
 * registry verdict cannot release it;
 * 2c. requires the hold to be the PURE linkage hold — sealed reason `awaiting_review` and no
 * operational override : an override (`same_owner_unresolvable`,
 * `receive_authorship_unresolvable`, `mint_claim_unverifiable`) adds no record gate, so it
 * looks like a registry hold by gates alone, but its fence (same-owner, authorship, the
 * mint claim) was never decided and the linkage verdict does not decide it;
 * 3. per the verifier's verdict, computes the settled points + routing:
 * - unlinked → record_points VERBATIM (sealed 1.0x IS the live price), no routing;
 * - beneficiary_linked → record_points RE-PRICED via recomputeRecordPointsAtCorrectedLinkage
 * (exact, hard-capped at sealed×2) + a beneficiary_routing_snapshot (agent/human split);
 * - beneficiary_linked, claimless (witness-class) Commons speech act → record_points are the
 * points its speech-window budget BOOKED at seal (`speech_window_reservations/{pe_id}`), never
 * re-priced, + the same beneficiary_routing_snapshot. The window's budget booked exactly those
 * points against the burn that opened it, and nothing re-books a budget, so the linked 2.0x would
 * mint past what the window booked. The booking must be readable, unexhausted, bound to this
 * pe_id, action type and actor, and equal to the sealed points; anything else keeps the row
 * held (`refused_booking_unverified`), never released at a guess;
 * 4. writes `mint_status:'eligible'` AND the routing snapshot in the SAME patch, so the inlet
 * never sees an eligible row without its routing and can never register a 100% `sole` leg
 * that would then double-mint against the split legs;
 * 5. writes the audit `economic_eligibility_projection` (one `registry` resolutionEvidence item,
 * canonicalEventId bound to the seal);
 * 6. applies the economic-aggregate delta in the same transaction.
 * The sealed `economic_snapshot` / `economic_snapshot_hash` are NEVER touched.
 */

import type admin from 'firebase-admin';
import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import {
  recomputeRecordPointsAtCorrectedLinkage,
  type EligibilityProjection,
  type MonetaryPolicyVersion,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import {
  createBeneficiaryRoutingSnapshot,
  hashBeneficiaryRoutingSnapshot,
} from './beneficiary-routing';
import { EconomicAggregateWriter } from './policy/economic-aggregate';
import type { PEHistoryDocument } from '../../pe-history';
import type { RegistryHoldVerdict } from './registry-hold-verifier';
import type { HeldActDoc } from '../meter/held-acts';
import { METER_HELD_ACTS_COLLECTION } from '../meter/meter-store';
import { SPEECH_WINDOW_RESERVATIONS_COLLECTION, speechPeNeedsPass } from './speech-window-budget';

const HELD_STATUS = 'pending_review';
const RELAY_STATUS_READY = 'eligible';

export type RegistryHoldResolutionOutcome =
  | 'resolved'
  | 'refused_not_pending'
  | 'refused_snapshot_unbound'
  | 'refused_not_registry_hold'
  | 'refused_other_record_gates'
  | 'refused_operational_hold'
  | 'refused_not_mint_once_owner'
  | 'refused_booking_unverified'
  | 'refused_no_verdict';

/**
 * What one read of a PE's speech-window booking found: the reservation document (`null` when
 * none exists), or `unreadable` when the read itself failed. Only a claimless linked speech act
 * reads it; every other row is judged with `not_read`.
 */
export type SpeechWindowBookingRead =
  | { readonly kind: 'not_read' }
  | { readonly kind: 'read'; readonly doc: Record<string, unknown> | null }
  | { readonly kind: 'unreadable' };

const BOOKING_NOT_READ: SpeechWindowBookingRead = { kind: 'not_read' };
const ATOMIC = /^[0-9]+$/;

export interface RegistryHoldResolutionInput {
  readonly peId: string;
  readonly economicActorId: string;
  /** The sealed snapshot hash the verdict was computed against (TOCTOU bind). */
  readonly economicSnapshotHash: string | null;
  /** From the verifier — must be a `resolve` verdict. */
  readonly verdict: RegistryHoldVerdict;
  /** The record-time policy vintage, for the exact linkage recompute. */
  readonly policy: MonetaryPolicyVersion;
  readonly nowMs: number;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function legacyDisplayPvt(atomic: string): number {
  return Number(BigInt(atomic)) / 1e18;
}

/** The registry eligibility projection (audit artifact; the settlement runtime gate keys on mint_status). */
export function buildRegistryEligibilityProjection(params: {
  peId: string;
  economicActorId: string;
  linkage: 'unlinked' | 'beneficiary_linked';
  correctedLinkageMultiplierBps: number;
  canonicalEventId: string | null;
  nowMs: number;
  /** Set when the row released at its speech-window booking: that window's burn id. */
  bookedSpeechWindowBurnId?: string | null;
}): EligibilityProjection {
  const booked = params.bookedSpeechWindowBurnId ?? null;
  const facts = stableStringify({
    kind: 'registry_hold_resolution',
    pe_id: params.peId,
    economic_actor_id: params.economicActorId,
    linkage: params.linkage,
    corrected_linkage_multiplier_bps: params.correctedLinkageMultiplierBps,
    canonical_event_id: params.canonicalEventId,
    ...(booked !== null ? { booked_speech_window_burn_id: booked } : {}),
  }) ?? '';
  return {
    mintDisposition: RELAY_STATUS_READY,
    mintReasonCode: 'policy_eligible',
    resolutionEvidence: [{
      resolutionType: 'registry',
      evidenceId: `registry-hold:${params.peId}:${params.nowMs}`,
      evidenceHash: `sha256:${sha256(facts)}`,
      source: booked !== null
        ? 'registry-hold-resolver:beneficiary_reverified_at_booked_points'
        : 'registry-hold-resolver:beneficiary_reverified',
      asOf: `resolved_at_ms:${params.nowMs}`,
      canonicalEventId: params.canonicalEventId,
    }],
  };
}

/**
 * True iff the row's own sealed evidence names this pe_id the OWNER of the mint-once claim of its
 * economic event, and it is a duplicate of no economic event. `artifact` is novelty (who first
 * produced an output), not event identity, so it neither qualifies a row nor disqualifies it —
 * the same split `assertMintOnceClaimEvidence` seals. Malformed evidence is never an owner.
 */
function rowOwnsItsMintOnceClaim(before: Record<string, unknown>, peId: string): boolean {
  const evidence = before.mint_once_claim_evidence;
  if (Array.isArray(evidence) && evidence.length === 0) return rowIsItsOwnWitnessClassEvent(before);
  if (!Array.isArray(evidence)) return false;
  let owns = false;
  for (const entry of evidence) {
    const e = entry as { relation?: unknown; claim?: { claim_kind?: unknown; owner_pe_id?: unknown } } | null;
    const kind = e?.claim?.claim_kind;
    // Malformed evidence is never ownership (Unknown = Block).
    if (typeof kind !== 'string' || (e?.relation !== 'owner' && e?.relation !== 'duplicate')) return false;
    if (kind === 'artifact') continue;
    if (e.relation !== 'owner' || e.claim?.owner_pe_id !== peId) return false;
    owns = true;
  }
  return owns;
}


const PE_HASH = /^[0-9a-f]{64}$/;

/**
 * A witness-class act takes NO mint-once claim document: when no emitter event was passed, its
 * sealed canonical event is `<type>:<its own pe hash>` this exact PE, mint-once by construction
 * (`pvt-accrual.ts`). With empty evidence it owns its event iff the seal says exactly that: the
 * `verified_witness_class` requirement, the `witness_class:<type>` group, the event id bound to
 * this row's own hash, no evidence commitment, and not a duplicate. Anything else with empty
 * evidence stays refused (no evidence is no ownership).
 */
function rowIsItsOwnWitnessClassEvent(before: Record<string, unknown>): boolean {
  const sealed = before.economic_snapshot as RecordEconomicSnapshot | undefined;
  const factors = sealed?.recordTimeFactors;
  const peHash = before.peHash;
  if (!sealed || !factors || typeof sealed.actionType !== 'string' || typeof peHash !== 'string') return false;
  return PE_HASH.test(peHash)
    && factors.evidenceRequirement === 'verified_witness_class'
    && factors.canonicalEventGroup === `witness_class:${sealed.actionType}`
    && factors.canonicalEventId === `${sealed.actionType}:${peHash}`
    && factors.exactDuplicate === false
    && (before.mint_once_claim_evidence_hash === null || before.mint_once_claim_evidence_hash === undefined);
}

/**
 * True iff the row is a claimless (witness-class, empty evidence) Commons speech act judged under
 * a beneficiary_linked verdict: the one shape whose release reads its speech-window booking.
 */
function isClaimlessLinkedSpeech(before: Record<string, unknown>, input: RegistryHoldResolutionInput): boolean {
  const evidence = before.mint_once_claim_evidence;
  const sealed = before.economic_snapshot as RecordEconomicSnapshot | undefined;
  return input.verdict.kind === 'resolve'
    && input.verdict.linkage === 'beneficiary_linked'
    && Array.isArray(evidence) && evidence.length === 0
    && typeof sealed?.actionType === 'string'
    && speechPeNeedsPass(sealed.actionType);
}

/**
 * The points a claimless speech act's speech-window budget booked for it, or `null` when the
 * booking cannot vouch for them. The booking must have been read, exist, be admitted (not
 * exhausted), name this pe_id, its sealed action type and its sealed economic actor, carry a
 * window burn id, and book a positive atomic amount EQUAL to the sealed record points (the
 * amount the seal reserved). Any mismatch is unknown, and unknown keeps the row held.
 */
function bookedSpeechPoints(
  sealed: RecordEconomicSnapshot,
  peId: string,
  booking: SpeechWindowBookingRead,
): { readonly pointsAtomic: string; readonly burnId: string } | null {
  if (booking.kind !== 'read' || booking.doc === null) return null;
  const d = booking.doc;
  const points = d.points_atomic;
  const burnId = d.burn_id;
  if (d.pe_id !== peId
    || d.action_type !== sealed.actionType
    || d.wallet_id !== sealed.economicActorId
    || d.exhausted !== false
    || typeof burnId !== 'string' || burnId.length === 0
    || typeof points !== 'string' || !ATOMIC.test(points)
    || points !== sealed.recordPointsAtomic
    || BigInt(points) <= 0n) {
    return null;
  }
  return { pointsAtomic: points, burnId };
}

/** Read a PE's speech-window booking through `get`; a failed read is `unreadable`. */
async function readSpeechWindowBooking(
  get: () => Promise<{ readonly exists: boolean; data(): unknown }>,
): Promise<SpeechWindowBookingRead> {
  try {
    const snap = await get();
    const data = snap.exists ? snap.data() : null;
    return { kind: 'read', doc: data !== null && typeof data === 'object' ? data as Record<string, unknown> : null };
  } catch {
    return { kind: 'unreadable' };
  }
}

type RegistryHoldRefusal = Exclude<RegistryHoldResolutionOutcome, 'resolved'>;

/**
 * Judge ONE row and build its resolution patch. Pure: the pre-meter transaction runs it on the
 * row it re-read, and the held-act path runs it on the held row AND again (as its `expect`) on
 * the row as read inside `resolveHeldAct`'s transaction — so both re-check exactly the same
 * things: the CAS, the TOCTOU bind, the registry-hold shape, and mint-once ownership.
 */
function registryHoldResolution(
  before: Record<string, unknown>,
  input: RegistryHoldResolutionInput,
  booking: SpeechWindowBookingRead = BOOKING_NOT_READ,
): { readonly outcome: 'resolved'; readonly patch: Record<string, unknown> } | { readonly outcome: RegistryHoldRefusal } {
  if (input.verdict.kind !== 'resolve') return { outcome: 'refused_no_verdict' };

  // CAS — one mint per ROW. A row already flipped by a concurrent sweep is refused.
  if (before.mint_status !== HELD_STATUS) return { outcome: 'refused_not_pending' };
  // TOCTOU — the seal must be the exact one the verdict was computed against.
  if (before.economic_snapshot_hash !== input.economicSnapshotHash) return { outcome: 'refused_snapshot_unbound' };

  const sealed = before.economic_snapshot as RecordEconomicSnapshot | undefined;
  const factors = sealed?.recordTimeFactors;
  if (!sealed || !factors
    || factors.linkageState !== 'unverifiable'
    || !Array.isArray(factors.unresolvedRecordGates)
    || !factors.unresolvedRecordGates.includes('registry')) {
    return { outcome: 'refused_not_registry_hold' };
  }

  // The hold must be the PURE linkage hold: an operational override is a different undecided fence.
  const override = (factors as { operationalDispositionOverride?: unknown }).operationalDispositionOverride;
  if (sealed.mintReasonCode !== 'awaiting_review' || (override !== undefined && override !== null)) {
    return { outcome: 'refused_operational_hold' };
  }
  // Registry must be the ONLY thing the row waits on: the verdict resolves linkage, nothing else.
  if (factors.unresolvedRecordGates.some((gate) => gate !== 'registry')) return { outcome: 'refused_other_record_gates' };
  // One mint per TURN belt — this row must own the mint-once claim of its economic event and be
  // a duplicate of none (pure read of its own sealed evidence and its sealed duplicate flag).
  if (factors.exactDuplicate === true || !rowOwnsItsMintOnceClaim(before, input.peId)) {
    return { outcome: 'refused_not_mint_once_owner' };
  }
  // A claimless (witness-class) act mints once at the points its seal booked. A Commons speech
  // act's seal booked exactly those points against its speech window's burn budget (a window
  // mints strictly less than its burn), and nothing re-books a budget, so a linked one releases
  // at its BOOKED points with the linked split, never re-priced to the linked 2.0x. The booking
  // is read from its own record and must vouch for the sealed points, or the row stays held.
  // A claimless linked act that is not speech has no booking to release at: it stays held, listed.
  const evidence = before.mint_once_claim_evidence;
  const claimless = Array.isArray(evidence) && evidence.length === 0;
  let booked: { readonly pointsAtomic: string; readonly burnId: string } | null = null;
  if (claimless && input.verdict.linkage !== 'unlinked') {
    if (!isClaimlessLinkedSpeech(before, input)) return { outcome: 'refused_not_mint_once_owner' };
    booked = bookedSpeechPoints(sealed, input.peId, booking);
    if (booked === null) return { outcome: 'refused_booking_unverified' };
  }

  const sealedRecordPointsAtomic = sealed.recordPointsAtomic;

  let repricedPointsAtomic: string;
  let correctedLinkageMultiplierBps: number;
  let routingSnapshot: ReturnType<typeof createBeneficiaryRoutingSnapshot> = null;
  let routingSnapshotHash: string | null = null;

  if (input.verdict.linkage === 'unlinked') {
    // The frozen 1.0x IS the live price for a standalone agent. Verbatim, no routing.
    repricedPointsAtomic = sealedRecordPointsAtomic;
    correctedLinkageMultiplierBps = factors.linkageMultiplierBps;
  } else {
    if (booked !== null) {
      // beneficiary_linked claimless speech: exactly the booked points (equal to the sealed
      // points), at the sealed linkage multiplier; only the routing is added.
      repricedPointsAtomic = booked.pointsAtomic;
      correctedLinkageMultiplierBps = factors.linkageMultiplierBps;
    } else {
      // beneficiary_linked — re-price to the true 2.0x value (exact, hard-capped) + routing.
      const recomputed = recomputeRecordPointsAtCorrectedLinkage({
        snapshot: sealed,
        correctedLinkageState: 'beneficiary_linked',
        policy: input.policy,
      });
      repricedPointsAtomic = recomputed.recordPointsAtomic;
      correctedLinkageMultiplierBps = recomputed.correctedLinkageMultiplierBps;
    }
    routingSnapshot = createBeneficiaryRoutingSnapshot({
      peId: input.peId,
      economicActorId: input.economicActorId,
      recordedAtMs: sealed.recordedAtMs,
      beneficiary: input.verdict.beneficiary,
    });
    if (routingSnapshot === null) return { outcome: 'refused_not_registry_hold' };
    routingSnapshotHash = hashBeneficiaryRoutingSnapshot(routingSnapshot);
  }

  const projection = buildRegistryEligibilityProjection({
    peId: input.peId,
    economicActorId: input.economicActorId,
    linkage: input.verdict.linkage,
    correctedLinkageMultiplierBps,
    canonicalEventId: factors.canonicalEventId,
    nowMs: input.nowMs,
    bookedSpeechWindowBurnId: booked?.burnId ?? null,
  });

  const patch: Record<string, unknown> = {
    mint_status: RELAY_STATUS_READY,
    mint_disposition: RELAY_STATUS_READY,
    disposition_reason_code: 'policy_eligible',
    estimatedPVT: legacyDisplayPvt(repricedPointsAtomic),
    estimated_pvt_atomic: repricedPointsAtomic,
    record_points_atomic: repricedPointsAtomic,
    economic_eligibility_projection: projection,
    registry_hold_resolved_at_ms: input.nowMs,
    registry_hold_resolution_linkage: input.verdict.linkage,
  };
  // FENCE #2 — routing + eligibility flip in the SAME patch, so no 100% sole leg can be
  // registered before the split legs exist.
  if (routingSnapshot !== null) {
    patch.beneficiary_routing_snapshot = routingSnapshot;
    patch.beneficiary_routing_snapshot_hash = routingSnapshotHash;
  }
  return { outcome: 'resolved', patch };
}

/**
 * Apply one registry-hold resolution INSIDE the caller's transaction. Every read precedes
 * every write. Returns the outcome; the caller (the sweep) records it.
 */
export async function applyRegistryHoldResolutionInTransaction(
  db: admin.firestore.Firestore,
  txn: admin.firestore.Transaction,
  input: RegistryHoldResolutionInput,
): Promise<RegistryHoldResolutionOutcome> {
  if (input.verdict.kind !== 'resolve') return 'refused_no_verdict';

  const historyRef = db.collection('pe_history').doc(input.peId);
  const current = await txn.get(historyRef);
  if (!current.exists) return 'refused_not_pending';
  const before = (current.data() ?? {}) as Record<string, unknown>;

  // The booking is read inside this transaction, before any write, and only for the one shape
  // that releases at it. A failed read is `unreadable` and keeps the row held.
  const booking = isClaimlessLinkedSpeech(before, input)
    ? await readSpeechWindowBooking(() => txn.get(db.collection(SPEECH_WINDOW_RESERVATIONS_COLLECTION).doc(input.peId)))
    : BOOKING_NOT_READ;

  const judged = registryHoldResolution(before, input, booking);
  if (judged.outcome !== 'resolved') return judged.outcome;
  const patch = judged.patch;
  const after: Record<string, unknown> = { ...before, ...patch };

  // the economic-aggregate delta of this status flip, loaded (reads) here before any
  // write and committed beside the row patch in this same transaction.
  const aggregateWriter = new EconomicAggregateWriter(db, txn, input.nowMs);
  await aggregateWriter.load(EconomicAggregateWriter.identitiesOf(before, after));

  txn.update(historyRef, patch);
  aggregateWriter.applyMutation(
    before as unknown as PEHistoryDocument,
    after as unknown as PEHistoryDocument,
  );
  aggregateWriter.commit();
  return 'resolved';
}

/**
 * PE METER — the same resolution for a METERED held act (`meter_held_acts_v1/{relay_pe_id}`,
 * held at `pending_review`). The patch is built from the held row by the same judgement, and the
 * transition is `resolveHeldAct` — the one transition for a held act, which lands the patch with
 * its aggregate delta, resolves the act's payee legs from the (re-priced, routed) row, creates the
 * act's own act-unit pending claims and removes the hold, in one transaction whose `expect` runs
 * the SAME judgement on the row as it stands there (CAS, TOCTOU, registry hold, mint-once owner).
 * The patch depends only on the hash-bound seal and the input, so an `expect` that passes proves
 * the patch is exactly the one that row would have produced.
 */
export async function applyRegistryHoldResolutionToHeldAct(
  db: admin.firestore.Firestore,
  input: RegistryHoldResolutionInput,
): Promise<RegistryHoldResolutionOutcome> {
  if (input.verdict.kind !== 'resolve') return 'refused_no_verdict';
  const held = await privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(input.peId).get();
  const row = held.exists ? (held.data() as Partial<HeldActDoc> | undefined)?.key?.row : undefined;
  if (row === undefined || row === null || typeof row !== 'object') return 'refused_not_pending';
  // A booking is written once, by `create`, and never updated, so this one read is also the
  // booking the transaction's `expect` judges against.
  const booking = isClaimlessLinkedSpeech(row, input)
    ? await readSpeechWindowBooking(() => db.collection(SPEECH_WINDOW_RESERVATIONS_COLLECTION).doc(input.peId).get())
    : BOOKING_NOT_READ;
  const judged = registryHoldResolution(row, input, booking);
  if (judged.outcome !== 'resolved') return judged.outcome;

  // Lazy, like `mutatePeHistoryRowWithAggregate`: the meter module graph reaches the record path.
  const { resolveHeldAct } = await import('../meter/held-acts');
  const result = await resolveHeldAct(db, input.peId, judged.patch, {
    nowMs: input.nowMs,
    expect: (before) => registryHoldResolution(before, input, booking).outcome === 'resolved',
  });
  switch (result.outcome) {
    case 'promoted':
    case 'promotion_refused':
      // `promotion_refused`: the row IS eligible; the act waits for its payee (payee retry pass).
      return 'resolved';
    case 'precondition_failed': {
      if (result.before === null) return 'refused_not_pending';
      const rejudged = registryHoldResolution(result.before, input, booking);
      // Every check passed but the row moved under the transaction: judged again next pass.
      return rejudged.outcome === 'resolved' ? 'refused_not_pending' : rejudged.outcome;
    }
    default:
      // `missing` (another pass already resolved it), or an outcome a promotion cannot produce.
      return 'refused_not_pending';
  }
}

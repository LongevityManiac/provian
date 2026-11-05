import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * THE SANCTIONED PROMOTER: the one module that flips a held
 * `human_job_delivered` row out of `pending_evidence` to `eligible`.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────────
 * FC-013 forbids the held-row SWEEP (`pending-evidence-
 * resolver.ts`) from mutating anything but its own bookkeeping and from naming a
 * disposition field in any write position; FC-014 forbids ANY
 * module from writing `mint_status: 'eligible'` while carrying the held literal
 * unless it is named in `SANCTIONED_PENDING_EVIDENCE_PROMOTERS` "a promotion
 * out of pending_evidence may exist only behind the bound canonical-event
 * verifier and a recorded decision", and adding the name there IS the decision
 * being recorded. This module is that name. The recorded decision is the operator’s
 * ruling (completion earning: a genuinely completed job earns whether or
 * not an on-chain escrow release exists; the counterparty confirmation
 * corroborates the deliverer's work PE — it lifts, it never double-pays). The
 * bound verifier is `completion-verifier.ts` the promotion below runs ONLY on
 * its `promote` verdict, which binds the poster's confirmation to the exact
 * job, poster and delivery, checks the distinct-owner fence, and prepares the
 * `completion` mint-once claim for the canonical completion event.
 *
 * The sweep decides; this module writes. Keeping the write here — and only
 * here — is what lets FC-013 keep proving the sweep cannot destroy or promote
 * on its own, and FC-014 keep proving no SECOND promoter appears beside this
 * one.
 *
 * ── WHAT ONE PROMOTION COMMITS, IN ONE TRANSACTION ───────────────────────────
 * 1. re-reads the held row: still `pending_evidence`, sealed snapshot hash
 * unmoved (a moved row is refused, nothing written);
 * 2. CLAIMS the `completion` mint-once slot through the same crash-safe
 * `inspectPreparedMintOnceClaimInTransaction` every record-time claim uses —
 * a slot the on-chain release took meanwhile is a race, refused BY NAME
 * (`refused_canonical_event_already_minted` the best-supported witness paid);
 * 3. appends the claim's OWNER evidence to the row's `mint_once_claim_evidence`
 * (+ hash), so a later duplicate's in-transaction inspect finds this row
 * bound to the claim it holds;
 * 4. flips the MUTABLE disposition fields to eligible beside an immutable
 * `economic_eligibility_projection` the kernel validates on every settlement
 * read (`resolveEligibilityProjection` `pending_evidence -> eligible` in
 * mode (b), one `evidence` item naming the canonical event);
 * 5. stamps the confirmation as the row's CORROBORATION — the LIFT, which the
 * kernel applies only inside its 72h enhancement window measured from the
 * delivery's record time (scoping verbatim; a late confirmation still
 * promotes, at the sealed value);
 * 6. marks the row the OFF-CHAIN completion witness, which the settlement
 * inlet's takeover deferral and the on-chain witness's takeover pre-check
 * read;
 * 7. applies the (−before, +after) delta to the row's accrual-time economic
 * aggregates (M5 — EVERY post-seal mutation of an economic field
 * goes through the aggregate primitive, in the SAME transaction as the
 * mutation). `pending_evidence → eligible` is exactly such a mutation: a
 * held row projects ZERO settlement input, a promoted one projects its
 * (lifted) sealed points. The writer is constructed inside this
 * transaction, its reads run with the other reads (before any write), and
 * a row already past the frozen watermark adjusts the FROZEN sums, not the
 * live tail — the same membership rule `mutatePeHistoryRowWithAggregate`
 * applies to the novelty-corrected recovery and the settlement writeback,
 * the existing late-mutation precedents. A late promotion (after the row
 * was frozen at 72h) would otherwise leave the frozen sum at 0 forever.
 * The sealed `economic_snapshot` is never touched. The sweep's own resolution
 * record is written by the sweep, in the same transaction, after this returns.
 */

import type admin from 'firebase-admin';
import type { EligibilityProjection } from './policy/monetary-accounting';
import {
  MintOnceClaimRaceError,
  applyMintOnceClaimDecision,
  canonicalMintOnceClaimEvidence,
  hashMintOnceClaimEvidence,
  inspectPreparedMintOnceClaimInTransaction,
  type MintOnceClaimEvidence,
} from './mint-once-claim';
import type { CompletionPromotionFacts } from './completion-verifier';
import type { PEHistoryDocument } from '../../pe-history';
import { EconomicAggregateWriter } from './policy/economic-aggregate';
import stableStringify from 'json-stable-stringify';
import type { HeldActDoc } from '../meter/held-acts';
import { METER_HELD_ACTS_COLLECTION } from '../meter/meter-store';

/**
 * The `corroboration_status` a promoted off-chain completion witness carries —
 * the poster (a peer, the counterparty) verified the delivery. A recognized
 * member of the settlement-lift set (`CORROBORATION_STATUSES` in the inlet,
 * `currentAttestation` in the projection), so it lifts the row software 0.8× →
 * corroborated 1.1× inside the kernel's 72h enhancement window.
 */
export const COMPLETION_CONFIRMATION_CORROBORATION_STATUS = 'peer_verified';

/** The `mint_status` the settlement inlet selects on. */
const RELAY_STATUS_READY = 'eligible';
/** The held state this promotion leaves. */
const HELD_STATUS = 'pending_evidence';

export type CompletionPromotionOutcome =
  | 'promoted'
  | 'refused_not_pending'
  | 'refused_snapshot_unbound'
  | 'refused_canonical_event_already_minted';

export interface CompletionPromotionInput {
  readonly peId: string;
  /** The sealed snapshot hash the verdict was computed against. */
  readonly economicSnapshotHash: string | null;
  /** The sealed record points — written verbatim, never recomputed. */
  readonly recordPointsAtomic: string;
  readonly facts: CompletionPromotionFacts;
  /** Built by the sweep from the same evidence its resolution record carries. */
  readonly projection: EligibilityProjection;
  readonly nowMs: number;
}

function legacyDisplayPvt(atomic: string): number {
  return Number(BigInt(atomic)) / 1e18;
}

/**
 * The re-check every promotion runs on the row as it stands at commit time: still held, sealed
 * snapshot hash unmoved. One function, so the pre-meter transaction and the held-act `expect`
 * re-check exactly the same thing.
 */
function promotionPreconditionRefusal(
  before: Record<string, unknown>,
  input: CompletionPromotionInput,
): 'refused_not_pending' | 'refused_snapshot_unbound' | null {
  if (before.mint_status !== HELD_STATUS) return 'refused_not_pending';
  if (before.economic_snapshot_hash !== input.economicSnapshotHash) return 'refused_snapshot_unbound';
  return null;
}

/** The promotion patch, built from the row it applies to (its prior claim evidence included). */
function completionPromotionPatch(
  before: Record<string, unknown>,
  input: CompletionPromotionInput,
): Record<string, unknown> {
  const priorEvidence = canonicalMintOnceClaimEvidence(
    Array.isArray(before.mint_once_claim_evidence)
      ? before.mint_once_claim_evidence as MintOnceClaimEvidence[]
      : null,
  );
  const nextEvidence = [...priorEvidence, input.facts.claim.evidence]
    .sort((a, b) => a.claim.claim_kind.localeCompare(b.claim.claim_kind));
  const nextEvidenceHash = hashMintOnceClaimEvidence(nextEvidence);

  return {
    mint_status: RELAY_STATUS_READY,
    mint_disposition: RELAY_STATUS_READY,
    disposition_reason_code: 'policy_eligible',
    estimatedPVT: legacyDisplayPvt(input.recordPointsAtomic),
    estimated_pvt_atomic: input.recordPointsAtomic,
    record_points_atomic: input.recordPointsAtomic,
    economic_eligibility_projection: input.projection,
    corroboration_status: COMPLETION_CONFIRMATION_CORROBORATION_STATUS,
    corroboration_source: input.facts.confirmationPeId,
    corroboration_received_at: input.facts.confirmationTimestampMs,
    completion_canonical_id: input.facts.canonicalId,
    completion_witness: 'counterparty_confirmation',
    completion_resolved_at_ms: input.nowMs,
    mint_once_claim_evidence: nextEvidence,
    mint_once_claim_evidence_hash: nextEvidenceHash,
  };
}

/**
 * Apply one promotion INSIDE the caller's transaction. Every read precedes every
 * write. Returns the outcome; the caller (the sweep) records it.
 */
export async function applyCompletionPromotionInTransaction(
  db: admin.firestore.Firestore,
  txn: admin.firestore.Transaction,
  input: CompletionPromotionInput,
): Promise<CompletionPromotionOutcome> {
  const historyRef = db.collection('pe_history').doc(input.peId);
  const current = await txn.get(historyRef);
  if (!current.exists) return 'refused_not_pending';
  const before = (current.data() ?? {}) as Record<string, unknown>;
  const refusal = promotionPreconditionRefusal(before, input);
  if (refusal !== null) return refusal;

  // THE MINT-ONCE SLOT. A slot the on-chain witness took between the read-only
  // preparation and here is a race, which is the best-supported witness having
  // paid — refuse by name, write nothing.
  let claimDecision;
  try {
    claimDecision = await inspectPreparedMintOnceClaimInTransaction(db, txn, input.facts.claim);
  } catch (error) {
    if (error instanceof MintOnceClaimRaceError) return 'refused_canonical_event_already_minted';
    throw error;
  }

  const patch = completionPromotionPatch(before, input);
  const after: Record<string, unknown> = { ...before, ...patch };

  // M5 — the aggregate delta of this status flip. READ (load) here, with
  // every other read of this transaction already done and before any write;
  // WRITTEN (commit) below, beside the row patch, in this same transaction.
  const aggregateWriter = new EconomicAggregateWriter(db, txn, input.nowMs);
  await aggregateWriter.load(EconomicAggregateWriter.identitiesOf(before, after));

  applyMintOnceClaimDecision(db, txn, claimDecision);
  txn.update(historyRef, patch);
  aggregateWriter.applyMutation(
    before as unknown as PEHistoryDocument,
    after as unknown as PEHistoryDocument,
  );
  aggregateWriter.commit();
  return 'promoted';
}

/**
 * PE METER — the same promotion for a METERED held act (`meter_held_acts_v1/{relay_pe_id}`),
 * whose row lives in its held record rather than `pe_history`.
 *
 * Two transactions, in the only order that can never pay one completion twice:
 *  1. CLAIM THE SLOT against the held row as it stands (still held, snapshot hash unmoved) with
 *     the same crash-safe `inspectPreparedMintOnceClaimInTransaction`; a slot another PE took is
 *     refused by name and nothing is written. The claim carries no TTL (like the pre-meter path):
 *     a held act never expires, so neither may the slot it owns.
 *  2. PROMOTE through `resolveHeldAct`, the one transition for a held act: it lands this module's
 *     patch, applies the aggregate delta, resolves the act's payee legs, creates the act's own
 *     act-unit pending claims and removes the hold, in one transaction whose `expect` re-checks
 *     exactly what (1) and the pre-meter transaction check (still held, snapshot hash unmoved),
 *     plus that the claim evidence the patch was built on has not moved.
 * A crash between them leaves the slot owned by this still-held act (the meter's own precedent:
 * an act's mint-once slots are taken before its batch commits), and the next pass finds the slot
 * self-owned (a no-op re-inspect) and completes the promotion. The reverse order could promote an
 * act whose canonical event another witness had already minted.
 */
export async function applyCompletionPromotionToHeldAct(
  db: admin.firestore.Firestore,
  input: CompletionPromotionInput,
): Promise<CompletionPromotionOutcome> {
  const heldRef = privateRetentionCollection(db, METER_HELD_ACTS_COLLECTION).doc(input.peId);
  type Claimed =
    | { readonly row: Record<string, unknown> }
    | { readonly refusal: 'refused_not_pending' | 'refused_snapshot_unbound' };
  let claimed: Claimed;
  try {
    claimed = await db.runTransaction(async (txn): Promise<Claimed> => {
      const held = await txn.get(heldRef);
      const row = held.exists ? (held.data() as Partial<HeldActDoc> | undefined)?.key?.row : undefined;
      if (row === undefined || row === null || typeof row !== 'object') {
        return { refusal: 'refused_not_pending' };
      }
      const refusal = promotionPreconditionRefusal(row, input);
      if (refusal !== null) return { refusal };
      const decision = await inspectPreparedMintOnceClaimInTransaction(db, txn, input.facts.claim);
      applyMintOnceClaimDecision(db, txn, decision);
      return { row };
    });
  } catch (error) {
    if (error instanceof MintOnceClaimRaceError) return 'refused_canonical_event_already_minted';
    throw error;
  }
  if ('refusal' in claimed) return claimed.refusal;

  const patch = completionPromotionPatch(claimed.row, input);
  const evidenceBuiltOn = stableStringify(claimed.row.mint_once_claim_evidence ?? null);
  // Loaded lazily, like `mutatePeHistoryRowWithAggregate` does: the meter module graph reaches the
  // record path, which must not become a static dependency of the settlement sweeps.
  const { resolveHeldAct } = await import('../meter/held-acts');
  const result = await resolveHeldAct(db, input.peId, patch, {
    nowMs: input.nowMs,
    expect: (before) => promotionPreconditionRefusal(before, input) === null
      && stableStringify(before.mint_once_claim_evidence ?? null) === evidenceBuiltOn,
  });
  switch (result.outcome) {
    case 'promoted':
    case 'promotion_refused':
      // `promotion_refused`: the row IS eligible; the act waits for its payee (payee retry pass).
      return 'promoted';
    case 'precondition_failed':
      return (result.before === null ? null : promotionPreconditionRefusal(result.before, input))
        ?? 'refused_not_pending';
    default:
      // `missing` (another pass already resolved it), or an outcome a promotion cannot produce.
      return 'refused_not_pending';
  }
}

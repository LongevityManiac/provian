

import { PAYOUT_LEG_ROLES, type PayoutLegRole } from '../wp-ev/payout-legs';
import {
  BUG_DEMOTION_COLLECTION,
  CLAIM_LEDGER_COLLECTION,
  PE_HISTORY_COLLECTION,
  claimKeyOf,
  ledgerRowFromInput,
  normalizePeId,
  validateNewClaim,
  type NewClaimInput,
  type SettlementDb,
  type SettlementDocSnap,
} from './durable-settlement-store';
import { topupDeltasFor } from './attestation-topup-inlet-source';
import {
  PE_SPLIT_COLLECTION,
  frozenSplitDocOf,
  parseFrozenSplit,
  proposalFromFrozen,
  sameSplitPayout,
  validateProposedSplit,
  type LateLift,
  type ProposedPeSplit,
} from './pe-split';

export type RegisterSplitResult =
  /**
   * `created` act legs were written now; the rest of the frozen set already existed or is held.
   * `createdTopups` are the late-lift top-ups registered beside them (round 2).
   */
  | {
    readonly kind: 'created';
    readonly created: number;
    readonly createdPointsAtomic: string;
    readonly createdTopups: number;
    readonly createdTopupPointsAtomic: string;
  }
  | { readonly kind: 'already_registered_identical' }
  | { readonly kind: 'rejected'; readonly reason: string };

/** The ledger inputs for every leg of a split, in split order. */
export function splitClaimInputs(
  peId: string,
  split: ProposedPeSplit,
  claimIds: ReadonlyMap<PayoutLegRole, string>,
): NewClaimInput[] | string {
  const inputs: NewClaimInput[] = [];
  for (const leg of split.legs) {
    const claimId = claimIds.get(leg.leg);
    if (typeof claimId !== 'string') return 'claim_id_missing_for_leg';
    const input: NewClaimInput = {
      pe_id: peId,
      leg: leg.leg,
      claim_id: claimId,
      lane: 'standard',
      contributor: leg.contributor,
      beneficiary_class: leg.beneficiary_class,
      record_points_atomic: leg.record_points_atomic,
    };
    const invalid = validateNewClaim(input);
    if (invalid !== null) return invalid;
    inputs.push(input);
  }
  return inputs;
}

function rowMatchesInput(row: Record<string, unknown>, input: NewClaimInput): boolean {
  return row.claim_id === input.claim_id.toLowerCase()
    && row.lane === 'standard'
    && (row.claim_kind ?? 'act') === 'act'
    && row.contributor === input.contributor
    && row.record_points_atomic === input.record_points_atomic
    && row.beneficiary_class === input.beneficiary_class;
}

export async function registerFrozenSplitClaims(
  db: SettlementDb,
  params: {
    readonly peId: string;
    readonly split: ProposedPeSplit;
    readonly claimIds: ReadonlyMap<PayoutLegRole, string>;
    /**
     * The legs the caller has JUDGED this run and found registrable (eligibility, payee,
     * points, class). ONLY these get a ledger row now; every other frozen leg stays in the
     * split, unregistered, until a later run judges it registrable and offers it at its frozen
     * payee/points/class. The split itself is always frozen WHOLE. Omitted = every split leg.
     */
    readonly registerLegs?: ReadonlySet<PayoutLegRole>;
    readonly nowMs: number;
    /**
     * round 2 — the lift a frozen-at-base split is owed (`lateLiftFor`), with each leg's
     * top-up claim id (`deriveTopupClaimId`). When present, every act leg created here also gets
     * its top-up row, in this transaction, at its share of `lifted − total` over ALL frozen legs.
     */
    readonly lateLift?: LateLift & { readonly topupClaimIds: ReadonlyMap<PayoutLegRole, string> };
    /** `pe_history.mint_status` values the PE must hold at commit. */
    readonly requirePeHistoryStatus: readonly string[];
  },
): Promise<RegisterSplitResult> {
  const splitInvalid = validateProposedSplit(params.split);
  if (splitInvalid !== null) return { kind: 'rejected', reason: `split_${splitInvalid}` };
  const inputs = splitClaimInputs(params.peId, params.split, params.claimIds);
  if (typeof inputs === 'string') return { kind: 'rejected', reason: inputs };

  const peKey = normalizePeId(params.peId);
  const ledger = db.collection(CLAIM_LEDGER_COLLECTION);
  const splitRef = db.collection(PE_SPLIT_COLLECTION).doc(peKey);
  const demotionRef = db.collection(BUG_DEMOTION_COLLECTION).doc(peKey);
  const peHistoryRef = db.collection(PE_HISTORY_COLLECTION).doc(params.peId);
  const actRefs = PAYOUT_LEG_ROLES.map((leg) => ({ leg, ref: ledger.doc(claimKeyOf(params.peId, leg)) }));
  const topupRefs = PAYOUT_LEG_ROLES.map((leg) => ({
    leg, ref: ledger.doc(claimKeyOf(params.peId, leg, 'attestation_topup')),
  }));

  return db.runTransaction<RegisterSplitResult>(async (txn) => {
    // ALL reads first (Firestore's rule, and what makes a concurrent writer force a retry).
    const demotion = await txn.get(demotionRef);
    const peSnap = await txn.get(peHistoryRef);
    const splitSnap = await txn.get(splitRef);
    const actSnaps = new Map<PayoutLegRole, SettlementDocSnap>();
    for (const { leg, ref } of actRefs) actSnaps.set(leg, await txn.get(ref));
    const topupExists = new Set<PayoutLegRole>();
    if (params.lateLift !== undefined) {
      for (const { leg, ref } of topupRefs) if ((await txn.get(ref)).exists) topupExists.add(leg);
    }

    if (demotion.exists) return { kind: 'rejected', reason: 'pe_bug_demoted' };
    const status = peSnap.exists ? (peSnap.data() ?? {}).mint_status : undefined;
    if (typeof status !== 'string' || !params.requirePeHistoryStatus.includes(status)) {
      return { kind: 'rejected', reason: 'pe_history_not_settleable' };
    }
    const existingRows = new Map<PayoutLegRole, Record<string, unknown>>();
    for (const [leg, snap] of actSnaps) {
      if (snap.exists) existingRows.set(leg, snap.data() ?? {});
    }

    let toCreate: NewClaimInput[];
    if (splitSnap.exists) {
      // FROZEN. The stored split is the authority; the offer must describe exactly it.
      const parsed = parseFrozenSplit(splitSnap.data(), peKey);
      if (parsed.kind !== 'valid') return { kind: 'rejected', reason: `frozen_split_invalid:${parsed.reason}` };
      const frozen = proposalFromFrozen(parsed.split);
      if (!sameSplitPayout(frozen, params.split)) return { kind: 'rejected', reason: 'frozen_split_mismatch' };
      for (const leg of parsed.split.legs) {
        if (params.claimIds.get(leg.leg)?.toLowerCase() !== leg.claim_id) {
          return { kind: 'rejected', reason: 'frozen_split_claim_id_mismatch' };
        }
      }
      // Every existing act row must BE a frozen leg, byte-for-byte. A row outside the split,
      // or one that disagrees with it, is the over/short shape this module exists to refuse.
      for (const [leg, row] of existingRows) {
        const input = inputs.find((candidate) => candidate.leg === leg);
        if (input === undefined) return { kind: 'rejected', reason: 'ledger_outside_frozen_split' };
        if (!rowMatchesInput(row, input)) return { kind: 'rejected', reason: 'ledger_disagrees_with_frozen_split' };
      }
      toCreate = inputs.filter((input) => !existingRows.has(input.leg)
        && (params.registerLegs === undefined || params.registerLegs.has(input.leg)));
      if (toCreate.length === 0) return { kind: 'already_registered_identical' };
    } else {
      // UNFROZEN. Only a PE with NO act rows may be frozen here: rows without a split are a
      // pre- set, and adding to one is exactly the over/short defect.
      if (existingRows.size > 0) return { kind: 'rejected', reason: 'legacy_leg_set_unfrozen' };
      if (params.split.frozen) return { kind: 'rejected', reason: 'frozen_split_missing' };
      toCreate = inputs.filter((input) => params.registerLegs === undefined || params.registerLegs.has(input.leg));
      // The split is frozen by a REGISTRATION: a PE none of whose legs can register yet is
      // not frozen, and is resolved afresh when one can.
      if (toCreate.length === 0) return { kind: 'rejected', reason: 'no_leg_registrable' };
      txn.create(splitRef, frozenSplitDocOf({
        peId: params.peId, peKey, split: params.split, claimIds: params.claimIds, nowMs: params.nowMs,
      }) as unknown as Record<string, unknown>);
    }
    const topups = params.lateLift === undefined
      ? []
      : lateLiftTopupInputs(params.peId, params.split, toCreate.map((input) => input.leg), params.lateLift)
        .filter((input) => !topupExists.has(input.leg));
    let points = 0n;
    for (const input of toCreate) {
      txn.create(
        ledger.doc(claimKeyOf(input.pe_id, input.leg)),
        ledgerRowFromInput(input, params.nowMs) as unknown as Record<string, unknown>,
      );
      points += BigInt(input.record_points_atomic!);
    }
    let topupPoints = 0n;
    for (const input of topups) {
      txn.create(
        ledger.doc(claimKeyOf(input.pe_id, input.leg, 'attestation_topup')),
        ledgerRowFromInput(input, params.nowMs) as unknown as Record<string, unknown>,
      );
      topupPoints += BigInt(input.record_points_atomic!);
    }
    return {
      kind: 'created',
      created: toCreate.length,
      createdPointsAtomic: points.toString(),
      createdTopups: topups.length,
      createdTopupPointsAtomic: topupPoints.toString(),
    };
  });
}

/**
 * round 2 — the top-up rows owed on act legs registered LATE into a split frozen at the
 * sealed base, after the corroboration lift landed.
 *
 * The delta is `topupDeltasFor(lifted, ALL frozen legs at their frozen points)` the SAME
 * function and the SAME proportions the top-up lane uses — so a leg's share never depends
 * on which siblings already had rows, and Σ(frozen act legs) + Σ(every leg's top-up) == lifted
 * exactly. Each top-up is domain-separated (`claim_kind: 'attestation_topup'`, the top-up claim
 * id, the `#attestation_topup` ledger key): one per leg, ever — the caller skips a leg whose
 * top-up row exists, and `registerClaim`'s identity check guards a replay. Throws on nothing;
 * a malformed input yields no row.
 */
export function lateLiftTopupInputs(
  peId: string,
  split: ProposedPeSplit,
  legsBeingCreated: readonly PayoutLegRole[],
  lift: LateLift & { readonly topupClaimIds: ReadonlyMap<PayoutLegRole, string> },
): NewClaimInput[] {
  if (BigInt(lift.liftedTotalAtomic) <= BigInt(split.totalPointsAtomic)) return [];
  const deltas = topupDeltasFor(
    BigInt(lift.liftedTotalAtomic),
    split.legs.map((leg) => ({ leg: leg.leg, pointsAtomic: BigInt(leg.record_points_atomic) })),
  );
  const out: NewClaimInput[] = [];
  for (const { leg, deltaAtomic } of deltas) {
    if (!legsBeingCreated.includes(leg)) continue;
    const frozen = split.legs.find((candidate) => candidate.leg === leg);
    const claimId = lift.topupClaimIds.get(leg);
    if (frozen === undefined || claimId === undefined) continue;
    const input: NewClaimInput = {
      pe_id: peId,
      leg,
      claim_id: claimId,
      lane: 'standard',
      contributor: frozen.contributor,
      beneficiary_class: frozen.beneficiary_class,
      record_points_atomic: deltaAtomic.toString(),
      claim_kind: 'attestation_topup',
      topup_of_claim_key: claimKeyOf(peId, leg),
      topup_attestation_tier: lift.attestationTier,
      topup_observed_at_ms: lift.observedAtMs,
    };
    if (validateNewClaim(input) === null) out.push(input);
  }
  return out;
}

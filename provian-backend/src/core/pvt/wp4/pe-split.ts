

import {
  BPS_DENOMINATOR,
  PAYOUT_LEG_ROLES,
  type PayoutLegRole,
} from '../wp-ev/payout-legs';
import type { PEHistoryDocument } from '../../../pe-history';
import {
  corroborationLiftedRecordPointsAtomic,
  currentAttestationTier,
} from '../policy/economic-projection';
import { ATTESTATION_HORIZON_CUT_LINE_MS } from '../policy/monetary-accounting';

export const PE_SPLIT_COLLECTION = 'pvt9_pe_split_v1';
export const PE_SPLIT_SCHEMA = 'pvt9-pe-split/v1';

/**
 * Where a frozen split came from. `inlet_resolution` is the only ordinary origin; the leg-sum
 * audit (`leg-sum-audit.ts`) writes `ledger_audit_correction` when it freezes a split for a
 * PE whose legs were registered before.
 */
export type FrozenSplitOrigin = 'inlet_resolution' | 'ledger_audit_correction';

export interface FrozenSplitLeg {
  readonly leg: PayoutLegRole;
  /** Lowercase EVM address this leg settles to — decided once, never re-resolved. */
  readonly contributor: string;
  /** `BeneficiaryClass` as the kernel sees it (0 unknown, 1 human-resolving, 2 autonomous). */
  readonly beneficiary_class: number;
  /** This leg's share of the act. All legs sum to exactly 10,000. */
  readonly bps: number;
  /** This leg's portion of `total_points_atomic`. All legs sum to exactly the total. */
  readonly record_points_atomic: string;
  /** Lowercase bytes32 — `deriveLegClaimId(sealed identity, leg)`. */
  readonly claim_id: string;
}

export interface FrozenSplitDoc {
  readonly schema_version: typeof PE_SPLIT_SCHEMA;
  readonly pe_id: string;
  readonly pe_key: string;
  readonly lane: 'standard';
  /** The total the legs were cut from (the corroboration-lifted total at freeze time). */
  readonly total_points_atomic: string;
  /** `pe_history.record_points_atomic` (the sealed base) at freeze time, when known. */
  readonly base_points_atomic: string | null;
  readonly legs: readonly FrozenSplitLeg[];
  readonly resolved_at_ms: number;
  readonly origin: FrozenSplitOrigin;

  readonly source_fields: Readonly<Record<string, string | number | null>>;
}

/** The split the source proposes for a PE — the doc minus the fields registration stamps. */
export interface ProposedPeSplit {
  readonly totalPointsAtomic: string;
  readonly basePointsAtomic: string | null;
  /** Legs WITHOUT claim ids: the inlet derives each id from the sealed identity. */
  readonly legs: readonly Omit<FrozenSplitLeg, 'claim_id'>[];
  readonly origin: FrozenSplitOrigin;
  readonly sourceFields: Readonly<Record<string, string | number | null>>;
  /**
   * TRUE when this split was READ from an existing `pvt9_pe_split_v1` doc (the PE is frozen;
   * only its missing legs are being offered), FALSE when it was freshly resolved and will be
   * frozen by the registration that carries it.
   */
  readonly frozen: boolean;
}

export type FrozenSplitRefusal =
  | 'not_an_object'
  | 'schema_mismatch'
  | 'pe_key_mismatch'
  | 'lane_mismatch'
  | 'no_legs'
  | 'invalid_leg_role'
  | 'duplicate_leg_role'
  | 'invalid_contributor'
  | 'invalid_beneficiary_class'
  | 'invalid_bps'
  | 'bps_do_not_sum'
  | 'invalid_points'
  | 'points_do_not_sum'
  | 'invalid_claim_id'
  | 'invalid_resolved_at';

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const ATOMIC = /^(0|[1-9][0-9]{0,77})$/;

function isPositiveAtomic(value: unknown): value is string {
  return typeof value === 'string' && ATOMIC.test(value) && BigInt(value) > 0n;
}

/**
 * The legs' arithmetic, the single definition of "sums to exactly 100%": every role distinct
 * and known, every bps a positive integer, bps summing to exactly 10,000, every portion
 * non-zero, and the portions summing to exactly `totalPointsAtomic`. Shared by the proposal
 * check, the frozen-doc check and the leg-sum audit so none of them can disagree.
 */
export function checkLegArithmetic(
  legs: readonly Pick<FrozenSplitLeg, 'leg' | 'bps' | 'record_points_atomic'>[],
  totalPointsAtomic: unknown,
): FrozenSplitRefusal | null {
  if (!Array.isArray(legs) || legs.length === 0) return 'no_legs';
  if (!isPositiveAtomic(totalPointsAtomic)) return 'invalid_points';
  const seen = new Set<string>();
  let bps = 0;
  let points = 0n;
  for (const leg of legs) {
    if (!(PAYOUT_LEG_ROLES as readonly unknown[]).includes(leg?.leg)) return 'invalid_leg_role';
    if (seen.has(leg.leg)) return 'duplicate_leg_role';
    seen.add(leg.leg);
    if (typeof leg.bps !== 'number' || !Number.isInteger(leg.bps) || leg.bps <= 0
      || leg.bps > BPS_DENOMINATOR) {
      return 'invalid_bps';
    }
    if (!isPositiveAtomic(leg.record_points_atomic)) return 'invalid_points';
    bps += leg.bps;
    points += BigInt(leg.record_points_atomic);
  }
  if (bps !== BPS_DENOMINATOR) return 'bps_do_not_sum';
  if (points !== BigInt(totalPointsAtomic)) return 'points_do_not_sum';
  return null;
}

function checkLegPayee(leg: Pick<FrozenSplitLeg, 'contributor' | 'beneficiary_class'>): FrozenSplitRefusal | null {
  if (typeof leg.contributor !== 'string' || !ADDRESS.test(leg.contributor)) return 'invalid_contributor';
  if (typeof leg.beneficiary_class !== 'number' || ![0, 1, 2].includes(leg.beneficiary_class)) {
    return 'invalid_beneficiary_class';
  }
  return null;
}

/** Validate a proposed (not yet frozen) split. Null = sound. */
export function validateProposedSplit(split: ProposedPeSplit): FrozenSplitRefusal | null {
  if (split === null || typeof split !== 'object') return 'not_an_object';
  const arithmetic = checkLegArithmetic(split.legs, split.totalPointsAtomic);
  if (arithmetic !== null) return arithmetic;
  for (const leg of split.legs) {
    const payee = checkLegPayee(leg);
    if (payee !== null) return payee;
  }
  return null;
}

export type FrozenSplitParse =
  | { readonly kind: 'valid'; readonly split: FrozenSplitDoc }
  | { readonly kind: 'invalid'; readonly reason: FrozenSplitRefusal };

/**
 * Parse a stored split doc. Fail-closed: anything that does not re-validate is `invalid`, and
 * every caller treats an invalid split as "do not pay, do not flip" — never as "no split".
 * `expectedPeKey` binds the doc to the PE the caller is processing, so a doc copied onto
 * another PE's key cannot stand in for that PE's split.
 */
export function parseFrozenSplit(raw: unknown, expectedPeKey: string): FrozenSplitParse {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', reason: 'not_an_object' };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.schema_version !== PE_SPLIT_SCHEMA) return { kind: 'invalid', reason: 'schema_mismatch' };
  if (doc.pe_key !== expectedPeKey) return { kind: 'invalid', reason: 'pe_key_mismatch' };
  if (doc.lane !== 'standard') return { kind: 'invalid', reason: 'lane_mismatch' };
  if (typeof doc.resolved_at_ms !== 'number' || !Number.isSafeInteger(doc.resolved_at_ms)) {
    return { kind: 'invalid', reason: 'invalid_resolved_at' };
  }
  const legs = doc.legs;
  if (!Array.isArray(legs)) return { kind: 'invalid', reason: 'no_legs' };
  const typed = legs as FrozenSplitLeg[];
  const arithmetic = checkLegArithmetic(typed, doc.total_points_atomic);
  if (arithmetic !== null) return { kind: 'invalid', reason: arithmetic };
  for (const leg of typed) {
    const payee = checkLegPayee(leg);
    if (payee !== null) return { kind: 'invalid', reason: payee };
    if (typeof leg.claim_id !== 'string' || !BYTES32.test(leg.claim_id)) {
      return { kind: 'invalid', reason: 'invalid_claim_id' };
    }
  }
  return { kind: 'valid', split: doc as unknown as FrozenSplitDoc };
}

/** The split as a proposal, for (re)offering a frozen PE's missing legs. */
export function proposalFromFrozen(split: FrozenSplitDoc): ProposedPeSplit {
  return {
    totalPointsAtomic: split.total_points_atomic,
    basePointsAtomic: split.base_points_atomic,
    legs: split.legs.map(({ claim_id: _claimId, ...leg }) => leg),
    origin: split.origin,
    sourceFields: split.source_fields,
    frozen: true,
  };
}

/** Build the doc a registration freezes. Claim ids are supplied by the caller (derived). */
export function frozenSplitDocOf(params: {
  readonly peId: string;
  readonly peKey: string;
  readonly split: ProposedPeSplit;
  readonly claimIds: ReadonlyMap<PayoutLegRole, string>;
  readonly nowMs: number;
}): FrozenSplitDoc {
  return {
    schema_version: PE_SPLIT_SCHEMA,
    pe_id: params.peId,
    pe_key: params.peKey,
    lane: 'standard',
    total_points_atomic: params.split.totalPointsAtomic,
    base_points_atomic: params.split.basePointsAtomic,
    legs: params.split.legs.map((leg) => ({
      leg: leg.leg,
      contributor: leg.contributor,
      beneficiary_class: leg.beneficiary_class,
      bps: leg.bps,
      record_points_atomic: leg.record_points_atomic,
      claim_id: (params.claimIds.get(leg.leg) ?? '').toLowerCase(),
    })),
    resolved_at_ms: params.nowMs,
    origin: params.split.origin,
    source_fields: params.split.sourceFields,
  };
}

/** Two splits describe the same payout (legs, addresses, classes, bps, points, total). */
export function sameSplitPayout(
  a: Pick<ProposedPeSplit, 'totalPointsAtomic' | 'legs'>,
  b: Pick<ProposedPeSplit, 'totalPointsAtomic' | 'legs'>,
): boolean {
  if (a.totalPointsAtomic !== b.totalPointsAtomic || a.legs.length !== b.legs.length) return false;
  return a.legs.every((leg) => {
    const other = b.legs.find((candidate) => candidate.leg === leg.leg);
    return other !== undefined
      && other.contributor === leg.contributor
      && other.beneficiary_class === leg.beneficiary_class
      && other.bps === leg.bps
      && other.record_points_atomic === leg.record_points_atomic;
  });
}

/**
 * round 2 — the corroboration lift a LATE-registering frozen leg is owed.
 *
 * A frozen leg that registers after its siblings (withheld by a per-claim check, or left to fill by
 * a leg-sum correction) may do so after the lift landed and after the top-up sweep's floor (`topupSweepFloorMs`, two horizons back) has moved
 * past the PE's corroboration. So the delta owed on that leg is registered in the SAME
 * transaction as its act row. Returns the lift only when it is exactly the case the
 * top-up lane pays: a post-cut-line PE, a split frozen at the sealed BASE, and the same gate
 * (`corroborationLiftedRecordPointsAtomic`) lifting it above that base. Null otherwise — a
 * split frozen at the lifted total owes nothing, and anything else is never guessed.
 */
export interface LateLift {
  readonly liftedTotalAtomic: string;
  readonly attestationTier: string;
  readonly observedAtMs: number;
}

export function lateLiftFor(history: Record<string, unknown>, frozenTotalAtomic: string): LateLift | null {
  const recordedAt = history.timestamp;
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)
    || recordedAt < ATTESTATION_HORIZON_CUT_LINE_MS) return null;
  if (history.is_genesis_grant === true) return null;
  const base = history.record_points_atomic;
  if (typeof base !== 'string' || !ATOMIC.test(base) || base !== frozenTotalAtomic) return null;
  const lifted = corroborationLiftedRecordPointsAtomic(history as unknown as PEHistoryDocument);
  if (!ATOMIC.test(lifted) || BigInt(lifted) <= BigInt(base)) return null;
  const tier = currentAttestationTier(history as unknown as PEHistoryDocument);
  const observedAt = history.corroboration_received_at;
  if (tier === null || typeof observedAt !== 'number' || !Number.isFinite(observedAt) || observedAt <= 0) return null;
  return { liftedTotalAtomic: lifted, attestationTier: tier, observedAtMs: Math.trunc(observedAt) };
}

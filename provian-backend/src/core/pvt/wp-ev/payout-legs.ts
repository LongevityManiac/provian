/**
 * WP-EV — ONE ACT, SEVERAL PAYEES. The general mechanism.
 *
 * ── THE PROBLEM IT SOLVES ────────────────────────────────────────────────────
 * A linked-agent PE owes two people: the agent gets `agent_share_bps` of the contributor share
 * and its human gets the rest. `settleStandardPEBatch` mints the whole of a recipient's share to
 * ONE address, so M7 concluded a split was inexpressible and refused every such PE
 * (`linked_agent_split_unwired`,).
 *
 * That conclusion was wrong, and the reason is worth stating precisely. The kernel dedupes on
 * `claimSettled[claimId]`, which is keyed PER CLAIM ITEM — not per PE, and not per recipient. A
 * batch may therefore carry two recipients, each with one claim, each claim carrying its own id
 * and its own portion of the points. Two legs of one act settle independently, one address per
 * recipient stays true, and the kernel needs no change.
 *
 * ── WHY THIS IS A GENERAL SPLIT AND NOT AN AGENT/HUMAN SPECIAL CASE ──────────
 * A PE resolves to a LIST of legs, each a role, an address, and a share in basis points summing
 * to exactly 10,000. Two legs today; the shape does not care. That generality is not decoration:
 * the kernel already performs its own split — `PROVIAN_BPS` and the Foundation rate come off
 * every recipient's gross inside `settleStandardPEBatch` and expressing settler-side legs in
 * the same vocabulary means the two layers can be reasoned about together instead of one being a
 * hard-coded pair and the other an implicit constant. `KERNEL_INTRINSIC_LEGS` documents the
 * kernel's own legs in exactly this form so the whole distribution of an act is readable in one
 * place, even though this layer never emits them.
 *
 * ── THE ARITHMETIC RULE ──────────────────────────────────────────────────────
 * Integer basis points, floor division, and the REMAINDER GOES TO THE LAST LEG. Splitting
 * atomic units by bps cannot be exact, and the alternatives are worse: dropping the remainder
 * burns dust on every split, and distributing it proportionally reintroduces rounding. Assigning
 * it deterministically means `sum(legs) === total` exactly, always, which is the property the
 * kernel's cap accounting and the ledger's audit both depend on.
 *
 * Pure. Hashes nothing, reads nothing, prices nothing beyond dividing a number that was already
 * decided at record time.
 */

/**
 * The named legs an act can pay out to.
 *
 * A closed set on purpose. Claim ids are domain-separated by role (`claim-id.ts`), so a role is
 * part of a settled identity forever; inventing one at a call site would mint under an id nobody
 * can account for. `sole` is the identity case — one payee, one leg — and its claim id is
 * byte-identical to the unsplit derivation so nothing that already exists changes id.
 */
export type PayoutLegRole = 'sole' | 'agent' | 'beneficiary';

export const PAYOUT_LEG_ROLES: readonly PayoutLegRole[] =
  ['sole', 'agent', 'beneficiary'];

/**
 * WHICH CLAIM of a leg this is. `act` is the original settlement of the act's
 * sealed record points (the identity case: absent on every pre- row and byte-neutral
 * in every key). `attestation_topup` is the ADDITIVE, separately claim-keyed mint for the
 * delta between the tier the act sealed at and a verified attestation upgrade observed
 * inside the act's own corroboration horizon AFTER the act's row had already registered
 * or minted. A closed set for the same reason the leg roles are: the kind is folded into
 * the claim id's domain separator and into the ledger document id, so a kind is part of a
 * settled identity forever.
 */
export type ClaimKind = 'act' | 'attestation_topup';

export const CLAIM_KINDS: readonly ClaimKind[] = ['act', 'attestation_topup'];

export function isClaimKind(value: unknown): value is ClaimKind {
  return typeof value === 'string' && (CLAIM_KINDS as readonly string[]).includes(value);
}

export const BPS_DENOMINATOR = 10_000;

export interface PayoutLeg {
  readonly role: PayoutLegRole;
  /** Lowercase EVM address this leg settles to. */
  readonly address: string;
  /** This leg's share of the act, in basis points. All legs sum to exactly 10,000. */
  readonly bps: number;
  /** This leg's portion of the act's points, in atomic units. All legs sum to the total. */
  readonly pointsAtomic: string;
}

/**
 * The kernel's OWN legs, documented in the same vocabulary.
 *
 * `settleStandardPEBatch` takes `PROVIAN_BPS` (50) and the epoch's Foundation rate off each
 * recipient's gross before the contributor sees it. This layer never emits these — the kernel
 * applies them itself, to every leg above independently — but writing them down here is what
 * makes the full distribution of an act legible rather than half-visible. The contributor bps is
 * a function of the epoch policy's `agentFoundationBps`, so it is deliberately not a constant.
 */
export const KERNEL_INTRINSIC_LEGS = Object.freeze({
  provian: 50,
  /** The human/Genesis floor. An agent-terminating mint may use a higher approved rate. */
  foundationHumanFloor: 50,
});

export type PayoutLegRefusal =
  | 'no_legs'
  | 'bps_do_not_sum'
  | 'invalid_bps'
  | 'invalid_address'
  | 'duplicate_role'
  | 'invalid_points'
  | 'zero_leg';

export type PayoutLegResult =
  | { readonly kind: 'legs'; readonly legs: readonly PayoutLeg[] }
  | { readonly kind: 'refused'; readonly reason: PayoutLegRefusal };

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ATOMIC = /^\d{1,78}$/;

export interface PayoutLegSpec {
  readonly role: PayoutLegRole;
  readonly address: string;
  readonly bps: number;
}

/**
 * Split an act's points across its legs.
 *
 * Fail-closed on every input: bps that do not sum to exactly 10,000, a malformed address, a
 * repeated role, unparseable points, or ANY leg that would receive zero. The zero rule matters —
 * the kernel reverts the whole batch on `recordPointsAtomic == 0`, so a 1-atomic-unit act split
 * 20/80 must be refused here rather than wedge a batch on arrival.
 */
export function splitPointsAcrossLegs(
  specs: readonly PayoutLegSpec[],
  totalPointsAtomic: string,
): PayoutLegResult {
  if (!Array.isArray(specs) || specs.length === 0) {
    return { kind: 'refused', reason: 'no_legs' };
  }
  if (typeof totalPointsAtomic !== 'string' || !ATOMIC.test(totalPointsAtomic)) {
    return { kind: 'refused', reason: 'invalid_points' };
  }
  const total = BigInt(totalPointsAtomic);
  if (total <= 0n) return { kind: 'refused', reason: 'invalid_points' };

  const seen = new Set<PayoutLegRole>();
  let bpsSum = 0;
  for (const spec of specs) {
    if (!PAYOUT_LEG_ROLES.includes(spec?.role)) return { kind: 'refused', reason: 'duplicate_role' };
    if (seen.has(spec.role)) return { kind: 'refused', reason: 'duplicate_role' };
    seen.add(spec.role);
    if (typeof spec.bps !== 'number' || !Number.isInteger(spec.bps) || spec.bps <= 0
      || spec.bps > BPS_DENOMINATOR) {
      return { kind: 'refused', reason: 'invalid_bps' };
    }
    if (typeof spec.address !== 'string' || !ADDRESS.test(spec.address)) {
      return { kind: 'refused', reason: 'invalid_address' };
    }
    bpsSum += spec.bps;
  }
  if (bpsSum !== BPS_DENOMINATOR) return { kind: 'refused', reason: 'bps_do_not_sum' };

  const legs: PayoutLeg[] = [];
  let assigned = 0n;
  specs.forEach((spec, index) => {
    // The LAST leg takes the remainder, so the parts sum to the whole exactly. Floor division
    // on every leg and then dropping the dust would burn value on every single split.
    const portion = index === specs.length - 1
      ? total - assigned
      : (total * BigInt(spec.bps)) / BigInt(BPS_DENOMINATOR);
    assigned += portion;
    legs.push({
      role: spec.role,
      address: spec.address.toLowerCase(),
      bps: spec.bps,
      pointsAtomic: portion.toString(),
    });
  });

  // The kernel reverts the batch on a zero-point claim; refuse the split rather than emit one.
  if (legs.some((leg) => BigInt(leg.pointsAtomic) <= 0n)) {
    return { kind: 'refused', reason: 'zero_leg' };
  }
  // Belt and braces: the invariant the remainder rule exists to guarantee, asserted rather than
  // assumed. If this ever fails the act would mint more or less than it was priced at.
  const rebuilt = legs.reduce((sum, leg) => sum + BigInt(leg.pointsAtomic), 0n);
  if (rebuilt !== total) return { kind: 'refused', reason: 'invalid_points' };

  return { kind: 'legs', legs };
}

/**
 * The legs for a linked-agent act: the agent's configured share, and its human beneficiary.
 *
 * `agentShareBps` is the record-time value from the sealed `beneficiary_routing_snapshot`, never
 * a live config read — the snapshot exists precisely so the split cannot be repriced after the
 * fact. The beneficiary takes the remaining bps AND the arithmetic remainder.
 */
export function linkedAgentLegs(params: {
  readonly agentAddress: string;
  readonly humanAddress: string;
  readonly agentShareBps: number;
  readonly totalPointsAtomic: string;
}): PayoutLegResult {
  if (typeof params?.agentShareBps !== 'number' || !Number.isInteger(params.agentShareBps)
    || params.agentShareBps <= 0 || params.agentShareBps >= BPS_DENOMINATOR) {
    return { kind: 'refused', reason: 'invalid_bps' };
  }
  return splitPointsAcrossLegs([
    { role: 'agent', address: params.agentAddress, bps: params.agentShareBps },
    { role: 'beneficiary', address: params.humanAddress, bps: BPS_DENOMINATOR - params.agentShareBps },
  ], params.totalPointsAtomic);
}

/** The single-payee case, expressed in the same vocabulary. */
export function soleLeg(address: string, totalPointsAtomic: string): PayoutLegResult {
  return splitPointsAcrossLegs([{ role: 'sole', address, bps: BPS_DENOMINATOR }], totalPointsAtomic);
}


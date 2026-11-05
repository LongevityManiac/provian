/**
 * settlement runtime — per-PE claim identity and the single cross-lane cursor.
 *
 * Two kernel facts drive this module, both pinned in
 * `contracts/test/ProvianPVT9Wp4Settlement.t.sol` *
 * 1. The standard lane dedupes on `claimId` ALONE and carries no PE identity.
 * Re-settling the same work under a freshly derived claim id mints a second
 * time and nothing on-chain detects it
 * (`test_standardLane_freshClaimIdForSameWork_doubleMints`). The Genesis lane
 * has a second net — the typed one-time anchor — so the same drift is caught
 * there (`test_genesisLane_freshClaimIdIsStillCaughtByTheOneTimeAnchor`).
 * That asymmetry is why claim-id stability is a settler-layer obligation and
 * cannot be delegated to the kernel.
 * 2. Standard and Genesis share ONE monotonic `nextFinalizedCursor`
 * (`test_cursor_isOneMonotonicCounterSharedByBothLanes`), so cursor ranges
 * must come from a single sequence and the two lanes can never be submitted
 * concurrently.
 *
 * This module deliberately does NOT derive claim ids. How a claim id is derived
 * from a PE is a protocol decision that belongs with the PE schema, not with
 * the settler. What is enforced here is that whatever derivation is used stays
 * STABLE for the life of a PE, which is the property that prevents the double
 * mint. Pure verification: nothing signs, submits, or connects.
 */

import { PAYOUT_LEG_ROLES, isClaimKind, type ClaimKind, type PayoutLegRole } from '../wp-ev/payout-legs';

export type SettlementLane = 'standard' | 'genesis';

/**
 * THE UNIT OF IDENTITY IS THE CLAIM, NOT THE PE (M9).
 *
 * gave one act up to N payout legs, each with its own claim id, because the kernel dedupes
 * on `claimSettled[claimId]` per claim ITEM. This module was still indexed by PE, so the two legs
 * of one act collapsed onto a single map entry: the second overwrote the first, the survivor's
 * claim id did not match the other leg's proposal, and the verdict was `claim_id_drift` +
 * `duplicate_pe_in_proposal`. `runSettlementCycle` treats that as `stop('claim_identity_
 * violations')` a whole-cycle halt, not a per-PE skip — and selection restarts from the same
 * unsettled rows every sweep, so ONE split act would have wedged settlement for everyone,
 * permanently. Neither payee paid, and every unrelated standard and Genesis claim behind it
 * stopped too.
 *
 * Everything below is therefore keyed on `${peId}#${leg}`. The double-mint property the module
 * exists to protect is unchanged and now strictly stronger: a claim id seen twice is a violation
 * even when both sightings are legs of the SAME PE.
 */
/**
 * The leg vocabulary is IMPORTED, not redeclared.
 *
 * M9 round 2: this module had its own `PayoutLegRole` + `VALID_LEGS` while
 * `durable-settlement-store.ts` and `wp-ev/claim-id.ts` both import
 * `PAYOUT_LEG_ROLES` from `wp-ev/payout-legs.ts` — a third copy of the same closed set. That is
 * the run contract's named "self-referential"/redeclared-literal shape, and it had teeth here:
 * adding a fourth role in `payout-legs.ts` would have made `isValidLeg` reject every ledger
 * record carrying it, silently disabling the drift checker wholesale with no test failure.
 * One source, so a new role cannot desynchronise the checker from the writer.
 */
export type { PayoutLegRole } from '../wp-ev/payout-legs';

/** A claim the worker intends to put in a batch. */
export interface ProposedClaim {
  readonly peId: string;
  /** Which payout leg of the act. One act may propose several, each with its own claim id. */
  readonly leg: PayoutLegRole;
  /**
   * which claim of the leg. Absent = `act`. A top-up is a DISTINCT identity from
   * the act on the same (pe, leg): it is keyed separately below, so the act's settled row
   * never reads as `pe_already_settled` / `claim_id_drift` against its own top-up.
   */
  readonly kind?: ClaimKind;
  readonly claimId: string;
  readonly lane: SettlementLane;
  /** Genesis only: `genesisAnchorKey(grantType, oneTimeAnchor)`. */
  readonly genesisAnchorKey?: string;
}

/** What the settler durably recorded for one CLAIM of a PE on an earlier pass. */
export interface RecordedClaim {
  readonly peId: string;
  readonly leg: PayoutLegRole;
  /** which claim of the leg. Absent = `act`. */
  readonly kind?: ClaimKind;
  readonly claimId: string;
  readonly lane: SettlementLane;
  /** True once a settlement receipt for this claim was reconciled on-chain. */
  readonly settled: boolean;
  readonly genesisAnchorKey?: string;
}

export type ClaimIdentityViolationKind =
  /** The double-mint vector: a PE re-proposed under a different claim id. */
  | 'claim_id_drift'
  | 'genesis_anchor_drift'
  | 'lane_drift'
  /** Already minted; proposing it again is at best a wasted transaction. */
  | 'pe_already_settled'
  /** The same (PE, leg) proposed twice in one batch. Two DIFFERENT legs are legitimate. */
  | 'duplicate_claim_in_proposal'
  /** Two PEs sharing one claim id: the kernel would silently drop the second. */
  | 'claim_id_collision'
  | 'claim_id_owned_by_other_pe'
  | 'invalid_claim';

export interface ClaimIdentityViolation {
  readonly kind: ClaimIdentityViolationKind;
  readonly peId: string;
  readonly claimId: string;
  /** The value already on record, when the violation is a drift or collision. */
  readonly recorded?: string;
}

export type ClaimIdentityVerdict =
  | { readonly kind: 'stable' }
  | { readonly kind: 'violations'; readonly violations: readonly ClaimIdentityViolation[] };

const BYTES32 = /^0x[0-9a-f]{64}$/i;
/** The kernel rejects `claimId == bytes32(0)` and a zero Genesis anchor. */
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

function isSettleableHash(value: unknown): value is string {
  return typeof value === 'string' && BYTES32.test(value) && value.toLowerCase() !== ZERO_BYTES32;
}

function normalize(value: string): string {
  return value.toLowerCase();
}

/**
 * PE ids are compared case- and whitespace-insensitively. The relay's own
 * envelope-id validator is case-insensitive, so `PE-Abc` and `pe-abc` are one
 * PE; treating them as two would let a settled PE re-enter under a fresh claim
 * id and mint twice, which nothing on the standard lane can detect.
 */
function normalizePeId(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The characters a PE id may contain, mirroring `durable-settlement-store.ts::PE_ID`.
 *
 * Declared here rather than imported ONLY because this module is deliberately dependency-free
 * (it is pure verification and is imported by the store's own caller). The two must agree; if
 * one changes, so must the other. `claim-identity.test.ts` asserts a `#`-bearing PE id is
 * refused, which is the property that matters and the one that would break first.
 */
const PE_ID_CHARSET = /^[A-Za-z0-9_:-]{1,200}$/;

/**
 * The identity key. `#` cannot occur in a PE id — see `PE_ID_CHARSET`, enforced on every
 * proposal by `isValidProposal` — and the leg is a closed set of three literals, so the join is
 * unambiguous and no PE id can spell another PE's claim key.
 */
/**
 * Mirrors `durable-settlement-store.ts::claimKeyOf` EXACTLY : the `act` kind adds
 * nothing, a top-up appends `#attestation_topup`. The two modules must agree on what
 * counts as one claim, or a legitimate top-up would read as drift against its own act.
 */
function claimKey(peId: string, leg: PayoutLegRole, kind: ClaimKind = 'act'): string {
  const base = `${normalizePeId(peId)}#${leg}`;
  return kind === 'act' ? base : `${base}#${kind}`;
}

function isValidLeg(value: unknown): value is PayoutLegRole {
  return typeof value === 'string' && (PAYOUT_LEG_ROLES as readonly string[]).includes(value);
}

function isValidProposal(claim: ProposedClaim): boolean {
  if (typeof claim.peId !== 'string' || claim.peId.trim() === '') return false;
  // The charset is what makes `${peId}#${leg}` unambiguous. Checked here rather than assumed
  // from the registration path: this module must not depend on a caller having validated, or
  // the separator argument becomes a claim about someone else's code.
  if (!PE_ID_CHARSET.test(normalizePeId(claim.peId))) return false;
  if (!isValidLeg(claim.leg)) return false;
  if (claim.kind !== undefined && !isClaimKind(claim.kind)) return false;
  // a top-up exists only on the standard lane.
  if (claim.kind === 'attestation_topup' && claim.lane !== 'standard') return false;
  if (!isSettleableHash(claim.claimId)) return false;
  if (claim.lane !== 'standard' && claim.lane !== 'genesis') return false;
  if (claim.lane === 'genesis') {
    if (!isSettleableHash(claim.genesisAnchorKey)) return false;
  } else if (claim.genesisAnchorKey !== undefined) {
    return false;
  }
  return true;
}

/**
 * Verify that every proposed claim keeps the identity its PE already has.
 *
 * Reports ALL violations rather than the first, so one pass shows the whole
 * blast radius. An empty proposal is trivially stable.
 */
export function verifyClaimIdentity(
  proposed: readonly ProposedClaim[],
  ledger: ReadonlyMap<string, RecordedClaim>,
): ClaimIdentityVerdict {
  const violations: ClaimIdentityViolation[] = [];

  // Indexed from each record's OWN peId rather than trusting the map key: a
  // caller that keys the ledger differently must not silently defeat every
  // check below.
  const byClaimKey = new Map<string, RecordedClaim>();
  const claimOwners = new Map<string, string>();
  for (const record of ledger.values()) {
    if (!isValidLeg(record.leg) || (record.kind !== undefined && !isClaimKind(record.kind))) {
      // FAIL CLOSED. Skipping a malformed record dropped it from `byClaimKey` AND from
      // `claimOwners`, so `claim_id_drift`, `lane_drift`, `genesis_anchor_drift`,
      // `pe_already_settled` and `claim_id_owned_by_other_pe` were all silently unenforced for
      // it and the proposal came back `stable` — the exact inverse of this module's posture.
      violations.push({
        kind: 'invalid_claim',
        peId: typeof record.peId === 'string' ? record.peId : '',
        claimId: typeof record.claimId === 'string' ? record.claimId : '',
      });
      continue;
    }
    byClaimKey.set(claimKey(record.peId, record.leg, record.kind), record);
    // Owned by the CLAIM, not the PE: two legs of one act hold two distinct ids, and an id
    // showing up under a different (pe, leg) than the one that recorded it is still the
    // double-mint vector this module exists to stop.
    claimOwners.set(normalize(record.claimId), claimKey(record.peId, record.leg, record.kind));
  }

  const seenClaimKeys = new Set<string>();
  const seenClaimIds = new Map<string, string>();

  for (const claim of proposed) {
    if (!isValidProposal(claim)) {
      violations.push({
        kind: 'invalid_claim',
        peId: typeof claim.peId === 'string' ? claim.peId : '',
        claimId: typeof claim.claimId === 'string' ? claim.claimId : '',
      });
      continue;
    }

    const claimId = normalize(claim.claimId);
    const key = claimKey(claim.peId, claim.leg, claim.kind);

    if (seenClaimKeys.has(key)) {
      violations.push({
        kind: 'duplicate_claim_in_proposal',
        peId: claim.peId,
        claimId: claim.claimId,
      });
    }
    seenClaimKeys.add(key);

    // Compared on the CLAIM KEY, so two legs of one act that somehow derived the SAME id are
    // caught. Comparing on the PE id (as this did pre-M9) would have silently permitted exactly
    // that, and the kernel would drop the second leg while the ledger recorded both as paid.
    const collidingKey = seenClaimIds.get(claimId);
    if (collidingKey !== undefined && collidingKey !== key) {
      violations.push({
        kind: 'claim_id_collision',
        peId: claim.peId,
        claimId: claim.claimId,
        recorded: collidingKey,
      });
    }
    seenClaimIds.set(claimId, key);

    const owner = claimOwners.get(claimId);
    if (owner !== undefined && owner !== key) {
      violations.push({
        kind: 'claim_id_owned_by_other_pe',
        peId: claim.peId,
        claimId: claim.claimId,
        recorded: owner,
      });
    }

    const record = byClaimKey.get(key);
    if (record === undefined) continue;

    if (record.settled) {
      violations.push({
        kind: 'pe_already_settled',
        peId: claim.peId,
        claimId: claim.claimId,
        recorded: record.claimId,
      });
    }
    if (normalize(record.claimId) !== claimId) {
      violations.push({
        kind: 'claim_id_drift',
        peId: claim.peId,
        claimId: claim.claimId,
        recorded: record.claimId,
      });
    }
    if (record.lane !== claim.lane) {
      violations.push({
        kind: 'lane_drift',
        peId: claim.peId,
        claimId: claim.claimId,
        recorded: record.lane,
      });
    }
    // Unknown = block: a genesis record with no anchor on file cannot witness
    // that the proposed anchor is unchanged, so it is not treated as "no drift".
    if (
      claim.lane === 'genesis'
      && record.lane === 'genesis'
      && (record.genesisAnchorKey === undefined
        || claim.genesisAnchorKey === undefined
        || normalize(record.genesisAnchorKey) !== normalize(claim.genesisAnchorKey))
    ) {
      violations.push({
        kind: 'genesis_anchor_drift',
        peId: claim.peId,
        claimId: claim.claimId,
        recorded: record.genesisAnchorKey,
      });
    }
  }

  return violations.length === 0 ? { kind: 'stable' } : { kind: 'violations', violations };
}

/** A batch's claim on the shared cursor, whichever lane it settles through. */
export interface LaneCursorSegment {
  readonly lane: SettlementLane;
  readonly claimCount: number;
}

export interface AllocatedCursorRange {
  readonly lane: SettlementLane;
  readonly claimCount: number;
  readonly cursorStart: bigint;
  readonly cursorEnd: bigint;
}

export type CursorChainRejection =
  | 'invalid_start_cursor'
  | 'invalid_segment'
  | 'cursor_not_contiguous'
  | 'cursor_not_monotonic'
  | 'cursor_range_mismatch';

export type CursorAllocationResult =
  | { readonly kind: 'allocated'; readonly ranges: readonly AllocatedCursorRange[] }
  | { readonly kind: 'rejected'; readonly reason: CursorChainRejection; readonly index?: number };

/**
 * Allocate cursor ranges for an ORDERED, mixed-lane sequence of batches.
 *
 * Both lanes draw from one counter, so this is the only correct way to size
 * them: each range begins exactly where the previous one ended, regardless of
 * which lane produced it. There is no per-lane sequence to allocate from, and
 * two batches may never hold the same `cursorStart` — the second would revert
 * `CursorDiscontinuity`, which is also why the lanes cannot run concurrently.
 */
export function allocateCursorRanges(
  startCursor: bigint,
  segments: readonly LaneCursorSegment[],
): CursorAllocationResult {
  if (typeof startCursor !== 'bigint' || startCursor < 0n) {
    return { kind: 'rejected', reason: 'invalid_start_cursor' };
  }

  const ranges: AllocatedCursorRange[] = [];
  let cursor = startCursor;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      (segment.lane !== 'standard' && segment.lane !== 'genesis')
      || !Number.isSafeInteger(segment.claimCount)
      || segment.claimCount <= 0
    ) {
      return { kind: 'rejected', reason: 'invalid_segment', index };
    }
    const cursorEnd = cursor + BigInt(segment.claimCount);
    ranges.push({ lane: segment.lane, claimCount: segment.claimCount, cursorStart: cursor, cursorEnd });
    cursor = cursorEnd;
  }

  return { kind: 'allocated', ranges };
}

/**
 * Check that an already-built sequence forms one unbroken chain from
 * `startCursor`: no fork (two batches sharing a start), no gap, no overlap, and
 * every range exactly as long as its claim count. Catches a worker that
 * accidentally allocated the two lanes from separate counters.
 */
export function validateCursorChain(
  startCursor: bigint,
  ranges: readonly AllocatedCursorRange[],
): { readonly kind: 'valid' } | { readonly kind: 'rejected'; readonly reason: CursorChainRejection; readonly index: number } {
  if (typeof startCursor !== 'bigint' || startCursor < 0n) {
    return { kind: 'rejected', reason: 'invalid_start_cursor', index: 0 };
  }

  let expected = startCursor;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (
      typeof range.cursorStart !== 'bigint'
      || typeof range.cursorEnd !== 'bigint'
      || !Number.isSafeInteger(range.claimCount)
      || range.claimCount <= 0
    ) {
      return { kind: 'rejected', reason: 'invalid_segment', index };
    }
    if (range.cursorEnd <= range.cursorStart) {
      return { kind: 'rejected', reason: 'cursor_not_monotonic', index };
    }
    if (range.cursorEnd - range.cursorStart !== BigInt(range.claimCount)) {
      return { kind: 'rejected', reason: 'cursor_range_mismatch', index };
    }
    if (range.cursorStart !== expected) {
      return { kind: 'rejected', reason: 'cursor_not_contiguous', index };
    }
    expected = range.cursorEnd;
  }

  return { kind: 'valid' };
}

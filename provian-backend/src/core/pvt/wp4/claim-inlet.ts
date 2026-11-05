/**
 * settlement runtime — THE INLET. Turning a qualifying act into a durable settlement claim.
 *
 * Everything downstream of a qualifying act already existed and none of it ran, because
 * nothing ever called `registerClaim`. `wp4/durable-settlement-store.ts` is the ledger,
 * `wp4/settlement-cycle-runner.ts` drains it, `wp-ev/eligibility.ts` decides what qualifies
 * and `wp-ev/claim-id.ts` names it — and between the relay's sealed PEs and that ledger there
 * was no code at all. This module is that missing edge, and nothing else:
 *
 * sealed PE -> evaluateEligibility -> deriveClaimId -> registerClaim
 *
 * WHAT THIS MODULE DELIBERATELY IS NOT
 *
 * It does not decide eligibility (that is `wp-ev/eligibility.ts`), derive identity
 * (`wp-ev/claim-id.ts`), or price anything. It reads `record_points_atomic` verbatim off the
 * sealed economic snapshot and never recomputes it — repricing at claim time would let the
 * inlet silently disagree with the record the relay already sealed, and the sealed record is
 * the one the earner can audit.
 *
 * It mints nothing, signs nothing, sends nothing, and opens no connection. A claim row is a
 * settler-side bookkeeping record; the kernel remains the only mint authority. The only
 * writes are `registerClaim` creates, which are transactional and idempotent per PE.
 *
 * TWO LANES, TWO SOURCES, ONE POLICY
 *
 * Both lanes run through this module, and each has its OWN source. The standard lane's source
 * reads `pe_history` (`claim-inlet-source.ts`); the Genesis lane's reads the reservation state
 * machine's outbox (`genesis-inlet-source.ts`), never `pe_history`, because
 * `core/pvt/genesis-award-state-machine.ts` owns which grant a wallet has already reserved and
 * deriving that from PE records alone is exactly the shape a double-pay takes. The kernel's
 * `genesisAnchorUsed` registry is the second net; it catches a double-pay only by reverting a
 * batch, which blocks the queue head, so the first net has to hold.
 *
 * What this module contributes is the same for both: eligibility, claim identity, and a
 * transactional idempotent write. Nothing lane-specific is decided here beyond which payload
 * shape the ledger row takes.
 *
 * SELECTION IS RESTARTABLE — THE CURSOR IS A SCAN POSITION, NEVER LEDGER STATE
 *
 * Correctness never depends on where a run starts: `registerClaim` is idempotent per PE, so
 * scanning a region twice is harmless and a PE that fails eligibility this run is simply
 * re-evaluated on a later pass — which is the correct behaviour when the thing that changed
 * is the PE's corroboration status or the relay's `mint_status`.
 *
 * What DOES depend on the start position is liveness (Finding B, C4). Every run used
 * to re-select from the top of the keyspace, so once the eligible pool outgrew one run's
 * scan budget (`maxPesPerRun`, ~10–20k under `maxRunMs`), the runs burned their whole budget
 * re-reading the same lexicographic prefix and everything past the horizon starved forever —
 * never registered, never settled, never leaving `eligible`. So a run may now START where
 * the previous one STOPPED: `config.startAfterKey` seeds the source cursor, and the report
 * carries `nextStartAfterKey` the stop position when the budget ran out, or null when the
 * source was exhausted (the next run starts from the top again). The persisted value is a
 * HINT, not authority: a lost or stale cursor only changes scan order, and the wrap-around
 * guarantees every key is scanned at least once every ceil(pool / budget) + 1 runs.
 */

import {
  evaluateEligibility,
  type EligibilityCandidate,
  type EligibilityRejection,
} from '../wp-ev/eligibility';
import { deriveLegClaimId, deriveTopupClaimId } from '../wp-ev/claim-id';
import type { PayoutLegRole } from '../wp-ev/payout-legs';
import { BeneficiaryClass } from '../wp-ev/settlement-batch';
import {
  registerClaim,
  type NewClaimInput,
  type SettlementDb,
} from './durable-settlement-store';
import { registerFrozenSplitClaims } from './frozen-split-registration';
import { BPS_DENOMINATOR } from '../wp-ev/payout-legs';
import { sameSplitPayout, validateProposedSplit, type LateLift, type ProposedPeSplit } from './pe-split';
// VALUE import of the single "ready to settle" mint_status literal. The reverse edge
// (`claim-inlet-source` -> `claim-inlet`) is TYPE-ONLY, so this does not create a runtime cycle.
import { RELAY_STATUS_READY } from './claim-inlet-source';

/**
 * the `pe_history.mint_status` values an attestation top-up may register against:
 * the act still settleable (`eligible`) or already settled (`minted`). Both are winners a
 * verified upgrade may add to; anything else (a demoted duplicate, a terminal refusal, a
 * hold) is not.
 */
export const TOPUP_PE_HISTORY_STATUSES: readonly string[] = Object.freeze([RELAY_STATUS_READY, 'minted']);

/**
 * One PE offered to the inlet, with its economics already resolved by the source.
 *
 * The source owns "which address does this PE pay, and under which beneficiary class",
 * because that is a relay-data question. The inlet owns "may it be claimed, and under what
 * identity".
 */
interface InletCandidateBase {
  readonly peId: string;
  /**
   * Which payout leg of the act this candidate is.
   *
   * An act with two payees is offered as TWO candidates sharing a `peId` and differing in
   * `leg` — because the kernel dedupes on `claimSettled[claimId]` per claim item, so two legs
   * settle independently under two derived ids. `sole` is the single-payee case and its claim
   * id is byte-identical to the unsplit derivation.
   */
  readonly leg: PayoutLegRole;
  /** Everything `evaluateEligibility` needs, built verbatim from the sealed record. */
  readonly eligibility: EligibilityCandidate;
  /** Lowercase EVM address the claim settles to. Empty when the source refused to resolve one. */
  readonly contributor: string;
  /**
   * Why the source could not name a payee, when it could not.
   *
   * Carried so a skip says WHICH question went unanswered. Without it every unresolvable payee
   * collapses into one indistinguishable `invalid_contributor`, and a systematic failure (an
   * entire class of PE that can never resolve) looks exactly like scattered bad data.
   */
  readonly contributorRefusal?: string;
}

export interface StandardInletCandidate extends InletCandidateBase {
  readonly lane: 'standard';
  /** Verbatim from the sealed economic snapshot. Never recomputed here. */
  readonly recordPointsAtomic: string;
  readonly beneficiaryClass: BeneficiaryClass;
  /**
   * an ADDITIVE ATTESTATION TOP-UP candidate. Absent = the act itself. Present: this
   * candidate is the delta owed on an act row that already registered/minted, and
   * `recordPointsAtomic` IS that delta (lifted leg points − the act row's frozen points),
   * settling to the act row's own contributor. Its claim id is domain-separated
   * (`deriveTopupClaimId`) and its ledger key carries the kind, so it can never collide
   * with, drift from, or re-settle the act. Registration requires the act row to exist.
   */
  readonly topup?: {
    readonly ofClaimKey: string;
    readonly attestationTier: string;
    readonly observedAtMs: number;
  };
  /**
   * the WHOLE split of the act this leg belongs to (act candidates only; never on a
   * top-up). Every act leg of one PE carries the same split; the inlet freezes the WHOLE split
   * in one transaction together with a row for every leg that passes every check now. A leg
   * that does not stays frozen without a row and registers on the run it passes, at its frozen
   * values — so no payee's own share waits on another payee's state.
   * `split.frozen` means the split was read from an existing `pvt9_pe_split_v1` doc and only
   * its missing legs are offered.
   *
   * Absent only on a single `sole` candidate from a source that predates the field (test
   * fakes); the inlet then freezes the one split that shape can mean — `sole` at 10,000 bps
   * for exactly its own points. A multi-leg act without a split is refused, never guessed.
   */
  readonly split?: ProposedPeSplit;
  /**
   * round 2 — set by the source on a FROZEN split's re-offered legs when the split was
   * frozen at the sealed base and the corroboration lift has since landed (`lateLiftFor`). Each
   * act leg registered late then gets its top-up row in the same transaction, so a leg that
   * registers after the top-up sweep window still receives its lift.
   */
  readonly lateLift?: LateLift;
}

/** The Genesis payload the kernel validates on-chain, projected from the reservation record. */
export interface GenesisClaimPayload {
  /** `genesisAnchorKey(grantType, oneTimeAnchor)` — the kernel's own uniqueness key. */
  readonly genesisAnchorKey: string;
  readonly walletId: string;
  readonly oneTimeAnchor: string;
  readonly grantType: number;
  /** Unix SECONDS. The kernel compares it against the Genesis window in chain time. */
  readonly qualifiedAt: number;
  readonly reservedGrossAtomic: string;
}

export interface GenesisInletCandidate extends InletCandidateBase {
  readonly lane: 'genesis';
  readonly genesis: GenesisClaimPayload;
}

export type InletCandidate = StandardInletCandidate | GenesisInletCandidate;

/**
 * One page from the source.
 *
 * THE THREE FIELDS ARE NOT REDUNDANT, AND CONFLATING THEM UNDER-PAYS EARNERS.
 *
 * A source filters: rows already in the claim ledger are dropped before they are ever offered,
 * so `candidates.length` is routinely SMALLER than the number of rows read. The first version
 * of this contract returned only the candidate array, and the inlet compared its length against
 * the requested page size to decide "the backlog is exhausted". In steady state — where almost
 * every row on page one is already claimed — that reads a full page as an empty one, stops after
 * page one, and reports `completed` while every PE past page one waits forever. That is
 * permanent under-payment with a green report, and it is the same defect as approached
 * from the other side of the same contract.
 *
 * So the source reports what it READ (`readCount`) and where it STOPPED (`lastKey`)
 * independently of what it OFFERED (`candidates`). Exhaustion is a fact about the read; the
 * cursor is a fact about the read; only the work is a fact about the offer.
 */
export interface InletPage {
  /** Rows that survived filtering, ready to be judged. May be empty on a full page. */
  readonly candidates: readonly InletCandidate[];
  /** Rows READ from the source before any filtering. Compared against the requested size. */
  readonly readCount: number;
  /**
   * The source's own sort key for the LAST row read — filtered or not. `undefined` only when
   * `readCount` is zero. A cursor derived from the last OFFERED row would rewind past every
   * filtered row after it and loop forever.
   */
  readonly lastKey?: string;
}

export interface InletPeSource {
  /**
   * One page of PEs, in the source's own sort order.
   *
   * The source is responsible for excluding PEs it has already offered — the natural
   * implementation is a `settled`-aware query plus a ledger existence check. Re-offering an
   * already-registered PE is HARMLESS (registration is idempotent per identity), so the
   * source may be conservative.
   *
   * `startAfterKey` is passed back VERBATIM as the source returned it in `lastKey`. The inlet
   * never normalizes it: the sort key belongs to the source's query, and case-folding a cursor
   * against a case-sensitive index silently skips every key that sorts between the two
   * spellings.
   */
  loadPage(options: {
    readonly pageSize: number;
    readonly startAfterKey?: string;
  }): Promise<InletPage>;
}

export interface ClaimInletConfig {
  /** PEs read per page. Bounds a single Firestore read. */
  readonly pageSize: number;
  /**
   * Hard ceiling on source rows SCANNED in one run — not on candidates offered.
   *
   * Bounding the offered count instead would make a large already-claimed backlog unbounded:
   * the source can read tens of thousands of rows and offer none, and a budget that only
   * counts offers would never stop. Scanning is what costs Firestore reads, so scanning is
   * what is bounded.
   */
  readonly maxPesPerRun: number;
  /** Hard wall-clock stop for one run. */
  readonly maxRunMs: number;
  /**
   * Where the PREVIOUS run stopped, fed back verbatim as the source cursor so this run scans
   * the region the budget cut off (Finding B, C4). Omit — or persist null — to start
   * from the top. A scan-position hint only: correctness is cursor-independent.
   */
  readonly startAfterKey?: string;
}

export interface ClaimInletDeps {
  readonly db: SettlementDb;
  readonly source: InletPeSource;
  readonly now: () => number;
  readonly log?: (message: string) => void;
}

export type InletSkipReason =
  | 'ineligible'
  | 'invalid_contributor'
  | 'invalid_record_points'
  /**
   * Zero record points. A zero-point row is not free: it is a claim the kernel would accept,
   * settle, and mint nothing for, permanently consuming its `claimSettled[claimId]` slot and a
   * cursor position — while occupying the head of the selection queue. Refusing it here keeps
   * a repricing that later gives the PE real points settleable.
   */
  | 'zero_record_points'
  | 'invalid_beneficiary_class'
  | 'pe_id_mismatch'
  | 'registration_rejected'
  /**
   * The PE's `pe_history.mint_status` was demoted out from under this run by a dual-witness
   * takeover between selection and registration — it stopped being settleable. DISTINCT
   * from `registration_rejected` on purpose: a demoted incumbent is the takeover working as
   * designed, not the claim-identity drift that `registration_rejected` signals, so it must not
   * read as a double-mint alarm.
   */
  | 'no_longer_settleable'
  /** Genesis-lane row offered without the Genesis payload the ledger requires. */
  | 'genesis_payload_missing'
  /**
   * the act legs offered for a PE do not describe one complete split (missing split
   * metadata on a multi-leg act, legs that disagree with the split, or a split that does not
   * sum to exactly 100%). The whole PE is skipped; nothing registers.
   */
  | 'split_inconsistent';

export interface InletSkip {
  readonly peId: string;
  readonly reason: InletSkipReason;
  /** Eligibility rejections, or the store's rejection code. */
  readonly detail: readonly string[];
}

export type InletStopReason = 'source_exhausted' | 'pe_limit' | 'run_time_limit';

export interface ClaimInletReport {
  readonly outcome: 'completed' | 'stopped';
  readonly stopReason: InletStopReason;
  /**
   * Source rows READ this run, before filtering. This is the number that says whether the run
   * looked at anything; `examined` can be zero on a healthy steady-state run where every row
   * on every page is already claimed, and reporting only that would make a run that read
   * 25,000 rows indistinguishable from one that read none.
   */
  readonly scanned: number;
  /** Candidates actually offered and judged. Zero is a distinct, reportable state. */
  readonly examined: number;
  readonly registered: number;
  readonly alreadyRegistered: number;
  readonly skipped: number;
  readonly skips: readonly InletSkip[];
  /**
   * Gross atomic points registered THIS run: `record_points_atomic` on the standard lane and
   * `reservedGrossAtomic` on Genesis, as a decimal string.
   */
  readonly pointsRegisteredAtomic: string;
  /**
   * Where the NEXT run should start: the last-read source key when this run stopped on a
   * budget, or null when the source was exhausted (start from the top). The caller persists
   * this; losing it costs scan order, never correctness.
   */
  readonly nextStartAfterKey: string | null;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const ATOMIC = /^\d{1,78}$/;

/**
 * A settleable point value: well-formed AND non-zero.
 *
 * `ATOMIC` alone admits `'0'`, and a zero-point claim is not harmless. The kernel reverts the
 * WHOLE batch on `recordPointsAtomic == 0` (`_validateStandardInputs` -> `InvalidClaim`), and
 * because selection takes the queue head, one such row blocks every batch behind it until
 * somebody notices. Refusing at the inlet keeps it out of the ledger entirely.
 */
function isSettleablePoints(value: unknown): value is string {
  return typeof value === 'string' && ATOMIC.test(value) && BigInt(value) > 0n;
}

/**
 * How many skips are carried back in the report. Skips are diagnostic, and a run that skips
 * 25,000 PEs must not build a 25,000-element array to say so — the counts stay exact either
 * way, and `skipped` is the number that matters.
 */
export const MAX_REPORTED_SKIPS = 200;

function isValidClass(value: unknown): value is BeneficiaryClass {
  return value === BeneficiaryClass.Unknown
    || value === BeneficiaryClass.HumanResolving
    || value === BeneficiaryClass.AutonomousAgent;
}

export type PreparedClaim =
  | { readonly ok: true; readonly input: NewClaimInput; readonly gross: string }
  | { readonly ok: false; readonly reason: InletSkipReason; readonly detail: readonly string[] };

/**
 * Every per-claim check, in the order the inlet has always applied them, returning the ledger
 * input or the skip. Pure. Shared by the per-claim path (Genesis, top-ups) and the per-act path,
 * so the two cannot drift apart. Nothing here reads recovery-escrow state: escrow is how a
 * linked human can restore an agent's key, and it never holds earnings.
 */
export async function prepareClaim(
  candidate: InletCandidate,
): Promise<PreparedClaim> {
  // The eligibility candidate carries its own copy of the PE identity, and the claim id
  // is derived from THAT. If it names a different PE than the row we are about to write,
  // the ledger row and its claim id would describe two different events.
  if (candidate.eligibility?.pe?.id !== candidate.peId) {
    return { ok: false, reason: 'pe_id_mismatch', detail: [String(candidate.eligibility?.pe?.id ?? '')] };
  }

  const verdict = evaluateEligibility(candidate.eligibility);
  if (verdict.kind !== 'eligible') {
    return { ok: false, reason: 'ineligible', detail: verdict.reasons as readonly EligibilityRejection[] };
  }

  // The LEG's claim id, not the PE's. `verdict.claimId` is the sole-leg derivation; for a
  // split act each leg needs its own id or the second leg would consume the first's
  // `claimSettled` slot and its payee would never be paid.
  // A top-up takes the domain-separated top-up id for its leg — distinct from
  // the act's by construction.
  const isTopup = candidate.lane === 'standard' && candidate.topup !== undefined;
  const legClaim = isTopup
    ? deriveTopupClaimId(candidate.eligibility.pe, candidate.leg)
    : deriveLegClaimId(candidate.eligibility.pe, candidate.leg);
  if (legClaim.kind !== 'derived') {
    return { ok: false, reason: 'ineligible', detail: [legClaim.reason] };
  }

  if (typeof candidate.contributor !== 'string' || !ADDRESS.test(candidate.contributor)) {
    return {
      ok: false,
      reason: 'invalid_contributor',
      detail: [candidate.contributorRefusal ?? String(candidate.contributor)],
    };
  }

  const gross = candidate.lane === 'genesis'
    ? candidate.genesis?.reservedGrossAtomic
    : candidate.recordPointsAtomic;
  if (!isSettleablePoints(gross)) {
    return {
      ok: false,
      reason: typeof gross === 'string' && ATOMIC.test(gross) ? 'zero_record_points' : 'invalid_record_points',
      detail: [String(gross)],
    };
  }

  if (candidate.lane === 'standard' && !isValidClass(candidate.beneficiaryClass)) {
    return { ok: false, reason: 'invalid_beneficiary_class', detail: [String(candidate.beneficiaryClass)] };
  }

  const input: NewClaimInput = candidate.lane === 'genesis'
    ? {
      pe_id: candidate.peId,
      leg: candidate.leg,
      claim_id: legClaim.claimId,
      lane: 'genesis',
      contributor: candidate.contributor,
      genesis_anchor_key: candidate.genesis.genesisAnchorKey,
      wallet_id: candidate.genesis.walletId,
      one_time_anchor: candidate.genesis.oneTimeAnchor,
      grant_type: candidate.genesis.grantType,
      qualified_at: candidate.genesis.qualifiedAt,
      reserved_gross_atomic: candidate.genesis.reservedGrossAtomic,
    }
    : {
      pe_id: candidate.peId,
      leg: candidate.leg,
      claim_id: legClaim.claimId,
      lane: 'standard',
      contributor: candidate.contributor,
      beneficiary_class: candidate.beneficiaryClass,
      record_points_atomic: candidate.recordPointsAtomic,
      ...(candidate.topup === undefined
        ? {}
        : {
          claim_kind: 'attestation_topup' as const,
          topup_of_claim_key: candidate.topup.ofClaimKey,
          topup_attestation_tier: candidate.topup.attestationTier,
          topup_observed_at_ms: candidate.topup.observedAtMs,
        }),
    };
  return { ok: true, input, gross: gross as string };
}

type InletUnit =
  | { readonly kind: 'single'; readonly candidate: InletCandidate }
  | { readonly kind: 'act'; readonly peId: string; readonly candidates: StandardInletCandidate[] };

function isActCandidate(candidate: InletCandidate): candidate is StandardInletCandidate {
  return candidate.lane === 'standard' && candidate.topup === undefined;
}

/**
 * group a page's standard ACT candidates by PE (first-appearance order), leaving
 * Genesis and top-up candidates as single units. A source is expected to offer a PE's legs
 * contiguously, but grouping by id rather than adjacency means a source that did not could
 * never split one act into two registrations.
 */
export function groupInletUnits(candidates: readonly InletCandidate[]): InletUnit[] {
  const units: InletUnit[] = [];
  const acts = new Map<string, StandardInletCandidate[]>();
  for (const candidate of candidates) {
    if (!isActCandidate(candidate)) {
      units.push({ kind: 'single', candidate });
      continue;
    }
    const existing = acts.get(candidate.peId);
    if (existing !== undefined) {
      existing.push(candidate);
      continue;
    }
    const group = [candidate];
    acts.set(candidate.peId, group);
    units.push({ kind: 'act', peId: candidate.peId, candidates: group });
  }
  return units;
}

/**
 * the ONE split an act unit's legs describe, or why they describe none.
 *
 * Every leg must carry the same split, every offered leg must be a leg of it with exactly its
 * address, class and points, and an unfrozen split must be offered WHOLE (a fresh resolution
 * registers every leg or none). A lone `sole` candidate without split metadata freezes the only
 * split that shape can mean. Anything else is refused, never guessed.
 */
export function splitOfActUnit(legs: readonly StandardInletCandidate[]): ProposedPeSplit | string {
  if (legs.length === 0) return 'no_legs';
  const offered = legs.map((leg) => leg.split);
  let split: ProposedPeSplit;
  if (offered.every((candidate) => candidate === undefined)) {
    if (legs.length !== 1 || legs[0].leg !== 'sole') return 'split_metadata_missing';
    split = {
      totalPointsAtomic: legs[0].recordPointsAtomic,
      basePointsAtomic: null,
      legs: [{
        leg: 'sole',
        contributor: legs[0].contributor,
        beneficiary_class: legs[0].beneficiaryClass,
        bps: BPS_DENOMINATOR,
        record_points_atomic: legs[0].recordPointsAtomic,
      }],
      origin: 'inlet_resolution',
      sourceFields: {},
      frozen: false,
    };
  } else {
    const first = offered[0];
    if (first === undefined || offered.some((candidate) => candidate === undefined)) {
      return 'split_metadata_partial';
    }
    if (offered.some((candidate) => candidate!.frozen !== first.frozen
      || !sameSplitPayout(candidate!, first))) {
      return 'split_disagreement';
    }
    split = first;
  }
  const invalid = validateProposedSplit(split);
  if (invalid !== null) return `split_${invalid}`;
  const seen = new Set<PayoutLegRole>();
  for (const leg of legs) {
    if (seen.has(leg.leg)) return 'duplicate_leg_offered';
    seen.add(leg.leg);
    const splitLeg = split.legs.find((candidate) => candidate.leg === leg.leg);
    if (splitLeg === undefined) return 'leg_outside_split';
    if (splitLeg.contributor !== leg.contributor
      || splitLeg.beneficiary_class !== leg.beneficiaryClass
      || splitLeg.record_points_atomic !== leg.recordPointsAtomic) {
      return 'leg_disagrees_with_split';
    }
  }
  if (!split.frozen && seen.size !== split.legs.length) return 'unfrozen_split_offered_partially';
  return split;
}

/**
 * Run the inlet: examine unclaimed PEs and register the ones that qualify.
 *
 * Fail-closed throughout. A PE that cannot be validated is SKIPPED, never registered on a
 * best guess, and never silently dropped — every skip carries a reason.
 */
export async function runClaimInlet(
  deps: ClaimInletDeps,
  config: ClaimInletConfig,
): Promise<ClaimInletReport> {
  if (!Number.isSafeInteger(config.pageSize) || config.pageSize <= 0) {
    throw new Error('runClaimInlet: pageSize must be a positive integer');
  }
  if (!Number.isSafeInteger(config.maxPesPerRun) || config.maxPesPerRun <= 0) {
    throw new Error('runClaimInlet: maxPesPerRun must be a positive integer');
  }

  const startedAt = deps.now();
  const skips: InletSkip[] = [];
  let scanned = 0;
  let examined = 0;
  let registered = 0;
  let alreadyRegistered = 0;
  let skipped = 0;
  let pointsRegistered = 0n;
  let startAfterKey: string | undefined = config.startAfterKey;
  let stopReason: InletStopReason = 'source_exhausted';

  const skip = (peId: string, reason: InletSkipReason, detail: readonly string[]): void => {
    skipped += 1;
    if (skips.length < MAX_REPORTED_SKIPS) skips.push({ peId, reason, detail });
  };

  for (;;) {
    if (scanned >= config.maxPesPerRun) { stopReason = 'pe_limit'; break; }
    if (deps.now() - startedAt >= config.maxRunMs) { stopReason = 'run_time_limit'; break; }

    const remaining = config.maxPesPerRun - scanned;
    // The REQUESTED size, which may be trimmed by the remaining run budget. The
    // short-page-means-exhausted test below must compare against this and not against
    // `config.pageSize`: a full page that was trimmed to fit the budget would otherwise be
    // misread as "backlog exhausted", and the run would report `completed` while earners
    // still had unclaimed work waiting.
    const requestedPageSize = Math.min(config.pageSize, remaining);
    const page = await deps.source.loadPage({ pageSize: requestedPageSize, startAfterKey });
    // A source that READ rows but reports no cursor cannot be paged: the next request would
    // repeat this page, and the run would burn its whole budget re-reading it while reporting
    // progress. Bounded rather than infinite — `scanned` still climbs — which is exactly what
    // makes it the quiet kind of wrong. Refuse loudly instead.
    if (page.readCount > 0 && page.lastKey === undefined) {
      throw new Error(
        `runClaimInlet: source read ${page.readCount} rows but returned no cursor; it cannot be paged`,
      );
    }
    scanned += page.readCount;
    // The cursor comes from the source's LAST READ row, not from the last row it offered.
    // Deriving it from the offered set rewinds past every filtered row behind it and the run
    // loops on the same page forever.
    if (page.lastKey !== undefined) startAfterKey = page.lastKey;

    // a standard ACT's legs are one unit: grouped by PE and frozen together as one
    // split in one transaction, with a ledger row for every leg that is registrable now.
    // Genesis and top-up candidates keep the per-claim path; a top-up's legs are each a
    // separate additive claim on an already-frozen act.
    for (const unit of groupInletUnits(page.candidates)) {
      if (unit.kind === 'single') {
        const candidate = unit.candidate;
        examined += 1;
        const prepared = await prepareClaim(candidate);
        if (!prepared.ok) {
          skip(candidate.peId, prepared.reason, prepared.detail);
          continue;
        }
        const isTopup = candidate.lane === 'standard' && candidate.topup !== undefined;
        // Standard candidates re-check `pe_history.mint_status` inside the registration
        // transaction, so a takeover that demotes the incumbent between selection and here
        // forces a retry that observes it. Genesis passes nothing — its source is the
        // reservation outbox, not pe_history, so there is no enrichment row to pin.
        const result = await registerClaim(
          deps.db,
          prepared.input,
          deps.now(),
          // A top-up pins the act as still-settleable OR already-minted — both are
          // winners it may add to — and the registration transaction additionally requires
          // the act's own ledger row to exist.
          candidate.lane === 'standard'
            ? { requirePeHistoryStatus: isTopup ? TOPUP_PE_HISTORY_STATUSES : RELAY_STATUS_READY }
            : undefined,
        );
        if (result.kind === 'created') {
          registered += 1;
          pointsRegistered += BigInt(prepared.gross);
        } else if (result.kind === 'already_registered_identical') {
          alreadyRegistered += 1;
        } else if (result.reason === 'pe_history_not_settleable') {
          // The incumbent was demoted by a dual-witness takeover between selection and here.
          // Not a drift alarm — the row simply stopped being settleable, so it skips under
          // its own reason and is re-evaluated on a later pass if it becomes settleable again.
          skip(candidate.peId, 'no_longer_settleable', [result.reason]);
        } else {
          // `claim_identity_drift` lands here: the PE is on record under a DIFFERENT claim id.
          // That is the double-mint vector, and refusing is the whole point.
          skip(candidate.peId, 'registration_rejected', [result.reason]);
        }
        continue;
      }

      // ── An act: the WHOLE split is frozen at once; the legs that can register now, do.
      const { peId, candidates: legs } = unit;
      examined += legs.length;
      const registrable: StandardInletCandidate[] = [];
      const withheld: Array<{ leg: PayoutLegRole; reason: InletSkipReason; detail: readonly string[] }> = [];
      for (const legCandidate of legs) {
        const prepared = await prepareClaim(legCandidate);
        if (prepared.ok) registrable.push(legCandidate);
        else withheld.push({ leg: legCandidate.leg, reason: prepared.reason, detail: prepared.detail });
      }
      // No leg registrable (an ineligible act fails every leg alike): nothing is frozen, the PE
      // is resolved afresh on a later run. Reported once, under its first reason.
      if (registrable.length === 0) {
        const first = withheld[0];
        skip(peId, first.reason, legs.length > 1 ? [...first.detail, `leg:${first.leg}`] : first.detail);
        continue;
      }
      const split = splitOfActUnit(legs);
      if (typeof split === 'string') {
        skip(peId, 'split_inconsistent', [split]);
        continue;
      }
      // The claim id of EVERY split leg — offered or already registered — derived from the
      // one sealed identity the eligibility verdict was reached on.
      const claimIds = new Map<PayoutLegRole, string>();
      let underivable: string | null = null;
      for (const leg of split.legs) {
        const derived = deriveLegClaimId(legs[0].eligibility.pe, leg.leg);
        if (derived.kind !== 'derived') { underivable = derived.reason; break; }
        claimIds.set(leg.leg, derived.claimId);
      }
      if (underivable !== null) {
        skip(peId, 'ineligible', [underivable]);
        continue;
      }
      const lateLift = legs.find((leg) => leg.lateLift !== undefined)?.lateLift;
      let lateLiftWithIds: (LateLift & { topupClaimIds: Map<PayoutLegRole, string> }) | undefined;
      if (lateLift !== undefined && split.frozen) {
        const topupClaimIds = new Map<PayoutLegRole, string>();
        for (const leg of split.legs) {
          const derived = deriveTopupClaimId(legs[0].eligibility.pe, leg.leg);
          if (derived.kind === 'derived') topupClaimIds.set(leg.leg, derived.claimId);
        }
        lateLiftWithIds = { ...lateLift, topupClaimIds };
      }
      const result = await registerFrozenSplitClaims(deps.db, {
        peId,
        split,
        claimIds,
        ...(lateLiftWithIds === undefined ? {} : { lateLift: lateLiftWithIds }),
        registerLegs: new Set(registrable.map((candidate) => candidate.leg)),
        nowMs: deps.now(),
        requirePeHistoryStatus: [RELAY_STATUS_READY],
      });
      if (result.kind === 'created' || result.kind === 'already_registered_identical') {
        // A withheld leg (one that failed a per-claim check this run) is FROZEN in the split
        // with no row; it is re-offered at its frozen payee/points/class and registers the run
        // it passes. Its skip is reported per leg; the other legs are not held for it.
        for (const held of withheld) skip(peId, held.reason, [...held.detail, `leg:${held.leg}`]);
      }
      if (result.kind === 'created') {
        registered += result.created + result.createdTopups;
        alreadyRegistered += Math.max(0, registrable.length - result.created);
        pointsRegistered += BigInt(result.createdPointsAtomic) + BigInt(result.createdTopupPointsAtomic);
      } else if (result.kind === 'already_registered_identical') {
        alreadyRegistered += registrable.length;
      } else if (result.reason === 'pe_history_not_settleable') {
        skip(peId, 'no_longer_settleable', [result.reason]);
      } else {
        skip(peId, 'registration_rejected', [result.reason]);
      }
    }
    // Exhaustion is a fact about the READ, never about the offer. A page filtered down to
    // nothing is still a full page of backlog behind it.
    if (page.readCount < requestedPageSize) { stopReason = 'source_exhausted'; break; }
  }

  deps.log?.(
    `claim-inlet: scanned=${scanned} examined=${examined} registered=${registered} `
    + `already=${alreadyRegistered} skipped=${skipped} stop=${stopReason}`,
  );

  return {
    outcome: stopReason === 'source_exhausted' ? 'completed' : 'stopped',
    stopReason,
    scanned,
    examined,
    registered,
    alreadyRegistered,
    skipped,
    skips,
    pointsRegisteredAtomic: pointsRegistered.toString(),
    // Exhausted ⇒ wrap to the top next run (so a region skipped by a stale or
    // mid-keyspace start is reached within one further sweep); budget-stopped
    // ⇒ resume at the stop position.
    nextStartAfterKey: stopReason === 'source_exhausted' ? null : (startAfterKey ?? null),
  };
}

// ---------------------------------------------------------------------------
// Durable scan-position hint (Finding B, C4)
// ---------------------------------------------------------------------------

export const CLAIM_INLET_STATE_COLLECTION = 'pvt9_claim_inlet_state_v1';

/**
 * Load the persisted scan position for a lane. FAIL-OPEN BY DESIGN: any read
 * problem or malformed doc returns undefined, which is exactly the pre-
 * behaviour (scan from the top). The cursor is a liveness hint; it must never
 * be able to stop the inlet.
 */
export type InletCursorLane = 'standard' | 'genesis' | 'attestation_topup';

export async function loadInletCursor(
  db: SettlementDb,
  lane: InletCursorLane,
): Promise<string | undefined> {
  try {
    const snap = await db.collection(CLAIM_INLET_STATE_COLLECTION).doc(lane).get();
    if (!snap.exists) return undefined;
    const key = (snap.data() as Record<string, unknown> | undefined)?.next_start_after_key;
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Persist where the next run should start (null ⇒ top). Best-effort. */
export async function saveInletCursor(
  db: SettlementDb,
  lane: InletCursorLane,
  nextStartAfterKey: string | null,
  nowMs: number,
): Promise<void> {
  try {
    await db.collection(CLAIM_INLET_STATE_COLLECTION).doc(lane).set({
      next_start_after_key: nextStartAfterKey,
      updated_at: nowMs,
    });
  } catch (error) {
    // Losing the cursor costs one wrap-around of scan order, never a claim.
    console.warn(`[ClaimInlet] cursor persist failed for ${lane} lane:`, error);
  }
}

import {createQueryPager} from '../../provenance/query-pages';


import { hashBeneficiaryRoutingSnapshot, type BeneficiaryRoutingSnapshot } from '../beneficiary-routing';
import { corroborationLiftedRecordPointsAtomic } from '../policy/economic-projection';
import type { PEHistoryDocument } from '../../../pe-history';
import { deriveLegClaimId, deriveTopupClaimId } from '../wp-ev/claim-id';
import {
  PAYOUT_LEG_ROLES,
  linkedAgentLegs,
  soleLeg,
  type PayoutLeg,
  type PayoutLegRole,
} from '../wp-ev/payout-legs';
import {
  BUG_DEMOTION_COLLECTION,
  CLAIM_LEDGER_COLLECTION,
  SETTLEMENT_BATCHES_COLLECTION,
  PE_HISTORY_COLLECTION,
  claimKeyOf,
  ledgerRowFromInput,
  normalizePeId,
  type NewClaimInput,
  type SettlementDb,
  type SettlementDocRef,
  type SettlementTxn,
} from './durable-settlement-store';
import { BeneficiaryClass } from '../wp-ev/settlement-batch';
import { prepareClaim, type StandardInletCandidate } from './claim-inlet';
import { registerFrozenSplitClaims } from './frozen-split-registration';
import {
  ENVELOPES_COLLECTION,
  NO_GENESIS_ANCHORS,
  buildEligibilityCandidate,
  resolvePayee,
  sealedIdentityOf,
  splitFromResolution,
} from './claim-inlet-source';
import {
  PE_SPLIT_COLLECTION,
  checkLegArithmetic,
  frozenSplitDocOf,
  lateLiftFor,
  parseFrozenSplit,
  proposalFromFrozen,
  validateProposedSplit,
  type FrozenSplitParse,
  type ProposedPeSplit,
} from './pe-split';

const ATOMIC = /^(0|[1-9][0-9]{0,77})$/;

// ---------------------------------------------------------------------------
// Inputs (what the scan reads) — plain data, so the classifier is pure
// ---------------------------------------------------------------------------

export interface AuditActRow {
  readonly leg: PayoutLegRole;
  readonly claimId: string;
  readonly contributor: string;
  readonly beneficiaryClass: number;
  readonly pointsAtomic: string;
  readonly settled: boolean;
  readonly settledTxHash: string | null;
  readonly settledBatchId: string | null;
  readonly reservedBatchId: string | null;
}

export interface AuditPeInput {
  readonly peId: string;
  readonly peKey: string;
  readonly actRows: readonly AuditActRow[];
  /** Rows of kind `attestation_topup`, excluded from every sum (additive claims). */
  readonly topupRowCount: number;
  /** `pe_history.record_points_atomic` — the sealed base. Null when absent/malformed. */
  readonly basePointsAtomic: string | null;
  /** `corroborationLiftedRecordPointsAtomic(pe_history)`. Null when absent/malformed. */
  readonly liftedPointsAtomic: string | null;
  readonly mintStatus: string | null;
  readonly historyExists: boolean;
  /** Agent share from the VERIFIED routing snapshot; null = a sole-shaped act. */
  readonly agentShareBps: number | null;
  /** A routing snapshot is present but does not verify (hash, binding, or shape). */
  readonly routingInvalid: boolean;
  readonly split: FrozenSplitParse | null;
  readonly bugDemoted: boolean;
}

// ---------------------------------------------------------------------------
// Candidates — the complete splits the inlet's arithmetic could have produced
// ---------------------------------------------------------------------------

export interface CandidateLeg {
  readonly leg: PayoutLegRole;
  readonly bps: number;
  readonly pointsAtomic: string;
}

export interface SplitCandidate {
  readonly totalPointsAtomic: string;
  readonly legs: readonly CandidateLeg[];
}

const PLACEHOLDER: Readonly<Record<PayoutLegRole, string>> = {
  sole: `0x${'1'.repeat(40)}`,
  agent: `0x${'2'.repeat(40)}`,
  beneficiary: `0x${'3'.repeat(40)}`,
};

function toCandidate(total: string, legs: readonly PayoutLeg[]): SplitCandidate {
  return {
    totalPointsAtomic: total,
    legs: legs.map((leg) => ({ leg: leg.role, bps: leg.bps, pointsAtomic: leg.pointsAtomic })),
  };
}


export function completeSplitCandidates(params: {
  readonly totals: readonly string[];
  readonly agentShareBps: number | null;
}): SplitCandidate[] {
  const out: SplitCandidate[] = [];
  const seenTotals = new Set<string>();
  for (const total of params.totals) {
    if (!ATOMIC.test(total) || BigInt(total) <= 0n || seenTotals.has(total)) continue;
    seenTotals.add(total);
    const base = params.agentShareBps === null
      ? soleLeg(PLACEHOLDER.sole, total)
      : linkedAgentLegs({
        agentAddress: PLACEHOLDER.agent,
        humanAddress: PLACEHOLDER.beneficiary,
        agentShareBps: params.agentShareBps,
        totalPointsAtomic: total,
      });
    if (base.kind !== 'legs') continue;
    out.push(toCandidate(total, base.legs));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type LegSumStatus =
  /** Pre-freeze rows that are exactly one complete split. Left alone. */
  | 'conforming'
  /** Frozen split, every act row a frozen leg and every frozen leg registered. */
  | 'frozen_conforming'
  /** Frozen split with legs still to register (the inlet registers them). */
  | 'frozen_incomplete'
  /** Frozen split with a row outside it or disagreeing with it. */
  | 'frozen_violation'
  | 'over'
  | 'under'
  /** No complete split explains the rows (e.g. legs cut from two different totals). */
  | 'unexplained'
  /** Several complete splits explain the rows and disagree on the fix. */
  | 'ambiguous'
  | 'no_history'
  | 'routing_invalid'
  | 'bug_demoted';

export interface LegSumFinding {
  readonly peId: string;
  readonly peKey: string;
  readonly status: LegSumStatus;
  readonly mintStatus: string | null;
  readonly basePointsAtomic: string | null;
  readonly liftedPointsAtomic: string | null;
  readonly actPointsSumAtomic: string;
  /** The total the rows were priced under, when one is identified. */
  readonly referenceTotalAtomic: string | null;
  /** `floor(actPointsSum × 10000 / referenceTotal)`; 10000 is exactly 100%. */
  readonly impliedBps: number | null;
  /** The complete split the rows were priced under (conforming/under/over). */
  readonly pricedUnder: SplitCandidate | null;
  readonly excessLegs: readonly PayoutLegRole[];
  readonly missingLegs: readonly CandidateLeg[];
  readonly settledLegs: readonly {
    readonly leg: PayoutLegRole;
    readonly pointsAtomic: string;
    readonly txHash: string | null;
    readonly batchId: string | null;
  }[];
  readonly reservedLegs: readonly PayoutLegRole[];
  readonly topupRowCount: number;
  readonly detail: string | null;
}

function sumPoints(rows: readonly { pointsAtomic: string }[]): bigint {
  return rows.reduce((sum, row) => sum + (ATOMIC.test(row.pointsAtomic) ? BigInt(row.pointsAtomic) : 0n), 0n);
}

function rowsEqualCandidate(rows: readonly AuditActRow[], candidate: SplitCandidate): boolean {
  if (rows.length !== candidate.legs.length) return false;
  return candidate.legs.every((leg) => rows.some((row) => row.leg === leg.leg && row.pointsAtomic === leg.pointsAtomic));
}

function rowsWithinCandidate(rows: readonly AuditActRow[], candidate: SplitCandidate): boolean {
  return rows.every((row) => candidate.legs.some((leg) => leg.leg === row.leg && leg.pointsAtomic === row.pointsAtomic));
}

function impliedBpsOf(sum: bigint, total: string | null): number | null {
  if (total === null || !ATOMIC.test(total) || BigInt(total) === 0n) return null;
  return Number((sum * 10_000n) / BigInt(total));
}

export function classifyPe(input: AuditPeInput): LegSumFinding {
  const sum = sumPoints(input.actRows);
  const settledLegs = input.actRows.filter((row) => row.settled).map((row) => ({
    leg: row.leg, pointsAtomic: row.pointsAtomic, txHash: row.settledTxHash, batchId: row.settledBatchId,
  }));
  const reservedLegs = input.actRows.filter((row) => !row.settled && row.reservedBatchId !== null)
    .map((row) => row.leg);
  const base = {
    peId: input.peId,
    peKey: input.peKey,
    mintStatus: input.mintStatus,
    basePointsAtomic: input.basePointsAtomic,
    liftedPointsAtomic: input.liftedPointsAtomic,
    actPointsSumAtomic: sum.toString(),
    settledLegs,
    reservedLegs,
    topupRowCount: input.topupRowCount,
  };
  const finding = (
    status: LegSumStatus,
    rest: Partial<Pick<LegSumFinding, 'referenceTotalAtomic' | 'pricedUnder' | 'excessLegs' | 'missingLegs' | 'detail'>> = {},
  ): LegSumFinding => {
    const reference = rest.referenceTotalAtomic ?? null;
    return {
      ...base,
      status,
      referenceTotalAtomic: reference,
      impliedBps: impliedBpsOf(sum, reference ?? input.liftedPointsAtomic ?? input.basePointsAtomic),
      pricedUnder: rest.pricedUnder ?? null,
      excessLegs: rest.excessLegs ?? [],
      missingLegs: rest.missingLegs ?? [],
      detail: rest.detail ?? null,
    };
  };

  if (input.bugDemoted) return finding('bug_demoted');

  // ── FROZEN: the split doc is the authority.
  if (input.split !== null) {
    if (input.split.kind !== 'valid') return finding('frozen_violation', { detail: `split_invalid:${input.split.reason}` });
    const split = input.split.split;
    const pricedUnder: SplitCandidate = {
      totalPointsAtomic: split.total_points_atomic,
      legs: split.legs.map((leg) => ({ leg: leg.leg, bps: leg.bps, pointsAtomic: leg.record_points_atomic })),
    };
    for (const row of input.actRows) {
      const leg = split.legs.find((candidate) => candidate.leg === row.leg);
      if (leg === undefined || leg.claim_id !== row.claimId || leg.contributor !== row.contributor
        || leg.record_points_atomic !== row.pointsAtomic || leg.beneficiary_class !== row.beneficiaryClass) {
        return finding('frozen_violation', {
          referenceTotalAtomic: split.total_points_atomic, pricedUnder, detail: `row_outside_or_disagreeing:${row.leg}`,
        });
      }
    }
    const missing = pricedUnder.legs.filter((leg) => !input.actRows.some((row) => row.leg === leg.leg));
    return finding(missing.length === 0 ? 'frozen_conforming' : 'frozen_incomplete', {
      referenceTotalAtomic: split.total_points_atomic, pricedUnder, missingLegs: missing,
    });
  }

  if (!input.historyExists) return finding('no_history');
  if (input.routingInvalid) return finding('routing_invalid');

  const totals = [input.liftedPointsAtomic, input.basePointsAtomic]
    .filter((total): total is string => total !== null);
  const candidates = completeSplitCandidates({ totals, agentShareBps: input.agentShareBps });

  // CONFORMING — exactly a complete split.
  const exact = candidates.find((candidate) => rowsEqualCandidate(input.actRows, candidate));
  if (exact !== undefined) {
    return finding('conforming', { referenceTotalAtomic: exact.totalPointsAtomic, pricedUnder: exact });
  }

  // UNDER — the rows are a strict subset of complete splits; every such split must agree on
  // what is missing, or the fix is not determined.
  const supersets = candidates.filter((candidate) => candidate.legs.length > input.actRows.length
    && rowsWithinCandidate(input.actRows, candidate));
  if (supersets.length > 0) {
    const missingOf = (candidate: SplitCandidate): CandidateLeg[] => candidate.legs
      .filter((leg) => !input.actRows.some((row) => row.leg === leg.leg));
    const first = supersets[0];
    const firstMissing = JSON.stringify(missingOf(first));
    const agree = supersets.every((candidate) => candidate.totalPointsAtomic === first.totalPointsAtomic
      && JSON.stringify(missingOf(candidate)) === firstMissing);
    if (!agree) {
      return finding('ambiguous', { detail: `under: ${supersets.length} complete splits explain the rows and disagree` });
    }
    return finding('under', {
      referenceTotalAtomic: first.totalPointsAtomic, pricedUnder: first, missingLegs: missingOf(first),
    });
  }

  // OVER — some rows form a complete split and the rest are excess. The kept set must be
  // unique, or which rows are "excess" is not determined.
  const keeps: Array<{ candidate: SplitCandidate; excess: PayoutLegRole[] }> = [];
  const n = input.actRows.length;
  for (let mask = 1; mask < (1 << n) - 1; mask += 1) {
    const kept = input.actRows.filter((_row, index) => (mask & (1 << index)) !== 0);
    const match = candidates.find((candidate) => rowsEqualCandidate(kept, candidate));
    if (match !== undefined) {
      keeps.push({
        candidate: match,
        excess: input.actRows.filter((_row, index) => (mask & (1 << index)) === 0).map((row) => row.leg),
      });
    }
  }
  if (keeps.length === 1) {
    return finding('over', {
      referenceTotalAtomic: keeps[0].candidate.totalPointsAtomic,
      pricedUnder: keeps[0].candidate,
      excessLegs: keeps[0].excess,
    });
  }
  if (keeps.length > 1) {
    return finding('ambiguous', { detail: `over: ${keeps.length} complete splits fit inside the rows` });
  }
  return finding('unexplained', {
    detail: `no complete split over totals [${totals.join(', ')}] matches legs [${input.actRows.map((r) => `${r.leg}=${r.pointsAtomic}`).join(', ')}]`,
  });
}

// ---------------------------------------------------------------------------
// Correction plan
// ---------------------------------------------------------------------------

export type CorrectionKind =
  | 'none'
  | 'reset_and_freeze'
  | 'delete_excess_and_freeze'
  | 'register_missing_and_freeze'
  /** A frozen split with legs still unregistered (withheld by a per-claim check, or not yet re-offered). */
  | 'register_frozen_missing'
  | 'report_only';

export interface CorrectionPlan {
  readonly kind: CorrectionKind;
  readonly reason: string;
}

const NEEDS_NOTHING: ReadonlySet<LegSumStatus> = new Set(['conforming', 'frozen_conforming']);

/**
 * The `pe_history.mint_status` values a leg may be ADDED under: the act still settling
 * (`eligible`) or already flipped (`minted` the short shape, whose missing leg the batch
 * approval gate admits by the kernel's per-claim `claimSettled`,). The same pair the
 * top-up lane pins (`TOPUP_PE_HISTORY_STATUSES`). Anything else (a demoted duplicate,
 * a terminal refusal) is never added to.
 */
export const LEG_ADD_PE_HISTORY_STATUSES: readonly string[] = Object.freeze(['eligible', 'minted']);

/**
 * What `--apply` may do for this finding. Pure. The order is the order of the ruling:
 * untouched-by-settlement PEs are re-frozen from a fresh resolution; an unsettled excess is
 * deleted; a shortfall beside a settled leg is completed at the settled legs' pricing; anything
 * over 100% that already settled is reported only.
 */
export function planCorrection(finding: LegSumFinding): CorrectionPlan {
  if (NEEDS_NOTHING.has(finding.status)) return { kind: 'none', reason: finding.status };
  if (finding.status === 'frozen_incomplete') {
    // The inlet re-offers these for an `eligible` PE; for a `minted` one (a short set this
    // audit froze, whose missing leg was held) nothing else ever will.
    return finding.mintStatus !== null && LEG_ADD_PE_HISTORY_STATUSES.includes(finding.mintStatus)
      ? { kind: 'register_frozen_missing', reason: 'frozen legs still unregistered' }
      : { kind: 'report_only', reason: 'frozen_incomplete_pe_not_settleable' };
  }
  if (finding.status === 'bug_demoted' || finding.status === 'no_history' || finding.status === 'frozen_violation'
    || finding.status === 'routing_invalid') {
    return { kind: 'report_only', reason: finding.status };
  }
  if (finding.topupRowCount > 0) return { kind: 'report_only', reason: 'topup_rows_present' };

  const anySettled = finding.settledLegs.length > 0;
  const anyReserved = finding.reservedLegs.length > 0;
  if (!anySettled && !anyReserved) {
    if (finding.mintStatus !== 'eligible') return { kind: 'report_only', reason: 'pe_not_eligible_for_reinlet' };
    return { kind: 'reset_and_freeze', reason: `${finding.status}: nothing settled or reserved` };
  }
  if (finding.status === 'over') {
    const excessSettledOrReserved = finding.excessLegs.some((leg) => finding.settledLegs.some((s) => s.leg === leg)
      || finding.reservedLegs.includes(leg));
    if (excessSettledOrReserved) return { kind: 'report_only', reason: 'over_excess_already_settled_or_reserved' };
    return { kind: 'delete_excess_and_freeze', reason: 'over: excess legs unsettled and unreserved' };
  }
  if (finding.status === 'under') {
    if (!anySettled) return { kind: 'report_only', reason: 'under_with_reserved_legs_in_flight' };
    return { kind: 'register_missing_and_freeze', reason: 'under: complete the set at the settled legs\' pricing' };
  }
  return { kind: 'report_only', reason: `${finding.status}_with_settled_or_reserved_legs` };
}

// ---------------------------------------------------------------------------
// I/O: scan
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The agent share from a VERIFIED routing snapshot (the same checks `resolveLinkedAgentLegs` makes). */
export function verifiedAgentShareBps(
  history: Record<string, unknown>,
  peId: string,
): { readonly agentShareBps: number | null; readonly invalid: boolean } {
  const routing = history.beneficiary_routing_snapshot;
  if (routing === null || routing === undefined) return { agentShareBps: null, invalid: false };
  if (typeof routing !== 'object' || Array.isArray(routing)) return { agentShareBps: null, invalid: true };
  const sealed = str(history.beneficiary_routing_snapshot_hash);
  try {
    if (sealed === null
      || hashBeneficiaryRoutingSnapshot(routing as unknown as BeneficiaryRoutingSnapshot) !== sealed) {
      return { agentShareBps: null, invalid: true };
    }
  } catch {
    return { agentShareBps: null, invalid: true };
  }
  const snapshot = routing as Record<string, unknown>;
  if (str(snapshot.pe_id) !== peId) return { agentShareBps: null, invalid: true };
  const share = snapshot.agent_share_bps;
  if (typeof share !== 'number' || !Number.isInteger(share)) return { agentShareBps: null, invalid: true };
  return { agentShareBps: share, invalid: false };
}

function actRowOf(row: Record<string, unknown>): AuditActRow | null {
  const leg = row.leg;
  if (typeof leg !== 'string' || !(PAYOUT_LEG_ROLES as readonly string[]).includes(leg)) return null;
  return {
    leg: leg as PayoutLegRole,
    claimId: String(row.claim_id ?? ''),
    contributor: String(row.contributor ?? ''),
    beneficiaryClass: typeof row.beneficiary_class === 'number' ? row.beneficiary_class : -1,
    pointsAtomic: String(row.record_points_atomic ?? ''),
    settled: row.settled === true,
    settledTxHash: str(row.settled_tx_hash),
    settledBatchId: str(row.settled_batch_id),
    reservedBatchId: str(row.reserved_batch_id),
  };
}

export interface LegSumScan {
  readonly scannedRows: number;
  readonly settledHistoricalPes: number;
  readonly unsupportedPes: readonly string[];
  readonly genesisPes: number;
  readonly malformedRows: number;
  readonly inputs: readonly AuditPeInput[];
}

/** Completed archived role sets are immutable history, never repair candidates. */
async function isTerminalHistoricalSet(db: SettlementDb, peId: string, rows: readonly Record<string, unknown>[]): Promise<boolean> {
  if (rows.length === 0) return false;
  for (const row of rows) {
    if (row.settled !== true || row.reserved_batch_id != null || typeof row.settled_batch_id !== 'string'
      || typeof row.settled_tx_hash !== 'string' || typeof row.claim_id !== 'string') return false;
    const snap = await db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(row.settled_batch_id).get();
    const batch = snap.data();
    if (!snap.exists || !batch || batch.status !== 'confirmed' || batch.applied !== true
      || batch.writebacks_complete !== true || batch.finality_verified !== true
      || batch.confirmed_tx_hash !== row.settled_tx_hash || !Array.isArray(batch.members)
      || !batch.members.some((member: unknown) => {
        if (!member || typeof member !== 'object') return false;
        const m = member as Record<string, unknown>;
        return m.pe_id === peId && m.leg === row.leg && m.claim_id === row.claim_id;
      })) return false;
  }
  return true;
}

/** Read the whole claim ledger (paged by `claim_key`) and assemble one input per standard PE. */
export async function scanLedger(db: SettlementDb, pageSize = 500): Promise<LegSumScan> {
  const byPe = new Map<string, { peId: string; rows: Record<string, unknown>[] }>();
  let scannedRows = 0;
  let cursor: string | undefined;
  const readScanPage1 = createQueryPager();
  for (;;) {
    let query = db.collection(CLAIM_LEDGER_COLLECTION).orderBy('claim_key', 'asc').limit(pageSize);
    if (cursor !== undefined) query = query.startAfter(cursor);
    const page = await readScanPage1(query);
    for (const doc of page.docs) {
      const row = doc.data() ?? {};
      scannedRows += 1;
      const peKey = str(row.pe_key) ?? normalizePeId(String(row.pe_id ?? doc.id.split('#')[0]));
      const entry = byPe.get(peKey) ?? { peId: str(row.pe_id) ?? peKey, rows: [] };
      entry.rows.push(row);
      byPe.set(peKey, entry);
      cursor = str(row.claim_key) ?? doc.id;
    }
    if (page.docs.length < pageSize) break;
  }

  let genesisPes = 0;
  let malformedRows = 0;
  let settledHistoricalPes = 0;
  const unsupportedPes: string[] = [];
  const inputs: AuditPeInput[] = [];
  for (const [peKey, { peId, rows }] of byPe) {
    if (rows.every((row) => row.lane === 'genesis')) { genesisPes += 1; continue; }
    if (rows.some(row => !(PAYOUT_LEG_ROLES as readonly unknown[]).includes(row.leg))) {
      if (await isTerminalHistoricalSet(db, peId, rows)) settledHistoricalPes += 1;
      else {malformedRows += rows.length; unsupportedPes.push(peId);}
      continue;
    }
    const actRows: AuditActRow[] = [];
    let topupRowCount = 0;
    for (const row of rows) {
      if (row.lane !== 'standard') continue;
      if (row.claim_kind === 'attestation_topup') { topupRowCount += 1; continue; }
      const parsed = actRowOf(row);
      if (parsed === null) { malformedRows += 1; continue; }
      actRows.push(parsed);
    }
    const historySnap = await db.collection(PE_HISTORY_COLLECTION).doc(peId).get();
    const history = historySnap.exists ? historySnap.data() ?? {} : {};
    const splitSnap = await db.collection(PE_SPLIT_COLLECTION).doc(peKey).get();
    const demotionSnap = await db.collection(BUG_DEMOTION_COLLECTION).doc(peKey).get();
    const base = str(history.record_points_atomic);
    const lifted = historySnap.exists
      ? corroborationLiftedRecordPointsAtomic(history as unknown as PEHistoryDocument)
      : null;
    const routing = verifiedAgentShareBps(history, peId);
    inputs.push({
      peId,
      peKey,
      actRows,
      topupRowCount,
      basePointsAtomic: base !== null && ATOMIC.test(base) ? base : null,
      liftedPointsAtomic: lifted !== null && ATOMIC.test(lifted) ? lifted : null,
      mintStatus: str(history.mint_status),
      historyExists: historySnap.exists,
      agentShareBps: routing.agentShareBps,
      routingInvalid: routing.invalid,
      split: splitSnap.exists ? parseFrozenSplit(splitSnap.data(), peKey) : null,
      bugDemoted: demotionSnap.exists,
    });
  }
  return { scannedRows, genesisPes, malformedRows, inputs, settledHistoricalPes, unsupportedPes };
}

// ---------------------------------------------------------------------------
// I/O: apply
// ---------------------------------------------------------------------------

/** A transaction that can also delete — admin Firestore's, and the test fake's. */
export interface AuditTxn extends SettlementTxn {
  delete(ref: SettlementDocRef): void;
}

export interface AuditDb extends Omit<SettlementDb, 'runTransaction'> {
  runTransaction<T>(fn: (txn: AuditTxn) => Promise<T>): Promise<T>;
}

export type ApplyOutcome =
  | {
    readonly kind: 'applied';
    readonly deletedLegs: readonly PayoutLegRole[];
    readonly createdLegs: readonly PayoutLegRole[];
    /**
     * Legs that are in the frozen split but were NOT registered, because the inlet's own
     * per-claim checks refused them now. They stay frozen; a later inlet run (eligible PE) or
     * `--apply` (minted PE) registers them once they pass, at their frozen values.
     */
    readonly withheldLegs: readonly { readonly leg: PayoutLegRole; readonly reason: string; readonly detail: readonly string[] }[];
    readonly split: ProposedPeSplit;
  }
  | { readonly kind: 'skipped'; readonly reason: string };

/**
 * Run each leg the audit would CREATE through the inlet's own per-claim checks
 * (`prepareClaim` eligibility on the sealed record, payee, points, class) — the audit never
 * registers a leg the inlet would have refused. Recovery escrow is not one of them: it never
 * holds earnings. The
 * eligibility candidate is the one the batch-approval gate re-judges (`buildEligibilityCandidate`);
 * a `minted` act is presented as `eligible` for THIS question only, exactly as the top-up lane
 * does, because adding a missing leg is not the act settling again (the kernel's per-claim
 * `claimSettled` and the approval gate's relaxation guard that).
 */
export async function judgeLegsToCreate(
  db: SettlementDb,
  peId: string,
  split: ProposedPeSplit,
  legs: readonly PayoutLegRole[],
): Promise<{ registrable: PayoutLegRole[]; withheld: Array<{ leg: PayoutLegRole; reason: string; detail: readonly string[] }> } | string> {
  const candidate = await buildEligibilityCandidate(db, peId, NO_GENESIS_ANCHORS);
  if (candidate === null) return 'eligibility_candidate_unavailable';
  const eligibility = candidate.relayMintStatus === 'minted'
    ? { ...candidate, relayMintStatus: 'eligible' }
    : candidate;
  const registrable: PayoutLegRole[] = [];
  const withheld: Array<{ leg: PayoutLegRole; reason: string; detail: readonly string[] }> = [];
  for (const legRole of legs) {
    const leg = split.legs.find((candidateLeg) => candidateLeg.leg === legRole);
    if (leg === undefined) return `leg_not_in_split:${legRole}`;
    const inletCandidate: StandardInletCandidate = {
      peId,
      leg: leg.leg,
      lane: 'standard',
      eligibility,
      contributor: leg.contributor,
      recordPointsAtomic: leg.record_points_atomic,
      beneficiaryClass: leg.beneficiary_class as BeneficiaryClass,
      split,
    };
    const prepared = await prepareClaim(inletCandidate);
    if (prepared.ok) registrable.push(legRole);
    else withheld.push({ leg: legRole, reason: prepared.reason, detail: prepared.detail });
  }
  return { registrable, withheld };
}

async function claimIdsFor(db: SettlementDb, peId: string): Promise<Map<PayoutLegRole, string> | string> {
  const envelopeSnap = await db.collection(ENVELOPES_COLLECTION).doc(peId).get();
  if (!envelopeSnap.exists) return 'envelope_missing';
  const identity = sealedIdentityOf(peId, envelopeSnap.data() ?? {});
  if (identity === null) return 'identity_underivable';
  const ids = new Map<PayoutLegRole, string>();
  for (const leg of PAYOUT_LEG_ROLES) {
    const derived = deriveLegClaimId(identity, leg);
    if (derived.kind !== 'derived') return `claim_id_underivable:${derived.reason}`;
    ids.set(leg, derived.claimId.toLowerCase());
  }
  return ids;
}

async function topupClaimIdsFor(db: SettlementDb, peId: string): Promise<Map<PayoutLegRole, string> | string> {
  const envelopeSnap = await db.collection(ENVELOPES_COLLECTION).doc(peId).get();
  if (!envelopeSnap.exists) return 'envelope_missing';
  const identity = sealedIdentityOf(peId, envelopeSnap.data() ?? {});
  if (identity === null) return 'identity_underivable';
  const ids = new Map<PayoutLegRole, string>();
  for (const leg of PAYOUT_LEG_ROLES) {
    const derived = deriveTopupClaimId(identity, leg);
    if (derived.kind !== 'derived') return `topup_claim_id_underivable:${derived.reason}`;
    ids.set(leg, derived.claimId.toLowerCase());
  }
  return ids;
}

function sameRow(current: Record<string, unknown>, planned: AuditActRow): boolean {
  const now = actRowOf(current);
  return now !== null && now.leg === planned.leg && now.claimId === planned.claimId
    && now.contributor === planned.contributor && now.pointsAtomic === planned.pointsAtomic
    && now.beneficiaryClass === planned.beneficiaryClass && now.settled === planned.settled
    && now.reservedBatchId === planned.reservedBatchId;
}

/**
 * Apply ONE PE's correction in ONE transaction. Re-reads the split doc, every act row and the
 * demotion marker; refuses `state_changed` if anything the plan was computed from moved, and
 * `split_exists` if a split was frozen meanwhile (so a re-run is a no-op).
 */
export async function applyCorrection(
  db: AuditDb,
  input: AuditPeInput,
  finding: LegSumFinding,
  plan: CorrectionPlan,
  nowMs: number,
): Promise<ApplyOutcome> {
  if (plan.kind === 'none' || plan.kind === 'report_only') return { kind: 'skipped', reason: plan.reason };
  const claimIds = await claimIdsFor(db as unknown as SettlementDb, input.peId);
  if (typeof claimIds === 'string') return { kind: 'skipped', reason: claimIds };

  if (plan.kind === 'register_frozen_missing') {
    // A frozen split's missing legs: judged by the inlet's checks, registered at their FROZEN
    // values through the same transaction the inlet uses.
    if (input.split === null || input.split.kind !== 'valid') return { kind: 'skipped', reason: 'split_not_valid' };
    const frozen = proposalFromFrozen(input.split.split);
    const missing = frozen.legs.map((leg) => leg.leg)
      .filter((leg) => !input.actRows.some((row) => row.leg === leg));
    const judged = await judgeLegsToCreate(db as unknown as SettlementDb, input.peId, frozen, missing);
    if (typeof judged === 'string') return { kind: 'skipped', reason: judged };
    // A held leg registering late is owed any lift that landed meanwhile (round 2).
    const historySnap = await db.collection(PE_HISTORY_COLLECTION).doc(input.peId).get();
    const lift = lateLiftFor(historySnap.data() ?? {}, frozen.totalPointsAtomic);
    const topupIds = await topupClaimIdsFor(db as unknown as SettlementDb, input.peId);
    if (judged.registrable.length === 0) {
      return { kind: 'skipped', reason: `all_missing_legs_withheld:${judged.withheld.map((w) => `${w.leg}=${w.reason}`).join(',')}` };
    }
    const result = await registerFrozenSplitClaims(db as unknown as SettlementDb, {
      peId: input.peId,
      split: frozen,
      claimIds,
      registerLegs: new Set(judged.registrable),
      nowMs,
      requirePeHistoryStatus: LEG_ADD_PE_HISTORY_STATUSES,
      ...(lift === null || typeof topupIds === 'string' ? {} : { lateLift: { ...lift, topupClaimIds: topupIds } }),
    });
    if (result.kind === 'rejected') return { kind: 'skipped', reason: result.reason };
    return {
      kind: 'applied', deletedLegs: [], createdLegs: result.kind === 'created' ? judged.registrable : [],
      withheldLegs: judged.withheld, split: frozen,
    };
  }

  // The split to freeze, and which rows to delete / create against it.
  let split: ProposedPeSplit;
  if (plan.kind === 'reset_and_freeze') {
    // A FRESH resolution — exactly what the inlet does for a PE with no rows.
    const historySnap = await db.collection(PE_HISTORY_COLLECTION).doc(input.peId).get();
    const history = historySnap.data() ?? {};
    const total = corroborationLiftedRecordPointsAtomic(history as unknown as PEHistoryDocument);
    const resolved = await resolvePayee(db as unknown as SettlementDb, history, total, input.peId);
    if (resolved.kind !== 'resolved') return { kind: 'skipped', reason: `resolution_refused:${resolved.reason}` };
    split = { ...splitFromResolution(history, total, resolved), origin: 'ledger_audit_correction' };
  } else {
    const pricedUnder = finding.pricedUnder;
    if (pricedUnder === null) return { kind: 'skipped', reason: 'no_priced_under_split' };
    const keptRows = input.actRows.filter((row) => !finding.excessLegs.includes(row.leg));
    let livePayees: Map<PayoutLegRole, { contributor: string; beneficiaryClass: number }> | null = null;
    if (plan.kind === 'register_missing_and_freeze') {
      // The missing legs' POINTS are the settled legs' pricing; their PAYEES are resolved now,
      // the same way the inlet resolves any payee.
      const historySnap = await db.collection(PE_HISTORY_COLLECTION).doc(input.peId).get();
      const resolved = await resolvePayee(
        db as unknown as SettlementDb, historySnap.data() ?? {}, pricedUnder.totalPointsAtomic, input.peId,
      );
      if (resolved.kind !== 'resolved') return { kind: 'skipped', reason: `resolution_refused:${resolved.reason}` };
      livePayees = new Map(resolved.legs.map((leg) => [leg.leg, {
        contributor: leg.contributor, beneficiaryClass: leg.beneficiaryClass,
      }]));
    }
    const legs: ProposedPeSplit['legs'][number][] = [];
    for (const leg of pricedUnder.legs) {
      const row = keptRows.find((candidate) => candidate.leg === leg.leg);
      const payee = row !== undefined
        ? { contributor: row.contributor, beneficiaryClass: row.beneficiaryClass }
        : livePayees?.get(leg.leg);
      if (payee === undefined) return { kind: 'skipped', reason: `missing_leg_payee_unresolvable:${leg.leg}` };
      legs.push({
        leg: leg.leg,
        contributor: payee.contributor,
        beneficiary_class: payee.beneficiaryClass,
        bps: leg.bps,
        record_points_atomic: leg.pointsAtomic,
      });
    }
    split = {
      totalPointsAtomic: pricedUnder.totalPointsAtomic,
      basePointsAtomic: input.basePointsAtomic,
      legs,
      origin: 'ledger_audit_correction',
      sourceFields: {
        audit_status: finding.status,
      },
      frozen: false,
    };
  }
  const invalid = validateProposedSplit(split);
  if (invalid !== null) return { kind: 'skipped', reason: `split_${invalid}` };
  if (checkLegArithmetic(split.legs, split.totalPointsAtomic) !== null) {
    return { kind: 'skipped', reason: 'split_arithmetic' };
  }

  const matchesSplit = (row: AuditActRow): boolean => split.legs.some((leg) => leg.leg === row.leg
    && leg.contributor === row.contributor && leg.record_points_atomic === row.pointsAtomic
    && leg.beneficiary_class === row.beneficiaryClass && claimIds.get(leg.leg) === row.claimId);
  const toDelete = plan.kind === 'delete_excess_and_freeze'
    ? input.actRows.filter((row) => finding.excessLegs.includes(row.leg))
    : plan.kind === 'reset_and_freeze'
      ? input.actRows.filter((row) => !matchesSplit(row))
      : [];
  // Every row that stays must BE its frozen leg, or the frozen split would describe a set the
  // ledger does not hold.
  const kept = input.actRows.filter((row) => !toDelete.includes(row));
  if (!kept.every(matchesSplit)) return { kind: 'skipped', reason: 'kept_row_disagrees_with_split' };
  if (toDelete.some((row) => row.settled || row.reservedBatchId !== null)) {
    return { kind: 'skipped', reason: 'refusing_to_delete_settled_or_reserved_row' };
  }
  // review: a leg the audit creates passes the inlet's OWN checks first (eligibility,
  // payee, points, class). A withheld leg stays in the frozen split, unregistered.
  let withheld: Array<{ leg: PayoutLegRole; reason: string; detail: readonly string[] }> = [];
  let registrable = new Set<PayoutLegRole>();
  if (plan.kind === 'register_missing_and_freeze') {
    const missing = split.legs.map((leg) => leg.leg).filter((leg) => !kept.some((row) => row.leg === leg));
    const judged = await judgeLegsToCreate(db as unknown as SettlementDb, input.peId, split, missing);
    if (typeof judged === 'string') return { kind: 'skipped', reason: judged };
    withheld = judged.withheld;
    registrable = new Set(judged.registrable);
  }
  const toCreate: NewClaimInput[] = plan.kind === 'register_missing_and_freeze'
    ? split.legs.filter((leg) => !kept.some((row) => row.leg === leg.leg) && registrable.has(leg.leg)).map((leg) => ({
      pe_id: input.peId,
      leg: leg.leg,
      claim_id: claimIds.get(leg.leg)!,
      lane: 'standard' as const,
      contributor: leg.contributor,
      beneficiary_class: leg.beneficiary_class,
      record_points_atomic: leg.record_points_atomic,
    }))
    : [];

  const ledger = db.collection(CLAIM_LEDGER_COLLECTION);
  const splitRef = db.collection(PE_SPLIT_COLLECTION).doc(input.peKey);
  const demotionRef = db.collection(BUG_DEMOTION_COLLECTION).doc(input.peKey);
  const peHistoryRef = db.collection(PE_HISTORY_COLLECTION).doc(input.peId);
  // Pinned like the inlet pins it: a re-freeze only for a PE the inlet will select again; an
  // added leg only beside an act that is still settling or already settled.
  const pinnedStatuses: readonly string[] | null = plan.kind === 'reset_and_freeze'
    ? ['eligible']
    : plan.kind === 'register_missing_and_freeze' ? LEG_ADD_PE_HISTORY_STATUSES : null;
  return db.runTransaction<ApplyOutcome>(async (txn) => {
    const splitSnap = await txn.get(splitRef);
    const demotion = await txn.get(demotionRef);
    const peSnap = await txn.get(peHistoryRef);
    const current = new Map<PayoutLegRole, Record<string, unknown> | null>();
    for (const leg of PAYOUT_LEG_ROLES) {
      const snap = await txn.get(ledger.doc(claimKeyOf(input.peId, leg)));
      current.set(leg, snap.exists ? snap.data() ?? {} : null);
    }
    if (splitSnap.exists) return { kind: 'skipped', reason: 'split_exists' };
    if (demotion.exists) return { kind: 'skipped', reason: 'pe_bug_demoted' };
    const status = peSnap.exists ? (peSnap.data() ?? {}).mint_status : undefined;
    if (pinnedStatuses !== null && (typeof status !== 'string' || !pinnedStatuses.includes(status))) {
      return { kind: 'skipped', reason: 'pe_history_not_settleable' };
    }
    for (const leg of PAYOUT_LEG_ROLES) {
      const planned = input.actRows.find((row) => row.leg === leg);
      const now = current.get(leg) ?? null;
      if (planned === undefined ? now !== null : now === null || !sameRow(now, planned)) {
        return { kind: 'skipped', reason: 'state_changed' };
      }
    }
    for (const row of toDelete) txn.delete(ledger.doc(claimKeyOf(input.peId, row.leg)));
    for (const created of toCreate) {
      txn.create(ledger.doc(claimKeyOf(created.pe_id, created.leg)),
        ledgerRowFromInput(created, nowMs) as unknown as Record<string, unknown>);
    }
    txn.create(splitRef, frozenSplitDocOf({
      peId: input.peId, peKey: input.peKey, split, claimIds, nowMs,
    }) as unknown as Record<string, unknown>);
    return {
      kind: 'applied',
      deletedLegs: toDelete.map((row) => row.leg),
      createdLegs: toCreate.map((row) => row.leg),
      withheldLegs: withheld,
      split,
    };
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface LegSumReport {
  readonly mode: 'dry_run' | 'apply';
  readonly generated_at_ms: number;
  readonly scanned_rows: number;
  readonly standard_pes: number;
  readonly genesis_pes_skipped: number;
  readonly settled_historical_pes_skipped: number;
  readonly unsupported_pes: readonly string[];
  readonly malformed_rows: number;
  readonly counts: Readonly<Record<string, number>>;
  /** Every PE not summing to exactly 100% on which a leg already SETTLED — cannot be un-minted. */
  readonly settled_mismatches: readonly LegSumFinding[];
  readonly findings: readonly (LegSumFinding & { readonly plan: CorrectionPlan; readonly applied?: ApplyOutcome })[];
}

const MISMATCH: ReadonlySet<LegSumStatus> = new Set(['over', 'under', 'unexplained', 'ambiguous', 'frozen_violation']);

export async function runLegSumAudit(
  db: AuditDb,
  options: {
    readonly apply: boolean;
    readonly nowMs: number;
    readonly pageSize?: number;
  },
): Promise<LegSumReport> {
  const scan = await scanLedger(db as unknown as SettlementDb, options.pageSize);
  const counts: Record<string, number> = {};
  const findings: Array<LegSumFinding & { plan: CorrectionPlan; applied?: ApplyOutcome }> = [];
  const settledMismatches: LegSumFinding[] = [];
  for (const input of scan.inputs) {
    const finding = classifyPe(input);
    counts[finding.status] = (counts[finding.status] ?? 0) + 1;
    const plan = planCorrection(finding);
    if (MISMATCH.has(finding.status) && finding.settledLegs.length > 0) settledMismatches.push(finding);
    if (plan.kind === 'none') continue;
    const entry: LegSumFinding & { plan: CorrectionPlan; applied?: ApplyOutcome } = { ...finding, plan };
    if (options.apply) entry.applied = await applyCorrection(db, input, finding, plan, options.nowMs);
    findings.push(entry);
  }
  return {
    mode: options.apply ? 'apply' : 'dry_run',
    generated_at_ms: options.nowMs,
    scanned_rows: scan.scannedRows,
    standard_pes: scan.inputs.length,
    genesis_pes_skipped: scan.genesisPes,
    settled_historical_pes_skipped: scan.settledHistoricalPes,
    unsupported_pes: scan.unsupportedPes,
    malformed_rows: scan.malformedRows,
    counts,
    settled_mismatches: settledMismatches,
    findings,
  };
}

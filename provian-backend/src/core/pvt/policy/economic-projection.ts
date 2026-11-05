import { accrualEndMs, accrualEndedAt } from '../accrual-end-line';
import { singleScanQuery } from '../../provenance/private-store';
import { ordinaryHardwareAttestationTier } from './evidence-class';
/**
 * Economic accrual projection — the per-row pricing functions behind the
 * Abundance dashboard and the allocation routes, plus the PURE reference fold
 * over a given set of rows (`foldEconomicAccrualRows`).
 *
 * PE METER : the relay keeps no per-PE history, so the
 * Firestore full fold over `pe_history` (and the dashboard's fall-back to it) is
 * gone. The dashboard read is `readEconomicAccrualProjection` in
 * `economic-aggregate-read.ts` stored running totals (maintained in the SAME
 * transaction as each act's commit) plus a live tail folded from the actor's
 * 31-day act keys. The pure fold is what that read must EQUAL — the parity
 * control in `economic-aggregate-read.meter.test.ts` asserts it field by field.
 *
 * ROUNDING, STATED ONCE. The mint rate is applied to the SUM of rate-free
 * settlement inputs (per category and in total), not per PE. Per-PE application
 * loses up to one atomic unit (1e-18 PVT) per row to flooring; applying it to
 * the sum is what lets a stored sum-of-inputs and a live fold agree exactly.
 * Both paths call `applyGlobalMintRate` on their sums, so they cannot disagree
 * by construction. A total is floor(total_input × rate); a category is
 * floor(category_input × rate); the categories therefore need not sum to the
 * total by more than one atomic unit per category. Non-final display value.
 */

import { FieldPath } from 'firebase-admin/firestore';
import type { Firestore, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { PEHistoryDocument } from '../../../pe-history';
import { getWeekStart } from '../week-start';
import { PVT9_ELIGIBILITY_CUT_LINE_MS } from '../wp-ev/eligibility';
import {
  computeSettlement,
  disclosedRationalFactor,
  hashRecordEconomicSnapshot,
  type DisclosedRationalFactor,
  type RecordEconomicSnapshot,
} from './monetary-accounting';

const ATOMIC_SCALE = 10n ** 18n;
const BPS = 10_000n;
const WALLETS_COLLECTION = 'wallets';
// Firestore caps `in` filters at 30 values; a human never owns this many wallets.
const MAX_CONTRIBUTOR_IDENTITIES = 30;

/**
 * The set of `pe_history.userId` values that all belong to ONE human account.
 *
 * The dashboard authenticates as the users-collection id (`user_...`), but some
 * server-authored PEs are keyed by the contributor's WALLET DOCUMENT id
 * (`wallet_...`) instead — notably GitHub-witness `service:github_commit` rows,
 * because the witness/connect id space is the wallets-collection doc id (see
 * routes/middleware/wallet-owner-auth.ts and the owner-capture writer).
 * Those PEs settle correctly — the sealed `economic_snapshot.economicActorId`
 * is the wallet doc id, resolved to the wallet address at payee time — but keyed
 * by `wallet_...` they are invisible to a dashboard that only queries
 * `userId == user_...`, so the human never sees their own commit PEs.
 *
 * Unioning the human's OWN wallet doc ids surfaces those rows WITHOUT touching a
 * single sealed record: `pe_history` is a derived read-model, and neither the
 * sealed PE nor its `economic_snapshot` is mutated or re-hashed. Scope is
 * strictly the caller's own wallets (`wallets.user_id == userId`), so it can
 * never pull another account's PEs (verified by the negative control in
 * economic-projection.test.ts).
 */
export async function resolveContributorIdentities(
  db: Firestore,
  userId: string,
): Promise<string[]> {
  const identities = new Set<string>([userId]);
  const owned = await db.collection(WALLETS_COLLECTION).where('user_id', '==', userId).get();
  for (const doc of owned.docs) {
    if (identities.size >= MAX_CONTRIBUTOR_IDENTITIES) break;
    identities.add(doc.id);
  }
  return [...identities];
}

export interface CurrentSettlementProjectionContext {
  readonly projectedAtMs: number;
  readonly globalMintRate: DisclosedRationalFactor;
}

export interface SettlementProjectionDescriptor {
  readonly label: 'current_settlement_projection_non_final';
  readonly isFinal: false;
  readonly projectedAtMs: number;
  readonly factorVintage: {
    readonly globalMintRate: DisclosedRationalFactor;
  };
}

export interface EconomicAccrualProjection {
  readonly totalRecordPointsAtomic: string;
  readonly recordPointsByCategoryAtomic: Readonly<Record<string, string>>;
  readonly totalCurrentSettlementProjectionAtomic: string | null;
  readonly currentSettlementProjectionByCategoryAtomic: Readonly<Record<string, string>> | null;
  readonly currentSettlementProjection: SettlementProjectionDescriptor | null;
  readonly currentSettlementProjectionUnavailableReason: 'factors_not_supplied' | null;
  readonly exactGenesisReservedGrossAtomic: string;
  readonly exactGenesisReservedGrossByCategoryAtomic: Readonly<Record<string, string>>;
  readonly totalPEs: number;
  readonly weeklyPEs: number;
  readonly pesByCategory: Readonly<Record<string, number>>;
  readonly integrityFailures: number;
  readonly projectionFailures: number;
}

export function formatPvtAtomic(atomic: string, fractionDigits = 1): string {
  const value = BigInt(atomic);
  const whole = value / ATOMIC_SCALE;
  if (fractionDigits <= 0) return whole.toString(10);
  const fraction = (value % ATOMIC_SCALE)
    .toString(10)
    .padStart(18, '0')
    .slice(0, Math.min(18, fractionDigits));
  return `${whole.toString(10)}.${fraction}`;
}

export function atomicToSafeDisplayNumber(atomic: string): number {
  return Number(formatPvtAtomic(atomic, 8));
}

/**
 * The sealed record-time economic snapshot, integrity-verified, or null.
 *
 * `pe_history` is the MUTABLE enrichment record, so the snapshot is trusted only when it
 * re-hashes to the `economic_snapshot_hash` sealed beside it AND is bound to this very PE
 * (peId / actionType / recordedAtMs). Exported as THE one verified-read of the seal — the
 * settlement projection (`wp4/claim-inlet-source.ts`) reads the record-time evidence verdict
 * through this same function, so a tampered or transplanted snapshot is no snapshot anywhere.
 */
/**
 * Why a row's sealed snapshot could not be trusted. `absent` is the ONE benign
 * case (a legacy pre-cut-line PE that never sealed a snapshot — PVT9 launched at
 * zero supply with no historical migration); `hash_mismatch`/`identity_mismatch`
 * are genuine integrity breaches. The distinction drives log SEVERITY only, never
 * accounting: an unpriceable row is an integrity failure in exactly one bucket
 * regardless of reason (see `foldRowIntoTotals`).
 */
export type SnapshotRejectionReason = 'absent' | 'hash_mismatch' | 'identity_mismatch';

export type SnapshotVerdict =
  | { readonly ok: true; readonly snapshot: RecordEconomicSnapshot }
  | { readonly ok: false; readonly reason: SnapshotRejectionReason };

/**
 * Classify a row's sealed snapshot, returning WHY it is untrusted so the caller
 * can decide log severity. `verifiedSnapshot` is the thin `... | null` wrapper
 * over this; the five other callers keep their existing contract.
 */
export function classifySnapshot(pe: PEHistoryDocument): SnapshotVerdict {
  const snapshot = pe.economic_snapshot;
  if (snapshot === null || snapshot === undefined) return { ok: false, reason: 'absent' };
  if (!pe.economic_snapshot_hash
    || hashRecordEconomicSnapshot(snapshot) !== pe.economic_snapshot_hash) {
    return { ok: false, reason: 'hash_mismatch' };
  }
  if (snapshot.peId !== pe.peId
    || snapshot.actionType !== pe.actionType
    || snapshot.recordedAtMs !== pe.timestamp) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  return { ok: true, snapshot };
}

export function verifiedSnapshot(pe: PEHistoryDocument): RecordEconomicSnapshot | null {
  const verdict = classifySnapshot(pe);
  return verdict.ok ? verdict.snapshot : null;
}

function splitForRole(
  pe: PEHistoryDocument,
  amount: bigint,
  role: 'contributor' | 'beneficiary',
): bigint {
  const snapshot = pe.economic_snapshot!;
  const agentBps = BigInt(snapshot.recordTimeFactors.beneficiaryAgentShareBps ?? 10_000);
  if (role === 'contributor') {
    return pe.beneficiary_wallet_id ? (amount * agentBps) / BPS : amount;
  }
  if (!pe.beneficiary_wallet_id) return 0n;
  return amount - ((amount * agentBps) / BPS);
}

/**
 * the value a novelty-corrected pending-cache recovery actually
 * settles, when it is LOWER than what the sealed snapshot computed at its
 * ordinal-1 full-novelty placeholder. The sealed snapshot is untouched by the
 * recovery, so every snapshot-derived surface must substitute the row's own
 * corrected points or it overstates the row by up to the novelty spread.
 * Returns null when no correction applies (then the snapshot is the truth).
 * Display-trust rule: a corrected value is honored only downward — a row
 * claiming MORE than its sealed snapshot is ignored, never projected.
 */
function correctedRecoveryPointsAtomic(
  pe: PEHistoryDocument,
  snapshot: RecordEconomicSnapshot,
): bigint | null {
  if (pe.pending_cache_outcome !== 'eligible_novelty_corrected') return null;
  const rowPoints = pe.record_points_atomic;
  if (typeof rowPoints !== 'string' || !/^(0|[1-9][0-9]*)$/.test(rowPoints)) return null;
  const corrected = BigInt(rowPoints);
  const sealed = BigInt(snapshot.recordPointsAtomic);
  return corrected < sealed ? corrected : null;
}

export function recordPointsForRoleAtomic(
  pe: PEHistoryDocument,
  role: 'contributor' | 'beneficiary',
): bigint | null {
  const snapshot = verifiedSnapshot(pe);
  if (snapshot === null) return null;
  const corrected = correctedRecoveryPointsAtomic(pe, snapshot);
  return splitForRole(pe, corrected ?? BigInt(snapshot.recordPointsAtomic), role);
}

/** @deprecated The old name represented record points, not estimated PVT. */
export const projectedPEAtomic = recordPointsForRoleAtomic;

/**
 * The attestation tier a row's CURRENT evidence supports, never below the sealed record
 * tier. Exported so the attestation top-up lane records WHICH tier its delta was
 * computed against — it is read, never re-derived, from the same function the inline lift
 * and the dashboard projection use.
 */
export function currentAttestationTier(pe: PEHistoryDocument): string | null {
  const snapshot = verifiedSnapshot(pe);
  return snapshot === null ? null : currentAttestation(pe, snapshot);
}

function currentAttestation(pe: PEHistoryDocument, snapshot: RecordEconomicSnapshot): string {
  const rawCandidate = (() => {
    if (pe.attestationDepth === 'hardware') return 'hardware_full';
    if (pe.corroboration_status === 'on_chain_verified'
      || pe.corroboration_status === 'merchant_confirmed'
      || pe.corroboration_status === 'peer_verified'
      || pe.corroboration_status === 'service_grant_attested') {
      return 'corroborated';
    }
    if (pe.replication_pack?.input_hash
      && pe.replication_pack?.output_hash
      && pe.replication_pack?.model_id) {
      return 'software_verified';
    }
    return pe.attestationDepth || snapshot.recordTimeFactors.attestationTier;
  })();
  const candidate = snapshot.schemaVersion === 'pvt-monetary-accounting/v3' && snapshot.recordTimeFactors.witnessClass !== 'hardware_rooted' ? ordinaryHardwareAttestationTier(rawCandidate) : rawCandidate;
  // `computeSettlement` refuses attestation DOWNGRADES, so never request one:
  // when the candidate's multiplier in the SEALED table sits below the
  // record-time tier's (e.g. a hardware_full record that also carries a
  // replication pack, or any evidence-priced row whose sealed table prices the
  // candidate tier below the record tier — under that included
  // software_verified at 0), project at the record tier instead.
  const table = snapshot.recordTimeFactors.attestationMultipliersAtRecordPolicyBps;
  const recordTier = snapshot.recordTimeFactors.attestationTier;
  const candidateBps = table[candidate];
  const recordBps = table[recordTier];
  if (candidateBps === undefined
    || (recordBps !== undefined && candidateBps < recordBps)) {
    return recordTier;
  }
  return candidate;
}

/**
 * the corroboration-lifted settleable TOTAL record points for the LIVE
 * PVT9 settlement lane.
 *
 * The lane settles `record_points_atomic` verbatim, so the corroboration lift
 * (software 0.8× → corroborated 1.0×, e.g. a forge witness 2.4× → 3.0×) has to be
 * applied to that value at claim-registration time — the ONE place the settleable
 * amount is read. It is computed by the SAME `computeSettlement` math the estimate
 * uses (`currentAttestation` maps a recognized `corroboration_status` to the
 * `corroborated` tier; the carve-out in `computeSettlement` authorizes the
 * external-proof-priced upgrade), so the record path and the settlement path can
 * never disagree about the lift.
 *
 * The lift is applied as the attestation RATIO to `record_points_atomic` the
 * verbatim settleable base, which already carries any novelty correction — NOT to
 * the snapshot's own points, so a pending-cache-corrected row is lifted from its
 * corrected value, never re-inflated. Returns the base UNCHANGED (verbatim, as the
 * lane always did) unless a recognized corroboration lifts the tier within the 72h
 * window; fail-closed to the verbatim base on any snapshot/settlement problem.
 */
export function corroborationLiftedRecordPointsAtomic(pe: PEHistoryDocument): string {
  const rawBase = pe.record_points_atomic;
  const base = typeof rawBase === 'string' && /^(0|[1-9][0-9]*)$/.test(rawBase) ? rawBase : null;
  // Preserve the lane's prior `str(record_points_atomic) ?? ''` fallback shape so a
  // malformed/absent base skips with the SAME reason it always did.
  if (base === null) return typeof rawBase === 'string' ? rawBase : '';
  const snapshot = verifiedSnapshot(pe);
  if (snapshot === null || pe.mint_disposition !== 'eligible') return base;
  const verifiedTier = currentAttestation(pe, snapshot);
  // No tier change → no lift; the common (uncorroborated) path returns verbatim.
  if (verifiedTier === snapshot.recordTimeFactors.attestationTier) return base;
  // Shutdown coverage (2026-10-20): a corroboration observed at or after the accrual end line
  // lifts nothing, so no new top-up accrues past it. With an end line configured, a lift whose
  // observation time is unknown is refused too (Unknown = Block).
  if (accrualEndMs() !== null && accrualEndedAt(pe.corroboration_received_at ?? Number.NaN)) return base;
  try {
    const observedAt = pe.corroboration_received_at ?? null;
    const settlement = computeSettlement(snapshot, {
      // >= the observation and the record time; the 72h enhancement window inside
      // computeSettlement is what actually bounds the lift.
      settlementAtMs: Math.max(observedAt ?? pe.timestamp, pe.timestamp),
      authorizedRecordSnapshotHash: pe.economic_snapshot_hash!,
      verifiedAttestationTier: verifiedTier,
      verifiedAttestationObservedAtMs: observedAt,
      // Identity: only the attestation ratio is used below, never the mint rate.
      globalMintRate: disclosedRationalFactor(1n, 1n, 'settlement_read_identity', snapshot.policyVersion),
      // a row PROMOTED from a recoverable hold (the resolver's
      // `pending_evidence → eligible` on a verified counterparty confirmation)
      // carries its immutable resolution projection beside the untouched seal.
      // Without it `computeSettlement` reads the sealed `pending_evidence`
      // disposition, refuses settlement, and this returns the UNLIFTED base — so
      // the poster's corroboration could never lift the deliverer's row. Passing
      // it routes the lift through the kernel's own projection validation
      // (`resolveEligibilityProjection`), exactly as the dashboard projection
      // below already does; a malformed projection throws and falls to the base.
      ...(pe.economic_eligibility_projection
        ? { eligibilityProjection: pe.economic_eligibility_projection }
        : {}),
    });
    if (!settlement.settlementPermitted) return base;
    const stf = settlement.settlementTimeFactors;
    // The window may have lapsed (late corroboration) → the enhancement did not
    // apply → settle the verbatim base, not a lift.
    if (!stf.enhancementApplied) return base;
    const lifted = (BigInt(base) * BigInt(stf.settlementAttestationMultiplierBps))
      / BigInt(stf.recordAttestationMultiplierBps);
    return lifted.toString();
  } catch {
    return base;
  }
}

/**
 * The RATE-FREE settlement input of one row for one role: the role-split
 * contract-input points the kernel would receive, BEFORE the epoch mint rate.
 *
 * This is the quantity the accrual-time aggregate stores for a frozen row and
 * the tail fold computes live, because it is the largest part of the
 * projection that does not depend on the live mint rate. It DOES still depend
 * on row state that can change inside the 72h enhancement window (a
 * corroboration lifting the tier) and on the mutable `mint_status` /
 * `record_points_atomic` (settlement writeback, pending-cache recovery,
 * deferred release) — which is exactly why the aggregate is split into a
 * frozen part (rows past the window, adjusted by delta at every mutation site)
 * and a live tail.
 *
 * Returns a ZERO input when the row is not presently settleable, null when it
 * cannot be priced at all (missing/tampered snapshot, disposition not eligible,
 * or the settlement kernel refusing the inputs) — the caller counts a null as a
 * projection failure, never as zero value.
 *
 * TWO LANES IN ONE INPUT. A fixed grant (Genesis: `allowedSettlementAdjustments.
 * globalMintRate === false`) is rate-NEUTRAL by contract — the kernel settles it
 * at exactly its reserved gross — so its points go in `fixed` and are never
 * scaled; everything else goes in `rated` and meets the live epoch rate once,
 * in `applyGlobalMintRate`. Folding both into one number would let a stored
 * sum silently scale a Genesis grant by whatever the rate happened to be.
 */
export function projectCurrentSettlementInputAtomic(
  pe: PEHistoryDocument,
  role: 'contributor' | 'beneficiary',
  projectedAtMs: number,
): SettlementInputAtomic | null {
  // Minted PEs are already final on-chain and are not a pending current-factor
  // projection. Operationally deferred rows likewise remain record points only.
  if (pe.mint_status !== 'eligible') return ZERO_SETTLEMENT_INPUT;
  const snapshot = verifiedSnapshot(pe);
  if (snapshot === null || pe.mint_disposition !== 'eligible') return null;
  try {
    const verifiedTier = currentAttestation(pe, snapshot);
    const settlement = computeSettlement(snapshot, {
      settlementAtMs: Math.max(projectedAtMs, pe.timestamp),
      authorizedRecordSnapshotHash: pe.economic_snapshot_hash!,
      verifiedAttestationTier: verifiedTier,
      verifiedAttestationObservedAtMs:
        verifiedTier === snapshot.recordTimeFactors.attestationTier
          ? null
          : pe.corroboration_received_at,
      // Identity: only the contract-input points are read below. The live
      // rate is applied by `applyGlobalMintRate` to the SUM, never per row.
      globalMintRate: disclosedRationalFactor(1n, 1n, 'settlement_input_identity', snapshot.policyVersion),
      ...(pe.economic_eligibility_projection
        ? { eligibilityProjection: pe.economic_eligibility_projection }
        : {}),
    });
    if (!settlement.settlementPermitted) return ZERO_SETTLEMENT_INPUT;
    // The mint worker splits contract input points before contributor
    // aggregation/global-rate application. This per-PE view uses that same
    // operation order, but remains non-final because later aggregation and the
    // armed mint rate can change before mint. Parity: mint rate is the only
    // settlement factor; no supply/lifetime scaler.
    //
    // a value-reducing novelty-corrected recovery settles the ROW's
    // corrected points (the PVT9 lane reads them verbatim), so project those —
    // conservatively without attestation-upgrade uplift, which the snapshot
    // path cannot express for a corrected base.
    const corrected = correctedRecoveryPointsAtomic(pe, snapshot);
    const roleInput = splitForRole(
      pe,
      corrected ?? BigInt(settlement.contractInputPointsAtomic),
      role,
    );
    return snapshot.allowedSettlementAdjustments.globalMintRate
      ? { rated: roleInput, fixed: 0n }
      : { rated: 0n, fixed: roleInput };
  } catch {
    return null;
  }
}

/** Rate-free settlement input, split by whether the live rate applies to it. */
export interface SettlementInputAtomic {
  readonly rated: bigint;
  readonly fixed: bigint;
}

export const ZERO_SETTLEMENT_INPUT: SettlementInputAtomic = Object.freeze({ rated: 0n, fixed: 0n });

export function addSettlementInput(
  a: SettlementInputAtomic,
  b: SettlementInputAtomic,
): SettlementInputAtomic {
  return { rated: a.rated + b.rated, fixed: a.fixed + b.fixed };
}

/**
 * floor(rated × rate) + fixed. The ONE place the live mint rate meets a
 * projection; the fixed lane passes through untouched by contract.
 */
export function applyGlobalMintRate(
  input: SettlementInputAtomic,
  globalMintRate: DisclosedRationalFactor,
): bigint {
  return (input.rated * BigInt(globalMintRate.numerator)) / BigInt(globalMintRate.denominator)
    + input.fixed;
}

/**
 * Per-row projection WITH the rate applied — the single-row view (kept for the
 * per-PE consumers and their tests). The dashboard totals do NOT sum this;
 * they sum `projectCurrentSettlementInputAtomic` and apply the rate once —
 * see the module header on rounding.
 */
export function projectCurrentSettlementPEAtomic(
  pe: PEHistoryDocument,
  role: 'contributor' | 'beneficiary',
  context: CurrentSettlementProjectionContext,
): bigint | null {
  const input = projectCurrentSettlementInputAtomic(pe, role, context.projectedAtMs);
  if (input === null) return null;
  return applyGlobalMintRate(input, context.globalMintRate);
}

export function exactGenesisReservedGrossForRoleAtomic(
  pe: PEHistoryDocument,
  role: 'contributor' | 'beneficiary',
): bigint | null {
  const snapshot = verifiedSnapshot(pe);
  if (snapshot === null) return null;
  if (snapshot.recordTimeFactors.fixedGrantSource !== 'genesis_campaign_reservation') return 0n;
  if (role === 'beneficiary') return 0n;
  const fixed = snapshot.recordTimeFactors.fixedGrantAtomic;
  return fixed === null ? null : BigInt(fixed);
}

function appendCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function appendAtomic(record: Record<string, bigint>, key: string, amount: bigint): void {
  record[key] = (record[key] ?? 0n) + amount;
}

function stringifyAtomicRecord(record: Record<string, bigint>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(record).map(([key, amount]) => [key, amount.toString(10)]),
  ));
}

/**
 * Dashboard monetary truth has three distinct layers:
 * - sealed record points (historical participation units, not PVT);
 * - a current-factor settlement projection explicitly marked non-final;
 * - exact fixed Genesis reserved gross issuance.
 */
/**
 * Page a query and hand each document to `onDoc`. Native Firestore retains a page;
 * encrypted queries share one logical snapshot to avoid repeated decrypt/read passes.
 * This ordered helper is exported for its progress-guard tests; production unordered
 * reductions use `visitQueryDocuments` to retain one physical page instead.
 *
 * Ordered by document id so the walk is a total order with no tiebreaker
 * needed, and served by Firestore's automatic index for a single-equality query
 * — no composite index, no deploy. `onDoc` is synchronous on purpose: the
 * callers fold into scalars, and allowing an async callback here would invite a
 * per-document await, turning a paged read into a per-row round trip.
 *
 * EXPORTED for its own tests. The progress guard below was flagged in review as
 * an unreachable branch — true while the only entry point was this module's own
 * correct call site. Exporting widens the INPUT so a non-advancing query can be
 * constructed and the guard actually exercised, per the run contract's "widen
 * the guard's input type so the violation is constructible, and keep the narrow
 * type at the call site".
 */
export async function streamQuery(
  query: Query,
  onDoc: (doc: QueryDocumentSnapshot) => void,
  pageSize = 1000,
): Promise<void> {
  const source = singleScanQuery(query.orderBy(FieldPath.documentId()));
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let page = source.limit(pageSize);
    if (cursor !== null) page = page.startAfter(cursor);
    const snap = await page.get();
    if (snap.empty) return;
    for (const doc of snap.docs) onDoc(doc);
    // A short page is the last page. Checking size rather than issuing another
    // query saves one round trip per walk.
    if (snap.size < pageSize) return;
    const next = snap.docs[snap.docs.length - 1];
    // PROGRESS GUARD. If the cursor is ever dropped or misapplied, this loop
    // re-reads page one forever — and a hang is the worst way for that to
    // surface: the request never returns and CI times out with no signal. A
    // repeated final document id is impossible on a `__name__`-ordered walk,
    // so it can only mean the cursor stopped advancing. Fail loudly instead.
    if (cursor !== null && next.id === cursor.id) {
      throw new Error(`stream_query_cursor_not_advancing at ${next.id}`);
    }
    cursor = next;
  }
}

/**
 * The mutable accumulator both the full fold and the aggregate read fill, and
 * the ONE finaliser (`finalizeEconomicAccrualProjection`) that turns it into the
 * API shape. Settlement inputs are kept RATE-FREE here; the rate is applied
 * exactly once, on the sums, in the finaliser.
 */
export interface EconomicAccrualTotals {
  totalRecordPoints: bigint;
  exactGenesisReservedGross: bigint;
  settlementInput: SettlementInputAtomic;
  totalPEs: number;
  weeklyPEs: number;
  integrityFailures: number;
  projectionFailures: number;
  counts: Record<string, number>;
  recordPointsByCategory: Record<string, bigint>;
  settlementInputByCategory: Record<string, SettlementInputAtomic>;
  genesisByCategory: Record<string, bigint>;
}

export function emptyEconomicAccrualTotals(): EconomicAccrualTotals {
  return {
    totalRecordPoints: 0n,
    exactGenesisReservedGross: 0n,
    settlementInput: ZERO_SETTLEMENT_INPUT,
    totalPEs: 0,
    weeklyPEs: 0,
    integrityFailures: 0,
    projectionFailures: 0,
    counts: {},
    recordPointsByCategory: {},
    settlementInputByCategory: {},
    genesisByCategory: {},
  };
}

export function appendSettlementInput(
  record: Record<string, SettlementInputAtomic>,
  key: string,
  amount: SettlementInputAtomic,
): void {
  record[key] = addSettlementInput(record[key] ?? ZERO_SETTLEMENT_INPUT, amount);
}

export function finalizeEconomicAccrualProjection(
  totals: EconomicAccrualTotals,
  projectionContext: CurrentSettlementProjectionContext | null,
): EconomicAccrualProjection {
  // Every COUNTED category carries an entry in each by-category map, zero when
  // nothing priced into it. The fold reaches that shape by appending zeros; the
  // aggregate stores no zero entries (a delta that returns a bucket to zero
  // deletes it). Normalising here — in the ONE finaliser both paths use — is
  // what lets frozen + tail and the fold compare equal by construction.
  for (const category of Object.keys(totals.counts)) {
    totals.recordPointsByCategory[category] ??= 0n;
    totals.genesisByCategory[category] ??= 0n;
    if (projectionContext) totals.settlementInputByCategory[category] ??= ZERO_SETTLEMENT_INPUT;
  }
  const projectionByCategory: Record<string, bigint> = {};
  if (projectionContext) {
    for (const [category, input] of Object.entries(totals.settlementInputByCategory)) {
      projectionByCategory[category] = applyGlobalMintRate(input, projectionContext.globalMintRate);
    }
  }
  return {
    totalRecordPointsAtomic: totals.totalRecordPoints.toString(10),
    recordPointsByCategoryAtomic: stringifyAtomicRecord(totals.recordPointsByCategory),
    totalCurrentSettlementProjectionAtomic: projectionContext
      ? applyGlobalMintRate(totals.settlementInput, projectionContext.globalMintRate).toString(10)
      : null,
    currentSettlementProjectionByCategoryAtomic: projectionContext
      ? stringifyAtomicRecord(projectionByCategory)
      : null,
    currentSettlementProjection: projectionContext
      ? Object.freeze({
        label: 'current_settlement_projection_non_final' as const,
        isFinal: false as const,
        projectedAtMs: projectionContext.projectedAtMs,
        factorVintage: Object.freeze({
          globalMintRate: projectionContext.globalMintRate,
        }),
      })
      : null,
    currentSettlementProjectionUnavailableReason: projectionContext
      ? null
      : 'factors_not_supplied',
    exactGenesisReservedGrossAtomic: totals.exactGenesisReservedGross.toString(10),
    exactGenesisReservedGrossByCategoryAtomic: stringifyAtomicRecord(totals.genesisByCategory),
    totalPEs: totals.totalPEs,
    weeklyPEs: totals.weeklyPEs,
    pesByCategory: Object.freeze({ ...totals.counts }),
    integrityFailures: totals.integrityFailures,
    projectionFailures: totals.projectionFailures,
  };
}

/**
 * Log an unpriceable row at the RIGHT severity — accounting is unchanged (the
 * caller has already counted it in `integrityFailures`); this decides only how
 * loud the row is.
 *
 * A pre-cut-line row that simply never sealed a snapshot is EXPECTED legacy (PVT9
 * launched at zero supply, no historical migration) and is logged quietly, so the
 * benign backlog stops saturating the ERROR channel. Everything else stays LOUD at
 * ERROR: a row written AT/AFTER the cut line that failed to seal a snapshot (a
 * genuinely new failure — the hole this must never reopen), a hash/identity
 * mismatch (a real integrity breach), or a present snapshot missing its Genesis
 * fixed grant. The ERROR event name is unchanged so existing alerting still fires;
 * a `reason` field is added for triage.
 */
function reportUnpriceableRow(pe: PEHistoryDocument, userId: string): void {
  const verdict = classifySnapshot(pe);
  const legacyAbsent = !verdict.ok
    && verdict.reason === 'absent'
    && typeof pe.timestamp === 'number'
    && pe.timestamp <= PVT9_ELIGIBILITY_CUT_LINE_MS;
  if (legacyAbsent) {
    console.debug(JSON.stringify({
      severity: 'DEBUG',
      event: 'pvt_legacy_unpriceable_row',
      pe_id: pe.peId,
      user_id: userId,
    }));
    return;
  }
  // ok:true here means the snapshot verified but the Genesis fixed grant was null
  // (a present-snapshot anomaly); ok:false carries a real rejection reason. Either
  // way this is a genuine failure — keep it at ERROR.
  const reason = verdict.ok ? 'genesis_fixed_grant_missing' : verdict.reason;
  console.error(JSON.stringify({
    severity: 'ERROR',
    event: 'pvt_economic_snapshot_integrity_failure',
    pe_id: pe.peId,
    user_id: userId,
    reason,
  }));
}

/**
 * Fold ONE row for ONE role into `totals`. Shared by the full fold below and by
 * the aggregate's per-row contribution (`economic-aggregate.ts`), so the two
 * cannot price a row differently: an integrity failure is counted and nothing
 * else; a priced row adds its record points, its Genesis gross, its counts, and
 * (when asked) its rate-free settlement input or a projection failure.
 */
export function foldRowIntoTotals(
  totals: EconomicAccrualTotals,
  pe: PEHistoryDocument,
  role: 'contributor' | 'beneficiary',
  options: {
    /** Wall clock: decides the current week for `weeklyPEs`. */
    readonly nowMs: number;
    /** Settlement clock for the projection; defaults to `nowMs`. */
    readonly projectedAtMs?: number;
    readonly withProjection: boolean;
    readonly userIdForLog: string;
  },
): void {
  const recordPoints = recordPointsForRoleAtomic(pe, role);
  const genesisGross = exactGenesisReservedGrossForRoleAtomic(pe, role);
  if (recordPoints === null || genesisGross === null) {
    totals.integrityFailures += 1;
    reportUnpriceableRow(pe, options.userIdForLog);
    return;
  }
  totals.totalPEs += 1;
  if (pe.timestamp >= getWeekStart(options.nowMs)) totals.weeklyPEs += 1;
  const category = pe.category || 'other';
  appendCount(totals.counts, category);
  appendAtomic(totals.recordPointsByCategory, category, recordPoints);
  appendAtomic(totals.genesisByCategory, category, genesisGross);
  totals.totalRecordPoints += recordPoints;
  totals.exactGenesisReservedGross += genesisGross;

  if (options.withProjection) {
    const input = projectCurrentSettlementInputAtomic(
      pe,
      role,
      options.projectedAtMs ?? options.nowMs,
    );
    if (input === null) {
      totals.projectionFailures += 1;
      return;
    }
    appendSettlementInput(totals.settlementInputByCategory, category, input);
    totals.settlementInput = addSettlementInput(totals.settlementInput, input);
  }
}

/**
 * THE REFERENCE FOLD over a given set of (row, role) pairs — PURE, no Firestore.
 *
 * PE METER : the relay keeps no per-PE history, so there is no
 * longer a full-history fold to read (the Firestore fold over `pe_history` is gone, with the
 * dashboard's fall-back to it). What survives is the arithmetic the aggregate must equal: a
 * test (or an operator holding rows) folds them here and compares field by field with the
 * aggregate-backed read. A (row id, role) pair is counted once.
 */
export function foldEconomicAccrualRows(
  rows: Iterable<{ readonly row: PEHistoryDocument; readonly role: 'contributor' | 'beneficiary' }>,
  options: {
    readonly nowMs: number;
    readonly settlementProjection?: CurrentSettlementProjectionContext | null;
    readonly userIdForLog?: string;
  },
): EconomicAccrualProjection {
  const projectionContext = options.settlementProjection ?? null;
  const totals = emptyEconomicAccrualTotals();
  const observedRoles = new Set<string>();
  for (const { row, role } of rows) {
    const roleKey = `${String(row.peId)}:${role}`;
    if (observedRoles.has(roleKey)) continue;
    observedRoles.add(roleKey);
    foldRowIntoTotals(totals, row, role, {
      nowMs: options.nowMs,
      projectedAtMs: projectionContext?.projectedAtMs,
      withProjection: projectionContext !== null,
      userIdForLog: options.userIdForLog ?? '',
    });
  }
  return finalizeEconomicAccrualProjection(totals, projectionContext);
}

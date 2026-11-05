/**
 * Approved PVT-native cost catalog — the Agent Bank institution record (institution parameters + institution parameters-rem).
 *
 * The checked-in approval RECORD that `institution parameters_APPROVAL_MECHANISM.md` identified as
 * missing: the home where the policy setter approval of an institution cost VALUE lands. It
 * is deliberately SEPARATE from the byte-frozen proposal catalog
 * (`proposed-pvt-cost-catalog.ts`, which stays untouched and is pinned by
 * `check:wp2`'s `frozenCostCatalogSha256`). An approved value recorded here is
 * later installed on-chain through the matching, bounded, admin-only,
 * prospective-epoch `schedule*` setter on the institution contract, and takes
 * effect at an epoch boundary — never a wall-clock delay.
 *
 * Current parameter recording for the Agent Bank institutions'
 * economics at the standing ECONOMICS-DEFAULT (every value EQUALS the contract's
 * existing literal/gate, so recording it changes NO on-chain behavior and writes NO
 * schedule). This record now carries, alongside the Escrow anchor:
 * - Promise (ProvianPromiseV3): settlement fee 25 bps == the live
 * `(repayAmount*25)/10000` literal; default grace 2,592,000-band 86,400 s
 * == the live `DEFAULT_GRACE_PERIOD` (24 h) constant; principal cap /
 * maximum deadline ratified NO-OVERRIDE (backend caps, no on-chain gate).
 * - Pool (ProvianPoolV3): execution fee 50 bps == the live `(threshold*5)/1000`
 * literal; maximum contributors 200 == the live MAX_CONTRIBUTORS_PER_POOL
 * gate; threshold cap / maximum deadline ratified NO-OVERRIDE.
 * - Court (ProvianCourtV2): panel voting period 172,800 s == the live 48-hour
 * literal. (institution parameters owns Court COST params only; agent directory owns mechanics — every
 * other court.* row is not_implemented / dropped-reputation and is NOT
 * recorded here.)
 * - jobs (backend): the two Escrow inheritors, plus three backend-enforced job
 * limits recorded at their existing values (max applications 50, max
 * deadline 2,419,200 s, PVT budget cap 10,000 PVT). Jobs have no
 * independent on-chain contract — they reuse ProvianEscrowV4 via
 * `createEscrow` so these three carry a `backend` authority, not a setter.
 *
 * A row's `approved` slot holds the ratified value, or `null` when the row is
 * approved-as-NO-OVERRIDE (the contract default stands; no schedule is written). A
 * non-null on-chain value must lie in the row's immutable band. No economic value
 * here differs from the contract fallback, so behavior is byte-for-byte unchanged;
 * installing any value is a later, deliberate `schedule*` step, still the operator’s call.
 *
 * BINDS THE FROZEN PROPOSAL. `FROZEN_COST_CATALOG_SHA256` pins the exact reviewed
 * bytes of `proposed-pvt-cost-catalog.ts`, so an approved value can only ever be
 * registered against a row of the reviewed set. The accompanying test recomputes
 * that hash from the file on disk and fails if it drifts.
 */

/** The five cost parameters rooted directly at `escrow.` in the proposal catalog. */
export type EscrowCostId =
  | 'escrow.pvt_principal_fee'
  | 'escrow.pvt_principal_cap'
  | 'escrow.maximum_auto_release_period'
  | 'escrow.maximum_agreement_deadline'
  | 'escrow.dispute_resolution_timeout';

/** The two `job.` rows that inherit from an Escrow parent (no independent value). */
export type JobInheritorCostId = 'job.pvt_settlement_cost' | 'job.maximum_auto_release_period';

export type EscrowRootedCostId = EscrowCostId | JobInheritorCostId;

/** How an approved value is denominated and where it is enforced on-chain. */
export interface OnChainCostHome {
  /** The contract that holds and enforces this parameter. */
  readonly contract: 'ProvianEscrowV4';
  /** The bounded, admin-only, prospective-epoch setter that installs a value. */
  readonly scheduler:
    | 'scheduleFeeBps'
    | 'schedulePrincipalCap'
    | 'scheduleAutoReleasePeriod'
    | 'scheduleAgreementDeadline'
    | 'scheduleDisputeTimeout';
  /** Denomination of the (future) approved value. */
  readonly unit: 'basis_points' | 'pvt_atomic' | 'seconds';
  /**
   * Immutable [min, max] band the on-chain setter enforces. These MIRROR the
   * contract's compiled constants and the frozen proposal's declared range; they
   * are structural constraints, NOT an approved economic value.
   */
  readonly min: bigint;
  readonly max: bigint;
}

/** An Escrow-rooted approval row. `approved` holds the ratified on-chain value. */
export interface ApprovedEscrowCostRow {
  readonly cost_id: EscrowCostId;
  readonly on_chain: OnChainCostHome;
  /**
   * The ratified on-chain value in `on_chain.unit`, or `null` when the row is
   * approved-as-NO-OVERRIDE (the contract default stands; no schedule is written).
   * A non-null value must lie in the row's immutable band.
   */
  readonly approved: bigint | null;
}

/** A job row that inherits its value from an Escrow parent — never its own value. */
export interface InheritedApprovedCostRow {
  readonly cost_id: JobInheritorCostId;
  readonly inherits_from: EscrowCostId;
  /** Inheritors carry no independent value; they resolve to their parent. */
  readonly approved: null;
}

/** SHA256 of the byte-frozen proposal catalog (`check:wp2`'s `frozenCostCatalogSha256`). */
export const FROZEN_COST_CATALOG_SHA256 =
  'd1a5844c334077471c939861585770b658654abd75786b110c8617055f6a0049' as const;

/**
 * Catalog status for the approved Agent Bank institutions (Escrow, Promise,
 * Pool, Court-costs, jobs) are recorded at their ratified values. The
 * `'no_rows_approved_yet'` sentinel below is still recognized by the fail-closed
 * helpers (a value can never surface under it), but it is not this catalog's status.
 */
export const APPROVED_COST_CATALOG_STATUS = 'agent_bank_institutions_recorded' as const;

/** The sentinel status meaning nothing is approved: no value surfaces under it. */
export const NO_ROWS_APPROVED_STATUS = 'no_rows_approved_yet' as const;

const PVT = 10n ** 18n; // 1 PVT in atomic units

/**
 * The five Escrow-rooted rows, recorded at the operator’s ratified values. Two carry an
 * on-chain value (fee 50 bps; dispute 2,592,000 s = 30 days); three are ratified
 * NO-OVERRIDE (`approved: null` → the contract default stands and no schedule is
 * written). Every recorded value equals the contract's current fallback. The
 * `min`/`max` bands mirror `ProvianEscrowV4`'s compiled constants exactly.
 */
export const APPROVED_ESCROW_COST_ROWS: readonly ApprovedEscrowCostRow[] = Object.freeze([
  {
    cost_id: 'escrow.pvt_principal_fee',
    on_chain: { contract: 'ProvianEscrowV4', scheduler: 'scheduleFeeBps', unit: 'basis_points', min: 0n, max: 1000n },
    // Ratified 50 bps == the live `(amount*5)/1000` literal; equals the contract fallback.
    approved: 50n,
  },
  {
    cost_id: 'escrow.pvt_principal_cap',
    on_chain: {
      contract: 'ProvianEscrowV4',
      scheduler: 'schedulePrincipalCap',
      unit: 'pvt_atomic',
      min: PVT, // 1 PVT
      max: 1_000_000n * PVT, // 1,000,000 PVT
    },
    // Ratified UNSET / no on-chain cap (approved-as-no-override, not pending). The
    // large-amount warning is a separate app-side follow-up — never an on-chain cap.
    approved: null,
  },
  {
    cost_id: 'escrow.maximum_auto_release_period',
    on_chain: {
      contract: 'ProvianEscrowV4',
      scheduler: 'scheduleAutoReleasePeriod',
      unit: 'seconds',
      min: 3_600n, // 1 hour
      max: 7_776_000n, // 90 days
    },
    // Ratified no override (approved-as-no-override, not pending) — keep the contract default.
    approved: null,
  },
  {
    cost_id: 'escrow.maximum_agreement_deadline',
    on_chain: {
      contract: 'ProvianEscrowV4',
      scheduler: 'scheduleAgreementDeadline',
      unit: 'seconds',
      min: 3_600n, // 1 hour
      max: 7_776_000n, // 90 days
    },
    // Ratified no override (approved-as-no-override, not pending) — keep the contract default.
    approved: null,
  },
  {
    cost_id: 'escrow.dispute_resolution_timeout',
    on_chain: {
      contract: 'ProvianEscrowV4',
      scheduler: 'scheduleDisputeTimeout',
      unit: 'seconds',
      min: 172_800n, // 2 days
      max: 15_552_000n, // 180 days
    },
    // Ratified 30 days == the live `DISPUTE_RESOLUTION_TIMEOUT` constant; equals the contract fallback.
    approved: 2_592_000n,
  },
]);

/**
 * The two job inheritors, approved as inheriting their Escrow parent — never a
 * value of their own. `job.pvt_settlement_cost` resolves to
 * `escrow.pvt_principal_fee` (→ 50 bps); `job.maximum_auto_release_period`
 * resolves to `escrow.maximum_auto_release_period` (→ no-override / null). A job's
 * escrow IS a `ProvianEscrowV4`, created via the same `createEscrow`, so it
 * inherits the Escrow parameter automatically on-chain.
 */
export const APPROVED_JOB_INHERITOR_ROWS: readonly InheritedApprovedCostRow[] = Object.freeze([
  { cost_id: 'job.pvt_settlement_cost', inherits_from: 'escrow.pvt_principal_fee', approved: null },
  { cost_id: 'job.maximum_auto_release_period', inherits_from: 'escrow.maximum_auto_release_period', approved: null },
]);

// =============================================================================
// Promise institution — current default policy. Every value EQUALS the ProvianPromiseV3
// fallback, so recording writes NO schedule and changes NO on-chain behavior.
// =============================================================================

/** The four cost parameters rooted directly at `promise.` in the proposal catalog. */
export type PromiseCostId =
  | 'promise.pvt_settlement_fee'
  | 'promise.pvt_principal_cap'
  | 'promise.maximum_deadline'
  | 'promise.default_grace_period';

/** How a Promise cost parameter is denominated and where it is enforced on-chain. */
export interface PromiseOnChainCostHome {
  readonly contract: 'ProvianPromiseV3';
  readonly scheduler:
    | 'scheduleSettlementFeeBps'
    | 'schedulePrincipalCap'
    | 'scheduleMaximumDeadline'
    | 'scheduleDefaultGracePeriod';
  readonly unit: 'basis_points' | 'pvt_atomic' | 'seconds';
  readonly min: bigint;
  readonly max: bigint;
}

/** A Promise cost row, recorded at the operator’s ratified value (or NO-OVERRIDE null). */
export interface ApprovedPromiseCostRow {
  readonly cost_id: PromiseCostId;
  readonly on_chain: PromiseOnChainCostHome;
  readonly approved: bigint | null;
}

/**
 * The four Promise rows recorded at their fallbacks. Settlement fee 25 bps == the
 * live `(repayAmount*25)/10000` literal; default grace 86,400 s == the live
 * `DEFAULT_GRACE_PERIOD` (24 h) constant; principal cap / maximum deadline ratified
 * NO-OVERRIDE (backend-capped, no on-chain gate). Bands mirror ProvianPromiseV3's
 * compiled constants exactly.
 */
export const APPROVED_PROMISE_COST_ROWS: readonly ApprovedPromiseCostRow[] = Object.freeze([
  {
    cost_id: 'promise.pvt_settlement_fee',
    on_chain: {
      contract: 'ProvianPromiseV3',
      scheduler: 'scheduleSettlementFeeBps',
      unit: 'basis_points',
      min: 0n,
      max: 1000n,
    },
    // Ratified 25 bps == the live `(repayAmount*25)/10000` literal.
    approved: 25n,
  },
  {
    cost_id: 'promise.pvt_principal_cap',
    on_chain: {
      contract: 'ProvianPromiseV3',
      scheduler: 'schedulePrincipalCap',
      unit: 'pvt_atomic',
      min: PVT,
      max: 1_000_000n * PVT,
    },
    // Ratified NO-OVERRIDE (no on-chain cap; the backend caps principal).
    approved: null,
  },
  {
    cost_id: 'promise.maximum_deadline',
    on_chain: {
      contract: 'ProvianPromiseV3',
      scheduler: 'scheduleMaximumDeadline',
      unit: 'seconds',
      min: 3_600n,
      max: 7_776_000n,
    },
    // Ratified NO-OVERRIDE (no on-chain bound; the backend bounds the window).
    approved: null,
  },
  {
    cost_id: 'promise.default_grace_period',
    on_chain: {
      contract: 'ProvianPromiseV3',
      scheduler: 'scheduleDefaultGracePeriod',
      unit: 'seconds',
      min: 0n, // a zero grace is legal
      max: 2_592_000n, // 30 days
    },
    // Ratified 86,400 s == the live `DEFAULT_GRACE_PERIOD` (24 h) constant.
    approved: 86_400n,
  },
]);

// =============================================================================
// Pool institution — current default policy. Every value EQUALS the ProvianPoolV3 fallback.
// =============================================================================

export type PoolCostId =
  | 'pool.pvt_execution_fee'
  | 'pool.pvt_threshold_cap'
  | 'pool.maximum_deadline'
  | 'pool.maximum_contributors';

export interface PoolOnChainCostHome {
  readonly contract: 'ProvianPoolV3';
  readonly scheduler:
    | 'scheduleFeeBps'
    | 'scheduleThresholdCap'
    | 'scheduleMaximumDeadline'
    | 'scheduleMaxContributors';
  readonly unit: 'basis_points' | 'pvt_atomic' | 'seconds' | 'count';
  readonly min: bigint;
  readonly max: bigint;
}

export interface ApprovedPoolCostRow {
  readonly cost_id: PoolCostId;
  readonly on_chain: PoolOnChainCostHome;
  readonly approved: bigint | null;
}

/**
 * The four Pool rows recorded at their fallbacks. Execution fee 50 bps == the live
 * `(threshold*5)/1000` literal; maximum contributors 200 == the live
 * MAX_CONTRIBUTORS_PER_POOL gate; threshold cap / maximum deadline ratified
 * NO-OVERRIDE (backend-capped). Bands mirror ProvianPoolV3's compiled constants.
 */
export const APPROVED_POOL_COST_ROWS: readonly ApprovedPoolCostRow[] = Object.freeze([
  {
    cost_id: 'pool.pvt_execution_fee',
    on_chain: { contract: 'ProvianPoolV3', scheduler: 'scheduleFeeBps', unit: 'basis_points', min: 0n, max: 1000n },
    approved: 50n,
  },
  {
    cost_id: 'pool.pvt_threshold_cap',
    on_chain: {
      contract: 'ProvianPoolV3',
      scheduler: 'scheduleThresholdCap',
      unit: 'pvt_atomic',
      min: PVT,
      max: 1_000_000n * PVT,
    },
    approved: null,
  },
  {
    cost_id: 'pool.maximum_deadline',
    on_chain: {
      contract: 'ProvianPoolV3',
      scheduler: 'scheduleMaximumDeadline',
      unit: 'seconds',
      min: 3_600n, // 1 hour
      max: 15_552_000n, // 180 days
    },
    approved: null,
  },
  {
    cost_id: 'pool.maximum_contributors',
    on_chain: {
      contract: 'ProvianPoolV3',
      scheduler: 'scheduleMaxContributors',
      unit: 'count',
      min: 2n,
      max: 200n,
    },
    // Ratified 200 == the live MAX_CONTRIBUTORS_PER_POOL hard-cap gate.
    approved: 200n,
  },
]);

// =============================================================================
// Court institution — current default policy, cost parameters only; arbitration mechanics are separate.
// Only court.panel_voting_period has a live enforced literal; every other court.*
// row is not_implemented / dropped-reputation and is intentionally NOT recorded here.
// =============================================================================

export type CourtCostId = 'court.panel_voting_period';

export interface CourtOnChainCostHome {
  readonly contract: 'ProvianCourtV2';
  readonly scheduler: 'schedulePanelVotingPeriod';
  readonly unit: 'seconds';
  readonly min: bigint;
  readonly max: bigint;
}

export interface ApprovedCourtCostRow {
  readonly cost_id: CourtCostId;
  readonly on_chain: CourtOnChainCostHome;
  readonly approved: bigint | null;
}

/**
 * The one Court cost row recorded at its fallback: panel voting period 172,800 s ==
 * the live 48-hour literal. Band mirrors ProvianCourtV2's compiled constants
 * (86,400–1,209,600 s = 1–14 days).
 */
export const APPROVED_COURT_COST_ROWS: readonly ApprovedCourtCostRow[] = Object.freeze([
  {
    cost_id: 'court.panel_voting_period',
    on_chain: {
      contract: 'ProvianCourtV2',
      scheduler: 'schedulePanelVotingPeriod',
      unit: 'seconds',
      min: 86_400n, // 1 day
      max: 1_209_600n, // 14 days
    },
    approved: 172_800n, // 48 hours
  },
]);

// =============================================================================
// jobs — backend-enforced limits (institution parameters-rem). Jobs have NO independent on-chain
// contract (they reuse ProvianEscrowV4 via createEscrow), so these three carry a
// `backend` authority, not a setter. Each is recorded at its existing backend value.
// =============================================================================

export type JobBackendCostId = 'job.maximum_applications' | 'job.maximum_deadline' | 'job.pvt_budget_cap';

/** A job limit enforced in the relay/backend, with no on-chain scheduler. */
export interface JobBackendCostRow {
  readonly cost_id: JobBackendCostId;
  readonly authority: 'backend';
  readonly unit: 'count' | 'seconds' | 'pvt_atomic';
  /** The recorded existing backend value (never null — these carry a live limit). */
  readonly recorded: bigint;
  /** Immutable [min, max] band mirroring the frozen proposal's declared range. */
  readonly min: bigint;
  readonly max: bigint;
}

/**
 * The three backend job limits recorded at their existing values: max applications
 * 50, max deadline 2,419,200 s (28 days), PVT budget cap 10,000 PVT. Bands mirror
 * the frozen proposal catalog's declared ranges.
 */
export const APPROVED_JOB_BACKEND_ROWS: readonly JobBackendCostRow[] = Object.freeze([
  { cost_id: 'job.maximum_applications', authority: 'backend', unit: 'count', recorded: 50n, min: 1n, max: 500n },
  {
    cost_id: 'job.maximum_deadline',
    authority: 'backend',
    unit: 'seconds',
    recorded: 2_419_200n,
    min: 3_600n,
    max: 15_552_000n,
  },
  {
    cost_id: 'job.pvt_budget_cap',
    authority: 'backend',
    unit: 'pvt_atomic',
    recorded: 10_000n * PVT,
    min: PVT,
    max: 1_000_000n * PVT,
  },
]);

// =============================================================================
// Resolvers + fail-closed guards
// =============================================================================

export interface ApprovedPVTCostCatalog {
  readonly schema_version: 'approved-pvt-cost-catalog/v2';
  readonly scope: 'agent_bank_institutions';
  readonly status: typeof APPROVED_COST_CATALOG_STATUS;
  readonly frozen_proposal_sha256: typeof FROZEN_COST_CATALOG_SHA256;
  readonly escrow_rows: readonly ApprovedEscrowCostRow[];
  readonly job_inheritor_rows: readonly InheritedApprovedCostRow[];
  readonly job_backend_rows: readonly JobBackendCostRow[];
  readonly promise_rows: readonly ApprovedPromiseCostRow[];
  readonly pool_rows: readonly ApprovedPoolCostRow[];
  readonly court_rows: readonly ApprovedCourtCostRow[];
}

export const APPROVED_PVT_COST_CATALOG: ApprovedPVTCostCatalog = Object.freeze({
  schema_version: 'approved-pvt-cost-catalog/v2',
  scope: 'agent_bank_institutions',
  status: APPROVED_COST_CATALOG_STATUS,
  frozen_proposal_sha256: FROZEN_COST_CATALOG_SHA256,
  escrow_rows: APPROVED_ESCROW_COST_ROWS,
  job_inheritor_rows: APPROVED_JOB_INHERITOR_ROWS,
  job_backend_rows: APPROVED_JOB_BACKEND_ROWS,
  promise_rows: APPROVED_PROMISE_COST_ROWS,
  pool_rows: APPROVED_POOL_COST_ROWS,
  court_rows: APPROVED_COURT_COST_ROWS,
});

/** A row that carries an on-chain `approved` value and an immutable band. */
interface BandedRow {
  readonly approved: bigint | null;
  readonly on_chain: { readonly min: bigint; readonly max: bigint };
}

/**
 * True while the catalog's status is the nothing-approved sentinel. Takes `status`
 * as a widened `string` so the resolvers can pass the concrete catalog status
 * without TS narrowing the comparison to always-false. The self-gate is a defense:
 * no institution value ever surfaces while the catalog reads "nothing approved".
 */
function statusGatesEverything(status: string): boolean {
  return status === NO_ROWS_APPROVED_STATUS;
}

/** True iff any Escrow row carries a non-null approved on-chain value (fee + dispute here). */
export function isAnyCostApproved(): boolean {
  return APPROVED_ESCROW_COST_ROWS.some((row) => row.approved !== null);
}

/** True iff any Promise row carries a value (fee + grace here). */
export function isAnyPromiseCostApproved(): boolean {
  return APPROVED_PROMISE_COST_ROWS.some((row) => row.approved !== null);
}

/** True iff any Pool row carries a value (fee + contributors here). */
export function isAnyPoolCostApproved(): boolean {
  return APPROVED_POOL_COST_ROWS.some((row) => row.approved !== null);
}

/**
 * A recorded approved value must lie inside the row's immutable on-chain band —
 * the same inclusive guard the setter enforces. Returns true for a `null`
 * (no-override) slot: nothing is claimed.
 */
export function isApprovedValueInBand(row: BandedRow): boolean {
  if (row.approved === null) return true;
  return row.approved >= row.on_chain.min && row.approved <= row.on_chain.max;
}

/** A backend job limit's recorded value must lie in its immutable band. */
export function isJobBackendValueInBand(row: JobBackendCostRow): boolean {
  return row.recorded >= row.min && row.recorded <= row.max;
}

/**
 * Pure resolver (injectable for drift-testing). Returns the approved on-chain
 * value for an Escrow-rooted cost id, or `null` when the row is no-override /
 * unrecognized. TWO fail-closed defenses: a status self-gate (no value surfaces
 * while `status === NO_ROWS_APPROVED_STATUS`) and at-most-one-hop inheritor delegation.
 */
export function resolveApprovedCostValue(
  costId: EscrowRootedCostId,
  escrowRows: readonly ApprovedEscrowCostRow[],
  inheritorRows: readonly InheritedApprovedCostRow[],
  status: string,
): bigint | null {
  if (status === NO_ROWS_APPROVED_STATUS) return null;
  const inheritor = inheritorRows.find((row) => row.cost_id === costId);
  if (inheritor) {
    return resolveApprovedCostValue(inheritor.inherits_from, escrowRows, inheritorRows, status);
  }
  const row = escrowRows.find((r) => r.cost_id === costId);
  return row ? row.approved : null;
}

/**
 * The approved on-chain value for an Escrow-rooted cost id, or `null` when the row
 * is no-override / unknown. Fail-closed; inheritors resolve to their Escrow parent.
 */
export function getApprovedCostValue(costId: EscrowRootedCostId): bigint | null {
  return resolveApprovedCostValue(
    costId,
    APPROVED_ESCROW_COST_ROWS,
    APPROVED_JOB_INHERITOR_ROWS,
    APPROVED_PVT_COST_CATALOG.status,
  );
}

/** The approved value for a Promise cost id (fail-closed to null on an unknown id). */
export function resolveApprovedPromiseCostValue(costId: PromiseCostId): bigint | null {
  if (statusGatesEverything(APPROVED_PVT_COST_CATALOG.status)) return null;
  const row = APPROVED_PROMISE_COST_ROWS.find((r) => r.cost_id === costId);
  return row ? row.approved : null;
}

/** The approved value for a Pool cost id (fail-closed to null on an unknown id). */
export function resolveApprovedPoolCostValue(costId: PoolCostId): bigint | null {
  if (statusGatesEverything(APPROVED_PVT_COST_CATALOG.status)) return null;
  const row = APPROVED_POOL_COST_ROWS.find((r) => r.cost_id === costId);
  return row ? row.approved : null;
}

/** The approved value for a Court cost id (fail-closed to null on an unknown id). */
export function resolveApprovedCourtCostValue(costId: CourtCostId): bigint | null {
  if (statusGatesEverything(APPROVED_PVT_COST_CATALOG.status)) return null;
  const row = APPROVED_COURT_COST_ROWS.find((r) => r.cost_id === costId);
  return row ? row.approved : null;
}

/**
 * Pure fail-closed invariant for the Escrow anchor (injectable for drift-testing).
 * Throws if: (a) `status` is the nothing-approved sentinel but an Escrow row carries
 * a value; (b) any Escrow value is out of its immutable band; (c) an inheritor
 * carries its own value.
 */
export function assertFailClosedFor(
  escrowRows: readonly ApprovedEscrowCostRow[],
  inheritorRows: readonly InheritedApprovedCostRow[],
  status: string,
): void {
  const anyApproved = escrowRows.some((row) => row.approved !== null);
  if (status === NO_ROWS_APPROVED_STATUS && anyApproved) {
    throw new Error('approved-pvt-cost-catalog: status is no_rows_approved_yet but a row carries a value');
  }
  for (const row of escrowRows) {
    if (!isApprovedValueInBand(row)) {
      throw new Error(`approved-pvt-cost-catalog: ${row.cost_id} approved value is out of its immutable band`);
    }
  }
  for (const row of inheritorRows) {
    if (row.approved !== null) {
      throw new Error(`approved-pvt-cost-catalog: inheritor ${row.cost_id} must not carry its own value`);
    }
  }
}

/**
 * Pure fail-closed invariant across EVERY recorded institution: every on-chain
 * `approved` value (Escrow, Promise, Pool, Court) and every backend job value sits
 * in its immutable band. Injectable for drift-testing.
 */
export function assertAllInstitutionsInBandFor(
  onChainRows: readonly BandedRow[],
  jobBackendRows: readonly JobBackendCostRow[],
  labels: readonly string[],
): void {
  onChainRows.forEach((row, i) => {
    if (!isApprovedValueInBand(row)) {
      throw new Error(`approved-pvt-cost-catalog: ${labels[i]} approved value is out of its immutable band`);
    }
  });
  for (const row of jobBackendRows) {
    if (!isJobBackendValueInBand(row)) {
      throw new Error(`approved-pvt-cost-catalog: backend ${row.cost_id} recorded value is out of its immutable band`);
    }
  }
}

/** Assert the shipped catalog is fail-closed across every institution. */
export function assertFailClosed(): void {
  assertFailClosedFor(APPROVED_ESCROW_COST_ROWS, APPROVED_JOB_INHERITOR_ROWS, APPROVED_PVT_COST_CATALOG.status);
  const onChain: BandedRow[] = [
    ...APPROVED_ESCROW_COST_ROWS,
    ...APPROVED_PROMISE_COST_ROWS,
    ...APPROVED_POOL_COST_ROWS,
    ...APPROVED_COURT_COST_ROWS,
  ];
  const labels: string[] = [
    ...APPROVED_ESCROW_COST_ROWS.map((r) => r.cost_id),
    ...APPROVED_PROMISE_COST_ROWS.map((r) => r.cost_id),
    ...APPROVED_POOL_COST_ROWS.map((r) => r.cost_id),
    ...APPROVED_COURT_COST_ROWS.map((r) => r.cost_id),
  ];
  assertAllInstitutionsInBandFor(onChain, APPROVED_JOB_BACKEND_ROWS, labels);
}

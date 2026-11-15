/**
 * cutover reconciliation — zero-carry cutover reconciliation (repeatable dry run).
 *
 * Pure, read-only reconciliation over the cutover inventory + cursors:
 * NOTHING here can mint, settle, anchor, migrate, or transition any record —
 * there is no write path in this module, no kernel binding, no signer, and no
 * scheduler mount. The plan's acceptance (lines 895–897): dry run repeatable,
 * no-migration exclusion reverified, cursor ranges non-overlapping, totals
 * reconcile exactly, no UI shows legacy/test value as pending PVT9 mint.
 *
 * Repeatability: the report is a deterministic pure function of the inventory
 * snapshot + cut line; `report_sha256` is a digest over the stable-stringified
 * report body, so two runs over the same data yield the identical digest.
 *
 * Chain-backed checks (on-chain batchMinted / totalSupply / burn evidence)
 * accept an OPTIONAL injected reader. Without it those checks report
 * 'not_evaluated' never a silent pass (Unknown = Block). The activation
 * reverification at the final cut line MUST run with the chain reader bound;
 * an inconclusive check blocks cutover per the plan's launch consequence.
 */

import * as crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import type admin from 'firebase-admin';
import {
  takeCutoverInventory,
  type CutoverInventory,
  type CutoverInventoryDb,
} from './cutover-inventory';
import {
  deriveCutoverCursors,
  validateCursorNonOverlap,
  type CutoverCursors,
} from './cutover-cursors';
import { isScopeExcluded } from './cutover-scope-exclusions';
import { judgeC1, judgeC6, type VarianceVerdict } from './cutover-documented-variances';
import {
  findAcknowledgementsWithoutWrittenCause,
  gateBlockers,
  isGateReconciled,
} from './cutover-hard-stops';
import type { C6DowngradeVerdict } from './c6-downgrade-evidence';

/**
 * v5 : the tree the reconciliation ran against. The report is only as
 * meaningful as the CODE that produced it, so the report now names the exact
 * commit and whether the tree was dirty — and the standard-lane settlement
 * gate refuses any report whose commit is not the one the runtime was
 * deployed from. A later commit therefore invalidates the report instead of
 * silently carrying forward (the defect class). Produced by the dry-run
 * SCRIPT (this module stays pure and reads no filesystem or git state).
 */
export interface ReconciliationTreeBinding {
  /** `git rev-parse HEAD` at run time. */
  readonly git_head: string;
  /** `git status --porcelain` non-empty. A dirty tree binds to nothing. */
  readonly tree_dirty: boolean;
}

/**
 * `documented_variance` is NOT a pass and NOT a failure: the check
 * found exactly the state an evidenced, pinned record explains (C1's five
 * pre-snapshot-era legacy mints; C6's downgraded pool/ledger delta), and
 * nothing else. Any departure from the pinned evidence is `fail`. Like
 * `vacuous_pass`, it never counts toward `reconciled`.
 *
 * `vacuous_pass` () is a PASS that asserted NOTHING because the check
 * evaluated ZERO items — a universally-quantified claim over an empty set. It
 * is reported as a status distinct from `pass` because such a check "would
 * pass identically if the data were absent for a bad reason", and the
 * `reconciled` predicate refuses to count it unless it is explicitly
 * acknowledged BY NAME.
 */
export type ReconciliationCheckStatus =
  | 'pass'
  | 'fail'
  | 'documented_variance'
  | 'vacuous_pass'
  | 'not_evaluated';

export interface ReconciliationCheck {
  readonly id: string;
  readonly status: ReconciliationCheckStatus;
  readonly detail: string;
  /**
   * How many records this check actually examined. Printed for ALL thirteen
   * checks so a reader never has to infer coverage from a bare "PASS".
   */
  readonly evaluated_items: number;
}

export interface CutoverReconciliationReport {
  /**
   * v6 : the `documented_variance` status (C1, C6); C8 lists retired
   * operator stubs; C12 is reframed from "stores pristine" (a pre-activation
   * premise that expired at the first mint,) to "no legacy bleed" and is
   * renamed `C12_pvt9_settlement_stores_no_legacy_bleed`.
   * v5 : `bound_tree` (the git commit the run reconciled — the
   * staleness binding the standard-lane gate enforces) + `c6_downgrade` (the
   * downgrade verdict re-derived from the tree at run time, embedded
   * so the gate can honour a documented variance without a filesystem scan at
   * settle time).
   * v4 : C11 resolves its contract per document; C2/C3 cover orphan
   * snapshots.
   * v3 (): `vacuous_pass` + per-check `evaluated_items` +
   * `acknowledged_vacuous_checks`; C1 reports evidenced `out_of_scope` items
   * and C5 classifies zero-PE days. v2 added C12/C13.
   */
  readonly schema_version: 'pvt-cutover-reconciliation/v6';
  readonly cut_line_ms: number;
  readonly inventory: CutoverInventory;
  readonly cursors: CutoverCursors;
  readonly checks: readonly ReconciliationCheck[];
  /** The tree this run reconciled; null when the runner could not bind one. */
  readonly bound_tree: ReconciliationTreeBinding | null;
  /** C6's downgrade verdict at run time; null when not derived. */
  readonly c6_downgrade: C6DowngradeVerdict | null;
  /**
   * Check ids whose `vacuous_pass` the operator explicitly acknowledged. Part
   * of the report body, so the digest covers the acknowledgement and an
   * acknowledged run can never be mistaken for an unacknowledged one.
   *
   * an acknowledgement here requires a WRITTEN CAUSE in
   * `VACUOUS_CAUSE_REGISTRY`, and it no longer affects `reconciled` it is a
   * record of what the operator read, not a gate lever.
   */
  readonly acknowledged_vacuous_checks: readonly string[];
  /**
   * True iff EVERY check passed over a NON-EMPTY item set.
   *
   * , hard stop 5: `vacuous_pass`, `fail` and `not_evaluated` all
   * block, and no acknowledgement can override any of them. Computed by
   * `isGateReconciled` in `cutover-hard-stops.ts`.
   */
  readonly reconciled: boolean;
  /** True iff every check that ran passed (inconclusive checks excluded). */
  readonly reconciled_excluding_not_evaluated: boolean;
  readonly report_sha256: string;
}

/**
 * Optional on-chain evidence reader for the activation chain-backed run. Read-only
 * by construction: the interface exposes no transaction surface.
 */
export interface CutoverChainReader {
  /**
   * `batchMinted(batchId)` asked of the contract THAT BATCH was minted against.
   *
   * the second argument is the batch's own recorded
   * `pvt_contract_address`, used by the registry-bound reader when no
   * mint-transaction binding exists. An implementation that cannot resolve or
   * reach the correct contract MUST THROW — a probe that could not ask the
   * right contract has not received a negative answer, and this gate must never
   * be able to read silence as one. `reconcileCutoverInventory` deliberately
   * does not catch, so a throw aborts the run instead of failing a check.
   */
  readBatchMinted(batchId: string, recordedContractAddress?: string | null): Promise<boolean>;
}

function check(
  id: string,
  passed: boolean,
  evaluatedItems: number,
  detail: string,
): ReconciliationCheck {
  const status: ReconciliationCheckStatus = !passed
    ? 'fail'
    : evaluatedItems === 0 ? 'vacuous_pass' : 'pass';
  return { id, status, detail, evaluated_items: evaluatedItems };
}

/** A check judged by a pinned-evidence verdict. */
function judged(
  id: string,
  verdict: VarianceVerdict,
  evaluatedItems: number,
  detail: string,
): ReconciliationCheck {
  if (verdict === 'documented_variance') {
    return { id, status: 'documented_variance', detail, evaluated_items: evaluatedItems };
  }
  return check(id, verdict === 'pass', evaluatedItems, detail);
}

function notEvaluated(id: string, detail: string): ReconciliationCheck {
  return { id, status: 'not_evaluated', detail, evaluated_items: 0 };
}

/**
 * Run every reconciliation check over an already-taken inventory. Pure and
 * synchronous except the optional chain readbacks.
 */
export async function reconcileCutoverInventory(
  inventory: CutoverInventory,
  options?: {
    chainReader?: CutoverChainReader;
    /** Check ids whose vacuous pass the operator accepts. Default: none. */
    acknowledgedVacuousChecks?: readonly string[];
    /** v5: the tree this run reconciled, supplied by the runner script. */
    boundTree?: ReconciliationTreeBinding | null;
    /** v5: C6's downgrade verdict, derived by the runner script. */
    c6Downgrade?: C6DowngradeVerdict | null;
  },
): Promise<CutoverReconciliationReport> {
  const cursors = deriveCutoverCursors(inventory);
  const checks: ReconciliationCheck[] = [];
  const batches = inventory.legacy_pvtv8.mint_batches;
  const orphanSnapshotRows = inventory.legacy_pvtv8.orphan_snapshot_rows;
  /** Every document that actually carries snapshot arrays (). */
  const snapshotRows = [
    ...batches.filter((b) => b.has_snapshot),
    ...orphanSnapshotRows,
  ];

  // C1 — batch graph completeness: batch ⟺ snapshot, marked ⇒ durable tx.
  // an id carrying a recorded, evidenced out-of-scope ruling in
  // `cutover-scope-exclusions.ts` is reported `out_of_scope` WITH A COUNT —
  // never silently dropped. That registry is empty: the five surviving items
  // are real mints and may never be excluded.
  // when the unresolved set is EXACTLY those five evidenced documents
  //, C1 reports `documented_variance` instead of failing every
  // deploy. One more item, one fewer, or any marked-without-tx batch fails.
  {
    const allMissingSnapshot = batches.filter((b) => !b.has_snapshot).map((b) => b.batch_id);
    const allOrphans = inventory.legacy_pvtv8.orphan_snapshot_batch_ids;
    // DELIBERATELY not scope-filtered: a batch marked minted with no durable
    // transaction is a phantom-mint signal, and no scoping ruling may excuse
    // one. Only the graph-completeness populations are exemptible.
    const markedWithoutTx = batches
      .filter((b) => b.marked && b.mint_tx_hash === null)
      .map((b) => b.batch_id);
    const outOfScope = [...allMissingSnapshot, ...allOrphans].filter(isScopeExcluded);
    const missingSnapshot = allMissingSnapshot.filter((id) => !isScopeExcluded(id));
    const orphans = allOrphans.filter((id) => !isScopeExcluded(id));
    checks.push(judged(
      'C1_batch_graph_complete',
      judgeC1({ missingSnapshot, markedWithoutTx, orphans }),
      batches.length + allOrphans.length,
      `batches=${batches.length} missing_snapshot=[${missingSnapshot.join(',')}] `
      + `marked_without_tx=[${markedWithoutTx.join(',')}] orphan_snapshots=[${orphans.join(',')}] `
      + `out_of_scope=${outOfScope.length} [${outOfScope.join(',')}]`,
    ));
  }

  // C2 — exact batch totals: Σ leaves.basePoints === Σ pe_points, leaves match
  // sorted_pe_ids, parallel arrays consistent, per-contributor sums exact.
  {
    // `snapshotRows` is every document carrying snapshot arrays —
    // batches joined to their snapshot AND orphan snapshots, which the previous
    // population silently skipped. All three surviving snapshots are orphans,
    // so the old population was empty and C2/C3 asserted nothing.
    const broken = snapshotRows.filter((b) => !(
      b.parallel_arrays_consistent
      && b.leaves_match_sorted_pe_ids
      && b.per_contributor_points_consistent
      && b.total_pe_points_atomic !== null
      && b.total_leaf_points_atomic !== null
      && b.total_pe_points_atomic === b.total_leaf_points_atomic
    )).map((b) => b.batch_id);
    checks.push(check(
      'C2_batch_totals_exact',
      broken.length === 0,
      snapshotRows.length,
      broken.length === 0
        ? `every snapshot reconciles exactly (${snapshotRows.length} snapshots, `
          + `${orphanSnapshotRows.length} of them orphaned)`
        : `snapshots with inexact totals or inconsistent leaf/contributor structure: [${broken.join(',')}]`,
    ));
  }

  // C3 — every recipient resolves: well-formed lowercase EVM addresses only.
  {
    const bad = snapshotRows
      .filter((b) => !b.recipients_all_valid_addresses)
      .map((b) => b.batch_id);
    checks.push(check(
      'C3_recipients_resolve',
      bad.length === 0,
      snapshotRows.length,
      bad.length === 0
        ? `every recipient across ${snapshotRows.length} snapshots is a well-formed `
          + 'lowercase EVM address'
        : `snapshots with invalid recipients: [${bad.join(',')}]`,
    ));
  }

  // C4 — mint claims bind to existing batches and carry ONLY the legacy v1
  // schema (a non-v1 claim in the legacy collection would be an identifier-
  // space bleed toward PVT9 — the no-migration exclusion re-verification).
  {
    const claims = inventory.legacy_pvtv8.mint_claims;
    const nonLegacy = claims.filter((c) => !c.is_legacy_schema).map((c) => c.claim_id);
    const unbound = claims.filter((c) => !c.has_batch).map((c) => c.claim_id);
    checks.push(check(
      'C4_claims_legacy_schema_and_bound',
      nonLegacy.length === 0 && unbound.length === 0,
      claims.length,
      `claims=${claims.length} non_v1_schema=[${nonLegacy.join(',')}] unbound=[${unbound.join(',')}]`,
    ));
  }

  // C5 — anchor segments internally consistent (anchored ⇒ tx hash, exact
  // member counts, root present).
  //
  // , the standing rule: a day with ZERO PEs has nothing to anchor, so
  // demanding a merkle root of it is a CHECKER defect. Such a day is
  // CLASSIFIED `no_pe_day` (six conjuncts, including a direct PE probe — see
  // `cutover-inventory.ts`) and LISTED BY DATE with a count; it is never
  // suppressed, and its `internally_consistent` stays false. C5 passes only
  // when EVERY inconsistent day is a no_pe_day.
  {
    const anchors = inventory.legacy_pvtv8.anchors;
    const inconsistent = anchors.filter((a) => !a.internally_consistent);
    const noPeDays = inconsistent.filter((a) => a.no_pe_day);
    const unresolved = inconsistent.filter((a) => !a.no_pe_day);
    const noPeDates = noPeDays.map((a) => a.day ?? a.batch_id).sort((x, y) => x.localeCompare(y));
    checks.push(check(
      'C5_anchor_segments_consistent',
      unresolved.length === 0,
      anchors.length,
      `anchors=${anchors.length} inconsistent=${inconsistent.length} `
      + `no_pe_day=${noPeDays.length} [${noPeDates.join(',')}] `
      + `unresolved=[${unresolved.map((a) => a.batch_id).join(',')}]`,
    ));
  }

  // C6 — legacy Genesis pool ledger reconciles exactly against the per-wallet
  // issuance ledgers (the "totals reconcile exactly" acceptance for the legacy
  // Genesis family).
  // the one evidenced delta (the deleted cleanup script's decrement,
  // /) reports `documented_variance` while BOTH downgrade proofs
  // hold AND the observed delta equals the pinned one; anything else fails.
  {
    const pool = inventory.legacy_pvtv8.genesis.pool_minted_pvt;
    const ledgerTotal = inventory.legacy_pvtv8.genesis.wallet_ledger_issued_total_pvt;
    const ledgerCount = inventory.legacy_pvtv8.genesis.wallet_ledger_count;
    checks.push(judged(
      'C6_genesis_pool_ledger_exact',
      judgeC6(pool, ledgerTotal, ledgerCount, options?.c6Downgrade),
      ledgerCount + (pool === null ? 0 : 1),
      `pool_minted_pvt=${pool ?? 'absent'} wallet_ledger_total=${ledgerTotal} `
      + `(${ledgerCount} ledgers)`
      + (pool === null ? '' : ` ledger_minus_pool=${ledgerTotal - pool}`)
      + ` downgrade_eligible=${options?.c6Downgrade?.downgrade_eligible === true}`,
    ));
  }

  // C7 — structural zero-carry: NO legacy fallback and NO legacy migration are configured,
  // so no path exists that could carry a legacy balance into PVT9.
  //
  // This check formerly also required `pvt9_address === null` and
  // `deployment_status === 'not_deployed'`. That was a PRE-DEPLOY PROXY, not the property:
  // it read "PVT9 does not exist yet, therefore nothing can have carried into it", which is
  // a true but temporary statement of a permanent requirement. Once the kernel is deployed
  // and configured the proxy goes false while the real property is untouched, and leaving it
  // in would have turned a correct posture into a permanent red.
  //
  // The two surviving clauses ARE the property, and they are the ones that would have to be
  // flipped for a balance to carry — both are pinned false by the config generator's own
  // invariants, in the unconfigured and configured branches alike, so this is not a
  // weakening. Deployment status is reported for the operator but no longer gates the check.
  {
    const posture = inventory.pvt9_posture;
    checks.push(check(
      'C7_zero_carry_structural',
      posture.legacy_fallback === false
      && posture.legacy_migration === false,
      1,
      `pvt9_address=${posture.pvt9_address ?? 'null'} `
      + `deployment=${posture.pvt9_deployment_status} legacy_fallback=${posture.legacy_fallback} `
      + `legacy_migration=${posture.legacy_migration}`,
    ));
  }

  // C8 — PVT9 Genesis backlog integrity: every outbox/reservation row carries
  // the expected v2 schema (an unknown schema row is an unclassifiable record
  // and fails closed), and reserved totals parse exactly. The backlog is NOT
  // legacy carry and NOT a migration input — its payability is decided only
  // by the activation arming decision; nothing in this module (or anywhere in cutover reconciliation)
  // can settle it.
  {
    const backlog = inventory.pvt9_genesis_backlog;
    checks.push(check(
      'C8_genesis_backlog_integrity',
      backlog.unknown_schema_count === 0 && backlog.unparseable_reserved_count === 0,
      backlog.outbox_count + backlog.reservation_count,
      `outbox=${backlog.outbox_count} reservations=${backlog.reservation_count} `
      + `reserved_atomic_total=${backlog.reserved_atomic_total} `
      + `unknown_schema=${backlog.unknown_schema_count} unparseable=${backlog.unparseable_reserved_count} `
      + `retired_stubs=${backlog.retired_stub_ids.length} [${backlog.retired_stub_ids.join(',')}]`,
    ));
  }

  // C9 — cursor non-overlap (time fence + fresh-kernel start + no migration).
  {
    const verdict = validateCursorNonOverlap(cursors);
    checks.push(check(
      'C9_cursor_non_overlap',
      verdict.ok,
      1,
      verdict.ok
        ? `pvtv8 settled fence=${cursors.pvtv8_finalized.max_settled_pe_timestamp_ms ?? 'none'} `
          + `< pvt9 starts_after=${cursors.pvt9_start.starts_after_ms}; kernel cursor starts at 0`
        : verdict.violations.join('; '),
    ));
  }

  // C10 — lock inventory parses exactly (bonded PVT is legacy on-chain
  // custody evidence; the record side must sum without ambiguity).
  {
    checks.push(check(
      'C10_lock_inventory_exact',
      inventory.locks.unparseable_amount_count === 0,
      inventory.locks.count,
      `bonds=${inventory.locks.count} total_amount_atomic=${inventory.locks.total_amount_atomic} `
      + `unparseable=${inventory.locks.unparseable_amount_count}`,
    ));
  }

  // C12 — PVT9 settlement stores carry NO LEGACY BLEED (, reframed).
  // Before the first mint this check also demanded the stores be EMPTY ("no
  // settlement authority consumed before activation"). That premise expired at
  // an armed, minting kernel fills them legitimately, so the emptiness
  // conjuncts failed on every healthy deploy since. What stays is the part that
  // was always load-bearing: every ledger, cycle and batch row carries the
  // PVT9 schema, no row carries the LEGACY claim schema, and no settled row is
  // bound to a LEGACY mint batch id. PVT9's start cursor stays the single
  // unified counter (C9).
  {
    const stores = inventory.pvt9_settlement;
    checks.push(check(
      'C12_pvt9_settlement_stores_no_legacy_bleed',
      stores.claim_ledger_unknown_schema_count === 0
      && stores.claim_ledger_legacy_schema_count === 0
      && stores.claim_ledger_legacy_batch_binding_count === 0
      && stores.cycle_unknown_schema_count === 0
      && stores.batch_unknown_schema_count === 0,
      stores.claim_ledger_count + stores.cycle_count + stores.batch_count,
      `ledger=${stores.claim_ledger_count} (settled=${stores.claim_ledger_settled_count} `
      + `unknown_schema=${stores.claim_ledger_unknown_schema_count} `
      + `legacy_schema=${stores.claim_ledger_legacy_schema_count} `
      + `legacy_binding=${stores.claim_ledger_legacy_batch_binding_count}) `
      + `cycles=${stores.cycle_count} (unknown_schema=${stores.cycle_unknown_schema_count}) `
      + `batches=${stores.batch_count} (unknown_schema=${stores.batch_unknown_schema_count})`,
    ));
  }

  // C13 — segmented anchors reconcile : every settlement runtime segmented-anchor
  // day partitions exactly (contiguous ranges, exact counts, per-segment and
  // aggregate roots recompute) and no segment doc is orphaned. Complete over
  // the empty set until segmented anchoring runs — stated plainly.
  {
    const anchorsInventory = inventory.pvt9_anchor_segments;
    const brokenDays = anchorsInventory.day_rows.filter((row) => !row.partition_ok);
    checks.push(check(
      'C13_segmented_anchors_reconcile',
      brokenDays.length === 0 && anchorsInventory.orphan_segment_doc_ids.length === 0,
      anchorsInventory.day_rows.length + anchorsInventory.orphan_segment_doc_ids.length,
      anchorsInventory.day_rows.length === 0 && anchorsInventory.orphan_segment_doc_ids.length === 0
        ? 'no segmented anchor days recorded (complete over the empty set)'
        : `days=${anchorsInventory.day_rows.length} broken=[${brokenDays.map((row) => row.day_doc_id).join(',')}] `
          + `orphan_segments=[${anchorsInventory.orphan_segment_doc_ids.join(',')}]`,
    ));
  }

  // C11 — on-chain finality readback for every finalized batch (chain-backed;
  // activation must run this with a bound reader — inconclusive blocks cutover).
  {
    const reader = options?.chainReader;
    const finalized = batches.filter((b) => b.finalized);
    if (!reader) {
      checks.push(notEvaluated(
        'C11_onchain_batch_finality',
        `chain reader not bound; ${finalized.length} finalized batches require on-chain `
        + 'batchMinted readback at the activation reverification',
      ));
    } else {
      const unconfirmed: string[] = [];
      for (const batch of finalized) {
        // eslint-disable-next-line no-await-in-loop
        const minted = await reader.readBatchMinted(batch.batch_id, batch.pvt_contract_address);
        if (!minted) unconfirmed.push(batch.batch_id);
      }
      checks.push(check(
        'C11_onchain_batch_finality',
        unconfirmed.length === 0,
        finalized.length,
        unconfirmed.length === 0
          ? `all ${finalized.length} finalized batches confirmed on-chain`
          : `finalized batches NOT confirmed on-chain: [${unconfirmed.join(',')}]`,
      ));
    }
  }

  // , HARD STOP 3: an acknowledgement naming a check with no
  // WRITTEN CAUSE is not merely ignored, it is REFUSED — the report cannot be
  // built at all. An uncaused acknowledgement must be inexpressible, not
  // discouraged, because "discouraged" is what prose already was.
  const acknowledged = [...new Set(options?.acknowledgedVacuousChecks ?? [])].sort();
  const uncaused = findAcknowledgementsWithoutWrittenCause(acknowledged);
  if (uncaused.length > 0) {
    throw new Error(
      'cutover_acknowledgement_without_written_cause: '
      + `[${uncaused.join(',')}] — a vacuous check may only be acknowledged when `
      + 'VACUOUS_CAUSE_REGISTRY records a written cause for it',
    );
  }

  // , HARD STOP 5: `reconciled` is true ONLY when every check
  // passed over a NON-EMPTY item set. Acknowledgement is a recorded fact about
  // the operator's reading; it is NOT a licence to count an empty set as a
  // result. This is strictly tighter than the previous predicate, which let an
  // acknowledged `vacuous_pass` reconcile — the exact shape of "acknowledge a
  // vacuous check in order to make a gate green". A `documented_variance`
  // is not a pass either, so `reconciled` stays false while C1/C6
  // carry their evidenced variances and C4/C10/C13 stay vacuous.
  // `reconciled_excluding_not_evaluated` is the "no check FAILED" reading: it
  // is what a healthy deploy prints as true, and any real failure makes false.
  const allPass = isGateReconciled(checks);
  const ranPass = checks.every((c) => c.status !== 'fail');
  const blockers = gateBlockers(checks);
  if (blockers.length > 0 && allPass) {
    // Unreachable by construction; asserted anyway so the two functions can
    // never drift apart silently.
    throw new Error(`cutover_gate_predicate_inconsistent: [${blockers.join(',')}]`);
  }

  const body = {
    schema_version: 'pvt-cutover-reconciliation/v6' as const,
    cut_line_ms: inventory.cut_line_ms,
    inventory,
    cursors,
    checks,
    bound_tree: options?.boundTree ?? null,
    c6_downgrade: options?.c6Downgrade ?? null,
    acknowledged_vacuous_checks: acknowledged,
    reconciled: allPass,
    reconciled_excluding_not_evaluated: ranPass,
  };
  const serialized = stableStringify(body);
  if (serialized === undefined) {
    throw new Error('cutover_reconciliation_report_unserializable');
  }
  return {
    ...body,
    report_sha256: crypto.createHash('sha256').update(serialized, 'utf8').digest('hex'),
  };
}

/**
 * The repeatable dry run: take the inventory at the cut line, reconcile it,
 * return the deterministic report. Read-only end to end.
 */
export async function runCutoverReconciliation(
  db: CutoverInventoryDb | admin.firestore.Firestore,
  options: {
    cutLineMs: number;
    chainReader?: CutoverChainReader;
    acknowledgedVacuousChecks?: readonly string[];
    boundTree?: ReconciliationTreeBinding | null;
    c6Downgrade?: C6DowngradeVerdict | null;
  },
): Promise<CutoverReconciliationReport> {
  const inventory = await takeCutoverInventory(db, { cutLineMs: options.cutLineMs });
  return reconcileCutoverInventory(inventory, {
    chainReader: options.chainReader,
    acknowledgedVacuousChecks: options.acknowledgedVacuousChecks,
    boundTree: options.boundTree,
    c6Downgrade: options.c6Downgrade,
  });
}

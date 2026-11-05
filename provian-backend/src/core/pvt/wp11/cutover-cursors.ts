/**
 * cutover reconciliation — exact PVTv8-finalized cursor and PVT9 start cursor.
 *
 * Pure derivation over the cutover inventory. The two cursors are the
 * non-overlap fence the plan's cutover reconciliation acceptance requires ("cursor ranges do
 * not overlap"):
 *
 * - `pvtv8_finalized` is the exact upper bound of legacy settled value —
 * a watermark over the finalized PVTv8 mint batches (marked on-chain with
 * a durable mint tx hash). It is a HISTORICAL FACT: the PVTv8 mint runtime
 * is quarantined, so this set can only shrink to canonical truth at the
 * activation reverification, never grow.
 * - `pvt9_start` is where PVT9 settlement MAY begin once (and only once)
 * activation deploys, configures, arms, and separately activates it: the fresh
 * kernel's `nextFinalizedCursor` starts at 0 (zero-supply, non-upgradeable,
 * no carry), and its eligibility fence opens strictly AFTER the cut line.
 *
 * RESOLUTION (settlement runtime acceptance): the durable cursor settlement runtime materialized
 * (`pvt9_settlement_cycles_v1.cursor_next`) is a settler-side MIRROR of the
 * kernel's single unified `nextFinalizedCursor` one counter, both lanes,
 * exactly the representation this module already pins. No per-lane segments
 * were introduced, so the `pvt9_start` shape here stands UNCHANGED; the
 * additive check required (the new ledger/cursor store starts empty at
 * the cut line, no legacy identifier bleed) is reconciliation check C12 over
 * `inventory.pvt9_settlement`.
 *
 * Non-overlap is enforced on three independent axes (any single failure is a
 * reconciliation failure):
 * 1. TIME — the cut line is strictly after every timestamp PVTv8 settled.
 * 2. RUNTIME — the PVT9 kernel is unconfigured/undeployed with
 * legacy_migration=false, so no path exists that could consume a legacy
 * record (structural zero-carry).
 * 3. IDENTIFIER SPACE — legacy claims live in 'pvt-mint-claim/v1' keyed by
 * PVTv8 batch id; PVT9 claims are wp-ev derived claim ids over sealed PE
 * identity with a distinct domain-separated preimage. The spaces are
 * disjoint by construction; the reconciliation additionally asserts no
 * non-v1 claim schema appears in the legacy claim collection.
 */

import type { CutoverInventory } from './cutover-inventory';

/**
 * The fresh kernel's starting `nextFinalizedCursor` the ONE source.
 *
 * `nextFinalizedCursor` is a monotonic counter of SETTLED PVT9 CLAIMS, not a
 * timestamp, block, batch index, epoch, or points total: the kernel requires
 * `cursorStart == nextFinalizedCursor` and `cursorEnd - cursorStart ==
 * claimCount`, then advances to `cursorEnd` (`ProvianPVT9.sol:947,948,1079`).
 * A fresh, zero-supply, non-upgradeable kernel with no carry therefore starts
 * at exactly 0, and C9 (`validateCursorNonOverlap`) fails otherwise.
 *
 * exported so the P6 arm script BINDS to this value rather than
 * accepting whatever an operator types. `armEpochZero` does not validate the
 * cursor (`ProvianPVT9.sol:396-406` checks dates, rate, treasuries and
 * verifier only), the value can never be corrected once armed (there is no
 * setter — the only writes are the one-time arm and the settlement advance),
 * and this reconciliation can never observe what actually landed on chain,
 * because it compares this constant to itself. Two modules reading one
 * constant is the fix; two modules each declaring `'0'` is the defect
 * `findRedeclaredLiterals` exists to catch.
 */
export const KERNEL_NEXT_FINALIZED_CURSOR_START = '0';

export interface CutoverCursors {
  readonly schema_version: 'pvt-cutover-cursors/v1';
  readonly pvtv8_finalized: {
    readonly finalized_batch_count: number;
    readonly unfinalized_batch_count: number;
    /** Lexicographically-last finalized batch id (deterministic tiebreak). */
    readonly last_finalized_batch_id: string | null;
    readonly last_finalized_mint_tx_hash: string | null;
    readonly max_finalized_epoch: number | null;
    /** Max leaf timestamp (ms) across FINALIZED batches — the settled fence. */
    readonly max_settled_pe_timestamp_ms: number | null;
    /** Σ pe_points across finalized batches (gross issuance input, atomic). */
    readonly total_finalized_points_atomic: string;
  };
  readonly pvt9_start: {
    /** Fresh non-upgradeable zero-supply kernel: on-chain cursor starts at 0. */
    readonly kernel_next_finalized_cursor_start: typeof KERNEL_NEXT_FINALIZED_CURSOR_START;
    /** The cut line: PVT9 eligibility begins strictly after this instant. */
    readonly starts_after_ms: number;
    readonly kernel_deployed: boolean;
    readonly legacy_migration_configured: boolean;
  };
}

export function deriveCutoverCursors(inventory: CutoverInventory): CutoverCursors {
  const finalized = inventory.legacy_pvtv8.mint_batches.filter((row) => row.finalized);
  const unfinalized = inventory.legacy_pvtv8.mint_batches.length - finalized.length;

  let lastBatch: (typeof finalized)[number] | null = null;
  let maxEpoch: number | null = null;
  let maxTs: number | null = null;
  let totalPoints = 0n;
  for (const row of finalized) {
    if (lastBatch === null || row.batch_id.localeCompare(lastBatch.batch_id) > 0) {
      lastBatch = row;
    }
    if (row.epoch !== null) maxEpoch = maxEpoch === null ? row.epoch : Math.max(maxEpoch, row.epoch);
    if (row.max_leaf_timestamp_ms !== null) {
      maxTs = maxTs === null ? row.max_leaf_timestamp_ms : Math.max(maxTs, row.max_leaf_timestamp_ms);
    }
    if (row.total_pe_points_atomic !== null) totalPoints += BigInt(row.total_pe_points_atomic);
  }

  return {
    schema_version: 'pvt-cutover-cursors/v1',
    pvtv8_finalized: {
      finalized_batch_count: finalized.length,
      unfinalized_batch_count: unfinalized,
      last_finalized_batch_id: lastBatch?.batch_id ?? null,
      last_finalized_mint_tx_hash: lastBatch?.mint_tx_hash ?? null,
      max_finalized_epoch: maxEpoch,
      max_settled_pe_timestamp_ms: maxTs,
      total_finalized_points_atomic: totalPoints.toString(),
    },
    pvt9_start: {
      kernel_next_finalized_cursor_start: KERNEL_NEXT_FINALIZED_CURSOR_START,
      starts_after_ms: inventory.cut_line_ms,
      kernel_deployed: inventory.pvt9_posture.pvt9_deployment_status !== 'not_deployed'
        || inventory.pvt9_posture.pvt9_address !== null,
      legacy_migration_configured: inventory.pvt9_posture.legacy_migration,
    },
  };
}

export interface CursorOverlapVerdict {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/**
 * The non-overlap fence. Every violation is stated exactly; an empty
 * violation list is the ONLY passing state (fail-closed on any ambiguity).
 */
export function validateCursorNonOverlap(cursors: CutoverCursors): CursorOverlapVerdict {
  const violations: string[] = [];
  const settledFence = cursors.pvtv8_finalized.max_settled_pe_timestamp_ms;
  if (settledFence !== null && cursors.pvt9_start.starts_after_ms <= settledFence) {
    violations.push(
      `cut line ${cursors.pvt9_start.starts_after_ms} is not strictly after the `
      + `last PVTv8-settled PE timestamp ${settledFence}`,
    );
  }
  if (cursors.pvt9_start.kernel_next_finalized_cursor_start !== KERNEL_NEXT_FINALIZED_CURSOR_START) {
    violations.push(
      `PVT9 kernel start cursor is not ${KERNEL_NEXT_FINALIZED_CURSOR_START} (fresh-kernel invariant)`,
    );
  }
  if (cursors.pvt9_start.legacy_migration_configured) {
    violations.push('legacy_migration is configured true — zero-carry violated');
  }
  return { ok: violations.length === 0, violations };
}

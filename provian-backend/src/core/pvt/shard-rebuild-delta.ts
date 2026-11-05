/**
 * The delta plan for a sharded increment-only counter rebuild (M8).
 *
 * Extracted from `scripts/rebuild-network-pe-counters.ts` so the arithmetic that
 * makes the rebuild race-free is executable rather than argued: the script does
 * `admin.initializeApp()` at module scope, so it cannot be imported by a test,
 * and the claim "concurrent accrual survives the rebuild" is exactly the kind of
 * property that must be demonstrated, not asserted in a comment.
 *
 * THE PROPERTY. `pvt_network_stats` shards are increment-only — nothing
 * decrements them — so a rebuild that writes ABSOLUTE values clobbers whatever
 * landed between the read and the write. Applying `increment(target - observed)`
 * instead leaves a shard at `observed + c + (target - observed) = target + c`,
 * where `c` is everything that arrived concurrently. The correction lands and
 * the live traffic survives, with no transaction, no retry, and nothing to
 * converge on.
 */

export interface ShardObservation {
  /** Shard document id, e.g. `shard_3`. */
  readonly id: string;
  readonly totalPEs: number;
  readonly totalEstimatedPVT: number;
}

export interface ShardDelta {
  readonly id: string;
  /** Value to pass to `FieldValue.increment` for `totalPEs`. */
  readonly totalPEs: number;
  /** Value to pass to `FieldValue.increment` for `totalEstimatedPVT`. */
  readonly totalEstimatedPVT: number;
}

export interface RebuildTargets {
  readonly totalPEs: number;
  readonly totalEstimatedPVT: number;
}

/**
 * Plan the per-shard increments that move the fleet to `targets`.
 *
 * Shard 0 absorbs the whole real total; every other shard is driven to zero —
 * the consolidation the rebuild exists to perform. Both are expressed relative
 * to what was observed, never as an assignment.
 */
export function computeShardRebuildDeltas(
  observed: readonly ShardObservation[],
  targets: RebuildTargets,
): ShardDelta[] {
  return observed.map((shard, index) => {
    const targetPEs = index === 0 ? targets.totalPEs : 0;
    const targetPVT = index === 0 ? targets.totalEstimatedPVT : 0;
    return {
      id: shard.id,
      totalPEs: targetPEs - shard.totalPEs,
      totalEstimatedPVT: targetPVT - shard.totalEstimatedPVT,
    };
  });
}

/**
 * What the fleet sums to after the deltas land, given increments that arrived
 * concurrently. Used by the tests to state the survival property directly, and
 * by the script's post-run report to explain a non-zero difference as preserved
 * traffic rather than as drift.
 */
export function projectPostRebuildTotal(
  observed: readonly ShardObservation[],
  targets: RebuildTargets,
  concurrentPEsByShard: readonly number[],
): number {
  const deltas = computeShardRebuildDeltas(observed, targets);
  return observed.reduce(
    (sum, shard, i) => sum + shard.totalPEs + (concurrentPEsByShard[i] ?? 0) + deltas[i].totalPEs,
    0,
  );
}

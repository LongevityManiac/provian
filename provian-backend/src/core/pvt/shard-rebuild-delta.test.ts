/**
 * Shard rebuild deltas (M8).
 *
 * The claim under test is the one the old implementation got wrong: a rebuild
 * running while real accrual continues must PRESERVE that accrual. The old form
 * wrote absolute totals, so concurrent increments were clobbered — and the
 * verify loop then reported the loss as "drift" and retried into the same
 * window, up to five rounds, before throwing.
 *
 * a suite that only checked the quiet case (no concurrent traffic) would
 * pass against the absolute-write implementation, which is precisely the defect.
 * The concurrent case is therefore the centre of this file, and it is paired
 * with an explicit demonstration of what the absolute write would have produced
 * on the SAME fixture.
 */

import {
  computeShardRebuildDeltas,
  projectPostRebuildTotal,
  type ShardObservation,
} from './shard-rebuild-delta';

const SHARDS: ShardObservation[] = [
  { id: 'shard_0', totalPEs: 900, totalEstimatedPVT: 90 },
  { id: 'shard_1', totalPEs: 40, totalEstimatedPVT: 4 },
  { id: 'shard_2', totalPEs: 60, totalEstimatedPVT: 6 },
];
const TARGETS = { totalPEs: 700, totalEstimatedPVT: 70 };

/**
 * What the fleet sums to if the rebuild writes ABSOLUTE values, as it used to.
 *
 * MODELLED FROM THE OLD OPERATION, not hard-coded. The first version of this
 * helper ignored its arguments and returned the target constant — flagged in
 * review as a tautological control, and rightly: it would have "proved" the old
 * strategy lost data even if the old strategy had been fine.
 *
 * The old `writeShards` SET shard_0 to the target and every other shard to 0,
 * inside a transaction that READ nothing — so Firestore had no document to
 * detect a conflict on. An increment that committed BEFORE that write is simply
 * replaced by it and is gone; one that commits AFTER survives on top. The split
 * is therefore the whole story, and it is an input here rather than an
 * assumption.
 */
function absoluteWriteTotal(
  observed: readonly ShardObservation[],
  concurrentBeforeWrite: readonly number[],
  concurrentAfterWrite: readonly number[],
): number {
  // Everything the shards held — the observed values AND anything that landed
  // before the write — is overwritten by the absolute SET.
  void observed;
  void concurrentBeforeWrite;
  return TARGETS.totalPEs + concurrentAfterWrite.reduce((a, b) => a + b, 0);
}

describe('computeShardRebuildDeltas', () => {
  it('drives shard 0 to the real total and every other shard to zero', () => {
    const deltas = computeShardRebuildDeltas(SHARDS, TARGETS);

    expect(deltas).toEqual([
      { id: 'shard_0', totalPEs: 700 - 900, totalEstimatedPVT: 70 - 90 },
      { id: 'shard_1', totalPEs: -40, totalEstimatedPVT: -4 },
      { id: 'shard_2', totalPEs: -60, totalEstimatedPVT: -6 },
    ]);
  });

  it('lands EXACTLY on the target when nothing accrues during the run', () => {
    expect(projectPostRebuildTotal(SHARDS, TARGETS, [0, 0, 0])).toBe(700);
  });

  it('PRESERVES accrual that lands during the run — the whole point', () => {
    // Seven real PEs arrive mid-rebuild, spread across shards. The fleet must end
    // at target + 7, not at target.
    const concurrent = [3, 2, 2];
    expect(projectPostRebuildTotal(SHARDS, TARGETS, concurrent)).toBe(707);
  });

  it('CONTROL — an absolute write LOSES whatever landed before it; the delta keeps everything', () => {
    // Same fixture, same seven concurrent PEs, both strategies. Four land before
    // the write and three after.
    const before = [2, 1, 1];   // 4
    const after = [1, 1, 1];    // 3
    const all = before.map((n, i) => n + after[i]);

    const absolute = absoluteWriteTotal(SHARDS, before, after);
    const delta = projectPostRebuildTotal(SHARDS, TARGETS, all);

    // The absolute write keeps ONLY what arrived after it: target + 3.
    expect(absolute).toBe(703);
    // The delta keeps all seven, regardless of which side of the write they hit.
    expect(delta).toBe(707);
    expect(delta - absolute).toBe(before.reduce((a, b) => a + b, 0));

    // And the worst case the verify loop kept hitting — everything lands before
    // the write — loses ALL of them.
    expect(absoluteWriteTotal(SHARDS, all, [0, 0, 0])).toBe(700);
    expect(projectPostRebuildTotal(SHARDS, TARGETS, all)).toBe(707);
  });

  it('is correct when the counters are already right (a re-run is a no-op)', () => {
    const alreadyRight: ShardObservation[] = [
      { id: 'shard_0', totalPEs: 700, totalEstimatedPVT: 70 },
      { id: 'shard_1', totalPEs: 0, totalEstimatedPVT: 0 },
    ];
    expect(computeShardRebuildDeltas(alreadyRight, TARGETS).every(
      (d) => d.totalPEs === 0 && d.totalEstimatedPVT === 0,
    )).toBe(true);
    expect(projectPostRebuildTotal(alreadyRight, TARGETS, [0, 0])).toBe(700);
  });

  it('corrects UPWARD too, not only downward', () => {
    // The rebuild is not inherently a subtraction; if the shards under-count, the
    // delta is positive. A sign assumption baked into the implementation would
    // fail here.
    const undercounted: ShardObservation[] = [
      { id: 'shard_0', totalPEs: 10, totalEstimatedPVT: 1 },
      { id: 'shard_1', totalPEs: 0, totalEstimatedPVT: 0 },
    ];
    const deltas = computeShardRebuildDeltas(undercounted, TARGETS);
    expect(deltas[0].totalPEs).toBe(690);
    expect(projectPostRebuildTotal(undercounted, TARGETS, [0, 0])).toBe(700);
  });

  it('handles an empty shard fleet without throwing', () => {
    expect(computeShardRebuildDeltas([], TARGETS)).toEqual([]);
    expect(projectPostRebuildTotal([], TARGETS, [])).toBe(0);
  });
});

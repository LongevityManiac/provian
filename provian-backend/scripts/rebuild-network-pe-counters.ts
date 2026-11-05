/**
 * rebuild-network-pe-counters — one-time recompute of the pvt_network_stats
 * shard totals so they count REAL wallets only.
 *
 * The shard counters (pvt_network_stats/global/shards/shard_0..9) are
 * increment-only — there is no decrement path — so consigning wallets to
 * test status (scripts/mark-test-wallets.ts) cannot retroactively clean
 * totalPEs. This script recomputes BY INCLUSION: it counts pe_history for
 * exactly the ids the allowlisted real wallets own ({doc id, user_id,
 * agent_id}) and writes those totals to shard_0, zeroing shard_1..9. An
 * exclusion-based rebuild would silently keep unknown junk ids (orphaned
 * loadtest_*, deleted wallets, 'system') — inclusion cannot.
 *
 * RUN ORDER: after the network_countable accrual gate is DEPLOYED (else
 * test accrual re-inflates the shards between rebuild and cutover).
 *
 * M8 — THE CORRECTION IS APPLIED AS ATOMIC DELTAS, in ONE pass. It used
 * to write absolute totals and then re-count in a loop, retrying on "drift" up
 * to five rounds before throwing. That drift was self-inflicted: an absolute
 * write clobbers any accrual that landed mid-rebuild, and each retry re-opened
 * the same window, so under sustained accrual it could never converge. These
 * counters are increment-only, so the correct operation is an increment —
 * `increment(target - observed)` leaves concurrent accrual intact and is
 * commutative with it. There is nothing left to converge on and no retry budget
 * to exhaust. See `applyShardDeltas`.
 *
 * DRY-RUNS by default; writes only with --apply.
 *
 * Usage:
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/rebuild-network-pe-counters.ts # dry run
 * GCP_PROJECT_ID=provian-ai npx tsx scripts/rebuild-network-pe-counters.ts --apply # LIVE
 */

import admin from 'firebase-admin';
import { parseAllowlistArgs, resolveAllowlist } from './lib/real-wallet-allowlist';
import { computeShardRebuildDeltas } from '../src/core/pvt/shard-rebuild-delta';
import { NETWORK_SHARD_COUNT } from '../src/core/pvt/durable-accrual-effects';
import { scriptDb } from './lib/script-db';

admin.initializeApp();
const db = scriptDb();

// H4 — IMPORTED, never re-declared. This used to be a local `10` with a
// comment saying it mirrored `durable-accrual-effects.ts`; a mirror is not a
// source, and a rebuild running with a stale count would leave every shard above
// its horizon untouched and silently under-correct the totals.
const SHARD_COUNT = NETWORK_SHARD_COUNT;

interface RealTotals {
  totalPEs: number;
  totalEstimatedPVT: number;
  perId: Map<string, number>;
}

async function computeRealTotals(realIdSet: Set<string>): Promise<RealTotals> {
  let totalPEs = 0;
  let totalEstimatedPVT = 0;
  const perId = new Map<string, number>();
  for (const id of realIdSet) {
    const countSnap = await db.collection('pe_history').where('userId', '==', id).count().get();
    const count = countSnap.data().count;
    perId.set(id, count);
    totalPEs += count;
    if (count === 0) continue;
    // Paged estimatedPVT sum (select() keeps the reads narrow).
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      let query = db.collection('pe_history')
        .where('userId', '==', id)
        .orderBy('__name__')
        .select('estimatedPVT')
        .limit(1000);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const doc of page.docs) {
        const v = doc.data().estimatedPVT;
        if (typeof v === 'number' && Number.isFinite(v)) totalEstimatedPVT += v;
      }
      cursor = page.docs[page.docs.length - 1] ?? null;
      if (page.size < 1000) break;
    }
  }
  return { totalPEs, totalEstimatedPVT, perId };
}

async function readShardSums(): Promise<{ totalPEs: number; totalEstimatedPVT: number }> {
  const snap = await db.collection('pvt_network_stats').doc('global').collection('shards').get();
  let totalPEs = 0;
  let totalEstimatedPVT = 0;
  for (const doc of snap.docs) {
    totalPEs += typeof doc.data().totalPEs === 'number' ? doc.data().totalPEs : 0;
    totalEstimatedPVT += typeof doc.data().totalEstimatedPVT === 'number' ? doc.data().totalEstimatedPVT : 0;
  }
  return { totalPEs, totalEstimatedPVT };
}

/**
 * Apply the correction as ATOMIC DELTAS, never as absolute values (M8).
 *
 * WHY THIS CHANGED. The old form wrote absolute totals (`shard_0 = realTotal`,
 * the rest `= 0`) inside a transaction that READ nothing — so Firestore had no
 * document to detect a conflict on, and a real PE that incremented a shard while
 * the rebuild was in flight was simply overwritten. That is what the verify loop
 * was papering over: it re-counted, saw the drift, and re-ran, up to five times,
 * then THREW. sustained accrual it could never converge, because every
 * round re-opened the same window it was trying to close.
 *
 * The counters are increment-only by construction, so the correct operation is
 * an increment, not an assignment. Reading shard `i` at value `V` and applying
 * `increment(-V)` lands it at exactly the increments that arrived in between:
 * `V + c - V = c`. Concurrent accrual is PRESERVED rather than clobbered, the
 * operation is commutative with it, and no convergence loop is needed at all.
 *
 * The read happens outside the write on purpose: a stale `V` is harmless here
 * (it only changes which increments are attributed to the correction versus to
 * live traffic), whereas a transaction would serialise against every accrual on
 * a hot counter for no correctness gain.
 */
async function applyShardDeltas(totals: RealTotals): Promise<{ appliedTo: number }> {
  const shardsRef = db.collection('pvt_network_stats').doc('global').collection('shards');
  const refs = Array.from({ length: SHARD_COUNT }, (_, i) => shardsRef.doc(`shard_${i}`));
  const snaps = await db.getAll(...refs);

  const num = (v: unknown): number =>
    (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const observed = snaps.map((snap, i) => ({
    id: refs[i].id,
    totalPEs: num(snap.data()?.totalPEs),
    totalEstimatedPVT: num(snap.data()?.totalEstimatedPVT),
  }));

  // The arithmetic lives in src/core/pvt/shard-rebuild-delta.ts and is tested
  // there — this file cannot be imported by a test (admin.initializeApp() runs
  // at module scope), and the survival property is too load-bearing to leave as
  // a comment.
  const deltas = computeShardRebuildDeltas(observed, totals);

  const batch = db.batch();
  for (let i = 0; i < deltas.length; i++) {
    batch.set(refs[i], {
      totalPEs: admin.firestore.FieldValue.increment(deltas[i].totalPEs),
      totalEstimatedPVT: admin.firestore.FieldValue.increment(deltas[i].totalEstimatedPVT),
    }, { merge: true });
  }
  await batch.commit();
  return { appliedTo: deltas.length };
}

async function main(): Promise<void> {
  const { entries, apply } = parseAllowlistArgs(process.argv);
  console.log(`Allowlist entries: ${entries.join(', ')}`);
  console.log(`Mode: ${apply ? 'APPLY (live writes)' : 'DRY RUN'}\n`);

  const { realIdSet } = await resolveAllowlist(db, entries);
  console.log(`Real id set (${realIdSet.size}): ${[...realIdSet].join(', ')}\n`);

  const before = await readShardSums();
  const totals = await computeRealTotals(realIdSet);

  console.log('Per-id pe_history counts:');
  for (const [id, count] of totals.perId) console.log(`  ${id}: ${count}`);
  console.log(`\nShard sums BEFORE: totalPEs=${before.totalPEs} totalEstimatedPVT=${before.totalEstimatedPVT}`);
  console.log(`Computed REAL:     totalPEs=${totals.totalPEs} totalEstimatedPVT=${totals.totalEstimatedPVT.toFixed(4)}`);
  console.log(`Delta to remove:   totalPEs=${before.totalPEs - totals.totalPEs}`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to execute.');
    return;
  }

  // ONE pass. The delta form is commutative with live accrual, so there is
  // nothing to converge on and no retry loop to run out of.
  await applyShardDeltas(totals);

  const after = await readShardSums();
  const landedDuringRun = after.totalPEs - totals.totalPEs;
  console.log(`\nShard sums AFTER:  totalPEs=${after.totalPEs} totalEstimatedPVT=${after.totalEstimatedPVT}`);

  if (landedDuringRun === 0) {
    console.log('Exactly the computed real total; no accrual landed during the run.');
  } else if (landedDuringRun > 0) {
    // NOT drift, and NOT an error: these are real PEs that arrived while the
    // rebuild was running, and preserving them is the entire point of the delta
    // form. The old absolute write would have silently DELETED them and then
    // reported the loss as drift.
    console.log(`+${landedDuringRun} PE(s) landed during the run and were preserved (expected under live accrual).`);
  } else {
    // Only reachable if something DECREMENTED a counter, which no code path
    // does. Report loudly rather than pretending the rebuild succeeded.
    console.error(
      `\nUNEXPECTED: shard sum ${after.totalPEs} is BELOW the computed real total `
      + `${totals.totalPEs}. No code path decrements these counters — investigate before trusting `
      + 'network stats.',
    );
    process.exitCode = 1;
    return;
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * cycle-supersede rehearsed on REAL Firestore, zero production contact.
 *
 * `resolveEffectiveCycleId` had never executed outside jest fakes (the first
 * standard settlement's cycle closed clean, so the supersede path stayed
 * cold). Its first live execution must not be during an incident, so this
 * rehearsal drives the REAL function against REAL Firestore — real
 * transactional reads, real indexes — through a SettlementDb wrapper that
 * remaps every collection name onto a `rehearsal_` prefix. The production
 * collections are never read or written; the module under rehearsal is
 * read-only by construction anyway (it writes nothing, anywhere).
 *
 * Scenarios mirror the module's own doctrine, including both refusal edges.
 * Every scenario prints PASS/FAIL; any FAIL exits 1. Rehearsal docs are
 * deleted afterward (they are this script's own scratch state).
 *
 * npx ts-node scripts/wp4-supersede-rehearsal.ts
 */
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import {
  MAX_CYCLE_SUPERSESSIONS,
  resolveEffectiveCycleId,
} from '../src/core/pvt/wp4/cycle-supersede';
import {
  SETTLEMENT_BATCH_SCHEMA,
  type SettlementDb,
} from '../src/core/pvt/wp4/durable-settlement-store';
import { scriptDb } from './lib/script-db';

const PREFIX = 'rehearsal_d152_';
const BASE = 'epoch0-2026-07-28-rehearsal';

function remapped(db: FirebaseFirestore.Firestore): SettlementDb {
  return {
    collection: (name: string) => db.collection(`${PREFIX}${name}`),
    batch: () => db.batch(),
    runTransaction: (fn: (txn: FirebaseFirestore.Transaction) => Promise<unknown>) =>
      db.runTransaction(fn),
  } as unknown as SettlementDb;
}

function scratchBatch(cycleId: string, status: 'submitted' | 'reserved', nonce: number) {
  return {
    schema_version: SETTLEMENT_BATCH_SCHEMA,
    cycle_id: cycleId,
    status,
    reserved_nonce: nonce,
    cursor_start: '0',
    rehearsal: 'd152',
  };
}

async function main(): Promise<void> {
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'provian-ai' });
  }
  const raw = scriptDb();
  const db = remapped(raw);
  const cycles = raw.collection(`${PREFIX}pvt9_settlement_cycles_v1`);
  const batches = raw.collection(`${PREFIX}pvt9_settlement_batches_v1`);
  const created: FirebaseFirestore.DocumentReference[] = [];
  const seedCycle = async (id: string, status: string) => {
    const ref = cycles.doc(id);
    await ref.set({ status, rehearsal: 'd152' });
    created.push(ref);
  };
  const seedBatch = async (id: string, doc: Record<string, unknown>) => {
    const ref = batches.doc(id);
    await ref.set(doc);
    created.push(ref);
  };

  let failures = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
    if (!ok) failures += 1;
  };

  try {
    // 1. Normal day: no cycle doc at all → the base id, nothing superseded.
    let r = await resolveEffectiveCycleId(db, BASE, console.log);
    check('normal-day', r.kind === 'ok' && r.cycleId === BASE && r.supersededCycleIds.length === 0,
      JSON.stringify(r));

    // 2. Active cycle: resumable as-is.
    await seedCycle(BASE, 'active');
    r = await resolveEffectiveCycleId(db, BASE, console.log);
    check('active-resume', r.kind === 'ok' && r.cycleId === BASE && r.supersededCycleIds.length === 0,
      JSON.stringify(r));

    // 3. THE WEDGE CASE: closed and batch-empty → superseded to -r2.
    await seedCycle(BASE, 'completed');
    r = await resolveEffectiveCycleId(db, BASE, console.log);
    check('closed-empty-supersedes', r.kind === 'ok' && r.cycleId === `${BASE}-r2`
      && r.supersededCycleIds.length === 1 && r.supersededCycleIds[0] === BASE,
      JSON.stringify(r));

    // 4. Chained: -r2 also closed-empty → -r3, both recorded in order.
    await seedCycle(`${BASE}-r2`, 'completed');
    r = await resolveEffectiveCycleId(db, BASE, console.log);
    check('chained-supersede', r.kind === 'ok' && r.cycleId === `${BASE}-r3`
      && JSON.stringify(r.supersededCycleIds) === JSON.stringify([BASE, `${BASE}-r2`]),
      JSON.stringify(r));

    // 5. REFUSAL EDGE — a submitted batch in the closed cycle: never step past
    //    a transaction that may have been accepted by a node.
    await seedBatch('0xd152submitted', scratchBatch(BASE, 'submitted', 7));
    r = await resolveEffectiveCycleId(db, BASE, console.log);
    check('refuses-submitted', r.kind === 'refused'
      && r.reason === 'closed_cycle_has_unresolved_batches'
      && r.unresolvedStatuses.includes('submitted'),
      JSON.stringify(r));

    // 6. REFUSAL EDGE — a reserved crash orphan: its nonce adjudication
    //    belongs to the runner's resume path, not a fresh id.
    await batches.doc('0xd152submitted').delete();
    await seedBatch('0xd152reserved', scratchBatch(BASE, 'reserved', 9));
    r = await resolveEffectiveCycleId(db, BASE, console.log);
    check('refuses-reserved', r.kind === 'refused'
      && r.reason === 'closed_cycle_has_unresolved_batches'
      && r.unresolvedStatuses.includes('reserved'),
      JSON.stringify(r));
    await batches.doc('0xd152reserved').delete();

    // 7. The runaway backstop: MAX closed-empty cycles → supersede_limit.
    for (let ordinal = 3; ordinal <= MAX_CYCLE_SUPERSESSIONS; ordinal += 1) {
      await seedCycle(`${BASE}-r${ordinal}`, 'completed');
    }
    r = await resolveEffectiveCycleId(db, BASE, console.log);
    check('supersede-limit', r.kind === 'refused' && r.reason === 'supersede_limit',
      JSON.stringify(r));
  } finally {
    for (const ref of created) await ref.delete().catch(() => {});
    const leftoverCycles = await cycles.get();
    const leftoverBatches = await batches.get();
    console.log(`cleanup: rehearsal collections now hold ${leftoverCycles.size} cycle + ${leftoverBatches.size} batch docs (expect 0 + 0)`);
    if (leftoverCycles.size + leftoverBatches.size > 0) failures += 1;
  }

  if (failures > 0) {
    console.error(`${failures} scenario(s) FAILED`);
    process.exit(1);
  }
  console.log('all 7 scenarios PASS; rehearsal state fully removed; production collections untouched.');
}

main().catch((error) => {
  console.error('[wp4-supersede-rehearsal] failed:', error);
  process.exit(1);
});

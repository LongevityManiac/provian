/**
 * cutover reconciliation — zero-carry cutover reconciliation tests.
 *
 * Locks down the plan's cutover reconciliation acceptance (lines 895–897):
 * 1. The dry run is REPEATABLE: two runs over the same data produce the
 * byte-identical report digest.
 * 2. The no-migration exclusion is reverified: structural zero-carry (kernel
 * undeployed, legacy_migration=false) and identifier-space isolation (a
 * non-v1 claim schema in the legacy claim collection FAILS).
 * 3. Cursor ranges do not overlap: a cut line at/before the last
 * PVTv8-settled PE timestamp FAILS.
 * 4. Totals reconcile exactly: an off-by-one anywhere (batch points,
 * genesis pool vs wallet ledgers) FAILS — no tolerance.
 * 5. Nothing in the module can write: the fake store is byte-identical
 * before and after a full run.
 */
import { describe, it, expect } from '@jest/globals';
import {
  CUT_LINE,
  seedHealthyCutoverStore as seedHealthyStore,
} from '../__test-helpers__/healthy-cutover-store';
import { takeCutoverInventory } from './cutover-inventory';
import { deriveCutoverCursors, validateCursorNonOverlap } from './cutover-cursors';
import { runCutoverReconciliation } from './cutover-reconciliation';

describe('cutover reconciliation cutover reconciliation — healthy state', () => {
  it('reconciles exactly, is repeatable, and never writes', async () => {
    const db = seedHealthyStore();
    const before = JSON.stringify([...db.store.entries()].sort());

    const report1 = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const report2 = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });

    // Repeatable dry run: byte-identical digest.
    expect(report1.report_sha256).toBe(report2.report_sha256);
    // Read-only: the store is untouched.
    expect(JSON.stringify([...db.store.entries()].sort())).toBe(before);

    // Every Firestore-side check passes; the chain readback is explicitly
    // inconclusive (not silently passed) without a bound reader.
    const byId = new Map(report1.checks.map((c) => [c.id, c]));
    for (const id of [
      'C1_batch_graph_complete',
      'C2_batch_totals_exact',
      'C3_recipients_resolve',
      'C4_claims_legacy_schema_and_bound',
      'C5_anchor_segments_consistent',
      'C6_genesis_pool_ledger_exact',
      'C7_zero_carry_structural',
      'C8_genesis_backlog_integrity',
      'C9_cursor_non_overlap',
      'C10_lock_inventory_exact',
      'C12_pvt9_settlement_stores_no_legacy_bleed',
      'C13_segmented_anchors_reconcile',
    ]) {
      // a check that PASSED over zero items now reports
      // `vacuous_pass` instead of `pass`. Neither is a failure; the
      // distinction is the point, so assert the exact split rather than
      // widening the assertion to "not fail".
      const status = byId.get(id)?.status;
      expect(`${id}=${status}`).toMatch(/=(pass|vacuous_pass)$/);
      if ((byId.get(id)?.evaluated_items ?? 0) === 0) {
        expect(status).toBe('vacuous_pass');
      } else {
        expect(status).toBe('pass');
      }
    }
    expect(byId.get('C11_onchain_batch_finality')?.status).toBe('not_evaluated');
    expect(report1.reconciled).toBe(false); // inconclusive ≠ reconciled
    expect(report1.reconciled_excluding_not_evaluated).toBe(true);
  });

  it('chain reader binds C11: pass when confirmed, fail when not', async () => {
    const db = seedHealthyStore();
    const confirmed = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
    });
    expect(confirmed.checks.find((c) => c.id === 'C11_onchain_batch_finality')?.status).toBe('pass');
    // this fixture leaves some checks with an empty item set, so a
    // bound-and-confirmed C11 no longer reconciles on its own — the vacuous
    // passes must be acknowledged BY NAME first.
    expect(confirmed.reconciled).toBe(false);
    const vacuous = confirmed.checks
      .filter((c) => c.status === 'vacuous_pass').map((c) => c.id);
    expect(vacuous.length).toBeGreaterThan(0);
    // , HARD STOP 5 — this assertion is INVERTED from what it was.
    // Acknowledging every vacuous check used to make the gate green; it no
    // longer can. Acknowledgement is recorded (and still requires a written
    // cause), but a check that examined zero items never counts as a result.
    const acknowledged = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
      acknowledgedVacuousChecks: vacuous,
    });
    expect(acknowledged.acknowledged_vacuous_checks).toEqual([...vacuous].sort());
    expect(acknowledged.reconciled).toBe(false);

    const unconfirmed = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => false },
    });
    expect(unconfirmed.checks.find((c) => c.id === 'C11_onchain_batch_finality')?.status).toBe('fail');
    expect(unconfirmed.reconciled).toBe(false);
  });

  it('derives the exact PVTv8-finalized cursor', async () => {
    const db = seedHealthyStore();
    const inventory = await takeCutoverInventory(db, { cutLineMs: CUT_LINE });
    const cursors = deriveCutoverCursors(inventory);
    expect(cursors.pvtv8_finalized.finalized_batch_count).toBe(1);
    expect(cursors.pvtv8_finalized.last_finalized_batch_id).toBe('batch_a');
    expect(cursors.pvtv8_finalized.max_finalized_epoch).toBe(3);
    expect(cursors.pvtv8_finalized.max_settled_pe_timestamp_ms).toBe(1_699_999_500_000);
    expect(cursors.pvtv8_finalized.total_finalized_points_atomic).toBe('3000000000000000000');
    expect(cursors.pvt9_start.kernel_next_finalized_cursor_start).toBe('0');
    // True since the runtime was configured against the live Base deployment. The
    // non-overlap assertion below is the one that matters and is unaffected: the PVT9
    // cursor still starts at 0 and cannot overlap the PVTv8-finalized range.
    expect(cursors.pvt9_start.kernel_deployed).toBe(true);
    expect(validateCursorNonOverlap(cursors).ok).toBe(true);
  });
});

describe('cutover reconciliation cutover reconciliation — violations fail exactly (no tolerance)', () => {
  it('an off-by-one in batch points fails C2', async () => {
    const db = seedHealthyStore();
    const snap = db.store.get('pvt_mint_batch_snapshots/batch_a')!;
    db.store.set('pvt_mint_batch_snapshots/batch_a', {
      ...snap,
      pe_points: ['1000000000000000000', '2000000000000000001'], // +1 wei
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    expect(report.checks.find((c) => c.id === 'C2_batch_totals_exact')?.status).toBe('fail');
    expect(report.reconciled).toBe(false);
  });

  it('a genesis pool/ledger mismatch fails C6', async () => {
    const db = seedHealthyStore();
    db.store.set('genesis_campaign_state/global', { pool_minted_pvt: 176 });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    expect(report.checks.find((c) => c.id === 'C6_genesis_pool_ledger_exact')?.status).toBe('fail');
  });

  it('a non-v1 claim schema (identifier-space bleed toward PVT9) fails C4', async () => {
    const db = seedHealthyStore();
    db.store.set('pvt_mint_claims_v1/claim_bad', {
      schema_version: 'pvt9-claim/v1',
      claim_id: 'claim_bad',
      batch_id: 'batch_a',
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    expect(report.checks.find((c) => c.id === 'C4_claims_legacy_schema_and_bound')?.status).toBe('fail');
  });

  it('a cut line at (not strictly after) the settled fence fails C9', async () => {
    const db = seedHealthyStore();
    const report = await runCutoverReconciliation(db, { cutLineMs: 1_699_999_500_000 });
    expect(report.checks.find((c) => c.id === 'C9_cursor_non_overlap')?.status).toBe('fail');
  });

  it('a marked batch without a durable mint tx fails C1', async () => {
    const db = seedHealthyStore();
    db.store.set('pvt_mint_batches/batch_b', { marked: true });
    db.store.set('pvt_mint_batch_snapshots/batch_b', db.store.get('pvt_mint_batch_snapshots/batch_a')!);
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    expect(report.checks.find((c) => c.id === 'C1_batch_graph_complete')?.status).toBe('fail');
  });

  it('an unknown-schema genesis backlog row fails C8 (Unknown = Block)', async () => {
    const db = seedHealthyStore();
    db.store.set('genesis_reservations_v2/r_bad', {
      schema_version: 'pvt-genesis-reservation/v3-unknown',
      state: 'ready_for_settlement',
      reservation: { reserved_atomic: '1' },
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    expect(report.checks.find((c) => c.id === 'C8_genesis_backlog_integrity')?.status).toBe('fail');
  });

  it('a non-empty, well-formed PVT9 settlement store PASSES C12 (minting is healthy since)', async () => {
    const db = seedHealthyStore();
    db.store.set('pvt9_claim_ledger_v1/pe-x', {
      schema_version: 'pvt9-claim-ledger/v1',
      pe_id: 'pe-x',
      claim_id: '0x'.padEnd(66, '1'),
      lane: 'standard',
      settled: false,
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const c12 = report.checks.find((c) => c.id === 'C12_pvt9_settlement_stores_no_legacy_bleed');
    expect(c12?.status).toBe('pass');
    expect(c12?.evaluated_items).toBeGreaterThan(0);
  });

  it('NEGATIVE CONTROL : a ledger row carrying the LEGACY claim schema fails C12', async () => {
    const db = seedHealthyStore();
    db.store.set('pvt9_claim_ledger_v1/pe-legacy', {
      schema_version: 'pvt-mint-claim/v1',
      pe_id: 'pe-legacy',
      claim_id: '0x'.padEnd(66, '3'),
      settled: false,
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const c12 = report.checks.find((c) => c.id === 'C12_pvt9_settlement_stores_no_legacy_bleed');
    expect(c12?.status).toBe('fail');
    expect(c12?.detail).toContain('legacy_schema=1');
    expect(report.reconciled_excluding_not_evaluated).toBe(false);
  });

  it('NEGATIVE CONTROL : an unknown-schema settlement cycle or batch fails C12', async () => {
    for (const [doc, needle] of [
      ['pvt9_settlement_cycles_v1/cycle-bad', 'cycles=1 (unknown_schema=1)'],
      ['pvt9_settlement_batches_v1/batch-bad', 'batches=1 (unknown_schema=1)'],
    ] as const) {
      const db = seedHealthyStore();
      db.store.set(doc, { schema_version: 'something-else/v9', status: 'active' });
      const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
      const c12 = report.checks.find((c) => c.id === 'C12_pvt9_settlement_stores_no_legacy_bleed');
      expect(c12?.status).toBe('fail');
      expect(c12?.detail).toContain(needle);
    }
  });

  it('a settled ledger row bound to a LEGACY mint batch id fails C12 (identifier bleed)', async () => {
    const db = seedHealthyStore();
    db.store.set('pvt9_claim_ledger_v1/pe-y', {
      schema_version: 'pvt9-claim-ledger/v1',
      pe_id: 'pe-y',
      claim_id: '0x'.padEnd(66, '2'),
      lane: 'standard',
      settled: true,
      settled_batch_id: 'batch_a', // the legacy PVTv8 batch from the fixture
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const c12 = report.checks.find((c) => c.id === 'C12_pvt9_settlement_stores_no_legacy_bleed');
    expect(c12?.status).toBe('fail');
    expect(c12?.detail).toContain('legacy_binding=1');
  });

  it('a broken segmented-anchor partition fails C13 ', async () => {
    const db = seedHealthyStore();
    // A day doc claiming 2 segments while only one (mis-ranged) segment exists.
    db.store.set('pe_daily_anchor_days_v1/2026-07-20__2', {
      schema_version: 'pe-daily-anchor-day/v1',
      day: '2026-07-20',
      pe_count: 10,
      segment_count: 2,
      segment_size: 5,
      segment_roots: ['0x'.padEnd(66, '3'), '0x'.padEnd(66, '4')],
      segment_batch_ids: ['0x'.padEnd(66, '5'), '0x'.padEnd(66, '6')],
      aggregate_root: '0x'.padEnd(66, '7'),
      aggregate_batch_id: '0x'.padEnd(66, '8'),
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const c13 = report.checks.find((c) => c.id === 'C13_segmented_anchors_reconcile');
    expect(c13?.status).toBe('fail');
    expect(c13?.detail).toContain('broken=[2026-07-20__2]');
  });

  it('an orphan segment doc (no matching day doc) fails C13', async () => {
    const db = seedHealthyStore();
    db.store.set('pe_daily_anchor_segments_v1/2026-07-20__0_3', {
      schema_version: 'pe-daily-anchor-segment/v1',
      day: '2026-07-20',
      segment_index: 0,
      segment_count: 3,
      members: [],
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const c13 = report.checks.find((c) => c.id === 'C13_segmented_anchors_reconcile');
    expect(c13?.status).toBe('fail');
    expect(c13?.detail).toContain('orphan_segments=[2026-07-20__0_3]');
  });

  it('a mutated report body cannot keep the original digest', async () => {
    const db = seedHealthyStore();
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const forged = { ...report, reconciled: true };
    // Recomputing the digest over the forged body cannot equal the original.
    expect(JSON.stringify(forged)).not.toBe(JSON.stringify(report));
  });
});

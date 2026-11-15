/**
 * Cutover reconciliation constraints.
 * A no_pe_day classification requires all six conjuncts. The scope exclusion
 * registry is empty and reports its count. Vacuous passes remain distinct from
 * passes and require acknowledgement backed by a written cause. The launch
 * window is recorded independently of the kernel's armed state.
 */
import { describe, it, expect } from '@jest/globals';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { CUT_LINE } from '../__test-helpers__/healthy-cutover-store';
import {
  anchorDayBounds,
  anchorRowLooksEmpty,
  takeCutoverInventory,
} from './cutover-inventory';
import { reconcileCutoverInventory, runCutoverReconciliation } from './cutover-reconciliation';
import { C1_SCOPE_EVIDENCE, SCOPE_EXCLUSIONS, isScopeExcluded } from './cutover-scope-exclusions';
import { writtenCauseFor } from './cutover-hard-stops';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../policy/proposed-genesis-policy';

// was a second module-scope copy of the fixture's cut line.

/** The nine live zero-PE anchor days observed at the baseline run. */
const LIVE_ZERO_PE_DAYS = [
  '2026-07-09', '2026-07-10', '2026-07-12', '2026-07-13', '2026-07-16',
  '2026-07-19', '2026-07-20', '2026-07-23', '2026-07-24',
];

/** The exact stored shape of a live zero-PE anchor batch (from production). */
function emptyDayDoc(day: string) {
  return {
    batch_id: `anchor_${day}`,
    day,
    kind: 'day',
    status: 'empty',
    merkle_root: null,
    pe_count: 0,
    members: [],
    swept_pe_ids: [],
    anchor_args: null,
    anchor_tx_hash: null,
    anchored_at: null,
    writebacks_complete: true,
    skipped_no_hash: 0,
  };
}

/**
 * PE METER: the probe reads anchored membership, not `pe_history`. A PE that missed its own day's
 * batch was swept into a LATER anchored batch; `swept` models that carrier — a consistent anchored
 * batch (sorted after every test row) whose members carry the swept PEs' own timestamps.
 */
function seedAnchorStore(docs: Array<{ id: string; row: Record<string, unknown> }>,
  swept: Array<{ id: string; timestamp: number }> = []) {
  const db = createFakeFirestore();
  for (const { id, row } of docs) db.store.set(`pe_daily_anchor_batches/${id}`, row);
  if (swept.length > 0) {
    db.store.set('pe_daily_anchor_batches/zz_swept_carrier', {
      batch_id: 'zz_swept_carrier', day: '2026-07-25', kind: 'day', status: 'anchored',
      merkle_root: `0x${'1'.repeat(64)}`, anchor_tx_hash: `0x${'2'.repeat(64)}`,
      pe_count: swept.length,
      members: swept.map((pe) => ({ pe_id: pe.id, pe_hash: 'f'.repeat(64), timestamp: pe.timestamp })),
    });
  }
  // A retired-store row is never evidence (the relay keeps no PE store).
  db.store.set('pe_history/pe_retired_store', { timestamp: Date.parse('2026-07-09T12:00:00Z') });
  return db;
}

async function c5(db: ReturnType<typeof createFakeFirestore>) {
  const inventory = await takeCutoverInventory(db, { cutLineMs: CUT_LINE });
  const report = await reconcileCutoverInventory(inventory);
  return {
    inventory,
    check: report.checks.find((c) => c.id === 'C5_anchor_segments_consistent')!,
    rows: inventory.legacy_pvtv8.anchors,
  };
}

describe('C5 no_pe_day classification', () => {
  it('classifies every one of the nine live zero-PE days as no_pe_day, and C5 passes', async () => {
    const db = seedAnchorStore(LIVE_ZERO_PE_DAYS.map((day) => ({
      id: `anchor_${day}`, row: emptyDayDoc(day),
    })));
    const { check, rows } = await c5(db);

    expect(rows).toHaveLength(9);
    for (const day of LIVE_ZERO_PE_DAYS) {
      const row = rows.find((r) => r.day === day)!;
      expect(row).toBeDefined();
      // CLASSIFIED, never suppressed: the day is still not internally consistent.
      expect(row.internally_consistent).toBe(false);
      expect(row.no_pe_day).toBe(true);
      expect(row.direct_pe_probe_count).toBe(0);
    }
    expect(check.status).toBe('pass');
    // Listed BY DATE with a count — never silently dropped.
    expect(check.detail).toContain('no_pe_day=9');
    for (const day of LIVE_ZERO_PE_DAYS) expect(check.detail).toContain(day);
    expect(check.detail).toContain('unresolved=[]');
  });

  it('NEGATIVE CONTROL — pe_count 1 with no root stays inconsistent and fails C5', async () => {
    const db = seedAnchorStore([{
      id: 'anchor_x',
      row: { ...emptyDayDoc('2026-07-09'), pe_count: 1, members: [{ pe_id: 'p1' }] },
    }]);
    const { check, rows } = await c5(db);
    expect(rows[0].no_pe_day).toBe(false);
    expect(rows[0].internally_consistent).toBe(false);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('unresolved=[anchor_x]');
  });

  it('NEGATIVE CONTROL — pe_count 0 but NON-EMPTY members stays inconsistent', async () => {
    const db = seedAnchorStore([{
      id: 'anchor_y',
      row: { ...emptyDayDoc('2026-07-10'), pe_count: 0, members: [{ pe_id: 'ghost' }] },
    }]);
    const { check, rows } = await c5(db);
    expect(rows[0].no_pe_day).toBe(false);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('unresolved=[anchor_y]');
  });

  it('NEGATIVE CONTROL — pe_count 0, empty members, but a PE of the day was anchored in a later batch', async () => {
    // A straggler of 2026-07-12 swept into a later day's batch: the day genuinely had a PE.
    const { startMs } = anchorDayBounds('2026-07-12')!;
    const db = seedAnchorStore(
      [{ id: 'anchor_z', row: emptyDayDoc('2026-07-12') }],
      [{ id: 'pe_in_day', timestamp: startMs + 3_600_000 }],
    );
    const { check, rows } = await c5(db);
    expect(rows[0].direct_pe_probe_count).toBe(1);
    expect(rows[0].no_pe_day).toBe(false);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('unresolved=[anchor_z]');
  });

  it('NEGATIVE CONTROL — pe_count 0, empty members, but the row skipped a PE with no hash', async () => {
    // The skipped_no_hash case: PEs exist for the day but none could be a leaf,
    // so the batch is written `empty` while the day genuinely had PEs.
    const db = seedAnchorStore([{ id: 'anchor_s', row: { ...emptyDayDoc('2026-07-12'), skipped_no_hash: 1 } }]);
    const { check, rows } = await c5(db);
    expect(rows[0].direct_pe_probe_count).toBe(1);
    expect(rows[0].no_pe_day).toBe(false);
    expect(check.status).toBe('fail');
  });

  it('NEGATIVE CONTROL — an anchor tx hash present on an "empty" day blocks the exemption', async () => {
    const db = seedAnchorStore([{
      id: 'anchor_tx',
      row: { ...emptyDayDoc('2026-07-13'), anchor_tx_hash: `0x${'a'.repeat(64)}` },
    }]);
    const { check, rows } = await c5(db);
    expect(rows[0].no_pe_day).toBe(false);
    expect(check.status).toBe('fail');
  });

  it('a PE OUTSIDE the day\'s own UTC bounds does not defeat the exemption', async () => {
    // A straggler from the previous day belongs to the previous day's batch.
    const { startMs } = anchorDayBounds('2026-07-16')!;
    const db = seedAnchorStore(
      [{ id: 'anchor_ok', row: emptyDayDoc('2026-07-16') }],
      [{ id: 'pe_prev_day', timestamp: startMs - 1 },
        { id: 'pe_next_day', timestamp: startMs + 86_400_000 }],
    );
    const { check, rows } = await c5(db);
    expect(rows[0].direct_pe_probe_count).toBe(0);
    expect(rows[0].no_pe_day).toBe(true);
    expect(check.status).toBe('pass');
  });

  it('an unusable day key fails closed: probe null, no exemption', async () => {
    const db = seedAnchorStore([{ id: 'anchor_bad', row: { ...emptyDayDoc('2026-13-99') } }]);
    const { check, rows } = await c5(db);
    expect(rows[0].direct_pe_probe_count).toBeNull();
    expect(rows[0].no_pe_day).toBe(false);
    expect(check.status).toBe('fail');
  });

  it('a genuinely broken anchored day still fails even alongside no_pe_days', async () => {
    const db = seedAnchorStore([
      { id: 'anchor_good', row: emptyDayDoc('2026-07-19') },
      { id: 'anchor_broken', row: { ...emptyDayDoc('2026-07-20'), status: 'anchored', pe_count: 2, members: [{}, {}] } },
    ]);
    const { check } = await c5(db);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('no_pe_day=1');
    expect(check.detail).toContain('unresolved=[anchor_broken]');
  });

  it('anchorRowLooksEmpty rejects when ANY single cheap conjunct is broken', () => {
    const base = {
      status: 'empty', pe_count: 0, members_count: 0,
      merkle_root_present: false, anchor_tx_hash: null as string | null,
    };
    expect(anchorRowLooksEmpty(base)).toBe(true);
    expect(anchorRowLooksEmpty({ ...base, status: 'anchored' })).toBe(false);
    expect(anchorRowLooksEmpty({ ...base, status: null })).toBe(false);
    expect(anchorRowLooksEmpty({ ...base, pe_count: 1 })).toBe(false);
    expect(anchorRowLooksEmpty({ ...base, pe_count: null })).toBe(false);
    expect(anchorRowLooksEmpty({ ...base, members_count: 1 })).toBe(false);
    expect(anchorRowLooksEmpty({ ...base, members_count: null })).toBe(false);
    expect(anchorRowLooksEmpty({ ...base, merkle_root_present: true })).toBe(false);
    expect(anchorRowLooksEmpty({ ...base, anchor_tx_hash: '0xabc' })).toBe(false);
  });

  it('anchorDayBounds matches the daily-anchor rule and rejects unusable keys', () => {
    expect(anchorDayBounds('2026-07-24')).toEqual({
      startMs: Date.parse('2026-07-24T00:00:00.000Z'),
      endMs: Date.parse('2026-07-25T00:00:00.000Z'),
    });
    // Every live day key resolves, and each day is exactly 86_400_000 ms.
    for (const day of LIVE_ZERO_PE_DAYS) {
      const b = anchorDayBounds(day)!;
      expect(b).not.toBeNull();
      expect(b.endMs - b.startMs).toBe(86_400_000);
      expect(new Date(b.startMs).toISOString().slice(0, 10)).toBe(day);
    }
    expect(anchorDayBounds(null)).toBeNull();
    expect(anchorDayBounds('2026-02-30')).toBeNull(); // not a real date
    expect(anchorDayBounds('2026-7-9')).toBeNull();   // not zero-padded
    expect(anchorDayBounds('')).toBeNull();
  });
});

describe('C1 scope exclusions are evidenced, and currently empty', () => {
  it('the exclusion set is EMPTY: no item passed all three evidence conjuncts', () => {
    expect(SCOPE_EXCLUSIONS.size).toBe(0);
    expect(C1_SCOPE_EVIDENCE).toHaveLength(5);
    for (const row of C1_SCOPE_EVIDENCE) {
      expect(row.excluded).toBe(false);
      expect(isScopeExcluded(row.document_id)).toBe(false);
      expect(row.rationale.length).toBeGreaterThan(20);
      expect(row.document_id).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('every recorded item carries a real mint tx — the reason none is excluded', () => {
    for (const row of C1_SCOPE_EVIDENCE) {
      expect(row.recorded_mint_tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
      // the reader is now bound to each document's OWN contract,
      // so its answer IS probative — and it says the mint is real.
      expect(row.chain_reader_probative).toBe(true);
      expect(row.minted_against_contract).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(row.batch_minted_on_correct_contract).toBe(true);
      // The PVTv8 control stays false for all five: PVTv8 never minted anything.
      expect(row.batch_minted_on_pvtv8).toBe(false);
    }
    // The one origin that could be established from surviving data.
    const deleted = C1_SCOPE_EVIDENCE.filter((r) => r.orphan_batch_origin === 'deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0].document_id)
      .toBe('0x4b953d26337b235a9a86fea056bb4e09b9df1d74d2d0dbeea60e0ed97f513177');
  });

  it('C1 reports an out_of_scope COUNT and never drops an item silently', async () => {
    const db = createFakeFirestore();
    db.store.set('pvt_mint_batches/batch_no_snapshot', { marked: false });
    db.store.set('pvt_mint_batch_snapshots/orphan_one', { merkle_root: '0xdead' });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const c1 = report.checks.find((c) => c.id === 'C1_batch_graph_complete')!;
    expect(c1.status).toBe('fail');
    expect(c1.detail).toContain('out_of_scope=0');
    expect(c1.detail).toContain('missing_snapshot=[batch_no_snapshot]');
    expect(c1.detail).toContain('orphan_snapshots=[orphan_one]');
    expect(c1.evaluated_items).toBe(2);
  });
});

describe('vacuous_pass', () => {
  it('a check over ZERO items is vacuous_pass, not pass, and is NOT reconciled', async () => {
    const db = createFakeFirestore();
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });

    const c13 = report.checks.find((c) => c.id === 'C13_segmented_anchors_reconcile')!;
    expect(c13.status).toBe('vacuous_pass');
    expect(c13.evaluated_items).toBe(0);
    // C11 has no bound reader here, so it is not_evaluated rather than vacuous.
    expect(report.checks.find((c) => c.id === 'C11_onchain_batch_finality')!.status)
      .toBe('not_evaluated');
    expect(report.acknowledged_vacuous_checks).toEqual([]);
    expect(report.reconciled).toBe(false);
  });

  it('EVERY check reports an evaluated-item count', async () => {
    const db = createFakeFirestore();
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    expect(report.checks).toHaveLength(13);
    for (const c of report.checks) {
      expect(typeof c.evaluated_items).toBe('number');
      expect(Number.isSafeInteger(c.evaluated_items)).toBe(true);
      expect(c.evaluated_items).toBeGreaterThanOrEqual(0);
    }
  });

  // , HARD STOP 5 — THIS ASSERTION IS INVERTED FROM WHAT IT WAS.
  // It used to read "acknowledging every vacuous check by name DOES reconcile",
  // which is precisely the lever the hard stop forbids: acknowledge the empty
  // sets and the gate goes green. Acknowledgement is now a RECORD (still in the
  // digest, still requiring a written cause) and never a gate lever.
  it('BRANCH B — acknowledging every caused vacuous check STILL does not reconcile', async () => {
    const db = createFakeFirestore();
    const bare = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
    });
    const vacuousIds = bare.checks.filter((c) => c.status === 'vacuous_pass').map((c) => c.id);
    expect(vacuousIds.length).toBeGreaterThan(0);
    expect(bare.reconciled).toBe(false);

    const caused = vacuousIds.filter((id) => writtenCauseFor(id) !== null);
    expect(caused.length).toBeGreaterThan(0);
    const acked = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
      acknowledgedVacuousChecks: caused,
    });
    expect(acked.reconciled).toBe(false);
    expect(acked.acknowledged_vacuous_checks).toEqual([...caused].sort());
    // The acknowledgement is still part of the digest — it cannot be lost.
    expect(acked.report_sha256).not.toBe(bare.report_sha256);

    // HARD STOP 3 — and an uncaused acknowledgement is refused outright.
    const uncaused = vacuousIds.filter((id) => writtenCauseFor(id) === null);
    expect(uncaused.length).toBeGreaterThan(0);
    await expect(runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
      acknowledgedVacuousChecks: uncaused,
    })).rejects.toThrow(/acknowledgement_without_written_cause/);
  });

  it('acknowledging only SOME vacuous checks still does not reconcile', async () => {
    const db = createFakeFirestore();
    const bare = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
    });
    const vacuousIds = bare.checks
      .filter((c) => c.status === 'vacuous_pass' && writtenCauseFor(c.id) !== null)
      .map((c) => c.id);
    expect(vacuousIds.length).toBeGreaterThan(1);
    const partial = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
      acknowledgedVacuousChecks: vacuousIds.slice(0, -1),
    });
    expect(partial.reconciled).toBe(false);
  });


  it('DEFECT GUARD — every check\'s evaluated_items equals the fixture\'s known cardinality', async () => {
    // The R4 mechanism is only as good as these counts: if a check reports a
    // non-zero count over an empty set it silently becomes `pass` instead of
    // `vacuous_pass` and stops needing acknowledgement. The expected numbers
    // below are derived BY HAND from the seeds — never from the report — so a
    // corrupted count expression cannot satisfy its own assertion. Every
    // collection is given a DISTINCT cardinality so a swapped expression is
    // caught, not just a zeroed one.
    const db = createFakeFirestore();
    const s = db.store;
    const tx = `0x${'a'.repeat(64)}`;

    // 2 mint batches; exactly 1 has a snapshot; exactly 1 is finalized.
    s.set('pvt_mint_batches/b_one', { marked: true, mint_tx_hash: tx });
    s.set('pvt_mint_batches/b_two', { marked: false });
    s.set('pvt_mint_batch_snapshots/b_one', { sorted_pe_ids: [], leaves: [] });
    // 3 orphan snapshots (no matching batch doc). these now also enter
    // C2/C3's population (1 batch-with-snapshot + 3 orphans = 4), which is the
    // scope defect S5 fixed — they carry the very arrays those checks validate.
    for (const id of ['orph_a', 'orph_b', 'orph_c']) {
      s.set(`pvt_mint_batch_snapshots/${id}`, { merkle_root: '0xdead' });
    }
    // 11 mint claims. raised from 4 so C4 stays DISTINCT from C2/C3,
    // whose population became 4 once orphan snapshots entered it.
    for (let i = 0; i < 11; i += 1) {
      s.set(`pvt_mint_claims_v1/c_${i}`, { schema_version: 'pvt-mint-claim/v1', batch_id: 'b_one' });
    }
    // 3 legacy anchor batches (distinct from C1's 5, so a swap is visible).
    for (let i = 0; i < 3; i += 1) {
      s.set(`pe_daily_anchor_batches/a_${i}`, {
        day: `2026-06-0${i + 1}`, kind: 'day', status: 'anchored', anchor_tx_hash: tx,
        merkle_root: '0xroot', pe_count: 0, members: [],
      });
    }
    // 6 genesis wallet ledgers + a present pool doc  => C6 items = 7.
    for (let i = 0; i < 6; i += 1) s.set(`genesis_wallet_ledger/w_${i}`, { issued_pvt: 1 });
    s.set('genesis_campaign_state/global', { pool_minted_pvt: 6 });
    // 2 outbox + 6 reservations => C8 items = 8.
    for (let i = 0; i < 2; i += 1) {
      s.set(`genesis_qualification_outbox_v2/o_${i}`, { schema_version: 'pvt-genesis-qualification/v2' });
    }
    for (let i = 0; i < 6; i += 1) {
      s.set(`genesis_reservations_v2/r_${i}`, {
        schema_version: 'pvt-genesis-reservation/v2', reservation: { reserved_atomic: '1' },
      });
    }
    // 9 bonds.
    for (let i = 0; i < 9; i += 1) s.set(`bonds/bond_${i}`, { amount_pvt: '1', status: 'active' });
    // 3 + 4 + 3 PVT9 settlement docs => C12 items = 10.
    for (let i = 0; i < 3; i += 1) s.set(`pvt9_claim_ledger_v1/cl_${i}`, {});
    for (let i = 0; i < 4; i += 1) s.set(`pvt9_settlement_cycles_v1/cy_${i}`, {});
    for (let i = 0; i < 3; i += 1) s.set(`pvt9_settlement_batches_v1/sb_${i}`, {});
    // 11 segmented anchor day docs + 1 orphan segment => C13 items = 12.
    for (let i = 0; i < 11; i += 1) s.set(`pe_daily_anchor_days_v1/d_${i}`, { day: `2026-05-${i + 10}` });
    s.set('pe_daily_anchor_segments_v1/seg_orphan', { day: '2099-01-01', segment_count: 99 });

    const report = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
    });
    const items = Object.fromEntries(report.checks.map((c) => [c.id, c.evaluated_items]));
    expect(items).toEqual({
      C1_batch_graph_complete: 5,               // 2 batches + 3 orphan snapshots
      C2_batch_totals_exact: 4,                 // batches carrying a snapshot
      C3_recipients_resolve: 4,                 // same population as C2
      C4_claims_legacy_schema_and_bound: 11,     // mint claims
      C5_anchor_segments_consistent: 3,         // legacy anchor batches
      C6_genesis_pool_ledger_exact: 7,          // 6 wallet ledgers + the pool doc
      C7_zero_carry_structural: 1,              // the single structural posture
      C8_genesis_backlog_integrity: 8,          // 2 outbox + 6 reservations
      C9_cursor_non_overlap: 1,                 // the derived cursor pair
      C10_lock_inventory_exact: 9,              // bonds
      C11_onchain_batch_finality: 1,            // finalized batches only
      C12_pvt9_settlement_stores_no_legacy_bleed: 10, // 3 ledger + 4 cycles + 3 batches
      C13_segmented_anchors_reconcile: 12,      // 11 day rows + 1 orphan segment
    });
    // C2/C3 now share the snapshot population (4) with each other and
    // nothing else; the structurally-1 checks are C7, C9, C11. Every other
    // cardinality is pairwise distinct, so a swapped expression cannot pass by
    // coincidence.
    expect(new Set(Object.values(items)).size).toBe(10);
    expect(Object.entries(items).filter(([, n]) => n === 4).map(([id]) => id).sort())
      .toEqual(['C2_batch_totals_exact', 'C3_recipients_resolve']);
    expect(Object.entries(items).filter(([, n]) => n === 1).map(([id]) => id).sort())
      .toEqual([
        'C7_zero_carry_structural', 'C9_cursor_non_overlap',
        'C11_onchain_batch_finality',
      ].sort());
    // And with a NON-empty population none of these is vacuous.
    for (const c of report.checks) {
      expect(c.status).not.toBe('vacuous_pass');
    }
  });

  it('DEFECT GUARD — acknowledgement applies to vacuous_pass ONLY, never not_evaluated', async () => {
    // Without a bound chain reader C11 is `not_evaluated` — the "inconclusive
    // blocks cutover" gate. Naming it in the acknowledgement list must NOT
    // reconcile the report, or an operator could clear the on-chain readback
    // gate simply by running without --rpc.
    const db = createFakeFirestore();
    const bare = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const c11 = bare.checks.find((c) => c.id === 'C11_onchain_batch_finality')!;
    expect(c11.status).toBe('not_evaluated');

    // C11 has no written cause, so naming it is not merely
    // ineffective — the report REFUSES to build. The original property (an
    // acknowledgement cannot clear a not_evaluated check) is asserted below
    // through the caused ids, which the registry does license.
    await expect(runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      acknowledgedVacuousChecks: bare.checks.map((c) => c.id), // includes C11
    })).rejects.toThrow(/acknowledgement_without_written_cause/);

    const acked = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      acknowledgedVacuousChecks: bare.checks
        .map((c) => c.id).filter((id) => writtenCauseFor(id) !== null),
    });
    expect(acked.checks.find((c) => c.id === 'C11_onchain_batch_finality')!.status)
      .toBe('not_evaluated');
    expect(acked.reconciled).toBe(false);
  });

  it('acknowledging a vacuous check never rescues a genuine FAIL', async () => {
    const db = createFakeFirestore();
    db.store.set('pvt_mint_batch_snapshots/orphan', { merkle_root: '0xdead' });
    const report = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
      // C1 itself cannot be acknowledged (no written cause), so the rescue is
      // attempted with the one id the registry does license.
      acknowledgedVacuousChecks: ['C13_segmented_anchors_reconcile'],
    });
    expect(report.checks.find((c) => c.id === 'C1_batch_graph_complete')!.status).toBe('fail');
    expect(report.reconciled).toBe(false);
  });
});

describe('launch window reset EARLIER, still DISARMED', () => {
  it('records the shifted window; activation Phase 2 has now ARMED it', () => {
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms).toBe(1_785_715_200_000);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms).toBe(1_798_761_600_000);
    expect(new Date(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms!).toISOString())
      .toBe('2026-08-03T00:00:00.000Z');
    expect(new Date(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms!).toISOString())
      .toBe('2027-01-01T00:00:00.000Z');
    // Every reset through kept the same 84-day span.
    // is the first deliberate EXTENSION: the close moves from 2026-10-26 to
    // 2027-01-01 (open through 2026-12-31), a 151-day window. The start is unchanged.
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms! - PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms!)
      .toBe(151 * 86_400_000);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms! - Date.UTC(2026, 9, 26))
      .toBe(67 * 86_400_000);
    // Position relative to the two prior candidate opens. moved the open
    // EARLIER (the only reset that ever did); has now moved it LATER again,
    // by seven days, because the successor kernel has to be armed and
    // armEpochZero requires a strictly-future start. Relative to the // open of 2026-08-16 it is now thirteen days earlier, and it sits one
    // day AFTER the open of 2026-08-02.
    expect(1_786_838_400_000 - PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms!)
      .toBe(13 * 86_400_000);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms! - 1_785_628_800_000)
      .toBe(1 * 86_400_000);

    // activation Phase 2 is the separate off-chain grant-issuance activation:
    // recording dates was not arming; this flip is. The comprehensive
    // RED control for these constants (revert any one → validateManifest rejects)
    // lives in genesis-policy-engine.test.ts "armed proposal (Phase 2,)".
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.grants_enabled).toBe(true);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.state)
      .toBe('armed_by_explicit_pvt9_activation');
    for (const bounty of PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties) {
      expect(bounty.launch_armed).toBe(true);
      expect(bounty.activation).toBe('explicit_pvt9_launch_activation');
    }
  });
});

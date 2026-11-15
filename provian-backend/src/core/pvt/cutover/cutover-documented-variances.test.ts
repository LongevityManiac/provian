/**
 * the reconciliation stops fouling on a healthy system, and a real
 * failure still fails.
 *
 * Two halves, both required:
 * 1. The production-shaped state (C1's five evidenced legacy documents, C6's
 * pinned pool/ledger delta with both downgrade proofs, the one retired C8
 * stub, a populated PVT9 settlement store) reports ZERO failing checks.
 * 2. NEGATIVE CONTROLS: every departure from the pinned evidence — one more
 * C1 document, one fewer, a phantom-mint batch, a moved C6 delta, a lost
 * downgrade proof, an edited stub, the stub's content under another id, a
 * second unknown-schema row — is reported `fail`.
 *
 * The suite binds to the ONE evidence source (`C1_SCOPE_EVIDENCE`,
 * `C6_DOCUMENTED_VARIANCE`, `RETIRED_GENESIS_BACKLOG_STUBS`) and never declares
 * its own copy of it.
 */
import { describe, it, expect } from '@jest/globals';
import {
  CUT_LINE,
  seedHealthyCutoverStore,
} from '../__test-helpers__/healthy-cutover-store';
import type { C6DowngradeVerdict } from './c6-downgrade-evidence';
import {
  C6_DOCUMENTED_VARIANCE,
  RETIRED_GENESIS_BACKLOG_STUBS,
  expectedC1Populations,
  isRetiredBacklogStub,
  judgeC1,
  judgeC6,
  type C1EvidenceRowLike,
} from './cutover-documented-variances';
import { C1_SCOPE_EVIDENCE } from './cutover-scope-exclusions';
import { runCutoverReconciliation } from './cutover-reconciliation';

const ELIGIBLE: C6DowngradeVerdict = {
  cleanup_script_removed: true,
  all_writers_monotonic_or_gated: true,
  reducers: [],
  downgrade_eligible: true,
  detail: 'fixture: both proofs hold',
};
const INELIGIBLE: C6DowngradeVerdict = {
  ...ELIGIBLE,
  cleanup_script_removed: false,
  downgrade_eligible: false,
  detail: 'fixture: proof (a) lost',
};

const STUB = RETIRED_GENESIS_BACKLOG_STUBS[0];
const PINNED = C6_DOCUMENTED_VARIANCE.observed;

/** Put the production state the run observed into a healthy store. */
function seedProductionShapedStore() {
  const db = seedHealthyCutoverStore();
  const s = db.store;
  const { missingSnapshot, orphans } = expectedC1Populations();
  const snapshotA = s.get('pvt_mint_batch_snapshots/batch_a')!;
  for (const id of missingSnapshot) {
    // Pre-snapshot-era inline schema: durable finality recorded as `tx_hash`.
    s.set(`pvt_mint_batches/${id}`, {
      tx_hash: '0x'.padEnd(66, 'e'),
      merkle_root: '0x'.padEnd(66, 'f'),
      total_pvt_minted: 1,
    });
  }
  for (const id of orphans) {
    s.set(`pvt_mint_batch_snapshots/${id}`, { ...snapshotA, batch_id: id });
  }
  // The pinned legacy Genesis totals (6 ledgers whose sum is the ledger total).
  s.delete('genesis_wallet_ledger/wallet_h');
  s.delete('genesis_wallet_ledger/wallet_a');
  s.set('genesis_campaign_state/global', { pool_minted_pvt: PINNED.pool_minted_pvt });
  s.set('genesis_wallet_ledger/l_0', { issued_pvt: PINNED.wallet_ledger_issued_total_pvt });
  for (let i = 1; i < PINNED.wallet_ledger_count; i += 1) {
    s.set(`genesis_wallet_ledger/l_${i}`, { issued_pvt: 0 });
  }
  // The retired stub, exactly.
  s.set(`${STUB.collection}/${STUB.document_id}`, { ...STUB.exact_content });
  // A populated, well-formed PVT9 settlement store (minting since).
  s.set('pvt9_claim_ledger_v1/pe-x', {
    schema_version: 'pvt9-claim-ledger/v1', pe_id: 'pe-x', settled: true, settled_batch_id: '0x99',
  });
  s.set('pvt9_settlement_cycles_v1/cy-1', { schema_version: 'pvt9-settlement-cycle/v1', status: 'completed' });
  s.set('pvt9_settlement_batches_v1/sb-1', { schema_version: 'pvt9-settlement-batch/v1', status: 'confirmed' });
  return db;
}

function statusOf(
  report: Awaited<ReturnType<typeof runCutoverReconciliation>>,
  id: string,
): string | undefined {
  return report.checks.find((c) => c.id === id)?.status;
}

describe(' · a healthy production-shaped system reports ZERO failures', () => {
  it('C1/C6 documented variance, C8 and C12 pass, nothing fails', async () => {
    const db = seedProductionShapedStore();
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    const failing = report.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.detail}`);
    expect(failing).toEqual([]);
    expect(statusOf(report, 'C1_batch_graph_complete')).toBe('documented_variance');
    expect(statusOf(report, 'C6_genesis_pool_ledger_exact')).toBe('documented_variance');
    expect(statusOf(report, 'C8_genesis_backlog_integrity')).toBe('pass');
    expect(statusOf(report, 'C12_pvt9_settlement_stores_no_legacy_bleed')).toBe('pass');
    expect(report.checks.find((c) => c.id === 'C8_genesis_backlog_integrity')?.detail)
      .toContain(`retired_stubs=1 [${STUB.document_id}]`);
    expect(report.reconciled_excluding_not_evaluated).toBe(true);
    // A documented variance is not a pass: `reconciled` stays strict.
    expect(report.reconciled).toBe(false);
  });
});

describe(' · NEGATIVE CONTROLS — a real failure still fails', () => {
  it('C1: a sixth unexplained batch without a snapshot fails', async () => {
    const db = seedProductionShapedStore();
    db.store.set('pvt_mint_batches/0xsixth', { tx_hash: '0x'.padEnd(66, '9') });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    expect(statusOf(report, 'C1_batch_graph_complete')).toBe('fail');
    expect(report.reconciled_excluding_not_evaluated).toBe(false);
  });

  it('C1: one of the five repaired (four left) fails — the pin is exact, not a ceiling', async () => {
    const db = seedProductionShapedStore();
    const [first] = expectedC1Populations().orphans;
    db.store.delete(`pvt_mint_batch_snapshots/${first}`);
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    expect(statusOf(report, 'C1_batch_graph_complete')).toBe('fail');
  });

  it('C1: a marked-without-tx batch (phantom mint) fails even beside the five', async () => {
    const db = seedProductionShapedStore();
    db.store.set('pvt_mint_batches/batch_b', { marked: true });
    db.store.set('pvt_mint_batch_snapshots/batch_b', db.store.get('pvt_mint_batch_snapshots/batch_a')!);
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    expect(statusOf(report, 'C1_batch_graph_complete')).toBe('fail');
  });

  it('C6: a delta moved by one micro-PVT fails', async () => {
    const db = seedProductionShapedStore();
    db.store.set('genesis_campaign_state/global', { pool_minted_pvt: PINNED.pool_minted_pvt - 0.000001 });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    expect(statusOf(report, 'C6_genesis_pool_ledger_exact')).toBe('fail');
  });

  it('C6: the pinned delta without BOTH downgrade proofs fails (absent or ineligible)', async () => {
    for (const downgrade of [INELIGIBLE, null, undefined]) {
      const db = seedProductionShapedStore();
      const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: downgrade });
      expect(statusOf(report, 'C6_genesis_pool_ledger_exact')).toBe('fail');
    }
  });

  it('C8: the stub with one changed value is an unknown-schema row and fails', async () => {
    const db = seedProductionShapedStore();
    db.store.set(`${STUB.collection}/${STUB.document_id}`, { ...STUB.exact_content, status: 'complete' });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    expect(statusOf(report, 'C8_genesis_backlog_integrity')).toBe('fail');
  });

  it('C8: the stub with one added field fails', async () => {
    const db = seedProductionShapedStore();
    db.store.set(`${STUB.collection}/${STUB.document_id}`, { ...STUB.exact_content, reserved_atomic: '1' });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    expect(statusOf(report, 'C8_genesis_backlog_integrity')).toBe('fail');
  });

  it('C8: the stub content under ANOTHER id fails', async () => {
    const db = seedProductionShapedStore();
    db.store.set(`${STUB.collection}/gq_another`, { ...STUB.exact_content });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    expect(statusOf(report, 'C8_genesis_backlog_integrity')).toBe('fail');
  });

  it('C8: a second unknown-schema reservation fails beside the retired stub', async () => {
    const db = seedProductionShapedStore();
    db.store.set('genesis_reservations_v2/r_bad', {
      schema_version: 'pvt-genesis-reservation/v3-unknown',
      reservation: { reserved_atomic: '1' },
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    expect(statusOf(report, 'C8_genesis_backlog_integrity')).toBe('fail');
  });

  it('C12: a legacy-schema ledger row fails beside a healthy populated store', async () => {
    const db = seedProductionShapedStore();
    db.store.set('pvt9_claim_ledger_v1/pe-legacy', { schema_version: 'pvt-mint-claim/v1', settled: false });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, c6Downgrade: ELIGIBLE });
    expect(statusOf(report, 'C12_pvt9_settlement_stores_no_legacy_bleed')).toBe('fail');
  });
});

describe(' · the pure judges, over the whole domain of each pin', () => {
  const five = expectedC1Populations();

  it('judgeC1', () => {
    const exact = { missingSnapshot: five.missingSnapshot, markedWithoutTx: [], orphans: five.orphans };
    expect(judgeC1({ missingSnapshot: [], markedWithoutTx: [], orphans: [] })).toBe('pass');
    expect(judgeC1(exact)).toBe('documented_variance');
    expect(judgeC1({ ...exact, orphans: [...five.orphans].reverse() })).toBe('documented_variance');
    expect(judgeC1({ ...exact, orphans: [...five.orphans, '0xnew'] })).toBe('fail');
    expect(judgeC1({ ...exact, orphans: five.orphans.slice(1) })).toBe('fail');
    expect(judgeC1({ ...exact, markedWithoutTx: ['0xphantom'] })).toBe('fail');
    // Swapping populations is not the same evidence.
    expect(judgeC1({ missingSnapshot: five.orphans, markedWithoutTx: [], orphans: five.missingSnapshot }))
      .toBe('fail');
    // A non-probative evidence table vouches for nothing.
    const unprobative: C1EvidenceRowLike[] = C1_SCOPE_EVIDENCE.map((row) => ({
      ...row, chain_reader_probative: false,
    }));
    expect(judgeC1(exact, unprobative)).toBe('fail');
    expect(judgeC1(exact, [])).toBe('fail');
  });

  it('judgeC6', () => {
    const pool = PINNED.pool_minted_pvt;
    const ledger = PINNED.wallet_ledger_issued_total_pvt;
    const n = PINNED.wallet_ledger_count;
    expect(judgeC6(175, 175, 2, null)).toBe('pass');
    expect(judgeC6(null, 0, 0, null)).toBe('pass');
    expect(judgeC6(pool, ledger, n, ELIGIBLE)).toBe('documented_variance');
    // Both counters moved together by a grant: the delta survives float noise.
    expect(judgeC6(pool + 25, ledger + 25, n + 1, ELIGIBLE)).toBe('documented_variance');
    expect(judgeC6(pool + 25, ledger + 25.000001, n + 1, ELIGIBLE)).toBe('fail');
    expect(judgeC6(pool, ledger, n, INELIGIBLE)).toBe('fail');
    expect(judgeC6(pool, ledger, n, null)).toBe('fail');
    expect(judgeC6(ledger, pool, n, ELIGIBLE)).toBe('fail'); // the sign matters
    expect(judgeC6(null, ledger, n, ELIGIBLE)).toBe('fail');
    expect(judgeC6(Number.NaN, ledger, n, ELIGIBLE)).toBe('fail');
  });

  it('isRetiredBacklogStub', () => {
    expect(RETIRED_GENESIS_BACKLOG_STUBS).toHaveLength(1);
    const row = { ...STUB.exact_content };
    expect(isRetiredBacklogStub(STUB.collection, STUB.document_id, row)).toBe(true);
    expect(isRetiredBacklogStub(STUB.collection, `${STUB.document_id}x`, row)).toBe(false);
    expect(isRetiredBacklogStub('genesis_reservations_v2', STUB.document_id, row)).toBe(false);
    expect(isRetiredBacklogStub(STUB.collection, STUB.document_id, { ...row, extra: 1 })).toBe(false);
    expect(isRetiredBacklogStub(STUB.collection, STUB.document_id, { ...row, updated_at_ms: 1 })).toBe(false);
    const { status: _status, ...missing } = row;
    expect(isRetiredBacklogStub(STUB.collection, STUB.document_id, missing)).toBe(false);
  });
});

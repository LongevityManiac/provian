/**
 * the standard-lane first-mint gate's controls.
 *
 * Every refusal reason is produced by a DELIBERATELY violating input derived
 * from a known-admitting report by single-field perturbation, so no branch is
 * asserted only in the direction it happens to sit today. The
 * evidenced-variance admit path binds to `C1_SCOPE_EVIDENCE` the ONE
 * evidence table — never to a copy of the five ids.
 *
 * The suite also enforces the SINGLE ADMIT ROUTE by source scan: the only
 * production call site of `judgeStandardLaneAdmission` is
 * `operator-runtime.ts`, and `testOnlyAdmittedStandardLaneVerdict` never
 * appears in production `src/` outside this module's own file.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync, type Dirent } from 'fs';
import * as path from 'path';
import { C1_SCOPE_EVIDENCE } from '../wp11/cutover-scope-exclusions';
import {
  JUDGEABLE_REPORT_SCHEMA,
  evidencePinsProbative,
  expectedC1Populations,
  judgeStandardLaneAdmission,
  recomputeReportSha256,
  testOnlyAdmittedStandardLaneVerdict,
  type LoadedReconciliationReport,
  type StandardLaneAdmission,
} from './standard-lane-recon-gate';

const RUNTIME_HEAD = 'a'.repeat(40);

/** Wrap a raw report the way the loader would deliver it. */
function loaded(report: unknown): LoadedReconciliationReport {
  return { kind: 'loaded', report };
}

/**
 * A minimal ADMITTING v6 report (all three checks pass), digest-sealed the
 * same way `reconcileCutoverInventory` seals a real one.
 */
function admittingReport(overrides?: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schema_version: JUDGEABLE_REPORT_SCHEMA,
    cut_line_ms: 1_784_938_132_043,
    inventory: {
      legacy_pvtv8: {
        mint_batches: [
          { batch_id: '0xok', has_snapshot: true, marked: true, mint_tx_hash: '0xtx' },
        ],
        orphan_snapshot_batch_ids: [],
      },
    },
    cursors: {},
    checks: [
      { id: 'C1_batch_graph_complete', status: 'pass', evaluated_items: 1, detail: 't' },
      { id: 'C3_recipients_resolve', status: 'pass', evaluated_items: 3, detail: 't' },
      { id: 'C6_genesis_pool_ledger_exact', status: 'pass', evaluated_items: 7, detail: 't' },
    ],
    bound_tree: { git_head: RUNTIME_HEAD, tree_dirty: false },
    c6_downgrade: null,
    acknowledged_vacuous_checks: [],
    reconciled: false,
    reconciled_excluding_not_evaluated: false,
    ...overrides,
  };
  const sha = recomputeReportSha256(body);
  if (sha === null) throw new Error('fixture unserializable');
  return { ...body, report_sha256: sha };
}

/** Replace one check row by id, resealing the digest. */
function withCheck(
  report: Record<string, unknown>,
  id: string,
  row: Record<string, unknown> | null,
): Record<string, unknown> {
  const { report_sha256: _sha, ...body } = report;
  const checks = (body.checks as Array<Record<string, unknown>>)
    .filter((c) => c.id !== id);
  if (row !== null) checks.push({ id, ...row });
  const next = { ...body, checks };
  const sha = recomputeReportSha256(next);
  if (sha === null) throw new Error('fixture unserializable');
  return { ...next, report_sha256: sha };
}

/**
 * The report that matches TODAY'S real state: C1 reports a documented variance
 * on the evidenced five (; before v6 this was a `fail` row).
 */
function evidencedVarianceReport(): Record<string, unknown> {
  const expected = expectedC1Populations();
  const batches: Array<Record<string, unknown>> = [
    { batch_id: '0xok', has_snapshot: true, marked: true, mint_tx_hash: '0xtx' },
    ...expected.missingSnapshot.map((id) => (
      { batch_id: id, has_snapshot: false, marked: true, mint_tx_hash: '0xtx' })),
  ];
  const base = admittingReport({
    inventory: {
      legacy_pvtv8: {
        mint_batches: batches,
        orphan_snapshot_batch_ids: [...expected.orphans],
      },
    },
  });
  return withCheck(base, 'C1_batch_graph_complete',
    { status: 'documented_variance', evaluated_items: 5, detail: 'five evidenced items' });
}

function refusalOf(verdict: StandardLaneAdmission): string {
  if (verdict.admitted) throw new Error('expected a refusal, got an admit');
  return verdict.reason;
}

describe(' · the standard-lane gate refuses today\'s unreconciled state', () => {
  it('RED — no published report refuses report_absent', () => {
    const verdict = judgeStandardLaneAdmission({ kind: 'absent' }, RUNTIME_HEAD);
    expect(refusalOf(verdict)).toBe('report_absent');
  });

  it('RED — an unstamped runtime refuses even with a perfect report', () => {
    const verdict = judgeStandardLaneAdmission(loaded(admittingReport()), null);
    expect(refusalOf(verdict)).toBe('runtime_tree_unstamped');
  });

  it('RED — a v4-era report (no tree binding, the db93daf6/d0f899af shape) is UNKNOWN, not judged', () => {
    const v4 = admittingReport();
    const { report_sha256: _sha, ...body } = v4;
    const asV4 = { ...body, schema_version: 'pvt-cutover-reconciliation/v4' };
    const sha = recomputeReportSha256(asV4);
    const verdict = judgeStandardLaneAdmission(loaded({ ...asV4, report_sha256: sha }), RUNTIME_HEAD);
    expect(refusalOf(verdict)).toBe('report_schema_unsupported');
  });
});

describe(' · every refusal reason is reachable by one violating input', () => {
  it('unparseable loader result → report_unparseable', () => {
    expect(refusalOf(judgeStandardLaneAdmission(
      { kind: 'unparseable', detail: 'bad json' }, RUNTIME_HEAD,
    ))).toBe('report_unparseable');
    expect(refusalOf(judgeStandardLaneAdmission(loaded('not-an-object'), RUNTIME_HEAD)))
      .toBe('report_unparseable');
  });

  it('a tampered body no longer matches its stored digest', () => {
    const report = admittingReport();
    const tampered = { ...report, cut_line_ms: 1 };
    expect(refusalOf(judgeStandardLaneAdmission(loaded(tampered), RUNTIME_HEAD)))
      .toBe('report_digest_mismatch');
  });

  it('a tampered stored sha no longer matches its body', () => {
    const report = admittingReport();
    const flipped = { ...report, report_sha256: `0${String(report.report_sha256).slice(1)}` };
    expect(refusalOf(judgeStandardLaneAdmission(loaded(flipped), RUNTIME_HEAD)))
      .toBe('report_digest_mismatch');
  });

  it('no tree binding / malformed head / dirty tree each refuse by name', () => {
    expect(refusalOf(judgeStandardLaneAdmission(
      loaded(admittingReport({ bound_tree: null })), RUNTIME_HEAD,
    ))).toBe('report_tree_unbound');
    expect(refusalOf(judgeStandardLaneAdmission(
      loaded(admittingReport({ bound_tree: { git_head: 'HEAD', tree_dirty: false } })), RUNTIME_HEAD,
    ))).toBe('report_tree_unbound');
    expect(refusalOf(judgeStandardLaneAdmission(
      loaded(admittingReport({ bound_tree: { git_head: RUNTIME_HEAD, tree_dirty: true } })), RUNTIME_HEAD,
    ))).toBe('report_tree_dirty');
  });

  it('a report bound to a DIFFERENT commit than the runtime is STALE', () => {
    const report = admittingReport({ bound_tree: { git_head: 'b'.repeat(40), tree_dirty: false } });
    expect(refusalOf(judgeStandardLaneAdmission(loaded(report), RUNTIME_HEAD)))
      .toBe('report_stale_tree');
  });

  it('a missing judged check is UNKNOWN (check_missing), never a pass', () => {
    const report = withCheck(admittingReport(), 'C3_recipients_resolve', null);
    expect(refusalOf(judgeStandardLaneAdmission(loaded(report), RUNTIME_HEAD)))
      .toBe('check_missing');
  });

  it('C3 failing — or vacuously passing — refuses', () => {
    expect(refusalOf(judgeStandardLaneAdmission(loaded(withCheck(
      admittingReport(), 'C3_recipients_resolve',
      { status: 'fail', evaluated_items: 3, detail: 't' },
    )), RUNTIME_HEAD))).toBe('c3_failing');
    expect(refusalOf(judgeStandardLaneAdmission(loaded(withCheck(
      admittingReport(), 'C3_recipients_resolve',
      { status: 'vacuous_pass', evaluated_items: 0, detail: 't' },
    )), RUNTIME_HEAD))).toBe('c3_failing');
  });

  it('C6: a documented variance without a held downgrade refuses; with it, it admits as documented_variance', () => {
    const noDowngrade = withCheck(admittingReport(), 'C6_genesis_pool_ledger_exact',
      { status: 'documented_variance', evaluated_items: 7, detail: 'pool != ledger' });
    expect(refusalOf(judgeStandardLaneAdmission(loaded(noDowngrade), RUNTIME_HEAD)))
      .toBe('c6_failing');

    const withIneligible = withCheck(admittingReport({
      c6_downgrade: { downgrade_eligible: false, reducers: ['x'], detail: 't' },
    }), 'C6_genesis_pool_ledger_exact',
    { status: 'documented_variance', evaluated_items: 7, detail: 'pool != ledger' });
    expect(refusalOf(judgeStandardLaneAdmission(loaded(withIneligible), RUNTIME_HEAD)))
      .toBe('c6_failing');

    const withDowngrade = withCheck(admittingReport({
      c6_downgrade: {
        cleanup_script_removed: true,
        all_writers_monotonic_or_gated: true,
        reducers: [],
        downgrade_eligible: true,
        detail: 't',
      },
    }), 'C6_genesis_pool_ledger_exact',
    { status: 'documented_variance', evaluated_items: 7, detail: 'pool != ledger' });
    const verdict = judgeStandardLaneAdmission(loaded(withDowngrade), RUNTIME_HEAD);
    expect(verdict.admitted).toBe(true);
    if (verdict.admitted) expect(verdict.basis.c6).toBe('documented_variance');

    // NEGATIVE CONTROL: a FAILING C6 (the reconciliation found a delta
    // other than the evidenced one) refuses even with the downgrade held.
    const failingWithDowngrade = withCheck(admittingReport({
      c6_downgrade: {
        cleanup_script_removed: true,
        all_writers_monotonic_or_gated: true,
        reducers: [],
        downgrade_eligible: true,
        detail: 't',
      },
    }), 'C6_genesis_pool_ledger_exact',
    { status: 'fail', evaluated_items: 7, detail: 'pool != ledger, delta moved' });
    expect(refusalOf(judgeStandardLaneAdmission(loaded(failingWithDowngrade), RUNTIME_HEAD)))
      .toBe('c6_failing');
  });

  it(' NEGATIVE CONTROL: a FAILING C1 refuses even when its inventory shows only the five', () => {
    const asFail = withCheck(evidencedVarianceReport(), 'C1_batch_graph_complete',
      { status: 'fail', evaluated_items: 5, detail: 'reconciliation judged it a failure' });
    expect(refusalOf(judgeStandardLaneAdmission(loaded(asFail), RUNTIME_HEAD))).toBe('c1_failing');
  });

  it('C1 documented variance on EXACTLY the evidenced five admits as evidenced_variance', () => {
    const verdict = judgeStandardLaneAdmission(loaded(evidencedVarianceReport()), RUNTIME_HEAD);
    expect(verdict.admitted).toBe(true);
    if (verdict.admitted) {
      expect(verdict.basis.c1).toBe('evidenced_variance');
      expect(verdict.basis.c3).toBe('pass');
    }
  });

  it('ONE item beyond the evidenced five refuses c1_failing', () => {
    const base = evidencedVarianceReport();
    const { report_sha256: _sha, ...body } = base;
    const inventory = body.inventory as {
      legacy_pvtv8: { mint_batches: unknown[]; orphan_snapshot_batch_ids: string[] };
    };
    const next = {
      ...body,
      inventory: {
        legacy_pvtv8: {
          mint_batches: inventory.legacy_pvtv8.mint_batches,
          orphan_snapshot_batch_ids: [
            ...inventory.legacy_pvtv8.orphan_snapshot_batch_ids,
            '0xnew_unexplained_orphan',
          ],
        },
      },
    };
    const sha = recomputeReportSha256(next);
    const verdict = judgeStandardLaneAdmission(loaded({ ...next, report_sha256: sha }), RUNTIME_HEAD);
    expect(refusalOf(verdict)).toBe('c1_failing');
  });

  it('a marked-without-tx batch (phantom-mint signal) is NEVER excusable', () => {
    const base = evidencedVarianceReport();
    const { report_sha256: _sha, ...body } = base;
    const inventory = body.inventory as {
      legacy_pvtv8: { mint_batches: Array<Record<string, unknown>>; orphan_snapshot_batch_ids: string[] };
    };
    const next = {
      ...body,
      inventory: {
        legacy_pvtv8: {
          mint_batches: [
            ...inventory.legacy_pvtv8.mint_batches,
            { batch_id: '0xphantom', has_snapshot: true, marked: true, mint_tx_hash: null },
          ],
          orphan_snapshot_batch_ids: inventory.legacy_pvtv8.orphan_snapshot_batch_ids,
        },
      },
    };
    const sha = recomputeReportSha256(next);
    const verdict = judgeStandardLaneAdmission(loaded({ ...next, report_sha256: sha }), RUNTIME_HEAD);
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.reason).toBe('c1_failing');
      expect(verdict.detail).toContain('phantom');
    }
  });

  it('C1 documented variance with an unreadable inventory is UNKNOWN, not a judged failure', () => {
    const base = withCheck(admittingReport({ inventory: { legacy_pvtv8: null } }),
      'C1_batch_graph_complete', { status: 'documented_variance', evaluated_items: 5, detail: 't' });
    expect(refusalOf(judgeStandardLaneAdmission(loaded(base), RUNTIME_HEAD)))
      .toBe('report_unparseable');
  });

  it('a fully passing report admits with c1=pass, c6=pass', () => {
    const verdict = judgeStandardLaneAdmission(loaded(admittingReport()), RUNTIME_HEAD);
    expect(verdict.admitted).toBe(true);
    if (verdict.admitted) {
      expect(verdict.basis).toMatchObject({ c1: 'pass', c3: 'pass', c6: 'pass' });
      expect(verdict.basis.git_head).toBe(RUNTIME_HEAD);
    }
  });
});

describe(' · the evidence pins bind to the one table and can fail', () => {
  it('the REAL table is probative and pins exactly 2 + 3 documents', () => {
    expect(evidencePinsProbative()).toBe(true);
    const expected = expectedC1Populations();
    expect(expected.missingSnapshot.length).toBe(2);
    expect(expected.orphans.length).toBe(3);
    // Bound to the table itself, not to a re-typed copy of the ids.
    const fromTable = C1_SCOPE_EVIDENCE.map((row) => row.document_id).sort();
    expect([...expected.missingSnapshot, ...expected.orphans].sort()).toEqual(fromTable);
  });

  it('NEGATIVE CONTROL — a non-probative row makes the pins refuse', () => {
    const rows = C1_SCOPE_EVIDENCE.map((row) => ({ ...row } as {
      document_id: string; kind: string; chain_reader_probative: boolean;
      batch_minted_on_correct_contract: boolean; recorded_mint_tx_hash: string | null;
      excluded: boolean;
    }));
    expect(evidencePinsProbative(rows)).toBe(true);
    rows[0].batch_minted_on_correct_contract = false;
    expect(evidencePinsProbative(rows)).toBe(false);
    rows[0].batch_minted_on_correct_contract = true;
    rows[1].recorded_mint_tx_hash = null;
    expect(evidencePinsProbative(rows)).toBe(false);
    rows[1].recorded_mint_tx_hash = `0x${'f'.repeat(64)}`;
    rows[2].excluded = true;
    expect(evidencePinsProbative(rows)).toBe(false);
    expect(evidencePinsProbative([])).toBe(false); // empty population is not proof
  });
});

describe(' · single admit route (source scan)', () => {
  const SRC_ROOT = path.join(__dirname, '..', '..', '..');

  function walkSrc(relative: string, out: string[]): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(SRC_ROOT, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walkSrc(child, out);
        continue;
      }
      if (/\.ts$/.test(entry.name)) out.push(child);
    }
  }

  it('judgeStandardLaneAdmission is called from operator-runtime.ts and nowhere else in src/', () => {
    const files: string[] = [];
    walkSrc('.', files);
    expect(files.length).toBeGreaterThan(100); // the sweep saw a real tree
    const callers = files.filter((file) => {
      if (file.endsWith('.test.ts')) return false;
      const source = readFileSync(path.join(SRC_ROOT, file), 'utf8');
      if (!source.includes('judgeStandardLaneAdmission(')) return false;
      // The definition site declares it; a CALL anywhere else is a route.
      return !file.endsWith('standard-lane-recon-gate.ts');
    }).sort();
    expect(callers).toEqual(['./core/pvt/wp4/operator-runtime.ts']);
  });

  it('testOnlyAdmittedStandardLaneVerdict never appears in production src/', () => {
    const files: string[] = [];
    walkSrc('.', files);
    const offenders = files.filter((file) => {
      if (file.endsWith('.test.ts')) return false;
      if (file.endsWith('standard-lane-recon-gate.ts')) return false;
      const source = readFileSync(path.join(SRC_ROOT, file), 'utf8');
      return source.includes('testOnlyAdmittedStandardLaneVerdict');
    });
    expect(offenders).toEqual([]);
  });

  it('the test-only verdict is honest about itself', () => {
    const verdict = testOnlyAdmittedStandardLaneVerdict();
    expect(verdict.admitted).toBe(true);
    expect(verdict.basis.report_sha256).toBe('test-only');
  });
});

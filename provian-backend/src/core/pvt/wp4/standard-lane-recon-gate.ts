/**
 * settlement runtime/THE STANDARD-LANE FIRST-MINT GATE, AS CODE.
 *
 * declared a first-mint gate ("P1 reconciled + the double-mint block
 * exercised") and recorded, in its own words, that it was "enforced by
 * PROCESS, not by code" because no production settlement caller existed to
 * refuse. / stood the caller up; found the gate had been
 * WALKED PAST at the first (Genesis) mint. This module is the operator’s ordered
 * conversion : a fail-closed refusal at the settlement caller on
 * the STANDARD lane — the lane that has not yet settled a mainnet PE.
 *
 * WHAT IT JUDGES. A published cutover reconciliation cutover-reconciliation report (schema v6,
 * which binds the git tree it reconciled, embeds the C6 downgrade verdict, and
 * reports evidenced variances as `documented_variance`,),
 * against the tree the RUNNING code was deployed from:
 *
 * - the report must EXIST, parse, and re-derive its own `report_sha256`
 * (tamper evidence — the digest is recomputed here, never trusted);
 * - the report must bind a CLEAN tree whose `git_head` equals the deployed
 * runtime's stamp (`tree-stamp.generated.ts`). A later commit therefore
 * invalidates the report at the next deploy instead of silently carrying
 * forward — the exact defect class recorded;
 * - C3 must PASS over a non-empty set;
 * - C6 must PASS, or report `documented_variance` with the * downgrade genuinely held (both proofs, re-derived at report time and
 * embedded); a FAILING C6 refuses;
 * - C1 must PASS, or report `documented_variance` on EXACTLY the five
 * evidenced pre-snapshot-era
 * legacy documents (real mints on retired contracts, confirmed
 * on-chain, never allowlistable, never repairable without fabricating
 * records). The failing populations are re-derived from the report's own
 * inventory and compared to the pinned evidence table by id and kind; ONE
 * new unexplained item refuses. `marked_without_tx` the phantom-mint
 * signal — is never excusable.
 *
 * UNKNOWN REFUSES AS UNKNOWN. A conjunct this module cannot evaluate refuses
 * under a reason that says so (`report_unparseable`, `runtime_tree_unstamped`,
 * `check_missing`) — never by asserting a check "failed" that was in fact
 * unreadable.
 *
 * SINGLE ADMIT ROUTE. The only production construction of an admitted verdict
 * is `judgeStandardLaneAdmission` in this module, consumed by
 * `operator-runtime.ts` and enforced by `standard-lane-recon-gate.test.ts`'s
 * source scan. The Genesis lane is NOT judged here and no Genesis code path
 * consults this module — the operator: "do not add a gate to a path that is minting,
 * only to the one that has not."
 *
 * AUTHORITY-REMOVING. This module reads one Firestore document and refuses;
 * it writes nothing, signs nothing, and adds no admit capability that did not
 * exist — before it, the standard lane could settle with NO reconciliation at
 * all.
 */

import * as crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import {
  evidencePinsProbative,
  expectedC1Populations,
} from '../wp11/cutover-documented-variances';
import type { SettlementDb } from './durable-settlement-store';

// The C1 evidence judgments live with the reconciliation that now applies them
// (, `cutover-documented-variances.ts`); re-exported so the gate's own
// suite and any caller keep one source.
export {
  evidencePinsProbative,
  expectedC1Populations,
  type C1EvidenceRowLike,
} from '../wp11/cutover-documented-variances';

/** Where the publisher puts the current report. One doc; the gate reads only this. */
export const RECONCILIATION_REPORTS_COLLECTION = 'pvt9_reconciliation_reports_v1';
export const RECONCILIATION_CURRENT_DOC = 'current';

/** The one report schema this gate can judge. Anything else is UNKNOWN. */
export const JUDGEABLE_REPORT_SCHEMA = 'pvt-cutover-reconciliation/v6';

export type StandardLaneRefusalReason =
  | 'report_absent'
  | 'report_unparseable'
  | 'report_digest_mismatch'
  | 'report_schema_unsupported'
  | 'report_tree_unbound'
  | 'report_tree_dirty'
  | 'runtime_tree_unstamped'
  | 'report_stale_tree'
  | 'check_missing'
  | 'c1_failing'
  | 'c3_failing'
  | 'c6_failing'
  | 'evidence_pins_unprobative';

declare const ADMITTED_VIA_GATE: unique symbol;

export interface StandardLaneAdmitted {
  readonly admitted: true;
  readonly basis: {
    readonly report_sha256: string;
    readonly git_head: string;
    readonly c1: 'pass' | 'evidenced_variance';
    readonly c3: 'pass';
    readonly c6: 'pass' | 'documented_variance';
  };
  /**
   * Compile-time brand: the symbol is declared, never exported, so no other
   * module can TYPE an admitted verdict without a cast — and a cast is
   * exactly what the source-scan test looks for.
   */
  readonly [ADMITTED_VIA_GATE]: true;
}

export interface StandardLaneRefused {
  readonly admitted: false;
  readonly reason: StandardLaneRefusalReason;
  readonly detail: string;
}

export type StandardLaneAdmission = StandardLaneAdmitted | StandardLaneRefused;

/** What the loader found; the judge is total over this union. */
export type LoadedReconciliationReport =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unparseable'; readonly detail: string }
  | { readonly kind: 'loaded'; readonly report: unknown };

function refuse(reason: StandardLaneRefusalReason, detail: string): StandardLaneRefused {
  return { admitted: false, reason, detail };
}

function admit(basis: StandardLaneAdmitted['basis']): StandardLaneAdmitted {
  // The brand property is compile-time only; the runtime object carries the
  // admitted flag and its basis. This function is module-private on purpose.
  return { admitted: true, basis } as StandardLaneAdmitted;
}

/**
 * TEST-ONLY admitted verdict, for suites and the fork harness. Named so the
 * source scan can assert it never appears in production `src/` outside this
 * module and `*.test.ts` — a production import of this function IS the second
 * admit path this gate exists to not have.
 */
export function testOnlyAdmittedStandardLaneVerdict(): StandardLaneAdmitted {
  return admit({
    report_sha256: 'test-only',
    git_head: 'test-only',
    c1: 'pass',
    c3: 'pass',
    c6: 'pass',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const GIT_HEAD_RE = /^[0-9a-f]{40}$/;

interface JudgeableCheckRow {
  readonly id: string;
  readonly status: string;
  readonly evaluated_items: number;
}

function checkRow(report: Record<string, unknown>, id: string): JudgeableCheckRow | null {
  const checks = report.checks;
  if (!Array.isArray(checks)) return null;
  for (const raw of checks) {
    if (!isRecord(raw)) continue;
    if (raw.id !== id) continue;
    const status = stringField(raw.status);
    const items = typeof raw.evaluated_items === 'number' ? raw.evaluated_items : null;
    if (status === null || items === null) return null;
    return { id, status, evaluated_items: items };
  }
  return null;
}

interface C1Populations {
  readonly missingSnapshot: readonly string[];
  readonly markedWithoutTx: readonly string[];
  readonly orphans: readonly string[];
}

/** Re-derive C1's failing populations from the report's own inventory. */
function c1PopulationsOf(report: Record<string, unknown>): C1Populations | null {
  const inventory = report.inventory;
  if (!isRecord(inventory)) return null;
  const legacy = inventory.legacy_pvtv8;
  if (!isRecord(legacy)) return null;
  const batches = legacy.mint_batches;
  const orphans = legacy.orphan_snapshot_batch_ids;
  if (!Array.isArray(batches) || !Array.isArray(orphans)) return null;
  const missingSnapshot: string[] = [];
  const markedWithoutTx: string[] = [];
  for (const raw of batches) {
    if (!isRecord(raw)) return null;
    const id = stringField(raw.batch_id);
    if (id === null) return null;
    if (raw.has_snapshot !== true) missingSnapshot.push(id);
    if (raw.marked === true && raw.mint_tx_hash === null) markedWithoutTx.push(id);
  }
  const orphanIds: string[] = [];
  for (const raw of orphans) {
    const id = stringField(raw);
    if (id === null) return null;
    orphanIds.push(id);
  }
  return {
    missingSnapshot: missingSnapshot.sort(),
    markedWithoutTx: markedWithoutTx.sort(),
    orphans: orphanIds.sort(),
  };
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Recompute the report digest from its own body. The stored `report_sha256`
 * is never trusted: the body minus that one field is stable-stringified and
 * hashed exactly as `reconcileCutoverInventory` does it.
 */
export function recomputeReportSha256(report: Record<string, unknown>): string | null {
  const { report_sha256: _ignored, ...body } = report;
  const serialized = stableStringify(body);
  if (serialized === undefined) return null;
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * The gate. Total over its inputs; every refusal is named; UNKNOWN refuses as
 * UNKNOWN. Pure — the caller supplies the loaded report and the runtime's
 * deploy stamp, so every branch is constructible in test.
 */
export function judgeStandardLaneAdmission(
  loaded: LoadedReconciliationReport,
  runtimeGitHead: string | null,
): StandardLaneAdmission {
  if (loaded.kind === 'absent') {
    return refuse('report_absent',
      `no published reconciliation report at ${RECONCILIATION_REPORTS_COLLECTION}/`
      + `${RECONCILIATION_CURRENT_DOC}; run scripts/wp11-cutover-dry-run.ts on a clean tree `
      + 'and publish with scripts/wp11-publish-reconciliation-report.ts');
  }
  if (loaded.kind === 'unparseable') {
    return refuse('report_unparseable', loaded.detail);
  }
  const report = loaded.report;
  if (!isRecord(report)) {
    return refuse('report_unparseable', 'published report is not an object');
  }

  const storedSha = stringField(report.report_sha256);
  const recomputed = recomputeReportSha256(report);
  if (storedSha === null || recomputed === null || storedSha !== recomputed) {
    return refuse('report_digest_mismatch',
      `stored report_sha256=${storedSha ?? 'absent'} recomputed=${recomputed ?? 'unserializable'}`);
  }

  if (report.schema_version !== JUDGEABLE_REPORT_SCHEMA) {
    return refuse('report_schema_unsupported',
      `schema_version=${String(report.schema_version)}; this gate judges only `
      + `${JUDGEABLE_REPORT_SCHEMA} (older reports use an older status vocabulary or carry no `
      + 'tree binding — re-run the dry run)');
  }

  const boundTree = report.bound_tree;
  if (!isRecord(boundTree)) {
    return refuse('report_tree_unbound',
      'report carries no bound_tree — it cannot prove which tree it reconciled');
  }
  const reportHead = stringField(boundTree.git_head);
  if (reportHead === null || !GIT_HEAD_RE.test(reportHead)) {
    return refuse('report_tree_unbound', `bound_tree.git_head=${String(boundTree.git_head)}`);
  }
  if (boundTree.tree_dirty !== false) {
    return refuse('report_tree_dirty',
      'the report was produced on a dirty tree; its git_head does not describe the code that ran');
  }
  if (runtimeGitHead === null || !GIT_HEAD_RE.test(runtimeGitHead)) {
    return refuse('runtime_tree_unstamped',
      'this runtime carries no deploy tree stamp (tree-stamp.generated.ts is null); '
      + 'an unstamped image cannot prove what tree it runs — deploy via the stamped flow');
  }
  if (reportHead !== runtimeGitHead) {
    return refuse('report_stale_tree',
      `report reconciled tree ${reportHead.slice(0, 12)}… but this runtime was deployed from `
      + `${runtimeGitHead.slice(0, 12)}… — a later commit invalidates the report; re-run the `
      + 'reconciliation at the deployed commit');
  }

  const c1 = checkRow(report, 'C1_batch_graph_complete');
  const c3 = checkRow(report, 'C3_recipients_resolve');
  const c6 = checkRow(report, 'C6_genesis_pool_ledger_exact');
  if (c1 === null || c3 === null || c6 === null) {
    return refuse('check_missing',
      `report is missing or malforms one of the judged checks (C1=${c1 !== null} `
      + `C3=${c3 !== null} C6=${c6 !== null})`);
  }

  // C3 — must simply pass, over a non-empty set. The two mixed-case orphan
  // snapshots were normalized under the operator’s explicit authorization;
  // nothing short of a pass is admissible here.
  if (!(c3.status === 'pass' && c3.evaluated_items > 0)) {
    return refuse('c3_failing', `C3 status=${c3.status} items=${c3.evaluated_items}`);
  }

  // C6 — pass, or a documented variance with the downgrade genuinely
  // held (re-checked here from the embedded verdict, never trusted from the
  // status alone). A FAILING C6 — the reconciliation found a delta other than
  // the evidenced one — refuses.
  let c6Basis: 'pass' | 'documented_variance';
  if (c6.status === 'pass' && c6.evaluated_items > 0) {
    c6Basis = 'pass';
  } else if (c6.status === 'documented_variance' && c6.evaluated_items > 0) {
    const downgrade = report.c6_downgrade;
    if (!isRecord(downgrade) || downgrade.downgrade_eligible !== true) {
      return refuse('c6_failing',
        'C6 reports a documented variance but the downgrade verdict is absent or ineligible — '
        + 'the pool/ledger variance is an undowngraded blocker (both proofs or C6 blocks)');
    }
    c6Basis = 'documented_variance';
  } else {
    return refuse('c6_failing', `C6 status=${c6.status} items=${c6.evaluated_items}`);
  }

  // C1 — pass, or a documented variance on EXACTLY the five evidenced
  // documents, re-derived here from the report's own inventory (defence in
  // depth: the status alone is never trusted). A FAILING C1 refuses.
  let c1Basis: 'pass' | 'evidenced_variance';
  if (c1.status === 'pass' && c1.evaluated_items > 0) {
    c1Basis = 'pass';
  } else if (c1.status === 'documented_variance' && c1.evaluated_items > 0) {
    if (!evidencePinsProbative()) {
      return refuse('evidence_pins_unprobative',
        'the C1 evidence table itself is not probative; nothing here can vouch for the variance');
    }
    const populations = c1PopulationsOf(report);
    if (populations === null) {
      return refuse('report_unparseable', 'C1 populations cannot be re-derived from the inventory');
    }
    if (populations.markedWithoutTx.length > 0) {
      return refuse('c1_failing',
        `marked_without_tx=[${populations.markedWithoutTx.join(',')}] — a batch marked minted `
        + 'with no durable transaction is a phantom-mint signal and is never excusable');
    }
    const expected = expectedC1Populations();
    if (!sameIdSet(populations.missingSnapshot, expected.missingSnapshot)
      || !sameIdSet(populations.orphans, expected.orphans)) {
      return refuse('c1_failing',
        `C1 failing set differs from the evidenced five: missing_snapshot=`
        + `[${populations.missingSnapshot.join(',')}] orphans=[${populations.orphans.join(',')}] `
        + `expected missing_snapshot=[${expected.missingSnapshot.join(',')}] `
        + `orphans=[${expected.orphans.join(',')}]`);
    }
    c1Basis = 'evidenced_variance';
  } else {
    return refuse('c1_failing', `C1 status=${c1.status} items=${c1.evaluated_items}`);
  }

  return admit({
    report_sha256: storedSha,
    git_head: reportHead,
    c1: c1Basis,
    c3: 'pass',
    c6: c6Basis,
  });
}

/**
 * Load the published report. Read-only; one doc. `report_json` is a STRING on
 * purpose — Firestore never touches the report's own field types, and the
 * digest recomputation sees exactly what the publisher serialized.
 */
export async function readPublishedReconciliationReport(
  db: SettlementDb,
): Promise<LoadedReconciliationReport> {
  const snapshot = await db.collection(RECONCILIATION_REPORTS_COLLECTION)
    .doc(RECONCILIATION_CURRENT_DOC)
    .get();
  if (!snapshot.exists) return { kind: 'absent' };
  const data = snapshot.data();
  const raw = data === undefined ? undefined : data.report_json;
  if (typeof raw !== 'string' || raw.length === 0) {
    return { kind: 'unparseable', detail: 'published doc has no report_json string' };
  }
  try {
    return { kind: 'loaded', report: JSON.parse(raw) as unknown };
  } catch (error) {
    return {
      kind: 'unparseable',
      detail: `report_json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * cutover reconciliation — zero-carry cutover reconciliation DRY RUN (operator tool).
 *
 * Read-only end to end: takes the final inventory at the cut line, runs every
 * reconciliation check, prints the deterministic report, and writes a local
 * evidence JSON artifact. It mounts NO route, registers NO scheduler, signs
 * NOTHING, and cannot mint, settle, anchor, or migrate — see
 * `src/core/pvt/wp11/cutover-reconciliation.ts`.
 *
 * activation usage (the reverification at the final cut line):
 * npx ts-node scripts/wp11-cutover-dry-run.ts --cut-line <unix_ms> \
 * --rpc https://mainnet.base.org
 * Run it twice: the acceptance requires the repeated run to print the same
 * report_sha256.
 *
 * THE CHAIN READER IS BOUND PER DOCUMENT. Passing `--rpc` binds
 * a READ-ONLY `batchMinted(bytes32)` readback whose TARGET CONTRACT is resolved
 * for each document from `legacy-mint-contract-registry.ts`. bound the
 * current PVTv8 token to every document; PVTv8 has never minted anything (live
 * totalSupply zero), so that reader could only ever answer `false` about
 * batches that were minted on three earlier contracts. A document whose
 * contract cannot be resolved or reached now THROWS and aborts the run — a
 * probe that could not ask the right contract has not received a negative
 * answer. The reader issues `eth_call` only: no signer, no key, no transaction
 * surface. Without `--rpc`, C11 stays `not_evaluated`, which BLOCKS cutover by
 * design (Unknown = Block).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { runCutoverReconciliation } from '../src/core/pvt/wp11/cutover-reconciliation';
import type {
  CutoverChainReader,
  ReconciliationTreeBinding,
} from '../src/core/pvt/wp11/cutover-reconciliation';
import {
  findPoolCounterWriters,
  isCleanupScriptRemoved,
  judgeC6Downgrade,
} from '../src/core/pvt/wp11/c6-downgrade-evidence';
import {
  makeJsonRpcTransport,
  makeRegistryBoundBatchMintedReader,
} from '../src/core/pvt/wp11/legacy-batch-minted-reader';
import { scriptDb } from './lib/script-db';

/**
 * v5 : bind the report to the tree it reconciles. Fail-closed — if git
 * cannot answer, the report carries `bound_tree: null` and the standard-lane
 * gate refuses it, which is the correct fate of a report of unknown
 * provenance.
 */
function readTreeBinding(backendRoot: string): ReconciliationTreeBinding | null {
  try {
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: backendRoot, encoding: 'utf8' }).trim();
    const head = git(['rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(head)) return null;
    // Self-exclusion, exactly one shape: THIS SCRIPT'S OWN untracked evidence
    // artifacts (`wp11-cutover-dry-run.<cutline>.<sha12>.json`). Run 1 writing
    // its artifact must not make run 2 report a dirty tree — the artifact is
    // the run's OUTPUT and cannot change what a run reconciles. Everything
    // else, tracked or untracked, still marks the tree dirty (fail-closed).
    const dirty = git(['status', '--porcelain']).split('\n')
      .filter((line) => line.trim().length > 0)
      .filter((line) => !/^\?\? .*wp11-cutover-dry-run\.\d+\.[0-9a-f]{12}\.json$/.test(line.trim()))
      .length > 0;
    return { git_head: head, tree_dirty: dirty };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cutLineFlag = args.indexOf('--cut-line');
  const cutLineMs = cutLineFlag >= 0 ? Number(args[cutLineFlag + 1]) : Date.now();
  if (!Number.isSafeInteger(cutLineMs) || cutLineMs <= 0) {
    console.error(
      'Usage: wp11-cutover-dry-run.ts [--cut-line <unix_ms>] [--rpc <url>] '
      + '[--acknowledge-vacuous <checkId,checkId>]',
    );
    process.exit(2);
  }

  // a `vacuous_pass` counts toward `reconciled` only when named
  // here. Acknowledging is a launch-gate judgment, so it is an explicit,
  // recorded operator act — never a default.
  const ackFlag = args.indexOf('--acknowledge-vacuous');
  const acknowledgedVacuousChecks = ackFlag >= 0
    ? (args[ackFlag + 1] ?? '').split(',').map((v) => v.trim()).filter((v) => v.length > 0)
    : [];

  const rpcFlag = args.indexOf('--rpc');
  const rpcUrl = rpcFlag >= 0 ? args[rpcFlag + 1] : process.env.BASE_RPC_URL;

  let chainReader: CutoverChainReader | undefined;
  if (rpcUrl) {
    // the reader now resolves the contract PER DOCUMENT from
    // `legacy-mint-contract-registry.ts` instead of binding PVTv8 to
    // everything. PVTv8's live totalSupply is ZERO, so the old binding could
    // only ever answer `false` — about batches minted on three different
    // earlier contracts. An unresolvable contract THROWS.
    chainReader = makeRegistryBoundBatchMintedReader(makeJsonRpcTransport({ 8453: rpcUrl }));
    console.log(
      `chain reader BOUND per-document via the legacy mint-contract registry `
      + `(Base RPC ${rpcUrl}, read-only eth_call; unresolvable contract THROWS)`,
    );
  } else {
    console.log('chain reader NOT bound (no --rpc / BASE_RPC_URL) — C11 will be not_evaluated');
  }

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
  const db = scriptDb();

  const backendRoot = path.join(__dirname, '..');
  const boundTree = readTreeBinding(backendRoot);
  if (boundTree === null) {
    console.log('WARNING: tree binding unavailable — report will carry bound_tree=null (gate refuses it)');
  } else if (boundTree.tree_dirty) {
    console.log(`WARNING: tree is DIRTY at ${boundTree.git_head} — the gate refuses a dirty-tree report`);
  } else {
    console.log(`tree binding: ${boundTree.git_head} (clean)`);
  }
  // C6's downgrade verdict is re-derived from the tree on every run, never
  // copied forward — the same two proofs `cutover-wp12r3.test.ts` pins.
  const c6Downgrade = judgeC6Downgrade(
    isCleanupScriptRemoved(backendRoot),
    findPoolCounterWriters(backendRoot),
  );
  console.log(`C6 downgrade: ${c6Downgrade.downgrade_eligible ? 'ELIGIBLE (documented variance)' : 'NOT eligible (blocking)'} — ${c6Downgrade.detail}`);

  const report = await runCutoverReconciliation(db, {
    cutLineMs, chainReader, acknowledgedVacuousChecks, boundTree, c6Downgrade,
  });

  const label: Record<string, string> = {
    pass: 'PASS', fail: 'FAIL', documented_variance: 'DOCV', vacuous_pass: 'VACU', not_evaluated: 'SKIP',
  };
  // `items=` is printed for EVERY check: a bare PASS must never hide the fact
  // that the check evaluated nothing.
  const summary = report.checks
    .map((c) => `  ${label[c.status] ?? '????'} ${c.id} (items=${c.evaluated_items}): ${c.detail}`)
    .join('\n');
  console.log(`cutover reconciliation cutover reconciliation dry run @ cut line ${cutLineMs}`);
  console.log(summary);
  const vacuous = report.checks.filter((c) => c.status === 'vacuous_pass');
  if (vacuous.length > 0) {
    console.log(
      `VACUOUS (passed over ZERO items, assert nothing): ${vacuous.map((c) => c.id).join(', ')}`,
    );
  }
  const documented = report.checks.filter((c) => c.status === 'documented_variance');
  if (documented.length > 0) {
    console.log(
      `DOCUMENTED VARIANCE (evidenced and pinned; any departure fails): ${documented.map((c) => c.id).join(', ')}`,
    );
  }
  console.log(
    `acknowledged_vacuous_checks=[${report.acknowledged_vacuous_checks.join(',')}]`,
  );
  const failing = report.checks.filter((c) => c.status === 'fail');
  console.log(`failures=${failing.length}${failing.length > 0 ? ` [${failing.map((c) => c.id).join(',')}]` : ''}`);
  console.log(`reconciled=${report.reconciled} (excluding not_evaluated: ${report.reconciled_excluding_not_evaluated})`);
  console.log(`report_sha256=${report.report_sha256}`);

  const outPath = path.join(
    process.cwd(),
    `wp11-cutover-dry-run.${cutLineMs}.${report.report_sha256.slice(0, 12)}.json`,
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`evidence artifact: ${outPath}`);

  process.exit(report.reconciled_excluding_not_evaluated ? 0 : 1);
}

main().catch((err) => {
  console.error('[wp11-cutover-dry-run] failed:', err);
  process.exit(1);
});

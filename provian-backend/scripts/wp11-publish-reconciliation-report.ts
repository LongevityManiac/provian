/**
 * publish a cutover reconciliation cutover-reconciliation report for the standard-lane
 * settlement gate to judge.
 *
 * The dry run (`wp11-cutover-dry-run.ts`) stays read-only and writes only a
 * local JSON artifact; THIS script is the one writer of
 * `pvt9_reconciliation_reports_v1/current`. It refuses to publish anything the
 * gate could not honestly judge:
 *
 * - the artifact's `report_sha256` must re-derive from its own body;
 * - the report must be schema v5 with a CLEAN tree binding;
 * - the bound `git_head` must equal the repo's CURRENT HEAD, and the tree
 * must be clean NOW — publishing an artifact the tree has moved past would
 * manufacture exactly the staleness the binding exists to expose.
 *
 * Publishing is NOT approval: the gate re-derives the digest and re-judges
 * C1/C3/C6 against the pinned evidence on every settlement run. This script
 * cannot mint, settle, or mark anything reconciled — it stores a document the
 * gate is free to refuse.
 *
 * Usage:
 * npx ts-node scripts/wp11-publish-reconciliation-report.ts <artifact.json>
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import {
  RECONCILIATION_CURRENT_DOC,
  RECONCILIATION_REPORTS_COLLECTION,
  JUDGEABLE_REPORT_SCHEMA,
  recomputeReportSha256,
} from '../src/core/pvt/wp4/standard-lane-recon-gate';
import { scriptDb } from './lib/script-db';

async function main(): Promise<void> {
  const artifactPath = process.argv[2];
  if (artifactPath === undefined) {
    console.error('Usage: wp11-publish-reconciliation-report.ts <dry-run artifact.json>');
    process.exit(2);
  }
  const raw = fs.readFileSync(artifactPath, 'utf8');
  const report = JSON.parse(raw) as Record<string, unknown>;

  if (report.schema_version !== JUDGEABLE_REPORT_SCHEMA) {
    throw new Error(`publish_refused_schema: ${String(report.schema_version)} (need ${JUDGEABLE_REPORT_SCHEMA})`);
  }
  const stored = report.report_sha256;
  const recomputed = recomputeReportSha256(report);
  if (typeof stored !== 'string' || recomputed === null || stored !== recomputed) {
    throw new Error(`publish_refused_digest: stored=${String(stored)} recomputed=${String(recomputed)}`);
  }
  const boundTree = report.bound_tree as { git_head?: unknown; tree_dirty?: unknown } | null;
  if (boundTree === null || typeof boundTree !== 'object'
    || typeof boundTree.git_head !== 'string' || boundTree.tree_dirty !== false) {
    throw new Error('publish_refused_tree_binding: report has no clean tree binding');
  }

  const backendRoot = path.join(__dirname, '..');
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: backendRoot, encoding: 'utf8' }).trim();
  const head = git(['rev-parse', 'HEAD']);
  if (head !== boundTree.git_head) {
    throw new Error(
      `publish_refused_stale_artifact: artifact bound ${boundTree.git_head} but HEAD is ${head} — `
      + 're-run the dry run at the current commit',
    );
  }
  // Same single self-exclusion as the dry-run's binding: the run's own
  // untracked evidence artifacts are output, not tree state.
  const dirty = git(['status', '--porcelain']).split('\n')
    .filter((l) => l.trim().length > 0)
    .filter((l) => !/^\?\? .*wp11-cutover-dry-run\.\d+\.[0-9a-f]{12}\.json$/.test(l.trim()))
    .length > 0;
  if (dirty) {
    throw new Error('publish_refused_dirty_tree: commit first; the binding must describe a real commit');
  }

  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'provian-ai' });
  }
  const db = scriptDb();
  const publishedAt = Date.now();
  const doc = {
    schema_version: 'pvt9-reconciliation-publication/v1',
    report_json: raw,
    report_sha256: stored,
    git_head: boundTree.git_head,
    cut_line_ms: report.cut_line_ms ?? null,
    published_at_ms: publishedAt,
  };
  const collection = db.collection(RECONCILIATION_REPORTS_COLLECTION);
  await collection.doc(RECONCILIATION_CURRENT_DOC).set(doc);
  // History copy, content-addressed — `current` is a pointer, never the only record.
  await collection.doc(`history_${stored.slice(0, 16)}`).set(doc);
  console.log(`published ${RECONCILIATION_REPORTS_COLLECTION}/${RECONCILIATION_CURRENT_DOC}`);
  console.log(`  report_sha256 = ${stored}`);
  console.log(`  git_head      = ${boundTree.git_head}`);
  console.log(`  published_at  = ${new Date(publishedAt).toISOString()}`);
  console.log('The gate re-judges this on every settlement run; publication is not approval.');
}

main().catch((err) => {
  console.error('[wp11-publish-reconciliation-report] failed:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Refuse any GitHub Actions workflow that can burn the operator’s Actions minutes
 * unattended.
 *
 * WHY THIS EXISTS. Three prior fixes each closed ONE instance of the same cost
 * class: the docs-only skip, the push-trigger removal (2026-09-06,
 * the solo-developer CI shape), and the backend-tests timeout after a nightly
 * jest step hung for GitHub's 6-hour default. Every other job
 * was still on the 6-hour default. This closes the class with two invariants:
 *
 * 1. NO PUSH TRIGGER. A workflow triggers only on pull_request /
 * workflow_dispatch / schedule (and other non-push events). `on: push` in
 * any spelling (string, list, or map key) is refused.
 * 2. EVERY JOB IS TIME-BOUNDED. Every job carries an explicit `timeout-minutes`
 * that is a positive integer no larger than MAX_TIMEOUT_MINUTES — or a
 * `${{ matrix.… }}` expression that resolves, for EVERY matrix leg, to such
 * an integer. The values themselves are sized from observed run durations
 * (see the comment beside each one); this check cannot judge sizing, only
 * that a bound exists and is not the 6-hour default in disguise.
 *
 * FAIL CLOSED (Unknown = Block). An unparseable file, a matrix built from an
 * expression, a timeout expression this check cannot resolve, a job calling a
 * reusable workflow in another repo (whose jobs this check cannot see), and an
 * empty population (zero workflow files, or a workflow with zero jobs) all REFUSE.
 *
 * WHERE IT RUNS (there is no per-push CI, so the gate is local):
 * - `.githooks/pre-push` on the exact commits being pushed (`--rev`), so a
 * violating workflow cannot land on the remote from this clone;
 * - `npm run check:wp2` the documented pre-push battery, which also puts it
 * in the nightly typecheck (root) leg as the backstop.
 *
 * Run: node scripts/check-workflow-budget.mjs # worktree
 * node scripts/check-workflow-budget.mjs --rev <sha> # a commit's tree
 * node scripts/check-workflow-budget.mjs --self-test # RED controls
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

export const WORKFLOW_DIR = '.github/workflows';

/**
 * Upper bound on any single job's timeout. The longest observed job across
 * the operator’s repos is a Fly deploy at 14.0 min; every chosen timeout is <= 45.
 * A value above this is a deliberate decision and needs this constant edited.
 */
export const MAX_TIMEOUT_MINUTES = 60;

const isWorkflowFile = (p) => /\.ya?ml$/.test(p);

/** Trigger event names of a parsed workflow, in any of GitHub's three spellings. */
function triggerNames(on) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === 'object') return Object.keys(on);
  return null;
}

function validTimeoutInt(v) {
  return Number.isInteger(v) && v > 0 && v <= MAX_TIMEOUT_MINUTES;
}

/**
 * Every value a `matrix.<a>[.<b>…]` path takes across the job's legs, or a
 * string reason why it cannot be resolved. Legs come from the matrix's own
 * dimension arrays plus `include` entries; an include entry that does not name
 * the root key is a leg with no value, which cannot be proven bounded.
 */
function resolveMatrixPath(strategy, segments) {
  const matrix = strategy?.matrix;
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    return 'timeout references matrix but the job has no literal strategy.matrix';
  }
  const [root, ...rest] = segments;
  const rootValues = [];
  if (root in matrix) {
    if (!Array.isArray(matrix[root])) return `matrix.${root} is not a literal list`;
    rootValues.push(...matrix[root]);
  }
  if (matrix.include !== undefined) {
    if (!Array.isArray(matrix.include)) return 'matrix.include is not a literal list';
    for (const entry of matrix.include) {
      if (!entry || typeof entry !== 'object' || !(root in entry)) {
        return `a matrix.include leg does not define ${root}, so its timeout is unbounded`;
      }
      rootValues.push(entry[root]);
    }
  }
  if (rootValues.length === 0) return `matrix.${root} has no legs`;
  const values = [];
  for (const rv of rootValues) {
    let v = rv;
    for (const seg of rest) {
      if (!v || typeof v !== 'object' || !(seg in v)) {
        return `a matrix leg of ${root} does not define .${rest.join('.')}`;
      }
      v = v[seg];
    }
    values.push(v);
  }
  return values;
}

/** Violations for one job's timeout-minutes. */
function checkJobTimeout(where, job) {
  if (!('timeout-minutes' in job)) {
    return [`${where}: no timeout-minutes (GitHub default is 360 min)`];
  }
  const t = job['timeout-minutes'];
  if (typeof t === 'number') {
    return validTimeoutInt(t)
      ? []
      : [`${where}: timeout-minutes ${t} is not an integer in 1..${MAX_TIMEOUT_MINUTES}`];
  }
  if (typeof t === 'string') {
    const m = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}$/.exec(t.trim());
    if (!m) return [`${where}: timeout-minutes ${JSON.stringify(t)} is not a literal or a matrix reference`];
    const resolved = resolveMatrixPath(job.strategy, m[1].split('.'));
    if (typeof resolved === 'string') return [`${where}: ${resolved}`];
    const bad = resolved.filter((v) => !validTimeoutInt(v));
    return bad.length === 0
      ? []
      : [`${where}: matrix timeout values ${JSON.stringify(bad)} are not integers in 1..${MAX_TIMEOUT_MINUTES}`];
  }
  return [`${where}: timeout-minutes has unsupported type ${typeof t}`];
}

/**
 * The single rule set. Pure over `{ path, source }` records so the self-test
 * feeds it the same function the real check uses.
 * Returns `{ violations, workflows, jobs }`.
 */
export function checkWorkflows(files) {
  const violations = [];
  let workflows = 0;
  let jobs = 0;
  if (files.length === 0) {
    violations.push(`no workflow files found under ${WORKFLOW_DIR} — an empty population is not a pass`);
  }
  for (const { path: file, source } of files) {
    workflows += 1;
    let wf;
    try {
      const doc = YAML.parseDocument(source);
      if (doc.errors.length > 0) throw new Error(doc.errors[0].message);
      wf = doc.toJS();
    } catch (err) {
      violations.push(`${file}: unparseable YAML (${err.message})`);
      continue;
    }
    if (!wf || typeof wf !== 'object') {
      violations.push(`${file}: not a workflow mapping`);
      continue;
    }
    // YAML 1.1 parsers read a bare `on` key as boolean true; accept either.
    const on = 'on' in wf ? wf.on : wf.true;
    const names = triggerNames(on);
    if (names === null) {
      violations.push(`${file}: no parseable \`on:\` triggers`);
    } else if (names.includes('push')) {
      violations.push(`${file}: triggers on push (allowed shape: pull_request / workflow_dispatch / schedule)`);
    }
    const jobMap = wf.jobs;
    if (!jobMap || typeof jobMap !== 'object' || Object.keys(jobMap).length === 0) {
      violations.push(`${file}: no jobs — an empty population is not a pass`);
      continue;
    }
    for (const [id, job] of Object.entries(jobMap)) {
      jobs += 1;
      const where = `${file} job '${id}'`;
      if (!job || typeof job !== 'object') {
        violations.push(`${where}: not a job mapping`);
        continue;
      }
      if (typeof job.uses === 'string') {
        // A reusable-workflow call cannot carry timeout-minutes; its callee's
        // jobs must. A local callee is in this directory and checked here; a
        // remote one is invisible to this check, so it is refused.
        if (!job.uses.startsWith('./')) {
          violations.push(`${where}: calls remote reusable workflow ${job.uses}, whose job timeouts cannot be checked`);
        }
        continue;
      }
      violations.push(...checkJobTimeout(where, job));
    }
  }
  return { violations, workflows, jobs };
}

/** Workflow files in the worktree. */
function readWorktree(root) {
  const dir = path.join(root, WORKFLOW_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isWorkflowFile)
    .sort()
    .map((name) => {
      const rel = `${WORKFLOW_DIR}/${name}`;
      return { path: rel, source: fs.readFileSync(path.join(root, rel), 'utf8') };
    });
}

/** Workflow files as they exist in commit `rev` (what a push would land). */
function readRevision(root, rev) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const listing = git(['ls-tree', '--name-only', `${rev}:${WORKFLOW_DIR}`]).split('\n').filter(Boolean);
  return listing
    .filter(isWorkflowFile)
    .sort()
    .map((name) => {
      const rel = `${WORKFLOW_DIR}/${name}`;
      return { path: rel, source: git(['show', `${rev}:${rel}`]) };
    });
}

// ---------------------------------------------------------------------------
// Self-test: every RED control must be refused by the same checkWorkflows the
// real run uses, and the GREEN control must pass. A guard never seen failing
// is not evidence (CLAUDE.md, negative-control doctrine).
// ---------------------------------------------------------------------------
const GOOD = `
on:
  pull_request:
  workflow_dispatch:
  schedule:
    - cron: '0 9 * * *'
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps: [{ run: 'true' }]
  m:
    runs-on: ubuntu-latest
    timeout-minutes: \${{ matrix.project.timeout }}
    strategy:
      matrix:
        project:
          - { name: x, timeout: 10 }
          - { name: y, timeout: 20 }
    steps: [{ run: 'true' }]
  call:
    uses: ./.github/workflows/other.yml
`;

const RED_CONTROLS = [
  ['push as a map key', `on:\n  push:\n    branches: [master]\n  pull_request:\njobs:\n  a: { runs-on: x, timeout-minutes: 5 }\n`],
  ['push as a string', `on: push\njobs:\n  a: { runs-on: x, timeout-minutes: 5 }\n`],
  ['push in a list', `on: [pull_request, push]\njobs:\n  a: { runs-on: x, timeout-minutes: 5 }\n`],
  ['missing timeout', `on: [pull_request]\njobs:\n  a: { runs-on: x }\n`],
  ['timeout zero', `on: [pull_request]\njobs:\n  a: { runs-on: x, timeout-minutes: 0 }\n`],
  ['timeout at the 6h default', `on: [pull_request]\njobs:\n  a: { runs-on: x, timeout-minutes: 360 }\n`],
  ['timeout non-integer', `on: [pull_request]\njobs:\n  a: { runs-on: x, timeout-minutes: 2.5 }\n`],
  ['timeout arbitrary expression', `on: [pull_request]\njobs:\n  a: { runs-on: x, timeout-minutes: '\${{ inputs.t }}' }\n`],
  ['matrix leg missing timeout', `on: [pull_request]\njobs:\n  m:\n    runs-on: x\n    timeout-minutes: \${{ matrix.p.timeout }}\n    strategy: { matrix: { p: [{ timeout: 5 }, { name: nope }] } }\n`],
  ['matrix leg over the cap', `on: [pull_request]\njobs:\n  m:\n    runs-on: x\n    timeout-minutes: \${{ matrix.p.timeout }}\n    strategy: { matrix: { p: [{ timeout: 5 }, { timeout: 999 }] } }\n`],
  ['matrix include leg without the key', `on: [pull_request]\njobs:\n  m:\n    runs-on: x\n    timeout-minutes: \${{ matrix.p.timeout }}\n    strategy: { matrix: { p: [{ timeout: 5 }], include: [{ other: 1 }] } }\n`],
  ['matrix from an expression', `on: [pull_request]\njobs:\n  m:\n    runs-on: x\n    timeout-minutes: \${{ matrix.p.timeout }}\n    strategy: { matrix: '\${{ fromJSON(inputs.m) }}' }\n`],
  ['remote reusable workflow', `on: [pull_request]\njobs:\n  c: { uses: 'someone/repo/.github/workflows/x.yml@v1' }\n`],
  ['no jobs', `on: [pull_request]\njobs: {}\n`],
  ['no triggers', `jobs:\n  a: { runs-on: x, timeout-minutes: 5 }\n`],
  ['unparseable YAML', `on: [pull_request\njobs: :\n`],
];

export function selfTest() {
  const failures = [];
  const green = checkWorkflows([{ path: 'good.yml', source: GOOD }]);
  if (green.violations.length !== 0) failures.push(`GREEN control refused: ${green.violations.join('; ')}`);
  if (green.jobs !== 3) failures.push(`GREEN control evaluated ${green.jobs} jobs, expected 3`);
  for (const [label, source] of RED_CONTROLS) {
    const { violations } = checkWorkflows([{ path: `${label}.yml`, source }]);
    if (violations.length === 0) failures.push(`RED control passed (guard cannot fail): ${label}`);
  }
  const empty = checkWorkflows([]);
  if (empty.violations.length === 0) failures.push('RED control passed: empty population');
  return { failures, controls: RED_CONTROLS.length + 2 };
}

function main(argv) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (argv.includes('--self-test')) {
    const { failures, controls } = selfTest();
    if (failures.length > 0) {
      console.error(`check-workflow-budget self-test FAILED:\n  ${failures.join('\n  ')}`);
      return 1;
    }
    console.log(`check-workflow-budget self-test ok (${controls} controls: 1 GREEN, ${controls - 1} RED refused)`);
  }
  const revIdx = argv.indexOf('--rev');
  let files;
  let label;
  try {
    if (revIdx !== -1) {
      const rev = argv[revIdx + 1];
      if (!rev) throw new Error('--rev needs a commit');
      files = readRevision(root, rev);
      label = `commit ${rev.slice(0, 12)}`;
    } else {
      files = readWorktree(root);
      label = 'worktree';
    }
  } catch (err) {
    console.error(`check-workflow-budget: cannot read workflows (${err.message}) — refusing`);
    return 1;
  }
  const { violations, workflows, jobs } = checkWorkflows(files);
  if (violations.length > 0) {
    console.error(
      `check-workflow-budget: ${violations.length} violation(s) in ${label} ` +
        `(${workflows} workflows, ${jobs} jobs):\n  ${violations.join('\n  ')}\n` +
        'Every job needs timeout-minutes sized from observed durations; no workflow may trigger on push.',
    );
    return 1;
  }
  console.log(`check-workflow-budget ok: ${label}, ${workflows} workflows, ${jobs} jobs — all time-bounded, none push-triggered`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

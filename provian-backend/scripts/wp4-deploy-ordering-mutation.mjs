/**
 * mutation battery for the deploy ordering rule.
 *
 * `deploy-gate-ordering.ts` guards the standard-lane settlement gate's two
 * halves (the published report and the image stamp) against naming different
 * commits, so per the run contract it ships with mutation coverage rather than
 * a green-only suite. Every mutant below is a REAL semantic weakening — each
 * one restores exactly one of the divergences the module exists to refuse —
 * and `deploy-gate-ordering.test.ts` must go RED for each. A SURVIVOR is a
 * finding and exits 1; it is never silently re-baselined. Source is restored
 * byte-identical (SHA-256 verified) on every exit path.
 *
 * node scripts/wp4-deploy-ordering-mutation.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, '..', 'src', 'core', 'pvt', 'wp4', 'deploy-gate-ordering.ts');
const SUITE = 'src/core/pvt/wp4/deploy-gate-ordering.test.ts';

const MUTANTS = [
  {
    id: 'ordering-guard-disabled',
    detail: 'any step may run in any order — the whole sequence rule stops existing',
    from: '  if (!isNextInSequence(step, state.completed)) {',
    to: '  if (false as boolean && !isNextInSequence(step, state.completed)) {',
  },
  {
    id: 'publish-before-stamp-not-required',
    detail: 'stamping is allowed with no published report — deploy would refuse report_absent',
    from: "      if (state.publishedReportHead === null) {\n        return refuse('publish_missing',",
    to: "      if (false as boolean) {\n        return refuse('publish_missing',",
  },
  {
    id: 'the-trap-reopened',
    detail: 'a report bound to an undeployed commit passes — THE failure this module exists for',
    from: '      if (state.publishedReportHead !== head) {\n        return refuse(\'publish_stale\',\n          `the published report binds ${state.publishedReportHead.slice(0, 12)}… but HEAD is `',
    to: '      if (false as boolean) {\n        return refuse(\'publish_stale\',\n          `the published report binds ${String(state.publishedReportHead)} but HEAD is `',
  },
  {
    id: 'unstamped-deploy-permitted',
    detail: 'an unstamped image may be deployed — the gate would refuse runtime_tree_unstamped',
    from: "      if (state.stampValue === null) {\n        return refuse('stamp_missing',",
    to: "      if (false as boolean) {\n        return refuse('stamp_missing',",
  },
  {
    id: 'stamp-mismatch-tolerated',
    detail: 'the stamp may name a different commit than HEAD',
    from: '      if (state.stampValue !== head) {\n        return refuse(\'stamp_mismatch\',',
    to: '      if (false as boolean) {\n        return refuse(\'stamp_mismatch\',',
  },
  {
    id: 'deploy-boundary-recheck-dropped',
    detail: 'the report is trusted from the stamp step, so a concurrent republish slips through',
    from: '      if (state.publishedReportHead !== head) {\n        return refuse(\'publish_stale\',\n          `the published report binds ${String(state.publishedReportHead)} but this deploy would `',
    to: '      if (false as boolean) {\n        return refuse(\'publish_stale\',\n          `the published report binds ${String(state.publishedReportHead)} but this deploy would `',
  },
  {
    id: 'stale-artifact-published',
    detail: 'a dry-run artifact from an older commit may be published',
    from: "      if (state.artifactBoundHead !== head) {\n        return refuse('artifact_stale',",
    to: "      if (false as boolean) {\n        return refuse('artifact_stale',",
  },
  {
    id: 'dirty-tree-tolerated',
    detail: 'a dirty tree may be bound and built — the claimed commit is not the built tree',
    from: '  if (state.treeDirty) {',
    to: '  if (false as boolean && state.treeDirty) {',
  },
  {
    id: 'reset-requires-successful-deploy',
    detail: 'reset becomes illegal until deploy completes, stranding a stamped tree after a failure',
    from: "  if (step === 'reset') return completed.includes('stamp');",
    to: "  if (step === 'reset') return completed.includes('deploy');",
  },
  {
    id: 'final-invariant-hardwired-ok',
    detail: 'the end-state check always passes, so a stamped tree or mismatched pair ships silently',
    from: 'export function judgeFinalState(state: DeployGateState): StepVerdict {',
    to: 'export function judgeFinalState(state: DeployGateState): StepVerdict {\n  if (true as boolean) return { ok: true };',
  },
];

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

function suiteGreen() {
  try {
    execFileSync('npx', ['jest', '--silent', '--runTestsByPath', SUITE], {
      cwd: path.join(HERE, '..'),
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

const original = readFileSync(TARGET, 'utf8');
const originalSha = sha(original);
let survivors = 0;

try {
  if (!suiteGreen()) {
    console.error('PRECONDITION FAILED: the suite is not green on unmutated source.');
    process.exit(2);
  }
  for (const mutant of MUTANTS) {
    if (!original.includes(mutant.from)) {
      console.error(`MUTANT ${mutant.id}: anchor text not found — the harness has drifted from the source.`);
      survivors += 1;
      continue;
    }
    writeFileSync(TARGET, original.replace(mutant.from, mutant.to));
    const killed = !suiteGreen();
    writeFileSync(TARGET, original);
    console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${mutant.id} — ${mutant.detail}`);
    if (!killed) survivors += 1;
  }
} finally {
  writeFileSync(TARGET, original);
  if (sha(readFileSync(TARGET, 'utf8')) !== originalSha) {
    console.error('RESTORE FAILED: source is not byte-identical.');
    process.exit(3);
  }
}

if (survivors > 0) {
  console.error(`${survivors} SURVIVOR(S) — the battery does not kill every weakening.`);
  process.exit(1);
}
console.log(`all ${MUTANTS.length} mutants killed; source restored byte-identical (${originalSha.slice(0, 12)}).`);

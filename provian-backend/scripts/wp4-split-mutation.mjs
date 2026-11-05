/**
 * mutation battery for the single-contributor batch split.
 *
 * The split is a settlement-planner money-path change (it decides how an
 * oversized contributor's claims become kernel transactions), so per the run
 * contract it ships with mutation coverage: every mutant below is a REAL
 * semantic weakening of `batch-bounds.ts`, and the batch-bounds jest suite
 * must go RED for each. A SURVIVOR is a finding and exits 1; it is never
 * silently re-baselined. Source is restored byte-identical (SHA-256 verified)
 * on every exit path.
 *
 * node scripts/wp4-split-mutation.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, '..', 'src', 'core', 'pvt', 'wp4', 'batch-bounds.ts');
const SUITE = 'src/core/pvt/wp4/batch-bounds.test.ts';

const MUTANTS = [
  {
    id: 'slice-overrun',
    detail: 'a slice may exceed the alone-bound by one claim',
    from: 'const slice = item.claimIds.slice(start, start + sliceBound);',
    to: 'const slice = item.claimIds.slice(start, start + sliceBound + 1);',
  },
  {
    id: 'trailing-slice-dropped',
    detail: 'the final partial slice of a split contributor is silently dropped',
    from: 'for (let start = 0; start < item.claimIds.length; start += sliceBound) {',
    to: 'for (let start = 0; start + sliceBound < item.claimIds.length; start += sliceBound) {',
  },
  {
    id: 'pre-split-flush-skipped',
    detail: 'the batch open before the split leaks into the first slice',
    from: 'if (!fits(limits, gasModel, 1, item.claimIds.length)) {\n      flush();',
    to: 'if (!fits(limits, gasModel, 1, item.claimIds.length)) {',
  },
  {
    id: 'gas-ignored-in-slice-bound',
    detail: 'the slice bound honors maxClaims only, so a gas-bound slice overruns maxGas',
    from: 'return Math.min(limits.maxClaims, byGas);',
    to: 'return limits.maxClaims;',
  },
  {
    id: 'slice-claims-uncounted',
    detail: 'slice claims are not counted, so claimCount and cursors go wrong',
    from: 'current.push({ contributor: item.contributor, claimIds: slice });\n        currentClaims += slice.length;',
    to: 'current.push({ contributor: item.contributor, claimIds: slice });',
  },
  {
    id: 'dup-claim-guard-short-circuited',
    detail: 'the cross-plan duplicate-claim-id guard is wired to its passing answer',
    from: 'if (seenClaimIds.has(normalized)) {',
    to: 'if (false as boolean && seenClaimIds.has(normalized)) {',
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

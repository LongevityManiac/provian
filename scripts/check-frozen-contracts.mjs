#!/usr/bin/env node
/**
 * Refuse to COMMIT a frozen contract whose bytes are not the pinned bytes.
 *
 * WHY THIS EXISTS. `scripts/wp-mutation-harness.mjs` mutates contract sources IN
 * PLACE and restores them afterwards. During that window the worktree genuinely
 * contains a mutated PVT9 kernel, and a concurrent `git add -A` captures it. That
 * happened once this project — it was caught by hand, restored, and amended. "Be
 * careful not to run `git add -A` while the harness runs" is an instruction, not a
 * control; this is the control.
 *
 * WHAT IT CHECKS. For every pinned path, the sha256 of the STAGED blob (what the
 * commit would actually contain, via `git show :<path>`) must equal the pin. It
 * deliberately reads the staged blob rather than the worktree file, because the
 * staged blob is what gets committed — a harness that has already restored the
 * worktree would otherwise hide a mutated index.
 *
 * FAIL CLOSED. A path that is staged but unreadable, a hash that cannot be
 * computed, or an unexpected git failure all REFUSE. Only an exact match passes.
 *
 * Install:  git config core.hooksPath .githooks
 * Run:      node scripts/check-frozen-contracts.mjs [--self-test]
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';

/**
 * Exact reviewed kernel and verifier bytes. BOOTSTRAP_ADMIN is a compile-time
 * constant with no transfer, renounce or setter; authority changes require a
 * separately reviewed successor architecture. Every staged byte must match.
 */
export const FROZEN_CONTRACT_SHA256 = Object.freeze({
  'contracts/src/ProvianPVT9.sol':
    '6fafddefe8c20490a813e13095bb466bccb6dd2b7a7b506c4c9f576497dd8a5d',
  'contracts/src/ProvianPVT9EligibilityVerifier.sol':
    'dc129c388219e05ca3cf55b80c4f9cd91d6628f2345556a62c8823b2103b8e02',
});

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Paths currently staged for commit. */
function stagedPaths() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf8',
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** The exact bytes the commit would contain for `path`. */
function readStagedBlob(path) {
  return execFileSync('git', ['show', `:${path}`], { maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Pure core, so the violating case is CONSTRUCTIBLE without staging a real
 * mutated kernel. `staged` is the list of staged paths; `read` returns the staged
 * bytes for one of them (and may throw, which must refuse).
 */
export function checkFrozenContracts(staged, read, pins = FROZEN_CONTRACT_SHA256) {
  const violations = [];
  let checked = 0;
  for (const path of Object.keys(pins)) {
    if (!staged.includes(path)) continue;
    checked += 1;
    let actual;
    try {
      actual = sha256(read(path));
    } catch (err) {
      violations.push({ path, expected: pins[path], actual: null, reason: `unreadable: ${err.message}` });
      continue;
    }
    if (actual !== pins[path]) {
      violations.push({ path, expected: pins[path], actual, reason: 'staged bytes are not the pinned bytes' });
    }
  }
  return { checked, violations, ok: violations.length === 0 };
}

/**
 * The RED control, permanent and in-band. It feeds the guard a deliberately
 * mutated kernel and asserts the guard REPORTS it — so this check can never be
 * green because it is dead. It also asserts the clean case passes, and that a
 * throwing reader refuses rather than silently skipping.
 */
function selfTest() {
  const path = 'contracts/src/ProvianPVT9.sol';
  const clean = Buffer.from('pinned-bytes');
  const pins = { [path]: sha256(clean) };

  const green = checkFrozenContracts([path], () => clean, pins);
  if (!green.ok || green.checked !== 1) throw new Error('SELF-TEST: clean kernel did not pass');

  const mutated = Buffer.concat([clean, Buffer.from(' // mutated by the harness')]);
  const red = checkFrozenContracts([path], () => mutated, pins);
  if (red.ok) throw new Error('SELF-TEST FAILED: a MUTATED kernel was allowed through');
  if (red.violations[0].path !== path) throw new Error('SELF-TEST: violation not attributed');

  const throwing = checkFrozenContracts([path], () => { throw new Error('boom'); }, pins);
  if (throwing.ok) throw new Error('SELF-TEST FAILED: an unreadable staged blob was allowed through');

  // Non-vacuity: an unstaged pinned path is not "checked", and that must be
  // visible rather than passing silently as if it had been verified.
  const skipped = checkFrozenContracts([], () => mutated, pins);
  if (skipped.checked !== 0) throw new Error('SELF-TEST: checked count is wrong');

  console.log('self-test ok — mutated kernel BLOCKED, unreadable blob BLOCKED, clean kernel passes');
}

function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return; }
  let result;
  try {
    result = checkFrozenContracts(stagedPaths(), readStagedBlob);
  } catch (err) {
    console.error(`frozen-contract check could not run, refusing the commit: ${err.message}`);
    process.exit(1);
  }
  if (result.ok) {
    if (result.checked > 0) console.log(`frozen-contract check ok (${result.checked} pinned path(s) staged)`);
    return;
  }
  console.error('\nCOMMIT REFUSED — a frozen contract is staged with bytes that are not the pinned bytes.');
  console.error('This is the `git add -A` during a mutation-harness run that captured a mutated kernel once before.\n');
  for (const v of result.violations) {
    console.error(`  ${v.path}\n    expected ${v.expected}\n    staged   ${v.actual ?? '(unreadable)'}\n    ${v.reason}`);
  }
  console.error('\nIf the harness is running, let it restore, then `git checkout -- contracts/src` and re-stage.');
  console.error('If you INTEND to change the kernel, that is run-contract stop #3 — update the pin deliberately.\n');
  process.exit(1);
}

main();

/**
 * mutation harness for the `no_pe_day` predicate.
 *
 * The directive requires: "Mutation-check the predicate. A mutant dropping any
 * conjunct must be KILLED." The contract mutation harness
 * (`scripts/wp-mutation-harness.mjs`) only targets Solidity, so this is its
 * TypeScript counterpart, scoped to exactly the six conjuncts of the R1
 * exemption plus the two fail-closed guards that make it sound.
 *
 * Each mutant DROPS or INVERTS one conjunct, then runs the suite. A
 * mutant is KILLED when the suite fails. A SURVIVOR means that conjunct is
 * unguarded — the exact failure mode found in the G1 strip test.
 *
 * Read-only against the repo in effect: the source is restored byte-identical
 * (verified by SHA-256) whether the run passes, fails, or throws.
 *
 * node scripts/wp12r-predicate-mutation.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, '..', 'src', 'core', 'pvt', 'wp11', 'cutover-inventory.ts');
const SUITE = 'src/core/pvt/wp11/';

/** Each mutant drops or inverts exactly one load-bearing conjunct/guard. */
const MUTANTS = [
  {
    name: 'drop status===empty',
    from: "  return row.status === 'empty'\n    && row.pe_count === 0",
    to: '  return row.pe_count === 0',
  },
  {
    name: 'drop pe_count===0',
    from: "    && row.pe_count === 0\n    && row.members_count === 0",
    to: '    && row.members_count === 0',
  },
  {
    name: 'drop members_count===0',
    from: '    && row.members_count === 0\n    && row.merkle_root_present === false',
    to: '    && row.merkle_root_present === false',
  },
  {
    name: 'drop merkle_root_present===false',
    from: '    && row.merkle_root_present === false\n    && row.anchor_tx_hash === null;',
    to: '    && row.anchor_tx_hash === null;',
  },
  {
    name: 'drop anchor_tx_hash===null',
    from: '    && row.merkle_root_present === false\n    && row.anchor_tx_hash === null;',
    to: '    && row.merkle_root_present === false;',
  },
  {
    name: 'drop the direct PE probe (6th conjunct)',
    from: '    const noPeDay = cheapConjunctsHold && probeCount === 0;',
    to: '    const noPeDay = cheapConjunctsHold;',
  },
  {
    name: 'treat a null probe as zero (fail-OPEN)',
    from: '    const noPeDay = cheapConjunctsHold && probeCount === 0;',
    to: '    const noPeDay = cheapConjunctsHold && (probeCount ?? 0) === 0;',
  },
  {
    // PE METER: the probe reads anchored membership (the relay keeps no pe_history).
    name: 'probe past the day window (a next-day PE counts)',
    from: '    if (ts >= bounds.startMs && ts < bounds.endMs) count += 1;',
    to: '    if (ts >= bounds.startMs && ts <= bounds.endMs) count += 1;',
  },
  {
    name: 'ignore anchored members swept into later batches',
    from: '    if (ts >= bounds.startMs && ts < bounds.endMs) count += 1;',
    to: '    if (ts < 0) count += 1;',
  },
  {
    name: 'ignore the row\'s skipped_no_hash PEs',
    from: "  let count = typeof row.skipped_no_hash === 'number' && row.skipped_no_hash > 0 ? row.skipped_no_hash : 0;",
    to: '  let count = 0;',
  },
  {
    name: 'accept a malformed day key instead of failing closed',
    from: '  if (dayKey === null || !DAY_KEY_RE.test(dayKey)) return null;',
    to: '  if (dayKey === null) return null;\n  if (!DAY_KEY_RE.test(dayKey)) return { startMs: 0, endMs: 0 };',
  },
];

const original = readFileSync(TARGET, 'utf8');
const originalHash = createHash('sha256').update(original).digest('hex');

function runSuite() {
  try {
    execFileSync('npx', ['jest', SUITE, '--silent'], {
      cwd: path.join(HERE, '..'), stdio: 'pipe', encoding: 'utf8',
    });
    return true; // suite green => mutant SURVIVED
  } catch {
    return false; // suite red => mutant KILLED
  }
}

let killed = 0;
let survived = 0;
let errored = 0;
try {
  // Sanity: the unmutated suite must be GREEN, or every "kill" is meaningless.
  if (!runSuite()) {
    console.error('BASELINE RED — the suite fails before any mutation. Aborting.');
    process.exit(2);
  }
  console.log('baseline GREEN\n');

  for (const mutant of MUTANTS) {
    if (!original.includes(mutant.from)) {
      console.log(`ERROR   ${mutant.name} — anchor text not found (predicate moved?)`);
      errored += 1;
      continue;
    }
    writeFileSync(TARGET, original.replace(mutant.from, mutant.to), 'utf8');
    const green = runSuite();
    writeFileSync(TARGET, original, 'utf8');
    if (green) {
      console.log(`SURVIVED ${mutant.name}  <-- UNGUARDED CONJUNCT`);
      survived += 1;
    } else {
      console.log(`KILLED   ${mutant.name}`);
      killed += 1;
    }
  }
} finally {
  writeFileSync(TARGET, original, 'utf8');
  const restoredHash = createHash('sha256').update(readFileSync(TARGET, 'utf8')).digest('hex');
  if (restoredHash !== originalHash) {
    console.error(`SOURCE NOT RESTORED: ${originalHash} -> ${restoredHash}`);
    process.exit(3);
  }
  console.log(`\nsource restored byte-identical (sha256 ${originalHash.slice(0, 12)}…)`);
}

console.log(`\n${killed} KILLED, ${survived} SURVIVED, ${errored} ERROR`);
process.exit(survived === 0 && errored === 0 ? 0 : 1);

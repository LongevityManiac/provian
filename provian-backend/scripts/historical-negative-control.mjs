#!/usr/bin/env node
/**
 * HISTORICAL NEGATIVE CONTROL — the M9 round-5 control standard.
 *
 * A hand-written mutation is a negative control the author chose. It proves the test can fail on
 * a defect the author already understood, which is never the defect that ships. Four M9 rounds
 * produced four tests that were green when written and green on the very implementations they
 * named; each was "verified" by a mutation the same author invented.
 *
 * THE STANDARD, from here on:
 *
 *   A negative control is the ACTUAL PRIOR BROKEN IMPLEMENTATION, extracted from git and run
 *   against the new test. If a test passes against the commit it was written to catch, it is
 *   not a test.
 *
 * This tool makes that executable. For each (function, historical commit, test) triple it
 * extracts the historical body of that function from git, splices it into the working tree in
 * place of the current one — leaving every other line at HEAD, so a RED is attributable to the
 * guard and not to unrelated drift — runs the named tests, and reports whether each went RED.
 *
 * A test that stays GREEN against the broken implementation it names is reported as NOT A TEST.
 *
 * The target file is restored with `git checkout --` in a finally block, and the run refuses to
 * start if the target has uncommitted changes, so restoration is always byte-identical.
 *
 * Usage:
 *   node scripts/historical-negative-control.mjs                 # run the manifest
 *   node scripts/historical-negative-control.mjs --manifest x.json
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(BACKEND, '..');

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });

/**
 * Extract one top-level function's exact text from a file's contents.
 *
 * Boundaries: the line beginning `export ... function <name>(` through the first subsequent line
 * that is exactly `}`. Every function this tool targets is top-level and brace-terminated at
 * column 0; anything else throws rather than splicing a guess.
 */
function extractFunction(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^(export )?(async )?function ${name}\\(`).test(l));
  if (start === -1) throw new Error(`function_not_found:${name}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) throw new Error(`function_end_not_found:${name}`);
  return { text: lines.slice(start, end + 1).join('\n'), start, end };
}

function spliceFunction(currentSource, name, replacementText) {
  const { start, end } = extractFunction(currentSource, name);
  const lines = currentSource.split('\n');
  return [...lines.slice(0, start), replacementText, ...lines.slice(end + 1)].join('\n');
}

/**
 * Run one jest test by exact name. Returns 'RED' if it failed, 'GREEN' if it passed.
 *
 * `--testNamePattern` is given the literal test name with regex metacharacters escaped, so a
 * name containing `(` or `.` selects itself and not a superset.
 */
function runTest(testFile, testName, timeoutMs) {
  const pattern = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // spawnSync, not execFileSync: jest writes its summary to STDERR, and execFileSync returns only
  // stdout on success. Reading stdout alone made every genuine pass look like a run that never
  // happened — the harness's own version of the defect it exists to catch.
  const r = spawnSync(
    'npx',
    ['jest', '--runTestsByPath', testFile, '--testNamePattern', pattern],
    {
      cwd: BACKEND,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 << 20,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    },
  );
  // ANSI must be stripped before ANY matching: jest colourises `error TS2353` as
  // `error<esc>[0m<esc>[90m TS2353`, so the compile-failure probe below silently missed every
  // compile failure and read them all as RED — the false control, one more level up.
  // eslint-disable-next-line no-control-regex
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\[[0-9;]*m/g, '');
  // A hang cannot fail from inside; it is bounded from outside and reported as its own status.
  if (r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT') return 'TIMEOUT';

  // THE FALSE RED, and the reason this check exists.
  //
  // Splicing the ORIGINAL implementation made the whole suite fail to COMPILE — its option was
  // `scanLimit`, the tests pass `pageSize` — so every test in the file "failed" against it, and
  // the first run of this tool read all four of those as RED and reported the properties
  // vindicated. A non-zero exit is not evidence a test DETECTED anything; a prior whose
  // signature the test file cannot even typecheck against is disqualified as a control, not
  // promoted to a passing one. This is the same defect the tool exists to catch, one level up.
  if (/Test suite failed to run/.test(out) && /error TS\d+/.test(out)) return 'COMPILE_FAIL';

  // A pattern that matches NOTHING exits 0 with zero tests run. That is not a GREEN — it is the
  // empty population in its purest form, and it must never be read as one.
  const ran = /(^|\n)Tests:\s+(?!0 total)/.test(out);
  if (!ran) return 'NO_TESTS_RAN';
  if (r.status === 0) return 'GREEN';
  // A RED must be ATTRIBUTABLE. Carry the first assertion line back so the report shows the test
  // failed on the defect rather than on some unrelated breakage the splice happened to cause.
  const m = out.match(/●[^\n]*\n+\s*([^\n]+)/);
  return { verdict: 'RED', reason: (m?.[1] ?? '').trim().slice(0, 160) };
}

const DEFAULT_MANIFEST = {
  controls: [
    {
      file: 'provian-backend/src/core/pvt/wp4/durable-settlement-store.ts',
      fn: 'assertNoLegacyLedgerRows',
      testFile: 'src/core/pvt/wp4/settlement-cycle-runner.test.ts',
      // The two genuinely broken prior implementations of this guard. Round 3 (2b9256da) and
      // round 4 (eb7ccedd) share a byte-identical guard — round 4 changed only tests — so round 3
      // is not a distinct implementation and is not listed.
      priors: [
        { commit: '2c491043', defect: 'ORIGINAL — a single unbounded 500-row read; a legacy row past row 500 was never seen and the scan reported clean' },
        { commit: 'adc1d8a2', defect: 'unconditional truncation throw at maxScan halts a healthy ledger; cursors on non-unique pe_id' },
        { commit: 'afa3f656', defect: 'same halt moved by exactly one row; size cap retained' },
      ],
      // Each test names the prior implementations it is WRITTEN TO CATCH. That binding is the
      // whole standard: a test is refuted by staying GREEN on a commit it claims, and a test
      // claiming nothing is not thereby vindicated — it is DECLARED as having no executable
      // historical control, with the reason, rather than being counted as a pass.
      tests: [
        {
          name: 'M9r3 — a CLEAN ledger passes at ANY size, INCLUDING past any budget that could return',
          catches: ['2c491043', 'adc1d8a2', 'afa3f656'],
        },
        {
          name: 'M9r3 — the stall backstop FIRES when the cursor field is absent, and is reachable',
          catches: ['2c491043', 'adc1d8a2', 'afa3f656'],
        },
        {
          name: 'M9r3 — RED: it still FINDS a legacy row, at every page size',
          catches: [],
          why: 'No implementation in this chain ever neutered legacy-row detection — that defect '
            + 'never shipped, so no historical control for it exists. The test is a standing '
            + 'guard against a future regression, NOT evidence about any past one. Its GREEN on '
            + 'all three priors is expected and proves nothing.',
        },
        {
          name: 'M9r3 — a DUPLICATE claim id is refused, including one split across a page boundary',
          catches: ['2c491043', 'adc1d8a2', 'afa3f656'],
        },
      ],
      // The stall-backstop property's negative control is a HANG, not a failure: a
      // non-terminating loop cannot fail fast from inside. It is bounded from OUTSIDE here, and
      // a TIMEOUT is reported as its own status rather than being collapsed into RED.
      timeoutMs: 120_000,
    },
    {
      // M10 — the legacy-checkpoint widening. The prior implementation is the shipped one that
      // refused both live Base checkpoints on shape and took agent onboarding down.
      file: 'provian-backend/src/core/pvt/watcher-address-admission.ts',
      fn: 'parseCheckpoint',
      testFile: 'src/core/pvt/parse-checkpoint-legacy-shape.test.ts',
      priors: [
        { commit: '0a4e5c64', defect: 'exactly-four-keys shape gate refused the two live legacy checkpoints' },
      ],
      tests: [
        {
          name: 'genesis_inbound_checkpoints/8453',
          catches: ['0a4e5c64'],
        },
        {
          name: 'activity_outbound_checkpoints/8453',
          catches: ['0a4e5c64'],
        },
        {
          name: 'a PRESENT but invalid generation still throws — widening did not weaken this',
          catches: [],
          why: 'This asserts a refusal the prior implementation ALSO made correctly. It guards the '
            + 'widening against future loosening, so it is expected to stay green on the prior '
            + 'commit; that green is not evidence about the defect.',
        },
      ],
      timeoutMs: 120_000,
    },
  ],
};

function main() {
  const argv = process.argv.slice(2);
  const manifestArg = argv.indexOf('--manifest');
  const manifest = manifestArg === -1
    ? DEFAULT_MANIFEST
    : JSON.parse(readFileSync(resolve(process.cwd(), argv[manifestArg + 1]), 'utf8'));

  const rows = [];
  for (const control of manifest.controls) {
    const abs = resolve(REPO, control.file);

    // Restoration is only byte-identical if the target starts clean. Refuse otherwise.
    if (git(['status', '--porcelain', '--', control.file]).trim() !== '') {
      throw new Error(`target_file_dirty:${control.file} — commit or stash before running a control`);
    }
    const pristine = readFileSync(abs, 'utf8');

    for (const prior of control.priors) {
      const historicalSource = git(['show', `${prior.commit}:${control.file}`]);
      const historical = extractFunction(historicalSource, control.fn);
      const currentText = extractFunction(pristine, control.fn).text;

      if (historical.text === currentText) {
        console.log(`SKIP ${prior.commit}: ${control.fn} is byte-identical to HEAD — not a distinct implementation`);
        continue;
      }

      console.log(`\n=== ${control.fn} @ ${prior.commit} ===\n${prior.defect}\n`);
      try {
        writeFileSync(abs, spliceFunction(pristine, control.fn, historical.text));
        for (const test of control.tests) {
          const raw = runTest(control.testFile, test.name, control.timeoutMs ?? 120_000);
          const verdict = typeof raw === 'string' ? raw : raw.verdict;
          const reason = typeof raw === 'string' ? '' : raw.reason;
          const claimed = test.catches.includes(prior.commit);
          rows.push({ commit: prior.commit, test, verdict, reason, claimed });
          console.log(`  ${verdict.padEnd(12)}  ${claimed ? '[claimed]' : '[   —   ]'}  ${test.name}`);
          if (reason) console.log(`               ↳ ${reason}`);
        }
      } finally {
        git(['checkout', '--', control.file]);
        if (readFileSync(abs, 'utf8') !== pristine) throw new Error(`restore_failed:${control.file}`);
      }
    }
  }

  // A property SURVIVES only if it went RED (or TIMEOUT, for a hang-shaped control) on every
  // prior it CLAIMS. GREEN on a claimed prior means the test could not have caught the defect it
  // was written for. A property claiming no prior is DECLARED, never counted as a pass — the
  // empty population is its own status, exactly as the run contract requires.
  const byTest = new Map();
  for (const r of rows) {
    if (!byTest.has(r.test.name)) byTest.set(r.test.name, { test: r.test, results: [] });
    byTest.get(r.test.name).results.push(r);
  }

  console.log('\n================ VERDICT ================');
  let failures = 0;
  let declared = 0;
  for (const [name, { test, results }] of byTest) {
    const detail = results.map((r) => `${r.commit}:${r.verdict}`).join(' ');
    // A COMPILE_FAIL prior is DISQUALIFIED, not evidence in either direction: the test never ran
    // against it, so it neither caught nor missed the defect.
    const usable = results.filter((r) => r.claimed && r.verdict !== 'COMPILE_FAIL');
    const disqualified = results.filter((r) => r.claimed && r.verdict === 'COMPILE_FAIL');
    const dqNote = disqualified.length
      ? `\n            DISQUALIFIED (never compiled, no evidence): ${disqualified.map((r) => r.commit).join(' ')}`
      : '';

    if (results.filter((r) => r.claimed).length === 0) {
      declared += 1;
      console.log(`DECLARED    ${name}\n            ${detail}\n            NO HISTORICAL CONTROL: ${test.why}`);
      continue;
    }
    if (usable.length === 0) {
      declared += 1;
      console.log(`DECLARED    ${name}\n            ${detail}${dqNote}\n            Every claimed prior was disqualified — this property has NO usable historical control.`);
      continue;
    }
    const caught = usable.every((r) => r.verdict === 'RED' || r.verdict === 'TIMEOUT');
    if (!caught) failures += 1;
    console.log(`${caught ? 'SURVIVES ' : 'NOT A TEST'}  ${name}\n            ${detail}${dqNote}`);
  }
  console.log('=========================================');
  const survived = byTest.size - failures - declared;
  console.log(`${survived} survive · ${failures} refuted · ${declared} declared (no historical control)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

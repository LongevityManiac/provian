/**
 * mutation harness for THE GATE SURFACE.
 *
 * The pre-existing harness (`wp12r2-reader-mutation.mjs`) covers the chain
 * reader and the contract resolver. It does NOT cover the reconciliation
 * checkers, the cursor derivation, or the gate predicate — which is precisely
 * where all three instances of the run's recurring defect class landed: a guard
 * that cannot fail.
 *
 * That is not a coincidence. A test asserting a property of its own
 * construction cannot kill a mutant of the real code, so mutation coverage over
 * this surface would have surfaced all three as SURVIVED. This harness is that
 * coverage.
 *
 * Every mutant below is a REAL semantic weakening — a dropped conjunct, an
 * added tolerance, a guard short-circuited to its passing answer. A SURVIVOR is
 * a finding and is reported as one; it is never silently re-baselined. A mutant
 * marked `equivalent: true` must carry sweep evidence of the same quality as
 * the U+0000–U+2FFF sweep already performed for the bool-decode mutant.
 *
 * Source is restored byte-identical (SHA-256 verified) on every exit path.
 *
 * node scripts/wp12r3-gate-mutation.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CUTOVER_ROOT = path.join(HERE, '..', 'src', 'core', 'pvt', 'wp11');
const INVENTORY = path.join(CUTOVER_ROOT, 'cutover-inventory.ts');
const RECONCILIATION = path.join(CUTOVER_ROOT, 'cutover-reconciliation.ts');
const CURSORS = path.join(CUTOVER_ROOT, 'cutover-cursors.ts');
const HARD_STOPS = path.join(CUTOVER_ROOT, 'cutover-hard-stops.ts');
const EXCLUSIONS = path.join(CUTOVER_ROOT, 'cutover-scope-exclusions.ts');
const VARIANCES = path.join(CUTOVER_ROOT, 'cutover-documented-variances.ts');
// the arm-time guards are part of the same gate surface — they decide
// what the ONE irreversible call sends and whether what landed is checked.
const ACTIVATION_ROOT = path.join(HERE, '..', 'src', 'core', 'pvt', 'wp12');
const ARM_GUARDS = path.join(ACTIVATION_ROOT, 'arm-guards.ts');
const SUITES = ['src/core/pvt/wp11/', 'src/core/pvt/wp12/'];

const MUTANTS = [
  // ---- wp12/arm-guards.ts — the arm-time guards -----------------
  // These three decide what the ONE irreversible call sends, and whether what
  // actually landed is ever compared to what was meant. Each must die.
  {
    file: ARM_GUARDS,
    name: 'arm guard 1: accept ANY --cursor the operator supplies',
    from: '  if (supplied !== INTENDED_INITIAL_FINALIZED_CURSOR) {',
    to: '  if (false && supplied !== INTENDED_INITIAL_FINALIZED_CURSOR) {',
  },
  {
    file: ARM_GUARDS,
    name: 'arm guard 1: a non-numeric --cursor falls through instead of being refused',
    from: "  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) {",
    to: "  if (false && !/^(0|[1-9][0-9]*)$/.test(trimmed)) {",
  },
  {
    file: ARM_GUARDS,
    name: 'arm guard 3: the post-arm readback never reports a mismatch',
    from: '    if (check.expected !== check.actual) {',
    to: '    if (false && check.expected !== check.actual) {',
  },
  {
    file: ARM_GUARDS,
    name: 'arm guard 3: the readback silently skips the cursor field',
    from: `    {
      field: 'nextFinalizedCursor',
      expected: intended.initialFinalizedCursor.toString(),
      actual: onChain.nextFinalizedCursor.toString(),
    },`,
    to: '',
  },
  {
    file: ARM_GUARDS,
    name: 'arm guard 3: a policy field is dropped from the covered-field list',
    from: "  'getEpochPolicy(0).genesisCap',\n",
    to: '',
  },
  {
    file: ARM_GUARDS,
    name: 'arm guard 1: the shared-constant binding check always answers yes',
    from: '  return imports && derives;',
    to: '  return true;',
  },
  {
    file: ARM_GUARDS,
    name: 'arm guard 2: the ambiguous-cursor scan reports nothing',
    from: '      if (re.test(lines[i])) {',
    to: '      if (false && re.test(lines[i])) {',
  },
  {
    file: ARM_GUARDS,
    name: 'arm guard 2: an EMPTY source is a silent pass instead of a hit',
    from: '  if (source.trim().length === 0) {',
    to: '  if (false && source.trim().length === 0) {',
  },
  // ---- cutover-cursors.ts — the non-overlap fence -------------------------
  {
    file: CURSORS,
    name: 'cursors: cut line may EQUAL the last settled timestamp (off-by-one on the fence)',
    from: '  if (settledFence !== null && cursors.pvt9_start.starts_after_ms <= settledFence) {',
    to: '  if (settledFence !== null && cursors.pvt9_start.starts_after_ms < settledFence) {',
  },
  {
    file: CURSORS,
    name: 'cursors: stop reporting a configured legacy_migration as a violation',
    from: '  if (cursors.pvt9_start.legacy_migration_configured) {',
    to: '  if (false && cursors.pvt9_start.legacy_migration_configured) {',
  },
  {
    file: CURSORS,
    // the literal `'0'` moved into the exported
    // KERNEL_NEXT_FINALIZED_CURSOR_START, which the P6 arm script now binds to.
    // The anchor moves with it; the mutant is the same one.
    name: 'cursors: stop requiring the PVT9 kernel cursor to start at 0',
    from: '  if (cursors.pvt9_start.kernel_next_finalized_cursor_start !== KERNEL_NEXT_FINALIZED_CURSOR_START) {',
    to: '  if (false && cursors.pvt9_start.kernel_next_finalized_cursor_start !== KERNEL_NEXT_FINALIZED_CURSOR_START) {',
  },
  {
    file: CURSORS,
    name: 'cursors: settled fence takes the MIN leaf timestamp instead of the MAX',
    from: '      maxTs = maxTs === null ? row.max_leaf_timestamp_ms : Math.max(maxTs, row.max_leaf_timestamp_ms);',
    to: '      maxTs = maxTs === null ? row.max_leaf_timestamp_ms : Math.min(maxTs, row.max_leaf_timestamp_ms);',
  },
  {
    file: CURSORS,
    name: 'cursors: kernel_deployed requires BOTH witnesses instead of either',
    from: "      kernel_deployed: inventory.pvt9_posture.pvt9_deployment_status !== 'not_deployed'\n        || inventory.pvt9_posture.pvt9_address !== null,",
    to: "      kernel_deployed: inventory.pvt9_posture.pvt9_deployment_status !== 'not_deployed'\n        && inventory.pvt9_posture.pvt9_address !== null,",
  },

  // ---- cutover-reconciliation.ts — the checkers ---------------------------
  {
    // C1's verdict moved to `judgeC1` (documented-variance pin).
    file: VARIANCES,
    name: 'C1: drop the orphan-snapshot conjunct',
    from: '    && sortedEqual(populations.orphans, expected.orphans)\n',
    to: '\n',
  },
  {
    file: RECONCILIATION,
    name: 'C1: allow a scope ruling to excuse a phantom mint (marked, no durable tx)',
    from: "      .filter((b) => b.marked && b.mint_tx_hash === null)\n      .map((b) => b.batch_id);",
    to: '      .filter((b) => b.marked && b.mint_tx_hash === null)\n      .map((b) => b.batch_id).filter((id) => !isScopeExcluded(id));',
    // EQUIVALENT, with a WHOLE-DOMAIN proof rather than a sample: SCOPE_EXCLUSIONS
    // is empty, so `!isScopeExcluded(x)` is the constant `true` for every input
    // and the filter is the identity function. Asserted in cutover-wp12r3.test.ts
    // (EQ-1/EQ-2), which also proves the two forms DIVERGE the instant any row
    // asks to be excluded — so the equivalence is bounded, not permanent.
    equivalent: true,
  },
  {
    file: RECONCILIATION,
    name: 'C2: drop the exact leaf-vs-PE points equality',
    from: '      && b.total_pe_points_atomic === b.total_leaf_points_atomic\n    )).map((b) => b.batch_id);',
    to: '    )).map((b) => b.batch_id);',
    // NOT EQUIVALENT — this carried `equivalent: true` and the label was WRONG.
    // The reviewer produced the distinguishing input: a DUPLICATE
    // contributor address plus an extra distinct leaf address makes
    // `byContributor.size === contributors.length` true by coincidence, so the
    // bijection the excuse assumed does not exist and the totals differ (10 vs
    // 12) while every other conjunct holds. The excusing "proof" was a
    // tautology that called no production symbol. Killed now by the real
    // fixture in cutover-wp12r3.test.ts (EQ-3).
  },
  {
    file: RECONCILIATION,
    name: 'C3: stop failing on an invalid recipient address',
    from: "    const bad = snapshotRows\n      .filter((b) => !b.recipients_all_valid_addresses)",
    to: '    const bad = snapshotRows\n      .filter(() => false)',
  },
  {
    file: RECONCILIATION,
    name: 'C5: classify EVERY inconsistent anchor day as a no-PE day',
    from: '    const unresolved = inconsistent.filter((a) => !a.no_pe_day);',
    to: '    const unresolved = inconsistent.filter(() => false);',
  },
  {
    // C6's verdict moved to `judgeC6`; the pinned delta's tolerance is 1e-9.
    file: VARIANCES,
    name: 'C6: widen the pinned pool/ledger delta tolerance',
    from: '  return Math.abs(delta - pinned.ledger_minus_pool_pvt) <= pinned.tolerance_pvt',
    to: '  return Math.abs(delta - pinned.ledger_minus_pool_pvt) <= 1',
  },
  {
    file: RECONCILIATION,
    name: 'C7: stop requiring legacy_migration to be false (structural zero-carry)',
    from: '      && posture.legacy_migration === false,',
    to: '      && true,',
  },
  {
    file: RECONCILIATION,
    name: 'C11: stop recording a batch the chain did not confirm',
    from: '        if (!minted) unconfirmed.push(batch.batch_id);',
    to: '        if (false && !minted) unconfirmed.push(batch.batch_id);',
  },
  {
    file: RECONCILIATION,
    name: 'C12: drop the legacy-batch-binding conjunct (identifier-space bleed)',
    from: '      && stores.claim_ledger_legacy_batch_binding_count === 0',
    to: '      && true',
    // NOT equivalent any more. The `claim_ledger_count === 0` conjunct
    // that bounded it is gone (C12 reframed to no-legacy-bleed), so the
    // settled-legacy-binding fixture in cutover-reconciliation.test.ts kills it.
  },
  {
    file: RECONCILIATION,
    name: 'check(): a pass over ZERO items reports `pass` instead of `vacuous_pass`',
    from: "    : evaluatedItems === 0 ? 'vacuous_pass' : 'pass';",
    to: "    : 'pass';",
  },
  {
    file: RECONCILIATION,
    name: 'notEvaluated(): an unbound chain reader reports `pass` instead of not_evaluated',
    from: "  return { id, status: 'not_evaluated', detail, evaluated_items: 0 };",
    to: "  return { id, status: 'pass', detail, evaluated_items: 1 };",
  },
  {
    file: RECONCILIATION,
    name: 'HARD STOP 3: accept an acknowledgement with no written cause',
    from: '  if (uncaused.length > 0) {',
    to: '  if (false && uncaused.length > 0) {',
  },
  {
    file: RECONCILIATION,
    name: 'HARD STOP 5: restore the old predicate (an acknowledged vacuous check reconciles)',
    from: '  const allPass = isGateReconciled(checks);',
    to: "  const acknowledgedSet = new Set(acknowledged);\n  const allPass = checks.every((c) => c.status === 'pass'\n    || (c.status === 'vacuous_pass' && acknowledgedSet.has(c.id)));",
  },

  // ---- cutover-hard-stops.ts — the guards themselves ----------------------
  {
    file: HARD_STOPS,
    name: 'gate predicate: drop the evaluated_items > 0 conjunct',
    from: "  return checks.every((c) => c.status === 'pass' && c.evaluated_items > 0);",
    to: "  return checks.every((c) => c.status === 'pass');",
  },
  {
    file: HARD_STOPS,
    name: 'gate predicate: an EMPTY check list counts as reconciled',
    from: '  if (checks.length === 0) return false;',
    to: '  if (checks.length === 0) return true;',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 2: real-mint witnesses become a conjunction instead of a disjunction',
    from: '  return hasTx || row.batch_minted_on_correct_contract === true || row.bound_pe_count > 0;',
    to: '  return hasTx && row.batch_minted_on_correct_contract === true && row.bound_pe_count > 0;',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 2: honour `excluded: true` regardless of mint evidence',
    from: '    if (documentCarriesRealMint(row)) refused.push(row.document_id);\n    else exclusions.add(row.document_id);',
    to: '    exclusions.add(row.document_id);',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 3: every acknowledgement is treated as caused',
    from: '  return [...new Set(acknowledgedCheckIds)]\n    .filter((id) => writtenCauseFor(id) === null)\n    .sort();',
    to: '  return [];',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 3: a placeholder counts as a written cause',
    from: '  return cause.cause.trim().length >= MIN_WRITTEN_CAUSE_CHARS\n    && cause.becomes_non_empty_when.trim().length > 0;',
    to: '  return true;',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 1: the probe judge never finds a violation',
    from: "  if (outcome.kind === 'threw') return false; // silence, correctly expressed",
    to: '  return false;',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 4: the write-surface scan reports nothing',
    from: '  const hits: WriteSurfaceHit[] = [];\n  for (const rel of relativeFiles) {',
    to: '  const hits: WriteSurfaceHit[] = [];\n  if (true) return hits;\n  for (const rel of relativeFiles) {',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 4: a file that cannot be read is treated as clean',
    from: "      hits.push({ file: rel, line: 0, pattern: 'unreadable', text: 'file could not be read' });\n      continue;",
    to: '      continue;',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 4: the read-only db proxy passes the handle through unguarded',
    from: '  return wrap(db) as T;',
    to: '  return db;',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 4: comment stripping eats real code too',
    from: "    const lineComment = line.indexOf('//');",
    to: "    const lineComment = 0 * line.length + (line.length > 0 ? 0 : -1);",
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 6: the arming-claim scan reports nothing',
    from: '  const hits: ArmingClaimHit[] = [];\n  for (const file of absoluteFiles) {',
    to: '  const hits: ArmingClaimHit[] = [];\n  if (true) return hits;\n  for (const file of absoluteFiles) {',
  },
  {
    file: HARD_STOPS,
    name: 'HARD STOP 6: every arming mention is treated as conditional',
    from: '  return ARMING_CONDITIONAL_CUES.some((re) => re.test(line));',
    to: '  return true;',
  },

  // ---- HARD STOP 4, the shape the rule actually names ---------------------
  {
    file: INVENTORY,
    name: 'HARD STOP 4: a CONDITIONAL corrective write to the money document',
    // The reviewer planted exactly this and the whole suite stayed
    // green: the source scan was line-scoped, and the behavioural proxy only
    // ever ran against the healthy fixture where pool === ledgerTotal, so the
    // corrective branch was DEAD CODE under the guard. Both are fixed; this
    // mutant is what proves it, because it is live only on a DISCREPANCY.
    from: '  const posture: Pvt9PostureInventory = {',
    to: `  if (genesisInventory.pool_minted_pvt !== null
    && genesisInventory.pool_minted_pvt !== genesisInventory.wallet_ledger_issued_total_pvt) {
    await (db as unknown as { collection(n: string): { doc(i: string): { update(v: unknown): Promise<unknown> } } })
      .collection('genesis_campaign_state')
      .doc('global')
      .update({ pool_minted_pvt: genesisInventory.wallet_ledger_issued_total_pvt });
  }
  const posture: Pvt9PostureInventory = {`,
  },

  // ---- cutover-scope-exclusions.ts — the wiring ---------------------------
  {
    file: EXCLUSIONS,
    name: 'exclusions: bypass the hard-stop derivation and trust the table',
    from: 'const SCOPE_DERIVATION = deriveScopeExclusions(C1_SCOPE_EVIDENCE);',
    to: "const SCOPE_DERIVATION = { exclusions: new Set(C1_SCOPE_EVIDENCE.filter((r) => r.excluded).map((r) => r.document_id)), refused: [] as string[] };",
    // EQUIVALENT while no row carries `excluded: true` — the same bounded
    // domain proof as the C1 filter above (EQ-1/EQ-2).
    equivalent: true,
  },

  // ---- cutover-inventory.ts — populations the checkers depend on ----------
  {
    file: INVENTORY,
    name: 'inventory: recipient validity stops requiring lowercase (the C3 defect, un-found)',
    from: '        return addr !== null && EVM_ADDRESS_RE.test(addr) && addr === addr.toLowerCase();',
    to: '        return addr !== null && EVM_ADDRESS_RE.test(addr);',
  },
  {
    file: INVENTORY,
    name: 'inventory: an empty contributor list counts as valid recipients',
    from: '    recipientsOk = contributors !== null && contributors.length > 0',
    to: '    recipientsOk = contributors === null || contributors.length === 0 || true;\n    if (false) recipientsOk = contributors !== null && contributors.length > 0',
  },
];

const sources = new Map();
for (const file of new Set(MUTANTS.map((m) => m.file))) {
  sources.set(file, readFileSync(file, 'utf8'));
}
const hashes = new Map(
  [...sources].map(([f, s]) => [f, createHash('sha256').update(s).digest('hex')]),
);

function runSuite() {
  try {
    execFileSync('npx', ['jest', ...SUITES, '--silent'], {
      cwd: path.join(HERE, '..'), stdio: 'pipe', encoding: 'utf8',
    });
    return true; // green => mutant SURVIVED
  } catch {
    return false; // red => mutant KILLED
  }
}

function restoreAll() {
  for (const [file, src] of sources) writeFileSync(file, src, 'utf8');
}

let killed = 0;
let survived = 0;
let equivalent = 0;
let errored = 0;
const survivors = [];
try {
  if (!runSuite()) {
    console.error('BASELINE RED — the suite fails before any mutation. Aborting.');
    process.exit(2);
  }
  console.log(`baseline GREEN — ${MUTANTS.length} mutants over ${sources.size} files\n`);

  for (const mutant of MUTANTS) {
    const src = sources.get(mutant.file);
    // Every anchor must be UNIQUE in its file. A mutant applied to the wrong
    // site proves nothing about the site it was meant to test, so a non-unique
    // anchor is an ERROR (which fails the harness) rather than a quiet
    // best-effort replacement.
    const occurrences = src.split(mutant.from).length - 1;
    if (occurrences !== 1) {
      console.log(`ERROR   ${mutant.name} — anchor found ${occurrences} times (expected exactly 1)`);
      errored += 1;
      continue;
    }
    writeFileSync(mutant.file, src.replace(mutant.from, mutant.to), 'utf8');
    const green = runSuite();
    restoreAll();
    if (green && mutant.equivalent === true) {
      console.log(`EQUIVALENT ${mutant.name}  (survives by construction — see note)`);
      equivalent += 1;
    } else if (green) {
      console.log(`SURVIVED ${mutant.name}  <-- FINDING: this weakening is unguarded`);
      survivors.push(mutant.name);
      survived += 1;
    } else {
      console.log(`KILLED   ${mutant.name}`);
      killed += 1;
    }
  }
} finally {
  restoreAll();
  for (const [file, expected] of hashes) {
    const actual = createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex');
    if (actual !== expected) {
      console.error(`SOURCE NOT RESTORED ${path.basename(file)}: ${expected} -> ${actual}`);
      process.exit(3);
    }
  }
  console.log(`\nsource restored byte-identical for all ${sources.size} files`);
}

console.log(`\n${killed} KILLED, ${equivalent} EQUIVALENT, ${survived} SURVIVED, ${errored} ERROR`);
if (survivors.length > 0) {
  console.log('\nFINDINGS (report these; never re-baseline them away):');
  for (const s of survivors) console.log(`  - ${s}`);
}
process.exit(survived === 0 && errored === 0 ? 0 : 1);

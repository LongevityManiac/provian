/**
 * C6's variance status is computed from the source tree.
 *
 * The pool/ledger variance is documented rather than blocking only while BOTH
 * proofs hold: the cleanup script is absent or unreachable, and every remaining
 * pool_minted_pvt writer is monotonic-increasing or gated. Either missing proof
 * blocks reconciliation. No corrective value is written: the residual arithmetic
 * cannot be reconstructed, so a delta patch would guess at the money counter.
 *
 * The scan re-enumerates writers on each run. A new ungated reducer must turn
 * this check red, including a reducer outside the explicit source-file list.
 * This module is read-only and cannot mint, settle, or grant authority.
 */

import { readFileSync, readdirSync, type Dirent } from 'fs';
import * as path from 'path';
import { flattenForScanning } from './cutover-hard-stops';

/** How a writer moves the counter. */
export type PoolWriterKind = 'increment' | 'decrement' | 'unclassified';

export interface PoolCounterWriter {
  /** Path relative to `provian-backend/`. */
  readonly file: string;
  readonly line: number;
  readonly kind: PoolWriterKind;
  readonly text: string;
}

/**
 * Files that may legitimately write the counter. A file NOT listed here that
 * writes it is invisible to this scan, which is why the corpus is asserted
 * non-empty and pinned by test rather than trusted.
 */
export const POOL_COUNTER_SOURCE_FILES: readonly string[] = [
  'src/core/pvt/genesis-campaign.ts',
  // The cleanup script is excluded from this writer list because it must be
  // absent. C6_CLEANUP_SCRIPT separately pins the path so restoring it blocks.
];

/**
 * Roots swept for a pool-counter write that is NOT in the two files above. A
 * reducer added to a third file would otherwise be invisible, and the whole
 * point of proof (b) is that it enumerate EVERY writer, not every writer in a
 * list someone last updated in 2026.
 */
export const POOL_COUNTER_SWEEP_ROOTS: readonly string[] = ['src', 'scripts'];

/** The counter whose every writer proof (b) must enumerate. */
export const POOL_COUNTER_FIELD = 'pool_minted_pvt';

/** Restoring the cleanup script at this path invalidates variance proof (a). */
export const C6_CLEANUP_SCRIPT = 'scripts/launch/genesis-stranger-run.ts';

/**
 * A write of the counter, matched over FLATTENED source (newlines collapsed).
 *
 * Flattening detects writes whose call and field assignment span lines.
 * A line-scoped scan can miss an ungated reducer and incorrectly accept the
 * variance. A multiline txn.set(globalRef, { pool_minted_pvt: poolMinted - 1 })
 * must therefore be detected just like its single-line spelling.
 *
 * A read-model object that merely CARRIES the field (`genesis-campaign.ts:936`
 * returns one) is not a writer: the pattern requires a write verb's call
 * parenthesis to be open when the assignment appears.
 */
const POOL_WRITE = new RegExp(
  // The captured expression must survive a comma INSIDE a call:
  // `Math.max(0, poolMinted - amount)` is the most dangerous writer in the
  // tree, and a comma-terminated capture reads it as `Math.max(0` and calls it
  // "unclassified" — losing the minus sign that makes it a reducer.
  String.raw`\b(?:set|update|create)\s*\([^;]{0,400}?\bpool_minted_pvt\s*:\s*((?:[^,;}()]|\([^()]*\))*)`,
  'g',
);

/**
 * Classify the assigned expression. `-` is tested FIRST, so an expression
 * carrying both signs reads as a decrement: Unknown = Block applies to
 * ambiguity about DIRECTION too, not just about whether a write happened.
 *
 * `FieldValue.increment(x)` is a decrement when x is negative — the name is a
 * lie about direction, and reading it literally is how a reducer hides.
 */
export function classifyPoolWrite(text: string): PoolWriterKind {
  const assigned = /pool_minted_pvt\s*:\s*(.+)$/.exec(text.trim());
  if (assigned === null) return 'unclassified';
  const expr = assigned[1];
  const fieldValue = /FieldValue\s*\.\s*increment\s*\(\s*(-?)/.exec(expr);
  if (fieldValue !== null) return fieldValue[1] === '-' ? 'decrement' : 'increment';
  // `Math.max(0, poolMinted - amount)` hides its minus past a comma, so the
  // whole expression is inspected rather than a comma-bounded prefix.
  if (/-/.test(expr)) return 'decrement';
  if (/\+/.test(expr)) return 'increment';
  return 'unclassified';
}

/**
 * Find every write of `pool_minted_pvt`. `backendRoot` is a parameter so a
 * negative control can point the same scan at a planted tree.
 */
export function findPoolCounterWriters(
  backendRoot: string,
  files: readonly string[] = POOL_COUNTER_SOURCE_FILES,
): readonly PoolCounterWriter[] {
  const out: PoolCounterWriter[] = [];
  for (const rel of files) {
    let source: string;
    try {
      source = readFileSync(path.join(backendRoot, rel), 'utf8');
    } catch {
      // Unreadable is a finding, never a clean scan.
      out.push({ file: rel, line: 0, kind: 'unclassified', text: 'file could not be read' });
      continue;
    }
    const { text, lineOf } = flattenForScanning(source);
    POOL_WRITE.lastIndex = 0;
    let m = POOL_WRITE.exec(text);
    while (m !== null) {
      const snippet = `pool_minted_pvt: ${m[1].trim()}`;
      out.push({
        file: rel,
        line: lineOf(m.index),
        kind: classifyPoolWrite(snippet),
        text: m[0].replace(/\s+/g, ' ').trim().slice(0, 160),
      });
      m = POOL_WRITE.exec(text);
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Sweep the whole tree for a pool-counter write outside
 * `POOL_COUNTER_SOURCE_FILES`. Proof (b) claims to enumerate EVERY writer; a
 * two-file allowlist can only ever enumerate every writer in the allowlist, so
 * this is what makes the claim true rather than merely maintained.
 */
export function findUnlistedPoolCounterFiles(
  backendRoot: string,
  roots: readonly string[] = POOL_COUNTER_SWEEP_ROOTS,
  known: readonly string[] = POOL_COUNTER_SOURCE_FILES,
): readonly string[] {
  const knownSet = new Set(known);
  const found: string[] = [];
  const walk = (rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(backendRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
        walk(child);
        continue;
      }
      if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
      // Not production writers, and each is excluded for a stated reason: a
      // test fixture SEEDS a store rather than writing the live counter, and a
      // mutation harness contains the write only as replacement TEXT.
      if (/\.test\.ts$/.test(entry.name)) continue;
      if (/-mutation\.mjs$/.test(entry.name)) continue;
      if (child.includes('__test-helpers__') || child.includes('__mocks__')) continue;
      if (knownSet.has(child)) continue;
      let source: string;
      try {
        source = readFileSync(path.join(backendRoot, child), 'utf8');
      } catch {
        continue;
      }
      if (!source.includes(POOL_COUNTER_FIELD)) continue;
      const { text } = flattenForScanning(source);
      POOL_WRITE.lastIndex = 0;
      if (POOL_WRITE.test(text)) found.push(child);
    }
  };
  for (const root of roots) walk(root);
  return found.sort();
}

export interface C6DowngradeVerdict {
  /** (a) — true iff the cleanup script is gone. */
  readonly cleanup_script_removed: boolean;
  /** (b) — true iff no writer decrements. */
  readonly all_writers_monotonic_or_gated: boolean;
  /** Every decrementing writer, by name. Empty is the only passing state. */
  readonly reducers: readonly string[];
  /** BOTH proofs, or C6 stays blocking. */
  readonly downgrade_eligible: boolean;
  readonly detail: string;
}

/**
 * The downgrade decision, as a total function of the two proofs. Written as a
 * conjunction over inputs the caller supplies so BOTH branches are reachable in
 * test — a verdict function that can only ever return one answer proves nothing
 * about the rule it claims to implement.
 */
export function judgeC6Downgrade(
  cleanupScriptRemoved: boolean,
  writers: readonly PoolCounterWriter[],
): C6DowngradeVerdict {
  const reducers = writers
    .filter((w) => w.kind !== 'increment')
    .map((w) => `${w.file}:${w.line}(${w.kind})`)
    .sort();
  const monotonic = reducers.length === 0;
  return {
    cleanup_script_removed: cleanupScriptRemoved,
    all_writers_monotonic_or_gated: monotonic,
    reducers,
    downgrade_eligible: cleanupScriptRemoved && monotonic,
    detail: `proof(a) cleanup_script_removed=${cleanupScriptRemoved}; `
      + `proof(b) monotonic=${monotonic} reducers=[${reducers.join(',')}]; `
      + 'C6 downgrades ONLY if both hold — no corrective value is written either way',
  };
}

/** True iff the cleanup script is absent from the tree. */
export function isCleanupScriptRemoved(backendRoot: string): boolean {
  try {
    readFileSync(path.join(backendRoot, C6_CLEANUP_SCRIPT), 'utf8');
    return false;
  } catch {
    return true;
  }
}

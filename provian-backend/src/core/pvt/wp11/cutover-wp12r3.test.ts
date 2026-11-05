/**
 * Cutover hard stops, each exercised against compliant and violating inputs.
 * A guard tested only against known-good data cannot distinguish enforcement
 * from a hard-wired success. Negative controls are permanent and in-suite.
 * Nothing here deploys, broadcasts, signs, arms, or writes.
 */
import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  CANONICAL_ABI_FALSE_WORD,
  CUTOVER_READ_ONLY_MODULES,
  CutoverWriteAttempted,
  FIRESTORE_WRITE_SURFACE_PATTERNS,
  MIN_WRITTEN_CAUSE_CHARS,
  SCAN_EXEMPT_MODULE,
  VACUOUS_CAUSE_REGISTRY,
  deriveScopeExclusions,
  documentCarriesRealMint,
  extractLiteralDeclarations,
  findRedeclaredLiterals,
  findAcknowledgementsWithoutWrittenCause,
  gateBlockers,
  isGateReconciled,
  isWrittenCause,
  probeOutcomeViolatesHardStop,
  readOnlyDbProxy,
  auditArmingRecord,
  scanForArmingClaims,
  scanForWriteSurface,
  stripCommentsPreservingLines,
  writtenCauseFor,
  type GateJudgeableCheck,
  type ScopeExclusionCandidate,
} from './cutover-hard-stops';
import {
  C1_SCOPE_EVIDENCE,
  REFUSED_SCOPE_EXCLUSIONS,
  SCOPE_EXCLUSIONS,
  isScopeExcluded,
} from './cutover-scope-exclusions';
import {
  makeRegistryBoundBatchMintedReader,
  type EthCallTransport,
} from './legacy-batch-minted-reader';
import { DOCUMENT_MINT_BINDINGS } from './legacy-mint-contract-registry';
import { reconcileCutoverInventory, runCutoverReconciliation } from './cutover-reconciliation';
import { takeCutoverInventory } from './cutover-inventory';
import {
  C6_CLEANUP_SCRIPT,
  classifyPoolWrite,
  findPoolCounterWriters,
  findUnlistedPoolCounterFiles,
  isCleanupScriptRemoved,
  judgeC6Downgrade,
} from './c6-downgrade-evidence';
import { deriveCutoverCursors, validateCursorNonOverlap } from './cutover-cursors';
import {
  CUT_LINE,
  seedHealthyCutoverStore,
} from '../__test-helpers__/healthy-cutover-store';

/** `provian-backend/` — three levels up from `src/core/pvt/wp11`. */
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ===========================================================================
// HARD STOP 1 — a chain probe must never return false when it could not reach
//               the correct contract.
// ===========================================================================

describe('HARD STOP 1 — silence is never a negative', () => {
  /**
   * The probe corpus. These are the test's own INPUTS, which is legitimate —
   * what would not be legitimate is a copy of the reader's decode RULE, since
   * asserting a rule against a copy of itself is the defect. The rule
   * here comes from `CANONICAL_ABI_FALSE_WORD`, one module-scope definition
   * shared by the guard and this suite.
   */
  const WORDS: readonly string[] = [
    CANONICAL_ABI_FALSE_WORD,
    `0x${'0'.repeat(63)}1`,
    `0x${'0'.repeat(62)}02`, // well-shaped, NOT a bool — a fallback's answer
    `0x${'f'.repeat(64)}`, // what a value-returning fallback often gives
    `0x${'0'.repeat(62)}ff`,
    `0x${'1'.repeat(64)}`,
    '0x', // no code at the address, or no such function
    `0x${'0'.repeat(63)}`, // short by one nibble
    `0x${'0'.repeat(65)}`, // long by one nibble
    'not-hex-at-all',
    '',
    `0x${'0'.repeat(63)}2`,
    // A sweep of every single-hex-digit last character, so the corpus is not a
    // hand-picked set that happens to miss the interesting one.
    ...'0123456789abcdefABCDEF'.split('').map((c) => `0x${'0'.repeat(63)}${c}`),
  ];

  const DOC = DOCUMENT_MINT_BINDINGS[0].document_id;

  async function probe(word: string): Promise<{ kind: 'threw' } | { kind: 'returned'; value: boolean }> {
    const transport: EthCallTransport = { ethCall: async () => word };
    const reader = makeRegistryBoundBatchMintedReader(transport);
    try {
      return { kind: 'returned', value: await reader.readBatchMinted(DOC, null) };
    } catch {
      return { kind: 'threw' };
    }
  }

  it('the real reader never answers false for any word but the canonical zero', async () => {
    for (const word of WORDS) {
      const outcome = await probe(word);
      expect({ word, violates: probeOutcomeViolatesHardStop(outcome, word) })
        .toEqual({ word, violates: false });
    }
  });

  it('NEGATIVE CONTROL — the judge catches a reader that maps non-bools to false', async () => {
    // The pre-`f167bcff` decode, reconstructed: accept any 32-byte word, then
    // `BigInt(word) === 1n`. If the judge cannot fail, this loop finds nothing
    // and the test above proves nothing either.
    const looseDecode = (word: string): { kind: 'threw' } | { kind: 'returned'; value: boolean } => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(word)) return { kind: 'threw' };
      return { kind: 'returned', value: BigInt(word) === 1n };
    };
    const violations = WORDS.filter((word) => probeOutcomeViolatesHardStop(looseDecode(word), word));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toContain(`0x${'0'.repeat(62)}02`);
    expect(violations).toContain(`0x${'f'.repeat(64)}`);
  });

  it('an unresolvable document THROWS rather than answering false', async () => {
    const reader = makeRegistryBoundBatchMintedReader({
      ethCall: async () => CANONICAL_ABI_FALSE_WORD,
    });
    const unknown = `0x${'9'.repeat(64)}`;
    await expect(reader.readBatchMinted(unknown, null)).rejects.toThrow(/unresolved/i);
    await expect(reader.readBatchMinted(unknown, `0x${'1'.repeat(40)}`))
      .rejects.toThrow(/UNIDENTIFIED/);
  });

  it('a transport error propagates rather than answering false', async () => {
    const reader = makeRegistryBoundBatchMintedReader({
      ethCall: async () => { throw new Error('ECONNRESET'); },
    });
    await expect(reader.readBatchMinted(DOC, null)).rejects.toThrow('ECONNRESET');
  });
});

// ===========================================================================
// HARD STOP 2 — no document carrying a real mint transaction may be present in
//               cutover-scope-exclusions.ts.
// ===========================================================================

describe('HARD STOP 2 — a real mint is in scope by definition', () => {
  it('the live exclusion set is empty and nothing was refused', () => {
    expect([...SCOPE_EXCLUSIONS]).toEqual([]);
    expect(REFUSED_SCOPE_EXCLUSIONS).toEqual([]);
  });

  it('every one of the five C1 documents carries a real mint, and none is excluded', () => {
    expect(C1_SCOPE_EVIDENCE.length).toBe(5);
    for (const row of C1_SCOPE_EVIDENCE) {
      expect({ id: row.document_id, mint: documentCarriesRealMint(row) })
        .toEqual({ id: row.document_id, mint: true });
      expect(isScopeExcluded(row.document_id)).toBe(false);
    }
  });

  it('NEGATIVE CONTROL — a row that asks to be excluded while carrying a mint is REFUSED', () => {
    // Each poisoned row trips exactly ONE of the three witnesses, so the guard
    // is proven to be a disjunction rather than a conjunction that any single
    // missing field could defeat.
    const base: ScopeExclusionCandidate = {
      document_id: 'poison_none',
      excluded: true,
      recorded_mint_tx_hash: null,
      batch_minted_on_correct_contract: false,
      bound_pe_count: 0,
    };
    const poisoned: readonly ScopeExclusionCandidate[] = [
      { ...base, document_id: 'poison_tx', recorded_mint_tx_hash: `0x${'a'.repeat(64)}` },
      { ...base, document_id: 'poison_chain', batch_minted_on_correct_contract: true },
      { ...base, document_id: 'poison_pe', bound_pe_count: 1 },
    ];
    const derived = deriveScopeExclusions(poisoned);
    expect(derived.refused).toEqual(['poison_chain', 'poison_pe', 'poison_tx']);
    expect([...derived.exclusions]).toEqual([]);
  });

  it('a document with NO mint evidence at all may still be excluded (the guard is not a blanket ban)', () => {
    const clean: ScopeExclusionCandidate = {
      document_id: 'clean_doc',
      excluded: true,
      recorded_mint_tx_hash: null,
      batch_minted_on_correct_contract: false,
      bound_pe_count: 0,
    };
    const derived = deriveScopeExclusions([clean]);
    expect([...derived.exclusions]).toEqual(['clean_doc']);
    expect(derived.refused).toEqual([]);
    // …and an empty-string tx hash is not a tx hash.
    expect(documentCarriesRealMint({ ...clean, recorded_mint_tx_hash: '  ' })).toBe(false);
  });
});

// ===========================================================================
// HARD STOP 3 — no vacuous check may be acknowledged without a written cause.
// ===========================================================================

describe('HARD STOP 3 — an acknowledgement needs a written cause', () => {
  it('every registered cause is a cause, not a placeholder', () => {
    expect(VACUOUS_CAUSE_REGISTRY.length).toBeGreaterThan(0);
    for (const cause of VACUOUS_CAUSE_REGISTRY) {
      expect(isWrittenCause(cause)).toBe(true);
      expect(cause.cause.trim().length).toBeGreaterThanOrEqual(MIN_WRITTEN_CAUSE_CHARS);
      expect(cause.becomes_non_empty_when.trim().length).toBeGreaterThan(0);
      expect(['BENIGN', 'DEFECTIVE']).toContain(cause.classification);
    }
    expect(findAcknowledgementsWithoutWrittenCause(
      VACUOUS_CAUSE_REGISTRY.map((c) => c.check_id),
    )).toEqual([]);
  });

  it('NEGATIVE CONTROL — an unregistered id and a placeholder cause are both rejected', () => {
    expect(findAcknowledgementsWithoutWrittenCause(['C1_batch_graph_complete']))
      .toEqual(['C1_batch_graph_complete']);
    expect(writtenCauseFor('C1_batch_graph_complete')).toBeNull();
    for (const placeholder of ['', '  ', 'n/a', 'benign', 'see the run log']) {
      expect(isWrittenCause({
        check_id: 'X', classification: 'BENIGN',
        cause: placeholder, becomes_non_empty_when: 'later',
      })).toBe(false);
    }
    // A long cause with no repopulation condition is still not a written cause.
    expect(isWrittenCause({
      check_id: 'X', classification: 'BENIGN',
      cause: 'x'.repeat(MIN_WRITTEN_CAUSE_CHARS + 10), becomes_non_empty_when: '  ',
    })).toBe(false);
  });

  it('NEGATIVE CONTROL — the reconciliation REFUSES to build a report on an uncaused ack', async () => {
    const db = seedHealthyCutoverStore();
    await expect(runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      acknowledgedVacuousChecks: ['C1_batch_graph_complete'],
    })).rejects.toThrow(/acknowledgement_without_written_cause/);
    // A caused acknowledgement is accepted and recorded (it just cannot make
    // the gate green — hard stop 5).
    const ok = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      acknowledgedVacuousChecks: ['C12_pvt9_settlement_stores_no_legacy_bleed'],
    });
    expect(ok.acknowledged_vacuous_checks).toEqual(['C12_pvt9_settlement_stores_no_legacy_bleed']);
  });
});

// ===========================================================================
// HARD STOP 4 — no reconciliation path may write a corrective value to any
//               money document.
// ===========================================================================

describe('HARD STOP 4 — the reconciliation cannot write', () => {
  it('a full run completes through the proxy on EVERY fixture, including a live discrepancy', async () => {
    // . This previously ran the proxy against the
    // HEALTHY fixture only — where `pool === ledgerTotal`, so a conditional
    // corrective write ("if the pool disagrees with the ledger, fix it") is
    // DEAD CODE and the proxy never sees it. The reviewer planted exactly that
    // write and all 137 tests stayed green.
    //
    // The fix is not a cleverer guard, it is a fixture that makes the branch
    // LIVE: each store below drives a different reconciliation path, and the
    // discrepancy one is the shape the hard stop actually names.
    const stores: Record<string, () => ReturnType<typeof seedHealthyCutoverStore>> = {
      healthy: seedHealthyCutoverStore,
      // pool ≠ ledger — the C6 variance shape, and the trigger for any
      // corrective write.
      poolLedgerDiscrepancy: () => {
        const db = seedHealthyCutoverStore();
        db.store.set('genesis_campaign_state/global', { pool_minted_pvt: 175.5 });
        return db;
      },
      // pool present, ledgers absent: the other side of the same branch.
      poolWithoutLedgers: () => {
        const db = seedHealthyCutoverStore();
        db.store.delete('genesis_wallet_ledger/wallet_h');
        db.store.delete('genesis_wallet_ledger/wallet_a');
        return db;
      },
      // an orphan snapshot + a failing C1/C3, so the failure paths run too.
      failingGraph: () => {
        const db = seedHealthyCutoverStore();
        db.store.set('pvt_mint_batch_snapshots/orphan', {
          merkle_root: '0xdead',
          contributor_addresses: ['0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a'],
        });
        return db;
      },
    };
    for (const [name, make] of Object.entries(stores)) {
      const db = make();
      const before = JSON.stringify([...db.store.entries()].sort());
      // eslint-disable-next-line no-await-in-loop
      const report = await runCutoverReconciliation(readOnlyDbProxy(db), {
        cutLineMs: CUT_LINE,
        chainReader: { readBatchMinted: async () => true },
      });
      expect({ name, checks: report.checks.length }).toEqual({ name, checks: 13 });
      expect({ name, store: JSON.stringify([...db.store.entries()].sort()) })
        .toEqual({ name, store: before });
    }
    // The discrepancy fixture must genuinely make C6 fail, or the branch it is
    // here to exercise is still not live.
    const disc = await runCutoverReconciliation(stores.poolLedgerDiscrepancy(), { cutLineMs: CUT_LINE });
    expect(disc.checks.find((c) => c.id === 'C6_genesis_pool_ledger_exact')!.status).toBe('fail');
  });

  it('NEGATIVE CONTROL — the proxy throws the moment a write is attempted', () => {
    const db = seedHealthyCutoverStore();
    const guarded = readOnlyDbProxy(db) as unknown as {
      collection(name: string): { doc(id: string): { set(v: unknown): void } };
    };
    expect(() => guarded.collection('genesis_campaign_state').doc('global').set({ pool_minted_pvt: 0 }))
      .toThrow(CutoverWriteAttempted);
    expect(() => guarded.collection('genesis_campaign_state').doc('global').set({}))
      .toThrow(/cutover_write_attempted: set/);
  });

  it('NEGATIVE CONTROL — a write reached through snap.docs[i].ref does NOT escape the proxy', () => {
    // The hole this closes: `docs` is a read, but a Firestore
    // QueryDocumentSnapshot carries `.ref`, so `snap.docs[0].ref.set(…)` would
    // reach the real handle three hops past a naive guard. Found by auditing
    // the guard against its own rule rather than by trusting it.
    let escaped = false;
    const realDoc = { id: 'global', data: () => ({ pool_minted_pvt: 424.7 }), ref: { set: () => { escaped = true; } } };
    const fake = { collection: () => ({ get: async () => ({ docs: [realDoc] }) }) };
    const guarded = readOnlyDbProxy(fake) as unknown as {
      collection(n: string): { get(): Promise<{ docs: { ref: { set(v?: unknown): void } }[] }> };
    };
    return guarded.collection('genesis_campaign_state').get().then((snap) => {
      expect(() => snap.docs[0].ref.set({ pool_minted_pvt: 0 })).toThrow(CutoverWriteAttempted);
      expect(escaped).toBe(false);
    });
  });

  it('the scan sees a MULTI-LINE write — the shape that used to walk past it', () => {
    // the scan was line-scoped, so this
    // repo's DOMINANT write idioms were invisible to it. Each shape below was
    // demonstrated missed; each must now be found.
    const dir = mkdtempSync(path.join(tmpdir(), 'wp12r3-shapes-'));
    try {
      const shapes: Record<string, string> = {
        'chained.ts': 'await db.collection("genesis_campaign_state").doc("global")\n  .set({ pool_minted_pvt: 0 });',
        'multiline-object.ts': 'txn.set(globalRef, {\n  pool_minted_pvt: poolMinted - 1,\n  updated_at: now,\n}, { merge: true });',
        'lowercase-ref.ts': 'const ref = db.collection("x").doc("y");\nawait ref\n  .update({ pool_minted_pvt: 0 });',
        'docs-ref.ts': 'const snap = await q.get();\nawait snap.docs[0].ref.update({ pool_minted_pvt: 0 });',
        'aliased.ts': 'const handle = db.collection("genesis_campaign_state");\nawait handle.doc("global").set({ pool_minted_pvt: 0 });',
        'url-in-line.ts': '// see https://example.com/a//b\nawait db.collection("c").doc("d")\n  .update({ pool_minted_pvt: 0 });',
      };
      for (const [file, body] of Object.entries(shapes)) {
        writeFileSync(path.join(dir, file), `${body}\n`, 'utf8');
      }
      const missed = Object.keys(shapes)
        .filter((f) => scanForWriteSurface(dir, [f]).length === 0);
      expect(missed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // …and the proxy still catches the same write behaviourally.
    const guarded = readOnlyDbProxy(seedHealthyCutoverStore()) as unknown as {
      collection(n: string): { doc(i: string): { set(v: unknown): void } };
    };
    expect(() => guarded.collection('genesis_campaign_state').doc('global')
      .set({ pool_minted_pvt: 0 })).toThrow(CutoverWriteAttempted);
  });

  it('no cutover module contains Firestore write surface', () => {
    expect(scanForWriteSurface(BACKEND_ROOT)).toEqual([]);
    expect(CUTOVER_READ_ONLY_MODULES.length).toBeGreaterThanOrEqual(8);
    // The scan covers the guard module itself — the guard is not exempt from
    // its own rule.
    expect(CUTOVER_READ_ONLY_MODULES).toContain('src/core/pvt/wp11/cutover-hard-stops.ts');
  });

  it('the ONE scan-exempt module earns its exemption, and it is asserted not assumed', () => {
    // A table of write-API names cannot be scanned for write-API names. The
    // exemption is bounded by proving the file is nothing BUT that table.
    expect(CUTOVER_READ_ONLY_MODULES).not.toContain(SCAN_EXEMPT_MODULE);
    const source = readFileSync(path.join(BACKEND_ROOT, SCAN_EXEMPT_MODULE), 'utf8');
    const code = stripCommentsPreservingLines(source);
    expect(code).not.toMatch(/^\s*import\s/m); // imports nothing at all
    expect(code).not.toMatch(/\bdb\b|firestore|Firestore/); // touches no db handle
    expect(code).not.toMatch(/\basync\b|\bawait\b|\bfunction\b|=>/); // no behaviour
    // Its only exports are the pattern table and the pattern type.
    const exported = [...code.matchAll(/^export\s+(?:const|interface|type)\s+(\w+)/gm)]
      .map((m) => m[1]).sort();
    expect(exported).toEqual(['FIRESTORE_WRITE_SURFACE_PATTERNS', 'WriteSurfacePattern']);
  });

  it('NEGATIVE CONTROL — comment stripping does not blind the scan to real code', () => {
    const withComment = stripCommentsPreservingLines([
      '// db.collection("x").doc("y").set(z)  <- a comment, not a write',
      '/* db.collection("x").doc("y").update(z) */',
      'await db.collection("genesis_campaign_state").doc("global").set(v);',
    ].join('\n'));
    // Line numbering survives, comments are gone, the real call is not.
    expect(withComment.split('\n').length).toBe(3);
    expect(withComment.split('\n')[0].trim()).toBe('');
    expect(withComment.split('\n')[1].trim()).toBe('');
    expect(withComment.split('\n')[2]).toContain('.set(v)');
  });

  it('NEGATIVE CONTROL — the scan finds a planted write, and a missing file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wp12r3-scan-'));
    try {
      mkdirSync(path.join(dir, 'src'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'corrective.ts'), [
        'export async function patchThePool(db: any) {',
        "  await db.collection('genesis_campaign_state').doc('global').update({",
        '    pool_minted_pvt: FieldValue.increment(0.0002010601167),',
        '  });',
        '}',
        '',
      ].join('\n'), 'utf8');
      const hits = scanForWriteSurface(dir, ['src/corrective.ts']);
      const patterns = new Set(hits.map((h) => h.pattern));
      expect(hits.length).toBeGreaterThan(0);
      expect(patterns.has('write on a doc()/collection() ref')).toBe(true);
      expect(patterns.has('FieldValue mutation')).toBe(true);
      // A file that disappears is a finding, never an empty (passing) scan.
      expect(scanForWriteSurface(dir, ['src/does-not-exist.ts']))
        .toEqual([{ file: 'src/does-not-exist.ts', line: 0, pattern: 'unreadable', text: 'file could not be read' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The real modules are still clean after the control ran.
    expect(scanForWriteSurface(BACKEND_ROOT)).toEqual([]);
  });

  it('the scan does not cry wolf on Map.set / Set.add / hash.update', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wp12r3-benign-'));
    try {
      writeFileSync(path.join(dir, 'benign.ts'), [
        'const m = new Map(); m.set(k, v);',
        'const s = new Set(); s.add(k);',
        "createHash('sha256').update(x, 'utf8');",
        'byContributor.set(key, (byContributor.get(key) ?? 0n) + points);',
        '',
      ].join('\n'), 'utf8');
      expect(scanForWriteSurface(dir, ['benign.ts'])).toEqual([]);
      expect(FIRESTORE_WRITE_SURFACE_PATTERNS.length).toBeGreaterThanOrEqual(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// HARD STOP 6 — INVERTED FOR STATUS.md POST-ARM.
//
// The original stop was "never write READY-TO-ARM or any arming status into
// STATUS.md", and it was correct for exactly as long as the kernel was unarmed.
// Arming happened on Base mainnet and was independently verified 25/0,
// which turned the guard against the honest document: STATUS.md line 8 records
// the armed posture, so the pre-arm assertion went RED on master and stayed
// there. Deleting the guard would have discarded a working detector; the
// correct move is to invert the half that expired.
//
//   STATUS.md            — must now RECORD arming (existential, post-arm).
// activation_PRE_ARM_REPORT — its frozen BODY must still declare NONE. It documents
//                          the pre-arm posture as evidence and the body is never
//                          retro-edited, so this half of the original stop is
// unchanged. added ONE bounded historical banner at
//                          the top (between the markers below) that says arming has
//                          since happened and points at STATUS.md — so a reader of
//                          the file is not told "NOT ARMED" as if it were current.
//                          The banner is the ONLY place an arming mention may
//                          stand: it must be unique, short, and closed before the
//                          frozen `STATE: NOT ARMED` line, so it can never wrap the
//                          body; the body is scanned with the banner blanked.
//
// The detector itself is untouched, and its planted-claim controls below still
// prove it catches every arming shape and excuses conditional/prohibitive prose.
// ===========================================================================

const HISTORICAL_BANNER_START = '<!-- historical-banner:start -->';
const HISTORICAL_BANNER_END = '<!-- historical-banner:end -->';
const HISTORICAL_BANNER_MAX_LINES = 12;
/** The frozen pre-arm claim the body must keep — the line the banner sits above. */
const FROZEN_STATE_LINE = /^>\s*\*\*STATE:\s*NOT ARMED\. NOT DEPLOYED\.\*\*\s*$/;

type FrozenReport =
  | { readonly ok: true; readonly body: string; readonly banner: string }
  | { readonly ok: false; readonly error: string };

/**
 * Split the pre-arm report into its one bounded historical banner and its frozen
 * body (banner lines blanked, so line numbers in scan hits still match the file).
 * Refuses — never guesses — any shape where the banner could hide a body claim.
 */
function splitFrozenPreArmReport(source: string): FrozenReport {
  const lines = source.split('\n');
  const starts = lines.flatMap((l, i) => (l.trim() === HISTORICAL_BANNER_START ? [i] : []));
  const ends = lines.flatMap((l, i) => (l.trim() === HISTORICAL_BANNER_END ? [i] : []));
  if (starts.length !== 1 || ends.length !== 1) {
    return { ok: false, error: `expected exactly one banner (start ${starts.length}, end ${ends.length})` };
  }
  const [start] = starts;
  const [end] = ends;
  if (end <= start) return { ok: false, error: 'banner end precedes its start' };
  if (end - start - 1 > HISTORICAL_BANNER_MAX_LINES) {
    return { ok: false, error: `banner is ${end - start - 1} lines (max ${HISTORICAL_BANNER_MAX_LINES})` };
  }
  const stateLines = lines.flatMap((l, i) => (FROZEN_STATE_LINE.test(l) ? [i] : []));
  if (stateLines.length !== 1) {
    return { ok: false, error: `expected the frozen STATE: NOT ARMED line exactly once (found ${stateLines.length})` };
  }
  if (end >= stateLines[0]) return { ok: false, error: 'banner does not close before the frozen STATE line' };
  const banner = lines.slice(start + 1, end).join('\n');
  const body = lines.map((l, i) => (i >= start && i <= end ? '' : l)).join('\n');
  return { ok: true, body, banner };
}

/** Scan a report's frozen body for arming claims (via a temp copy — the scanner reads files). */
function scanFrozenBody(source: string): { readonly split: FrozenReport; readonly hits: ReturnType<typeof scanForArmingClaims> } {
  const split = splitFrozenPreArmReport(source);
  if (!split.ok) return { split, hits: [] };
  const dir = mkdtempSync(path.join(tmpdir(), 'wp12-prearm-body-'));
  try {
    const file = path.join(dir, 'activation_PRE_ARM_REPORT.body.md');
    writeFileSync(file, split.body, 'utf8');
    return { split, hits: scanForArmingClaims([file]) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// HARD STOP 5 — reconciled must never be true while any check is vacuous_pass,
//               failing, or not_evaluated.
// ===========================================================================

describe('HARD STOP 5 — an empty set is never a result', () => {
  const passing = (id: string): GateJudgeableCheck => ({ id, status: 'pass', evaluated_items: 1 });

  it('all-pass over non-empty sets is the ONLY reconciled state', () => {
    expect(isGateReconciled([passing('A'), passing('B')])).toBe(true);
    expect(gateBlockers([passing('A')])).toEqual([]);
  });

  it('NEGATIVE CONTROL — each blocking status alone keeps the gate red', () => {
    for (const bad of [
      { id: 'V', status: 'vacuous_pass', evaluated_items: 0 },
      { id: 'F', status: 'fail', evaluated_items: 3 },
      { id: 'N', status: 'not_evaluated', evaluated_items: 0 },
      // A 'pass' over zero items is the same lie under a friendlier label; the
      // second conjunct exists so a defect in status assignment cannot open the
      // gate on its own.
      { id: 'P0', status: 'pass', evaluated_items: 0 },
    ]) {
      expect(isGateReconciled([passing('A'), bad])).toBe(false);
      expect(gateBlockers([passing('A'), bad])).toEqual([`${bad.id}:${bad.status}(${bad.evaluated_items})`]);
    }
    // An empty check list is not "everything passed".
    expect(isGateReconciled([])).toBe(false);
  });

  it('NEGATIVE CONTROL — acknowledging every vacuous check does NOT reconcile', async () => {
    const db = seedHealthyCutoverStore();
    const bound = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
    });
    const vacuous = bound.checks.filter((c) => c.status === 'vacuous_pass').map((c) => c.id);
    expect(vacuous.length).toBeGreaterThan(0);
    const acknowledged = await runCutoverReconciliation(db, {
      cutLineMs: CUT_LINE,
      chainReader: { readBatchMinted: async () => true },
      acknowledgedVacuousChecks: vacuous,
    });
    expect(acknowledged.acknowledged_vacuous_checks).toEqual([...vacuous].sort());
    expect(acknowledged.reconciled).toBe(false);
    expect(gateBlockers(acknowledged.checks).length).toBeGreaterThan(0);
  });

  it('the report`s own reconciled field agrees with the gate predicate, always', async () => {
    const db = seedHealthyCutoverStore();
    for (const chainReader of [undefined, { readBatchMinted: async () => true }]) {
      // eslint-disable-next-line no-await-in-loop
      const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE, chainReader });
      expect(report.reconciled).toBe(isGateReconciled(report.checks));
    }
  });
});

// ===========================================================================
// T2 — ASSERTION ADEQUACY OVER THE GATE SURFACE.
//
// Every test below exists because `scripts/wp12r3-gate-mutation.mjs` reported a
// SURVIVING mutant against the checker or cursor it covers: the real code was
// correct, and nothing would have noticed if it stopped being correct. They are
// written from the mutants, so each one fails against the weakened source.
// ===========================================================================

describe('cursors — the non-overlap fence asserts each conjunct', () => {
  const cursorsWith = (over: Record<string, unknown>) => ({
    schema_version: 'pvt-cutover-cursors/v1' as const,
    pvtv8_finalized: {
      finalized_batch_count: 1,
      unfinalized_batch_count: 0,
      last_finalized_batch_id: 'batch_a',
      last_finalized_mint_tx_hash: null,
      max_finalized_epoch: 3,
      max_settled_pe_timestamp_ms: 1_699_999_500_000,
      total_finalized_points_atomic: '0',
    },
    pvt9_start: {
      kernel_next_finalized_cursor_start: '0' as const,
      starts_after_ms: CUT_LINE,
      kernel_deployed: false,
      legacy_migration_configured: false,
      ...over,
    },
  });

  it('a configured legacy_migration is a violation', () => {
    const v = validateCursorNonOverlap(cursorsWith({ legacy_migration_configured: true }));
    expect(v.ok).toBe(false);
    expect(v.violations.join('  ')).toMatch(/legacy_migration/);
  });

  it('a PVT9 start cursor other than 0 is a violation', () => {
    const v = validateCursorNonOverlap(
      cursorsWith({ kernel_next_finalized_cursor_start: '1' }) as never,
    );
    expect(v.ok).toBe(false);
    expect(v.violations.join('  ')).toMatch(/start cursor is not 0/);
  });

  it('a cut line EQUAL to the last settled timestamp is a violation, not a pass', () => {
    const v = validateCursorNonOverlap(cursorsWith({ starts_after_ms: 1_699_999_500_000 }));
    expect(v.ok).toBe(false);
    expect(validateCursorNonOverlap(cursorsWith({ starts_after_ms: 1_699_999_500_001 })).ok)
      .toBe(true);
  });

  it('the settled fence is the MAXIMUM leaf timestamp across finalized batches', async () => {
    // Two finalized batches with DIFFERENT max leaf timestamps: with one batch
    // min and max coincide and the fence direction is unobservable.
    const db = seedHealthyCutoverStore();
    db.store.set('pvt_mint_batches/batch_b', {
      marked: true, marked_at: 1_700_000_100_000, mint_tx_hash: '0x'.padEnd(66, 'e'),
    });
    db.store.set('pvt_mint_batch_snapshots/batch_b', {
      batch_id: 'batch_b',
      merkle_root: '0x'.padEnd(66, 'f'),
      sorted_pe_ids: ['pe_9'],
      leaves: [{
        peId: 'pe_9',
        walletAddress: '0x3333333333333333333333333333333333333333',
        actionType: 'receive',
        timestamp: 1_600_000_000_000,
        basePoints: '1000000000000000000',
      }],
      contributor_addresses: ['0x3333333333333333333333333333333333333333'],
      pe_points: ['1000000000000000000'],
      pe_action_types: ['0xcccc'],
      epoch: 1,
    });
    const inventory = await takeCutoverInventory(db, { cutLineMs: CUT_LINE });
    const cursors = deriveCutoverCursors(inventory);
    // MAX of {1_699_999_500_000, 1_600_000_000_000}. A MIN would give the older.
    expect(cursors.pvtv8_finalized.max_settled_pe_timestamp_ms).toBe(1_699_999_500_000);
  });

  it('kernel_deployed is true on EITHER witness alone, never only on both', async () => {
    const db = seedHealthyCutoverStore();
    const base = await takeCutoverInventory(db, { cutLineMs: CUT_LINE });
    const withStatusOnly = deriveCutoverCursors({
      ...base,
      pvt9_posture: { ...base.pvt9_posture, pvt9_deployment_status: 'deployed', pvt9_address: null },
    });
    expect(withStatusOnly.pvt9_start.kernel_deployed).toBe(true);
    const withAddressOnly = deriveCutoverCursors({
      ...base,
      pvt9_posture: {
        ...base.pvt9_posture,
        pvt9_deployment_status: 'not_deployed',
        pvt9_address: `0x${'a'.repeat(40)}`,
      },
    });
    expect(withAddressOnly.pvt9_start.kernel_deployed).toBe(true);
  });
});

describe('checkers — each conjunct is asserted by a fixture', () => {
  const byId = (r: { checks: readonly { id: string; status: string }[] }, id: string) =>
    r.checks.find((c) => c.id === id)!;

  it('C3 FAILS on a mixed-case EIP-55 recipient (the live orphan defect)', async () => {
    const db = seedHealthyCutoverStore();
    const snap = db.store.get('pvt_mint_batch_snapshots/batch_a')!;
    // Exactly the shape the two live orphan snapshots carry.
    db.store.set('pvt_mint_batch_snapshots/batch_a', {
      ...snap,
      // The EXACT address the two live orphan snapshots carry, in its EIP-55
      // mixed case. A digits-only address would be unchanged by casing and the
      // fixture would silently assert nothing.
      contributor_addresses: [
        '0x1111111111111111111111111111111111111111',
        '0xD395c8f59131a4736aa4d9eE6e5dEb8fDA07Ce0a',
      ],
      leaves: [
        (snap as { leaves: unknown[] }).leaves[0],
        {
          peId: 'pe_2',
          walletAddress: '0xd395c8f59131a4736aa4d9ee6e5deb8fda07ce0a',
          actionType: 'receive',
          timestamp: 1_699_999_500_000,
          basePoints: '2000000000000000000',
        },
      ],
    });
    const report = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    expect(byId(report, 'C3_recipients_resolve').status).toBe('fail');
  });

  it('C3 FAILS on a malformed recipient, and passes on well-formed lowercase', async () => {
    const db = seedHealthyCutoverStore();
    const snap = db.store.get('pvt_mint_batch_snapshots/batch_a')!;
    db.store.set('pvt_mint_batch_snapshots/batch_a', {
      ...snap,
      contributor_addresses: ['0xnot-an-address', '0x2222222222222222222222222222222222222222'],
    });
    expect(byId(await runCutoverReconciliation(db, { cutLineMs: CUT_LINE }), 'C3_recipients_resolve')
      .status).toBe('fail');
    expect(byId(await runCutoverReconciliation(seedHealthyCutoverStore(), { cutLineMs: CUT_LINE }),
      'C3_recipients_resolve').status).toBe('pass');
  });

  it('C6 FAILS on a sub-unit pool/ledger discrepancy — there is no tolerance', async () => {
    const db = seedHealthyCutoverStore();
    // 175.5 vs 175: the exact magnitude of the live C6 variance is ~2e-4, so a
    // "harmless rounding" tolerance would swallow the real finding.
    db.store.set('genesis_campaign_state/global', { pool_minted_pvt: 175.5 });
    expect(byId(await runCutoverReconciliation(db, { cutLineMs: CUT_LINE }),
      'C6_genesis_pool_ledger_exact').status).toBe('fail');
    db.store.set('genesis_campaign_state/global', { pool_minted_pvt: 175.0000001 });
    expect(byId(await runCutoverReconciliation(db, { cutLineMs: CUT_LINE }),
      'C6_genesis_pool_ledger_exact').status).toBe('fail');
  });

  it('C7 FAILS when legacy_migration or legacy_fallback is configured', async () => {
    const db = seedHealthyCutoverStore();
    const base = await takeCutoverInventory(db, { cutLineMs: CUT_LINE });
    for (const over of [{ legacy_migration: true }, { legacy_fallback: true }]) {
      // eslint-disable-next-line no-await-in-loop
      const report = await reconcileCutoverInventory({
        ...base, pvt9_posture: { ...base.pvt9_posture, ...over },
      });
      expect(byId(report, 'C7_zero_carry_structural').status).toBe('fail');
    }
    // …but a deployed/addressed kernel does NOT, and that is the point of the restatement.
    // C7 asks whether a legacy balance can CARRY, and deployment is orthogonal to carry:
    // the two clauses above are the only ones that would have to flip for one to. Asserting
    // a fail here would have re-pinned the pre-deploy proxy that the check no longer uses.
    const deployed = await reconcileCutoverInventory({
      ...base,
      pvt9_posture: {
        ...base.pvt9_posture,
        pvt9_address: `0x${'a'.repeat(40)}`,
        pvt9_deployment_status: 'deployed',
      },
    });
    expect(byId(deployed, 'C7_zero_carry_structural').status).toBe('pass');

    // RED CONTROL for the line above: the same deployed posture still FAILS the moment a
    // migration path is configured, so `pass` there is caused by the absence of a carry
    // path and not by the check having gone blind.
    const deployedWithMigration = await reconcileCutoverInventory({
      ...base,
      pvt9_posture: {
        ...base.pvt9_posture,
        pvt9_address: `0x${'a'.repeat(40)}`,
        pvt9_deployment_status: 'deployed',
        legacy_migration: true,
      },
    });
    expect(byId(deployedWithMigration, 'C7_zero_carry_structural').status).toBe('fail');
  });
});

describe('EQUIVALENT mutants, each with a whole-domain proof', () => {
  // The harness reports four mutants it cannot kill. Each is recorded here with
  // a proof over the ENTIRE input domain — stronger than a sweep, and asserted
  // rather than argued, so a change that makes one killable turns this red.

  it('EQ-1/EQ-2 — the C1 scope filter and the exclusion derivation are inert on an EMPTY set', () => {
    // `!isScopeExcluded(x)` is the constant `true` for every x, and
    // `deriveScopeExclusions` and a bare `.filter(r => r.excluded)` agree, iff
    // no row asks to be excluded. Both hold, over the whole table, by count.
    expect(SCOPE_EXCLUSIONS.size).toBe(0);
    expect(REFUSED_SCOPE_EXCLUSIONS).toEqual([]);
    expect(C1_SCOPE_EVIDENCE.filter((r) => (r as { excluded: boolean }).excluded)).toEqual([]);
    // The moment ANY row asks to be excluded, the two forms diverge — proven
    // here rather than asserted, so the equivalence is bounded, not permanent.
    const asks = C1_SCOPE_EVIDENCE.map((r) => ({ ...r, excluded: true }));
    expect(deriveScopeExclusions(asks).refused.length).toBe(5);
    expect(deriveScopeExclusions(asks).exclusions.size).toBe(0);
  });

  it('EQ-3 WAS FALSE — C2`s totals equality is LOAD-BEARING, and here is the input that proves it', async () => {
    // . The original "proof" here computed two
    // identical `reduce`s of the same array and asserted they were equal. It
    // imported no production symbol, so no change to the real code could ever
    // turn it red — a test asserting a property of its own construction, which
    // is the exact defect class this work package exists to close. It was
    // wrong, and the mutant it excused ("drop the exact leaf-vs-PE points
    // equality") is a REAL survivor.
    //
    // The distinguishing input the reviewer produced: a DUPLICATE contributor
    // address plus an extra distinct leaf address. `byContributor.size ===
    // contributors.length` (cutover-inventory.ts) is then satisfied by
    // coincidence — 2 distinct leaf addresses, 2 contributor entries — so the
    // bijection the old argument assumed does not exist, per-contributor
    // consistency holds, and the totals still differ: 10 vs 12.
    const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const db = seedHealthyCutoverStore();
    db.store.set('pvt_mint_batch_snapshots/batch_a', {
      batch_id: 'batch_a',
      merkle_root: '0x'.padEnd(66, 'b'),
      sorted_pe_ids: ['pe_1', 'pe_2'],
      leaves: [
        { peId: 'pe_1', walletAddress: A, actionType: 'receive', timestamp: 1_699_999_000_000, basePoints: '5' },
        { peId: 'pe_2', walletAddress: B, actionType: 'receive', timestamp: 1_699_999_500_000, basePoints: '7' },
      ],
      contributor_addresses: [A, A],
      pe_points: ['5', '5'],
      pe_action_types: ['0xaaaa', '0xbbbb'],
      epoch: 3,
    });
    const inventory = await takeCutoverInventory(db, { cutLineMs: CUT_LINE });
    const row = inventory.legacy_pvtv8.mint_batches.find((b) => b.batch_id === 'batch_a')!;
    // Every OTHER conjunct holds — which is why dropping the equality was
    // invisible to the suite as shipped.
    expect(row.parallel_arrays_consistent).toBe(true);
    expect(row.leaves_match_sorted_pe_ids).toBe(true);
    expect(row.per_contributor_points_consistent).toBe(true);
    // …and the totals still differ.
    expect(row.total_pe_points_atomic).toBe('10');
    expect(row.total_leaf_points_atomic).toBe('12');
    // So C2 must FAIL here. This is what kills the mutant.
    const report = await reconcileCutoverInventory(inventory);
    expect(report.checks.find((c) => c.id === 'C2_batch_totals_exact')!.status).toBe('fail');
  });

  it('EQ-4 — C12`s derived counters are bounded above by claim_ledger_count', async () => {
    // `claim_ledger_count === 0` therefore implies all four derived counters
    // are 0, so no fixture can isolate any one of them. They are
    // defence-in-depth, not independent assertions, and are labelled as such.
    const db = seedHealthyCutoverStore();
    const empty = await takeCutoverInventory(db, { cutLineMs: CUT_LINE });
    const s = empty.pvt9_settlement;
    expect(s.claim_ledger_count).toBe(0);
    for (const derived of [
      s.claim_ledger_settled_count,
      s.claim_ledger_unknown_schema_count,
      s.claim_ledger_legacy_schema_count,
      s.claim_ledger_legacy_batch_binding_count,
    ]) {
      expect(derived).toBeLessThanOrEqual(s.claim_ledger_count);
    }
    // With a LEGACY-schema ledger row present, C12 fails — the check itself is
    // not vacuous by construction, only its redundant conjuncts are (a
    // well-formed PVT9 row no longer fails C12; a legacy row still does).
    db.store.set('pvt9_claim_ledger_v1/c1', {
      schema_version: 'pvt-mint-claim/v1', settled: true, settled_batch_id: 'batch_a',
    });
    const seeded = await runCutoverReconciliation(db, { cutLineMs: CUT_LINE });
    const c12 = seeded.checks.find((c) => c.id === 'C12_pvt9_settlement_stores_no_legacy_bleed')!;
    expect(c12.status).toBe('fail');
    expect(c12.evaluated_items).toBeGreaterThan(0);
  });
});

// ===========================================================================
// T3 — CLASS-WIDE SELF-REFERENTIAL CONTROL AUDIT.
//
// Three passes produced three instances of one defect: a test that declares its
// OWN copy of the data, patterns, roots or fixtures the code under test uses.
// Auditing for it by reading is what produced three misses, so it is detected
// mechanically here, on every commit.
// ===========================================================================

describe('no test redeclares a literal its module already owns', () => {
  /**
   * Scope: the reconciliation and activation guard modules. Stated rather than
   * implied — a guard whose scope is unstated is a guard whose scope silently
   * shrinks, which is defect 5 of exactly.
   */
  // adds `wp12` so the arm-time guards are inside the audited surface
  // for the usual test-redeclares-a-module-literal case.
  //
  // It does NOT cover the cursor binding, and saying so is the point: this
  // detector skips literals under two characters (`'0'` is one) and only
  // compares a TEST against a MODULE, never module against module — so
  // re-spelling `BigInt(KERNEL_NEXT_FINALIZED_CURSOR_START)` as `BigInt('0')`
  // is invisible to it (, demonstrated by severing the
  // binding and watching this stay green). That property is checked by
  // `bindsCursorToSharedConstant` in `wp12/arm-guards.ts`, which has its own
  // negative control.
  const AUDITED_DIRS = ['wp11', 'policy', '__test-helpers__', 'wp12'];

  const corpus = (): { path: string; source: string }[] => {
    const root = path.resolve(__dirname, '..');
    const out: { path: string; source: string }[] = [];
    for (const dir of AUDITED_DIRS) {
      for (const f of readdirSync(path.join(root, dir))) {
        if (!f.endsWith('.ts')) continue;
        out.push({ path: `${dir}/${f}`, source: readFileSync(path.join(root, dir, f), 'utf8') });
      }
    }
    return out;
  };

  it('finds ZERO redeclarations across the audited surface', () => {
    const files = corpus();
    // The corpus must be real, or "zero hits" means "scanned nothing".
    expect(files.length).toBeGreaterThan(15);
    expect(files.filter((f) => f.path.endsWith('.test.ts')).length).toBeGreaterThan(4);
    expect(findRedeclaredLiterals(files)).toEqual([]);
  });

  it('NEGATIVE CONTROL — a planted redeclaration is found, in every literal kind', () => {
    const planted = [
      { path: 'wp11/thing.ts', source: [
        "export const THE_RE = /^0x[0-9a-f]{8}$/;",
        "const THE_STR = 'pvt9_claim_ledger_v1';",
        'const THE_NUM = 1_784_938_132_043;',
        '',
      ].join('\n') },
      { path: 'wp11/thing.test.ts', source: [
        'const MY_RE = /^0x[0-9a-f]{8}$/;',
        "const MY_STR = 'pvt9_claim_ledger_v1';",
        'const MY_NUM = 1_784_938_132_043;',
        '',
      ].join('\n') },
    ];
    const hits = findRedeclaredLiterals(planted);
    expect(hits.map((h) => h.test_name).sort()).toEqual(['MY_NUM', 'MY_RE', 'MY_STR']);
    expect(hits.every((h) => h.module_file === 'wp11/thing.ts')).toBe(true);
    // …and it does NOT fire when only the NAME matches, or only the module has it.
    expect(findRedeclaredLiterals([
      { path: 'wp11/a.ts', source: "const X = 'alpha';\n" },
      { path: 'wp11/a.test.ts', source: "const X = 'beta';\n" },
    ])).toEqual([]);
  });

  it('NEGATIVE CONTROL — the extractor is not blinded by comments or export/type syntax', () => {
    const decls = extractLiteralDeclarations('m.ts', [
      "// const COMMENTED = 'ignored';",
      "export const A: RegExp = /^ab+$/;",
      "const B = 'a-real-string';",
      'const C = 42_000;',
      'const D = { not: "a literal" };', // multi-part object: not this defect's shape
      "const E = 'x';", // single char: no identity worth tracking
      '',
    ].join('\n'));
    expect(decls.map((d) => d.name)).toEqual(['A', 'B', 'C']);
    expect(decls.find((d) => d.name === 'A')!.line).toBe(2);
  });
});

// ===========================================================================
// T4 — RETURN TO THE GATE. C1, C3 and C6 under the standing rulings.
//
// The rulings are not re-raised. What changes here is that each verdict is
// COMPUTED from evidence on every run instead of restated from a hand
// enumeration made once, on one day, and thereafter believed.
// ===========================================================================

describe('C1 — a real mint is in scope, structurally', () => {
  it('all five documents are mint-carrying, and the guard refuses to exclude any of them', () => {
    // The ruling as an invariant rather than a sentence: even if a future edit
    // sets `excluded: true` on all five, none can enter the exclusion set.
    const asks = C1_SCOPE_EVIDENCE.map((r) => ({ ...r, excluded: true }));
    const derived = deriveScopeExclusions(asks);
    expect(derived.exclusions.size).toBe(0);
    expect(derived.refused.length).toBe(5);
    // Each of the five is refused for a reason that is on its own record.
    for (const row of C1_SCOPE_EVIDENCE) {
      expect(row.batch_minted_on_correct_contract).toBe(true);
      expect(row.recorded_mint_tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(row.chain_reader_probative).toBe(true);
      expect(row.excluded).toBe(false);
    }
  });
});

describe('C6 — the downgrade verdict is derived, not asserted', () => {
  const BACKEND = BACKEND_ROOT;

  it('finds every writer of pool_minted_pvt, and classifies each', () => {
    const writers = findPoolCounterWriters(BACKEND);
    // M4 (Q3/C6): the counter is now MONOTONIC. Both reducers are gone —
    // `rollbackGenesisIssuance` refuses instead of decrementing, and the
    // cleanup script's bare decrement is routed through the chokepoint, which
    // refuses. `confirmGenesisPendingCacheReReserve`'s re-debit is refused too,
    // so what remains is exactly ONE writer, and it is an increment.
    // A SECOND writer, or any non-increment, turns this red.
    expect(writers.length).toBe(1);
    expect(writers.filter((w) => w.kind === 'increment').length).toBe(1);
    expect(writers.filter((w) => w.kind === 'decrement')).toEqual([]);
    expect(writers.filter((w) => w.kind === 'unclassified')).toEqual([]);
    expect(writers[0].file).toBe('src/core/pvt/genesis-campaign.ts');
  });

  it('the whole tree is swept, so proof (b) enumerates EVERY writer and not just the listed ones', () => {
    // . A two-file allowlist can only ever enumerate
    // every writer IN THE ALLOWLIST, and proof (b) claims more than that.
    expect(findUnlistedPoolCounterFiles(BACKEND)).toEqual([]);
  });

  it('NEGATIVE CONTROL — a MULTI-LINE reducer in a third file is found by the sweep', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wp12r3-sweep-'));
    try {
      mkdirSync(path.join(dir, 'src', 'core'), { recursive: true });
      // The exact shape the reviewer planted, in this repo's dominant style.
      writeFileSync(path.join(dir, 'src', 'core', 'shave.ts'), [
        'export async function shave(txn: any, globalRef: any, poolMinted: number, now: number) {',
        '  txn.set(globalRef, {',
        '    pool_minted_pvt: poolMinted - 1,',
        '    updated_at: now,',
        '  }, { merge: true });',
        '}',
        '',
      ].join('\n'), 'utf8');
      expect(findUnlistedPoolCounterFiles(dir, ['src'], [])).toEqual(['src/core/shave.ts']);
      const found = findPoolCounterWriters(dir, ['src/core/shave.ts']);
      expect(found.length).toBe(1);
      expect(found[0].kind).toBe('decrement');
      // The line reported is where the write STATEMENT opens, not where the
      // field happens to sit — that is the line an operator needs.
      expect(found[0].line).toBe(2);
      // …and a FieldValue decrement, which never names the value inline.
      writeFileSync(path.join(dir, 'src', 'core', 'fv.ts'), [
        'txn.update(globalRef, {',
        '  pool_minted_pvt: FieldValue.increment(-0.5),',
        '});',
        '',
      ].join('\n'), 'utf8');
      expect(findPoolCounterWriters(dir, ['src/core/fv.ts'])[0].kind).toBe('decrement');
      writeFileSync(path.join(dir, 'src', 'core', 'fv.ts'), [
        'txn.update(globalRef, {',
        '  pool_minted_pvt: FieldValue.increment(0.5),',
        '});',
        '',
      ].join('\n'), 'utf8');
      expect(findPoolCounterWriters(dir, ['src/core/fv.ts'])[0].kind).toBe('increment');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BOTH PROOFS NOW HOLD — C6 is a DOCUMENTED VARIANCE, not a blocker ', () => {
    // Proof (b) landed at M4/ (the monotonic chokepoint). Proof (a)
    // landed 2026-07-28: the operator resolved it by removing the cleanup script
    //, where had only routed its decrement through the refusing
    // chokepoint. The ruling encoded in `judgeC6Downgrade` is
    // UNTOUCHED — the conjunction now genuinely holds, which downgrades C6
    // from blocker to documented variance. No corrective value was written in
    // either direction: pool and ledger still disagree, and that variance is
    // what the standard-lane settlement gate pins. Restoring the script — or
    // planting any reducer — flips this red.
    const verdict = judgeC6Downgrade(
      isCleanupScriptRemoved(BACKEND),
      findPoolCounterWriters(BACKEND),
    );
    expect(verdict.cleanup_script_removed).toBe(true);         // proof (a) —
    expect(verdict.all_writers_monotonic_or_gated).toBe(true); // proof (b) —
    expect(verdict.reducers).toEqual([]);
    expect(verdict.downgrade_eligible).toBe(true);
  });

  it('NEGATIVE CONTROL — a restored cleanup script is DETECTED (proof (a) can fail)', () => {
    // With the real file gone, `isCleanupScriptRemoved` only ever sees the
    // true branch against the live tree — which is exactly the guard-that-
    // cannot-fail shape. Plant the script at the pinned path in a scratch
    // root and assert the detector reports it present.
    const dir = mkdtempSync(path.join(tmpdir(), 'wp12r3-c6a-'));
    try {
      expect(isCleanupScriptRemoved(dir)).toBe(true);
      mkdirSync(path.dirname(path.join(dir, C6_CLEANUP_SCRIPT)), { recursive: true });
      writeFileSync(path.join(dir, C6_CLEANUP_SCRIPT), '// resurrected\n', 'utf8');
      expect(isCleanupScriptRemoved(dir)).toBe(false);
      expect(judgeC6Downgrade(isCleanupScriptRemoved(dir), []).downgrade_eligible).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NEGATIVE CONTROL — the verdict function can return every answer, not just this one', () => {
    // A verdict that can only say "blocking" proves nothing about the rule. All
    // four combinations are exercised, and only one downgrades.
    const inc = { file: 'f', line: 1, kind: 'increment' as const, text: '' };
    const dec = { file: 'f', line: 2, kind: 'decrement' as const, text: '' };
    expect(judgeC6Downgrade(true, [inc]).downgrade_eligible).toBe(true);
    expect(judgeC6Downgrade(true, [inc, dec]).downgrade_eligible).toBe(false);
    expect(judgeC6Downgrade(false, [inc]).downgrade_eligible).toBe(false);
    expect(judgeC6Downgrade(false, [inc, dec]).downgrade_eligible).toBe(false);
    // An unclassified write is treated as a reducer — Unknown = Block.
    expect(judgeC6Downgrade(true, [{ ...inc, kind: 'unclassified' }]).downgrade_eligible)
      .toBe(false);
  });

  it('NEGATIVE CONTROL — a newly planted reducer is found, and a vanished file is a finding', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wp12r3-pool-'));
    try {
      mkdirSync(path.join(dir, 'src'), { recursive: true });
      writeFileSync(path.join(dir, 'src', 'new-reducer.ts'), [
        'export async function shave(db: any, amount: number) {',
        '  await db.runTransaction(async (txn: any) => {',
        '    txn.set(ref, { pool_minted_pvt: current - amount }, { merge: true });',
        '  });',
        '}',
        '// txn.set(ref, { pool_minted_pvt: current - 1 }) <- commented, not a writer',
        '',
      ].join('\n'), 'utf8');
      const found = findPoolCounterWriters(dir, ['src/new-reducer.ts']);
      expect(found.length).toBe(1);
      expect(found[0].kind).toBe('decrement');
      expect(found[0].line).toBe(3);
      // A file that is gone is reported, never silently skipped.
      const missing = findPoolCounterWriters(dir, ['src/gone.ts']);
      expect(missing).toEqual([
        { file: 'src/gone.ts', line: 0, kind: 'unclassified', text: 'file could not be read' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies increment, decrement and ambiguous assignments distinctly', () => {
    expect(classifyPoolWrite('pool_minted_pvt: poolMinted + granted')).toBe('increment');
    expect(classifyPoolWrite('pool_minted_pvt: Math.max(0, poolMinted - amount)')).toBe('decrement');
    expect(classifyPoolWrite('pool_minted_pvt: FieldValue.increment(-1)')).toBe('decrement');
    expect(classifyPoolWrite('pool_minted_pvt: FieldValue.increment(1)')).toBe('increment');
    expect(classifyPoolWrite('pool_minted_pvt: current - reversal')).toBe('decrement');
    expect(classifyPoolWrite('pool_minted_pvt: someValue')).toBe('unclassified');
    expect(classifyPoolWrite('no field here')).toBe('unclassified');
  });
});

/**
 * Executable hard stops for read-only cutover reconciliation.
 *
 * Each predicate accepts caller-supplied data so its companion tests can supply
 * a violating input as well as compliant data. A known-good fixture alone cannot
 * prove that a guard rejects a bad result. In particular, inability to reach a
 * document's correct contract must never become a false batchMinted answer.
 *
 * These functions and the filesystem scan cannot write, mint, settle, deploy,
 * or grant authority.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { FIRESTORE_WRITE_SURFACE_PATTERNS } from './cutover-write-surface-patterns';

export { FIRESTORE_WRITE_SURFACE_PATTERNS } from './cutover-write-surface-patterns';

// ---------------------------------------------------------------------------
// HARD STOP 2 — "no document carrying a real mint transaction may be present
//                in cutover-scope-exclusions.ts"
// ---------------------------------------------------------------------------

/**
 * The widened row shape the guard judges. Deliberately NOT
 * `C1ScopeEvidence`: that type pins `excluded: false`, so a test could not
 * construct the violating case, and a guard whose violating case is
 * unconstructible is a guard that cannot fail. The runtime rule must hold even
 * if a later edit widens the type — which is exactly the edit this guard exists
 * to catch.
 */
export interface ScopeExclusionCandidate {
  readonly document_id: string;
  readonly excluded: boolean;
  /** The mint transaction recorded on the document itself, if any. */
  readonly recorded_mint_tx_hash: string | null;
  /** `batchMinted(document_id)` asked of the contract it minted against. */
  readonly batch_minted_on_correct_contract: boolean;
  /** `pe_history` docs bound to this id. */
  readonly bound_pe_count: number;
}

/**
 * A document carries a real mint if ANY of three independent witnesses says so.
 * Disjunction, not conjunction: each witness alone is sufficient evidence that
 * value attached, and requiring all three would let a document with a confirmed
 * on-chain mint but a missing tx-hash field slip through.
 */
export function documentCarriesRealMint(row: ScopeExclusionCandidate): boolean {
  const hasTx = typeof row.recorded_mint_tx_hash === 'string'
    && row.recorded_mint_tx_hash.trim() !== '';
  return hasTx || row.batch_minted_on_correct_contract === true || row.bound_pe_count > 0;
}

export interface ScopeExclusionDerivation {
  /** Ids legitimately ruled out of scope. */
  readonly exclusions: ReadonlySet<string>;
  /**
   * Ids that ASKED to be excluded while carrying a real mint. Refused, and
   * surfaced by name — a silently dropped violation is the same failure as an
   * honoured one.
   */
  readonly refused: readonly string[];
}

/**
 * Derive the exclusion set under the hard stop. `excluded: true` is a REQUEST,
 * never a decision: a row carrying a real mint is refused here regardless of
 * what it claims about itself, so widening the allowlist cannot be done by
 * flipping a boolean or by editing a type.
 */
export function deriveScopeExclusions(
  rows: readonly ScopeExclusionCandidate[],
): ScopeExclusionDerivation {
  const exclusions = new Set<string>();
  const refused: string[] = [];
  for (const row of rows) {
    if (!row.excluded) continue;
    if (documentCarriesRealMint(row)) refused.push(row.document_id);
    else exclusions.add(row.document_id);
  }
  return { exclusions, refused: refused.sort() };
}

// ---------------------------------------------------------------------------
// HARD STOP 3 — "no vacuous check may be acknowledged without a written cause"
// ---------------------------------------------------------------------------

export type VacuousCauseClass = 'BENIGN' | 'DEFECTIVE';

export interface VacuousCause {
  readonly check_id: string;
  readonly classification: VacuousCauseClass;
  /** Why the set is empty. Prose, and it must actually say something. */
  readonly cause: string;
  /** The specific condition under which the set becomes non-empty. */
  readonly becomes_non_empty_when: string;
}

/**
 * A cause shorter than this is not a written cause. The number is a floor on
 * effort, not a style rule: `''`, `'n/a'` and `'benign'` are exactly the
 * placeholders that would turn this guard back into a rubber stamp.
 */
export const MIN_WRITTEN_CAUSE_CHARS = 40;

/**
 * The written causes, from the triage. This registry is the ONLY
 * thing that can license an acknowledgement; a check absent from it cannot be
 * acknowledged at all.
 */
export const VACUOUS_CAUSE_REGISTRY: readonly VacuousCause[] = [
  {
    check_id: 'C4_claims_legacy_schema_and_bound',
    classification: 'BENIGN',
    cause: 'The Firestore collection `pvt_mint_claims_v1` does not exist. Its name matches its '
      + 'writer\'s own constant (`MINT_BATCH_CLAIM_COLLECTION` in `mint-worker-coordination.ts`), '
      + 'and that writer was the PVTv8 mint runtime, deleted with the PE meter migration '
      + '(2026-10-03), so nothing can write a claim. Both surviving batches (2026-04-07, '
      + '2026-05-04) predate the claim mechanism entirely.',
    becomes_non_empty_when: 'a legacy PVTv8 mint claim is written — impossible: no writer of that '
      + 'collection remains in the tree.',
  },
  {
    check_id: 'C8_genesis_backlog_integrity',
    classification: 'BENIGN',
    cause: 'The collections `genesis_qualification_outbox_v2` and `genesis_reservations_v2` do not '
      + 'exist. Their names match `genesis-award-state-machine.ts:61-62` exactly. That module IS '
      + 'wired into production routes, but `proposedArmedGenesisWindow()` (:340-352) returns null '
      + 'unless Genesis is armed and every bounty is `launch_armed`, and :362-363 short-circuits '
      + 'on null, so no row can be written pre-arming.',
    becomes_non_empty_when: 'the first qualifying registration after PVT9 Genesis is armed.',
  },
  {
    check_id: 'C10_lock_inventory_exact',
    classification: 'BENIGN',
    cause: 'The `bonds` collection does not exist. The name matches its writer exactly '
      + '(`agent-bank/bonds.ts` uses `collection(\'bonds\')`). No bond has ever been posted in '
      + 'production, so there is no lock inventory to parse.',
    becomes_non_empty_when: 'the first successful `postBond`.',
  },
  {
    check_id: 'C12_pvt9_settlement_stores_no_legacy_bleed',
    classification: 'BENIGN',
    cause: 'The collections `pvt9_claim_ledger_v1`, `pvt9_settlement_cycles_v1` and '
      + '`pvt9_settlement_batches_v1` do not exist. Their names are IMPORTED from the writer '
      + 'module (`wp4/durable-settlement-store.ts:58-60`), so name drift between checker and '
      + 'writer is structurally impossible. PVT9 settlement has never run.',
    becomes_non_empty_when: 'the first `registerClaim` against the durable settlement store.',
  },
  {
    check_id: 'C13_segmented_anchors_reconcile',
    classification: 'BENIGN',
    cause: 'The collections `pe_daily_anchor_days_v1` and `pe_daily_anchor_segments_v1` do not '
      + 'exist. Their names are imported from `wp4/segmented-pe-anchor.ts:49-50`. The only writer '
      + 'anywhere in the tree is `scripts/wp4-load-harness.ts`; there is no production caller. '
      + 'linked-job settlement daily anchoring writes `pe_daily_anchor_batches`, which C5 reads instead.',
    becomes_non_empty_when: 'settlement runtime segmented anchoring is activated in production.',
  },
];

const CAUSES_BY_CHECK: ReadonlyMap<string, VacuousCause> = new Map(
  VACUOUS_CAUSE_REGISTRY.map((c) => [c.check_id, c]),
);

/** True iff `cause` is a cause rather than a placeholder. */
export function isWrittenCause(cause: VacuousCause | undefined | null): boolean {
  if (cause === undefined || cause === null) return false;
  return cause.cause.trim().length >= MIN_WRITTEN_CAUSE_CHARS
    && cause.becomes_non_empty_when.trim().length > 0;
}

/** The recorded cause for a check id, or `null` — never a fabricated default. */
export function writtenCauseFor(checkId: string): VacuousCause | null {
  const cause = CAUSES_BY_CHECK.get(checkId);
  return isWrittenCause(cause) ? (cause as VacuousCause) : null;
}

/**
 * Which of `acknowledgedCheckIds` have no written cause. A non-empty result is
 * a hard-stop violation, and `reconcileCutoverInventory` refuses to build a
 * report at all in that case — an uncaused acknowledgement must not be
 * expressible, not merely discouraged.
 */
export function findAcknowledgementsWithoutWrittenCause(
  acknowledgedCheckIds: readonly string[],
): readonly string[] {
  return [...new Set(acknowledgedCheckIds)]
    .filter((id) => writtenCauseFor(id) === null)
    .sort();
}

// ---------------------------------------------------------------------------
// HARD STOP 5 — "reconciled must never be true while any check is
//                vacuous_pass, failing, or not_evaluated"
// ---------------------------------------------------------------------------

/** The minimum a check must expose for the gate predicate to judge it. */
export interface GateJudgeableCheck {
  readonly id: string;
  readonly status: string;
  readonly evaluated_items: number;
}

/**
 * The gate predicate, stated as the hard stop states it.
 *
 * `reconciled` is true ONLY when every check both passed AND examined at least
 * one item. An acknowledgement cannot flip it: acknowledgement is a recorded
 * fact about the operator's reading, not a licence to call an empty set a
 * result. This is STRICTLY tighter than the pre-predicate, which let an
 * acknowledged `vacuous_pass` count as reconciled — the precise shape of
 * "acknowledge a vacuous check in order to make a gate green".
 *
 * The `evaluated_items > 0` conjunct is not redundant with `status === 'pass'`.
 * It is the same claim asserted through a second, independent field, so a
 * defect in the status-assignment logic alone cannot open the gate.
 */
export function isGateReconciled(checks: readonly GateJudgeableCheck[]): boolean {
  if (checks.length === 0) return false;
  return checks.every((c) => c.status === 'pass' && c.evaluated_items > 0);
}

/** Every check id blocking the gate, with the reason, for the report detail. */
export function gateBlockers(checks: readonly GateJudgeableCheck[]): readonly string[] {
  return checks
    .filter((c) => !(c.status === 'pass' && c.evaluated_items > 0))
    .map((c) => `${c.id}:${c.status}(${c.evaluated_items})`);
}

// ---------------------------------------------------------------------------
// HARD STOP 4 — "no reconciliation path may write a corrective value to any
//                money document"
// ---------------------------------------------------------------------------

/**
 * The modules that make up the reconciliation path, relative to
 * `provian-backend/`. A file added to the cutover surface and NOT added here is
 * the obvious way to defeat this scan, which is why the suite also runs the
 * whole reconciliation through a db proxy that throws on any write — the
 * behavioural guard does not depend on this list being maintained.
 */
export const CUTOVER_READ_ONLY_MODULES: readonly string[] = [
  'src/core/pvt/wp11/cutover-inventory.ts',
  'src/core/pvt/wp11/cutover-reconciliation.ts',
  'src/core/pvt/wp11/cutover-cursors.ts',
  'src/core/pvt/wp11/cutover-scope-exclusions.ts',
  'src/core/pvt/wp11/cutover-hard-stops.ts',
  'src/core/pvt/wp11/legacy-batch-minted-reader.ts',
  'src/core/pvt/wp11/legacy-mint-contract-registry.ts',
  'scripts/wp11-cutover-dry-run.ts',
];

/**
 * The ONE scan-exempt file, named with its reason. A table of write-API names
 * necessarily contains write-API names; isolating it in a module that imports
 * nothing and touches no database handle is the only exemption, and
 * `cutover-wp12r3.test.ts` asserts those properties rather than trusting them.
 */
export const SCAN_EXEMPT_MODULE = 'src/core/pvt/wp11/cutover-write-surface-patterns.ts';

export interface WriteSurfaceHit {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
  readonly text: string;
}

/**
 * Blank out comments, preserving line numbering. A comment cannot write to
 * Firestore, and a scan that flags one teaches its readers to ignore it — which
 * is how a source scan stops being enforcement.
 */
export function stripCommentsPreservingLines(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    if (inBlock) {
      const end = raw.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      inBlock = false;
      out.push(raw.slice(end + 2));
      continue;
    }
    let line = raw;
    const block = line.indexOf('/*');
    if (block !== -1) {
      const end = line.indexOf('*/', block + 2);
      if (end === -1) { inBlock = true; line = line.slice(0, block); } else {
        line = line.slice(0, block) + line.slice(end + 2);
      }
    }
    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Scan the given files for Firestore write surface. `backendRoot` is passed in
 * rather than derived from `__dirname` so the caller — including a negative
 * control that plants a violating file in a scratch tree — controls the scope.
 */
/**
 * Flatten comment-stripped source into ONE line, keeping a map from character
 * offset back to the original line number.
 *
 * WHY THIS EXISTS (). The first version of
 * these scans matched line by line, so every one of this repo's dominant write
 * idioms walked straight past them — a chained `db.collection(x)` / `.doc(y)` /
 * `.update({...})` across three lines, a multi-line object literal, a `ref`
 * binding on its own line. This backend contains 201 chained `.set(`/`.update(`
 * line-starts and 130 multi-line `.set({` writes, so those are not exotic
 * shapes: they are the normal ones, and a line-scoped scan was blind to the
 * majority of what it claimed to cover. Flattening first is what makes the
 * patterns mean what they say.
 */
export function flattenForScanning(source: string): {
  readonly text: string;
  readonly lineOf: (offset: number) => number;
} {
  const lines = stripCommentsPreservingLines(source).split('\n');
  const starts: number[] = [];
  let text = '';
  for (let i = 0; i < lines.length; i += 1) {
    starts.push(text.length);
    text += `${lines[i]} `;
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  return { text, lineOf };
}

export function scanForWriteSurface(
  backendRoot: string,
  relativeFiles: readonly string[] = CUTOVER_READ_ONLY_MODULES,
): readonly WriteSurfaceHit[] {
  const hits: WriteSurfaceHit[] = [];
  for (const rel of relativeFiles) {
    let source: string;
    try {
      source = readFileSync(path.join(backendRoot, rel), 'utf8');
    } catch {
      // A module that cannot be read is a finding, not a pass: report it as a
      // hit so a renamed-away file can never silently empty the scan.
      hits.push({ file: rel, line: 0, pattern: 'unreadable', text: 'file could not be read' });
      continue;
    }
    // Matching runs over the FLATTENED source, so a write split across lines is
    // caught. This is still the SECONDARY guard: the primary one is
    // behavioural (`readOnlyDbProxy`), because no pattern list is ever complete.
    const { text, lineOf } = flattenForScanning(source);
    for (const { name, re } of FIRESTORE_WRITE_SURFACE_PATTERNS) {
      const global = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
      let m = global.exec(text);
      while (m !== null) {
        hits.push({
          file: rel,
          line: lineOf(m.index),
          pattern: name,
          text: m[0].replace(/\s+/g, ' ').trim().slice(0, 160),
        });
        m = global.exec(text);
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.pattern.localeCompare(b.pattern));
}

/**
 * A db handle that permits exactly the read surface `takeCutoverInventory`
 * uses and throws on everything else — including every write method, however it
 * is spelled. This is the PRIMARY proof for hard stop 4: it does not depend on
 * a pattern list, a file list, or anyone remembering to update either.
 */
export const CUTOVER_ALLOWED_DB_METHODS: readonly string[] = [
  'collection', 'doc', 'get', 'where', 'orderBy', 'limit', 'startAfter',
];

export class CutoverWriteAttempted extends Error {
  public readonly method: string;

  constructor(method: string) {
    super(`cutover_write_attempted: ${method} is not part of the read-only cutover surface`);
    this.name = 'CutoverWriteAttempted';
    this.method = method;
  }
}

/**
 * Wrap any db-like object so that touching anything outside
 * `CUTOVER_ALLOWED_DB_METHODS` throws. Returned query/doc objects are wrapped
 * recursively, so a write reached through `db.collection(x).doc(y).set(z)`
 * throws at `.set` rather than succeeding three hops away from the guard.
 */
/** True iff `value` is an object exposing any Firestore write method. */
function exposesWrite(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['set', 'update', 'delete', 'create', 'add'].some((m) => typeof v[m] === 'function');
}

export function readOnlyDbProxy<T extends object>(db: T): T {
  const allowed = new Set(CUTOVER_ALLOWED_DB_METHODS);
  const wrap = (target: unknown): unknown => {
    if (typeof target === 'function') return target;
    if (target === null || typeof target !== 'object') return target;
    // A promise is unwrapped rather than proxied: proxying it detaches
    // `then` from its receiver, and the value that matters is what it
    // resolves to, which IS wrapped.
    if (typeof (target as { then?: unknown }).then === 'function') {
      return (target as Promise<unknown>).then(wrap);
    }
    return new Proxy(target as object, {
      get(obj, prop, receiver) {
        if (typeof prop !== 'string') return Reflect.get(obj, prop, receiver);
        // `docs` is a read, but its ELEMENTS are not inert: a Firestore
        // QueryDocumentSnapshot carries `.ref`, and `snap.docs[0].ref.set(…)`
        // would otherwise reach the real handle three hops past the guard.
        // Each element is wrapped, so the write throws at `.set` as it must.
        if (prop === 'docs') {
          const docs = Reflect.get(obj, prop, receiver);
          return Array.isArray(docs) ? docs.map((d) => wrap(d)) : docs;
        }
        // Scalar data-bearing properties of a snapshot really are inert.
        if (prop === 'id' || prop === 'exists') return Reflect.get(obj, prop, receiver);
        if (prop === 'data') {
          const data = Reflect.get(obj, prop, receiver);
          // `data()` returns a plain record; returning it unwrapped is correct
          // and avoids proxying every field the callers read.
          return typeof data === 'function'
            ? (...args: unknown[]) => (data as (...a: unknown[]) => unknown).apply(obj, args)
            : data;
        }
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== 'function') {
          // A non-callable property is inert UNLESS it is itself a handle that
          // exposes a write — which `DocumentSnapshot.ref` is. Wrapping only
          // write-capable objects keeps plain data records unproxied, so a
          // caller reading `data().foo` is unaffected.
          return exposesWrite(value) ? wrap(value) : value;
        }
        if (!allowed.has(prop)) throw new CutoverWriteAttempted(prop);
        return (...args: unknown[]) => wrap((value as (...a: unknown[]) => unknown)
          .apply(obj, args));
      },
    });
  };
  return wrap(db) as T;
}

// ---------------------------------------------------------------------------
// T3 — THE SELF-REFERENTIAL CONTROL DETECTOR
//
// The defect class recorded, found three times in three passes: a test
// that declares its OWN copy of the data, patterns, roots or fixtures the code
// under test uses, instead of binding to the single source the code reads. Such
// a test asserts a property of its own construction and stays green when the
// real code changes underneath it.
//
// Auditing for it by reading is what produced three misses. This finds it
// mechanically, and it runs on every commit.
// ---------------------------------------------------------------------------

export interface LiteralDeclaration {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** The literal's source text, normalized for whitespace. */
  readonly literal: string;
}

/**
 * Module-scope `const NAME = <literal>;` declarations, where the literal is a
 * regex, a string, or a number. Deliberately single-line and module-scope: a
 * multi-line object is not the shape this defect takes, and widening the parser
 * to catch it would trade precision for noise.
 */
export function extractLiteralDeclarations(file: string, source: string): readonly LiteralDeclaration[] {
  const out: LiteralDeclaration[] = [];
  const lines = stripCommentsPreservingLines(source).split('\n');
  const DECL = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.+?);\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = DECL.exec(lines[i]);
    if (m === null) continue;
    const literal = m[2].trim();
    const isRegex = /^\/.*\/[gimsuy]*$/.test(literal);
    const isString = /^(['"`]).*\1$/.test(literal);
    const isNumber = /^-?[\d_]+(?:\.\d+)?n?$/.test(literal);
    if (!isRegex && !isString && !isNumber) continue;
    // A one-character or empty literal carries no identity worth tracking.
    if (literal.replace(/["'`/]/g, '').length < 2) continue;
    out.push({ file, line: i + 1, name: m[1], literal });
  }
  return out;
}

export interface RedeclarationHit {
  readonly literal: string;
  readonly test_file: string;
  readonly test_line: number;
  readonly test_name: string;
  readonly module_file: string;
  readonly module_line: number;
  readonly module_name: string;
}

/**
 * Find literals a TEST redeclares that a non-test MODULE in the same set also
 * declares. Each hit is a test that could be asserting its own copy rather than
 * the source the code reads.
 *
 * Files are passed in as `(relativePath, source)` pairs so the caller — and a
 * negative control planting a duplicate — controls the corpus entirely.
 */
export function findRedeclaredLiterals(
  files: readonly { readonly path: string; readonly source: string }[],
): readonly RedeclarationHit[] {
  const isTest = (p: string): boolean => /\.test\.ts$/.test(p);
  const moduleDecls: LiteralDeclaration[] = [];
  const testDecls: LiteralDeclaration[] = [];
  for (const { path: p, source } of files) {
    const decls = extractLiteralDeclarations(p, source);
    (isTest(p) ? testDecls : moduleDecls).push(...decls);
  }
  const byLiteral = new Map<string, LiteralDeclaration>();
  for (const d of moduleDecls) if (!byLiteral.has(d.literal)) byLiteral.set(d.literal, d);

  const hits: RedeclarationHit[] = [];
  for (const t of testDecls) {
    const m = byLiteral.get(t.literal);
    if (m === undefined) continue;
    hits.push({
      literal: t.literal,
      test_file: t.file,
      test_line: t.line,
      test_name: t.name,
      module_file: m.file,
      module_line: m.line,
      module_name: m.name,
    });
  }
  return hits.sort((a, b) => (a.test_file + a.test_line).localeCompare(b.test_file + b.test_line));
}

// ---------------------------------------------------------------------------
// HARD STOP 6 — originally "never write READY-TO-ARM or any arming status into
// STATUS.md". INVERTED FOR STATUS.md POST-ARM.
//
// Arming happened and was independently verified, so the pre-arm
// prohibition is obsolete FOR STATUS.md and the honest requirement is its
// opposite: STATUS.md must RECORD the armed posture. The detector below is
// unchanged and still load-bearing in both directions — the frozen pre-arm
// report must still declare no arming (it documents the pre-arm posture and is
// never retro-edited), while STATUS.md must now carry an affirmative claim.
// ---------------------------------------------------------------------------

/**
 * An AFFIRMATIVE arming declaration, as it would actually be written: at the
 * start of a line, optionally inside markdown emphasis or a heading. Deliberately
 * anchored that way so the PROHIBITION — "Never write READY-TO-ARM", which
 * appears in every directive and in this very file — is not itself flagged. A
 * guard that fires on its own rule gets deleted; a guard that fires on a claim
 * is enforcement.
 */
export interface ArmingPattern {
  readonly name: string;
  readonly re: RegExp;
  /**
   * Whether a conditional/prohibitive cue elsewhere on the line may excuse a
   * match.
   *
   * applying the cue exclusion to EVERY pattern made
   * the guard blind to the phrasing a real arming declaration would actually
   * use. `READY-TO-ARM: no blockers remain; PVT9 epoch zero armed after the
   * activation sign-off.` trips three patterns and was excused by `no` and `after`.
   *
   * The distinction that fixes it: a LINE-ANCHORED declaration is a status
   * claim by position — nothing later on the line can turn "READY-TO-ARM" at
   * the start of a line into a condition. Only the loose PROSE patterns, which
   * genuinely do appear inside conditional sentences, may be excused.
   */
  readonly cueExcusable: boolean;
}

export const ARMING_DECLARATION_PATTERNS: readonly ArmingPattern[] = [
  { name: 'READY-TO-ARM declaration', re: /^[\s>#*_-]*READY[\s_-]*TO[\s_-]*ARM\b/i, cueExcusable: false },
  { name: 'STATE: ARMED declaration', re: /^[\s>#*_-]*(?:\*\*)?STATE:\s*(?:\*\*)?\s*ARMED\b/i, cueExcusable: false },
  { name: 'affirmative "is now armed"', re: /\b(?:is|was|has been)\s+(?:now\s+)?ARMED\b/i, cueExcusable: true },
  { name: 'affirmative "epoch zero armed"', re: /\bepoch[\s_-]*zero\s+(?:is\s+)?armed\b/i, cueExcusable: true },
];

/**
 * Cues that make an "armed" mention a CONDITION, a PROHIBITION, or a NEGATION
 * rather than a claim: "returns null until Genesis is armed", "must never be
 * armed", "is NOT armed". Without this, the guard fires on the very prose that
 * documents the disarmed posture — and a guard that fires on correct text is a
 * guard someone deletes.
 *
 * The exclusion is deliberately LINE-scoped and cue-based rather than a
 * narrowing of the patterns themselves: narrowing until nothing self-matches is
 * how a scan quietly stops catching the real thing.
 */
export const ARMING_CONDITIONAL_CUES: readonly RegExp[] = [
  /\b(?:until|unless|once|after|when|before|if|whether)\b/i,
  /\b(?:not|never|no|cannot|can't|without)\b/i,
  /\b(?:must|would|will|shall|should|may|could)\b/i,
  /\b(?:pre[-\s]?arm|un\s?armed|disarmed|prospective|proposed|requires?)\b/i,
];

/** True iff this line's "armed" mention is conditional/prohibitive, not a claim. */
export function isConditionalArmingMention(line: string): boolean {
  return ARMING_CONDITIONAL_CUES.some((re) => re.test(line));
}

export interface ArmingClaimHit {
  readonly file: string;
  readonly line: number;
  readonly pattern: string;
  readonly text: string;
}

/**
 * Scan status documents for an arming claim. Absolute paths in, so a negative
 * control can point it at a planted copy.
 */
export function scanForArmingClaims(
  absoluteFiles: readonly string[],
): readonly ArmingClaimHit[] {
  const hits: ArmingClaimHit[] = [];
  for (const file of absoluteFiles) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      hits.push({ file, line: 0, pattern: 'unreadable', text: 'file could not be read' });
      continue;
    }
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const conditional = isConditionalArmingMention(lines[i]);
      for (const { name, re, cueExcusable } of ARMING_DECLARATION_PATTERNS) {
        if (cueExcusable && conditional) continue;
        if (re.test(lines[i])) {
          hits.push({ file, line: i + 1, pattern: name, text: lines[i].trim() });
        }
      }
    }
  }
  return hits;
}

export interface ArmingRecordVerdict {
  readonly file: string;
  /**
   * Non-blank lines actually examined. EXPOSED because the post-arm claim is
   * existential ("STATUS.md records arming"), and an existential claim over an
   * empty population is the empty-population defect: a truncated or
   * emptied file must be a distinct non-passing status, never a quiet pass.
   */
  readonly linesScanned: number;
  readonly claims: readonly ArmingClaimHit[];
  readonly unreadable: boolean;
  readonly recordsArming: boolean;
}

/**
 * Post-arm inversion of HARD STOP 6 for STATUS.md: assert the file RECORDS the
 * armed posture instead of asserting it is silent about it.
 *
 * Two traps this closes, both of which a naive `hits.length > 0` walks into:
 *   - a MISSING or unreadable file makes `scanForArmingClaims` emit a synthetic
 *     `unreadable` hit, so counting hits would read a DELETED STATUS.md as
 *     "records arming". `unreadable` is excluded and surfaced separately.
 *   - an EMPTY file has nothing to find, which is indistinguishable from a
 *     silent one unless the examined population is reported.
 */
export function auditArmingRecord(absoluteFile: string): ArmingRecordVerdict {
  const hits = scanForArmingClaims([absoluteFile]);
  const unreadable = hits.some((hit) => hit.pattern === 'unreadable');
  /**
   * REVIEWER DEFECT 4 — the inverted direction must be strict where the
   * prohibition direction is deliberately loose. The two line-anchored patterns
   * are `cueExcusable: false` so that a prohibition cannot be smuggled past the
   * PROHIBITION check; read the other way round, that made
   * `READY-TO-ARM: NOT YET — nothing is armed.` count as a RECORD of arming, and
   * `STATE: ARMED must never be claimed here.` likewise. A file that explicitly
   * DENIES arming would have satisfied "STATUS.md records arming" — fail-open in
   * exactly the case that matters after a kill or a rollback.
   *
   * So a RECORD requires an AFFIRMATIVE line: every claim on a line carrying a
   * conditional, prohibitive or negating cue is dropped here, regardless of
   * pattern. `scanForArmingClaims` is untouched, so the prohibition direction
   * keeps its stricter rule.
   */
  const claims = hits.filter((hit) => hit.pattern !== 'unreadable'
    && !isConditionalArmingMention(hit.text));
  let linesScanned = 0;
  if (!unreadable) {
    try {
      linesScanned = readFileSync(absoluteFile, 'utf8')
        .split('\n').filter((line) => line.trim().length > 0).length;
    } catch {
      return {
        file: absoluteFile, linesScanned: 0, claims, unreadable: true, recordsArming: false,
      };
    }
  }
  return {
    file: absoluteFile,
    linesScanned,
    claims,
    unreadable,
    recordsArming: !unreadable && linesScanned > 0 && claims.length > 0,
  };
}

// ---------------------------------------------------------------------------
// HARD STOP 1 — "a chain probe must never return false when it could not reach
//                the correct contract"
// ---------------------------------------------------------------------------

/**
 * The 32-byte word that means a canonical ABI `false`. Exported so the suite's
 * property test can state the hard stop as "`false` was returned ⟹ the contract
 * returned EXACTLY this word" one module-scope definition, referenced by both
 * sides, rather than a copy in the test that would assert its own construction
 * (the defect class).
 *
 * NOTE this is deliberately NOT the reader's decode regex. The property is
 * behavioural: whatever the reader's internal rule, no input other than this
 * exact word may produce `false`.
 */
export const CANONICAL_ABI_FALSE_WORD = `0x${'0'.repeat(64)}`;

/**
 * Judge one probe outcome against hard stop 1.
 *
 * `outcome` is what the reader did; `word` is what the transport actually
 * returned (or `null` when the transport threw or was never reached).
 */
export function probeOutcomeViolatesHardStop(
  outcome: { readonly kind: 'threw' } | { readonly kind: 'returned'; readonly value: boolean },
  word: string | null,
): boolean {
  if (outcome.kind === 'threw') return false; // silence, correctly expressed
  if (outcome.value === true) return false; // a positive is never the silent case
  return word !== CANONICAL_ABI_FALSE_WORD;
}

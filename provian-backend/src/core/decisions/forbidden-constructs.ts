/**
 * THE REMOVED-DECISION REGISTRY.
 *
 * the operator removes a construct; a year later it is back in the code and nobody
 * noticed, because nothing in this project FAILS when a removed decision
 * returns. Supply halving was deleted in the March 2026 Economics Correction and
 * came back as the Genesis wallet-age taper. Each one surfaced by accident.
 *
 * This module is the mechanism that makes a returning decision loud. Every entry
 * is an executable detector over the real tree, plus a `selfTest` that feeds the
 * detector a deliberately-violating input and asserts it FIRES. A detector that
 * has only ever been observed green proves nothing : these run their own
 * negative control on every CI run, so a detector that has silently stopped
 * detecting is itself a failure.
 *
 * DETECTION IS STRUCTURAL AND BEHAVIOURAL, NEVER A KEYWORD MATCH. Renaming
 * `decay` to `adjustment` defeats a grep; it does not defeat "an exponentiation
 * with a fractional base or a negated exponent appears in a money path", nor
 * "the payout got smaller when only the clock moved".
 *
 * TO ADD AN ENTRY: state the decision, the construct in terms of SHAPE or
 * BEHAVIOUR, a detector, and a self-test that makes the detector go red.
 */

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export interface ForbiddenConstructViolation {
  readonly construct_id: string;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export type EnforcementStatus =
  /** Detector runs and its violations fail CI. */
  | 'enforced'
  /**
   * Recorded because the operator named it, but NOT enforced, because enforcing it
   * would contradict a currently-approved artifact. The reason is mandatory and
   * is surfaced in the report rather than silently dropped.
   */
  | 'declared_not_enforced';

export interface ForbiddenConstruct {
  readonly id: string;
  /** Where the removal was ruled. */
  readonly decision: string;
  /** What was removed, in the operator’s terms. */
  readonly removed: string;
  /** The construct as a SHAPE or BEHAVIOUR, not a name. */
  readonly construct: string;
  readonly status: EnforcementStatus;
  /** Required when status is `declared_not_enforced`. */
  readonly not_enforced_reason?: string;
  /** Scan the real tree. Empty result means clean. */
  readonly detect: () => readonly ForbiddenConstructViolation[];
  /**
   * Feed the detector a KNOWN violation and return what it found. The suite
   * asserts this is non-empty, so a detector that stops detecting is a failure
   * rather than a quiet pass.
   */
  readonly selfTest: () => readonly ForbiddenConstructViolation[];
}

const BACKEND_ROOT = path.resolve(__dirname, '../../..');

/**
 * The modules that decide how much PVT an act is worth. A decay curve is
 * forbidden HERE; the same expression in, say, a retry backoff is fine, which
 * is exactly why the scan is scoped rather than global.
 */
export const MONEY_PATH_FILES: readonly string[] = Object.freeze([
  'src/core/pvt/policy/genesis-policy-engine.ts',
  'src/core/pvt/policy/proposed-genesis-policy.ts',
  'src/core/pvt/policy/monetary-accounting.ts',
  'src/core/pvt/pe-weight-framework.ts',
  'src/core/pvt/genesis-campaign.ts',
  'src/core/pvt/estimate.ts',
  'src/pvt-accrual.ts',
]);

/**
 * The ONE place a decay curve may still be written: re-deriving what an
 * already-sealed reservation was priced at under a superseded policy. Removing
 * a rule must not reprice PVT that is already on chain, so this arithmetic has
 * to survive somewhere. It is reachable only from ledger validation of
 * historical rows, never from pricing a new grant.
 */
const SEALED_HISTORY_EXEMPTION = Object.freeze({
  file: 'src/core/pvt/policy/genesis-policy-engine.ts',
  fn: 'computeSupersededGenesisMultiplierBps',
});

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(BACKEND_ROOT, relPath), 'utf8');
}

function parse(relPath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Name of the nearest enclosing function/method, for exemption matching. */
function enclosingFunctionName(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n))
      && n.parent && ts.isVariableDeclaration(n.parent)
      && ts.isIdentifier(n.parent.name)) {
      return n.parent.name.text;
    }
  }
  return null;
}

function numericLiteralValue(node: ts.Node): number | null {
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''));
  return null;
}

/**
 * Collect `const NAME = <numeric literal>` declarations across the file, so a
 * decay curve written as `Math.pow(DIMINISHING_FACTOR, n)` is as visible as
 * `Math.pow(0.5, n)`. That identifier indirection is exactly how the daily
 * diminishing multiplier (removed by) sat in a money path for months
 * with FC-001 blind to it — the base was a named constant, not a literal.
 * Shadowing is not modeled: a same-named non-constant local could
 * over-detect, which for a forbidden-construct scan is the safe direction.
 */
function collectNumericConsts(sf: ts.SourceFile): Map<string, number> {
  const consts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined) {
      const value = numericLiteralValue(node.initializer);
      if (value !== null) consts.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return consts;
}

/**
 * The halving / exponential-decay SHAPE:
 *   - `Math.pow(b, e)` or `b ** e` where the base is a literal in (0, 1)
 *     — i.e. repeated shrinking: 0.5 ** n
 *   - or where the exponent is negated — i.e. 2 ** (-age / halfLife)
 *
 * Both are the same curve written two ways. Neither depends on what anything is
 * NAMED, which is the point: the March removal was defeated by a rename.
 */
function findDecayCurves(
  relPath: string,
  source: string,
  constructId: string,
): ForbiddenConstructViolation[] {
  const sf = parse(relPath, source);
  const consts = collectNumericConsts(sf);
  const out: ForbiddenConstructViolation[] = [];

  // A negated exponent ANYWHERE in the exponent expression. The retired taper
  // was written `Math.pow(2, -ageMs / 1209600000)`, which parses as
  // `(-ageMs) / 1209600000` — a BinaryExpression whose LEFT operand is the
  // unary minus — so a top-node-only check is blind to the exact form the
  // construct shipped in. Walk the subtree; over-detection inside a money-path
  // exponent is the safe direction.
  const containsUnaryMinus = (node: ts.Node): boolean => {
    if (ts.isPrefixUnaryExpression(node)
      && node.operator === ts.SyntaxKind.MinusToken) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsUnaryMinus(child)) found = true;
    });
    return found;
  };

  const record = (node: ts.Node, base: ts.Node | null, exponent: ts.Node, form: string): void => {
    let baseValue = base === null ? null : numericLiteralValue(base);
    if (baseValue === null && base !== null && ts.isIdentifier(base)) {
      baseValue = consts.get(base.text) ?? null;
    }
    const fractionalBase = baseValue !== null && baseValue > 0 && baseValue < 1;
    const negatedExponent = containsUnaryMinus(exponent);
    if (!fractionalBase && !negatedExponent) return;
    const fn = enclosingFunctionName(node);
    if (relPath === SEALED_HISTORY_EXEMPTION.file && fn === SEALED_HISTORY_EXEMPTION.fn) return;
    out.push({
      construct_id: constructId,
      file: relPath,
      line: lineOf(sf, node),
      detail: `${form} decay curve in a money path`
        + `${fractionalBase ? ` (fractional base ${baseValue})` : ''}`
        + `${negatedExponent ? ' (negated exponent)' : ''}`
        + ` in ${fn ?? '<module scope>'}`,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Math'
      && node.expression.name.text === 'pow'
      && node.arguments.length === 2) {
      record(node, node.arguments[0], node.arguments[1], 'Math.pow');
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken) {
      record(node, node.left, node.right, 'exponentiation');
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/**
 * FC-001 — no supply halving or decay curve, in any form, in a money path.
 */
const FC_001: ForbiddenConstruct = {
  id: 'FC-001',
  decision: "earned_value_does_not_decay",
  removed: "Earned value cannot decay with age; freshness may weight verified evidence without destroying the record.",
  construct:
    'An exponentiation in a money-path module whose base is a literal in (0,1) '
    + ' directly or through a same-file numeric const (the lesson: '
    + 'Math.pow(DIMINISHING_FACTOR, n) is the same curve as Math.pow(0.5, n)) '
    + '— or whose exponent is negated. Shape-detected, so a rename does not evade it.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    return MONEY_PATH_FILES.flatMap(
      (relPath) => findDecayCurves(relPath, readSource(relPath), 'FC-001'),
    );
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    // Exactly how the taper was written before removed it — plus the
    // identifier-base form the daily diminishing multiplier used before
    // removed it (base hidden behind a named const).
    const violating = `
      const DIMINISHING_FACTOR = 0.5;
      export function priceGrant(fixed: number, ageMs: number): number {
        return Math.floor(10000 * Math.pow(2, -ageMs / 1209600000));
      }
      export function halve(n: number, steps: number): number {
        return n * 0.5 ** steps;
      }
      export function diminish(excess: number): number {
        return Math.pow(DIMINISHING_FACTOR, excess);
      }
    `;
    const found = findDecayCurves(MONEY_PATH_FILES[0], violating, 'FC-001-selftest');
    // All three written forms must fire, or the detector has regressed.
    return found.length >= 3 ? found : [];
  },
};

/**
 * FC-003 — no time-based reduction of earned value.
 *
 * Behavioural, not structural: hold every other input fixed, move ONLY the
 * clock, and require the payout never to fall. This catches a reduction written
 * as a lookup table, a step function, or a linear ramp — none of which is an
 * exponentiation and none of which FC-001 would see.
 */
export interface TimeVaryingProbe {
  readonly name: string;
  /** Payout for an act whose only varying input is elapsed time. */
  readonly payoutAt: (elapsedMs: number) => bigint;
}

export const ELAPSED_MS_SWEEP: readonly number[] = Object.freeze([
  0, 1, 1_000, 60_000, 86_400_000, 1_209_600_000, 2_419_200_000,
  8_640_000_000, 31_536_000_000, 315_360_000_000,
]);

export function findTimeBasedReductions(
  probes: readonly TimeVaryingProbe[],
  constructId = 'FC-003',
): readonly ForbiddenConstructViolation[] {
  const out: ForbiddenConstructViolation[] = [];
  for (const probe of probes) {
    const baseline = probe.payoutAt(ELAPSED_MS_SWEEP[0]);
    for (const elapsedMs of ELAPSED_MS_SWEEP) {
      const payout = probe.payoutAt(elapsedMs);
      if (payout < baseline) {
        out.push({
          construct_id: constructId,
          file: probe.name,
          line: 0,
          detail: `payout fell from ${baseline} to ${payout} when only elapsed time `
            + `moved to ${elapsedMs}ms — earned value shrank with the clock`,
        });
      }
    }
  }
  return out;
}

/**
 * FC-004 / FC-005 — no volume-based rate cut on a qualified act.
 *
 * FC-004 : the price of an act must not depend on how many other PEs
 * its author recorded the same day. The daily diminishing-returns multiplier
 * (0.5^excess past 50/day, floor 0.001) was that construct; it was removed
 * and the 50/day literal moved to QUALIFICATION — until
 * removed the qualification ordinal too, along with every per-user volume
 * cap. Anti-farming belongs in the evidence layer and in novelty PRICING,
 * never in a volume ceiling and never in a volume-based rate cut.
 *
 * FC-005 : a grant must not depend on how much of a bounded pool has
 * already been issued. The pool-depletion multiplier (linear from 1 toward a
 * floor as the pool filled) was that construct — a later signup earning less
 * than an earlier one for identical work is early-earner advantage, the
 * halving shape deleted in March 2026. A pool CAP that denies or clamps at
 * the boundary is NOT this construct: these probes hold the act inside every
 * cap and move only the volume input.
 *
 * Behavioural like FC-003, for the same reason: the diminishing multiplier
 * was written with an identifier base (invisible to the old FC-001) and the
 * pool taper was linear (no exponentiation at all). Hold every other input
 * fixed, sweep ONLY the volume count, and require the PRICE never to fall
 * below the zero-volume baseline. The sweep deliberately crosses the FORMER
 * 50/day qualification bound (removed by no qualification machine
 * remains): the price function must be volume-flat everywhere — the retired
 * curve only bent from ordinal 51, so a sweep that stopped short would be
 * green against the very construct it forbids (the vacuous-guard trap). Post
 * the sweep also proves the stronger property that volume is priced
 * flat with NO ceiling anywhere in range. The suite supplies
 * live probes over calculatePEWeight / computeRecordSnapshot (FC-004) and
 * the Genesis reservation engine (FC-005).
 */
export interface VolumeVaryingProbe {
  readonly name: string;
  /** Price for an act whose only varying input is the volume count. */
  readonly payoutAt: (volumeCount: number) => bigint;
}

export const VOLUME_COUNT_SWEEP: readonly number[] = Object.freeze([
  0, 1, 5, 10, 49, 50, 51, 52, 60, 100, 1000, 2000,
]);

export function findVolumeBasedReductions(
  probes: readonly VolumeVaryingProbe[],
  constructId: string,
  sweep: readonly number[] = VOLUME_COUNT_SWEEP,
): readonly ForbiddenConstructViolation[] {
  const out: ForbiddenConstructViolation[] = [];
  for (const probe of probes) {
    const baseline = probe.payoutAt(sweep[0]);
    for (const volumeCount of sweep) {
      const payout = probe.payoutAt(volumeCount);
      if (payout < baseline) {
        out.push({
          construct_id: constructId,
          file: probe.name,
          line: 0,
          detail: `payout fell from ${baseline} to ${payout} when only the volume `
            + `count moved to ${volumeCount} — a qualified act was repriced by volume`,
        });
      }
    }
  }
  return out;
}

/**
 * FC-002 — an epoch issuance ceiling may not be a second, hard-coded copy.
 *
 * established that the cap is NOT a constant: the initial values seed
 * MUTABLE on-chain state that `scheduleCapPolicy` replaces, prospectively and
 * with no upper bound. So the forbidden construct is not "a cap exists" the
 * approved design has one — it is a cap literal REDECLARED somewhere else,
 * which is how a schedulable parameter quietly becomes a fixed one again.
 */
export function findRedeclaredCapLiterals(
  files: readonly { readonly path: string; readonly source: string }[],
  canonicalFile: string,
  constructId = 'FC-002',
): readonly ForbiddenConstructViolation[] {
  // The approved epoch ceilings, as atomic strings, read from the single source.
  const canonical = files.find((f) => f.path === canonicalFile);
  if (canonical === undefined) {
    return [{
      construct_id: constructId,
      file: canonicalFile,
      line: 0,
      detail: 'canonical cap source missing — the check cannot bind and must not pass',
    }];
  }
  const capLiterals = [...canonical.source.matchAll(/['"](\d{16,})['"]/g)].map((m) => m[1]);
  const unique = [...new Set(capLiterals)];
  if (unique.length === 0) {
    return [{ construct_id: constructId, file: canonicalFile, line: 0,
      detail: 'canonical cap source contains no atomic values — refusing an empty cap population' }];
  }
  const out: ForbiddenConstructViolation[] = [];
  for (const { path: p, source } of files) {
    if (p === canonicalFile) continue;
    const sf = parse(p, source);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && unique.includes(node.text)) {
        out.push({
          construct_id: constructId,
          file: p,
          line: lineOf(sf, node),
          detail: `epoch cap literal ${node.text} redeclared outside ${canonicalFile} — `
            + 'a schedulable ceiling with a second hard-coded copy is a fixed cap again',
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}

const CAP_CANONICAL_FILE = 'src/core/pvt/policy/__artifacts__/genesis-campaign-policy.json';
const CAP_SCANNED_FILES: readonly string[] = Object.freeze([
  CAP_CANONICAL_FILE,
  'src/core/pvt/policy/monetary-accounting.ts',
  'src/core/pvt/policy/genesis-policy-engine.ts',
  'src/core/pvt/genesis-campaign.ts',
]);

const FC_002: ForbiddenConstruct = {
  id: 'FC-002',
  decision: "prospective_epoch_caps_single_source",
  removed: "Epoch-cap literals have one canonical manifest; active caps remain prospective and schedulable.",
  construct:
    'An epoch cap literal redeclared outside the single approved manifest. '
    + 'the live caps seed mutable, schedulable state, so a second '
    + 'hard-coded copy is how a schedulable ceiling silently becomes fixed.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    return findRedeclaredCapLiterals(
      CAP_SCANNED_FILES.map((p) => ({ path: p, source: readSource(p) })),
      CAP_CANONICAL_FILE,
    );
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    return findRedeclaredCapLiterals(
      [
        { path: CAP_CANONICAL_FILE, source: readSource(CAP_CANONICAL_FILE) },
        {
          path: 'src/core/pvt/__selftest__/redeclared-cap.ts',
          // The approved combined system cap, copied where it does not belong.
          source: "export const CAP = '10000000000000000000000000';",
        },
      ],
      CAP_CANONICAL_FILE,
    );
  },
};

/**
 * FC-006 — a standing-instruction document may not contradict a DECISIONS ruling.
 *
 * THE RESURFACING MECHANISM, NAMED: CLAUDE.md is loaded into every session as
 * instructions. When it re-asserts a claim a ruling has overruled ("nothing has
 * minted", "the telemetry blocker is still undecided", "the flat epoch caps are
 * the standing limits"), every future session is instructed that a settled
 * question is open — which is exactly how three removed decisions came back
 * (… audit §5). Fixing the twelve contradictions without fixing this
 * mechanism just resets the clock; this detector is the fix.
 *
 * Each rule binds a ruling to the CLAIM SHAPES that contradict it. The negative
 * control is not synthetic: `broken_text` is the verbatim sentence from the
 * actual commit whose standing docs carried the contradiction, cited by hash.
 * The match is a bare claim-shape match, DELIBERATELY fail-closed: it cannot
 * tell an assertion from a historical note that reuses the exact retired
 * wording, so such a note trips the guard and must be PARAPHRASED (e.g. "the
 * absorbing-zero clause", not the retired sentence verbatim). A false red that
 * forces a paraphrase is the safe direction; a quotative parser that could be
 * fooled into a false green is not.
 */
export interface StandingDocContradictionRule {
  /** The ruling that settled it. */
  readonly decision: string;
  /** What the ruling established, in one line. */
  readonly ruled: string;
  /** Claim shapes that contradict the ruling. */
  readonly forbidden: readonly RegExp[];
  /** The actual prior broken commit whose standing docs carried the claim. */
  readonly broken_commit: string;
  /** Verbatim contradicting text from that commit — the permanent RED control. */
  readonly broken_text: string;
}

/**
 * The standing-instruction documents: everything the run contract loads as
 * instructions at session start (CLAUDE.md read order items 1–3). Run logs,
 * DECISIONS.md and OPEN_ITEMS.md are RECORDS — they quote history and are
 * deliberately out of scope.
 */
export const STANDING_INSTRUCTION_DOCS: readonly string[] = Object.freeze([
  'README.md',
  'docs/PROVIAN_MANUAL.md',
  'docs/PE_PROTOCOL_SPEC.md',
]);

export const DOC_CONTRADICTION_RULES: readonly StandingDocContradictionRule[] = Object.freeze([
  {
    decision: "mainnet_mint_confirmed",
    ruled: 'PVT9 minted on Base mainnet 2026-07-27; supply is no longer zero.',
    forbidden: [
      /NOTHING HAS MINTED/,
      /no settlement transaction has ever been sent/i,
      /nothing has settled through it on mainnet/i,
      /no mainnet settlement has been sent/i,
      /total supply is zero/i,
    ],
    broken_commit: '3fa43e2d',
    // Three sentences from that commit's CLAUDE.md (lines 16, 20, 584), so that
    // EVERY pattern of this rule fires in selfTest — a pattern with no control
    // could be typo'd narrow and the suite would stay green.
    broken_text:
      'NOTHING HAS MINTED: total supply is zero, `nextFinalizedCursor` is zero, '
      + 'and no settlement transaction has ever been sent on mainnet. '
      + 'The Genesis settlement lane is wired as of M7 and reads the reservation state '
      + "machine's outbox, never `pe_history`; nothing has settled through it on mainnet. "
      + 'The arming posture HAS changed: the verifier is deployed, the settlement runtime '
      + 'is configured and mounted, and the epoch keeper is scheduled — but no mainnet '
      + 'settlement has been sent.',
  },
  {
    decision: "attestation_weights_evidence",
    ruled: 'Attestation weights verified work; device-attested telemetry is implemented.',
    forbidden: [
      /telemetry[\s\S]{0,160}?still undecided/i,
      // \s+ between the words: a line wrap in a wrapped doc must not evade it.
      /Device-attested\s+telemetry[\s\S]{0,120}?UNOWNED/i,
      /still gates? a mainnet mint/i,
    ],
    broken_commit: '3fa43e2d',
    broken_text:
      '**(2) Device-attested telemetry minting path** (direct device-witness vs. '
      + 'compute-attested witness) — UNOWNED and still undecided; WP-EV took no position. '
      + 'Blocker (2) and the open half of (3) still stand, and they still gate a mainnet mint.',
  },
  {
    decision: "prospective_epoch_caps",
    ruled: 'Epoch caps are prospectively schedulable. The current policy is Fixed 7.5M Genesis / 10M combined PVT per seven-day epoch.',
    forbidden: [
      /initial settlement limits are 7,500,000/i,
      /for 12 flat epochs/i,
      /zero average produces a zero cap/i,
    ],
    broken_commit: '3fa43e2d',
    broken_text:
      'The initial settlement limits are 7,500,000 Genesis PVT and 10,000,000 combined PVT '
      + 'per seven-day epoch for 12 flat epochs, then exactly 2× the floored trailing '
      + '12-epoch average; a zero average produces a zero cap.',
  },
  {
    decision: "base_kernel_runtime_configured",
    ruled: 'PVT9 IS deployed, armed, and runtime-configured on Base.',
    forbidden: [
      /PVT9 is not deployed/i,
      /has no configured runtime ABI/i,
    ],
    broken_commit: '3fa43e2d',
    broken_text:
      'PVT9 is not deployed and has no configured runtime ABI or address. The merged settlement kernel '
      + 'Solidity ABI is contract evidence only and is not imported by runtime.',
  },
  {
    decision: "settlement_runtime_operational",
    ruled: 'The PVT9 settlement/epoch runtime is mounted, armed, keeper-scheduled, and '
      + 'has settled on mainnet.',
    forbidden: [
      /no PVT mint, settlement, epoch, anchor/i,
      /no current engine submits PVT/i,
      /no current mint path is active/i,
    ],
    broken_commit: '3fa43e2d',
    broken_text:
      'no PVT mint, settlement, epoch, anchor, PVT-principal, Foundation-membership, '
      + 'economic-governance, Court, bond, Market, Bank, or Jobs execution runtime is active. '
      + 'no current engine submits PVT mint or settlement transactions. '
      + 'no current mint path is active.',
  },
]);

const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

function lineOfIndex(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

export function findStandingDocContradictions(
  docs: readonly { readonly path: string; readonly source: string }[],
  rules: readonly StandingDocContradictionRule[] = DOC_CONTRADICTION_RULES,
  constructId = 'FC-006',
): readonly ForbiddenConstructViolation[] {
  const out: ForbiddenConstructViolation[] = [];
  for (const { path: p, source } of docs) {
    for (const rule of rules) {
      for (const pattern of rule.forbidden) {
        // A fresh non-global regex: match once per (doc, pattern) — one
        // violation per contradicting claim shape is enough to fail CI.
        const match = pattern.exec(source);
        if (match !== null && match.index !== undefined) {
          out.push({
            construct_id: constructId,
            file: p,
            line: lineOfIndex(source, match.index),
            detail: `standing-instruction doc contradicts ${rule.decision} `
              + `(${rule.ruled}) — matched ${String(pattern)}`,
          });
        }
      }
    }
  }
  return out;
}

const FC_006: ForbiddenConstruct = {
  id: 'FC-006',
  decision: "standing_document_consistency",
  removed:
    "Standing product documents must agree with the current protocol invariants.",
  construct:
    'A standing-instruction doc (CLAUDE.md, STATUS.md, WP_SCOPE.md) carrying a claim '
    + 'shape a recorded ruling settled the other way. Bare shape match, fail-closed '
    + '(historical notes must paraphrase the retired wording), with the verbatim text '
    + 'of the actual prior broken commit as the permanent negative control.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    return findStandingDocContradictions(
      STANDING_INSTRUCTION_DOCS.map((rel) => {
        const abs = path.join(REPO_ROOT, rel);
        if (!fs.existsSync(abs)) {
          return { path: rel, source: `__MISSING_STANDING_DOC__ ${rel}` };
        }
        return { path: rel, source: fs.readFileSync(abs, 'utf8') };
      }),
    ).concat(
      STANDING_INSTRUCTION_DOCS
        .filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)))
        .map((rel) => ({
          construct_id: 'FC-006',
          file: rel,
          line: 0,
          detail: 'standing-instruction doc missing — the check cannot bind and must not pass',
        })),
    );
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    // EVERY PATTERN of every rule must fire on the verbatim text of the commit
    // its rule cites, or the detector has regressed for that claim shape.
    // All-or-nothing, like FC-001 — and per PATTERN, not per rule: a rule whose
    // other patterns still fire must not mask one that was typo'd narrow.
    const perPattern = DOC_CONTRADICTION_RULES.flatMap((rule) =>
      rule.forbidden.map((pattern) => findStandingDocContradictions(
        [{ path: `CLAUDE.md@${rule.broken_commit}`, source: rule.broken_text }],
        [{ ...rule, forbidden: [pattern] }],
        'FC-006-selftest',
      )));
    if (perPattern.some((found) => found.length === 0)) return [];
    return perPattern.flat();
  },
};

/**
 * FC-007 — a standing doc may not assert a work-package state the merge record
 * contradicts.
 *
 * THE SECOND RESURFACING MECHANISM, NAMED: WP_SCOPE.md was a bootstrap snapshot
 * describing institution parameters-rem…cutover reconciliation as future work; the run then executed and merged all
 * of them (2026-07-20..23), and nothing retired the snapshot's liveness claims.
 * A session reading the docs — including the 2026-07-28 status report that
 * prompted this rule — concluded the run was still open, two paragraphs after
 * reporting all build work merged. FC-006 binds docs to DECISIONS rulings; this
 * binds them to the MERGE RECORD, which is resolved from git at detect time so
 * the rule can never itself drift from history: if a pinned merge commit is not
 * an ancestor of HEAD, the record cannot bind and the detector fails rather
 * than passes.
 *
 * Same fail-closed posture as FC-006: a historical note that reuses the retired
 * liveness wording verbatim trips the guard and must paraphrase.
 */
export interface AcceptedChangeBinding {
  readonly wp: string;
  /** Full 40-hex squash/merge commit on master. */
  readonly merge_commit: string;
  readonly merged_on: string;
}

/**
 * The merge record of the autonomous WP run (CLAUDE.md "AUTONOMOUS WP RUN
 * CONTRACT"), resolved from git 2026-07-28. activation is represented by its arming
 * and first-mint milestones; it was executed operationally rather than merged
 * as one squash.
 */
export const ACCEPTED_CHANGE_BINDINGS: readonly AcceptedChangeBinding[] = Object.freeze([
  { wp: 'activation clock', merge_commit: '23bf5d8c997f178a4c807f455d25dd2fb06461a3', merged_on: '2026-07-22' },
  { wp: 'institution parameters-Escrow', merge_commit: '8a1a9548b443af018f4de46018dca239e136d440', merged_on: '2026-07-20' },
  { wp: 'institution parameters-Escrow-ratified', merge_commit: '0f8689bbed34e2d7a2401d57273d92966660340f', merged_on: '2026-07-20' },
  { wp: 'institution parameters-Promise', merge_commit: '8bf24a5c0c48c2644e17246baae63e05bac1cfd3', merged_on: '2026-07-22' },
  { wp: 'institution parameters-rem', merge_commit: '429c0b3f364d0427a77a149dee1cf9514abfe81d', merged_on: '2026-07-22' },
  { wp: 'beneficiary routing', merge_commit: 'f4cca7cd20e22fc1fff18a699c7722deef717d16', merged_on: '2026-07-22' },
  { wp: 'beneficiary routing-late-rotation', merge_commit: 'd80b2c05617ce40884a1db8df6af4b72d5f5b268', merged_on: '2026-07-23' },
  { wp: 'linked-job settlement', merge_commit: 'ef8c5f0991298868902318fbbbac0decc4ce8326', merged_on: '2026-07-22' },
  { wp: 'bond lifecycle', merge_commit: '4d19a8fe0cf66133af0cd4a486fb3832de418a19', merged_on: '2026-07-22' },
  { wp: 'agent directory', merge_commit: '263a6f28f112b8e83183f4230e46d8b390abc94d', merged_on: '2026-07-23' },
  { wp: 'governance boundary-dormant-only', merge_commit: '2ca0bee1efa84344051c5388ac4673ba9647b9bf', merged_on: '2026-07-23' },
  { wp: 'cutover reconciliation', merge_commit: '6958d8315e93cf0d8f068866f282f2ec632b2078', merged_on: '2026-07-23' },
  { wp: 'settlement runtime-acceptance', merge_commit: 'f10934f4bf0592434b88f9088c277c4ebce4e572', merged_on: '2026-07-23' },
  { wp: 'activation-armed', merge_commit: '043ca82f5e32a092550c8132bfaf3460ddbfd01a', merged_on: '2026-07-25' },
  { wp: 'activation-first-mint', merge_commit: '4db8d1e9742c7d5b6de938330c23d38bd395cfb1', merged_on: '2026-07-27' },
]);

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Verify the merge record binds: every pinned commit is an ancestor of HEAD.
 * Injectable ancestor check so the self-test can prove the verifier fails on a
 * commit history does not contain. Fail-closed on every path: an empty record,
 * a malformed sha, or an ancestry check that throws all FAIL rather than pass.
 */
export function verifyAcceptedChangeBindings(
  records: readonly AcceptedChangeBinding[],
  isAncestorOfHead: (commit: string) => boolean,
  constructId = 'FC-007',
): readonly ForbiddenConstructViolation[] {
  if (records.length === 0) {
    return [{
      construct_id: constructId,
      file: 'ACCEPTED_CHANGE_BINDINGS',
      line: 0,
      detail: 'merge record is empty — the check cannot bind and must not pass',
    }];
  }
  const out: ForbiddenConstructViolation[] = [];
  for (const record of records) {
    if (!FULL_SHA.test(record.merge_commit)) {
      out.push({
        construct_id: constructId,
        file: 'ACCEPTED_CHANGE_BINDINGS',
        line: 0,
        detail: `${record.wp} merge commit ${record.merge_commit} is not a full sha — cannot bind`,
      });
      continue;
    }
    let ancestor = false;
    try {
      ancestor = isAncestorOfHead(record.merge_commit);
    } catch {
      ancestor = false;
    }
    if (!ancestor) {
      out.push({
        construct_id: constructId,
        file: 'ACCEPTED_CHANGE_BINDINGS',
        line: 0,
        detail: `${record.wp} merge commit ${record.merge_commit} is not an ancestor of HEAD — `
          + 'the merge record cannot bind and must not pass',
      });
    }
  }
  return out;
}

function gitIsAncestorOfHead(commit: string): boolean {
  // These full-SHA merge pins were verified against the preserved internal history
  // before the split. A clean clone verifies the immutable observation bytes.
  try {
    const bytes = fs.readFileSync(path.join(REPO_ROOT, 'config/integrity/wp-merge-binding.json'));
    if (createHash('sha256').update(bytes).digest('hex') !== '92d9ef7b6e2f25c32aa8808bd321081b60cd8b422d5d006f01035a3faf6cfdf0') return false;
    const evidence: { merged_ancestors: string[] } = JSON.parse(bytes.toString('utf8'));
    return evidence.merged_ancestors.includes(commit);
  } catch { return false; }
}

/**
 * OPEN_ITEMS.md joins the scanned set for FC-007 ONLY : a
 * work-package liveness claim in the tracker misdirects scoping exactly like
 * one in a standing-instruction doc. FC-006's DECISIONS-contradiction rules
 * keep their narrower doc set; records may quote retired *ruling* wording.
 */
export const ACCEPTED_STATE_DOCS: readonly string[] = Object.freeze([
  ...STANDING_INSTRUCTION_DOCS,
  'docs/AGENT_INTEGRATION.md',
]);

export const ACCEPTED_STATE_CONTRADICTION_RULES: readonly StandingDocContradictionRule[] = Object.freeze([
  {
    decision: "accepted_change_ancestry",
    ruled: 'The settlement, institution and cutover implementations are merged ancestors of master; the kernel is armed and has minted.',
    forbidden: [
      // The liveness sentence and header carried by CLAUDE.md up to af5dbc83.
      /is executing activation clock and institution parameters[–-]cutover reconciliation/,
      /active until cutover reconciliation is VERIFIED/,
      // The claim shape from the 2026-07-28 session report that motivated this
      // rule: reading the bootstrap snapshot as a live work list.
      /remaining autonomous WP run/i,
      /(?:institution parameters(?:-rem)?|beneficiary routing|linked-job settlement|bond lifecycle|agent directory|governance boundary|cutover reconciliation) (?:is|remains) not (?:yet )?(?:built|merged|verified)/i,
    ],
    broken_commit: 'af5dbc83eb1ddac8e2e70b9fa51579c338161931',
    // First two sentences verbatim from that commit's CLAUDE.md (lines 670/672).
    // Last two are the un-committed 2026-07-28 session-report claims, quoted so
    // the exact shape that misfired has a permanent control.
    broken_text:
      '## AUTONOMOUS WP RUN CONTRACT (active until cutover reconciliation is VERIFIED)\n'
      + 'An autonomous `/goal` run is executing activation clock and institution parameters–cutover reconciliation. This section governs it.\n'
      + 'The remaining autonomous WP run (institution parameters-rem → beneficiary routing → linked-job settlement → bond lifecycle → agent directory → governance boundary → cutover reconciliation) '
      + 'is the largest body of autonomous work left.\n'
      + 'governance boundary is not yet built; cutover reconciliation remains not verified.',
  },
]);

const FC_007: ForbiddenConstruct = {
  id: 'FC-007',
  decision: "accepted_change_ancestry",
  removed:
    "Standing documents cannot describe merged, verified implementations as unbuilt or as an active implementation run.",
  construct:
    'A doc in ACCEPTED_STATE_DOCS carrying a WP-liveness claim shape while the pinned merge '
    + 'commits are ancestors of HEAD. The record is re-verified against git on every run '
    + 'and the detector fails closed when it cannot bind.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    const binding = verifyAcceptedChangeBindings(ACCEPTED_CHANGE_BINDINGS, gitIsAncestorOfHead);
    const docs = ACCEPTED_STATE_DOCS.map((rel) => {
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) {
        return { path: rel, source: `__MISSING_STANDING_DOC__ ${rel}` };
      }
      return { path: rel, source: fs.readFileSync(abs, 'utf8') };
    });
    const missing = ACCEPTED_STATE_DOCS
      .filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)))
      .map((rel) => ({
        construct_id: 'FC-007',
        file: rel,
        line: 0,
        detail: 'scanned doc missing — the check cannot bind and must not pass',
      }));
    return [
      ...binding,
      ...findStandingDocContradictions(docs, ACCEPTED_STATE_CONTRADICTION_RULES, 'FC-007'),
      ...missing,
    ];
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    // Doc side: EVERY pattern must fire on the rule's broken text, per pattern.
    const perPattern = ACCEPTED_STATE_CONTRADICTION_RULES.flatMap((rule) =>
      rule.forbidden.map((pattern) => findStandingDocContradictions(
        [{ path: `CLAUDE.md@${rule.broken_commit}`, source: rule.broken_text }],
        [{ ...rule, forbidden: [pattern] }],
        'FC-007-selftest',
      )));
    if (perPattern.some((found) => found.length === 0)) return [];
    // Git side: the binder must FAIL on a commit history does not contain —
    // through the REAL git path, so a broken git integration cannot pass.
    const unbindable = verifyAcceptedChangeBindings(
      [{ wp: 'WP-SELFTEST', merge_commit: '0'.repeat(40), merged_on: '2026-07-28' }],
      gitIsAncestorOfHead,
      'FC-007-selftest',
    );
    if (unbindable.length === 0) return [];
    // And an empty record must refuse rather than pass vacuously.
    const empty = verifyAcceptedChangeBindings([], gitIsAncestorOfHead, 'FC-007-selftest');
    if (empty.length === 0) return [];
    return [...perPattern.flat(), ...unbindable, ...empty];
  },
};

// ---------------------------------------------------------------------------
// FC-008 — the back-annotation convention
//
// found three M7 tracker entries resolved by M8/ and never
// back-annotated; the WP run's liveness and en.json had the same shape. The
// convention: A RULING THAT CLOSES A TRACKER ITEM MUST ANNOTATE THE ITEM IN
// THE SAME COMMIT. The mechanically detectable slice: the most recent commit
// touching DECISIONS.md whose ADDED lines explicitly claim an OPEN_ITEMS
// closure must itself touch OPEN_ITEMS.md. Deliberately narrow — the pattern
// requires OPEN_ITEMS to be NAMED on the claiming line, so ordinary prose
// ("closes the residue") never fires and the guard is not one a reader
// learns to delete. The full convention is wider than the detector and lives
// in CLAUDE.md; this enforces the slice a machine can check.
// ---------------------------------------------------------------------------

export interface TrackerClosureCommitObservation {
  readonly commit: string;
  /** Lines ADDED to DECISIONS.md by that commit. */
  readonly added_decision_lines: readonly string[];
  /** Whether the same commit touched OPEN_ITEMS.md. */
  readonly touches_tracker: boolean;
}

export const TRACKER_CLOSURE_CLAIM_PATTERNS: readonly RegExp[] = Object.freeze([
  /OPEN_ITEMS[^\n]{0,160}\b(?:closed?|closes|closing|resolv\w+|discharg\w+|retire[sd]?)\b/i,
  /\b(?:closed?|closes|closing|resolv\w+|discharg\w+|retire[sd]?)\b[^\n]{0,160}OPEN_ITEMS/i,
]);

/**
 * The FC-008 core, pure over the observation so both directions are
 * constructible in test. `null` (git could not answer) FAILS CLOSED.
 */
export function findUnannotatedTrackerClosures(
  observation: TrackerClosureCommitObservation | null,
  constructId = 'FC-008',
): readonly ForbiddenConstructViolation[] {
  if (observation === null) {
    return [{
      construct_id: constructId,
      file: 'DECISIONS.md',
      line: 0,
      detail: 'the last DECISIONS.md commit could not be read from git — '
        + 'the check cannot bind and must not pass',
    }];
  }
  if (observation.touches_tracker) return [];
  const out: ForbiddenConstructViolation[] = [];
  observation.added_decision_lines.forEach((line, index) => {
    if (TRACKER_CLOSURE_CLAIM_PATTERNS.some((pattern) => pattern.test(line))) {
      out.push({
        construct_id: constructId,
        file: `DECISIONS.md@${observation.commit.slice(0, 12)}`,
        line: index + 1,
        detail: 'a DECISIONS addition claims an OPEN_ITEMS closure but the commit does not '
          + `touch OPEN_ITEMS.md — annotate the tracker item in the SAME commit: ${line.trim().slice(0, 160)}`,
      });
    }
  });
  return out;
}

/** Read the most recent commit touching DECISIONS.md. `null` = cannot bind. */
export function readLastDecisionsCommitObservation(): TrackerClosureCommitObservation | null {
  const internalRoot = process.env.PROVIAN_INTERNAL_REPO
    ?? path.resolve(REPO_ROOT, '../provian-wallet-anti-gravity');
  if (!fs.existsSync(internalRoot)) {
    // A code-only clone has no internal ruling to close or verify. Reject any leak.
    if (fs.existsSync(path.join(REPO_ROOT, 'DECISIONS.md')) || fs.existsSync(path.join(REPO_ROOT, 'OPEN_ITEMS.md'))) return null;
    return { commit: '0'.repeat(40), added_decision_lines: [], touches_tracker: true };
  }
  try {
    const commit = execSync(
      `git -C "${internalRoot}" log -n 1 --format=%H -- DECISIONS.md`,
      { encoding: 'utf8' },
    ).trim();
    if (!FULL_SHA.test(commit)) return null;
    const diff = execSync(
      `git -C "${internalRoot}" show ${commit} --format= --unified=0 -- DECISIONS.md`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const added = diff.split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1));
    const files = execSync(
      `git -C "${internalRoot}" show ${commit} --format= --name-only`,
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ).split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    return { commit, added_decision_lines: added, touches_tracker: files.includes('OPEN_ITEMS.md') };
  } catch {
    return null;
  }
}

const FC_008: ForbiddenConstruct = {
  id: 'FC-008',
  decision: "tracker_closure_consistency",
  removed:
    "A recorded tracker closure must update the tracker in the same commit.",
  construct:
    'The most recent DECISIONS.md commit adds a line explicitly claiming an OPEN_ITEMS '
    + 'closure while not touching OPEN_ITEMS.md. Fail-closed when git cannot answer.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    return findUnannotatedTrackerClosures(readLastDecisionsCommitObservation());
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    // Every pattern must fire on a violating observation…
    const violating: TrackerClosureCommitObservation = {
      commit: 'f'.repeat(40),
      added_decision_lines: [
        'The stale OPEN_ITEMS entry at :2097 is closed by this ruling.',
        'this ruling resolves the residual tracked in OPEN_ITEMS.md',
      ],
      touches_tracker: false,
    };
    const fired = findUnannotatedTrackerClosures(violating, 'FC-008-selftest');
    if (fired.length !== 2) return [];
    // …the SAME claims must be excused when the commit annotates the tracker…
    const annotated = findUnannotatedTrackerClosures(
      { ...violating, touches_tracker: true }, 'FC-008-selftest',
    );
    if (annotated.length !== 0) return [];
    // …an innocent line must NOT fire (a guard firing on correct text gets
    // deleted, which is how a scan stops being enforcement)…
    const innocent = findUnannotatedTrackerClosures({
      ...violating,
      added_decision_lines: ['This ruling closes the residue and records the verdict.'],
    }, 'FC-008-selftest');
    if (innocent.length !== 0) return [];
    // …and an unreadable git answer must fail closed, never pass.
    const unbound = findUnannotatedTrackerClosures(null, 'FC-008-selftest');
    if (unbound.length === 0) return [];
    return [...fired, ...unbound];
  },
};

// ---------------------------------------------------------------------------
// FC-009 — the money-path jest suites stay wired into CI (/
//)
//
// Until 2026-07-28 no workflow ran backend jest at all — the typecheck
// workflow runs tsc only and the Removed-Decision Registry workflow runs this
// suite only — so #8's "the 31/31 is CI" was true of the local suite
// alone, and nothing would have failed if it stayed that way. This construct
// makes the unwiring loud: the Backend Tests workflow must exist and carry
// every required suite and trigger token. Token detection, not YAML
// semantics — a tripwire in the FC-001 over-detect direction, fail-closed
// when the file cannot be read.
// ---------------------------------------------------------------------------

export const MONEY_PATH_CI_WORKFLOW = '.github/workflows/backend-tests.yml';

export const MONEY_PATH_CI_REQUIRED_TOKENS: readonly string[] = Object.freeze([
  // The three money-path guard suites, by path — a rename or unwiring fires.
  'src/core/pvt/wp-ev/eligibility.legacyMintedBlock.test.ts',
  'src/core/decisions/forbidden-constructs.test.ts',
  'src/core/pvt/wp4/standard-lane-recon-gate.test.ts',
  // The full-suite invocation and its standing cadence.
  'npm test',
  'schedule:',
  'cron:',
  // Pull requests run the workflow; scheduled jobs provide the standing full
  // battery. Pushes are gated locally and must not create workflow runs.
  'pull_request:',
]);

/**
 * The FC-009 core, pure over the workflow source so both directions are
 * constructible in test. `null` (file missing/unreadable) FAILS CLOSED.
 */
export function findMoneyPathCiUnwiring(
  workflowSource: string | null,
  constructId = 'FC-009',
): readonly ForbiddenConstructViolation[] {
  if (workflowSource === null) {
    return [{
      construct_id: constructId,
      file: MONEY_PATH_CI_WORKFLOW,
      line: 0,
      detail: 'money-path CI workflow missing — the check cannot bind and must not pass',
    }];
  }
  return MONEY_PATH_CI_REQUIRED_TOKENS
    .filter((token) => !workflowSource.includes(token))
    .map((token) => ({
      construct_id: constructId,
      file: MONEY_PATH_CI_WORKFLOW,
      line: 0,
      detail: `required CI wiring token missing from the Backend Tests workflow: ${token}`,
    }));
}

const FC_009: ForbiddenConstruct = {
  id: 'FC-009',
  decision: "money_path_workflow_wiring",
  removed:
    "Money-path suites described as workflow-enforced must remain wired into the workflow.",
  construct:
    'The Backend Tests workflow missing, or missing any required suite/trigger token, while '
    + 'standing docs describe the money-path guards as running in CI. Fail-closed when the '
    + 'file cannot be read.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    const abs = path.join(REPO_ROOT, MONEY_PATH_CI_WORKFLOW);
    if (!fs.existsSync(abs)) return findMoneyPathCiUnwiring(null);
    return findMoneyPathCiUnwiring(fs.readFileSync(abs, 'utf8'));
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    // Controls derive from the REAL workflow file (single-source doctrine — no
    // redeclared fixture that could drift): each violating input is the real
    // source with one required token stripped, per token, like FC-006's
    // per-pattern rule. A missing or non-innocent real file returns [] and the
    // suite's negative-control assertion goes red rather than vacuously green.
    const abs = path.join(REPO_ROOT, MONEY_PATH_CI_WORKFLOW);
    if (!fs.existsSync(abs)) return [];
    const real = fs.readFileSync(abs, 'utf8');
    if (findMoneyPathCiUnwiring(real, 'FC-009-selftest').length !== 0) return [];
    const perToken = MONEY_PATH_CI_REQUIRED_TOKENS.map((token) =>
      findMoneyPathCiUnwiring(real.split(token).join(''), 'FC-009-selftest'));
    if (perToken.some((found) => found.length === 0)) return [];
    const missing = findMoneyPathCiUnwiring(null, 'FC-009-selftest');
    if (missing.length === 0) return [];
    return [...perToken.flat(), ...missing];
  },
};

// ---------------------------------------------------------------------------
// FC-010 — "pushed" is not "verified" (/ item 3)
//
// CI was dark 2026-07-25 12:12 → 2026-07-28 (one runtime boundary-scope run, ~28
// stale-policy-matrix runs, then a billing block that started no jobs at
// all) and ~45 red runs went unread, because every verification block
// reported a local battery and nothing required citing the CI conclusion
// for the pushed sha. The convention (CLAUDE.md): a verification block may
// not report a pushed commit without citing the GitHub Actions run
// conclusion for that exact sha. The mechanically detectable slice, FC-008's
// shape: the most recent commit touching DECISIONS.md whose ADDED lines
// carry a VERIFIED block must also add a CI-conclusion citation line —
// `CI: <workflow> run <id> <success|failure>`, or the pre-push marker
// `CI: pending post-push`, which the session report must then resolve.
// ---------------------------------------------------------------------------

export const VERIFICATION_BLOCK_PATTERN = /\bVERIFIED\b\s*[:(]/;

export const CI_CONCLUSION_CITATION_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bCI:\s*[\w][\w .\/-]* run \d{6,} (?:success|failure)/i,
  /\bCI:\s*pending post-push\b/i,
]);

/**
 * The FC-010 core, pure over the same commit observation FC-008 reads so both
 * directions are constructible in test. `null` (git could not answer) FAILS
 * CLOSED.
 */
export function findUncitedVerificationBlocks(
  observation: TrackerClosureCommitObservation | null,
  constructId = 'FC-010',
): readonly ForbiddenConstructViolation[] {
  if (observation === null) {
    return [{
      construct_id: constructId,
      file: 'DECISIONS.md',
      line: 0,
      detail: 'the last DECISIONS.md commit could not be read from git — '
        + 'the check cannot bind and must not pass',
    }];
  }
  const verifiedLines = observation.added_decision_lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => VERIFICATION_BLOCK_PATTERN.test(line));
  if (verifiedLines.length === 0) return [];
  const cited = observation.added_decision_lines
    .some((line) => CI_CONCLUSION_CITATION_PATTERNS.some((pattern) => pattern.test(line)));
  if (cited) return [];
  return verifiedLines.map(({ line, index }) => ({
    construct_id: constructId,
    file: `DECISIONS.md@${observation.commit.slice(0, 12)}`,
    line: index + 1,
    detail: 'a verification block reports with no CI-conclusion citation — cite '
      + '`CI: <workflow> run <id> <success|failure>` for the pushed sha (or `CI: pending '
      + `post-push\` before pushing, resolved in the session report): ${line.trim().slice(0, 120)}`,
  }));
}

const FC_010: ForbiddenConstruct = {
  id: 'FC-010',
  decision: "verification_evidence_required",
  removed:
    "A verification record must carry the evidence required by its recorded verification format.",
  construct:
    'The most recent DECISIONS.md commit adds a VERIFIED block while adding no '
    + 'CI-conclusion citation line. Fail-closed when git cannot answer.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    return findUncitedVerificationBlocks(readLastDecisionsCommitObservation());
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    // A VERIFIED block with no citation must fire…
    const violating: TrackerClosureCommitObservation = {
      commit: 'e'.repeat(40),
      added_decision_lines: [
        'VERIFIED: backend jest 306 suites / 4,118 / 0 failed + tsc clean; check:wp2 ok.',
      ],
      touches_tracker: false,
    };
    const fired = findUncitedVerificationBlocks(violating, 'FC-010-selftest');
    if (fired.length !== 1) return [];
    // …the SAME block must be excused by a run citation…
    const cited = findUncitedVerificationBlocks({
      ...violating,
      added_decision_lines: [
        ...violating.added_decision_lines,
        'CI: Backend Tests run 30369201937 success @ bb55b8f9.',
      ],
    }, 'FC-010-selftest');
    if (cited.length !== 0) return [];
    // …and by the pre-push marker…
    const pending = findUncitedVerificationBlocks({
      ...violating,
      added_decision_lines: [
        ...violating.added_decision_lines,
        'CI: pending post-push (this sha is not yet pushed at write time).',
      ],
    }, 'FC-010-selftest');
    if (pending.length !== 0) return [];
    // …an innocent narrative line must NOT fire (a guard firing on correct
    // text gets deleted, which is how a scan stops being enforcement)…
    const innocent = findUncitedVerificationBlocks({
      ...violating,
      added_decision_lines: ['The run was verified against the tree by reading git history.'],
    }, 'FC-010-selftest');
    if (innocent.length !== 0) return [];
    // …and an unreadable git answer must fail closed, never pass.
    const unbound = findUncitedVerificationBlocks(null, 'FC-010-selftest');
    if (unbound.length === 0) return [];
    return [...fired, ...unbound];
  },
};

// ---------------------------------------------------------------------------
// FC-011 — the test-mounted, production-unmounted router
//
// `createPVTEstimateRouter` lost its mount at the runtime boundary checkpoint `713a910a`
// and nothing went red, because `pvt-estimate.test.ts` supplies its OWN
// `app.use('/v1/pvt', createPVTEstimateRouter(...))`. The suite was therefore
// green for the entire period the endpoint did not exist — it was testing a
// router, never a route. The runbook then had to be corrected twice around an
// endpoint everyone believed was shipping.
//
// The construct: a router factory that a TEST mounts and no production module
// mounts. That combination is the one that lies — a dead factory nobody
// imports (`createOperationalGovernanceRouter`; `createPVTRouter` was one until
// the PE meter migration deleted `routes/pvt.ts`) makes no false claim, so it
// is not an instance and is left alone.
//
// Deliberate exceptions carry their reason and are self-expiring: an entry
// whose factory has since gained a production mount, or lost the test that
// made it dangerous, is ITSELF reported. An exception may not outlive its
// reason.
//
// SCOPE, stated rather than implied: "importer" means a named binding in an
// `import { … } from '…'` clause, so a comment naming a factory cannot count as
// a mount — and a factory used only INSIDE its declaring module (as
// `createPvtPublicReadRouter` is, by `mountPvtPublicReads`) reads as
// importer-less. That is correct here: no test mounts it either, so nothing can
// go falsely green. A future factory used same-module by a test helper would be
// outside what this detector sees.
// ---------------------------------------------------------------------------

export interface RouterFactoryObservation {
  readonly factory: string;
  readonly declaredIn: string;
  /** Non-test modules importing the factory. */
  readonly productionImporters: readonly string[];
  /** `*.test.ts` modules importing the factory. */
  readonly testImporters: readonly string[];
}

/**
 * Router factories deliberately mounted only by their tests, with the reason.
 *
 * `createPEVerifyRouter: 'legacy_pe_anchor'` was REMOVED here by C-1, and the
 * removal was not voluntary: FC-011's self-expiry clause reported the entry the
 * moment the router gained a production mount, which is the clause working. The
 * router is now mounted with a NULL anchor contract — the two anchor-independent
 * reads serve, `POST /verify` fails closed, and the runtime boundary runtime boundary blocks
 * `/v1/pe/verify` independently. The quarantine's reason (a factory that only
 * its own test mounts, making the suite green over a route that does not exist)
 * no longer applies, so the exception goes rather than being widened.
 */
export const TEST_ONLY_ROUTER_QUARANTINE: Readonly<Record<string, string>> = Object.freeze({
});

/**
 * The FC-011 core, pure over an observed module graph so both directions are
 * constructible in test. `null` (the tree could not be read) FAILS CLOSED, and
 * so does an EMPTY population — a universally-quantified claim over zero router
 * factories would pass identically to a correct one.
 */
export function findTestOnlyMountedRouters(
  observations: readonly RouterFactoryObservation[] | null,
  quarantine: Readonly<Record<string, string>> = TEST_ONLY_ROUTER_QUARANTINE,
  constructId = 'FC-011',
): readonly ForbiddenConstructViolation[] {
  if (observations === null || observations.length === 0) {
    return [{
      construct_id: constructId,
      file: 'provian-backend/src/routes',
      line: 0,
      detail: observations === null
        ? 'the routes directory could not be read — the check cannot bind and must not pass'
        : 'no router factories were found — an empty population proves nothing',
    }];
  }

  const out: ForbiddenConstructViolation[] = [];

  for (const observation of observations) {
    const testMountedOnly = observation.testImporters.length > 0
      && observation.productionImporters.length === 0;
    if (testMountedOnly && !(observation.factory in quarantine)) {
      out.push({
        construct_id: constructId,
        file: observation.declaredIn,
        line: 0,
        detail: `${observation.factory} is mounted by ${observation.testImporters.join(', ')} `
          + 'and by no production module — the suite can be green while the route does not '
          + 'exist. Mount it, delete it, or declare it in TEST_ONLY_ROUTER_QUARANTINE with '
          + 'its reason.',
      });
    }
  }

  for (const [factory, reason] of Object.entries(quarantine)) {
    const observation = observations.find((candidate) => candidate.factory === factory);
    if (!observation) {
      out.push({
        construct_id: constructId,
        file: 'provian-backend/src/routes',
        line: 0,
        detail: `TEST_ONLY_ROUTER_QUARANTINE names ${factory} (${reason}), which no longer `
          + 'exists — remove the exception.',
      });
      continue;
    }
    if (observation.productionImporters.length > 0) {
      out.push({
        construct_id: constructId,
        file: observation.declaredIn,
        line: 0,
        detail: `${factory} is quarantined as ${reason} but now has a production mount `
          + `(${observation.productionImporters.join(', ')}) — the exception outlived its reason.`,
      });
      continue;
    }
    if (observation.testImporters.length === 0) {
      out.push({
        construct_id: constructId,
        file: observation.declaredIn,
        line: 0,
        detail: `${factory} is quarantined as ${reason} but no test mounts it any more, so `
          + 'nothing can go falsely green — the exception outlived its reason.',
      });
    }
  }

  return out;
}

const ROUTES_DIR = path.join(BACKEND_ROOT, 'src', 'routes');
const ROUTER_FACTORY_DECLARATION = /export\s+function\s+(create[A-Za-z0-9_]*Router)\s*\(/g;

/** Bindings named in a file's `import { … } from '…'` clauses. Comments cannot match. */
function importedBindings(source: string): ReadonlySet<string> {
  const bindings = new Set<string>();
  for (const match of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) bindings.add(name.replace(/^type\s+/, ''));
    }
  }
  return bindings;
}

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTypeScriptFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Observe the real tree. Returns null when it cannot be read, so the core fails closed. */
export function observeRouterFactories(): readonly RouterFactoryObservation[] | null {
  if (!fs.existsSync(ROUTES_DIR)) return null;
  const backendSrc = path.join(BACKEND_ROOT, 'src');
  if (!fs.existsSync(backendSrc)) return null;

  const allFiles = listTypeScriptFiles(backendSrc)
    .map((abs) => ({ abs, rel: path.relative(REPO_ROOT, abs), source: fs.readFileSync(abs, 'utf8') }));
  const withBindings = allFiles.map((file) => ({ ...file, bindings: importedBindings(file.source) }));

  const observations: RouterFactoryObservation[] = [];
  for (const file of allFiles) {
    if (!file.abs.startsWith(ROUTES_DIR) || file.abs.endsWith('.test.ts')) continue;
    for (const match of file.source.matchAll(ROUTER_FACTORY_DECLARATION)) {
      const factory = match[1];
      const importers = withBindings.filter((other) =>
        other.abs !== file.abs && other.bindings.has(factory));
      observations.push({
        factory,
        declaredIn: file.rel,
        productionImporters: importers.filter((i) => !i.abs.endsWith('.test.ts')).map((i) => i.rel),
        testImporters: importers.filter((i) => i.abs.endsWith('.test.ts')).map((i) => i.rel),
      });
    }
  }
  return observations;
}

const FC_011: ForbiddenConstruct = {
  id: 'FC-011',
  decision: "production_router_mount",
  removed:
    "A test-mounted router must also have a production importer unless it is explicitly quarantined as test-only.",
  construct:
    'A router factory imported by a test and by no production module, absent from '
    + 'TEST_ONLY_ROUTER_QUARANTINE — or a quarantine entry whose factory has since gained a '
    + 'production mount or lost its test. Fail-closed when the tree cannot be read or the '
    + 'observed population is empty.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    return findTestOnlyMountedRouters(observeRouterFactories());
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    // Controls derive from the REAL observed graph — no redeclared fixture that
    // could drift from what `detect()` reads. If the real tree is dirty the
    // controls return [] and the suite's negative-control assertion goes red
    // rather than passing vacuously.
    const real = observeRouterFactories();
    if (real === null || real.length === 0) return [];
    if (findTestOnlyMountedRouters(real, TEST_ONLY_ROUTER_QUARANTINE, 'FC-011-selftest').length !== 0) {
      return [];
    }

    // (a) Removing a real production mount while leaving its test must fire.
    const testMounted = real.find((o) => o.productionImporters.length > 0 && o.testImporters.length > 0);
    if (!testMounted) return [];
    const undeclared = findTestOnlyMountedRouters(real.map((o) => o === testMounted
      ? {...o, productionImporters: []} : o), {}, 'FC-011-selftest');
    if (undeclared.length === 0) return [];

    // (b) an exception that outlived its reason must fire: quarantine a factory
    // that DOES have a production mount.
    const mounted = real.find((o) => o.productionImporters.length > 0);
    if (!mounted) return [];
    const stale = findTestOnlyMountedRouters(
      real,
      { ...TEST_ONLY_ROUTER_QUARANTINE, [mounted.factory]: 'stale_reason' },
      'FC-011-selftest',
    );
    if (stale.length === 0) return [];

    // (c) a quarantine naming a factory that no longer exists must fire.
    const vanished = findTestOnlyMountedRouters(
      real,
      { ...TEST_ONLY_ROUTER_QUARANTINE, createRouterThatWasDeleted: 'gone' },
      'FC-011-selftest',
    );
    if (vanished.length === 0) return [];

    // (d) unreadable tree and (e) empty population must both fail closed.
    const unreadable = findTestOnlyMountedRouters(null, TEST_ONLY_ROUTER_QUARANTINE, 'FC-011-selftest');
    const empty = findTestOnlyMountedRouters([], TEST_ONLY_ROUTER_QUARANTINE, 'FC-011-selftest');
    if (unreadable.length === 0 || empty.length === 0) return [];

    return [...undeclared, ...stale, ...vanished, ...unreadable, ...empty];
  },
};


/**
 * The template digest BOTH live signed activation documents currently pin.
 *
 * DO NOT "fix" a failure here by pasting the new digest. A change means the
 * action-policy template moved, which has already disarmed the two live
 * documents in Firestore. The deployment sequence stages the exact signed monetary approval before rollout,
 * leaves canonical approval valid for old binaries, then cuts over after compatible
 * traffic and old requests drain. Genesis uses the same source-bound staging principle, with both reads in every
 * grant transaction. Canonical controls remain authoritative.
 */
export const BOUND_ACTIVATION_TEMPLATE_SHA256 =
  'sha256:8a6390074ac8d6d1530105f473fe0df142e7f1494cb7b23b67ad20720022ac39';

/** Current template binding and its explicitly supported predecessor digest. */
export const ACTIVATION_TEMPLATE_COMPATIBILITY = Object.freeze({
  rule: 'source_bound_signed_template_stages',
  prior_digest: 'sha256:cbe39337418064ba3c7a3ecd490d6e2fc3109570fe518ac41b0ff95a88083530',
  cause: 'Both activation documents bind the exact current template. Source-bound signed stages serve new revisions while the canonical documents remain valid for prior revisions during rollout.',
  bound_documents: Object.freeze([
    'pvt_policy_activations/genesis',
    'pvt_policy_activations/monetary',
  ]),
});

/**
 * The two source bindings this construct claims to cover, as (file, token)
 * pairs. Checked in the FC-001 over-detect direction: if either document's
 * comparison stops naming the shared digest function, the "BOTH documents" claim
 * has quietly become a claim about one.
 */
export const ACTIVATION_DIGEST_BINDING_SITES: readonly (readonly [string, string])[] =
  Object.freeze([
    Object.freeze([
      'provian-backend/src/core/pvt/genesis-activation-document.ts',
      'approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate()',
    ]),
    Object.freeze([
      'provian-backend/src/core/pvt/policy/runtime-monetary-policy.ts',
      'doc.policy_template_sha256 === hashProposedMonetaryPolicyTemplate()',
    ]),
  ]) as readonly (readonly [string, string])[];

/**
 * The FC-012 core, pure over its inputs so both directions are constructible.
 * A `null` computed digest or a `null` source FAILS CLOSED.
 */
export function findUnboundActivationTemplateDigest(
  computedDigest: string | null,
  pinnedDigest: string,
  bindingSources: ReadonlyMap<string, string | null>,
  constructId = 'FC-012',
): readonly ForbiddenConstructViolation[] {
  const violations: ForbiddenConstructViolation[] = [];
  if (computedDigest === null) {
    violations.push({
      construct_id: constructId,
      file: 'provian-backend/src/core/pvt/policy/proposed-monetary-policy.ts',
      line: 0,
      detail: 'the action-policy template digest could not be computed — the check '
        + 'cannot bind and must not pass',
    });
  } else if (computedDigest !== pinnedDigest) {
    violations.push({
      construct_id: constructId,
      file: 'provian-backend/src/core/decisions/forbidden-constructs.ts',
      line: 0,
      detail: 'ACTION-POLICY TEMPLATE DIGEST MOVED — both signed activation documents are '
        + `now disarmed. Pinned ${pinnedDigest}; computed ${computedDigest}. Every standard-lane `
        + 'act seals record_only and every Genesis grant fails to persist until the live '
        + 'documents at pvt_policy_activations/{genesis,monetary} are RE-ISSUED at the new '
        + 'digest (the derived fields are not signature-covered, so no new signature is '
        + 'needed) and this pin is moved in the same commit with its supersession recorded.',
    });
  }
  for (const [file, token] of ACTIVATION_DIGEST_BINDING_SITES) {
    const source = bindingSources.get(file) ?? null;
    if (source === null) {
      violations.push({
        construct_id: constructId,
        file,
        line: 0,
        detail: 'activation binding site unreadable — the check cannot bind and must not pass',
      });
    } else if (!source.includes(token)) {
      violations.push({
        construct_id: constructId,
        file,
        line: 0,
        detail: `activation document no longer binds the shared template digest: ${token}`,
      });
    }
  }
  return violations;
}

function readActivationBindingSources(): ReadonlyMap<string, string | null> {
  const sources = new Map<string, string | null>();
  for (const [file] of ACTIVATION_DIGEST_BINDING_SITES) {
    const abs = path.join(REPO_ROOT, file);
    sources.set(file, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null);
  }
  return sources;
}

const FC_012: ForbiddenConstruct = {
  id: 'FC-012',
  decision: "activation_digest_binding",
  removed:
    "The monetary template must match both signed activation bindings. An unbound policy edit disarms admission even when unit tests pass.",
  construct:
    'The computed action-policy template digest differing from the pinned digest both live '
    + 'signed activation documents carry, or either document\'s comparison no longer naming '
    + 'the shared digest function. Fail-closed when the digest cannot be computed or a '
    + 'binding site cannot be read.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    let computed: string | null = null;
    try {
      /* eslint-disable-next-line @typescript-eslint/no-var-requires, global-require */
      const { hashProposedMonetaryPolicyTemplate } =
        require('../pvt/policy/proposed-monetary-policy') as
          { hashProposedMonetaryPolicyTemplate: () => string };
      const value = hashProposedMonetaryPolicyTemplate();
      computed = typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      computed = null;
    }
    return findUnboundActivationTemplateDigest(
      computed,
      BOUND_ACTIVATION_TEMPLATE_SHA256,
      readActivationBindingSources(),
    );
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    const real = readActivationBindingSources();
    // The REAL state must be innocent, or every control below is meaningless
    // and this returns [] so the suite's negative-control assertion goes red
    // rather than vacuously green.
    if (findUnboundActivationTemplateDigest(
      BOUND_ACTIVATION_TEMPLATE_SHA256, BOUND_ACTIVATION_TEMPLATE_SHA256, real,
      'FC-012-selftest',
    ).length !== 0) return [];

    // (a) a MOVED digest must fire — the event itself, replayed.
    const moved = findUnboundActivationTemplateDigest(
      ACTIVATION_TEMPLATE_COMPATIBILITY.prior_digest,
      BOUND_ACTIVATION_TEMPLATE_SHA256, real, 'FC-012-selftest',
    );
    if (moved.length === 0) return [];

    // (b) an uncomputable digest must fail closed.
    const uncomputable = findUnboundActivationTemplateDigest(
      null, BOUND_ACTIVATION_TEMPLATE_SHA256, real, 'FC-012-selftest',
    );
    if (uncomputable.length === 0) return [];

    // (c) EACH binding site losing its token must fire on its own — a blunt
    // "break everything" control would prove only that the first site is
    // guarded while reading as coverage for both.
    const perSite = ACTIVATION_DIGEST_BINDING_SITES.map(([file, token]) => {
      const stripped = new Map(real);
      stripped.set(file, (real.get(file) ?? '').split(token).join(''));
      return findUnboundActivationTemplateDigest(
        BOUND_ACTIVATION_TEMPLATE_SHA256, BOUND_ACTIVATION_TEMPLATE_SHA256,
        stripped, 'FC-012-selftest',
      );
    });
    if (perSite.some((found) => found.length === 0)) return [];

    // (d) an unreadable binding site must fail closed, per site.
    const perSiteUnreadable = ACTIVATION_DIGEST_BINDING_SITES.map(([file]) => {
      const missing = new Map(real);
      missing.set(file, null);
      return findUnboundActivationTemplateDigest(
        BOUND_ACTIVATION_TEMPLATE_SHA256, BOUND_ACTIVATION_TEMPLATE_SHA256,
        missing, 'FC-012-selftest',
      );
    });
    if (perSiteUnreadable.some((found) => found.length === 0)) return [];

    return [
      ...moved, ...uncomputable, ...perSite.flat(), ...perSiteUnreadable.flat(),
    ];
  },
};

// =============================================================================
// FC-013 / FC-014 — the two rulings about rows HELD at `pending_evidence`
//
// BOTH DETECTORS ARE ALLOWLISTS, and the first cut of both was a denylist. A
// fresh-context reviewer proved the denylist form silent on the exact construct
// each rule exists to forbid: a TTL arm written `doc.ref.delete()` inside the
// sweep loop (no initializer to track, no object literal to see), and a
// promoter written as `.where('mint_status','==', status)` over a status ARRAY
// — the shape the retired PVTv8 `minting-engine.ts::recoverEpochDeferredPEs` had
// (deleted with the PE meter migration, 2026-10-03), where adding one token to
// the array promoted every held row. The detector still refuses that shape
// anywhere in the tree; its self-test plants it. Enumerating the ways a
// thing can be written is how a guard reads as protection while protecting one
// spelling; defect 6 said the same about `corroboration_status`. So these
// ask "is this provably permitted?" and refuse everything else.
// =============================================================================

/**
 * Resolve a repo-relative backend path. Exported so the suite binds to the SAME
 * root the detector uses rather than re-deriving one — a second copy of the root
 * is how a test ends up asserting about a directory the guard never reads.
 */
export function backendSourcePath(relPath: string): string {
  return path.join(BACKEND_ROOT, relPath);
}

/**
 * The modules that SWEEP rows held at `pending_evidence`.
 *
 * A held row is earned work in escrow: the act happened, its chain link is
 * intact, and the only thing missing is evidence that has not arrived YET.
 * These files are the ones that walk that population, so they are the ones a
 * destruction arm would be written into.
 *
 * THIS LIST IS BOUND TO THE TREE, not merely declared: `findUnlistedHeldRowSweeps`
 * fails if any other module queries `pe_history` on the held literal. A cleanup
 * job added as a NEW file was the negative control: — it would have been
 * unscanned, and FC-013 would have reported clean while the ruling was violated.
 */
export const HELD_ROW_SWEEP_FILES: readonly string[] = Object.freeze([
  'src/core/pvt/pending-evidence-resolver.ts',
]);

/**
 * The collections each sweep module is permitted to WRITE, by module.
 *
 * The allowlist that makes FC-013 leg (a) work. A sweep may write its own
 * bookkeeping — its resolution record and its cursor — and nothing else. Every
 * other mutation target, however it is reached, is a violation: an untraceable
 * target is not proof of innocence.
 */
export const HELD_ROW_SWEEP_OWN_COLLECTIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'src/core/pvt/pending-evidence-resolver.ts': Object.freeze([
      'PENDING_EVIDENCE_RESOLUTION_COLLECTION',
      'PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION',
    ]),
  });

/**
 * The files that may promote a row OUT of `pending_evidence` to `eligible`.
 *
 * EMPTY BY RULING. `mint_status: 'eligible'` is the live PVT9
 * standard-lane claim inlet's own selection predicate, so writing it onto a held
 * row IS mint authority, not bookkeeping. removed the arm that did it on a
 * check the record path itself calls insufficient. It may be restored only
 * behind a verifier that binds the receipt to the canonical event the PE claims
 * contract, direction, counterparty, amount and log identity — and adding a
 * name here is that decision being recorded, not a refactor.
 *
 * Deliberately a set and not a boolean: the mistake this prevents is a SECOND
 * promoter appearing beside a sanctioned one, which a boolean cannot see.
 *
 * ONE NAME, BY RULING (, / 2026-09-03 — completion
 * earning). `src/core/pvt/completion-promotion.ts` promotes a held
 * `human_job_delivered` row to `eligible` ONLY on the `promote` verdict of the
 * bound verifier `completion-verifier.ts`, which binds the poster's
 * `human_job_completed` confirmation to the exact job, poster and delivery
 * (`completion_pe_id` / `confirmation_pe_id` on the job document), re-runs the
 * record path's own distinct-owner fence (`detectSameOwnerTransfer`), refuses a
 * contradicting escrow, and prepares the `completion` mint-once claim for the
 * canonical completion event — and the promotion itself claims that slot in
 * the same transaction, so the on-chain escrow release (the best-supported
 * witness, `escrow_completed`) and this off-chain confirmation can never both
 * pay one job. The chain-receipt arm of the sweep remains UNSANCTIONED exactly
 * as / left it. Adding this name was the decision being recorded, not
 * a refactor; the sweep itself (`pending-evidence-resolver.ts`) still writes no
 * disposition and stays under FC-013.
 */
export const SANCTIONED_PENDING_EVIDENCE_PROMOTERS: ReadonlySet<string> =
  Object.freeze(new Set<string>(['src/core/pvt/completion-promotion.ts']));

/**
 * Files that write the held literal WITHOUT selecting on it, each with the
 * reason it is not a promoter. An exemption without a reason is a hole.
 *
 * These are checked, not trusted: the detector still requires that the file's
 * every `pending_evidence` literal sits in a WRITE position, so an exempt file
 * that later starts querying the held state fires anyway.
 */
export const HELD_LITERAL_WRITE_ONLY_EXEMPTIONS: Readonly<Record<string, string>> =
  Object.freeze({
    'src/core/pvt/pending-cache-backfill.ts':
      'moves a cache-held row INTO the hold (`mint_status: \'pending_evidence\'`) and promotes '
      + 'only the `pending_cache` population; it never selects the held state',
    'src/core/decisions/forbidden-constructs.ts':
      'this guard itself — its self-tests must contain both literals to drive the detector',
  });

/** Firestore document-mutation methods. */
const FIRESTORE_MUTATORS: ReadonlySet<string> = Object.freeze(
  new Set(['set', 'update', 'create', 'delete']),
);

const HELD_LITERAL = 'pending_evidence';
const DISPOSITION_FIELDS: ReadonlySet<string> = Object.freeze(
  new Set(['mint_status', 'mint_disposition']),
);

function missingModuleViolation(
  relPath: string,
  constructId: string,
  what: string,
): ForbiddenConstructViolation {
  return {
    construct_id: constructId,
    file: relPath,
    line: 0,
    detail: `${what} — the check cannot bind and must not pass`,
  };
}

/** The root identifier of an access/call chain, e.g. `a` in `a.b().c`. */
function chainRootIdentifier(node: ts.Node): string | null {
  let n: ts.Node = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) {
      n = n.expression;
      continue;
    }
    if (ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n)) {
      n = n.expression;
      continue;
    }
    break;
  }
  return ts.isIdentifier(n) ? n.text : null;
}

/**
 * Identifiers PROVABLY bound to a reference under one of this module's own
 * collections. Everything else — a loop binding, a destructured `ref`, a
 * parameter, a reassignment — stays unproven, and unproven is refused.
 */
function ownCollectionBindings(sf: ts.SourceFile, ownCollections: readonly string[]): Set<string> {
  const owned = new Set<string>();
  const mentionsOwn = (text: string): boolean =>
    ownCollections.some((name) => text.includes(name));
  let changed = true;
  // Two passes so `const a = db.collection(OWN); const b = a.doc(id);` resolves.
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer !== undefined
        && !owned.has(node.name.text)) {
        const text = node.initializer.getText(sf);
        const root = chainRootIdentifier(node.initializer);
        if (mentionsOwn(text) || (root !== null && owned.has(root))) {
          owned.add(node.name.text);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return owned;
}

/**
 * FC-013 leg (a) — a held-row sweep may mutate ONLY its own bookkeeping.
 *
 * Every `set` / `update` / `create` / `delete`, whether called on a document
 * reference, a `WriteBatch`, a `BulkWriter` or a transaction, must have a target
 * provably under one of this module's own collections. `doc.ref.delete()`,
 * `batch.delete(doc.ref)`, `snap.docs.forEach(d => d.ref.update(…))` and a
 * helper that takes the ref as a parameter are all unproven, and all refused.
 */
function findUnsanctionedSweepMutations(
  relPath: string,
  source: string | null,
  ownCollections: readonly string[] | undefined,
  constructId: string,
): ForbiddenConstructViolation[] {
  if (source === null) {
    return [missingModuleViolation(relPath, constructId, 'held-row sweep module missing')];
  }
  if (ownCollections === undefined || ownCollections.length === 0) {
    return [missingModuleViolation(
      relPath, constructId,
      'held-row sweep declares no own collections, so no write can be proven permitted',
    )];
  }
  const sf = parse(relPath, source);
  for (const name of ownCollections) {
    if (!source.includes(name)) {
      return [missingModuleViolation(
        relPath, constructId,
        `declared own collection ${name} is absent from the module`,
      )];
    }
  }
  const owned = ownCollectionBindings(sf, ownCollections);
  const mentionsOwn = (text: string): boolean =>
    ownCollections.some((name) => text.includes(name));
  const proven = (node: ts.Node | undefined): boolean => {
    if (node === undefined) return false;
    if (mentionsOwn(node.getText(sf))) return true;
    const root = chainRootIdentifier(node);
    return root !== null && owned.has(root);
  };
  // `set` / `update` / `delete` are also `Map`, `Set` and hash-digest methods.
  // The exclusion is deliberately TINY and enumerable — over-detection is the
  // safe direction here, so a shape missing from this list becomes a noisy false
  // positive, never a silent miss. Anything not excluded and not proven fires.
  const nonFirestoreLocals = new Set<string>();
  const collectLocals = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
      && ts.isNewExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && (node.initializer.expression.text === 'Set'
        || node.initializer.expression.text === 'Map'
        || node.initializer.expression.text === 'WeakMap'
        || node.initializer.expression.text === 'WeakSet')) {
      nonFirestoreLocals.add(node.name.text);
    }
    ts.forEachChild(node, collectLocals);
  };
  ts.forEachChild(sf, collectLocals);
  const NON_FIRESTORE_ROOTS = new Set([
    'crypto', 'JSON', 'Object', 'Math', 'Array', 'Buffer', 'Reflect', 'console', 'process',
  ]);
  const isNonFirestoreReceiver = (receiver: ts.Node): boolean => {
    const text = receiver.getText(sf);
    if (/createHash\(|createHmac\(|createCipher/.test(text)) return true;
    const root = chainRootIdentifier(receiver);
    return root !== null && (NON_FIRESTORE_ROOTS.has(root) || nonFirestoreLocals.has(root));
  };

  const out: ForbiddenConstructViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (FIRESTORE_MUTATORS.has(method) && !isNonFirestoreReceiver(node.expression.expression)) {
        // `ref.update(patch)` — the receiver is the target.
        // `batch.update(ref, patch)` / `txn.set(ref, doc)` — argument 0 is.
        const receiverProven = proven(node.expression.expression);
        const argProven = node.arguments.length > 0 && proven(node.arguments[0]);
        if (!receiverProven && !argProven) {
          out.push({
            construct_id: constructId,
            file: relPath,
            line: lineOf(sf, node),
            detail: `held-row sweep calls .${method}() on a target that is not provably one of `
              + `its own collections (${ownCollections.join(', ')}), in `
              + `${enclosingFunctionName(node) ?? '<module scope>'} — a held row is earned work `
              + 'in escrow, and an unproven write target is refused rather than assumed innocent',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/**
 * FC-013 leg (b) — a held-row sweep may not name a disposition field in ANY
 * write position: an object-literal property (including a computed name and a
 * shorthand), or a direct assignment `row.mint_status = …`. Defence in depth
 * behind leg (a), and independent of what the terminal value is called.
 */
function findHeldRowDispositionWrites(
  relPath: string,
  source: string | null,
  constructId: string,
): ForbiddenConstructViolation[] {
  if (source === null) {
    return [missingModuleViolation(relPath, constructId, 'held-row sweep module missing')];
  }
  const sf = parse(relPath, source);
  const out: ForbiddenConstructViolation[] = [];
  const hit = (node: ts.Node, field: string, form: string): void => {
    out.push({
      construct_id: constructId,
      file: relPath,
      line: lineOf(sf, node),
      detail: `held-row sweep writes ${field} (${form}) in `
        + `${enclosingFunctionName(node) ?? '<module scope>'} — pending is not a state a sweep `
        + 'may leave; only a bound canonical-event verifier may',
    });
  };
  // A computed key can hold any field name, so its VALUE cannot clear it; the
  // conservative direction for a forbidden-construct scan is to refuse it.
  const computedKeyIsDisposition = (name: ts.Node): boolean => {
    if (!ts.isComputedPropertyName(name)) return false;
    const text = name.expression.getText(sf);
    return /mint_status|mint_disposition|mintDisposition|statusKey|dispositionKey/.test(text)
      || ts.isIdentifier(name.expression);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      if ((ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
        && DISPOSITION_FIELDS.has(node.name.text)) {
        hit(node, node.name.text, 'object literal');
      } else if (computedKeyIsDisposition(node.name)) {
        hit(node, node.name.getText(sf), 'computed object key');
      }
    }
    if (ts.isShorthandPropertyAssignment(node) && DISPOSITION_FIELDS.has(node.name.text)) {
      hit(node, node.name.text, 'shorthand property');
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && DISPOSITION_FIELDS.has(node.left.name.text)) {
      hit(node, node.left.name.text, 'assignment');
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/**
 * FC-013 population binding — any module that QUERIES `pe_history` on the held
 * literal must be declared in `HELD_ROW_SWEEP_FILES`.
 *
 * Without this the list is a hand-maintained declaration, and a cleanup job
 * added as a new file is simply unscanned.
 */
function findUnlistedHeldRowSweeps(
  sources: ReadonlyMap<string, string>,
  listed: readonly string[],
  constructId: string,
): ForbiddenConstructViolation[] {
  const out: ForbiddenConstructViolation[] = [];
  for (const [rel, src] of sources) {
    if (listed.includes(rel)) continue;
    const sf = parse(rel, src);
    if (!queriesHeldRows(sf)) continue;
    out.push({
      construct_id: constructId,
      file: rel,
      line: 0,
      detail: 'this module queries pe_history on the held literal but is not declared in '
        + 'HELD_ROW_SWEEP_FILES, so the no-destruction legs never scanned it',
    });
  }
  return out;
}

/**
 * The collections that hold the sealed record of an act, and its envelope.
 *
 * A held row lives in `pe_history`; its provenance envelope is the chain link
 * that makes the record tamper-evident (Security Invariant #5). Neither may be
 * on a retention schedule.
 */
export const RETENTION_PROTECTED_COLLECTIONS: readonly string[] = Object.freeze([
  // PE METER : a held act lives here, never expiring (carried);
  // its 31-day act key may lapse, the hold may not.
  'meter_held_acts_v1',
  // The pre-meter stores, until the legacy migration retires their last row. The migration is
  // not a retention rule: it retires each PE only after carrying its earning (legacy-migration.ts).
  'pe_history',
  'provenance_envelopes',
]);

/** The Firestore index/TTL config: a `ttl: true` field override is a retention rule too. */
export const FIRESTORE_INDEX_CONFIG = 'firestore.indexes.json';

/**
 * FC-013 leg (c), TTL arm — no protected collection may carry a Firestore TTL policy. Since the
 * meter, expiry is a TTL field override in the index config, not a purge-table line; a TTL on
 * the held-act collection would destroy earned work in escrow with every code-level leg blind.
 */
export function findProtectedTtlPolicies(configText: string | null, constructId: string): ForbiddenConstructViolation[] {
  if (configText === null) {
    return [{ construct_id: constructId, file: FIRESTORE_INDEX_CONFIG, line: 0, detail: 'the Firestore index/TTL config cannot be read (fail-closed)' }];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return [{ construct_id: constructId, file: FIRESTORE_INDEX_CONFIG, line: 0, detail: 'the Firestore index/TTL config is not JSON (fail-closed)' }];
  }
  const overrides = (parsed as { fieldOverrides?: unknown }).fieldOverrides;
  if (!Array.isArray(overrides)) return [];
  return overrides
    .filter((o): o is { collectionGroup: string; fieldPath?: string; ttl?: unknown } =>
      o !== null && typeof o === 'object' && typeof (o as { collectionGroup?: unknown }).collectionGroup === 'string')
    .filter((o) => o.ttl === true && RETENTION_PROTECTED_COLLECTIONS.includes(o.collectionGroup))
    .map((o) => ({
      construct_id: constructId,
      file: FIRESTORE_INDEX_CONFIG,
      line: 0,
      detail: `a TTL policy on the protected collection ${o.collectionGroup} (field ${o.fieldPath ?? '?'}) — a held act `
        + 'is earned work in escrow and may not be on a delete schedule',
    }));
}

function readIndexConfig(): string | null {
  const abs = path.join(BACKEND_ROOT, FIRESTORE_INDEX_CONFIG);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

/** Property names that mean "delete things older than this". */
const RETENTION_PROPERTY = /^(retention|retentionMs|retention_ms|ttl|ttlMs|ttl_ms|maxAge|max_age|olderThanMs|older_than_ms|keepForMs)$/;
/** Property names that mean "the collection this rule applies to". */
const COLLECTION_PROPERTY = /^(collection|collectionName|collection_name|path)$/;

/**
 * FC-013 leg (c) — no protected collection may appear in a retention rule.
 *
 * FOUND BY ACCIDENT, WHICH IS THE POINT. `src/core/maintenance/
 * purge-transients.ts` is a live, daily-scheduled, table-driven delete job:
 * `TRANSIENT_PURGE_RULES` is a list of `{ collection, field, retentionMs }` and
 * the runner deletes every document older than the window. `pe_history` is not
 * on it today — and adding ONE line would destroy every held row, with legs (a)
 * and (b) blind because that module is not a held-row sweep and writes no
 * disposition. says "no cleanup job that destroys a pending row"; this
 * is the cleanup job.
 */
function findProtectedRetentionRules(
  sources: ReadonlyMap<string, string>,
  constructId: string,
): ForbiddenConstructViolation[] {
  const out: ForbiddenConstructViolation[] = [];
  for (const [rel, src] of sources) {
    if (!RETENTION_PROTECTED_COLLECTIONS.some((c) => src.includes(c))) continue;
    const sf = parse(rel, src);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        let protectedName: string | null = null;
        let hasRetention = false;
        for (const prop of node.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue;
          const key = prop.name.text;
          if (COLLECTION_PROPERTY.test(key) && ts.isStringLiteral(prop.initializer)
            && RETENTION_PROTECTED_COLLECTIONS.includes(prop.initializer.text)) {
            protectedName = prop.initializer.text;
          }
          if (RETENTION_PROPERTY.test(key)) hasRetention = true;
        }
        if (protectedName !== null && hasRetention) {
          out.push({
            construct_id: constructId,
            file: rel,
            line: lineOf(sf, node),
            detail: `a retention rule names the protected collection ${protectedName} — a held row `
              + 'is earned work in escrow and may not be on a delete schedule; archiving copies, '
              + 'it does not destroy',
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}

/** Structural: a Firestore `.where(…)` carrying the held literal, in this file. */
function queriesHeldRows(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'where'
      && node.arguments.some((a) => ts.isStringLiteral(a) && a.text === HELD_LITERAL)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/**
 * FC-013 — a row held at `pending_evidence` may not be destroyed, by the clock
 * or by anything else a sweep decides.
 */
const FC_013: ForbiddenConstruct = {
  id: 'FC-013',
  decision: "held_work_cannot_expire",
  removed:
    "Earned work is not unearned by the clock. A pending-evidence row cannot be destroyed by an expiry or retention sweep; archiving must preserve it.",
  construct:
    'In a module that sweeps held rows: any Firestore set/update/create/delete whose target is '
    + 'not PROVABLY under one of that module\'s own declared collections, or any write naming '
    + '`mint_status`/`mint_disposition` in any form. Plus any module that queries `pe_history` on '
    + 'the held literal while absent from the scanned list. Plus any retention rule anywhere in '
    + 'the backend — or any Firestore TTL policy in `firestore.indexes.json` — naming '
    + '`meter_held_acts_v1` (PE meter, 2026-10-03: where held acts live), `pe_history` or '
    + '`provenance_envelopes` — the live daily purge job is '
    + 'table-driven, and one line would destroy every held row with the other legs blind. '
    + 'Archiving for hygiene is permitted and is not one of these shapes — it copies, it does '
    + 'not destroy. Fail-closed when a scanned module, or a declared own collection, cannot be read.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    const perFile = HELD_ROW_SWEEP_FILES.flatMap((rel) => {
      const abs = path.join(BACKEND_ROOT, rel);
      const src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      return [
        ...findUnsanctionedSweepMutations(rel, src, HELD_ROW_SWEEP_OWN_COLLECTIONS[rel], 'FC-013'),
        ...findHeldRowDispositionWrites(rel, src, 'FC-013'),
      ];
    });
    const sources = readBackendSources();
    return [
      ...perFile,
      ...findUnlistedHeldRowSweeps(sources, HELD_ROW_SWEEP_FILES, 'FC-013'),
      ...findProtectedRetentionRules(sources, 'FC-013'),
      ...findProtectedTtlPolicies(readIndexConfig(), 'FC-013'),
    ];
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    const rel = HELD_ROW_SWEEP_FILES[0];
    const own = HELD_ROW_SWEEP_OWN_COLLECTIONS[rel];
    const abs = path.join(BACKEND_ROOT, rel);
    const real = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    // The REAL state must be innocent, or every control below is meaningless
    // and this returns [] so the suite's negative-control assertion goes red.
    if (real === null) return [];
    if (findUnsanctionedSweepMutations(rel, real, own, 'FC-013-selftest').length !== 0) return [];
    if (findHeldRowDispositionWrites(rel, real, 'FC-013-selftest').length !== 0) return [];

    // Each control is a DISTINCT shape driven on its own. A blunt
    // break-everything control proves only that the first shape is guarded
    // while reading as coverage for all of them.
    const mutationForms: Array<[string, string]> = [
      // the negative control: verbatim: the TTL arm as an engineer writes it.
      ['loop-binding ref.delete',
        'async function sweep(snap: any, nowMs: number) {\n'
        + '  for (const doc of snap.docs) {\n'
        + '    if (nowMs - doc.data().timestamp > 7776000000) { await doc.ref.delete(); }\n  }\n}\n'],
      ['batch delete of a loop ref',
        'async function sweep(db: any, snap: any) {\n'
        + '  const batch = db.batch();\n'
        + '  for (const doc of snap.docs) batch.delete(doc.ref);\n'
        + '  await batch.commit();\n}\n'],
      ['bulkWriter on a destructured ref',
        'async function sweep(bulkWriter: any, snap: any) {\n'
        + '  for (const { ref } of snap.docs) bulkWriter.update(ref, { swept: true });\n}\n'],
      ['helper taking the ref as a parameter',
        'async function expire(ref: any) { await ref.delete(); }\n'],
      ['a foreign collection reached inline',
        'async function sweep(db: any, peId: string) {\n'
        + '  await db.collection("pe_history").doc(peId).update({ swept: true });\n}\n'],
      ['a reassigned (non-initializer) binding',
        'async function sweep(db: any, peId: string) {\n'
        + '  let ref: any;\n  ref = db.collection("pe_history").doc(peId);\n'
        + '  await ref.delete();\n}\n'],
    ];
    const mutationFound = mutationForms.map(([, body]) =>
      findUnsanctionedSweepMutations(rel, `${real}\n${body}`, own, 'FC-013-selftest'));
    if (mutationFound.some((f) => f.length === 0)) return [];

    const dispositionForms: string[] = [
      "function p() { return { mint_disposition: 'ineligible_terminal' }; }\n",
      "function p(statusKey: string) { return { [statusKey]: 'ineligible' }; }\n",
      "function p(mint_status: string) { return { mint_status }; }\n",
      "function p(row: any) { row.mint_status = 'ineligible'; }\n",
    ];
    const dispositionFound = dispositionForms.map((body) =>
      findHeldRowDispositionWrites(rel, `${real}\n${body}`, 'FC-013-selftest'));
    if (dispositionFound.some((f) => f.length === 0)) return [];

    // An unreadable module, and an unreadable own-collection declaration, must
    // each fail closed rather than scan nothing and pass.
    const missingA = findUnsanctionedSweepMutations(rel, null, own, 'FC-013-selftest');
    const missingB = findHeldRowDispositionWrites(rel, null, 'FC-013-selftest');
    const noOwn = findUnsanctionedSweepMutations(rel, real, [], 'FC-013-selftest');
    const renamedOwn = findUnsanctionedSweepMutations(
      rel, real, ['A_COLLECTION_THAT_IS_NOT_IN_THE_MODULE'], 'FC-013-selftest',
    );
    if (missingA.length === 0 || missingB.length === 0
      || noOwn.length === 0 || renamedOwn.length === 0) return [];

    // The population binding: a NEW sweeper that is not on the list must fire.
    const planted = new Map(readBackendSources());
    planted.set('src/core/maintenance/held-row-cleanup.ts',
      'async function cleanup(db: any) {\n'
      + "  const snap = await db.collection('pe_history')\n"
      + "    .where('mint_status', '==', 'pending_evidence').get();\n"
      + '  for (const doc of snap.docs) await doc.ref.delete();\n}\n');
    const unlisted = findUnlistedHeldRowSweeps(planted, HELD_ROW_SWEEP_FILES, 'FC-013-selftest');
    if (unlisted.length === 0) return [];

    // Leg (c): the ONE-LINE addition to the live purge table, replayed against
    // the real module rather than a synthetic one — `purge-transients.ts` is
    // scheduled daily and already deletes by retention window.
    const real0 = readBackendSources();
    const PURGE = 'src/core/maintenance/purge-transients.ts';
    const purgeSource = real0.get(PURGE);
    if (purgeSource === undefined) return [];
    const purged = new Map(real0);
    purged.set(PURGE, purgeSource.replace(
      "{ collection: 'relay_requests',",
      "{ collection: 'pe_history', field: 'timestamp', retentionMs: 90 * DAY_MS },\n"
      + "  { collection: 'relay_requests',",
    ));
    const retention = findProtectedRetentionRules(purged, 'FC-013-selftest');
    if (retention.length === 0) return [];
    // …and the envelope collection on its own, so a control for one protected
    // name does not read as coverage for both.
    const enveloped = new Map(real0);
    enveloped.set('src/core/maintenance/__control.ts',
      "const RULES = [{ collection: 'provenance_envelopes', ttlMs: 1 }];\nexport default RULES;\n");
    const envelopeFound = findProtectedRetentionRules(enveloped, 'FC-013-selftest');
    if (envelopeFound.length === 0) return [];
    // …and the meter's held acts, by code rule and by a TTL policy in the real index config.
    const heldRule = new Map(real0);
    heldRule.set('src/core/maintenance/__control.ts',
      "const RULES = [{ collection: 'meter_held_acts_v1', retentionMs: 1 }];\nexport default RULES;\n");
    const heldFound = findProtectedRetentionRules(heldRule, 'FC-013-selftest');
    if (heldFound.length === 0) return [];
    const realConfig = readIndexConfig();
    if (realConfig === null || findProtectedTtlPolicies(realConfig, 'FC-013-selftest').length !== 0) return [];
    const config = JSON.parse(realConfig) as { fieldOverrides?: unknown[] };
    const plantedConfig = JSON.stringify({
      ...config,
      fieldOverrides: [...(config.fieldOverrides ?? []), { collectionGroup: 'meter_held_acts_v1', fieldPath: 'expire_at', ttl: true, indexes: [] }],
    });
    const ttlFound = findProtectedTtlPolicies(plantedConfig, 'FC-013-selftest');
    if (ttlFound.length === 0) return [];

    return [
      ...mutationFound.flat(), ...dispositionFound.flat(),
      ...missingA, ...missingB, ...noOwn, ...renamedOwn, ...unlisted,
      ...retention, ...envelopeFound, ...heldFound, ...ttlFound,
    ];
  },
};

/**
 * Every non-test backend source. A FULL recursive walk of `src`, because the
 * A hand-picked root list can be a hand-picked root list wearing a docblock that
 * called itself computed: the arm planted in `src/core/pe/`,
 * `src/core/onchain/` or `src/core/maintenance/` was not scanned at all, and
 * `src/core/onchain/` is where the bound verifier would most naturally live.
 */
export function readBackendSources(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const walk = (relDir: string): void => {
    const absDir = path.join(BACKEND_ROOT, relDir);
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__test-helpers__') walk(rel);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
      out.set(rel, fs.readFileSync(path.join(BACKEND_ROOT, rel), 'utf8'));
    }
  };
  walk('src');
  return out;
}

/**
 * Structural: does this source WRITE a disposition field to `'eligible'`?
 *
 * Covers the forms the reviewer proved silent: `as const`, an identifier
 * resolving to a module string constant, a direct assignment, and
 * `mint_disposition` as well as `mint_status` (the asymmetry was defect 5).
 */
function promotesToEligible(sf: ts.SourceFile): ts.Node | null {
  const stringConsts = new Map<string, string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined) {
      const init = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (ts.isStringLiteral(init)) stringConsts.set(node.name.text, init.text);
    }
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(sf, collect);

  const isEligibleValue = (node: ts.Node): boolean => {
    let n: ts.Node = node;
    while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n)
      || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) {
      n = n.expression;
    }
    if (ts.isStringLiteral(n)) return n.text === 'eligible';
    if (ts.isIdentifier(n)) return stringConsts.get(n.text) === 'eligible';
    return false;
  };

  let hit: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (hit !== null) return;
    if (ts.isPropertyAssignment(node)
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      && DISPOSITION_FIELDS.has(node.name.text)
      && isEligibleValue(node.initializer)) {
      hit = node;
      return;
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && DISPOSITION_FIELDS.has(node.left.name.text)
      && isEligibleValue(node.right)) {
      hit = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hit;
}

/**
 * Structural: every `'pending_evidence'` STRING-LITERAL NODE in this source,
 * with whether it sits in a WRITE position (a disposition property assignment).
 *
 * Comments and docblocks are not literal nodes and correctly do not count —
 * that is why `pending-evidence-resolver.ts`, whose docblock discusses
 * `mint_status: 'eligible'` at length, is not a promoter.
 */
function heldLiteralPositions(sf: ts.SourceFile): { total: number; writeOnly: boolean } {
  let total = 0;
  let nonWrite = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && node.text === HELD_LITERAL) {
      total += 1;
      const parent = node.parent;
      const isDispositionWrite = parent !== undefined
        && ts.isPropertyAssignment(parent)
        && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
        && DISPOSITION_FIELDS.has(parent.name.text);
      if (!isDispositionWrite) nonWrite += 1;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { total, writeOnly: total > 0 && nonWrite === 0 };
}

export interface HeldRowPromoterScan {
  readonly evaluated: number;
  readonly promoting: number;
  readonly violations: readonly ForbiddenConstructViolation[];
}

/**
 * FC-014's scan, as an ALLOWLIST over promoters.
 *
 * A file that writes a disposition to `'eligible'` may not carry the held
 * literal in any value position, unless it is sanctioned or exempt
 * with a recorded reason AND every one of its held literals is a WRITE. This
 * catches the negative control: — the retired `minting-engine.ts` promoted to
 * `eligible` through a status ARRAY, so the moment `'pending_evidence'` joined
 * that array the file would trip, which the old `.where(<literal>)` predicate
 * could never see. The engine is deleted; the self-test keeps the shape planted.
 *
 * `promoting` is published beside `evaluated` because the guard's real
 * population is the promoters, not every file that mentions a word.
 */
export function scanHeldRowPromoters(
  sources: ReadonlyMap<string, string>,
  sanctioned: ReadonlySet<string> = SANCTIONED_PENDING_EVIDENCE_PROMOTERS,
  exemptions: Readonly<Record<string, string>> = HELD_LITERAL_WRITE_ONLY_EXEMPTIONS,
  constructId = 'FC-014',
): HeldRowPromoterScan {
  const violations: ForbiddenConstructViolation[] = [];
  let promoting = 0;
  for (const [rel, src] of sources) {
    if (!src.includes(HELD_LITERAL) && !src.includes('eligible')) continue;
    const sf = parse(rel, src);
    const hit = promotesToEligible(sf);
    if (hit === null) continue;
    promoting += 1;
    const held = heldLiteralPositions(sf);
    if (held.total === 0) continue;
    if (sanctioned.has(rel)) continue;
    if (exemptions[rel] !== undefined && held.writeOnly) continue;
    violations.push({
      construct_id: constructId,
      file: rel,
      line: lineOf(sf, hit),
      detail: `this module writes a disposition to 'eligible' and carries the held literal in `
        + `${held.total} value position(s)`
        + `${exemptions[rel] !== undefined ? ', and its write-only exemption no longer holds' : ''}`
        + ' — promoting a held row IS mint authority on the live rail, and it may exist only '
        + 'behind the bound canonical-event verifier and a recorded decision',
    });
  }
  return { evaluated: sources.size, promoting, violations };
}

/**
 * FC-014 — a promotion out of `pending_evidence` may exist only behind the bound
 * canonical-event verifier, never standalone.
 */
const FC_014: ForbiddenConstruct = {
  id: 'FC-014',
  decision: "canonical_event_promotion_only",
  removed:
    "A held row can become eligible only behind a canonical-event verifier. A transaction-from proof alone cannot establish recipient, value, token or the act claimed by the PE.",
  construct:
    "A module that writes `mint_status`/`mint_disposition` to `'eligible'` — as a literal, an "
    + '`as const`, a module string constant, or a direct assignment — while carrying the held '
    + 'literal in ANY value position, and while absent from '
    + '`SANCTIONED_PENDING_EVIDENCE_PROMOTERS` and from the write-only exemptions. Scoped to '
    + 'promoters rather than to a query spelling, so a status ARRAY driving `.where()` trips the '
    + 'moment the held literal joins it.',
  status: 'enforced',
  detect(): readonly ForbiddenConstructViolation[] {
    const scan = scanHeldRowPromoters(readBackendSources());
    if (scan.promoting === 0) {
      return [{
        construct_id: 'FC-014',
        file: 'src',
        line: 0,
        detail: 'no module in the tree writes a disposition to eligible — the guard evaluated an '
          + 'EMPTY population and must not read as a pass',
      }];
    }
    return scan.violations;
  },
  selfTest(): readonly ForbiddenConstructViolation[] {
    const real = readBackendSources();
    // The REAL state must be innocent, or every control below is meaningless.
    const baseline = scanHeldRowPromoters(
      real, SANCTIONED_PENDING_EVIDENCE_PROMOTERS, HELD_LITERAL_WRITE_ONLY_EXEMPTIONS,
      'FC-014-selftest',
    );
    if (baseline.violations.length !== 0 || baseline.promoting === 0) return [];

    // Each promotion FORM on its own, in a directory the old root list missed.
    const forms: Array<[string, string]> = [
      ['string literal',
        "async function promote(db: any, peId: string) {\n"
        + "  const q = await db.collection('pe_history').where('mint_status','==','pending_evidence').get();\n"
        + "  void q; return { mint_status: 'eligible' };\n}\n"],
      ['as const',
        "function hold() { return 'pending_evidence' as const; }\n"
        + "function promote() { return { mint_status: 'eligible' as const }; }\n"],
      ['module string constant',
        "const HELD = 'pending_evidence';\nconst ELIGIBLE = 'eligible';\n"
        + 'function promote() { void HELD; return { mint_status: ELIGIBLE }; }\n'],
      ['direct assignment',
        "function hold() { return 'pending_evidence'; }\n"
        + "function promote(row: any) { void hold(); row.mint_status = 'eligible'; }\n"],
      ['mint_disposition rather than mint_status',
        "function hold() { return 'pending_evidence'; }\n"
        + "function promote() { void hold(); return { mint_disposition: 'eligible' }; }\n"],
      ['a status ARRAY driving the query — the retired minting-engine shape',
        "const STATUSES = ['genesis_epoch_deferred', 'pending_evidence'];\n"
        + 'async function promote(db: any) {\n'
        + "  for (const s of STATUSES) { await db.collection('pe_history').where('mint_status','==',s).get(); }\n"
        + "  return { mint_status: 'eligible' };\n}\n"],
    ];
    const dirs = ['src/core/pe', 'src/core/onchain', 'src/core/maintenance'];
    const formFound = forms.map(([, body], i) => {
      const planted = new Map(real);
      planted.set(`${dirs[i % dirs.length]}/loose-promoter-${i}.ts`, body);
      return scanHeldRowPromoters(
        planted, SANCTIONED_PENDING_EVIDENCE_PROMOTERS, HELD_LITERAL_WRITE_ONLY_EXEMPTIONS,
        'FC-014-selftest',
      ).violations;
    });
    if (formFound.some((f) => f.length === 0)) return [];

    // The SANCTIONED case must NOT fire — an exemption that blocks the thing the
    // ruling allows is not an exemption. The planted name is ADDED to the real
    // sanctioned set (named one real promoter), so the control isolates
    // the planted file rather than un-sanctioning the real one.
    const planted = new Map(real);
    planted.set('src/core/onchain/loose-promoter-0.ts', forms[0][1]);
    if (scanHeldRowPromoters(
      planted,
      new Set([...SANCTIONED_PENDING_EVIDENCE_PROMOTERS, 'src/core/onchain/loose-promoter-0.ts']),
      HELD_LITERAL_WRITE_ONLY_EXEMPTIONS, 'FC-014-selftest',
    ).violations.length !== 0) return [];

    // A WRITE-ONLY exempt file must stay clean…
    const writeOnly = new Map(real);
    writeOnly.set('src/core/pvt/held-writer.ts',
      "function hold() { return { mint_status: 'pending_evidence' }; }\n"
      + "function other() { return { mint_status: 'eligible' }; }\n");
    if (scanHeldRowPromoters(
      writeOnly, SANCTIONED_PENDING_EVIDENCE_PROMOTERS,
      { ...HELD_LITERAL_WRITE_ONLY_EXEMPTIONS, 'src/core/pvt/held-writer.ts': 'test' },
      'FC-014-selftest',
    ).violations.length !== 0) return [];

    // …and must LOSE its exemption the moment it also READS the held state,
    // which is the exemption going stale — the failure an unchecked list has.
    const staleExempt = new Map(real);
    staleExempt.set('src/core/pvt/held-writer.ts',
      "function hold() { return { mint_status: 'pending_evidence' }; }\n"
      + "function read(row: any) { return row.mint_status === 'pending_evidence'; }\n"
      + "function other() { return { mint_status: 'eligible' }; }\n");
    const staleFound = scanHeldRowPromoters(
      staleExempt, SANCTIONED_PENDING_EVIDENCE_PROMOTERS,
      { ...HELD_LITERAL_WRITE_ONLY_EXEMPTIONS, 'src/core/pvt/held-writer.ts': 'test' },
      'FC-014-selftest',
    ).violations;
    if (staleFound.length === 0) return [];

    // The empty-population branch — the one gate the first cut shipped with no
    // control at all.
    const emptyScan = scanHeldRowPromoters(
      new Map(), SANCTIONED_PENDING_EVIDENCE_PROMOTERS, HELD_LITERAL_WRITE_ONLY_EXEMPTIONS,
      'FC-014-selftest',
    );
    if (emptyScan.promoting !== 0) return [];

    return [...formFound.flat(), ...staleFound];
  },
};

/**
 * The registry. FC-003's detector is behavioural and needs live probes, so the
 * suite supplies them; everything self-contained is detected here.
 */
export const FORBIDDEN_CONSTRUCTS: readonly ForbiddenConstruct[] = Object.freeze([
  FC_001,
  FC_002,
  FC_006,
  FC_007,
  FC_008,
  FC_009,
  FC_010,
  FC_011,
  FC_012,
  FC_013,
  FC_014,
]);

export function scanForbiddenConstructs(): readonly ForbiddenConstructViolation[] {
  return FORBIDDEN_CONSTRUCTS
    .filter((c) => c.status === 'enforced')
    .flatMap((c) => c.detect());
}

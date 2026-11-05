/**
 * The MINT CAPABILITY is closed, and this is what keeps it closed.
 *
 * Pausing `provian-pvt-mint` removed the SCHEDULE, not the CAPABILITY: the
 * endpoint still existed in the build and the relay still mounted
 * `PVT_MINTER_KEY`. Two things closed the capability itself, and both are
 * structural rather than operational —
 *
 * 1. Every mint-path scheduler endpoint is refused by the runtime boundary runtime
 * boundary BEFORE it reaches its handler, and the handler refuses again
 * on its own. Neither refusal reads a key, a database, or a provider.
 * 2. **No relay module constructs a signer from `PVT_MINTER_KEY` at all.**
 * The only remaining reads of that variable derive the minter ADDRESS in
 * order to FORBID it — three keepers that refuse to act as the minter.
 *
 * (2) is the one that would rot silently. A future change that builds a signer
 * out of that environment variable on a settlement path re-opens the capability
 * without touching a scheduler, a flag, or a contract, and nothing today would
 * notice. So this module re-derives the claim from the source tree on every test
 * run, the same way `c6-downgrade-evidence.ts` does for the pool counter.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
 * **It is a source sweep, not a proof, and the difference matters.** It reports
 * that no file in `src/` or `scripts/` both reaches for the minter key and
 * constructs a signer, in the shapes enumerated below. An earlier version of
 * this comment claimed more than that, and the claim was FALSE twice over: the
 * pattern required the key inside the constructor parentheses (missing
 * indirection through a local, this repo's dominant style), and stage 1 was a
 * literal substring test that `process.env[MINTER_KEY_ENV]` walks straight past
 * using a constant this very module exports.
 *
 * Both are fixed, and these evasions are named rather than left implied: a key
 * read through a computed string this list does not know, a signer built by a
 * library whose constructor shape is not below, a key fetched from Secret
 * Manager at runtime instead of the environment, or a signer assembled in a
 * dependency. Treat a clean sweep as "no KNOWN shape is present", and keep the
 * boundary refusals in (1) as the thing actually holding the door.
 *
 * (This file states the pattern only as a regular expression, never as a literal
 * construction, so it cannot match itself and needs no exclusion from its own
 * sweep.)
 *
 * ── WHY `PVT_MINTER_KEY` MUST NOT BE UNMOUNTED ────────────────────────────
 * It is tempting, and it is wrong twice over. First, it removes nothing: no
 * mint path reads it. Second, and worse, it **removes a safety check**. The
 * escrow-release, bond-keeper, and pool-keeper identity guards derive the
 * minter address from that key precisely so they can refuse to use it — and
 * each one SKIPS the check when the variable is absent. Unmounting the key
 * silently stops three keepers from forbidding the minter address. The key's
 * only live use in this service is a negative one.
 *
 * Read-only. One filesystem read and some regular expressions. Nothing here
 * mints, settles, signs, grants authority, or reads a key value.
 */

import { readFileSync, readdirSync, type Dirent } from 'fs';
import * as path from 'path';

/** The environment variable that carries the operational minter's key. */
export const MINTER_KEY_ENV = 'PVT_MINTER_KEY';

/**
 * Every token that indicates a file is reaching for the minter key. Stage 1
 * matches ANY of them, not just the literal env-var name.
 *
 * `MINTER_KEY_ENV` is in this list because the constant is EXPORTED from this
 * module, so `process.env[MINTER_KEY_ENV]` reads the key without the literal
 * `PVT_MINTER_KEY` ever appearing in the file — which defeated an earlier
 * substring-only stage 1 completely, and would have left the sweep reporting
 * `capability_closed: true` with a live minter signer in the tree.
 */
export const MINTER_KEY_TOKENS: readonly string[] = [
  MINTER_KEY_ENV,        // the literal env-var name
  'MINTER_KEY_ENV',      // this module's own exported constant
  'pvt-minter-key',      // the Secret Manager secret name
  // M7: the PVT9 settlement key names. `PVT9_SETTLEMENT_MINTER_KEY` does NOT contain
  // `PVT_MINTER_KEY` as a substring, so without these three a module that reads the settlement
  // keys under any local constant name would pass stage 1 unseen — and stage 1 is what makes
  // the sweep a capability check rather than a string search. The APPROVER key is listed too:
  // it is the epoch keeper's gas payer and the batch approver, so a file reaching for it is
  // reaching for on-chain write capability even though it cannot itself mint.
  'PVT9_SETTLEMENT_MINTER_KEY',
  'PVT9_SETTLEMENT_APPROVER_KEY',
  'pvt9-batch-approver-key',
];

/**
 * Files permitted to derive an address from the minter key, each because the
 * derivation exists to REFUSE that address rather than to use it. A file added
 * here is a claim that its use is negative; the test pins this list so the
 * claim has to be made deliberately.
 */
export const MINTER_KEY_NEGATIVE_USE_FILES: readonly string[] = [
  'src/core/agent-bank/escrow-release.ts',
  'src/core/agent-bank/bond-keeper.ts',
  'src/core/agent-bank/pool-keeper.ts',
];

/**
 * Files that build a settlement signer as their PURPOSE — a POSITIVE use, and the exact
 * opposite of the negative-use list above.
 *
 * This list is deliberately separate rather than folded into
 * `MINTER_KEY_NEGATIVE_USE_FILES`, because putting a positive use in a list whose stated
 * meaning is "derives the address in order to refuse it" would make the guard report a
 * comforting falsehood. A file here does not make the capability closed — it makes the
 * capability OPEN, deliberately, at a named location. `judgeMintCapability` reports exactly
 * that, and `capability_closed` is false whenever this list is non-empty.
 *
 * `src/core/pvt/wp4/operator-runtime.ts` is the ONE module that builds a settlement signer. As
 * of M7 it is reachable from the relay (`POST /v1/internal/settlement/pvt9-run`) as well as from
 * the two scripts, which are thin argv wrappers over it. Two ways reach that route :
 * scheduler auth on the daily runner `provian-pvt9-settlement` (`0 12 * * *`, ), and operator/admin
 * auth + an echoed arming token for a hand run. Either way the standing `PVT9_SETTLEMENT_ARMED`
 * env gate still holds. That is a real posture change and this list is where it is said out
 * loud: the tree CAN mint.
 *
 * What still stands in the way is operational, and each piece is independent: the exact
 * `PVT9_SETTLEMENT_ARMED=yes-settle-real-pvt` token, both keys present as Secret Manager
 * mounts, a funded approver, and — for the route — operator auth plus the same token in the
 * request body.
 *
 * The list has exactly ONE entry, and that is the point. `scripts/pvt9-settlement-run.ts`,
 * `scripts/pvt9-epoch-keeper.ts` and the two routes all reach the capability, and none of them
 * appears here — because none of them constructs a signer or reads a key. They are argv and
 * HTTP wrappers over the one module that does. The sweep is per-file and finds signer
 * CONSTRUCTION, so this list shrinking from the M6 shape while the capability grew is the
 * correct reading: the surface that touches key material got smaller, not larger.
 */
export const SANCTIONED_MINT_SIGNER_FILES: readonly string[] = [
  'src/core/pvt/wp4/operator-runtime.ts',
  // B10 (, the design requires ARM): the PE-ANCHOR runtime. Constructs a signer
  // from PVT_MINTER_KEY to send `anchorPEBatch` transactions on the deployed
  // PEAnchor `0x889A59A8…` — an on-chain WRITE capability, declared here for
  // that reason, but NOT a settlement/mint capability: the anchor contract
  // stores Merkle roots, holds no funds, and has zero kernel coupling (,
  // verified live: admin = the Foundation Safe, minter = this gas-only EOA).
  'src/core/pvt/pe-anchor-runtime.ts',
];

/**
 * Roots swept. `scripts/` is included because that is exactly where a
 * gas-spending signer gets written (`wp12-deploy-pvt9.ts`, `wp4-load-harness.ts`),
 * and an earlier version that swept only `src/` would not have seen one there.
 */
export const MINT_CAPABILITY_SWEEP_ROOTS: readonly string[] = ['src', 'scripts'];

/**
 * Any construction of a signer/wallet: the two ethers forms this codebase uses
 * and the viem `privateKeyToAccount` form. Stated only as the expression below,
 * never as a literal call, so this file cannot match itself and therefore never
 * needs excluding from its own sweep.
 *
 * DELIBERATELY NOT ANCHORED TO THE ENV VAR. An earlier version required the
 * minter-key identifier to appear INSIDE the constructor parentheses. That
 * caught the inline shape and missed the ordinary one — read the variable into
 * a local on one line, build the signer from that local nine lines later — which
 * is this repo's own dominant style (`scripts/wp12-deploy-pvt9.ts:222` -> `:231`).
 * The guard's stated contract was therefore false. The test is now per-FILE and
 * two-stage: a file that BOTH mentions the minter key AND builds a signer is a
 * finding, wherever in the file each appears.
 *
 * This over-approximates on purpose. A file that reads the variable for a
 * forbid-list and separately builds an unrelated signer WILL be flagged — and
 * must then be justified in the allowlist below with a stated reason. Over-
 * flagging costs a comment; under-flagging re-opens the mint capability.
 */
const SIGNER_CONSTRUCTION = new RegExp(
  [
    // Constructor forms: the plain and dotted ethers shapes, a parenthesised
    // member expression, and a short aliased import (one or two characters,
    // capitalised) — i.e. any `new` of a capitalised name ending in Wallet,
    // Signer or Account, plus the short-alias case. Written as a pattern only,
    // never as an example call, so this file cannot match itself.
    String.raw`new\s+\(?\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*(?:\w*(?:Wallet|Signer|Account)\b|[A-Z]\w?)\s*\)?\s*\(`,
    // viem
    String.raw`privateKeyToAccount\s*\(`,
    // ethers static factories, which are not `new` at all
    String.raw`Wallet\s*\.\s*(?:from|fromPrivateKey|fromEncryptedJson|fromEncryptedJsonSync|fromPhrase|fromMnemonic)\s*\(`,
    // hand-rolled secp256k1 — the shape this repo's own SDK uses
    String.raw`secp256k1\s*\.\s*(?:sign|getPublicKey)\s*\(`,
  ].join('|'),
  'g',
);

export interface MintSignerConstruction {
  /** Path relative to `provian-backend/`. */
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Every construction of a signer from the minter key OUTSIDE the negative-use
 * allowlist. Empty is the only state in which the capability is closed.
 *
 * `backendRoot` is a parameter so a negative control can point the same scan at
 * a tree with a planted violation — a scanner only ever observed returning
 * empty has not been shown to find anything.
 */
export function findMintSignerConstructions(
  backendRoot: string,
  roots: readonly string[] = MINT_CAPABILITY_SWEEP_ROOTS,
  // Both accounted-for lists. A sanctioned positive use is not an unaccounted-for FINDING,
  // but it still opens the capability — `judgeMintCapability` is where that is reported.
  allowed: readonly string[] = [...MINTER_KEY_NEGATIVE_USE_FILES, ...SANCTIONED_MINT_SIGNER_FILES],
): readonly MintSignerConstruction[] {
  const allowedSet = new Set(allowed);
  const found: MintSignerConstruction[] = [];

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
      // Tests and fixtures construct signers from throwaway keys by design.
      if (/\.test\.ts$/.test(entry.name)) continue;
      if (child.includes('__test-helpers__') || child.includes('__mocks__')) continue;
      if (allowedSet.has(child)) continue;

      let source: string;
      try {
        source = readFileSync(path.join(backendRoot, child), 'utf8');
      } catch {
        // Unreadable is a finding, never a clean scan.
        found.push({ file: child, line: 0, text: 'file could not be read' });
        continue;
      }
      // Stage 1: does this file reach for the minter key by ANY of its names?
      if (!MINTER_KEY_TOKENS.some((token) => source.includes(token))) continue;
      // Stage 2: does it build a signer ANYWHERE? The two need not be adjacent
      // — indirection through a local is the shape that matters.
      SIGNER_CONSTRUCTION.lastIndex = 0;
      let m = SIGNER_CONSTRUCTION.exec(source);
      while (m !== null) {
        found.push({
          file: child,
          line: lineOf(source, m.index),
          text: m[0].replace(/\s+/g, ' ').trim().slice(0, 160),
        });
        m = SIGNER_CONSTRUCTION.exec(source);
      }
    }
  };

  for (const root of roots) walk(root);
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * The scheduler paths that MUST be refused by the runtime boundary runtime boundary for the
 * mint capability to be closed. Asserted against the boundary's own classifier
 * rather than against a copy of its list, so a path quietly dropped from the
 * boundary turns this red.
 */
export const MINT_PATH_SCHEDULER_ENDPOINTS: readonly string[] = [
  '/v1/internal/scheduler/pvt-mint',
  '/v1/internal/scheduler/advance-epoch',
  // B10 : daily-pe-anchor + pe-anchor-backfill were REMOVED from this
  // list — they were held here "on principle" while quarantined, but they are
  // ANCHOR paths, not mint paths (the PEAnchor stores Merkle roots and cannot
  // move PVT), and they are live scheduler handlers again per /.
];

export interface MintCapabilityVerdict {
  /** No signer is constructible from the minter key outside the negative uses. */
  readonly no_signer_constructions: boolean;
  /** Every mint-path scheduler endpoint is refused before its handler. */
  readonly all_mint_endpoints_refused: boolean;
  /** Offending signer constructions, by name. Empty is the only passing state. */
  readonly constructions: readonly string[];
  /** Mint-path endpoints the boundary does NOT refuse. Empty is passing. */
  readonly unrefused_endpoints: readonly string[];
  /**
   * Files that build a settlement signer deliberately. NOT a defect — but not nothing
   * either: while this is non-empty the tree can mint, and `capability_closed` says so.
   */
  readonly sanctioned_mint_signers: readonly string[];
  /** ALL THREE empty, or the capability is open. */
  readonly capability_closed: boolean;
  readonly detail: string;
}

/**
 * The decision, as a total function of its two inputs, so both branches are
 * reachable in test. A verdict function that can only ever return one answer
 * proves nothing about the rule it claims to implement.
 */
export function judgeMintCapability(
  constructions: readonly MintSignerConstruction[],
  unrefusedEndpoints: readonly string[],
  // A PARAMETER, not a direct read of the module constant. While that constant is non-empty
  // a direct read would make the `capability_closed: true` branch unconstructible, and a
  // branch no test can reach is a branch no test is checking.
  sanctionedSigners: readonly string[] = SANCTIONED_MINT_SIGNER_FILES,
): MintCapabilityVerdict {
  const named = constructions.map((c) => `${c.file}:${c.line}`).sort();
  const sanctioned = [...sanctionedSigners].sort();
  // A sanctioned signer is still a signer. It is EXCLUDED from `constructions` (it is not an
  // unaccounted-for finding) but it is NOT excluded from the verdict: `capability_closed`
  // stays false while any sanctioned file exists, because the tree can mint.
  const noSigners = named.length === 0;
  const allRefused = unrefusedEndpoints.length === 0;
  const noSanctioned = sanctioned.length === 0;
  return {
    no_signer_constructions: noSigners,
    all_mint_endpoints_refused: allRefused,
    constructions: named,
    unrefused_endpoints: [...unrefusedEndpoints].sort(),
    sanctioned_mint_signers: sanctioned,
    capability_closed: noSigners && allRefused && noSanctioned,
    detail: `signer_constructions=[${named.join(',')}]; `
      + `unrefused_mint_endpoints=[${[...unrefusedEndpoints].sort().join(',')}]; `
      + `sanctioned_mint_signers=[${sanctioned.join(',')}]; `
      + 'the capability is closed ONLY if all three are empty',
  };
}

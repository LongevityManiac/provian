#!/usr/bin/env node
/**
 * Money-path tripwire.
 *
 * Replaces the removed runtime boundary per-file corrective allowlist. That gate made you
 * write down EVERY path in the repo you were allowed to touch, and never looked
 * at what a file did — so a colour literal in a settings screen cost the same
 * ceremony as the settlement runtime. This one inverts that: it ignores the
 * whole repo except the money path, and there it notices every byte.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * This is a NOTICE mechanism, not a freeze. The manifest is EXPECTED to move
 * whenever money-path code legitimately changes; regenerating it with --write
 * is the normal, correct response, and the regenerated diff is the audit record
 * a reviewer reads.
 *
 * Do not confuse it with the frozen Gate 1 evidence
 * (`pvt-policy-approval-manifest.generated.json`, pinned at 704c1a2d, and the
 * byte-frozen cost catalog / action-policy matrix). Those must NEVER move, and
 * CLAUDE.md pitfall #57 exists because regenerating THEM registers as an
 * adversarial mutation. Different artifacts, opposite rules. This file is
 * deliberately named and stored apart from them so the two cannot be swapped by
 * muscle memory.
 *
 * ── What it buys ────────────────────────────────────────────────────────────
 * You cannot change accrual, settlement, eligibility, genesis, the PVT9 kernel
 * or verifier, the runtime address/ABI seam, or the value-moving institution
 * logic — including their tests, because a quietly weakened money-path test is
 * the cheaper attack — without the change being surfaced by name.
 *
 * Usage:
 * node scripts/money-path-tripwire.mjs # check (exit 1 on drift)
 * node scripts/money-path-tripwire.mjs --write # accept current tree
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = 'docs/audit/money-path-tripwire.json';

/**
 * The money path. ONE declaration — the checker, the manifest generator, and
 * the test all read this exact array, so a test can never drift into asserting
 * a private copy of the scope it is meant to be checking.
 *
 * Each entry is matched as a path prefix against `git ls-files`.
 */
export const MONEY_PATH_ROOTS = Object.freeze([
  // accrual: where a PE becomes points, and points become a payable row
  'provian-backend/src/pvt-accrual',
  // the novelty-counter store (close-out; carve-out). `cache.ts`
  // holds the `pvt:occ:{user}:{action}:{day}` occurrence ordinals that PRICE
  // every PE (novelty decay is a record-time factor sealed into the snapshot)
  // and the Lua that commits them atomically with the per-PE exactly-once
  // claim (`commitPEAccountingCountersOnce`, `consumeRecoveredPECounterSlot`).
  // H3 changed that claim's semantics (immortal keys → a derived 7-day
  // TTL) and this tripwire said nothing, because the file sat outside the
  // manifest. The exact path, not a directory: the rest of `src/` stays out.
  // The file is mostly generic caching, so this trades some notice-noise for
  // protection of the one seam in it that prices money — the manifest diff is
  // what a reviewer reads, and a pricing-neutral cache edit is a one-line accept.
  'provian-backend/src/cache.ts',
  // settlement, eligibility, genesis, policy, watchers, operator runtime —
  // includes wp4/operator-runtime.ts, the one module that builds a mint signer
  'provian-backend/src/core/pvt/',
  'provian-backend/src/core/jurisdiction/',
  // PE METER : the meter seals every act, holds its mint-once keys, builds the
  // pending claims settlement registers, and commits running totals — the whole record half of the
  // money path once pe_history is gone. Its batch wire format decides what a device's act prices as.
  'provian-backend/src/core/meter/',
  // The authoritative agent→human beneficiary binding is outside core/pvt but
  // directly decides whether a PE is priced/routed sole or at the sealed split.
  // Its shared rotation proof decides whether that binding survives a key
  // change; weakening either can underpay a human or misroute a live claim.
  'provian-backend/src/core/agent-wallet/beneficiary-relationship',
  'provian-backend/src/core/agent-wallet/rotation-history-evidence',
  // the shared burn-consumption ledger : burning PVT is spending, so the
  // GLOBAL single-use gate every work package burn product checks-and-writes is money-path
  // (the operator: "the consumption gate is money-path"). One burn = one benefit; a silent
  // weakening here would let a burn buy multiple benefits.
  'provian-backend/src/core/commons/burn-consumption',
  // : the shared USDC charge path (an EIP-3009 authorization submitted on chain with
  // the relay's gas key, straight to Provian's revenue wallet — the on-demand payout fee and the
  // PE Archive's $5 per GB both go through it) and the Archive's account ledger, which credits a GB
  // exactly once per confirmed charge and gates uploads on paid space. A silent weakening here
  // would charge twice, credit without a charge, or charge a different amount.
  'provian-backend/src/core/payments/',
  'provian-backend/src/core/archive/',
  // App-store purchases: the relay verifies an App Store or Google Play receipt and credits the
  // same Archive GB or paid Settle now the USDC charge buys, once per store transaction. A silent
  // weakening here would credit an unverified, replayed, sandbox or other-app receipt. The
  // on-demand payout is the request those purchases (and the $1 USDC fee) pay for, and it runs a
  // payee's settlement.
  'provian-backend/src/core/store-purchases/',
  'provian-backend/src/core/payout/',
  // institution logic that moves value
  'provian-backend/src/core/agent-bank/escrow',
  'provian-backend/src/core/agent-bank/promises',
  // human P2P promise state machine + signing. The relay's wallet-bound
  // close-out record is the EARNING WITNESS the completion verifier reads to
  // promote a `promise_fulfilled` PE — a silent weakening of the two-close-out-
  // signature bind or the transition/authorization rules would let a promise mint
  // without a genuine mutual close, so it is money-path.
  'provian-backend/src/core/human-promises',
  'provian-backend/src/core/agent-bank/pools',
  'provian-backend/src/core/agent-bank/court',
  'provian-backend/src/core/agent-bank/bonds',
  'provian-backend/src/core/agent-bank/job-settlement',
  // the kernel and the verifier that gates every batch
  'contracts/src/ProvianPVT9',
  // deploy / arm / verify / rotate scripts. These spend gas and can appoint or
  // move authority, so a silent edit here is a live-value risk even though the
  // files run by hand rather than on a server. Solidity TESTS are deliberately
  // NOT in scope: they live under `contracts/test/` (44 `.t.sol`), they churn
  // heavily, and they cannot move value — this root contains no `.sol` at all.
  'contracts/scripts/',
  // the runtime address/ABI seam the settlement path reads
  'config/pvt9-base.json',
  // the SDK's ungoverned agent signer and its pinned addresses. This file calls
  // itself "the ONLY safety boundary" for agent spending, and it is: the agent's
  // own money is deliberately not governed by AAG, so a wrong address here moves
  // real value with nothing downstream to catch it. Added after exactly that
  // drift shipped — `evm-allowlist.ts` kept pinning PVT to retired PVTv8 through
  // the kernel succession, so `transferToken(PVT)` targeted a dead token
  // while the live kernel was not allowlisted at all. Nothing was watching.
  'provian-agent-sdk/src/evm-allowlist',
  'provian-agent-sdk/src/evm-signer',
  // the voluntary-rotation balance sweep — signs a real transfer of the retired
  // address's earned balance with the old key. Same "ungoverned, nothing
  // downstream to catch it" property as evm-signer; a defect here strands or
  // misdirects earned PVT, so its bytes (and its tests) are watched.
  'provian-agent-sdk/src/sweep',
  // the universal voluntary-rotation entry : loads the machine's keystore,
  // rotates + sweeps, and — critically for money-safety — PRESERVES the retired
  // key when a sweep strands so the balance stays recoverable. A silent weakening
  // (skipping the preserve, or discarding the old key) would strand earned PVT, so
  // its bytes and its test are watched.
  'provian-agent-sdk/src/rotate-key-flow',
  // the app-side balance sweep : signs a real transfer of the retired
  // address's earned PVT with the recovered old key, and can pull gas from the
  // human's wallet. Same "moves real value, fail-closed" property as sweep.ts; a
  // defect here strands or misdirects earned PVT. The one app-tree money-path root.
  'src/core/agents/agentBalanceSweep',
  'provian-agent-sdk/src/evm-bond',
  'provian-agent-sdk/src/evm-escrow',
  'provian-agent-sdk/src/evm-pool',
  'provian-agent-sdk/src/contract-addresses',
  'provian-agent-sdk/src/commons-institutions',
  'provian-agent-sdk/src/x402-signer',
  // the agent's own swap (signs the 0x transaction after the guard) and the
  // guard that decides whether those bytes are the swap asked for — the same ungoverned-signer
  // property as evm-signer; plus the shell act verbs that sign transfers / burns / bonds / x402
  // with the installed key and scrub it from every output.
  'provian-agent-sdk/src/agent-swap',
  'provian-agent-sdk/src/zerox-swap-guard',
  'provian-agent-sdk/src/act-verbs',
  // the process lane decides on the device which commands mint (launcher, wrapper, one act per
  // command) — what the relay then prices. Its tests ride with it.
  'provian-agent-sdk/src/observer/plugins/process-lane',
]);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function moneyPathFiles() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  return tracked.filter((p) => MONEY_PATH_ROOTS.some((root) => p.startsWith(root))).sort();
}

export function currentDigests() {
  const out = {};
  for (const relativePath of moneyPathFiles()) {
    out[relativePath] = sha256(readFileSync(resolve(REPO_ROOT, relativePath)));
  }
  return out;
}

/**
 * Compare a tree against a manifest. Pure: takes both sides, returns a verdict.
 * Kept side-effect-free so the test can drive it with synthetic inputs and see
 * it report a violation, rather than only ever observing it green.
 */
export function diffAgainstManifest(current, manifest) {
  const currentKeys = Object.keys(current);
  const manifestKeys = Object.keys(manifest);
  return {
    evaluated: currentKeys.length,
    added: currentKeys.filter((k) => !(k in manifest)).sort(),
    removed: manifestKeys.filter((k) => !(k in current)).sort(),
    modified: currentKeys.filter((k) => k in manifest && manifest[k] !== current[k]).sort(),
  };
}

export function isClean(verdict) {
  return verdict.added.length === 0 && verdict.removed.length === 0 && verdict.modified.length === 0;
}

function main() {
  const write = process.argv.includes('--write');
  const current = currentDigests();

  // The vacuous pass this guard could otherwise ship: if the roots stopped
  // matching anything (a directory rename, a bad prefix), every comparison
  // below would trivially hold and the tripwire would report OK forever while
  // guarding nothing. An empty population is a FAILURE, never a pass.
  if (Object.keys(current).length === 0) {
    console.error('money-path tripwire: FAILED — the roots matched zero tracked files.');
    console.error('The scope is broken, not clean. Check MONEY_PATH_ROOTS against the tree.');
    process.exit(1);
  }

  const manifestFile = resolve(REPO_ROOT, MANIFEST_PATH);

  if (write) {
    writeFileSync(
      manifestFile,
      `${JSON.stringify({ note: 'Money-path tripwire. Expected to move when money-path code changes; regenerate with `npm run money-path:accept`. NOT the frozen Gate 1 evidence.', files: current }, null, 2)}\n`,
    );
    console.log(`money-path tripwire: wrote ${Object.keys(current).length} digests to ${MANIFEST_PATH}`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8')).files;
  } catch {
    console.error(`money-path tripwire: FAILED — cannot read ${MANIFEST_PATH}.`);
    process.exit(1);
  }

  const verdict = diffAgainstManifest(current, manifest);
  if (isClean(verdict)) {
    console.log(`money-path tripwire: ok — ${verdict.evaluated} files, none changed.`);
    return;
  }

  console.error('money-path tripwire: money-path files changed.\n');
  for (const [label, list] of [['modified', verdict.modified], ['added', verdict.added], ['removed', verdict.removed]]) {
    if (list.length) {
      console.error(`    ${label}:`);
      for (const p of list) console.error(`    ${p}`);
    }
  }
  console.error(
    '\nThis is a notice, not a verdict — it does not claim the change is wrong.\n' +
      'If the change is intended, accept it and commit the manifest alongside it:\n' +
      '  npm run money-path:accept\n',
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

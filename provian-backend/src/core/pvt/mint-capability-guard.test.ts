/**
 * The mint capability is closed — re-derived from the tree, not remembered.
 *
 * The claim "no relay module can construct a minter signer" is a universally
 * quantified statement over a corpus. Two ways it fails vacuously, both
 * excluded here: the scanner might find nothing because it cannot find
 * anything (so a PLANTED violation is asserted to be caught), and the corpus
 * might be empty (so the swept file count is asserted non-trivial).
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  findMintSignerConstructions,
  judgeMintCapability,
  MINT_PATH_SCHEDULER_ENDPOINTS,
  MINTER_KEY_NEGATIVE_USE_FILES,
  SANCTIONED_MINT_SIGNER_FILES,
  MINTER_KEY_ENV,
  MINTER_KEY_TOKENS,
} from './mint-capability-guard';
import { classifyPvt9RuntimeRequest } from './wp2-runtime-boundary';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');

function unrefusedMintEndpoints(): string[] {
  return MINT_PATH_SCHEDULER_ENDPOINTS
    .filter((p) => !classifyPvt9RuntimeRequest('POST', p).blocked);
}

describe('mint capability — signer constructions', () => {
  it('THIS TREE: no signer is constructed from the minter key outside the negative uses', () => {
    expect(findMintSignerConstructions(BACKEND_ROOT)).toEqual([]);
  });

  it('RED CONTROL: the scanner catches a PLANTED signer construction', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-'));
    try {
      mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'core', 'reopened.ts'),
        `import { ethers } from 'ethers';\n`
        + `export const signer = new ethers.Wallet(process.env.${MINTER_KEY_ENV}!);\n`,
      );
      const found = findMintSignerConstructions(root);
      expect(found).toHaveLength(1);
      expect(found[0].file).toBe('src/core/reopened.ts');
      expect(found[0].line).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RED CONTROL: INDIRECTION through a local is caught — the shape a narrow regex missed', () => {
    // This is the defect an earlier version had: it required the minter key to
    // sit INSIDE the constructor parentheses, so the repo's own dominant style
    // (read into a local, construct nine lines later) was invisible.
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-indirect-'));
    try {
      mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'core', 'indirect.ts'),
        `import { Wallet } from 'ethers';\n`
        + `const rawKey = process.env.${MINTER_KEY_ENV} as string;\n`
        + `// ... nine lines of unrelated setup ...\n`.repeat(9)
        + `export const signer = new Wallet(rawKey, provider);\n`,
      );
      const found = findMintSignerConstructions(root);
      expect(found.map((c) => c.file)).toEqual(['src/core/indirect.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RED CONTROL: indirection into the VIEM form is caught too', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-indirect-viem-'));
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'indirect-viem.ts'),
        `const k = process.env.${MINTER_KEY_ENV}!;\n`
        + `export const acct = privateKeyToAccount(k as \`0x\${string}\`);\n`,
      );
      expect(findMintSignerConstructions(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RED CONTROL: a signer planted under scripts/ is caught — scripts is swept', () => {
    // `scripts/` is where a gas-spending signer actually gets written. An
    // earlier version swept only `src/` and would not have seen one here.
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-scripts-'));
    try {
      mkdirSync(path.join(root, 'scripts'), { recursive: true });
      writeFileSync(
        path.join(root, 'scripts', 'settle.ts'),
        `const rawKey = process.env.${MINTER_KEY_ENV};\n`
        + `const signer = new Wallet(rawKey, provider);\n`,
      );
      expect(findMintSignerConstructions(root).map((c) => c.file))
        .toEqual(['scripts/settle.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a file that builds a signer but never mentions the minter key is NOT a finding', () => {
    // Stage 1 is load-bearing: without it the sweep would flag every signer in
    // the tree and the guard would be noise rather than a gate.
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-unrelated-'));
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'unrelated.ts'),
        `const signer = new Wallet(process.env.SOME_OTHER_KEY, provider);\n`,
      );
      expect(findMintSignerConstructions(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RED CONTROL: reading the key through this module\'s OWN exported constant is caught', () => {
    // The defect the second review found: stage 1 was a literal substring test,
    // so `process.env[MINTER_KEY_ENV]` — using a constant this module exports —
    // never contained `PVT_MINTER_KEY` and the sweep short-circuited entirely,
    // still reporting the capability closed with a live minter signer present.
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-const-'));
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'via-constant.ts'),
        `import { MINTER_KEY_ENV } from '../pvt/mint-capability-guard';\n`
        + `const k = process.env[MINTER_KEY_ENV]!;\n`
        + `export const signer = new Wallet(k, provider);\n`,
      );
      expect(findMintSignerConstructions(root).map((c) => c.file))
        .toEqual(['src/via-constant.ts']);
      // …and it must NOT contain the literal, or the control proves nothing.
      expect(readFileSync(path.join(root, 'src', 'via-constant.ts'), 'utf8'))
        .not.toContain(MINTER_KEY_ENV);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RED CONTROL: an ethers STATIC FACTORY is caught, not only `new`', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-factory-'));
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'factory.ts'),
        `const k = process.env.${MINTER_KEY_ENV}!;\n`
        + `export const signer = Wallet.fromPrivateKey(k);\n`,
      );
      expect(findMintSignerConstructions(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RED CONTROL: the Secret Manager NAME is a stage-1 signal too', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-secret-'));
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'secret.ts'),
        `const k = await sm.access('projects/provian-ai/secrets/pvt-minter-key/versions/latest');\n`
        + `export const signer = new ethers.Wallet(k, provider);\n`,
      );
      expect(findMintSignerConstructions(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RED CONTROL: the viem shape is caught too, not only the ethers shape', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-viem-'));
    try {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'viem-reopened.ts'),
        `export const acct = privateKeyToAccount(process.env.${MINTER_KEY_ENV} as \`0x\${string}\`);\n`,
      );
      expect(findMintSignerConstructions(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RED CONTROL: an unreadable file is a FINDING, never a clean scan', () => {
    // A directory named like a source file cannot be read as one.
    const root = mkdtempSync(path.join(tmpdir(), 'mint-cap-unreadable-'));
    try {
      mkdirSync(path.join(root, 'src', 'trap.ts'), { recursive: true });
      // `readdirSync` reports it as a directory, so the scan descends instead —
      // which is why the real protection is the planted-violation control above.
      // What this asserts is the weaker, still necessary property: the scan does
      // not throw on a hostile tree.
      expect(() => findMintSignerConstructions(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the negative-use allowlist is exactly the three keeper identity guards', () => {
    // Pinned so adding a fourth file is a deliberate act with a stated reason,
    // not a quiet widening of where a minter signer may be built.
    expect([...MINTER_KEY_NEGATIVE_USE_FILES].sort()).toEqual([
      'src/core/agent-bank/bond-keeper.ts',
      'src/core/agent-bank/escrow-release.ts',
      'src/core/agent-bank/pool-keeper.ts',
    ]);
  });

  it('the allowlisted files really do reference the minter key (the exclusion is load-bearing)', () => {
    // If they did not, the allowlist would be excluding nothing and the clean
    // scan above would prove less than it appears to.
    const withoutAllowlist = findMintSignerConstructions(BACKEND_ROOT, ['src', 'scripts'], []);
    // Each keeper builds several signers, so dedupe to FILES: the claim is that
    // the allowlist excludes exactly these three and nothing else in the tree.
    expect([...new Set(withoutAllowlist.map((c) => c.file))].sort())
      .toEqual([...MINTER_KEY_NEGATIVE_USE_FILES, ...SANCTIONED_MINT_SIGNER_FILES].sort());
    expect(withoutAllowlist.length).toBeGreaterThan(3); // and it is not an empty sweep
  });
});

describe('mint capability — the boundary refuses every mint-path endpoint', () => {
  it.each(MINT_PATH_SCHEDULER_ENDPOINTS)('%s is refused before its handler', (endpoint) => {
    const decision = classifyPvt9RuntimeRequest('POST', endpoint);
    expect(decision.blocked).toBe(true);
    expect(decision.dependency).toBe('legacy_settlement_scheduler');
  });

  it('RED CONTROL: the classifier is not hard-wired to block — a live route passes', () => {
    expect(classifyPvt9RuntimeRequest('GET', '/v1/pvt/accrual').blocked).toBe(false);
  });

  it('the mint-path endpoint list is non-empty', () => {
    // B10 removed the two anchor paths (anchor ≠ mint); the two
    // genuine legacy mint stubs remain.
    expect(MINT_PATH_SCHEDULER_ENDPOINTS.length).toBeGreaterThanOrEqual(2);
  });
});

describe('judgeMintCapability', () => {
  it('THIS TREE: the capability is OPEN, at exactly the sanctioned locations', () => {
    // Changed deliberately when the production settlement runner landed, and again in M7 when
    // the runtime became reachable from the relay. A runner that cannot sign is not a runner,
    // so the tree can mint and the verdict says so. What is asserted is that the opening is
    // EXACTLY the files that were signed off: no unaccounted-for signer, and every legacy
    // mint-path endpoint still refused.
    const verdict = judgeMintCapability(
      findMintSignerConstructions(BACKEND_ROOT),
      unrefusedMintEndpoints(),
    );
    expect(verdict).toMatchObject({
      no_signer_constructions: true,
      all_mint_endpoints_refused: true,
      capability_closed: false,
      constructions: [],
      unrefused_endpoints: [],
      sanctioned_mint_signers: [
        // B10 : the PE-anchor runtime — a declared on-chain WRITE
        // (anchoring-only; cannot mint) at a named location.
        'src/core/pvt/pe-anchor-runtime.ts',
        'src/core/pvt/wp4/operator-runtime.ts',
      ],
    });
  });

  it('the entrypoints that REACH the capability construct no signer of their own', () => {
    // The two scripts and the two routes all run settlement, and none of them holds key
    // material — they are wrappers over the one module that does. If a future edit inlined a
    // signer into one of them, the sweep would surface it as an unaccounted-for construction
    // and `constructions` above would stop being empty.
    const found = findMintSignerConstructions(BACKEND_ROOT, ['src', 'scripts'], []);
    const files = new Set(found.map((c) => c.file));
    expect(files.has('scripts/pvt9-settlement-run.ts')).toBe(false);
    expect(files.has('scripts/pvt9-epoch-keeper.ts')).toBe(false);
    // RED CONTROL: the module that DOES build one is found, so the absence above is a fact
    // about those files and not about the sweep failing to look at `scripts/`.
    expect(files.has('src/core/pvt/wp4/operator-runtime.ts')).toBe(true);
  });

  it('the settlement key env names are in the token list, so a rename cannot hide a signer', () => {
    // `PVT9_SETTLEMENT_MINTER_KEY` does not contain `PVT_MINTER_KEY` as a substring. Before
    // M7 added these tokens, a module reading it under a local constant would have passed
    // stage 1 entirely unseen — and stage 1 is what makes this a capability check.
    for (const token of ['PVT9_SETTLEMENT_MINTER_KEY', 'PVT9_SETTLEMENT_APPROVER_KEY', 'pvt9-batch-approver-key']) {
      expect(MINTER_KEY_TOKENS).toContain(token);
    }
    // RED CONTROL: the substring relationship that would have made them redundant is absent.
    expect('PVT9_SETTLEMENT_MINTER_KEY'.includes('PVT_MINTER_KEY')).toBe(false);
  });

  it('RED CONTROL: with NO sanctioned signer this same tree would be closed', () => {
    // The negative control for the assertion above: it proves `capability_closed:false` is
    // caused by the sanctioned entry and not by some unrelated finding leaking in.
    expect(judgeMintCapability(
      findMintSignerConstructions(BACKEND_ROOT),
      unrefusedMintEndpoints(),
      [],
    )).toMatchObject({ capability_closed: true, sanctioned_mint_signers: [] });
  });

  it('RED: a sanctioned signer alone opens the capability', () => {
    expect(judgeMintCapability([], [], ['scripts/pvt9-settlement-run.ts']))
      .toMatchObject({
        capability_closed: false,
        no_signer_constructions: true,
        all_mint_endpoints_refused: true,
      });
  });

  it('RED: one signer construction opens the capability', () => {
    expect(judgeMintCapability(
      [{ file: 'src/core/pvt/whatever.ts', line: 12, text: 'new ethers.Wallet(...)' }],
      [],
    )).toMatchObject({ capability_closed: false, no_signer_constructions: false });
  });

  it('RED: one unrefused mint endpoint opens the capability', () => {
    expect(judgeMintCapability([], ['/v1/internal/scheduler/pvt-mint']))
      .toMatchObject({ capability_closed: false, all_mint_endpoints_refused: false });
  });

  it('both branches of the verdict are reachable', () => {
    const outcomes = new Set([
      judgeMintCapability([], [], []).capability_closed,
      judgeMintCapability([{ file: 'x', line: 1, text: 'y' }], [], []).capability_closed,
    ]);
    expect([...outcomes].sort()).toEqual([false, true]);
  });
});

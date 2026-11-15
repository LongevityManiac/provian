/**
 * Registry-bound chain readers and the single-definition launch window.
 * A reader must throw when it cannot reach the correct contract. Querying a
 * different token can return false for a real mint, so that answer cannot be
 * used as evidence of absence. Each throwing case is a negative control.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DOCUMENT_MINT_BINDINGS,
  LEGACY_MINT_CONTRACT_REGISTRY,
  LegacyMintContractUnresolved,
  contractsWithLiveSupply,
  isRegisteredMintContract,
  resolveMintContractForDocument,
} from './legacy-mint-contract-registry';
import {
  BATCH_MINTED_SELECTOR,
  makeJsonRpcTransport,
  makeRegistryBoundBatchMintedReader,
  toBytes32Arg,
  type EthCallTransport,
} from './legacy-batch-minted-reader';
import { C1_SCOPE_EVIDENCE, SCOPE_EXCLUSIONS } from './cutover-scope-exclusions';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from '../policy/proposed-genesis-policy';
import { shouldEnqueueGenesisQualification } from '../genesis-award-state-machine';
import { EVM_ADDRESS_RE, takeCutoverInventory } from './cutover-inventory';
import { CANONICAL_ABI_FALSE_WORD } from './cutover-hard-stops';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';

/**
 * The epochZeroStartsAt scan, at MODULE scope so the guard and its positive
 * control bind to the SAME roots, the SAME patterns and the SAME walk. The
 * Guard and negative controls share their roots and patterns so narrowing
 * the real scan cannot leave an independent fixture green.
 */
const EPOCH_ZERO_REPO_ROOT = path.resolve(__dirname, '../../../../..');

/** Every off-chain code root. Narrowing this list must fail the positive control. */
const EPOCH_ZERO_SCAN_ROOTS = [
  path.join(EPOCH_ZERO_REPO_ROOT, 'provian-backend', 'src'),
  path.join(EPOCH_ZERO_REPO_ROOT, 'provian-backend', 'scripts'),
  path.join(EPOCH_ZERO_REPO_ROOT, 'scripts'),
];

/** The four shapes a stale copy can take: property, binding, Date(...), raw ms. */
const EPOCH_ZERO_DEFINITION_PATTERNS = [
  /epochZeroStartsAt\s*:\s*['"`]\s*\d{4}-\d{2}-\d{2}/,
  /epochZeroStartsAt\s*=\s*['"`]\s*\d{4}-\d{2}-\d{2}/,
  /epochZeroStartsAt\s*[:=]\s*new Date\(/,
  /epochZeroStartsAt\s*[:=]\s*\d{10,}/,
];

const EPOCH_ZERO_CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const EPOCH_ZERO_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'out', 'typechain-types',
]);

/** Returns `relative/path: line` for every date literal assigned to the field. */
function scanForEpochZeroDefinitions(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EPOCH_ZERO_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!EPOCH_ZERO_CODE_FILE.test(entry.name)) continue;
      if (entry.name.endsWith('.test.ts')) continue; // fixtures are not definitions
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (EPOCH_ZERO_DEFINITION_PATTERNS.some((re) => re.test(line))) {
          found.push(`${path.relative(EPOCH_ZERO_REPO_ROOT, full)}: ${line.trim()}`);
        }
      }
    }
  };
  for (const root of EPOCH_ZERO_SCAN_ROOTS) walk(root);
  return found;
}

// both were redeclared copies. Bound to the one source each.
const ADDRESS_RE = EVM_ADDRESS_RE;
const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const TRUE_WORD = `0x${'0'.repeat(63)}1`;
const FALSE_WORD = CANONICAL_ABI_FALSE_WORD;

/** A transport that records what it was asked and replies with a fixed word. */
function recordingTransport(reply: string | Error): {
  transport: EthCallTransport;
  calls: Array<{ chainId: number; to: string; data: string }>;
} {
  const calls: Array<{ chainId: number; to: string; data: string }> = [];
  return {
    calls,
    transport: {
      async ethCall(chainId, to, data) {
        calls.push({ chainId, to, data });
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

describe('the legacy mint-contract registry', () => {
  it('has no UNIDENTIFIED row (an unidentified address is a finding, not a footnote)', () => {
    const unidentified = LEGACY_MINT_CONTRACT_REGISTRY
      .filter((r) => r.source_version === 'UNIDENTIFIED')
      .map((r) => `${r.chain_id}:${r.address}`);
    expect(unidentified).toEqual([]);
  });

  it('every row is structurally well-formed and evidence-carrying', () => {
    expect(LEGACY_MINT_CONTRACT_REGISTRY.length).toBeGreaterThan(0);
    for (const row of LEGACY_MINT_CONTRACT_REGISTRY) {
      expect(row.address).toMatch(ADDRESS_RE);
      expect([8453, 42161, 10]).toContain(row.chain_id);
      expect(row.artifact_sources.length).toBeGreaterThan(0);
      expect(row.runtime_code_sha256_16).toMatch(/^[0-9a-f]{16}$/);
      expect(row.runtime_code_bytes).toBeGreaterThan(0);
      expect(row.total_supply_atomic).toMatch(/^\d+$/);
      if (row.deployment_tx !== null) expect(row.deployment_tx).toMatch(BYTES32_RE);
    }
  });

  it('(chain, address) is unique — the registry cannot hold two answers for one contract', () => {
    const keys = LEGACY_MINT_CONTRACT_REGISTRY.map((r) => `${r.chain_id}:${r.address.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('records exactly the three Base contracts that carry live supply, and PVTv8 carries none', () => {
    const withSupply = contractsWithLiveSupply();
    expect(withSupply.map((r) => r.address).sort()).toEqual([
      '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD', // PVTv4 base-chunk-ii — 10.6
      '0x87B2d38dAf0fE335BB6e1Bb030647667D2c63598', // PVTv4 base-pvt-v4 — 27.4
      '0xE99B2EEB3da013376ee779c0e0e6c759BBb51fb4', // PVTv3 base-pvt-v3 — 33.2
    ].sort());
    for (const row of withSupply) expect(row.chain_id).toBe(8453);

    // THE FACT THAT INVALIDATED 's BINDING: the contract its reader asked
    // has never minted anything, so `false` was the only answer it could give.
    const pvtv8 = LEGACY_MINT_CONTRACT_REGISTRY
      .find((r) => r.address === '0x50D6F1Ff28CcaC80B548946F27701016C01f4BAa');
    expect(pvtv8?.source_version).toBe('PVTv8');
    expect(pvtv8?.total_supply_atomic).toBe('0');
    expect(pvtv8?.retired).toBe(false);
  });

  it('every Arbitrum and Optimism PVT deployment has zero supply (Base-only consolidation)', () => {
    for (const row of LEGACY_MINT_CONTRACT_REGISTRY.filter((r) => r.chain_id !== 8453)) {
      expect(row.total_supply_atomic).toBe('0');
    }
  });

  it('binds all five C1 documents, each to a REGISTERED contract, each minted TRUE', () => {
    expect(DOCUMENT_MINT_BINDINGS).toHaveLength(5);
    for (const b of DOCUMENT_MINT_BINDINGS) {
      expect(b.document_id).toMatch(BYTES32_RE);
      expect(b.mint_tx_hash).toMatch(BYTES32_RE);
      expect(isRegisteredMintContract(b.mint_contract_address)).toBe(true);
      expect(b.batch_minted_on_correct_contract).toBe(true);
      expect(b.batch_minted_on_pvtv8).toBe(false);
      expect(b.mint_block).toBeGreaterThan(0);
    }
    // Three distinct contracts, not one — recorded "four of five on
    // 0x23D1266…", which the receipts disprove.
    const contracts = new Set(DOCUMENT_MINT_BINDINGS.map((b) => b.mint_contract_address));
    expect(contracts.size).toBe(3);
    expect([...contracts].sort()).toEqual([
      '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD',
      '0x87B2d38dAf0fE335BB6e1Bb030647667D2c63598',
      '0xE99B2EEB3da013376ee779c0e0e6c759BBb51fb4',
    ].sort());
    expect(DOCUMENT_MINT_BINDINGS
      .filter((b) => b.mint_contract_address === '0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD'))
      .toHaveLength(3);
  });

  it('the C1 evidence table and the bindings agree document-for-document', () => {
    expect(C1_SCOPE_EVIDENCE).toHaveLength(5);
    for (const row of C1_SCOPE_EVIDENCE) {
      const bound = DOCUMENT_MINT_BINDINGS.find((b) => b.document_id === row.document_id);
      expect(bound).toBeDefined();
      expect(row.minted_against_contract).toBe(bound!.mint_contract_address);
      expect(row.batch_minted_on_correct_contract).toBe(bound!.batch_minted_on_correct_contract);
      expect(row.recorded_mint_tx_hash).toBe(bound!.mint_tx_hash);
    }
  });

  it('THE PRE-RESOLVED RULING — no document carrying a real mint may be allowlisted', () => {
    // A real mint is in scope by definition. Every one of the five carries a
    // confirmed mint tx, so the exclusion set must be empty — and the `excluded`
    // field is typed as the literal `false`, so it cannot be flipped either.
    expect(SCOPE_EXCLUSIONS.size).toBe(0);
    for (const row of C1_SCOPE_EVIDENCE) {
      expect(row.recorded_mint_tx_hash).not.toBeNull();
      expect(row.excluded).toBe(false);
    }
  });
});

describe('contract resolution THROWS rather than answering', () => {
  it('resolves each bound document from its own mint receipt', () => {
    for (const b of DOCUMENT_MINT_BINDINGS) {
      const r = resolveMintContractForDocument(b.document_id);
      expect(r.address).toBe(b.mint_contract_address);
      expect(r.chainId).toBe(8453);
      expect(r.source).toBe('receipt');
    }
  });

  it('the receipt binding OUTRANKS a recorded field, even a conflicting one', () => {
    const b = DOCUMENT_MINT_BINDINGS[0];
    const r = resolveMintContractForDocument(
      b.document_id,
      '0x50D6F1Ff28CcaC80B548946F27701016C01f4BAa', // the wrong (PVTv8) answer
    );
    expect(r.address).toBe(b.mint_contract_address);
    expect(r.source).toBe('receipt');
  });

  it('resolves an unbound document from a recorded address the registry knows', () => {
    const r = resolveMintContractForDocument(
      `0x${'7'.repeat(64)}`,
      '0x23d126600ba4f606240b5f60db4b27bd0f8ec2ad', // lowercase on purpose
    );
    expect(r.address).toBe('0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD');
    expect(r.source).toBe('recorded_field');
  });

  it('NEGATIVE CONTROL — a recorded address ABSENT from the registry THROWS', () => {
    // The directive's named case. The old reader would have queried PVTv8 and
    // reported `false`; an unknown contract is UNIDENTIFIED, which is a finding.
    expect(() => resolveMintContractForDocument(
      `0x${'8'.repeat(64)}`,
      '0x000000000000000000000000000000000000dEaD',
    )).toThrow(LegacyMintContractUnresolved);
    expect(() => resolveMintContractForDocument(
      `0x${'8'.repeat(64)}`,
      '0x000000000000000000000000000000000000dEaD',
    )).toThrow(/UNIDENTIFIED/);
  });

  it('NEGATIVE CONTROL — no binding and no recorded address THROWS', () => {
    expect(() => resolveMintContractForDocument(`0x${'9'.repeat(64)}`))
      .toThrow(LegacyMintContractUnresolved);
    expect(() => resolveMintContractForDocument(`0x${'9'.repeat(64)}`, null))
      .toThrow(/no mint-transaction binding/);
    expect(() => resolveMintContractForDocument(`0x${'9'.repeat(64)}`, '   '))
      .toThrow(/no mint-transaction binding/);
  });

  it('never returns null — the return type has no absent case', () => {
    // Exhaustive over the two success paths plus the three failure paths above:
    // there is no fourth outcome, so a caller cannot receive a falsy contract
    // and go on to read `false` from nowhere.
    const ok = resolveMintContractForDocument(DOCUMENT_MINT_BINDINGS[0].document_id);
    expect(ok.address).toMatch(ADDRESS_RE);
  });
});

describe('the registry-bound batchMinted reader', () => {
  it('derives the selector rather than hardcoding it', () => {
    expect(BATCH_MINTED_SELECTOR).toBe('0x005509b9');
  });

  it('asks the CORRECT contract, with the document as the bytes32 argument', async () => {
    const b = DOCUMENT_MINT_BINDINGS[1]; // the PVTv3 one
    const { transport, calls } = recordingTransport(TRUE_WORD);
    const reader = makeRegistryBoundBatchMintedReader(transport);
    await expect(reader.readBatchMinted(b.document_id)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('0xE99B2EEB3da013376ee779c0e0e6c759BBb51fb4');
    expect(calls[0].to).not.toBe('0x50D6F1Ff28CcaC80B548946F27701016C01f4BAa');
    expect(calls[0].chainId).toBe(8453);
    expect(calls[0].data).toBe(BATCH_MINTED_SELECTOR + b.document_id.slice(2));
  });

  it('returns false ONLY when the correct contract itself answers false', async () => {
    const { transport, calls } = recordingTransport(FALSE_WORD);
    const reader = makeRegistryBoundBatchMintedReader(transport);
    await expect(reader.readBatchMinted(DOCUMENT_MINT_BINDINGS[0].document_id))
      .resolves.toBe(false);
    // …and it did reach the right contract before saying so.
    expect(calls[0].to).toBe('0x87B2d38dAf0fE335BB6e1Bb030647667D2c63598');
  });

  it('NEGATIVE CONTROL — an unresolvable contract THROWS and never calls out', async () => {
    const { transport, calls } = recordingTransport(FALSE_WORD);
    const reader = makeRegistryBoundBatchMintedReader(transport);
    await expect(reader.readBatchMinted(`0x${'e'.repeat(64)}`))
      .rejects.toThrow(LegacyMintContractUnresolved);
    // The decisive assertion: it did not fall back to SOME contract and read a
    // `false` from it. No call was made at all.
    expect(calls).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — a document pointed at an unregistered address THROWS, not false', async () => {
    const { transport, calls } = recordingTransport(FALSE_WORD);
    const reader = makeRegistryBoundBatchMintedReader(transport);
    await expect(reader.readBatchMinted(
      `0x${'d'.repeat(64)}`,
      '0x000000000000000000000000000000000000dEaD',
    )).rejects.toThrow(/UNIDENTIFIED/);
    expect(calls).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — `0x` (no code / no such function) THROWS, not false', async () => {
    // A live no-code address returns exactly '0x'. Reading that as `false` is
    // the whole defect class this module exists to close.
    const { transport } = recordingTransport('0x');
    const reader = makeRegistryBoundBatchMintedReader(transport);
    await expect(reader.readBatchMinted(DOCUMENT_MINT_BINDINGS[0].document_id))
      .rejects.toThrow(/non-canonical bool word/);
  });

  it('NEGATIVE CONTROL — a transport error THROWS, not false', async () => {
    const { transport } = recordingTransport(new Error('eth_call HTTP 429'));
    const reader = makeRegistryBoundBatchMintedReader(transport);
    await expect(reader.readBatchMinted(DOCUMENT_MINT_BINDINGS[0].document_id))
      .rejects.toThrow(/429/);
  });

  it('NEGATIVE CONTROL — a short or malformed word THROWS, not false', async () => {
    for (const bad of ['0x01', '', 'not-hex', `0x${'0'.repeat(63)}`]) {
      const { transport } = recordingTransport(bad);
      const reader = makeRegistryBoundBatchMintedReader(transport);
      // eslint-disable-next-line no-await-in-loop
      await expect(reader.readBatchMinted(DOCUMENT_MINT_BINDINGS[0].document_id))
        .rejects.toThrow(/non-canonical bool word/);
    }
  });

  it('NEGATIVE CONTROL — an UNCONFIGURED RPC endpoint THROWS, not false', async () => {
    // The same rule applied to configuration: a chain with no endpoint cannot
    // be reached, so it cannot have answered. Mutating this throw into a zero
    // word would make every unreachable chain report "not minted".
    const transport = makeJsonRpcTransport({}); // nothing configured at all
    await expect(transport.ethCall(8453, '0x00000000000000000000000000000000000000ff', '0x00'))
      .rejects.toThrow(/no RPC endpoint configured for chain 8453/);
    await expect(transport.ethCall(8453, '0x00000000000000000000000000000000000000ff', '0x00'))
      .rejects.toThrow(/refusing to answer rather than answering false/);

    // …and an empty-string endpoint is treated identically, not as "configured".
    await expect(makeJsonRpcTransport({ 8453: '' })
      .ethCall(8453, '0x00000000000000000000000000000000000000ff', '0x00'))
      .rejects.toThrow(/no RPC endpoint configured/);

    // End to end: the reader surfaces it as a throw, never as `false`.
    const reader = makeRegistryBoundBatchMintedReader(makeJsonRpcTransport({}));
    await expect(reader.readBatchMinted(DOCUMENT_MINT_BINDINGS[0].document_id))
      .rejects.toThrow(/no RPC endpoint configured/);
  });

  it('NEGATIVE CONTROL — a well-shaped but NON-CANONICAL bool word THROWS, not false', async () => {
    // . `0x…02`, `0xff…ff`, `0x…10` are what a fallback
    // function, a proxy, or a selector collision returns when `batchMinted` was
    // never actually reached. The old `BigInt(word) === 1n` mapped every one of
    // them to `false` — a "could not reach the function" case wearing the mask of
    // a negative answer, and the INVERSE of what ethers' bool decoder does (it
    // returns true for any nonzero word). Only 0x…00 and 0x…01 are decodable.
    const doc = DOCUMENT_MINT_BINDINGS[0].document_id;
    for (const word of [
      `0x${'0'.repeat(63)}2`,       // 2
      `0x${'f'.repeat(64)}`,        // all ones
      `0x${'0'.repeat(62)}10`,      // 16
      `0x${'1'.repeat(64)}`,        // high bits set
      `0x${'0'.repeat(31)}1${'0'.repeat(32)}`, // nonzero in a high byte only
    ]) {
      const { transport } = recordingTransport(word);
      const reader = makeRegistryBoundBatchMintedReader(transport);
      // eslint-disable-next-line no-await-in-loop
      await expect(reader.readBatchMinted(doc)).rejects.toThrow(/non-canonical bool word/);
    }
  });

  it('decodes ONLY the two canonical bool words, and decodes them correctly', async () => {
    // Pins the decode rule itself, so flipping it (e.g. to `BigInt(w) !== 0n`)
    // is a test failure rather than a silent inversion of every answer.
    const doc = DOCUMENT_MINT_BINDINGS[0].document_id;
    const read = (word: string) =>
      makeRegistryBoundBatchMintedReader(recordingTransport(word).transport)
        .readBatchMinted(doc);
    await expect(read(`0x${'0'.repeat(64)}`)).resolves.toBe(false);
    await expect(read(`0x${'0'.repeat(63)}1`)).resolves.toBe(true);
  });

  it('rejects a document id that is not 32 bytes', () => {
    expect(() => toBytes32Arg('0xdeadbeef')).toThrow(/not a 32-byte hex value/);
    expect(toBytes32Arg(`0x${'A'.repeat(64)}`)).toBe('a'.repeat(64));
  });

  it('EXHAUSTIVE — across every failure mode, `false` is returned exactly once', async () => {
    // The property stated as a single assertion: of the six behaviours below,
    // only the one where the right contract said false yields false.
    const doc = DOCUMENT_MINT_BINDINGS[0].document_id;
    const outcomes: Array<'true' | 'false' | 'threw'> = [];
    const run = async (fn: () => Promise<boolean>) => {
      try { outcomes.push((await fn()) ? 'true' : 'false'); } catch { outcomes.push('threw'); }
    };
    const mk = (reply: string | Error) =>
      makeRegistryBoundBatchMintedReader(recordingTransport(reply).transport);

    await run(() => mk(TRUE_WORD).readBatchMinted(doc));
    await run(() => mk(FALSE_WORD).readBatchMinted(doc));
    await run(() => mk('0x').readBatchMinted(doc));
    await run(() => mk(new Error('boom')).readBatchMinted(doc));
    await run(() => mk(FALSE_WORD).readBatchMinted(`0x${'e'.repeat(64)}`));
    await run(() => mk(FALSE_WORD).readBatchMinted(`0x${'e'.repeat(64)}`, '0x00000000000000000000000000000000000000ff'));

    expect(outcomes).toEqual(['true', 'false', 'threw', 'threw', 'threw', 'threw']);
    expect(outcomes.filter((o) => o === 'false')).toHaveLength(1);
  });
});

describe('the window, and ONE definition of epochZeroStartsAt', () => {
  it('records 2026-08-03 → 2027-01-01 (open through 2026-12-31), now ARMED (Phase 2,)', () => {
    const w = PROPOSED_GENESIS_CAMPAIGN_POLICY.window;
    expect(w.start_ms).toBe(1_785_715_200_000);
    expect(w.end_ms).toBe(1_798_761_600_000);
    expect(new Date(w.start_ms!).toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(new Date(w.end_ms!).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(w.end_ms! - w.start_ms!).toBe(151 * 86_400_000);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.state)
      .toBe('armed_by_explicit_pvt9_activation');
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.grants_enabled).toBe(true);
    for (const b of PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties) {
      expect(b.launch_armed).toBe(true);
      expect(b.activation).toBe('explicit_pvt9_launch_activation');
    }
  });

  it('the ARMED checked-in singleton opens the enqueue gate exactly within the window (Phase 2 + RED control)', () => {
    // Positive: the live gate (proposedArmedGenesisWindow, read through the
    // exported shouldEnqueueGenesisQualification) admits an in-window qualifying
    // act on the CHECKED-IN singleton — this is the operator’s "proposedArmedGenesisWindow()
    // returns the window" done-criterion, observed on the real armed policy.
    const start = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms!;
    const end = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms!;
    for (const action of ['genesis_human_signup', 'genesis_signup', 'genesis_device_link']) {
      expect(shouldEnqueueGenesisQualification(action, start)).toBe(true);
      expect(shouldEnqueueGenesisQualification(action, end)).toBe(true);
    }
    // RED control (window bounds, non-vacuous): one millisecond outside either
    // edge is refused — proving the gate enforces the window and is not a
    // constant-true. A non-Genesis action is refused regardless of timing.
    expect(shouldEnqueueGenesisQualification('genesis_human_signup', start - 1)).toBe(false);
    expect(shouldEnqueueGenesisQualification('genesis_human_signup', end + 1)).toBe(false);
    expect(shouldEnqueueGenesisQualification('not_a_genesis_action', start)).toBe(false);
  });

  it('EXACTLY ONE definition of epochZeroStartsAt exists in the off-chain tree', () => {
    // found a SECOND hardcoded copy in pvt9-arming-inputs.ts that silently
    // kept the old date when the window moved. Zero hits is the strongest form of
    // "exactly one definition": the single definition is DERIVED from the window
    // (`epochZeroStartsAtFromWindow()`), so no date literal is assigned anywhere.
    expect(scanForEpochZeroDefinitions()).toEqual([]);
  });

  it('POSITIVE CONTROL — the REAL scan detects a planted copy in every root and shape', () => {
    // Reviewer defect 5 (first pass): the scan walked one directory while three
    // documents claimed tree-wide.
    // Reviewer defect 1 (second pass): the control added for THAT defect declared
    // its own duplicate copies of ROOTS and DEFINITIONS, so it asserted a property
    // of its own construction and stayed green when the scan itself was narrowed —
    // a guard on a guard that could not fail, the same class again.
    //
    // This control now calls `scanForEpochZeroDefinitions()` — the EXACT function
    // the guard above calls, over the EXACT module-scope ROOTS and DEFINITIONS it
    // uses — after planting a stale copy in each root. Narrowing either constant
    // now turns this test RED.
    const planted: string[] = [];
    try {
      const cases: Array<[string, string, string]> = [
        // [root, filename, stale line] — one per root, and four distinct shapes.
        [EPOCH_ZERO_SCAN_ROOTS[0], '__scan_probe_a.ts',
          "export const A = { epochZeroStartsAt: '2026-08-02T00:00:00Z' };"],
        [EPOCH_ZERO_SCAN_ROOTS[1], '__scan_probe_b.ts',
          "const epochZeroStartsAt = '2026-08-02T00:00:00Z';"],
        [EPOCH_ZERO_SCAN_ROOTS[2], '__scan_probe_c.mjs',
          'export const C = { epochZeroStartsAt: new Date(1785628800000) };'],
        [EPOCH_ZERO_SCAN_ROOTS[2], '__scan_probe_d.mjs',
          'export const D = { epochZeroStartsAt: 1785628800000 };'],
      ];
      for (const [root, name, line] of cases) {
        const full = path.join(root, name);
        fs.writeFileSync(full, `${line}\n`, 'utf8');
        planted.push(full);
      }

      const hits = scanForEpochZeroDefinitions();
      // Every planted copy is found — in every root, in .ts AND .mjs, in all four
      // shapes. A narrowed ROOTS or DEFINITIONS drops at least one and fails here.
      for (const full of planted) {
        const rel = path.relative(EPOCH_ZERO_REPO_ROOT, full);
        expect(hits.some((h) => h.startsWith(`${rel}:`))).toBe(true);
      }
      expect(hits).toHaveLength(planted.length);
    } finally {
      for (const full of planted) {
        try { fs.unlinkSync(full); } catch { /* best effort */ }
      }
    }
    // The tree is left exactly as found, so the guard above still sees zero.
    expect(scanForEpochZeroDefinitions()).toEqual([]);
  });

  it('POSITIVE CONTROL — the scan ignores the legitimate derivation and chain readbacks', () => {
    // The other half: a scan that matched everything would also pass the control
    // above. These must NOT be treated as definitions.
    const planted: string[] = [];
    try {
      const benign = [
        '  epochZeroStartsAt: epochZeroStartsAtFromWindow(),',
        '  readonly epochZeroStartsAtSec: number;',
        'const x = { epochZeroStartsAtSec: Number(await kernel.epochZeroStartsAt()) };',
        "  console.log(`epochZeroStartsAt ${z.epochZeroStartsAtSec}`);",
      ];
      benign.forEach((line, i) => {
        const full = path.join(EPOCH_ZERO_SCAN_ROOTS[0], `__scan_benign_${i}.ts`);
        fs.writeFileSync(full, `${line}\n`, 'utf8');
        planted.push(full);
      });
      expect(scanForEpochZeroDefinitions()).toEqual([]);
    } finally {
      for (const full of planted) {
        try { fs.unlinkSync(full); } catch { /* best effort */ }
      }
    }
  });

  it('the one derivation still equals the window open exactly', async () => {
    const { PVT9_ARMING_INPUTS } = await import('../policy/pvt9-arming-inputs');
    expect(Date.parse(PVT9_ARMING_INPUTS.epochZeroStartsAt))
      .toBe(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms);
    expect(PVT9_ARMING_INPUTS.epochZeroStartsAt).toBe('2026-08-03T00:00:00Z');
  });
});

describe('C11 finality: the LEGACY INLINE batch shape', () => {
  // the fix had zero coverage. Reverting
  // `mint_tx_hash ?? tx_hash` and `legacyInlineFinality` left the whole suite
  // green, so C11 could silently fall back to `vacuous_pass` with
  // evaluated_items 0 — a check reporting a passing status while asserting
  // nothing, which is the exact class this WP exists to eliminate.
  const CUT_LINE = 1_784_938_132_043;
  const tx = `0x${'a'.repeat(64)}`;

  const inventoryWith = async (batches: Record<string, Record<string, unknown>>) => {
    const db = createFakeFirestore();
    for (const [id, doc] of Object.entries(batches)) db.store.set(`pvt_mint_batches/${id}`, doc);
    return takeCutoverInventory(db, { cutLineMs: CUT_LINE });
  };

  it('the LEGACY INLINE shape (tx_hash + merkle_root, NO mint_tx_hash) is FINALIZED', async () => {
    // This is the exact shape of the two surviving production batch documents.
    const inv = await inventoryWith({
      legacy: { tx_hash: tx, merkle_root: '0xroot', total_pvt_minted: '27400000000000000000' },
    });
    const row = inv.legacy_pvtv8.mint_batches[0];
    expect(row.finalized).toBe(true);
    expect(row.mint_tx_hash).toBe(tx);
    expect(row.finality_evidence).toBe('legacy_inline_tx_hash');
    expect(row.marked).toBe(true);
  });

  it('the LATER shape (marked + mint_tx_hash) is FINALIZED and reports the other evidence', async () => {
    const inv = await inventoryWith({ later: { marked: true, mint_tx_hash: tx } });
    const row = inv.legacy_pvtv8.mint_batches[0];
    expect(row.finalized).toBe(true);
    expect(row.finality_evidence).toBe('marked_field');
  });

  it('NEGATIVE CONTROL — tx_hash WITHOUT a merkle root is NOT finalized', async () => {
    // The fallback must not make finality cheaper to claim: an inline doc has to
    // carry the merkle root too, or it is not the durable-finality shape.
    const inv = await inventoryWith({ partial: { tx_hash: tx } });
    const row = inv.legacy_pvtv8.mint_batches[0];
    expect(row.finalized).toBe(false);
    expect(row.finality_evidence).toBe('none');
  });

  it('NEGATIVE CONTROL — a bare unmarked doc is NOT finalized', async () => {
    const inv = await inventoryWith({ bare: { marked: false } });
    const row = inv.legacy_pvtv8.mint_batches[0];
    expect(row.finalized).toBe(false);
    expect(row.mint_tx_hash).toBeNull();
    expect(row.finality_evidence).toBe('none');
  });

  it('the legacy-inline batch REACHES C11 — it is not silently dropped from the population', async () => {
    // The assertion that would have caught a revert: with only a legacy-inline
    // doc present, C11 must evaluate ONE item, not zero.
    const inv = await inventoryWith({
      legacy: { tx_hash: tx, merkle_root: '0xroot', total_pvt_minted: '1' },
    });
    const finalized = inv.legacy_pvtv8.mint_batches.filter((b) => b.finalized);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].batch_id).toBe('legacy');
  });
});

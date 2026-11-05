/**
 * mutation harness for the reader's THROW paths.
 *
 * The directive requires: "An unresolvable contract must THROW, never return
 * false … Mutation-check the throw path." Every mutant below converts one throw
 * into an answer — which is exactly the defect, re-introduced one site at
 * a time. A SURVIVOR means that throw is unguarded and the gate could again read
 * silence as a negative. A mutant marked `equivalent: true` is one that CANNOT be
 * killed because it does not change behaviour on the reachable domain; it is
 * reported under its own label so an unkillable mutant is never counted as a
 * kill, and never quietly deleted either.
 *
 * Two files are mutated: the reader and the registry resolver it depends on.
 * Source is restored byte-identical (SHA-256 verified) on every exit path.
 *
 * node scripts/wp12r2-reader-mutation.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CUTOVER_ROOT = path.join(HERE, '..', 'src', 'core', 'pvt', 'wp11');
const READER = path.join(CUTOVER_ROOT, 'legacy-batch-minted-reader.ts');
const REGISTRY = path.join(CUTOVER_ROOT, 'legacy-mint-contract-registry.ts');
const INVENTORY = path.join(CUTOVER_ROOT, 'cutover-inventory.ts');
const SUITE = 'src/core/pvt/wp11/';

const PVTV8 = "{ address: '0x50D6F1Ff28CcaC80B548946F27701016C01f4BAa', chainId: 8453 as const, source: 'receipt' as const }";

/**
 * Each mutant turns exactly one THROW into an answer, or reverts one S5 defect
 * fix. The C11 finality mutants exist because the reviewer proved the
 * fix had NO coverage: reverting it left the whole suite green while C11 fell
 * back to `vacuous_pass` over zero items.
 */
const MUTANTS = [
  {
    file: INVENTORY,
    name: 'C11 finality: drop the tx_hash fallback (revert the S5 field-name fix)',
    from: "  const mintTxHash = asString(batch?.mint_tx_hash) ?? asString(batch?.tx_hash);",
    to: '  const mintTxHash = asString(batch?.mint_tx_hash);',
  },
  {
    file: INVENTORY,
    name: 'C11 finality: disable the legacy-inline shape entirely',
    from: "  const legacyInlineFinality = batch !== null",
    to: '  const legacyInlineFinality = false && batch !== null',
  },
  {
    file: INVENTORY,
    name: 'C11 finality: drop the merkle-root conjunct (make finality cheaper to claim)',
    from: "    && asString(batch?.merkle_root) !== null;",
    to: '    && true;',
  },
  {
    file: INVENTORY,
    name: 'C2/C3: drop orphan snapshots from the population (revert the S5 scope fix)',
    from: "  const orphanSnapshotRows = orphanSnapshotEntries\n    .map(({ id, row }) => deriveBatchRow(id, null, row));",
    to: '  const orphanSnapshotRows = [];',
  },
  {
    file: REGISTRY,
    name: 'unregistered recorded address -> fall back to PVTv8 (the defect)',
    from: `    if (row === undefined) {
      throw new LegacyMintContractUnresolved(`,
    to: `    if (row === undefined) {
      return ${PVTV8};
      throw new LegacyMintContractUnresolved(`,
  },
  {
    file: REGISTRY,
    name: 'no binding and no recorded address -> fall back to PVTv8',
    from: `  throw new LegacyMintContractUnresolved(
    documentId,
    'no mint-transaction binding`,
    to: `  return ${PVTV8};
  throw new LegacyMintContractUnresolved(
    documentId,
    'no mint-transaction binding`,
  },
  {
    file: REGISTRY,
    name: 'accept ANY recorded address without consulting the registry',
    from: '    const row = REGISTRY_BY_ADDRESS.get(recordedContractAddress.trim().toLowerCase());',
    to: '    const row = REGISTRY_BY_ADDRESS.get(recordedContractAddress.trim().toLowerCase())\n      ?? { address: recordedContractAddress, chain_id: 8453 };',
  },
  {
    file: READER,
    name: 'non-bool word -> return false instead of throwing',
    from: `      if (typeof word !== 'string' || !CANONICAL_BOOL_WORD.test(word)) {`,
    to: `      if (typeof word !== 'string' || !CANONICAL_BOOL_WORD.test(word)) {
        return false;`,
  },
  {
    file: READER,
    name: 'drop the bool-word shape check entirely',
    from: "      if (typeof word !== 'string' || !CANONICAL_BOOL_WORD.test(word)) {",
    to: '      if (false) {',
  },
  {
    file: READER,
    name: 'swallow a resolution throw and answer false',
    from: '      const target = resolveMintContractForDocument(documentId, recordedContractAddress);',
    to: `      let target;
      try {
        target = resolveMintContractForDocument(documentId, recordedContractAddress);
      } catch {
        return false;
      }`,
  },
  {
    file: READER,
    name: 'swallow a transport error and answer false',
    from: '      const word = await transport.ethCall(target.chainId, target.address, data);',
    to: `      let word;
      try {
        word = await transport.ethCall(target.chainId, target.address, data);
      } catch {
        return false;
      }`,
  },
  {
    file: READER,
    name: 'ignore the resolved contract and query PVTv8 unconditionally',
    from: '      const word = await transport.ethCall(target.chainId, target.address, data);',
    to: "      const word = await transport.ethCall(target.chainId, '0x50D6F1Ff28CcaC80B548946F27701016C01f4BAa', data);",
  },
  {
    file: READER,
    name: 'accept ANY 32-byte word as a bool (the loose BOOL_WORD form)',
    from: "const CANONICAL_BOOL_WORD = /^0x0{63}[01]$/;",
    to: "const CANONICAL_BOOL_WORD = /^0x[0-9a-fA-F]{64}$/;",
  },
  {
    file: READER,
    name: 'invert the bool decode (nonzero => true, as ethers does)',
    from: "      return word.endsWith('1');",
    to: '      return BigInt(word) !== 0n;',
    // EQUIVALENT MUTANT, and recorded as one rather than papered over with a
    // contrived test. `CANONICAL_BOOL_WORD` admits ONLY 0x0…0 and 0x0…1, so on
    // the reachable domain `word.endsWith('1')` and `BigInt(word) !== 0n` agree
    // on both inputs. This mutant WOULD have been killed before the defect-2
    // fix (the loose word regex let 0x…02 through, where the two disagree) —
    // tightening the regex is precisely what made it unkillable. A survivor
    // here is proof the domain is narrow, not proof the decode is unguarded;
    // the decode rule itself is pinned by the "decodes ONLY the two canonical
    // bool words" test.
    equivalent: true,
  },
  {
    file: READER,
    name: 'unconfigured RPC endpoint -> answer false instead of throwing',
    from: `      if (url === undefined || url === '') {
        throw new Error(`,
    to: `      if (url === undefined || url === '') {
        return '0x' + '0'.repeat(64);
        throw new Error(`,
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
    execFileSync('npx', ['jest', SUITE, '--silent'], {
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
try {
  if (!runSuite()) {
    console.error('BASELINE RED — the suite fails before any mutation. Aborting.');
    process.exit(2);
  }
  console.log('baseline GREEN\n');

  for (const mutant of MUTANTS) {
    const src = sources.get(mutant.file);
    if (!src.includes(mutant.from)) {
      console.log(`ERROR   ${mutant.name} — anchor text not found (source moved?)`);
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
      console.log(`SURVIVED ${mutant.name}  <-- UNGUARDED THROW`);
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
process.exit(survived === 0 && errored === 0 ? 0 : 1);

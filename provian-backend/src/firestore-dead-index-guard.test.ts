/**
 * The two dead `pe_history` composite indexes on the retired `minted` field
 * are DELETED from the declared index file, and nothing in
 * the tree may grow a query shape that would need them back.
 *
 * Negative-control doctrine: the detector is driven with a planted
 * `.where('minted', …).orderBy(…)` and must name it; the real-tree assertion
 * prints and checks the evaluated population (the surviving single-field
 * equality queries in scripts/) so a pass over zero files is not a pass.
 */

import fs from 'fs';
import path from 'path';
import {
  findLegacyMintStatusPeHistoryIndexes,
  findMintedPeHistoryIndexes,
  findMintedQueries,
  type DeclaredIndex,
} from './firestore-dead-index-guard';

const BACKEND_ROOT = path.resolve(__dirname, '..');
const INDEX_FILE = path.join(BACKEND_ROOT, 'firestore.indexes.json');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('dead pe_history indexes on `minted` ', () => {
  it('the declared index file carries NO pe_history composite index on `minted`', () => {
    const declared = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).indexes as DeclaredIndex[];
    expect(declared.length).toBeGreaterThan(20); // non-empty population
    expect(findMintedPeHistoryIndexes(declared)).toEqual([]);
  });

  it('the declared index file carries NONE of the three legacy mint_status-led timestamp-ordered shapes (deleted live after the H5 cutover)', () => {
    const declared = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).indexes as DeclaredIndex[];
    // Non-empty population: the sharded twins and the KEPT (mint_status, peId)
    // inlet index must still be declared, or this assertion is over nothing.
    const peHistory = declared.filter((i) => i.collectionGroup === 'pe_history');
    expect(peHistory.filter((i) => i.fields?.[0]?.fieldPath === 'index_shard')).toHaveLength(3);
    expect(peHistory.some((i) => i.fields?.map((f) => f.fieldPath).join(',') === 'mint_status,peId')).toBe(true);
    expect(findLegacyMintStatusPeHistoryIndexes(declared)).toEqual([]);
  });

  it('CONTROL: the legacy-shape detector names each of the three re-grown shapes and spares the kept inlet index', () => {
    const planted: DeclaredIndex[] = [
      { collectionGroup: 'pe_history', fields: [{ fieldPath: 'mint_status' }, { fieldPath: 'timestamp' }] },
      { collectionGroup: 'pe_history', fields: [{ fieldPath: 'mint_status' }, { fieldPath: 'jurisdiction_context' }, { fieldPath: 'timestamp' }] },
      { collectionGroup: 'pe_history', fields: [{ fieldPath: 'mint_status' }, { fieldPath: 'timestamp' }, { fieldPath: 'peId' }] },
      { collectionGroup: 'pe_history', fields: [{ fieldPath: 'mint_status' }, { fieldPath: 'peId' }] },
      { collectionGroup: 'pe_history', fields: [{ fieldPath: 'index_shard' }, { fieldPath: 'mint_status' }, { fieldPath: 'timestamp' }] },
      { collectionGroup: 'other', fields: [{ fieldPath: 'mint_status' }, { fieldPath: 'timestamp' }] },
    ];
    expect(findLegacyMintStatusPeHistoryIndexes(planted)).toEqual(planted.slice(0, 3));
  });

  it('CONTROL: the index detector names a re-grown `minted` index', () => {
    const planted: DeclaredIndex[] = [
      { collectionGroup: 'pe_history', fields: [{ fieldPath: 'minted' }, { fieldPath: 'timestamp' }] },
      { collectionGroup: 'other', fields: [{ fieldPath: 'minted' }] },
      { collectionGroup: 'pe_history', fields: [{ fieldPath: 'userId' }, { fieldPath: 'timestamp' }] },
    ];
    expect(findMintedPeHistoryIndexes(planted)).toEqual([planted[0]]);
  });

  it('every query on `minted` in src/ and scripts/ is a single-field equality — none carries an orderBy', () => {
    const files = [...walk(path.join(BACKEND_ROOT, 'src')), ...walk(path.join(BACKEND_ROOT, 'scripts'))];
    const findings = files.flatMap((file) => findMintedQueries(path.relative(BACKEND_ROOT, file), fs.readFileSync(file, 'utf8')));
    // Empty-population guard: the surviving equality queries really exist and
    // were really evaluated (the three legacy scripts OPEN_ITEMS names).
    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(new Set(findings.map((f) => f.file))).toEqual(new Set([
      'scripts/migrate-mint-status.ts',
      'scripts/count-pe-data.ts',
      'scripts/count-pe-data2.ts',
    ]));
    expect(findings.filter((f) => f.ordered)).toEqual([]);
  });

  it('CONTROL: the query detector names a planted `minted` query with an orderBy', () => {
    const planted = [
      "const q = db.collection('pe_history')",
      "  .where('minted', '==', false)",
      "  .orderBy('timestamp', 'asc')",
      '  .limit(10);',
      'const fine = db.collection(\'pe_history\').where("minted", "==", true).get();',
    ].join('\n');
    const findings = findMintedQueries('planted.ts', planted);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ line: 2, ordered: true });
    expect(findings[1]).toMatchObject({ line: 5, ordered: false });
  });
});

import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { AbiCoder, sha256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { authenticateBreakArtifact, storeBreakArtifact, readStoredBreakArtifact, BREAK_ARTIFACTS } from './break-artifact-store';
import type { RestorationSuccessionLineage } from './restoration-lineage';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
function fixture(ownerCount = 1) {
  const predecessor = a(1), origin = a(2), kernel = a(3), block = 100, coder = AbiCoder.defaultAbiCoder();
  const leaf = (label: string, types: string[], values: unknown[]) => sha256(coder.encode(
    ['string', 'address', 'uint256', ...types], [label, predecessor, block, ...values]));
  const entries: Record<string, unknown>[] = Array.from({ length: ownerCount }, (_, index) => ({ kind: 'owner', identity: h(index + 1),
    amount: '100', commitment: h(9000 + index), signingRoot: h(12000 + index), accounts: [{ account: a(500 + index), amount: '100' }],
    leaf: leaf('Provian restoration', ['bytes32', 'uint256', 'bytes32'], [h(index + 1), 100, h(9000 + index)]) }));
  entries.push({ kind: 'institution-count', count: 0, amount: '0', leaf: leaf('Provian institution restoration count', ['uint256', 'uint256'], [0, 0]) },
    { kind: 'reversal-count', count: 0, leaf: leaf('Provian reversal history count', ['uint256'], [0]) });
  // Invoke the actual snapshot builder's tree routine, rather than reimplementing
  // its odd-node and sibling-order rules in the test fixture.
  const moduleUrl = pathToFileURL(resolve(__dirname, '../../../../scripts/recourse/snapshot.mjs')).href;
  const tree = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {merkle} from ${JSON.stringify(moduleUrl)};let input='';for await(const chunk of process.stdin)input+=chunk;process.stdout.write(JSON.stringify(merkle(JSON.parse(input))));`],
  { input: JSON.stringify(entries.map(entry => entry.leaf)), encoding: 'utf8' })) as { root: string; proofs: string[][] };
  const artifact = { format: 'provian-break-ownership-snapshot', predecessor, block, root: tree.root, unrelated: 'must-not-be-stored',
    entries: entries.map((entry, index) => ({ ...entry, proof: tree.proofs[index] })) };
  const chain: RestorationSuccessionLineage = { kernel, executor: origin, manifestHash: h(99), migrations: [{
    kernel, executor: origin, predecessor, cutoff: block, cutoffHash: h(block), root: tree.root, kind: 'cryptographic_break' }] };
  const lineage = jest.fn(async (_predecessor: string) => chain), fake = createFakeFirestore(), db = fake as unknown as Firestore;
  return { origin, artifact, chain, lineage, fake, db, manifest: `${BREAK_ARTIFACTS}/${origin.slice(2)}` };
}
test('complete artifacts span bounded chunks, omit uncommitted metadata, and reauthenticate on every read', async () => {
  const f = fixture(400);
  await storeBreakArtifact(f.db, f.origin, f.artifact, f.lineage);
  const manifest = f.fake.store.get(f.manifest)!;
  expect(Number(manifest.chunks)).toBeGreaterThan(1);
  const serialized = JSON.stringify([...f.fake.store.values()]);
  for (const field of ['accounts', 'signingRoot', 'must-not-be-stored']) expect(serialized).not.toContain(field);
  expect((await readStoredBreakArtifact(f.db, f.origin, f.lineage)).owners).toHaveLength(400);
  expect(f.lineage).toHaveBeenCalledTimes(3);
  const size = f.fake.store.size;
  await storeBreakArtifact(f.db, f.origin, f.artifact, f.lineage);
  expect(f.fake.store.size).toBe(size);
  f.lineage.mockResolvedValue({ ...f.chain, migrations: [] });
  await expect(readStoredBreakArtifact(f.db, f.origin, f.lineage)).rejects.toThrow('origin_unrelated');
});
test('interrupted chunk writes cannot publish a usable manifest; a clean retry is idempotent', async () => {
  const f = fixture();
  f.lineage.mockResolvedValueOnce(f.chain).mockRejectedValueOnce(Error('changed'));
  await expect(storeBreakArtifact(f.db, f.origin, f.artifact, f.lineage)).rejects.toThrow('changed');
  expect(f.fake.store.size).toBeGreaterThan(0); expect(f.fake.store.has(f.manifest)).toBe(false);
  await expect(readStoredBreakArtifact(f.db, f.origin, f.lineage)).rejects.toThrow('manifest_missing');
  await storeBreakArtifact(f.db, f.origin, f.artifact, f.lineage);
  expect((await readStoredBreakArtifact(f.db, f.origin, f.lineage)).owners).toHaveLength(1);
});
test('missing or corrupted chunks cannot alter authority or be overwritten on retry', async () => {
  for (const change of ['missing', 'content', 'index'] as const) {
    const f = fixture(); await storeBreakArtifact(f.db, f.origin, f.artifact, f.lineage);
    const chunkKey = [...f.fake.store.keys()].find(key => key !== f.manifest)!;
    const chunk = f.fake.store.get(chunkKey)!;
    if (change === 'missing') f.fake.store.delete(chunkKey);
    else f.fake.store.set(chunkKey, change === 'content' ? { ...chunk, text: String(chunk.text).replace('100', '101') } : { ...chunk, index: 1 });
    await expect(readStoredBreakArtifact(f.db, f.origin, f.lineage)).rejects.toThrow();
    if (change !== 'missing') await expect(storeBreakArtifact(f.db, f.origin, f.artifact, f.lineage)).rejects.toThrow('chunk_conflict');
  }
});
test('a matching-looking file cannot substitute an ordinary or unrelated origin', async () => {
  const f = fixture();
  await expect(authenticateBreakArtifact(a(88), f.artifact, f.lineage)).rejects.toThrow('origin_unrelated');
  f.lineage.mockResolvedValue({ ...f.chain, migrations: f.chain.migrations.map(migration => ({ ...migration, kind: 'ordinary' })) });
  await expect(storeBreakArtifact(f.db, f.origin, f.artifact, f.lineage)).rejects.toThrow('origin_unrelated');
  expect(f.fake.store.size).toBe(0);
});
test('a complete older artifact can be backfilled after later succession without publishing old owner credentials', async () => {
  const f = fixture();
  f.lineage.mockResolvedValue({ ...f.chain, kernel: a(80), executor: a(81), migrations: [...f.chain.migrations, {
    kernel: a(80), executor: a(81), predecessor: f.chain.kernel, cutoff: 200, cutoffHash: h(200), root: h(300), kind: 'cryptographic_break' }] });
  await storeBreakArtifact(f.db, f.origin, f.artifact, f.lineage);
  expect((await readStoredBreakArtifact(f.db, f.origin, f.lineage)).domain.root).toBe(f.artifact.root);
  expect([...f.fake.store.keys()].every(path => path.startsWith(`${BREAK_ARTIFACTS}/`))).toBe(true);
});

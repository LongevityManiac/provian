import { beforeAll, describe, expect, test } from 'vitest';
import { AbiCoder, sha256 } from 'ethers';
import { verifyBreakArtifact } from './break-artifact.js';
let merkle: (leaves: readonly string[]) => { root: string; proofs: string[][] };
beforeAll(async () => { ({ merkle } = await import('../../scripts/recourse/snapshot.mjs')); });
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const coder = AbiCoder.defaultAbiCoder();
function fixture() {
  const predecessor = a(1), block = 100;
  const leaf = (name: string, types: string[], values: unknown[]) => sha256(coder.encode(
    ['string', 'address', 'uint256', ...types], [name, predecessor, block, ...values]));
  const entries = [
    { kind: 'owner', identity: h(1), amount: '100', commitment: h(2), accounts: [{ account: a(4), amount: '100' }], signingRoot: h(3),
      leaf: leaf('Provian restoration', ['bytes32', 'uint256', 'bytes32'], [h(1), 100, h(2)]) },
    { kind: 'owner', identity: h(4), amount: '0', commitment: h(5), accounts: [], signingRoot: h(6),
      leaf: leaf('Provian restoration', ['bytes32', 'uint256', 'bytes32'], [h(4), 0, h(5)]) },
    { kind: 'institution-count', count: 0, amount: '0', leaf: leaf('Provian institution restoration count', ['uint256', 'uint256'], [0, 0]) },
    { kind: 'reversal-count', count: 0, leaf: leaf('Provian reversal history count', ['uint256'], [0]) },
  ];
  const tree = merkle(entries.map(entry => entry.leaf));
  const domain = { predecessor, block, root: tree.root as string };
  const artifact = { format: 'provian-break-ownership-snapshot', ...domain,
    entries: entries.map((entry, index) => ({ ...entry, proof: tree.proofs[index] as string[] })) };
  return { domain, artifact };
}
describe('complete break artifacts', () => {
  test('institution and restoration-history leaves reconcile their committed counts and amounts', () => {
    const { artifact, domain } = fixture();
    const encode = (name: string, types: string[], values: unknown[]) => sha256(coder.encode(
      ['string', 'address', 'uint256', ...types], [name, domain.predecessor, domain.block, ...values]));
    const entries: Record<string, unknown>[] = [...artifact.entries.slice(0, 2),
      { kind: 'institution', source: a(10), destination: a(11), amount: '7', runtimeHash: h(10),
        leaf: encode('Provian institution restoration', ['address', 'address', 'uint256', 'bytes32'], [a(10), a(11), 7, h(10)]) },
      { kind: 'institution-count', count: 1, amount: '7',
        leaf: encode('Provian institution restoration count', ['uint256', 'uint256'], [1, 7]) },
      { kind: 'reversal', request: h(11), identity: h(1), shortfall: '5', evidenceHash: h(12),
        leaf: encode('Provian reversal history', ['bytes32', 'bytes32', 'uint256', 'bytes32'], [h(11), h(1), 5, h(12)]) },
      { kind: 'intent', request: h(13), identity: h(4), destination: a(12), lossHash: h(14), maximumLoss: '9',
        leaf: encode('Provian pending restoration intent', ['tuple(bytes32,bytes32,address,bytes32,uint256)'], [[h(13), h(4), a(12), h(14), 9]]) },
      { kind: 'reversal-count', count: 2, leaf: encode('Provian reversal history count', ['uint256'], [2]) },
    ];
    function assembled() {
      const tree = merkle(entries.map(entry => String(entry.leaf)));
      return { root: tree.root, artifact: { ...artifact, root: tree.root, entries: entries.map((entry, i) => ({ ...entry, proof: tree.proofs[i] })) } };
    }
    const complete = assembled();
    expect(verifyBreakArtifact(complete.artifact, { ...domain, root: complete.root }).owners).toHaveLength(2);
    entries[3] = { kind: 'institution-count', count: 1, amount: '8',
      leaf: encode('Provian institution restoration count', ['uint256', 'uint256'], [1, 8]) };
    const changed = assembled();
    // Even a root containing an inconsistent count cannot yield a usable artifact.
    expect(() => verifyBreakArtifact(changed.artifact, { ...domain, root: changed.root })).toThrow('incomplete');
  });
  test('complete root authenticates owner presence and absence but never the serialized account partition', () => {
    const { artifact, domain } = fixture(), checked = verifyBreakArtifact(artifact, domain);
    expect(checked.owners.map(owner => owner.identity)).toEqual([h(1), h(4)]);
    expect(checked.owners.some(owner => owner.identity === h(99))).toBe(false);
    expect(checked.owners[0]).not.toHaveProperty('accounts'); expect(checked.owners[0]).not.toHaveProperty('signingRoot');
    artifact.entries[0].accounts = [{ account: a(99), amount: '100' }]; artifact.entries[0].signingRoot = h(999);
    expect(verifyBreakArtifact(artifact, domain)).toEqual(checked);
    expect(Object.isFrozen(checked.owners[0].proof)).toBe(true);
  });
  test('valid individual proofs with an omitted owner cannot prove that owner absent', () => {
    const { artifact, domain } = fixture();
    artifact.entries.splice(1, 1);
    expect(() => verifyBreakArtifact(artifact, domain)).toThrow('incomplete');
  });
  test('duplicate owner, altered proof, substituted cutoff or root refuses', () => {
    const { artifact, domain } = fixture();
    expect(() => verifyBreakArtifact({ ...artifact, entries: [...artifact.entries, artifact.entries[0]] }, domain)).toThrow('duplicate_owner');
    expect(() => verifyBreakArtifact(artifact, { ...domain, block: 101 })).toThrow('domain_invalid');
    expect(() => verifyBreakArtifact(artifact, { ...domain, root: h(999) })).toThrow('domain_invalid');
    artifact.entries[0].proof[0] = h(999);
    expect(() => verifyBreakArtifact(artifact, domain)).toThrow('proof_invalid');
  });
  test('amount and leaf metadata cannot change aggregate authority', () => {
    for (const amount of ['101', '-1', '01', (1n << 256n).toString()]) {
      const { artifact, domain } = fixture(); artifact.entries[0].amount = amount;
      expect(() => verifyBreakArtifact(artifact, domain)).toThrow();
    }
    const { artifact, domain } = fixture(); artifact.entries[0].leaf = h(999);
    expect(() => verifyBreakArtifact(artifact, domain)).toThrow('proof_invalid');
  });
  test('missing typed counts and unknown leaves cannot be silently discarded', () => {
    const { artifact, domain } = fixture();
    expect(() => verifyBreakArtifact({ ...artifact, entries: artifact.entries.slice(0, 2) }, domain)).toThrow('incomplete');
    artifact.entries[2].kind = 'unknown';
    expect(() => verifyBreakArtifact(artifact, domain)).toThrow('kind_invalid');
  });
});

/**
 * closed-loop-detector (, Prompt 3). Proven on synthetic rings/patterns. The three required
 * shapes: a closed ring IS flagged; an outward (sensor-like) pattern is NOT; a never-before-cited
 * public origin is NOT. RED controls: a ring that also cites the outside world is not closed; a
 * detector that flagged "cited by no one else" would fail the never-cited test.
 */

import { detectClosedLoopOwners, type ClosedLoopDeps } from './closed-loop-detector';

/** owner->signer map (external owners absent) + signer->owners citation graph. */
function deps(ownerSigner: Record<string, string>, graph: Record<string, string[]>): ClosedLoopDeps {
  return {
    ownerToSigner: async (owner) => ownerSigner[owner] ?? null,
    readOutEdgeOwners: async (signer) => graph[signer] ?? [],
  };
}

// Owners are the wallets' addresses; ownerToSigner maps each to its wallet.
const oA = 'evm:0xaaa', oB = 'evm:0xbbb', oC = 'evm:0xccc';
const ownerSigner = { [oA]: 'A', [oB]: 'B', [oC]: 'C' };

describe('detectClosedLoopOwners', () => {
  it('CLOSED RING (A->B->C->A, citing only each other) -> flags the cited owner', async () => {
    const d = deps(ownerSigner, { A: [oB], B: [oC], C: [oA] });
    const r = await detectClosedLoopOwners(d, { signer: 'A', candidateOwners: [oB] });
    expect(r.closedLoopOwners.has(oB)).toBe(true);
    expect([...r.clusterMembers].sort()).toEqual(['A', 'B', 'C']);
    expect(r.unresolvable).toBe(false);
  });

  // Trust Layer build (one graph): a `pe:` CONSUMPTION edge is a leaf, not a ring, unless the walk
  // cycles back. A cites B's PE; B cites nothing (or only C, who cites nothing) → nothing flagged.
  const peB = 'signer:B', peC = 'signer:C';
  const peOwners = { [peB]: 'B', [peC]: 'C', 'signer:A': 'A' };
  it('a LEAF `pe:` citation (A->B, B cites nothing) is NOT a ring — the ordinary consumption shape', async () => {
    const d = deps(peOwners, { A: [peB], B: [] });
    const r = await detectClosedLoopOwners(d, { signer: 'A', candidateOwners: [peB], ringRequiredOwners: new Set([peB]) });
    expect(r.closedLoopOwners.size).toBe(0);
    expect(r.unresolvable).toBe(false);
  });
  it('a DAG `pe:` chain (A->B->C, C cites nothing) is NOT a ring', async () => {
    const d = deps(peOwners, { A: [peB], B: [peC], C: [] });
    const r = await detectClosedLoopOwners(d, { signer: 'A', candidateOwners: [peB], ringRequiredOwners: new Set([peB]) });
    expect(r.closedLoopOwners.size).toBe(0);
  });
  // RED control for the cycle rule: the SAME chain with C citing back to A IS a ring.
  it('RED — the same `pe:` chain closed by C->A IS flagged', async () => {
    const d = deps(peOwners, { A: [peB], B: [peC], C: ['signer:A'] });
    const r = await detectClosedLoopOwners(d, { signer: 'A', candidateOwners: [peB], ringRequiredOwners: new Set([peB]) });
    expect(r.closedLoopOwners.has(peB)).toBe(true);
  });
  // RED control: a PRICED owner keeps the closure rule — the same
  // leaf/DAG shape over an `evm:` owner that cites nothing IS a closed cluster and IS flagged
  // (one operator's second wallet, cited by the first, citing nothing else).
  it('RED — a LEAF citation over a PRICED (non-pe) owner IS flagged: closure, not cycle, is the rule', async () => {
    const leaf = deps({ [oA]: 'A', [oB]: 'B' }, { A: [oB], B: [] });
    const r1 = await detectClosedLoopOwners(leaf, { signer: 'A', candidateOwners: [oB] });
    expect(r1.closedLoopOwners.has(oB)).toBe(true);
    const dag = deps(ownerSigner, { A: [oB], B: [oC], C: [] });
    const r2 = await detectClosedLoopOwners(dag, { signer: 'A', candidateOwners: [oB] });
    expect(r2.closedLoopOwners.has(oB)).toBe(true);
    // And a MIXED PE: the pe: owner (leaf) is exempt while the priced owner in the same cluster is flagged.
    const mixed = deps({ ...peOwners, [oB]: 'B' }, { A: [peB, oB], B: [] });
    const r3 = await detectClosedLoopOwners(mixed, { signer: 'A', candidateOwners: [peB, oB], ringRequiredOwners: new Set([peB]) });
    expect(r3.closedLoopOwners.has(oB)).toBe(true);
    expect(r3.closedLoopOwners.has(peB)).toBe(false);
  });

  it('a mutual PAIR (A<->B, only each other) is a closed ring', async () => {
    const d = deps({ [oA]: 'A', [oB]: 'B' }, { A: [oB], B: [oA] });
    const r = await detectClosedLoopOwners(d, { signer: 'A', candidateOwners: [oB] });
    expect(r.closedLoopOwners.has(oB)).toBe(true);
  });

  // RED control: the SAME ring, but one member ALSO cites an external party -> cluster cites
  // outward -> NOT closed -> nothing flagged (witnessed stuffing residual, accepted eyes-open).
  it('RED — a ring that ALSO cites the outside world is NOT flagged', async () => {
    const d = deps(ownerSigner, { A: [oB], B: [oC], C: [oA, 'domain:arxiv.org'] });
    const r = await detectClosedLoopOwners(d, { signer: 'A', candidateOwners: [oB] });
    expect(r.closedLoopOwners.size).toBe(0);
    expect(r.clusterMembers.size).toBe(0);
  });

  it('OUTWARD (sensor-like): many wallets cite ONE external lab -> NOT flagged, lab counts', async () => {
    // The detector only looks at whether the cited owner is a signer + closure — never target
    // popularity. Even if 1000 wallets cite the lab, citing it is outward and counts.
    const d = deps({}, { S: ['domain:calibration-lab.example'] });
    const r = await detectClosedLoopOwners(d, {
      signer: 'S', candidateOwners: ['domain:calibration-lab.example'],
    });
    expect(r.closedLoopOwners.size).toBe(0);
  });

  it('NEVER-BEFORE-CITED public origin -> NOT flagged (cited-by-no-one-else is not the signal)', async () => {
    // ownerToSigner returns null (external) and no one else has an edge to it.
    const d = deps({}, {});
    const r = await detectClosedLoopOwners(d, { signer: 'S', candidateOwners: ['doi-registrant:10.9999'] });
    expect(r.closedLoopOwners.size).toBe(0);
    expect(r.unresolvable).toBe(false);
  });

  it('a legitimate wallet citing external parties is never in a loop', async () => {
    const d = deps(ownerSigner, { A: ['domain:openai.com', 'domain:arxiv.org'] });
    const r = await detectClosedLoopOwners(d, {
      signer: 'A', candidateOwners: ['domain:openai.com', 'domain:arxiv.org'],
    });
    expect(r.closedLoopOwners.size).toBe(0);
  });

  it('a too-large cluster is not flagged (bounded, conservative)', async () => {
    // A long chain exceeding maxCluster: not provably a small closed ring -> not flagged.
    const os: Record<string, string> = {}; const g: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) { os[`evm:0x${i}`] = `W${i}`; g[`W${i}`] = [`evm:0x${(i + 1) % 10}`]; }
    const d = deps(os, g);
    const r = await detectClosedLoopOwners(d, { signer: 'W0', candidateOwners: ['evm:0x1'], maxCluster: 3 });
    expect(r.closedLoopOwners.size).toBe(0);
  });

  it('RED — a read error is unresolvable (nothing flagged; origins count normally)', async () => {
    const d: ClosedLoopDeps = {
      ownerToSigner: async () => 'B',
      readOutEdgeOwners: async () => { throw new Error('graph read failed'); },
    };
    const r = await detectClosedLoopOwners(d, { signer: 'A', candidateOwners: [oB] });
    expect(r.unresolvable).toBe(true);
    expect(r.closedLoopOwners.size).toBe(0);
  });

  it('empty candidates -> nothing to flag', async () => {
    const r = await detectClosedLoopOwners(deps({}, {}), { signer: 'A', candidateOwners: [] });
    expect(r.closedLoopOwners.size).toBe(0);
  });
});

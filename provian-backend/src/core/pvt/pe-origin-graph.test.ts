/**
 * Trust Layer build (§2.1–§2.4) — the ONE graph with `pe:` consumption edges.
 * Every counting claim ships with its RED control in-suite (a guard that cannot fail is not evidence).
 */

import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { resolveOriginPricingInputs } from './origin-pricing-inputs';
import {
  ORIGIN_REFERENCE_GRAPH_COLLECTION,
  readOwnerInEdges,
  readPeInEdges,
  readSignerOutEdgeDocs,
  readClosedLoopEdges,
  summarizeConsumption,
  countHumanApprovalsCited,
  originEdgeId,
  type OriginEdge,
} from './origin-reference-graph';
import { resolvePeOrigins } from './pe-origin-resolver';
import type { BeneficiaryCacheEntry } from './beneficiary';
import type { InputOrigin } from '../provenance/input-origins';
import type { SealedWitness } from './origin-independence';
import type { Firestore } from 'firebase-admin/firestore';

const cache = {} as never;
const UNLINKED: BeneficiaryCacheEntry = {
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
};
const unlinkedBeneficiary = async (): Promise<BeneficiaryCacheEntry> => UNLINKED;
const WITNESS: SealedWitness = { identity: 'daemon_b', tier: 'software' };
const addr = (c: string) => `0x${c.repeat(40)}`;

function db(): FakeFirestore { return createFakeFirestore(); }
const fs = (d: FakeFirestore) => d as unknown as Firestore;

function seedPe(d: FakeFirestore, peId: string, userId: string, actionType = 'coding_session'): void {
  d.store.set(`pe_history/${peId}`, { peId, userId, actionType, timestamp: 1 });
}
function seedEdge(d: FakeFirestore, e: Partial<OriginEdge> & { signer: string; owner: string | null; pe_id: string; origin_identifier: string }): void {
  const hash = e.hash ?? `sha256:${'0'.repeat(64)}`;
  d.store.set(`${ORIGIN_REFERENCE_GRAPH_COLLECTION}/${originEdgeId(e.pe_id, e.origin_identifier, hash)}`, {
    schema_version: 'origin-reference-graph-edge/v1',
    witnessed: true, counted: false, recorded_at_ms: 1, hash,
    scheme: e.origin_identifier.startsWith('pe:') ? 'pe' : 'evm',
    reason: 'consumption_edge', closed_loop: false,
    ...e,
  });
}
const origin = (id: string, witnessed = true, hash?: string): InputOrigin => ({
  hash: hash ?? `sha256:${id.replace(/[^a-z0-9]/gi, '').padEnd(64, '0').slice(0, 64)}`,
  origin_identifier: id,
  witnessed,
  ...(witnessed ? { witness: { type: 'observer_device', identity: 'daemon_b' } } : {}),
});
const base = (actor: string, peId: string) => ({
  economicActorId: actor, walletAddress: null as string | null, peId, nowMs: 1000,
  submissionWitness: WITNESS as SealedWitness | null,
  witnessObservedTokens: null as number | null, bodyDeclaredTokens: null as number | null,
});
const edgesOf = (d: FakeFirestore): OriginEdge[] =>
  [...d.store.entries()].filter(([k]) => k.startsWith(`${ORIGIN_REFERENCE_GRAPH_COLLECTION}/`)).map(([, v]) => v as unknown as OriginEdge);

describe('§2.1/§2.2 — a `pe:` origin is a CONSUMPTION edge that adds ZERO', () => {
  it('declared pe: origin → reason consumption_edge, count 0, edge carries cited_pe_id + owner signer:<cited>', async () => {
    const d = db();
    seedPe(d, 'pe_A1', 'alice');
    const r = await resolveOriginPricingInputs(fs(d), cache, {
      ...base('bob', 'pe_B1'), inputOrigins: [origin('pe:pe_A1')],
    }, unlinkedBeneficiary);
    expect(r.independentOriginCount).toBe(0);
    expect(r.origins[0].reason).toBe('consumption_edge');
    expect(r.origins[0].counted).toBe(false);
    expect(r.origins[0].owner).toBe('signer:alice');
    expect(r.consumptionEdges).toEqual([{ citedPeId: 'pe_A1', citedSigner: 'alice', citedActionType: 'coding_session', reason: 'consumption_edge' }]);
    const [edge] = edgesOf(d);
    expect(edge.scheme).toBe('pe');
    expect(edge.cited_pe_id).toBe('pe_A1');
    expect(edge.cited_signer).toBe('alice');
    expect(edge.cited_action_type).toBe('coding_session');
    expect(edge.closed_loop).toBe(false);
  });

  // RED CONTROL: the SAME submission with an independent evm: origin beside the pe: one counts EXACTLY
  // the evm origin (1), proving the pe: edge is what adds zero — not a dead counter.
  it('RED — an evm: origin beside the pe: origin counts 1; the pe: origin still 0', async () => {
    const d = db();
    seedPe(d, 'pe_A1', 'alice');
    const r = await resolveOriginPricingInputs(fs(d), cache, {
      ...base('bob', 'pe_B2'), inputOrigins: [origin('pe:pe_A1'), origin(`evm:${addr('c')}`)],
    }, unlinkedBeneficiary);
    expect(r.independentOriginCount).toBe(1);
    expect(r.origins.map((o) => o.reason)).toEqual(['consumption_edge', null]);
  });

  it('self-cite (pe: of my own PE) → same_party (never consumption)', async () => {
    const d = db();
    seedPe(d, 'pe_B0', 'bob');
    const r = await resolveOriginPricingInputs(fs(d), cache, {
      ...base('bob', 'pe_B3'), inputOrigins: [origin('pe:pe_B0')],
    }, unlinkedBeneficiary);
    expect(r.origins[0].reason).toBe('same_party');
    expect(r.independentOriginCount).toBe(0);
  });

  it('a pe: of a PE the relay does not know → unresolvable_owner (recorded, never guessed)', async () => {
    const d = db();
    const r = await resolveOriginPricingInputs(fs(d), cache, {
      ...base('bob', 'pe_B4'), inputOrigins: [origin('pe:pe_NOPE')],
    }, unlinkedBeneficiary);
    expect(r.origins[0].reason).toBe('unresolvable_owner');
    expect(r.origins[0].owner).toBeNull();
    expect(edgesOf(d)).toHaveLength(1); // still recorded
    expect(r.consumptionEdges).toEqual([]);
  });

  it('an UNWITNESSED pe: origin is recorded but is not a consumption edge', async () => {
    const d = db();
    seedPe(d, 'pe_A1', 'alice');
    const r = await resolveOriginPricingInputs(fs(d), cache, {
      ...base('bob', 'pe_B5'), submissionWitness: null, inputOrigins: [origin('pe:pe_A1', false)],
    }, unlinkedBeneficiary);
    expect(r.origins[0].reason).toBe('unwitnessed');
    const summary = summarizeConsumption(await readOwnerInEdges(fs(d), 'alice'));
    expect(summary.consumption_edges).toBe(0);
    expect(summary.unwitnessed_edges).toBe(1);
  });
});

// §2.3's per-output digest index (hash → producing PE) is RETIRED (: nothing at the
// relay grows with history). Signed citations replace it — see `output-citation.test.ts`.
describe('§2.1 — resolving a declared pe: origin', () => {
  it('resolvePeOrigins reads pe_history per doc and maps unknown ids to null', async () => {
    const d = db();
    seedPe(d, 'pe_K', 'kim', 'human_approval');
    const m = await resolvePeOrigins(fs(d), [origin('pe:pe_K'), origin('pe:pe_missing'), origin('evm:0xabc')]);
    expect(m.get('pe:pe_K')).toEqual({ citedPeId: 'pe_K', citedSigner: 'kim', citedActionType: 'human_approval', citedPeHash: null });
    expect(m.get('pe:pe_missing')).toBeNull();
    expect(m.has('evm:0xabc')).toBe(false);
  });
});

describe('§2.1 — the closed-loop detector covers pe: rings on the ONE graph', () => {
  it('3-wallet pe: ring (A→B, B→C, then C→A) → C\'s edge seals closed_loop; consumption excludes it', async () => {
    const d = db();
    seedPe(d, 'pe_A', 'alice'); seedPe(d, 'pe_B', 'bob'); seedPe(d, 'pe_C', 'carol');
    // pre-existing ring edges in the graph: alice cited bob's PE, bob cited carol's PE
    seedEdge(d, { signer: 'alice', owner: 'signer:bob', pe_id: 'pe_A', origin_identifier: 'pe:pe_B', cited_pe_id: 'pe_B', cited_signer: 'bob' });
    seedEdge(d, { signer: 'bob', owner: 'signer:carol', pe_id: 'pe_B', origin_identifier: 'pe:pe_C', cited_pe_id: 'pe_C', cited_signer: 'carol' });
    // carol now cites alice's PE → closes the ring
    const r = await resolveOriginPricingInputs(fs(d), cache, {
      ...base('carol', 'pe_C2'), inputOrigins: [origin('pe:pe_A')],
    }, unlinkedBeneficiary);
    expect(r.origins[0].reason).toBe('closed_loop');
    expect(r.closedLoopUnresolvable).toBe(false);
    const ringEdge = edgesOf(d).find((e) => e.pe_id === 'pe_C2')!;
    expect(ringEdge.closed_loop).toBe(true);
    // alice's Consumption excludes the ring edge
    const summary = summarizeConsumption(await readOwnerInEdges(fs(d), 'alice'));
    expect(summary.consumption_edges).toBe(0);
    expect(summary.ring_excluded_edges).toBe(1);
    const ops = await readClosedLoopEdges(fs(d));
    expect(ops.edges).toBe(1);
    expect(ops.owners).toEqual(['signer:alice']);
  });

  // RED CONTROL: break closure with ONE outward citation → nothing flagged, consumption counts.
  it('RED — the same ring plus one EXTERNAL citation by carol is NOT closed → consumption_edge, not ring-excluded', async () => {
    const d = db();
    seedPe(d, 'pe_A', 'alice'); seedPe(d, 'pe_B', 'bob'); seedPe(d, 'pe_C', 'carol');
    seedEdge(d, { signer: 'alice', owner: 'signer:bob', pe_id: 'pe_A', origin_identifier: 'pe:pe_B', cited_pe_id: 'pe_B', cited_signer: 'bob' });
    seedEdge(d, { signer: 'bob', owner: 'signer:carol', pe_id: 'pe_B', origin_identifier: 'pe:pe_C', cited_pe_id: 'pe_C', cited_signer: 'carol' });
    const r = await resolveOriginPricingInputs(fs(d), cache, {
      ...base('carol', 'pe_C3'), inputOrigins: [origin('pe:pe_A'), origin('domain:arxiv.org')],
    }, unlinkedBeneficiary);
    expect(r.origins[0].reason).toBe('consumption_edge');
    expect(r.origins[1].counted).toBe(true);
    const summary = summarizeConsumption(await readOwnerInEdges(fs(d), 'alice'));
    // Not ring-excluded … and, being an UNSIGNED pe: citation, not Consumption either (the operator
    // 2026-10-04): it records as unsigned. A signed citation in the same position counts
    // (output-citation.test.ts).
    expect(summary.ring_excluded_edges).toBe(0);
    expect(summary.unsigned_edges).toBe(1);
    expect(summary.consumption_edges).toBe(0);
  });
});

describe('§2.10 — Accountability: human_approval PEs cited', () => {
  it('an agent citing a human\'s approval PE → countHumanApprovalsCited over its out-edges = 1', async () => {
    const d = db();
    seedPe(d, 'pe_H1', 'frank', 'human_approval');
    await resolveOriginPricingInputs(fs(d), cache, {
      ...base('atlas', 'pe_T1'), inputOrigins: [origin('pe:pe_H1')],
    }, unlinkedBeneficiary);
    const out = await readSignerOutEdgeDocs(fs(d), 'atlas');
    expect(countHumanApprovalsCited(out)).toBe(1);
    // and the human's side sees its approval being built on
    expect(summarizeConsumption(await readOwnerInEdges(fs(d), 'frank')).own_approvals_cited).toBe(1);
  });
  it('RED — citing a non-approval PE counts 0', async () => {
    const d = db();
    seedPe(d, 'pe_W1', 'frank', 'coding_session');
    await resolveOriginPricingInputs(fs(d), cache, {
      ...base('atlas', 'pe_T2'), inputOrigins: [origin('pe:pe_W1')],
    }, unlinkedBeneficiary);
    expect(countHumanApprovalsCited(await readSignerOutEdgeDocs(fs(d), 'atlas'))).toBe(0);
  });
});

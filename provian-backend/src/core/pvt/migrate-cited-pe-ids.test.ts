/** Trust Layer build §2.1 — `cited_pe_ids` migrates into the ONE graph as `pe:` edges, zero mint effect. */
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import { migrateCitedPeIdsToGraph } from './migrate-cited-pe-ids';
import { ORIGIN_REFERENCE_GRAPH_COLLECTION, originEdgeId, type OriginEdge } from './origin-reference-graph';
import type { Firestore } from 'firebase-admin/firestore';

const fs = (d: FakeFirestore) => d as unknown as Firestore;
function seed(d: FakeFirestore, id: string, fields: Record<string, unknown>): void {
  d.collection('pe_history').doc(id).set({ userId: 'u', actionType: 'coding_session', timestamp: 1, ...fields });
}
const edges = async (d: FakeFirestore): Promise<OriginEdge[]> =>
  (await fs(d).collection(ORIGIN_REFERENCE_GRAPH_COLLECTION).get()).docs.map((x) => x.data() as OriginEdge);

describe('migrateCitedPeIdsToGraph', () => {
  it('writes one pe: edge per citation (owner = signer:<cited signer>, hash = cited peHash), counted:false, idempotent', async () => {
    const d = createFakeFirestore();
    seed(d, 'pe_A', { userId: 'alice', peHash: 'hA', cited_pe_ids: null });
    seed(d, 'pe_B', { userId: 'bob', peHash: 'hB', cited_pe_ids: [] });
    seed(d, 'pe_C', { userId: 'carol', peHash: 'hC', integrationSource: 'device_pe_submit', cited_pe_ids: ['pe_A', 'pe_B', 'pe_A', 'pe_C', 'pe_missing'] });
    const dry = await migrateCitedPeIdsToGraph(fs(d), { apply: false, nowMs: 5 });
    expect(dry.rows_with_citations).toBe(1);
    expect(dry.edges_planned).toBe(3); // A, B, missing (dup A + self C dropped)
    expect(dry.edges_written).toBe(0);
    expect(await edges(d)).toHaveLength(0); // dry run writes nothing

    const run = await migrateCitedPeIdsToGraph(fs(d), { apply: true, nowMs: 5 });
    expect(run.edges_written).toBe(3);
    expect(run.unresolvable_citations).toBe(1);
    expect(run.witnessed_edges).toBe(2); // device-witnessed source → its citations are witnessed
    const all = await edges(d);
    const toA = all.find((e) => e.origin_identifier === 'pe:pe_A')!;
    expect(toA).toMatchObject({
      signer: 'carol', owner: 'signer:alice', hash: 'hA', witnessed: true, counted: false,
      reason: 'migrated_citation', closed_loop: false, scheme: 'pe',
      cited_pe_id: 'pe_A', cited_signer: 'alice', cited_action_type: 'coding_session', pe_id: 'pe_C',
    });
    const toMissing = all.find((e) => e.origin_identifier === 'pe:pe_missing')!;
    expect(toMissing).toMatchObject({ owner: null, witnessed: false, counted: false, reason: 'unresolvable_owner' });
    // idempotent: the deterministic edge id means a re-run overwrites identically
    const again = await migrateCitedPeIdsToGraph(fs(d), { apply: true, nowMs: 5 });
    expect(again.edges_written).toBe(3);
    expect(await edges(d)).toHaveLength(3);
    expect((await fs(d).collection(ORIGIN_REFERENCE_GRAPH_COLLECTION).doc(originEdgeId('pe_C', 'pe:pe_A', 'hA')).get()).exists).toBe(true);
  });

  it('RED — a bare self-report source (no device, no witness class) migrates UNWITNESSED edges, and a same-party citation is same_party', async () => {
    const d = createFakeFirestore();
    seed(d, 'pe_X', { userId: 'alice', peHash: 'hX' });
    seed(d, 'pe_Y', { userId: 'alice', peHash: 'hY' });
    seed(d, 'pe_Z', { userId: 'zed', peHash: 'hZ', integrationSource: 'agent_bank_generate_pe', cited_pe_ids: ['pe_X'] });
    seed(d, 'pe_W', { userId: 'alice', peHash: 'hW', integrationSource: 'device_pe_submit', cited_pe_ids: ['pe_Y'] });
    const run = await migrateCitedPeIdsToGraph(fs(d), { apply: true, nowMs: 9 });
    expect(run.edges_written).toBe(2);
    expect(run.witnessed_edges).toBe(0);
    const all = await edges(d);
    expect(all.find((e) => e.pe_id === 'pe_Z')).toMatchObject({ witnessed: false, counted: false, reason: 'migrated_citation' });
    expect(all.find((e) => e.pe_id === 'pe_W')).toMatchObject({ witnessed: true, counted: false, reason: 'same_party', owner: 'signer:alice' });
    // every migrated edge adds zero: counted is false on all of them
    expect(all.every((e) => e.counted === false)).toBe(true);
  });
});

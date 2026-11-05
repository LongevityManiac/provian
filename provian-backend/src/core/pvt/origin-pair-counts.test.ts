/**
 * PE METER cost pass — citation edges expire (31 days) and fold into permanent PER-PAIR COUNTS
 * (ruling item 7). Every reader of an actor's whole citation history reads the counts once the
 * one-shot fold of pre-existing edges has opened the gate.
 *
 * Proven here, each with a RED control:
 * 1. EQUIVALENCE — over a mixed edge population (every summarizeConsumption bucket non-empty),
 * the summary over counts equals the summary over edges, and the out-owner map from counts
 * equals the one from edges. RED: a fold that mis-buckets ONE rule is detected.
 * 2. EXACTLY ONCE — the legacy recorder counts an edge once however often the PE replays. RED:
 * staging the same edges twice without the existence check counts them twice.
 * 3. TTL — every edge is written with a Timestamp `expire_at` 31 days past its record time, and
 * `firestore.indexes.json` declares the TTL policy on that field.
 * 4. BOUNDED READS — once the gate is open, the history readers never touch the edge collection
 * (RED: with the gate closed, the same read does).
 * 5. THE FOLD — pre-existing (unfolded) edges are counted once, the gate opens, and only THEN do
 * they get their TTL; a re-run counts nothing twice.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { Timestamp } from 'firebase-admin/firestore';
import { createFakeFirestore } from './__test-helpers__/fake-firestore';
import {
  CITATION_PAIR_COUNTS_COLLECTION,
  CITATION_PAIR_COUNTS_STATE_COLLECTION,
  CITATION_PAIR_COUNTS_STATE_DOC,
  ORIGIN_EDGE_LIFETIME_MS,
  ORIGIN_REFERENCE_GRAPH_COLLECTION,
  buildOriginEdges,
  citationIncrementsOf,
  edgeDocId,
  foldCitationIncrements,
  foldUnfoldedOriginEdges,
  readActorConsumption,
  readSignerCitedOwners,
  readSignerOutEdges,
  readSignerOutPairs,
  recordOriginEdges,
  resetCitationPairGateForTests,
  stageCitationPairIncrements,
  summarizeConsumption,
  summarizeConsumptionFromPairs,
  type CitationIncrements,
  type CitationPairCounts,
  type OriginEdge,
} from './origin-reference-graph';
import type { OriginNotCountedReason, SealedOriginRef } from './origin-independence';
import { METER_KEY_LIFETIME_MS } from '../meter/meter-store';

type Db = Parameters<typeof recordOriginEdges>[0];

const REASONS: (OriginNotCountedReason | null)[] = [
  null, 'consumption_edge', 'migrated_citation', 'closed_loop', 'same_party', 'unresolvable_owner',
  'owner_set_unresolvable', 'unwitnessed', 'private_hashed',
] as (OriginNotCountedReason | null)[];

/** A deterministic, mixed population of edges across a few signers and owners. */
function population(): OriginEdge[] {
  const edges: OriginEdge[] = [];
  const signers = ['atlas', 'bob', 'carol', 'mallory'];
  const owners = ['signer:alice', 'signer:atlas', 'evm:0xext', 'domain:x.com', null];
  let n = 0;
  for (const signer of signers) {
    for (const owner of owners) {
      for (const reason of REASONS) {
        for (const witnessed of [true, false]) {
          for (const approval of [false, true]) {
            n += 1;
            // A third of signer-owned edges are declared `pe:` citations, a third SIGNED `out:`
            // citations, the rest evm origins.
            const isCite = owner !== null && owner.startsWith('signer:') && n % 3 !== 0;
            const isPe = isCite && n % 3 === 1;
            const isOut = isCite && n % 3 === 2;
            const origin: SealedOriginRef = {
              origin_identifier: isPe ? `pe:pe_${n}` : isOut ? `out:0x${n.toString(16).padStart(40, '0')}` : `evm:0x${n.toString(16).padStart(40, '0')}`,
              hash: `sha256:${n}`,
              owner,
              witnessed,
              witness: witnessed ? { identity: 'dev', tier: 'software' } : null,
              counted: reason === null && witnessed && owner !== null,
              reason,
            };
            edges.push(...buildOriginEdges({
              signer, peId: `pe_src_${n}`, nowMs: 1_000 + n, origins: [origin],
              citedPeDetail: isPe
                ? new Map([[origin.origin_identifier, { citedPeId: `pe_${n}`, citedSigner: owner!.slice(7), citedActionType: approval ? 'human_approval' : 'agent_action' }]])
                : undefined,
            }));
          }
        }
      }
    }
  }
  return edges;
}

function pairsFrom(edges: readonly OriginEdge[], fold: typeof foldCitationIncrements = foldCitationIncrements): CitationPairCounts[] {
  return [...fold(edges).values()].map((p) => ({ kind: 'citation', signer: p.signer, owner: p.owner, last_at_ms: p.lastAtMs, ...p.inc }));
}

/** Does the counts-based summary for every owner and signer equal the edge-based one? */
function countsMatchEdges(edges: readonly OriginEdge[], fold: typeof foldCitationIncrements = foldCitationIncrements): boolean {
  const pairs = pairsFrom(edges, fold);
  const owners = new Set(edges.map((e) => e.owner).filter((o): o is string => typeof o === 'string'));
  for (const owner of owners) {
    const fromEdges = summarizeConsumption(edges.filter((e) => e.owner === owner), Number.MAX_SAFE_INTEGER);
    const fromPairs = summarizeConsumptionFromPairs(pairs.filter((p) => p.owner === owner), Number.MAX_SAFE_INTEGER);
    if (JSON.stringify(fromEdges) !== JSON.stringify(fromPairs)) return false;
  }
  for (const signer of new Set(edges.map((e) => e.signer))) {
    const fromEdges = new Map<string, boolean>();
    for (const e of edges) {
      if (e.signer !== signer || typeof e.owner !== 'string') continue;
      fromEdges.set(e.owner, (fromEdges.get(e.owner) ?? false) || e.counted === true);
    }
    const fromPairs = new Map(pairs.filter((p) => p.signer === signer).map((p) => [p.owner, p.counted > 0]));
    if (JSON.stringify([...fromEdges].sort()) !== JSON.stringify([...fromPairs].sort())) return false;
  }
  return true;
}

describe('citation pair counts — equivalence with the edges they fold', () => {
  const edges = population();

  it('the population is not empty in any bucket (no vacuous pass)', () => {
    const totals = pairsFrom(edges).reduce((t, p) => ({
      consumption: t.consumption + p.pe_consumption,
      ring: t.ring + p.pe_ring_excluded,
      unwitnessed: t.unwitnessed + p.pe_unwitnessed,
      approvals: t.approvals + p.pe_approvals_cited,
      counted: t.counted + p.counted,
      unsigned: t.unsigned + p.cite_unsigned,
    }), { consumption: 0, ring: 0, unwitnessed: 0, approvals: 0, counted: 0, unsigned: 0 });
    expect(edges.length).toBeGreaterThan(500);
    for (const v of Object.values(totals)) expect(v).toBeGreaterThan(0);
    // Unresolved-owner edges fold into nothing (no reader keys on them).
    expect(edges.some((e) => e.owner === null)).toBe(true);
    expect(edges.filter((e) => e.owner === null).every((e) => citationIncrementsOf(e) === null)).toBe(true);
  });

  it('summary over counts == summary over edges, for every owner; out-owners equal for every signer', () => {
    expect(countsMatchEdges(edges)).toBe(true);
  });

  it('RED: a fold that mis-buckets one rule (a ring edge counted as consumption) is detected', () => {
    const misfold: typeof foldCitationIncrements = (es) => {
      const out = foldCitationIncrements(es);
      for (const [id, p] of out) {
        if (p.inc.pe_ring_excluded > 0) {
          const inc: CitationIncrements = { ...p.inc, pe_consumption: p.inc.pe_consumption + p.inc.pe_ring_excluded, pe_ring_excluded: 0 };
          out.set(id, { ...p, inc });
        }
      }
      return out;
    };
    expect(countsMatchEdges(edges, misfold)).toBe(false);
  });
});

describe('citation pair counts — written exactly once, edges expire', () => {
  beforeEach(() => resetCitationPairGateForTests());

  const origins: SealedOriginRef[] = [
    { origin_identifier: 'evm:0xa', hash: 'h1', owner: 'evm:0xa', witnessed: true, witness: { identity: 'd', tier: 'software' }, counted: true, reason: null },
    { origin_identifier: 'file:/x', hash: 'h2', owner: null, witnessed: false, witness: null, counted: false, reason: 'unwitnessed' },
  ];

  it('a replayed PE counts its edges once; every edge carries its 31-day Timestamp TTL', async () => {
    const fs = createFakeFirestore();
    const db = fs as unknown as Db;
    await recordOriginEdges(db, { signer: 'atlas', peId: 'pe_1', nowMs: 5_000, origins });
    await recordOriginEdges(db, { signer: 'atlas', peId: 'pe_1', nowMs: 5_000, origins });
    const pairs = await fs.collection(CITATION_PAIR_COUNTS_COLLECTION).get();
    expect(pairs.size).toBe(1); // the null-owner edge has no pair
    expect(pairs.docs[0].data()?.edges).toBe(1);
    expect(pairs.docs[0].data()?.counted).toBe(1);
    const edgeDocs = await fs.collection(ORIGIN_REFERENCE_GRAPH_COLLECTION).get();
    expect(edgeDocs.size).toBe(2);
    for (const d of edgeDocs.docs) {
      const e = d.data() as unknown as OriginEdge;
      expect(e.expire_at).toBeInstanceOf(Timestamp);
      expect(e.expire_at!.toMillis()).toBe(5_000 + ORIGIN_EDGE_LIFETIME_MS);
      expect(e.pair_folded).toBe(true);
    }
  });

  it('RED: staging the same edges twice without the existence check counts them twice', async () => {
    const fs = createFakeFirestore();
    const db = fs as unknown as Db;
    const edges = buildOriginEdges({ signer: 'atlas', peId: 'pe_1', nowMs: 5_000, origins });
    for (let i = 0; i < 2; i += 1) {
      const batch = fs.batch();
      stageCitationPairIncrements(batch as never, db, edges);
      await batch.commit();
    }
    const pairs = await fs.collection(CITATION_PAIR_COUNTS_COLLECTION).get();
    expect(pairs.docs[0].data()?.edges).toBe(2);
  });

  it('edges live exactly as long as act keys, and the TTL policy is declared', () => {
    expect(ORIGIN_EDGE_LIFETIME_MS).toBe(METER_KEY_LIFETIME_MS);
    const cfg = JSON.parse(readFileSync(path.join(__dirname, '../../../firestore.indexes.json'), 'utf8')) as {
      fieldOverrides: { collectionGroup: string; fieldPath: string; ttl?: boolean }[];
    };
    const ttl = cfg.fieldOverrides.find((f) => f.collectionGroup === ORIGIN_REFERENCE_GRAPH_COLLECTION && f.fieldPath === 'expire_at');
    expect(ttl?.ttl).toBe(true);
  });
});

describe('citation pair counts — readers, gate and the one-shot fold', () => {
  beforeEach(() => resetCitationPairGateForTests());

  /** Seed pre-meter edges: written the old way (no TTL, never folded). */
  async function seedLegacyEdges(fs: ReturnType<typeof createFakeFirestore>, edges: readonly OriginEdge[]): Promise<void> {
    for (const e of edges) await fs.collection(ORIGIN_REFERENCE_GRAPH_COLLECTION).doc(edgeDocId(e)).set({ ...e });
  }

  /** A db whose edge collection throws on any read (proves a reader never touched it). */
  function edgeReadsForbidden(fs: ReturnType<typeof createFakeFirestore>): Db {
    return new Proxy(fs, {
      get(target, prop, receiver) {
        if (prop === 'collection') {
          return (name: string) => {
            if (name === ORIGIN_REFERENCE_GRAPH_COLLECTION) throw new Error('edge collection read');
            return target.collection(name);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as Db;
  }

  it('fold: counts every legacy edge once, opens the gate, THEN stamps TTL; a re-run counts nothing', async () => {
    const fs = createFakeFirestore();
    const db = fs as unknown as Db;
    const legacy = population().filter((e) => e.owner === 'signer:alice' || e.signer === 'atlas');
    await seedLegacyEdges(fs, legacy);
    // A post-change edge (already folded at write) must not be counted again by the fold.
    await recordOriginEdges(db, {
      signer: 'atlas', peId: 'pe_new', nowMs: 9_000,
      origins: [{ origin_identifier: 'evm:0xnew', hash: 'hn', owner: 'evm:0xnew', witnessed: true, witness: null, counted: true, reason: null }],
    });

    // Gate closed: readers read edges (complete) — the pre-meter result.
    const beforeOwners = await readSignerCitedOwners(db, 'atlas');
    const beforeConsumption = await readActorConsumption(db, 'alice');

    const report = await foldUnfoldedOriginEdges(db, { nowMs: 10_000, pageSize: 50 });
    expect(report.folded).toBe(legacy.length);
    expect(report.alreadyFolded).toBe(1);
    expect(report.ttlStamped).toBe(legacy.length);
    const gate = await fs.collection(CITATION_PAIR_COUNTS_STATE_COLLECTION).doc(CITATION_PAIR_COUNTS_STATE_DOC).get();
    expect(gate.data()?.complete).toBe(true);

    // Gate open: the SAME answers, from counts only (the edge collection is never read).
    const bounded = edgeReadsForbidden(fs);
    const afterOwners = await readSignerCitedOwners(bounded, 'atlas');
    expect([...afterOwners.owners].sort()).toEqual([...beforeOwners.owners].sort());
    const afterConsumption = await readActorConsumption(bounded, 'alice');
    expect(afterConsumption).toEqual(beforeConsumption);
    expect(afterConsumption.consumption_edges + afterConsumption.ring_excluded_edges).toBeGreaterThan(0);

    // A re-run folds nothing twice.
    const again = await foldUnfoldedOriginEdges(db, { nowMs: 11_000, pageSize: 50 });
    expect(again.folded).toBe(0);
    expect((await readSignerOutPairs(db, 'atlas')).totalEdges)
      .toBe(legacy.filter((e) => e.signer === 'atlas' && e.owner !== null).length + 1);
  });

  it('RED: with the gate closed the history read DOES read the edge collection', async () => {
    const fs = createFakeFirestore();
    await expect(readSignerCitedOwners(edgeReadsForbidden(fs), 'atlas')).rejects.toThrow('edge collection read');
    // ...and the edge reader it falls back to walks history (proportional), which the gate retires.
    expect((await readSignerOutEdges(fs as unknown as Db, 'atlas')).totalEdges).toBe(0);
  });
});

/**
 * origin-reference-graph (, Prompt 3). The forward-only edge store. Records EVERY origin edge
 * (including witnessed:false and unresolved), idempotent by a deterministic id, queryable by signer.
 */

import {
  recordOriginEdges,
  readSignerOutEdges,
  OUT_EDGE_PAGE_SIZE,
  originEdgeId,
  ORIGIN_REFERENCE_GRAPH_COLLECTION,
} from './origin-reference-graph';
import type { SealedOriginRef } from './origin-independence';

/**
 * A fake Firestore supporting batch().set()/commit() and the paged, projected out-edge read:
 * collection().where().orderBy(documentId).select().limit().startAfter().get(). An UNBOUNDED or
 * UNPROJECTED get() throws — that shape exhausted the relay heap (18,411 full edge docs, 2026-09-24).
 */
function fakeDb() {
  const store = new Map<string, Record<string, unknown>>();
  const reads: Array<{ limit: number | null; fields: string[] | null; startAfter: string | null; returned: number }> = [];
  const db = {
    _store: store,
    _reads: reads,
    collection(name: string) {
      if (name !== ORIGIN_REFERENCE_GRAPH_COLLECTION) throw new Error(`unexpected collection ${name}`);
      return {
        doc(id: string) { return { _id: id }; },
        where(field: string, _op: string, value: unknown) {
          const q = { field, value, limit: null as number | null, fields: null as string[] | null, after: null as string | null, ordered: false };
          const chain = {
            orderBy(_path: unknown) { q.ordered = true; return chain; },
            select(...fields: string[]) { q.fields = fields; return chain; },
            limit(n: number) { q.limit = n; return chain; },
            startAfter(id: string) { q.after = id; return chain; },
            get: async () => {
              if (q.limit === null || q.fields === null || !q.ordered) {
                throw new Error('unbounded or unprojected read of the origin graph');
              }
              const matched = [...store.entries()]
                .filter(([, v]) => v[q.field] === q.value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .filter(([id]) => q.after === null || id > q.after)
                .slice(0, q.limit);
              const docs = matched.map(([id, v]) => ({
                id,
                data: () => Object.fromEntries(q.fields!.filter((f) => f in v).map((f) => [f, v[f]])),
              }));
              reads.push({ limit: q.limit, fields: q.fields, startAfter: q.after, returned: docs.length });
              return { docs, size: docs.length, empty: docs.length === 0 };
            },
          };
          return chain;
        },
      };
    },
    batch() {
      const ops: Array<{ id: string; data: Record<string, unknown> }> = [];
      return {
        set(ref: { _id: string }, data: Record<string, unknown>) { ops.push({ id: ref._id, data }); },
        commit: async () => { for (const o of ops) store.set(o.id, o.data); },
      };
    },
  };
  return db as never;
}

const ref = (id: string, owner: string | null, witnessed: boolean, counted: boolean): SealedOriginRef => ({
  origin_identifier: id, hash: `sha256:${id}`, owner, witnessed,
  witness: witnessed ? { identity: 'dev', tier: 'software' } : null,
  counted, reason: counted ? null : 'unresolvable_owner',
});

describe('origin-reference-graph', () => {
  it('records EVERY edge — counted, uncounted, unwitnessed, and unresolved (owner null)', async () => {
    const db = fakeDb();
    const n = await recordOriginEdges(db, {
      signer: 'atlas', peId: 'pe_1', nowMs: 100,
      origins: [
        ref('evm:0xext', 'evm:0xext', true, true),      // counted
        ref('private_file', null, true, false),          // witnessed, unresolved owner
        ref('domain:x.com', 'domain:x.com', false, false), // unwitnessed
      ],
    });
    expect(n).toBe(3);
    expect((db as unknown as { _store: Map<string, unknown> })._store.size).toBe(3);
  });

  it('is idempotent — replaying the SAME PE overwrites, never duplicates', async () => {
    const db = fakeDb();
    const origins = [ref('evm:0xext', 'evm:0xext', true, true)];
    await recordOriginEdges(db, { signer: 'atlas', peId: 'pe_1', nowMs: 100, origins });
    await recordOriginEdges(db, { signer: 'atlas', peId: 'pe_1', nowMs: 200, origins });
    expect((db as unknown as { _store: Map<string, unknown> })._store.size).toBe(1);
  });

  it('readSignerOutEdges returns the distinct owners a signer cited, counted-any per owner', async () => {
    const db = fakeDb();
    await recordOriginEdges(db, {
      signer: 'atlas', peId: 'pe_1', nowMs: 100,
      origins: [ref('evm:a', 'evm:a', true, true), ref('evm:b', 'evm:b', true, false)],
    });
    await recordOriginEdges(db, {
      signer: 'atlas', peId: 'pe_2', nowMs: 100, origins: [ref('evm:a', 'evm:a', true, true)],
    });
    const out = await readSignerOutEdges(db, 'atlas');
    expect(out.totalEdges).toBe(3);
    expect(out.owners.get('evm:a')).toBe(true);   // counted somewhere
    expect(out.owners.get('evm:b')).toBe(false);  // never counted
    // unresolved (owner null) edges are not owner-keyed
    expect(out.owners.size).toBe(2);
  });

  it('empty origins record nothing', async () => {
    const db = fakeDb();
    expect(await recordOriginEdges(db, { signer: 'atlas', peId: 'pe_x', nowMs: 1, origins: [] })).toBe(0);
  });

  it('originEdgeId is deterministic and distinct per (pe, origin, hash)', () => {
    expect(originEdgeId('pe_1', 'evm:a', 'h')).toBe(originEdgeId('pe_1', 'evm:a', 'h'));
    expect(originEdgeId('pe_1', 'evm:a', 'h')).not.toBe(originEdgeId('pe_2', 'evm:a', 'h'));
    expect(originEdgeId('pe_1', 'evm:a', 'h')).not.toBe(originEdgeId('pe_1', 'evm:b', 'h'));
  });

  it('reads a large edge history in bounded, projected pages with the SAME result (the 2026-09-24 OOM)', async () => {
    const db = fakeDb();
    const store = (db as unknown as { _store: Map<string, Record<string, unknown>> })._store;
    // 2,500 edges over 3 owners — more than two pages. Owner 'evm:c' is counted only on the LAST
    // page, so a walk that stops early would get its flag wrong.
    const n = OUT_EDGE_PAGE_SIZE * 2 + 500;
    let lastC = n - 1;
    while (lastC % 3 !== 2) lastC -= 1;
    expect(lastC).toBeGreaterThanOrEqual(OUT_EDGE_PAGE_SIZE * 2); // on the third page
    for (let i = 0; i < n; i++) {
      const owner = i % 3 === 0 ? 'evm:a' : i % 3 === 1 ? 'evm:b' : 'evm:c';
      const counted = owner === 'evm:a' || (owner === 'evm:c' && i === lastC);
      store.set(`e${String(i).padStart(6, '0')}`, { signer: 'heavy', owner, counted, pe_id: `pe_${i}`, witness: { big: 'x'.repeat(50) } });
    }
    store.set('z_other', { signer: 'someone-else', owner: 'evm:zzz', counted: true });
    const out = await readSignerOutEdges(db, 'heavy');
    expect(out.totalEdges).toBe(n);
    expect([...out.owners.entries()].sort()).toEqual([['evm:a', true], ['evm:b', false], ['evm:c', true]]);
    const reads = (db as unknown as { _reads: Array<{ limit: number; fields: string[]; startAfter: string | null; returned: number }> })._reads;
    expect(reads.length).toBe(3);
    for (const r of reads) {
      expect(r.limit).toBeLessThanOrEqual(OUT_EDGE_PAGE_SIZE);
      expect(r.fields).toEqual(['owner', 'counted']);
    }
    expect(reads.map((r) => r.startAfter)).toEqual([null, `e${String(OUT_EDGE_PAGE_SIZE - 1).padStart(6, '0')}`, `e${String(OUT_EDGE_PAGE_SIZE * 2 - 1).padStart(6, '0')}`]);
  });

  it('an exact multiple of the page size ends on the empty page (no lost or repeated rows)', async () => {
    const db = fakeDb();
    const store = (db as unknown as { _store: Map<string, Record<string, unknown>> })._store;
    for (let i = 0; i < OUT_EDGE_PAGE_SIZE; i++) store.set(`e${String(i).padStart(6, '0')}`, { signer: 's', owner: `o${i % 7}`, counted: false });
    const out = await readSignerOutEdges(db, 's');
    expect(out.totalEdges).toBe(OUT_EDGE_PAGE_SIZE);
    expect(out.owners.size).toBe(7);
  });
});

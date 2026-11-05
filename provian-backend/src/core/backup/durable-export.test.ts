import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  DURABLE_SUBCOLLECTION_GROUPS,
  durableCollectionIds,
  LEGACY_PRE_METER_COLLECTIONS,
  TRANSIENT_COLLECTIONS,
  exportSnapshotTimeMs,
  startDurableExport,
} from './durable-export';

describe('durable export ', () => {
  const top = ['agent_wallets', 'wallets', 'pvt9_claim_ledger_v1', 'meter_device_tips_v1', 'pe_history', 'rate_limits', 'a_collection_added_tomorrow'];

  it('exports every top-level collection except the named legacy and transient ones, plus the subcollection groups', () => {
    const ids = durableCollectionIds(top);
    expect(ids).toEqual(expect.arrayContaining(['agent_wallets', 'wallets', 'pvt9_claim_ledger_v1', 'meter_device_tips_v1', 'shards', 'rotation_history']));
    expect(ids).not.toContain('pe_history');
    expect(ids).not.toContain('rate_limits');
  });

  it('backs up live fingerprint leaves, residency pointers, packed keys and routing state', () => {
    const collections = ['meter_occurrence_sets_v1', 'meter_occurrence_states_v1', 'meter_occurrence_due_v1', 'meter_key_pages_v1', 'meter_day_counters_v1', 'meter_pending_payees_v1', 'meter_pending_ready_v1', 'pe_mailbox_heads_v1'];
    expect(durableCollectionIds(collections)).toEqual(expect.arrayContaining(collections));
    // Dormant fingerprint bytes are durable objects; the live database exports only their pointer/fence.
  });
  it('an unknown collection is KEPT (subtractive list: unknown = keep)', () => {
    expect(durableCollectionIds(top)).toContain('a_collection_added_tomorrow');
  });

  it('RED control: with no exclusions the same input keeps the legacy collection (the list is what excludes)', () => {
    expect(LEGACY_PRE_METER_COLLECTIONS).toContain('pe_history');
    expect(TRANSIENT_COLLECTIONS).toContain('rate_limits');
    expect(top.filter((c) => !LEGACY_PRE_METER_COLLECTIONS.includes(c) && !TRANSIENT_COLLECTIONS.includes(c))).toHaveLength(5);
  });

  it('starts one export under <bucket>/<db>/<day>/<HHMM>Z naming ONLY the durable collections ', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const collectionIds = durableCollectionIds(top);
    const out = await startDurableExport({
      rest: { getJson: async () => ({ status: 200, data: null }), postJson: async (url, body) => { posted.push({ url, body }); return { status: 200, data: { name: 'projects/p/databases/relay/operations/op1' } }; } },
      persistManifest: async () => {}, runId:'test', projectId: 'provian-ai', databaseId: 'relay', nowMs: Date.UTC(2026, 9, 4, 3, 30, 17), collectionIds,
    });
    expect(out).toMatchObject({ ok: true, operation: 'projects/p/databases/relay/operations/op1', outputUriPrefix: 'gs://provian-ai-relay-exports/relay/2026-10-04/0329Z/test', snapshotTime: '2026-10-04T03:29:00.000Z' });
    expect(posted[0].url).toBe('https://firestore.googleapis.com/v1/projects/provian-ai/databases/relay:exportDocuments');
    expect(posted[0].body).toEqual({ outputUriPrefix: 'gs://provian-ai-relay-exports/relay/2026-10-04/0329Z/test/part-00001', collectionIds, snapshotTime: '2026-10-04T03:29:00.000Z' });
    // RED (pre-change source exported the whole database: no collectionIds at all).
    expect((posted[0].body as { collectionIds: string[] }).collectionIds).not.toContain('pe_history');
    expect((posted[0].body as { collectionIds: string[] }).collectionIds).not.toContain('rate_limits');
  });

  it.each([100,101,221,501])('exports all %i groups in bounded parts at exactly one snapshot',async count=>{
    const collectionIds=Array.from({length:count},(_,i)=>`durable_${String(i).padStart(4,'0')}`);
    const bodies: {collectionIds:string[];snapshotTime:string;outputUriPrefix:string}[]=[];
    const manifests=new Map<string,unknown>();
    const out=await startDurableExport({projectId:'p',databaseId:'relay',nowMs:1800000000000,collectionIds,
      persistManifest:async(uri,manifest)=>{manifests.set(uri,structuredClone(manifest));},
      rest:{getJson:async()=>({status:200,data:null}),postJson:async(_url,body)=>{
        const request=body as typeof bodies[number];
        expect(manifests.size).toBeGreaterThan(0); bodies.push(request);
        // Executable refusing API double: the original single request fails for >100.
        if(request.collectionIds.length>100)return {status:400,data:{error:'too many filters'}};
        return {status:200,data:{name:`operations/${bodies.length}`}};
      }}});
    expect(out.ok).toBe(true);expect(bodies.length).toBe(Math.ceil(count/100));
    expect(bodies.flatMap(b=>b.collectionIds)).toEqual(collectionIds);
    expect(new Set(bodies.map(b=>b.snapshotTime)).size).toBe(1);
    expect(new Set(bodies.map(b=>b.outputUriPrefix)).size).toBe(bodies.length);
    expect(manifests.get(out.manifestUri)).toMatchObject({collectionIds,parts:out.parts,ok:true});
    expect(out.parts.every(p=>p.operation!==null)).toBe(true);
  });

  it('records every part and refuses success when a middle request fails',async()=>{
    let calls=0;const manifests=new Map<string,unknown>();
    const out=await startDurableExport({projectId:'p',databaseId:'relay',nowMs:1800000000000,collectionIds:Array.from({length:221},(_,i)=>String(i)),
      persistManifest:async(uri,m)=>{manifests.set(uri,m);},rest:{getJson:async()=>({status:200,data:null}),postJson:async()=>{calls++;return calls===2?{status:429,data:{error:'quota'}}:{status:200,data:{name:`op/${calls}`}};}}});
    expect(calls).toBe(3);expect(out.ok).toBe(false);expect(out.parts.map(p=>p.operation)).toEqual(['op/1',null,'op/3']);
    expect(manifests.get(out.manifestUri)).toMatchObject({ok:false});
  });

  it('every collection is read at ONE PITR instant: a whole minute, strictly in the past ', async () => {
    // RED (pre-change source sent no snapshotTime: Firestore read each collection whenever it got to it).
    const bodies: Record<string, unknown>[] = [];
    for (const nowMs of [Date.UTC(2026, 9, 11, 3, 30, 0, 0), Date.UTC(2026, 9, 11, 3, 30, 59, 999), Date.UTC(2026, 9, 11, 0, 0, 0, 1)]) {
      await startDurableExport({
        rest: { getJson: async () => ({ status: 200, data: null }), postJson: async (_url, body) => { bodies.push(body as Record<string, unknown>); return { status: 200, data: { name: 'op' } }; } },
        persistManifest: async () => {}, runId:'test', projectId: 'provian-ai', databaseId: 'relay', nowMs, collectionIds: ['wallets'],
      });
      const t = exportSnapshotTimeMs(nowMs);
      expect(t % 60_000).toBe(0);
      expect(nowMs - t).toBeGreaterThanOrEqual(60_000);
      expect(nowMs - t).toBeLessThan(120_000);
    }
    expect(bodies.map((b) => b.snapshotTime)).toEqual(['2026-10-11T03:29:00.000Z', '2026-10-11T03:29:00.000Z', '2026-10-10T23:59:00.000Z']);
  });

  it('a refused export (e.g. PITR off) reports not-ok with the snapshot it asked for, never a silent success', async () => {
    const out = await startDurableExport({
      rest: { getJson: async () => ({ status: 200, data: null }), postJson: async () => ({ status: 400, data: { error: { message: 'Point-in-time recovery is not enabled' } } }) },
      persistManifest: async () => {}, runId:'test', projectId: 'provian-ai', databaseId: 'relay', nowMs: Date.UTC(2026, 9, 11, 3, 30), collectionIds: ['wallets'],
    });
    expect(out).toMatchObject({ ok: false, status: 400, operation: null, snapshotTime: '2026-10-11T03:29:00.000Z' });
  });

  it('RED: an empty collection list is refused before any request (Firestore reads [] as "everything")', async () => {
    let calls = 0;
    const out = await startDurableExport({
      rest: { getJson: async () => ({ status: 200, data: null }), postJson: async () => { calls += 1; return { status: 200, data: {} }; } },
      persistManifest: async () => {}, runId:'test', projectId: 'provian-ai', databaseId: 'relay', nowMs: Date.UTC(2026, 9, 4, 3, 30), collectionIds: [],
    });
    expect(out).toMatchObject({ ok: false, detail: 'no_collection_ids' });
    expect(calls).toBe(0);
  });
});

/**
 * The export names its collections, and `listCollections()` sees only top-level ones, so every
 * SUBCOLLECTION the relay writes must be in `DURABLE_SUBCOLLECTION_GROUPS` or it silently goes
 * unexported. This scans the relay's own source for `.doc(…).collection(<name>)` and
 * `collectionGroup(<name>)`, resolving `export const NAME = '<id>'` constants.
 */
describe('every subcollection the relay writes is in the export (guard)', () => {
  const SRC = join(__dirname, '..', '..');
  const SUB = /\.doc\((?:[^()]|\([^()]*\))*\)\s*\.collection\(\s*([^)\s,]+)/gs;
  const GROUP = /\.collectionGroup\(\s*([^)\s,]+)/gs;

  function sources(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== '__test-helpers__' && f !== 'node_modules') walk(p); continue; }
        // Comments are not code: strip block and line comments before scanning.
        if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
          out.set(p, readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1'));
        }
      }
    };
    walk(SRC);
    return out;
  }

  function subcollectionNames(files: Map<string, string>): Set<string> {
    const constants = new Map<string, string>();
    for (const text of files.values()) {
      for (const m of text.matchAll(/export const ([A-Z0-9_]+)\s*=\s*'([a-z0-9_]+)'/g)) constants.set(m[1], m[2]);
    }
    const names = new Set<string>();
    for (const text of files.values()) {
      for (const re of [SUB, GROUP]) {
        for (const m of text.matchAll(re)) {
          const raw = m[1];
          const literal = /^'([a-z0-9_]+)'$/.exec(raw);
          names.add(literal ? literal[1] : (constants.get(raw) ?? `UNRESOLVED:${raw}`));
        }
      }
    }
    return names;
  }

  it('the scan finds the relay\'s subcollections, and every one is exported', () => {
    const names = subcollectionNames(sources());
    // Non-empty population: a scan that matched nothing would pass vacuously.
    expect(names.size).toBeGreaterThanOrEqual(5);
    expect([...names].filter((n) => !DURABLE_SUBCOLLECTION_GROUPS.includes(n))).toEqual([]);
  });

  it('RED control: a new subcollection in source is reported missing', () => {
    const files = new Map([['x.ts', "db.collection('wallets').doc(id).collection('brand_new_sub').doc('a')"]]);
    const names = subcollectionNames(files);
    expect([...names].filter((n) => !DURABLE_SUBCOLLECTION_GROUPS.includes(n))).toEqual(['brand_new_sub']);
  });
});

describe('database move copy set ', () => {
  it('copies the state the survey found must survive, drops the verified legacy list, keeps transient state', async () => {
    const { cutoverCollectionIds } = await import('./durable-export');
    const ids = cutoverCollectionIds(['pe_history_index_shard_migration', 'identity_pes_legacy_v1', 'meter_pair_counts_state_v1', 'pe_anchor_state', 'consumed_nonces', 'pe_history', 'origin_reference_graph_v1']);
    expect(ids).toEqual(expect.arrayContaining(['pe_history_index_shard_migration', 'identity_pes_legacy_v1', 'meter_pair_counts_state_v1', 'pe_anchor_state', 'consumed_nonces', 'shards']));
    expect(ids).not.toContain('pe_history');
    expect(ids).not.toContain('origin_reference_graph_v1');
  });
});

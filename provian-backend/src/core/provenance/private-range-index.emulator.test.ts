import { Firestore } from 'firebase-admin/firestore';
import { randomUUID } from 'crypto';
import { privateFirestore, privateStorageId, withPrivateReadSession, encodePrivateRecord } from './private-store';
import { backfillPrivateArrayLookups } from '../../../scripts/lib/private-array-lookup';
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
jest.setTimeout(60_000);
suite('certified operational range mirrors avoid historical financial scans', () => {
  let raw: Firestore, db: Firestore;
  const collection = 'pvt9_claim_ledger_v1', secret = process.env.RELAY_SIGNING_KEY;
  beforeAll(async () => {
    process.env.RELAY_SIGNING_KEY = 'public-range-index-emulator-key';
    raw = new Firestore({ projectId: 'demo-private-range', databaseId: 'range-' + randomUUID().slice(0, 8) });
    await raw.collection('private_retention_state_v1').doc('d554').set({ opaque_ids_ready: true, opaque_records_complete: true }); db = privateFirestore(raw);
    for (let first = 0; first < 501; first += 100) { const write = db.batch(); for (let i = first; i < Math.min(first + 100, 501); i++) write.create(db.collection(collection).doc('claim-' + i), { claim_key: 'claim-' + i, created_at: i, record_points_atomic: String(i + 1) }); await write.commit(); }
  });
  afterAll(async () => { await raw.terminate(); if (secret === undefined) delete process.env.RELAY_SIGNING_KEY; else process.env.RELAY_SIGNING_KEY = secret; });
  async function query(certified: boolean) {
    await raw.collection('private_retention_state_v1').doc('d554').set({ range_lookup_version: certified ? 1 : 0 }, { merge: true });
    let reads = 0; const original = (raw as any).requestStream;
    const spy = jest.spyOn(raw as any, 'requestStream').mockImplementation(async (...args: any[]) => {
      const stream = await original.apply(raw, args), emit = stream.emit.bind(stream);
      stream.emit = (event: string, value: any, ...rest: unknown[]) => { if (event === 'data' && value?.document?.name?.includes('/documents/' + collection + '/')) reads++; return emit(event, value, ...rest); }; return stream;
    });
    try { const docs = await withPrivateReadSession(() => db.collection(collection).where('created_at', '>=', 250).orderBy('created_at', 'desc').get()); return { reads, rows: docs.docs.map(doc => doc.data()) }; }
    finally { spy.mockRestore(); }
  }
  it('RED an uncertified mirror scans501 rows; a certified mirror reads only the251 matching claims with identical amounts/order across pages', async () => {
    const old = await query(false), fast = await query(true); expect(old.reads).toBe(501); expect(fast.reads).toBe(251); expect(fast.rows).toEqual(old.rows); expect(fast.rows.map(row => row.created_at)).toEqual(Array.from({ length: 251 }, (_, i) => 500 - i));
  });
  it('backfill repairs a missing mirror without changing ciphertext, then certifies complete query coverage', async () => {
    const ref = raw.collection(collection).doc(privateStorageId(collection, 'claim-500')), before = (await ref.get()).get('body');
    const { FieldValue } = await import('firebase-admin/firestore'); await ref.update({ _provian_range: FieldValue.delete() });
    const old = await query(false); expect(old.rows[0].created_at).toBe(500);
    const report = await backfillPrivateArrayLookups(raw, true); expect(report.changed).toBeGreaterThanOrEqual(1); expect((await ref.get()).get('body')).toEqual(before);
    expect((await raw.collection('private_retention_state_v1').doc('d554').get()).get('range_lookup_version')).toBe(1);
    expect((await query(true)).rows).toEqual(old.rows);
  });  it('RED a writer changing ciphertext after the scan wins; stale metadata cannot overwrite it or certify the wrong lookup', async () => {
    const id = 'claim-500', ref = raw.collection(collection).doc(privateStorageId(collection,id));
    const { FieldValue } = await import('firebase-admin/firestore'); await ref.update({ _provian_range: FieldValue.delete() });
    const original = raw.batch.bind(raw); let injected = false, latestBody: unknown;
    const spy = jest.spyOn(raw,'batch').mockImplementation(() => {
      const write = original(); let touches = false;
      return new Proxy(write,{get(target,prop){
        if(prop==='update')return (candidate:any,...args:any[])=>{ if(candidate.path===ref.path)touches=true; (target.update as any)(candidate,...args);return target; };
        if(prop==='commit')return async()=>{
          if(touches&&!injected){injected=true;await ref.set(encodePrivateRecord(collection,id,{claim_key:id,created_at:500,record_points_atomic:'99999'}));latestBody=(await ref.get()).get('body');}
          return target.commit();
        };
        const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
      }});
    });
    try { await backfillPrivateArrayLookups(raw,true); } finally { spy.mockRestore(); }
    expect(injected).toBe(true); expect((await ref.get()).get('body')).toEqual(latestBody); expect((await db.collection(collection).doc(id).get()).get('record_points_atomic')).toBe('99999');
    expect((await query(true)).rows[0].record_points_atomic).toBe('99999');
  });

});

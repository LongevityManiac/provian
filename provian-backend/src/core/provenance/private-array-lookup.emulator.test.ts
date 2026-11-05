import {Firestore,Timestamp} from 'firebase-admin/firestore';
import {randomUUID} from 'crypto';
import {privateFirestore,privateStorageId,encodePrivateRecord} from './private-store';
import {PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} from './private-retention';
import {backfillPrivateArrayLookups} from '../../../scripts/lib/private-array-lookup';
const suite=/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST??'')?describe:describe.skip;
jest.setTimeout(120000);
suite('certified secret array indexes lower owner reads without altering records',()=>{
 let raw:Firestore,db:Firestore,restore:()=>void,reads=0,counting=false;const previous=process.env.RELAY_SIGNING_KEY;
 beforeAll(()=>{
  process.env.RELAY_SIGNING_KEY='public-local-array-proof';raw=new Firestore({projectId:'demo-cost-cut',databaseId:'arrays-'+randomUUID().slice(0,8)});db=privateFirestore(raw);
  const proto=Object.getPrototypeOf(raw),original=proto.requestStream;
  proto.requestStream=async function(...args:unknown[]){const stream=await original.apply(this,args),emit=stream.emit.bind(stream);stream.emit=(event:string,...values:unknown[])=>{if(counting&&event==='data'){const chunk=values[0] as {document?:{name:string};found?:{name:string}};if((chunk?.document??chunk?.found)?.name.includes('/meter_batch_acts_v1/'))reads++;}return emit(event,...values);};return stream;};restore=()=>{proto.requestStream=original;};
 });
 afterAll(async()=>{restore();await raw.terminate();if(previous===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=previous;});
 it('RED unindexed owner scan401; GREEN reads21 only, same full records/ciphertext/economics/TTL',async()=>{
  const state=raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC);await state.set({opaque_ids_ready:true,opaque_records_complete:true,array_lookup_version:0});
  const col='meter_batch_acts_v1',batch=raw.batch(),before=new Map<string,FirebaseFirestore.DocumentData>();
  for(let i=0;i<401;i++){const id='array-'+i,doc=encodePrivateRecord(col,id,{id,actor_id:'actor-'+i,beneficiary_ids:i%20===0?['owner','owner',null,NaN]:['other-'+i],amount_atomic:'123456789123456789',sealed_pricing:{gross:'987654321'},expire_at:Timestamp.fromMillis(2000000000000)});for(const [k,v] of Object.entries(doc._provian_lookup))if(Array.isArray(v))delete doc._provian_lookup[k];const physical=privateStorageId(col,id);before.set(physical,doc);batch.create(raw.collection(col).doc(physical),doc);}await batch.commit();
  const query=()=>db.collection(col).where('beneficiary_ids','array-contains','owner');
  reads=0;counting=true;const old=await query().get();counting=false;expect(reads).toBe(401);expect(old.size).toBe(21);
  const plan=await backfillPrivateArrayLookups(raw,false);expect(plan.changed).toBe(401);expect((await state.get()).data()?.array_lookup_version).toBe(0);
  const result=await backfillPrivateArrayLookups(raw,true);expect(result).toEqual({scanned:401,changed:401,verified:401});expect((await state.get()).data()?.array_lookup_version).toBe(1);
  for(const doc of (await raw.collection(col).get()).docs){const {_provian_lookup:a,...unchanged}=doc.data();const {_provian_lookup:b,...original}=before.get(doc.id)!;expect(unchanged).toEqual(original);expect(Object.values(a).some(Array.isArray)).toBe(true);}
  reads=0;counting=true;const current=await query().get();counting=false;expect(reads).toBe(21);expect(current.docs.map(d=>[d.id,d.data()])).toEqual(old.docs.map(d=>[d.id,d.data()]));
  expect((await db.collection(col).where('beneficiary_ids','array-contains-any',['owner','missing']).get()).docs.map(d=>d.id)).toEqual(current.docs.map(d=>d.id));
  expect(()=>db.collection(col).where('beneficiary_ids','array-contains',null)).toThrow();
  expect(()=>db.collection(col).where('beneficiary_ids','array-contains',NaN)).toThrow();
  expect((await db.collection(col).where('beneficiary_ids','array-contains-any',[null,NaN]).get()).size).toBe(21);
  expect((await db.collection(col).where('beneficiary_ids','array-contains','owner').where('actor_id','==','actor-0').get()).docs.map(d=>d.id)).toEqual(['array-0']);
  expect(await backfillPrivateArrayLookups(raw,true)).toEqual({scanned:401,changed:0,verified:401});
 });
 it('an invalid representation closes the certificate and never enables an incomplete index',async()=>{
  await raw.collection('identity_acts_v1').doc('legacy-forbidden').set({beneficiary_ids:['owner']});
  await expect(backfillPrivateArrayLookups(raw,true)).rejects.toThrow('uncertified private representation');
  expect((await raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).get()).data()?.array_lookup_version).toBe(0);
 });
});

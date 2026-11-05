import {Firestore} from 'firebase-admin/firestore';
import {randomUUID} from 'crypto';
import {privateFirestore,privateStorageId,encodePrivateRecord} from './private-store';
import {createQueryPager} from './query-pages';
import * as pages from './query-pages';
import {listPendingPolicyActionItemsPage} from '../pvt/policy/pending-policy-queue';
import {listAllPendingPolicyActions} from '../pvt/policy/earning-type-projection';
import {backfillPrivateArrayLookups} from '../../../scripts/lib/private-array-lookup';
import {PRIVATE_RETENTION_STATE_COLLECTION as STATE,PRIVATE_RETENTION_STATE_DOC as DOC} from './private-retention';
const suite=/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST??'')?describe:describe.skip;
jest.setTimeout(120_000);
suite('one encrypted scan, exact logical pagination and narrowed candidates',()=>{
 let raw:Firestore,db:Firestore;const prior=process.env.RELAY_SIGNING_KEY;const collection='meter_batch_acts_v1';
 beforeEach(async()=>{process.env.RELAY_SIGNING_KEY='public-private-pager-cost-proof';raw=new Firestore({projectId:'demo-cost-cut',databaseId:'pager-'+randomUUID().slice(0,8)});db=privateFirestore(raw);await raw.collection(STATE).doc(DOC).set({opaque_ids_ready:true,opaque_records_complete:true});});
 afterEach(async()=>{jest.restoreAllMocks();await raw.terminate();if(prior===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=prior;});
 async function seed(n:number){for(let at=0;at<n;at+=400){const b=raw.batch();for(let i=at;i<Math.min(at+400,n);i++){const id='row_'+String(i).padStart(4,'0');const data={id,owner:i%2?'other':'owner',state:i%3?'settled':'pending',created_at_ms:i%7,beneficiary_ids:i%2?['other']:['owner'],payload:'local record data'};b.create(raw.collection(collection).doc(privateStorageId(collection,id)),encodePrivateRecord(collection,id,data));}await b.commit();}}
 function reads(){const hits=new Map<string,number>();const run=raw.runTransaction.bind(raw);jest.spyOn(raw,'runTransaction').mockImplementation(((fn:any,options:any)=>run(async tx=>fn(new Proxy(tx,{get(target,prop){if(prop==='get')return async(q:any)=>{const s:any=await tx.get(q);for(const d of s.docs??[])if(d.ref.parent.id===collection)hits.set(d.id,(hits.get(d.id)??0)+1);return s;};const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;}})),options)) as typeof raw.runTransaction);return hits;}
 it('751 rows, tied ordering, selected fields and pinned snapshot: every cursor page matches one native logical result and each physical row is read once',async()=>{
  await seed(751);const base=db.collection(collection).orderBy('created_at_ms').select('id','created_at_ms');const expected=(await base.get()).docs.map(d=>({id:d.id,data:d.data()}));
  const hits=reads(),read=createQueryPager();const out:typeof expected=[];let cursor:FirebaseFirestore.QueryDocumentSnapshot|undefined;
  for(;;){const q=(cursor?base.startAfter(cursor):base).limit(41);const page=await read(q);out.push(...page.docs.map(d=>({id:d.id,data:d.data()})));if(!cursor)await raw.collection(collection).doc(privateStorageId(collection,'row_0750')).update({body:encodePrivateRecord(collection,'row_0750',{id:'row_0750',created_at_ms:999}).body});if(page.size<41)break;cursor=page.docs.at(-1);}
  expect(out).toEqual(expected);expect(hits.size).toBe(751);expect([...hits.values()].every(n=>n===1)).toBe(true);
  await expect(read(db.collection(collection).where('owner','==','other').limit(41))).rejects.toThrow('query changed');
 });
 it('small operator queue pages keep bounded retention; bulk traversal alone prepares the shared scan',async()=>{
  const col='pvt_pending_policy_queue',batch=raw.batch();
  for(let i=0;i<401;i++){const id=i.toString(16).padStart(64,'0');batch.create(raw.collection(col).doc(privateStorageId(col,id)),encodePrivateRecord(col,id,{first_seen_at:i,action_type:'queue_'+String(i).padStart(4,'0'),policy_review_state:'pending_policy',description:'x'.repeat(1000)}));}await batch.commit();
  const spy=jest.spyOn(pages,'createQueryPager');
  const first=await listPendingPolicyActionItemsPage(db,{limit:1});expect(first.items.map(x=>x.action_type)).toEqual(['queue_0000']);expect(first.nextCursor).not.toBeNull();expect(spy).not.toHaveBeenCalled();
  const rows=await listAllPendingPolicyActions(db);expect(rows).toHaveLength(401);expect(rows[400].action_type).toBe('queue_0400');expect(spy).toHaveBeenCalledTimes(1);
 });
 it('a map cursor containing ref/data keys remains a Firestore map rather than a snapshot',async()=>{
  const col=db.collection(collection);await col.doc('map-a').set({shape:{ref:'a',data:'value'}});await col.doc('map-b').set({shape:{ref:'b',data:'value'}});
  const next=await col.orderBy('shape').startAfter({ref:'a',data:'value'}).get();expect(next.docs.map(d=>d.id)).toEqual(['map-b']);
 });
 it('two scalar equality indexes read only their intersection, with logical post-filter unchanged',async()=>{
  await seed(120);const hits=reads();const found=await db.collection(collection).where('owner','==','owner').where('state','==','pending').get();expect(found.size).toBe(20);expect(hits.size).toBe(20);
 });
 it('RED unindexed old arrays cannot enable pushdown; backfill changes no cipher or economic data, then recipient query reads only its candidates',async()=>{
  await seed(120);const before=await raw.collection(collection).get();for(const d of before.docs){const lookup=d.get('_provian_lookup');for(const k of Object.keys(lookup))if(Array.isArray(lookup[k]))delete lookup[k];await d.ref.update({_provian_lookup:lookup});}
  const old=(await db.collection(collection).where('beneficiary_ids','array-contains','owner').get()).docs.map(d=>d.id);expect(old).toHaveLength(60);
  const report=await backfillPrivateArrayLookups(raw,true);expect(report).toEqual({scanned:120,changed:120,verified:120});
  for(const d of before.docs){const after=await d.ref.get();expect(after.get('body')).toEqual(d.get('body'));}
  const hits=reads();const next=await db.collection(collection).where('beneficiary_ids','array-contains','owner').get();expect(next.docs.map(d=>d.id)).toEqual(old);expect(hits.size).toBe(60);
 });
 it('RED a stray legacy slot after certification fails closed, even beside an identical opaque slot',async()=>{
  const id='stray',data={id};await raw.collection(collection).doc(privateStorageId(collection,id)).set(encodePrivateRecord(collection,id,data));await raw.collection(collection).doc(id).set(data);
  await expect(db.collection(collection).get()).rejects.toThrow('certified representation drift');
  await raw.collection(collection).doc(id).set({id,points:'changed'});await expect(db.collection(collection).get()).rejects.toThrow('certified representation drift');
 });
});

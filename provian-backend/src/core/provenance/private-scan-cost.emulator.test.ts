import * as nativeOrder from '@google-cloud/firestore/build/src/order';
import {Firestore,FieldPath} from 'firebase-admin/firestore';
import {randomUUID,createHash} from 'crypto';
import * as storage from './private-store';
import {PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} from './private-retention';
import {buildPendingClaim,meterBatchClaimId,meterBatchClaimKey,buildPayoutClaim,MAX_PAYOUT_MEMBERS} from '../meter/meter-claims';
import {runMeterClaimInlet} from '../meter/meter-settlement';
import {listRecentActKeys} from '../meter/owner-reads';
import {buildActPages,actKeyOfPageAct} from '../meter/meter-act-pages';
import {actKeyDocFor} from '../meter/__test-helpers__/seed-act-keys';
import {createHeldActSource,listHeldActs} from '../meter/held-acts';
import {walkHeldActs} from '../pvt/held-act-sweep';
const suite=/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST??'')?describe:describe.skip;
type Stream={emit:(event:string|symbol,...args:unknown[])=>boolean};
type StreamFn=(method:string,bidi:unknown,request:unknown,...rest:unknown[])=>Promise<Stream>;
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'?v as Record<string,unknown>:{};
jest.setTimeout(120_000);
suite('linear encrypted scans and exact weekly claims',()=>{
 let raw:Firestore,db:Firestore,restore:()=>void;const reads=new Map<string,number>();let counting=false;const prior=process.env.RELAY_SIGNING_KEY;
 beforeAll(()=>{
  process.env.RELAY_SIGNING_KEY='public-emulator-cost-control';raw=new Firestore({projectId:'demo-cost-cut',databaseId:'cost-'+randomUUID().slice(0,8),ignoreUndefinedProperties:true});db=storage.privateFirestore(raw);
  const proto=Object.getPrototypeOf(raw) as {requestStream:StreamFn},original=proto.requestStream;
  proto.requestStream=async function(method,bidi,request,...rest){const stream=await original.call(this,method,bidi,request,...rest),emit=stream.emit.bind(stream);
   stream.emit=(event,...args)=>{if(counting&&event==='data'){const chunk=object(args[0]),doc=object(chunk.document??chunk.found),name=typeof doc.name==='string'?doc.name:typeof chunk.missing==='string'?chunk.missing:null;if(name!==null)reads.set(name,(reads.get(name)??0)+1);}return emit(event,...args);};return stream;};restore=()=>{proto.requestStream=original;};
 });
 afterAll(async()=>{restore();await raw.terminate();if(prior===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=prior;});
 const complete=()=>raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).set({opaque_ids_ready:true,opaque_records_complete:true});
 it('RED old pages reread 401 rows; GREEN identical logical ties and bounds reads each once',async()=>{
  await complete();const col='identity_acts_v1',ids=Array.from({length:401},(_,i)=>'cost-'+String(i).padStart(4,'0'));const writer=raw.batch();
  for(const [i,id] of ids.entries())writer.create(raw.collection(col).doc(storage.privateStorageId(col,id)),storage.encodePrivateRecord(col,id,{group:'linear',timestamp:Math.floor(i/3),payload:id}));await writer.commit();
  const base=db.collection(col).where('group','==','linear').orderBy('timestamp').orderBy(FieldPath.documentId());
  const traverse=async(query:FirebaseFirestore.Query)=>{reads.clear();counting=true;let after:FirebaseFirestore.QueryDocumentSnapshot|undefined;const out:string[]=[];
   try{for(;;){let page=query.limit(37);if(after)page=page.startAfter(after);const snap=await page.get();out.push(...snap.docs.map(d=>d.id));after=snap.docs.at(-1);if(snap.size<37)break;}}finally{counting=false;}return {out,reads:[...reads].filter(([n])=>n.includes('/'+col+'/')).reduce((n,[,c])=>n+c,0)};};
  const red=await traverse(base),green=await traverse(storage.singleScanQuery(base));expect(red.out).toEqual(ids);expect(red.reads).toBeGreaterThan(ids.length*10);expect(green).toEqual({out:ids,reads:ids.length});
  const scan=storage.singleScanQuery(base);expect((await scan.startAt(2,'cost-0007').endBefore(3).select('payload').get()).docs.map(d=>d.data())).toEqual([{payload:'cost-0007'},{payload:'cost-0008'}]);expect((await scan.startAfter(2).limitToLast(2).get()).docs.map(d=>d.id)).toEqual(ids.slice(-2));
  console.log('[cost proof]',JSON.stringify({candidates:ids.length,old_reads:red.reads,new_reads:green.reads}));
 });
 it('401 ready claims read once and build identical payout IDs, amounts and members, then replay registers none',async()=>{
  await complete();const col='meter_pending_claims_v1',now=2000000000000,contributor='0x'+'1'.repeat(40);
  const claims=Array.from({length:401},(_,i)=>{const batch_hash=createHash('sha256').update('weekly-cost-'+i).digest('hex'),identity={batch_hash,leg:'sole' as const,contributor,beneficiary_class:0};return buildPendingClaim({...identity,claim_key:meterBatchClaimKey(identity),claim_id:meterBatchClaimId(identity),unit:'batch',device_id:'device',actor_id:'actor',record_points_atomic:String(BigInt(i+1)*10n**18n),acts:[],created_at_ms:now-1000,ready_at_ms:0});}).sort((a,b)=>a.claim_key<b.claim_key?-1:1);
  const writer=raw.batch();for(const c of claims)writer.create(raw.collection(col).doc(storage.privateStorageId(col,c.claim_key)),storage.encodePrivateRecord(col,c.claim_key,c));await writer.commit();
  const expected=[];for(let i=0;i<claims.length;i+=MAX_PAYOUT_MEMBERS)expected.push(buildPayoutClaim({leg:'sole',contributor,beneficiary_class:0,created_at_ms:now,members:claims.slice(i,i+MAX_PAYOUT_MEMBERS).map(c=>({claim_key:c.claim_key,claim_id:c.claim_id,points_atomic:c.record_points_atomic}))}));
  reads.clear();counting=true;let report;try{report=await runMeterClaimInlet(db,{nowMs:now,pageSize:31});}finally{counting=false;}expect(report).toMatchObject({scanned:401,aggregated:401,payouts:2,registered:2});
  for(const c of claims){const suffix='/'+col+'/'+storage.privateStorageId(col,c.claim_key);expect([...reads].filter(([n])=>n.endsWith(suffix)).reduce((n,[,v])=>n+v,0)).toBe(1);}
  for(const p of expected)expect((await db.collection(col).doc(p.claim_key).get()).data()).toMatchObject({...p,state:'registered'});
  expect(await runMeterClaimInlet(db,{nowMs:now,pageSize:1})).toMatchObject({scanned:0,payouts:0,registered:0});
 });
 it('native scalar count avoids document reads; range fallback counts exact logical values',async()=>{
  reads.clear();counting=true;const count=await db.collection('identity_acts_v1').where('group','==','linear').count().get();counting=false;expect(count.data().count).toBe(401);expect([...reads.keys()].filter(n=>n.includes('/identity_acts_v1/'))).toEqual([]);expect((await db.collection('identity_acts_v1').where('timestamp','>=',130).count().get()).data().count).toBe(11);
 });
 it('a replaced projection fetches newly requested fields; identical projected pages reuse the scan',async()=>{
  await complete();const col=db.collection('identity_acts_v1');await col.doc('projection-replace').set({group:'replace',payload:'alpha',otherField:'beta'});
  const base=col.where('group','==','replace').select('payload');const scan=storage.singleScanQuery(base);
  expect((await scan.get()).docs[0].data()).toEqual({payload:'alpha'});
  expect((await scan.select('otherField').get()).docs[0].data()).toEqual({otherField:'beta'});
  expect((await scan.select().get()).docs[0].data()).toEqual({});
 });
 it('scalar IN counts exclude null and NaN exactly as logical queries do',async()=>{
  await complete();const col=db.collection('identity_acts_v1');await col.doc('count-null').set({group:'in-count',field:null});await col.doc('count-nan').set({group:'in-count',field:NaN});await col.doc('count-value').set({group:'in-count',field:'yes'});
  for(const values of [[null,NaN,'yes'],[null,NaN]]){const q=col.where('field','in',values);expect((await q.count().get()).data().count).toBe((await q.get()).size);}
  expect((await col.where('field','in',[null,NaN,'yes']).count().get()).data().count).toBe(1);
 });
 it('transaction reads and writes reuse one alias resolution, while transforms preserve values',async()=>{
  await complete();const col='identity_acts_v1',id='transaction-cost';await db.collection(col).doc(id).set({value:7});reads.clear();counting=true;
  try{await db.runTransaction(async tx=>{const ref=db.collection(col).doc(id),a=await tx.get(ref),b=await tx.get(ref);expect(a.data()).toEqual(b.data());tx.update(ref,{value:a.data()!.value+5});});}finally{counting=false;}
  const slots=[...reads].filter(([n])=>n.includes('/'+col+'/')&&(n.endsWith('/'+id)||n.endsWith('/'+storage.privateStorageId(col,id))));expect(slots.reduce((n,[,c])=>n+c,0)).toBe(1);expect((await db.collection(col).doc(id).get()).data()?.value).toBe(12);
 });
 it('streaming reductions read each row once and preserve projected outputs, including mixed legacy aliases',async()=>{
  reads.clear();counting=true;const values:string[]=[];try{await storage.visitQueryDocuments(db.collection('identity_acts_v1').where('group','==','linear').select('payload'),d=>{expect(Object.keys(d.data())).toEqual(['payload']);values.push(d.data().payload);});}finally{counting=false;}
  expect(values.sort()).toEqual(Array.from({length:401},(_,i)=>'cost-'+String(i).padStart(4,'0')));expect([...reads].filter(([n])=>n.includes('/identity_acts_v1/')).reduce((n,[,c])=>n+c,0)).toBe(401);
  await raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).set({opaque_records_complete:false});const col='identity_pes_legacy_v1';await raw.collection(col).doc('mixed').set({kind:'mixed',value:1});await raw.collection(col).doc(storage.privateStorageId(col,'mixed')).set(storage.encodePrivateRecord(col,'mixed',{kind:'mixed',value:1}));const out:string[]=[];await storage.visitQueryDocuments(db.collection(col).where('kind','==','mixed'),d=>out.push(d.id));expect(out).toEqual(['mixed']);expect((await db.collection(col).where('kind','==','mixed').count().get()).data().count).toBe(1);await complete();
 });
 it('RED stale member fails the atomic take and its sibling payout creation',async()=>{
  await complete();const col='meter_pending_claims_v1';await db.collection(col).doc('stale-cost').set({state:'pending',value:1});const snap=(await storage.singleScanQuery(db.collection(col).where('value','==',1)).get()).docs[0];await snap.ref.update({value:2});const batch=db.batch();batch.update(snap.ref,{state:'aggregated'},{lastUpdateTime:snap.updateTime});batch.create(db.collection(col).doc('must-not-exist'),{state:'payout'});await expect(batch.commit()).rejects.toBeDefined();expect((await db.collection(col).doc('must-not-exist').get()).exists).toBe(false);expect((await snap.ref.get()).data()?.state).toBe('pending');
 });
 it('bounded top-k selection preserves ties and directions with sublinear comparisons per candidate',async()=>{
  await complete();const col='identity_acts_v1',rows=Array.from({length:401},(_,i)=>({id:'heap-'+String(i).padStart(4,'0'),timestamp:i%17}));const batch=raw.batch();for(const row of rows)batch.create(raw.collection(col).doc(storage.privateStorageId(col,row.id)),storage.encodePrivateRecord(col,row.id,{...row,group:'heap'}));await batch.commit();
  const expected=[...rows].sort((a,b)=>a.timestamp-b.timestamp||a.id.localeCompare(b.id));
  const base=db.collection(col).where('group','==','heap').orderBy('timestamp').orderBy(FieldPath.documentId());
  const spy=jest.spyOn(nativeOrder,'compare');try{const page=await base.limit(64).get();const comparisons=spy.mock.calls.length;expect(page.docs.map(d=>d.id)).toEqual(expected.slice(0,64).map(d=>d.id));console.log('heap_comparisons',comparisons);expect(comparisons).toBeLessThan(12000);}finally{spy.mockRestore();}
  expect((await base.limitToLast(64).get()).docs.map(d=>d.id)).toEqual(expected.slice(-64).map(d=>d.id));
  expect((await base.offset(17).limit(64).select('timestamp').get()).docs.map(d=>d.id)).toEqual(expected.slice(17,81).map(d=>d.id));
 });

 it('recent act pages stream once with bounded retention and preserve cursor, offset and duplicate-key precedence',async()=>{
  await complete();const col='meter_batch_acts_v1',actor='recent-stream-cost';
  const pages=Array.from({length:45},(_,i)=>{
   const keys=Array.from({length:9},(_,j)=>actKeyDocFor({peId:j===0?'shared-duplicate':'recent-'+i+'-'+j,userId:actor,timestamp:2000000000000+(j===0?10:(i*7+j)%23),actionType:'coding_session',record_points_atomic:String(i*9+j)}));
   const page=buildActPages({batchHash:'recent-'+String(i).padStart(3,'0'),actorId:actor,deviceId:'device',keys:keys as never})[0];return {id:page.batch_hash+'~0',page};
  });
  const writer=raw.batch();for(const {id,page} of pages)writer.create(raw.collection(col).doc(storage.privateStorageId(col,id)),storage.encodePrivateRecord(col,id,page));await writer.commit();
  const reference=pages.slice().sort((a,b)=>b.page.max_ts-a.page.max_ts||Buffer.compare(Buffer.from(b.id),Buffer.from(a.id)))
   .flatMap(({page})=>Object.values(page.acts).map(a=>({id:a.relay_pe_id,key:actKeyOfPageAct(a)})))
   .sort((a,b)=>b.key.timestamp-a.key.timestamp||(a.id<b.id?1:a.id>b.id?-1:0));
  for(const options of [{limit:7},{limit:3,offset:19},{limit:100,cursor:{sortValue:2000000000010,documentId:'shared-duplicate'}}]){
   const cursor=options.cursor??null,offset=cursor?0:options.offset??0,want=offset+options.limit+1;
   const candidates=reference.filter(a=>!cursor||a.key.timestamp<Number(cursor.sortValue)||(a.key.timestamp===Number(cursor.sortValue)&&a.id<cursor.documentId)).slice(0,want);
   const merged=[...new Map(candidates.map(a=>[a.id,a])).values()].sort((a,b)=>b.key.timestamp-a.key.timestamp||(a.id<b.id?1:a.id>b.id?-1:0));
   reads.clear();counting=true;let got;try{got=await listRecentActKeys(db,[actor],options);}finally{counting=false;}
   expect(got.acts).toEqual(merged.slice(offset,offset+options.limit));expect(got.hasMore).toBe(merged.length>offset+options.limit);
   expect([...reads].filter(([n])=>n.includes('/'+col+'/')).reduce((n,[,c])=>n+c,0)).toBe(pages.length);
  }
 });

 it('held sweep retains only its existing page budget, preserving resume and end/wrap semantics',async()=>{
  await complete();const col='meter_held_acts_v1',reason='held-budget-cost',ids=Array.from({length:9},(_,i)=>'held-cap-'+String(i).padStart(4,'0'));
  const writer=raw.batch();for(const id of ids)writer.create(raw.collection(col).doc(storage.privateStorageId(col,id)),storage.encodePrivateRecord(col,id,{relay_pe_id:id,held_reason:reason,key:actKeyDocFor({peId:id,userId:'held-actor',timestamp:2000000000000,actionType:'coding_session'})}));await writer.commit();
  reads.clear();counting=true;try{
   const source=createHeldActSource(db,reason,{startAfter:ids[2],maxResults:4});
   expect((await source.get()).docs.map(d=>d.id)).toEqual(ids.slice(3,7));
   const first=await listHeldActs(db,reason,{limit:2,startAfter:ids[2],source}),second=await listHeldActs(db,reason,{limit:2,startAfter:first.next,source});
   expect([...first.rows,...second.rows].map(r=>r.relayPeId)).toEqual(ids.slice(3,7));expect(second.next).toBe(ids[6]);
   expect((await listHeldActs(db,reason,{limit:2,startAfter:second.next,source})).rows).toEqual([]);
   expect([...reads].filter(([n])=>n.includes('/'+col+'/')).reduce((n,[,c])=>n+c,0)).toBe(9);
  }finally{counting=false;}
  const projected=storage.singleScanQuery(db.collection(col).where('held_reason','==',reason).orderBy('relay_pe_id').startAfter(ids[2]).select('relay_pe_id'),4);
  expect((await projected.get()).size).toBe(4);expect((await projected.select('held_reason').get()).docs.map(d=>d.data())).toEqual(Array.from({length:4},()=>({held_reason:reason})));
  const seen:string[]=[];const pass=()=>walkHeldActs(db,reason,{cursor:{collection:'test_cost_cursor',docId:'held-budget'},nowMs:2000000000000,limit:2,maxPages:2},async row=>{seen.push(row.relayPeId);});
  const reports=[await pass(),await pass(),await pass()];expect(reports.map(r=>r.scanned)).toEqual([4,4,1]);expect(reports.map(r=>r.reached_end)).toEqual([false,false,true]);expect(seen).toEqual(ids);
  const wrap=await pass();expect(wrap.scanned).toBe(4);expect(seen.slice(9)).toEqual(ids.slice(0,4));
 });

});

import {Firestore,FieldValue,FieldPath,Timestamp} from 'firebase-admin/firestore';
import {randomUUID,createHash} from 'crypto';
import {privateFirestore,privateStorageId,encodePrivateRecord,decodePrivateRecord} from './private-store';
import {PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} from './private-retention';
import {buildActPages,meterActPageId} from '../meter/meter-act-pages';
import {takeCutoverInventory} from '../pvt/wp11/cutover-inventory';
import {forEachPrivateMigrationPage} from '../../../scripts/lib/private-migration-page';
const local=process.env.FIRESTORE_EMULATOR_HOST;
const suite=local&&/^(127\.0\.0\.1|localhost):\d+$/.test(local)?describe:describe.skip;
jest.setTimeout(45_000);
suite(' exact logical private storage on real local Firestore',()=>{
 let raw:Firestore,db:Firestore;
 const priorSecret=process.env.RELAY_SIGNING_KEY;
 const coll='meter_act_keys_v1';
 beforeAll(()=>{
  process.env.RELAY_SIGNING_KEY='existing-public-emulator-relay-secret';
  raw=new Firestore({projectId:'demo-meter',databaseId:'d554-'+randomUUID().slice(0,8),ignoreUndefinedProperties:true});
  db=privateFirestore(raw);
 });
 afterAll(async()=>{await raw.terminate();if(priorSecret===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=priorSecret;});
 it('encodes null-prototype summary counters without leaking or dropping their values',async()=>{
  await ready();const counts=Object.create(null) as Record<string,number>;counts.ai_conversation=3;
  const c='meter_batches_v1',id='null-prototype-summary';
  const value={work_summary:{by_type:counts},accepted_at_ms:7};
  await db.collection(c).doc(id).create(value);
  expect((await db.collection(c).doc(id).get()).data()).toEqual(value);
  const physical=await raw.collection(c).doc(privateStorageId(c,id)).get();
  expect(JSON.stringify(physical.data())).not.toContain('ai_conversation');
 });
 it('novelty scalars use secret aliases and encrypted records, never known actor/action/day guesses',async()=>{
  await ready();
  const c='pvt_novelty_counters_v1', id=createHash('sha256').update('pvt:occ:known-actor:ai_conversation:2026-10-08').digest('hex');
  await db.collection(c).doc(id).set({count:51});
  expect((await db.collection(c).doc(id).get()).data()).toEqual({count:51});
  expect((await raw.collection(c).doc(id).get()).exists).toBe(false);
  const physical=await raw.collection(c).doc(privateStorageId(c,id)).get();
  expect(physical.exists).toBe(true);expect(physical.data()?.count).toBeUndefined();
  expect(decodePrivateRecord(c,physical.id,physical.data()!,db).data).toEqual({count:51});
 });
 const ready=async(value=true)=>raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).set({opaque_ids_ready:value});
 async function move(collection:string,id:string):Promise<void>{
  await raw.runTransaction(async tx=>{
   const old=raw.collection(collection).doc(id),target=raw.collection(collection).doc(privateStorageId(collection,id));
   const [a,b]=await Promise.all([tx.get(old),tx.get(target)]);
   if(!a.exists)return;if(b.exists)throw new Error('target collision');
   tx.create(target,encodePrivateRecord(collection,id,decodePrivateRecord(collection,id,a.data()!,db).data));tx.delete(old);
  });
 }
 it('bounded parallel native representation transactions retain 501 exact seals and claims with no original slot remaining',async()=>{
  const collection='identity_pes_legacy_v1',expected=new Map<string,Record<string,unknown>>();
  const ids=Array.from({length:501},(_,i)=>'bounded-native-'+String(i).padStart(4,'0'));
  for(let start=0;start<ids.length;start+=500){const batch=raw.batch();for(const id of ids.slice(start,start+500)){
   const data={claim_id:id,sealed:{gross_wei:'1234567890123456789',snapshot_hash:'original-immutable-'+id},timestamp:7};expected.set(id,data);batch.set(raw.collection(collection).doc(id),data);
  }await batch.commit();}
  await ready();
  for(let start=0;start<ids.length;start+=200)await forEachPrivateMigrationPage(ids.slice(start,start+200),id=>move(collection,id));
  for(const id of ids){expect((await raw.collection(collection).doc(id).get()).exists).toBe(false);const physical=await raw.collection(collection).doc(privateStorageId(collection,id)).get();expect(physical.data()?._provian_store).toBe(1);expect(decodePrivateRecord(collection,physical.id,physical.data()!,db).data).toEqual(expected.get(id));}
 });
 it('RED legacy guessed private hashes and IDs are exposed; cipher/alias retains exact immutable money inputs',async()=>{
  const id='pe_m_private_guessable_hash',old={pe_id:id,pe_hash:'guessable-sha-of-private-path',metadata:{repo:'secret-owner/repository',branch:'secret-branch'},row:{economic_snapshot_hash:'immutable-exact-seal',recordPointsAtomic:'1000000000000000000'},timestamp:1};
  await ready(false);await db.collection(coll).doc(id).create(old);
  expect((await raw.collection(coll).doc(id).get()).data()).toEqual(old); // RED old storage is guessable.
  await ready();await move(coll,id);
  const physical=await raw.collection(coll).doc(privateStorageId(coll,id)).get();
  expect(JSON.stringify(physical.data())).not.toMatch(/secret-owner|secret-branch|guessable-sha|immutable-exact-seal|pe_m_private/);
  expect((await raw.collection(coll).doc(id).get()).exists).toBe(false);
  const recovered=await db.collection(coll).doc(id).get();expect(recovered.id).toBe(id);expect(recovered.data()).toEqual(old);
  await expect(db.collection(coll).doc(id).create(old)).rejects.toMatchObject({code:6});
 });
 it('logical document order, page-size-one, snapshot ties and inclusive mailbox cursors survive inverted HMAC order',async()=>{
  await ready();const names=['cursor-a','cursor-b','cursor-c'];
  await Promise.all(names.map(id=>db.collection('meter_pending_claims_v1').doc(id).create({claim_key:id,group:'cursor',created_at_ms:7})));
  // RED ordering physical HMAC IDs cannot be used as logical claim order.
  const physical=names.map(id=>({id,physical:privateStorageId('meter_pending_claims_v1',id)})).sort((a,b)=>a.physical.localeCompare(b.physical)).map(x=>x.id);
  expect(physical).not.toEqual(names);
  const query=db.collection('meter_pending_claims_v1').where('group','==','cursor').orderBy('created_at_ms').limit(1);
  const a=(await query.get()).docs[0];const b=(await query.startAfter(a).get()).docs[0];const c=(await query.startAfter(b).get()).docs[0];
  expect([a.id,b.id,c.id]).toEqual(names);
  expect((await query.startAt(7,'cursor-b').get()).docs[0].id).toBe('cursor-b');
  const byId=db.collection('meter_pending_claims_v1').where('group','==','cursor').orderBy(FieldPath.documentId()).limit(1);
  expect((await byId.startAfter('cursor-a').get()).docs[0].id).toBe('cursor-b');
  expect((await query.startAfter(c).get()).empty).toBe(true);
 });
 it('mixed legacy/cipher slots and getAll order preserve missing documents; divergent dual slots fail',async()=>{
  const c='identity_acts_v1';await ready(false);await db.collection(c).doc('legacy-row').create({actor_id:'actor',order:1});
  await ready();await db.collection(c).doc('cipher-row').create({actor_id:'actor',order:2});
  const snaps=await db.getAll(db.collection(c).doc('cipher-row'),db.collection(c).doc('missing-row'),db.collection(c).doc('legacy-row'));
  expect(snaps.map(d=>[d.id,d.exists])).toEqual([['cipher-row',true],['missing-row',false],['legacy-row',true]]);
  await raw.collection(c).doc(privateStorageId(c,'legacy-row')).create(encodePrivateRecord(c,'legacy-row',{actor_id:'actor',order:1}));
  expect((await db.collection(c).where('actor_id','==','actor').get()).size).toBe(2);
  await raw.collection(c).doc('legacy-row').set({actor_id:'actor',order:3});
  await expect(db.collection(c).doc('legacy-row').get()).rejects.toThrow('duplicate identity conflict');
  await expect(db.collection(c).get()).rejects.toThrow('duplicate identity conflict');
 });
 it('atomic claim and ordinary counter coexist; concurrent writers produce one owner and no second count',async()=>{
  await ready();const ref=db.collection('device_occurrence_mint_claims').doc('same-occurrence');
  const counter=db.collection('d554_test_counters').doc('owner-count');await counter.set({count:0});
  const claim=()=>db.runTransaction(async tx=>{
   const existing=await tx.get(ref);if(existing.exists)return false;
   tx.create(ref,{claim_id:'same-occurrence',owner_pe_id:'original-logical-pe'});
   // This raw counter write is buffered too: alias reads must finish before it reaches Firestore.
   tx.update(counter,{count:FieldValue.increment(1)});return true;
  });
  const result=await Promise.all([claim(),claim()]);expect(result.filter(Boolean)).toHaveLength(1);
  expect((await counter.get()).data()!.count).toBe(1);
  expect((await ref.get()).data()!.owner_pe_id).toBe('original-logical-pe');
 });
 it('RED stale payout take and stale deletion fail the entire batch after alias migration',async()=>{
  const c='meter_pending_claims_v1',id='stale-take';await ready(false);await db.collection(c).doc(id).create({claim_key:id,status:'ready'});
  const stale=await db.collection(c).doc(id).get();await ready();await move(c,id);
  const take=db.batch();take.update(stale.ref,{status:'taken'},{lastUpdateTime:stale.updateTime!});take.create(db.collection(c).doc('stale-payout'),{status:'payout'});
  await expect(take.commit()).rejects.toMatchObject({code:9});
  expect((await db.collection(c).doc('stale-payout').get()).exists).toBe(false);expect((await stale.ref.get()).data()!.status).toBe('ready');
  await expect(stale.ref.delete({lastUpdateTime:stale.updateTime!})).rejects.toMatchObject({code:9});
  const fresh=await stale.ref.get();await fresh.ref.update({status:'taken'},{lastUpdateTime:fresh.updateTime!});
 });
 it('partial economic map merges, deletes, typed values and all FieldValue transforms preserve exact native semantics',async()=>{
  await ready();const ref=db.collection('meter_batch_acts_v1').doc('transform-test');
  const timestamp=new Timestamp(123,456),literal={__pv_type:'timestamp',seconds:99,nanoseconds:1};
  await ref.create({acts:{pe_a:{row:{points:1,remove:'old'}},pe_b:{row:{points:2}}},count:2,tags:['a'],timestamp,literal});
  await db.runTransaction(async tx=>{
   tx.set(ref,{acts:{pe_a:{row:{points:3,remove:FieldValue.delete()}}}},{merge:true});
   tx.update(ref,{count:FieldValue.increment(2),tags:FieldValue.arrayUnion('b','b'),first_time:FieldValue.serverTimestamp()});
   tx.update(ref,'second_time',FieldValue.serverTimestamp(),'other',4);
  });
  const data=(await ref.get()).data()!;expect(data.acts).toEqual({pe_a:{row:{points:3}},pe_b:{row:{points:2}}});
  expect(data.count).toBe(4);expect(data.tags).toEqual(['a','b']);expect(data.timestamp.isEqual(timestamp)).toBe(true);expect(data.literal).toEqual(literal);
  expect(data.first_time).toBeInstanceOf(Timestamp);expect(data.second_time).toBeInstanceOf(Timestamp);expect(data.other).toBe(4);
  await ref.update({tags:FieldValue.arrayRemove('a'),other:FieldValue.delete()});expect((await ref.get()).data()!.tags).toEqual(['b']);expect((await ref.get()).data()!.other).toBeUndefined();
 });
 it('RED deletion followed by merge never resurrects fields, map equality ignores field order, and literal FieldPath dots stay literal',async()=>{
  await ready();const ref=db.collection('meter_relay_acts_v1').doc('native-semantics');
  await ref.create({old:'remove',literal:{},'literal.dot':1,obj:{a:1,b:2}});
  await ref.update(new FieldPath('literal.dot'),2);expect((await ref.get()).data()!['literal.dot']).toBe(2);expect((await ref.get()).data()!.literal).toEqual({});
  expect((await db.collection('meter_relay_acts_v1').where('obj','==',{b:2,a:1}).get()).size).toBe(1);
  await db.runTransaction(async tx=>{tx.delete(ref);tx.set(ref,{fresh:'only'},{merge:true});});
  expect((await ref.get()).data()).toEqual({fresh:'only'});
 });
 it('transaction queries use the same atomic read set and original logical identities',async()=>{
  await ready();const c='meter_batches_v1';await db.collection(c).doc('batch-original').create({batch_hash:'batch-original',acts_root:'private-old-root',device_id:'d'});
  const result=await db.runTransaction(async tx=>{
   const page=await tx.get(db.collection(c).where('acts_root','in',['private-old-root']).limit(1));
   expect(page.docs[0].id).toBe('batch-original');tx.update(page.docs[0].ref,{anchored:true});
   return page.docs[0].data()!.acts_root;
  });expect(result).toBe('private-old-root');expect((await db.collection(c).doc('batch-original').get()).data()!.anchored).toBe(true);
 });
 it('exempt encrypted fields still support complete logical equality, range and count queries',async()=>{
  await ready();const c='meter_occurrence_sets_v1';
  await db.collection(c).doc('exempt-a').set({actor_id:'exempt',prefix:'a',revision:1,split:false,fingerprints:Buffer.alloc(32,1)});
  await db.collection(c).doc('exempt-b').set({actor_id:'exempt',prefix:'b',revision:2,split:false,fingerprints:Buffer.alloc(32,2)});
  expect((await db.collection(c).where('actor_id','==','exempt').where('prefix','==','a').get()).docs.map(d=>d.id)).toEqual(['exempt-a']);
  expect((await db.collection(c).where('actor_id','==','exempt').where('revision','>=',2).get()).docs.map(d=>d.id)).toEqual(['exempt-b']);
  expect((await db.collection(c).where('actor_id','==','exempt').where('revision','>=',2).count().get()).data().count).toBe(1);
 });
 it('large standalone queries use bounded reads at one fixed snapshot; RED an unpinned long transaction expires',async()=>{
  await ready();const c='pvt9_claim_ledger_v1';
  for(let start=0;start<501;start+=200){const batch=raw.batch();for(let i=start;i<Math.min(start+200,501);i++){const id='read-time-'+String(i).padStart(4,'0');batch.create(raw.collection(c).doc(privateStorageId(c,id)),encodePrivateRecord(c,id,{claim_key:id,index:i}));}await batch.commit();}
  const run=raw.runTransaction.bind(raw),points:Timestamp[]=[];let unavailableAt=Infinity;
  const spy=jest.spyOn(raw,'runTransaction').mockImplementation(((work:any,options:any)=>{
   if(options?.readOnly&&!options.readTime)return Promise.reject(Object.assign(new Error('RED expired long transaction'),{code:10}));
   if(options?.readTime){points.push(options.readTime);if(points.length===unavailableAt)return Promise.reject(Object.assign(new Error('RED pinned snapshot unavailable'),{code:9}));}return run(work,options);
  }) as typeof raw.runTransaction);
  try{
   await expect(raw.runTransaction(tx=>tx.get(raw.collection(c)),{readOnly:true})).rejects.toMatchObject({code:10});
   const docs=(await db.collection(c).orderBy(FieldPath.documentId()).get()).docs;
   expect(docs).toHaveLength(501);expect(docs.map(doc=>doc.data()!.index)).toEqual(Array.from({length:501},(_,i)=>i));
   expect(points).toHaveLength(3);expect(points.every(point=>point.isEqual(points[0]))).toBe(true);
   expect((await db.collection(c).count().get()).data().count).toBe(501);
   expect(await db.collection(c).listDocuments()).toHaveLength(501);
   // RED outer logical pagination repeats a full physical scan per page.
   const get=db.collection.bind(db),logicalReads:string[]=[];
   const inventoryDb=new Proxy(db,{get(target,prop){if(prop!=='collection')return Reflect.get(target,prop,target);return (name:string)=>{
    const collection=get(name);if(name!==c)return collection;
    return new Proxy(collection,{get(target,prop){const value=Reflect.get(target,prop,target);if(prop==='get')return ()=>{logicalReads.push(name);return value.call(target);};if(prop==='orderBy')return ()=>{throw new Error('RED duplicate outer logical inventory scan');};return typeof value==='function'?value.bind(target):value;}});
   };}});
   const inventory=await takeCutoverInventory(inventoryDb,{cutLineMs:1});expect(inventory.pvt9_settlement.claim_ledger_count).toBe(501);expect(logicalReads).toHaveLength(1);
   const before=points.length;unavailableAt=before+3;
   await expect(db.collection(c).get()).rejects.toMatchObject({code:9});
   const failed=points.slice(before);expect(failed).toHaveLength(3);expect(failed.every(point=>point.isEqual(failed[0]))).toBe(true);
  }finally{spy.mockRestore();}
 });
 it('maximum accepted 500-act page remains accepted and round-trips every economic field',async()=>{
  await ready();
  const metadata=Object.fromEntries(Array.from({length:20},(_,i)=>['field'+i,'x'.repeat(16)]));
  const keys=Array.from({length:500},(_,i)=>({relay_pe_id:'pe_m_'+i.toString(16).padStart(48,'0'),actor_id:'actor',device_id:'device',beneficiary_id:null,timestamp:1,action_type:'agent_tool_orchestration',row:{witness_class:'software_observed',metadata},side:{},facts:null,expire_at:null})) as any;
  const pages=buildActPages({batchHash:'1'.repeat(64),actorId:'actor',deviceId:'device',keys});
  expect(pages.reduce((n,p)=>n+p.act_count,0)).toBe(500);
  for(const page of pages){
   const id=meterActPageId(page.batch_hash,page.page),encoded=encodePrivateRecord('meter_batch_acts_v1',id,page);
   // RED the retired universal index exceeds1MiB even before protobuf overhead.
   const universal:Record<string,string>={};
   const walk=(value:any,at:string)=>{if(value&&typeof value==='object'&&!Buffer.isBuffer(value)){for(const [name,child]of Object.entries(value))walk(child,at+'.'+name);}else universal['i_'+require('crypto').createHash('sha256').update(at).digest('hex')]=require('crypto').createHash('sha256').update(JSON.stringify(value)??'null').digest('hex');};
   walk(page,'');
   expect(Buffer.byteLength(JSON.stringify(universal))).toBeGreaterThan(1024*1024);
   expect(Object.keys(encoded._provian_lookup).length).toBeLessThan(30);
   expect(encoded.body.ciphertext.length).toBeLessThan(1024*1024);
   await db.collection('meter_batch_acts_v1').doc(id).create(page);
   expect((await db.collection('meter_batch_acts_v1').doc(id).get()).data()).toEqual(page);
  }
 });
 it('RED legacy JS sorting/type equality differs from native Firestore; private queries keep implicit inequality ordering, mixed types and Date equality',async()=>{
  await ready();const c='pvt9_claim_ledger_v1';
  const fixtures=[['native-a',{group:'native',timestamp:9,sort:3,t:new Date(1)}],['native-z',{group:'native',timestamp:1,sort:'2',t:new Date(1)}]] as const;
  for(const [id,value] of fixtures)await db.collection(c).doc(id).create(value);
  expect([...fixtures].sort(([a],[b])=>a.localeCompare(b))[0][0]).toBe('native-a');
  expect((await db.collection(c).where('group','==','native').where('timestamp','>',0).orderBy('group').limit(1).get()).docs[0].id).toBe('native-z');
  expect((await db.collection(c).where('group','==','native').orderBy('sort').get()).docs.map(d=>d.id)).toEqual(['native-a','native-z']);
  expect((await db.collection(c).where('t','==',Timestamp.fromMillis(1)).get()).size).toBe(2);
  const selected=await db.collection(c).where('group','==','native').select('group').get();expect(selected.docs.every(d=>Object.keys(d.data()!).join()==='group')).toBe(true);
  await raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).set({opaque_records_complete:true},{merge:true});
  expect((await db.collection(c).where('t','==',Timestamp.fromMillis(1)).get()).size).toBe(2);
  expect((await db.collection(c).where('group','in',['native']).orderBy('timestamp').limit(1).get()).docs[0].id).toBe('native-z');
  await ready();
 });
 it('RED private dispute reasons in an outbox and nested inbox stay encrypted with exact cursor identities',async()=>{
  await ready();const text='repo:private-owner/private-work@private-branch',event={event_id:'event-original',data:{reason:text},timestamp:7};
  const nested='agent_wallets/wallet-test/inbox_v1';
  await db.collection('agent_bank_event_outbox_v1').doc('event-original').set(event);
  await db.collection('agent_wallets').doc('wallet-test').collection('inbox_v1').doc('event-original').set(event);
  const physical=await raw.collection(nested).doc(privateStorageId(nested,'event-original')).get();
  expect(JSON.stringify(event)).toContain(text);expect(JSON.stringify(physical.data())).not.toContain(text);
  expect((await db.doc(nested+'/event-original').get()).data()).toEqual(event);
  const ownerQuery=db.collection('agent_wallets').doc('wallet-test').collection('inbox_v1').orderBy('timestamp').limit(1);
  const first=(await ownerQuery.get()).docs[0];expect(first.id).toBe('event-original');expect(first.data()).toEqual(event);
  expect((await ownerQuery.startAfter(first).get()).empty).toBe(true);
  expect((await raw.collection(nested).doc('event-original').get()).exists).toBe(false);
 });
 it('RED wire -0 differs from +0; the completed private scalar index preserves native equality',async()=>{
  await ready();const c='pvt9_claim_ledger_v1',id='indexed-negative-zero';
  const {Serializer}=require('@google-cloud/firestore/build/src/serializer');
  const serializer=new Serializer({_settings:{}});
  expect(serializer.encodeValue(-0)).not.toEqual(serializer.encodeValue(0));
  await db.collection(c).doc(id).set({number:-0});
  await raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).set({opaque_records_complete:true},{merge:true});
  for(const [op,value] of [['==',0],['in',[0]]] as const){
   expect((await db.collection(c).where('number',op,value).get()).docs.map(d=>d.id)).toEqual([id]);
  }
  await ready();
 });
 it('every mixed-type range and membership filter exactly matches the native query',async()=>{
  await ready();const c='meter_pair_counts_v1',control=raw.collection('d554_native_query_control');
  const values=[null,false,true,-1,0,1,NaN,'a','z',new Date(1),Buffer.from('x'),[1],{n:1}];
  for(let i=0;i<values.length;i++){const row={value:values[i]};const id='mixed-'+String(i).padStart(2,'0');await control.doc(id).set(row);await db.collection(c).doc(id).set(row);}
  for(const op of ['<','<=','>','>=','==','!=','in','not-in'] as const){
   for(const operand of [0,'a',null,NaN,new Date(1)]){
    const argument=['in','not-in'].includes(op)?[operand]:operand;
    let nativeQuery:FirebaseFirestore.Query;
    try{nativeQuery=control.where('value',op,argument);}catch{expect(()=>db.collection(c).where('value',op,argument)).toThrow();continue;}
    const native=(await nativeQuery.get()).docs.map(d=>d.id);
    const logical=(await db.collection(c).where('value',op,argument).get()).docs.map(d=>d.id);
    try{expect(logical).toEqual(native);}catch{throw new Error('native query differs: '+op+' operand='+String(operand)+' native='+native.join(',')+' logical='+logical.join(','));}
   }
  }
 });
 it('RED physical first-page limit misses the globally first logical row; limit, count and index read all pages',async()=>{
  await ready();const c='pvt_registry_hold_resolution_v1';
  const ids=Array.from({length:215},(_,i)=>'page-'+String(i).padStart(4,'0'));
  const physical=ids.slice().sort((a,b)=>privateStorageId(c,a).localeCompare(privateStorageId(c,b)));
  const best=physical[210];
  const batch=db.batch();for(const id of ids)batch.create(db.collection(c).doc(id),{group:'page-control',rank:id===best?0:1});await batch.commit();
  expect(physical.slice(0,200)).not.toContain(best);
  const q=db.collection(c).where('group','==','page-control').orderBy('rank').limit(1);
  expect((await q.get()).docs[0].id).toBe(best);
  expect((await q.count().get()).data().count).toBe(1);
  expect((await db.collection(c).where('group','==','page-control').count().get()).data().count).toBe(215);
 });

 it('device health and derived actor keys retain their exact facts only inside protected storage',async()=>{
  await ready();
  const device={owner_type:'agent',owner_wallet_id:'known-owner',capture_health:{format_broken_programs:['private-program-name']},registered_at:1};
  const actor={pe_count:1,model_families:{private_deployment:1},record_points_atomic:'800000000000000000'};
  await db.collection('devices').doc('device-private').create(device);
  await db.collection('actor_stats_v1').doc('actor-private').create(actor);
  expect((await db.collection('devices').doc('device-private').get()).data()).toEqual(device);
  expect((await db.collection('actor_stats_v1').doc('actor-private').get()).data()).toEqual(actor);
  for(const [c,id] of [['devices','device-private'],['actor_stats_v1','actor-private']]){
   expect(JSON.stringify((await raw.collection(c).doc(privateStorageId(c,id)).get()).data())).not.toMatch(/private-program-name|private_deployment|800000000000000000/);
  }
 });

});

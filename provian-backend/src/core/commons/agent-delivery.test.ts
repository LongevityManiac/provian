import {createFakeFirestore} from '../pvt/__test-helpers__/fake-firestore';
import {prepareAgentDelivery,deliveryHead,readDeliveryPage,deliverySequence,DELIVERY_PAGE,acknowledgeDelivery,deliveryCheckpoint,deliveryGeneration,pendingApprovalRef,decodePendingApproval} from './agent-delivery';
import type {Firestore} from 'firebase-admin/firestore';

describe('ordered agent delivery log',()=>{
 it('co-commits metadata, orders two agents independently, and reads only a bounded suffix',async()=>{
  const fake=createFakeFirestore({strictTransactionOrder:true}),db=fake as unknown as Firestore;
  for(let i=0;i<DELIVERY_PAGE+3;i++)await db.runTransaction(async tx=>{const append=await prepareAgentDelivery(db,tx,'a');tx.set(db.collection('messages').doc(String(i)),{ok:true});append('thr_a','msg_'+String(i).padStart(24,'0'));});
  await db.runTransaction(async tx=>(await prepareAgentDelivery(db,tx,'b'))('thr_b','msg_b'));
  expect(deliverySequence(db,await deliveryHead(db,'a').get())).toBe(DELIVERY_PAGE+3);
  const page=await readDeliveryPage(db,'a',0,DELIVERY_PAGE+3);
  expect(page).toHaveLength(DELIVERY_PAGE);expect(page.map(e=>e.sequence)).toEqual(Array.from({length:DELIVERY_PAGE},(_,i)=>i+1));
  expect(await readDeliveryPage(db,'a',DELIVERY_PAGE,DELIVERY_PAGE+3)).toHaveLength(3);
  expect(await readDeliveryPage(db,'a',DELIVERY_PAGE+3,DELIVERY_PAGE+3)).toEqual([]);
  expect((await readDeliveryPage(db,'b',0,1))[0].thread_id).toBe('thr_b');
 });
 it('RED: an aborted message transaction leaves no notification or sequence gap',async()=>{
  const db=createFakeFirestore() as unknown as Firestore;
  await expect(db.runTransaction(async tx=>{(await prepareAgentDelivery(db,tx,'a'))('thr_a','msg_a');throw new Error('abort');})).rejects.toThrow('abort');
  expect((await deliveryHead(db,'a').get()).exists).toBe(false);
  await db.runTransaction(async tx=>(await prepareAgentDelivery(db,tx,'a'))('thr_a','msg_b'));
  expect((await readDeliveryPage(db,'a',0,1))[0].sequence).toBe(1);
 });
 it('RED: missing durable rows and damaged heads fail closed',async()=>{
  const db=createFakeFirestore() as unknown as Firestore;
  await expect(readDeliveryPage(db,'a',0,1)).rejects.toThrow('Delivery log gap');
  await deliveryHead(db,'a').set({sequence:'bad'});
  expect(()=>deliverySequence(db,{exists:true,data:()=>({sequence:'bad'})} as never)).toThrow('Invalid delivery sequence');
 });
});


describe('legacy delivery upgrade',()=>{
 it('only queues unread legacy messages in time order, once, without any PE',async()=>{
  const fake=createFakeFirestore(),db=fake as unknown as Firestore;
  fake.store.set('commons_threads/thr_legacy',{party_a:'human',party_b:'agent',parties:{agent:{kind:'agent'}},read_cursors:{agent:10}});
  fake.store.set('commons_thread_messages/z',{thread_id:'thr_legacy',author_id:'human',created_at:20});
  fake.store.set('commons_thread_messages/a',{thread_id:'thr_legacy',author_id:'human',created_at:30});
  fake.store.set('commons_thread_messages/read',{thread_id:'thr_legacy',author_id:'human',created_at:5});
  const {migrateCommonsDelivery}=await import('../../../scripts/migrate-commons-delivery');
  expect(await migrateCommonsDelivery(db,false)).toMatchObject({scanned:3,candidates:2,enqueued:0});
  expect(await migrateCommonsDelivery(db,true)).toMatchObject({enqueued:2});
  expect(await migrateCommonsDelivery(db,true)).toMatchObject({enqueued:0});
  expect((await readDeliveryPage(db,'agent',0,2,deliveryGeneration(db,await deliveryHead(db,'agent').get()))).map(e=>e.message_id)).toEqual(['z','a']);
  expect([...fake.store.keys()].filter(k=>k.includes('meter_')||k.includes('pe_'))).toEqual([]);
 });
});


describe('durable relay acknowledgment',()=>{
 it('refuses to skip unseen sequence and survives a later append',async()=>{
  const db=createFakeFirestore() as unknown as Firestore;
  await db.runTransaction(async tx=>(await prepareAgentDelivery(db,tx,'a'))('thr_a','msg_a'));
  await expect(acknowledgeDelivery(db,'a',2)).rejects.toThrow('Invalid acknowledgment');
  const pending={sequence:1,thread_id:'thr_a',message_id:'msg_a',approval_id:'req_1'};
  await acknowledgeDelivery(db,'a',1,pending);
  await db.runTransaction(async tx=>(await prepareAgentDelivery(db,tx,'a'))('thr_a','msg_b'));
  expect(deliveryCheckpoint(db,await deliveryHead(db,'a').get())).toEqual({cursor:1});
  expect(decodePendingApproval(db,await pendingApprovalRef(db,'a','req_1').get())).toEqual(pending);
  expect(deliveryCheckpoint(db,await deliveryHead(db,'b').get())).toEqual({cursor:0});
 });
});


describe('concurrent rollout ordering',()=>{
 it('prepends old unread work ahead of the live generation without changing its messages or PEs',async()=>{
  const fake=createFakeFirestore(),db=fake as unknown as Firestore;
  fake.store.set('commons_threads/thr_mix',{party_a:'human',party_b:'agent',parties:{agent:{kind:'agent'}},read_cursors:{}});
  fake.store.set('commons_thread_messages/old',{thread_id:'thr_mix',author_id:'human',created_at:100});
  await db.runTransaction(async tx=>{const append=await prepareAgentDelivery(db,tx,'agent');append('thr_mix','new');tx.set(db.collection('commons_thread_messages').doc('new'),{thread_id:'thr_mix',author_id:'human',created_at:200,notification_sequence:append.sequence});});
  const {migrateCommonsDelivery}=await import('../../../scripts/migrate-commons-delivery');await migrateCommonsDelivery(db,true);
  const generation=deliveryGeneration(db,await deliveryHead(db,'agent').get());
  expect((await readDeliveryPage(db,'agent',0,2,generation)).map(e=>e.message_id)).toEqual(['old','new']);
  expect(fake.store.get('commons_thread_messages/old')?.notification_legacy).toBe(true);
  expect(fake.store.get('commons_thread_messages/new')?.notification_legacy).toBeUndefined();
 });
});


describe('pending approval scale',()=>{
 it('650 pending requests use bounded acknowledgment deltas and never grow the head document',async()=>{
  const db=createFakeFirestore() as unknown as Firestore;
  await db.runTransaction(async tx=>(await prepareAgentDelivery(db,tx,'a'))('thr_a','msg_a'));
  for(let i=0;i<650;i++)await acknowledgeDelivery(db,'a',1,{sequence:1,thread_id:'thr_a',message_id:'msg_a',approval_id:'request_'+i});
  expect((await deliveryHead(db,'a').collection('pending').get()).docs).toHaveLength(650);
  expect(JSON.stringify((await deliveryHead(db,'a').get()).data()).length).toBeLessThan(100);
  await acknowledgeDelivery(db,'a',1,undefined,'request_649');
  expect((await pendingApprovalRef(db,'a','request_649').get()).exists).toBe(false);
 });
});

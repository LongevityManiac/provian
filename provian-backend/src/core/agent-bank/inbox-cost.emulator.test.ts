import {Firestore} from 'firebase-admin/firestore';
import {randomUUID} from 'crypto';
import {privateFirestore,privateStorageId,encodePrivateRecord,decodePrivateRecord} from '../provenance/private-store';
import {PRIVATE_RETENTION_STATE_COLLECTION as STATE,PRIVATE_RETENTION_STATE_DOC as DOC} from '../provenance/private-retention';
import {writeInboxEvent,readInbox,deterministicInboxEventId} from './agent-inbox';
import {INBOX_HEAD_COLLECTION} from './inbox-head';
import {backfillInboxHeads} from '../../../scripts/lib/inbox-head-backfill';
const suite=/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST??'')?describe:describe.skip;
jest.setTimeout(120_000);
suite('encrypted inbox head eliminates caught-up lifetime scans',()=>{
 let raw:Firestore,db:Firestore;const prior=process.env.RELAY_SIGNING_KEY;const wallet='local-wallet';const collection=`agent_wallets/${wallet}/inbox_v1`;
 beforeEach(async()=>{process.env.RELAY_SIGNING_KEY='public-local-inbox-cost-proof';raw=new Firestore({projectId:'demo-cost-cut',databaseId:'inbox-'+randomUUID().slice(0,8)});db=privateFirestore(raw);await raw.collection(STATE).doc(DOC).set({opaque_ids_ready:true,opaque_records_complete:true});});
 afterEach(async()=>{jest.restoreAllMocks();await raw.terminate();if(prior===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=prior;});
 it('backfill preserves 1,001 original events; caught-up polls perform no event query and keep the same empty response',async()=>{
  const ids=Array.from({length:1001},(_,i)=>deterministicInboxEventId(1000+i,'event-'+i));
  for(let at=0;at<ids.length;at+=400){const b=raw.batch();for(const id of ids.slice(at,at+400)){b.create(raw.collection(collection).doc(privateStorageId(collection,id)),encodePrivateRecord(collection,id,{event_id:id,event:'test',created_at:1}));}await b.commit();}
  const before=await raw.collection(collection).get();expect(await readInbox(db,wallet,{cursor:ids.at(-1)})).toEqual({events:[],next_cursor:null});
  expect(await backfillInboxHeads(raw,true)).toEqual({events:1001,wallets:1,verified:1});
  for(const d of before.docs)expect((await d.ref.get()).get('body')).toEqual(d.get('body'));
  const spy=jest.spyOn(raw,'runTransaction');expect(await readInbox(db,wallet,{cursor:ids.at(-1)})).toEqual({events:[],next_cursor:null});expect(spy).not.toHaveBeenCalled();
  // Exact catch-up page and cursor remain the original chronological document ordering.
  const page=await readInbox(db,wallet,{cursor:ids[500],limit:50});expect(page.events.map(e=>e.event_id)).toEqual(ids.slice(501,551));expect(page.next_cursor).toBe(ids[550]);
 });
 it('atomic concurrent appends, backdated deterministic retry and missing/orphan heads never hide an event',async()=>{
  await raw.collection(STATE).doc(DOC).set({inbox_heads_version:1},{merge:true});
  const ids=await Promise.all([writeInboxEvent(db,{recipient:wallet,event:'late',nowMs:2000}),writeInboxEvent(db,{recipient:wallet,event:'early',nowMs:1000})]);ids.sort();
  expect((await db.collection(INBOX_HEAD_COLLECTION).doc(wallet).get()).get('last_event_id')).toBe(ids[1]);
  await writeInboxEvent(db,{recipient:wallet,event:'retry',nowMs:1,eventId:ids[0]});expect((await db.collection(INBOX_HEAD_COLLECTION).doc(wallet).get()).get('last_event_id')).toBe(ids[1]);
  expect((await readInbox(db,wallet,{cursor:ids[0]})).events.map(e=>e.event_id)).toEqual([ids[1]]);
  await db.collection(INBOX_HEAD_COLLECTION).doc(wallet).delete();expect((await readInbox(db,wallet,{cursor:ids[0]})).events.map(e=>e.event_id)).toEqual([ids[1]]);
  await db.collection(INBOX_HEAD_COLLECTION).doc(wallet).set({schema:'provian.inbox-head.v1',last_event_id:'999999999999999_orphan'});expect((await readInbox(db,wallet,{cursor:'999999999999999_orphan'})).events).toEqual([]);
  // The orphan forces the original query, rather than trusting a head left by a partial restore.
  const spy=jest.spyOn(raw,'runTransaction');await readInbox(db,wallet,{cursor:'999999999999999_orphan'});expect(spy).toHaveBeenCalled();
  await db.collection(INBOX_HEAD_COLLECTION).doc(wallet).set({schema:'provian.inbox-head.v1',last_event_id:'invalid/path'});
  expect((await readInbox(db,wallet,{cursor:ids[0]})).events.map(e=>e.event_id)).toEqual([ids[1]]);
  const physical=raw.collection(INBOX_HEAD_COLLECTION).doc(privateStorageId(INBOX_HEAD_COLLECTION,wallet));
  await physical.update({'body.ciphertext':Buffer.from('unreadable derived head')});
  expect((await readInbox(db,wallet,{cursor:ids[0]})).events.map(e=>e.event_id)).toEqual([ids[1]]);

 });
 it('a failed rebuild closes an existing certificate before encountering representation drift',async()=>{
  await raw.collection(STATE).doc(DOC).set({inbox_heads_version:1},{merge:true});
  await raw.collection(collection).doc('stray').set({event_id:'stray'});
  await expect(backfillInboxHeads(raw,true)).rejects.toThrow('inbox representation drift');
  expect((await raw.collection(STATE).doc(DOC).get()).get('inbox_heads_version')).toBe(0);
 });

 it('unreadable or conflicting derived heads never block authoritative concurrent appends or hide their events',async()=>{
  await raw.collection(STATE).doc(DOC).set({inbox_heads_version:1},{merge:true});
  const first=await writeInboxEvent(db,{recipient:wallet,event:'first',nowMs:1000});
  const original=await raw.collection(collection).doc(privateStorageId(collection,first)).get();
  const head=raw.collection(INBOX_HEAD_COLLECTION).doc(privateStorageId(INBOX_HEAD_COLLECTION,wallet));
  await head.update({'body.ciphertext':Buffer.from('unreadable derived head')});
  const added=await Promise.all([writeInboxEvent(db,{recipient:wallet,event:'second',nowMs:2000}),writeInboxEvent(db,{recipient:wallet,event:'third',nowMs:3000})]);
  expect((await readInbox(db,wallet,{cursor:first})).events.map(e=>e.event_id)).toEqual(added.sort());
  expect((await db.collection(INBOX_HEAD_COLLECTION).doc(wallet).get()).get('schema')).toBe('provian.inbox-head.invalid');
  expect((await raw.collection(collection).doc(privateStorageId(collection,first)).get()).get('body')).toEqual(original.get('body'));
  await raw.collection(INBOX_HEAD_COLLECTION).doc(wallet).set(encodePrivateRecord(INBOX_HEAD_COLLECTION,wallet,{schema:'provian.inbox-head.v1',last_event_id:'conflicting'}));
  const fourth=await writeInboxEvent(db,{recipient:wallet,event:'fourth',nowMs:4000});
  // A completed migration reads only the authoritative opaque slot. An injected legacy
  // alias stays outside that certified read path until a verified rebuild refuses it.
  expect((await raw.collection(INBOX_HEAD_COLLECTION).doc(wallet).get()).exists).toBe(true);
  expect((await readInbox(db,wallet,{cursor:added[0]})).events.map(e=>e.event_id)).toEqual([added[1],fourth]);
  // The uncertified per-wallet head stays on the complete-query path until a verified rebuild.
  const queried=jest.spyOn(raw,'runTransaction');
  expect(await readInbox(db,wallet,{cursor:fourth})).toEqual({events:[],next_cursor:null});
  expect(queried).toHaveBeenCalled();
  queried.mockRestore();
  expect(await backfillInboxHeads(raw,true)).toEqual({events:4,wallets:1,verified:1});
  const rebuilt=await head.get();
  expect(decodePrivateRecord(INBOX_HEAD_COLLECTION,rebuilt.id,rebuilt.data()!,raw).data.last_event_id).toBe(fourth);
 });

 it('retries and concurrent writers preserve the first event body for a shared ID',async()=>{
  const id=await writeInboxEvent(db,{recipient:wallet,event:'original',nowMs:1000,data:{value:'first'}});
  const ref=raw.collection(collection).doc(privateStorageId(collection,id));
  const before=(await ref.get()).data();
  await Promise.all(Array.from({length:4},(_,i)=>writeInboxEvent(db,{recipient:wallet,event:'replacement',eventId:id,nowMs:2000+i,data:{value:'changed'}})));
  expect((await ref.get()).data()).toEqual(before);
  expect((await readInbox(db,wallet)).events).toMatchObject([{event_id:id,event:'original',data:{value:'first'},created_at:1000}]);
  const fresh=deterministicInboxEventId(3000,'concurrent');
  await Promise.all(['one','two'].map(event=>writeInboxEvent(db,{recipient:wallet,event,eventId:fresh,nowMs:3000})));
  const stored=(await db.collection(collection).doc(fresh).get()).data();
  expect(['one','two']).toContain(stored?.event);
  await writeInboxEvent(db,{recipient:wallet,event:'third',eventId:fresh,nowMs:4000});
  expect((await db.collection(collection).doc(fresh).get()).data()).toEqual(stored);
 });

 it('an authoritative event failure still refuses the append without modifying a healthy derived head',async()=>{
  const id=await writeInboxEvent(db,{recipient:wallet,event:'first',nowMs:1000});
  const head=raw.collection(INBOX_HEAD_COLLECTION).doc(privateStorageId(INBOX_HEAD_COLLECTION,wallet));
  const before=(await head.get()).data();
  const event=raw.collection(collection).doc(privateStorageId(collection,id));
  await event.update({'body.ciphertext':Buffer.from('unreadable authoritative event')});
  const damaged=(await event.get()).data();
  await expect(writeInboxEvent(db,{recipient:wallet,event:'retry',eventId:id,nowMs:2000})).rejects.toThrow();
  expect((await head.get()).data()).toEqual(before);
  expect((await event.get()).data()).toEqual(damaged);
 });

});

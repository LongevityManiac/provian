import {Firestore} from 'firebase-admin/firestore';
import {createHash,randomUUID} from 'crypto';
import {privateFirestore,privateStorageId,encodePrivateRecord} from '../provenance/private-store';
import {PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} from '../provenance/private-retention';
import {buildPendingClaim,buildPayoutClaim,meterBatchClaimId,meterBatchClaimKey} from './meter-claims';
import {runMeterClaimInlet} from './meter-settlement';
import {METER_PENDING_CLAIMS_COLLECTION as CLAIMS} from './meter-store';

const host=process.env.FIRESTORE_EMULATOR_HOST;
const suite=host&&/^(127\.0\.0\.1|localhost):\d+$/.test(host)?describe:describe.skip;
jest.setTimeout(120_000);
suite('cost-cut: identical claims with one physical read per pending claim',()=>{
 let raw:Firestore,db:Firestore,control:Firestore;
 const secret=process.env.RELAY_SIGNING_KEY;
 const nowMs=1_800_000_000_000;
 beforeAll(()=>{
  process.env.RELAY_SIGNING_KEY='public-local-claim-cost-proof';
  raw=new Firestore({projectId:'demo-cost-cut',databaseId:'private-'+randomUUID().slice(0,8),ignoreUndefinedProperties:true});
  db=privateFirestore(raw);
  control=new Firestore({projectId:'demo-cost-cut',databaseId:'control-'+randomUUID().slice(0,8),ignoreUndefinedProperties:true});
 });
 afterAll(async()=>{await Promise.all([raw.terminate(),control.terminate()]);if(secret===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=secret;});
 function claim(i:number,waiting=false){
  const identity={batch_hash:createHash('sha256').update('batch-'+i).digest('hex'),leg:'sole' as const,contributor:'0x'+(i%7+1).toString(16).padStart(40,'0'),beneficiary_class:1};
  return buildPendingClaim({...identity,claim_key:meterBatchClaimKey(identity),claim_id:meterBatchClaimId(identity),unit:'batch',device_id:'device',actor_id:'agent',record_points_atomic:String(1000+i),acts:[{relay_pe_id:'pe_local_'+i,points_atomic:String(1000+i)}],created_at_ms:nowMs-1000,ready_at_ms:waiting?nowMs+1000:0});
 }
 async function seed(count:number,waiting=false){
  await raw.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).set({opaque_ids_ready:true,opaque_records_complete:true});
  for(let start=0;start<count;start+=400){const a=raw.batch(),b=control.batch();for(let i=start;i<Math.min(start+400,count);i++){
   const c=claim(i,waiting),id=c.claim_key;
   a.create(raw.collection(CLAIMS).doc(privateStorageId(CLAIMS,id)),encodePrivateRecord(CLAIMS,id,c));b.create(control.collection(CLAIMS).doc(id),c);
  }await Promise.all([a.commit(),b.commit()]);}
 }
 function reads(after?: (result:unknown,options:any)=>Promise<void>){
  const hits=new Map<string,number>(),run=raw.runTransaction.bind(raw);
  const spy=jest.spyOn(raw,'runTransaction').mockImplementation(((work:any,options:any)=>run(async tx=>work(new Proxy(tx,{get(target,prop){
   if(prop==='get')return async(q:any)=>{const snap:any=await tx.get(q);const docs=snap.docs??(snap.exists?[snap]:[]);for(const d of docs)if(d.ref.parent.id===CLAIMS)hits.set(d.id,(hits.get(d.id)??0)+1);return snap;};
   const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
  }})),options).then(async result=>{if(after)await after(result,options);return result;})) as typeof raw.runTransaction);
  return {hits,stop:()=>spy.mockRestore()};
 }
 it('RED paginated encrypted query reads 1,201 claims three times; GREEN inlet matches native payouts and ledger exactly',async()=>{
  await seed(1201);
  const old=reads();let after:string|undefined;
  for(;;){let q=db.collection(CLAIMS).where('state','==','pending').orderBy('claim_key').limit(500);if(after)q=q.startAfter(after);const page=await q.get();if(page.size<500)break;after=page.docs.at(-1)!.get('claim_key');}
  old.stop();expect(old.hits.size).toBe(1201);expect([...old.hits.values()].every(n=>n===3)).toBe(true);
  const expected=await runMeterClaimInlet(control,{nowMs,pageSize:500});
  const actualReads=reads();const actual=await runMeterClaimInlet(db,{nowMs,pageSize:500});actualReads.stop();
  for(let i=0;i<1201;i++)expect(actualReads.hits.get(privateStorageId(CLAIMS,claim(i).claim_key))).toBe(1);
  expect(actual).toEqual(expected);expect(actual.scanned).toBe(1201);expect(actual.aggregated).toBe(1201);
  for(const name of [CLAIMS,'pvt9_claim_ledger_v1']){
   const a=(await db.collection(name).get()).docs.map(d=>({id:d.id,data:d.data()})).sort((x,y)=>x.id.localeCompare(y.id));
   const b=(await control.collection(name).get()).docs.map(d=>({id:d.id,data:d.data()})).sort((x,y)=>x.id.localeCompare(y.id));expect(a).toEqual(b);
  }
 });
 it('existing pending payouts are each read once; a competing finalization cannot abort the other payee',async()=>{
  const pending=[claim(70000),claim(70001)].map(c=>buildPayoutClaim({leg:'sole',contributor:c.contributor,beneficiary_class:c.beneficiary_class,members:[{claim_key:c.claim_key,claim_id:c.claim_id,points_atomic:c.record_points_atomic}],created_at_ms:nowMs}));
  for(const p of pending)await raw.collection(CLAIMS).doc(privateStorageId(CLAIMS,p.claim_key)).create(encodePrivateRecord(CLAIMS,p.claim_key,p));
  const first=[...pending].sort((a,b)=>a.claim_key.localeCompare(b.claim_key))[0];
  let raced=false;
  const tracked=reads(async(_result,options)=>{
   if(!options?.readOnly&&!raced){raced=true;await raw.collection(CLAIMS).doc(privateStorageId(CLAIMS,first.claim_key)).set(encodePrivateRecord(CLAIMS,first.claim_key,{...first,state:'registered',registered_at_ms:nowMs}));}
  });
  const result=await runMeterClaimInlet(db,{nowMs});tracked.stop();
  expect(raced).toBe(true);expect(result.registered).toBe(2);expect(result.rejected).toEqual([]);
  for(const p of pending){expect(tracked.hits.get(privateStorageId(CLAIMS,p.claim_key))).toBe(1);expect((await db.collection(CLAIMS).doc(p.claim_key).get()).get('state')).toBe('registered');}
 });
 it('RED a competing demotion defeats the captured-version atomic take; no payout or slice is created',async()=>{
  const c=claim(99999),id=privateStorageId(CLAIMS,c.claim_key),ref=raw.collection(CLAIMS).doc(id);
  await ref.create(encodePrivateRecord(CLAIMS,c.claim_key,c));
  const scanned=(await db.collection(CLAIMS).where('claim_key','==',c.claim_key).get()).docs[0];
  await ref.update({body:encodePrivateRecord(CLAIMS,c.claim_key,{...c,state:'voided'}).body});
  const write=db.batch();write.update(scanned.ref,{state:'aggregated'},{lastUpdateTime:scanned.updateTime});write.create(db.collection(CLAIMS).doc('race-payout'),{state:'pending'});
  const tracked=reads();await expect(write.commit()).rejects.toMatchObject({code:9});tracked.stop();
  expect(tracked.hits.get(id)).toBeUndefined();expect((await db.collection(CLAIMS).doc('race-payout').get()).exists).toBe(false);
  expect((await scanned.ref.get()).get('state')).toBe('voided');
 });
});

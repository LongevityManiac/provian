/** One-time bounded-page upgrade: enqueue legacy unread agent messages without recording work. */
import type {Firestore,DocumentData} from 'firebase-admin/firestore';
import {randomBytes} from 'crypto';
import {scriptDb} from './lib/script-db';
import {rawPrivateFirestore,decodePrivateRecord} from '../src/core/provenance/private-store';
import {deliveryHead,deliverySequence,deliveryGeneration,readDeliveryPage,decodeDeliveryRecord,encodeDeliveryRecord,DELIVERY_COLLECTION} from '../src/core/commons/agent-delivery';
export async function migrateCommonsDelivery(db:Firestore,apply=false):Promise<{apply:boolean;scanned:number;candidates:number;enqueued:number}>{
 const raw=rawPrivateFirestore(db);
 const legacy:Array<{id:string;message:DocumentData;recipient:string}>=[];
 let cursor:string|undefined,scanned=0,candidates=0,enqueued=0;
 for(;;){
  let query=raw.collection('commons_thread_messages').orderBy('__name__').limit(200);
  if(cursor)query=query.startAfter(cursor);
  const page=await query.get();
  for(const physical of page.docs){
   scanned++;
   const decoded=decodePrivateRecord('commons_thread_messages',physical.id,physical.data(),db),message=decoded.data;
   if(message.notification_sequence!==undefined)continue;
   const thread=(await db.collection('commons_threads').doc(message.thread_id).get()).data();
   if(!thread)throw new Error('Legacy message has no thread');
   const recipient=[thread.party_a,thread.party_b].find(p=>p!==message.author_id);
   if(!recipient||thread.parties?.[recipient]?.kind!=='agent'||message.created_at<=(thread.read_cursors?.[recipient]??0))continue;
   candidates++;legacy.push({id:decoded.id,message,recipient});
  }
  if(page.docs.length<200)break;cursor=page.docs.at(-1)!.id;
 }
 if(apply){
  const state=await raw.collection('commons_delivery_state_v1').doc('current').get();
  if(state.get('active')===true&&legacy.length)throw new Error('Stop legacy consumers and deactivate the stream before migration');
  const wallets=[...new Set(legacy.map(row=>row.recipient))];
  for(const wallet of wallets){
   const head=deliveryHead(db,wallet);
   for(;;){
    const snapshot=await head.get(),sequence=deliverySequence(db,snapshot),generation=deliveryGeneration(db,snapshot);
    const row=decodeDeliveryRecord(db,DELIVERY_COLLECTION,snapshot);
    if(Number(row?.acknowledged??0)!==0)throw new Error('Cannot resequence an acknowledged log');
    const union=new Map(legacy.filter(item=>item.recipient===wallet).map(item=>[item.id,item.message]));
    for(let after=0;after<sequence;after+=50)for(const event of await readDeliveryPage(db,wallet,after,sequence,generation)){
     const message=(await db.collection('commons_thread_messages').doc(event.message_id).get()).data();
     if(!message)throw new Error('Delivery message missing');union.set(event.message_id,message);
    }
    const sorted=[...union].sort(([a,x],[b,y])=>x.created_at-y.created_at||a.localeCompare(b));
    const next='g_'+randomBytes(12).toString('hex'),collection='events_'+next,domain=head.path+'/'+collection;
    // Build a new immutable generation in bounded batches. Live writers keep using the old one.
    for(let offset=0;offset<sorted.length;offset+=400){
     const batch=raw.batch();
     for(let i=offset;i<Math.min(sorted.length,offset+400);i++){
      const id=String(i+1).padStart(16,'0'),[messageId,message]=sorted[i];
      batch.set(head.collection(collection).doc(id),encodeDeliveryRecord(db,domain,id,{sequence:i+1,thread_id:message.thread_id,message_id:messageId}));
     }
     await batch.commit();
    }
    let swapped=false;
    await db.runTransaction(async tx=>{
     const current=await tx.get(head),currentRow=decodeDeliveryRecord(db,DELIVERY_COLLECTION,current);
     if(deliverySequence(db,current)!==sequence||deliveryGeneration(db,current)!==generation)return;
     if(Number(currentRow?.acknowledged??0)!==0)throw new Error('Consumer must remain stopped during migration');
     tx.set(head,encodeDeliveryRecord(db,DELIVERY_COLLECTION,wallet,{...currentRow,sequence:sorted.length,generation:next,acknowledged:0}));swapped=true;
    });
    if(!swapped)continue; // A live append won. Rebuild from its newer frontier, never block that send.
    for(let offset=0;offset<sorted.length;offset+=200){
     const batch=db.batch();
     for(let i=offset;i<Math.min(sorted.length,offset+200);i++){
      const [id,message]=sorted[i];batch.update(db.collection('commons_thread_messages').doc(id),{notification_sequence:i+1,...(message.notification_sequence===undefined?{notification_legacy:true}:{})});
     }
     await batch.commit();
    }
    enqueued+=legacy.filter(item=>item.recipient===wallet).length;break;
   }
  }
 }
 return {apply,scanned,candidates,enqueued};
}
if(require.main===module)void (async()=>{
 const db=scriptDb(),apply=process.argv.includes('--execute');
 const result=await migrateCommonsDelivery(db,apply);
 if(process.argv.includes('--activate')){
  if(!apply)throw new Error('--activate requires --execute');
  await rawPrivateFirestore(db).collection('commons_delivery_state_v1').doc('current').set({active:true});
 }
 console.log(JSON.stringify(result));
})().catch(error=>{console.error(error instanceof Error?error.message:'Migration failed');process.exitCode=1;});

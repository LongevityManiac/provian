import {FieldPath,type Firestore,type QueryDocumentSnapshot} from 'firebase-admin/firestore';
import {decodePrivateRecord,encodePrivateRecord,privateStorageId} from '../../src/core/provenance/private-store';
import {INBOX_HEAD_COLLECTION,inboxIdCompare,validInboxHead} from '../../src/core/agent-bank/inbox-head';
import {PRIVATE_RETENTION_STATE_COLLECTION as STATE,PRIVATE_RETENTION_STATE_DOC as DOC} from '../../src/core/provenance/private-retention';

/** Derived, encrypted inbox frontier. Original event objects and their chronology stay exact.
 * Run after compatible traffic and old-request drain; each scan has a fixed snapshot. */
export async function backfillInboxHeads(raw:Firestore,execute:boolean):Promise<{events:number;wallets:number;verified:number}> {
 const state=raw.collection(STATE).doc(DOC),ready=(await state.get()).data();
 if(ready?.opaque_records_complete!==true||ready.opaque_ids_ready!==true)throw new Error('inbox heads require certified opaque storage');
 if(execute)await state.set({inbox_heads_version:0},{merge:true});
 async function scan():Promise<{max:Map<string,string>;events:number}> {
  const point=await state.get(),max=new Map<string,string>();let after:QueryDocumentSnapshot|undefined,events=0;
  for(;;){let q=raw.collectionGroup('inbox_v1').orderBy(FieldPath.documentId()).limit(200);if(after)q=q.startAfter(after);
   const page=await raw.runTransaction(tx=>tx.get(q),{readOnly:true,readTime:point.readTime});
   for(const doc of page.docs){const collection=doc.ref.parent.path;if(!/^agent_wallets\/[^/]+\/inbox_v1$/.test(collection))continue;
    const value=decodePrivateRecord(collection,doc.id,doc.data(),raw);if(doc.data()._provian_store!==1||doc.id!==privateStorageId(collection,value.id)||value.data.event_id!==value.id)throw new Error('inbox representation drift');
    const wallet=doc.ref.parent.parent!.id,prior=max.get(wallet);if(prior===undefined||inboxIdCompare(value.id,prior)>0)max.set(wallet,value.id);events++;
   }
   if(page.size<200)break;after=page.docs.at(-1);
  }
  return {max,events};
 }
 const first=await scan();
 if(execute)for(const [wallet,id] of first.max){const ref=raw.collection(INBOX_HEAD_COLLECTION).doc(privateStorageId(INBOX_HEAD_COLLECTION,wallet));
  await raw.runTransaction(async tx=>{const current=await tx.get(ref);const head=current.exists?decodePrivateRecord(INBOX_HEAD_COLLECTION,current.id,current.data()!,raw).data:undefined;
   const last=validInboxHead(head)&&inboxIdCompare(head.last_event_id,id)>0?head.last_event_id:id;
   tx.set(ref,encodePrivateRecord(INBOX_HEAD_COLLECTION,wallet,{schema:'provian.inbox-head.v1',last_event_id:last}));
  });
 }
 let verified=0;
 if(execute){const second=await scan();for(const [wallet,id] of second.max){const physical=await raw.collection(INBOX_HEAD_COLLECTION).doc(privateStorageId(INBOX_HEAD_COLLECTION,wallet)).get();
   const head=physical.exists?decodePrivateRecord(INBOX_HEAD_COLLECTION,physical.id,physical.data()!,raw).data:undefined;
   if(!validInboxHead(head)||inboxIdCompare(head.last_event_id,id)<0)throw new Error('inbox head verification incomplete');
   const collection=`agent_wallets/${wallet}/inbox_v1`,last=await raw.collection(collection).doc(privateStorageId(collection,head.last_event_id)).get();
   if(!last.exists||decodePrivateRecord(collection,last.id,last.data()!,raw).data.event_id!==head.last_event_id)throw new Error('inbox head orphan');verified++;
  }
  await state.set({inbox_heads_version:1,inbox_heads_completed_at_ms:Date.now()},{merge:true});
 }
 return {events:first.events,wallets:first.max.size,verified};
}

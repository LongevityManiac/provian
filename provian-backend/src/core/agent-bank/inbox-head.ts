import type {DocumentData,Firestore} from 'firebase-admin/firestore';
import {compareUtf8Strings} from '@google-cloud/firestore/build/src/order';
import {isDeepStrictEqual} from 'util';
import {decodePrivateRecord,encodePrivateRecord,privateStorageId,rawPrivateFirestore} from '../provenance/private-store';
export const INBOX_HEAD_COLLECTION='agent_inbox_heads_v1';
export const inboxIdCompare=compareUtf8Strings;
export interface InboxHead {schema:'provian.inbox-head.v1';last_event_id:string}
export function validInboxHead(data:DocumentData|undefined):data is InboxHead {
 return data?.schema==='provian.inbox-head.v1'&&typeof data.last_event_id==='string'&&data.last_event_id.length>0&&!data.last_event_id.includes('/')&&data.last_event_id!=='.'&&data.last_event_id!=='..'&&Buffer.byteLength(data.last_event_id,'utf8')<=1500;
}

/** Recover only a damaged derived index, never an authoritative inbox event. Native
 * transaction reads fence concurrent repairs/appends. An invalid marker keeps the
 * empty-poll shortcut disabled until a complete inbox rebuild verifies the frontier. */
export async function recoverDamagedInboxHead(db:Firestore,wallet:string,eventId:string):Promise<void> {
 const raw=rawPrivateFirestore(db);
 const opaque=raw.collection(INBOX_HEAD_COLLECTION).doc(privateStorageId(INBOX_HEAD_COLLECTION,wallet));
 const legacy=raw.collection(INBOX_HEAD_COLLECTION).doc(wallet);
 await raw.runTransaction(async tx=>{
  const snapshots=await Promise.all([tx.get(opaque),tx.get(legacy)]);
  const decoded:DocumentData[]=[];let damaged=false;
  for(const snapshot of snapshots)if(snapshot.exists){
   try{decoded.push(decodePrivateRecord(INBOX_HEAD_COLLECTION,snapshot.id,snapshot.data()!,db).data);}
   catch{damaged=true;}
  }
  if(decoded.length===2&&!isDeepStrictEqual(decoded[0],decoded[1]))damaged=true;
  if(!damaged)return; // Another recovery may already have repaired the slot.
  tx.set(opaque,encodePrivateRecord(INBOX_HEAD_COLLECTION,wallet,{schema:'provian.inbox-head.invalid',last_event_id:eventId}));
  if(snapshots[1].exists)tx.delete(legacy);
 });
}

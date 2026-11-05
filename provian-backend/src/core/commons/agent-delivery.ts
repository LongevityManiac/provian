/** Durable transport metadata only. Committed with the message; never records work. */
import {FieldPath,type Firestore,type Transaction,type DocumentSnapshot,type DocumentReference,type QueryDocumentSnapshot} from 'firebase-admin/firestore';
import {rawPrivateFirestore,isPrivateFirestore,privateStorageId,encodePrivateRecord,decodePrivateRecord} from '../provenance/private-store';
export const DELIVERY_COLLECTION = 'commons_agent_delivery_v1';
export const DELIVERY_PAGE = 50;
export interface DeliveryEvent { sequence: number; thread_id: string; message_id: string }
export function deliveryHead(db:Firestore,wallet:string):DocumentReference {
 return rawPrivateFirestore(db).collection(DELIVERY_COLLECTION).doc(isPrivateFirestore(db)?privateStorageId(DELIVERY_COLLECTION,wallet):wallet);
}
export function encodeDeliveryRecord(db:Firestore,domain:string,id:string,data:Record<string,unknown>):Record<string,unknown> {
 return isPrivateFirestore(db)?encodePrivateRecord(domain,id,data):data;
}
export function decodeDeliveryRecord(db:Firestore,domain:string,snapshot:DocumentSnapshot):Record<string,unknown>|undefined {
 if(!snapshot.exists)return undefined;
 return isPrivateFirestore(db)?decodePrivateRecord(domain,snapshot.id,snapshot.data()!,db).data:snapshot.data();
}
export function deliverySequence(db:Firestore,snapshot:DocumentSnapshot):number {
 const row=decodeDeliveryRecord(db,DELIVERY_COLLECTION,snapshot);
 if(!row)return 0;
 if(!Number.isSafeInteger(row.sequence)||Number(row.sequence)<0)throw new Error('Invalid delivery sequence');
 return Number(row.sequence);
}
export function deliveryEventCollection(row:Record<string,unknown>|undefined):string {
 const generation=row?.generation;
 if(generation===undefined||generation==='')return 'events';
 if(typeof generation!=='string'||!/^g_[a-f0-9]{24}$/.test(generation))throw new Error('Invalid delivery generation');
 return 'events_'+generation;
}
export function deliveryGeneration(db:Firestore,snapshot:DocumentSnapshot):string|undefined {
 const row=decodeDeliveryRecord(db,DELIVERY_COLLECTION,snapshot);deliveryEventCollection(row);return row?.generation as string|undefined;
}
export async function prepareAgentDelivery(db:Firestore,tx:Transaction,wallet:string):Promise<((thread:string,message:string)=>void) & {sequence:number}> {
 const head=deliveryHead(db,wallet);
 const snapshot=await tx.get(head);
 const previous=decodeDeliveryRecord(db,DELIVERY_COLLECTION,snapshot);
 const sequence=deliverySequence(db,snapshot)+1;
 if(!Number.isSafeInteger(sequence))throw new Error('Delivery sequence exhausted');
 return Object.assign((thread_id:string,message_id:string)=>{
  tx.set(head,encodeDeliveryRecord(db,DELIVERY_COLLECTION,wallet,{...previous,sequence}));
  const id=String(sequence).padStart(16,'0');
  const domain=head.path+'/'+deliveryEventCollection(previous);
  tx.create(head.collection(deliveryEventCollection(previous)).doc(id),encodeDeliveryRecord(db,domain,id,{sequence,thread_id,message_id}));
 },{sequence});
}
/** Exact document reads, bounded independently of encrypted message and inbox history. */
export async function readDeliveryPage(db:Firestore,wallet:string,after:number,through:number,generation?:string):Promise<DeliveryEvent[]> {
 const head=deliveryHead(db,wallet),collection=deliveryEventCollection({generation}),domain=head.path+'/'+collection;
 const end=Math.min(through,after+DELIVERY_PAGE);
 const refs=Array.from({length:Math.max(0,end-after)},(_,i)=>head.collection(collection).doc(String(after+i+1).padStart(16,'0')));
 if(!refs.length)return [];
 const snapshots=await rawPrivateFirestore(db).getAll(...refs);
 return snapshots.map((s,i)=>{
  const row=decodeDeliveryRecord(db,domain,s);
  if(!row||row.sequence!==after+i+1||typeof row.thread_id!=='string'||typeof row.message_id!=='string')throw new Error('Delivery log gap');
  return row as unknown as DeliveryEvent;
 });
}

export interface PendingDeliveryApproval extends DeliveryEvent {approval_id:string}
export function deliveryCheckpoint(db:Firestore,snapshot:DocumentSnapshot):{cursor:number} {
 const row=decodeDeliveryRecord(db,DELIVERY_COLLECTION,snapshot);
 return {cursor:Number(row?.acknowledged??0)};
}
export function pendingApprovalRef(db:Firestore,wallet:string,requestId:string):DocumentReference {
 const collection=deliveryHead(db,wallet).path+'/pending';
 return rawPrivateFirestore(db).collection(collection).doc(isPrivateFirestore(db)?privateStorageId(collection,requestId):requestId);
}
export function decodePendingApproval(db:Firestore,snapshot:DocumentSnapshot):PendingDeliveryApproval {
 const row=isPrivateFirestore(db)?decodeDeliveryRecord(db,snapshot.ref.path.split('/').slice(0,-1).join('/'),snapshot):snapshot.data();
 if(!row||typeof row.approval_id!=='string'||typeof row.message_id!=='string'||typeof row.thread_id!=='string'||!Number.isSafeInteger(row.sequence))throw new Error('Invalid pending delivery approval');
 return row as unknown as PendingDeliveryApproval;
}
/** Rows per read of an agent's outstanding approvals; rows only exist while an owner decides. */
export const PENDING_SCAN_PAGE = 200;
export interface PendingScan {
 /** Decided or expired: the consumer runs the follow-up and acknowledges it. */
 ready:PendingDeliveryApproval[];
 /** The approval no longer exists (for example its owner deleted their data): nothing to deliver. */
 orphans:DocumentReference[];
 /** A row whose approval names another agent: a corrupt binding, never a delivery. */
 foreign:boolean;
}
/**
 * Walks every outstanding approval, page by page, so a decided one is never hidden behind
 * undecided ones; `enough` ends the walk once the caller has what it needs.
 */
export async function scanPendingApprovals(db:Firestore,wallet:string,enough:(scan:PendingScan)=>boolean=()=>false):Promise<PendingScan>{
 const raw=rawPrivateFirestore(db),collection='human_approval_requests_v1';
 const query=deliveryHead(db,wallet).collection('pending').orderBy(FieldPath.documentId()).limit(PENDING_SCAN_PAGE);
 const scan:PendingScan={ready:[],orphans:[],foreign:false};
 let last:QueryDocumentSnapshot|undefined;
 for(;;){
  const rows=await (last?query.startAfter(last):query).get();
  const pendings=rows.docs.map(doc=>decodePendingApproval(db,doc));
  const refsOf=(id:string)=>isPrivateFirestore(db)?[raw.collection(collection).doc(privateStorageId(collection,id)),raw.collection(collection).doc(id)]:[raw.collection(collection).doc(id)];
  // One read round trip per page, never one per row: delivery time cannot grow with the backlog.
  const width=isPrivateFirestore(db)?2:1;
  const approvals=pendings.length?await raw.getAll(...pendings.flatMap(p=>refsOf(p.approval_id))):[];
  for(const [i,doc] of rows.docs.entries()){
   const pending=pendings[i];
   const found=approvals.slice(i*width,(i+1)*width).find(s=>s.exists);
   if(!found)scan.orphans.push(doc.ref);
   else {
    const row=isPrivateFirestore(db)?decodePrivateRecord(collection,found.id,found.data()!,db).data:found.data();
    if(row?.agent_wallet_id!==wallet)scan.foreign=true;
    else if(row.status==='satisfied'||Number(row.expires_at_ms)<=Date.now())scan.ready.push(pending);
   }
   if(enough(scan))return scan;
  }
  if(rows.size<PENDING_SCAN_PAGE)return scan;
  last=rows.docs[rows.docs.length-1];
 }
}
/**
 * Tells an observer to poll, never carries content. Idle: one head read and one empty pending query.
 * An approval still awaiting its owner does not wake a poll; a decided, expired or vanished one does.
 */
export async function deliveryWaiting(db:Firestore,wallet:string):Promise<boolean>{
 const [snapshot,scan]=await Promise.all([deliveryHead(db,wallet).get(),scanPendingApprovals(db,wallet,s=>s.ready.length>0||s.orphans.length>0)]);
 return deliverySequence(db,snapshot)>deliveryCheckpoint(db,snapshot).cursor||scan.ready.length>0||scan.orphans.length>0;
}
/** Small acknowledgment deltas never grow with outstanding approvals or history. */
export async function acknowledgeDelivery(db:Firestore,wallet:string,sequence:number,pending?:PendingDeliveryApproval,resolvedApprovalId?:string):Promise<void>{
 const ref=deliveryHead(db,wallet);
 await db.runTransaction(async tx=>{
  const snapshot=await tx.get(ref),row=decodeDeliveryRecord(db,DELIVERY_COLLECTION,snapshot);
  const ack=deliveryCheckpoint(db,snapshot).cursor;
  if(!row||!Number.isSafeInteger(sequence)||sequence<0||sequence>deliverySequence(db,snapshot)||sequence>ack+1)throw new Error('Invalid acknowledgment sequence');
  tx.set(ref,encodeDeliveryRecord(db,DELIVERY_COLLECTION,wallet,{...row,acknowledged:Math.max(sequence,ack)}));
  if(pending){const target=pendingApprovalRef(db,wallet,pending.approval_id);tx.set(target,encodeDeliveryRecord(db,target.path.split('/').slice(0,-1).join('/'),pending.approval_id,{...pending}));}
  if(resolvedApprovalId)tx.delete(pendingApprovalRef(db,wallet,resolvedApprovalId));
 });
}

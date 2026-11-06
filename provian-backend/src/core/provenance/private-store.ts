import { PRIVATE_RANGE_FIELDS, privateRecordRange } from './private-range-index';
import { PRIVATE_LOOKUP_EXEMPTIONS } from './private-index-exemptions.generated';
import { AsyncLocalStorage } from 'async_hooks';
import { METER_KEY_PAGES, meterKeyPointer } from '../meter/meter-key-pages';
import type { MeterActKeyDoc } from '../meter/meter-act-key';
/**
 * storage boundary. Logical identities, proofs, query order and monetary inputs
 * remain exact. Only the relay's physical representation changes. Legacy slots are
 * read alongside secret aliases and are moved by the operator's transactional migration.
 * All writes (including ordinary counters) are buffered until alias reads finish.
 */
import {PRIVATE_QUERY_SCAN,PRIVATE_QUERY_COMPARE,PRIVATE_QUERY_PAGER} from './query-pages';
import {createHash,createHmac,createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'crypto';
import {deflateRawSync,inflateRawSync} from 'zlib';
import {Firestore, FieldPath, FieldValue, Timestamp, GeoPoint} from 'firebase-admin/firestore';
import type {DocumentData,DocumentSnapshot,Query,QuerySnapshot,QueryDocumentSnapshot} from 'firebase-admin/firestore';
import {QueryDocumentSnapshot as NativeQueryDocumentSnapshot} from '@google-cloud/firestore/build/src/document';
import {Serializer} from '@google-cloud/firestore/build/src/serializer';
import {compare as compareFirestoreValues,compareUtf8Strings} from '@google-cloud/firestore/build/src/order';
import {recoverRetainedFields,privateRetentionKey,PRIVATE_RETENTION_STATE_COLLECTION,PRIVATE_RETENTION_STATE_DOC} from './private-retention';

export const PRIVATE_STORE_COLLECTIONS=new Set([
 'meter_act_keys_v1','meter_key_pages_v1','meter_held_acts_v1','identity_pes_legacy_v1','origin_reference_graph_v1',
 'meter_relay_acts_v1','meter_batch_acts_v1','identity_acts_v1','occurrence_mint_claims',
 'device_occurrence_mint_claims','artifact_novelty_claims','meter_pair_counts_v1',
 'meter_device_tips_v1','meter_batches_v1','meter_pending_claims_v1','pe_mailbox_v1',
 'pe_mailbox_acks_v1','wallet_jurisdiction_sessions_v1','mint_compliance_events_v1',
 'meter_occurrence_sets_v1','meter_day_counters_v1','pvt9_payee_settlement_clocks_v1','meter_occurrence_states_v1',
 'pvt9_claim_ledger_v1','pvt9_settlement_batches_v1','pvt9_settlement_cycles_v1',
 'pvt9_bug_demotions_v1','archive_days_v1','pe_chain_tips','commit_mint_claims',
 'completion_mint_claims','financial_settlement_mint_claims','x402_tx_mint_claims',
 'pe_accrual_failures','pvt_pending_policy_observations','pvt_pending_policy_queue',
 'pvt_registry_hold_resolution_v1','pvt_pending_evidence_resolution_v1',
 'pvt_held_act_sweep_cursor_v1','pvt_pending_evidence_resolver_cursor_v1',
 'pvt_registry_hold_resolver_cursor_v1','pvt_registry_hold_resolver_run_v1',
 'pvt9_claim_inlet_state_v1','pvt_pending_policy_recovery_state',
 'pvt9_reconciliation_reports_v1','pvt_mint_batch_snapshots','pvt_mint_batches',
 'speech_window_reservations','pe_hash_index','pvt_ordinary_accrual_intake_v1',
 'pvt_accrual_effects','pvt9_pe_split_v1','pe_daily_anchor_segments_v1',
 'pe_daily_anchor_days_v1','pe_daily_anchor_batches',
 'human_approval_requests_v1','presentation_requests_v1','commons_threads',
 'commons_thread_messages','commons_human_jobs','commons_human_job_applications','jobs',
 'commons_publication_consents','commons_published_pes','actor_stats_v1','actor_stats_applied','devices',
 'escrows','promises','general_disputes','human_promises','service_installs','github_webhook_inbox_v1','agent_bank_event_outbox_v1',
 'agent_inbox_heads_v1','agent_author_mappings','webhook_subscriptions','pvt_novelty_counters_v1',
]);
export function isPrivateCollection(path:string):boolean{return PRIVATE_STORE_COLLECTIONS.has(path)||/^agent_wallets\/[^/]+\/inbox_v1$/.test(path);}
const META=Symbol('provian-private-reference');
const RAW=Symbol('provian-private-raw-db');
const TX=Symbol('provian-private-native-transaction');
const SCAN=Symbol('provian-private-single-scan');
const VISIT=Symbol('provian-private-visit');
/** A scan belongs to one traversal, never a shared or cross-request cache. Native queries stay native. */
export function singleScanQuery<Q>(query:Q,maxResults?:number):Q {
 if(maxResults!==undefined&&(!Number.isSafeInteger(maxResults)||maxResults<=0))throw new Error('single scan maxResults must be a positive integer');
 const begin=(query as unknown as Record<symbol,unknown>)[SCAN];
 return typeof begin==='function'?begin(maxResults):query;
}
/** Unordered reductions stream one physical page at a time; they never retain the full backlog. */
export async function visitQueryDocuments(query:FirebaseFirestore.Query, visit:(doc:QueryDocumentSnapshot)=>unknown):Promise<void> {
 const run=(query as unknown as Record<symbol,unknown>)[VISIT];
 if(typeof run==='function'){await run(visit);return;}
 // Unit doubles have no stream. Native Firestore streams preserve its existing query semantics.
 if(typeof query.stream==='function'){for await(const doc of query.stream())await visit(doc as unknown as QueryDocumentSnapshot);}
 else {
  // Preserve bounded reads for query doubles; production uses the native stream above.
  let after:string|undefined;
  for(;;){let page=query.limit(1000);if(after!==undefined)page=page.startAfter(after);
   const snap=await page.get();for(const doc of snap.docs)await visit(doc);
   if(snap.docs.length<1000)break;after=snap.docs.at(-1)!.id;
  }
 }
}
const readSessions=new AsyncLocalStorage<Map<Firestore,Promise<DocumentSnapshot>>>();
export function withPrivateReadSession<T>(work:()=>T):T { return readSessions.getStore()?work():readSessions.run(new Map(),work); }
const SERVER_TIME=Symbol('provian-server-timestamp');
const caches=new WeakMap<object,Firestore>();
type PackedSlot={id:string;raw:DocumentSnapshot;data:DocumentData;transaction?:unknown};
type RefMeta={collection:string;id:string;converter?:any;known?:{raw:FirebaseFirestore.DocumentSnapshot;data:DocumentData;packed?:PackedSlot}};
type ResolvedSlot={raw:DocumentSnapshot;legacy:FirebaseFirestore.DocumentReference;opaque:FirebaseFirestore.DocumentReference;duplicate:boolean;known?:boolean;packed?:PackedSlot;data?:DocumentData};
type Pred={field:string;op:string;value:any};
type Order={field:string;direction:string};
type QueryMeta={collection:string;preds:Pred[];orders:Order[];limit?:number;offset?:number;last?:boolean;start?:{values:any[];inclusive:boolean};end?:{values:any[];inclusive:boolean};select?:string[];converter?:any;scan?:{base:QueryMeta;result?:Promise<QuerySnapshot>;maxResults?:number}};
type Mutation={kind:'set'|'create'|'update'|'delete';ref:any;data?:any;options?:any};
function mac(domain:string,value:string):string {
 const secret=process.env.RELAY_SIGNING_KEY;if(!secret)throw new Error('private storage requires existing relay secret');
 return createHmac('sha256',secret).update('provian-private-store:v1\0'+domain+'\0'+value).digest('hex');
}
export function privateStorageId(collection:string,id:string):string{return 'pv1_'+mac(collection,id);}
const lookupField=(field:string)=>mac('lookup-field',field);
// Encoding needs SDK settings only; importing this module must not open a database.
const serializer=new Serializer({_settings:{},doc:()=>{throw new Error('encode-only serializer');}} as unknown as ConstructorParameters<typeof Serializer>[0]);
const lookupValue=(value:any)=>{
 // Firestore considers -0 and +0 equal. Its serializer chooses different wire number
 // families for them, so canonicalize before making the equality candidate index.
 const proto=serializer.encodeValue(Object.is(value,-0)?0:value)!;
 const normalized=proto.timestampValue?{timestampValue:{seconds:Number(proto.timestampValue.seconds??0),nanos:Number(proto.timestampValue.nanos??0)}}:proto;
 return mac('lookup-value',JSON.stringify(normalized,(_key,v)=>typeof v==='number'&&!Number.isFinite(v)?String(v):v));
};
function scalar(value:any):boolean{return value===null||['string','number','boolean'].includes(typeof value)||value instanceof Timestamp||value instanceof Date||Buffer.isBuffer(value);}
/** Only queried root arrays: never index every act, proof leaf, or arbitrary private field. */
export const PRIVATE_ARRAY_LOOKUP_FIELDS = new Set(['beneficiary_ids','parties','panel','consenting_wallet_ids','capabilities','required_capabilities','events','witness_ids','action_types']);
export function lookupFieldIndexed(collection:string,field:string):boolean {
 const exemptions=PRIVATE_LOOKUP_EXEMPTIONS[collection.split('/').at(-1)!]??[];
 return !exemptions.includes('*')&&!exemptions.includes(field);
}
export function privateRecordLookup(data:DocumentData,collection=''):Record<string,string|string[]> {
 const out:Record<string,string|string[]>={};
 for(const [field,value] of Object.entries(data)) {
  if(!lookupFieldIndexed(collection,field))continue;
  if(scalar(value))out[lookupField(field)]=lookupValue(value);
  else if(PRIVATE_ARRAY_LOOKUP_FIELDS.has(field)&&Array.isArray(value))out[lookupField(field)]=[...new Set(value.filter(scalar).map(lookupValue))];
 }
 return out;
}
function fieldName(field:any):string {
 if(typeof field==='string')return field;
 if(field instanceof FieldPath)return (field as any).segments.map((x:string)=>x.replace(/\\/g,'\\\\').replace(/\./g,'\\.')).join('.');
 throw new Error('unsupported private store field path');
}
function segments(field:string):string[]{const out:string[]=[];let part='',escape=false;for(const c of field){if(escape){part+=c;escape=false;}else if(c==='\\')escape=true;else if(c==='.'){out.push(part);part='';}else part+=c;}out.push(part);return out;}
function getAt(data:any,field:string):any {return segments(field).reduce((v,k)=>v?.[k],data);}
function serial(v:any):any {
 if(v===undefined)return undefined;
 if(v instanceof Timestamp)return {__pv_type:'timestamp',seconds:v.seconds,nanoseconds:v.nanoseconds};
 if(v instanceof Date)return serial(Timestamp.fromDate(v));
 if(typeof v==='number'&&!Number.isFinite(v))return {__pv_type:'number',value:String(v)};
 if(v instanceof GeoPoint)return {__pv_type:'geopoint',latitude:v.latitude,longitude:v.longitude};
 if(Buffer.isBuffer(v))return {__pv_type:'bytes',value:v.toString('base64')};
 if(Array.isArray(v))return v.map(serial);
 if(v&&typeof v==='object') {
  if(v[SERVER_TIME])return {__pv_type:'server_timestamp',key:v.key};
  if(v[META])return {__pv_type:'reference',path:v[META].collection+'/'+v[META].id};
  if(v.constructor?.name==='DocumentReference')return {__pv_type:'reference',path:v.path};
  if(v.constructor?.name?.endsWith('Transform'))throw new Error('unresolved private-store transform');
  return {__pv_type:'map',entries:Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).filter(([,x])=>x!==undefined).map(([k,x])=>[k,serial(x)])};
 }
 return v;
}
function restore(v:any,db:any,transforms:any={}):any {
 if(Array.isArray(v))return v.map(x=>restore(x,db,transforms));
 if(v&&typeof v==='object') {
  switch(v.__pv_type) {
   case 'map':return Object.fromEntries(v.entries.map(([k,x]:any[])=>[k,restore(x,db,transforms)]));
   case 'timestamp':return new Timestamp(v.seconds,v.nanoseconds);
   case 'date':return new Date(v.value);
   case 'number':return Number(v.value);
   case 'geopoint':return new GeoPoint(v.latitude,v.longitude);
   case 'bytes':return Buffer.from(v.value,'base64');
   case 'reference':return db.doc(v.path);
   case 'server_timestamp':return transforms[v.key];
  }
  return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,restore(x,db,transforms)]));
 }
 return v;
}
function canon(v:any):string{return JSON.stringify(serial(v));}
function equality(v:any,w:any):boolean{
 if(v===undefined||w===undefined)return v===w;
 return compareFirestoreValues(serializer.encodeValue(v)!,serializer.encodeValue(w)!)===0;
}
/** Storage ciphertext is complete: arbitrary text and object keys cannot escape by field name. */
export function encodePrivateRecord(collection:string,id:string,data:DocumentData):DocumentData {
 const {_provian_server_times:times,...bodyData}=data;
 const serialized=serial(bodyData);
 const payload=deflateRawSync(Buffer.from(JSON.stringify({id,data:serialized})));
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',privateRetentionKey(),iv);
 cipher.setAAD(Buffer.from('provian-private-store:v1\0'+collection));
 const body={iv,ciphertext:Buffer.concat([cipher.update(payload),cipher.final()]),tag:cipher.getAuthTag()};
 return {_provian_store:1,body,
  _provian_lookup:privateRecordLookup(bodyData,collection),
  ...(PRIVATE_RANGE_FIELDS[collection]?{_provian_range:privateRecordRange(collection,bodyData)}:{}),
  ...(data.expire_at!==undefined?{expire_at:data.expire_at}:{}),
  ...(times?{_provian_server_times:times}:{}),
 };
}
export function decodePrivateRecord(collection:string,physicalId:string,data:DocumentData,db:any):{id:string;data:DocumentData} {
 if(data._provian_store!==1)return {id:physicalId,data:recoverRetainedFields(collection,data)};
 let decoded:any;
 if(Buffer.isBuffer(data.body?.ciphertext)){
  const decipher=createDecipheriv('aes-256-gcm',privateRetentionKey(),data.body.iv);
  decipher.setAAD(Buffer.from('provian-private-store:v1\0'+collection));decipher.setAuthTag(data.body.tag);
  decoded=JSON.parse(inflateRawSync(Buffer.concat([decipher.update(data.body.ciphertext),decipher.final()])).toString('utf8'));
 }else decoded=recoverRetainedFields(collection,{metadata:data.body}).metadata;
 if(typeof decoded?.id!=='string'||(!decoded.data&&typeof decoded.payload!=='string'))throw new Error('private storage binding invalid');
 if(physicalId!==(physicalId.startsWith('pv1_')?privateStorageId(collection,decoded.id):decoded.id))throw new Error('private storage identity invalid');
 const original=decoded.encoding==='deflate-raw/v1'?JSON.parse(inflateRawSync(Buffer.from(decoded.payload,'base64')).toString('utf8')):decoded.data;
 return {id:decoded.id,data:restore(original,db,data._provian_server_times)};
}
export function rawPrivateFirestore(db:Firestore):Firestore{return (db as any)[RAW]??db;}
export function isPrivateFirestore(db:any):boolean{return !!db?.[RAW];}
function failure(code:number,message:string):Error {return Object.assign(new Error(message),{code});}
function compare(a:any,b:any):number {
 if(a===undefined)return b===undefined?0:-1;if(b===undefined)return 1;
 return compareFirestoreValues(serializer.encodeValue(a)!,serializer.encodeValue(b)!);
}
function rangeComparable(a:any,b:any):boolean {
 if(a===undefined||a===null||b===null||Number.isNaN(a)||Number.isNaN(b))return false;
 const family=(v:any)=>{const proto=serializer.encodeValue(v)!;return 'integerValue' in proto||'doubleValue' in proto?'number':Object.keys(proto)[0];};
 return family(a)===family(b);
}
function matches(v:any,p:Pred):boolean {
 switch(p.op) {
  case '==':return equality(v,p.value);case '!=':return v!==undefined&&v!==null&&!equality(v,p.value);
  case '>':return rangeComparable(v,p.value)&&compare(v,p.value)>0;case '>=':return rangeComparable(v,p.value)&&compare(v,p.value)>=0;
  case '<':return rangeComparable(v,p.value)&&compare(v,p.value)<0;case '<=':return rangeComparable(v,p.value)&&compare(v,p.value)<=0;
  case 'in':return p.value.some((x:any)=>x!==null&&!Number.isNaN(x)&&equality(v,x));
  case 'not-in':return v!==undefined&&v!==null&&!p.value.includes(null)&&!p.value.some((x:any)=>!Number.isNaN(x)&&equality(v,x));
  case 'array-contains':return Array.isArray(v)&&v.some(x=>equality(x,p.value));
  case 'array-contains-any':return Array.isArray(v)&&p.value.some((x:any)=>v.some(y=>equality(x,y)));
  default:throw new Error('unsupported private store query operator');
 }
}
function queryOrdering(meta:QueryMeta){
  const orders=[...meta.orders],direction=orders.at(-1)?.direction??'asc';
  const inequality=[...new Set(meta.preds.filter(p=>['<','<=','>','>=','!=','not-in'].includes(p.op)).map(p=>p.field))].sort(compareUtf8Strings);
  for(const field of inequality)if(field!=='__name__'&&!orders.some(o=>o.field===field))orders.push({field,direction});
  if(!orders.some(o=>o.field==='__name__'))orders.push({field:'__name__',direction});
  const value=(doc:DocumentSnapshot,field:string)=>field==='__name__'?doc.id:getAt(doc.data(),field);
  const sort=(a:DocumentSnapshot,b:DocumentSnapshot)=>{
   for(const o of orders){const c=compare(value(a,o.field),value(b,o.field))*(o.direction==='desc'?-1:1);if(c)return c;}
   return 0;
  };
  const cursorCompare=(doc:DocumentSnapshot,values:unknown[])=>{
   if(values.length===1&&typeof values[0]==='object'&&values[0]!==null&&'ref' in values[0]&&'data' in values[0]&&typeof values[0].data==='function'){const cursor=values[0] as DocumentSnapshot;values=orders.map(o=>value(cursor,o.field));}
   if(values.length>orders.length||values.some(x=>x===undefined))throw new Error('invalid logical query cursor');
   for(let i=0;i<values.length;i++){
    const o=orders[i];const c=compare(value(doc,o.field),values[i])*(o.direction==='desc'?-1:1);if(c)return c;
   }return 0;
  };
  return {orders,value,sort,cursorCompare};
}
function updateArguments(args:any[]):{data:any;options:any} {
 if(typeof args[0]==='string'||args[0] instanceof FieldPath){
  const values=[...args];let options:any;
  if(values.length%2===1)options=values.pop();
  const data:any={};for(let i=0;i<values.length;i+=2)data[fieldName(values[i])]=values[i+1];return {data,options};
 }
 return {data:args[0],options:args[1]};
}
function mutation(kind:Mutation['kind'],ref:any,args:any[]):Mutation {
 return kind==='update'?{kind,ref,...updateArguments(args)}:{kind,ref,data:args[0],options:args[1]};
}
function deepMerge(a:any,b:any):any {
 const out={...a};for(const [k,v] of Object.entries(b)) {
  if(v===undefined)continue;
  if(v?.constructor?.name==='DeleteTransform'){delete out[k];continue;}
  out[k]=v&&Object.getPrototypeOf(v)===Object.prototype&&a?.[k]&&Object.getPrototypeOf(a[k])===Object.prototype?deepMerge(a[k],v):v;
 }return out;
}
function assignAt(out:any,field:string,value:any):void {
 const parts=segments(field);let target=out;
 for(const part of parts.slice(0,-1))target=target[part]=target[part]&&Object.getPrototypeOf(target[part])===Object.prototype?{...target[part]}:{};
 if(value?.constructor?.name==='DeleteTransform')delete target[parts.at(-1)!];else target[parts.at(-1)!]=value;
}
function materialize(v:any,old:any,at:string,times:any):any {
 const kind=v?.constructor?.name;
 if(kind==='NumericIncrementTransform')return (typeof old==='number'?old:0)+v.operand;
 if(kind==='ArrayUnionTransform'){const out=Array.isArray(old)?[...old]:[];for(const x of v.elements)if(!out.some(y=>equality(x,y)))out.push(x);return out;}
 if(kind==='ArrayRemoveTransform')return (Array.isArray(old)?old:[]).filter(x=>!v.elements.some((y:any)=>equality(x,y)));
 if(kind==='ServerTimestampTransform'){const k=mac('server-time',at);times[k]=v;return {[SERVER_TIME]:true,key:k};}
 if(Array.isArray(v))return v.map((x,i)=>materialize(x,old?.[i],at+'.'+i,times));
 if(v&&Object.getPrototypeOf(v)===Object.prototype)return Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).map(([k,x])=>[k,materialize(x,old?.[k],at+'.'+k,times)]));
 return v;
}

/** Real Firestore only; handwritten test doubles retain their established surface. */
function hasTransform(value: unknown): boolean {
 if (!value || typeof value !== 'object') return false;
 if (value.constructor?.name?.endsWith('Transform')) return true;
 if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
 return Object.values(value).some(hasTransform);
}
export async function readPackedMeterKeyPages(db:Firestore,txn:FirebaseFirestore.Transaction,ids:readonly string[],allowMissing=false):Promise<Map<string,{data:DocumentData;ref:FirebaseFirestore.DocumentReference}>>{
 const read=(db as unknown as Record<symbol,unknown>)[Symbol.for('provian.meter-key-pages')];
 if(typeof read!=='function')throw new Error('meter_key_pages_require_private_store');
 return read(txn,ids,allowMissing);
}
export function privateFirestore(db:Firestore):Firestore {
 if(isPrivateFirestore(db))return db;
 if(typeof Firestore!=='function'||!(db instanceof Firestore))return db;
 const prior=caches.get(db);if(prior)return prior;
 let wrapped:any;
 const boundaryRef=(ref:any):any=>new Proxy(ref,{get(target,prop){
  if(prop==='collection')return (name:string)=>wrapped.collection(ref.path+'/'+name);
  const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
 }});
 const boundaryCollection=(collection:any):any=>new Proxy(collection,{get(target,prop){
  if(prop==='doc')return (id?:string)=>boundaryRef(id===undefined?collection.doc():collection.doc(id));
  const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
 }});
 const makeRef=(meta:RefMeta):any=>{
  const original=db.collection(meta.collection).doc(meta.id);
  return new Proxy(original,{get(target,prop){
   if(prop===META)return meta;if(prop==='firestore')return wrapped;
   if(prop==='parent')return makeQuery({collection:meta.collection,preds:[],orders:[],converter:meta.converter});
   if(prop==='collection')return (name:string)=>wrapped.collection(meta.collection+'/'+meta.id+'/'+name);
   if(prop==='withConverter')return (converter:any)=>makeRef({...meta,converter});
   if(prop==='get')return async()=>readRef(meta,(r:any)=>r.get());
   if(['set','create','update','delete'].includes(String(prop)))return (...args:any[])=>{(db.batch() as any)[prop](original,...args);return executeMutations([mutation(prop as Mutation['kind'],makeRef(meta),args)]);};
   const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
  }});
 };
 const snapshot=(raw:any,meta:RefMeta,decoded?:{id:string;data:any}):any=>{
  const logical=decoded??(raw.exists?decodePrivateRecord(meta.collection,raw.id,raw.data(),wrapped):{id:meta.id,data:undefined});
  const ref=makeRef({...meta,id:logical.id,...(meta.known?{known:{raw:meta.known.raw,data:logical.data}}:{})});
  return new Proxy(raw,{get(target,prop){
   if(prop==='id')return logical.id;if(prop==='ref')return ref;
   if(prop==='updateTime'&&meta.known?.packed)return meta.known.packed.raw.updateTime;
   if(prop==='data')return ()=>{
    if(logical.data===undefined)return undefined;
    if(meta.converter)return meta.converter.fromFirestore(snapshot(raw,{...meta,converter:undefined},logical));
    return logical.data;
   };
   if(prop==='get')return (field:any)=>getAt(logical.data,fieldName(field));
   const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;
  }});
 };
 const resolve=async(meta:RefMeta,read:(r:any)=>Promise<any>,complete=false):Promise<ResolvedSlot>=>{
  const legacy=db.collection(meta.collection).doc(meta.id),opaque=db.collection(meta.collection).doc(privateStorageId(meta.collection,meta.id));
  if(complete)return {raw:await read(opaque),legacy,opaque,duplicate:false};
  const [a,b]=await Promise.all([read(opaque),read(legacy)]);
  if(a.exists&&b.exists&&!equality(decodePrivateRecord(meta.collection,a.id,a.data(),wrapped).data,decodePrivateRecord(meta.collection,b.id,b.data(),wrapped).data))throw new Error('private storage duplicate identity conflict');
  return {raw:a.exists?a:b,legacy,opaque,duplicate:a.exists&&b.exists};
 };
 const expand=async(meta:RefMeta,slot:ResolvedSlot,read:(ref:FirebaseFirestore.DocumentReference)=>Promise<DocumentSnapshot>,complete=false,pages=new Map<string,Promise<ResolvedSlot>>(),transaction?:unknown):Promise<ResolvedSlot>=>{
  if(!slot.raw.exists||meta.collection!=='meter_act_keys_v1')return slot;
  const pointer=decodePrivateRecord(meta.collection,slot.raw.id,slot.raw.data()!,wrapped).data;
  if(pointer._meter_key_page===undefined)return slot;
  const id=pointer._meter_key_page;
  if(typeof id!=='string'||!/^[a-f0-9]{64}~[0-9]+$/.test(id)||pointer.relay_pe_id!==meta.id||pointer.batch_hash!==id.split('~')[0])throw new Error('meter_key_pointer_invalid');
  let page=pages.get(id);
  if(!page){page=resolve({collection:METER_KEY_PAGES,id},read,complete);pages.set(id,page);}
  const got=await page;
  if(!got.raw.exists)throw new Error('meter_key_page_missing');
  const data=decodePrivateRecord(METER_KEY_PAGES,got.raw.id,got.raw.data()!,wrapped).data;
  const key=data.keys?.[meta.id];
  if(data.schema!=='provian.meter-key-page.v1'||data.batch_hash!==pointer.batch_hash||data.actor_id!==pointer.actor_id||!key||key.relay_pe_id!==meta.id||key.batch_hash!==data.batch_hash||key.actor_id!==data.actor_id)throw new Error('meter_key_page_binding_invalid');
  return {...slot,data:key,packed:{id,raw:got.raw,data,transaction}};
 };
 // A scan chunk of act keys points into many packed pages. Awaiting one page per key in
 // sequence made a 1,759-key commit lookup take ~10 s. Outside a caller's transaction every read
 // is its own read-only snapshot read and takes no lock, so the scan keeps up to
 // KEY_PAGE_LOOKAHEAD distinct page reads in flight ahead of the key it is expanding. `expand`
 // still awaits each page in order and validates every pointer and binding. Inside a caller's
 // transaction, reads lock, so the scan reads one page at a time as before.
 const KEY_PAGE_LOOKAHEAD=32;
 const keyPagePrefetch=(collection:string,docs:readonly QueryDocumentSnapshot[],read:(ref:FirebaseFirestore.DocumentReference)=>Promise<DocumentSnapshot>,complete:boolean,pages:Map<string,Promise<ResolvedSlot>>):(index:number)=>void=>{
  if(collection!=='meter_act_keys_v1')return ()=>undefined;
  const order:string[]=[],slotOfDoc:number[]=[];
  for(const doc of docs){
   let id:unknown;
   try{id=decodePrivateRecord(collection,doc.id,doc.data(),wrapped).data._meter_key_page;}catch{id=undefined;}
   if(typeof id==='string'&&/^[a-f0-9]{64}~[0-9]+$/.test(id)&&!pages.has(id)&&!order.includes(id))order.push(id);
   slotOfDoc.push(typeof id==='string'?order.indexOf(id):-1);
  }
  let started=0,reached=0;
  return (index:number)=>{
   if(slotOfDoc[index]!==undefined&&slotOfDoc[index]>=0)reached=Math.max(reached,slotOfDoc[index]);
   for(;started<order.length&&started<=reached+KEY_PAGE_LOOKAHEAD-1;started++){
    const id=order[started];if(pages.has(id))continue;
    const page=resolve({collection:METER_KEY_PAGES,id},read,complete);
    // Observed here so a read the loop never reaches (it stopped on an earlier key) cannot
    // become an unhandled rejection; the loop's own await still surfaces every failure it meets.
    page.catch(()=>undefined);
    pages.set(id,page);
   }
  };
 };
 const slotSnapshot=(meta:RefMeta,slot:ResolvedSlot):DocumentSnapshot=>{
  const data=slot.data??(slot.raw.exists?decodePrivateRecord(meta.collection,slot.raw.id,slot.raw.data()!,wrapped).data:undefined);
  return snapshot(slot.raw,{...meta,...(data?{known:{raw:slot.raw,data,...(slot.packed?{packed:slot.packed}:{})}}:{})},{id:meta.id,data});
 };
 const readRef=async(meta:RefMeta,read:(r:any)=>Promise<any>)=>{
  const scope=readSessions.getStore();let complete=false;
  if(scope){
   let pending=scope.get(db);if(!pending){pending=db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).get();scope.set(db,pending);}
   const state=(await pending).data();complete=state?.opaque_ids_ready===true&&state?.opaque_records_complete===true;
  }
  return slotSnapshot(meta,await expand(meta,await resolve(meta,read,complete),read,complete));
 };
 const queryRead=async(meta:QueryMeta,read:(q:any)=>Promise<any>,countOnly=false,visit?: (doc:QueryDocumentSnapshot)=>unknown,certificate?:DocumentSnapshot,lockFree=false)=>{
  // During migration there are mixed formats. No physical limit or cursor may run before
  // logical resolution. Server-side predicates are safe only after all legacy rows move.
  let candidates:any=db.collection(meta.collection);
  let rangeOrder:string|undefined;
  const state=certificate??await read(db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC));
  // The final migration scan establishes that every row has this representation. Until then,
  // the native field and encrypted aliases cannot share a safe server-side predicate.
  const complete=state.data()?.opaque_records_complete===true&&state.data()?.opaque_ids_ready===true;
  if(state.data()?.opaque_records_complete===true){
   const predicates=meta.preds.filter(p=>lookupFieldIndexed(meta.collection,p.field)&&!p.field.includes('.')&&p.field!=='__name__'&&
    (p.op==='=='&&scalar(p.value)||p.op==='in'&&Array.isArray(p.value)&&p.value.every(scalar)));
   let disjunctions=1;
   for(const predicate of predicates){
    const width=predicate.op==='in'?predicate.value.length:1;
    if(disjunctions*width>30)continue;
    disjunctions*=width;
    candidates=candidates.where('_provian_lookup.'+lookupField(predicate.field),predicate.op,
    predicate.op==='in'?predicate.value.map(lookupValue):lookupValue(predicate.value));
   }
   // Old rows are not excluded until the version-checked, representation-only backfill proves
   // every queried root array indexed. Logical filtering still verifies every decrypted result.
   if(state.data()?.array_lookup_version===1) {
    const array=meta.preds.find(p=>lookupFieldIndexed(meta.collection,p.field)&&PRIVATE_ARRAY_LOOKUP_FIELDS.has(p.field)&&
      (p.op==='array-contains'&&scalar(p.value)||p.op==='array-contains-any'&&Array.isArray(p.value)&&p.value.every(scalar)));
    if(array&&disjunctions*(array.op==='array-contains-any'?array.value.length:1)<=30)candidates=candidates.where('_provian_lookup.'+lookupField(array.field),array.op,
      array.op==='array-contains-any'?array.value.map(lookupValue):lookupValue(array.value));
   }
  }
  if(state.data()?.range_lookup_version===1&&meta.preds.length===1){
   const predicate=meta.preds[0];
   if((PRIVATE_RANGE_FIELDS[meta.collection]??[]).includes(predicate.field)&&['<','<=','>','>='].includes(predicate.op)&&typeof predicate.value==='number'&&Number.isFinite(predicate.value)){
    rangeOrder='_provian_range.'+predicate.field;
    candidates=candidates.where(rangeOrder,predicate.op,predicate.value);
   }
  }
  const {orders,value,sort,cursorCompare}=queryOrdering(meta);
  const streaming=visit&&complete&&!meta.limit&&!meta.start&&!meta.end&&!meta.offset;
  const seen=new Map<string,{digest:string;opaque:boolean}>(),selected=new Map<string,any>();
  const keep=meta.limit===undefined?undefined:meta.limit+(meta.offset??0);
  // A bounded query keeps its best k in a heap; sorting k again for every candidate
  // made encrypted reads burn O(N*k*log(k)) comparisons before returning the same page.
  const heap:QueryDocumentSnapshot[]=[],positions=new Map<string,number>();
  const worst=(a:QueryDocumentSnapshot,b:QueryDocumentSnapshot)=>(meta.last?-1:1)*sort(a,b);
  const swap=(a:number,b:number)=>{[heap[a],heap[b]]=[heap[b],heap[a]];positions.set(heap[a].id,a);positions.set(heap[b].id,b);};
  const rise=(index:number)=>{let i=index;while(i>0){const parent=(i-1)>>>1;if(worst(heap[i],heap[parent])<=0)break;swap(i,parent);i=parent;}return i;};
  const sink=(index:number)=>{for(let i=index;;){const left=i*2+1,right=left+1;if(left>=heap.length)return;const child=right<heap.length&&worst(heap[right],heap[left])>0?right:left;if(worst(heap[child],heap[i])<=0)return;swap(i,child);i=child;}};
  const retain=(doc:QueryDocumentSnapshot)=>{
   if(keep===undefined){selected.set(doc.id,doc);return;}
   if(keep===0)return;
   const prior=positions.get(doc.id);
   if(prior!==undefined){heap[prior]=doc;selected.set(doc.id,doc);sink(rise(prior));return;}
   if(heap.length<keep){heap.push(doc);positions.set(doc.id,heap.length-1);selected.set(doc.id,doc);rise(heap.length-1);return;}
   if(worst(doc,heap[0])>=0)return;
   const removed=heap[0];positions.delete(removed.id);selected.delete(removed.id);
   heap[0]=doc;positions.set(doc.id,0);selected.set(doc.id,doc);sink(0);
  };
  const packedPages=new Map<string,Promise<ResolvedSlot>>();
  let physicalAfter:any,raw:any,matchCount=0;
  for(;;){
   let query=(rangeOrder?candidates.orderBy(rangeOrder):candidates).orderBy(FieldPath.documentId()).limit(200);if(physicalAfter)query=query.startAfter(physicalAfter);
   const page=await read(query);raw??=page;
   const advance=lockFree?keyPagePrefetch(meta.collection,page.docs,read,complete,packedPages):()=>undefined;
   for(const [index,doc] of page.docs.entries()){
    advance(index);
    const initial=decodePrivateRecord(meta.collection,doc.id,doc.data(),wrapped);
    const expanded=await expand({collection:meta.collection,id:initial.id},{raw:doc,legacy:db.collection(meta.collection).doc(initial.id),opaque:doc.ref,duplicate:false},read,complete,packedPages);
    const decoded={id:initial.id,data:expanded.data??initial.data};
    if(complete&&(doc.data()._provian_store!==1||doc.id!==privateStorageId(meta.collection,decoded.id)))throw new Error('private storage certified representation drift');
    const digest=complete?'':createHash('sha256').update(canon(decoded.data)).digest('hex'),prior=seen.get(decoded.id),opaque=doc.id.startsWith('pv1_');
    if(prior&&prior.digest!==digest)throw new Error('private storage query duplicate identity conflict');
    if(prior&&(!opaque||prior.opaque))continue;
    if(!complete)seen.set(decoded.id,{digest,opaque});
    // The scan retains logical inputs and version metadata, never a second ciphertext copy.
    const physicalFields=Object.fromEntries(Object.keys(doc.data()).map(k=>[k,k==='_provian_store'?1:null]));
    const thin=new NativeQueryDocumentSnapshot(doc.ref,serializer.encodeFields(physicalFields),doc.readTime,doc.createTime,doc.updateTime);
    const logical=snapshot(thin,{collection:meta.collection,id:decoded.id,converter:meta.converter,...(state.data()?.opaque_records_complete===true&&!meta.select?{known:{raw:thin,data:decoded.data,...(expanded.packed?{packed:expanded.packed}:{})}}:{})},decoded);
    if(!meta.preds.every(p=>matches(value(logical,p.field),p))||!orders.every(o=>value(logical,o.field)!==undefined))continue;
    if(meta.start&&cursorCompare(logical,meta.start.values)<(meta.start.inclusive?0:1))continue;
    if(meta.end&&cursorCompare(logical,meta.end.values)>(meta.end.inclusive?0:-1))continue;
    if(countOnly){if(!prior)matchCount++;continue;}
    if(streaming){
     if(meta.select){const data:DocumentData={};for(const f of meta.select){const v=getAt(decoded.data,f);if(f!=='__name__'&&v!==undefined)assignAt(data,f,v);}
      await visit(snapshot(thin,{collection:meta.collection,id:decoded.id,converter:meta.converter},{id:decoded.id,data}));
     }else await visit(logical);
     continue;
    }
    let retained=logical;
    if(meta.select){
     const data:DocumentData={};for(const f of new Set([...meta.select,...orders.map(o=>o.field)])){
      if(f==='__name__')continue;const v=getAt(decoded.data,f);if(v!==undefined)assignAt(data,f,v);
     }
     retained=snapshot(thin,{collection:meta.collection,id:decoded.id,converter:meta.converter},{id:decoded.id,data});
    }
    // Keep only the globally best logical results. Physical HMAC order can NEVER stop the scan early.
    retain(retained);
   }
   if(page.docs.length<200)break;physicalAfter=page.docs.at(-1);
  }
  let docs=[...selected.values()].sort(sort);
  if(meta.offset)docs=docs.slice(meta.offset);
  if(meta.limit!==undefined)docs=meta.last?docs.slice(-meta.limit):docs.slice(0,meta.limit);
  if(meta.select)docs=docs.map(doc=>{
   const data:any={};for(const field of meta.select!){if(field==='__name__')continue;const value=getAt(doc.data(),field);if(value!==undefined)assignAt(data,field,value);}
   return snapshot(doc,{collection:meta.collection,id:doc.id,converter:meta.converter},{id:doc.id,data});
  });
  if(visit&&!streaming)for(const doc of docs)await visit(doc);
  const logicalSize=countOnly?Math.min(meta.limit??Infinity,Math.max(0,matchCount-(meta.offset??0))):docs.length;
  return new Proxy(raw,{get(target,prop){
   if(prop==='docs')return docs;if(prop==='size')return logicalSize;if(prop==='empty')return logicalSize===0;
   if(prop==='forEach')return (fn:(doc:QueryDocumentSnapshot)=>void,ctx:unknown)=>docs.forEach(fn,ctx);
   if(prop==='query')return makeQuery(meta);
   if(prop==='docChanges')return ()=>docs.map((doc,i)=>({type:'added',doc,oldIndex:-1,newIndex:i}));
   const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;
  }});
 };
 const makeQuery=(meta:QueryMeta):any=>{
  const base=db.collection(meta.collection);
  let validation:any=base;
  const nativeField=(field:string)=>field==='__name__'?FieldPath.documentId():new FieldPath(...segments(field));
  for(const p of meta.preds)validation=validation.where(nativeField(p.field),p.op,p.value);
  for(const o of meta.orders)validation=validation.orderBy(nativeField(o.field),o.direction);
  if(meta.limit!==undefined)validation=meta.last?validation.limitToLast(meta.limit):validation.limit(meta.limit);
  if(meta.offset!==undefined)validation=validation.offset(meta.offset);
  if(meta.select)validation=validation.select(...meta.select.map(nativeField));
  return new Proxy(base,{get(target,prop){
   if(prop===META)return meta;if(prop==='firestore')return wrapped;
   if(prop===SCAN)return (maxResults?:number)=>makeQuery({...meta,scan:{base:meta,maxResults}});
   if(prop===PRIVATE_QUERY_COMPARE)return queryOrdering(meta).sort;
   if(prop===PRIVATE_QUERY_PAGER)return async()=>{
    const shared={base:{...meta,limit:undefined,offset:undefined,last:undefined,scan:undefined}};
    const shape=canon({collection:meta.collection,preds:meta.preds,orders:meta.orders,select:meta.select,end:meta.end});
    return async(query:Query)=>{
     const next=(query as Query&{[META]?:QueryMeta})[META];
     if(!next||next.converter!==meta.converter||next.last||canon({collection:next.collection,preds:next.preds,orders:next.orders,select:next.select,end:next.end})!==shape)throw new Error('private scan pager query changed');
     return snapshotQuery({...next,scan:shared});
    };
   };

   if(prop===VISIT||prop===PRIVATE_QUERY_SCAN)return async(visit:(doc:QueryDocumentSnapshot)=>unknown)=>{
    const point=await db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).get();
    await queryRead(meta,(q:any)=>db.runTransaction(tx=>tx.get(q),{readOnly:true,readTime:point.readTime}),false,visit,point,true);
   };
   if(prop==='doc')return (id?:string)=>makeRef({collection:meta.collection,id:id??randomUUID(),converter:meta.converter});
   if(prop==='add')return async(data:any)=>{const ref=makeRef({collection:meta.collection,id:randomUUID(),converter:meta.converter});await ref.create(data);return ref;};
   if(prop==='withConverter')return (converter:any)=>makeQuery({...meta,converter,scan:undefined});
   if(prop==='where')return (field:any,op:string,value:any)=>makeQuery({...meta,preds:[...meta.preds,{field:fieldName(field),op,value}],scan:undefined});
   if(prop==='orderBy')return (field:any,direction='asc')=>makeQuery({...meta,orders:[...meta.orders,{field:fieldName(field),direction}],scan:undefined});
   if(prop==='limit'||prop==='limitToLast')return (limit:number)=>makeQuery({...meta,limit,last:prop==='limitToLast'});
   if(prop==='offset')return (offset:number)=>makeQuery({...meta,offset});
   if(prop==='select')return (...fields:any[])=>{
    const select=fields.map(fieldName),scan=meta.scan;
    const cached=scan?.base.select;
    const available=cached?[...cached,...(scan?.base.orders??[]).map(o=>o.field),...(scan?.base.preds??[]).filter(p=>['<','<=','>','>=','!=','not-in'].includes(p.op)).map(p=>p.field)]:undefined;
    const covered=!available||select.every((f:string)=>f==='__name__'||available.some(parent=>f===parent||f.startsWith(parent+'.')));
    // select() replaces a projection. A newly requested field needs a new traversal,
    // while repeated/smaller projections continue to share their existing snapshot.
    return makeQuery({...meta,select,scan:scan&&!covered?{base:{...scan.base,select,scan:undefined},maxResults:scan.maxResults}:scan});
   };
   if(prop==='startAt'||prop==='startAfter')return (...values:any[])=>makeQuery({...meta,start:{values,inclusive:prop==='startAt'}});
   if(prop==='endAt'||prop==='endBefore')return (...values:any[])=>makeQuery({...meta,end:{values,inclusive:prop==='endAt'}});
   if(prop==='get')return ()=>snapshotQuery(meta);
   if(prop==='count')return ()=>({get:async()=>{const result=await snapshotQuery(meta,true);return {data:()=>({count:result.size})};}});
   if(prop==='listDocuments')return async()=>(await snapshotQuery(meta)).docs.map((d:any)=>d.ref);
   if(prop==='stream'||prop==='onSnapshot')throw new Error('private store streaming requires logical query adapter');
   const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;
  }});
 };
 /** Public readTime options retain one consistent snapshot across bounded pages
  * without holding a transaction ID beyond Firestore's transaction lifetime.
  * Queries inside a caller's write transaction still use that caller's tx. */
 const snapshotQuery=async(meta:QueryMeta,countOnly=false):Promise<QuerySnapshot>=>{
  if(meta.scan){
   const scan=meta.scan;
   // One consistent logical snapshot. A later page never re-reads/decrypts candidates.
   // Keep the base predicates/order; cursor/limit are local views of that snapshot.
   const selected=scan.base.select;
   const sortFields=[...scan.base.orders.map(o=>o.field),...scan.base.preds.filter(p=>['<','<=','>','>=','!=','not-in'].includes(p.op)).map(p=>p.field)];
   scan.result??=snapshotQuery({...scan.base,scan:undefined,limit:scan.maxResults,offset:undefined,last:undefined,
    select:selected?[...new Set([...selected,...sortFields])]:undefined});
   const result=await scan.result;
   const orders=[...meta.orders],direction=orders.at(-1)?.direction??'asc';
   const inequalities=[...new Set(meta.preds.filter(p=>['<','<=','>','>=','!=','not-in'].includes(p.op)).map(p=>p.field))].sort(compareUtf8Strings);
   for(const field of inequalities)if(field!=='__name__'&&!orders.some(o=>o.field===field))orders.push({field,direction});
   if(!orders.some(o=>o.field==='__name__'))orders.push({field:'__name__',direction});
   const value=(doc:QueryDocumentSnapshot,field:string)=>field==='__name__'?doc.id:doc.get(field);
   const cursorCompare=(doc:QueryDocumentSnapshot,values:unknown[])=>{
    const first=values[0] as QueryDocumentSnapshot | undefined;
    if(values.length===1&&first?.ref&&typeof first?.data==='function')values=orders.map(o=>value(first,o.field));
    if(values.length>orders.length||values.some(x=>x===undefined))throw new Error('invalid logical query cursor');
    for(let i=0;i<values.length;i++){const c=compare(value(doc,orders[i].field),values[i])*(orders[i].direction==='desc'?-1:1);if(c)return c;}return 0;
   };
   // Binary cursor seek also removes the quadratic local filtering/sorting cost.
   const bound=(cursor:{values:unknown[];inclusive:boolean},end:boolean)=>{
    let lo=0,hi=result.docs.length;
    while(lo<hi){const mid=(lo+hi)>>>1,c=cursorCompare(result.docs[mid],cursor.values);
     if(end?c<0||c===0&&cursor.inclusive:c<0||c===0&&!cursor.inclusive)lo=mid+1;else hi=mid;
    }return lo;
   };
   let lo=meta.start?bound(meta.start,false):0,hi=meta.end?bound(meta.end,true):result.docs.length;
   lo+=meta.offset??0;
   if(meta.limit!==undefined){if(meta.last)lo=Math.max(lo,hi-meta.limit);else hi=Math.min(hi,lo+meta.limit);}
   let docs=result.docs.slice(lo,Math.max(lo,hi));
   if(meta.select)docs=docs.map((doc:QueryDocumentSnapshot)=>{
    const data:DocumentData={};for(const field of meta.select!){if(field==='__name__')continue;const v=getAt(doc.data(),field);if(v!==undefined)assignAt(data,field,v);}
    return snapshot(doc,{collection:meta.collection,id:doc.id,converter:meta.converter},{id:doc.id,data});
   });
   return new Proxy(result,{get(target,prop){
    if(prop==='docs')return docs;if(prop==='size')return docs.length;if(prop==='empty')return docs.length===0;
    if(prop==='forEach')return (fn:(doc:QueryDocumentSnapshot)=>void,ctx:unknown)=>docs.forEach(fn,ctx);
    if(prop==='query')return makeQuery(meta);
    if(prop==='docChanges')return ()=>docs.map((doc:QueryDocumentSnapshot,i:number)=>({type:'added',doc,oldIndex:-1,newIndex:i}));
    const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;
   }});
  }
  const scope=readSessions.getStore();
  if(scope&&!countOnly){
   let pending=scope.get(db);if(!pending){pending=db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).get();scope.set(db,pending);}
   const certificate=await pending;
   if(certificate.get('opaque_ids_ready')===true&&certificate.get('opaque_records_complete')===true){
    let readTime:Timestamp|undefined;
    return queryRead(meta,async(query:FirebaseFirestore.Query)=>{
     if(!readTime){const page=await query.get();readTime=page.readTime;return page;}
     return db.runTransaction(tx=>tx.get(query),{readOnly:true,readTime});
    },false,undefined,certificate,true);
   }
  }
  const point=await db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC).get();
  if(countOnly&&point.data()?.opaque_records_complete===true&&!meta.start&&!meta.end&&
   meta.preds.every(p=>lookupFieldIndexed(meta.collection,p.field)&&!p.field.includes('.')&&p.field!=='__name__'&&
    (p.op==='=='&&scalar(p.value)||p.op==='in'&&Array.isArray(p.value)&&p.value.every(scalar)))&&
   meta.orders.every(o=>o.field==='__name__'||meta.preds.some(p=>p.field===o.field))){
   let query=db.collection(meta.collection) as FirebaseFirestore.Query;
   for(const p of meta.preds){
    // Firestore IN does not match null/NaN; preserve the logical adapter's same rule.
    const values=p.op==='in'?p.value.filter((v:unknown)=>v!==null&&!Number.isNaN(v)):undefined;
    if(values?.length===0)return {size:0} as QuerySnapshot;
    query=query.where('_provian_lookup.'+lookupField(p.field),p.op as FirebaseFirestore.WhereFilterOp,
     values?values.map(lookupValue):lookupValue(p.value));
   }
   const aggregate=await db.runTransaction(tx=>tx.get(query.count()),{readOnly:true,readTime:point.readTime});
   const size=Math.min(meta.limit??Infinity,Math.max(0,aggregate.data().count-(meta.offset??0)));
   return {size} as QuerySnapshot;
  }
  return queryRead(meta,(query:any)=>db.runTransaction(tx=>tx.get(query),{readOnly:true,readTime:point.readTime}),countOnly,undefined,point,true);
 };
 const apply=async(tx:any,mutations:Mutation[],reads?:Map<string,Promise<Awaited<ReturnType<typeof resolve>>>>,certificate?:DocumentSnapshot)=>{
  const state=mutations.some(m=>m.ref[META])?(certificate??await tx.get(db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC))):null;
  const ready=state?.data()?.opaque_ids_ready===true;
  const complete=ready&&state?.data()?.opaque_records_complete===true;
  const slots=new Map<string,any>();
  for(const m of mutations){const meta=m.ref[META] as RefMeta|undefined;if(meta&&!slots.has(meta.collection+'/'+meta.id)){
   const known=meta.known,pre=m.options?.lastUpdateTime;
   const same=mutations.filter(other=>other.ref[META]?.collection===meta.collection&&other.ref[META]?.id===meta.id);
   if(known?.packed&&(known.packed.transaction===tx||pre?.isEqual(known.packed.raw.updateTime))){
    slots.set(meta.collection+'/'+meta.id,{raw:known.raw,data:known.data,packed:known.packed,legacy:db.collection(meta.collection).doc(meta.id),opaque:db.collection(meta.collection).doc(privateStorageId(meta.collection,meta.id)),duplicate:false,known:true});
   }else if(complete&&same.length===1&&(m.kind==='create'||m.kind==='set'&&meta.collection!=='meter_act_keys_v1'&&!m.options&&!meta.converter&&!hasTransform(m.data))) {
    // A native create is its own atomic absence check; no read of a brand-new body.
    slots.set(meta.collection+'/'+meta.id,{raw:{exists:false},legacy:db.collection(meta.collection).doc(meta.id),opaque:db.collection(meta.collection).doc(privateStorageId(meta.collection,meta.id)),duplicate:false});
   }else if(known&&m.kind==='update'&&pre?.isEqual(known.raw.updateTime)&&same.length===1){
    slots.set(meta.collection+'/'+meta.id,{raw:known.raw,legacy:db.collection(meta.collection).doc(meta.id),opaque:known.raw.ref,duplicate:false,known:true});
   }else slots.set(meta.collection+'/'+meta.id,await (reads?.get(meta.collection+'/'+meta.id)??resolve(meta,(r:any)=>tx.get(r),complete)));
  }}
  const packedPages=new Map<string,Promise<ResolvedSlot>>();
  for(const [key,slot] of slots)if(!slot.packed&&slot.raw.exists){const meta=mutations.find(m=>m.ref[META]&&m.ref[META].collection+'/'+m.ref[META].id===key)!.ref[META];slots.set(key,await expand(meta,slot,(ref)=>tx.get(ref),complete,packedPages,tx));}
  const staged=new Map<string,{meta:RefMeta;slot:any;data:any;exists:boolean;created:boolean;deleted:boolean}>();
  // Original reads and all alias reads are complete before ANY underlying write.
  for(const m of mutations){
   const meta=m.ref[META] as RefMeta|undefined;
   if(!meta)continue;
   const k=meta.collection+'/'+meta.id,slot=slots.get(k);
   let current=staged.get(k);
   if(!current){current={meta,slot,data:slot.raw.exists?(slot.data??(slot.known?meta.known!.data:decodePrivateRecord(meta.collection,slot.raw.id,slot.raw.data(),wrapped).data)):{},exists:slot.raw.exists,created:false,deleted:false};staged.set(k,current);}
   const opts=m.kind==='delete'?m.data:m.options;
   const pre=opts?.lastUpdateTime;
   if(pre&&(!slot.raw.exists||!(slot.packed?.raw.updateTime??slot.raw.updateTime).isEqual(pre)))throw failure(9,'private storage stale update precondition');
   if(opts?.exists===true&&!current.exists)throw failure(9,'private storage existence precondition');
   if(opts?.exists===false&&current.exists)throw failure(9,'private storage nonexistence precondition');
   if(m.kind==='create'&&current.exists)throw failure(6,'private storage document already exists');
   if(m.kind==='update'&&!current.exists)throw failure(5,'private storage document does not exist');
   if(m.kind==='delete'){current.exists=false;current.data={};current.deleted=true;continue;}
   let data=meta.converter?meta.converter.toFirestore(m.data,m.options):m.data;
   data=recoverRetainedFields(meta.collection,data);
   const times:Record<string,any>={};
   if(m.kind==='update') {
    const out={...current.data};for(const [field,value] of Object.entries(data))assignAt(out,field,materialize(value,getAt(current.data,field),field,times));current.data=out;
   }else {
    const incoming=materialize(data,current.data,'',times);
    if(m.options?.mergeFields){const out={...current.data};for(const f of m.options.mergeFields){const path=fieldName(f);assignAt(out,path,getAt(incoming,path));}current.data=out;}
    else current.data=m.options?.merge?deepMerge(current.data,incoming):incoming;
   }
   if(Object.keys(times).length)current.data._provian_server_times={...current.data._provian_server_times,...times};
   current.created||=m.kind==='create';current.exists=true;current.deleted=false;
  }
  for(const m of mutations)if(!m.ref[META]){
   if(m.kind==='delete')tx.delete(m.ref,m.data);
   else if(m.kind==='update')tx.update(m.ref,m.data,...(m.options?[m.options]:[]));
   else if(m.kind==='set')tx.set(m.ref,m.data,...(m.options?[m.options]:[]));
   else tx.create(m.ref,m.data);
  }
  const packedWrites=new Map<string,{slot:PackedSlot;keys:DocumentData}>();
  for(const {meta,slot,data,exists,created} of staged.values()) {
   if(slot.packed){
    const packed=slot.packed as PackedSlot;
    let group=packedWrites.get(packed.id);
    if(group&&!group.slot.raw.updateTime!.isEqual(packed.raw.updateTime!))throw failure(9,'private packed page mixed snapshot versions');
    if(!group){group={slot:packed,keys:{...packed.data.keys}};packedWrites.set(packed.id,group);}
    if(exists){group.keys[meta.id]=data;tx.set(slot.opaque,encodePrivateRecord(meta.collection,meta.id,meterKeyPointer(data as MeterActKeyDoc,packed.id)));}
    else{delete group.keys[meta.id];tx.delete(slot.opaque);}
    if(slot.duplicate)tx.delete(slot.legacy);
    continue;
   }
   const physical=slot.raw.exists?slot.raw.ref:(ready?slot.opaque:slot.legacy);
   if(!exists){tx.delete(physical);if(slot.duplicate)tx.delete(slot.legacy);continue;}
   const payload=ready||slot.raw.data()?._provian_store===1?encodePrivateRecord(meta.collection,meta.id,data):data;
   if(slot.known){
    // Firestore checks this atomically with every sibling create/update. No stale member can
    // be taken, even if a takeover, demotion or another run changed it since the scan.
    const patch={...payload};for(const field of Object.keys(slot.raw.data()??{}))if(!(field in patch))patch[field]=FieldValue.delete();
    tx.update(physical,patch,{lastUpdateTime:slot.raw.updateTime});
   }else if(created&&!slot.raw.exists)tx.create(physical,payload);else tx.set(physical,payload);
   if(slot.duplicate)tx.delete(slot.legacy);
  }
  for(const {slot,keys} of packedWrites.values()){
   if(!Object.keys(keys).length){tx.delete(slot.raw.ref,{lastUpdateTime:slot.raw.updateTime});continue;}
   const expiries=Object.values(keys).map(key=>key.expire_at as Timestamp|null);
   const expire_at=expiries.some(at=>at==null)?null:Timestamp.fromMillis(Math.max(...expiries.map(at=>at!.toMillis())));
   const payload=encodePrivateRecord(METER_KEY_PAGES,slot.id,{...slot.data,keys,expire_at});
   const patch={...payload};for(const field of Object.keys(slot.raw.data()??{}))if(!(field in patch))patch[field]=FieldValue.delete();
   tx.update(slot.raw.ref,patch,{lastUpdateTime:slot.raw.updateTime});
  }
 };
 const packedFromPage=async(txn:FirebaseFirestore.Transaction,ids:readonly string[],allowMissing=false):Promise<Map<string,{data:DocumentData;ref:FirebaseFirestore.DocumentReference}>>=>{
  const out=new Map<string,{data:DocumentData;ref:FirebaseFirestore.DocumentReference}>();
  for(const id of ids){
   const snap=await txn.get(wrapped.collection(METER_KEY_PAGES).doc(id) as FirebaseFirestore.DocumentReference);
   if(!snap.exists){if(allowMissing)continue;throw new Error('meter_key_page_missing');}
   const meta=(snap.ref as unknown as Record<symbol,RefMeta>)[META],raw=meta.known?.raw,data=snap.data();
   if(!raw||!data||data.schema!=='provian.meter-key-page.v1'||data.batch_hash!==id.split('~')[0]||!data.keys)throw new Error('meter_key_page_binding_invalid');
   for(const [keyId,key] of Object.entries(data.keys) as [string,DocumentData][]){
    if(key.relay_pe_id!==keyId||key.batch_hash!==data.batch_hash||key.actor_id!==data.actor_id)throw new Error('meter_key_page_binding_invalid');
    const ref=makeRef({collection:'meter_act_keys_v1',id:keyId,known:{raw,data:key,packed:{id,raw,data,transaction:(txn as unknown as Record<symbol,unknown>)[TX]}}});
    out.set(keyId,{data:key,ref});
   }
  }
  return out;
 };
 const executeMutations=async(mutations:Mutation[])=>db.runTransaction(async tx=>{await apply(tx,mutations);});
 const transaction=async(fn:any,options?:any)=>db.runTransaction(async tx=>{
  const mutations:Mutation[]=[];
  // A native transaction reads one snapshot. Reuse each alias resolution within THIS attempt;
  // a retry gets a new map, and Firestore still validates every read before any commit.
  const reads=new Map<string,Promise<ResolvedSlot>>();
  const packedPages=new Map<string,Promise<ResolvedSlot>>();
  let certificate: Promise<DocumentSnapshot> | undefined;
  const certified = (): Promise<DocumentSnapshot> => certificate ??= tx.get(db.collection(PRIVATE_RETENTION_STATE_COLLECTION).doc(PRIVATE_RETENTION_STATE_DOC));
  const cachedRef=async(meta:RefMeta)=>{
   const key=meta.collection+'/'+meta.id;let read=reads.get(key);
   if(!read){read=(async()=>{const state=(await certified()).data(),complete=state?.opaque_ids_ready===true&&state?.opaque_records_complete===true;return expand(meta,await resolve(meta,(r:any)=>tx.get(r),complete),(ref)=>tx.get(ref),complete,packedPages,tx);})();reads.set(key,read);}
   return slotSnapshot(meta,await read);
  };
  const proxy=new Proxy(tx,{get(target,prop){
   if(prop===TX)return tx;
   if(prop==='get')return (ref:any)=>{const meta=ref[META];return meta?('id' in meta?cachedRef(meta):certified().then(certificate=>queryRead(meta,(q:any)=>tx.get(q),false,undefined,certificate))):tx.get(ref);};
   if(prop==='getAll')return (...refs:any[])=>Promise.all(refs.map(ref=>proxy.get(ref)));
   if(['set','create','update','delete'].includes(String(prop)))return (ref:any,...args:any[])=>{const meta=ref[META];(db.batch() as any)[prop](meta?db.collection(meta.collection).doc(meta.id):ref,...args);mutations.push(mutation(prop as Mutation['kind'],ref,args));return proxy;};
   const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;
  }});
  const result=await fn(proxy);if(mutations.length)await apply(tx,mutations,reads,certificate?await certificate:undefined);return result;
 },options);
 const batch=()=>{
  const mutations:Mutation[]=[],validation=db.batch();const api:any={commit:()=>executeMutations(mutations)};
  for(const kind of ['set','create','update','delete'])api[kind]=(ref:any,...args:any[])=>{
   const meta=ref[META] as RefMeta|undefined;const raw=meta?db.collection(meta.collection).doc(meta.id):ref;
   (validation as any)[kind](raw,...args); // preserve synchronous SDK validation, including undefined rejection
   mutations.push(mutation(kind as Mutation['kind'],ref,args));return api;
  };return api;
 };
 const bulk=()=>{
  const jobs:Promise<any>[]=[];const writer:any={close:()=>Promise.all(jobs).then(()=>undefined),flush:()=>Promise.all(jobs).then(()=>undefined),onWriteError:()=>undefined,onWriteResult:()=>undefined};
  for(const kind of ['set','create','update','delete'])writer[kind]=(ref:any,...args:any[])=>{const job=executeMutations([mutation(kind as Mutation['kind'],ref,args)]);jobs.push(job);return job;};return writer;
 };
 wrapped=new Proxy(db,{get(target,prop){
  if(prop===RAW)return db;
  if(prop===Symbol.for('provian.meter-key-pages'))return packedFromPage;
  if(prop===Symbol.for('provian.private-store'))return true;
  if(prop==='collection')return (name:string)=>isPrivateCollection(name)?makeQuery({collection:name,preds:[],orders:[]}):boundaryCollection(db.collection(name));
  if(prop==='doc')return (path:string)=>{const parts=path.split('/'),collection=parts.slice(0,-1).join('/');return isPrivateCollection(collection)?makeRef({collection,id:parts.at(-1)!}):boundaryRef(db.doc(path));};
  if(prop==='runTransaction')return transaction;if(prop==='batch')return batch;if(prop==='bulkWriter')return bulk;
  if(prop==='getAll')return (...refs:any[])=>Promise.all(refs.map(ref=>ref[META]?readRef(ref[META],(r:any)=>r.get()):ref.get()));
  if(prop==='listCollections')return async()=>(await db.listCollections()).map(c=>wrapped.collection(c.id));
  const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;
 }});
 caches.set(db,wrapped);return wrapped;
}

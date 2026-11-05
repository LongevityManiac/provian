/** protect retained identifiers using the relay's EXISTING secret.
 * Conversion changes storage only. Readers recover the exact sealed inputs;
 * pricing, signature verification, snapshot commitments and claim IDs do not change.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';
import type { Firestore, CollectionReference, FirestoreDataConverter, DocumentData } from 'firebase-admin/firestore';
export const PRIVATE_RETENTION_COLLECTIONS = new Set([
 'meter_act_keys_v1', 'meter_held_acts_v1', 'identity_pes_legacy_v1',
 'origin_reference_graph_v1', 'meter_relay_acts_v1', 'meter_batch_acts_v1', 'identity_acts_v1',
 'occurrence_mint_claims','device_occurrence_mint_claims','artifact_novelty_claims','meter_pair_counts_v1',
]);
const SENSITIVE = new Set([
 'metadata','input_origins','inputOrigins','relayWitnessedOrigins','relay_derived_origins',
 'economic_snapshot','economic_snapshot_hash','economic_eligibility_projection',
 'canonicalEventId','canonical_event_id','economicCanonicalEventId','observedCanonicalEventId',
 'description','content','input_summary','output_summary','inputSummary','outputSummary',
 'repo','repository','branch','resource','path','cwd','event_id','claim_id','detail_hash',
 'mint_once_claim_evidence','mint_once_claim_evidence_hash',
]);
type Box = { _provian_private: 'aes-256-gcm/v1'; iv: string; ciphertext: string; tag: string };
const plain = (v: unknown): v is Record<string, unknown> => !!v && Object.getPrototypeOf(v) === Object.prototype;
export function privateRetentionKey(): Buffer {
 const secret=process.env.RELAY_SIGNING_KEY;
 if(!secret) throw new Error('private retention requires the existing RELAY_SIGNING_KEY');
 return createHmac('sha256',secret).update('provian-private-retention-key:v1').digest();
}
function box(v: unknown, context: string): Box {
 const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',privateRetentionKey(),iv);
 cipher.setAAD(Buffer.from(context));
 return { _provian_private:'aes-256-gcm/v1',iv:iv.toString('base64'),
  ciphertext:Buffer.concat([cipher.update(JSON.stringify(v),'utf8'),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64') };
}
function unbox(v: Box, context: string): unknown {
 const decipher=createDecipheriv('aes-256-gcm',privateRetentionKey(),Buffer.from(v.iv,'base64'));
 decipher.setAAD(Buffer.from(context));decipher.setAuthTag(Buffer.from(v.tag,'base64'));
 return JSON.parse(Buffer.concat([decipher.update(Buffer.from(v.ciphertext,'base64')),decipher.final()]).toString('utf8')) as unknown;
}
function walk(v: unknown, context: string, decrypt: boolean): unknown {
 if(Array.isArray(v))return v.map((x,i)=>walk(x,context+'.'+i,decrypt));
 if(!plain(v))return v;
 if(v._provian_private==='aes-256-gcm/v1') return decrypt?unbox(v as Box,context):v;
 const result: Record<string,unknown>={};
 const privateOrigin=typeof v.origin_identifier==='string' && /^(?:private_|repo:)/.test(v.origin_identifier);
 for(const [field,value] of Object.entries(v)) {
  const at=context+'.'+field, leaf=field.split('.').at(-1)!;
  if(!decrypt&&plain(value)&&value._provian_private==='aes-256-gcm/v1'){result[field]=value;continue;}
  if(!decrypt && value!==null && value!==undefined && (SENSITIVE.has(leaf) || leaf==='owner'&&typeof value==='string'&&value.startsWith('repo-owner:') || privateOrigin && (field==='origin_identifier'||field==='hash')))result[field]=box(value,at);
  else result[field]=walk(value,at,decrypt);
 }
 return result;
}
export function protectRetainedFields(collection: string, data: DocumentData): DocumentData {
 return walk(data,collection,false) as DocumentData;
}
export function recoverRetainedFields(collection: string, data: DocumentData): DocumentData {
 return walk(data,collection,true) as DocumentData;
}
const retentionConverters = new Map<string, FirestoreDataConverter<DocumentData>>();
export function privateRetentionConverter(collection: string): FirestoreDataConverter<DocumentData> {
 const existing = retentionConverters.get(collection);
 if (existing) return existing;
 const converter: FirestoreDataConverter<DocumentData> = {
  toFirestore(data: DocumentData): DocumentData {return protectRetainedFields(collection,data);},
  fromFirestore(snapshot): DocumentData {return recoverRetainedFields(collection,snapshot.data());},
 };
 retentionConverters.set(collection, converter);
 return converter;
}
/** Explicit at every retained-store boundary, including transaction/getAll references. */
export function privateRetentionCollection(db: { collection: (name: string) => unknown }, collection: string): CollectionReference {
 if((db as any)[Symbol.for('provian.private-store')])return db.collection(collection) as CollectionReference;
 if(!PRIVATE_RETENTION_COLLECTIONS.has(collection))throw new Error('unexpected private-retention collection:'+collection);
 const ref=db.collection(collection) as CollectionReference;
 if(typeof ref.withConverter!=='function') {
  // Hand-written unit-test doubles do not implement Firestore converters. Production never bypasses.
  if(process.env.NODE_ENV==='test')return ref;
  throw new Error('private retention requires a Firestore converter');
 }
 return ref.withConverter(privateRetentionConverter(collection));
}

/** Physical IDs hide dictionary attacks; logical claim commitments never change. */
export const PRIVATE_ID_COLLECTIONS=new Set(['occurrence_mint_claims','device_occurrence_mint_claims','artifact_novelty_claims']);
export const PRIVATE_RETENTION_STATE_COLLECTION='private_retention_state_v1';
export const PRIVATE_RETENTION_STATE_DOC='d554';
export function protectedRetentionId(collection:string,id:string):string {
 if(!PRIVATE_ID_COLLECTIONS.has(collection)&&collection!=='meter_pair_counts_v1')return id;
 return 'private_'+createHmac('sha256',privateRetentionKey()).update('provian-private-store-id:v1\0'+collection+'\0'+id).digest('hex');
}

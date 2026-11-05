/** Decrypt only authenticated mapper inputs; all commitments remain over the ciphertext act. */
import {createDecipheriv,createHmac} from 'crypto';
import {batchHashOf,type PeBatch,type ActRecord} from './meter-wire';
export const PRIVATE_PRICING_SCHEMA='provian.private-pricing.v1';
const PRIVATE_REQUEST_CONTEXT='provian-private-request:v1:';

/** Transit re-sends the same batch-sized sealed copies as the original upload. */
function privateRequestLimit(path:string):number {
 if(path==='/v1/meter/transit')return 2*1024*1024;
 return path.startsWith('/v1/archive/')?26*1024*1024:100*1024;
}
export function openPrivatePricing(act:ActRecord,secret?:string|null):Record<string,unknown> {
 const pricing=act.pricing as Record<string,unknown>,box=pricing.private_pricing;
 if(box===undefined)return pricing; // historical acts keep their original bytes and seals
 if(!secret||!box||typeof box!=='object'||Array.isArray(box))throw new Error('private_pricing_unavailable');
 const b=box as Record<string,unknown>;
 if(b.schema!==PRIVATE_PRICING_SCHEMA||typeof b.nonce!=='string'||!/^[a-f0-9]{24}$/.test(b.nonce)||typeof b.data!=='string'||(b.data.length < 32 || b.data.length % 2 !== 0 || /[^a-f0-9]/.test(b.data)))throw new Error('private_pricing_invalid');
 const key=createHmac('sha256',secret).update('provian-private-pricing-key:v1').digest();
 const data=Buffer.from(b.data,'hex'),d=createDecipheriv('aes-256-gcm',key,Buffer.from(b.nonce,'hex'));
 d.setAAD(Buffer.from(PRIVATE_PRICING_SCHEMA+'\0'+act.pe_id));d.setAuthTag(data.subarray(-16));
 const plaintext=Buffer.concat([d.update(data.subarray(0,-16)),d.final()]);
 const max=act.pe_id.startsWith(PRIVATE_REQUEST_CONTEXT)?privateRequestLimit(act.pe_id.slice(PRIVATE_REQUEST_CONTEXT.length)):2*1024*1024;
 if(plaintext.length>max+100*1024)throw new Error('private_request_transport_limit');
 const plain=JSON.parse(plaintext.toString('utf8')) as Record<string,unknown>;
 if(!plain||typeof plain!=='object'||Array.isArray(plain)||Object.prototype.hasOwnProperty.call(plain,'private_pricing')||Object.prototype.hasOwnProperty.call(plain,'hardware_witness'))throw new Error('private_pricing_invalid');
 // No cleartext overrides: the phone's blinded detail commitment is the only redundant field.
 if(Object.keys(pricing).some(k=>!['private_pricing','hardware_witness','detail_hash'].includes(k)))throw new Error('private_pricing_clear_override');
 if(pricing.detail_hash!==undefined&&pricing.detail_hash!==plain.detail_hash)throw new Error('private_pricing_detail_binding');
 return {...plain,...(pricing.hardware_witness!==undefined?{hardware_witness:pricing.hardware_witness}:{})};
}

/** Authenticated transport wrapper is ephemeral: never included in the accepted batch or store. */
export function unwrapPrivateBatch(body:unknown,secret?:string|null):{batch:unknown;openings:Record<string,string>} {
 if(body&&typeof body==='object'&&!Array.isArray(body)&&Object.prototype.hasOwnProperty.call(body,'private_batch')) {
  const decoded=openPrivatePricing({pe_id:'provian-private-batch:v1',pricing:{private_pricing:(body as Record<string,unknown>).private_batch}} as unknown as ActRecord,secret);
  if(!decoded.batch||!decoded.openings||typeof decoded.openings!=='object'||Array.isArray(decoded.openings))throw new Error('private_batch_invalid');
  const batch=decoded.batch as PeBatch,openings=decoded.openings as Record<string,string>;
  if(Buffer.byteLength(JSON.stringify(batch))>2*1024*1024)throw new Error('private_batch_transport_limit');
  for(const [id,key] of Object.entries(openings))if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key)||!batch.acts.some(a=>a.pe_id===id))throw new Error('private_opening_invalid');
  for(const act of batch.acts)if(act.pricing.private_pricing!==undefined&&!openings[act.pe_id])throw new Error('private_opening_missing');
  return {batch,openings};
 }
 if(!body||typeof body!=='object'||Array.isArray(body)||!Object.prototype.hasOwnProperty.call(body,'private_openings'))return {batch:body,openings:{}};
 const b=body as {batch:PeBatch;private_openings:unknown};
 const raw=openPrivatePricing({pe_id:batchHashOf(b.batch),pricing:{private_pricing:b.private_openings}} as unknown as ActRecord,secret);
 const openings:Record<string,string>={};
 for(const [id,key] of Object.entries(raw)) {
  if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new Error('private_opening_invalid');
  openings[id]=key;
 }
 for(const act of b.batch.acts)if(act.pricing.private_pricing!==undefined&&!openings[act.pe_id])throw new Error('private_opening_missing');
 return {batch:b.batch,openings};
}

/** Opens only AFTER the existing request authentication checked the original wire bytes. */
export function openPrivateAuthenticatedRequest(req:{body?:any;query?:any;originalUrl?:string;url?:string;path?:string},secret?:string|null):void {
 const path=(req.originalUrl||req.url||req.path||'').split('?')[0];
 const context='provian-private-request:v1:'+path;
 const open=(box:unknown):any=>{
  const decoded=openPrivatePricing({pe_id:context,pricing:{private_pricing:box}} as unknown as ActRecord,secret);
  if(!Object.prototype.hasOwnProperty.call(decoded,'request'))throw new Error('private_request_invalid');
  const max=privateRequestLimit(path);
  if(Buffer.byteLength(JSON.stringify(decoded.request))>max)throw new Error('private_request_transport_limit');
  return decoded.request;
 };
 if(req.body&&Object.prototype.hasOwnProperty.call(req.body,'private_request')) {
  if(Object.keys(req.body).length!==1)throw new Error('private_request_clear_override');
  req.body=open(req.body.private_request);
 }
 if(typeof req.query?.private_query==='string'){if(Object.keys(req.query).length!==1)throw new Error('private_query_clear_override');req.query=open(JSON.parse(req.query.private_query));}
}

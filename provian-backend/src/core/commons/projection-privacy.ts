/** Public disclosures retain the owner's choices and anchored proof, never unselected PE commitments. */
import {createHmac} from 'crypto';
import {privateRetentionKey} from '../provenance/private-retention';
import type {PEPublicProjection} from './types';
const alias=(domain:string,value:string)=>createHmac('sha256',privateRetentionKey()).update('provian-public-projection:v1\0'+domain+'\0'+value).digest('hex');
export const publicProjectionId=(id:string)=>'projection_'+alias('id',id);
export function publicProjection(projection:PEPublicProjection):PEPublicProjection {
 return {...projection,pe_id:publicProjectionId(projection.pe_id),pe_hash:alias('hash',projection.pe_hash),prev_envelope_hash:alias('previous',projection.prev_envelope_hash??''),projection_signature:alias('signature',projection.projection_signature)};
}

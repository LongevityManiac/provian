import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/** Protect the complete already-signed request; original signature and hardware binding never move. */
import {createHmac} from 'crypto';
import {sealToAnchor} from './agent-key-recovery';
const PURPOSE='provian.relay-private-request.v1';
export async function sealRelayPrivateRequest(relayUrl:string,path:string,request:Record<string,unknown>,existingSecret:string,fetchFn:typeof fetch=fetch):Promise<Record<string,unknown>> {
  fetchFn = guardedFetcher(fetchFn);
 if(!existingSecret)throw new Error('existing owner key required');
 const response=await fetchFn(relayUrl.replace(/\/$/,'')+'/v1/present/privacy-key');
 if(!response.ok)throw new Error('relay_privacy_key_unavailable');
 const key=await response.json() as {purpose?:string;kid?:string;public_key?:string};
 if(key.purpose!==PURPOSE||typeof key.kid!=='string'||typeof key.public_key!=='string')throw new Error('relay_privacy_key_invalid');
 const publicKey=Buffer.from(key.public_key,'base64url');if(publicKey.length!==32)throw new Error('relay_privacy_key_invalid');
 // A fresh signed occurrence nonce supplies uniqueness; no additional persistent key or credential.
 const ephemeral=createHmac('sha256',existingSecret).update(PURPOSE+'\0'+path+'\0'+JSON.stringify(request)).digest();
 const data=sealToAnchor(publicKey,Buffer.from(JSON.stringify({purpose:PURPOSE,path,request})),()=>ephemeral);
 return {private_relay_request:{purpose:PURPOSE,kid:key.kid,data:Buffer.from(data).toString('base64url')}};
}

/** Ephemeral ingress protection using the existing presentation identity, never a new key. */
import {createHash} from 'crypto';
import {loadPresentationSigningKey} from '../presentation/signer';
import {openWithKey,x25519PublicOf} from './sealed-box';

export const RELAY_PRIVATE_REQUEST_PURPOSE='provian.relay-private-request.v1';
function existingKey(env:NodeJS.ProcessEnv=process.env){
 const loaded=loadPresentationSigningKey(env);
 if(!loaded.ok)throw new Error('relay_privacy_key_unavailable');
 const jwk=loaded.key.privateKey.export({format:'jwk'});
 if(typeof jwk.d!=='string')throw new Error('relay_privacy_key_unavailable');
 // RFC 8032's secret scalar is also the RFC 7748 X25519 scalar. Domain/purpose is bound inside the box.
 const secret=createHash('sha512').update(Buffer.from(jwk.d,'base64url')).digest().subarray(0,32);
 secret[0]&=248;secret[31]&=127;secret[31]|=64;
 return {kid:loaded.key.kid,secret};
}
export function relayPrivacyCapability(env:NodeJS.ProcessEnv=process.env){
 const key=existingKey(env);
 return {purpose:RELAY_PRIVATE_REQUEST_PURPOSE,kid:key.kid,public_key:x25519PublicOf(key.secret).toString('base64url')};
}
export function openRelayPrivateRequest(body:unknown,path:string,env:NodeJS.ProcessEnv=process.env):unknown {
 if(!body||typeof body!=='object'||!Object.prototype.hasOwnProperty.call(body,'private_relay_request'))return body;
 if(Object.keys(body).length!==1)throw new Error('relay_private_request_clear_override');
 const box=(body as any).private_relay_request,key=existingKey(env);
 if(box?.purpose!==RELAY_PRIVATE_REQUEST_PURPOSE||box.kid!==key.kid||typeof box.data!=='string'||!/^[A-Za-z0-9_-]+$/.test(box.data))throw new Error('relay_private_request_invalid');
 const opened=JSON.parse(openWithKey(key.secret,Buffer.from(box.data,'base64url')).toString('utf8'));
 if(opened?.purpose!==RELAY_PRIVATE_REQUEST_PURPOSE||opened.path!==path||!opened.request||typeof opened.request!=='object'||Array.isArray(opened.request))throw new Error('relay_private_request_binding');
 return opened.request;
}

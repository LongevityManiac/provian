import {createPrivateKey,createPublicKey} from 'crypto';
import {relayPrivacyCapability,openRelayPrivateRequest} from '../../provian-backend/src/core/meter/relay-private-request';
const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,11)]),format:'der',type:'pkcs8'});
const publicJwk=createPublicKey(key).export({format:'jwk'});
export const PRIVACY_TEST_ENV={ATTESTATION_SIGNING_KEY:JSON.stringify({...key.export({format:'jwk'}),...publicJwk,kid:'existing-fixture-presentation-key'})};
export const privacyTestCapability=()=>relayPrivacyCapability(PRIVACY_TEST_ENV);
export const openPrivacyTestRequest=(body:unknown)=>openRelayPrivateRequest(body,'/v1/pe/submit-sovereign',PRIVACY_TEST_ENV) as Record<string,unknown>;
export function privacyTestFetch(fetchFn:typeof fetch):typeof fetch{return (async(input:any,init?:RequestInit)=>{
 if(String(input).endsWith('/v1/present/privacy-key'))return new Response(JSON.stringify(privacyTestCapability()),{status:200});
 return fetchFn(input,init);
}) as typeof fetch;}

/** Existing wallet auth credential; no new identity or attestation key. */
import {gcm} from '@noble/ciphers/aes';
import {hmac} from '@noble/hashes/hmac';
import {sha256} from '@noble/hashes/sha2';
import {bytesToHex,utf8ToBytes} from '@noble/hashes/utils';
export const PRIVATE_PRICING_SCHEMA='provian.private-pricing.v1';
export function privateCommitmentOpening(secret:string,peId:string):string {
 if(!secret)throw new Error('existing wallet credential required');
 return bytesToHex(hmac(sha256,utf8ToBytes(secret),utf8ToBytes('provian-private-commitment:v1\0'+peId)));
}
export function sealPrivatePricing(pricing:Record<string,unknown>,secret:string,peId:string):Record<string,unknown> {
 const key=hmac(sha256,utf8ToBytes(secret),utf8ToBytes('provian-private-pricing-key:v1'));
 const nonce=new Uint8Array(12);globalThis.crypto.getRandomValues(nonce);
 const data=gcm(key,nonce,utf8ToBytes(PRIVATE_PRICING_SCHEMA+'\0'+peId)).encrypt(utf8ToBytes(JSON.stringify(pricing)));
 return {schema:PRIVATE_PRICING_SCHEMA,nonce:bytesToHex(nonce),data:bytesToHex(data)};
}
export function blindDetailHash(hash:string,opening:string):string {
 return bytesToHex(sha256(utf8ToBytes(opening+'\0'+hash)));
}

/** the existing device credential protects pricing before hashing and attestation. */
import {createCipheriv,createHmac,randomBytes} from 'crypto';
export const PRIVATE_PRICING_SCHEMA='provian.private-pricing.v1';
export function privateCommitmentOpening(secret:string,peId:string):string {
 if(!secret)throw new Error('existing device credential required');
 return createHmac('sha256',secret).update('provian-private-commitment:v1\0'+peId).digest('hex');
}
export function sealPrivatePricing(pricing:Record<string,unknown>,secret:string,peId:string):Record<string,unknown> {
 const key=createHmac('sha256',secret).update('provian-private-pricing-key:v1').digest();
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
 cipher.setAAD(Buffer.from(PRIVATE_PRICING_SCHEMA+'\0'+peId));
 const data=Buffer.concat([cipher.update(JSON.stringify(pricing),'utf8'),cipher.final(),cipher.getAuthTag()]);
 return {schema:PRIVATE_PRICING_SCHEMA,nonce:nonce.toString('hex'),data:data.toString('hex')};
}

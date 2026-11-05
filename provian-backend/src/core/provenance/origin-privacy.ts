/** Private relay identifiers use the existing relay-held signing secret, separated by purpose. */
import {createHmac} from 'crypto';
export function privateIdentifierMac(type:string,value:string):string {
 const key=process.env.RELAY_SIGNING_KEY;
 if(!key)throw new Error('private identifier requires RELAY_SIGNING_KEY');
 return createHmac('sha256',key).update('provian-private-identifier:v1\0'+type+'\0'+value,'utf8').digest('hex');
}

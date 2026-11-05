/** Domain-separated MACs under the already registered device credential. Never a public salt. */
import {createHmac} from 'crypto';
import {loadCredentials} from '../scripts/credentials';
let secret:string|null=null;
export function setOriginPrivacySecret(value:string):void{if(!value)throw new Error('private identifier requires the existing device credential');secret=value;}
export function privateIdentifierMac(type:string,value:string):string {
 const key=secret??loadCredentials()?.deviceSecret;
 if(!key)throw new Error('private identifier requires the existing device credential');
 return createHmac('sha256',key).update('provian-private-identifier:v1\0'+type+'\0'+value,'utf8').digest('hex');
}

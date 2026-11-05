/** relay diagnostic data is retained only encrypted under the existing relay secret.
 * Install before relay modules run. Codes/counts, errors and stacks share the same boundary;
 * an interpolated first argument is just as private as a structured error field.
 */
import {createCipheriv,createHmac,randomBytes} from 'crypto';
export function privateDiagnostic(args:unknown[],secret:string):Record<string,unknown> {
 const seen=new WeakSet<object>();
 const bytes=Buffer.from(JSON.stringify(args,(_key,value)=>{
  if(value instanceof Error)return {name:value.name,message:value.message,stack:value.stack,code:(value as any).code};
  if(typeof value==='bigint')return value.toString();
  if(value&&typeof value==='object'){if(seen.has(value))return '[circular]';seen.add(value);}
  return value;
 }));
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',createHmac('sha256',secret).update('provian-private-diagnostic-key:v1').digest(),iv);
 cipher.setAAD(Buffer.from('provian-private-diagnostic:v1'));
 return {private_diagnostic:'aes-256-gcm/v1',iv:iv.toString('base64'),ciphertext:Buffer.concat([cipher.update(bytes),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
const installed=Symbol.for('provian.diagnostic-privacy');
if(!(console as any)[installed]){
 (console as any)[installed]=true;
 for(const level of ['log','info','warn','error','debug'] as const){
  const original=console[level].bind(console);
  console[level]=(...args:unknown[])=>{
   const secret=process.env.RELAY_SIGNING_KEY;
   try{original(JSON.stringify(secret?privateDiagnostic(args,secret):{private_diagnostic:'withheld_missing_relay_secret'}));}
   catch{original('{"private_diagnostic":"withheld_serialization_failure"}');}
  };
 }
}

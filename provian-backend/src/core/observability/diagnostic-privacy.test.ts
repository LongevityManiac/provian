import {createDecipheriv,createHmac} from 'crypto';

// Exercise the installed wrapper without letting it hide Jest's own diagnostics.
const levels=['log','info','warn','error','debug'] as const;
const original=Object.fromEntries(levels.map(level=>[level,console[level]]));
const received:unknown[][]=[];
for(const level of levels)console[level]=(...args:unknown[])=>{received.push(args);};
const {privateDiagnostic}=require('./diagnostic-privacy') as typeof import('./diagnostic-privacy');
const wrapped=console.error;
for(const level of levels)console[level]=original[level];

describe(' relay diagnostic privacy under the existing relay secret',()=>{
 const secret='existing-test-relay-secret',path='/Users/private-owner/private-project/plan.md';
 const open=(box:Record<string,any>)=>{
  const decipher=createDecipheriv('aes-256-gcm',createHmac('sha256',secret).update('provian-private-diagnostic-key:v1').digest(),Buffer.from(box.iv,'base64'));
  decipher.setAAD(Buffer.from('provian-private-diagnostic:v1'));decipher.setAuthTag(Buffer.from(box.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.ciphertext,'base64')),decipher.final()]).toString());
 };
 it('RED plaintext recovers a guessed path; retained ciphertext preserves the exact error for its secret holder',()=>{
  const error=Object.assign(new Error('failed reading '+path),{code:'E_PRIVATE'}),args=['read failed: '+path,{[path]:'private branch'},error,7n];
  expect(args[0]).toContain(path);
  const a=privateDiagnostic(args,secret),b=privateDiagnostic(args,secret);
  expect(JSON.stringify(a)).not.toContain(path);expect(a).not.toEqual(b);
  expect(open(a)).toEqual([args[0],args[1],{name:error.name,message:error.message,stack:error.stack,code:error.code},'7']);
  expect(()=>open({...a,tag:Buffer.alloc(16).toString('base64')})).toThrow();
 });
 it('the installed wrapper encrypts interpolated strings and withholds data when the existing secret is absent',()=>{
  const prior=process.env.RELAY_SIGNING_KEY;
  try{
   process.env.RELAY_SIGNING_KEY=secret;wrapped('failed '+path);expect(open(JSON.parse(received.at(-1)![0] as string))).toEqual(['failed '+path]);
   delete process.env.RELAY_SIGNING_KEY;wrapped('failed '+path);expect(received.at(-1)).toEqual(['{"private_diagnostic":"withheld_missing_relay_secret"}']);
  }finally{if(prior===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=prior;}
 });
});

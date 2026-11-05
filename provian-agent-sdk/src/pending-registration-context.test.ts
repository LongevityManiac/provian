import {afterEach, describe,expect,it,vi} from 'vitest';
import * as fs from 'fs';import * as os from 'os';import * as path from 'path';
import {loadOrCreatePendingAgentWalletRegistration,resumeAgentWalletRegistration} from './pending-wallet-registration';
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllGlobals();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
const config={relayUrl:'https://relay.test',agentId:'historical-pending-agent',agentName:'Historical Agent',platform:'sdk',constitutionAcceptedAt:'2026-07-12T00:00:00.000Z'};
async function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pending-context-'));dirs.push(dir);const file=path.join(dir,'pending.json');
 await loadOrCreatePendingAgentWalletRegistration(config,'passphrase',file,{N:1024,r:8,p:1,dklen:32});
 const stored=JSON.parse(fs.readFileSync(file,'utf8'));stored.prepared.archived_option='old-anchor';fs.writeFileSync(file,JSON.stringify(stored),{mode:0o600});
 const handle=await loadOrCreatePendingAgentWalletRegistration(config,'passphrase',file,{N:1024,r:8,p:1,dklen:32});
 return {file,handle,stored};
}
describe('historical request context never creates a second identity',()=>{
 it('authenticates the same encrypted key, carries context only for a confirmed committed replay, and retains it on failure',async()=>{
  const {file,handle,stored}=await fixture();const original=fs.readFileSync(file,'utf8');let body:Record<string,unknown>={};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({challenge_id:'challenge',challenge:'a'.repeat(64),registration_exists:true})}).mockImplementationOnce(async(_url,init)=>{body=JSON.parse(init.body);return {ok:false,status:409,text:async()=>JSON.stringify({error:'identity_mismatch'})};}));
  await expect(resumeAgentWalletRegistration(handle)).rejects.toMatchObject({code:'HTTP_409'});
  expect(body.public_key).toBe(stored.prepared.publicKey);
  expect(body.prior_request_context).toEqual({archived_option:'old-anchor'});
  expect(body).not.toHaveProperty('archived_option');
  expect(fs.readFileSync(file,'utf8')).toBe(original);
  expect((await loadOrCreatePendingAgentWalletRegistration(config,'passphrase',file,{N:1024,r:8,p:1,dklen:32}))).toBeDefined();
 });
 it('omits historical context from fresh creation and preserves the key if registration state is unknown',async()=>{
  for(const exists of [false,undefined]){
   const {file,handle}=await fixture();const original=fs.readFileSync(file,'utf8');let body:Record<string,unknown>={};
   const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({challenge_id:'challenge',challenge:'a'.repeat(64),registration_exists:exists})}).mockImplementationOnce(async(_url,init)=>{body=JSON.parse(init.body);return {ok:false,status:503,text:async()=>''};});vi.stubGlobal('fetch',fetch);
   await expect(resumeAgentWalletRegistration(handle)).rejects.toBeDefined();
   expect(body).not.toHaveProperty('prior_request_context');expect(fs.readFileSync(file,'utf8')).toBe(original);
   if(exists===undefined)expect(fetch).toHaveBeenCalledTimes(1);
  }
 });
 it('a changed bound key or identity refuses before any network request',async()=>{
  const {file}=await fixture();const data=JSON.parse(fs.readFileSync(file,'utf8'));data.prepared.publicKey='a'.repeat(128);fs.writeFileSync(file,JSON.stringify(data),{mode:0o600});
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(loadOrCreatePendingAgentWalletRegistration(config,'passphrase',file,{N:1024,r:8,p:1,dklen:32})).rejects.toThrow('key binding');expect(fetch).not.toHaveBeenCalled();
 });
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { concat, hexlify, sha256 } from 'ethers';
import { encryptKeystore, saveKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';
import { provisionBreakRecovery, prepareAgentBreakRecovery, completeAgentBreakRecovery, withAgentRecoveryMaterial, withAgentHashRecoveryRecord } from './break-recovery-store';
import { prepareAgentHashReplacement, prepareAgentHashReplacementDeployment } from './agent-hash-replacement';
import type { OwnerChainNetwork } from './recourse-owner-chain';
const f=vi.hoisted(()=>({secret:'',seed:'',commitment:'',signingRoot:'',nonce:1,changed:false,reads:0,occupied:false,rootReads:[] as string[],losePersist:false}));
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,identity=h(1),context=a(2),destination=a(3),commitment=h(4);
vi.mock('./recourse-hash-authorization',()=>({recoverySigningRoot:async(seed:Uint8Array)=>sha256(seed),recoveryCommitment:(secret:Uint8Array,root:string)=>sha256(concat([secret,root])),
 signRecoveryIntent:async(_seed:Uint8Array,intent:string,journal:{reserve(root:string,intent:string):Promise<void>})=>{await journal.reserve(h(9),intent);return{publicKey:h(9),signature:`0x${'aa'.repeat(7856)}`};}}));
vi.mock('./break-recovery',()=>({readBreakRecoveryContext:async()=>context,prepareBreakRecovery:async(input:{identity?:string;destination:string;destinationSigningSeed:Uint8Array;nextRecoverySecret:Uint8Array;nextRecoverySigningSeed:Uint8Array;persistBeforePublishing(backup:unknown):Promise<void>})=>{
 f.secret=hexlify(input.nextRecoverySecret);f.seed=hexlify(input.nextRecoverySigningSeed);f.signingRoot=sha256(input.nextRecoverySigningSeed);f.commitment=sha256(concat([input.nextRecoverySecret,f.signingRoot]));
 await input.persistBeforePublishing({kernel:a(8),identity,destination:input.destination,destinationSigningSeed:input.destinationSigningSeed,nextRecoverySecret:input.nextRecoverySecret,nextRecoverySigningSeed:input.nextRecoverySigningSeed,operationHash:h(5)});
 return {phase:'restore_balance',kernel:a(8),identity,destination,ownerIntent:h(5)};
}}));
vi.mock('./recourse-agent-credential',()=>({withBoundRecoveryMaterial:async(_k:unknown,_p:string,_i:string,fn:(secret:Uint8Array,seed:Uint8Array)=>Promise<unknown>)=>fn(new Uint8Array(32).fill(1),new Uint8Array(32).fill(2))}));
vi.mock('./break-recovery-receipt',()=>({verifyBreakRecoveryReceipt:async()=>{}}));
vi.mock('./recourse-owner-chain',()=>({readOwnerChainState:async()=>{f.reads++;return {nonce:f.nonce,destination,commitment:f.changed&&f.reads>1?h(99):f.commitment,signingRoot:f.signingRoot,deployment:{manifestHash:h(10),revision:1n,addresses:{kernel:a(8)}}};}}));
vi.mock('./hash-account-deployment',()=>{
 const discover=async(root:string)=>{f.rootReads.push(root);return{account:`0x${root.slice(-40)}`,initialRoot:root,deployed:f.occupied,currentRoot:f.occupied?h(99):null,nonce:f.occupied?'1':null,factory:a(6),breakOrigin:a(2),manifestHash:h(10)};};
 return{discoverHashAccount:discover,prepareHashAccountDeployment:discover};
});
vi.mock('./durable-private-file',async actual=>{
 const mod=await actual<typeof import('./durable-private-file')>();return{...mod,atomicReplacePrivateFile:(file:string,data:string)=>{if(f.losePersist&&file.includes('break-recoveries')){f.losePersist=false;throw Error('persist failed');}return mod.atomicReplacePrivateFile(file,data);}};
});
let directory:string;
const passphrase='test only encrypted replacement',network={} as OwnerChainNetwork;
const input=()=>({directory,passphrase,network,identity});
beforeEach(async()=>{
 Object.assign(f,{secret:'',seed:'',commitment:'',signingRoot:'',nonce:1,changed:false,reads:0,occupied:false,rootReads:[],losePersist:false});
 directory=fs.mkdtempSync(path.join(os.tmpdir(),'provian-agent-replacement-'));
 saveKeystore(encryptKeystore({...generateAgentKeyPair(),walletId:'wallet_aw_replacement',passphrase,recoverySecret:'11'.repeat(32),kdfParams:{N:1024,r:8,p:1,dklen:32}}),path.join(directory,'agent-keystore.json'));
 // The initial snapshot matches the mocked historical bound backup material.
 const initial=sha256(concat([new Uint8Array(32).fill(1),sha256(new Uint8Array(32).fill(2))]));
 await provisionBreakRecovery({...input(),commitment:initial,context});
 await prepareAgentBreakRecovery({...input(),destination,entitlement:{identity,commitment:initial,amount:'100',proof:[]}});
 await completeAgentBreakRecovery({...input(),commitment:initial,transactionHash:h(7)});
});
afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
test('retains one fresh encrypted account and current independent authority without reading the stolen spending root',async()=>{
 const original=fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8'),plan=await prepareAgentHashReplacement(input());
 expect(await prepareAgentHashReplacement(input())).toEqual(plan);expect(plan.account).not.toBe(destination);expect(plan.commitment).toBe(f.commitment);
 const proof=await prepareAgentHashReplacementDeployment({...input(),plan});expect(proof).toMatchObject({kind:'replacement',nonce:1,account:plan.account,initialRoot:plan.initialRoot,commitment:f.commitment,recoverySecret:f.secret});
 expect(await prepareAgentHashReplacementDeployment({...input(),plan})).toEqual(proof);
 expect(f.rootReads.every(root=>root===plan.initialRoot)).toBe(true);expect(fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8')).toBe(original);
 const file=path.join(directory,'break-recoveries',`${identity.slice(2)}-${plan.commitment.slice(2)}-${context.slice(2)}.json`),raw=fs.readFileSync(file,'utf8');
 expect(raw).not.toContain(f.secret.slice(2));expect(raw).not.toContain('destinationSigningSeed');expect(fs.statSync(file).mode&0o777).toBe(0o600);
});
test('changed owner authority, reused destination state and a changed caller plan cannot obtain sponsorship',async()=>{
 f.changed=true;await expect(prepareAgentHashReplacement(input())).rejects.toThrow('authority_changed');f.changed=false;f.reads=0;
 const priorRoot=f.signingRoot;f.signingRoot=h(99);await expect(prepareAgentHashReplacement(input())).rejects.toThrow('authority_changed');f.signingRoot=priorRoot;
 f.occupied=true;await expect(prepareAgentHashReplacement(input())).rejects.toThrow('destination_changed');f.occupied=false;
 const plan=await prepareAgentHashReplacement(input());
 await expect(prepareAgentHashReplacementDeployment({...input(),plan:{...plan,account:a(99)}})).rejects.toThrow('plan_changed');
 f.nonce=2;await expect(prepareAgentHashReplacementDeployment({...input(),plan})).rejects.toThrow(/changed/);
});
test('pending replacement generations remain available by exact commitment for a later last-good snapshot',async()=>{
 const plan=await prepareAgentHashReplacement(input());
 const files=fs.readdirSync(path.join(directory,'break-recoveries'));expect(files).toHaveLength(2);
 const source=await withAgentRecoveryMaterial({...input(),commitment:plan.commitment},async(secret,seed)=>({secret:hexlify(secret),seed:hexlify(seed)}));expect(source).toEqual({secret:f.secret,seed:f.seed});
 const next=await withAgentHashRecoveryRecord({...input(),...plan},async record=>({commitment:sha256(concat([record.nextRecoverySecret,sha256(record.nextRecoverySigningSeed)])),secret:record.nextRecoverySecret}));
 expect(await withAgentRecoveryMaterial({...input(),commitment:next.commitment},async secret=>hexlify(secret))).toBe(next.secret);
 const before=fs.readFileSync(path.join(directory,'break-recoveries',`${identity.slice(2)}-${plan.commitment.slice(2)}-${context.slice(2)}.json`),'utf8');
 f.losePersist=true;await expect(prepareAgentHashReplacementDeployment({...input(),plan})).rejects.toThrow('persist failed');
 expect(fs.readFileSync(path.join(directory,'break-recoveries',`${identity.slice(2)}-${plan.commitment.slice(2)}-${context.slice(2)}.json`),'utf8')).toBe(before);
 expect((await prepareAgentHashReplacement(input())).account).toBe(plan.account);
});

test('record persistence is revoked after the callback and queued inputs retain their original binding',async()=>{
 const plan=await prepareAgentHashReplacement(input());let escaped:(()=>void)|undefined;
 const supplied={...input(),...plan};const pending=withAgentHashRecoveryRecord(supplied,async(record,persist)=>{escaped=persist;expect(record.commitment).toBe(plan.commitment);});
 supplied.passphrase='changed while queued';await pending;
 const file=path.join(directory,'break-recoveries',`${identity.slice(2)}-${plan.commitment.slice(2)}-${context.slice(2)}.json`),before=fs.readFileSync(file,'utf8');
 expect(()=>escaped!()).toThrow('lock_expired');expect(fs.readFileSync(file,'utf8')).toBe(before);
 await expect(withAgentHashRecoveryRecord({...input(),...plan},async(record,persist)=>{record.identity=h(99);persist();})).rejects.toThrow('binding_changed');
 expect(fs.readFileSync(file,'utf8')).toBe(before);
});

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { concat, hexlify, sha256 } from 'ethers';
import { encryptKeystore, saveKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';
import { provisionBreakRecovery, prepareAgentBreakRecovery, completeAgentBreakRecovery, withAgentRecoveryMaterial, withAgentHashRecoveryRecord } from './break-recovery-store';
import { prepareAgentHashReplacement } from './agent-hash-replacement';
import { recoverAgentHashCredentials } from './agent-hash-credentials';
import { readActiveHashWallet, agentInitialBreakNeedsInstall } from './break-recovery-store';
import { prepareAgentHashOwnerOperation, confirmAgentHashOwnerOperation } from './agent-hash-owner-operation';
import type { OwnerChainNetwork } from './recourse-owner-chain';
const f=vi.hoisted(()=>({secret:'',seed:'',commitment:'',signingRoot:'',nonce:1,changed:false,reads:0,occupied:false,rootReads:[] as string[],losePersist:false,deployed:false,kernel:8,revision:1,ownerDestination:'0x0000000000000000000000000000000000000003',signs:0,failSign:false,badReceipt:false,receiptCalls:0,accountRoot:'',loseCredentials:false}));
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,identity=h(1),context=a(2),destination=a(3),commitment=h(4);
vi.mock('./recourse-hash-authorization',()=>({recoverySigningRoot:async(seed:Uint8Array)=>sha256(seed),recoveryCommitment:(secret:Uint8Array,root:string)=>sha256(concat([secret,root])),
 signRecoveryIntent:async(_seed:Uint8Array,intent:string,journal:{reserve(root:string,intent:string):Promise<void>})=>{await journal.reserve(h(9),intent);f.signs++;if(f.failSign){f.failSign=false;throw Error('signature interrupted');}return{publicKey:h(9),signature:`0x${'aa'.repeat(7856)}`};}}));
vi.mock('./break-recovery',()=>({readBreakRecoveryContext:async()=>context,prepareBreakRecovery:async(input:{identity?:string;destination:string;destinationSigningSeed:Uint8Array;nextRecoverySecret:Uint8Array;nextRecoverySigningSeed:Uint8Array;persistBeforePublishing(backup:unknown):Promise<void>})=>{
 f.secret=hexlify(input.nextRecoverySecret);f.seed=hexlify(input.nextRecoverySigningSeed);f.signingRoot=sha256(input.nextRecoverySigningSeed);f.commitment=sha256(concat([input.nextRecoverySecret,f.signingRoot]));
 await input.persistBeforePublishing({kernel:a(8),identity,destination:input.destination,destinationSigningSeed:input.destinationSigningSeed,nextRecoverySecret:input.nextRecoverySecret,nextRecoverySigningSeed:input.nextRecoverySigningSeed,operationHash:h(5)});
 return {phase:'restore_balance',kernel:a(8),identity,destination,ownerIntent:h(5)};
}}));
vi.mock('./recourse-agent-credential',()=>({withBoundRecoveryMaterial:async(_k:unknown,_p:string,_i:string,fn:(secret:Uint8Array,seed:Uint8Array)=>Promise<unknown>)=>fn(new Uint8Array(32).fill(1),new Uint8Array(32).fill(2))}));
vi.mock('./break-recovery-receipt',()=>({verifyBreakRecoveryReceipt:async()=>{}}));
vi.mock('./recourse-owner-chain',()=>({readOwnerChainState:async()=>{f.reads++;return {nonce:f.nonce,destination:f.ownerDestination,commitment:f.changed&&f.reads>1?h(99):f.commitment,signingRoot:f.signingRoot,deployment:{manifestHash:h(10),revision:BigInt(f.revision),addresses:{kernel:a(f.kernel)}}};},verifyOwnerOperationReceipt:async()=>{f.receiptCalls++;if(f.badReceipt)throw Error('receipt mismatch');}}));
vi.mock('./hash-account-deployment',()=>{
 const discover=async(root:string)=>{f.rootReads.push(root);return{account:`0x${root.slice(-40)}`,initialRoot:root,deployed:f.occupied||f.deployed,currentRoot:f.occupied?h(99):f.deployed?root:null,nonce:f.occupied?'1':f.deployed?'0':null,factory:a(6),breakOrigin:a(2),manifestHash:h(10)};};
 return{discoverHashAccount:discover,prepareHashAccountDeployment:discover};
});
vi.mock('./recourse-binding-chain',()=>({readAddressRecoveryBinding:async()=>identity}));
vi.mock('./hash-account-chain',()=>({readHashAccountState:async()=>({root:f.accountRoot,nonce:'0',manifestHash:h(10)})}));
vi.mock('./hash-account',()=>({signHashAccountMessage:async()=> '0x1234'}));
vi.mock('./durable-private-file',async actual=>{
 const mod=await actual<typeof import('./durable-private-file')>();return{...mod,atomicReplacePrivateFile:(file:string,data:string)=>{if(f.loseCredentials&&file.endsWith('agent-credentials.json')){f.loseCredentials=false;throw Error('credential install interrupted');}if(f.losePersist&&file.includes('break-recoveries')){f.losePersist=false;throw Error('persist failed');}return mod.atomicReplacePrivateFile(file,data);}};
});
let directory:string;
const passphrase='test only encrypted replacement',network={} as OwnerChainNetwork;
const input=()=>({directory,passphrase,network,identity});
beforeEach(async()=>{
 Object.assign(f,{secret:'',seed:'',commitment:'',signingRoot:'',nonce:1,changed:false,reads:0,occupied:false,rootReads:[],losePersist:false,deployed:false,kernel:8,revision:1,ownerDestination:'0x0000000000000000000000000000000000000003',signs:0,failSign:false,badReceipt:false,receiptCalls:0,accountRoot:'',loseCredentials:false});
 directory=fs.mkdtempSync(path.join(os.tmpdir(),'provian-agent-replacement-'));
 saveKeystore(encryptKeystore({...generateAgentKeyPair(),walletId:'wallet_aw_replacement',passphrase,recoverySecret:'11'.repeat(32),kdfParams:{N:1024,r:8,p:1,dklen:32}}),path.join(directory,'agent-keystore.json'));
 // The initial snapshot matches the mocked historical bound backup material.
 const initial=sha256(concat([new Uint8Array(32).fill(1),sha256(new Uint8Array(32).fill(2))]));
 await provisionBreakRecovery({...input(),commitment:initial,context});
 await prepareAgentBreakRecovery({...input(),destination,entitlement:{identity,commitment:initial,amount:'100',proof:[]}});
 await completeAgentBreakRecovery({...input(),commitment:initial,transactionHash:h(7)});
});
afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
const loss=()=>({transactionHash:h(30),block:100,kernel:a(8),scope:{request:h(31),lossHash:h(32),maximumLoss:'123'}});
const ready=async()=>{const plan=await prepareAgentHashReplacement(input());f.deployed=true;f.accountRoot=plan.initialRoot;return plan;};
test('persists the same bounded loss and destination through an interrupted signature, without changing the original wallet',async()=>{
 const original=fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8'),plan=await ready();f.failSign=true;
 await expect(prepareAgentHashOwnerOperation({...input(),plan,loss:loss()})).rejects.toThrow('signature interrupted');
 await expect(prepareAgentHashOwnerOperation({...input(),plan,loss:{...loss(),scope:{...loss().scope,maximumLoss:'124'}}})).rejects.toThrow('loss_changed');
 const op=await prepareAgentHashOwnerOperation({...input(),plan});expect(op.restoration).toEqual(loss().scope);expect(op.destination).toBe(plan.account);
 expect(await prepareAgentHashOwnerOperation({...input(),plan,loss:loss()})).toEqual(op);expect(f.signs).toBe(2);
 expect(fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8')).toBe(original);
 await expect(prepareAgentHashOwnerOperation({...input(),plan,loss:{...loss(),transactionHash:h(99)}})).rejects.toThrow('loss_changed');
});
test('requires the current independent recovery authority and an unused deployed replacement',async()=>{
 const plan=await prepareAgentHashReplacement(input());
 await expect(prepareAgentHashOwnerOperation({...input(),plan})).rejects.toThrow('destination_changed');f.deployed=true;f.occupied=true;
 await expect(prepareAgentHashOwnerOperation({...input(),plan})).rejects.toThrow('destination_changed');f.occupied=false;
 const root=f.signingRoot;f.signingRoot=h(99);await expect(prepareAgentHashOwnerOperation({...input(),plan})).rejects.toThrow('authority_changed');f.signingRoot=root;
 await expect(prepareAgentHashOwnerOperation({...input(),plan:{...plan,initialRoot:h(99)}})).rejects.toThrow('plan_changed');
 f.nonce++;await expect(prepareAgentHashOwnerOperation({...input(),plan})).rejects.toThrow('authority_changed');expect(f.signs).toBe(0);
});
test('refreshes only the protocol revision or kernel domain while preserving consequences and consumed operations',async()=>{
 const plan=await ready(),op=await prepareAgentHashOwnerOperation({...input(),plan});f.revision=2;
 const refreshed=await prepareAgentHashOwnerOperation({...input(),plan});expect(refreshed).toEqual({...op,revision:'2'});expect(f.signs).toBe(1);
 f.kernel=9;const migrated=await prepareAgentHashOwnerOperation({...input(),plan});expect(migrated).toEqual({...refreshed,kernel:a(9)});expect(f.signs).toBe(2);
 Object.assign(f,{nonce:2,commitment:migrated.proof.nextCommitment,signingRoot:migrated.proof.nextSigningRoot});
 // The destination check must reject an otherwise matching consumed operation.
 await expect(prepareAgentHashOwnerOperation({...input(),plan})).rejects.toThrow('authority_changed');
 f.ownerDestination=plan.account;f.kernel=10;expect(await prepareAgentHashOwnerOperation({...input(),plan})).toEqual(migrated);expect(f.signs).toBe(2);
});
test('confirms only an independently verified exact retained operation and transaction',async()=>{
 const plan=await ready();await prepareAgentHashOwnerOperation({...input(),plan});f.badReceipt=true;
 await expect(confirmAgentHashOwnerOperation({...input(),plan,transactionHash:h(50)})).rejects.toThrow('receipt mismatch');
 expect(await withAgentHashRecoveryRecord({...input(),...plan},async r=>r.replacement?.authorizationTxHash)).toBeUndefined();f.badReceipt=false;
 await confirmAgentHashOwnerOperation({...input(),plan,transactionHash:h(50)});expect(f.receiptCalls).toBe(2);
 await expect(confirmAgentHashOwnerOperation({...input(),plan,transactionHash:h(51)})).rejects.toThrow('receipt_changed');
});
test('signature reservation persistence failure never publishes an owner proof',async()=>{
 const plan=await ready();f.losePersist=true;
 await expect(prepareAgentHashOwnerOperation({...input(),plan})).rejects.toThrow('persist failed');expect(f.signs).toBe(0);
 expect(await withAgentHashRecoveryRecord({...input(),...plan},async r=>r.replacement?.operation)).toBeUndefined();
 expect((await prepareAgentHashOwnerOperation({...input(),plan})).destination).toBe(plan.account);
});

test(' rejected loss addition cannot poison retained ordinary intent',async()=>{
 const plan=await ready();f.failSign=true;
 await expect(prepareAgentHashOwnerOperation({...input(),plan})).rejects.toThrow('signature interrupted');
 await expect(prepareAgentHashOwnerOperation({...input(),plan,loss:loss()})).rejects.toThrow();
 const resumed=await prepareAgentHashOwnerOperation({...input(),plan});expect(resumed.restoration).toBeUndefined();
});

test('credential recovery retains exact credentials through lost replies and partial install, keeping the original EOA',async()=>{
 const original=fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8'),plan=await ready();
 await prepareAgentHashOwnerOperation({...input(),plan});await confirmAgentHashOwnerOperation({...input(),plan,transactionHash:h(50)});
 const bodies:Record<string,unknown>[]=[];let lost=true;
 const transport={request:async(route:string,body?:unknown)=>{expect(route).toBe('recover-agent');bodies.push(body as Record<string,unknown>);if(lost){lost=false;throw Error('lost reply');}return{walletId:'wallet_aw_replacement',destination:plan.account,generation:2};}};
 await expect(recoverAgentHashCredentials({...input(),plan,transport})).rejects.toThrow('lost reply');expect(readActiveHashWallet(directory)?.address).toBe(destination);
 f.loseCredentials=true;await expect(recoverAgentHashCredentials({...input(),plan,transport})).rejects.toThrow('credential install interrupted');
 const result=await recoverAgentHashCredentials({...input(),plan,transport});expect(result).toEqual({walletId:'wallet_aw_replacement',destination:plan.account,generation:2});expect(bodies).toHaveLength(2);
 expect(bodies[0].apiSecret).toBe(bodies[1].apiSecret);expect(bodies[0].requestId).toBe(bodies[1].requestId);expect(bodies[0].destinationKind).toBe('hash');expect(bodies[0]).not.toHaveProperty('breakDestinationRoot');
 expect(readActiveHashWallet(directory)?.address).toBe(plan.account);expect(fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8')).toBe(original);
 expect(JSON.parse(fs.readFileSync(path.join(directory,'agent-credentials.json'),'utf8')).api_secret).toBe(bodies[0].apiSecret);
});
test('credential cut refuses stolen replacement roots, bad receipts, mismatched responses and post-response root changes',async()=>{
 const plan=await ready();await prepareAgentHashOwnerOperation({...input(),plan});await confirmAgentHashOwnerOperation({...input(),plan,transactionHash:h(50)});
 const request=vi.fn(async()=>({walletId:'wallet_aw_replacement',destination:plan.account,generation:2})),transport={request};
 f.badReceipt=true;await expect(recoverAgentHashCredentials({...input(),plan,transport})).rejects.toThrow('receipt mismatch');f.badReceipt=false;
 f.accountRoot=h(99);await expect(recoverAgentHashCredentials({...input(),plan,transport})).rejects.toThrow('spending_changed');expect(request).not.toHaveBeenCalled();f.accountRoot=plan.initialRoot;
 request.mockResolvedValueOnce({walletId:'wrong wallet',destination:plan.account,generation:2});await expect(recoverAgentHashCredentials({...input(),plan,transport})).rejects.toThrow('reply_invalid');
 request.mockImplementationOnce(async()=>{f.accountRoot=h(99);return{walletId:'wallet_aw_replacement',destination:plan.account,generation:2};});
 await expect(recoverAgentHashCredentials({...input(),plan,transport})).rejects.toThrow('spending_changed');
 expect(readActiveHashWallet(directory)?.address).toBe(destination);expect(fs.existsSync(path.join(directory,'agent-credentials.json'))).toBe(false);
});

test('initial restoration completion requires the authenticated credential cut and exact activation locator',async()=>{
 const initial=sha256(concat([new Uint8Array(32).fill(1),sha256(new Uint8Array(32).fill(2))]));
 const lookup={...input(),context,commitment:f.commitment,destination};expect(await agentInitialBreakNeedsInstall(lookup)).toBe(true);
 await withAgentHashRecoveryRecord({...input(),context,commitment:initial},async(record,persist)=>{record.credentials={requestId:h(70),apiKey:'saved',apiSecret:'saved',generation:1};persist();});
 expect(await agentInitialBreakNeedsInstall(lookup)).toBe(false);
 const index=path.join(directory,'active-hash-wallet.json'),active=JSON.parse(fs.readFileSync(index,'utf8'));fs.writeFileSync(index,JSON.stringify({...active,transactionHash:h(99)}),{mode:0o600});
 expect(await agentInitialBreakNeedsInstall(lookup)).toBe(true);
});

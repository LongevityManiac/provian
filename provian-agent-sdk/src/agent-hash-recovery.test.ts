import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { concat, hexlify, sha256 } from 'ethers';
import { encryptKeystore, saveKeystore } from './keystore';
import { generateAgentKeyPair } from './wallet';
import { provisionBreakRecovery, prepareAgentBreakRecovery, completeAgentBreakRecovery, withAgentRecoveryMaterial, withAgentHashRecoveryRecord } from './break-recovery-store';
import { prepareAgentHashReplacement } from './agent-hash-replacement';
import { recoverHashRecourseAgent } from './agent-hash-recovery';
import { recoveryOperationId, ownerOperationIntent, type RecoveryOwnerOperation } from './recourse-owner-operation';
import { accountDeploymentDigest, type AccountDeploymentRequest } from './break-deployment-data';
import { listAgentHashReplacements } from './break-recovery-store';
import { recoverAgentHashCredentials } from './agent-hash-credentials';
import { readActiveHashWallet } from './break-recovery-store';
import { prepareAgentHashOwnerOperation, confirmAgentHashOwnerOperation } from './agent-hash-owner-operation';
import type { OwnerChainNetwork } from './recourse-owner-chain';
const http=vi.hoisted(()=>({request:vi.fn(),ticket:vi.fn(),status:vi.fn()}));
vi.mock('./guarded-fetch',()=>({guardedFetcher:()=>http.request}));
vi.mock('./private-access',()=>({privateRecourseEnvelope:async(_i:unknown,_s:unknown,_seed:unknown,_route:unknown,body:unknown)=>({request:body})}));
vi.mock('./recourse-restoration-ticket',()=>({verifyContinuedRestoration:(...args:unknown[])=>http.ticket(...args),readContinuedRestorationStatus:(...args:unknown[])=>http.status(...args),hasContinuedRestoration:async(_identity:string,_dest:string,scope:{request:string})=>ownerOperations.some(op=>op.restoration?.request===scope.request)}));
vi.mock('./recourse-owner-operation',async actual=>{const mod=await actual<typeof import('./recourse-owner-operation')>();return{...mod,recoveryOperationId:mod.ownerOperationIntent};});
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
const passphrase='test only encrypted replacement',network={deployment:async()=>({manifestHash:h(10),revision:BigInt(f.revision),addresses:{kernel:a(f.kernel)}})} as OwnerChainNetwork;
const input=()=>({directory,passphrase,network,identity,relayUrl:'https://relay.example'});
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
let ownerOperations:RecoveryOwnerOperation[],cuts:Record<string,unknown>[],submissions:Record<string,unknown>[],loseQueue:boolean,loseCut:boolean,stealCut:boolean,failSubmission:boolean;
beforeEach(async()=>{
 const initial=sha256(concat([new Uint8Array(32).fill(1),sha256(new Uint8Array(32).fill(2))]));
 await withAgentHashRecoveryRecord({...input(),commitment:initial,context},async(record,persist)=>{record.credentials={requestId:h(70),apiKey:`pvn_live_${'aa'.repeat(16)}`,apiSecret:`pvns_${'bb'.repeat(32)}`,generation:1};persist();});
 ownerOperations=[];cuts=[];submissions=[];loseQueue=false;loseCut=false;stealCut=false;failSubmission=false;http.status.mockReset();http.status.mockImplementation(async(_identity:string,_dest:string,scope:{request:string})=>ownerOperations.some(op=>op.restoration?.request===scope.request)?'pending':'absent');http.ticket.mockReset();http.ticket.mockResolvedValue(undefined);
 http.request.mockImplementation(async(url:string,options:RequestInit)=>{
  const route=url.split('/v1/recourse/')[1],body=JSON.parse(String(options.body));let result:unknown;
  if(route==='break-deployments'){const proof=body.request as AccountDeploymentRequest;f.deployed=true;result={id:accountDeploymentDigest(proof),status:'confirmed',transactionHash:h(40)};}
  else if(route==='owner-operations/recovery'){
   const op=body.request as RecoveryOwnerOperation,id=recoveryOperationId(op);const prior=ownerOperations.find(row=>row.kernel&&recoveryOperationId(row)===id);
   if(!prior){ownerOperations.push(op);f.nonce=op.nonce+1;f.commitment=op.proof.nextCommitment;f.signingRoot=op.proof.nextSigningRoot;f.ownerDestination=op.destination;f.accountRoot=f.rootReads.at(-1)!;}
   if(loseQueue){loseQueue=false;throw Error('owner queue response lost');}result={id,status:'confirmed',transactionHash:h(50+op.nonce)};
  }else if(route==='recover-agent'){
   cuts.push(body);if(loseCut){loseCut=false;throw Error('cut response lost');}if(stealCut){stealCut=false;f.accountRoot=h(99);}
   result={walletId:'wallet_aw_replacement',destination:body.destination,generation:body.authorizationNonce+1};
  }else if(route==='restoration-intents')result={kernel:a(f.kernel),...(body.transactionHash===h(60)?{request:h(61),lossHash:h(62),maximumLoss:'200'}:loss().scope)};
  else if(route==='restoration-requests'){submissions.push(body);if(failSubmission)throw Error('restoration response lost');result={requestId:body.transactionHash===h(60)?h(61):loss().scope.request,status:'awaiting_determination'};}
  else throw Error('unexpected route '+route);
  return{ok:true,json:async()=>result};
 });
});
const restoration=()=>({transactionHash:loss().transactionHash,block:loss().block,apiKey:'old-key',apiSecret:'old-secret'});
test('full post-break recovery resumes lost owner and credential replies without a second owner authorization',async()=>{
 const original=fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8');loseQueue=true;
 await expect(recoverHashRecourseAgent(input())).rejects.toThrow('owner queue response lost');expect(ownerOperations).toHaveLength(1);
 loseCut=true;await expect(recoverHashRecourseAgent(input())).rejects.toThrow('cut response lost');expect(ownerOperations).toHaveLength(1);
 const result=await recoverHashRecourseAgent(input());expect(ownerOperations).toHaveLength(1);expect(result.destination).toBe(ownerOperations[0].destination);
 expect(cuts[0].requestId).toBe(cuts[1].requestId);expect(readActiveHashWallet(directory)?.address).toBe(result.destination);
 expect(fs.readFileSync(path.join(directory,'agent-keystore.json'),'utf8')).toBe(original);
 const refreshed=JSON.stringify({wallet_id:'wallet_aw_replacement',address:result.destination,api_key:'refreshed-key',api_secret:'refreshed-secret'});fs.writeFileSync(path.join(directory,'agent-credentials.json'),refreshed,{mode:0o600});
 expect(await recoverHashRecourseAgent(input())).toEqual(result);expect(fs.readFileSync(path.join(directory,'agent-credentials.json'),'utf8')).toBe(refreshed);expect(cuts).toHaveLength(2);expect(ownerOperations).toHaveLength(1);
});
test('the bounded loss survives a stolen replacement using kind2 continuation, then retries final submission with recovered credentials',async()=>{
 stealCut=true;failSubmission=true;
 await expect(recoverHashRecourseAgent({...input(),restoration:restoration()})).rejects.toThrow('restoration response lost');
 expect(ownerOperations).toHaveLength(2);expect(ownerOperations[0].restoration).toEqual(loss().scope);expect(ownerOperations[1].restoration).toBeUndefined();
 expect(ownerOperations[0].destination).not.toBe(ownerOperations[1].destination);expect(submissions[0].transactionHash).toBe(loss().transactionHash);
 expect(submissions[0].recoveryRequestId).toBe(cuts[1].requestId);expect(submissions[0].recoveryRequestId).not.toBe(loss().scope.request);
 failSubmission=false;const result=await recoverHashRecourseAgent({...input(),restoration:restoration()});expect(result.restorationRequestId).toBe(loss().scope.request);
 expect(ownerOperations).toHaveLength(2);expect(cuts).toHaveLength(2);expect(submissions[1]).toEqual(submissions[0]);
 const call=http.request.mock.calls.filter(([url])=>String(url).endsWith('/restoration-requests')).at(-1)!;
 expect((call[1] as RequestInit).headers).toMatchObject({Authorization:`Bearer ${cuts[1].apiKey}:${cuts[1].apiSecret}`});
});
test('fresh replacement record created before a crash inherits the prior bounded ticket before signing',async()=>{
 failSubmission=true;await expect(recoverHashRecourseAgent({...input(),restoration:restoration()})).rejects.toThrow('restoration response lost');
 const next=await prepareAgentHashReplacement(input());expect((await listAgentHashReplacements({...input(),context})).find(row=>row.plan.account===next.account)?.state.continuedLosses).toBeUndefined();
 failSubmission=false;const result=await recoverHashRecourseAgent({...input(),restoration:restoration()});
 expect(ownerOperations).toHaveLength(2);expect(ownerOperations[1].restoration).toBeUndefined();expect(result.restorationRequestId).toBe(loss().scope.request);
});
test('new recovery cannot retire credentials before the preceding restoration submission finishes',async()=>{
 failSubmission=true;await expect(recoverHashRecourseAgent({...input(),restoration:restoration()})).rejects.toThrow('restoration response lost');
 await expect(recoverHashRecourseAgent({...input(),newRecovery:true})).rejects.toThrow('restoration response lost');expect(ownerOperations).toHaveLength(1);
 failSubmission=false;await recoverHashRecourseAgent({...input(),newRecovery:true});expect(ownerOperations).toHaveLength(2);expect(ownerOperations[1].restoration).toBeUndefined();
});

test('a carried loss returns its own request id even when the latest recovery has a different new loss',async()=>{
 await recoverHashRecourseAgent({...input(),restoration:restoration()});
 const second=await recoverHashRecourseAgent({...input(),restoration:{...restoration(),transactionHash:h(60),block:200}});expect(second.restorationRequestId).toBe(h(61));
 const first=await recoverHashRecourseAgent({...input(),restoration:restoration()});expect(first.restorationRequestId).toBe(loss().scope.request);expect(ownerOperations).toHaveLength(2);
 expect((await recoverHashRecourseAgent(input())).restorationRequestId).toBeUndefined();
});
test('a denied stale credential retries preparation only with an authenticated current local account record',async()=>{
 const normal=http.request.getMockImplementation()!;let denied=false;
 http.request.mockImplementation(async(url:string,options:RequestInit)=>{if(url.endsWith('/restoration-intents')){
  const headers=options.headers as Record<string,string>;if(headers.Authorization==='Bearer old-key:old-secret'){denied=true;return{ok:false,status:401};}
  expect(headers.Authorization).toBe(`Bearer pvn_live_${'aa'.repeat(16)}:pvns_${'bb'.repeat(32)}`);
 }return normal(url,options);});
 const result=await recoverHashRecourseAgent({...input(),restoration:restoration()});expect(denied).toBe(true);expect(result.restorationRequestId).toBe(loss().scope.request);
});


test('an unverified carried ticket prevents signing a continuation after a stolen replacement',async()=>{
 stealCut=true;http.status.mockRejectedValueOnce(Error('ticket ceiling changed'));
 await expect(recoverHashRecourseAgent({...input(),restoration:restoration()})).rejects.toThrow('ticket ceiling changed');expect(ownerOperations).toHaveLength(1);
});
test('a wrong final restoration response remains pending and retry uses the original request',async()=>{
 const normal=http.request.getMockImplementation()!;let wrong=true;
 http.request.mockImplementation(async(url:string,options:RequestInit)=>{if(url.endsWith('/restoration-requests')&&wrong)return{ok:true,json:async()=>({requestId:h(99),status:'awaiting_determination'})};return normal(url,options);});
 await expect(recoverHashRecourseAgent({...input(),restoration:restoration()})).rejects.toThrow('loss_reply_invalid');wrong=false;
 const result=await recoverHashRecourseAgent({...input(),restoration:restoration()});expect(result.restorationRequestId).toBe(loss().scope.request);expect(ownerOperations).toHaveLength(1);
});

test('pending submission uses refreshed current bound credentials but keeps the original recovery request id',async()=>{
 failSubmission=true;await expect(recoverHashRecourseAgent({...input(),restoration:restoration()})).rejects.toThrow('restoration response lost');
 const refreshed={wallet_id:'wallet_aw_replacement',address:ownerOperations[0].destination,api_key:`pvn_live_${'ab'.repeat(16)}`,api_secret:`pvns_${'cd'.repeat(32)}`};
 fs.writeFileSync(path.join(directory,'agent-credentials.json'),JSON.stringify(refreshed),{mode:0o600});failSubmission=false;
 await recoverHashRecourseAgent({...input(),restoration:restoration()});
 const options=http.request.mock.calls.filter(([url])=>String(url).endsWith('/restoration-requests')).at(-1)![1] as RequestInit;
 expect(options.headers).toMatchObject({Authorization:`Bearer ${refreshed.api_key}:${refreshed.api_secret}`});expect(JSON.parse(String(options.body)).recoveryRequestId).toBe(cuts[0].requestId);expect(cuts).toHaveLength(1);
});
test('a different wallet credential file cannot be used for a retained restoration request',async()=>{
 failSubmission=true;await expect(recoverHashRecourseAgent({...input(),restoration:restoration()})).rejects.toThrow('restoration response lost');
 const file=path.join(directory,'agent-credentials.json'),credentials=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,JSON.stringify({...credentials,wallet_id:'wallet_aw_another'}),{mode:0o600});
 failSubmission=false;const count=submissions.length;await expect(recoverHashRecourseAgent({...input(),restoration:restoration()})).rejects.toThrow('credentials_binding_changed');expect(submissions).toHaveLength(count);
});

test('a surviving bounded ticket from an earlier break origin is carried without signing it again',async()=>{
 const earlierContext=a(77),earlierCommitment=h(77);
 await withAgentHashRecoveryRecord({...input(),context:earlierContext,commitment:earlierCommitment,create:true},async(record,persist)=>{record.replacement={nonce:1,sourceAddress:a(78),loss:loss()};persist();});
 // A prior-origin authorization is included in the mocked current executor's surviving ticket set.
 ownerOperations.push({restoration:loss().scope} as RecoveryOwnerOperation);
 const result=await recoverHashRecourseAgent({...input(),restoration:restoration()});
 expect(ownerOperations).toHaveLength(2);expect(ownerOperations[1].restoration).toBeUndefined();expect(result.restorationRequestId).toBe(loss().scope.request);
});
test('historical evidence absent from the surviving current ticket set is not carried',async()=>{
 await withAgentHashRecoveryRecord({...input(),context:a(77),commitment:h(77),create:true},async(record,persist)=>{record.replacement={nonce:1,sourceAddress:a(78),loss:loss()};persist();});
 await recoverHashRecourseAgent(input());expect(ownerOperations).toHaveLength(1);expect(ownerOperations[0].restoration).toBeUndefined();expect(submissions).toHaveLength(0);
});

test('an executed retained ticket remains identified without resubmission or a second bounded authorization',async()=>{
 await recoverHashRecourseAgent({...input(),restoration:restoration()});const submitted=submissions.length;http.status.mockResolvedValue('executed');
 await recoverHashRecourseAgent({...input(),newRecovery:true});expect(ownerOperations).toHaveLength(2);expect(ownerOperations[1].restoration).toBeUndefined();expect(submissions).toHaveLength(submitted);
 const result=await recoverHashRecourseAgent({...input(),restoration:restoration()});expect(result.restorationRequestId).toBe(loss().scope.request);expect(ownerOperations).toHaveLength(2);expect(submissions).toHaveLength(submitted);
});

test('a provisional terminal outcome is revalidated after reorg rather than durably suppressing submission',async()=>{
 await recoverHashRecourseAgent({...input(),restoration:restoration()});const count=submissions.length;http.status.mockResolvedValue('executed');
 await recoverHashRecourseAgent({...input(),newRecovery:true});expect(submissions).toHaveLength(count);
 const rows=await listAgentHashReplacements({...input(),context}),latest=rows.find(row=>row.plan.account===ownerOperations[1].destination)!;
 expect(latest.state.continuedLosses?.[0].submitted).not.toBe(true);
 http.status.mockResolvedValue('pending');await recoverHashRecourseAgent({...input(),restoration:restoration()});
 expect(submissions).toHaveLength(count+1);expect(submissions.at(-1)?.recoveryRequestId).toBe(cuts[1].requestId);expect(ownerOperations).toHaveLength(2);
});

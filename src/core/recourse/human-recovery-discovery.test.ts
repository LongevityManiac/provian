vi.mock('./restoration-ticket',()=>({readContinuedRestorationStatus:async()=>{if(f.badTicket)throw Error('ticket_changed');return f.ticketStatus;}}));
import { beforeEach, expect, test, vi } from 'vitest';
import { concat, hexlify, sha256, toUtf8Bytes } from 'ethers';
import { humanBreakKey } from './human-secret';
import type { OwnerChainNetwork } from './owner-chain';
import { discoverPendingHumanRecovery, discoverHumanRestorationHistory } from './human-recovery-discovery';
const f=vi.hoisted(()=>({ticketStatus: 'pending' as 'pending'|'executed'|'absent',continuation:false,badTicket:false,restoration:false,badEvidence:false,relayCurrent:false,nonce:3,badReceipt:false,wrongDestination:false,wrongProof:false,duplicate:false,
 requests:[] as string[],receipts:[] as string[],missing:false}));
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const phrase='test test test test test test test test test test test junk',base={identity:h(1),breakOrigin:a(2),chainId:'8453'};
const key=(p:'recovery-secret'|'recovery-signing',n:number)=>humanBreakKey(phrase,base,p,String(n));
const root=(n:number)=>sha256(sha256(key('recovery-signing',n)));
const commitment=(n:number)=>sha256(concat([key('recovery-secret',n),root(n)]));
function evidence(){return JSON.stringify({snapshot:{identity:h(1),occurrence:h(55),transactionHash:h(56),block:123,lossAtomic:'20'},membership:{active:true}});}
function operation(){const nonce=f.nonce-1;return {kernel:a(4),revision:'2',identity:h(1),destination:a(3),nonce,...(f.restoration?{restoration:{request:h(55),lossHash:sha256(toUtf8Bytes(evidence())),maximumLoss:'20'}}:{}),
 proof:{recoverySecret:hexlify(key('recovery-secret',nonce)),publicKey:sha256(key('recovery-signing',nonce)),signingRoot:root(nonce),
 nextSigningRoot:root(f.nonce),nextCommitment:f.wrongProof?h(99):commitment(f.nonce),signature:`0x${'11'.repeat(7856)}`}};}
vi.mock('./human-break-history',()=>({discoverHumanIdentityHistory:async()=>({identity:h(1),points:[{breakOrigin:a(2)}]}),discoverHistoricalCurveGeneration:async()=>4}));
vi.mock('./owner-chain',()=>({readOwnerChainState:async()=>({nonce:f.nonce,commitment:commitment(f.nonce),signingRoot:root(f.nonce),
 destination:f.wrongDestination?a(99):a(3),deployment:{manifestHash:h(7)}}),verifyOwnerOperationReceipt:async(_op:unknown,tx:string)=>{
 f.receipts.push(tx);if(f.badReceipt)throw Error('receipt_unverified');}}));
vi.mock('./human-private-recovery',()=>({requestHumanRecoveryData:async(_m:string,_i:string,g:number,path:string)=>{
 expect(g).toBe(4);f.requests.push(path);if(path.startsWith('restoration-history/'))return {identity:h(1),candidates:[{scope:{request:h(55),lossHash:sha256(toUtf8Bytes(evidence())),maximumLoss:'20'},evidence:f.badEvidence?evidence()+' ':evidence()}]};const candidate={operation:operation(),transactionHash:h(8),...(f.relayCurrent?{completedRequestId:h(88)}:{}),...(f.restoration?{restorationEvidence:f.badEvidence?evidence().replace('123','124'):evidence()}: {}),
 ...(f.continuation?{continuations:[{scope:{request:h(55),lossHash:sha256(toUtf8Bytes(evidence())),maximumLoss:'20'},evidence:evidence()}]}:{})};
 return{identity:h(1),nonce:f.nonce-1,relayCommitment:f.relayCurrent?commitment(f.nonce):h(9),
 candidates:f.missing?[]:f.duplicate?[candidate,candidate]:[candidate]};}}));
vi.mock('./hash-authorization',()=>({recoverySigningRoot:async(seed:Uint8Array)=>sha256(sha256(seed)),recoveryCommitment:(secret:Uint8Array,r:string)=>sha256(concat([secret,r]))}));
vi.mock('./hash-account-deployment',()=>({discoverHashAccount:async(initialRoot:string)=>{
 const expected=sha256(sha256(humanBreakKey(phrase,{...base,accountGeneration:String(f.nonce)},'spending','0')));
 expect(initialRoot).toBe(expected);return{account:a(3),deployed:true,manifestHash:h(7)};
}}));
vi.mock('./human-account',()=>({deriveHumanAccount:vi.fn()}));
beforeEach(()=>Object.assign(f,{ticketStatus:'pending',continuation:false,badTicket:false,restoration:false,badEvidence:false,relayCurrent:false,nonce:3,badReceipt:false,wrongDestination:false,wrongProof:false,duplicate:false,requests:[],receipts:[],missing:false}));
test('a new backup authenticates a later hash destination and exact completed owner receipt without the old spending key',async()=>{
 const result=await discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork);
 expect(result).toMatchObject({identity:h(1),transactionHash:h(8),legacyGeneration:4,replacement:{nonce:2,accountGeneration:'3',account:a(3),breakOrigin:a(2)}});
 expect(f.receipts).toEqual([h(8)]);expect(f.requests).toEqual([`owner-recovery-state/${h(1)}/2`]);
 f.relayCurrent=true;f.receipts=[];expect(await discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).toMatchObject({completedRequestId:h(88)});expect(f.receipts).toEqual([h(8)]);
});
test('relay candidates cannot choose a destination, key transition, unverified receipt or ambiguous authorization',async()=>{
 f.wrongDestination=true;await expect(discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).rejects.toThrow('destination_mismatch');
 f.wrongDestination=false;f.wrongProof=true;await expect(discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).rejects.toThrow('pending_recovery_unavailable');expect(f.receipts).toEqual([]);
 f.wrongProof=false;f.badReceipt=true;await expect(discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).rejects.toThrow('receipt_unverified');
 f.badReceipt=false;f.duplicate=true;await expect(discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).rejects.toThrow('ambiguous');
 f.duplicate=false;f.missing=true;await expect(discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).rejects.toThrow('pending_recovery_unavailable');
});
test('initial break restoration stays on its entitlement path rather than creating another owner operation',async()=>{
 for(const nonce of [0,1]){f.nonce=nonce;expect(await discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).toBeNull();}
 expect(f.requests).toEqual([]);expect(f.receipts).toEqual([]);
});

test('a recovered bounded restoration retains the original loss occurrence authenticated by its on-chain intent',async()=>{
 f.restoration=true;
 expect(await discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).toMatchObject({lossTransaction:h(56),lossBlock:123,operation:{restoration:{request:h(55)}}});
 f.badEvidence=true;await expect(discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).rejects.toThrow('loss_changed');
});

test('latest kind2 discovery carries older bounded loss metadata only with an independently verified current ticket',async()=>{
 f.continuation=true;
 const result=await discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork);
 expect(result?.operation).not.toHaveProperty('restoration');
 expect(result?.continuedLosses).toEqual([{restoration:{request:h(55),lossHash:sha256(toUtf8Bytes(evidence())),maximumLoss:'20'},transactionHash:h(56),block:123}]);
 f.badTicket=true;await expect(discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).rejects.toThrow('ticket_changed');
});

test('a completed relay cut still returns verified prior losses and its existing request ID',async()=>{
 f.relayCurrent=true;f.continuation=true;
 const result=await discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork);
 expect(result?.completedRequestId).toBe(h(88));expect(result?.continuedLosses?.[0].transactionHash).toBe(h(56));
 f.badTicket=true;await expect(discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).rejects.toThrow('ticket_changed');
});

test('imported terminal history stays discoverable without an old intent and absence never creates authorization',async()=>{
 f.continuation=true;f.ticketStatus='executed';
 expect((await discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork))?.continuedLosses).toHaveLength(1);
 f.ticketStatus='absent';await expect(discoverPendingHumanRecovery(phrase,{}as OwnerChainNetwork)).rejects.toThrow('ticket_changed');
});
test('private all-generation history works at the initial break nonce and independently filters absent candidates',async()=>{
 f.nonce=1;
 for(const status of ['pending','executed'] as const){f.ticketStatus=status;
  expect(await discoverHumanRestorationHistory(phrase,h(1),4,{}as OwnerChainNetwork)).toHaveLength(1);}
 f.ticketStatus='absent';expect(await discoverHumanRestorationHistory(phrase,h(1),4,{}as OwnerChainNetwork)).toEqual([]);
 f.badEvidence=true;await expect(discoverHumanRestorationHistory(phrase,h(1),4,{}as OwnerChainNetwork)).rejects.toThrow('loss_changed');
});

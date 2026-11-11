import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Transaction, Wallet, sha256 } from 'ethers';
import { sendChainOperation } from './chain-nonce';
import { readHashDeliveryJournal } from './hash-delivery-journal';
import { fileNonceStore } from './nonce-file-store';
import { hashAccountCall, type SignedHashAccountOperation } from './hash-account';
import { hashDeliveryId } from './hash-account-delivery';
import { deliverActiveHashWalletOperation, reconcileActiveHashWalletOperation } from './active-hash-delivery';
import type { OwnerChainNetwork } from './recourse-owner-chain';
import type { NonceJournalStore } from './canonical-nonce';
const f=vi.hoisted(()=>({operation:null as SignedHashAccountOperation|null,cancellation:null as SignedHashAccountOperation|null,
 completed:null as {transactionHash:string;outcome:'succeeded'|'cancelled'}|null,sendCount:0,signedCount:0,lostResponse:false,mined:false,
 txHash:'',raw:'',retired:false,ownerChanged:false,rootChanged:false,loseStatus:false,rotations:0,secret:''}));
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,wallet=new Wallet(h(7));
const operation:SignedHashAccountOperation={chainId:'8453',account:a(1),nonce:'0',target:a(2),value:'0',callGas:'100000',data:'0x',nextCommitment:h(3),publicKey:h(4),signingRoot:sha256(h(4)),signature:`0x${'55'.repeat(7856)}`};
vi.mock('./keystore',()=>({loadKeystore:()=>({}),withDecryptedKey:async(_k:unknown,_p:string,fn:(key:{address:string;privateKey:string})=>Promise<unknown>)=>{
 const key={address:wallet.address,privateKey:wallet.privateKey};try{return await fn(key);}finally{key.privateKey='';f.secret=key.privateKey;}
}}));
vi.mock('./break-recovery-store',()=>({readActiveHashWalletDelivery:async()=>({active:{identity:h(9),address:a(1),context:a(10)},operation:f.operation,cancellation:f.cancellation,completed:f.completed}),
 completeActiveHashWalletOperation:async({transactionHash}:{transactionHash:string})=>{if(!f.completed){f.rotations++;f.completed={transactionHash,outcome:'succeeded'};}return f.completed.outcome;}
}));
vi.mock('./recourse-owner-chain',()=>({readOwnerChainState:async()=>({destination:f.ownerChanged?a(99):a(1),deployment:{manifestHash:h(11)}})}));
vi.mock('./hash-account-chain',()=>({readHashAccountState:async()=>({root:f.rootChanged?h(99):operation.signingRoot,nonce:'0',manifestHash:h(11)})}));
vi.mock('./protocol-transaction',()=>({assertCurrentProtocolTransaction:async()=>{if(f.retired)throw Error('retired');return {manifestHash:h(11)};}}));
vi.mock('./hash-delivery-journal',async actual=>{
 const mod=await actual<typeof import('./hash-delivery-journal')>();return {...mod,writeHashDeliveryJournal:(file:string,passphrase:string,id:string,sender:string,value:import('./hash-account-delivery').HashDeliveryRecord)=>{
  if(f.loseStatus&&value.complete){f.loseStatus=false;throw Error('lost completion status');}return mod.writeHashDeliveryJournal(file,passphrase,id,sender,value);
 }};
});
vi.mock('./evm-signer',()=>({sendTransaction:async(w:{address:string;privateKeyHex:string},p:{operationId:string;nonceJournalStore:NonceJournalStore;to:string;value:string;data:string;allowUnlistedTarget:boolean})=>{
 expect(w.address).toBe(wallet.address.toLowerCase());expect(p.value).toBe('0');expect(p.to).toBe(a(1));expect(p.allowUnlistedTarget).toBe(true);
 const attempt=await sendChainOperation({store:p.nonceJournalStore,now:Date.now,uuid:()=>String(Math.random()),nonce:async()=>f.mined?f.signedCount:0,
 resolveConsumption:async()=> f.mined?'own':'unknown',included:async()=>f.mined,assertApproved:()=>{},validate:saved=>{expect(Transaction.from(saved.raw).from?.toLowerCase()).toBe(w.address);},
 broadcast:async saved=>{f.sendCount++;f.txHash=saved.hash;f.raw=saved.raw;}
 },`8453_${w.address}`,p.operationId,`${p.to}:${p.value}:${p.data}`,async nonce=>{
  f.signedCount++;const raw=await wallet.signTransaction({to:p.to,value:0,data:p.data,chainId:8453,gasLimit:1000000,gasPrice:1,nonce});return{raw,hash:Transaction.from(raw).hash!,nonce};
 },{resume:true});if(f.lostResponse){f.lostResponse=false;throw Error('lost response');}return {hash:attempt.hash};
}}));
let directory:string;
const rpc={request:async(method:string,params:readonly unknown[]):Promise<unknown>=>{
 if(method==='eth_getTransactionReceipt')return f.mined?{transactionHash:params[0],blockNumber:'0x64',blockHash:h(100),status:'0x1'}:null;
 if(method==='eth_getTransactionByHash')return {hash:params[0],from:wallet.address.toLowerCase(),to:a(1),input:hashAccountCall(operation),value:'0x0',blockHash:h(100)};
 if(method==='eth_getBlockByNumber')return {number:'0x64',hash:h(100)};
 throw Error('unexpected rpc');
}};
const network={rpcs:[rpc,rpc],deployment:async()=>({manifestHash:h(11)})} as unknown as OwnerChainNetwork;
const input=()=>({directory,passphrase:'test only',network,operationId:hashDeliveryId(operation)});
beforeEach(()=>{directory=fs.mkdtempSync(path.join(os.tmpdir(),'provian-hash-delivery-'));Object.assign(f,{operation,cancellation:null,completed:null,sendCount:0,signedCount:0,lostResponse:false,mined:false,txHash:'',raw:'',retired:false,ownerChanged:false,rootChanged:false,loseStatus:false,rotations:0,secret:''});});
afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
test('lost broadcast response recovers exact durable gas bytes and receipt-only inspection never broadcasts',async()=>{
 f.lostResponse=true;await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow('lost response');expect(f.signedCount).toBe(1);expect(f.sendCount).toBe(1);
 expect((await reconcileActiveHashWalletOperation(input()))?.transactionHash).toBe(f.txHash);expect(f.sendCount).toBe(1);
 await deliverActiveHashWalletOperation(input());expect(f.signedCount).toBe(1);expect(f.sendCount).toBe(2);
 expect(f.secret).toBe('');const raw=fs.readFileSync(path.join(directory,'hash-deliveries',`${input().operationId.slice(2)}.json`),'utf8');expect(raw).not.toContain(wallet.privateKey);
 expect(fs.statSync(path.join(directory,'hash-deliveries',`${input().operationId.slice(2)}.json`)).mode&0o777).toBe(0o600);
});
test('key rotation preceding a failed delivery-status write returns the retained completion without another gas payment',async()=>{
 await deliverActiveHashWalletOperation(input());f.mined=true;f.loseStatus=true;
 await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow('lost completion status');expect(f.rotations).toBe(1);
 expect(await deliverActiveHashWalletOperation(input())).toMatchObject({status:'complete',outcome:'succeeded',transactionHash:f.txHash});expect(f.rotations).toBe(1);expect(f.sendCount).toBe(1);
});
test('retired targets, changed owner or spending root and a mismatched operation cannot spend gas',async()=>{
 f.retired=true;await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow('retired');f.retired=false;
 f.ownerChanged=true;await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow('state_changed');f.ownerChanged=false;
 f.rootChanged=true;await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow('state_changed');f.rootChanged=false;
 await expect(deliverActiveHashWalletOperation({...input(),operationId:h(99)})).rejects.toThrow('intent_changed');expect(f.sendCount).toBe(0);
});
test('unmined inspection never sends, and an already-mined operation reconciles after target retirement',async()=>{
 expect(await reconcileActiveHashWalletOperation(input())).toBeNull();expect(f.sendCount).toBe(0);
 await deliverActiveHashWalletOperation(input());f.retired=true;f.mined=true;
 expect(await reconcileActiveHashWalletOperation(input())).toMatchObject({status:'complete',outcome:'succeeded'});expect(f.sendCount).toBe(1);
});
test('corrupt or symlink delivery state is refused without replacing it or paying gas',async()=>{
 await deliverActiveHashWalletOperation(input());const file=path.join(directory,'hash-deliveries',`${input().operationId.slice(2)}.json`),target=path.join(directory,'target');
 fs.renameSync(file,target);fs.symlinkSync(target,file);await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow();expect(f.sendCount).toBe(1);
 fs.unlinkSync(file);fs.writeFileSync(file,'corrupt',{mode:0o600});await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow();expect(fs.readFileSync(file,'utf8')).toBe('corrupt');
});
test('a retained gas transaction with a changed call cannot be recovered',async()=>{
 f.lostResponse=true;await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow();
 const store=fileNonceStore(path.join(directory,'evm-nonces')),key=`8453_${wallet.address.toLowerCase()}`;
 const record=readHashDeliveryJournal(path.join(directory,'hash-deliveries',`${input().operationId.slice(2)}.json`),input().passphrase,input().operationId,wallet.address.toLowerCase())!;
 const id=record.attempts[0].id,raw=await wallet.signTransaction({to:a(8),data:hashAccountCall(operation),chainId:8453,nonce:0,gasLimit:1000000,gasPrice:1});
 await store.transact(`${key}_${id}`,current=>({...current!,attempts:[{...current!.attempts[0],raw,hash:Transaction.from(raw).hash!}]}));
 await expect(reconcileActiveHashWalletOperation(input())).rejects.toThrow('nonce_invalid');expect(f.sendCount).toBe(1);
});

test('edited plaintext completion and modified ciphertext cannot invent a completed payment',async()=>{
 await deliverActiveHashWalletOperation(input());const file=path.join(directory,'hash-deliveries',`${input().operationId.slice(2)}.json`);
 const encrypted=fs.readFileSync(file,'utf8'),record=readHashDeliveryJournal(file,input().passphrase,input().operationId,wallet.address.toLowerCase())!;
 fs.writeFileSync(file,JSON.stringify({...record,complete:{hash:f.txHash,outcome:'succeeded'}}));
 await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow('envelope_invalid');expect(f.completed).toBeNull();expect(f.rotations).toBe(0);
 const envelope=JSON.parse(encrypted);envelope.ciphertext=(envelope.ciphertext[0]==='a'?'b':'a')+envelope.ciphertext.slice(1);fs.writeFileSync(file,JSON.stringify(envelope));
 await expect(deliverActiveHashWalletOperation(input())).rejects.toThrow();expect(f.completed).toBeNull();expect(f.sendCount).toBe(1);
 fs.writeFileSync(file,encrypted);expect(()=>readHashDeliveryJournal(file,input().passphrase,h(98),wallet.address.toLowerCase())).toThrow();
 expect(()=>readHashDeliveryJournal(file,input().passphrase,input().operationId,a(99))).toThrow();
});

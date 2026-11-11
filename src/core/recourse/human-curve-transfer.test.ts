import { beforeEach, expect, test, vi } from 'vitest';
import { Wallet } from 'ethers';
import { executeHumanCurveTransfer, readHumanCurveTransfer } from './human-curve-transfer';
import type { HumanHashTransferIntent } from './human-hash-transfer';
import type { BiometricAction } from '../security/biometricAction';
const f=vi.hoisted(()=>({store:new Map<string,string>(),approved:true,account:'',kind:'curve',retired:false,seed:new Uint8Array(32),
 sent:[] as string[],signed:new Map<string,{raw:string;hash:string;nonce:number}>(),loseResponse:false,failWrite:'',mined:false,finalized:true,reverted:false,reorg:false,badTx:false,disagree:false,raceReorg:false,rpcReads:0}));
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const wallet=new Wallet(h(7)),action={} as BiometricAction;
const intent:HumanHashTransferIntent={id:h(1),account:wallet.address.toLowerCase(),auxiliaryBinding:h(2),target:a(3),value:'100',data:'0x'};
vi.mock('expo-secure-store',()=>({WHEN_UNLOCKED_THIS_DEVICE_ONLY:'device',getItemAsync:async(k:string)=>f.store.get(k)??null,
 setItemAsync:async(k:string,v:string)=>{const r=JSON.parse(v);if((f.failWrite==='pending'&&r.result?.status==='pending')||(f.failWrite==='complete'&&r.result?.status==='complete')||(f.failWrite==='initial'&&!r.result)){f.failWrite='';throw Error('lost write');}f.store.set(k,v);}}));
vi.mock('../security/biometricAction',()=>({assertBiometricAction:()=>{if(!f.approved)throw Error('expired');}}));
vi.mock('../wallet/SeedManager',()=>({default:{getMnemonic:async()=> 'backup'}}));
vi.mock('../wallet/TransactionService',()=>({default:{providerFor:()=>({})}}));
vi.mock('./human-bound-spending',()=>({discoverBoundHumanSpendingAccount:async()=>({account:f.account,kind:f.kind,generation:2,manifestHash:h(10)})}));
vi.mock('./auxiliary-account',()=>({auxiliaryAccountKey:async()=>{f.seed=new Uint8Array(32);f.seed[31]=7;return f.seed;}}));
vi.mock('../protocol/transaction',()=>({assertCurrentProtocolTransaction:async()=>{if(f.retired)throw Error('retired');return {manifestHash:h(10)};}}));
vi.mock('../security/ActionWallet',()=>({ActionWallet:class {
 address=wallet.address;
 constructor(_key:string,_action:unknown,_provider:unknown,private id:string){}
 async sendTransaction(tx:{to:string;value:string;data:string;chainId:number}){
  if(!f.signed.has(this.id)){const raw=await wallet.signTransaction({...tx,nonce:f.signed.size,gasLimit:21000,gasPrice:1});const {Transaction}=await import('ethers');f.signed.set(this.id,{raw,hash:Transaction.from(raw).hash!,nonce:f.signed.size});}
  f.sent.push(this.id);if(f.loseResponse){f.loseResponse=false;throw Error('lost response');}return {hash:f.signed.get(this.id)!.hash};
 }
}}));
vi.mock('../security/chainNonce',()=>({readChainOperation:async(_s:unknown,_k:string,id:string)=>{const a=f.signed.get(id);if(!a)throw Error('chain_operation_not_found');return {attempts:[{...a,intent:id}]};}}));
vi.mock('../security/secureNonceStore',()=>({secureNonceStore:()=>({transact:async()=>({attempts:[]})})}));
vi.mock('../protocol/runtime',()=>({ownerChainNetwork:()=>({rpcs:[0,1].map(i=>({request:async(method:string,params:unknown[])=>{
 f.rpcReads++;
 if(method==='eth_getTransactionReceipt')return f.mined?{transactionHash:params[0],blockHash:h(99),blockNumber:'0x64',status:f.reverted?'0x0':f.disagree&&i===1?'0x0':'0x1'}:null;
 if(method==='eth_getBlockByNumber'){if(f.raceReorg&&i===1&&params[0]==='finalized')f.reorg=true;return {number:params[0]==='finalized'&&!f.finalized?'0x63':'0x64',hash:f.reorg?h(98):h(99)};}
 if(method==='eth_getTransactionByHash')return {hash:params[0],from:intent.account,to:f.badTx?a(9):intent.target,input:'0x',value:'0x64',chainId:'0x2105',blockHash:h(99),blockNumber:'0x64'};
 throw Error('unexpected rpc');
}}))})}));
beforeEach(()=>{f.store.clear();f.signed.clear();Object.assign(f,{approved:true,account:intent.account,kind:'curve',retired:false,sent:[],loseResponse:false,failWrite:'',mined:false,finalized:true,reverted:false,reorg:false,badTx:false,disagree:false,raceReorg:false,rpcReads:0});});
test('retains one exact reviewed id through a lost send response and refuses replacement while unresolved',async()=>{
 f.loseResponse=true;await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow('lost response');expect((await readHumanCurveTransfer(intent.account))?.intent).toEqual(intent);
 await expect(executeHumanCurveTransfer({...intent,id:h(8)},action)).rejects.toThrow('transfer_pending');
 await expect(executeHumanCurveTransfer({...intent,value:'101'},action)).rejects.toThrow('intent_changed');
 await executeHumanCurveTransfer(intent,action);expect(f.signed.size).toBe(1);expect(f.seed.every(v=>v===0)).toBe(true);
});
test('lost completion and pending writes reconcile exact signed bytes without replay even after another recovery',async()=>{
 f.failWrite='pending';await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow('lost write');expect(f.sent).toHaveLength(1);
 f.mined=true;f.account=a(9);f.failWrite='complete';await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow('lost write');
 expect(await executeHumanCurveTransfer(intent,action)).toMatchObject({status:'complete',outcome:'succeeded'});expect(f.sent).toHaveLength(1);
 expect((await executeHumanCurveTransfer(intent,action)).status).toBe('complete');expect(f.sent).toHaveLength(1);
});
test('caller mutation cannot change a queued review and a new explicit id archives a completed payment',async()=>{
 const mutable={...intent};const task=executeHumanCurveTransfer(mutable,action);mutable.value='999';await task;
 expect((await readHumanCurveTransfer(intent.account))?.intent.value).toBe('100');f.mined=true;await executeHumanCurveTransfer(intent,action);
 await executeHumanCurveTransfer({...intent,id:h(8)},action);expect(f.signed.size).toBe(2);
 await executeHumanCurveTransfer(intent,action);expect(f.signed.size).toBe(2);
});
test('expired approval, hash authority, another wallet, retired targets and initial journal failure cannot send',async()=>{
 f.approved=false;await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow('expired');f.approved=true;
 f.kind='hash';await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow('wrong_account');f.kind='curve';
 f.account=a(9);await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow('wrong_account');f.account=intent.account;
 f.retired=true;await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow('retired');f.retired=false;
 f.failWrite='initial';await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow('lost write');expect(f.sent).toHaveLength(0);expect(f.seed.every(v=>v===0)).toBe(true);
});
test('two finalized canonical receipts and the exact call are required; a revert completes only as failed',async()=>{
 await executeHumanCurveTransfer(intent,action);f.mined=true;
 for(const field of ['reorg','badTx','disagree'] as const){f[field]=true;await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow(/recourse_transfer_receipt_/);f[field]=false;}
 f.finalized=false;expect((await executeHumanCurveTransfer(intent,action)).status).toBe('pending');f.finalized=true;
 f.reverted=true;expect(await executeHumanCurveTransfer(intent,action)).toMatchObject({status:'complete',outcome:'target_failed'});
});

test('a reorg during the second finality read cannot complete either success or failure or unlock a new payment',async()=>{
 await executeHumanCurveTransfer(intent,action);f.mined=true;f.raceReorg=true;
 for(const reverted of [false,true]){f.reverted=reverted;f.reorg=false;
  await expect(executeHumanCurveTransfer(intent,action)).rejects.toThrow('receipt_reorg');
  expect((await readHumanCurveTransfer(intent.account))?.result?.status).toBe('pending');
  await expect(executeHumanCurveTransfer({...intent,id:h(8)},action)).rejects.toThrow('transfer_pending');
 }
 expect(f.sent).toHaveLength(1);
});

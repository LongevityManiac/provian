import { beforeEach, expect, test, vi } from 'vitest';
import { sha256, toUtf8Bytes } from 'ethers';
import type { BiometricAction } from '../security/biometricAction';
import { executeHumanHashTransfer, readHumanHashTransfer, type HumanHashTransferIntent } from './human-hash-transfer';
import type { SignedHashAccountOperation } from './hash-account';
const f = vi.hoisted(() => ({ store: new Map<string,string>(), approved: true, selected: '', nonce: '0',
  operation: null as SignedHashAccountOperation | null, cancellation: null as SignedHashAccountOperation | null,
  auxiliaryBinding: null as string | null, completed: null as { hash: string; outcome: string } | null,
  prepared: 0, sends: 0, cancelled: 0, finalize: false, failWrite: '', estimates: 0, retired: false, mined: false, mineDuringCancel: false }));
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`, h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const action={} as BiometricAction, intent:HumanHashTransferIntent={id:h(1),account:a(2),auxiliaryBinding:null,target:a(3),value:'100',data:'0x'};
const opId=(op:SignedHashAccountOperation)=>sha256(toUtf8Bytes(JSON.stringify(op)));
const selection=()=>({kind:'hash',evm:f.selected,requestId:h(8),hashAccount:{identity:h(9),nonce:f.nonce}});
vi.mock('expo-secure-store',()=>({WHEN_UNLOCKED_THIS_DEVICE_ONLY:'device',getItemAsync:async(k:string)=>f.store.get(k)??null,
  setItemAsync:async(k:string,v:string)=>{const r=JSON.parse(v);if((f.failWrite==='id'&&r.operationId)||(f.failWrite==='complete'&&r.result?.status==='complete')){f.failWrite='';throw Error('interrupted write');}f.store.set(k,v);}}));
vi.mock('../security/biometricAction',()=>({assertBiometricAction:()=>{if(!f.approved)throw Error('expired');}}));
vi.mock('../wallet/SeedManager',()=>({default:{getMnemonic:async()=> 'backup'}}));
vi.mock('../../store/walletStore',()=>({useWalletStore:{getState:()=>({address:f.selected})}}));
vi.mock('./human-account',()=>({deriveHumanAccount:async()=>({evm:a(1)}),readHumanAccountSelection:async()=>selection(),discoverHumanHashAccountSelection:async()=>selection()}));
vi.mock('./human-bound-hash-account',()=>({discoverBoundHumanHashAccount:async()=>({evm:a(2),hashAccount:{nonce:f.nonce}})}));
vi.mock('../protocol/runtime',()=>({ownerChainNetwork:()=>({deployment:async()=>({manifestHash:h(10)}),rpcs:[0,1].map(()=>({request:async()=>{f.estimates++;return '0x5208';}}))})}));
vi.mock('../protocol/transaction',()=>({assertCurrentProtocolTransaction:async()=>{if(f.retired)throw Error('retired');return {manifestHash:h(10)};}}));
vi.mock('./hash-account-delivery',()=>({hashDeliveryId:(op:SignedHashAccountOperation)=>opId(op)}));
vi.mock('./human-hash-spending',()=>({
  readHumanHashSpendingDelivery:async()=>({operation:f.operation,cancellation:f.cancellation,completed:f.completed,auxiliaryBinding:f.auxiliaryBinding}),
  prepareHumanHashSpending:async(_m:string,call:object,_a:unknown,_n:unknown,binding?:string)=>{
    f.prepared++;f.auxiliaryBinding=binding??null;f.completed=null;
    f.operation={account:a(2),nonce:f.nonce,...call} as SignedHashAccountOperation;return f.operation;
  },
  cancelHumanHashSpending:async()=>{if(f.mineDuringCancel){f.mined=true;f.nonce='1';}if(f.nonce!==f.operation?.nonce)throw Error('pending_missing');f.cancelled++;f.cancellation={...f.operation!,target:a(2),value:'0',data:'0x'};return f.cancellation;},
}));
vi.mock('./human-hash-delivery',()=>({reconcileHumanHashSpending:async()=>{
  if(!f.mined)return null;
  f.completed={hash:h(20),outcome:'succeeded'};f.nonce='1';
  return{status:'complete',transactionHash:h(20),outcome:'succeeded'};
},deliverHumanHashSpending:async(_account:string,_action:unknown,id:string,variant:string)=>{
  expect(id).toBe(opId(variant==='cancellation'?f.cancellation!:f.operation!));
  if(f.completed)return{status:'complete',transactionHash:f.completed.hash,outcome:f.completed.outcome};
  if(f.finalize){f.completed={hash:h(20),outcome:variant==='cancellation'?'cancelled':'succeeded'};f.nonce=String(BigInt(f.nonce)+1n);return{status:'complete',transactionHash:h(20),outcome:f.completed.outcome};}
  f.sends++;return{status:'pending',transactionHash:h(20)};
}}));
beforeEach(()=>{f.store.clear();Object.assign(f,{approved:true,selected:a(2),nonce:'0',operation:null,cancellation:null,auxiliaryBinding:null,completed:null,
 prepared:0,sends:0,cancelled:0,finalize:false,failWrite:'',estimates:0,retired:false,mined:false,mineDuringCancel:false});});
test('retains exact review and gas before signing; refuses a changed review or a new intent while pending',async()=>{
  expect((await executeHumanHashTransfer(intent,action)).status).toBe('pending');
  const held=await readHumanHashTransfer(a(2));expect(held?.intent).toEqual(intent);expect(held?.nonce).toBe('0');expect(held?.operationId).toBe(opId(f.operation!));
  await expect(executeHumanHashTransfer({...intent,value:'101'},action)).rejects.toThrow('intent_changed');
  await expect(executeHumanHashTransfer({...intent,id:h(2)},action)).rejects.toThrow('transfer_pending');
  await executeHumanHashTransfer(intent,action);expect(f.prepared).toBe(1);expect(f.estimates).toBe(2);
});
test('a crash after signing reuses the exact signed operation even if its completion preceded the outer journal write',async()=>{
  f.failWrite='id';await expect(executeHumanHashTransfer(intent,action)).rejects.toThrow('interrupted write');expect(f.prepared).toBe(1);expect(f.sends).toBe(0);
  f.completed={hash:h(20),outcome:'succeeded'};f.nonce='1';
  expect((await executeHumanHashTransfer(intent,action)).status).toBe('complete');expect(f.prepared).toBe(1);expect(f.sends).toBe(0);
});
test('lost completion writes and archived retries cannot duplicate a payment; an explicitly new intent advances once',async()=>{
  await executeHumanHashTransfer(intent,action);f.finalize=true;f.failWrite='complete';
  await expect(executeHumanHashTransfer(intent,action)).rejects.toThrow('interrupted write');
  const complete=await executeHumanHashTransfer(intent,action);expect(complete.status).toBe('complete');expect(f.prepared).toBe(1);
  await executeHumanHashTransfer({...intent,id:h(2)},action);expect(f.prepared).toBe(2);
  expect(await executeHumanHashTransfer(intent,action)).toEqual(complete);expect(f.prepared).toBe(2);
  await expect(executeHumanHashTransfer({...intent,target:a(5)},action)).rejects.toThrow('intent_changed');
});
test('a cancellation remains the chosen competing variant across retries and never replaces the transfer',async()=>{
  await executeHumanHashTransfer(intent,action);
  await executeHumanHashTransfer(intent,action,true);expect(f.cancelled).toBe(1);expect((await readHumanHashTransfer(a(2)))?.cancelling).toBe(true);
  f.finalize=true;
  expect(await executeHumanHashTransfer(intent,action)).toMatchObject({status:'complete',outcome:'cancelled'});
  expect(f.cancelled).toBe(1);expect(f.prepared).toBe(1);
});
test('auxiliary transfers use their derived account and preserve the selected primary wallet',async()=>{
  f.selected=a(9);const auxiliary={...intent,auxiliaryBinding:h(4)};
  await executeHumanHashTransfer(auxiliary,action);expect(f.auxiliaryBinding).toBe(h(4));expect(f.selected).toBe(a(9));
  await expect(executeHumanHashTransfer({...auxiliary,account:a(8)},action)).rejects.toThrow('wrong_account');
});
test('an expired approval, retired target, orphan operation or changed nonce cannot sign a new transfer',async()=>{
  f.approved=false;await expect(executeHumanHashTransfer(intent,action)).rejects.toThrow('expired');f.approved=true;
  f.retired=true;await expect(executeHumanHashTransfer(intent,action)).rejects.toThrow('retired');f.retired=false;
  f.operation={account:a(2),nonce:'0',target:a(9),value:'0',data:'0x',callGas:'100'} as SignedHashAccountOperation;
  await expect(executeHumanHashTransfer(intent,action)).rejects.toThrow('spending_pending');expect(f.prepared).toBe(0);
  f.operation=null;f.failWrite='id';await expect(executeHumanHashTransfer(intent,action)).rejects.toThrow('interrupted write');
  f.operation=null;f.nonce='1';await expect(executeHumanHashTransfer(intent,action)).rejects.toThrow('state_changed');expect(f.prepared).toBe(1);
});
test('caller edits after enqueue cannot change the transfer that was reviewed',async()=>{
 const editable={...intent};const pending=executeHumanHashTransfer(editable,action);editable.value='999';editable.target=a(9);
 await pending;expect(f.operation?.value).toBe('100');expect(f.operation?.target).toBe(a(3));
 expect((await readHumanHashTransfer(a(2)))?.intent).toEqual(intent);
});

test('cancellation reconciles an already-mined original and a nonce consumed during cancellation preparation without rebroadcast',async()=>{
 for(const during of [false,true]){
  f.store.clear();f.operation=null;f.completed=null;f.nonce='0';f.mined=false;f.mineDuringCancel=false;f.sends=0;f.cancelled=0;
  await executeHumanHashTransfer(intent,action);
  if(during)f.mineDuringCancel=true;else{f.mined=true;f.nonce='1';}
  expect(await executeHumanHashTransfer(intent,action,true)).toMatchObject({status:'complete',outcome:'succeeded'});
  expect(f.sends).toBe(1);expect(f.cancelled).toBe(0);
  expect(await executeHumanHashTransfer(intent,action)).toMatchObject({status:'complete',outcome:'succeeded'});
 }
});

import { beforeEach, expect, test, vi } from 'vitest';
import { sha256 } from 'ethers';
import type { BiometricAction } from '../security/biometricAction';
import type { OwnerChainNetwork } from './owner-chain';
import { prepareHumanHashSpending, completeHumanHashSpending, pendingHumanHashSpending, cancelHumanHashSpending } from './human-hash-spending';
const f=vi.hoisted(()=>({store:new Map<string,string>(),nonce:'0',active:true,approved:true,badWrite:false,retired:false,
  signCount:0,seeds:[]as Uint8Array[],outcome:'succeeded',receipt:false,install:vi.fn()}));
const account=`0x${'11'.repeat(20)}`,target=`0x${'22'.repeat(20)}`,identity=`0x${'33'.repeat(32)}`,tx=`0x${'44'.repeat(32)}`;
const selection=()=>({kind:'hash',evm:account,requestId:identity,hashAccount:{identity,breakOrigin:target,chainId:'8453',nonce:f.nonce}});
vi.mock('expo-secure-store',()=>({WHEN_UNLOCKED_THIS_DEVICE_ONLY:'device',getItemAsync:async(k:string)=>f.badWrite?null:f.store.get(k)??null,
 setItemAsync:async(k:string,v:string)=>{f.store.set(k,v);}}));
vi.mock('../security/biometricAction',()=>({assertBiometricAction:()=>{if(!f.approved)throw Error('approval expired');}}));
vi.mock('../protocol/runtime',()=>({ownerChainNetwork:()=>({})}));
vi.mock('../protocol/transaction',()=>({assertCurrentProtocolTransaction:async()=>{if(f.retired)throw Error('retired');return{manifestHash:identity};}}));
vi.mock('./human-account',()=>({deriveHumanAccount:async()=>({evm:account}),readHumanAccountSelection:async()=>f.active?selection():null,
 discoverHumanHashAccountSelection:async()=>selection(),installHumanHashAccountSelection:async()=>{f.install();return selection();}}));
vi.mock('./human-secret',()=>({humanBreakKey:(_m:string,_c:unknown,_p:string,nonce:string)=>{const s=new Uint8Array(32).fill(Number(nonce)+1);f.seeds.push(s);return s;}}));
vi.mock('./hash-account',async importActual=>{
 const real=await importActual<typeof import('./hash-account')>();
 return{...real,prepareHashAccountOperation:async(input:Parameters<typeof real.prepareHashAccountOperation>[0])=>{
  const publicKey=`0x${'55'.repeat(32)}`,intent={...input.intent,nextCommitment:sha256(input.nextSigningSeed)};
  await input.persistBeforeSigning(intent,input.nextSigningSeed);++f.signCount;
  return{...intent,publicKey,signingRoot:sha256(publicKey),signature:`0x${'66'.repeat(7856)}`};
 }};
});
vi.mock('./hash-account-chain',()=>({verifyHashAccountVariantReceipt:async(ops:unknown[])=>{
 if(!f.receipt)throw Error('not finalized');return{operation:ops[f.outcome==='cancelled'?1:0],outcome:f.outcome};
}}));
const action={}as BiometricAction,network={}as OwnerChainNetwork,call={target,value:'0',callGas:'100000',data:'0x'};
beforeEach(()=>{f.store.clear();f.nonce='0';f.active=true;f.approved=true;f.badWrite=false;f.retired=false;f.signCount=0;f.seeds=[];f.outcome='succeeded';f.receipt=false;f.install.mockClear();});
test('reserves before signing, reuses exact operation, rejects a different request and wipes derived material',async()=>{
 const op=await prepareHumanHashSpending('backup',call,action,network);
 expect(await prepareHumanHashSpending('backup',{data:'0x',value:'0',target,callGas:'100000'},action,network)).toEqual(op);
 expect(f.signCount).toBe(1);expect(f.seeds.every(s=>s.every(b=>b===0))).toBe(true);
 expect((await pendingHumanHashSpending(account)).operation).toEqual(op);
 await expect(prepareHumanHashSpending('backup',{...call,value:'1'},action,network)).rejects.toThrow('pending');
});
test('failed durable readback, expired approval, curve selection and retired targets publish no signature',async()=>{
 f.badWrite=true;await expect(prepareHumanHashSpending('backup',call,action,network)).rejects.toThrow('write_unconfirmed');expect(f.signCount).toBe(0);
 f.badWrite=false;f.approved=false;await expect(prepareHumanHashSpending('backup',call,action,network)).rejects.toThrow('approval');
 f.approved=true;f.active=false;await expect(prepareHumanHashSpending('backup',call,action,network)).rejects.toThrow('not_selected');
 f.active=true;f.retired=true;await expect(prepareHumanHashSpending('backup',call,action,network)).rejects.toThrow('retired');expect(f.signCount).toBe(0);
});
test('a failed target still rotates after finality; lost completion response is idempotent',async()=>{
 await prepareHumanHashSpending('backup',call,action,network);
 await expect(completeHumanHashSpending('backup',account,tx,action,network)).rejects.toThrow('not finalized');expect(f.install).not.toHaveBeenCalled();
 f.receipt=true;f.nonce='1';f.outcome='target_failed';
 expect(await completeHumanHashSpending('backup',account,tx,action,network)).toBe('target_failed');
 expect(await completeHumanHashSpending('backup',account,tx,action,network)).toBe('target_failed');expect(f.install).toHaveBeenCalledTimes(1);
 expect((await pendingHumanHashSpending(account)).operation).toBeNull();
 const next=await prepareHumanHashSpending('backup',call,action,network);expect(next.nonce).toBe('1');expect(f.store.size).toBe(2);
});
test('cancellation retains both competing signatures and recognizes the winning variant',async()=>{
 const original=await prepareHumanHashSpending('backup',call,action,network),cancel=await cancelHumanHashSpending('backup',action,network);
 expect(cancel.nextCommitment).toBe(original.nextCommitment);expect(cancel.target).toBe(account);expect(cancel.value).toBe('0');
 await prepareHumanHashSpending('backup',call,action,network);
 expect(await pendingHumanHashSpending(account)).toEqual({operation:original,cancellation:cancel});
 f.receipt=true;f.nonce='1';f.outcome='cancelled';expect(await completeHumanHashSpending('backup',account,tx,action,network)).toBe('cancelled');
});
test('changed protected operation is refused before signing or broadcasting',async()=>{
 await prepareHumanHashSpending('backup',call,action,network);
 for(const[k,v]of f.store){const j=JSON.parse(v);j.operation.target=account;f.store.set(k,JSON.stringify(j));}
 await expect(prepareHumanHashSpending('backup',call,action,network)).rejects.toThrow('journal_invalid');expect(f.signCount).toBe(1);
});

import { beforeEach, expect, test, vi } from 'vitest';
import { signHumanHashDigest } from './human-hash-message';
import type { BiometricAction } from '../security/biometricAction';
import type { OwnerChainNetwork } from './owner-chain';
const f=vi.hoisted(()=>({hash:true,bad:false,changed:false,calls:0,seeds:[] as Uint8Array[],sign:vi.fn(async()=>'0xsigned')}));
const a=`0x${'11'.repeat(20)}`,h=`0x${'22'.repeat(32)}`;
vi.mock('../security/biometricAction',()=>({assertBiometricAction:()=>{}}));
vi.mock('../protocol/runtime',()=>({ownerChainNetwork:()=>({})}));
vi.mock('./human-account',()=>({deriveHumanAccount:async()=>({evm:a}),readHumanAccountSelection:async()=>f.hash?{kind:'hash',requestId:h,hashAccount:{identity:h}}:null,
  discoverHumanHashAccountSelection:async()=>{++f.calls;if(f.bad)throw Error('unverified');return{evm:a,requestId:h,hashAccount:{identity:h,chainId:'8453',breakOrigin:a,nonce:f.changed&&f.calls>1?'1':'0'}};}}));
vi.mock('./human-secret',()=>({humanBreakKey:()=>{const s=new Uint8Array(32).fill(42);f.seeds.push(s);return s;}}));
vi.mock('./hash-account',()=>({signHashAccountMessage:f.sign}));
beforeEach(()=>{f.hash=true;f.bad=false;f.changed=false;f.calls=0;f.seeds=[];f.sign.mockClear();});
const action={}as BiometricAction,net={}as OwnerChainNetwork;
test('signs only the independently discovered hash account and wipes the seed',async()=>{
  await expect(signHumanHashDigest('backup',a,h,action,net)).resolves.toBe('0xsigned');expect(f.calls).toBe(2);
  expect(f.seeds[0].every(b=>b===0)).toBe(true);
});
test('only a curve selection returns null; a corrupt hash selection fails closed',async()=>{
  f.hash=false;await expect(signHumanHashDigest('backup',a,h,action,net)).resolves.toBeNull();
  f.hash=true;f.bad=true;await expect(signHumanHashDigest('backup',a,h,action,net)).rejects.toThrow('unverified');expect(f.sign).not.toHaveBeenCalled();
});
test('refuses a different destination or a nonce change while signing',async()=>{
  await expect(signHumanHashDigest('backup',`0x${'33'.repeat(20)}`,h,action,net)).rejects.toThrow('destination_changed');
  expect(f.sign).not.toHaveBeenCalled();f.calls=0;f.changed=true;
  await expect(signHumanHashDigest('backup',a,h,action,net)).rejects.toThrow('state_changed');expect(f.seeds[0].every(b=>b===0)).toBe(true);
});

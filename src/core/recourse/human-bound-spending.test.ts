import { beforeEach, expect, test, vi } from 'vitest';
import { Wallet, hexlify, sha256 } from 'ethers';
import { discoverBoundHumanSpendingAccount } from './human-bound-spending';
import { auxiliaryAccountKey } from './auxiliary-account';
import { humanRecoverySecret, humanRecoverySigningSeed } from './human-secret';
import type { OwnerChainNetwork } from './owner-chain';
const f=vi.hoisted(()=>({broken:false,unavailable:false,destination:'',nonce:3,badRoot:false,badSecret:false,changed:false,reads:0,keys:[] as Uint8Array[]}));
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const phrase='test test test test test test test test test test test junk', identity=h(4), network={} as OwnerChainNetwork;
vi.mock('../wallet/pacedSeed',()=>({mnemonicToSeedPaced:async()=>new Uint8Array(64).fill(9)}));
vi.mock('./hash-authorization',()=>({recoverySigningRoot:async(seed:Uint8Array)=>sha256(seed),recoveryCommitment:(secret:Uint8Array)=>sha256(secret)}));
vi.mock('./break-recovery',()=>({readBreakRecoveryContext:async()=>{if(f.unavailable)throw Error('rpc offline');if(!f.broken)throw Error('break_recovery_unavailable');return a(1);}}));
vi.mock('./human-bound-hash-account',()=>({discoverBoundHumanHashAccount:async()=>({evm:a(5),recoveryGeneration:4,manifestHash:h(10)})}));
vi.mock('./owner-chain',()=>({readOwnerChainState:async()=>{
 f.reads++;return {nonce:f.nonce,destination:f.changed&&f.reads>1?a(9):f.destination,deployment:{manifestHash:h(10)},
 signingRoot:f.badRoot?h(8):sha256(humanRecoverySigningSeed(phrase,f.nonce,identity)),commitment:f.badSecret?h(8):sha256(humanRecoverySecret(phrase,f.nonce,identity))};
}}));
beforeEach(async()=>{Object.assign(f,{broken:false,unavailable:false,nonce:3,badRoot:false,badSecret:false,changed:false,reads:0});
 const key=await auxiliaryAccountKey(phrase,identity,2);try{f.destination=new Wallet(hexlify(key)).address.toLowerCase();}finally{key.fill(0);}
});
test('discovers an auxiliary curve generation independently of its later recovery nonce without selecting a primary wallet',async()=>{
 expect(await discoverBoundHumanSpendingAccount(phrase,identity,network)).toEqual({account:f.destination,kind:'curve',auxiliaryBinding:identity,generation:2,manifestHash:h(10)});
});
test('requires exact independent recovery authority and refuses wrong bindings, destination and racing state',async()=>{
 for(const field of ['badRoot','badSecret','changed'] as const){f[field]=true;f.reads=0;await expect(discoverBoundHumanSpendingAccount(phrase,identity,network)).rejects.toThrow(/recourse_auxiliary_/);f[field]=false;}
 await expect(discoverBoundHumanSpendingAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',identity,network)).rejects.toThrow('recovery_mismatch');
 await expect(discoverBoundHumanSpendingAccount(phrase,h(5),network)).rejects.toThrow('recovery_mismatch');
 f.destination=a(9);await expect(discoverBoundHumanSpendingAccount(phrase,identity,network)).rejects.toThrow('backup_mismatch');
});
test('a break selects hash authority while unavailable discovery never falls back to curve keys',async()=>{
 f.broken=true;expect((await discoverBoundHumanSpendingAccount(phrase,identity,network)).kind).toBe('hash');expect(f.reads).toBe(0);
 f.unavailable=true;await expect(discoverBoundHumanSpendingAccount(phrase,identity,network)).rejects.toThrow('rpc offline');expect(f.reads).toBe(0);
});

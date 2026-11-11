import { beforeEach, expect, it, vi } from 'vitest';
import { sha256 } from 'ethers';
import { discoverBoundHumanHashAccount } from './human-bound-hash-account';
import { humanBreakKey } from './human-secret';
import type { OwnerChainNetwork } from './owner-chain';
const f=vi.hoisted(()=>({generation:2,ownerNonce:3,spendingNonce:'4',badSpend:false,badRecovery:false,changed:false,winnerReads:0}));
const phrase='test test test test test test test test test test test junk';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const base={identity:h(1),breakOrigin:a(2),chainId:'8453'};
vi.mock('./hash-authorization',()=>({recoverySigningRoot:async(seed:Uint8Array)=>sha256(seed),recoveryCommitment:(secret:Uint8Array)=>sha256(secret)}));
vi.mock('./break-recovery',()=>({readBreakRecoveryContext:async()=>a(2)}));
vi.mock('./owner-chain',()=>({readOwnerChainState:async()=>({nonce:f.ownerNonce,destination:a(10+f.generation),deployment:{manifestHash:h(99)},
  signingRoot:sha256(humanBreakKey(phrase,base,'recovery-signing',String(f.ownerNonce))),
  commitment:f.badRecovery?h(77):sha256(humanBreakKey(phrase,base,'recovery-secret',String(f.ownerNonce)))})}));
vi.mock('./hash-account-deployment',()=>({discoverHashAccount:async(root:string)=>{
  let generation=-1;
  for(let i=0;i<=f.ownerNonce;i++)if(sha256(humanBreakKey(phrase,{...base,accountGeneration:String(i)},'spending','0'))===root)generation=i;
  if(generation===f.generation)f.winnerReads++;
  return {account:a(10+generation),deployed:generation===f.generation,nonce:generation===f.generation?f.spendingNonce:null,
    currentRoot:f.badSpend?h(77):sha256(humanBreakKey(phrase,{...base,accountGeneration:String(Math.max(0,generation))},'spending',f.spendingNonce)),
    factory:a(20),manifestHash:f.changed&&f.winnerReads>1?h(98):h(99)};
}}));
beforeEach(()=>Object.assign(f,{generation:2,ownerNonce:3,spendingNonce:'4',badSpend:false,badRecovery:false,changed:false,winnerReads:0}));
it('rediscovers the exact replacement account from only the seed and per-address binding, with separate spending and recovery generations',async()=>{
  const result=await discoverBoundHumanHashAccount(phrase,h(1),{} as OwnerChainNetwork);
  expect(result).toMatchObject({identity:h(1),evm:a(12),recoveryGeneration:3,hashAccount:{...base,accountGeneration:'2',nonce:'4'}});
  f.generation=0;f.winnerReads=0;
  expect((await discoverBoundHumanHashAccount(phrase,h(1),{} as OwnerChainNetwork)).hashAccount.accountGeneration).toBe('0');
});
it('refuses wrong backups, missing spending or recovery authority, and a changed finalized observation',async()=>{
  for(const field of ['badSpend','badRecovery','changed'] as const){
    f[field]=true;f.winnerReads=0;
    await expect(discoverBoundHumanHashAccount(phrase,h(1),{} as OwnerChainNetwork)).rejects.toThrow(/recourse_hash_account_/);
    f[field]=false;
  }
  await expect(discoverBoundHumanHashAccount('another backup',h(1),{} as OwnerChainNetwork)).rejects.toThrow('backup_mismatch');
});

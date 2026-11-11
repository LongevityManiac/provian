import { beforeEach, expect, test, vi } from 'vitest';
import { withdrawHumanRestoration } from './human-restoration-exit';
import { RECOURSE_POOL_ABI } from './pool-abi';
const f=vi.hoisted(()=>({seed:new Uint8Array(64).fill(1),approved:true,manifest:'current',status:1,allocated:true,
  send:vi.fn(),mnemonic:vi.fn(),activeKey:vi.fn(()=>{throw Error('recourse_hash_account_signer_required');})}));
const pool=`0x${'11'.repeat(20)}`,identity=`0x${'22'.repeat(32)}`,request=`0x${'33'.repeat(32)}`,hash=`0x${'44'.repeat(32)}`;
vi.mock('../security/biometricAction',()=>({withBiometricAction:async(_prompt:string,run:(a:object)=>Promise<unknown>)=>run({}),
 assertBiometricAction:()=>{if(!f.approved)throw Error('approval expired');}}));
vi.mock('../security/ActionWallet',()=>({ActionWallet:class{async sendTransaction(tx:unknown){f.send(tx);return{hash,wait:async()=>({status:f.status})};}}}));
vi.mock('../wallet/SeedManager',()=>({default:{getEVMPrivateKey:f.activeKey,getMnemonic:async()=>{f.mnemonic();return 'test-only backup';}}}));
vi.mock('../wallet/pacedSeed',()=>({mnemonicToSeedPaced:async()=>f.seed}));
vi.mock('../wallet/TransactionService',()=>({default:{providerFor:()=>({})}}));
vi.mock('../protocol/runtime',()=>({ownerChainNetwork:()=>({}),currentProtocolDeployment:async()=>({manifestHash:f.manifest})}));
vi.mock('../../i18n/translate',()=>({translate:(_k:string,fallback:string)=>fallback}));
vi.mock('./human-account',()=>({humanAccountPaths:(generation:number)=>{expect(generation).toBe(0);return{evm:"m/44'/60'/0'/0/0"};}}));
vi.mock('./restoration-exit',()=>({prepareRestorationExit:async(i:string,r:string)=>{if(!f.allocated)throw Error('recourse_allocation_unavailable');return{pool,manifestHash:'current',data:RECOURSE_POOL_ABI.encodeFunctionData('deliverRestoration',[r,i])};}}));
beforeEach(()=>{f.seed=new Uint8Array(64).fill(1);f.approved=true;f.manifest='current';f.status=1;f.allocated=true;vi.clearAllMocks();});
test('hash-account selection does not request its curve key; gas transport cannot change allocation destination',async()=>{
 expect(await withdrawHumanRestoration(identity,request)).toBe(hash);
 expect(f.activeKey).not.toHaveBeenCalled();expect(f.mnemonic).toHaveBeenCalledTimes(1);
 expect(f.send).toHaveBeenCalledExactlyOnceWith({to:pool,chainId:8453,value:0n,data:RECOURSE_POOL_ABI.encodeFunctionData('deliverRestoration',[request,identity])});
 expect(f.seed.every(b=>b===0)).toBe(true);
});
test('changed pointer, revoked biometric or missing allocation cannot broadcast',async()=>{
 f.manifest='changed';await expect(withdrawHumanRestoration(identity,request)).rejects.toThrow('pointer_changed');expect(f.seed.every(b=>b===0)).toBe(true);
 f.manifest='current';f.approved=false;await expect(withdrawHumanRestoration(identity,request)).rejects.toThrow('approval');
 f.approved=true;f.allocated=false;await expect(withdrawHumanRestoration(identity,request)).rejects.toThrow('allocation_unavailable');expect(f.send).not.toHaveBeenCalled();
});
test('failed transaction never reports a completed payout and wipes derived seed bytes',async()=>{
 f.status=0;await expect(withdrawHumanRestoration(identity,request)).rejects.toThrow('not_confirmed');expect(f.seed.every(b=>b===0)).toBe(true);
});

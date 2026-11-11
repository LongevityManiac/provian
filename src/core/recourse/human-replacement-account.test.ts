import { beforeEach, expect, test, vi } from 'vitest';
import { sha256, concat } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import type { BiometricAction } from '../security/biometricAction';
import { humanBreakKey } from './human-secret';
import { prepareHumanReplacementAccount, deployHumanReplacementAccount, signHumanReplacementDestination } from './human-replacement-account';
const f=vi.hoisted(()=>({deployed:false,nonce:'0',wrongOwner:false,wrongRoot:false,reads:0,changed:false,approved:true,status:'confirmed',pretend:false,sponsored:0,queries:[] as string[],retains:0}));
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const phrase='test test test test test test test test test test test junk',base={identity:h(1),breakOrigin:a(2),chainId:'8453'};
const network={}as OwnerChainNetwork,action={}as BiometricAction;
vi.mock('../security/biometricAction',()=>({assertBiometricAction:()=>{if(!f.approved)throw Error('expired');}}));
vi.mock('./break-recovery',()=>({readBreakRecoveryContext:async()=>a(2)}));
vi.mock('./hash-authorization',()=>({recoverySigningRoot:async(seed:Uint8Array)=>sha256(seed),recoveryCommitment:(secret:Uint8Array,root:string)=>sha256(concat([secret,root]))}));
vi.mock('./owner-chain',()=>({readOwnerChainState:async()=>{f.reads++;const root=sha256(humanBreakKey(phrase,base,'recovery-signing','2'));return{
 nonce:2,commitment:f.wrongOwner?h(9):sha256(concat([humanBreakKey(phrase,base,'recovery-secret','2'),root])),signingRoot:root,
 destination:a(90),deployment:{manifestHash:h(f.changed&&f.reads>1?8:7)}};}}));
vi.mock('./hash-account-deployment',()=>({discoverHashAccount:async(root:string)=>{f.queries.push(root);return{account:a(3),deployed:f.deployed,
 currentRoot:f.wrongRoot?h(99):sha256(humanBreakKey(phrase,{...base,accountGeneration:'3'},'spending',f.nonce)),nonce:f.nonce,manifestHash:h(7)};}}));
vi.mock('./replacement-deployment-proof',()=>({prepareReplacementDeploymentRequest:async(input:{persistBeforePublishing:(r:unknown)=>Promise<void>})=>{
 await input.persistBeforePublishing({account:a(3),breakOrigin:a(2),nonce:2,digest:h(5)});return{kind:'replacement',account:a(3)};
}}));
vi.mock('./break-deployment-data',()=>({accountDeploymentDigest:()=>h(5)}));
vi.mock('../../services/RelayAPIService',()=>({default:{recourseRecoveryRequest:async()=>{f.sponsored++;if(!f.pretend)f.deployed=true;return{id:h(5),status:f.status};}}}));
vi.mock('./hash-account',()=>({signHashAccountMessage:async()=> 'hash signature'}));
beforeEach(()=>Object.assign(f,{deployed:false,nonce:'0',wrongOwner:false,wrongRoot:false,reads:0,changed:false,approved:true,status:'confirmed',pretend:false,sponsored:0,queries:[],retains:0}));
test('replacement preparation needs independent recovery material and never the stolen account spending root',async()=>{
 const plan=await prepareHumanReplacementAccount(phrase,h(1),network);
 expect(plan).toMatchObject({nonce:2,accountGeneration:'3',account:a(3)});
 expect(f.queries).toEqual([plan.initialRoot]); // no query selects the stolen destination/root
 f.wrongOwner=true;await expect(prepareHumanReplacementAccount(phrase,h(1),network)).rejects.toThrow('backup_mismatch');
 f.wrongOwner=false;f.changed=true;f.reads=0;await expect(prepareHumanReplacementAccount(phrase,h(1),network)).rejects.toThrow('state_changed');
});
test('exact durable plan precedes sponsorship, a false success cannot install an undeployed account, and a retry never spends again',async()=>{
 const plan=await prepareHumanReplacementAccount(phrase,h(1),network);
 await expect(deployHumanReplacementAccount(phrase,plan,action,network,async()=>{throw Error('disk');})).rejects.toThrow('disk');expect(f.sponsored).toBe(0);
 f.pretend=true;await expect(deployHumanReplacementAccount(phrase,plan,action,network,async()=>{f.retains++;})).rejects.toThrow('state_changed');
 f.pretend=false;await deployHumanReplacementAccount(phrase,plan,action,network,async()=>{f.retains++;});const calls=f.sponsored;
 await deployHumanReplacementAccount(phrase,plan,action,network,async()=>{throw Error('should not reserve');});expect(f.sponsored).toBe(calls);
 f.wrongRoot=true;await expect(deployHumanReplacementAccount(phrase,plan,action,network,async()=>{})).rejects.toThrow('state_changed');
});
test('destination possession follows the replacement current spending nonce and refuses expired authority or another root',async()=>{
 const plan=await prepareHumanReplacementAccount(phrase,h(1),network);f.deployed=true;f.nonce='4';
 expect(await signHumanReplacementDestination(phrase,plan,'exact credential cut',action,network)).toBe('hash signature');
 f.wrongRoot=true;await expect(signHumanReplacementDestination(phrase,plan,'exact credential cut',action,network)).rejects.toThrow('spending_key_changed');
 f.wrongRoot=false;f.approved=false;await expect(signHumanReplacementDestination(phrase,plan,'exact credential cut',action,network)).rejects.toThrow('expired');
});

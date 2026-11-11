import { beforeEach, expect, it, vi } from 'vitest';
import { hexlify } from 'ethers';
import { recoveryCommitment, recoverySigningRoot } from './recourse-hash-authorization';
import { prepareReplacementDeploymentRequest } from './replacement-deployment-proof';
import { accountDeploymentDigest, parseAccountDeploymentRequest, replacementDeploymentDigest } from './break-deployment-data';
import type { OwnerChainNetwork } from './recourse-owner-chain';
const f=vi.hoisted(()=>({changed:false,reads:0,wrongOwner:false,sameAccount:false,wrongManifest:false}));
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const secret=new Uint8Array(32).fill(1),seed=new Uint8Array(32).fill(2),destination=new Uint8Array(32).fill(3);
vi.mock('./recourse-owner-chain',()=>({readOwnerChainState:async()=>{f.reads++;const root=await recoverySigningRoot(seed);return{
 nonce:f.changed&&f.reads>1?2:1,commitment:f.wrongOwner?h(99):recoveryCommitment(secret,root),signingRoot:root,destination:a(5),
 deployment:{addresses:{kernel:a(1)},revision:4n,manifestHash:h(1)}};}}));
vi.mock('./hash-account-deployment',()=>({prepareHashAccountDeployment:async()=>({factory:a(3),account:f.sameAccount?a(5):a(4),manifestHash:h(f.wrongManifest?2:1)})}));
beforeEach(()=>Object.assign(f,{changed:false,reads:0,wrongOwner:false,sameAccount:false,wrongManifest:false}));
const input=()=>({network:{} as OwnerChainNetwork,identity:h(2),expectedBreakOrigin:a(2),destinationSigningSeed:destination,
 recoverySecret:secret,recoverySigningSeed:seed,persistBeforePublishing:vi.fn(async()=>{})});
it('publishes only a durably retained exact replacement account under the current hash authority',async()=>{
 const i=input(),result=await prepareReplacementDeploymentRequest(i);
 expect(result).toMatchObject({kind:'replacement',kernel:a(1),revision:'4',nonce:1,account:a(4)});
 expect(i.persistBeforePublishing).toHaveBeenCalledWith({account:a(4),breakOrigin:a(2),nonce:1,digest:replacementDeploymentDigest(result)});
 expect(parseAccountDeploymentRequest(result)).toEqual(result);expect(accountDeploymentDigest(result)).toBe(replacementDeploymentDigest(result));
 const {slh_dsa_sha2_128s}=await import('@noble/post-quantum/slh-dsa.js');
 const bytes=(s:string)=>new Uint8Array(Buffer.from(s.slice(2),'hex'));
 expect(slh_dsa_sha2_128s.verify(bytes(result.signature),bytes(accountDeploymentDigest(result)),bytes(result.publicKey))).toBe(true);
 expect(slh_dsa_sha2_128s.verify(bytes(result.signature),bytes(accountDeploymentDigest({...result,account:a(9)})),bytes(result.publicKey))).toBe(false);
 expect(hexlify(secret)).toBe(`0x${'01'.repeat(32)}`);expect(hexlify(seed)).toBe(`0x${'02'.repeat(32)}`);
 expect(()=>parseAccountDeploymentRequest({...result,proof:[]})).toThrow('invalid');expect(()=>parseAccountDeploymentRequest({...result,nonce:0})).toThrow('invalid');
});
it('changed owner state, same destination, another manifest, aliased material and failed persistence publish nothing',async()=>{
 for(const field of ['wrongOwner','sameAccount','wrongManifest','changed'] as const){f[field]=true;f.reads=0;
  await expect(prepareReplacementDeploymentRequest(input())).rejects.toThrow(/replacement_deployment_/);f[field]=false;}
 await expect(prepareReplacementDeploymentRequest({...input(),destinationSigningSeed:seed})).rejects.toThrow('material_invalid');
 await expect(prepareReplacementDeploymentRequest({...input(),persistBeforePublishing:async()=>{throw Error('disk unavailable');}})).rejects.toThrow('disk unavailable');
}, 20000);

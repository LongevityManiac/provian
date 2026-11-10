import { it, expect, vi } from 'vitest';
import { AbiCoder, ZeroHash, hexlify, keccak256, sha256 } from 'ethers';
import { prepareBreakRecovery, readBreakRecoveryContext, BREAK_RECOVERY_ABI as abi, type BreakRecoveryBackup } from './break-recovery';
import { recoverySigningRoot, recoveryCommitment } from './recourse-hash-authorization';
import { OWNER_EXECUTOR_ABI } from './recourse-owner-operation';
import { parseBreakRestorationRequest, breakRestorationDetails, breakRestorationId } from './break-restoration-data';
import { recoverFreeBreak } from './free-break-recovery';
import { breakDeploymentDigest } from './break-deployment-data';
import { breakRegistrationId } from './break-registration-data';
import { prepareHashAccountDeployment } from './hash-account-deployment';
import { verifyBreakRecoveryReceipt } from './break-recovery-receipt';
vi.mock('./hash-account-deployment', () => ({ prepareHashAccountDeployment:vi.fn() }));
vi.mock('./break-recovery-receipt', () => ({ verifyBreakRecoveryReceipt:vi.fn() }));
import { PROTOCOL_COMPONENTS, type ProtocolComponent, type ProtocolDeployment } from './protocol-pointer';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const coder=AbiCoder.defaultAbiCoder(),kernel=a(1),executor=a(2),origin=a(3),predecessor=a(4),destination=a(5),authority=a(6),identity=h(1);
async function fixture(){
 const recoverySecret=new Uint8Array(32).fill(10),recoverySigningSeed=new Uint8Array(32).fill(11),destinationSigningSeed=new Uint8Array(32).fill(12),nextRecoverySecret=new Uint8Array(32).fill(13),nextRecoverySigningSeed=new Uint8Array(32).fill(14);
 const signingRoot=await recoverySigningRoot(recoverySigningSeed),destinationRoot=await recoverySigningRoot(destinationSigningSeed),commitment=recoveryCommitment(recoverySecret,signingRoot);
 const leaf=sha256(coder.encode(['string','address','uint256','bytes32','uint256','bytes32'],['Provian restoration',predecessor,100,identity,50,commitment]));
 const deployment:ProtocolDeployment={pointer:a(7),revision:2n,manifestHash:h(8),blockHash:h(9),runtimeHashes:[],addresses:Object.fromEntries(PROTOCOL_COMPONENTS.map(k=>[k,kernel])) as Record<ProtocolComponent,string>};
 const state={origin,registered:false,disagree:false,badRoot:false,badDestination:false,reused:false,digestMismatch:false};
 const rpcs=[0,1].map(index=>({request:async(method:string,params:readonly unknown[]):Promise<unknown>=>{
  if(state.disagree&&index===1)return '0x00';if(method==='eth_getCode')return '0x6000';
  const call=abi.parseTransaction({data:(params[0] as {data:string}).data})!;
  const values:Record<string,unknown>={ownerAuthorization:executor,restorationAuthority:authority,kernel,breakOrigin:state.origin,predecessor,lastGoodBlock:100,restorationRoot:state.badRoot?h(10):leaf,hashAccountCodeHash:keccak256('0x6000'),restoredIdentity:false,keyCommitment:state.badDestination?h(11):destinationRoot,ownerRecoveryCommitment:state.registered?commitment:ZeroHash,ownerSigningRoot:signingRoot,ownerAuthorizationNonce:0,ownerUsedSigningRoot:state.reused,ownerUsedRecoveryCommitment:false};
  if(call.name==='ownerAuthorizationDigest')return abi.encodeFunctionResult(call.name,[state.digestMismatch?h(12):sha256(coder.encode(['string','uint256','address','bytes32','bytes32','uint256','bytes32','bytes32','bytes32'],['Provian restoration owner authorization',8453,kernel,identity,commitment,0,call.args[1],call.args[2],call.args[3]]))]);
  if(!(call.name in values))throw Error('unexpected '+call.name);return abi.encodeFunctionResult(call.name,[values[call.name]]);
 }}));
 const persist=vi.fn(async(_backup:BreakRecoveryBackup)=>{});
 return {state,commitment,signingRoot,persist,input:{network:{rpcs:rpcs as [typeof rpcs[number],typeof rpcs[number]],deployment:async()=>deployment},entitlement:{identity,amount:'50',commitment,proof:[]},recoverySecret,recoverySigningSeed,destination,destinationSigningSeed,nextRecoverySecret,nextRecoverySigningSeed,persistBeforePublishing:persist}};
}
it('prepares exact registration without a curve signature or membership and saves replacement material first',async()=>{
 const f=await fixture(),result=await prepareBreakRecovery(f.input);expect(result.phase).toBe('register_owner');expect(f.persist).toHaveBeenCalledOnce();
 const call=abi.parseTransaction({data:result.data})!;expect(call.name).toBe('registerBreakOwner');expect(call.args[0]).toBe(identity);expect(call.args[1]).toBe(50n);expect(call.args[2]).toBe(hexlify(f.input.recoverySecret));expect(result).not.toHaveProperty('destinationSigningSeed');
 f.persist.mockRejectedValueOnce(Error('backup unavailable'));await expect(prepareBreakRecovery(f.input)).rejects.toThrow('backup unavailable');
});
it('binds destination, snapshot and next commitment to the independently checked on-chain digest',async()=>{
 const f=await fixture();f.state.registered=true;const result=await prepareBreakRecovery(f.input),call=OWNER_EXECUTOR_ABI.parseTransaction({data:result.data})!;
 expect(result.phase).toBe('restore_balance');expect(call.args.identity).toBe(identity);
 const payload=coder.decode(['uint8','bytes'],call.args.payload);expect(payload[0]).toBe(1n);
 const restored=coder.decode(['tuple(bytes32,uint256,bytes32,address,bytes32,bytes32[])'],payload[1])[0];expect(restored[1]).toBe(50n);expect(restored[2]).toBe(f.commitment);expect(String(restored[3]).toLowerCase()).toBe(destination);
 expect(call.args.proof.signingRoot).toBe(f.signingRoot);expect(sha256(call.args.proof.publicKey)).toBe(f.signingRoot);expect(f.persist).toHaveBeenCalledOnce();expect(f.persist.mock.calls[0][0]).toMatchObject({operationHash:call.args.operationHash});
 const request=parseBreakRestorationRequest({kernel:result.kernel,ownerIntent:result.ownerIntent,data:result.data});
 expect(breakRestorationDetails(request)).toMatchObject({identity,destination,amount:'50',commitment:f.commitment});
 expect(breakRestorationId(request)).toMatch(/^0x[0-9a-f]{64}$/);
 expect(()=>parseBreakRestorationRequest({...request,data:request.data+'00'})).toThrow('invalid');
 const substitute=OWNER_EXECUTOR_ABI.encodeFunctionData('execute',[call.args.identity,call.args.operationHash,call.args.proof,coder.encode(['uint8','bytes'],[2,'0x'])]);
 expect(()=>parseBreakRestorationRequest({...request,data:substitute})).toThrow('invalid');
 expect(()=>parseBreakRestorationRequest({...request,authority:authority})).toThrow('invalid');
});
it('refuses forged entitlement, wrong destination, reused keys, RPC disagreement and digest substitution before publication',async()=>{
 const f=await fixture();f.state.registered=true;
 for(const key of ['badRoot','badDestination','reused','disagree','digestMismatch'] as const){f.state[key]=true;await expect(prepareBreakRecovery(f.input)).rejects.toThrow();f.state[key]=false;}
 await expect(prepareBreakRecovery({...f.input,destinationSigningSeed:f.input.recoverySecret})).rejects.toThrow('not_independent');expect(f.persist).not.toHaveBeenCalled();
});
it('Buffer inputs remain owned by the caller while retained callback copies are wiped on success and failure',async()=>{
 const f=await fixture();
 const keys=['recoverySecret','recoverySigningSeed','destinationSigningSeed','nextRecoverySecret','nextRecoverySigningSeed'] as const;
 for(const key of keys)f.input[key]=Buffer.from(f.input[key]);
 const originals=keys.map(key=>hexlify(f.input[key]));
 await prepareBreakRecovery(f.input);
 expect(keys.map(key=>hexlify(f.input[key]))).toEqual(originals);
 const backup=f.persist.mock.calls[0][0];
 expect([backup.destinationSigningSeed,backup.nextRecoverySecret,backup.nextRecoverySigningSeed].every(seed=>seed.every(b=>b===0))).toBe(true);
 f.state.registered=true;f.state.badRoot=true;
 await expect(prepareBreakRecovery(f.input)).rejects.toThrow('entitlement_invalid');
 expect(keys.map(key=>hexlify(f.input[key]))).toEqual(originals);
});

it('scopes a recovery journal to the independently authenticated break origin',async()=>{
 const f=await fixture();expect(await readBreakRecoveryContext(f.input.network)).toBe(origin);
 f.state.disagree=true;await expect(readBreakRecoveryContext(f.input.network)).rejects.toThrow('disagreement');
});

it('refuses a new break with a reused commitment before writing into a previously selected journal',async()=>{
 const f=await fixture();const expectedBreakOrigin=await readBreakRecoveryContext(f.input.network);
 f.state.origin=a(99); // Publisher changes break context between store lookup and proof preparation.
 await expect(prepareBreakRecovery({...f.input,expectedBreakOrigin})).rejects.toThrow('context_changed');
 expect(f.persist).not.toHaveBeenCalled();
});

it('runs free deployment, registration and authority restoration and verifies the finalized outcome independently', async () => {
 const f=await fixture(), publicKey=h(15), signingRoot=sha256(publicKey);
 const deployment={kind:'deploy' as const,breakOrigin:origin,factory:a(77),account:destination,initialRoot:h(16),identity,amount:'50',
  commitment:f.commitment,proof:[],recoverySecret:h(10),signingRoot,publicKey,signature:`0x${'11'.repeat(7856)}`};
 vi.mocked(prepareHashAccountDeployment).mockResolvedValue({deployed:true,account:destination,factory:a(77)} as Awaited<ReturnType<typeof prepareHashAccountDeployment>>);
 vi.mocked(verifyBreakRecoveryReceipt).mockResolvedValue();
 const transport={request:vi.fn(async(path:string,body?:unknown)=>{
  if(path==='break-deployments')return {id:breakDeploymentDigest(deployment),status:'confirmed',transactionHash:null};
  if(path==='break-registrations'){f.state.registered=true;return {id:breakRegistrationId({deployment,kernel}),status:'confirmed',transactionHash:h(88)};}
  if(path==='break-restorations')return {id:breakRestorationId(parseBreakRestorationRequest(body)),status:'confirmed',transactionHash:h(89)};
  throw Error('unexpected path');
 })};
 const callbacks={network:f.input.network,transport,prepareDeployment:async()=>deployment,
  prepareRecovery:async()=>prepareBreakRecovery(f.input)};
 const result=await recoverFreeBreak(callbacks);
 expect(result.transactionHash).toBe(h(89));expect(result.prepared.phase).toBe('restore_balance');
 expect(transport.request.mock.calls.map(call=>call[0])).toEqual(['break-deployments','break-registrations','break-restorations']);
 expect(verifyBreakRecoveryReceipt).toHaveBeenCalledWith(result.prepared,h(89),f.input.network);
 vi.mocked(verifyBreakRecoveryReceipt).mockRejectedValueOnce(Error('independent_receipt_refused'));
 await expect(recoverFreeBreak(callbacks)).rejects.toThrow('independent_receipt_refused');
 vi.mocked(prepareHashAccountDeployment).mockResolvedValue({deployed:false,account:destination,factory:a(77)} as Awaited<ReturnType<typeof prepareHashAccountDeployment>>);
 await expect(recoverFreeBreak(callbacks)).rejects.toThrow('deployment_unverified');
 const aborted=new AbortController();aborted.abort();
 await expect(recoverFreeBreak({...callbacks,signal:aborted.signal})).rejects.toThrow('cancelled');
}, 15000);

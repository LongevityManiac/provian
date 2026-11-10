import { packetFixture } from './__test-helpers__/determination-fixture';
import { address,hash } from './__test-helpers__/restoration-evidence-fixture';
import { assessRestoration } from './determination';
import { DETERMINATION_EXECUTION_READ_ABI as readAbi,prepareDeterminationExecution,prepareRestorationAllocation,prepareRecordedPoolExecution,verifyRecourseExecution,type DeterminationExecutionPort } from './determination-execution';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { protocolDeploymentFixture } from '../../__test-helpers__/protocol-fixture';
async function fixture(){
 const f=await packetFixture(),value=assessRestoration(f.packet,f.judgment),registry=address(80),executor=address(81),authority=address(82),gas=address(83),attestor=address(84),pool=address(85);
 const deployment={...protocolDeploymentFixture,manifestHash:hash(86),revision:2n,addresses:{...protocolDeploymentFixture.addresses,kernel:f.snapshot.kernel,recoursePool:pool}};
 const state={sequence:1,revision:0,executed:false};
 const port:DeterminationExecutionPort={deployment:async()=>deployment,bindingLog:async()=>0,agree:jest.fn(async(_method,params)=>{
  const call=params[0] as {to:string;data:string;from?:string};
  if(call.from)return '0x';
  const abi=call.to===pool?RECOURSE_POOL_ABI:readAbi;
  const parsed=abi.parseTransaction({data:call.data})!;
  const values:Record<string,readonly unknown[]>={registryOperator:[registry],ownerAuthorization:[executor],restorationAuthority:[authority],submitter:[gas],identityAttestor:[attestor],outgoingSequence:[state.sequence],outcomeRevision:[state.revision],reversalExecuted:[state.executed],restorationIntent:[f.ticket],reversalEvidence:[[f.ticket.identity,100,hash(99)]]};
  return abi.encodeFunctionResult(parsed.name,values[parsed.name]);
 })};
 return {...f,value,port,state,deployment,registry,executor,authority,gas,attestor,pool};
}
test('a checked determination derives separate exact attestation, authority reversal and pro-rata allocation calls',async()=>{
 const f=await fixture(),signDigest=jest.fn(async()=>`0x${'11'.repeat(65)}`);
 const attestation=await prepareDeterminationExecution(f.value,'attest',{address:f.attestor,signDigest},f.port);
 expect(attestation).toMatchObject({executor:f.registry,signer:f.gas,kind:'attest'});expect(signDigest).toHaveBeenCalledTimes(1);
 const reverse=await prepareDeterminationExecution(f.value,'reverse',undefined,f.port);
 expect(reverse).toMatchObject({executor:f.executor,signer:f.authority,requests:[f.ticket.request]});
 expect(reverse.checks.length).toBeGreaterThan(2);
 const allocation=await prepareRestorationAllocation([f.value],f.port);
 expect(allocation).toMatchObject({executor:f.pool,signer:f.authority,kind:'allocate'});
 const decoded=RECOURSE_POOL_ABI.parseTransaction({data:allocation.calldata})!;
 expect(decoded.args.accepted[0].shortfall).toBe(100n);
 expect(Object.isFrozen(reverse)).toBe(true);
});
test('stale movement, changed pool revision, wrong attestor and copied capabilities cannot authorize signing',async()=>{
 const f=await fixture();
 const plan=await prepareDeterminationExecution(f.value,'reverse',undefined,f.port);
 await expect(verifyRecourseExecution({...plan},f.port)).rejects.toThrow('unverified');
 f.state.sequence=2;await expect(verifyRecourseExecution(plan,f.port)).rejects.toThrow('stale');
 f.state.sequence=1;f.state.revision=1;await expect(verifyRecourseExecution(plan,f.port)).rejects.toThrow('stale');
 f.state.revision=0;
 const signDigest=jest.fn(async()=>'0x11');
 await expect(prepareDeterminationExecution(f.value,'attest',{address:f.authority,signDigest},f.port)).rejects.toThrow('attestor_invalid');
 expect(signDigest).not.toHaveBeenCalled();
 await expect(prepareRestorationAllocation([f.value,f.value],f.port)).rejects.toThrow('duplicate');
 await expect(prepareDeterminationExecution(f.value,'record',undefined,f.port)).rejects.toThrow('batch_required');
});

test('post-reversal recovery uses the immutable consumed scope and chain result, not a rewritten or re-priced trace',async()=>{
 const f=await fixture();
 await expect(prepareRecordedPoolExecution(f.db,[f.ticket.request],'allocate',f.port)).rejects.toThrow('result_invalid');
 f.state.executed=true;
 const plan=await prepareRecordedPoolExecution(f.db,[f.ticket.request],'allocate',f.port);
 const decoded=RECOURSE_POOL_ABI.parseTransaction({data:plan.calldata})!;
 expect(decoded.args.accepted[0].shortfall).toBe(100n);expect(decoded.args.accepted[0].evidenceHash).toBe(hash(99));
 f.fake.store.set(f.path,{...f.fake.store.get(f.path),snapshot:{...f.snapshot,lossAtomic:'101'}});
 await expect(prepareRecordedPoolExecution(f.db,[f.ticket.request],'allocate',f.port)).rejects.toThrow('result_invalid');
});

import { packetFixture } from './__test-helpers__/determination-fixture';
import { address,hash } from './__test-helpers__/restoration-evidence-fixture';
import { assessRestoration } from './determination';
import { DETERMINATION_EXECUTION_READ_ABI as readAbi,prepareDeterminationExecution,prepareRestorationAllocation,prepareRecordedPoolExecution,verifyRecourseExecution,type DeterminationExecutionPort } from './determination-execution';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { protocolDeploymentFixture } from '../../__test-helpers__/protocol-fixture';
async function fixture(){
 const f=await packetFixture(),value=assessRestoration(f.packet,f.judgment),registry=address(80),executor=address(81),authority=address(82),gas=address(83),attestor=address(84),pool=address(85);
 const deployment={...protocolDeploymentFixture,manifestHash:hash(86),revision:2n,addresses:{...protocolDeploymentFixture.addresses,kernel:f.snapshot.kernel,recoursePool:pool}};
 const state={sequence:1,revision:0,executed:false,approved:true};
 const port:DeterminationExecutionPort={deployment:async()=>deployment,bindingLog:async()=>0,agree:jest.fn(async(_method,params)=>{
  const call=params[0] as {to:string;data:string;from?:string};
  if(call.from)return '0x';
  const abi=call.to===pool?RECOURSE_POOL_ABI:readAbi;
  const parsed=abi.parseTransaction({data:call.data})!;
  const values:Record<string,readonly unknown[]>={approvedLossEligibility:[state.approved],registryOperator:[registry],ownerAuthorization:[executor],restorationAuthority:[authority],submitter:[gas],identityAttestor:[attestor],outgoingSequence:[state.sequence],outcomeRevision:[state.revision],reversalExecuted:[state.executed],restorationIntent:[f.ticket],reversalEvidence:[[f.ticket.identity,100,hash(99)]]};
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

test('membership admission signs the exact pool domain and consumed loss before any reserve allocation',async()=>{
 const f=await fixture();f.state.executed=true;f.state.approved=false;
 const signDigest=jest.fn(async()=>`0x${'22'.repeat(65)}`);
 const plan=await prepareRecordedPoolExecution(f.db,[f.ticket.request],'eligibility',f.port,{address:f.attestor,signDigest},f.ticket.request);
 const parsed=RECOURSE_POOL_ABI.parseTransaction({data:plan.calldata})!;
 expect(parsed.name).toBe('admitLossEligibility');
 expect(parsed.args.evidence.determination.toObject()).toMatchObject({request:f.ticket.request,shortfall:100n,expectedRevision:0n});
 expect(plan.signer).toBe(f.gas);
 const {AbiCoder,sha256,Wallet,getBytes,verifyMessage}=await import('ethers');
 const tuple=RECOURSE_POOL_ABI.getFunction('admitLossEligibility')!.inputs[0];
 const message=sha256(AbiCoder.defaultAbiCoder().encode(['string','uint256','address','address','address',tuple],
  ['Provian private membership at loss',8453,f.deployment.pointer,f.snapshot.kernel,f.pool,parsed.args.evidence]));
 expect(signDigest).toHaveBeenCalledWith(message);
 const key=Wallet.createRandom(),signature=await key.signMessage(getBytes(message));
 expect(verifyMessage(getBytes(message),signature)).toBe(key.address);
 await expect(prepareRecordedPoolExecution(f.db,[f.ticket.request],'allocate',f.port)).rejects.toThrow('membership_attestation_required');
 f.state.approved=true;
 expect((await prepareRecordedPoolExecution(f.db,[f.ticket.request],'allocate',f.port)).checks).toEqual(expect.arrayContaining([
  expect.objectContaining({data:expect.stringMatching(/^0x/),expected:RECOURSE_POOL_ABI.encodeFunctionResult('approvedLossEligibility',[true])})]));
 await expect(prepareRecordedPoolExecution(f.db,[f.ticket.request],'eligibility',f.port,{address:f.authority,signDigest},f.ticket.request)).rejects.toThrow('attestor_invalid');
 expect(signDigest).toHaveBeenCalledTimes(1);
});

test('missing historical membership evidence cannot be replaced by default log positions',async()=>{
 const f=await fixture();f.state.executed=true;
 const row=f.fake.store.get(f.path)!,membership={...(row.membership as Record<string,unknown>)};
 delete membership.admissionLogIndex;
 const {createHash}=await import('crypto');
 const ticket={...f.ticket,lossHash:`0x${createHash('sha256').update(JSON.stringify({snapshot:f.snapshot,membership})).digest('hex')}`};
 const original=f.port.agree;
 f.port.agree=async(method,params)=>{
  const call=params[0] as {data:string;from?:string};
  if(!call.from&&call.data.startsWith(readAbi.getFunction('restorationIntent')!.selector))return readAbi.encodeFunctionResult('restorationIntent',[ticket]);
  return original(method,params);
 };
 f.fake.store.set(f.path,{...row,membership});
 const signDigest=jest.fn(async()=>'0x11');
 await expect(prepareRecordedPoolExecution(f.db,[f.ticket.request],'eligibility',f.port,{address:f.attestor,signDigest},f.ticket.request)).rejects.toThrow('membership_evidence_missing');
 expect(signDigest).not.toHaveBeenCalled();
});

test('same-owner cohort admissions use the same sorted revision offsets as allocation',async()=>{
 const f=await fixture();f.state.executed=true;
 const second=hash(95),row=f.fake.store.get(f.path)!;
 const snapshot={...f.snapshot,occurrence:second};
 const {createHash}=await import('crypto');
 const ticket={...f.ticket,request:second,lossHash:`0x${createHash('sha256').update(JSON.stringify({snapshot,membership:row.membership})).digest('hex')}`};
 f.fake.store.set(f.path.replace(f.ticket.request,second),{...row,snapshot});
 const original=f.port.agree;
 f.port.agree=async(method,params)=>{
  const call=params[0] as {to:string;data:string;from?:string};
  if(!call.from&&call.data.startsWith(readAbi.getFunction('restorationIntent')!.selector)){
   const request=readAbi.decodeFunctionData('restorationIntent',call.data)[0];
   return readAbi.encodeFunctionResult('restorationIntent',[request===second?ticket:f.ticket]);
  }
  return original(method,params);
 };
 const requests=[second,f.ticket.request],ordered=[...requests].sort();
 const signDigest=async()=>`0x${'33'.repeat(65)}`;
 for(const request of requests){
  const plan=await prepareRecordedPoolExecution(f.db,requests,'eligibility',f.port,{address:f.attestor,signDigest},request);
  const d=RECOURSE_POOL_ABI.parseTransaction({data:plan.calldata})!.args.evidence.determination;
  expect(d.expectedRevision).toBe(BigInt(ordered.indexOf(request)));
 }
 const allocation=await prepareRecordedPoolExecution(f.db,requests,'allocate',f.port);
 const records=RECOURSE_POOL_ABI.parseTransaction({data:allocation.calldata})!.args.accepted;
 expect(records.map((record:{request:string;expectedRevision:bigint})=>[record.request,record.expectedRevision])).toEqual(ordered.map((request,i)=>[request,BigInt(i)]));
});

import { createHash } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { RESTORATION_REQUESTS } from './restoration-request';
import type { LossSnapshot } from './loss-snapshot';
import { readHistoricalBindingLog, HISTORICAL_BINDING_ABI } from './restoration-binding-log';
import type { LossMembershipEvidence } from './membership-at-loss';
import { utcCalendarMonth } from './calendar-month';
import { Interface } from 'ethers';
import { currentProtocolDeployment } from '../protocol/runtime';
import type { ProtocolDeployment } from '../protocol/pointer';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { getAgreedBaseLogs,readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { assertCheckedDetermination,type CheckedDetermination } from './determination';
import { determinationPlan,RESTORATION_EXECUTION_ABI } from './determination-plan';
import { RECOURSE_POOL_ABI } from './pool-abi';
import type { RecourseExecutionCall } from './execution-transaction';
export const DETERMINATION_EXECUTION_READ_ABI=new Interface(['function registryOperator() view returns(address)','function restorationAuthority() view returns(address)',
 'function ownerAuthorization() view returns(address)','function identityAttestor() view returns(address)',
 'function boundBlock(address) view returns(uint256)','function outgoingSequence(address) view returns(uint256)',
 'function reversalExecuted(bytes32) view returns(bool)','function determined(bytes32) view returns(bool)',
 'function submitter() view returns(address)',
 'function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))',
 'function reversalEvidence(bytes32) view returns(tuple(bytes32 identity,uint256 shortfall,bytes32 evidenceHash))',
 'event OwnershipBound(bytes32 indexed identity,address indexed account,address indexed kernel,bytes32 recoveryCommitment,bytes32 signingRoot,bytes32 digest)',
 'event RecoveredAddressBound(bytes32 indexed identity,address indexed account,address indexed kernel)']);
export interface DeterminationExecutionPort {
 deployment():Promise<ProtocolDeployment>;
 agree(method:string,params:readonly unknown[]):Promise<unknown>;
 bindingLog(value:CheckedDetermination,registry:string):Promise<number>;
}
export function createDeterminationExecutionPort():DeterminationExecutionPort {
 const legs=getOperatorBoundRpcLegs('base');
 if(legs[0].operatorId===legs[1].operatorId)throw Error('recourse_rpc_operators_not_independent');
 const agree=async(method:string,params:readonly unknown[])=>{
  const values:unknown[]=await Promise.all(legs.map(leg=>leg.provider.send(method,[...params])));
  if(!rpcChainFactsEqual(values[0],values[1]))throw Error('recourse_execution_rpc_disagreement');return values[0];
 };
 return {deployment:currentProtocolDeployment,agree,bindingLog:async value=>readHistoricalBindingLog(value.packet.snapshot, {
  call:async(target,method,args,pin)=>{
   const raw=await agree('eth_call',[{to:target,data:HISTORICAL_BINDING_ABI.encodeFunctionData(method,args)},{blockHash:pin,requireCanonical:true}]);
   if(typeof raw!=='string')throw Error('recourse_execution_reply_invalid');
   return HISTORICAL_BINDING_ABI.decodeFunctionResult(method,raw)[0];
  },
  logs:(registry,identity,account,block)=>getAgreedBaseLogs({address:registry,topics:[
   ['OwnershipBound','RecoveredAddressBound'].map(name=>HISTORICAL_BINDING_ABI.getEvent(name)!.topicHash),identity,`0x${account.slice(2).padStart(64,'0')}`],fromBlock:block,toBlock:block}),
  blockHash:readAgreedBaseBlockHash,
 })};
}
interface ExecutionCheck { readonly target:string; readonly data:string; readonly expected:string; }
export interface CheckedRecourseExecution extends RecourseExecutionCall {
 readonly requests:readonly string[]; readonly checks:readonly ExecutionCheck[];
}
const checked=new WeakSet<CheckedRecourseExecution>();
export function assertCheckedRecourseExecution(value:CheckedRecourseExecution):void {
 if(!checked.has(value))throw Error('recourse_execution_unverified');
}
async function executionContext(port:DeterminationExecutionPort){
 const deployment=await port.deployment(),tag={blockHash:deployment.blockHash,requireCanonical:true};
 const call=async(target:string,abi:Interface,method:string,args:readonly unknown[]=[])=>{
  const raw=await port.agree('eth_call',[{to:target,data:abi.encodeFunctionData(method,args)},tag]);
  if(typeof raw!=='string')throw Error('recourse_execution_reply_invalid');return abi.decodeFunctionResult(method,raw);
 };
 const kernel=deployment.addresses.kernel.toLowerCase(),pool=deployment.addresses.recoursePool.toLowerCase();
 const [registry,executor,authority,submitter]=await Promise.all([
  call(kernel,DETERMINATION_EXECUTION_READ_ABI,'registryOperator'),call(kernel,DETERMINATION_EXECUTION_READ_ABI,'ownerAuthorization'),call(kernel,DETERMINATION_EXECUTION_READ_ABI,'restorationAuthority'),
  call(deployment.addresses.settlement,DETERMINATION_EXECUTION_READ_ABI,'submitter')]);
 return {deployment,tag,call,kernel,pool,registry:String(registry[0]).toLowerCase(),executor:String(executor[0]).toLowerCase(),
  authority:String(authority[0]).toLowerCase(),submitter:String(submitter[0]).toLowerCase()};
}
/** Freeze exact state checks with derived calldata. No arbitrary target/data or
 * member-provided source list can create this signing capability. */
async function seal(call:RecourseExecutionCall,requests:readonly string[],checks:ExecutionCheck[],port:DeterminationExecutionPort):Promise<CheckedRecourseExecution>{
 for(const value of [call.executor,call.signer])if(!/^0x[0-9a-f]{40}$/.test(value)||/^0x0+$/.test(value))throw Error('recourse_execution_domain_invalid');
 const result={...call,requests:Object.freeze([...requests]),checks:Object.freeze(checks.map(check=>Object.freeze(check)))};
 Object.freeze(result);checked.add(result);await verifyRecourseExecution(result,port);return result;
}
export async function verifyRecourseExecution(value:CheckedRecourseExecution,port:DeterminationExecutionPort=createDeterminationExecutionPort()):Promise<void>{
 assertCheckedRecourseExecution(value);
 const deployment=await port.deployment();
 if(deployment.manifestHash!==value.manifestHash)throw Error('recourse_execution_retired');
 const tag={blockHash:deployment.blockHash,requireCanonical:true};
 for(const check of value.checks){
  const result=await port.agree('eth_call',[{to:check.target,data:check.data},tag]);
  if(result!==check.expected)throw Error('recourse_execution_stale');
 }
 const simulation=await port.agree('eth_call',[{from:value.signer,to:value.executor,data:value.calldata,value:'0x0'},tag]);
 if(typeof simulation!=='string'||!/^0x([0-9a-f]{2})*$/i.test(simulation))throw Error('recourse_execution_simulation_invalid');
 if((await port.deployment()).manifestHash!==value.manifestHash)throw Error('recourse_execution_retired');
}
export interface EvidenceAttestor { readonly address:string; signDigest(message:string):Promise<string>; }
export async function prepareDeterminationExecution(value:CheckedDetermination,kind:'attest'|'reverse'|'record'|'decline'|'deliver',
 attestor?:EvidenceAttestor,port:DeterminationExecutionPort=createDeterminationExecutionPort()):Promise<CheckedRecourseExecution>{
 assertCheckedDetermination(value);
 const context=await executionContext(port),{deployment,kernel,pool,registry,executor,authority,submitter,call}=context;
 if(value.packet.evidence.executionKernel!==kernel)throw Error('recourse_execution_retired');
 const bindingLogIndex=await port.bindingLog(value,registry);
 const plan=determinationPlan(value,{revision:deployment.revision,registry,bindingLogIndex});
 const checks:ExecutionCheck[]=[];
 const check=(target:string,abi:Interface,method:string,args:readonly unknown[],expected:readonly unknown[])=>checks.push({target,data:abi.encodeFunctionData(method,args),expected:abi.encodeFunctionResult(method,expected)});
 if(kind!=='deliver')check(pool,RECOURSE_POOL_ABI,'outcomeRevision',[value.packet.ticket.identity],[value.packet.poolRevision]);
 let target:string,calldata:string,signer:string;
 if(kind==='decline'){
  if(plan.accepted)throw Error('recourse_execution_phase_invalid');target=pool;calldata=plan.poolCall;signer=authority;
 }else{
  if(!plan.accepted)throw Error('recourse_execution_phase_invalid');
  if(kind==='attest'||kind==='reverse'){
   check(executor,DETERMINATION_EXECUTION_READ_ABI,'reversalExecuted',[value.packet.request],[false]);
   for(const account of value.packet.evidence.checkpoint.accounts)check(kernel,DETERMINATION_EXECUTION_READ_ABI,'outgoingSequence',[account.address],[account.outgoingSequence]);
  }
  if(kind==='attest'){
   const expected=String((await call(registry,DETERMINATION_EXECUTION_READ_ABI,'identityAttestor'))[0]).toLowerCase();
   if(!attestor||attestor.address!==expected||expected===authority)throw Error('recourse_execution_attestor_invalid');
   const signature=await attestor.signDigest(plan.attestationMessage);
   target=registry;signer=submitter;calldata=RESTORATION_EXECUTION_ABI.encodeFunctionData('admitTheftEvidence',[plan.evidence,signature]);
  }else if(kind==='reverse'){target=executor;signer=authority;calldata=plan.reversalCall;}
  else if(kind==='record'){
   if(!plan.poolCall)throw Error('recourse_execution_batch_required');target=pool;signer=authority;calldata=plan.poolCall;
  }else{
   if(!plan.deliveryCall)throw Error('recourse_execution_phase_invalid');target=pool;signer=submitter;calldata=plan.deliveryCall;
  }
 }
 return seal({kind,executor:target,calldata,signer,manifestHash:deployment.manifestHash,attempt:deployment.blockHash},[value.packet.request],checks,port);
}
/** The operator supplies the complete ready batch from its transactional queue.
 * Same-owner revisions advance in deterministic request order inside one call. */
export async function prepareRestorationAllocation(values:readonly CheckedDetermination[],port:DeterminationExecutionPort=createDeterminationExecutionPort()):Promise<CheckedRecourseExecution>{
 if(values.length===0)throw Error('recourse_execution_batch_empty');
 values.forEach(assertCheckedDetermination);
 const context=await executionContext(port),checks:ExecutionCheck[]=[],counts=new Map<string,bigint>();
 const ordered=[...values].sort((a,b)=>a.packet.request.localeCompare(b.packet.request));
 if(new Set(ordered.map(value=>value.packet.request)).size!==ordered.length)throw Error('recourse_execution_batch_duplicate');
 const records=[];
 for(const value of ordered){
  if(value.packet.evidence.executionKernel!==context.kernel)throw Error('recourse_execution_retired');
  const plan=determinationPlan(value,{revision:context.deployment.revision,registry:context.registry,bindingLogIndex:await port.bindingLog(value,context.registry)});
  if(!plan.accepted||plan.record.shortfall==='0')throw Error('recourse_execution_batch_invalid');
  const identity=value.packet.ticket.identity,prior=counts.get(identity)??0n;
  if(prior===0n)checks.push({target:context.pool,data:RECOURSE_POOL_ABI.encodeFunctionData('outcomeRevision',[identity]),expected:RECOURSE_POOL_ABI.encodeFunctionResult('outcomeRevision',[value.packet.poolRevision])});
  counts.set(identity,prior+1n);records.push({...plan.record,expectedRevision:(BigInt(value.packet.poolRevision)+prior).toString()});
 }
 return seal({kind:'allocate',executor:context.pool,signer:context.authority,manifestHash:context.deployment.manifestHash,attempt:context.deployment.blockHash,
  calldata:RECOURSE_POOL_ABI.encodeFunctionData('determine',[records])},ordered.map(value=>value.packet.request),checks,port);
}

/** Resume after a completed reversal without re-pricing it. The original loss
 * and membership snapshot must still hash to the consumed owner ticket, while
 * the amount/evidence come from the actual immutable on-chain reversal result.
 * This path survives operator crashes between reversal and reserve allocation. */
export async function prepareRecordedPoolExecution(db:Firestore,requests:readonly string[],kind:'allocate'|'record'|'deliver',
 port:DeterminationExecutionPort=createDeterminationExecutionPort()):Promise<CheckedRecourseExecution>{
 if(requests.length===0||new Set(requests).size!==requests.length||requests.some(request=>!/^0x[0-9a-f]{64}$/.test(request))
   ||(kind!=='allocate'&&requests.length!==1))throw Error('recourse_execution_batch_invalid');
 const context=await executionContext(port),checks:ExecutionCheck[]=[],records=[],offsets=new Map<string,bigint>();
 for(const request of [...requests].sort()){
  const stored=await db.collection(RESTORATION_REQUESTS).doc(request).get();
  const snapshot=stored.get('snapshot') as LossSnapshot;
  const membership=stored.get('membership') as LossMembershipEvidence & {lossTimestamp:number};
  if(!stored.exists||!snapshot||!membership||snapshot.occurrence!==request||snapshot.identity!==stored.get('identity')
    ||!membership.active||membership.periodIndex===null)throw Error('recourse_execution_result_missing');
  const [ticketResult,result,executed,revision]=await Promise.all([
    context.call(context.executor,DETERMINATION_EXECUTION_READ_ABI,'restorationIntent',[request]),
    context.call(context.executor,DETERMINATION_EXECUTION_READ_ABI,'reversalEvidence',[request]),
    context.call(context.executor,DETERMINATION_EXECUTION_READ_ABI,'reversalExecuted',[request]),
    context.call(context.pool,RECOURSE_POOL_ABI,'outcomeRevision',[snapshot.identity]),
  ]);
  const ticket=ticketResult[0],outcome=result[0];
  const lossHash=`0x${createHash('sha256').update(JSON.stringify({snapshot,membership})).digest('hex')}`;
  if(!executed[0]||ticket.request!==request||ticket.identity!==snapshot.identity||ticket.lossHash!==lossHash
    ||String(ticket.maximumLoss)!==snapshot.lossAtomic||outcome.identity!==snapshot.identity||outcome.evidenceHash===`0x${'0'.repeat(64)}`
    ||BigInt(outcome.shortfall)>BigInt(ticket.maximumLoss))throw Error('recourse_execution_result_invalid');
  const offset=offsets.get(snapshot.identity)??0n;
  if(kind!=='deliver'&&offset===0n)checks.push({target:context.pool,data:RECOURSE_POOL_ABI.encodeFunctionData('outcomeRevision',[snapshot.identity]),
    expected:RECOURSE_POOL_ABI.encodeFunctionResult('outcomeRevision',[revision[0]])});
  offsets.set(snapshot.identity,offset+1n);
  records.push({request,identity:snapshot.identity,occurrence:snapshot.occurrence,shortfall:String(outcome.shortfall),evidenceHash:String(outcome.evidenceHash),
    expectedRevision:(BigInt(revision[0])+offset).toString(),membershipGeneration:membership.periodIndex+1,lossBlock:snapshot.block,lossMonth:utcCalendarMonth(membership.lossTimestamp)});
 }
 let calldata:string;
 if(kind==='allocate'){
  if(records.some(record=>record.shortfall==='0'))throw Error('recourse_execution_batch_invalid');
  calldata=RECOURSE_POOL_ABI.encodeFunctionData('determine',[records]);
 }else if(kind==='record'){
  if(records[0].shortfall!=='0')throw Error('recourse_execution_batch_required');
  calldata=RECOURSE_POOL_ABI.encodeFunctionData('recordReversalOnly',[records[0]]);
 }else calldata=RECOURSE_POOL_ABI.encodeFunctionData('deliverRestoration',[records[0].request,records[0].identity]);
 return seal({kind,executor:context.pool,calldata,signer:kind==='deliver'?context.submitter:context.authority,
  manifestHash:context.deployment.manifestHash,attempt:context.deployment.blockHash},[...requests].sort(),checks,port);
}

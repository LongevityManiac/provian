import { getBytes, Interface } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { SETTLEMENT_BATCHES_COLLECTION, type SettlementBatchDoc } from '../pvt/wp4/durable-settlement-store';
import { KERNEL_OBSERVATION_ABI } from '../pvt/wp4/settlement-chain-adapter';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { resolveHistoricalProtocolDeployment, type ProtocolDeployment, type PointerRpc } from '../protocol/pointer';
import { PROTOCOL_POINTER_PIN } from '../protocol/pointer-pin.generated';
import { currentProtocolDeployment } from '../protocol/runtime';
import { breakDeploymentChain } from './break-deployment-queue';
import { createRecourseChainPort } from './chain-ledger';
import { readMembershipWiring } from './membership-wiring';
import { readRecoursePoolState } from './pool-state';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { reconcileCurrentPrivateMembership } from './membership-preparation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, planPrivateIssuance, preparePrivateMembershipReservation, type PrivateMembershipAccount } from './private-membership-reservation';
import { PRIVATE_ISSUANCE_BATCHES, PRIVATE_ISSUANCE_ADDRESSES } from './issuance-lock';
import { reconcileAddressIssuance, reconcilePrivateIssuanceSuccession } from './private-issuance-succession';
import { privateIssuanceBatchId, reservePrivateIssuanceBatch, retainPrivateIssuanceSignature,
  type PrivateIssuanceBatchRecord, type PrivateIssuanceBatch, type UnadmittedIssuanceRecipient } from './private-issuance-batch';
import { planSettlementIssuance, type SettlementIssuancePolicy } from './settlement-issuance';
import { MEMBER_SETTLEMENT_ABI, membershipIssuanceSigningHash, type MembershipIssuanceTicket } from './issuance-ticket';
import { configuredIdentityAttestor, assertIdentityAttestation } from './identity-attestor';
import { membershipJournalHash as hash } from './private-membership-journal';
import { utcCalendarMonth } from './calendar-month';

const kernelAbi = new Interface(KERNEL_OBSERVATION_ABI);
const fail = (reason:string):never => { throw Error(`recourse_settlement_execution_${reason}`); };
export async function finalizedIssuanceDeployment(): Promise<{ deployment:ProtocolDeployment;block:number;timestamp:number }> {
  const chain=createRecourseChainPort(),block=await chain.finalizedBlock(),blockHash=await chain.blockHash(block);
  const { address,runtimeHash }=PROTOCOL_POINTER_PIN;
  if(!address||!runtimeHash||!blockHash)return fail('pointer');
  const legs=getOperatorBoundRpcLegs('base');
  if(!legs[0].operatorId||!legs[1].operatorId||legs[0].operatorId===legs[1].operatorId)return fail('operators');
  const rpcs:readonly [PointerRpc,PointerRpc]=[{request:(m,p)=>legs[0].provider.send(m,[...p])},{request:(m,p)=>legs[1].provider.send(m,[...p])}];
  const deployment=await resolveHistoricalProtocolDeployment(rpcs,address,runtimeHash,block,blockHash);
  const timestamp=await blockTimestamp(deployment,block);
  if((await currentProtocolDeployment({ fresh: true })).manifestHash!==deployment.manifestHash)return fail('publication_pending');
  return {deployment,block,timestamp};
}
async function blockTimestamp(deployment:ProtocolDeployment,expectedBlock?:number):Promise<number>{
  const chain=breakDeploymentChain();
  const header=await chain.agree('eth_getBlockByHash',[deployment.blockHash,false]);
  if(!header||typeof header!=='object'||!('hash'in header)||header.hash!==deployment.blockHash
    ||!('number'in header)||typeof header.number!=='string'||!/^0x[0-9a-f]+$/i.test(header.number)
    ||!('timestamp'in header)||typeof header.timestamp!=='string'||!/^0x[0-9a-f]+$/i.test(header.timestamp))return fail('block');
  const block=Number(BigInt(header.number)),timestamp=Number(BigInt(header.timestamp));
  if(!Number.isSafeInteger(block)||!Number.isSafeInteger(timestamp)||(expectedBlock!==undefined&&block!==expectedBlock))return fail('block');
  const canonical=await chain.agree('eth_getBlockByNumber',[header.number,false]);
  if(!canonical||typeof canonical!=='object'||!('hash'in canonical)||canonical.hash!==deployment.blockHash)return fail('reorg');
  return timestamp;
}
async function epochPolicy(batch:SettlementBatchDoc,deployment:ProtocolDeployment):Promise<SettlementIssuancePolicy>{
  const chain=breakDeploymentChain(),kernel=deployment.addresses.kernel.toLowerCase();
  const raw=await chain.agree('eth_call',[{to:kernel,data:kernelAbi.encodeFunctionData('getEpochPolicy',[batch.epoch])},{blockHash:deployment.blockHash,requireCanonical:true}]);
  if(typeof raw!=='string')return fail('policy');
  const p=kernelAbi.decodeFunctionResult('getEpochPolicy',raw)[0];
  if(p.opened!==true||String(p.epoch)!==String(batch.epoch)||String(p.policyHash).toLowerCase()!==batch.policy_hash)return fail('policy');
  return {kernel,epoch:String(p.epoch),policyHash:String(p.policyHash).toLowerCase(),mintRateAtomic:String(p.mintRate),agentFoundationBps:String(p.agentFoundationBps)};
}
async function publicBinding(account:string,deployment:ProtocolDeployment):Promise<string>{
  const raw=await breakDeploymentChain().agree('eth_call',[{to:deployment.addresses.recoursePool,data:RECOURSE_POOL_ABI.encodeFunctionData('ownerOf',[account])},{blockHash:deployment.blockHash,requireCanonical:true}]);
  if(typeof raw!=='string')return fail('binding');
  return String(RECOURSE_POOL_ABI.decodeFunctionResult('ownerOf',raw)[0]).toLowerCase();
}

/** Recheck before and after signing. Changed month, publication, recovery or
 * consent requires durable cancellation; it never silently reprices a ticket. */
export async function assertCurrentPrivateIssuance(db:Firestore,record:PrivateIssuanceBatchRecord,gasPayer:string):Promise<{deployment:ProtocolDeployment;identityAttestor:string}>{
  const batch=record.batch,deployment=await currentProtocolDeployment(),chain=breakDeploymentChain();
  if(!['reserved','signed'].includes(record.status)||batch.domain.pointer!==deployment.pointer.toLowerCase()
    ||batch.domain.kernel!==deployment.addresses.kernel.toLowerCase()||batch.domain.pool!==deployment.addresses.recoursePool.toLowerCase()
    ||batch.target!==deployment.addresses.settlement.toLowerCase()||batch.context.revision!==String(deployment.revision)
    ||batch.context.month!==String(utcCalendarMonth(await blockTimestamp(deployment))))return fail('stale');
  const wiring=await readMembershipWiring(chain,deployment);
  if(wiring.gasPayer!==gasPayer.toLowerCase())return fail('gas_payer');
  for(const method of ['poolHistoryReady','monthlyRule'] as const){
    const args=method==='monthlyRule'?[batch.context.month]:[];
    const raw=await chain.agree('eth_call',[{to:batch.domain.pool,data:RECOURSE_POOL_ABI.encodeFunctionData(method,args)},wiring.pin]);
    if(typeof raw!=='string')return fail('rule');
    const result=RECOURSE_POOL_ABI.decodeFunctionResult(method,raw)[0];
    if(method==='poolHistoryReady'?result!==true:String(result[4])!==batch.context.membershipRuleHash)return fail('rule');
  }
  await db.runTransaction(async tx=>{
    const retained=await tx.get(db.collection(PRIVATE_ISSUANCE_BATCHES).doc(batch.id));
    const parent=await tx.get(db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(batch.context.batchId));
    if(!retained.exists||hash(retained.get('batch'))!==hash(batch)||!['reserved','signed'].includes(String(retained.get('status')))
      ||parent.get('membership_issuance_id')!==batch.id||parent.get('calldata')!==batch.kernelCall
      ||!['reserved','submitted','mined'].includes(String(parent.get('status')))||parent.get('applied')!==false)return fail('reservation');
    for(const r of batch.reservations)await preparePrivateMembershipReservation(db,tx,r);
    for(const ticket of batch.tickets){
      const fence=await tx.get(db.collection(PRIVATE_ISSUANCE_ADDRESSES).doc(ticket.account));
      if(fence.get('batchId')!==batch.id)return fail('reservation');
    }
    for(const payee of batch.unadmitted){
      const row=await tx.get(db.collection(R.addresses).doc(batch.tickets[payee.ordinal].account));
      if(payee.ownerIdentity===null?row.exists:!row.exists||hash(row.data())!==payee.addressRecordHash)return fail('binding');
      if(payee.ownerIdentity!==null){
        const owner=await tx.get(db.collection(R.owners).doc(payee.ownerIdentity));
        const account=await tx.get(db.collection(C.owners).doc(payee.ownerIdentity));
        if(!owner.exists||owner.get('membershipTransition')!=null||account.exists)return fail('unreconciled_membership');
      }
    }
  });
  for(const ticket of batch.tickets){
    const binding=await publicBinding(ticket.account,deployment);
    const row=await db.collection(R.addresses).doc(ticket.account).get();
    if(!row.exists){if(!/^0x0+$/.test(binding)||ticket.protectedMember||ticket.contribution!=='0'||ticket.consentNonce!=='0')return fail('binding');continue;}
    if(row.get('identity')!==binding||row.get('kernel')!==batch.domain.kernel||row.get('chainBindingStatus')!=='confirmed')return fail('binding');
    const state=await readRecoursePoolState(binding,deployment);
    if(state.currentAddress!==ticket.account||state.consentNonce!==ticket.consentNonce||(ticket.protectedMember&&!state.addressConsent)
      ||state.signedRuleHash!==batch.context.membershipRuleHash)return fail('consent');
  }
  if((await currentProtocolDeployment({ fresh: true })).manifestHash!==deployment.manifestHash)return fail('stale');
  return {deployment,identityAttestor:wiring.identityAttestor};
}

/** Persist the complete private classification before any attestor signature
 * exists. The settlement parent retains its original inner approval calldata. */
export async function preparePrivateIssuanceExecution(db:Firestore,parent:SettlementBatchDoc,gasPayer:string,
  env:NodeJS.ProcessEnv=process.env):Promise<PrivateIssuanceBatchRecord>{
  const parentRow=await db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(parent.batch_id).get();
  if(!parentRow.exists||parentRow.get('calldata')!==parent.calldata)return fail('parent');
  parent=parentRow.data() as SettlementBatchDoc;
  const retainedId=parent.membership_issuance_id;
  let record:PrivateIssuanceBatchRecord|null=null;
  if(retainedId!==undefined){
    if(!/^0x[0-9a-f]{64}$/.test(retainedId))return fail('parent');
    await reconcilePrivateIssuanceSuccession(db,retainedId);
    const retained=await db.collection(PRIVATE_ISSUANCE_BATCHES).doc(retainedId).get();
    record=retained.exists?retained.data() as PrivateIssuanceBatchRecord:null;
    if(!record||record.batch.kernelCall!==parent.calldata||record.batch.context.batchId!==parent.batch_id)return fail('parent');
  }
  if(!record)record=await reservePrivateIssuanceBatch(db,await planPrivateIssuanceExecution(db,parent,gasPayer,env));
  if(record.status==='superseded'||record.status==='committed'||record.status==='cancelled')return fail('terminal');
  const check=await assertCurrentPrivateIssuance(db,record,gasPayer);
  if(record.status==='signed'){
    if(!record.signature||!record.calldata)return fail('signature');
    await assertIdentityAttestation(breakDeploymentChain(),check.identityAttestor,check.deployment.blockHash,
      getBytes(membershipIssuanceSigningHash(record.batch.domain,record.batch.context,record.batch.tickets)),record.signature);
    return retainPrivateIssuanceSignature(db,record.batch,record.signature);
  }
  const attestor=configuredIdentityAttestor(env);
  if(attestor.address!==check.identityAttestor||!attestor.signBytes)return fail('attestor');
  const message=getBytes(membershipIssuanceSigningHash(record.batch.domain,record.batch.context,record.batch.tickets));
  const signature=await attestor.signBytes(message);
  const after=await assertCurrentPrivateIssuance(db,record,gasPayer);
  if(after.identityAttestor!==attestor.address)return fail('attestor');
  await assertIdentityAttestation(breakDeploymentChain(),attestor.address,after.deployment.blockHash,message,signature);
  return retainPrivateIssuanceSignature(db,record.batch,signature);
}

/** Unsigned classification shared by reservation and reverting probes. This
 * planner creates no financial reservation or usable attestor authorization. */
async function planPrivateIssuanceExecution(db:Firestore,parent:SettlementBatchDoc,gasPayer:string,
  env:NodeJS.ProcessEnv):Promise<PrivateIssuanceBatch>{
  let selected=await finalizedIssuanceDeployment(),policy=await epochPolicy(parent,selected.deployment);
  const id=privateIssuanceBatchId(policy.kernel,parent.batch_id);
    const firstPlan=planSettlementIssuance(parent,policy);
    await reconcileAddressIssuance(db,firstPlan.recipients.map(r=>r.account));
    const owners=new Set<string>();
    for(const r of firstPlan.recipients){const row=await db.collection(R.addresses).doc(r.account).get();if(row.exists)owners.add(String(row.get('ownerIdentity')));}
    for(const owner of owners)await reconcileCurrentPrivateMembership(db,owner);
    selected=await finalizedIssuanceDeployment();policy=await epochPolicy(parent,selected.deployment);
    if(privateIssuanceBatchId(policy.kernel,parent.batch_id)!==id)return fail('stale');
    const {deployment,block,timestamp}=selected,plan=planSettlementIssuance(parent,policy);
    const wiring=await readMembershipWiring(breakDeploymentChain(),deployment),attestor=configuredIdentityAttestor(env);
    if(wiring.gasPayer!==gasPayer.toLowerCase())return fail('gas_payer');
    if(wiring.identityAttestor!==attestor.address||!attestor.signBytes)return fail('attestor');
    const domain={chainId:'8453' as const,pointer:deployment.pointer.toLowerCase(),kernel:policy.kernel,pool:deployment.addresses.recoursePool.toLowerCase()};
    const rules=await readPrivateCalendarRules(db,{pool:domain.pool,block,blockHash:deployment.blockHash}),month=utcCalendarMonth(timestamp);
    const context={batchId:parent.batch_id,lane:plan.lane,epoch:plan.epoch,policyHash:plan.policyHash,settlementDigest:plan.settlementDigest,
      revision:String(deployment.revision),month:String(month),membershipRuleHash:rules(month).ruleHash};
    const groups=new Map<string,{account:PrivateMembershipAccount;recipients:typeof plan.recipients[number][]}>();
    const unadmitted:UnadmittedIssuanceRecipient[]=[],tickets:MembershipIssuanceTicket[]=[];
    const consents:boolean[]=[];
    for(const r of plan.recipients){
      const row=await db.collection(R.addresses).doc(r.account).get(),binding=await publicBinding(r.account,deployment);
      let consentNonce='0',consenting=false;
      if(!row.exists){
        if(!/^0x0+$/.test(binding))return fail('unknown_binding');
        unadmitted.push({ordinal:r.ordinal,ownerIdentity:null,addressRecordHash:null});
      }else{
        if(row.get('identity')!==binding||row.get('kernel')!==domain.kernel||row.get('chainBindingStatus')!=='confirmed')return fail('binding');
        const state=await readRecoursePoolState(binding,deployment);
        if(state.currentAddress!==r.account||state.signedRuleHash!==context.membershipRuleHash)return fail('binding');
        consentNonce=state.consentNonce;
        consenting=state.addressConsent;
        const ownerIdentity=String(row.get('ownerIdentity')),accountRow=await db.collection(C.owners).doc(ownerIdentity).get();
        if(!accountRow.exists){
          if(state.addressConsent)return fail('unreconciled_membership');
          unadmitted.push({ordinal:r.ordinal,ownerIdentity,addressRecordHash:hash(row.data())});
        }else{
          const account=accountRow.data() as PrivateMembershipAccount;
          if(account.checkpoint.pool!==domain.pool||account.checkpoint.block>block)return fail('checkpoint');
          const group=groups.get(ownerIdentity);
          if(group){if(hash(group.account)!==hash(account))return fail('concurrent');group.recipients.push(r);}
          else groups.set(ownerIdentity,{account,recipients:[r]});
        }
      }
      tickets.push({account:r.account,gross:r.grossAtomic,contributor:r.contributorAtomic,contribution:'0',consentNonce,protectedMember:false});
      consents.push(consenting);
    }
    const reservations=[...groups.values()].map(g=>planPrivateIssuance(g.account,domain,context,g.recipients,rules));
    for(const r of reservations)for(const payee of r.recipients)tickets[payee.ordinal]={...tickets[payee.ordinal],contribution:payee.contributionAtomic,protectedMember:r.protectedMember!==false};
    if(tickets.some((ticket,i)=>ticket.protectedMember&&!consents[i]))return fail('unreconciled_membership');
    const batch:PrivateIssuanceBatch={id,domain,context,policy,kernelCall:parent.calldata,target:deployment.addresses.settlement.toLowerCase(),
      checkpoint:{block,blockHash:deployment.blockHash},tickets,reservations,unadmitted};
    return batch;
}

/** This calldata can only run inside an unconditionally reverting frame. */
export async function preparePrivateIssuanceProbe(db:Firestore,parent:SettlementBatchDoc,gasPayer:string,
  env:NodeJS.ProcessEnv=process.env):Promise<{target:string;data:string;blockHash:string;manifestHash:string}>{
  const batch=await planPrivateIssuanceExecution(db,parent,gasPayer,env);
  const deployment=await currentProtocolDeployment();
  if(batch.domain.kernel!==deployment.addresses.kernel.toLowerCase()||batch.target!==deployment.addresses.settlement.toLowerCase()
    ||batch.domain.pool!==deployment.addresses.recoursePool.toLowerCase()||batch.context.revision!==String(deployment.revision)
    ||batch.context.month!==String(utcCalendarMonth(await blockTimestamp(deployment))))return fail('stale');
  return {target:batch.target,data:MEMBER_SETTLEMENT_ABI.encodeFunctionData('probeMemberBatch',[batch.kernelCall,batch.context,batch.tickets]),
    blockHash:deployment.blockHash,manifestHash:deployment.manifestHash};
}

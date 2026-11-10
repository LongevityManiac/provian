import { randomUUID } from 'crypto';
import { Transaction,keccak256,sha256,toUtf8Bytes } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { acquireSignerLease,releaseSignerLease,listAllUnresolvedBatches,SETTLEMENT_SIGNER_LEASES_COLLECTION,
  SETTLEMENT_CYCLES_COLLECTION,type SettlementDb } from '../pvt/wp4/durable-settlement-store';
import { finalizedOwnerTransaction,type FinalizedOwnerTransaction } from './transaction-finality';
export interface RecourseExecutionCall {
  readonly kind:'attest'|'reverse'|'allocate'|'decline'|'record'|'deliver';
  readonly executor:string; readonly calldata:string; readonly manifestHash:string; readonly signer:string;
  /** Canonical preparation block distinguishes a fresh attempt after a
   * finalized revert without ever replacing an unresolved signed nonce. */
  readonly attempt?:string;
}
export interface RecourseExecutionSigner<T extends RecourseExecutionCall> {
  readonly address:string; sign(plan:T):Promise<string>; broadcast(raw:string):Promise<string>;
}
export const RECOURSE_EXECUTIONS='recourse_execution_transactions_v1';
/** Release only an unsigned reservation under the same exclusive signer lease.
 * A signed nonce must reach canonical finality; it can never be cancelled by
 * deleting queue state or by observing that a transaction is not yet mined. */
export async function cancelUnsignedRecourseCall(db:Firestore,id:string):Promise<void>{
 const ref=db.collection(RECOURSE_EXECUTIONS).doc(id),row=await ref.get();
 if(!row.exists)return;
 const plan=row.get('plan') as RecourseExecutionCall;
 if(!plan||recourseExecutionId(plan)!==id||row.get('signedTransaction')!==undefined)throw Error('recourse_execution_signed_pending');
 const workerId=`cancel-${randomUUID()}`,reservation=`restoration:${id}`,settlementDb=db as unknown as SettlementDb;
 const leaseRef=db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(plan.signer);
 const lease=await acquireSignerLease(settlementDb,{signer:plan.signer,workerId,operationId:reservation,nowMs:Date.now(),leaseTtlMs:120_000});
 if(lease.kind!=='acquired')throw Error('recourse_execution_signer_busy');
 try{
  await db.runTransaction(async tx=>{
   const [current,state]=await Promise.all([tx.get(ref),tx.get(leaseRef)]);
   if(current.get('signedTransaction')!==undefined)throw Error('recourse_execution_signed_pending');
   const pending=state.get('pending_operation');
   if(state.get('owner')!==workerId||Number(state.get('expires_at_ms'))<=Date.now()
     ||(pending!==undefined&&pending!==null&&pending!==reservation))throw Error('recourse_execution_lease_lost');
   tx.update(ref,{status:'cancelled'});tx.update(leaseRef,{pending_operation:null});
  });
 }finally{await releaseSignerLease(settlementDb,{signer:plan.signer,workerId,nowMs:Date.now()});}
}
export function recourseExecutionId(plan:RecourseExecutionCall):string {
  return sha256(toUtf8Bytes(JSON.stringify([plan.kind,plan.executor,plan.calldata,plan.manifestHash,plan.signer,plan.attempt??null])));
}
function verifyRaw(raw:string,plan:RecourseExecutionCall):void {
  const tx=Transaction.from(raw);
  if(!tx.signature||tx.from?.toLowerCase()!==plan.signer||tx.to?.toLowerCase()!==plan.executor||tx.data!==plan.calldata
    ||tx.chainId!==8453n||tx.type!==2||tx.value!==0n||tx.gasLimit<=0n||tx.maxFeePerGas===null||tx.maxPriorityFeePerGas===null
    ||tx.maxFeePerGas<tx.maxPriorityFeePerGas)throw Error('recourse_execution_signed_mismatch');
}
/** The caller supplies a capability verifier for a freshly checked plan, never
 * an HTTP body. Signed bytes are persisted before broadcast. All signers share
 * the settlement nonce reservation, including the restoration authority. */
export async function executeRecourseCall<T extends RecourseExecutionCall>(db:Firestore,plan:T,signer:RecourseExecutionSigner<T>,
  verifyPlan:(plan:T)=>Promise<void>,finalized:typeof finalizedOwnerTransaction=finalizedOwnerTransaction):
  Promise<{id:string;transactionHash:string;status:'submitted'|'confirmed'|'reverted';receipt?:FinalizedOwnerTransaction}> {
  if(signer.address!==plan.signer)throw Error('recourse_execution_signer_mismatch');
  const id=recourseExecutionId(plan),reservation=`restoration:${id}`,workerId=`restoration-${randomUUID()}`;
  const ref=db.collection(RECOURSE_EXECUTIONS).doc(id),leaseRef=db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(plan.signer);
  const settlementDb=db as unknown as SettlementDb;
  const renew=async()=>{
    const lease=await acquireSignerLease(settlementDb,{signer:plan.signer,workerId,operationId:reservation,nowMs:Date.now(),leaseTtlMs:120_000});
    if(lease.kind!=='acquired')throw Error('recourse_execution_signer_busy');
  };
  await renew();
  try {
    let row=await ref.get(),raw:unknown=row.get('signedTransaction');
    if(raw===undefined){
      for(const batch of await listAllUnresolvedBatches(settlementDb)){
        const cycle=await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(batch.cycle_id).get(),owner:unknown=cycle.get('signer');
        if(typeof owner!=='string'||owner.toLowerCase()===plan.signer)throw Error('recourse_execution_settlement_reserved');
      }
      await verifyPlan(plan);
      await db.runTransaction(async tx=>{
        const [lease,current]=await Promise.all([tx.get(leaseRef),tx.get(ref)]);
        if(lease.get('owner')!==workerId||Number(lease.get('expires_at_ms'))<=Date.now())throw Error('recourse_execution_lease_lost');
        const pending:unknown=lease.get('pending_operation');
        if(pending!==null&&pending!==undefined&&pending!==reservation)throw Error('recourse_execution_signer_busy');
        if(current.exists&&recourseExecutionId(current.get('plan') as RecourseExecutionCall)!==id)throw Error('recourse_execution_record_changed');
        tx.set(ref,{plan,status:'prepared',createdAtMs:Date.now()},{merge:true});
        tx.update(leaseRef,{pending_operation:reservation});
      });
      const signed=await signer.sign(plan);verifyRaw(signed,plan);
      await db.runTransaction(async tx=>{
        const [lease,current]=await Promise.all([tx.get(leaseRef),tx.get(ref)]);
        if(lease.get('owner')!==workerId||lease.get('pending_operation')!==reservation||Number(lease.get('expires_at_ms'))<=Date.now())throw Error('recourse_execution_lease_lost');
        if(recourseExecutionId(current.get('plan') as RecourseExecutionCall)!==id)throw Error('recourse_execution_record_changed');
        if(current.get('signedTransaction')!==undefined)return;
        tx.update(ref,{signedTransaction:signed,transactionHash:keccak256(signed),status:'submitted'});
      });
      row=await ref.get();raw=row.get('signedTransaction');
    }
    if(typeof raw!=='string'||keccak256(raw)!==row.get('transactionHash')||recourseExecutionId(row.get('plan') as RecourseExecutionCall)!==id)throw Error('recourse_execution_record_changed');
    verifyRaw(raw,plan);const transactionHash=keccak256(raw);
    let receipt:FinalizedOwnerTransaction|null;
    try {receipt=await finalized(raw);}
    catch(error){if(error instanceof Error&&error.message==='recourse_transaction_not_finalized')return {id,transactionHash,status:'submitted'};throw error;}
    if(receipt){
      const status=receipt.status===1?'confirmed' as const:'reverted' as const;
      await db.runTransaction(async tx=>{
        const [lease,current]=await Promise.all([tx.get(leaseRef),tx.get(ref)]);
        if(lease.get('owner')!==workerId||Number(lease.get('expires_at_ms'))<=Date.now()
          ||(lease.get('pending_operation')!==reservation && !((lease.get('pending_operation')===null||lease.get('pending_operation')===undefined)&&current.get('status')===status))
          ||current.get('signedTransaction')!==raw)throw Error('recourse_execution_lease_lost');
        tx.update(ref,{status,receipt,finalizedAtMs:Date.now()});tx.update(leaseRef,{pending_operation:null});
      });
      return {id,transactionHash,status,receipt};
    }
    await renew();
    try { await verifyPlan(plan); }
    catch(error){
      // Exact already-signed bytes retain their nonce until mined. The current
      // pointer and on-chain observation/replay fences make stale calls revert.
      if(!(error instanceof Error)||!['recourse_execution_retired','recourse_execution_stale'].includes(error.message))throw error;
    }
    if(await signer.broadcast(raw)!==transactionHash)throw Error('recourse_execution_broadcast_mismatch');
    return {id,transactionHash,status:'submitted'};
  }finally{await releaseSignerLease(settlementDb,{signer:plan.signer,workerId,nowMs:Date.now()});}
}

/** Reconcile only bytes already signed and durably reserved by this worker.
 * No signing method is available here; a stored unsigned plan needs a fresh
 * independently checked capability before any key can be used. */
export async function resumeRecourseCall(db:Firestore,id:string,signer:Pick<RecourseExecutionSigner<RecourseExecutionCall>,'address'|'broadcast'>,
 finalized:typeof finalizedOwnerTransaction=finalizedOwnerTransaction):Promise<Awaited<ReturnType<typeof executeRecourseCall>>>{
 if(!/^0x[0-9a-f]{64}$/.test(id))throw Error('recourse_execution_id_invalid');
 const row=await db.collection(RECOURSE_EXECUTIONS).doc(id).get(),value:unknown=row.get('plan');
 if(!row.exists||typeof row.get('signedTransaction')!=='string'||!value||typeof value!=='object')throw Error('recourse_execution_signed_record_required');
 const raw=value as Record<string,unknown>;
 if(!['attest','reverse','allocate','decline','record','deliver'].includes(String(raw.kind))||typeof raw.executor!=='string'
   ||typeof raw.signer!=='string'||typeof raw.calldata!=='string'||typeof raw.manifestHash!=='string')throw Error('recourse_execution_record_changed');
 if(raw.attempt!==undefined&&(typeof raw.attempt!=='string'||!/^0x[0-9a-f]{64}$/.test(raw.attempt)))throw Error('recourse_execution_record_changed');
 const plan:RecourseExecutionCall={kind:raw.kind as RecourseExecutionCall['kind'],executor:raw.executor,signer:raw.signer,calldata:raw.calldata,manifestHash:raw.manifestHash,
  ...(typeof raw.attempt==='string'?{attempt:raw.attempt}:{})};
 if(recourseExecutionId(plan)!==id)throw Error('recourse_execution_record_changed');
 return executeRecourseCall(db,plan,{...signer,sign:async()=>{throw Error('recourse_execution_signed_record_required');}},
  async()=>{throw Error('recourse_execution_stale');},finalized);
}

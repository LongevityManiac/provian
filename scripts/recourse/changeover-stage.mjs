import {sha256,toUtf8Bytes,Transaction,getCreateAddress} from 'ethers';
import {advanceChangeoverTransaction} from './changeover-transaction.mjs';
const ensure=(value,code)=>{if(!value)throw Error('changeover_stage_'+code);};
const digest=value=>sha256(toUtf8Bytes(JSON.stringify(value)));
/** Durable ordered execution. A shared signer lease is retained for the whole
 * stage. Independently matching canonical inclusion permits pipelining; only
 * finalized receipts permit completion. A retry reconciles earlier nonces
 * before preparing a later transaction, including after a reorganization.
 * The caller supplies a reviewed plan and an already-authorized signing port;
 * this module never obtains a key or infers authorization from a timeout. */
export async function advanceChangeoverStage({steps,planDigest,port,journal,persist}){
 ensure(/^0x[0-9a-f]{64}$/.test(planDigest)&&Array.isArray(steps)&&steps.length>0,'plan_invalid');
 const stageDigest=digest({planDigest,steps});
 let state=journal??{version:1,stageDigest,attempts:{},completed:false};
 ensure(state.version===1&&state.stageDigest===stageDigest&&state.attempts&&typeof state.attempts==='object','journal_mismatch');
 await port.assertLease(stageDigest);
 await port.assertPlan(planDigest);
 let allFinalized=true;
 for(let i=0;i<steps.length;i++){
  await port.assertLease(stageDigest);
  const step=steps[i],prior=state.attempts[String(i)];
  const result=await advanceChangeoverTransaction({step,port:port.forSigner(step.from),prior,
   persist:async attempt=>{
    state={...state,completed:false,attempts:{...state.attempts,[String(i)]:attempt}};
    await persist(state);
   }});
  ensure(result.status!=='reverted','transaction_reverted');
  if(result.status==='confirmed')continue;
  allFinalized=false;
  // This port must authenticate raw signed bytes, receipt status, canonical
  // block hash and transaction inclusion through both independent operators.
  const receipt=await port.included(result.attempt.raw);
  if(!receipt)return {status:result.status==='submitted'?'submitted':'awaiting_inclusion',step:i,journal:state};
  const tx=Transaction.from(result.attempt.raw);
  ensure(receipt.hash===result.attempt.hash&&receipt.status===1,'inclusion_invalid');
  if(tx.to===null)ensure(receipt.contractAddress?.toLowerCase()===getCreateAddress({from:step.from,nonce:tx.nonce}).toLowerCase(),'creation_mismatch');
 }
 await port.assertLease(stageDigest);
 if(!allFinalized)return {status:'awaiting_finality',step:steps.length,journal:state};
 await port.assertPlan(planDigest);
 state={...state,completed:true};await persist(state);
 return {status:'confirmed',step:steps.length,journal:state};
}

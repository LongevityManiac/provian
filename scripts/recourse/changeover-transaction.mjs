import {Transaction,keccak256,getCreateAddress} from 'ethers';
const ensure=(condition,code)=>{if(!condition)throw Error('changeover_transaction_'+code);};
/** One zero-value reviewed CREATE/call. The runner owns an exclusive signer
 * lease and independently checks the plan before entering. No implicit nonce
 * replacement: a lost response resumes the exact durable signed bytes. */
export async function advanceChangeoverTransaction({step,port,prior,persist}){
 ensure(step&&/^0x[0-9a-f]{40}$/.test(step.from)&&/^0x(?:[0-9a-f]{2})+$/.test(step.data)
   &&step.value==='0'&&(step.to===undefined||/^0x[0-9a-f]{40}$/.test(step.to)),'step_invalid');
 ensure(await port.chainId()===8453n&&await port.signerAddress()===step.from,'signer_or_chain');
 const identity=keccak256(Transaction.from({type:2,chainId:8453,nonce:0,to:step.to??null,value:0,data:step.data,
   gasLimit:0,maxFeePerGas:0,maxPriorityFeePerGas:0}).unsignedSerialized);
 let attempt=prior;
 if(attempt)ensure(attempt.identity===identity&&attempt.from===step.from&&Number.isSafeInteger(attempt.nonce)
   &&attempt.nonce>=0,'journal_mismatch');
 if(!attempt){
  const nonces=await port.nonces(step.from);
  ensure(Number.isSafeInteger(nonces.latest)&&nonces.latest>=0&&nonces.latest===nonces.pending,'nonce_busy');
  ensure(step.nonce===undefined||step.nonce===nonces.latest,'nonce_conflict');
  attempt={identity,from:step.from,nonce:nonces.latest,raw:null,hash:null};
  await persist(attempt);
 }
 ensure(step.nonce===undefined||step.nonce===attempt.nonce,'nonce_conflict');
 if(step.to===undefined&&step.address!==undefined)ensure(step.address===
   getCreateAddress({from:step.from,nonce:attempt.nonce}).toLowerCase(),'create_address');
 if(!attempt.raw){
  const nonces=await port.nonces(step.from);
  ensure(nonces.latest===attempt.nonce&&nonces.pending===attempt.nonce,'nonce_conflict');
  // prepare() must independently simulate this exact request and bound the gas
  // expenditure before signing; the returned transaction is checked below.
  const raw=await port.prepare({...step,nonce:attempt.nonce});
  attempt={...attempt,raw,hash:keccak256(raw)};
  validateChangeoverAttempt(attempt,step);
  await persist(attempt);
 }
 validateChangeoverAttempt(attempt,step);
 const receipt=await port.finalized(attempt.raw);
 if(receipt){
  ensure(receipt.hash===attempt.hash,'receipt_mismatch');
  if(receipt.status!==1)return {status:'reverted',attempt,receipt};
  if(step.to===undefined)ensure(receipt.contractAddress?.toLowerCase()===getCreateAddress({from:step.from,nonce:attempt.nonce}).toLowerCase()
    &&(step.address===undefined||receipt.contractAddress.toLowerCase()===step.address),'create_address');
  return {status:'confirmed',attempt,receipt};
 }
 // finalized() distinguishes an absent transaction from one merely awaiting
 // depth. A receipt seen by either operator must not be treated as absent.
 const nonces=await port.nonces(step.from);
 if(nonces.latest>attempt.nonce)return {status:'awaiting_finality',attempt};
 ensure(nonces.latest===attempt.nonce,'nonce_regressed');
 const hash=await port.broadcast(attempt.raw);
 ensure(hash===attempt.hash,'broadcast_hash');
 return {status:'submitted',attempt};
}
export function validateChangeoverAttempt(attempt,step){
 const tx=Transaction.from(attempt.raw);
 ensure(tx.signature&&tx.hash===attempt.hash&&tx.from?.toLowerCase()===step.from&&tx.type===2&&tx.chainId===8453n
   &&tx.nonce===attempt.nonce&&(tx.to===null?null:tx.to.toLowerCase())===(step.to??null)&&tx.data===step.data&&tx.value===0n
   &&tx.gasLimit>0n&&tx.maxFeePerGas!==null&&tx.maxPriorityFeePerGas!==null&&tx.maxFeePerGas>=tx.maxPriorityFeePerGas
   &&(step.nonce===undefined||step.nonce===attempt.nonce),'signed_binding');
}

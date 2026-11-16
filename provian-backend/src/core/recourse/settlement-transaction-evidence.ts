import { matchesPlannedCall, withoutBuilderCode } from '../onchain/builder-code';
import type { BatchAttempt } from '../pvt/settlement/durable-settlement-store';
import { breakDeploymentChain } from './break-deployment-queue';
import { readMembershipReceipt, type VerifiedMembershipReceipt } from './membership-receipt';
import { membershipJournalHash } from './private-membership-journal';
import { privateIssuanceReceiptEffects, type PrivateIssuanceBatchRecord } from './private-issuance-batch';
import { MEMBER_SETTLEMENT_ABI } from './issuance-ticket';

export interface VerifiedSettlementTransaction {
  readonly coordinatorId: string;
  readonly batchId: string;
  readonly status: 'committed' | 'cancelled';
  readonly receipt: VerifiedMembershipReceipt;
  /** Observed on chain, not represented as a transaction sent by this worker. */
  readonly attempt: BatchAttempt & { readonly observed: true };
}
const authentic = new WeakSet<object>();
const fail = (reason:string):never => { throw Error(`recourse_settlement_transaction_${reason}`); };
export function assertSettlementTransaction(proof:VerifiedSettlementTransaction):void {
  if(!authentic.has(proof))return fail('unverified');
}
function object(value:unknown):Record<string,unknown> {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail('reply');
}
function quantity(value:unknown):bigint {
  if(typeof value!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value))return fail('quantity');
  return BigInt(value);
}
function safeNumber(value:unknown):number {
  const n=Number(quantity(value));return Number.isSafeInteger(n)?n:fail('quantity');
}
function address(value:unknown):string {
  return typeof value==='string'&&/^0x[0-9a-f]{40}$/i.test(value)?value.toLowerCase():fail('address');
}

/** Recover exact transaction metadata only after authentic finalized effects.
 * This supports a receipt discovered during private reconciliation even when
 * its gas transaction is absent from the runner's durable attempt log. */
export async function readSettlementTransaction(record:PrivateIssuanceBatchRecord,gasPayer:string):Promise<VerifiedSettlementTransaction> {
  if(!['committed','cancelled'].includes(record.status)||!record.transactionHash||!record.receipt)return fail('terminal');
  const receipt=await readMembershipReceipt(record.transactionHash,record.batch.domain.pool);
  if(membershipJournalHash(receipt)!==membershipJournalHash(record.receipt)
    ||privateIssuanceReceiptEffects(record.batch,receipt).status!==record.status)return fail('receipt');
  const chain=breakDeploymentChain();
  const [transaction,rawReceipt]=await Promise.all([
    chain.agree('eth_getTransactionByHash',[record.transactionHash]),
    chain.agree('eth_getTransactionReceipt',[record.transactionHash]),
  ]);
  const tx=object(transaction),mined=object(rawReceipt),hash=record.transactionHash;
  if(tx.hash!==hash||mined.transactionHash!==hash||quantity(mined.status)!==1n
    ||tx.blockHash!==receipt.blockHash||mined.blockHash!==receipt.blockHash
    ||safeNumber(tx.blockNumber)!==receipt.block||safeNumber(mined.blockNumber)!==receipt.block
    ||address(tx.from)!==address(gasPayer)||address(tx.to)!==record.batch.target||quantity(tx.value)!==0n)return fail('binding');
  if(typeof tx.input!=='string'||!/^0x(?:[0-9a-f]{2})*$/.test(tx.input))return fail('calldata');
  if(record.status==='committed'){
    if(!record.calldata||!matchesPlannedCall(tx.input,record.calldata))return fail('calldata');
  }else{
    let args;
    try{args=MEMBER_SETTLEMENT_ABI.decodeFunctionData('cancelMemberBatch',tx.input);}catch{return fail('calldata');}
    const event=receipt.events.find(e=>e.name==='IssuanceBatchCancelled');
    if(!event||args[0]!==record.batch.context.batchId||String(args[1])!==event.revision
      ||!matchesPlannedCall(tx.input,MEMBER_SETTLEMENT_ABI.encodeFunctionData('cancelMemberBatch',[args[0],args[1]])))return fail('calldata');
  }
  const gas=quantity(tx.gas),used=quantity(mined.gasUsed),effective=quantity(mined.effectiveGasPrice);
  const maxFee=quantity(tx.maxFeePerGas??tx.gasPrice),priority=quantity(tx.maxPriorityFeePerGas??tx.gasPrice);
  if(gas===0n||used>gas||effective>maxFee||priority>maxFee)return fail('fee');
  // Metadata reads cannot carry evidence across a reorg between RPC rounds.
  const again=await readMembershipReceipt(hash,record.batch.domain.pool);
  if(membershipJournalHash(again)!==membershipJournalHash(receipt))return fail('reorg');
  const attempt=Object.freeze({nonce:safeNumber(tx.nonce),tx_hash:hash,target:record.batch.target,calldata:withoutBuilderCode(tx.input),
    kind:record.status==='committed'?'original' as const:'cancel' as const,observed:true as const,
    max_fee_per_gas_wei:maxFee.toString(),max_priority_fee_per_gas_wei:priority.toString(),gas_limit:gas.toString(),
    submitted_at_ms:receipt.timestamp*1000,mined:Object.freeze({status:'success' as const,block_number:receipt.block,
      block_hash:receipt.blockHash,gas_used:used.toString(),effective_gas_price_wei:effective.toString()})});
  const proof=Object.freeze({coordinatorId:record.batch.id,batchId:record.batch.context.batchId,
    status:record.status as 'committed'|'cancelled',receipt:again,attempt});
  authentic.add(proof);return proof;
}

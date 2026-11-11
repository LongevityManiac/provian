import type { Firestore } from 'firebase-admin/firestore';
import { Interface } from 'ethers';
import { SETTLEMENT_BATCHES_COLLECTION, type SettlementBatchDoc } from '../pvt/wp4/durable-settlement-store';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
import { PRIVATE_ISSUANCE_BATCHES } from './issuance-lock';
import { commitPrivateIssuanceBatch, privateIssuanceReceiptEffects, type PrivateIssuanceBatchRecord } from './private-issuance-batch';
import { reconcilePrivateIssuanceSuccession } from './private-issuance-succession';
import { MEMBERSHIP_BATCH_ABI, MEMBERSHIP_RECEIPT_ABI, readMembershipReceipt } from './membership-receipt';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { MEMBER_SETTLEMENT_ABI } from './issuance-ticket';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { breakDeploymentChain } from './break-deployment-queue';
import { readMembershipWiring } from './membership-wiring';
import { finalizedIssuanceDeployment } from './settlement-issuance-runtime';
import { createRecourseChainPort } from './chain-ledger';

const fail = (reason:string):never => { throw Error(`recourse_issuance_lifecycle_${reason}`); };

/** Always reload the durable parent; a caller's earlier snapshot may predate
 * reservation. A missing referenced coordinator is corruption, not no work. */
export async function readSettlementIssuance(db:Firestore,parent:SettlementBatchDoc):Promise<PrivateIssuanceBatchRecord|null>{
  const row=await db.collection(SETTLEMENT_BATCHES_COLLECTION).doc(parent.batch_id).get();
  if(!row.exists||row.get('calldata')!==parent.calldata)return fail('parent');
  const id:unknown=row.get('membership_issuance_id');
  if(id===undefined)return null;
  if(typeof id!=='string'||!/^0x[0-9a-f]{64}$/.test(id))return fail('parent');
  const retained=await db.collection(PRIVATE_ISSUANCE_BATCHES).doc(id).get();
  const record=retained.data() as PrivateIssuanceBatchRecord|undefined;
  if(!retained.exists||!record||record.batch.id!==id||record.batch.context.batchId!==parent.batch_id
    ||record.batch.kernelCall!==parent.calldata)return fail('coordinator');
  return record;
}

/** Finalize the whole private batch before the runner applies its parent or
 * returns its claims to the queue. A gas receipt alone has no release power. */
export async function finalizeSettlementIssuance(db:Firestore,parent:SettlementBatchDoc,transactionHash:string):Promise<'committed'|'cancelled'>{
  const record=await readSettlementIssuance(db,parent);
  if(!record)return fail('missing');
  const receipt=await readMembershipReceipt(transactionHash,record.batch.domain.pool);
  privateIssuanceReceiptEffects(record.batch,receipt);
  const rules=record.batch.reservations.length>0
    ?await readPrivateCalendarRules(db,{pool:record.batch.domain.pool,block:receipt.block,blockHash:receipt.blockHash})
    :()=>fail('unexpected_invoice');
  return commitPrivateIssuanceBatch(db,record.batch.id,receipt,rules);
}

/** Recover a missed finalized receipt or authenticated retirement. Endpoint
 * state prevents omitted logs from being mistaken for an unused authorization. */
export async function reconcileSettlementIssuance(db:Firestore,parent:SettlementBatchDoc):Promise<PrivateIssuanceBatchRecord|null>{
  let record=await readSettlementIssuance(db,parent);
  if(!record)return null;
  const status=await reconcilePrivateIssuanceSuccession(db,record.batch.id);
  if(status!=='current')return readSettlementIssuance(db,parent);
  const {deployment,block}=await finalizedIssuanceDeployment(),batch=record.batch;
  if(batch.domain.pointer!==deployment.pointer.toLowerCase()||batch.domain.kernel!==deployment.addresses.kernel.toLowerCase()
    ||batch.domain.pool!==deployment.addresses.recoursePool.toLowerCase()||batch.target!==deployment.addresses.settlement.toLowerCase())return fail('domain');
  const chain=breakDeploymentChain(),pin={blockHash:deployment.blockHash,requireCanonical:true};
  const call=async(to:string,abi:Interface,method:string)=>{
    const raw=await chain.agree('eth_call',[{to,data:abi.encodeFunctionData(method,[parent.batch_id])},pin]);
    if(typeof raw!=='string')return fail('reply');return abi.decodeFunctionResult(method,raw)[0];
  };
  const settled=(await call(batch.domain.kernel,MEMBERSHIP_BATCH_ABI,'getBatchRecord')).settled;
  const cancelled=await call(batch.domain.pool,RECOURSE_POOL_ABI,'cancelledIssuanceBatch');
  if(typeof settled!=='boolean'||typeof cancelled!=='boolean'||(settled&&cancelled))return fail('state');
  if(!settled&&!cancelled)return record;
  const topics=['IssuanceTicketConsumed','IssuanceBatchCancelled'].map(n=>MEMBERSHIP_RECEIPT_ABI.getEvent(n)!.topicHash);
  const transactions=new Set<string>();
  for(let start=batch.checkpoint.block+1;start<=block;start+=500){
    const end=Math.min(start+499,block);
    for(const log of await getAgreedBaseLogs({address:batch.domain.pool,topics:[topics,parent.batch_id],fromBlock:start,toBlock:end})){
      if(log.removed||log.address!==batch.domain.pool||log.blockNumber<start||log.blockNumber>end)return fail('log');
      const event=MEMBERSHIP_RECEIPT_ABI.parseLog({topics:[...log.topics],data:log.data});
      if(!event||event.args.batchId!==parent.batch_id)return fail('log');
      transactions.add(log.transactionHash);
    }
  }
  if(transactions.size!==1)return fail('receipt_missing');
  const transactionHash=[...transactions][0],receipt=await readMembershipReceipt(transactionHash,batch.domain.pool);
  if(receipt.block<=batch.checkpoint.block||receipt.block>block
    ||privateIssuanceReceiptEffects(batch,receipt).status!==(settled?'committed':'cancelled'))return fail('receipt_state');
  if(await createRecourseChainPort().blockHash(block)!==deployment.blockHash)return fail('reorg');
  await finalizeSettlementIssuance(db,parent,transactionHash);
  record=await readSettlementIssuance(db,parent);
  return record;
}

export type SettlementCancellation =
  | {readonly kind:'none'}
  | {readonly kind:'terminal';readonly record:PrivateIssuanceBatchRecord}
  | {readonly kind:'transaction';readonly target:string;readonly data:string;readonly manifestHash:string};
/** The current revision cancels even a ticket from an older revision of this
 * same kernel/pool. Changed contracts require authenticated succession first. */
export async function prepareSettlementIssuanceCancellation(db:Firestore,parent:SettlementBatchDoc,gasPayer:string):Promise<SettlementCancellation>{
  const record=await reconcileSettlementIssuance(db,parent);
  if(!record)return {kind:'none'};
  if(['committed','cancelled','superseded'].includes(record.status))return {kind:'terminal',record};
  const deployment=await currentProtocolDeployment(),batch=record.batch;
  if(batch.domain.pointer!==deployment.pointer.toLowerCase()||batch.domain.kernel!==deployment.addresses.kernel.toLowerCase()
    ||batch.domain.pool!==deployment.addresses.recoursePool.toLowerCase()||batch.target!==deployment.addresses.settlement.toLowerCase())return fail('domain');
  if((await readMembershipWiring(breakDeploymentChain(),deployment)).gasPayer!==gasPayer.toLowerCase())return fail('gas_payer');
  const data=MEMBER_SETTLEMENT_ABI.encodeFunctionData('cancelMemberBatch',[parent.batch_id,deployment.revision]);
  if((await currentProtocolDeployment()).manifestHash!==deployment.manifestHash)return fail('domain');
  return {kind:'transaction',target:batch.target,data,manifestHash:deployment.manifestHash};
}

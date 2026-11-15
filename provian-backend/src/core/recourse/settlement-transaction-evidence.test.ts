import { acquireCycleLease,applyConfirmedBatch,readCycle,recordObservedMemberTransaction, type SettlementDb } from '../pvt/settlement/durable-settlement-store';
import { issuanceBatchFixture } from './__test-helpers__/issuance-batch-fixture';
import { a,h,tx } from './__test-helpers__/membership-receipt-fixture';
import { reservePrivateIssuanceBatch,retainPrivateIssuanceSignature,commitPrivateIssuanceBatch,type PrivateIssuanceBatchRecord } from './private-issuance-batch';
import { PRIVATE_ISSUANCE_BATCHES } from './issuance-lock';
import { breakDeploymentChain } from './break-deployment-queue';
import { readSettlementTransaction,assertSettlementTransaction } from './settlement-transaction-evidence';
import { MEMBER_SETTLEMENT_ABI } from './issuance-ticket';
import { MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('./break-deployment-queue',()=>({breakDeploymentChain:jest.fn()}));
jest.mock('../protocol/pointer-pin.generated',()=>({PROTOCOL_POINTER_PIN:{address:'0x0000000000000000000000000000000000000001',runtimeHash:require('ethers').keccak256('0x6000')}}));
async function setup(cancel=false){
 const s=issuanceBatchFixture();await reservePrivateIssuanceBatch(s.db,s.batch);
 const signed=await retainPrivateIssuanceSignature(s.db,s.batch,'0x1234');
 if(cancel)s.f.state.effects=[{logIndex:'0x5',...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceBatchCancelled')!,[s.parent.batch_id])}];
 else s.issuance();
 await commitPrivateIssuanceBatch(s.db,s.batch.id,await s.f.read(),s.rules);
 const record=s.fake.store.get(`${PRIVATE_ISSUANCE_BATCHES}/${s.batch.id}`) as unknown as PrivateIssuanceBatchRecord;
 const transaction:Record<string,unknown>={hash:tx,blockHash:h(100),blockNumber:'0x64',from:a(900),to:s.batch.target,value:'0x0',nonce:'0x7',
  gas:'0x186a0',maxFeePerGas:'0xa',maxPriorityFeePerGas:'0x1',input:cancel?MEMBER_SETTLEMENT_ABI.encodeFunctionData('cancelMemberBatch',[s.parent.batch_id,1]):signed.calldata};
 const receipt:Record<string,unknown>={transactionHash:tx,status:'0x1',blockHash:h(100),blockNumber:'0x64',gasUsed:'0xc350',effectiveGasPrice:'0x5'};
 const state={afterMetadata:()=>{}};
 (breakDeploymentChain as jest.Mock).mockReturnValue({agree:async(method:string)=>{
  if(method==='eth_getTransactionByHash')return transaction;
  if(method==='eth_getTransactionReceipt'){state.afterMetadata();return receipt;}
  throw Error(method);
 }});
 return {...s,record,transaction,receipt,state};
}
beforeEach(()=>jest.resetAllMocks());
test.each([false,true])('finalized transaction evidence is branded and binds exact retained execution, cancellation=%s',async(cancel)=>{
 const s=await setup(cancel),proof=await readSettlementTransaction(s.record,a(900));
 expect(()=>assertSettlementTransaction(proof)).not.toThrow();expect(()=>assertSettlementTransaction({...proof})).toThrow('unverified');
 expect(proof.attempt).toMatchObject({observed:true,nonce:7,target:s.batch.target,calldata:s.transaction.input,kind:cancel?'cancel':'original',mined:{status:'success',block_number:100}});
 expect(Object.isFrozen(proof.attempt.mined)).toBe(true);expect(s.fake.store.get(`pvt9_settlement_batches_v1/${s.parent.batch_id}`)?.applied).toBe(false);
});
test.each(['from','to','hash','blockHash','blockNumber','value','input','nonce','gas','maxFeePerGas'])('rejects changed transaction %s',async(field)=>{
 const s=await setup();
 s.transaction[field]=({from:a(901),to:a(901),hash:h(901),blockHash:h(901),blockNumber:'0x65',value:'0x1',input:s.parent.calldata,nonce:'0x01',gas:'0x1',maxFeePerGas:'0x1'} as Record<string,string>)[field];
 await expect(readSettlementTransaction(s.record,a(900))).rejects.toThrow('recourse_settlement_transaction_');
});
test('receipt disappearance, RPC disagreement and a reorg during metadata reads grant no observed attempt',async()=>{
 for(const mode of ['disagreement','reorg','missing']){
  const s=await setup();
  if(mode==='disagreement')(breakDeploymentChain as jest.Mock).mockReturnValue({agree:async()=>{throw Error('RPC disagreement');}});
  if(mode==='missing')(breakDeploymentChain as jest.Mock).mockReturnValue({agree:async()=>null});
  if(mode==='reorg')s.state.afterMetadata=()=>{s.f.state.reorg=true;s.f.state.reads=2;};
  await expect(readSettlementTransaction(s.record,a(900))).rejects.toThrow();
 }
});
test('cancellation evidence cannot name another batch or revision',async()=>{
 for(const mode of ['batch','revision']){
  const s=await setup(true);s.transaction.input=MEMBER_SETTLEMENT_ABI.encodeFunctionData('cancelMemberBatch',[mode==='batch'?h(999):s.parent.batch_id,mode==='revision'?2:1]);
  await expect(readSettlementTransaction(s.record,a(900))).rejects.toThrow('calldata');
 }
});

test('only branded exact terminal evidence records an observed attempt; repeated catchup preserves its provenance',async()=>{
 const s=await setup(),proof=await readSettlementTransaction(s.record,a(900)),db=s.db as unknown as SettlementDb;
 await expect(recordObservedMemberTransaction(db,{...proof})).rejects.toThrow('unverified');
 await recordObservedMemberTransaction(db,proof);await recordObservedMemberTransaction(db,proof);
 const parent=s.fake.store.get(`pvt9_settlement_batches_v1/${s.parent.batch_id}`)!;
 expect(parent).toMatchObject({status:'mined',applied:false});expect(parent.attempts).toEqual([proof.attempt]);
 const key=`${PRIVATE_ISSUANCE_BATCHES}/${s.batch.id}`;
 s.fake.store.set(key,{...s.fake.store.get(key)!,transactionHash:h(999)});
 const before=new Map(s.fake.store);
 await expect(recordObservedMemberTransaction(db,proof)).rejects.toThrow('binding changed');expect(s.fake.store).toEqual(before);
});

test('an observed settlement applies actual fees and counters without consuming an unrelated local fee reservation',async()=>{
 const s=await setup(),db=s.db as unknown as SettlementDb;
 await acquireCycleLease(db,{cycleId:s.parent.cycle_id,workerId:'worker',nowMs:1000,leaseTtlMs:60_000,epoch:1,policyHash:s.parent.policy_hash,
  signer:a(900),baseNonce:0,limits:{max_transactions:100,max_fee_wei_total:'100000000'},cursorStart:0n});
 const key=`pvt9_settlement_cycles_v1/${s.parent.cycle_id}`,cycle=s.fake.store.get(key)!;
 s.fake.store.set(key,{...cycle,consumed:{...(cycle.consumed as Record<string,unknown>),fee_wei_reserved:'77'}});
 const proof=await readSettlementTransaction(s.record,a(900));await recordObservedMemberTransaction(db,proof);
 expect(await applyConfirmedBatch(db,{cycleId:s.parent.cycle_id,batchId:s.parent.batch_id,txHash:tx,nowMs:1001,final:{blockNumber:100,blockHash:h(100)}})).toEqual({kind:'applied'});
 expect((await readCycle(db,s.parent.cycle_id))?.consumed).toMatchObject({transactions_submitted:0,batches_confirmed:1,claims_settled:2,fee_wei_spent:'250000',fee_wei_reserved:'77'});
});

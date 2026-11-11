import { configure } from './__test-helpers__/membership-receipt-fixture';
import { issuanceBatchFixture } from './__test-helpers__/issuance-batch-fixture';
import { a,h,tx,old,pointer } from './__test-helpers__/membership-receipt-fixture';
import { readSettlementIssuance,finalizeSettlementIssuance,reconcileSettlementIssuance,prepareSettlementIssuanceCancellation } from './settlement-issuance-lifecycle';
import { reservePrivateIssuanceBatch } from './private-issuance-batch';
import { PRIVATE_ISSUANCE_BATCHES as B, PRIVATE_ISSUANCE_ADDRESSES as A } from './issuance-lock';
import { SETTLEMENT_BATCHES_COLLECTION as P } from '../pvt/wp4/durable-settlement-store';
import { MEMBERSHIP_BATCH_ABI,MEMBERSHIP_RECEIPT_ABI } from './membership-receipt';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { MEMBER_SETTLEMENT_ABI } from './issuance-ticket';
import { finalizedIssuanceDeployment } from './settlement-issuance-runtime';
import { currentProtocolDeployment } from '../protocol/runtime';
import { reconcilePrivateIssuanceSuccession } from './private-issuance-succession';
import { breakDeploymentChain } from './break-deployment-queue';
import { createRecourseChainPort } from './chain-ledger';
import { readMembershipWiring } from './membership-wiring';
import { getAgreedBaseLogs } from '../onchain/economic-discovery';
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('../onchain/economic-discovery',()=>({getAgreedBaseLogs:jest.fn()}));
jest.mock('./settlement-issuance-runtime',()=>({finalizedIssuanceDeployment:jest.fn()}));
jest.mock('../protocol/runtime',()=>({currentProtocolDeployment:jest.fn()}));
jest.mock('./private-issuance-succession',()=>({reconcilePrivateIssuanceSuccession:jest.fn()}));
jest.mock('./break-deployment-queue',()=>({breakDeploymentChain:jest.fn()}));
jest.mock('./chain-ledger',()=>({createRecourseChainPort:jest.fn()}));
jest.mock('./membership-wiring',()=>({readMembershipWiring:jest.fn()}));
jest.mock('../protocol/pointer-pin.generated',()=>({PROTOCOL_POINTER_PIN:{address:'0x0000000000000000000000000000000000000001',runtimeHash:require('ethers').keccak256('0x6000')}}));
async function setup(){
 const s=issuanceBatchFixture();await reservePrivateIssuanceBatch(s.db,s.batch);
 const state={settled:false,cancelled:false,blockHash:h(100)};
 const deployment={pointer,blockHash:h(100),revision:2n,manifestHash:h(500),addresses:{kernel:old[0],recoursePool:old[8],settlement:old[9]}};
 (currentProtocolDeployment as jest.Mock).mockResolvedValue(deployment);
 (finalizedIssuanceDeployment as jest.Mock).mockResolvedValue({deployment,block:100,timestamp:1700000000});
 (reconcilePrivateIssuanceSuccession as jest.Mock).mockResolvedValue('current');
 (createRecourseChainPort as jest.Mock).mockReturnValue({blockHash:async()=>state.blockHash});
 (readMembershipWiring as jest.Mock).mockResolvedValue({gasPayer:a(900)});
 (breakDeploymentChain as jest.Mock).mockReturnValue({agree:async(_m:string,params:readonly unknown[])=>{
  const call=params[0] as {to:string;data:string};
  return call.to===old[0]?MEMBERSHIP_BATCH_ABI.encodeFunctionResult('getBatchRecord',[[state.settled,0,1,0,2,h(601),h(604),s.batch.context.settlementDigest,200,199,198,0,1,2,2]])
   :RECOURSE_POOL_ABI.encodeFunctionResult('cancelledIssuanceBatch',[state.cancelled]);
 }});
 (getAgreedBaseLogs as jest.Mock).mockImplementation(async()=>s.f.state.effects.map((e,i)=>({...e,address:old[8],removed:false,blockNumber:100,blockHash:h(100),logIndex:i+5,transactionHash:tx})));
 return {...s,state,deployment};
}
beforeEach(()=>jest.resetAllMocks());
test('durable parent back-reference is mandatory even when caller predates reservation',async()=>{
 const s=await setup();expect((await readSettlementIssuance(s.db,s.parent))?.batch.id).toBe(s.batch.id);
 s.fake.store.delete(`${B}/${s.batch.id}`);
 await expect(readSettlementIssuance(s.db,s.parent)).rejects.toThrow('coordinator');
});
test('a finalized complete issuance commits private effects before any parent writeback',async()=>{
 const s=await setup();s.issuance();
 expect(await finalizeSettlementIssuance(s.db,s.parent,tx)).toBe('committed');
 expect(s.fake.store.get(`${A}/${a(3)}`)?.batchId).toBeNull();
 expect(s.fake.store.get(`${P}/${s.parent.batch_id}`)?.applied).toBe(false);
 expect(await finalizeSettlementIssuance(s.db,s.parent,tx)).toBe('committed');
});
test('missing or incomplete receipt effects never release tickets',async()=>{
 for(const mode of ['empty','partial','reverted','pending']){
  const s=await setup();s.issuance();
  if(mode==='empty')s.f.state.effects=[];
  if(mode==='partial')s.f.state.effects.pop();
  if(mode==='reverted')s.f.state.status='0x0';
  if(mode==='pending')s.f.state.final='0x63';
  await expect(finalizeSettlementIssuance(s.db,s.parent,tx)).rejects.toThrow();
  expect(s.fake.store.get(`${A}/${a(3)}`)?.batchId).toBe(s.batch.id);
 }
});
test('current-domain catchup requires endpoint state and complete receipt, never absent logs',async()=>{
 const s=await setup();s.issuance();s.state.settled=true;
 (getAgreedBaseLogs as jest.Mock).mockResolvedValueOnce([]);
 await expect(reconcileSettlementIssuance(s.db,s.parent)).rejects.toThrow('receipt_missing');
 expect(s.fake.store.get(`${A}/${a(3)}`)?.batchId).toBe(s.batch.id);
 expect((await reconcileSettlementIssuance(s.db,s.parent))?.status).toBe('committed');
});
test('cancellation from a newer same-domain revision retains reservations until its actual receipt',async()=>{
 const s=await setup(),cancel=await prepareSettlementIssuanceCancellation(s.db,s.parent,a(900));
 expect(cancel.kind).toBe('transaction');if(cancel.kind!=='transaction')throw Error('missing cancel');
 expect(MEMBER_SETTLEMENT_ABI.decodeFunctionData('cancelMemberBatch',cancel.data)).toEqual([s.parent.batch_id,2n]);
 expect(s.fake.store.get(`${A}/${a(3)}`)?.batchId).toBe(s.batch.id);
 s.state.cancelled=true;s.f.state.effects=[{logIndex:'0x5',...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceBatchCancelled')!,[s.parent.batch_id])}];
 expect((await prepareSettlementIssuanceCancellation(s.db,s.parent,a(900))).kind).toBe('terminal');
 expect(s.fake.store.get(`${A}/${a(3)}`)?.batchId).toBeNull();
});
test('wrong signer, changed domain or reorg prevents a new cancellation or private release',async()=>{
 for(const mode of ['signer','domain','reorg']){
  const s=await setup();
  if(mode==='domain')(currentProtocolDeployment as jest.Mock).mockResolvedValue({...s.deployment,addresses:{...s.deployment.addresses,kernel:a(999)}});
  if(mode==='reorg'){s.state.blockHash=h(101);s.state.settled=true;s.issuance();}
  await expect(prepareSettlementIssuanceCancellation(s.db,s.parent,mode==='signer'?a(901):a(900))).rejects.toThrow('recourse_issuance_lifecycle_');
  expect(s.fake.store.get(`${A}/${a(3)}`)?.batchId).toBe(s.batch.id);
 }
});

test('cached terminal status is revalidated against the actual finalized receipt on every reconciliation',async()=>{
 for(const status of ['committed','cancelled'] as const){
  const s=await setup();
  if(status==='committed')s.issuance();
  else s.f.state.effects=[{logIndex:'0x5',...MEMBERSHIP_RECEIPT_ABI.encodeEventLog(MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceBatchCancelled')!,[s.parent.batch_id])}];
  expect(await finalizeSettlementIssuance(s.db,s.parent,tx)).toBe(status);
  (reconcilePrivateIssuanceSuccession as jest.Mock).mockResolvedValue(status);
  expect((await reconcileSettlementIssuance(s.db,s.parent))?.status).toBe(status);
  const before=new Map(s.fake.store);s.f.state.reorg=true;s.f.state.reads=2;
  await expect(reconcileSettlementIssuance(s.db,s.parent)).rejects.toThrow('reorg');
  expect(s.fake.store).toEqual(before);
 }
});

test('same transaction re-mined at changed canonical position cannot reuse stale private receipt',async()=>{
 const s=await setup();s.issuance();
 await finalizeSettlementIssuance(s.db,s.parent,tx);
 (reconcilePrivateIssuanceSuccession as jest.Mock).mockResolvedValue('committed');
 const replaceHash=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(replaceHash);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,['hash','blockHash','parentHash'].includes(k)&&v===h(100)?h(101):replaceHash(v)]));
  return value;
 };
 configure(s.f.legs.map(leg=>({...leg,send:async(method,params)=>replaceHash(await leg.send(method,params))})));
 await expect(reconcileSettlementIssuance(s.db,s.parent)).rejects.toThrow('receipt_changed');
});

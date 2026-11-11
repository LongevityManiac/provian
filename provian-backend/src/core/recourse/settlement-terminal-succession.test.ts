import { h,old,next,pointer,manifest } from './__test-helpers__/membership-receipt-fixture';
import { findMembershipSuccessionCheckpoint } from './membership-succession-checkpoint';
import { resolveHistoricalProtocolDeployment } from '../protocol/pointer';
import { issuanceBatchFixture } from './__test-helpers__/issuance-batch-fixture';
import { issuanceSuccessionFixture } from './__test-helpers__/issuance-succession-fixture';
import { reservePrivateIssuanceBatch } from './private-issuance-batch';
import { PRIVATE_ISSUANCE_BATCHES } from './issuance-lock';
import { readIssuanceSuccession } from './issuance-succession-proof';
import { reconcilePrivateIssuanceSuccession } from './private-issuance-succession';
import { reconcileSettlementIssuance } from './settlement-issuance-lifecycle';
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('../onchain/economic-discovery',()=>({getAgreedBaseLogs:jest.fn()}));
jest.mock('../protocol/pointer',()=>({resolveHistoricalProtocolDeployment:jest.fn()}));
jest.mock('./chain-ledger',()=>({createRecourseChainPort:jest.fn()}));
jest.mock('./membership-succession-checkpoint',()=>({findMembershipSuccessionCheckpoint:jest.fn()}));
jest.mock('./private-issuance-succession',()=>({reconcilePrivateIssuanceSuccession:jest.fn()}));
jest.mock('../protocol/pointer-pin.generated',()=>({PROTOCOL_POINTER_PIN:{address:'0x0000000000000000000000000000000000000001',runtimeHash:require('ethers').keccak256('0x6000')}}));
beforeEach(()=>jest.resetAllMocks());
test('cached retirement requires the identical authenticated unused cutoff on every reconciliation',async()=>{
 const s=issuanceBatchFixture();await reservePrivateIssuanceBatch(s.db,s.batch);
 const state=issuanceSuccessionFixture(),succession=await readIssuanceSuccession(s.batch.domain,s.parent.batch_id);
 const key=`${PRIVATE_ISSUANCE_BATCHES}/${s.batch.id}`;
 s.fake.store.set(key,{...s.fake.store.get(key)!,status:'superseded',succession});
 (reconcilePrivateIssuanceSuccession as jest.Mock).mockResolvedValue('superseded');
 expect((await reconcileSettlementIssuance(s.db,s.parent))?.status).toBe('superseded');
 for(const failure of ['missing','changed','settled','reorg'] as const){
  state.current=false;state.cutoff=100;state.settled=false;state.reorg=false;
  if(failure==='missing')state.current=true;
  if(failure==='changed')state.cutoff=99;
  if(failure==='settled')state.settled=true;
  if(failure==='reorg')state.reorg=true;
  const before=new Map(s.fake.store);
  await expect(reconcileSettlementIssuance(s.db,s.parent)).rejects.toThrow('recourse_issuance_');
  expect(s.fake.store).toEqual(before);
 }
});

test('later finalized observation preserves the same authenticated unused succession',async()=>{
 const s=issuanceBatchFixture();await reservePrivateIssuanceBatch(s.db,s.batch);
 const state=issuanceSuccessionFixture(),succession=await readIssuanceSuccession(s.batch.domain,s.parent.batch_id);
 const key=`${PRIVATE_ISSUANCE_BATCHES}/${s.batch.id}`;
 s.fake.store.set(key,{...s.fake.store.get(key)!,status:'superseded',succession});
 (reconcilePrivateIssuanceSuccession as jest.Mock).mockResolvedValue('superseded');
 state.final=121;
 (findMembershipSuccessionCheckpoint as jest.Mock).mockResolvedValue({cutoff:{kernel:old[0],pool:old[8],block:100,blockHash:h(100)},successor:{kernel:next[0],pool:next[8],block:121,blockHash:h(121)}});
 (resolveHistoricalProtocolDeployment as jest.Mock).mockImplementation(async(_r,_p,_h,n:number)=>{const targets=n>=120?next:old,revision=n>=120?2:1;return {pointer,revision:BigInt(revision),manifestHash:manifest(revision,targets),addresses:{kernel:targets[0],recoursePool:targets[8]}};});
 await expect(reconcileSettlementIssuance(s.db,s.parent)).resolves.toMatchObject({status:'superseded'});
});

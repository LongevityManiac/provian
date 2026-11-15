import { SETTLEMENT_BATCHES_COLLECTION } from '../pvt/settlement/durable-settlement-store';
import { issuanceBatchFixture } from './__test-helpers__/issuance-batch-fixture';
import { issuanceSuccessionFixture } from './__test-helpers__/issuance-succession-fixture';
import { a,h,old,pointer,tx as receiptTx } from './__test-helpers__/membership-receipt-fixture';
import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, planPrivateIssuance, type PrivateMembershipAccount } from './private-membership-reservation';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { PRIVATE_ISSUANCE_ADDRESSES as A,PRIVATE_ISSUANCE_BATCHES as B } from './issuance-lock';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { reservePrivateIssuanceBatch,commitPrivateIssuanceBatch } from './private-issuance-batch';
import { reconcilePrivateIssuanceSuccession,reconcileAddressIssuance } from './private-issuance-succession';
import { reconcilePrivateMembershipReceipt } from './private-membership-reconcile';
import { resolveHistoricalProtocolDeployment } from '../protocol/pointer';
import { readPrivateCalendarRules } from './private-calendar-rules';
import * as receipts from './membership-receipt';
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('../onchain/economic-discovery',()=>({getAgreedBaseLogs:jest.fn()}));
jest.mock('../protocol/pointer',()=>({resolveHistoricalProtocolDeployment:jest.fn()}));
jest.mock('./chain-ledger',()=>({createRecourseChainPort:jest.fn()}));
jest.mock('./membership-succession-checkpoint',()=>({findMembershipSuccessionCheckpoint:jest.fn()}));
jest.mock('./private-calendar-rules',()=>({readPrivateCalendarRules:jest.fn()}));
jest.mock('../protocol/pointer-pin.generated',()=>({PROTOCOL_POINTER_PIN:{address:'0x0000000000000000000000000000000000000001',runtimeHash:require('ethers').keccak256('0x6000')}}));
const rules:PrivateCalendarRules=()=>({ruleHash:h(9),rule:{schema:'provian-recourse-membership/v1',chainId:8453,pointer,firstMonth:0,participationBurnAtomic:'100',noEarningsContributionAtomic:'100',earningsBps:100}});
function setup(members=0){
 const s=issuanceBatchFixture(),rs=[];
 for(let i=0;i<members;i++){
  const owner=h(500+i),address=a(3+i),binding=h(3+i);
  s.fake.store.set(`${R.owners}/${owner}`,{ownerIdentity:owner});
  s.fake.store.set(`${R.addresses}/${address}`,{ownerIdentity:owner,address,identity:binding,kernel:old[0],chainBindingStatus:'confirmed',recoveryGeneration:0});
  s.fake.store.set(`${R.identities}/${binding}`,{ownerIdentity:owner,identity:binding,recoveryGeneration:0});
  const account:PrivateMembershipAccount=seedMembershipJournal(s.fake.store,{ownerIdentity:owner,version:0,episode:joinPrivateMembership(null,Number(s.batch.context.month),rules),checkpoint:{pool:old[8],block:99,blockHash:h(99)},pendingReservation:null,needsScan:false},
   {chainId:'8453',kernel:old[0],pool:old[8],block:98,blockHash:h(98),logIndex:1,timestamp:1699999999});
  s.fake.store.set(`${C.owners}/${owner}`,{...account});
  rs.push(planPrivateIssuance(account,s.batch.domain,s.batch.context,[{ordinal:i,occurrence:h(777+i),account:address,grossAtomic:'100',contributorAtomic:'99'}],rules));
 }
 const batch={...s.batch,reservations:rs,unadmitted:s.batch.unadmitted.filter(r=>r.ordinal>=members),tickets:s.batch.tickets.map((t,i)=>({...t,protectedMember:i<members,contribution:i<members?'1':'0'}))};
 const authenticReceipt=async(cancel=false)=>{
  (resolveHistoricalProtocolDeployment as jest.Mock).mockImplementation(jest.requireActual('../protocol/pointer').resolveHistoricalProtocolDeployment);
  s.f.state.effects=cancel?[{logIndex:'0x5',...receipts.MEMBERSHIP_RECEIPT_ABI.encodeEventLog(receipts.MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceBatchCancelled')!,[h(600)])}]:batch.tickets.map((t,i)=>({logIndex:`0x${i+5}`,...receipts.MEMBERSHIP_RECEIPT_ABI.encodeEventLog(receipts.MEMBERSHIP_RECEIPT_ABI.getEvent('IssuanceTicketConsumed')!,[h(600),i,t.account,t.gross,t.contribution,h(9)])}));
  return s.f.read();
 };
 return {...s,batch,authenticReceipt};
}
beforeEach(()=>{jest.restoreAllMocks();jest.resetAllMocks();(readPrivateCalendarRules as jest.Mock).mockResolvedValue(rules);});
test('unused batch retires every recipient fence atomically without fabricating membership or touching parent claims',async()=>{
 const s=setup(),batch={...s.batch,unadmitted:s.batch.unadmitted.map(r=>({...r,ownerIdentity:null,addressRecordHash:null}))};s.fake.store.delete(`${R.addresses}/${a(3)}`);
 await reservePrivateIssuanceBatch(s.db,batch);const before=structuredClone(s.fake.store.get(`${SETTLEMENT_BATCHES_COLLECTION}/${h(600)}`));issuanceSuccessionFixture();
 await reconcileAddressIssuance(s.db,batch.tickets.map(t=>t.account));
 expect(await reconcilePrivateIssuanceSuccession(s.db,batch.id)).toBe('superseded');
 for(const t of batch.tickets)expect(s.fake.store.get(`${A}/${t.account}`)?.batchId).toBeNull();
 expect([...s.fake.store.keys()].filter(k=>k.startsWith(C.owners+'/'))).toHaveLength(0);expect(s.fake.store.get(`${SETTLEMENT_BATCHES_COLLECTION}/${h(600)}`)).toEqual(before);
});
test('pending owner and never-admitted payee release together, retaining episode and journal for the authenticated bridge',async()=>{
 const s=setup(1);await reservePrivateIssuanceBatch(s.db,s.batch);const before=structuredClone(s.fake.store.get(`${C.owners}/${h(500)}`));issuanceSuccessionFixture();
 expect(await reconcilePrivateIssuanceSuccession(s.db,s.batch.id)).toBe('superseded');
 expect(s.fake.store.get(`${C.owners}/${h(500)}`)).toEqual({...before,pendingReservation:null,version:1,needsScan:true});
 expect(s.fake.store.get(`${C.reservations}/${s.batch.reservations[0].id}`)?.status).toBe('superseded');
 expect([...s.fake.store.keys()].filter(k=>k.startsWith(C.effects+'/'))).toHaveLength(0);
});
test('settled or cancelled cutoff state with omitted logs never releases an owner or address lock',async()=>{
 for(const field of ['settled','cancelled'] as const){const s=setup(1);await reservePrivateIssuanceBatch(s.db,s.batch);const chain=issuanceSuccessionFixture();chain[field]=true;
 await expect(reconcilePrivateIssuanceSuccession(s.db,s.batch.id)).rejects.toThrow('receipt_missing');expect(s.fake.store.get(`${A}/${a(4)}`)?.batchId).toBe(s.batch.id);expect(s.fake.store.get(`${C.owners}/${h(500)}`)?.pendingReservation).toBe(s.batch.reservations[0].id);}
});
test('a replacement fence or concurrent coordinator mutation refuses the whole release',async()=>{
 for(const kind of ['fence','coordinator']){const s=setup(1);await reservePrivateIssuanceBatch(s.db,s.batch);const chain=issuanceSuccessionFixture();chain.beforeFinalRead=()=>{if(kind==='fence')s.fake.store.set(`${A}/${a(4)}`,{batchId:h(888)});else s.fake.store.set(`${B}/${s.batch.id}`,{...s.fake.store.get(`${B}/${s.batch.id}`)!,signature:'0x1234'});};
 await expect(reconcilePrivateIssuanceSuccession(s.db,s.batch.id)).rejects.toThrow(kind==='fence'?'fence':'concurrent');expect(s.fake.store.get(`${C.owners}/${h(500)}`)?.pendingReservation).toBe(s.batch.reservations[0].id);}
});
test('one owner receipt catchup commits both owners and all fences before either can branch',async()=>{
 const s=setup(2);await reservePrivateIssuanceBatch(s.db,s.batch);const receipt=await s.authenticReceipt();
 await reconcilePrivateMembershipReceipt(s.db,h(500),receipt);
 for(let i=0;i<2;i++){expect(s.fake.store.get(`${C.owners}/${h(500+i)}`)?.pendingReservation).toBeNull();expect(s.fake.store.get(`${C.owners}/${h(500+i)}`)?.version).toBe(1);expect(s.fake.store.get(`${A}/${a(3+i)}`)?.batchId).toBeNull();}
 expect(s.fake.store.get(`${B}/${s.batch.id}`)?.status).toBe('committed');
});
test('a lost coordinator cannot silently downgrade a coordinated receipt into individual credit',async()=>{
 const s=setup(2);await reservePrivateIssuanceBatch(s.db,s.batch);const receipt=await s.authenticReceipt();s.fake.store.delete(`${B}/${s.batch.id}`);
 await expect(reconcilePrivateMembershipReceipt(s.db,h(500),receipt)).rejects.toThrow('issuance_batch_missing');expect(s.fake.store.get(`${C.owners}/${h(500)}`)?.version).toBe(0);
});
test('authentic executed or cancelled batch reconciles completely through its cutoff before succession',async()=>{
 for(const cancel of [false,true]){const s=setup(1);await reservePrivateIssuanceBatch(s.db,s.batch);const receipt=await s.authenticReceipt(cancel);jest.spyOn(receipts,'readMembershipReceipt').mockResolvedValue(receipt);
 const chain=issuanceSuccessionFixture();chain.settled=!cancel;chain.cancelled=cancel;chain.oldLogs=s.f.state.effects.map(e=>({...e,logIndex:Number(e.logIndex),address:old[8],blockNumber:100,blockHash:h(100),transactionHash:receiptTx,removed:false}));
 expect(await reconcilePrivateIssuanceSuccession(s.db,s.batch.id)).toBe(cancel?'cancelled':'committed');expect(s.fake.store.get(`${A}/${a(4)}`)?.batchId).toBeNull();jest.restoreAllMocks();}
});
test('post-cutoff partial receipt remains historical evidence; a retired batch cannot later credit its discarded receipt',async()=>{
 const s=setup(1);await reservePrivateIssuanceBatch(s.db,s.batch);const receipt=await s.authenticReceipt();s.fake.store.set(`${A}/${a(4)}`,{batchId:h(888)});
 await expect(commitPrivateIssuanceBatch(s.db,s.batch.id,receipt,rules)).rejects.toThrow('fence');s.fake.store.set(`${A}/${a(4)}`,{batchId:s.batch.id});
 const historical=structuredClone(s.fake.store.get(`${C.owners}/${h(500)}`));const chain=issuanceSuccessionFixture();chain.cutoff=99;
 expect(await reconcilePrivateIssuanceSuccession(s.db,s.batch.id)).toBe('superseded');expect(s.fake.store.get(`${C.owners}/${h(500)}`)).toEqual(historical);
 expect(s.fake.store.get(`${C.reservations}/${s.batch.reservations[0].id}`)?.status).toBe('committed');await expect(commitPrivateIssuanceBatch(s.db,s.batch.id,receipt,rules)).rejects.toThrow('superseded');
});

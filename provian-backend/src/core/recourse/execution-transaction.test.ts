import { Wallet,keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION,acquireSignerLease,type SettlementDb } from '../pvt/settlement/durable-settlement-store';
import { executeRecourseCall,resumeRecourseCall,recourseExecutionId,RECOURSE_EXECUTIONS,type RecourseExecutionCall } from './execution-transaction';
import type { finalizedOwnerTransaction } from './transaction-finality';
const hash=(n:string)=>`0x${n.repeat(32)}`;
function fixture(){
 const wallet=new Wallet(`0x${'12'.repeat(32)}`),fake=createFakeFirestore({strictTransactionOrder:true});
 const plan:RecourseExecutionCall={kind:'reverse',executor:`0x${'34'.repeat(20)}`,calldata:'0x1234',manifestHash:hash('56'),signer:wallet.address.toLowerCase()};
 const signer={address:plan.signer,sign:jest.fn(async(p:RecourseExecutionCall)=>wallet.signTransaction({chainId:8453,type:2,nonce:3,to:p.executor,data:p.calldata,value:0,gasLimit:100000,maxFeePerGas:2,maxPriorityFeePerGas:1})),broadcast:jest.fn(async(raw:string)=>keccak256(raw))};
 const verify=jest.fn(async()=>{}),finalized=jest.fn<ReturnType<typeof finalizedOwnerTransaction>,Parameters<typeof finalizedOwnerTransaction>>(async()=>null);
 return {fake,db:fake as unknown as Firestore,plan,signer,verify,finalized};
}
test('lost broadcast response preserves one signed transaction and reserves its signer until canonical finality',async()=>{
 const f=fixture(),id=recourseExecutionId(f.plan);f.signer.broadcast.mockRejectedValueOnce(Error('connection lost'));
 await expect(executeRecourseCall(f.db,f.plan,f.signer,f.verify,f.finalized)).rejects.toThrow('connection lost');
 const stored=f.fake.store.get(`${RECOURSE_EXECUTIONS}/${id}`)!;
 expect(stored.signedTransaction).toBeTruthy();
 expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.signer.address}`)?.pending_operation).toBe(`restoration:${id}`);
 expect(await acquireSignerLease(f.fake as unknown as SettlementDb,{signer:f.signer.address,workerId:'settlement',nowMs:Date.now()+1000000,leaseTtlMs:120000})).toMatchObject({kind:'refused'});
 expect((await executeRecourseCall(f.db,f.plan,f.signer,f.verify,f.finalized)).status).toBe('submitted');
 expect(f.signer.sign).toHaveBeenCalledTimes(1);expect(f.signer.broadcast).toHaveBeenLastCalledWith(stored.signedTransaction);
 const receipt={transactionHash:String(stored.transactionHash),block:100,blockHash:hash('78'),status:1 as const};
 f.finalized.mockResolvedValue(receipt);f.verify.mockRejectedValue(Error('already executed'));
 expect((await executeRecourseCall(f.db,f.plan,f.signer,f.verify,f.finalized)).status).toBe('confirmed');
 expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.signer.address}`)?.pending_operation).toBeNull();
 expect((await executeRecourseCall(f.db,f.plan,f.signer,f.verify,f.finalized)).status).toBe('confirmed');
});
test('unverified plans and substituted signed recipients never broadcast',async()=>{
 const f=fixture();f.verify.mockRejectedValueOnce(Error('unverified'));
 await expect(executeRecourseCall(f.db,f.plan,f.signer,f.verify,f.finalized)).rejects.toThrow('unverified');
 expect(f.signer.sign).not.toHaveBeenCalled();
 const original=f.signer.sign.getMockImplementation()!;
 f.signer.sign.mockImplementation(async p=>original({...p,executor:`0x${'99'.repeat(20)}`}));
 await expect(executeRecourseCall(f.db,f.plan,f.signer,f.verify,f.finalized)).rejects.toThrow('signed_mismatch');
 expect(f.signer.broadcast).not.toHaveBeenCalled();
});
test('a finalized revert clears the exact reservation but does not masquerade as restoration success',async()=>{
 const f=fixture();const submitted=await executeRecourseCall(f.db,f.plan,f.signer,f.verify,f.finalized);
 f.finalized.mockResolvedValue({transactionHash:submitted.transactionHash,block:100,blockHash:hash('78'),status:0});
 f.verify.mockRejectedValue(Error('stale'));
 expect((await executeRecourseCall(f.db,f.plan,f.signer,f.verify,f.finalized)).status).toBe('reverted');
 expect(f.fake.store.get(`${SETTLEMENT_SIGNER_LEASES_COLLECTION}/${f.signer.address}`)?.pending_operation).toBeNull();
});

test('a restarted operator can only reconcile persisted signed bytes and cannot sign a database-invented call',async()=>{
 const f=fixture(),id=recourseExecutionId(f.plan);
 await expect(resumeRecourseCall(f.db,id,f.signer,f.finalized)).rejects.toThrow('signed_record_required');
 await executeRecourseCall(f.db,f.plan,f.signer,f.verify,f.finalized);
 const before=f.signer.sign.mock.calls.length;
 expect((await resumeRecourseCall(f.db,id,f.signer,f.finalized)).status).toBe('submitted');
 expect(f.signer.sign).toHaveBeenCalledTimes(before);
 const stored=f.fake.store.get(`${RECOURSE_EXECUTIONS}/${id}`)!;
 f.fake.store.set(`${RECOURSE_EXECUTIONS}/${id}`,{...stored,plan:{...f.plan,calldata:'0xbeef'}});
 await expect(resumeRecourseCall(f.db,id,f.signer,f.finalized)).rejects.toThrow('record_changed');
});

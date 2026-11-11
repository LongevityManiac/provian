import { encodePrivateRecord, decodePrivateRecord, privateStorageId } from '../provenance/private-store';
import { RESTORATION_REQUESTS } from './restoration-request';
import type { Firestore } from 'firebase-admin/firestore';
import { concat, sha256, toUtf8Bytes } from 'ethers';
import { discoverOwnerRecovery } from './owner-recovery-discovery';
import { recoveryOperationId } from './owner-operation';
import { OWNER_OPERATIONS } from './owner-operation-queue';
import { RECOURSE_COLLECTIONS } from './ownership';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const operation={identity:h(1),kernel:a(1),revision:'1',destination:a(2),nonce:2,proof:{recoverySecret:h(3),publicKey:h(4),
 signingRoot:sha256(h(4)),nextCommitment:h(5),nextSigningRoot:h(6),signature:`0x${'11'.repeat(7856)}`}};
function fixture(){const fake=createFakeFirestore(),id=recoveryOperationId(operation);
 fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${h(1)}`,{identity:h(1),recoveryCommitment:h(7)});
 fake.store.set(`${OWNER_OPERATIONS}/${id}`,{identity:h(1),operation,status:'confirmed',transactionHash:h(8),executor:a(9),queuedAtBlockHash:h(10)});
 return {fake,db:fake as unknown as Firestore,id};}
test('returns only exact-binding nonce candidates and public witnesses without writing credentials or state',async()=>{
 const {fake,db}=fixture(),before=JSON.stringify([...fake.store]),executed=jest.fn();
 const result=await discoverOwnerRecovery(db,h(1),'2',executed);
 expect(result).toEqual({identity:h(1),nonce:2,relayCommitment:h(7),candidates:[{operation,transactionHash:h(8)}]});
 expect(executed).not.toHaveBeenCalled();expect(JSON.stringify([...fake.store])).toBe(before);
 expect((await discoverOwnerRecovery(db,h(1),'3',executed)).candidates).toEqual([]);
 await expect(discoverOwnerRecovery(db,h(2),'2',executed)).rejects.toThrow('invalid');
});
test('a lost worker receipt is discovered read-only while superseded or unexecuted operations stay absent',async()=>{
 const {fake,db,id}=fixture();fake.store.get(`${OWNER_OPERATIONS}/${id}`)!.status='submitted';
 const executed=jest.fn().mockResolvedValue({transactionHash:h(11),superseded:false});
 expect((await discoverOwnerRecovery(db,h(1),'2',executed)).candidates[0].transactionHash).toBe(h(11));
 expect(executed).toHaveBeenCalledWith(operation,a(9),h(10));
 executed.mockResolvedValue({transactionHash:h(11),superseded:true});expect((await discoverOwnerRecovery(db,h(1),'2',executed)).candidates).toEqual([]);
 executed.mockResolvedValue(null);expect((await discoverOwnerRecovery(db,h(1),'2',executed)).candidates).toEqual([]);
 executed.mockRejectedValue(Error('rpc_disagreement'));await expect(discoverOwnerRecovery(db,h(1),'2',executed)).rejects.toThrow('disagreement');
});
test('corrupt identities, operation IDs, receipt hashes and invalid nonces fail closed',async()=>{
 for(const change of [{identity:h(2)},{destination:a(99)}]){
  const {fake,db,id}=fixture();fake.store.get(`${OWNER_OPERATIONS}/${id}`)!.operation={...operation,...change};
  await expect(discoverOwnerRecovery(db,h(1),'2')).rejects.toThrow('record_changed');
 }
 const {fake,db,id}=fixture();fake.store.get(`${OWNER_OPERATIONS}/${id}`)!.transactionHash=null;
 await expect(discoverOwnerRecovery(db,h(1),'2')).rejects.toThrow('record_changed');
 for(const nonce of ['-1','01','9007199254740991'])await expect(discoverOwnerRecovery(db,h(1),nonce)).rejects.toThrow('invalid');
});

test('restoration discovery carries the exact loss evidence and refuses changed prepared transaction metadata',async()=>{
 const {fake,db,id}=fixture();fake.store.delete(`${OWNER_OPERATIONS}/${id}`);
 const snapshot={identity:h(1),occurrence:h(20),transactionHash:h(21),block:123,lossAtomic:'20'},membership={active:true};
 const evidence=JSON.stringify({snapshot,membership}),scope={request:h(20),lossHash:sha256(toUtf8Bytes(evidence)),maximumLoss:'20'};
 const restored={...operation,restoration:scope},record=recoveryOperationId(restored);
 fake.store.set(`${OWNER_OPERATIONS}/${record}`,{identity:h(1),operation:restored,status:'confirmed',transactionHash:h(8)});
 fake.store.set(`${RESTORATION_REQUESTS}/${h(20)}`,{identity:h(1),transactionHash:h(21),block:123,snapshot,membership,scope,evidence});
 const priorKey=process.env.RELAY_SIGNING_KEY;
 try {
  process.env.RELAY_SIGNING_KEY='public-test-recourse-evidence-key';
  const key=`${RESTORATION_REQUESTS}/${h(20)}`,stored=fake.store.get(key)!;
  const encoded=encodePrivateRecord(RESTORATION_REQUESTS,h(20),stored);
  const decoded=decodePrivateRecord(RESTORATION_REQUESTS,privateStorageId(RESTORATION_REQUESTS,h(20)),encoded,db).data;
  expect(JSON.stringify(decoded.snapshot)).not.toBe(JSON.stringify(snapshot));
  fake.store.set(key,decoded);
  expect((await discoverOwnerRecovery(db,h(1),'2')).candidates[0].restorationEvidence).toBe(evidence);
 } finally {if(priorKey===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=priorKey;}

 fake.store.get(`${RESTORATION_REQUESTS}/${h(20)}`)!.block=124;
 await expect(discoverOwnerRecovery(db,h(1),'2')).rejects.toThrow('loss_changed');
 fake.store.get(`${RESTORATION_REQUESTS}/${h(20)}`)!.block=123;
 fake.store.get(`${RESTORATION_REQUESTS}/${h(20)}`)!.membership={active:false};
 await expect(discoverOwnerRecovery(db,h(1),'2')).rejects.toThrow('loss_changed');
});

test('kind2 discovery retains earlier bounded loss evidence for a second fresh-device resume',async()=>{
 const {fake,db}=fixture();
 const snapshot={identity:h(1),occurrence:h(30),transactionHash:h(31),block:123,lossAtomic:'20'},membership={active:true};
 const evidence=JSON.stringify({snapshot,membership}),scope={request:h(30),lossHash:sha256(toUtf8Bytes(evidence)),maximumLoss:'20'};
 fake.store.set(`${RESTORATION_REQUESTS}/${h(30)}`,{identity:h(1),authorizationTxHash:h(32),snapshot,membership,evidence,scope});
 expect((await discoverOwnerRecovery(db,h(1),'2')).candidates[0].continuations).toEqual([{scope,evidence}]);
 fake.store.get(`${RESTORATION_REQUESTS}/${h(30)}`)!.evidence=evidence+' ';
 await expect(discoverOwnerRecovery(db,h(1),'2')).rejects.toThrow('loss_changed');
});

test('a completed relay cut returns only its matching request ID, never login credentials',async()=>{
 const {fake,db}=fixture();fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${h(1)}`,{identity:h(1),recoveryCommitment:operation.proof.nextCommitment});
 const recovery={identity:h(1),authorizationTxHash:h(8),destination:operation.destination,nextCommitment:operation.proof.nextCommitment,
  nextSigningRoot:operation.proof.nextSigningRoot,consumedCommitment:sha256(concat([operation.proof.recoverySecret,operation.proof.signingRoot]))};
 fake.store.set(`${RECOURSE_COLLECTIONS.recoveries}/${h(40)}`,{...recovery,authSecret:'never returned'});
 const result=await discoverOwnerRecovery(db,h(1),'2');expect(result.candidates[0].completedRequestId).toBe(h(40));
 expect(JSON.stringify(result)).not.toContain('never returned');
 fake.store.set(`${RECOURSE_COLLECTIONS.recoveries}/${h(41)}`,recovery);
 await expect(discoverOwnerRecovery(db,h(1),'2')).rejects.toThrow('recovery_changed');
 fake.store.delete(`${RECOURSE_COLLECTIONS.recoveries}/${h(41)}`);fake.store.delete(`${RECOURSE_COLLECTIONS.recoveries}/${h(40)}`);
 await expect(discoverOwnerRecovery(db,h(1),'2')).rejects.toThrow('recovery_missing');
});

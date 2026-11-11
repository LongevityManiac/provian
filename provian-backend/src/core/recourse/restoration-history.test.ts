import type { Firestore } from 'firebase-admin/firestore';
import { sha256, toUtf8Bytes } from 'ethers';
import { discoverRestorationHistory } from './restoration-history';
import { RECOURSE_COLLECTIONS } from './ownership';
import { RESTORATION_REQUESTS } from './restoration-request';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
function fixture(){
 const fake=createFakeFirestore();fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${h(1)}`,{identity:h(1)});
 const snapshot={identity:h(1),occurrence:h(2),transactionHash:h(3),block:123,lossAtomic:'20'},membership={active:true};
 const evidence=JSON.stringify({snapshot,membership}),scope={request:h(2),lossHash:sha256(toUtf8Bytes(evidence)),maximumLoss:'20'};
 fake.store.set(`${RESTORATION_REQUESTS}/${h(2)}`,{identity:h(1),transactionHash:h(3),block:123,snapshot,membership,scope,evidence,status:'prepared'});
 fake.store.set(`${RESTORATION_REQUESTS}/${h(9)}`,{identity:h(9),secretPortfolio:'never return'});
 return {fake,db:fake as unknown as Firestore,scope,evidence};
}
test('returns exact single-binding evidence across statuses without granting authority or returning portfolio metadata',async()=>{
 const {fake,db,scope,evidence}=fixture();
 for(const status of ['prepared','authorized','executed']){
  fake.store.get(`${RESTORATION_REQUESTS}/${h(2)}`)!.status=status;
  expect(await discoverRestorationHistory(db,h(1))).toEqual({identity:h(1),candidates:[{scope,evidence}]});
 }
 expect(JSON.stringify(await discoverRestorationHistory(db,h(1)))).not.toContain('never return');
 await expect(discoverRestorationHistory(db,h(9))).rejects.toThrow('invalid');
});
test('changed evidence, scope, identity and transaction metadata are refused',async()=>{
 for(const change of [{evidence:'{}'},{block:124},{transactionHash:h(4)},{scope:{request:h(9),lossHash:h(8),maximumLoss:'20'}}]){
  const {fake,db}=fixture();Object.assign(fake.store.get(`${RESTORATION_REQUESTS}/${h(2)}`)!,change);
  await expect(discoverRestorationHistory(db,h(1))).rejects.toThrow('changed');
 }
 const {fake,db}=fixture();const row=fake.store.get(`${RESTORATION_REQUESTS}/${h(2)}`)!;
 const snapshot={...(row.snapshot as object),identity:h(9)},evidence=JSON.stringify({snapshot,membership:row.membership});
 row.snapshot=snapshot;row.evidence=evidence;row.scope={...(row.scope as object),lossHash:sha256(toUtf8Bytes(evidence))};
 await expect(discoverRestorationHistory(db,h(1))).rejects.toThrow('changed');
});

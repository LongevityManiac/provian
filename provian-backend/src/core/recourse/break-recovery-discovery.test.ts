import type { Firestore } from 'firebase-admin/firestore';
import { discoverBreakRecovery } from './break-recovery-discovery';
import { checkStoredBreakEntitlement } from './break-entitlement-store';
import { reconcileBreakRestoration, BREAK_RESTORATIONS } from './break-restoration-queue';
import { RECOURSE_COLLECTIONS } from './ownership';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
jest.mock('./break-entitlement-store',()=>({breakEntitlementId:()=>'',checkStoredBreakEntitlement:jest.fn()}));
jest.mock('./break-restoration-queue',()=>({BREAK_RESTORATIONS:'restorations',reconcileBreakRestoration:jest.fn()}));
jest.mock('./break-restoration-data',()=>({parseBreakRestorationRequest:(v:unknown)=>v,
  breakRestorationDetails:(r:{identity:string;commitment:string})=>({identity:r.identity,amount:'100',commitment:r.commitment,
    snapshotProof:[],destination:'0x'+'03'.repeat(20)})}));
jest.mock('../protocol/runtime',()=>({currentProtocolDeployment:async()=>({manifestHash:'0x'+'04'.repeat(32)})}));
const identity=`0x${'01'.repeat(32)}`,origin=`0x${'02'.repeat(20)}`,destination=`0x${'03'.repeat(20)}`,tx=`0x${'05'.repeat(32)}`;
function fixture(){const fake=createFakeFirestore();
  fake.store.set(`${RECOURSE_COLLECTIONS.identities}/${identity}`,{ownerType:'human',walletId:'wallet'});
  fake.store.set('wallets/wallet',{address:`0x${'09'.repeat(20)}`});
  fake.store.set(`${BREAK_RESTORATIONS}/request`,{identity,request:{kernel:origin,ownerIntent:tx,data:'0x12',identity,commitment:'current'},executor:origin,authority:destination});
  return {fake,db:fake as unknown as Firestore};}
beforeEach(()=>{jest.resetAllMocks();jest.mocked(reconcileBreakRestoration).mockResolvedValue({id:'request',status:'confirmed',transactionHash:tx});});
test('a posted operation whose relay cut was interrupted yields a public receipt candidate without credentials or writes',async()=>{
  const {fake,db}=fixture(), before=JSON.stringify([...fake.store]);
  const result=await discoverBreakRecovery(db,origin,identity);
  expect(result.relayDestination).not.toBe(destination);expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({transactionHash:tx,prepared:{identity,destination}});
  expect(reconcileBreakRestoration).toHaveBeenCalledWith(db,'request');expect(JSON.stringify([...fake.store])).toBe(before);
});
test('an older break proof cannot appear as a current recovery candidate',async()=>{
  const {db}=fixture();jest.mocked(checkStoredBreakEntitlement).mockRejectedValue(Error('break_entitlement_proof_invalid'));
  expect((await discoverBreakRecovery(db,origin,identity)).candidates).toEqual([]);expect(reconcileBreakRestoration).not.toHaveBeenCalled();
});
test('chain disagreement stays an error and awaiting-authority records are not completed witnesses',async()=>{
  const {db}=fixture();jest.mocked(checkStoredBreakEntitlement).mockRejectedValueOnce(Error('rpc_disagreement'));
  await expect(discoverBreakRecovery(db,origin,identity)).rejects.toThrow('disagreement');
  jest.mocked(reconcileBreakRestoration).mockResolvedValue({id:'request',status:'awaiting_authority',transactionHash:null});
  expect((await discoverBreakRecovery(db,origin,identity)).candidates).toEqual([]);
});

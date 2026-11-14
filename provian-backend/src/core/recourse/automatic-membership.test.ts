jest.mock('../protocol/runtime', () => ({ currentProtocolDeployment: async () => ({ addresses: { recoursePool: `0x${'6'.padStart(40, '0')}` } }) }));
import { advanceMembershipDeparture } from './membership-departure';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { collectAutomaticMembershipOwner,runAutomaticMembershipSweep,AUTOMATIC_MEMBERSHIP_SWEEP } from './automatic-membership';
import { prepareMembershipDebit } from './membership-debit-preparation';
import { queueMembershipDebit } from './membership-debit-operation';
import { reconcileCurrentPrivateMembership,prepareMembershipTransition } from './membership-preparation';
import { readRecoursePoolState } from './pool-state';
import { breakDeploymentChain } from './break-deployment-queue';
import { readMembershipWiring } from './membership-wiring';
import { STANDING_MEMBERSHIP_ABI } from './membership-authorization';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
jest.mock('./membership-departure',()=>({advanceMembershipDeparture:jest.fn()}));
jest.mock('./membership-debit-preparation',()=>({prepareMembershipDebit:jest.fn()}));
jest.mock('./membership-debit-operation',()=>({queueMembershipDebit:jest.fn()}));
jest.mock('./membership-preparation',()=>({reconcileCurrentPrivateMembership:jest.fn(),prepareMembershipTransition:jest.fn()}));
jest.mock('./pool-state',()=>({readRecoursePoolState:jest.fn()}));
jest.mock('./break-deployment-queue',()=>({breakDeploymentChain:jest.fn()}));
jest.mock('./membership-wiring',()=>({readMembershipWiring:jest.fn()}));
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
function setup(){
 jest.resetAllMocks();
 const fake=createFakeFirestore({strictTransactionOrder:true}),db=fake as unknown as Firestore;
 const owner=h(1),binding=h(2),payer=a(3),domain={chainId:'8453',pointer:a(4),kernel:a(5),pool:a(6)};
 fake.store.set(`${R.owners}/${owner}`,{ownerIdentity:owner,membershipFixedDebitBinding:binding});
 fake.store.set(`${C.owners}/${owner}`,{ownerIdentity:owner});
 const state={addressConsent:true,currentAddress:payer,consentNonce:'1',participationBurnAtomic:'100',noEarningsContributionAtomic:'100',earningsBps:100};
 (readRecoursePoolState as jest.Mock).mockResolvedValue(state);
 const mandate:[bigint,bigint,number,bigint,bigint,bigint,string,string,boolean]=[100n,100n,100,1n,0n,1n,h(7),h(8),true];
 const agree=jest.fn(async()=>STANDING_MEMBERSHIP_ABI.encodeFunctionResult('standingMandate',mandate));
 (breakDeploymentChain as jest.Mock).mockReturnValue({deployment:async()=>({}),agree});
 (readMembershipWiring as jest.Mock).mockResolvedValue({standingMembership:a(9),pin:{blockHash:h(10)}});
 const challenge={reservationId:h(11),domain,debit:{binding,payer,month:'1',burn:'100',reserve:'0',nonce:'1',generation:'1',revision:'1',ruleHash:h(12),expiresAt:'1000'}};
 (prepareMembershipDebit as jest.Mock).mockResolvedValue({status:'ready',challenge});
 (prepareMembershipTransition as jest.Mock).mockResolvedValue({kind:'leave'});
 return {fake,db,owner,binding,payer,state,mandate,challenge,agree};
}
test('scheduled collection needs only the retained approval, never member presence, a key or ETH',async()=>{
 const s=setup();expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('queued');
 expect(reconcileCurrentPrivateMembership).toHaveBeenCalledWith(s.db,s.owner);
 expect(prepareMembershipDebit).toHaveBeenCalledWith(s.db,s.owner,s.payer);
 expect(queueMembershipDebit).toHaveBeenCalledWith(s.db,s.owner,s.challenge);
});
test('an invoice outside the standing approval is not queued',async()=>{
 const s=setup();(prepareMembershipDebit as jest.Mock).mockResolvedValue({status:'approval_required'});
 expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('approval_required');
 expect(queueMembershipDebit).not.toHaveBeenCalled();
});
test('a later primary change never redirects the fixed payer',async()=>{
 const s=setup();s.fake.store.get(`${R.owners}/${s.owner}`)!.primaryBinding=h(99);
 expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('queued');
 expect(readRecoursePoolState).toHaveBeenCalledWith(s.binding,expect.anything());
});
test('a departure is advanced in the background and freezes new debits',async()=>{
 const s=setup();s.fake.store.get(`${R.owners}/${s.owner}`)!.membershipTransition=h(20);
 expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('pending');
 expect(prepareMembershipTransition).toHaveBeenCalledWith(s.db,s.owner,{id:h(20)});expect(queueMembershipDebit).not.toHaveBeenCalled();
});
test('a completed departure or already settled month causes no debit',async()=>{
 const s=setup();s.state.addressConsent=false;expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('left');
 s.state.addressConsent=true;(prepareMembershipDebit as jest.Mock).mockResolvedValue({status:'settled'});
 expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('settled');expect(queueMembershipDebit).not.toHaveBeenCalled();
});
test('a failing owner cannot starve the next owner and the sweep cursor resets after a full pass',async()=>{
 const s=setup(),other=h(21);s.fake.store.set(`${C.owners}/${other}`,{ownerIdentity:other});s.fake.store.set(`${R.owners}/${other}`,{ownerIdentity:other,membershipFixedDebitBinding:h(22)});
 (reconcileCurrentPrivateMembership as jest.Mock).mockRejectedValueOnce(Error('temporarily_unavailable'));
 expect(await runAutomaticMembershipSweep(s.db)).toMatchObject({visited:2,retry:1,queued:1});
 expect(s.fake.store.get(`${AUTOMATIC_MEMBERSHIP_SWEEP}/cursor`)?.after).toBeNull();
});

test('a never-admitted first join still reconciles departure after the app closes',async()=>{
 const {PRIVATE_MEMBERSHIP_TRANSITIONS:T}=await import('./private-membership-transition');
 const s=setup();s.fake.store.delete(`${C.owners}/${s.owner}`);
 s.fake.store.set(`${T}/${h(88)}`,{id:h(88),ownerIdentity:s.owner,departureRequested:true,status:'preparing'});
 await runAutomaticMembershipSweep(s.db);
 expect(advanceMembershipDeparture).toHaveBeenCalledWith(s.db,s.owner,h(88));
});

test('a fully assessed settled member makes no chain reads until something is due or pending', async () => {
 const s=setup();
 const { utcCalendarMonth }=await import('./calendar-month');
 const month=utcCalendarMonth(Math.floor(Date.now()/1000));
 const account={ownerIdentity:s.owner,checkpoint:{pool:a(6)},needsScan:false,pendingReservation:null,
  episode:{joined:true,observedMonth:month,lastAssessedMonth:month,invoices:{[month]:{month,burnDueAtomic:'100',burnPaidAtomic:'100',
    reserveDueAtomic:'1',reservePaidAtomic:'1',noEarningsContributionAtomic:'100',earnings:{grossAtomic:'100'}}}}};
 s.fake.store.set(`${C.owners}/${s.owner}`,account);
 expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('settled');
 expect(reconcileCurrentPrivateMembership).not.toHaveBeenCalled();
 expect(breakDeploymentChain).not.toHaveBeenCalled();
 expect(readRecoursePoolState).not.toHaveBeenCalled();
 account.episode.invoices[month].reservePaidAtomic='0';
 expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('queued');
 expect(reconcileCurrentPrivateMembership).toHaveBeenCalledTimes(1);
});

test('a departed member with no outstanding amount stays idle across later months', async () => {
 const s=setup(),{utcCalendarMonth}=await import('./calendar-month'),month=utcCalendarMonth(Math.floor(Date.now()/1000));
 const account={ownerIdentity:s.owner,checkpoint:{pool:a(6)},needsScan:false,pendingReservation:null,
   episode:{joined:false,observedMonth:month-12,lastAssessedMonth:month-12,invoices:{[month-12]:{
     month:month-12,burnDueAtomic:'100',burnPaidAtomic:'100',reserveDueAtomic:'100',reservePaidAtomic:'100',
     noEarningsContributionAtomic:'100',earnings:{grossAtomic:'0'}}}}};
 s.fake.store.set(`${C.owners}/${s.owner}`,account);
 expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('settled');
 expect(reconcileCurrentPrivateMembership).not.toHaveBeenCalled();expect(readRecoursePoolState).not.toHaveBeenCalled();
 account.episode.invoices[month-12].reservePaidAtomic='0';
 expect(await collectAutomaticMembershipOwner(s.db,s.owner)).toBe('queued');
 expect(reconcileCurrentPrivateMembership).toHaveBeenCalledTimes(1);
});

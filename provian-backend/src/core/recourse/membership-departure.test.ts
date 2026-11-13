import { Wallet, getBytes, sha256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { prepareDepartureCredentials, retainDepartureCredentials } from './membership-departure';
import { ownedMembershipTransition } from './membership-preparation';
import { currentProtocolDeployment } from '../protocol/runtime';
import { readRecoursePoolState } from './pool-state';
import { readMembershipWiring } from './membership-wiring';
import { breakDeploymentChain } from './break-deployment-queue';
import { STANDING_MEMBERSHIP_ABI, authenticatedDepartureSigningHash } from './membership-authorization';
import { MEMBERSHIP_CONSENT_OPERATIONS as Q, membershipConsentOperationId } from './membership-operation-identifiers';
import { PRIVATE_MEMBERSHIP_TRANSITIONS as T } from './private-membership-transition';
jest.mock('./membership-preparation', () => ({ownedMembershipTransition:jest.fn(),prepareMembershipTransition:jest.fn()}));
jest.mock('../protocol/runtime', () => ({currentProtocolDeployment:jest.fn()}));
jest.mock('./pool-state', () => ({readRecoursePoolState:jest.fn()}));
jest.mock('./membership-wiring', () => ({readMembershipWiring:jest.fn()}));
jest.mock('./break-deployment-queue', () => ({breakDeploymentChain:jest.fn()}));
const h=(b:string)=>`0x${b.repeat(32)}`,a=(b:string)=>`0x${b.repeat(20)}`;
function fixture(){
 const fake=createFakeFirestore({strictTransactionOrder:true}),db=fake as unknown as Firestore;
 const wallet=new Wallet(h('11')),owner=h('12'),id=h('13'),binding=h('14');
 const domain={chainId:'8453',pointer:a('15'),kernel:a('16'),pool:a('17')};
 const consent={binding,account:wallet.address.toLowerCase(),nonce:'0',joined:true,revision:'1',ruleHash:h('18'),expiresAt:'1300'};
 const standing={consent,admissionMonth:'23640',rejoinPayments:[],fixedChargePayer:true,burnLimit:'100',reserveLimit:'100',earningsBpsLimit:100,exitCommitment:sha256(h('19')),exitSalt:h('20')};
 const request={transitionId:id,domain,consent,standing,exitSecret:null};
 const qid=membershipConsentOperationId(request);
 const operation={id,ownerIdentity:owner,kind:'join',departureRequested:true,status:'consenting',pool:domain.pool,kernel:domain.kernel,bindings:[{binding}]};
 fake.store.set(`${T}/${id}`,operation);
 const deployment={pointer:domain.pointer,addresses:{kernel:domain.kernel,recoursePool:domain.pool},revision:1n,block:10,blockHash:h('21'),manifestHash:h('22')};
 const state={pool:domain.pool,kernel:domain.kernel,block:10,blockHash:deployment.blockHash,timestamp:1000,currentAddress:consent.account,addressConsent:false,consentNonce:'0',signedRuleHash:consent.ruleHash};
 jest.mocked(ownedMembershipTransition).mockImplementation(async()=>operation as never);
 jest.mocked(currentProtocolDeployment).mockResolvedValue(deployment as never);
 jest.mocked(readRecoursePoolState).mockResolvedValue(state as never);
 jest.mocked(readMembershipWiring).mockResolvedValue({standingMembership:a('23'),pin:{blockHash:deployment.blockHash,requireCanonical:true}} as never);
 const chain={deployment:async()=>deployment,agree:jest.fn(async(method:string)=>method==='eth_getCode'?'0x':STANDING_MEMBERSHIP_ABI.encodeFunctionResult('standingMandate',[0,0,0,0,0,1,h('00'),h('00'),false]))};
 jest.mocked(breakDeploymentChain).mockReturnValue(chain as never);
 return {fake,db,wallet,owner,id,binding,domain,consent,standing,request,qid,operation,deployment,state};
}
beforeEach(()=>jest.clearAllMocks());
test('review: admission confirmed after pinned read must not disappear from departure credential coverage',async()=>{
 const f=fixture();
 f.fake.store.set(`${Q}/${f.qid}`,{request:f.request,status:'submitted',transactionHash:h('24')});
 jest.mocked(readRecoursePoolState).mockImplementation(async()=>{
   // Admission lands in block 11 while this RPC returns pinned block 10.
   f.fake.store.get(`${Q}/${f.qid}`)!.status='confirmed';
   return f.state as never;
 });
 const challenges=await prepareDepartureCredentials(f.db,f.owner,f.id);
 expect(challenges).toEqual(expect.arrayContaining([expect.objectContaining({exitCommitment:f.standing.exitCommitment})]));
});
test('review: revocation proof safely survives a same-domain revision change',async()=>{
 const f=fixture();
 f.operation.kind='leave';f.deployment.revision=2n;
 f.state.addressConsent=true;f.state.consentNonce='1';
 const challenge={domain:f.domain,consent:{...f.consent,joined:false,nonce:'1',revision:'1'},exitSalt:null,exitCommitment:null};
 const ownerSignature=await f.wallet.signMessage(getBytes(authenticatedDepartureSigningHash(challenge.domain,challenge.consent)));
 expect(authenticatedDepartureSigningHash(challenge.domain,challenge.consent)).toBe(authenticatedDepartureSigningHash(challenge.domain,{...challenge.consent,revision:'2',ruleHash:h('31'),expiresAt:'9999'}));
 expect(authenticatedDepartureSigningHash(challenge.domain,challenge.consent)).not.toBe(authenticatedDepartureSigningHash(challenge.domain,{...challenge.consent,nonce:'2'}));
 await expect(retainDepartureCredentials(f.db,f.owner,f.id,[{challenge,exitSecret:null,ownerSignature}])).resolves.toBeUndefined();
});

test('review: valid current plus queued proof superset survives renewal landing between GET and POST',async()=>{
 const f=fixture();
 const oldSecret=h('32'),oldCommitment=sha256(oldSecret),newSecret=h('19');
 // Current mandate was approved in an older completed transition, therefore
 // this transition only stores the pending renewal. GET saw both mandates.
 f.consent.nonce='1';
 const request={...f.request,consent:f.consent,standing:{...f.standing,consent:f.consent}};
 const qid=membershipConsentOperationId(request);
 f.fake.store.set(`${Q}/${qid}`,{request,status:'confirmed',transactionHash:h('24')});
 f.state.addressConsent=true;f.state.consentNonce='2';
 const chain=jest.mocked(breakDeploymentChain)();
 jest.mocked(chain.agree).mockImplementation(async()=>STANDING_MEMBERSHIP_ABI.encodeFunctionResult('standingMandate',[100,100,100,0,0,2,f.standing.exitCommitment,f.standing.exitSalt,true]));
 const old={challenge:{domain:f.domain,consent:{...f.consent,joined:false},exitSalt:h('33'),exitCommitment:oldCommitment},exitSecret:oldSecret,ownerSignature:null};
 const future={challenge:{domain:f.domain,consent:{...f.consent,nonce:'2',joined:false},exitSalt:f.standing.exitSalt,exitCommitment:f.standing.exitCommitment},exitSecret:newSecret,ownerSignature:null};
 await expect(retainDepartureCredentials(f.db,f.owner,f.id,[old,future])).resolves.toBeUndefined();
});
test('review: a failed pre-recovery renewal cannot demand the old account in a fresh departure',async()=>{
 const f=fixture();
 f.consent.nonce='1';
 const request={...f.request,consent:f.consent,standing:{...f.standing,consent:f.consent}};
 const qid=membershipConsentOperationId(request);
 f.fake.store.set(`${Q}/${qid}`,{request,status:'failed',transactionHash:null});
 // Recovery changes the consent account without consuming its consent nonce.
 f.state.currentAddress=new Wallet(h('34')).address.toLowerCase();
 f.state.addressConsent=true;f.state.consentNonce='1';
 const chain=jest.mocked(breakDeploymentChain)();
 jest.mocked(chain.agree).mockImplementation(async()=>STANDING_MEMBERSHIP_ABI.encodeFunctionResult('standingMandate',[100,100,100,0,0,1,f.standing.exitCommitment,f.standing.exitSalt,true]));
 const challenges=await prepareDepartureCredentials(f.db,f.owner,f.id);
 expect(challenges.every(c=>c.consent.account===f.state.currentAddress)).toBe(true);
 expect(challenges).toHaveLength(1);
});

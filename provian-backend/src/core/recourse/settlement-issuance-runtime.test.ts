import { Interface } from 'ethers';
import { issuanceBatchFixture } from './__test-helpers__/issuance-batch-fixture';
import { a,h,old,pointer } from './__test-helpers__/membership-receipt-fixture';
import { preparePrivateIssuanceExecution, preparePrivateIssuanceProbe } from './settlement-issuance-runtime';
import { currentProtocolDeployment } from '../protocol/runtime';
import { resolveHistoricalProtocolDeployment } from '../protocol/pointer';
import { createRecourseChainPort } from './chain-ledger';
import { breakDeploymentChain } from './break-deployment-queue';
import { readMembershipWiring } from './membership-wiring';
import { readRecoursePoolState } from './pool-state';
import { readPrivateCalendarRules } from './private-calendar-rules';
import { reconcileCurrentPrivateMembership } from './membership-preparation';
import { reconcileAddressIssuance,reconcilePrivateIssuanceSuccession } from './private-issuance-succession';
import { configuredIdentityAttestor,assertIdentityAttestation } from './identity-attestor';
import { PRIVATE_ISSUANCE_ADDRESSES as A,PRIVATE_ISSUANCE_BATCHES as B } from './issuance-lock';
import { PRIVATE_MEMBERSHIP_COLLECTIONS as C, type PrivateMembershipAccount } from './private-membership-reservation';
import { RECOURSE_COLLECTIONS as R } from './ownership';
import { SETTLEMENT_BATCHES_COLLECTION as P } from '../pvt/settlement/durable-settlement-store';
import { KERNEL_OBSERVATION_ABI } from '../pvt/settlement/settlement-chain-adapter';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { joinPrivateMembership, type PrivateCalendarRules } from './private-membership-calendar';
import { seedMembershipJournal } from './__test-helpers__/membership-journal-fixture';
import { MEMBER_SETTLEMENT_ABI } from './issuance-ticket';
import { utcCalendarMonth } from './calendar-month';
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('../protocol/runtime',()=>({currentProtocolDeployment:jest.fn()}));
jest.mock('../protocol/pointer',()=>({resolveHistoricalProtocolDeployment:jest.fn()}));
jest.mock('./chain-ledger',()=>({createRecourseChainPort:jest.fn()}));
jest.mock('./break-deployment-queue',()=>({breakDeploymentChain:jest.fn()}));
jest.mock('./membership-wiring',()=>({readMembershipWiring:jest.fn()}));
jest.mock('./pool-state',()=>({readRecoursePoolState:jest.fn()}));
jest.mock('./private-calendar-rules',()=>({readPrivateCalendarRules:jest.fn()}));
jest.mock('./membership-preparation',()=>({reconcileCurrentPrivateMembership:jest.fn()}));
jest.mock('./private-issuance-succession',()=>({reconcileAddressIssuance:jest.fn(),reconcilePrivateIssuanceSuccession:jest.fn()}));
jest.mock('./identity-attestor',()=>({configuredIdentityAttestor:jest.fn(),assertIdentityAttestation:jest.fn()}));
jest.mock('../protocol/pointer-pin.generated',()=>({PROTOCOL_POINTER_PIN:{address:'0x0000000000000000000000000000000000000001',runtimeHash:require('ethers').keccak256('0x6000')}}));
const gas=a(901),attestor=a(900),timestamp=1700000000,month=utcCalendarMonth(timestamp);
const rules:PrivateCalendarRules=()=>({ruleHash:h(9),rule:{schema:'provian-recourse-membership/v1',chainId:8453,pointer,firstMonth:0,participationBurnAtomic:'100',noEarningsContributionAtomic:'100',earningsBps:100}});
function setup(member=false){
 const s=issuanceBatchFixture();
 const state={timestamp,revision:1n,manifest:h(800),consentNonce:'0',unknownBinding:false,signatureValid:true};
 const deployment=()=>({pointer,revision:state.revision,manifestHash:state.manifest,blockHash:h(99),addresses:{kernel:old[0],recoursePool:old[8],settlement:old[9]}});
 (currentProtocolDeployment as jest.Mock).mockImplementation(async()=>deployment());
 (resolveHistoricalProtocolDeployment as jest.Mock).mockImplementation(async()=>deployment());
 (createRecourseChainPort as jest.Mock).mockReturnValue({finalizedBlock:async()=>99,blockHash:async()=>h(99)});
 (readMembershipWiring as jest.Mock).mockResolvedValue({identityAttestor:attestor,gasPayer:gas,pin:{blockHash:h(99),requireCanonical:true}});
 (readPrivateCalendarRules as jest.Mock).mockResolvedValue(rules);
 (reconcileCurrentPrivateMembership as jest.Mock).mockResolvedValue(undefined);
 (reconcileAddressIssuance as jest.Mock).mockResolvedValue(undefined);
 (reconcilePrivateIssuanceSuccession as jest.Mock).mockResolvedValue('current');
 (readRecoursePoolState as jest.Mock).mockImplementation(async()=>({currentAddress:a(3),signedRuleHash:h(9),consentNonce:state.consentNonce,addressConsent:member}));
 const kernel=new Interface(KERNEL_OBSERVATION_ABI);
 const agree=jest.fn(async(method:string,params:readonly unknown[])=>{
  if(method==='eth_getBlockByHash'||method==='eth_getBlockByNumber')return {hash:h(99),number:'0x63',timestamp:`0x${state.timestamp.toString(16)}`};
  if(method==='eth_call'){
   const call=params[0] as {to:string;data:string};
   if(call.to===old[0])return kernel.encodeFunctionResult('getEpochPolicy',[[true,1,0,1,10n**18n,1000,1000,a(10),a(11),50,[a(12),h(1),1],[a(13),h(1),1],h(601)]]);
   const parsed=RECOURSE_POOL_ABI.parseTransaction({data:call.data})!;
   if(parsed.name==='poolHistoryReady')return RECOURSE_POOL_ABI.encodeFunctionResult('poolHistoryReady',[true]);
   if(parsed.name==='monthlyRule')return RECOURSE_POOL_ABI.encodeFunctionResult('monthlyRule',[[0,100,100,100,h(9)]]);
   if(parsed.name==='ownerOf')return RECOURSE_POOL_ABI.encodeFunctionResult('ownerOf',[String(parsed.args[0]).toLowerCase()===a(3)?h(3):state.unknownBinding?h(4):h(0)]);
  }
  throw Error('unexpected call');
 });
 (breakDeploymentChain as jest.Mock).mockReturnValue({deployment:async()=>deployment(),agree});
 const sign=jest.fn(async(message:Uint8Array)=>{
  expect(message).toBeInstanceOf(Uint8Array);expect(message).toHaveLength(32);
  const id=s.fake.store.get(`${P}/${h(600)}`)?.membership_issuance_id;
  expect(typeof id).toBe('string');expect(s.fake.store.get(`${B}/${id}`)?.status).toBe('reserved');
  for(const address of [a(3),a(4)])expect(s.fake.store.get(`${A}/${address}`)?.batchId).toBe(id);
  return '0x1234';
 });
 (configuredIdentityAttestor as jest.Mock).mockReturnValue({address:attestor,signBytes:sign});
 (assertIdentityAttestation as jest.Mock).mockImplementation(async()=>{if(!state.signatureValid)throw Error('invalid attestation');});
 if(member){
  const account:PrivateMembershipAccount=seedMembershipJournal(s.fake.store,{ownerIdentity:h(500),version:0,episode:joinPrivateMembership(null,month,rules),checkpoint:{pool:old[8],block:99,blockHash:h(99)},pendingReservation:null,needsScan:false},{chainId:'8453',kernel:old[0],pool:old[8],block:98,blockHash:h(98),logIndex:1,timestamp:timestamp-1});
  s.fake.store.set(`${C.owners}/${h(500)}`,{...account});s.fake.store.set(`${R.identities}/${h(3)}`,{identity:h(3),ownerIdentity:h(500),recoveryGeneration:0});
 }
 return {...s,state,sign,agree};
}
beforeEach(()=>jest.resetAllMocks());
test('a reverting probe needs no parent reservation and creates no reusable signature or financial lock',async()=>{
 const s=setup(true);s.fake.store.delete(`${P}/${h(600)}`);
 const before=new Map(s.fake.store);
 const probe=await preparePrivateIssuanceProbe(s.db,s.parent,gas,{});
 const decoded=MEMBER_SETTLEMENT_ABI.decodeFunctionData('probeMemberBatch',probe.data);
 expect(decoded[0]).toBe(s.parent.calldata);expect(decoded[2].map((t:{protectedMember:boolean})=>t.protectedMember)).toEqual([true,false]);
 expect(s.sign).not.toHaveBeenCalled();expect(s.fake.store).toEqual(before);
});
test('all classifications and parent link persist before raw-byte signing; restart reuses exact outer bytes',async()=>{
 const s=setup(true),record=await preparePrivateIssuanceExecution(s.db,s.parent,gas,{});
 expect(record.status).toBe('signed');expect(record.batch.tickets.map(t=>[t.protectedMember,t.contribution])).toEqual([[true,'1'],[false,'0']]);
 expect(MEMBER_SETTLEMENT_ABI.decodeFunctionData('settleMemberBatch',record.calldata!)[0]).toBe(s.parent.calldata);
 expect(s.fake.store.get(`${P}/${h(600)}`)?.calldata).toBe(s.parent.calldata);
 expect((await preparePrivateIssuanceExecution(s.db,s.parent,gas,{})).calldata).toBe(record.calldata);expect(s.sign).toHaveBeenCalledTimes(1);
 expect(assertIdentityAttestation).toHaveBeenCalledTimes(2);expect(reconcilePrivateIssuanceSuccession).toHaveBeenCalledWith(s.db,record.batch.id);
});
test('pointer revision or calendar rollover during signing retains locks and refuses to retain an obsolete signature',async()=>{
 for(const change of ['revision','month']){const s=setup();s.sign.mockImplementationOnce(async()=>{if(change==='revision')s.state.revision=2n;else s.state.timestamp+=40*86400;return '0x1234';});
 await expect(preparePrivateIssuanceExecution(s.db,s.parent,gas,{})).rejects.toThrow('stale');
 const id=s.fake.store.get(`${P}/${h(600)}`)?.membership_issuance_id;expect(s.fake.store.get(`${B}/${id}`)).toMatchObject({status:'reserved',signature:null});expect(s.fake.store.get(`${A}/${a(4)}`)?.batchId).toBe(id);}
});
test('public binding with no private owner cannot be signed as an unregistered zero-contribution recipient',async()=>{
 const s=setup();s.state.unknownBinding=true;await expect(preparePrivateIssuanceExecution(s.db,s.parent,gas,{})).rejects.toThrow('unknown_binding');expect(s.sign).not.toHaveBeenCalled();expect(s.fake.store.has(`${B}/${s.batch.id}`)).toBe(false);
});
test('changed consent or invalid attestor refuses retry without replacing retained signed bytes',async()=>{
 const s=setup(),r=await preparePrivateIssuanceExecution(s.db,s.parent,gas,{});s.state.consentNonce='1';
 await expect(preparePrivateIssuanceExecution(s.db,s.parent,gas,{})).rejects.toThrow('consent');s.state.consentNonce='0';s.state.signatureValid=false;
 await expect(preparePrivateIssuanceExecution(s.db,s.parent,gas,{})).rejects.toThrow('invalid attestation');expect(s.fake.store.get(`${B}/${r.batch.id}`)?.calldata).toBe(r.calldata);expect(s.sign).toHaveBeenCalledTimes(1);
});
test('missing coordinator referenced by a parent fails before signing or recreating classifications',async()=>{
 const s=setup(),r=await preparePrivateIssuanceExecution(s.db,s.parent,gas,{});s.fake.store.delete(`${B}/${r.batch.id}`);
 await expect(preparePrivateIssuanceExecution(s.db,s.parent,gas,{})).rejects.toThrow('parent');expect(s.sign).toHaveBeenCalledTimes(1);
});

test('unavailable authority or missing public consent refuses before any private reservation',async()=>{
 for(const mismatch of ['authority','consent']){const s=setup(true);
 if(mismatch==='authority')(configuredIdentityAttestor as jest.Mock).mockReturnValue({address:a(999),signBytes:s.sign});
 else(readRecoursePoolState as jest.Mock).mockResolvedValue({currentAddress:a(3),signedRuleHash:h(9),consentNonce:'0',addressConsent:false});
 await expect(preparePrivateIssuanceExecution(s.db,s.parent,gas,{})).rejects.toThrow(mismatch==='authority'?'attestor':'unreconciled_membership');
 expect(s.sign).not.toHaveBeenCalled();expect(s.fake.store.get(`${P}/${h(600)}`)?.membership_issuance_id).toBeUndefined();}
});

test('parent retirement during signing, verification or signed retry never retains or returns executable bytes',async()=>{
 for(const phase of ['sign','verify','retry']){
  const s=setup();
  const retire=()=>s.fake.store.set(`${P}/${h(600)}`,{...s.fake.store.get(`${P}/${h(600)}`)!,status:'dead'});
  if(phase==='sign')s.sign.mockImplementationOnce(async()=>{retire();return '0x1234';});
  if(phase==='verify')(assertIdentityAttestation as jest.Mock).mockImplementationOnce(async()=>retire());
  if(phase==='retry'){await preparePrivateIssuanceExecution(s.db,s.parent,gas,{});retire();}
  await expect(preparePrivateIssuanceExecution(s.db,s.parent,gas,{})).rejects.toThrow(phase==='verify'?'parent':'reservation');
  const id=s.fake.store.get(`${P}/${h(600)}`)?.membership_issuance_id;
  expect(s.fake.store.get(`${B}/${id}`)?.status).toBe(phase==='retry'?'signed':'reserved');
 }
});

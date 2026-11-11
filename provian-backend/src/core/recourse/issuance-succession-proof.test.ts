import { issuanceSuccessionFixture as setup } from './__test-helpers__/issuance-succession-fixture';
import { old,h } from './__test-helpers__/membership-receipt-fixture';
import { readIssuanceSuccession,assertIssuanceSuccession } from './issuance-succession-proof';
jest.mock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:jest.fn()}));
jest.mock('../onchain/economic-discovery',()=>({getAgreedBaseLogs:jest.fn()}));
jest.mock('../protocol/pointer',()=>({resolveHistoricalProtocolDeployment:jest.fn()}));
jest.mock('./chain-ledger',()=>({createRecourseChainPort:jest.fn()}));
jest.mock('./membership-succession-checkpoint',()=>({findMembershipSuccessionCheckpoint:jest.fn()}));
jest.mock('../protocol/pointer-pin.generated',()=>({PROTOCOL_POINTER_PIN:{address:'0x0000000000000000000000000000000000000001',runtimeHash:require('ethers').keccak256('0x6000')}}));
const source = { kernel:old[0],pool:old[8] };
beforeEach(()=>jest.resetAllMocks());
test('retirement proof binds exact canonical cutoff and independent batch endpoint states without any membership',async()=>{
 const s=setup(),p=await readIssuanceSuccession(source,h(600));expect(p).toMatchObject({settled:false,cancelled:false,cutoff:{block:100},afterBreak:true});
 expect(()=>assertIssuanceSuccession(p!)).not.toThrow();expect(Object.isFrozen(p)).toBe(true);expect(()=>assertIssuanceSuccession({...p!})).toThrow('unverified');
 s.settled=true;expect(await readIssuanceSuccession(source,h(600))).toMatchObject({settled:true,cancelled:false});
 s.cancelled=true;await expect(readIssuanceSuccession(source,h(600))).rejects.toThrow('batch_state');
 s.settled=false;expect(await readIssuanceSuccession(source,h(600))).toMatchObject({settled:false,cancelled:true});
 s.current=true;expect(await readIssuanceSuccession(source,h(600))).toBeNull();
});
test('unretired, unpublished, premature, unfinalized, disagreeing or changed canonical checkpoints grant no release',async()=>{
 for(const field of ['retired','publication','activation','premature','disagreement','reorg','final'] as const){
  const s=setup();if(field==='final')s.final=119;else if(['retired','publication','activation'].includes(field))s[field as 'retired']=false;else s[field as 'premature']=true;
  await expect(readIssuanceSuccession(source,h(600))).rejects.toThrow('recourse_issuance_succession_');
 }
});

test('ordinary succession cannot discard an issuance after its cutoff; a break retains that discarded branch',async()=>{
 const s=setup();s.afterBreak=false;s.lateSettlement=true;
 await expect(readIssuanceSuccession(source,h(600))).rejects.toThrow('ordinary_rollback');
 s.afterBreak=true;expect(await readIssuanceSuccession(source,h(600))).toMatchObject({settled:false,afterBreak:true});
});

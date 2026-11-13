import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface, ZeroAddress } from 'ethers';
import { readRestorationBreakdown } from './restoration-breakdown';
import { readOwnerChainState, type OwnerChainNetwork } from './owner-chain';
import { readFinalizedReceipt } from './finalized-receipt';
import { RECOURSE_POOL_ABI } from './pool-abi';
vi.mock('./owner-chain', () => ({ readOwnerChainState: vi.fn() }));
vi.mock('./finalized-receipt', () => ({ readFinalizedReceipt: vi.fn() }));
const a=(n:string)=>`0x${n.repeat(40)}`, h=(n:string)=>`0x${n.repeat(64)}`;
const abi=new Interface(['function previousAuthorization() view returns(address)',
  'event TheftReversed(bytes32 indexed request,bytes32 indexed identity,address indexed destination,uint256 amount,bytes32 evidenceHash)']);
function fixture({prior=false,unrelated=false,disagree=false,determined=true,changed=false}={}) {
  const deployment={manifestHash:h('1'),blockHash:h('2'),addresses:{recoursePool:a('3')}};
  vi.mocked(readOwnerChainState).mockResolvedValue({deployment,executor:a('4')} as Awaited<ReturnType<typeof readOwnerChainState>>);
  const event=abi.encodeEventLog(abi.getEvent('TheftReversed')!,[h('5'),h('6'),a('7'),60n,h('8')]);
  vi.mocked(readFinalizedReceipt).mockResolvedValue({transactionHash:h('9'),blockHash:h('2'),blockNumber:10n,
    logs:[{address:prior?a('8'):a('4'),...event}]});
  return {deployment:async()=>({...deployment,manifestHash:changed?h('3'):h('1')}),rpcs:[0,1].map(leg=>({request:async(_m:string,params:readonly unknown[])=>{
    const data=(params[0] as {data:string}).data;
    if(data.startsWith(RECOURSE_POOL_ABI.getFunction('determined')!.selector))return RECOURSE_POOL_ABI.encodeFunctionResult('determined',[determined]);
    return abi.encodeFunctionResult('previousAuthorization',[unrelated||disagree&&leg===1?ZeroAddress:a('8')]);
  }}))} as unknown as OwnerChainNetwork;
}
beforeEach(()=>vi.clearAllMocks());
describe('restoration breakdown',()=>{
  it.each([false,true])('adds actual reversal to assigned pool amount, delivered=%s',async withdrawn=>{
    expect(await readRestorationBreakdown(h('6'),h('5'),h('9'),{amountAtomic:'40',withdrawn},fixture())).toEqual({reversedAtomic:'60',poolAtomic:'40',totalAtomic:'100'});
  });
  it('does not substitute requested shortfall for a smaller pool allocation',async()=>{
    expect((await readRestorationBreakdown(h('6'),h('5'),h('9'),{amountAtomic:'15',withdrawn:false},fixture())).totalAtomic).toBe('75');
  });
  it('supports confirmed reversal-only outcomes and inherited executors',async()=>{
    expect(await readRestorationBreakdown(h('6'),h('5'),h('9'),null,fixture({prior:true}))).toEqual({reversedAtomic:'60',poolAtomic:'0',totalAtomic:'60'});
  });
  it.each([{prior:true,unrelated:true},{prior:true,disagree:true},{determined:false},{changed:true}])('refuses unverified outcome %j',async options=>{
    await expect(readRestorationBreakdown(h('6'),h('5'),h('9'),null,fixture(options))).rejects.toThrow();
  });
  it('rejects a receipt for a different request instead of showing its amount',async()=>{
    const network=fixture();await expect(readRestorationBreakdown(h('6'),h('1'),h('9'),null,network)).rejects.toThrow('event_missing');
  });
});

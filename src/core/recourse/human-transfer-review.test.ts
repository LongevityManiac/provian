import { beforeEach, expect, test, vi } from 'vitest';
import { Interface } from 'ethers';
import type { OwnerChainNetwork } from './owner-chain';
import { describeHumanTransfer, prepareHumanTransferReview } from './human-transfer-review';
const f=vi.hoisted(()=>({mismatch:false,retired:false,balance:'2000000',changed:false}));
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const abi=new Interface(['function transfer(address,uint256)','function transferCurrent(address,uint256,uint256)',
 'function decimals() view returns(uint8)','function symbol() view returns(string)','function balanceOf(address) view returns(uint256)']);
vi.mock('../protocol/transaction',()=>({assertCurrentProtocolTransaction:async()=>{if(f.retired)throw Error('retired');return{manifestHash:h(f.changed?2:1)};}}));
const network={deployment:async()=>({manifestHash:h(1),blockHash:h(10),revision:4,addresses:{kernel:a(3)}}),
 rpcs:[0,1].map(i=>({request:async(method:string,params:unknown[])=>{
  if(method==='eth_getBalance')return '0x1bc16d674ec80000';
  const tx=params[0] as{data:string};const call=abi.parseTransaction({data:tx.data})!;
  return abi.encodeFunctionResult(call.name,[call.name==='symbol'?'PVT':call.name==='decimals'?(f.mismatch&&i===1?18:6):f.balance]);
 }}))} as unknown as OwnerChainNetwork;
const input={id:h(1),account:a(1),auxiliaryBinding:null,recipient:a(2),token:a(3),amount:'1.5'};
beforeEach(()=>Object.assign(f,{mismatch:false,retired:false,balance:'2000000',changed:false}));
test('the exact review uses canonical token decimals and the current PVT revision',async()=>{
 const review=await prepareHumanTransferReview(input,network),call=abi.parseTransaction({data:review.intent.data})!;
 expect(call.name).toBe('transferCurrent');expect(String(call.args[1])).toBe('1500000');expect(String(call.args[2])).toBe('4');
 expect(review).toMatchObject({recipient:a(2),token:a(3),amount:'1.5',balance:'2.0',decimals:6});
 expect(await describeHumanTransfer(review.intent,network)).toEqual(review);
 const native=await prepareHumanTransferReview({...input,token:null},network);expect(native.intent.value).toBe('1500000000000000000');expect(native.intent.data).toBe('0x');
});
test('metadata disagreement, insufficient funds, retired addresses, changed pointer and altered calldata refuse review',async()=>{
 f.mismatch=true;await expect(prepareHumanTransferReview(input,network)).rejects.toThrow('metadata_disagreement');f.mismatch=false;
 f.balance='1000000';await expect(prepareHumanTransferReview(input,network)).rejects.toThrow('insufficient_balance');f.balance='2000000';
 f.retired=true;await expect(prepareHumanTransferReview(input,network)).rejects.toThrow('retired');f.retired=false;
 f.changed=true;await expect(prepareHumanTransferReview(input,network)).rejects.toThrow('state_changed');f.changed=false;
 const review=await prepareHumanTransferReview(input,network);
 await expect(describeHumanTransfer({...review.intent,data:review.intent.data+'00'},network)).rejects.toThrow('invalid');
 await expect(prepareHumanTransferReview({...input,amount:'1.0000001'},network)).rejects.toThrow();
});

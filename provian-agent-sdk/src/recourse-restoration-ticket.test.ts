import { beforeEach, expect, test, vi } from 'vitest';
import { Interface } from 'ethers';
import { verifyContinuedRestoration, hasContinuedRestoration, readContinuedRestorationStatus } from './recourse-restoration-ticket';
import type { OwnerChainNetwork } from './recourse-owner-chain';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const f=vi.hoisted(()=>({wrongDestination:false}));
vi.mock('./recourse-owner-chain',()=>({readOwnerChainState:async()=>({destination:f.wrongDestination?a(99):a(3),executor:a(4),deployment:{blockHash:h(5),manifestHash:h(6),addresses:{recoursePool:a(9)}}})}));
const abi=new Interface(['function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))']);
const scope={request:h(1),lossHash:h(2),maximumLoss:'10'};
function fixture(change?:string){const rpc=(leg:number)=>({request:async(method:string,params:readonly unknown[])=>{
 expect(method).toBe('eth_call');expect(params).toEqual([{to:a(4),data:abi.encodeFunctionData('restorationIntent',[scope.request])},{blockHash:h(5),requireCanonical:true}]);
 if(change==='absent'||change==='absent-drift')return abi.encodeFunctionResult('restorationIntent',[[h(0),h(0),a(0),h(0),0]]);
 return abi.encodeFunctionResult('restorationIntent',[[scope.request,change==='owner'?h(99):h(7),a(8),scope.lossHash,change==='amount'||change==='disagree'&&leg===1?'11':'10']]);
}});return{rpcs:[rpc(0),rpc(1)],deployment:async()=>({manifestHash:change==='manifest'||change==='absent-drift'?h(99):h(6)})}as unknown as OwnerChainNetwork;}
beforeEach(()=>{f.wrongDestination=false;});
test('an existing bounded loss follows current owner destination while retaining its original scope',async()=>{
 await expect(verifyContinuedRestoration(h(7),a(3),scope,fixture())).resolves.toBeUndefined();
});
test('foreign identity, changed amount, stale destination, manifest drift and RPC disagreement cannot create a continuation',async()=>{
 for(const change of ['owner','amount','manifest','disagree'])await expect(verifyContinuedRestoration(h(7),a(3),scope,fixture(change))).rejects.toThrow('recourse_restoration_ticket_');
 f.wrongDestination=true;await expect(verifyContinuedRestoration(h(7),a(3),scope,fixture())).rejects.toThrow('changed');
});

test('only a fully absent ticket in unchanged canonical state is omitted from historical carry',async()=>{
 expect(await hasContinuedRestoration(h(7),a(3),scope,fixture('absent'))).toBe(false);
 await expect(verifyContinuedRestoration(h(7),a(3),scope,fixture('absent'))).rejects.toThrow('changed');
 await expect(hasContinuedRestoration(h(7),a(3),scope,fixture('absent-drift'))).rejects.toThrow('changed');
 await expect(hasContinuedRestoration(h(7),a(3),scope,fixture('amount'))).rejects.toThrow('changed');
});

test('reversal and pool determinations are terminal only when both independent readers agree',async()=>{
 const statusAbi=new Interface(['function reversalExecuted(bytes32) view returns(bool)','function determined(bytes32) view returns(bool)']);
 for(const mode of ['pending','reversal','determined','disagree'] as const){const base=fixture(),network={...base,rpcs:base.rpcs.map((rpc,index)=>({request:async(method:string,params:readonly unknown[])=>{
  const call=params[0] as {to:string;data:string};const decoded=statusAbi.parseTransaction({data:call.data});
  if(!decoded)return rpc.request(method,params);
  expect(params[1]).toEqual({blockHash:h(5),requireCanonical:true});expect(call.to).toBe(decoded.name==='determined'?a(9):a(4));
  return statusAbi.encodeFunctionResult(decoded.name,[mode==='reversal'&&decoded.name==='reversalExecuted'||mode==='determined'&&decoded.name==='determined'||mode==='disagree'&&index===1]);
 }})) as unknown as OwnerChainNetwork['rpcs']};
 if(mode==='disagree')await expect(readContinuedRestorationStatus(h(7),a(3),scope,network)).rejects.toThrow('disagreement');
 else expect(await readContinuedRestorationStatus(h(7),a(3),scope,network)).toBe(mode==='pending'?'pending':'executed');
 }
});

test('completed history without an intent is terminal only for its independently verified owner',async()=>{
 const historyAbi=new Interface(['function reversalExecuted(bytes32) view returns(bool)','function determined(bytes32) view returns(bool)',
 'function reversalEvidence(bytes32) view returns(tuple(bytes32 identity,uint256 shortfall,bytes32 evidenceHash))','function occurrenceDetermined(bytes32,bytes32) view returns(bool)']);
 for(const mode of ['reversal','foreign-reversal','declined','foreign-decline','absent'] as const){const base=fixture('absent'),network={...base,rpcs:base.rpcs.map(rpc=>({request:async(method:string,params:readonly unknown[])=>{
  const call=params[0] as {to:string;data:string},decoded=historyAbi.parseTransaction({data:call.data});if(!decoded)return rpc.request(method,params);
  const values:Record<string,unknown>={reversalExecuted:mode.includes('reversal'),determined:mode.includes('declin'),
   reversalEvidence:[mode==='foreign-reversal'?h(99):h(7),0,h(8)],occurrenceDetermined:mode==='declined'};
  return historyAbi.encodeFunctionResult(decoded.name,[values[decoded.name]]);
 }})) as unknown as OwnerChainNetwork['rpcs']};
 if(mode.startsWith('foreign'))await expect(readContinuedRestorationStatus(h(7),a(3),scope,network)).rejects.toThrow('changed');
 else expect(await readContinuedRestorationStatus(h(7),a(3),scope,network)).toBe(mode==='absent'?'absent':'executed');
 }
});

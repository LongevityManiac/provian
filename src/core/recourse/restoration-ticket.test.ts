import { beforeEach, expect, test, vi } from 'vitest';
import { Interface } from 'ethers';
import { verifyContinuedRestoration } from './restoration-ticket';
import type { OwnerChainNetwork } from './owner-chain';
const h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const f=vi.hoisted(()=>({wrongDestination:false}));
vi.mock('./owner-chain',()=>({readOwnerChainState:async()=>({destination:f.wrongDestination?a(99):a(3),executor:a(4),deployment:{blockHash:h(5),manifestHash:h(6)}})}));
const abi=new Interface(['function restorationIntent(bytes32) view returns(tuple(bytes32 request,bytes32 identity,address destination,bytes32 lossHash,uint256 maximumLoss))']);
const scope={request:h(1),lossHash:h(2),maximumLoss:'10'};
function fixture(change?:string){const rpc=(leg:number)=>({request:async(method:string,params:readonly unknown[])=>{
 expect(method).toBe('eth_call');expect(params).toEqual([{to:a(4),data:abi.encodeFunctionData('restorationIntent',[scope.request])},{blockHash:h(5),requireCanonical:true}]);
 return abi.encodeFunctionResult('restorationIntent',[[scope.request,change==='owner'?h(99):h(7),a(8),scope.lossHash,change==='amount'||change==='disagree'&&leg===1?'11':'10']]);
}});return{rpcs:[rpc(0),rpc(1)],deployment:async()=>({manifestHash:change==='manifest'?h(99):h(6)})}as unknown as OwnerChainNetwork;}
beforeEach(()=>{f.wrongDestination=false;});
test('an existing bounded loss follows current owner destination while retaining its original scope',async()=>{
 await expect(verifyContinuedRestoration(h(7),a(3),scope,fixture())).resolves.toBeUndefined();
});
test('foreign identity, changed amount, stale destination, manifest drift and RPC disagreement cannot create a continuation',async()=>{
 for(const change of ['owner','amount','manifest','disagree'])await expect(verifyContinuedRestoration(h(7),a(3),scope,fixture(change))).rejects.toThrow('recourse_restoration_ticket_');
 f.wrongDestination=true;await expect(verifyContinuedRestoration(h(7),a(3),scope,fixture())).rejects.toThrow('changed');
});

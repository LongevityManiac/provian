import { Interface, getCreateAddress, keccak256 } from 'ethers';
import type { ProtocolDeployment, PointerRpc } from './protocol-pointer';
import { STANDING_MEMBERSHIP_ABI, type StandingMembershipMandate } from './recourse-membership-authorization';
export interface StandingMembershipState {
  readonly controller: string;
  readonly mandate: StandingMembershipMandate;
}
export async function readStandingMembershipState(binding: string, network: {
  readonly rpcs: readonly [PointerRpc,PointerRpc]; deployment(): Promise<ProtocolDeployment>;
}): Promise<StandingMembershipState> {
  if (!/^0x[0-9a-f]{64}$/.test(binding)) throw Error('recourse_standing_binding');
  const deployment=await network.deployment(), pool=deployment.addresses.recoursePool.toLowerCase();
  const abi=new Interface(['function standingMembership() view returns(address)']);
  const pin={blockHash:deployment.blockHash,requireCanonical:true};
  const states=await Promise.all(network.rpcs.map(async rpc=>{
    const code=await rpc.request('eth_getCode',[pool,pin]);
    if(typeof code!=='string'||keccak256(code)!==deployment.runtimeHashes[8])throw Error('recourse_standing_runtime');
    const value=await rpc.request('eth_call',[{to:pool,data:abi.encodeFunctionData('standingMembership')},pin]);
    if(typeof value!=='string')throw Error('recourse_standing_reply');
    const controller=String(abi.decodeFunctionResult('standingMembership',value)[0]).toLowerCase();
    if(controller!==getCreateAddress({from:pool,nonce:1}).toLowerCase())throw Error('recourse_standing_controller');
    const call=async(name:string,args:readonly unknown[]=[])=>{
      const raw=await rpc.request('eth_call',[{to:controller,data:STANDING_MEMBERSHIP_ABI.encodeFunctionData(name,args)},pin]);
      if(typeof raw!=='string')throw Error('recourse_standing_reply');return STANDING_MEMBERSHIP_ABI.decodeFunctionResult(name,raw);
    };
    if(String((await call('pool'))[0]).toLowerCase()!==pool)throw Error('recourse_standing_host');
    const m=await call('standingMandate',[binding]);
    return {controller,mandate:{burnLimit:String(m[0]),reserveLimit:String(m[1]),earningsBpsLimit:Number(m[2]),
      startMonth:String(m[3]),closedMonth:String(m[4]),consentNonce:String(m[5]),exitCommitment:String(m[6]),exitSalt:String(m[7]),active:Boolean(m[8])}};
  }));
  if(JSON.stringify(states[0])!==JSON.stringify(states[1]))throw Error('recourse_standing_disagreement');
  if((await network.deployment()).manifestHash!==deployment.manifestHash)throw Error('recourse_standing_retired');
  return states[0];
}

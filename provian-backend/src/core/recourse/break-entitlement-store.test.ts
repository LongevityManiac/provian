import { AbiCoder, Interface, sha256 } from 'ethers';
import { checkStoredBreakEntitlement, breakEntitlementId } from './break-entitlement-store';
import type { OwnerOperationChain } from './owner-operation-queue';
import type { ProtocolDeployment } from '../protocol/pointer';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const e={identity:h(1),amount:'100',commitment:h(2),proof:[]};
const root=sha256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256','bytes32','uint256','bytes32'],
  ['Provian restoration',a(3),100,e.identity,e.amount,e.commitment]));
const abi=new Interface(['function ownerAuthorization() view returns(address)','function kernel() view returns(address)',
  'function breakOrigin() view returns(address)','function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)','function restorationRoot() view returns(bytes32)']);
function port(mode='valid'):OwnerOperationChain {
  let reads=0;
  return {deployment:async()=>({addresses:{kernel:a(4)},blockHash:h(5),manifestHash:mode==='changed'&&reads++>0?h(99):h(6)} as ProtocolDeployment),
    agree:async(method,params)=>{
      expect(method).toBe('eth_call');expect(params[1]).toEqual({blockHash:h(5),requireCanonical:true});
      if(mode==='disagreement')throw Error('rpc_disagreement');
      const call=abi.parseTransaction(params[0] as {data:string})!;
      const values:Record<string,unknown>={ownerAuthorization:a(7),kernel:a(4),breakOrigin:mode==='origin'?a(99):a(8),
        predecessor:a(3),lastGoodBlock:100,restorationRoot:mode==='root'?h(99):root};
      return abi.encodeFunctionResult(call.name,[values[call.name]]);
    }};
}
test('serves only the exact independently authenticated immutable snapshot witness',async()=>{
  await expect(checkStoredBreakEntitlement(a(8),e.identity,e,port())).resolves.toEqual(e);
  expect(breakEntitlementId(a(8),e.identity)).toBe(`${a(8).slice(2)}-${e.identity.slice(2)}`);
  await expect(checkStoredBreakEntitlement(a(8),h(99),e,port())).rejects.toThrow('identity_changed');
  await expect(checkStoredBreakEntitlement(a(8),e.identity,{...e,amount:'101'},port())).rejects.toThrow('proof_invalid');
});
test.each(['origin','root','changed','disagreement'])('refuses %s state rather than trusting the stored document',async mode=>{
  await expect(checkStoredBreakEntitlement(a(8),e.identity,e,port(mode))).rejects.toThrow();
});

import {Interface,Wallet,getBytes,hashMessage} from 'ethers';
import {assertMembershipDepartureAttestation} from './membership-departure-attestation';
import {assertIdentityAttestation} from './identity-attestor';
import type {OwnerOperationChain} from './owner-operation-queue';
const account='0x'+'11'.repeat(20),blockHash='0x'+'22'.repeat(32),message=getBytes('0x'+'33'.repeat(32));
const abi=new Interface(['function isValidMembershipDepartureSignature(bytes32,bytes) view returns(bytes4)','function isValidSignature(bytes32,bytes) view returns(bytes4)']);
test('dedicated departure proof remains valid when generic current-key authority refuses',async()=>{
 const agree=jest.fn(async(method:string,params:readonly unknown[])=>{
  expect(params.at(-1)).toEqual({blockHash,requireCanonical:true});
  if(method==='eth_getCode')return '0x6000';
  const decoded=abi.parseTransaction({data:(params[0] as {data:string}).data})!;
  expect(decoded.args[0]).toBe(hashMessage(message));
  return abi.encodeFunctionResult(decoded.name,[decoded.name==='isValidMembershipDepartureSignature'?'0x1626ba7e':'0xffffffff']);
 });
 const chain={agree}as unknown as OwnerOperationChain;
 await expect(assertMembershipDepartureAttestation(chain,account,blockHash,message,'0x11')).resolves.toBeUndefined();
 await expect(assertIdentityAttestation(chain,account,blockHash,message,'0x11')).rejects.toThrow('attestation_invalid');
});
test('a dedicated refusal cannot authorize departure and a curve signer still proves its exact bytes',async()=>{
 const chain={agree:async(method:string,params:readonly unknown[])=>{
  if(method==='eth_getCode')return '0x6000';
  const name=abi.parseTransaction({data:(params[0]as{data:string}).data})!.name;
  return abi.encodeFunctionResult(name,['0xffffffff']);
 }}as unknown as OwnerOperationChain;
 await expect(assertMembershipDepartureAttestation(chain,account,blockHash,message,'0x11')).rejects.toThrow('attestation_invalid');
 const wallet=new Wallet('0x'+'44'.repeat(32)),curve={agree:async()=> '0x'}as unknown as OwnerOperationChain;
 await expect(assertMembershipDepartureAttestation(curve,wallet.address,blockHash,message,await wallet.signMessage(message))).resolves.toBeUndefined();
 await expect(assertMembershipDepartureAttestation(curve,account,blockHash,message,await wallet.signMessage(message))).rejects.toThrow();
});

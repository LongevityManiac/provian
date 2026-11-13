import { expect, it, vi } from 'vitest';
import { Interface, hashMessage } from 'ethers';
import { isRecourseBindingConfirmed } from './binding-chain';
import { recourseBindingMessage } from './binding';
import { acceptedBindingDigest } from './ownership';
import type { OwnerChainNetwork } from './owner-chain';
vi.mock('../wallet/SeedManager', () => ({ default: {} }));
vi.mock('../security/ActionWallet', () => ({ ActionWallet: class {} }));
vi.mock('../security/biometricAction', () => ({ assertBiometricAction: vi.fn() }));
const h=(n:string)=>`0x${n.repeat(32)}`,a=(n:string)=>`0x${n.repeat(20)}`;
const binding={identity:h('11'),address:a('22'),recoveryCommitment:h('33'),signingRoot:h('44'),kernel:a('55'),nonce:h('66'),expiresAtMs:100000};
const original=h('77');
const abi=new Interface(['function registryOperator() view returns(address)','function ownerAuthorization() view returns(address)',
 'function ownerOf(address) view returns(bytes32)','function boundBlock(address) view returns(uint256)','function consumedBinding(bytes32) view returns(bool)',
 'function ownerRecoveryCommitment(bytes32) view returns(bytes32)','function ownerSigningRoot(bytes32) view returns(bytes32)']);
function network(root=binding.signingRoot, overrides:Record<string,unknown>={}):OwnerChainNetwork{
 const rpc={request:async(method:string,params:readonly unknown[])=>{
  if(method!=='eth_call')throw Error('unexpected_method');
  const call=abi.parseTransaction(params[0] as {data:string}); if(!call)throw Error('missing_call');
  const values:Record<string,unknown>={registryOperator:a('88'),ownerAuthorization:a('99'),ownerOf:binding.identity,
   boundBlock:1n,consumedBinding:call.name==='consumedBinding'&&call.args[0]===original,
   ownerRecoveryCommitment:binding.recoveryCommitment,ownerSigningRoot:root,...overrides};
  return abi.encodeFunctionResult(call.name,[values[call.name]]);
 }};
 return {rpcs:[rpc,rpc],deployment:async()=>({manifestHash:h('aa'),blockHash:h('bb'),addresses:{kernel:binding.kernel}} as Awaited<ReturnType<OwnerChainNetwork['deployment']>>)};
}
it('confirms a repeated binding using its original consumed occurrence without accepting a new unused nonce',async()=>{
 expect(hashMessage(recourseBindingMessage(binding))).not.toBe(original);
 expect(await isRecourseBindingConfirmed(binding,network(),false)).toBe(false);
 expect(await isRecourseBindingConfirmed(binding,network(),false,original)).toBe(true);
 await expect(isRecourseBindingConfirmed(binding,network(h('cc')),false,original)).rejects.toThrow('chain_mismatch');
 for(const overrides of [{ownerOf:h('dd')},{ownerRecoveryCommitment:h('dd')}])
  await expect(isRecourseBindingConfirmed(binding,network(binding.signingRoot,overrides),false,original)).rejects.toThrow('chain_mismatch');
 expect(await isRecourseBindingConfirmed(binding,network(binding.signingRoot,{boundBlock:0n}),false,original)).toBe(false);
 await expect(isRecourseBindingConfirmed(binding,network(),false,'invalid')).rejects.toThrow('digest_invalid');
});
it('rejects unrelated or inconsistent registration replies',()=>{
 const record={address:binding.address,identity:binding.identity,kernel:binding.kernel,bindingDigest:original,chainBindingStatus:'confirmed'};
 expect(acceptedBindingDigest({binding:record,operationId:original},binding)).toBe(original);
 const current=hashMessage(recourseBindingMessage(binding));
 expect(acceptedBindingDigest({binding:{...record,chainBindingStatus:'pending'},operationId:current},binding)).toBe(current);
 for(const reply of [null,{binding:{...record,chainBindingStatus:['pending']},operationId:current},
  {binding:{...record,chainBindingStatus:'pending'},operationId:original},{binding:record,operationId:current},{binding:record,operationId:h('ee')},{binding:{...record,address:a('dd')},operationId:original},
  {binding:{...record,identity:h('dd')},operationId:original},{binding:{...record,kernel:a('dd')},operationId:original}]){
  expect(()=>acceptedBindingDigest(reply,binding)).toThrow('reply_invalid');
 }
});

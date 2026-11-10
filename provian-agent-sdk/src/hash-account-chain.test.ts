import { expect, it } from 'vitest';
import { Interface, keccak256, sha256 } from 'ethers';
import { HASH_ACCOUNT_ABI, hashAccountCall, type SignedHashAccountOperation } from './hash-account';
import { BREAK_RECOVERY_ABI } from './break-recovery';
import { verifyHashAccountReceipt, verifyHashAccountVariantReceipt } from './hash-account-chain';
import { PROTOCOL_COMPONENTS, type ProtocolComponent, type ProtocolDeployment } from './protocol-pointer';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
function fixture(){
 const operation:SignedHashAccountOperation={chainId:'8453',account:a(1),nonce:'0',target:a(2),value:'0',callGas:'100000',data:'0x1234',nextCommitment:h(1),publicKey:h(2),signingRoot:sha256(h(2)),signature:`0x${'11'.repeat(7856)}`};
 const transactionHash=h(3),blockHash=h(4);
 const state={success:true,changedRoot:false,changedData:false,disagree:false};
 const deployment:ProtocolDeployment={pointer:a(6),revision:2n,manifestHash:h(20),blockHash:h(21),runtimeHashes:[],addresses:Object.fromEntries(PROTOCOL_COMPONENTS.map(k=>[k,a(3)])) as Record<ProtocolComponent,string>};
 const all=new Interface([...BREAK_RECOVERY_ABI.fragments,...HASH_ACCOUNT_ABI.fragments]);
 const rpcs=[0,1].map(index=>({request:async(method:string,params:readonly unknown[]):Promise<unknown>=>{
  if(method==='eth_getTransactionReceipt')return {transactionHash,blockHash,blockNumber:'0x64',status:'0x1',logs:[{
   ...HASH_ACCOUNT_ABI.encodeEventLog(HASH_ACCOUNT_ABI.getEvent('Executed')!,[0,operation.target,state.success]),address:operation.account,transactionHash,blockHash,removed:false}]};
  if(method==='eth_getTransactionByHash')return {hash:transactionHash,blockHash,to:operation.account,input:state.changedData||(state.disagree&&index===1)?'0x':hashAccountCall(operation),value:'0x0'};
  if(method==='eth_getBlockByNumber')return params[0]==='finalized'?{number:'0x65'}:{number:'0x64',hash:blockHash};
  if(method==='eth_getCode')return '0x6000';
  const call=all.parseTransaction({data:(params[0] as {data:string}).data})!;
  const v:Record<string,unknown>={ownerAuthorization:a(4),hashAccountCodeHash:keccak256('0x6000'),keyCommitment:state.changedRoot?h(99):operation.nextCommitment,nonce:1};
  if(!(call.name in v))throw Error('unexpected '+call.name);return all.encodeFunctionResult(call.name,[v[call.name]]);
 }}));
 return {operation,transactionHash,state,network:{deployment:async()=>deployment,rpcs:rpcs as [typeof rpcs[number],typeof rpcs[number]]}};
}
it('reconciles the rotated key after either inner success or failure',async()=>{
 const f=fixture();expect(await verifyHashAccountReceipt(f.operation,f.transactionHash,f.network)).toBe('succeeded');
 f.state.success=false;expect(await verifyHashAccountReceipt(f.operation,f.transactionHash,f.network)).toBe('target_failed');
});
it('rejects another call, a changed root, or transaction disagreement despite matching receipt events',async()=>{
 for(const key of ['changedRoot','changedData','disagree'] as const){const f=fixture();f.state[key]=true;
  await expect(verifyHashAccountReceipt(f.operation,f.transactionHash,f.network)).rejects.toThrow();
 }
});
it('selects the actually executed variant, not the caller’s preferred cancellation',async()=>{
 const f=fixture();
 expect((await verifyHashAccountVariantReceipt([f.operation,{...f.operation}],f.transactionHash,f.network)).operation).toBe(f.operation);
 const cancellation={...f.operation,target:f.operation.account,data:'0x',callGas:'50000'};
 expect((await verifyHashAccountVariantReceipt([cancellation,f.operation],f.transactionHash,f.network)).operation).toBe(f.operation);
 await expect(verifyHashAccountVariantReceipt([cancellation],f.transactionHash,f.network)).rejects.toThrow('transaction_invalid');
 f.state.disagree=true;await expect(verifyHashAccountVariantReceipt([cancellation,f.operation],f.transactionHash,f.network)).rejects.toThrow('transaction_invalid');
});

import { withBuilderCodeFor } from '../../provian-backend/src/core/onchain/builder-code.ts';
import { assertBaseTransactionGasLimit, boundedGasEstimate } from './transaction-gas-limit.mjs';
import {Transaction,keccak256,toQuantity} from 'ethers';
const ensure=(v,c)=>{if(!v)throw Error('changeover_rpc_'+c);};
const lower=v=>typeof v==='string'?v.toLowerCase():v;
function quantity(v){ensure(typeof v==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v),'quantity');return BigInt(v);}
function number(v){const n=Number(quantity(v));ensure(Number.isSafeInteger(n)&&n>=0,'number');return n;}
function object(v){ensure(v&&typeof v==='object'&&!Array.isArray(v),'reply');return v;}
/** Both ports must have distinct, prevalidated provider operators. Raw signed
 * bytes reach either operator only after the transaction engine persists them.
 * The fee reservation callback owns the durable stage budget, including the
 * chain's data fee; this adapter does not claim gasLimit*maxFee is the whole fee. */
export function changeoverRpcPort({rpcs,signer,assertLease,assertBroadcast,assertExposure=assertLease,approveFee,maxFeePerGas,maxPriorityFeePerGas,maxGas}){
 ensure(rpcs.length===2&&rpcs[0]!==rpcs[1]&&typeof approveFee==='function'
  &&typeof assertLease==='function'&&typeof assertBroadcast==='function'&&typeof assertExposure==='function','configuration');
 ensure([maxFeePerGas,maxPriorityFeePerGas,maxGas].every(v=>typeof v==='bigint'&&v>0n)
  &&maxFeePerGas>=maxPriorityFeePerGas,'fee_configuration');
 assertBaseTransactionGasLimit(maxGas);
 const both=(m,p)=>Promise.all(rpcs.map(r=>r.request(m,p)));
 const agree=async(m,p)=>{const v=await both(m,p);ensure(JSON.stringify(v[0])===JSON.stringify(v[1]),'disagreement');return v[0];};
 const chain=async()=>{const id=quantity(await agree('eth_chainId',[]));ensure(id===8453n,'chain');return id;};
 const included=async(raw,finalized=false)=>{
  await chain();const tx=Transaction.from(raw);assertBaseTransactionGasLimit(tx.gasLimit);ensure(tx.signature&&tx.chainId===8453n,'signed_transaction');
  const rs=await both('eth_getTransactionReceipt',[tx.hash]);
  if(rs.some(r=>r===null))return null;
  const facts=rs.map(raw=>{const r=object(raw);return{hash:lower(r.transactionHash),blockHash:lower(r.blockHash),blockNumber:number(r.blockNumber),
   status:number(r.status),contractAddress:lower(r.contractAddress??null)};});
  ensure(JSON.stringify(facts[0])===JSON.stringify(facts[1]),'receipt_disagreement');const receipt=facts[0];
  ensure(receipt.hash===tx.hash&&[0,1].includes(receipt.status)&&/^0x[0-9a-f]{64}$/.test(receipt.blockHash),'receipt');
  const transactions=await both('eth_getTransactionByHash',[tx.hash]);
  for(const rawTx of transactions){const t=object(rawTx);
   ensure(lower(t.hash)===tx.hash&&lower(t.blockHash)===receipt.blockHash&&number(t.blockNumber)===receipt.blockNumber
    &&lower(t.from)===tx.from.toLowerCase()&&lower(t.to??null)===lower(tx.to)&&number(t.nonce)===tx.nonce
    &&quantity(t.chainId)===8453n&&quantity(t.value)===0n&&lower(t.input)===tx.data,'transaction_binding');}
  for(const b of await both('eth_getBlockByNumber',[toQuantity(receipt.blockNumber),false])){
   const h=object(b);ensure(lower(h.hash)===receipt.blockHash&&number(h.number)===receipt.blockNumber,'reorg');}
  if(finalized){const finals=await both('eth_getBlockByNumber',['finalized',false]);
   if(finals.some(b=>number(object(b).number)<receipt.blockNumber))return null;
   // A higher finalized head cannot authenticate an earlier orphaned receipt.
   // Recheck canonical membership after the finality read, not just before it.
   for(const b of await both('eth_getBlockByNumber',[toQuantity(receipt.blockNumber),false])){
    const header=object(b);ensure(lower(header.hash)===receipt.blockHash&&number(header.number)===receipt.blockNumber,'reorg');
   }
  }
  return receipt;
 };
 return{
  included:raw=>included(raw,false),
  chainId:chain,
  signerAddress:async()=>lower(await signer.getAddress()),
  nonces:async(address)=>{
   await chain();const latest=number(await agree('eth_getTransactionCount',[address,'latest']));
   const pending=number(await agree('eth_getTransactionCount',[address,'pending']));return{latest,pending};
  },
  finalized:raw=>included(raw,true),
  prepare:async(step)=>{
   // Every operator transaction carries Provian's Base Builder Code (ERC-8021), estimated and signed.
   step={...step,data:withBuilderCodeFor(step.to,step.data)};
   await assertLease();await chain();ensure(lower(await signer.getAddress())===step.from,'signer');
   const call={from:step.from,...(step.to?{to:step.to}:{}),data:step.data,value:'0x0',nonce:toQuantity(step.nonce)};
   // Compare the simulation at the same canonical head; taking the lesser head
   // avoids treating normal propagation lag as agreement on different states.
   const heads=await both('eth_getBlockByNumber',['latest',false]);
   const height=Math.min(...heads.map(h=>number(object(h).number))),tag=toQuantity(height);
   const header=object(await agree('eth_getBlockByNumber',[tag,false]));
   await assertExposure('simulation');await assertLease();
   await agree('eth_call',[call,tag]);
   await assertExposure('estimate');await assertLease();
   const estimates=(await both('eth_estimateGas',[call,tag])).map(quantity);
   const estimate=estimates.reduce((a,b)=>a>b?a:b),gasLimit=boundedGasEstimate(estimate,maxGas);
   ensure(gasLimit>0n&&gasLimit<=maxGas,'gas_bound');
   const prepared={type:2,chainId:8453,nonce:step.nonce,to:step.to??null,data:step.data,value:0n,gasLimit,maxFeePerGas,maxPriorityFeePerGas};
   const expectedUnsigned=Transaction.from(prepared).unsignedSerialized;
   // A nested authority proof is executable even before its sponsor signs.
   // Recheck before the fee oracle receives transaction bytes as calldata.
   await assertExposure('fee');await assertLease();
   await approveFee({step:{...step},transaction:{...prepared},blockHash:header.hash,blockNumber:height});
   ensure(object(await agree('eth_getBlockByNumber',[tag,false])).hash===header.hash,'reorg');
   await assertLease();const raw=await signer.signTransaction({...prepared});await assertLease();
   const signed=Transaction.from(raw);
   ensure(signed.signature&&signed.from?.toLowerCase()===step.from
    &&signed.unsignedSerialized===expectedUnsigned,'signed_fee_binding');
   return raw;
  },
  broadcast:async(raw)=>{
   await assertLease();await chain();const tx=Transaction.from(raw);assertBaseTransactionGasLimit(tx.gasLimit);
   ensure(tx.from?.toLowerCase()===lower(await signer.getAddress())&&tx.chainId===8453n&&tx.value===0n,'signed_transaction');
   // A lease is ownership, not authority. Revalidate the full source after
   // every awaited preparation read, including on retained-byte replay.
   const hash=keccak256(raw);await assertBroadcast();await assertLease();const result=await rpcs[0].request('eth_sendRawTransaction',[raw]);
   ensure(result===hash,'broadcast_hash');return hash;
  },
 };
}

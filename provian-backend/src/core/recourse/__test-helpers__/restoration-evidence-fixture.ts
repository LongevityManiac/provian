import { Interface } from 'ethers';
import { type RestorationEvidencePort } from '../restoration-evidence';
import type { BaseTransactionEvidence, CanonicalEconomicLog } from '../../onchain/economic-discovery';
import type { LossSnapshot } from '../loss-snapshot';
import type { TransferEvent } from '../ownership';
export const address=(n:number):string=>`0x${n.toString(16).padStart(40,'0')}`;
export const hash=(n:number):string=>`0x${n.toString(16).padStart(64,'0')}`;
export const token=address(9),owner=address(1),recipient=address(2),identity=hash(1);
const erc20=new Interface(['event Transfer(address indexed from,address indexed to,uint256 amount)']);
export function fixture(): {snapshot:LossSnapshot;port:RestorationEvidencePort;event:TransferEvent;transaction:BaseTransactionEvidence;state:{closing:bigint;alias:boolean}} {
  const event:TransferEvent={block:100,blockHash:hash(100),transactionHash:hash(1000),logIndex:0,from:owner,to:recipient,amountAtomic:'100'};
  const encoded=erc20.encodeEventLog(erc20.getEvent('Transfer')!,[owner,recipient,100]);
  const log:CanonicalEconomicLog={...encoded,address:token,blockNumber:100,blockHash:hash(100),transactionHash:hash(1000),transactionIndex:0,logIndex:0,removed:false};
  const transaction:BaseTransactionEvidence={schemaVersion:'base-transaction-evidence/v1',chainId:8453,transactionHash:hash(1000),blockNumber:100,
    blockHash:hash(100),blockTimestampMs:100000,confirmationFloor:12,providerOperatorIds:['a','b'],fromAddress:owner,toAddress:token,valueWei:'0',inputEmpty:false,
    transactionSelector:'0xa9059cbb',logs:[log],evidenceHash:hash(2000)};
  const state={closing:100n,alias:false};
  const snapshot:LossSnapshot={identity,kernel:token,block:100,blockHash:hash(100),transactionHash:hash(1000),firstOutflowLogIndex:0,
    recordedBalanceAtomic:'100',lossAtomic:'100',addresses:[{address:owner,balanceAtomic:'100',bindingDigest:hash(7)}],outflows:[event],occurrence:hash(8),evidenceHash:hash(9)};
  const port:RestorationEvidencePort={currentKernel:async()=>token,transaction:async()=>transaction,verifiedIdentity:async()=>null,privateOwner:async binding=>binding,
    call:async(_target,method,args)=>method==='registryOperator'?address(8):method==='ownerAuthorization'?address(7):method==='restorationRevision'?'3':method==='outgoingSequence'?'1':args[0]===owner||state.alias?identity:hash(0),
    chain:{finalizedBlock:async()=>101,blockHash:async n=>hash(n),
      balance:async(_kernel,account,pin)=>pin===hash(99)?account===owner?100n:0n:account===owner?0n:state.closing,
      transfers:async()=>[event]}};
  return {snapshot,port,event,transaction,state};
}

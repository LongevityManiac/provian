import { Interface, Wallet, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { RECOURSE_EXECUTIONS, recourseExecutionId, type RecourseExecutionCall } from './execution-transaction';
import { DETERMINATION_WORKFLOWS } from './determination-workflow';
import { RESTORATION_REQUESTS } from './restoration-request';
import { RECOURSE_POOL_ABI } from './pool-abi';
import { findPoolWithdrawal } from './pool-withdrawal';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { getAgreedBaseLogs, readAgreedBaseBlockHash } from '../onchain/economic-discovery';
import { finalizedOwnerTransaction } from './transaction-finality';
jest.mock('../protocol/runtime');
jest.mock('../onchain/rpc-provider');
jest.mock('../onchain/economic-discovery');
jest.mock('./transaction-finality');
const hash=(n:string)=>`0x${n.repeat(32)}`,address=(n:string)=>`0x${n.repeat(20)}`;
const history=new Interface(['function poolSnapshot() view returns(address predecessor,uint256 blockNumber,bytes32 root,uint256 entries,bool afterBreak)']);
async function fixture(oldWithdrawal=false){
 const fake=createFakeFirestore(),db=fake as unknown as Firestore,wallet=new Wallet(hash('12'));
 const request=hash('34'),identity=hash('56'),old=address('78'),current=address('90'),blockHash=hash('ab');
 const plan:RecourseExecutionCall={kind:'allocate',executor:old,signer:wallet.address.toLowerCase(),calldata:'0x1234',manifestHash:hash('cd')};
 const raw=await wallet.signTransaction({chainId:8453,type:2,nonce:0,to:old,data:plan.calldata,value:0,gasLimit:100000,maxFeePerGas:2,maxPriorityFeePerGas:1});
 const allocationHash=keccak256(raw),transactionHash=hash('ef'),height=oldWithdrawal?15:25;
 fake.store.set(`${RECOURSE_EXECUTIONS}/${recourseExecutionId(plan)}`,{plan,signedTransaction:raw,transactionHash:allocationHash,status:'confirmed'});
 fake.store.set(`${DETERMINATION_WORKFLOWS}/${request}`,{transactions:{allocate:allocationHash}});
 fake.store.set(`${RESTORATION_REQUESTS}/${request}`,{identity});
 const event=RECOURSE_POOL_ABI.encodeEventLog(RECOURSE_POOL_ABI.getEvent('RestorationWithdrawn')!,[request,address('11'),20]);
 const log={...event,address:oldWithdrawal?old:current,transactionHash,blockNumber:height,blockHash,transactionIndex:0,logIndex:1,removed:false};
 let amount=20n,finalizedHeight=30;
 const send=jest.fn(async(method:string,params:unknown[])=>{
  if(method==='eth_call'){
   const input=params[0] as {to:string;data:string};
   if(input.data.startsWith(history.getFunction('poolSnapshot')!.selector))return history.encodeFunctionResult('poolSnapshot',
    input.to===current?[old,20,hash('22'),0,false]:[address('00'),0,hash('00'),0,false]);
   return RECOURSE_POOL_ABI.encodeFunctionResult('restorationAllocations',[identity,amount,true]);
  }
  if(method==='eth_blockNumber')return `0x${(finalizedHeight+11).toString(16)}`;
  if(method==='eth_getTransactionReceipt')return {transactionHash,blockHash,blockNumber:`0x${height.toString(16)}`,status:'0x1',logs:[{...log,logIndex:'0x1'}]};
  throw Error(method);
 });
 (getOperatorBoundRpcLegs as jest.Mock).mockReturnValue([{operatorId:'one',provider:{send}},{operatorId:'two',provider:{send}}]);
 (currentProtocolDeployment as jest.Mock).mockResolvedValue({addresses:{recoursePool:current},blockHash,manifestHash:hash('cd')});
 (finalizedOwnerTransaction as jest.Mock).mockResolvedValue({transactionHash:allocationHash,block:10,blockHash,status:1});
 (readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(blockHash);
 (getAgreedBaseLogs as jest.Mock).mockImplementation(async input=>input.address===log.address&&input.fromBlock<=height&&input.toBlock>=height?[log]:[]);
 return {db,request,log,setAmount:(n:bigint)=>{amount=n;},setFinalized:(n:number)=>{finalizedHeight=n;}};
}
beforeEach(()=>jest.resetAllMocks());
test('recognizes an independently completed withdrawal in the current successor',async()=>{
 const f=await fixture();expect(await findPoolWithdrawal(f.db,f.request)).toEqual(f.log);
});
test('recognizes an original-pool withdrawal whose replay fence was imported',async()=>{
 const f=await fixture(true);expect(await findPoolWithdrawal(f.db,f.request)).toEqual(f.log);
});
test('does not call an unfinalized external withdrawal completed',async()=>{
 const f=await fixture();f.setFinalized(24);expect(await findPoolWithdrawal(f.db,f.request)).toBeNull();
});
test('rejects an amount mismatch or a noncanonical external event',async()=>{
 const f=await fixture();f.setAmount(21n);
 await expect(findPoolWithdrawal(f.db,f.request)).rejects.toThrow('amount_invalid');
 f.setAmount(20n);(readAgreedBaseBlockHash as jest.Mock).mockResolvedValue(hash('33'));
 await expect(findPoolWithdrawal(f.db,f.request)).rejects.toThrow('log_invalid');
});

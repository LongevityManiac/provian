import { Interface, Wallet, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { readDeterminationOutcome, type OutcomeReceiptPort } from './determination-outcome';
import { DETERMINATION_WORKFLOWS } from './determination-workflow';
import { RESTORATION_REQUESTS } from './restoration-request';
import { RECOURSE_EXECUTIONS, recourseExecutionId, type RecourseExecutionCall } from './execution-transaction';
import { RECOURSE_POOL_ABI } from './pool-abi';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';
const hash=(n:string)=>`0x${n.repeat(32)}`,address=(n:string)=>`0x${n.repeat(20)}`;
const reverseAbi=new Interface(['event TheftReversed(bytes32 indexed request,bytes32 indexed identity,address indexed destination,uint256 amount,bytes32 evidenceHash)']);
async function fixture(){
 const fake=createFakeFirestore(),db=fake as unknown as Firestore,wallet=new Wallet(hash('12'));
 const request=hash('34'),identity=hash('56'),evidence=hash('78'),blockHash=hash('90');
 const transactions:Record<string,string>={},logs:CanonicalEconomicLog[]=[];
 for(const [index,kind] of (['reverse','allocate','deliver'] as const).entries()){
  const plan:RecourseExecutionCall={kind,executor:address('ab'),signer:wallet.address.toLowerCase(),manifestHash:hash('cd'),calldata:`0x${index}0`};
  const raw=await wallet.signTransaction({chainId:8453,type:2,nonce:index,to:plan.executor,data:plan.calldata,value:0,gasLimit:100000,maxFeePerGas:2,maxPriorityFeePerGas:1});
  const transactionHash=keccak256(raw);transactions[kind]=transactionHash;
  fake.store.set(`${RECOURSE_EXECUTIONS}/${recourseExecutionId(plan)}`,{plan,signedTransaction:raw,transactionHash,status:'confirmed'});
  const add=(abi:Interface,name:string,args:readonly unknown[])=>{
   const encoded=abi.encodeEventLog(abi.getEvent(name)!,args);
   logs.push({address:plan.executor,...encoded,transactionHash,blockNumber:100+index,blockHash,transactionIndex:0,logIndex:logs.length,removed:false});
  };
  if(kind==='reverse')add(reverseAbi,'TheftReversed',[request,identity,address('ef'),60,evidence]);
  if(kind==='allocate'){
   add(RECOURSE_POOL_ABI,'RestorationDetermined',[request,identity,request,true,40,evidence,1]);
   add(RECOURSE_POOL_ABI,'RestorationAllocated',[request,identity,40,20]);
  }
  if(kind==='deliver')add(RECOURSE_POOL_ABI,'RestorationWithdrawn',[request,address('11'),20]);
 }
 fake.store.set(`${DETERMINATION_WORKFLOWS}/${request}`,{phase:'delivered',accepted:true,shortfall:'40',evidenceHash:evidence,transactions});
 fake.store.set(`${RESTORATION_REQUESTS}/${request}`,{identity});
 const port:OutcomeReceiptPort={finalized:jest.fn(async raw=>({transactionHash:keccak256(raw),block:100+Object.values(transactions).indexOf(keccak256(raw)),blockHash,status:1 as const})),
  logs:jest.fn(async input=>logs.filter(log=>log.blockNumber===input.fromBlock))};
 return {fake,db,request,transactions,port,logs,blockHash};
}
test('records actual pro-rata amounts and distinct reversal and later recovered reserve destinations',async()=>{
 const f=await fixture();
 expect(await readDeterminationOutcome(f.db,f.request,f.transactions,f.port)).toMatchObject({accepted:true,reversedAtomic:'60',shortfallAtomic:'40',assignedAtomic:'20',reversalDestination:address('ef'),poolDestination:address('11')});
});
test('does not record a merely submitted, reverted, or substituted receipt as an owner outcome',async()=>{
 const f=await fixture();f.port.finalized=async()=>null;
 await expect(readDeterminationOutcome(f.db,f.request,f.transactions,f.port)).rejects.toThrow('not_finalized');
 const g=await fixture();g.logs[0]={...g.logs[0],blockHash:hash('99')};
 await expect(readDeterminationOutcome(g.db,g.request,g.transactions,g.port)).rejects.toThrow('receipt_changed');
});
test('an event for another request cannot supply the requested restoration record',async()=>{
 const f=await fixture(),event=f.logs.findIndex(log=>log.transactionHash===f.transactions.deliver);
 const wrong=RECOURSE_POOL_ABI.encodeEventLog(RECOURSE_POOL_ABI.getEvent('RestorationWithdrawn')!,[hash('99'),address('11'),20]);
 f.logs[event]={...f.logs[event],...wrong};
 await expect(readDeterminationOutcome(f.db,f.request,f.transactions,f.port)).rejects.toThrow('event_missing');
});

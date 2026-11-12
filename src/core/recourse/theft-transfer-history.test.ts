import { describe, it, expect } from 'vitest';
import { Interface, ZeroAddress } from 'ethers';
import { theftTransferChoices, verifyTheftTransfer } from './theft-transfer-history';
import type { Transaction } from '../history/TransactionHistoryService';
import type { OwnerChainNetwork } from './owner-chain';
import type { ProtocolDeployment } from '../protocol/pointer';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const owner=address(1),recipient=address(2),kernel=address(3);
const row: Transaction={id:'test',hash:hash(1),type:'sent',status:'confirmed',chain:'Base',from:owner,to:recipient,
  amount:'12',symbol:'PVT',timestamp:100000,contractAddress:kernel};
const transfer=theftTransferChoices([row],owner,kernel)[0];
const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
function fixture(){
 const receipt={transactionHash:hash(1),blockHash:hash(2),blockNumber:'0xa',status:'0x1',logs:[{
  address:kernel,transactionHash:hash(1),blockHash:hash(2),removed:false,
  ...abi.encodeEventLog(abi.getEvent('Transfer')!,[owner,recipient,12n*10n**18n])}]};
 const state={receipt,canonical:hash(2),finalized:'0xa',secondReceipt:receipt};
 const deployment={manifestHash:hash(3),addresses:{kernel},blockHash:hash(2)} as ProtocolDeployment;
 const rpc=(second:boolean)=>({async request(method:string,params:readonly unknown[]){
  if(method==='eth_getTransactionReceipt')return second?state.secondReceipt:state.receipt;
  if(method==='eth_getBlockByNumber')return params[0]==='finalized'?{number:state.finalized}:{hash:state.canonical,timestamp:'0x64'};
  throw Error(method);
 }});
 const network:OwnerChainNetwork={rpcs:[rpc(false),rpc(true)],deployment:async()=>deployment};
 return {state,network};
}
describe('theft transfer selection',()=>{
 it('selects outgoing current PVT and deduplicates history rows',()=>{
  expect(theftTransferChoices([row,row],owner,kernel)).toEqual([transfer]);
 });
 it('excludes incoming, burned, unconfirmed, unrelated and retired balances',()=>{
  const changes:Partial<Transaction>[]=[{from:recipient},{to:ZeroAddress},{to:owner},{status:'pending'},{status:'failed'},
   {contractAddress:address(9)},{chain:'Arbitrum'},{isRetiredPvt:true},{amount:'0'},{hash:'bad'}];
  for(const change of changes)expect(theftTransferChoices([{...row,...change}],owner,kernel)).toEqual([]);
 });
 it('derives the block and amount from canonical receipts without asking the member',async()=>{
  const f=fixture();const result=await verifyTheftTransfer({...transfer,amount:'999'},owner,f.network);
  expect(result.block).toBe(10);expect(result.amount).toBe('12.0');expect(result.timestamp).toBe(100000);
 });
 it('refuses a changed owner, unsuccessful receipt, reorg or unfinalized loss',async()=>{
  await expect(verifyTheftTransfer(transfer,recipient,fixture().network)).rejects.toThrow();
  for(const change of [(s:ReturnType<typeof fixture>['state'])=>{s.receipt.status='0x0';},
   (s:ReturnType<typeof fixture>['state'])=>{s.canonical=hash(9);},
   (s:ReturnType<typeof fixture>['state'])=>{s.finalized='0x9';},
   (s:ReturnType<typeof fixture>['state'])=>{s.receipt.logs[0].removed=true;},
   (s:ReturnType<typeof fixture>['state'])=>{s.receipt.logs[0].address=address(9);}]){
   const f=fixture();change(f.state);await expect(verifyTheftTransfer(transfer,owner,f.network)).rejects.toThrow();
  }
 });
 it('refuses disagreement between independent receipt sources',async()=>{
  const f=fixture();f.state.secondReceipt={...f.state.receipt,logs:[]};
  await expect(verifyTheftTransfer(transfer,owner,f.network)).rejects.toThrow();
 });
});

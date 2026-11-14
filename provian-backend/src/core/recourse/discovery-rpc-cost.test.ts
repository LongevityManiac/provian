import type { Firestore } from 'firebase-admin/firestore';
import { AbiCoder, Interface, keccak256, toQuantity } from 'ethers';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,h=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
const pointer=a(1), runtime='0x60006000f3', runtimeHash=keccak256(runtime);
const addresses=Array.from({length:10},(_,i)=>a(100+i)), hashes=addresses.map(()=>runtimeHash);
const abi=new Interface(['function current() view returns(uint256,bytes32,address[10],bytes32[10])',
 'function poolSnapshot() view returns(address,uint256,bytes32,uint256,bool)',
 'function availableReserve() view returns(uint256)', 'function allocatedRestorations() view returns(uint256)']);
const manifestHash=keccak256(AbiCoder.defaultAbiCoder().encode(['uint256','address','uint256','address[10]','bytes32[10]'],[8453,pointer,1,addresses,hashes]));
/** Real discovery readers and their real range chunking; only transports and
 * durable storage are doubles. Thirty-day-old pool, one quiet registered wallet,
 * no pending operations/membership obligations, 1,500 newly finalized blocks. */
test('records requests per provider for the idle recourse discovery pass', async()=>{
 let head=100+30*86400*5;
 const calls:Record<string,number>[]=[{},{}];
 const providers=[0,1].map(i=>({operatorId:`provider-${i}`,provider:{send:async(method:string,params:readonly unknown[]):Promise<unknown>=>{
  calls[i][method]=(calls[i][method]??0)+1;
  if(method==='eth_chainId')return '0x2105';
  if(method==='eth_blockNumber')return toQuantity(head);
  if(method==='eth_getBlockByNumber'){
   const n=['finalized','latest','safe'].includes(String(params[0]))?head:Number(BigInt(String(params[0])));
   return {number:toQuantity(n),hash:h(n),timestamp:toQuantity(1794614400)};
  }
  if(method==='eth_getCode')return typeof params[1]==='string'&&BigInt(params[1])<100n?'0x':runtime;
  if(method==='eth_getLogs')return [];
  if(method==='eth_call'){
   const call=params[0] as {to:string;data:string};
   if(call.data===abi.encodeFunctionData('current'))return abi.encodeFunctionResult('current',[1,manifestHash,addresses,hashes]);
   if(call.data===abi.encodeFunctionData('poolSnapshot'))return abi.encodeFunctionResult('poolSnapshot',[a(0),0,h(0),0,false]);
   for(const getter of ['availableReserve','allocatedRestorations'])if(call.data===abi.encodeFunctionData(getter))return abi.encodeFunctionResult(getter,[0]);
   for(const getter of ['KERNEL','pvt','epochClock','token','kernel','settlement','pool','protocolPointer','pointer','registryOperator','ownerAuthorization']){
    const binding=new Interface([`function ${getter}() view returns(address)`]);
    if(call.data===binding.encodeFunctionData(getter))return binding.encodeFunctionResult(getter,[getter==='settlement'?addresses[9]:getter==='pool'?addresses[8]:['protocolPointer','pointer'].includes(getter)?pointer:getter==='registryOperator'?a(200):getter==='ownerAuthorization'?a(201):addresses[0]]);
   }
   return '0x';
  }
  throw Error(`unexpected_rpc:${method}`);
 }}}));
 const fake=createFakeFirestore({strictTransactionOrder:true}),db=fake as unknown as Firestore;
 jest.doMock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:()=>providers}));
 jest.doMock('../protocol/pointer-pin.generated',()=>({PROTOCOL_POINTER_PIN:{address:pointer,runtimeHash}}));
 jest.doMock('../../firestore-db',()=>({relayDb:()=>db}));
 fake.store.set(`recourse_addresses_v1/${a(300)}`,{address:a(300),kernel:addresses[0],chainBindingStatus:'confirmed',boundBlock:100});
 fake.store.set(`recourse_ledger_cursors/${addresses[0]}`,{block:head,blockHash:h(head)});
 fake.store.set(`recourse_shared_ledger_cursors_v1/${addresses[0]}`,{fromBlock:100,block:head,blockHash:h(head)});
 for(const [address,kind]of[[addresses[8],'pool'],[a(200),'registry'],[a(201),'restoration']])
  fake.store.set(`recourse_lifecycle_cursors_v1/${kind}:${address}`,{block:head,blockHash:h(head)});
 const {runOwnershipLedgerWatcher}=await import('./ledger-watcher');
 const {runRecourseLifecycleWatcher}=await import('./lifecycle-records');
 const {refreshRecoursePoolRatio}=await import('./pool-ratio');
 const {runAutomaticMembershipSweep}=await import('./automatic-membership');
 const run=async()=>{await runAutomaticMembershipSweep(db);await runOwnershipLedgerWatcher(db);await runRecourseLifecycleWatcher(db);await refreshRecoursePoolRatio(db);};
 await run(); // Established cursors and full revision proof are not cold-start costs.
 head+=1500; calls[0]={};calls[1]={};
 const clock=jest.spyOn(Date,'now').mockReturnValue(Date.now()+300_000);
 try {await run();}finally{clock.mockRestore();}
 const perProvider=calls.map(row=>Object.values(row).reduce((sum,n)=>sum+n,0));
 console.info('RECOURSE_IDLE_DISCOVERY_RPC_COUNTS',JSON.stringify({perProvider,methods:calls}));
 expect(perProvider[0]).toBe(perProvider[1]);
 expect(perProvider[0]).toBeLessThanOrEqual(100);
 expect(calls.map(row=>row.eth_getLogs)).toEqual([15,15]);
 expect(fake.store.get(`recourse_shared_ledger_cursors_v1/${addresses[0]}`)?.block).toBe(head);
 for(const [address,kind]of[[addresses[8],'pool'],[a(200),'registry'],[a(201),'restoration']])
   expect(fake.store.get(`recourse_lifecycle_cursors_v1/${kind}:${address}`)?.block).toBe(head);
});

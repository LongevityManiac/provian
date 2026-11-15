import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { AbiCoder, Interface, keccak256 } from 'ethers';
import { resolveProtocolDeployment, confirmProtocolDeployment, type PointerRpc } from './pointer';
const pointer = `0x${'01'.repeat(20)}`;
const runtime = '0x60006000f3';
const runtimeHash = keccak256(runtime);
const blockHash = `0x${'ab'.repeat(32)}`;
const addresses = Array.from({ length: 10 }, (_, i) => `0x${(i + 100).toString(16).padStart(40, '0')}`);
const hashes = addresses.map(() => runtimeHash);
const abi = new Interface(['function current() view returns (uint256,bytes32,address[10],bytes32[10])']);
function manifest(revision: bigint, corrupt = false): string {
  const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'uint256', 'address[10]', 'bytes32[10]'],
    [8453, pointer, revision, addresses, hashes]));
  return abi.encodeFunctionResult('current', [revision, corrupt ? blockHash : digest, addresses, hashes]);
}
function rpc(options: { chain?: string; code?: string; corrupt?: boolean; newer?: boolean; reorg?: boolean; wrongBinding?: boolean; revision?: bigint; count?: () => void } = {}): PointerRpc {
  let blocks = 0;
  return { async request(method, params) {
    options.count?.();
    if (method === 'eth_chainId') return options.chain ?? '0x2105';
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: options.reorg && blocks++ > 0 ? `0x${'cd'.repeat(32)}` : blockHash };
    if (method === 'eth_getCode') return params[0] === pointer ? runtime : (options.code ?? runtime);
    if (method === 'eth_call') {
      const call = params[0] as { data: string };
      if (call.data === abi.encodeFunctionData('current')) return manifest(params[1] === 'latest' && options.newer ? 2n : (options.revision ?? 1n), options.corrupt);
      const getters = ['KERNEL', 'pvt', 'epochClock', 'token', 'kernel', 'settlement', 'pool', 'protocolPointer', 'pointer'];
      for (const getter of getters) {
        const binding = new Interface([`function ${getter}() view returns(address)`]);
        if (call.data === binding.encodeFunctionData(getter)) {
          const target = options.wrongBinding ? addresses[4] : getter === 'settlement' ? addresses[9]
            : getter === 'pool' ? addresses[8] : getter === 'protocolPointer' || getter === 'pointer' ? pointer : addresses[0];
          return binding.encodeFunctionResult(getter, [target]);
        }
      }
      return '0x';
    }
    throw new Error('unexpected_rpc');
  } };
}

test('counts full verification and cheap two-provider revision confirmation', async () => {
 const counts=[0,0]; const legs=[rpc({count:()=>++counts[0]}),rpc({count:()=>++counts[1]})] as const;
 const verified=await resolveProtocolDeployment(legs,pointer,runtimeHash);
 expect(counts).toEqual([45,45]); counts.fill(0);
 expect((await confirmProtocolDeployment(legs,verified,runtimeHash))?.manifestHash).toBe(verified.manifestHash);
 expect(counts).toEqual([8,8]);
 console.info('RECOURSE_POINTER_RPC_COUNTS',JSON.stringify({full:[45,45],unchanged:counts}));
 await expect(confirmProtocolDeployment([rpc(),rpc({revision:2n})],verified,runtimeHash)).rejects.toThrow('disagreement');
 expect(await confirmProtocolDeployment([rpc({revision:2n}),rpc({revision:2n})],verified,runtimeHash)).toBeNull();
 await expect(confirmProtocolDeployment([rpc({newer:true}),rpc({newer:true})],verified,runtimeHash)).rejects.toThrow('changed');
 await expect(confirmProtocolDeployment([rpc({reorg:true}),rpc({reorg:true})],verified,runtimeHash)).rejects.toThrow('reorg');
});

test('requests share verification, restart reuses durable proof, signing always confirms both providers', async () => {
 const fake=createFakeFirestore({strictTransactionOrder:true});
 const counts=[0,0], revisions=[1n,1n];
 const providers=[0,1].map(i=>({operatorId:`provider-${i}`,provider:{send:async (method:string,params:readonly unknown[])=>
   rpc({revision:revisions[i],count:()=>++counts[i]}).request(method,params)}}));
 const load=async()=>{
   jest.resetModules();
   jest.doMock('../../firestore-db',()=>({relayDb:()=>fake as unknown as Firestore}));
   jest.doMock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:()=>providers}));
   jest.doMock('./pointer-pin.generated',()=>({PROTOCOL_POINTER_PIN:{address:pointer,runtimeHash}}));
   return (await import('./runtime')).currentProtocolDeployment;
 };
 let current=await load();
 await Promise.all(Array.from({length:8},()=>current()));
 expect(counts).toEqual([45,45]);
 counts.fill(0);
 await Promise.all(Array.from({length:100},()=>current()));
 expect(counts).toEqual([0,0]);
 current=await load(); await current(); expect(counts).toEqual([0,0]);
 await current({fresh:true}); expect(counts).toEqual([8,8]);
 counts.fill(0); revisions.fill(2n);
 expect((await current({fresh:true})).revision).toBe(2n);
 expect(counts).toEqual([50,50]);
 counts.fill(0); await current({fresh:true}); expect(counts).toEqual([8,8]);
 revisions[1]=3n;
 await expect(current({fresh:true})).rejects.toThrow('disagreement');
 counts.fill(0);
 for(let i=0;i<100;i++) await expect(current()).rejects.toThrow('protocol_verification_unavailable');
 expect(counts).toEqual([0,0]);
 current=await load();
 await expect(current()).rejects.toThrow('protocol_verification_unavailable');
 expect(counts).toEqual([0,0]);
});

test('metadata reads answer at once while one confirmation runs behind them; signing still waits', async () => {
 const fake=createFakeFirestore({strictTransactionOrder:true});
 const counts=[0,0], revisions=[1n,1n], fail=[false];
 const providers=[0,1].map(i=>({operatorId:`provider-${i}`,provider:{send:async (method:string,params:readonly unknown[])=>{
   if(fail[0]) throw new Error('provider_down');
   return rpc({revision:revisions[i],count:()=>++counts[i]}).request(method,params);}}}));
 let now=1_800_000_000_000;
 const clock=jest.spyOn(Date,'now').mockImplementation(()=>now);
 const load=async()=>{
   jest.resetModules();
   jest.doMock('../../firestore-db',()=>({relayDb:()=>fake as unknown as Firestore}));
   jest.doMock('../onchain/rpc-provider',()=>({getOperatorBoundRpcLegs:()=>providers}));
   jest.doMock('./pointer-pin.generated',()=>({PROTOCOL_POINTER_PIN:{address:pointer,runtimeHash}}));
   return (await import('./runtime')).currentProtocolDeployment;
 };
 const settle=async()=>{ for(let i=0;i<50;i++) await new Promise(r=>setImmediate(r)); };
 try {
  let current=await load();
  await current(); expect(counts).toEqual([45,45]); counts.fill(0);
  // Past the confirmation interval: the read answers before any provider call.
  now+=90_000;
  const answered=await current(); expect(answered.revision).toBe(1n); expect(counts).toEqual([0,0]);
  await settle(); expect(counts).toEqual([8,8]);
  // Concurrent reads share that single confirmation.
  counts.fill(0); now+=90_000;
  await Promise.all(Array.from({length:20},()=>current())); await settle(); expect(counts).toEqual([8,8]);
  // A new instance starts from a durable record minutes old, then confirms behind.
  counts.fill(0); now+=5*60_000;
  current=await load(); await current(); expect(counts).toEqual([0,0]);
  await settle(); expect(counts).toEqual([8,8]);
  // Signing boundaries never take the shortcut.
  counts.fill(0); now+=90_000; await current({fresh:true}); expect(counts).toEqual([8,8]);
  // Another instance holding the shared lease is not a failure: reads keep answering from the
  // confirmed revision and the next read simply tries again.
  counts.fill(0); now+=90_000;
  await fake.collection('protocol_verified_deployments_v1').doc(`${pointer.toLowerCase()}:${runtimeHash}`).set({leaseOwner:'other',leaseUntil:now+60_000},{merge:true});
  await current(); await settle();
  expect((await current()).revision).toBe(1n); expect(counts).toEqual([0,0]);
  await fake.collection('protocol_verified_deployments_v1').doc(`${pointer.toLowerCase()}:${runtimeHash}`).set({leaseOwner:null,leaseUntil:0},{merge:true});
  await current(); await settle(); expect(counts).toEqual([8,8]);
  // RED: a confirmation that fails behind a read clears the cache; later reads refuse.
  counts.fill(0); now+=90_000; fail[0]=true;
  await current(); await settle();
  await expect(current()).rejects.toThrow('protocol_verification_unavailable');
  // RED: beyond the serving window a read waits for confirmation and fails with it.
  fail[0]=false; current=await load(); counts.fill(0); now+=11*60_000; fail[0]=true;
  await expect(current()).rejects.toThrow('provider_down');
  expect(counts).toEqual([0,0]);
 } finally { clock.mockRestore(); }
});

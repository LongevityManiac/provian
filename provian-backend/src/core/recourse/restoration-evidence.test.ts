import { collectRestorationEvidence, assertRestorationEvidence, classifyRestorationReceipt } from './restoration-evidence';
import { fixture, token, owner, recipient, identity, address, hash } from './__test-helpers__/restoration-evidence-fixture';
import { traceRestoration, type TracedTransfer } from './restoration-trace';
import { packetFixture } from './__test-helpers__/determination-fixture';
import { prepareDetermination, assessRestoration } from './determination';
test('direct transfer shape alone cannot authorize destruction; canonical whole-account collection preserves the unreachable remainder',async()=>{
  const f=fixture();expect(classifyRestorationReceipt(token,f.event,f.transaction)).toBe('unresolved');
  const evidence=await collectRestorationEvidence(f.snapshot,f.port);
  expect(evidence.checkpoint.accounts).toHaveLength(2);expect(evidence.trace).toMatchObject({sources:[],shortfallAtomic:'100',reversibleAtomic:'0'});
  expect(()=>assertRestorationEvidence(evidence)).not.toThrow();expect(()=>assertRestorationEvidence({...evidence})).toThrow('unverified');
});
test('independently discovered same-owner destination cannot create a restoration loss',async()=>{
  const f=fixture();f.state.alias=true;
  expect((await collectRestorationEvidence(f.snapshot,f.port)).trace).toMatchObject({sources:[],shortfallAtomic:'0',returnedAtomic:'100'});
});
test('different public address bindings still offset returns to the same private owner', async () => {
  const f = fixture(), secondary = hash(91), privateOwner = hash(92);
  const port = { ...f.port,
    privateOwner: async (binding: string) => [identity, secondary].includes(binding) ? privateOwner : null,
    call: async (...args: Parameters<typeof f.port.call>) => args[1] === 'ownerOf' && args[2][0] === recipient
      ? secondary : f.port.call(...args),
    verifiedIdentity: async (account: string) => account === recipient ? { identity: privateOwner, evidenceHash: hash(93) } : null,
  };
  const result = await collectRestorationEvidence(f.snapshot, port);
  expect(result.trace).toMatchObject({ shortfallAtomic: '0', returnedAtomic: '100' });
  await expect(collectRestorationEvidence(f.snapshot, { ...port,
    privateOwner: async (binding: string) => binding === secondary ? hash(94) : privateOwner,
  })).rejects.toThrow('owner_conflict');
  await expect(collectRestorationEvidence(f.snapshot, { ...port, privateOwner: async () => null })).rejects.toThrow('owner_unusable');
  await expect(collectRestorationEvidence(f.snapshot, { ...port, verifiedIdentity: async () => null,
    privateOwner: async (binding: string) => binding === secondary ? null : privateOwner,
  })).rejects.toThrow('owner_unusable');
});
test('missing balances, altered receipt occurrence and changed current kernel fail before any determination',async()=>{
  const f=fixture();f.state.closing=99n;await expect(collectRestorationEvidence(f.snapshot,f.port)).rejects.toThrow('history_incomplete');
  expect(()=>classifyRestorationReceipt(token,f.event,{...f.transaction,blockHash:hash(7)})).toThrow('transaction_mismatch');
  expect(()=>classifyRestorationReceipt(token,f.event,{...f.transaction,logs:[]})).toThrow('transfer_missing');
  await expect(collectRestorationEvidence(f.snapshot,{...f.port,currentKernel:async()=>address(44)})).rejects.toThrow('kernel_retired');
});

test('native, proven or retired exact owner evidence also prevents self-wash without treating shared beneficiaries as owners',async()=>{
 const f=fixture();
 expect((await collectRestorationEvidence(f.snapshot,{...f.port,verifiedIdentity:async account=>account===recipient?{identity,evidenceHash:hash(66)}:null})).trace.shortfallAtomic).toBe('0');
 expect((await collectRestorationEvidence(f.snapshot,{...f.port,verifiedIdentity:async account=>account===recipient?{identity:hash(88),evidenceHash:hash(66)}:null})).trace.shortfallAtomic).toBe('100');
 await expect(collectRestorationEvidence(f.snapshot,{...f.port,verifiedIdentity:async()=>{throw Error('registry unavailable');}})).rejects.toThrow('registry unavailable');
});

test('a prepared predecessor loss traces through an authenticated ordinary import without counting carried tokens as new funds',async()=>{
  const f=fixture(),successor=address(77),executor=address(78),mintHash=hash(1111);
  const mint={...f.event,block:111,blockHash:hash(111),transactionHash:mintHash,logIndex:4,from:address(0),to:recipient};
  const base=f.port.chain;
  const port={...f.port,currentKernel:async()=>successor,
    lineage:async()=>({kernel:successor,executor,manifestHash:hash(888),migrations:[{kernel:successor,executor,predecessor:token,cutoff:105}]}),
    migrationMint:async(_migration:unknown,account:string)=>account===recipient?{mintId:`${mintHash}:4`,succession:null}:null,
    chain:{...base,finalizedBlock:async()=>120,
      transfers:async(kernel:string,account:string)=>kernel===token?[f.event]:account===recipient?[mint]:[]}};
  const result=await collectRestorationEvidence(f.snapshot,port);
  expect(result.executionKernel).toBe(successor);
  expect(result.trace).toMatchObject({shortfallAtomic:'100',reversibleAtomic:'0'});
  expect(result.checkpoint.transfers).toHaveLength(1);
  expect(f.snapshot.kernel).toBe(token);
  await expect(collectRestorationEvidence(f.snapshot,{...port,migrationMint:async()=>null})).rejects.toThrow();
});

test('institutional succession preserves both unresolved and reversible provenance at the new custody address',async()=>{
  const f=fixture(),successor=address(77),executor=address(78),destination=address(79),mintHash=hash(1111);
  const mint={...f.event,block:111,blockHash:hash(111),transactionHash:mintHash,logIndex:4,from:address(0),to:destination};
  const bridge:TracedTransfer={...mint,from:recipient,logIndex:5,receipt:'custody_succession',witnessHash:hash(999)};
  const base=f.port.chain;
  const port={...f.port,currentKernel:async()=>successor,
    lineage:async()=>({kernel:successor,executor,manifestHash:hash(888),migrations:[{kernel:successor,executor,predecessor:token,cutoff:105}]}),
    migrationMint:async(_migration:unknown,account:string)=>account===recipient?{mintId:`${mintHash}:4`,succession:bridge}:null,
    chain:{...base,finalizedBlock:async()=>120,
      balance:async(kernel:string,account:string,pin:string)=>kernel===successor?(account===destination?100n:0n):base.balance(kernel,account,pin),
      transfers:async(kernel:string,account:string)=>kernel===token?(account===owner||account===recipient?[f.event]:[]):account===destination?[mint]:[]}};
  const result=await collectRestorationEvidence(f.snapshot,port);
  expect(result.checkpoint.accounts).toHaveLength(3);
  expect(result.checkpoint.transfers).toHaveLength(2);
  expect(result.trace).toMatchObject({shortfallAtomic:'100',reversibleAtomic:'0',sources:[]});
  const gratuitous=traceRestoration(f.snapshot,{...result.checkpoint,transfers:result.checkpoint.transfers.map(event=>
    event.transactionHash===f.event.transactionHash?{...event,receipt:'gratuitous'}:event)});
  expect(gratuitous).toMatchObject({shortfallAtomic:'0',reversibleAtomic:'100',sources:[{address:destination,amountAtomic:'100',outgoingSequence:'1'}]});
  const request=await packetFixture();
  const packet=await prepareDetermination(request.db,request.ticket.request,{...request.ports,evidence:async()=>result});
  expect(()=>assessRestoration(packet,{...request.judgment,packetHash:packet.packetHash,receipts:[{
    transactionHash:bridge.transactionHash,logIndex:bridge.logIndex,conclusion:'witnessed_exchange',
    evidenceHashes:[bridge.witnessHash],reasoning:'Attempt to turn a verified custody succession into consideration.'
  }]})).toThrow('receipt_invalid');
  await expect(collectRestorationEvidence(f.snapshot,{...port,migrationMint:async(_migration,account)=>account===recipient?
    {mintId:`${mintHash}:4`,succession:{...bridge,amountAtomic:'101'}}:null})).rejects.toThrow('history_incomplete');
});

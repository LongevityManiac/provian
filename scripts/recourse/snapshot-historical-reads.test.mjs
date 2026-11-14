import {test,expect,vi} from 'vitest';
import {historicalSnapshotScope,historicalReadBatcher,checkedHistoricalBatch} from './snapshot-historical-reads.mjs';
const hash='0x'+'11'.repeat(32),otherHash='0x'+'22'.repeat(32),address='0x'+'33'.repeat(20);
const checkpoint={block:10,blockHash:hash};
function setup(){
 const port={finalizedBlock:vi.fn(async()=>({number:20,hash:otherHash})),blockHash:vi.fn(async()=>hash),
  call:vi.fn(async()=> '0xab'),code:vi.fn(async()=> '0xcd'),
  transaction:vi.fn(async id=>({hash:id,blockHash:hash,blockNumber:'0x5',input:'0xab',to:address})),
  rpcs:[{request:vi.fn()},{request:vi.fn()}]};
 const batch=vi.fn(async(_operator,rows)=>rows.map(row=>row.method==='eth_call'?'0x12':'0x34'));
 return {port,batch,scope:historicalSnapshotScope(port,['first','second'],batch)};
}
test('eight historical reads coalesce per provider; later scopes freshly authenticate but reuse exact results',async()=>{
 const s=setup();
 const run=port=>Promise.all(Array.from({length:8},(_,i)=>port.call(address,'0x'+i.toString(16).padStart(2,'0'),hash)));
 expect(await s.scope(checkpoint,run)).toEqual(Array(8).fill('0x12'));
 expect(s.batch).toHaveBeenCalledTimes(2);expect(s.batch.mock.calls.every(([,rows])=>rows.length===8)).toBe(true);
 expect(await s.scope(checkpoint,run)).toEqual(Array(8).fill('0x12'));
 expect(s.batch).toHaveBeenCalledTimes(2);expect(s.port.finalizedBlock).toHaveBeenCalledTimes(2);expect(s.port.blockHash).toHaveBeenCalledTimes(4);
 expect(s.port.call).not.toHaveBeenCalled();
});
test('sequential partial groups flush; method, calldata and target cannot collide',async()=>{
 const s=setup();await s.scope(checkpoint,async p=>{
  expect(await p.call(address,'0xaa',hash)).toBe('0x12');
  expect(await p.code(address,hash)).toBe('0x34');
  await p.call(address,'0xbb',hash);await p.call('0x'+'44'.repeat(20),'0xaa',hash);
 });expect(s.batch).toHaveBeenCalledTimes(8);
});
test('batch width stays bounded and providers retain their own queues',async()=>{
 const batch=vi.fn(async(_op,rows)=>rows.map(()=> '0x12')),read=historicalReadBatcher(batch);
 await Promise.all(Array.from({length:21},(_,i)=>read(i%2?'first':'second','eth_call',[i])));
 expect(batch.mock.calls.every(([,rows])=>rows.length<=8)).toBe(true);
 expect(batch.mock.calls.map(([op])=>op).sort()).toEqual(['first','first','second','second']);
});
test('fully cached replay refuses changed or unfinalized cutoff before returning any result',async()=>{
 const s=setup();const read=p=>p.call(address,'0xaa',hash);await s.scope(checkpoint,read);
 s.port.blockHash.mockResolvedValue(otherHash);
 await expect(s.scope(checkpoint,read)).rejects.toThrow('checkpoint_changed');expect(s.batch).toHaveBeenCalledTimes(2);
 s.port.blockHash.mockResolvedValue(hash);s.port.finalizedBlock.mockResolvedValue({number:9,hash});
 await expect(s.scope(checkpoint,read)).rejects.toThrow('checkpoint_changed');
});
test('exit reorg refuses; closed scopes cannot read or fall through to ordinary ports',async()=>{
 const s=setup();let saved;
 s.port.blockHash.mockResolvedValueOnce(hash).mockResolvedValueOnce(otherHash);
 await expect(s.scope(checkpoint,async p=>{saved=p;return p.call(address,'0xaa',hash);})).rejects.toThrow('checkpoint_changed');
 expect(()=>saved.call(address,'0xaa',hash)).toThrow('scope_closed');
 expect(()=>saved.code(address,otherHash)).toThrow('scope_closed');
});
test('different pins and ordinary RPC surfaces stay uncached and outside batching',async()=>{
 const s=setup();await s.scope(checkpoint,async p=>{
  expect(p.rpcs).toBe(s.port.rpcs);expect(p.withHistoricalSnapshot).toBeUndefined();
  await p.call(address,'0xaa',otherHash);await p.call(address,'0xaa',otherHash);
  await p.code(address,otherHash);await p.code(address,otherHash);
 });expect(s.batch).not.toHaveBeenCalled();expect(s.port.call).toHaveBeenCalledTimes(2);expect(s.port.code).toHaveBeenCalledTimes(2);
});
test('disagreement and errors never populate either provider cache',async()=>{
 const s=setup();s.batch.mockImplementation(async op=>[op==='first'?'0x12':'0x34']);
 await expect(s.scope(checkpoint,p=>p.call(address,'0xaa',hash))).rejects.toThrow('provider_disagreement');
 await new Promise(resolve=>setTimeout(resolve,0));
 s.batch.mockRejectedValue(new Error('provider_unavailable'));
 await expect(s.scope(checkpoint,p=>p.call(address,'0xaa',hash))).rejects.toThrow('provider_unavailable');
 await new Promise(resolve=>setTimeout(resolve,0));
 s.batch.mockImplementation(async(_op,rows)=>rows.map(()=> '0x12'));await s.scope(checkpoint,p=>p.call(address,'0xaa',hash));
 expect(s.batch).toHaveBeenCalledTimes(6);
});
test('scopes close on callback error and reject work completing after closure',async()=>{
 const s=setup();let saved;
 await expect(s.scope(checkpoint,async p=>{saved=p;throw Error('stop');})).rejects.toThrow('stop');
 expect(()=>saved.call(address,'0xaa',hash)).toThrow('scope_closed');
 let pending;
 await s.scope(checkpoint,async p=>{pending=p.call(address,'0xbb',hash);pending.catch(()=>{});});
 await expect(pending).rejects.toThrow('scope_closed');
 const before=s.batch.mock.calls.length;
 await s.scope(checkpoint,p=>p.call(address,'0xbb',hash));expect(s.batch.mock.calls.length-before).toBe(2);
});
test('batch responses bind IDs instead of order and reject ambiguous or malformed responses',()=>{
 const rows=[{id:1},{id:2}],valid=[{jsonrpc:'2.0',id:2,result:'0x22'},{jsonrpc:'2.0',id:1,result:'0x11'}];
 expect(checkedHistoricalBatch(rows,valid).map(r=>r.result)).toEqual(['0x11','0x22']);
 for(const bad of [null,{},[],valid.slice(1),[valid[0],valid[0]],[{...valid[0],id:3},valid[1]],
  [{...valid[0],id:'2'},valid[1]],[{...valid[0],jsonrpc:'1.0'},valid[1]],
  [{...valid[0],result:null},valid[1]],[{...valid[0],result:'0x1'},valid[1]],
  [{...valid[0],error:{code:429}},valid[1]],[{id:2,jsonrpc:'2.0'},valid[1]]])
   expect(()=>checkedHistoricalBatch(rows,bad)).toThrow('snapshot_historical_');
 expect(checkedHistoricalBatch(rows,[{id:2,jsonrpc:'2.0',error:{code:429}},valid[1]])[1].error.code).toBe(429);
});
test('finalized transactions reuse both-provider evidence only inside an authenticated cutoff and return copies',async()=>{
 const s=setup(),read=p=>p.transaction(otherHash);
 const first=await s.scope(checkpoint,read);first.input='0xff';
 expect((await s.scope(checkpoint,read)).input).toBe('0xab');
 expect(s.port.transaction).toHaveBeenCalledTimes(1);
 expect(s.port.blockHash.mock.calls.map(([n])=>n)).toEqual([10,5,10,10,10]);
 await s.port.transaction(otherHash);expect(s.port.transaction).toHaveBeenCalledTimes(2);
 s.port.blockHash.mockResolvedValue(otherHash);
 await expect(s.scope(checkpoint,read)).rejects.toThrow('checkpoint_changed');
 expect(s.port.transaction).toHaveBeenCalledTimes(2);
});
test('null, pending and beyond-cutoff transactions remain fresh; another cutoff cannot reuse them',async()=>{
 for(const value of [null,{hash:otherHash,blockHash:null,blockNumber:null},
  {hash:otherHash,blockHash:hash,blockNumber:'0xb'}]){
  const s=setup();s.port.transaction.mockResolvedValue(value);
  await s.scope(checkpoint,async p=>{expect(await p.transaction(otherHash)).toEqual(value);await p.transaction(otherHash);});
  expect(s.port.transaction).toHaveBeenCalledTimes(2);
 }
 const s=setup();await s.scope(checkpoint,p=>p.transaction(otherHash));
 s.port.blockHash.mockImplementation(async n=>n===11?otherHash:hash);
 await s.scope({block:11,blockHash:otherHash},p=>p.transaction(otherHash));
 expect(s.port.transaction).toHaveBeenCalledTimes(2);
});
test('malformed, mismatched, noncanonical or failed transaction evidence never enters the cache',async()=>{
 for(const change of [{hash:hash},{blockHash:'0x12'},{blockNumber:'not a number'},
  {blockNumber:'0x20000000000000'},{blockHash:otherHash}]){
  const s=setup(),good=await s.port.transaction(otherHash);s.port.transaction.mockClear();
  s.port.transaction.mockResolvedValueOnce({...good,...change});
  await expect(s.scope(checkpoint,p=>p.transaction(otherHash))).rejects.toThrow('snapshot_historical_');
  await s.scope(checkpoint,p=>p.transaction(otherHash));expect(s.port.transaction).toHaveBeenCalledTimes(2);
 }
 const s=setup();s.port.transaction.mockRejectedValueOnce(Error('snapshot_rpc_disagreement'));
 await expect(s.scope(checkpoint,p=>p.transaction(otherHash))).rejects.toThrow('snapshot_rpc_disagreement');
 await s.scope(checkpoint,p=>p.transaction(otherHash));expect(s.port.transaction).toHaveBeenCalledTimes(2);
});
test('transaction reads cannot outlive their scope or populate a cache after closure',async()=>{
 const s=setup();let saved,resolve,pending;
 const value=await s.port.transaction(otherHash);s.port.transaction.mockClear();
 s.port.transaction.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 await s.scope(checkpoint,async p=>{saved=p;pending=p.transaction(otherHash);pending.catch(()=>{});});
 resolve(value);await expect(pending).rejects.toThrow('scope_closed');
 await expect(saved.transaction(otherHash)).rejects.toThrow('scope_closed');
 await s.scope(checkpoint,p=>p.transaction(otherHash));expect(s.port.transaction).toHaveBeenCalledTimes(2);
});

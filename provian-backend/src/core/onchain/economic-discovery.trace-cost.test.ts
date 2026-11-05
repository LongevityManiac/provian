import {readBaseInternalEthPointers} from './economic-discovery';
import type {EconomicStateRpcLeg} from './economic-state';
const wallet='0xa11ce00000000000000000000000000000000001',sender='0x5000000000000000000000000000000000000005';
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const frame=(n:number,block=500,value='0x1')=>({type:'call',action:{from:sender,to:wallet,value,callType:'call'},traceAddress:[n],transactionHash:hash(n+1),blockNumber:block,result:{}});
type Filter={fromBlock:string;toBlock:string;toAddress:string[];after:number;count:number};
const args={fromBlock:500,toBlock:599,toAddresses:[wallet]};
function reader(read:(filter:Filter)=>unknown|Promise<unknown>){const calls:Filter[]=[];const legs:readonly [EconomicStateRpcLeg,EconomicStateRpcLeg]=[{operatorId:'primary',send:async(method,params)=>{expect(method).toBe('trace_filter');const f=params[0] as Filter;calls.push(f);return read(f);}},{operatorId:'independent',send:async()=>{throw Error('discovery should use primary only');}}];return {calls,options:{traceLegs:legs}};}
describe('complete trace discovery with fewer range queries',()=>{
 it('more than1000 frames include movements at both page boundaries and advance by every raw frame',async()=>{
  const frames=Array.from({length:1205},(_,i)=>frame(i,500,i===999||i===1000?'0x7':'0x0'));
  const r=reader(f=>frames.slice(f.after,f.after+f.count));const out=await readBaseInternalEthPointers(args,r.options);
  expect(out.map(p=>p.transactionHash)).toEqual([hash(1000),hash(1001)]);expect(r.calls.map(c=>c.after)).toEqual([0,1000,1205]);expect(r.calls.every(c=>c.count===1000)).toBe(true);
 });
 it('short provider-capped pages are not mistaken for completion; zero/reverted frames occupy offsets',async()=>{
  const frames=Array.from({length:405},(_,i)=>({...frame(i,501,i===404?'0x9':'0x0'),...(i===399?{error:'Reverted'}:{})}));
  const r=reader(f=>frames.slice(f.after,f.after+200));expect((await readBaseInternalEthPointers(args,r.options)).map(p=>p.valueWei)).toEqual(['9']);expect(r.calls.map(c=>c.after)).toEqual([0,200,400,405]);
 });
 it('an exactly full page still requires the empty terminator',async()=>{
  const frames=Array.from({length:1000},(_,i)=>frame(i));const r=reader(f=>frames.slice(f.after,f.after+1000));expect(await readBaseInternalEthPointers(args,r.options)).toHaveLength(1000);expect(r.calls.map(c=>c.after)).toEqual([0,1000]);
 });
 it('a later RPC failure or malformed page refuses the entire discovery',async()=>{
  const failed=reader(f=>{if(f.after)throw Error('later_page_failed');return [frame(1)];});await expect(readBaseInternalEthPointers(args,failed.options)).rejects.toThrow('later_page_failed');
  const malformed=reader(f=>f.after?{not:'array'}:[frame(1)]);await expect(readBaseInternalEthPointers(args,malformed.options)).rejects.toThrow('trace_unavailable');
  const outside=reader(f=>f.after?[frame(2,600)]:[frame(1)]);await expect(readBaseInternalEthPointers(args,outside.options)).rejects.toThrow('trace_out_of_range');
 });
 it('a provider ignoring after is refused without dropping duplicate-value legitimate frames',async()=>{
  const stalled=reader(()=>[frame(1),frame(2)]);await expect(readBaseInternalEthPointers(args,stalled.options)).rejects.toThrow('trace_pagination_stalled');expect(stalled.calls).toHaveLength(2);
 });
 it('wide500-block discovery covers five100-block ranges, with explicit smaller-limit retries exact',async()=>{
  const frames=[frame(1,500),frame(2,609),frame(3,999)];const r=reader(f=>frames.filter(p=>p.blockNumber>=Number(BigInt(f.fromBlock))&&p.blockNumber<=Number(BigInt(f.toBlock))).slice(f.after));
  expect((await readBaseInternalEthPointers({...args,toBlock:999},r.options)).map(p=>p.blockNumber)).toEqual([500,609,999]);expect(r.calls.filter(f=>f.after===0).map(f=>[Number(BigInt(f.fromBlock)),Number(BigInt(f.toBlock))])).toEqual([[500,599],[600,699],[700,799],[800,899],[900,999]]);
  const limited=reader(f=>{if(Number(BigInt(f.toBlock))-Number(BigInt(f.fromBlock))+1>30)throw Error('Block range too large; currently limited to 30 blocks');return frames.filter(p=>p.blockNumber>=Number(BigInt(f.fromBlock))&&p.blockNumber<=Number(BigInt(f.toBlock))).slice(f.after);});
  expect((await readBaseInternalEthPointers({...args,toBlock:999},limited.options)).map(p=>p.blockNumber)).toEqual([500,609,999]);
  const unknown=reader(()=>{throw Error('transport unavailable');});await expect(readBaseInternalEthPointers(args,unknown.options)).rejects.toThrow('transport unavailable');expect(unknown.calls).toHaveLength(1);
 });
 it('relay heap OOM 2026-10-17: a timed-out first page halves the range down to one block; later-page and one-block timeouts still throw',async()=>{
  const frames=[frame(1,510),frame(2,555),frame(3,599)];
  const timeout=()=>Object.assign(Error('request timeout (code=TIMEOUT, version=6.16.0)'),{code:'TIMEOUT'});
  const slow=reader(f=>{const width=Number(BigInt(f.toBlock))-Number(BigInt(f.fromBlock))+1;if(width>12)throw timeout();return frames.filter(p=>p.blockNumber>=Number(BigInt(f.fromBlock))&&p.blockNumber<=Number(BigInt(f.toBlock))).slice(f.after);});
  expect((await readBaseInternalEthPointers(args,slow.options)).map(p=>p.blockNumber)).toEqual([510,555,599]);
  const firstPages=slow.calls.filter(f=>f.after===0).map(f=>[Number(BigInt(f.fromBlock)),Number(BigInt(f.toBlock))]);
  expect(firstPages.slice(0,4)).toEqual([[500,599],[500,549],[500,524],[500,511]]);
  // every block of the window was covered by a range that answered
  const answered=firstPages.filter(([a,b])=>b-a+1<=12);expect(answered[0][0]).toBe(500);expect(answered[answered.length-1][1]).toBe(599);
  for(let i=1;i<answered.length;i++)expect(answered[i][0]).toBe(answered[i-1][1]+1);
  // RED twins: a timeout after the first page, and a timeout on a single block, refuse the window
  const later=reader(f=>{if(f.after)throw timeout();return [frame(1)];});await expect(readBaseInternalEthPointers(args,later.options)).rejects.toThrow('request timeout');
  const always=reader(()=>{throw timeout();});await expect(readBaseInternalEthPointers({...args,toBlock:500},always.options)).rejects.toThrow('request timeout');expect(always.calls).toHaveLength(1);
 });
});

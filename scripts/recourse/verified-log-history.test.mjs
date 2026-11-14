import {test,expect,vi} from 'vitest';
import {verifiedLogHistory} from './verified-log-history.mjs';
function fixture(){
 let final=100, changed=false, failure=false;
 const read=vi.fn(async(a,from,to)=>{if(failure)throw Error('provider unavailable');return Array.from({length:to-from+1},(_,i)=>({block:from+i}));});
 const hash=vi.fn(async n=>'0x'+BigInt(n+(changed?1000:0)).toString(16).padStart(64,'0'));
 const logs=verifiedLogHistory({read,blockHash:hash,finalizedBlock:async()=>({number:final})});
 return {logs,read,hash,reorg:()=>changed=true,fail:v=>failure=v,final:v=>final=v};
}
test('cold history then fresh suffix only; unchanged histories still authenticate canonical boundaries',async()=>{
 const f=fixture();expect(await f.logs('a',1,90)).toHaveLength(90);
 const first=await f.logs('a',1,90);first[0].block=999;
 expect((await f.logs('a',1,90))[0].block).toBe(1);
 expect(f.read).toHaveBeenCalledTimes(1);expect(f.hash.mock.calls.length).toBeGreaterThan(2);
 expect(await f.logs('a',1,95)).toHaveLength(95);expect(f.read).toHaveBeenLastCalledWith('a',91,95,undefined);
});
test('negative controls: changed canonical history and provider failure fail closed without saving suffix',async()=>{
 const f=fixture();await f.logs('a',1,90);f.reorg();await expect(f.logs('a',1,95)).rejects.toThrow('reorg');expect(f.read).toHaveBeenCalledTimes(1);
 const g=fixture();await g.logs('a',1,90);g.fail(true);await expect(g.logs('a',1,95)).rejects.toThrow('unavailable');g.fail(false);await g.logs('a',1,95);expect(g.read).toHaveBeenLastCalledWith('a',91,95,undefined);
});
test('unfinalized ranges are never cached and filters/from boundaries do not share evidence',async()=>{
 const f=fixture();await f.logs('a',1,101);await f.logs('a',1,101);expect(f.read).toHaveBeenCalledTimes(2);
 await f.logs('a',1,90,['x']);await f.logs('a',1,90,['y']);await f.logs('b',1,90,['x']);await f.logs('a',2,90,['x']);expect(f.read).toHaveBeenCalledTimes(6);
});
test('reorganization during suffix read refuses and concurrent extensions serialize',async()=>{
 const f=fixture();await f.logs('a',1,90);f.read.mockImplementationOnce(async()=>{f.reorg();return [{block:91}];});await expect(f.logs('a',1,91)).rejects.toThrow('reorg');
 const g=fixture();await Promise.all([g.logs('a',1,90),g.logs('a',1,95)]);expect(g.read.mock.calls.map(c=>c.slice(1,3))).toEqual([[1,90],[91,95]]);
});

test('missing canonical hashes cannot become reusable evidence',async()=>{const f=fixture();f.hash.mockResolvedValue(undefined);await expect(f.logs('a',1,90)).rejects.toThrow('hash_invalid');expect(f.read).not.toHaveBeenCalled();});

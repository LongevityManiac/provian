/** Actual Lua against a disposable loopback-only Redis container, never production. */
import {execFileSync} from 'child_process';
import {RedisCache,RECOVERED_PE_COUNTER_SLOT_LUA} from '../../cache';
import {privateCacheAlias,PRIVATE_CACHE_READY_KEY,migrateCacheSlotLua} from './private-cache';
const suite=process.env.LOCAL_REDIS_CONTROL==='1'?describe:describe.skip;
const cli=(...args:string[])=>{const result=execFileSync('docker',['exec','d554-redis-control','redis-cli','--json',...args],{encoding:'utf8'});if(result.startsWith('error:'))throw new Error(result);return JSON.parse(result);};
suite(' actual Redis monetary slot migration',()=>{
 let cache:RedisCache,script:string,keys:string[];
 beforeEach(()=>{
  cli('FLUSHDB');process.env.RELAY_SIGNING_KEY='test-relay-signing-key';cache=new RedisCache();
  (cache as any).client={eval:async(s:string,k:string[],a:string[])=>{script=s;keys=k;return cli('EVAL',s,String(k.length),...k,...a);}};
 });
 const request={peId:'pe_m_guessable_private_commitment',userId:'actor',actionType:'agent_action',timestampMs:1788800000000};
 it('RED dropping old-slot recognition reconsumes novelty; actual migration keeps both old/new writers safe until drain, then hides legacy with exact TTL',async()=>{
  const old='pvt:accounting:pe:'+request.peId,newKey='pvt:accounting:pe:private_'+privateCacheAlias('accounting',request.peId);
  cli('SET',old,'1','EX','600');
  expect((await cache.commitPEAccountingCountersOnce(request)).idempotent).toBe(true);
  expect(cli('GET',old)).toBe('1');expect(cli('GET',newKey)).toBe('1');expect(cli('GET',keys[3])).toBe(null);
  const ttl=cli('PTTL',old);cli('SET',PRIVATE_CACHE_READY_KEY,'1');
  expect((await cache.commitPEAccountingCountersOnce(request)).idempotent).toBe(true);
  expect(cli('GET',old)).toBe(null);expect(cli('PTTL',newKey)).toBeLessThanOrEqual(ttl);expect(cli('PTTL',newKey)).toBeGreaterThan(0);
  // Actual old code's slot read remains true until the gate, rather than a fake counter assertion.
  cli('FLUSHDB');cli('SET',old,'1','EX','600');
  const red=script.replace(migrateCacheSlotLua(1,6,7),'');
  expect(cli('EVAL',red,String(keys.length),...keys,'1','604800')).toBe(0);
  expect(cli('GET',keys[3])).toBe('1');
 });
 it('fresh work is mirrored for old writers; once drained new work has only its secret alias and never consumes twice',async()=>{
  expect((await cache.commitPEAccountingCountersOnce(request)).idempotent).toBe(false);
  expect(cli('GET',keys[5])).toBe('1');expect(cli('GET',keys[3])).toBe('1');
  expect((await cache.commitPEAccountingCountersOnce(request)).idempotent).toBe(true);expect(cli('GET',keys[3])).toBe('1');
  cli('SET',PRIVATE_CACHE_READY_KEY,'1');await cache.commitPEAccountingCountersOnce(request);expect(cli('GET',keys[5])).toBe(null);
  expect((await cache.commitPEAccountingCountersOnce({...request,peId:'second-private-id'})).idempotent).toBe(false);
  expect(cli('GET',keys[5])).toBe(null);expect(cli('GET',keys[3])).toBe('2');
 });
 it('conflicting claim representations refuse before any economic counter changes',async()=>{
  cli('SET','pvt:accounting:pe:'+request.peId,'old','EX','600');
  cli('SET','pvt:accounting:pe:private_'+privateCacheAlias('accounting',request.peId),'different','EX','600');
  await expect(cache.commitPEAccountingCountersOnce(request)).rejects.toThrow('private_cache_claim_conflict');
  expect(cli('GET',keys[3])).toBe(null);
 });
 it('recovery preserves a seven-field original verdict; a five-field original upgrades occurrence exactly once and mirrors the verdict until drain',async()=>{
  const old='pe_rate:pending_cache_recovery:'+request.peId;
  cli('SET',old,'1:2:3:3:4:5:6','EX','500');
  const preserved=await cache.consumeRecoveredPECounterSlot('actor',request.peId,'agent_action','2026-09-08');
  expect(preserved).toMatchObject({hourlyCountBefore:2,dailyCountBefore:3,occurrenceCountBefore:5,idempotent:true});
  expect(cli('GET',old)).toBe('1:2:3:3:4:5:6');
  cli('FLUSHDB');cli('SET',old,'1:2:3:3:4','EX','500');
  expect((await cache.consumeRecoveredPECounterSlot('actor',request.peId,'agent_action','2026-09-08')).occurrenceCountAfter).toBe(1);
  expect(cli('GET',old)).toBe('1:2:3:3:4:0:1');
  expect((await cache.consumeRecoveredPECounterSlot('actor',request.peId,'agent_action','2026-09-08')).idempotent).toBe(true);
  expect(cli('GET','pvt:occ:actor:agent_action:2026-09-08')).toBe('1');
  cli('SET',PRIVATE_CACHE_READY_KEY,'1');await cache.consumeRecoveredPECounterSlot('actor',request.peId,'agent_action','2026-09-08');expect(cli('GET',old)).toBe(null);
  expect(RECOVERED_PE_COUNTER_SLOT_LUA).toContain(migrateCacheSlotLua(3,5,6));
 });
});

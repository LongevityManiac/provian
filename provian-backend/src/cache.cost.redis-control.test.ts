/** Production Lua evaluated against this run's disposable Redis, never the platform database. */
import {execFileSync} from 'child_process';
import {RedisCache,FIXED_WINDOW_RATE_LIMIT_LUA,RECORD_ARTIFACT_HASH_LUA} from './cache';
import {PRIVATE_CACHE_READY_KEY} from './core/provenance/private-cache';
const suite=process.env.COST_LOCAL_REDIS==='1'?describe:describe.skip;
const cli=(...args:string[]):unknown=>JSON.parse(execFileSync('docker',['exec','provian-cost-redis-control','redis-cli','--json',...args],{encoding:'utf8'}));
suite('cost-cut atomic Redis commands, same limits and expiry',()=>{
 const prior=process.env.RELAY_SIGNING_KEY;afterAll(()=>{if(prior===undefined)delete process.env.RELAY_SIGNING_KEY;else process.env.RELAY_SIGNING_KEY=prior;});
 let cache:RedisCache,trips:number;const key='cost-local-rate';
 beforeEach(()=>{cli('FLUSHDB');process.env.RELAY_SIGNING_KEY='public-local-redis-cost-proof';trips=0;cache=new RedisCache();(cache as unknown as {client:unknown}).client={eval:async(s:string,k:string[],a:string[])=>{trips++;return cli('EVAL',s,String(k.length),...k,...a);}};});
 it('weighted counts, first expiry, exact-limit acceptance and denial TTL take one round trip each',async()=>{
  expect(await cache.checkRateLimit(key,20,60,10)).toEqual({allowed:true,current:10,limit:20});expect(cli('TTL',key)).toBeGreaterThan(0);
  cli('EXPIRE',key,'40');expect(await cache.checkRateLimit(key,20,60,10)).toEqual({allowed:true,current:20,limit:20});expect(cli('TTL',key)).toBeLessThanOrEqual(40);
  expect(await cache.checkRateLimit(key,20,60)).toMatchObject({allowed:false,current:21,limit:20,retryAfter:40});expect(trips).toBe(3);
 });
 it('strict behavior and orphan TTL fallback remain exact; RED removing expiry leaves an immortal first-request key',async()=>{
  expect(await cache.checkRateLimitStrict(key,1,60)).toEqual({allowed:true,current:1,limit:1});expect(await cache.checkRateLimitStrict(key,1,60)).toMatchObject({allowed:false,current:2,retryAfter:60});
  cli('PERSIST',key);expect(await cache.checkRateLimitStrict(key,1,60)).toMatchObject({allowed:false,current:3,retryAfter:60});
  cli('DEL',key);const red=FIXED_WINDOW_RATE_LIMIT_LUA.replace("if current==cost then redis.call('EXPIRE',KEYS[1],ARGV[2]) end",'');cli('EVAL',red,'1',key,'1','60','1');expect(cli('TTL',key)).toBe(-1);
 });
 it('artifact first TTL is 25h, not refreshed by repeats; old/new aliases and drain gate retain the same set',async()=>{
  cli('EVAL',RECORD_ARTIFACT_HASH_LUA,'2','artifacts',PRIVATE_CACHE_READY_KEY,'legacy','secret');expect(cli('SMEMBERS','artifacts')).toEqual(expect.arrayContaining(['legacy','secret']));expect(cli('TTL','artifacts')).toBe(90000);
  cli('EXPIRE','artifacts','500');cli('EVAL',RECORD_ARTIFACT_HASH_LUA,'2','artifacts',PRIVATE_CACHE_READY_KEY,'legacy','secret');expect(cli('TTL','artifacts')).toBeLessThanOrEqual(500);
  cli('SET',PRIVATE_CACHE_READY_KEY,'1');cli('EVAL',RECORD_ARTIFACT_HASH_LUA,'2','artifacts',PRIVATE_CACHE_READY_KEY,'legacy','secret');expect(cli('SMEMBERS','artifacts')).toEqual(['secret']);
 });
});

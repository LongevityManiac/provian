import {Redis,type Requester,type UpstashRequest} from '@upstash/redis';
import {scanPrivateCacheKeys} from '../../../scripts/lib/private-cache-scan';

it('actual Upstash command serialization preserves the live 64-bit cursor; RED number coercion loses later records',async()=>{
 const cursor='13028813533497619683',requests:unknown[][]=[];
 const requester:Requester={request:async<TResult>(request:UpstashRequest)=>{
  const body=request.body as unknown[];requests.push(body);
  expect(body[0]).toBe('scan');
  const result=String(body[1])==='0'?[cursor,['first']]:body[1]===cursor?['0',['second','third']]:['0',[]];
  return {result:result as TResult};
 }};
 const redis=new Redis(requester),found:string[]=[];
 for await(const key of scanPrivateCacheKeys(redis,'pvt:accounting:pe:*'))found.push(key);
 expect(found).toEqual(['first','second','third']);expect(requests[1][1]).toBe(cursor);
 const redFirst=await redis.scan(0,{match:'pvt:accounting:pe:*',count:200});
 const redSecond=await redis.scan(Number(redFirst[0]),{match:'pvt:accounting:pe:*',count:200});
 expect(String(Number(cursor))).not.toBe(cursor);
 expect([...redFirst[1],...redSecond[1]]).toEqual(['first']);
});

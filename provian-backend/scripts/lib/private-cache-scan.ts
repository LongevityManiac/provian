import type {Redis} from '@upstash/redis';

/** Redis cursors are opaque unsigned 64-bit strings, not JavaScript numbers. */
export async function* scanPrivateCacheKeys(redis:Pick<Redis,'scan'>,pattern:string):AsyncGenerator<string> {
 let cursor='0';
 do {
  const page=await redis.scan(cursor,{match:pattern,count:200});
  cursor=page[0];
  for(const key of page[1])yield key;
 } while(cursor!=='0');
}

import {createHmac} from 'crypto';
import {privateRetentionKey} from './private-retention';
export function privateCacheAlias(domain:string,value:string):string {
 return createHmac('sha256',privateRetentionKey()).update('provian-private-cache:v1\0'+domain+'\0'+value).digest('hex');
}
/** Preserve the original slot and its remaining TTL atomically, including legacy retries. */
export const PRIVATE_CACHE_READY_KEY='provian:private-retention:d554:opaque_ids_ready';
export const migrateCacheSlotLua=(target:number,legacy:number,gate:number)=>[
 `local old = redis.call('GET', KEYS[${legacy}])`,
 'if old then',
 ` local current = redis.call('GET', KEYS[${target}])`,
 " if current and current ~= old then return redis.error_reply('private_cache_claim_conflict') end",
 ` if redis.call('GET',KEYS[${gate}]) == '1' then`,
 `  if not current then redis.call('RENAME', KEYS[${legacy}], KEYS[${target}]) else redis.call('DEL', KEYS[${legacy}]) end`,
 ' elseif not current then',
 `  local ttl=redis.call('PTTL',KEYS[${legacy}]); if ttl>0 then redis.call('SET',KEYS[${target}],old,'PX',ttl) else redis.call('SET',KEYS[${target}],old) end`,
 ' end',
 'end',
].join('\n');

export const mirrorCacheSlotLua=(target:number,legacy:number,gate:number)=>[
 `if redis.call('GET',KEYS[${gate}]) ~= '1' then`,
 ` local value=redis.call('GET',KEYS[${target}]); local ttl=redis.call('PTTL',KEYS[${target}])`,
 ` if value then if ttl>0 then redis.call('SET',KEYS[${legacy}],value,'PX',ttl) else redis.call('SET',KEYS[${legacy}],value) end end`,
 'end',
].join('\n');

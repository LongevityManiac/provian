import { beforeEach, expect, test, vi } from 'vitest';
const f=vi.hoisted(()=>({store:new Map<string,string>()}));
vi.mock('@react-native-async-storage/async-storage',()=>({default:{getItem:async(k:string)=>f.store.get(k)??null,
 setItem:async(k:string,v:string)=>{f.store.set(k,v);},removeItem:async(k:string)=>{f.store.delete(k);}}}));
vi.mock('expo-secure-store',()=>({WHEN_UNLOCKED_THIS_DEVICE_ONLY:'device',getItemAsync:async()=> '11'.repeat(32),setItemAsync:async()=>{}}));
import { getItemHmac, setItemHmac } from './hmacAsyncStorage';
beforeEach(()=>f.store.clear());
test('occurrence reads preserve a corrupt authenticated entry across retries, while ordinary reads retain existing removal behavior',async()=>{
 await setItemHmac('occurrence',{id:'original'});expect(await getItemHmac('occurrence')).toEqual({id:'original'});
 const tampered=JSON.parse(f.store.get('occurrence')!);tampered.payload.id='changed';f.store.set('occurrence',JSON.stringify(tampered));
 for(let i=0;i<2;i++){expect(await getItemHmac('occurrence',{preserveInvalid:true})).toBeNull();expect(f.store.has('occurrence')).toBe(true);}
 expect(await getItemHmac('occurrence')).toBeNull();expect(f.store.has('occurrence')).toBe(false);
});

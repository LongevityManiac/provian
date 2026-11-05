import { describe, it, expect } from 'vitest';
import { stripGrokRepoint, unrepointGrok } from './grok-proxy-config';
describe('retired installer endpoint cleanup',()=>{
 it('removes only installer-owned endpoint lines; RED user endpoints survive',()=>{
  const user='[endpoints]\ncli_chat_proxy_base_url="https://mine.example"\n';
  expect(stripGrokRepoint(user)).toEqual({next:user,changed:false});
  const old='[endpoints] # provian-proxy\ncli_chat_proxy_base_url="http://127.0.0.1:4320/xai" # provian-proxy\n';
  expect(stripGrokRepoint(old).next).not.toContain('4320');
  let output='';expect(unrepointGrok({home:'/fixture',io:{read:()=>old,copy:()=>{},writeAtomic:(_p,v)=>{output=v;}}})).toBe('removed');
  expect(output).not.toContain('4320');
 });
});

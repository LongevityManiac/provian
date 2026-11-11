import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const a='0x'+'11'.repeat(20), b='0x'+'22'.repeat(20);
function harness({lost=false, wallet=a}={}) {
 const elements=new Map(), calls=[], signatures=[]; let completed=false;
 const document={querySelector:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);}};
 const fetch=async(path,options)=>{const body=options?.body?JSON.parse(options.body):null;calls.push({path,body});
  if(path==='/exercise'&&lost)throw Error('lost response');
  let data={};
  if(path==='/state')data={identity:'id',balance:'0',bound:true,member:true,sequenceStarted:true,exerciseBusy:true};
  if(path==='/exercise-status')data=completed?{state:'completed',result:'done'}:{state:'running',pending:{id:'request',challenge:{summary:'join',messageHex:'0x1234'}}};
  if(path==='/exercise-signature')completed=true;
  return {ok:true,json:async()=>data};};
 const ethereum={request:async args=>{if(args.method==='eth_chainId')return '0x7a69';if(args.method==='eth_accounts')return [wallet];if(args.method==='personal_sign'){signatures.push(args.params);return 'signed';}throw Error(args.method);}};
 const context=vm.createContext({document,fetch,ethereum,window:{ethereum},formatEther:v=>v,setTimeout:fn=>{fn();return 1;},Interface:class {}});
 const text=readFileSync(new URL('./exercise-workbench.mjs',import.meta.url),'utf8').match(/const client = `([\s\S]*?)`;/)[1].replace(/import .*?;\n/,'');
 vm.runInContext(text+'\nglobalThis.setAccount=v=>{account=v;config={copiedFunder:true};};globalThis.follow=followExercise;',context);
 context.setAccount(a);
 return {context,elements,calls,signatures};
}
test('lost successful start response resumes existing job without second POST',async()=>{
 const h=harness({lost:true});await h.elements.get('#exercise').onclick();
 expect(h.calls.filter(c=>c.path==='/exercise')).toHaveLength(1);
 expect(h.calls.filter(c=>c.path==='/exercise-signature')).toHaveLength(1);
 expect(h.elements.get('#status').textContent).toBe('done');
});
test('fresh page refresh resumes a running signature request without starting a job',async()=>{
 const h=harness();await h.elements.get('#refresh').onclick();
 expect(h.calls.some(c=>c.path==='/exercise')).toBe(false);
 expect(h.signatures).toEqual([['0x1234',a]]);
 expect(h.elements.get('#status').textContent).toBe('done');
});
test('polling captures account and deduplicates concurrent resume calls',async()=>{
 const h=harness(), one=h.context.follow(a), two=h.context.follow(a);h.context.setAccount(b);await Promise.all([one,two]);
 expect(h.signatures).toEqual([['0x1234',a]]);
 expect(h.calls.filter(c=>c.path==='/exercise-signature').map(c=>c.body.address)).toEqual([a]);
});
test('changed wallet refuses signing and permits a later fresh resume',async()=>{
 const h=harness({wallet:b});await expect(h.context.follow(a)).rejects.toThrow('Reconnect');
 expect(h.signatures).toEqual([]);expect(h.calls.some(c=>c.path==='/exercise-signature')).toBe(false);
});

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { sha256, toUtf8Bytes } from 'ethers';
import { createHashAuthority,prepareVaultHashOperation,onePasswordInvocation } from './hash-authority-vault.mjs';
import { spawnSync } from 'node:child_process';
test('template stdin uses a real pipe and hostile argument text is never shell code',()=>{
 const args=['item','create','-','--vault','$(exit 91); `exit 92`'];
 const invocation=onePasswordInvocation(args,true);
 assert.equal(invocation.command,'/bin/sh');
 assert.deepEqual(invocation.args.slice(3),args);
 // Replace only the command in this public fixture; exercise the exact pipe
 // and quoted argument forwarding with a child that reports received bytes.
 const command=invocation.args[1].replace('op "$@"','"$@"');
 const result=spawnSync(invocation.command,['-c',command,'fixture',process.execPath,'-e',
   'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.stringify({s,args:process.argv.slice(1),pipe:require("fs").fstatSync(0).isFIFO()})))',...args],
   {input:'public template fixture',encoding:'utf8'});
 assert.equal(result.status,0);
 assert.deepEqual(JSON.parse(result.stdout),{s:'public template fixture',args,pipe:true});
 assert.deepEqual(onePasswordInvocation(args,false),{command:'op',args});
});
function fixture(){
  const rows=new Map();let serial=0,signatures=0,corrupt=false;
  const vault={async create(record){const id=String(++serial);rows.set(id,structuredClone(record));return id;},
    async read(id){return {id,record:corrupt?{...rows.get(id),seed:'00'.repeat(32)}:structuredClone(rows.get(id))};},
    async byRoot(root){const entry=[...rows].find(([,row])=>row.root===root);if(!entry)throw Error('missing');return {id:entry[0],record:structuredClone(entry[1])};}};
  const crypto={root:async seed=>sha256(seed),digest:intent=>sha256(toUtf8Bytes(JSON.stringify(intent))),
    async prepare(input){const intent={...input.intent,nextCommitment:await crypto.root(input.nextSigningSeed)};
      await input.persistBeforeSigning(intent,input.nextSigningSeed);signatures++;return {...intent,signature:'public test signature'};}};
  return {vault,crypto,rows,signed:()=>signatures,corrupt:()=>{corrupt=true;}};
}
test('a durable read-back is required before provisioning or returning any signature',async()=>{
 const f=fixture(),initial=await createHashAuthority(f.vault,f.crypto);f.corrupt();
 await assert.rejects(prepareVaultHashOperation(f.vault,{currentRoot:initial.root,intent:{nonce:'0'}},f.crypto),/write_unconfirmed/);
 assert.equal(f.signed(),0);assert.equal(f.rows.size,2);
});
test('concurrent preparations retain every successor and never overwrite the original seed',async()=>{
 const f=fixture(),initial=await createHashAuthority(f.vault,f.crypto),original=structuredClone(f.rows.get(initial.itemId));
 const operations=await Promise.all([1,2].map(target=>prepareVaultHashOperation(f.vault,{currentRoot:initial.root,intent:{nonce:'0',target}},f.crypto)));
 assert.equal(f.rows.size,3);assert.deepEqual(f.rows.get(initial.itemId),original);
 for(const result of operations){
  const record=f.rows.get(result.nextItemId);assert.equal(record.root,result.operation.nextCommitment);
  assert.equal(record.parent.root,initial.root);assert.equal(record.intent.target,result.operation.target);
  assert.equal(JSON.stringify(result).includes(record.seed),false);
 }
 assert.notEqual(operations[0].nextItemId,operations[1].nextItemId);
});
test('a failed target still has a recoverable successor seed for the next account nonce',async()=>{
 const f=fixture(),initial=await createHashAuthority(f.vault,f.crypto);
 const first=await prepareVaultHashOperation(f.vault,{currentRoot:initial.root,intent:{nonce:'0',target:'fails'}},f.crypto);
 const next=await prepareVaultHashOperation(f.vault,{currentRoot:first.operation.nextCommitment,intent:{nonce:'1',target:'retry'}},f.crypto);
 assert.equal(f.rows.get(next.nextItemId).parent.itemId,first.nextItemId);assert.equal(f.rows.size,3);
});

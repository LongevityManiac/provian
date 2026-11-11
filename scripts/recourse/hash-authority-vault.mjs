import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { recoverySigningRoot } from '../../provian-agent-sdk/dist/recourse-hash-authorization.js';
import { prepareHashAccountOperation, hashAccountIntentDigest } from '../../provian-agent-sdk/dist/hash-account.js';

/** All secret input/output stays in this process. Never put a seed in argv,
 * temporary files, errors or console output. 1Password supplies encrypted,
 * independently recoverable storage, not an on-chain signing service. */
export function onePasswordInvocation(args, hasInput) {
  // Node supplies a socket as child stdin on macOS; the CLI only recognizes
  // piped templates on an actual pipe. cat supplies that pipe without a file
  // or any secret in argv. Positional arguments remain data, never shell code.
  return hasInput
    ? { command: '/bin/sh', args: ['-c', 'cat | op "$@"', 'op-stdin', ...args] }
    : { command: 'op', args };
}
function op(args, input) {
  return new Promise((resolve,reject)=>{
    const invocation=onePasswordInvocation(args,input!==undefined);
    const child=spawn(invocation.command,invocation.args,{stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0,failed=false;
    child.stdout.on('data',chunk=>{
      size+=chunk.length;
      if(size>1024*1024){failed=true;child.kill();return;}
      chunks.push(chunk);
    });
    child.stderr.on('data',()=>{});
    child.on('error',()=>reject(Error('recourse_vault_unavailable')));
    child.on('close',code=>{
      if(code!==0||failed){reject(Error('recourse_vault_unavailable'));return;}
      try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
      catch{reject(Error('recourse_vault_reply_invalid'));}
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(input===undefined?undefined:JSON.stringify(input));
  });
}
const title=root=>`Provian hash authority ${root}`;
function decode(item){
  if(!item||typeof item.id!=='string'||!Array.isArray(item.fields))throw Error('recourse_vault_record_invalid');
  const value=item.fields.find(field=>field.id==='authority_record')?.value;
  if(typeof value!=='string')throw Error('recourse_vault_record_invalid');
  let record;try{record=JSON.parse(value);}catch{throw Error('recourse_vault_record_invalid');}
  return {id:item.id,record};
}
export function onePasswordAuthorityVault(vault){
  if(typeof vault!=='string'||!vault.trim()||vault.startsWith('-'))throw Error('recourse_vault_invalid');
  return {
    async create(record){
      const response=await op(['item','create','-','--vault',vault,'--format','json'],{
        category:'SECURE_NOTE',title:title(record.root),tags:['provian-hash-authority'],
        fields:[{id:'authority_record',label:'authority_record',type:'CONCEALED',value:JSON.stringify(record)}],
      });
      if(!response||typeof response.id!=='string')throw Error('recourse_vault_reply_invalid');
      return response.id;
    },
    async read(id){
      if(typeof id!=='string'||!id||id.startsWith('-'))throw Error('recourse_vault_item_invalid');
      return decode(await op(['item','get',id,'--vault',vault,'--format','json','--reveal']));
    },
    async byRoot(root){
      if(!/^0x[0-9a-f]{64}$/.test(root))throw Error('recourse_vault_root_invalid');
      return decode(await op(['item','get',title(root),'--vault',vault,'--format','json','--reveal']));
    },
  };
}
const defaultCrypto={root:recoverySigningRoot,prepare:prepareHashAccountOperation,digest:hashAccountIntentDigest};
function seedOf(record){
  if(!record||record.schema!=='provian.hash-authority.v1'||!/^0x[0-9a-f]{64}$/.test(record.root)
    ||typeof record.seed!=='string'||!/^[0-9a-f]{64}$/.test(record.seed))throw Error('recourse_vault_record_invalid');
  return new Uint8Array(Buffer.from(record.seed,'hex'));
}
async function persist(vault,record){
  const id=await vault.create(record),read=await vault.read(id);
  const expected=Buffer.from(JSON.stringify(record)),actual=Buffer.from(JSON.stringify(read.record));
  if(read.id!==id||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('recourse_vault_write_unconfirmed');
  return id;
}
/** Provision only after explicit operator invocation. Each seed is a new vault
 * item and is never overwritten, including when two operators prepare different
 * successors concurrently. Whichever nonce wins has its own durable next seed. */
export async function createHashAuthority(vault,crypto=defaultCrypto){
  const seed=new Uint8Array(randomBytes(32));
  try{
    const root=await crypto.root(seed);
    const itemId=await persist(vault,{schema:'provian.hash-authority.v1',root,seed:Buffer.from(seed).toString('hex'),parent:null,intent:null});
    return {root,itemId};
  }finally{seed.fill(0);}
}
/** The caller independently verifies account code, chain, current root/nonce
 * and the complete requested call before invoking this signing boundary.
 * Returns public material only. A target-call failure still consumes the
 * account nonce, so its successor seed is retained unconditionally. */
export async function prepareVaultHashOperation(vault,input,crypto=defaultCrypto){
  const current=await vault.byRoot(input.currentRoot),seed=seedOf(current.record);
  const nextSeed=new Uint8Array(randomBytes(32));
  let nextItemId;
  try{
    if(await crypto.root(seed)!==input.currentRoot)throw Error('recourse_vault_root_mismatch');
    const operation=await crypto.prepare({intent:input.intent,signingSeed:seed,nextSigningSeed:nextSeed,
      async persistBeforeSigning(intent,successor){
        if(!timingSafeEqual(Buffer.from(successor),Buffer.from(nextSeed)))throw Error('recourse_vault_successor_mismatch');
        const root=await crypto.root(successor);
        if(root!==intent.nextCommitment)throw Error('recourse_vault_successor_mismatch');
        const digest=crypto.digest(intent);
        nextItemId=await persist(vault,{schema:'provian.hash-authority.v1',root,seed:Buffer.from(successor).toString('hex'),
          parent:{root:input.currentRoot,itemId:current.id},intent,digest});
      },
    });
    if(!nextItemId)throw Error('recourse_vault_write_unconfirmed');
    return {operation,nextItemId};
  }finally{seed.fill(0);nextSeed.fill(0);}
}

/** A cancellation installs the original operation's already-saved successor.
 * It never creates another seed at the same nonce. The caller fixes the self
 * call and authenticates the original durable operation before this boundary.
 * Both seeds and their lineage are read back before signing; only public
 * material is returned. persistIntent verifies the original durable record
 * from which the exact cancellation intent is deterministically derived. */
export async function prepareVaultHashCancellation(vault, input, persistIntent, crypto=defaultCrypto){
  input=structuredClone(input);
  const current=await vault.byRoot(input.currentRoot), saved=await vault.read(input.nextItemId);
  const seed=seedOf(current.record);let nextSeed;
  try{
    nextSeed=seedOf(saved.record);
    if(await crypto.root(seed)!==input.currentRoot || saved.id!==input.nextItemId
      || await crypto.root(nextSeed)!==input.nextCommitment || saved.record.root!==input.nextCommitment
      || saved.record.parent?.root!==input.currentRoot || saved.record.parent?.itemId!==current.id
      || saved.record.digest!==input.originalIntentDigest)throw Error('recourse_vault_cancellation_lineage');
    const operation=await crypto.prepare({intent:input.intent,signingSeed:seed,nextSigningSeed:nextSeed,
      async persistBeforeSigning(intent,successor){
        if(intent.nextCommitment!==input.nextCommitment
          || !timingSafeEqual(Buffer.from(successor),Buffer.from(nextSeed)))throw Error('recourse_vault_successor_mismatch');
        await persistIntent(intent);
      },
    });
    return {operation,nextItemId:input.nextItemId};
  }finally{seed.fill(0);nextSeed?.fill(0);}
}

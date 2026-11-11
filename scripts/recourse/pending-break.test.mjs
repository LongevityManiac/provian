import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AbiCoder, ZeroAddress, sha256 } from 'ethers';
import { readPendingBreak, pendingBreakAbi as abi } from './pending-break.mjs';
import { breakOwnerLeaf, breakInstitutionLeaf } from './break-snapshot.mjs';
import { merkle } from './snapshot.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,h=s=>sha256(Buffer.from(s));
function fixture(withInstitution=false){
 const predecessor=addr(1),kernel=addr(2),executor=addr(3),origin=addr(4),blockHash=h('pin');
 const entries=[0,1].map(i=>({kind:'owner',identity:h('owner'+i),amount:String(10+i),commitment:h('commit'+i),signingRoot:h('root'+i),accounts:[]}));
 for(const e of entries)e.leaf=breakOwnerLeaf(predecessor,100,e.identity,e.amount,e.commitment);
 entries.push({kind:'reversal-count',count:0,leaf:sha256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256','uint256'],['Provian reversal history count',predecessor,100,0]))});
 if(withInstitution)entries.push({kind:'institution',source:addr(30),destination:addr(31),amount:'5',runtimeHash:h('institution runtime'),
  leaf:breakInstitutionLeaf(predecessor,100,addr(30),addr(31),'5',h('institution runtime'))});
 entries.push({kind:'institution-count',count:withInstitution?1:0,amount:withInstitution?'5':'0',leaf:sha256(AbiCoder.defaultAbiCoder().encode(['string','address','uint256','uint256','uint256'],['Provian institution restoration count',predecessor,100,withInstitution?1:0,withInstitution?5:0]))});
 const tree=merkle(entries.map(e=>e.leaf));const snapshot={format:'provian-break-ownership-snapshot',predecessor,block:100,root:tree.root,
  counts:{owners:2},entries:entries.map((e,i)=>({...e,proof:tree.proofs[i]}))};
 const restored=new Set([entries[0].identity]);let noOrigin=false;let institutionImported=false;
 const port={async call(target,data,pin){assert.equal(pin,blockHash);const f=abi.parseTransaction({data});let v;
  switch(f.name){case 'ownerAuthorization':v=executor;break;case 'breakOrigin':v=noOrigin?ZeroAddress:origin;break;
  case 'restorationRoot':v=tree.root;break;case 'predecessor':v=predecessor;break;case 'lastGoodBlock':v=100;break;
  case 'migratedAddress':v=institutionImported;break;case 'restoredIdentity':v=restored.has(f.args[0]);break;default:throw Error(f.name);}
  return abi.encodeFunctionResult(f.name,[v]);}};
 return {input:{port,kernel,blockHash,artifact:{ownership:snapshot}},snapshot,restored,setInstitutionImported(){institutionImported=true;},setNoOrigin(){noOrigin=true;}};
}
test('only unissued original break balances carry across ordinary succession with their full root-bound proof set',async()=>{
 const f=fixture(),s=await readPendingBreak(f.input);assert.equal(s.amount,'11');assert.equal(s.owners.length,1);
 f.input.artifact={breakOriginSnapshot:s.snapshot};assert.equal((await readPendingBreak(f.input)).amount,'11');
 f.restored.clear();assert.equal((await readPendingBreak(f.input)).amount,'21');
 f.setNoOrigin();assert.equal(await readPendingBreak(f.input),null);
});
test('missing, truncated and substituted recovery artifacts cannot inflate or erase unissued entitlements',async()=>{
 for(const mutate of [f=>delete f.input.artifact,f=>f.snapshot.entries.pop(),f=>f.snapshot.entries[1].amount='1000',
  f=>f.snapshot.counts.owners=1,f=>f.snapshot.entries[0].identity=h('foreign')]){
  const f=fixture();mutate(f);await assert.rejects(readPendingBreak(f.input),/snapshot_break_/);
 }
});

test('a still-unimported institution prevents a later snapshot from losing its custody entitlement',async()=>{
 const f=fixture(true);await assert.rejects(readPendingBreak(f.input),/snapshot_break_institution_unrestored/);
 f.setInstitutionImported();assert.equal((await readPendingBreak(f.input)).amount,'11');
});

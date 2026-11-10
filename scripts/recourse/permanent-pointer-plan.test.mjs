import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { permanentPointerPlan,pointerRuntime,verifyPermanentPointerPlan,POINTER_CREATE2_FACTORY_CODE } from './permanent-pointer-plan.mjs';
const root=`0x${'22'.repeat(32)}`,block={number:123,hash:`0x${'33'.repeat(32)}`};
test('stable source-bound CREATE2 plan has a distinct pointer and immutable controller',()=>{
  const a=permanentPointerPlan(root),b=permanentPointerPlan(root);
  assert.deepEqual(a,b);assert.notEqual(a.pointer,a.authority);assert.notEqual(a.pointer,permanentPointerPlan(`0x${'44'.repeat(32)}`).pointer);
  assert.equal(a.transactions.length,2);assert.ok(a.transactions.every(t=>t.value==='0'));
  assert.throws(()=>permanentPointerPlan(`0x${'00'.repeat(32)}`),/root_invalid/);
});
test('immutable layout drift fails closed instead of replacing arbitrary bytecode words',()=>{
  const compiled=JSON.parse(readFileSync(new URL('../../contracts/out/ProvianProtocolPointer.sol/ProvianProtocolPointer.json',import.meta.url)));
  const plan=permanentPointerPlan(root);assert.match(pointerRuntime(compiled,plan.authority),/^0x[0-9a-f]+$/);
  const bad=structuredClone(compiled);bad.deployedBytecode.immutableReferences={unexpected:[{start:0,length:32}]};
  assert.throws(()=>pointerRuntime(bad,plan.authority),/placeholder/);
});
test('planning reads only and refuses factory substitution, occupied addresses, modified plans and reorgs',async()=>{
  const plan=permanentPointerPlan(root);let mode='valid';
  const port={finalizedBlock:async()=>block,blockHash:async()=>mode==='reorg'?root:block.hash,
    code:async address=>address===plan.factory?(mode==='factory'?'0x00':POINTER_CREATE2_FACTORY_CODE):(mode==='occupied'?'0x6000':'0x')};
  assert.deepEqual((await verifyPermanentPointerPlan(plan,port)).states,['undeployed','undeployed']);
  for(const bad of ['factory','occupied','reorg']){mode=bad;await assert.rejects(verifyPermanentPointerPlan(plan,port));}
  mode='valid';await assert.rejects(verifyPermanentPointerPlan({...plan,pointer:plan.authority},port),/changed/);
});

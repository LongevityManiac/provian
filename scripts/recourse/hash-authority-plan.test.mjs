import { test } from 'vitest';
import assert from 'node:assert/strict';
import { keccak256 } from 'ethers';
import { HASH_ACCOUNT_ABI } from '../../provian-agent-sdk/dist/hash-account.js';
import { verifyHashAuthorityPlan, prepareCheckedHashAuthority } from './hash-authority-plan.mjs';

const addr = n => `0x${n.toString(16).padStart(40,'0')}`;
const hash = n => `0x${n.toString(16).padStart(64,'0')}`;
const code = '0x60006000';
function fixture() {
  const plan = { schema:'provian.hash-authority-plan.v1',account:addr(1),target:addr(2),currentRoot:hash(3),
    targetRuntimeHash:keccak256(code),nonce:'0',value:'0',callGas:'100000',data:'0x0102' };
  let root=plan.currentRoot, nonce=0n, runtime=code;
  const port={async finalizedBlock(){return {number:100,hash:hash(100)};},async code(){return runtime;},
    async call(to,data){const call=HASH_ACCOUNT_ABI.parseTransaction({data});
      return HASH_ACCOUNT_ABI.encodeFunctionResult(call.name,[call.name==='nonce'?nonce:root]);}};
  return {plan,port,changeRoot(){root=hash(4);},changeNonce(){nonce=1n;},changeCode(){runtime='0x6001';}};
}
test('the plan binds exact account and target code and the independently read nonce and root',async()=>{
  const f=fixture();
  const checked=await verifyHashAuthorityPlan(f.plan,f.port,keccak256(code));
  assert.equal(checked.intent.chainId,'8453');assert.equal(checked.intent.data,f.plan.data);
  for(const change of ['changeRoot','changeNonce','changeCode']){
    const bad=fixture();bad[change]();
    await assert.rejects(verifyHashAuthorityPlan(bad.plan,bad.port,keccak256(code)),/state_changed|code_mismatch/);
  }
});
test('code or account-state disagreement is refused before any vault secret is read',async()=>{
  const f=fixture();f.changeCode();let reads=0;
  const vault={async byRoot(){reads++;throw Error('must not read');}};
  await assert.rejects(prepareCheckedHashAuthority(f.plan,f.port,keccak256(code),vault),/code_mismatch/);
  assert.equal(reads,0);
});

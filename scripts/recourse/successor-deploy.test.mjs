import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Interface, ZeroAddress, sha256, toUtf8Bytes } from 'ethers';
import { successorFixture } from './successor-plan.test.mjs';
import { buildSuccessorPlan, batchSuccessorImports } from './successor-plan.mjs';
import { readSuccessorArtifacts } from './successor-preflight.mjs';
import { permanentPointerPlan, pointerRuntime, POINTER_CREATE2_FACTORY_CODE } from './permanent-pointer-plan.mjs';
import { successorDeploymentSteps, successorDeploymentValidator } from './successor-deploy-cli.mjs';
const root = new URL('../..', import.meta.url).pathname;
const hash = n => '0x' + n.toString(16).padStart(64, '0');
function fixture() {
  const facts = successorFixture(), artifacts = readSuccessorArtifacts(root);
  const pointerPlan = permanentPointerPlan(hash(123));
  facts.pointerPlan = pointerPlan; facts.rule.rule.pointer = pointerPlan.pointer;
  facts.rule.ruleHash = sha256(toUtf8Bytes('Provian Recourse Pool membership rule\n' + JSON.stringify(facts.rule.rule) + '\n'));
  const plan = buildSuccessorPlan(facts), steps = successorDeploymentSteps(plan, artifacts, 16);
  const kernel = new Interface(artifacts.ProvianPVT9.abi);
  const authority = new Interface(['function nonce() view returns(uint256)', 'function keyCommitment() view returns(bytes32)']);
  const pointer = new Interface(artifacts.ProvianProtocolPointer.abi);
  const external = new Interface(['function administrativeHold() view returns(bool)', 'function batchApprover() view returns(address)', 'function balanceOf(address) view returns(uint256)']);
  const state = { published: false, absent: false, resumed: false, incoming: false };
  const port = {
    finalizedBlock: async () => ({ number: 21, hash: hash(21) }), blockHash: async n => hash(n),
    code: async address => address === pointerPlan.factory ? POINTER_CREATE2_FACTORY_CODE
      : address === pointerPlan.authority ? artifacts.ProvianHashAccount.deployedBytecode.object
      : state.absent ? '0x' : pointerRuntime(artifacts.ProvianProtocolPointer, pointerPlan.authority),
    logs: async address => !Array.isArray(address) && state.incoming ? [{}] : [],
    call: async (address, data) => {
      if (address === pointerPlan.authority) { const method = authority.parseTransaction({ data }).name;
        return authority.encodeFunctionResult(method, [method === 'nonce' ? 0 : pointerPlan.initialRoot]); }
      if (address === pointerPlan.pointer) { const method = pointer.parseTransaction({ data }).name;
        return pointer.encodeFunctionResult(method, [method === 'authority' ? pointerPlan.authority : state.published ? 1 : 0]); }
      if (address === plan.predecessor) { const method = kernel.parseTransaction({ data }).name;
        return kernel.encodeFunctionResult(method, [method === 'administrativeHold' ? !state.resumed : ZeroAddress]); }
      const method = external.parseTransaction({ data }).name;
      return external.encodeFunctionResult(method, [method === 'administrativeHold' ? true : method === 'batchApprover' ? ZeroAddress : 0]);
    },
  };
  const validate = successorDeploymentValidator({ plan, pointerPlan, deployment: facts.deployment, artifacts, port, steps });
  const checked = { planDigest: plan.digest, stageDigest: sha256(toUtf8Bytes(JSON.stringify({ planDigest: plan.digest, steps }))), steps };
  return { facts, artifacts, plan, steps, state, validate, checked };
}
test('deployment command derives only creation/import/configuration steps and validates exact stage plus live retirement', async () => {
  const f = fixture(); await f.validate(f.checked);
  assert.equal(f.steps.length, f.plan.creations.length + f.plan.configuration.length
    + batchSuccessorImports(f.plan, f.artifacts.ProvianSuccessionImporter.abi, 16).length);
  assert.ok(f.steps.every(step => step.value === '0'));
  assert.ok(!f.steps.some(step => step.label === f.plan.activation.label));
  assert.throws(() => successorDeploymentSteps(f.plan, f.artifacts), /batch_size/);
  for (const key of ['published', 'absent', 'resumed', 'incoming']) {
    f.state[key] = true; await assert.rejects(f.validate(f.checked)); f.state[key] = false;
  }
});
test('rehashed calldata substitutions and caller mutation cannot change the validated stage', async () => {
  const f = fixture(), edited = structuredClone(f.checked);
  edited.steps[0].data += '00';
  edited.stageDigest = sha256(toUtf8Bytes(JSON.stringify({ planDigest: edited.planDigest, steps: edited.steps })));
  await assert.rejects(f.validate(edited), /stage_changed/);
  const original = structuredClone(f.checked); f.steps[0].data += '00';
  await f.validate(original); await assert.rejects(f.validate(f.checked), /stage_changed/);
});
test('actual tsx command help starts without reading a key or contacting a chain', () => {
  const text = execFileSync(root + '/provian-backend/node_modules/.bin/tsx',
    [root + '/scripts/recourse/successor-deploy-cli.mjs', '--help'], { encoding: 'utf8', timeout: 30000 });
  assert.match(text, /Default performs read-only preflight/);
  assert.match(text, /does not retire the predecessor/);
});

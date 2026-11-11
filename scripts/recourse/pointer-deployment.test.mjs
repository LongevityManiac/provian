import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Interface, sha256, toUtf8Bytes } from 'ethers';
import { permanentPointerPlan, pointerRuntime, POINTER_CREATE2_FACTORY_CODE } from './permanent-pointer-plan.mjs';
import { preparePointerDeployment, verifyPointerDeployment, advancePointerDeployment, pointerDeploymentValidator } from './pointer-deployment.mjs';
const a = n => `0x${n.toString(16).padStart(40, '0')}`, h = n => `0x${n.toString(16).padStart(64, '0')}`;
const pointerArtifact = JSON.parse(readFileSync(new URL('../../contracts/out/ProvianProtocolPointer.sol/ProvianProtocolPointer.json', import.meta.url)));
const authorityArtifact = JSON.parse(readFileSync(new URL('../../contracts/out/ProvianHashAccount.sol/ProvianHashAccount.json', import.meta.url)));
const abi = new Interface(['function keyCommitment() view returns(bytes32)', 'function nonce() view returns(uint256)',
  'function authority() view returns(address)', 'function revision() view returns(uint256)']);
function fixture(initial = 0) {
  const pointerPlan = permanentPointerPlan(h(1)), levels = new Map([[h(100), initial]]);
  const state = { height: 100, reorg: false, used: false, published: false };
  const port = { finalizedBlock: async () => ({ number: state.height, hash: h(state.height) }),
    blockHash: async height => state.reorg && height === 100 ? h(999) : h(height),
    code: async (address, pin) => address === pointerPlan.factory ? POINTER_CREATE2_FACTORY_CODE
      : address === pointerPlan.authority && levels.get(pin) >= 1 ? authorityArtifact.deployedBytecode.object
        : address === pointerPlan.pointer && levels.get(pin) >= 2 ? pointerRuntime(pointerArtifact, pointerPlan.authority) : '0x',
    call: async (_target, data, pin) => {
      const method = abi.parseTransaction({ data }).name, current = pin !== h(100);
      return abi.encodeFunctionResult(method, [{ keyCommitment: h(1), nonce: current && state.used ? 1 : 0,
        authority: pointerPlan.authority, revision: current && state.published ? 1 : 0 }[method]]);
    } };
  return { pointerPlan, pin: { chainId: 8453, address: pointerPlan.pointer, runtimeHash: pointerPlan.pointerRuntimeHash }, deployer: a(2), port, state, levels };
}
test.each([0, 1, 2])('a newly prepared %s-component deployment has only its missing exact factory calls', async initial => {
  const f = fixture(initial), plan = await preparePointerDeployment(f);
  expect(plan.steps).toHaveLength(2 - initial);
  expect(plan.steps).toEqual(f.pointerPlan.transactions.slice(initial).map(transaction => ({ ...transaction, from: f.deployer })));
  expect((await verifyPointerDeployment({ plan, port: f.port, pin: f.pin })).deployed).toBe(initial === 2);
});
test.each(['deployer', 'init-code', 'value', 'stage'])('rehashed %s substitution refuses', async mode => {
  const f = fixture(), plan = await preparePointerDeployment(f), changed = structuredClone(plan);
  if (mode === 'deployer') changed.steps[0].from = a(88);
  if (mode === 'init-code') changed.steps[0].data += '00';
  if (mode === 'value') changed.steps[0].value = '1';
  if (mode === 'stage') changed.steps.reverse();
  delete changed.digest; changed.digest = sha256(toUtf8Bytes(JSON.stringify(changed)));
  await expect(verifyPointerDeployment({ plan: changed, port: f.port, pin: f.pin })).rejects.toThrow(/plan_changed/);
});
test('partial deployment retries keep the original full stage and cannot change its signer or nonce meanings', async () => {
  const f = fixture(), plan = await preparePointerDeployment(f); f.state.height = 110; f.levels.set(h(110), 1);
  const check = pointerDeploymentValidator({ plan, port: f.port, pin: f.pin });
  const stage = { planDigest: plan.digest, steps: plan.steps, stageDigest: sha256(toUtf8Bytes(JSON.stringify({ planDigest: plan.digest, steps: plan.steps }))) };
  expect((await check(stage)).deployed).toBe(false);
  await expect(check({ ...stage, steps: plan.steps.slice(1) })).rejects.toThrow(/stage_changed/);
});
test('read-only mode never requests signing and confirmed execution independently verifies both runtimes', async () => {
  const f = fixture(), plan = await preparePointerDeployment(f); let writes = 0;
  const runtime = async stage => { ++writes;
    await stage.assertPlan({ ...stage, stageDigest: sha256(toUtf8Bytes(JSON.stringify({ planDigest: stage.planDigest, steps: stage.steps }))) });
    f.state.height = 110; f.levels.set(h(110), 2); return { status: 'confirmed' };
  };
  expect(await advancePointerDeployment({ plan, port: f.port, pin: f.pin, execute: false, runtime })).toMatchObject({ status: 'preflight_passed', broadcast: false });
  expect(writes).toBe(0);
  expect(await advancePointerDeployment({ plan, port: f.port, pin: f.pin, execute: true, runtime })).toMatchObject({ status: 'confirmed', pointer: f.pointerPlan.pointer });
  expect(writes).toBe(1);
});
test('pending or falsely confirmed factory calls cannot certify the pointer', async () => {
  const f = fixture(), plan = await preparePointerDeployment(f);
  expect(await advancePointerDeployment({ plan, port: f.port, pin: f.pin, execute: true, runtime: async () => ({ status: 'awaiting_finality' }) }))
    .toEqual({ status: 'awaiting_finality' });
  await expect(advancePointerDeployment({ plan, port: f.port, pin: f.pin, execute: true, runtime: async () => ({ status: 'confirmed' }) })).rejects.toThrow(/incomplete/);
});
test('a nonempty original journal is reconciled even when both deployments are already visible', async () => {
  const f = fixture(), plan = await preparePointerDeployment(f); f.state.height = 110; f.levels.set(h(110), 2);
  await expect(advancePointerDeployment({ plan, port: f.port, pin: f.pin, execute: true, runtime: async () => { throw Error('receipt unresolved'); } })).rejects.toThrow('receipt unresolved');
});
test('a fresh fully deployed plan is read-only and never opens a signer reservation', async () => {
  const f = fixture(2), plan = await preparePointerDeployment(f);
  expect(await advancePointerDeployment({ plan, port: f.port, pin: f.pin, execute: true, runtime: async () => { throw Error('must not write'); } }))
    .toMatchObject({ status: 'confirmed', broadcast: false });
});
test.each(['reorg', 'used', 'published'])('%s refuses before a writer can act', async mode => {
  const f = fixture(), plan = await preparePointerDeployment(f); f.state.height = 110; f.levels.set(h(110), 2); f.state[mode] = true;
  await expect(advancePointerDeployment({ plan, port: f.port, pin: f.pin, execute: true, runtime: async () => { throw Error('must not write'); } }))
    .rejects.toThrow(mode === 'reorg' ? /reorg/ : /already_/);
});

test('a valid alternative CREATE2 root cannot replace the permanent build pin', async () => {
  const f = fixture(), alternate = permanentPointerPlan(h(88));
  await expect(preparePointerDeployment({ ...f, pointerPlan: alternate })).rejects.toThrow(/build_pin_changed/);
  const plan = await preparePointerDeployment(f);
  await expect(advancePointerDeployment({ plan, port: f.port, pin: { ...f.pin, address: alternate.pointer }, execute: true,
    runtime: async () => { throw Error('must not write'); } })).rejects.toThrow(/build_pin_changed/);
});

test('the actual pointer deployment command starts in help mode without key or chain access', async () => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const result = await promisify(execFile)(fileURLToPath(new URL('../../provian-backend/node_modules/.bin/tsx', import.meta.url)),
    [fileURLToPath(new URL('./pointer-deployment-cli.mjs', import.meta.url)), '--help'], { timeout: 30_000,
      env: { ...process.env, BASE_RPC_URL: 'https://invalid.example', BASE_RPC_URL_SECONDARY: 'https://invalid.example' } });
  expect(result.stdout).toContain('Default is read-only');
});

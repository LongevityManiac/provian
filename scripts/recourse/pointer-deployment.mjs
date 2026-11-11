import { sha256, toUtf8Bytes } from 'ethers';
import { verifyPermanentPointerPlan } from './permanent-pointer-plan.mjs';
const ensure = (value, reason) => { if (!value) throw Error('pointer_deployment_' + reason); };
const digest = value => sha256(toUtf8Bytes(JSON.stringify(value)));
function assertPin(pointerPlan, pin) {
  ensure(pin?.chainId === 8453 && typeof pin.address === 'string' && typeof pin.runtimeHash === 'string'
    && pointerPlan?.pointer === pin.address && pointerPlan.pointerRuntimeHash === pin.runtimeHash, 'build_pin_changed');
}
function assemble(pointerPlan, deployer, initial) {
  ensure(typeof deployer === 'string' && /^0x[0-9a-f]{40}$/.test(deployer) && !/^0x0+$/.test(deployer), 'deployer_invalid');
  const steps = pointerPlan.transactions.flatMap((transaction, index) => initial.states[index] === 'undeployed'
    ? [{ ...transaction, from: deployer }] : []);
  const body = { schema: 'provian.pointer-deployment.v1', chainId: 8453, pointerPlan,
    deployer, checkpoint: initial.block, initialStates: initial.states, steps };
  return { ...body, digest: digest(body) };
}
/** Preparation is read-only. The fixed CREATE2 plan authenticates factory code,
 * init code, independent hash authority and permanent pointer runtimes. An
 * already deployed component is skipped only in a newly prepared plan. */
export async function preparePointerDeployment({ pointerPlan, deployer, port, pin }) {
  assertPin(pointerPlan, pin);
  return assemble(pointerPlan, deployer, await verifyPermanentPointerPlan(pointerPlan, port));
}
export async function verifyPointerDeployment({ plan, port, pin, complete = false }) {
  assertPin(plan?.pointerPlan, pin);
  ensure(plan?.schema === 'provian.pointer-deployment.v1' && plan.chainId === 8453
    && Number.isSafeInteger(plan.checkpoint?.number) && plan.checkpoint.number > 0
    && /^0x[0-9a-f]{64}$/.test(plan.checkpoint.hash), 'plan_invalid');
  const initial = await verifyPermanentPointerPlan(plan.pointerPlan, { ...port, finalizedBlock: async () => plan.checkpoint });
  ensure(JSON.stringify(plan) === JSON.stringify(assemble(plan.pointerPlan, plan.deployer, initial)), 'plan_changed');
  const current = await verifyPermanentPointerPlan(plan.pointerPlan, port);
  ensure(current.block.number >= plan.checkpoint.number, 'finality_regressed');
  ensure(initial.states.every((state, index) => state === 'undeployed' || current.states[index] === 'deployed'), 'deployment_regressed');
  const deployed = current.states.every(state => state === 'deployed');
  if (complete) ensure(deployed, 'incomplete');
  ensure(await port.blockHash(plan.checkpoint.number) === plan.checkpoint.hash
    && await port.blockHash(current.block.number) === current.block.hash, 'reorg');
  return { ...current, deployed };
}
export function pointerDeploymentValidator({ plan, port, pin }) {
  plan = structuredClone(plan); pin = structuredClone(pin);
  const stageDigest = digest({ planDigest: plan.digest, steps: plan.steps });
  return async checked => {
    ensure(checked.planDigest === plan.digest && checked.stageDigest === stageDigest
      && JSON.stringify(checked.steps) === JSON.stringify(plan.steps), 'stage_changed');
    return verifyPointerDeployment({ plan, port, pin });
  };
}
export async function advancePointerDeployment({ plan, port, pin, execute, runtime }) {
  const verified = await verifyPointerDeployment({ plan, port, pin });
  if (plan.steps.length === 0) {
    ensure(verified.deployed, 'empty_undeployed_plan');
    return { status: 'confirmed', checkpoint: verified.block, broadcast: false };
  }
  if (!execute) return { status: 'preflight_passed', planDigest: plan.digest, steps: plan.steps.length, broadcast: false };
  ensure(typeof runtime === 'function', 'runtime_missing');
  // Existing on-chain code does not replace the original nonempty journal's
  // signed-byte, nonce and canonical-receipt reconciliation.
  const result = await runtime({ steps: plan.steps, planDigest: plan.digest, assertPlan: pointerDeploymentValidator({ plan, port, pin }) });
  if (result.status !== 'confirmed') return result;
  const final = await verifyPointerDeployment({ plan, port, pin, complete: true });
  return { ...result, checkpoint: final.block, pointer: plan.pointerPlan.pointer, authority: plan.pointerPlan.authority };
}

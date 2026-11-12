import { describe, it, expect } from 'vitest';
import { Interface, ZeroAddress, sha256, toUtf8Bytes } from 'ethers';
import { readSuccessorArtifacts } from './successor-preflight.mjs';
import { preparePredecessorRetirement, verifyPredecessorRetirement, predecessorRetirementValidator } from './predecessor-retirement.mjs';
import { fileURLToPath } from 'node:url';
const artifacts = readSuccessorArtifacts(fileURLToPath(new URL('../..', import.meta.url)));
const a = n => `0x${n.toString(16).padStart(40, '0')}`, h = n => `0x${n.toString(16).padStart(64, '0')}`;
const kernel = a(1), verifier = a(2), admin = a(3), initialMinter = a(4), initialApprover = a(5);
const tokenAbi = new Interface(artifacts.ProvianPVT9.abi), verifierAbi = new Interface(artifacts.ProvianPVT9EligibilityVerifier.abi);
function empty(param) {
  if (param.baseType === 'tuple') return Object.fromEntries(param.components.map(p => [p.name, empty(p)]));
  if (param.baseType === 'array') return [];
  if (param.type === 'address') return ZeroAddress;
  if (param.type === 'bool') return false;
  if (param.type.startsWith('bytes')) return h(0);
  return 0n;
}
function fixture() {
  const policy = empty(tokenAbi.getFunction('getEpochPolicy').outputs[0]);
  policy.eligibilityVerifier = { verifier, configurationId: h(6), version: 1n };
  const state = { height: 100, held: false, minter: initialMinter, verifierHeld: false, approver: initialApprover, reorg: false, logs: [] };
  const deployment = { wiring: { pvt: kernel, admin }, successorKernel:{pvt9Kernel:{block:1}} };
  const port = {
    finalizedBlock: async () => ({ number: state.height, hash: h(state.height) }),
    blockHash: async n => state.reorg && n === 100 ? h(999) : h(n),
    code: async target => artifacts[target === kernel ? 'ProvianPVT9' : 'ProvianPVT9EligibilityVerifier'].deployedBytecode.object,
    logs: async () => state.logs,
    call: async (target, data, pin) => {
      const abi = target === kernel ? tokenAbi : verifierAbi, name = abi.parseTransaction({ data }).name;
      const current = pin !== h(100), values = target === kernel ? {
        BOOTSTRAP_ADMIN: admin, lastOpenedEpoch: 1n, getEpochPolicy: policy,
        administrativeHold: current && state.held, operationalMinter: current ? state.minter : initialMinter,
      } : { BOOTSTRAP_ADMIN: admin, KERNEL: kernel, DEPLOYMENT_CHAIN_ID: 8453n, CONFIGURATION_ID: h(6), CONFIGURATION_VERSION: 1n,
        administrativeHold: current && state.verifierHeld, batchApprover: current ? state.approver : initialApprover };
      if (!(name in values)) throw Error(`unexpected ${name}`);
      return abi.encodeFunctionResult(name, [values[name]]);
    },
  };
  return { deployment, artifacts, port, state };
}
describe('predecessor retirement planning', () => {
  it('derives the exact ordered hold and revocation stage from reviewed live bindings', async () => {
    const f = fixture(), plan = await preparePredecessorRetirement(f);
    expect(plan.steps.map(step => (step.to === kernel ? tokenAbi : verifierAbi).parseTransaction({ data: step.data }).name))
      .toEqual(['placeAdministrativeHold', 'revokeOperationalMinter', 'placeAdministrativeHold', 'revokeBatchApprover']);
    expect(plan.steps.every(step => step.from === admin && step.value === '0')).toBe(true);
    expect((await verifyPredecessorRetirement({ ...f, plan })).retired).toBe(false);
    await expect(verifyPredecessorRetirement({ ...f, plan, complete: true })).rejects.toThrow(/incomplete/);
    Object.assign(f.state, { height: 110, held: true, minter: ZeroAddress, verifierHeld: true, approver: ZeroAddress });
    expect((await verifyPredecessorRetirement({ ...f, plan, complete: true })).retired).toBe(true);
  });
  it.each(['target', 'data', 'signer', 'amount'])('a rehashed %s edit cannot authorize a different operation', async field => {
    const f = fixture(), plan = await preparePredecessorRetirement(f);
    const changed = structuredClone(plan), row = changed.steps[0];
    if (field === 'target') row.to = a(88);
    if (field === 'data') row.data = tokenAbi.encodeFunctionData('resumeFromAdministrativeHold');
    if (field === 'signer') row.from = a(88);
    if (field === 'amount') row.value = '1';
    delete changed.digest; changed.digest = sha256(toUtf8Bytes(JSON.stringify(changed)));
    await expect(verifyPredecessorRetirement({ ...f, plan: changed })).rejects.toThrow(/plan_changed/);
  });
  it('a partially completed stage retains its original transaction sequence and rejects an unrelated stage', async () => {
    const f = fixture(), plan = await preparePredecessorRetirement(f);
    Object.assign(f.state, { height: 110, held: true, minter: ZeroAddress });
    const check = predecessorRetirementValidator({ ...f, plan });
    const checked = { planDigest: plan.digest, steps: plan.steps, stageDigest: sha256(toUtf8Bytes(JSON.stringify({ planDigest: plan.digest, steps: plan.steps }))) };
    await expect(check(checked)).resolves.toMatchObject({ retired: false });
    await expect(check({ ...checked, steps: plan.steps.slice(2) })).rejects.toThrow(/stage_changed/);
  });
  it.each(['kernel-code', 'verifier-code', 'admin', 'kernel-binding', 'configuration', 'chain', 'minter', 'approver', 'reorg'])('%s drift refuses', async mode => {
    const f = fixture(), plan = await preparePredecessorRetirement(f); f.state.height = 110;
    if (mode.endsWith('-code')) { const base = f.port.code; f.port.code = async target => target === (mode === 'kernel-code' ? kernel : verifier) ? '0x6000' : base(target); }
    if (mode === 'minter') f.state.minter = a(88);
    if (mode === 'approver') f.state.approver = a(88);
    if (mode === 'reorg') f.state.reorg = true;
    const original = f.port.call;
    f.port.call = async (target, data, pin) => {
      const abi = target === kernel ? tokenAbi : verifierAbi, name = abi.parseTransaction({ data }).name;
      if (mode === 'admin' && name === 'BOOTSTRAP_ADMIN') return abi.encodeFunctionResult(name, [a(88)]);
      if (mode === 'kernel-binding' && name === 'KERNEL') return abi.encodeFunctionResult(name, [a(88)]);
      if (mode === 'configuration' && name === 'CONFIGURATION_ID') return abi.encodeFunctionResult(name, [h(88)]);
      if (mode === 'chain' && name === 'DEPLOYMENT_CHAIN_ID') return abi.encodeFunctionResult(name, [1]);
      return original(target, data, pin);
    };
    await expect(verifyPredecessorRetirement({ ...f, plan })).rejects.toThrow();
  });
  it.each(['kernel-resume', 'verifier-resume', 'minter-reappointed', 'approver-reappointed'])('intervening %s refuses even when the final state is retired', async mode => {
    const f = fixture(), plan = await preparePredecessorRetirement(f);
    Object.assign(f.state, { height: 110, held: true, minter: ZeroAddress, verifierHeld: true, approver: ZeroAddress });
    const isKernel = mode === 'kernel-resume' || mode === 'minter-reappointed', abi = isKernel ? tokenAbi : verifierAbi;
    const name = mode.endsWith('resume') ? 'AdministrativeHoldResumed' : isKernel ? 'OperationalMinterUpdated' : 'BatchApproverAppointed';
    const args = mode.endsWith('resume') ? isKernel ? [admin] : [] : [ZeroAddress, a(88)];
    f.state.logs.push({ address: isKernel ? kernel : verifier, blockNumber: '0x69', blockHash: h(105), removed: false,
      ...abi.encodeEventLog(abi.getEvent(name), args) });
    await expect(verifyPredecessorRetirement({ ...f, plan, complete: true })).rejects.toThrow(/reactivated/);
  });
});

it('read-only retirement never opens the durable writer; execution confirms only after finalized shutdown', async () => {
  const { advancePredecessorRetirement } = await import('./predecessor-retirement-cli.mjs');
  const f = fixture(), plan = await preparePredecessorRetirement(f); let writes = 0;
  const runtime = async stage => { ++writes;
    await stage.assertPlan({ ...stage, stageDigest: sha256(toUtf8Bytes(JSON.stringify({ planDigest: stage.planDigest, steps: stage.steps }))) });
    Object.assign(f.state, { height: 110, held: true, minter: ZeroAddress, verifierHeld: true, approver: ZeroAddress });
    return { status: 'confirmed' };
  };
  expect(await advancePredecessorRetirement({ ...f, plan, execute: false, runtime })).toMatchObject({ status: 'preflight_passed', broadcast: false });
  expect(writes).toBe(0);
  expect(await advancePredecessorRetirement({ ...f, plan, execute: true, runtime })).toMatchObject({ status: 'confirmed', cutoff: { number: 110, hash: h(110) } });
  expect(writes).toBe(1);
});
it('an incomplete or falsely confirmed retirement stage cannot produce a snapshot cutoff', async () => {
  const { advancePredecessorRetirement } = await import('./predecessor-retirement-cli.mjs');
  const f = fixture(), plan = await preparePredecessorRetirement(f);
  expect(await advancePredecessorRetirement({ ...f, plan, execute: true, runtime: async () => ({ status: 'awaiting_finality' }) }))
    .toEqual({ status: 'awaiting_finality' });
  await expect(advancePredecessorRetirement({ ...f, plan, execute: true, runtime: async () => ({ status: 'confirmed' }) })).rejects.toThrow(/incomplete/);
});
it('a newly prepared already-retired plan is read-only even when execution was requested', async () => {
  const { advancePredecessorRetirement } = await import('./predecessor-retirement-cli.mjs');
  const f = fixture(); Object.assign(f.state, { height: 110, held: true, minter: ZeroAddress, verifierHeld: true, approver: ZeroAddress });
  const plan = await preparePredecessorRetirement(f); expect(plan.steps).toHaveLength(0);
  expect(await advancePredecessorRetirement({ ...f, plan, execute: true, runtime: async () => { throw Error('must not write'); } }))
    .toMatchObject({ status: 'confirmed', broadcast: false });
});
it('retired flags cannot skip receipt reconciliation for a nonempty original journal', async () => {
  const { advancePredecessorRetirement } = await import('./predecessor-retirement-cli.mjs');
  const f = fixture(), plan = await preparePredecessorRetirement(f);
  Object.assign(f.state, { height: 110, held: true, minter: ZeroAddress, verifierHeld: true, approver: ZeroAddress });
  await expect(advancePredecessorRetirement({ ...f, plan, execute: true, runtime: async () => { throw Error('journal refuses stale receipt'); } }))
    .rejects.toThrow('journal refuses stale receipt');
});

it('unsupported future verifier migration is refused before a retirement plan exists',async()=>{
 const f=fixture(),event=tokenAbi.encodeEventLog(tokenAbi.getEvent('EligibilityVerifierScheduled'),[2,a(88),h(89),1]);
 f.state.logs.push({address:kernel,blockNumber:'0x63',blockHash:h(99),removed:false,...event});
 const original=f.port.call;
 f.port.call=async(target,data,pin)=>{
  if(target===kernel&&tokenAbi.parseTransaction({data}).name==='getScheduledEligibilityVerifier')return tokenAbi.encodeFunctionResult('getScheduledEligibilityVerifier',[[true,[a(88),h(89),1]]]);
  return original(target,data,pin);
 };
 await expect(preparePredecessorRetirement(f)).rejects.toThrow('scheduled_verifier_successor_required');
 expect(f.state.held).toBe(false);expect(f.state.verifierHeld).toBe(false);
});

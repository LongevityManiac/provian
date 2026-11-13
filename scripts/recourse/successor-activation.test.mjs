import { beforeEach, expect, test, vi } from 'vitest';
import { Interface, ZeroAddress, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { readFileSync } from 'node:fs';
import { prepareSuccessorActivation, verifySuccessorActivation, successorActivationValidator, advanceSuccessorActivation } from './successor-activation.mjs';
import { assertGasStep, readGasCertificate } from './all-plan-gas.mjs';
const inspect = vi.hoisted(() => vi.fn());
vi.mock('./publication-outcome.mjs', () => ({ inspectPublicationOutcome: inspect }));
const a = n => `0x${n.toString(16).padStart(40, '0')}`, h = n => `0x${n.toString(16).padStart(64, '0')}`;
const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/ProvianRecourseKernel.sol/ProvianRecourseKernel.json', import.meta.url)));
const abi = new Interface(artifact.abi), old = new Interface(['function administrativeHold() view returns(bool)',
  'function operationalMinter() view returns(address)', 'function batchApprover() view returns(address)']);
beforeEach(() => { inspect.mockReset(); });
function fixture() {
  const state = { height: 120, resumedAt: null, logs: [], changed: new Map(), overrides: {}, code: '0x6001', orphan: false };
  const components = Array.from({ length: 10 }, (_, i) => a(30 + i));
  const addresses = { ProvianRecourseKernel: a(30), ProvianRecourseEligibilityVerifier: a(31), ProvianOwnershipRegistry: a(45),
    ProvianMemberRecoursePool: a(38), ProvianRecourseEscrow: a(33), ProvianPromiseV3: a(34), ProvianRecourseProjectPool: a(35),
    ProvianRecourseBondPool: a(36), ProvianRecourseCourt: a(37) };
  const artifacts = Object.fromEntries([...Object.keys(addresses), 'ProvianProtocolPointer', 'ProvianMemberSettlement', 'ProvianPVT9', 'ProvianPVT9EligibilityVerifier'].map(name =>
    [name, JSON.parse(readFileSync(new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url)))]));
  const interfaces = new Map([...Object.entries(addresses), ['ProvianMemberSettlement', a(39)]]
    .map(([name, address]) => [address, new Interface(artifacts[name].abi)]));
  const inputs = { publication: { digest: h(90), componentHashes: [keccak256('0x6001')] },
    successor: { components, addresses, admin: a(1), pointer: a(20), predecessor: a(2), digest: h(91),
      identityAttestor: a(4), batchApprover: a(5), submitter: a(6), snapshot: { state: { eligibilityVerifier: { verifier: a(3) } } } }, artifacts,
    rule: { ruleHash: h(8), rule: { firstMonth: 10, participationBurnAtomic: '100', noEarningsContributionAtomic: '100', earningsBps: 100 } },
    institutions: { inventory: ['escrowV4', 'promiseV3', 'poolV3', 'bondPool', 'courtV2'].map((key, i) => ({ key, address: a(10 + i),
      wiring: [{ method: 'admin', address: a(1) }], policy: [{ method: 'earliestSchedulableEpoch', values: ['1'] }] })) },
    port: { finalizedBlock: async () => ({ number: state.height, hash: h(state.height) }), blockHash: async n => state.changed.get(n) ?? h(n),
      code: async () => state.code,
      call: async (target, data, blockHash) => {
        const height = Number(BigInt(blockHash)), iface = interfaces.get(target) ?? (Number(BigInt(target)) >= 10 ? interfaces.get(a(33)) : old);
        const method = iface.parseTransaction({ data }).name;
        if (method === 'monthlyRule') return iface.encodeFunctionResult(method, [[10, 100, 100, 100, h(8)]]);
        const values = target === a(30) ? { BOOTSTRAP_ADMIN: a(1), restorationAuthority: a(1), operationalMinter: a(39),
          protocolPointer: a(20), epochZeroArmed: true, administrativeHold: state.resumedAt === null || height < state.resumedAt }
          : target === a(2) || target === a(3) ? { administrativeHold: true, operationalMinter: ZeroAddress, batchApprover: ZeroAddress }
            : { KERNEL: a(30), kernel: a(30), BOOTSTRAP_ADMIN: a(1), administrativeHold: false, batchApprover: a(5), pointer: a(20),
              identityAttestor: a(4), submitter: a(6), pool: a(38), token: a(30), registryOperator: a(45), bootstrapAdmin: a(1),
              settlement: a(39), monthlyRuleCount: 1, admin: a(1), earliestSchedulableEpoch: 1 };
        if (state.orphan) state.changed.set(state.height, h(999));
        return iface.encodeFunctionResult(method, [state.overrides[`${target}:${method}`] ?? values[method]]);
      },
      logs: async (target, from, to) => {
        expect(target).toContain(a(30)); expect(from).toBe(112);
        return state.logs.filter(row => target.includes(row.address) && Number(BigInt(row.blockNumber)) <= to);
      } } };
  inspect.mockImplementation(async (_plan, context) => {
    const block = await context.port.finalizedBlock();
    expect(block.number).toBeLessThanOrEqual(state.height);
    return { status: 'achieved', revision: '1', goal: { pointer: a(20), revision: '1' },
      publication: { block: { number: 112, hash: h(112) }, logIndex: 5, transactionHash: h(500), manifestHash: h(600) } };
  });
  const log = (name, args, height = 120, index = 7) => ({ ...abi.encodeEventLog(abi.getEvent(name), args),
    address: a(30), blockNumber: '0x' + height.toString(16), blockHash: h(height), logIndex: '0x' + index.toString(16), removed: false });
  const resume = (height = 130) => { state.height = height; state.resumedAt = height; state.logs.push(log('AdministrativeHoldResumed', [a(1)], height)); };
  return { inputs, state, log, resume, interfaces };
}
test('activation fixes one exact admin call and reconciles its published deployment and monotonic hold history', async () => {
  const f = fixture(), plan = await prepareSuccessorActivation(f.inputs);
  expect(plan.steps).toEqual([{ label: 'activate:resumeFromAdministrativeHold', from: a(1), to: a(30), value: '0',
    data: abi.encodeFunctionData('resumeFromAdministrativeHold') }]);
  expect((await verifySuccessorActivation({ ...f.inputs, plan })).active).toBe(false);
  f.resume(); expect((await verifySuccessorActivation({ ...f.inputs, plan, complete: true })).active).toBe(true);
});
test('the real activation planner stays inside the certified resume family', async () => {
  const f = fixture(), plan = await prepareSuccessorActivation(f.inputs);
  const proof = { certificate: readGasCertificate(), maximum: 16777216n };
  const row = plan.steps[0];
  expect(assertGasStep(row, f.inputs, proof)).toBeGreaterThan(0n);
  const anotherCertifiedCall = abi.encodeFunctionData('appointOperationalMinter', [a(99)]);
  expect(() => assertGasStep({ ...row, data: anotherCertifiedCall }, f.inputs, proof)).toThrow('activation_selector');
  expect(() => assertGasStep({ ...row, label: 'activate:armEpochZero' }, f.inputs, proof)).toThrow();
  expect(() => assertGasStep({ ...row, data: row.data + '00' }, f.inputs, proof)).toThrow();
});
test('owner transfers, burns and supply-neutral reversal token logs remain allowed', async () => {
  const f = fixture();
  f.state.logs.push(f.log('Transfer', [a(40), ZeroAddress, 100], 115, 1), f.log('Burned', [a(40), 100], 115, 2),
    f.log('Transfer', [ZeroAddress, a(41), 100], 115, 3));
  expect((await prepareSuccessorActivation(f.inputs)).steps).toHaveLength(1);
});
test('prepublication configuration logs are excluded by exact log position', async () => {
  const f = fixture(); f.state.logs.push(f.log('OperationalMinterUpdated', [a(50), a(39)], 112, 4));
  expect((await prepareSuccessorActivation(f.inputs)).steps).toHaveLength(1);
  f.state.logs[0].logIndex = '0x6'; await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow(/economy_changed/);
});
test.each(['pointer', 'runtime', 'unarmed', 'minter', 'restoration-authority', 'old-minter', 'old-approver', 'policy', 'held-history', 'reheld', 'event-domain', 'reorg'])('%s red control refuses', async mode => {
  const f = fixture();
  if (mode === 'pointer') inspect.mockResolvedValue({ status: 'superseded', revision: '2' });
  if (mode === 'runtime') f.state.code = '0x6002';
  if (mode === 'unarmed') f.state.overrides[`${a(30)}:epochZeroArmed`] = false;
  if (mode === 'minter') f.state.overrides[`${a(30)}:operationalMinter`] = a(99);
  if (mode === 'restoration-authority') f.state.overrides[`${a(30)}:restorationAuthority`] = a(99);
  if (mode === 'old-minter') f.state.overrides[`${a(2)}:operationalMinter`] = a(99);
  if (mode === 'old-approver') f.state.overrides[`${a(3)}:batchApprover`] = a(99);
  if (mode === 'policy') f.state.logs.push(f.log('MintRateScheduled', [1, 900]));
  if (mode === 'held-history') f.state.resumedAt = 115;
  if (mode === 'reheld') f.state.logs.push(f.log('AdministrativeHoldPlaced', [a(1)], 114, 1), f.log('AdministrativeHoldResumed', [a(1)], 115, 1));
  if (mode === 'event-domain') { f.state.logs.push(f.log('Approval', [a(40), a(41), 100])); f.state.logs[0].removed = true; }
  if (mode === 'reorg') f.state.orphan = true;
  await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow();
});
test('rehashing a changed executable call does not replace independent reconstruction', async () => {
  const f = fixture(), plan = await prepareSuccessorActivation(f.inputs); plan.steps[0].data = '0x1234'; delete plan.digest;
  plan.digest = sha256(toUtf8Bytes(JSON.stringify(plan)));
  await expect(verifySuccessorActivation({ ...f.inputs, plan })).rejects.toThrow(/plan_changed/);
});
test('stage validator refuses substituted steps even with the correct plan digest', async () => {
  const f = fixture(), plan = await prepareSuccessorActivation(f.inputs), validator = successorActivationValidator({ ...f.inputs, plan });
  const stageDigest = sha256(toUtf8Bytes(JSON.stringify({ planDigest: plan.digest, steps: plan.steps })));
  await validator({ planDigest: plan.digest, stageDigest, steps: plan.steps });
  await expect(validator({ planDigest: plan.digest, stageDigest, steps: [] })).rejects.toThrow(/stage_changed/);
});
test('empty already-active plans do not invoke a signer runtime; nonempty restarts still reconcile it', async () => {
  const f = fixture(), plan = await prepareSuccessorActivation(f.inputs); f.resume();
  const runtime = vi.fn(async () => ({ status: 'confirmed' }));
  expect((await advanceSuccessorActivation({ ...f.inputs, plan, execute: false, runtime })).status).toBe('preflight_passed');
  expect(runtime).not.toHaveBeenCalled();
  expect((await advanceSuccessorActivation({ ...f.inputs, plan, execute: true, runtime })).status).toBe('confirmed');
  expect(runtime).toHaveBeenCalledOnce();
  const active = await prepareSuccessorActivation(f.inputs); expect(active.steps).toHaveLength(0); runtime.mockClear();
  expect((await advanceSuccessorActivation({ ...f.inputs, plan: active, execute: true, runtime })).status).toBe('confirmed');
  expect(runtime).not.toHaveBeenCalled();
});
test('postpublication verifier changes refuse even if the kernel itself is unchanged', async () => {
  const f = fixture(); f.state.overrides[`${a(31)}:batchApprover`] = a(99);
  await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow(/component_binding_changed/);
  delete f.state.overrides[`${a(31)}:batchApprover`];
  f.state.logs.push({ ...f.log('Approval', [a(1), a(2), 1]), address: a(31),
    ...f.interfaces.get(a(31)).encodeEventLog('BatchApproverAppointed', [a(5), a(99)]) });
  await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow(/component_policy_changed/);
});
test('postpublication membership rules and institutional wiring cannot silently change', async () => {
  const f = fixture(); f.state.overrides[`${a(38)}:monthlyRuleCount`] = 2;
  await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow(/component_binding_changed/);
  delete f.state.overrides[`${a(38)}:monthlyRuleCount`]; f.state.overrides[`${a(33)}:admin`] = a(99);
  await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow(/institution_wiring_changed/);
});
test('old verifier reactivation cannot hide behind restored endpoint flags', async () => {
  const f = fixture(); f.state.logs.push({ ...f.log('Approval', [a(1), a(2), 1]), address: a(3),
    ...new Interface(f.inputs.artifacts.ProvianPVT9EligibilityVerifier.abi).encodeEventLog('AdministrativeHoldResumed', []) });
  await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow(/predecessor_activity/);
});
test('old-token issuance after publication cannot hide behind re-held endpoints', async () => {
  const f = fixture(); f.state.logs.push({ ...f.log('Transfer', [ZeroAddress, a(40), 100]), address: a(2) });
  await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow(/predecessor_activity/);
});
test('institution policy events refuse even if getters have returned to their expected values', async () => {
  const f = fixture(); f.state.logs.push({ ...f.log('Approval', [a(1), a(2), 1]), address: a(33),
    ...f.interfaces.get(a(33)).encodeEventLog('FeeBpsScheduled', [1, 500]) });
  await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow(/component_policy_changed/);
});
test('legitimate postpublication member consent logs remain allowed', async () => {
  const f = fixture(), iface = f.interfaces.get(a(38)), fragment = iface.getEvent('AddressBound');
  f.state.logs.push({ ...f.log('Approval', [a(1), a(2), 1]), address: a(38), ...iface.encodeEventLog(fragment, [h(55), a(55)]) });
  expect((await prepareSuccessorActivation(f.inputs)).steps).toHaveLength(1);
});
test('lost activation completion survives later and same-block economy changes', async () => {
  const f = fixture(), plan = await prepareSuccessorActivation(f.inputs); f.resume();
  f.state.logs.push(f.log('MintRateScheduled', [1, 900], 130, 8), f.log('AdministrativeHoldPlaced', [a(1)], 131, 1));
  f.state.height = 140;
  const call = f.inputs.port.call;
  f.inputs.port.call = async (target, data, hash) => {
    if (Number(BigInt(hash)) >= 130) throw Error('post_activation_getter_must_not_be_used');
    return call(target, data, hash);
  };
  const before = inspect.getMockImplementation();
  inspect.mockImplementation(async (publication, context) => {
    if ((await context.port.finalizedBlock()).number > plan.checkpoint.number) throw Error('post_activation_pointer_must_not_be_used');
    return before(publication, context);
  });
  expect((await verifySuccessorActivation({ ...f.inputs, plan, complete: true })).active).toBe(true);
  f.state.logs.push(f.log('MintRateScheduled', [1, 900], 130, 6));
  await expect(verifySuccessorActivation({ ...f.inputs, plan, complete: true })).rejects.toThrow(/economy_changed/);
});

test('adjacent activation cannot overwrite the authenticated publication hash', async () => {
  const f = fixture(); f.resume(113);
  const originalCall = f.inputs.port.call;
  f.inputs.port.call = (target, data, pin) => originalCall(target, data, pin === h(999) ? h(112) : pin);
  const originalHash = f.inputs.port.blockHash;
  f.inputs.port.blockHash = async number => number === 112 ? h(999) : originalHash(number);
  await expect(prepareSuccessorActivation(f.inputs)).rejects.toThrow(/reorg/);
});
test('publication and activation in the same block retain the exact log boundary', async () => {
  const f = fixture(); f.resume(112);
  const plan = await prepareSuccessorActivation(f.inputs);
  expect(plan.steps).toHaveLength(0);
  expect((await verifySuccessorActivation({ ...f.inputs, plan, complete: true })).active).toBe(true);
});

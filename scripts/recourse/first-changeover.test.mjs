import { beforeEach, expect, test, vi } from 'vitest';
import { keccak256, sha256, toUtf8Bytes } from 'ethers';
import { advanceFirstChangeover } from './first-changeover.mjs';
const checks = vi.hoisted(() => Object.fromEntries(['retirePrepare', 'retireVerify', 'retireValidator', 'pointerPrepare', 'pointerVerify', 'pointerValidator',
  'snapshot', 'institutions', 'runtimeHash', 'locations', 'build', 'preflight', 'interval', 'verify', 'steps', 'deployValidator', 'progress',
  'activationPrepare', 'activationVerify', 'activationValidator', 'prepareGas', 'validateGas', 'gasStep'].map(name => [name, vi.fn()])));
vi.mock('./all-plan-gas.mjs', () => ({prepareAllPlanGas: checks.prepareGas, validateGasCertificate: checks.validateGas, assertGasStep: checks.gasStep}));
vi.mock('./predecessor-retirement.mjs', () => ({ preparePredecessorRetirement: checks.retirePrepare, verifyPredecessorRetirement: checks.retireVerify, predecessorRetirementValidator: checks.retireValidator }));
vi.mock('./pointer-deployment.mjs', () => ({ preparePointerDeployment: checks.pointerPrepare, verifyPointerDeployment: checks.pointerVerify, pointerDeploymentValidator: checks.pointerValidator }));
vi.mock('./snapshot.mjs', () => ({ buildSuccessionSnapshot: checks.snapshot }));
vi.mock('./institution-snapshot.mjs', () => ({ buildInstitutionSnapshot: checks.institutions, verifyInstitutionRuntime: checks.runtimeHash,
  LEGACY_INSTITUTIONS: { escrowV4: 'escrow', promiseV3: 'promises', poolV3: 'pool', bondPool: 'bond', courtV2: 'court' } }));
vi.mock('./successor-plan.mjs', () => ({ successorLocations: checks.locations, buildSuccessorPlan: checks.build }));
vi.mock('./successor-preflight.mjs', () => ({ preflightSuccessorPlan: checks.preflight, verifySuccessorSourceInterval: checks.interval }));
vi.mock('./successor-verification.mjs', () => ({ verifySuccessorPlan: checks.verify }));
vi.mock('./successor-deploy-cli.mjs', () => ({ successorDeploymentSteps: checks.steps, successorDeploymentValidator: checks.deployValidator }));
vi.mock('./publication-recovery.mjs', () => ({ readPublicationProgress: checks.progress }));
vi.mock('./successor-activation.mjs', () => ({ prepareSuccessorActivation: checks.activationPrepare,
  verifySuccessorActivation: checks.activationVerify, successorActivationValidator: checks.activationValidator }));
const a = n => `0x${n.toString(16).padStart(40, '0')}`, h = n => `0x${n.toString(16).padStart(64, '0')}`;
const digest = value => sha256(toUtf8Bytes(JSON.stringify(value)));
beforeEach(() => { for (const fn of Object.values(checks)) fn.mockReset(); });
function fixture() {
  const files = new Map(), state = { height: 100, done: {}, actions: [], calls: [], pause: null, lose: null, reorg: null };
  const row = n => ({ from: a(1), to: a(n), value: '0', data: '0x1234' });
  const plans = { retirement: { digest: h(1), state: {verifier:a(3)}, steps: [row(2)] }, pointer: { digest: h(2), steps: [row(20)] },
    successor: { digest: h(3) }, activation: { digest: h(4), steps: [row(30)] } };
  const inventory = { inventory: ['escrowV4', 'promiseV3', 'poolV3', 'bondPool', 'courtV2'].map((key, i) => ({ key, address: a(10 + i) })) };
  const institutions = { ...inventory, digest: digest(inventory) }; plans.successor.institutionDigest = institutions.digest;
  const store = { read: async name => structuredClone(files.get(name) ?? null), create: async (name, value) => {
    if (files.has(name) && JSON.stringify(files.get(name)) !== JSON.stringify(value)) throw Error('conflicting_record');
    files.set(name, structuredClone(value)); return structuredClone(value);
  } };
  const request = vi.fn(async (method, params) => {
    expect(method).toBe('eth_getTransactionCount'); expect(params[0]).toBe(a(4)); return '0x7';
  });
  const port = { finalizedBlock: async () => ({ number: state.height, hash: h(state.height) }),
    blockHash: async number => state.reorg === number ? h(999) : h(number), code: async () => '0x6001',
    rpcs: ['one', 'two'].map(operatorId => ({ operatorId, request })) };
  const inputs = { deployment: { wiring: { pvt: a(2), admin: a(1) }, successorKernel: { pvt9Kernel: { block: 1 } },
    contracts: Object.fromEntries(inventory.inventory.map(item => [item.key, { address: item.address }])) },
    artifacts: { ProvianPVT9: { bytecode: { object: '0x6001' }, deployedBytecode: { object: '0x6001' }, abi: [] } },
    pointerPlan: { fixed: true }, pin: { address: a(20) }, rule: { signed: true }, legacyTokens: [a(9)],
    deployer: a(4), identityAttestor: a(5), batchApprover: a(6), submitter: a(7), importBatchSize: 128, callGas: '2000000', port };
  checks.prepareGas.mockResolvedValue({certificateDigest:h(90)});
  checks.validateGas.mockReturnValue({maximum:16777216n});
  const verify = phase => async input => {
    if (input.complete && !state.done[phase]) throw Error('phase_incomplete');
    const block = await input.port.finalizedBlock(); return { block, verifiedAt: block, active: Boolean(state.done[phase]) };
  };
  for (const [name, phase] of [['retirePrepare', 'retirement'], ['pointerPrepare', 'pointer'], ['activationPrepare', 'activation']])
    checks[name].mockImplementation(async () => { if (phase === 'activation') expect(state.done.publication).toBe(true); return structuredClone(plans[phase]); });
  checks.retireVerify.mockImplementation(verify('retirement')); checks.pointerVerify.mockImplementation(verify('pointer'));
  checks.activationVerify.mockImplementation(verify('activation'));
  for (const name of ['retireValidator', 'pointerValidator', 'deployValidator', 'activationValidator']) checks[name].mockImplementation(input => async supplied => {
    expect(supplied.planDigest).toBe(input.plan.digest); await input.port.finalizedBlock();
  });
  checks.snapshot.mockImplementation(async input => {
    expect(state.done.retirement).toBe(true); expect(state.done.pointer).toBe(true); expect(input.block).toBe(120);
    return { snapshot: true };
  });
  checks.institutions.mockResolvedValue(institutions); checks.runtimeHash.mockReturnValue(keccak256('0x6001'));
  checks.locations.mockReturnValue({ destinations: {} }); checks.build.mockReturnValue(plans.successor);
  checks.steps.mockReturnValue([row(30), row(31)]); checks.interval.mockResolvedValue(undefined);
  checks.preflight.mockImplementation(verify('successor'));
  checks.verify.mockImplementation(async input => { expect(state.done.successor).toBe(true); return { block: input.block }; });
  const baseline = { digest: h(8), stage: 'retire' };
  checks.progress.mockImplementation(async input => {
    expect(state.done.publication).toBe(true); return { baseline, outcome: { publication: { transactionHash: h(9) }, revision: '1', checkpoint: await input.port.finalizedBlock() } };
  });
  const finish = (phase, requireCompleted) => {
    state.calls.push({ phase, requireCompleted });
    if (requireCompleted && !state.done[phase]) throw Error('journal_not_completed');
    if (state.pause === phase) return { status: 'awaiting_finality' };
    if (!state.done[phase]) { state.done[phase] = true; state.actions.push(phase); state.height += 10; }
    if (state.lose === phase) { state.lose = null; throw Error('completion_reply_lost'); }
    return { status: 'confirmed' };
  };
  const runtime = vi.fn(async (stage, context) => {
    await stage.assertPlan(stage); return finish(context.phase, context.requireCompleted);
  });
  const publish = vi.fn(async (_input, context) => finish('publication', context.requireCompleted));
  const run = (execute = true) => advanceFirstChangeover({ inputs, state: store, execute, runtime, publish, authorityStore: {} });
  return { files, state, inputs, plans, run, runtime, publish, store };
}
test('orders retirement, permanent pointer, frozen snapshot/imports, publication and activation in one delivery', async () => {
  const f = fixture(), result = await f.run();
  expect(result).toMatchObject({ status: 'confirmed', phase: 'complete', checkpoint: { number: 150, hash: h(150) } });
  expect(f.state.actions).toEqual(['retirement', 'pointer', 'successor', 'publication', 'activation']);
  expect(f.files.get('successor-bundle').operators.nonce).toBe(7); expect(checks.snapshot).toHaveBeenCalledOnce();
  expect(f.files.has('activation-complete')).toBe(true);
});
test('inspection prepares immutable review plans but executes no stage', async () => {
  const f = fixture(); expect(await f.run(false)).toMatchObject({ status: 'preflight_passed', phase: 'retirement', broadcast: false });
  expect(f.state.actions).toHaveLength(0); expect(f.runtime).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  expect(f.files.has('retirement-plan')).toBe(true); expect(f.files.has('pointer-plan')).toBe(true); expect(checks.snapshot).not.toHaveBeenCalled();
});
test('restarts authenticate terminal phases at saved checkpoints without signing or re-snapshotting', async () => {
  const f = fixture(); await f.run(); f.state.height = 200; f.state.calls = [];
  expect((await f.run()).checkpoint.number).toBe(150);
  expect(f.state.calls).toEqual(['retirement', 'pointer', 'successor', 'publication', 'activation'].map(phase => ({ phase, requireCompleted: true })));
  expect(f.state.actions).toHaveLength(5); expect(checks.snapshot).toHaveBeenCalledOnce();
});
test.each(['retirement', 'pointer', 'successor', 'publication', 'activation'])('lost %s completion response resumes its exact plan', async phase => {
  const f = fixture(); f.state.lose = phase;
  await expect(f.run()).rejects.toThrow(/completion_reply_lost/);
  const saved = structuredClone(f.files.get('successor-bundle') ?? null);
  expect((await f.run()).status).toBe('confirmed');
  expect(f.state.actions).toEqual(['retirement', 'pointer', 'successor', 'publication', 'activation']);
  if (saved) expect(f.files.get('successor-bundle')).toEqual(saved);
});
test('unfinalized stages never start a later stage', async () => {
  const f = fixture(); f.state.pause = 'successor';
  expect(await f.run()).toMatchObject({ status: 'awaiting_finality', phase: 'successor' });
  expect(f.state.actions).toEqual(['retirement', 'pointer']); expect(f.publish).not.toHaveBeenCalled();
  f.state.pause = null; expect((await f.run()).status).toBe('confirmed');
});
test.each(['configuration', 'checkpoint', 'digest', 'journal', 'inventory'])('%s corruption refuses without new signing', async mode => {
  const f = fixture(); await f.run(); const count = f.state.actions.length;
  if (mode === 'configuration') f.inputs.submitter = a(99);
  if (mode === 'checkpoint') f.state.reorg = 110;
  if (mode === 'digest') f.files.get('retirement-complete').planDigest = h(999);
  if (mode === 'journal') f.state.done.retirement = false;
  if (mode === 'inventory') f.files.get('successor-bundle').institutions.inventory[0].address = a(99);
  await expect(f.run()).rejects.toThrow(); expect(f.state.actions.length).toBe(count);
});

test('successor completion must retain the same checkpoint that passed unused-pointer preflight', async () => {
  const f = fixture(); const preflight=checks.preflight.getMockImplementation(); let advanced=false;
  checks.preflight.mockImplementation(async input => {
    const result=await preflight(input);
    if (f.state.done.successor && !advanced) { advanced=true; f.state.height++; }
    return result;
  });
  await f.run();
  expect(f.files.get('successor-complete').checkpoint).toEqual({number:130,hash:h(130)});
});

test.each(['uncovered_family','artifact_changed','source_changed','transaction_gas_budget'])('gas %s refusal occurs before retirement', async reason => {
  const f=fixture(); checks.prepareGas.mockRejectedValue(Error('all_plan_gas_'+reason));
  await expect(f.run()).rejects.toThrow(reason);
  expect(f.runtime).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
  expect(f.state.actions).toEqual([]); expect(checks.snapshot).not.toHaveBeenCalled();
});
test('gas certificate drift on restart refuses new signing', async () => {
  const f=fixture(); await f.run(); const before=f.runtime.mock.calls.length;
  checks.prepareGas.mockResolvedValue({certificateDigest:h(91)});
  await expect(f.run()).rejects.toThrow('conflicting_record');
  expect(f.runtime.mock.calls.length).toBe(before);
});

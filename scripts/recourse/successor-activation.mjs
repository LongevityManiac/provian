import { Interface, ZeroAddress, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { inspectPublicationOutcome } from './publication-outcome.mjs';
const ensure = (value, reason) => { if (!value) throw Error('successor_activation_' + reason); };
const digest = value => sha256(toUtf8Bytes(JSON.stringify(value)));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lower = value => String(value).toLowerCase();
const copyInputs = inputs => { const { port, ...facts } = inputs; return { ...structuredClone(facts), port }; };
const institutionNames = { escrowV4: 'ProvianRecourseEscrow', promiseV3: 'ProvianPromiseV3', poolV3: 'ProvianRecourseProjectPool',
  bondPool: 'ProvianRecourseBondPool', courtV2: 'ProvianRecourseCourt' };

async function readActivationState(publication, inputs, block) {
  const { successor, artifacts, port } = inputs, kernel = successor.components[0];
  const outcome = await inspectPublicationOutcome(publication, { ...inputs, port: { ...port, finalizedBlock: async () => block } });
  ensure(outcome.status === 'achieved' && outcome.revision === '1' && outcome.publication, 'publication_not_current');
  ensure(keccak256(await port.code(kernel, block.hash)) === publication.componentHashes[0], 'kernel_runtime_changed');
  const abi = new Interface(artifacts.ProvianRecourseKernel.abi);
  const read = async (target, iface, method) => iface.decodeFunctionResult(method,
    await port.call(target, iface.encodeFunctionData(method), block.hash))[0];
  for (const [method, expected] of [['BOOTSTRAP_ADMIN', successor.admin], ['restorationAuthority', successor.admin],
    ['operationalMinter', successor.components[9]], ['protocolPointer', successor.pointer]])
    ensure(lower(await read(kernel, abi, method)) === lower(expected), 'binding_changed');
  ensure(await read(kernel, abi, 'epochZeroArmed') === true, 'unarmed');
  const held = await read(kernel, abi, 'administrativeHold');
  ensure(typeof held === 'boolean', 'hold_invalid');
  const old = new Interface(['function administrativeHold() view returns(bool)', 'function operationalMinter() view returns(address)',
    'function batchApprover() view returns(address)']);
  for (const [target, method, expected] of [[successor.predecessor, 'administrativeHold', true],
    [successor.predecessor, 'operationalMinter', ZeroAddress],
    [successor.snapshot.state.eligibilityVerifier.verifier, 'administrativeHold', true],
    [successor.snapshot.state.eligibilityVerifier.verifier, 'batchApprover', ZeroAddress]])
    ensure(lower(await read(target, old, method)) === lower(expected), 'predecessor_reactivated');
  const named = { ...successor.addresses, ProvianMemberSettlement: successor.components[9] };
  const bindings = {
    ProvianOwnershipRegistry: { pointer: successor.pointer, identityAttestor: successor.identityAttestor },
    ProvianRecourseEligibilityVerifier: { KERNEL: kernel, BOOTSTRAP_ADMIN: successor.admin, batchApprover: successor.batchApprover, administrativeHold: false },
    ProvianMemberSettlement: { kernel, pointer: successor.pointer, submitter: successor.submitter, pool: successor.components[8] },
    ProvianMemberRecoursePool: { token: kernel, pointer: successor.pointer, registryOperator: named.ProvianOwnershipRegistry,
      bootstrapAdmin: successor.admin, settlement: successor.components[9], monthlyRuleCount: 1 },
  };
  for (const [name, expected] of Object.entries(bindings)) for (const [method, value] of Object.entries(expected))
    ensure(lower(await read(named[name], new Interface(artifacts[name].abi), method)) === lower(value), 'component_binding_changed');
  const pool = new Interface(artifacts.ProvianMemberRecoursePool.abi);
  const monthly = pool.decodeFunctionResult('monthlyRule', await port.call(named.ProvianMemberRecoursePool,
    pool.encodeFunctionData('monthlyRule', [0]), block.hash))[0], rule = inputs.rule;
  ensure(String(monthly.firstMonth) === String(rule.rule.firstMonth) && String(monthly.participationBurn) === rule.rule.participationBurnAtomic
    && String(monthly.noEarningsContribution) === rule.rule.noEarningsContributionAtomic
    && Number(monthly.earningsBps) === rule.rule.earningsBps && monthly.signedRuleHash === rule.ruleHash, 'membership_rule_changed');
  ensure(inputs.institutions.inventory.length === Object.keys(institutionNames).length, 'institution_inventory');
  const replacements = new Map([[lower(successor.predecessor), kernel], ...inputs.institutions.inventory
    .map(row => [lower(row.address), named[institutionNames[row.key]]])]);
  for (const row of inputs.institutions.inventory) {
    const name = institutionNames[row.key], target = named[name], iface = new Interface(artifacts[name].abi);
    for (const wiring of row.wiring) ensure(lower(await read(target, iface, wiring.method))
      === lower(replacements.get(lower(wiring.address)) ?? wiring.address), 'institution_wiring_changed');
    for (const policy of row.policy) {
      const data = iface.encodeFunctionData(policy.method), result = await port.call(target, data, block.hash);
      if (policy.method === 'earliestSchedulableEpoch') ensure(result === await port.call(row.address, data, block.hash), 'institution_epoch_changed');
      else ensure(equal(iface.decodeFunctionResult(policy.method, result).toArray().map(value => typeof value === 'bigint' ? value.toString() : value), policy.values),
        'institution_policy_changed');
    }
  }

  // The first activation follows the reconciled publication without scheduling
  // or minting a different economy in the gap. Transfers, burns and owner-proof
  // reversals remain available; their token logs cannot hide a settlement or a
  // policy event. Completed workflows verify this interval at their saved
  // activation checkpoint, rather than rejecting later normal network activity.
  const published = outcome.publication, pins = new Map([[block.number, block.hash], [published.block.number, published.block.hash]]);
  const interfaces = new Map(Object.entries(named).filter(([name]) => artifacts[name]).map(([name, address]) => [lower(address), new Interface(artifacts[name].abi)]));
  interfaces.set(lower(kernel), abi);
  interfaces.set(lower(successor.predecessor), new Interface(artifacts.ProvianPVT9.abi));
  interfaces.set(lower(successor.snapshot.state.eligibilityVerifier.verifier), new Interface(artifacts.ProvianPVT9EligibilityVerifier.abi));
  for (const row of inputs.institutions.inventory) interfaces.set(lower(row.address), new Interface(artifacts[institutionNames[row.key]].abi));
  const source = new Set([lower(successor.predecessor), lower(successor.snapshot.state.eligibilityVerifier.verifier), ...inputs.institutions.inventory.map(row => lower(row.address))]);
  let resumes = 0;
  const seen = new Set();
  for (const log of await port.logs([...interfaces.keys()], published.block.number, block.number)) {
    const height = Number(BigInt(log.blockNumber)), index = Number(BigInt(log.logIndex)), key = `${height}:${index}`;
    const target = lower(log.address), iface = interfaces.get(target);
    ensure(iface && !log.removed && Number.isSafeInteger(height) && Number.isSafeInteger(index)
      && index >= 0 && height >= published.block.number && height <= block.number
      && /^0x[0-9a-f]{64}$/.test(log.blockHash) && !seen.has(key), 'event_invalid');
    seen.add(key); ensure(!pins.has(height) || pins.get(height) === log.blockHash, 'reorg'); pins.set(height, log.blockHash);
    if (height === published.block.number && index <= published.logIndex) continue;
    const event = iface.parseLog(log); ensure(event, 'unknown_event');
    if (source.has(target)) {
      ensure(target === lower(successor.predecessor) && ['Transfer', 'Approval', 'Burned'].includes(event.name)
        && (event.name !== 'Transfer' || event.args.from !== ZeroAddress), 'predecessor_activity');
      continue;
    }
    if (target !== lower(kernel)) {
      ensure(!event.name.endsWith('Scheduled') && !['AdminTransferred', 'CourtContractSet', 'ExecutorWired', 'BondPoolSet',
        'BatchApproverAppointed', 'BatchApproverRevoked', 'AdministrativeHoldPlaced', 'AdministrativeHoldResumed'].includes(event.name), 'component_policy_changed');
      continue;
    }
    if (event.name === 'AdministrativeHoldResumed') {
      ensure(lower(event.args.administrator) === successor.admin && ++resumes === 1, 'resume_changed');
    } else ensure(['Transfer', 'Approval', 'Burned'].includes(event.name), 'economy_changed');
  }
  ensure(resumes === (held ? 0 : 1), 'hold_history_changed');
  for (const [number, hash] of pins) ensure(await port.blockHash(number) === hash, 'reorg');
  return { held, kernel, admin: successor.admin, publication: published, goal: outcome.goal };
}
function assemble(state, block, publication, inputs) {
  const abi = new Interface(inputs.artifacts.ProvianRecourseKernel.abi);
  const steps = state.held ? [{ label: 'activate:resumeFromAdministrativeHold', from: state.admin,
    to: state.kernel, value: '0', data: abi.encodeFunctionData('resumeFromAdministrativeHold') }] : [];
  const body = { schema: 'provian.successor-activation.v1', checkpoint: block, publicationDigest: publication.digest,
    successorDigest: inputs.successor.digest, state, steps };
  return { ...body, digest: digest(body) };
}
export async function prepareSuccessorActivation({ publication, ...inputs }) {
  publication = structuredClone(publication); inputs = copyInputs(inputs);
  const block = await inputs.port.finalizedBlock();
  return assemble(await readActivationState(publication, inputs, block), block, publication, inputs);
}
export async function verifySuccessorActivation({ plan, publication, complete = false, ...inputs }) {
  plan = structuredClone(plan); publication = structuredClone(publication); inputs = copyInputs(inputs);
  ensure(plan?.schema === 'provian.successor-activation.v1', 'plan_invalid');
  const original = await readActivationState(publication, inputs, plan.checkpoint);
  ensure(equal(plan, assemble(original, plan.checkpoint, publication, inputs)), 'plan_changed');
  const block = await inputs.port.finalizedBlock(); ensure(block.number >= plan.checkpoint.number, 'finality_regressed');
  const current = await readActivationState(publication, inputs, block);
  ensure(plan.state.held || !current.held, 'hold_reintroduced');
  if (complete) ensure(!current.held, 'incomplete');
  ensure(await inputs.port.blockHash(plan.checkpoint.number) === plan.checkpoint.hash
    && await inputs.port.blockHash(block.number) === block.hash, 'reorg');
  return { active: !current.held, block, goal: current.goal };
}
export function successorActivationValidator({ plan, ...inputs }) {
  plan = structuredClone(plan); inputs = copyInputs(inputs);
  const stageDigest = digest({ planDigest: plan.digest, steps: plan.steps });
  return async checked => {
    ensure(checked.planDigest === plan.digest && checked.stageDigest === stageDigest && equal(checked.steps, plan.steps), 'stage_changed');
    return verifySuccessorActivation({ plan, ...inputs });
  };
}
export async function advanceSuccessorActivation({ plan, execute, runtime, ...inputs }) {
  const verified = await verifySuccessorActivation({ plan, ...inputs });
  if (!plan.steps.length) { ensure(verified.active, 'empty_held_plan'); return { status: 'confirmed', checkpoint: verified.block, broadcast: false }; }
  if (!execute) return { status: 'preflight_passed', planDigest: plan.digest, steps: plan.steps.length, broadcast: false };
  ensure(typeof runtime === 'function', 'runtime_missing');
  const result = await runtime({ steps: plan.steps, planDigest: plan.digest, assertPlan: successorActivationValidator({ plan, ...inputs }) });
  if (result.status !== 'confirmed') return result;
  const final = await verifySuccessorActivation({ plan, ...inputs, complete: true });
  return { ...result, checkpoint: final.block, goal: final.goal };
}

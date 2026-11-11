import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Interface, keccak256, ZeroAddress, zeroPadValue } from 'ethers';
import { buildSuccessionSnapshot } from './snapshot.mjs';
import { buildInstitutionSnapshot, LEGACY_INSTITUTIONS, verifyInstitutionRuntime } from './institution-snapshot.mjs';
import { buildSuccessorPlan, successorLocations, SUCCESSOR_CREATION_ORDER } from './successor-plan.mjs';
import { permanentPointerPlan, verifyPermanentPointerPlan } from './permanent-pointer-plan.mjs';

const ensure = (value, reason) => { if (!value) throw Error(`successor_preflight_${reason}`); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function readSuccessorArtifacts(root) {
  const names = [...new Set([...SUCCESSOR_CREATION_ORDER, ...Object.values(LEGACY_INSTITUTIONS),
    'ProvianHashAccount', 'ProvianProtocolPointer', 'ProvianMemberSettlement', 'ProvianPVT9', 'ProvianPVT9EligibilityVerifier'])];
  return Object.fromEntries(names.map(name => {
    const artifact = JSON.parse(readFileSync(resolve(root, `contracts/out/${name}.sol/${name}.json`), 'utf8'));
    const sources = Object.entries(artifact.metadata?.sources ?? {});
    ensure(sources.length > 0 && Array.isArray(artifact.abi) && artifact.abi.length > 0, 'artifact_incomplete');
    ensure(/^0x[0-9a-f]+$/i.test(artifact.bytecode?.object) && /^0x[0-9a-f]+$/i.test(artifact.deployedBytecode?.object), 'artifact_incomplete');
    ensure(Object.keys(artifact.bytecode.linkReferences ?? {}).length === 0
      && Object.keys(artifact.deployedBytecode.linkReferences ?? {}).length === 0, 'artifact_unlinked');
    for (const [path, source] of sources) {
      const absolute = resolve(root, 'contracts', path);
      ensure(absolute.startsWith(resolve(root, 'contracts') + '/'), 'artifact_source_path');
      ensure(keccak256(readFileSync(absolute)) === source.keccak256, 'artifact_stale');
    }
    return [name, artifact];
  }));
}

/** Compare the entire executable plan against independently rebuilt facts.
 * Rehashing an edited amount, destination or authority cannot authorize it. */
export function assertFreshSuccessorPlan(plan, facts) {
  const expected = buildSuccessorPlan(facts);
  ensure(equal(plan, expected), 'plan_changed');
  ensure(expected.snapshot.balances.length > 0 && expected.snapshot.history.length > 0, 'empty_population');
  return expected;
}

/** A token cutoff cannot also authorize a changed issuance policy or changed
 * institution liabilities. Retired-token transfers/approvals/burns continue to
 * exist, but neither a temporary reactivation nor fresh custody may be hidden
 * by checking only the source's final hold flag. */
export async function verifySuccessorSourceInterval({ plan, deployment, artifacts, port, current }) {
  const kernel = new Interface(artifacts.ProvianPVT9.abi);
  const institutions = Object.keys(LEGACY_INSTITUTIONS).map(key => deployment.contracts[key].address.toLowerCase());
  const verifier = plan.snapshot.state.eligibilityVerifier.verifier.toLowerCase();
  const sources = [plan.predecessor, verifier, ...institutions];
  const token = new Interface(['function balanceOf(address) view returns(uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
  if (current.number > plan.cutoff.number) {
    const rows = await port.logs(sources, plan.cutoff.number + 1, current.number);
    for (const row of rows) {
      ensure(!row.removed && BigInt(row.blockNumber) > BigInt(plan.cutoff.number)
        && BigInt(row.blockNumber) <= BigInt(current.number)
        && sources.includes(row.address.toLowerCase()), 'interval_log_invalid');
      ensure(row.address.toLowerCase() === plan.predecessor, 'source_activity_after_cutoff');
      const event = kernel.parseLog(row);
      ensure(event && ['Transfer', 'Approval', 'Burned'].includes(event.name)
        && (event.name !== 'Transfer' || event.args.from !== ZeroAddress), 'source_activity_after_cutoff');
    }
    const incoming = await port.logs(deployment.wiring.usdc, plan.cutoff.number + 1, current.number,
      [token.getEvent('Transfer').topicHash, null, institutions.map(address => zeroPadValue(address, 32))]);
    ensure(incoming.length === 0, 'new_usdc_custody');
  }
  const verifierAbi = new Interface(['function administrativeHold() view returns(bool)', 'function batchApprover() view returns(address)']);
  for (const [method, expected] of [['administrativeHold', true], ['batchApprover', ZeroAddress]]) {
    ensure(verifierAbi.decodeFunctionResult(method, await port.call(verifier,
      verifierAbi.encodeFunctionData(method), current.hash))[0] === expected, 'verifier_reactivated');
  }
  for (const address of institutions) ensure(token.decodeFunctionResult('balanceOf', await port.call(deployment.wiring.usdc,
    token.encodeFunctionData('balanceOf', [address]), current.hash))[0] === 0n, 'new_usdc_custody');
}

/** Reconstruct executable bytes from independent cutoff facts and operator inputs.
 * This does not require an unused pointer authority: retirement registration
 * rotates that authority before publication. Callers separately authenticate
 * the pointer's current runtime, revision and authority state. */
export async function reconstructSuccessorPlan({ plan, pointerPlan, verifiedRule, operators, deployment, artifacts, port }) {
  plan = structuredClone(plan); pointerPlan = structuredClone(pointerPlan); verifiedRule = structuredClone(verifiedRule);
  operators = structuredClone(operators); deployment = structuredClone(deployment);
  ensure(plan.schema === 'provian.successor-plan.v1' && plan.chainId === 8453
    && Number.isSafeInteger(plan.cutoff?.number) && plan.cutoff.number > 0
    && /^0x[0-9a-f]{64}$/.test(plan.cutoff.hash), 'plan_invalid');
  ensure(equal(pointerPlan, permanentPointerPlan(pointerPlan.initialRoot)), 'pointer_changed');
  ensure(plan.pointer === pointerPlan.pointer && plan.pointerAuthority === pointerPlan.authority
    && verifiedRule.rule.pointer === plan.pointer, 'pointer_changed');
  ensure(plan.predecessor.toLowerCase() === deployment.wiring.pvt.toLowerCase(), 'predecessor_changed');
  ensure(operators && Object.keys(operators).sort().join(',') === 'batchApprover,deployer,identityAttestor,nonce,submitter', 'operators_required');
  for (const key of Object.keys(operators)) ensure(plan[key] === operators[key], 'operators_changed');
  const finalized = await port.finalizedBlock();
  ensure(finalized.number >= plan.cutoff.number && await port.blockHash(plan.cutoff.number) === plan.cutoff.hash, 'cutoff_unfinalized');
  const predecessor = artifacts.ProvianPVT9;
  const snapshot = await buildSuccessionSnapshot({ port, kernelAbi: predecessor.abi,
    predecessor: deployment.wiring.pvt, deploymentBlock: deployment.successorKernel.pvt9Kernel.block,
    block: plan.cutoff.number, blockHash: plan.cutoff.hash,
    expectedRuntimeHash: verifyInstitutionRuntime(predecessor, await port.code(deployment.wiring.pvt, plan.cutoff.hash)),
    destinations: successorLocations(deployment, operators.deployer, operators.nonce).destinations,
    institutions: Object.keys(LEGACY_INSTITUTIONS).map(key => deployment.contracts[key].address) });
  const institutions = await buildInstitutionSnapshot({ port, deployment, artifacts,
    block: plan.cutoff.number, blockHash: plan.cutoff.hash });
  const rebuilt = assertFreshSuccessorPlan(plan, { snapshot, institutions, deployment, artifacts, pointerPlan, rule: verifiedRule,
    ...operators });
  ensure(await port.blockHash(plan.cutoff.number) === plan.cutoff.hash
    && await port.blockHash(finalized.number) === finalized.hash, 'reorg');
  return { plan: rebuilt, institutions, verifiedAt: finalized };
}

/** Read-only first-changeover preflight. The caller must verify the membership
 * signature with the pinned public approval key before supplying verifiedRule.
 * It grants no signer lease, reads no private key and broadcasts nothing. */
export async function preflightSuccessorPlan(inputs) {
  const { pointerPlan, deployment, artifacts, port } = inputs;
  const { plan, institutions, verifiedAt: finalized } = await reconstructSuccessorPlan(inputs);
  const rebuilt = plan, snapshot = plan.snapshot, predecessor = artifacts.ProvianPVT9;
  await verifyPermanentPointerPlan(pointerPlan, port);
  const pointerAbi = new Interface(['function revision() view returns(uint256)']);
  // The source must still be retired now, not merely at the historical cutoff.
  const current = await port.finalizedBlock(), kernel = new Interface(predecessor.abi);
  ensure(current.number >= finalized.number, 'finality_regressed');
  const read = async method => kernel.decodeFunctionResult(method, await port.call(plan.predecessor,
    kernel.encodeFunctionData(method), current.hash))[0];
  ensure(await read('administrativeHold') === true
    && /^0x0{40}$/i.test(await read('operationalMinter')), 'predecessor_reactivated');
  await verifySuccessorSourceInterval({ plan: rebuilt, deployment, artifacts, port, current });
  if (await port.code(plan.pointer, current.hash) !== '0x') ensure(pointerAbi.decodeFunctionResult('revision',
    await port.call(plan.pointer, pointerAbi.encodeFunctionData('revision'), current.hash))[0] === 0n, 'already_published');
  ensure(await port.blockHash(plan.cutoff.number) === plan.cutoff.hash
    && await port.blockHash(current.number) === current.hash, 'reorg');
  return { plan: rebuilt, institutions, verifiedAt: current, facts: { holders: snapshot.balances.length,
    historyEntries: snapshot.history.length, institutions: institutions.inventory.length,
    creations: rebuilt.creations.length, importCalls: rebuilt.imports.length }, broadcast: false };
}

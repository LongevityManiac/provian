import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress, sha256, toUtf8Bytes } from 'ethers';
import { successorFixture } from './successor-plan.test.mjs';
import { buildSuccessorPlan, remapSuccessionBalances, successorLocations } from './successor-plan.mjs';
import { permanentPointerPlan, POINTER_CREATE2_FACTORY_CODE } from './permanent-pointer-plan.mjs';
import { preflightSuccessorPlan, readSuccessorArtifacts } from './successor-preflight.mjs';

// Exporter suites exercise complete log/receipt/state reconstruction. These
// controlled ports isolate orchestration, including failures before/after it.
const reconstruction = vi.hoisted(() => ({ snapshot: vi.fn(), institutions: vi.fn() }));
vi.mock('./snapshot.mjs', async original => ({ ...await original(), buildSuccessionSnapshot: reconstruction.snapshot }));
vi.mock('./institution-snapshot.mjs', async original => ({ ...await original(), buildInstitutionSnapshot: reconstruction.institutions }));
const hash = n => '0x' + n.toString(16).padStart(64, '0');
function fixture() {
  const facts = successorFixture();
  facts.artifacts = readSuccessorArtifacts(new URL('../..', import.meta.url).pathname);
  facts.pointerPlan = permanentPointerPlan(hash(333));
  facts.rule.rule.pointer = facts.pointerPlan.pointer;
  facts.rule.ruleHash = sha256(toUtf8Bytes('Provian Recourse Pool membership rule\n' + JSON.stringify(facts.rule.rule) + '\n'));
  facts.deployment.successorKernel = { pvt9Kernel: { block: 1 } };
  const plan = buildSuccessorPlan(facts);
  const operators = Object.fromEntries(['deployer', 'nonce', 'identityAttestor', 'submitter', 'batchApprover'].map(key => [key, facts[key]]));
  const state = { hold: true, minter: ZeroAddress, verifierHold: true, approver: ZeroAddress, usdc: 0n, sourceLogs: [], incoming: [], published: false, stale: false, reorg: false, reads: 0 };
  const kernel = new Interface(facts.artifacts.ProvianPVT9.abi);
  const verifier = new Interface(['function administrativeHold() view returns(bool)', 'function batchApprover() view returns(address)']);
  const token = new Interface(['function balanceOf(address) view returns(uint256)']);
  const pointer = new Interface(['function revision() view returns(uint256)']);
  const port = {
    finalizedBlock: async () => { ++state.reads; return { number: state.stale ? 19 : 21, hash: hash(21) }; },
    blockHash: async n => state.reorg && state.reads >= 3 ? hash(99) : hash(n),
    code: async address => address === facts.deployment.wiring.pvt ? facts.artifacts.ProvianPVT9.deployedBytecode.object
      : address === facts.pointerPlan.factory ? POINTER_CREATE2_FACTORY_CODE
      : address === facts.pointerPlan.pointer && state.published && state.reads >= 3 ? '0x6000' : '0x',
    logs: async (addresses, from, to, topics) => {
      assert.equal(from, 21); assert.equal(to, 21);
      if (Array.isArray(addresses)) return state.sourceLogs;
      assert.equal(addresses, facts.deployment.wiring.usdc);
      assert.equal(topics[2].length, 5);
      return state.incoming;
    },
    call: async (address, data, pin) => {
      assert.equal(pin, hash(21));
      if (address === facts.snapshot.state.eligibilityVerifier.verifier) {
        const method = verifier.parseTransaction({ data }).name;
        return verifier.encodeFunctionResult(method, [method === 'administrativeHold' ? state.verifierHold : state.approver]);
      }
      if (address === facts.deployment.wiring.usdc) return token.encodeFunctionResult('balanceOf', [state.usdc]);
      if (address === plan.pointer) return pointer.encodeFunctionResult('revision', [1]);
      assert.equal(address, plan.predecessor);
      const method = kernel.parseTransaction({ data }).name;
      assert.ok(['administrativeHold', 'operationalMinter'].includes(method));
      return kernel.encodeFunctionResult(method, [method === 'administrativeHold' ? state.hold : state.minter]);
    },
  };
  reconstruction.snapshot.mockReset().mockImplementation(async input => {
    assert.equal(input.block, 20); assert.equal(input.blockHash, hash(20));
    assert.equal(input.predecessor, facts.deployment.wiring.pvt);
    assert.deepEqual(input.institutions, Object.values(facts.deployment.contracts).map(value => value.address));
    assert.deepEqual(input.destinations, successorLocations(facts.deployment, operators.deployer, operators.nonce).destinations);
    return remapSuccessionBalances(facts.snapshot, input.destinations);
  });
  reconstruction.institutions.mockReset().mockImplementation(async input => {
    assert.equal(input.block, 20); assert.equal(input.blockHash, hash(20));
    assert.deepEqual(input.deployment, facts.deployment);
    return facts.institutions;
  });
  return { kernel, input: { plan, pointerPlan: facts.pointerPlan, verifiedRule: facts.rule,
    operators, deployment: facts.deployment, artifacts: facts.artifacts, port }, state };
}
test('preflight reconstructs custody destinations and every call, then returns a read-only result', async () => {
  const f = fixture(), result = await preflightSuccessorPlan(f.input);
  assert.equal(result.broadcast, false);
  assert.deepEqual(result.plan, f.input.plan);
  assert.deepEqual(result.facts, { holders: 2, historyEntries: 1, institutions: 5, creations: 12, importCalls: 3 });
  assert.equal(reconstruction.snapshot.mock.calls.length, 1);
  assert.equal(reconstruction.institutions.mock.calls.length, 1);
  assert.equal(f.state.reads, 3);
});
test('unfinalized cutoff, separate operator substitution and pointer alteration refuse before reconstruction', async () => {
  for (const alter of [
    f => { f.state.stale = true; },
    f => { f.input.operators.submitter = f.input.plan.admin; },
    f => { delete f.input.operators; },
    f => { f.input.pointerPlan.pointer = f.input.plan.admin; },
  ]) {
    const f = fixture(); alter(f);
    await assert.rejects(preflightSuccessorPlan(f.input), /successor_preflight_/);
    assert.equal(reconstruction.snapshot.mock.calls.length, 0);
  }
});
test('predecessor reactivation, competing publication, reorg and changed executable plan refuse after reconstruction', async () => {
  for (const alter of [
    f => { f.state.hold = false; },
    f => { f.state.minter = f.input.plan.admin; },
    f => { f.state.published = true; },
    f => { f.state.reorg = true; },
    f => { f.input.plan.activation.value = '1'; },
  ]) {
    const f = fixture(); alter(f);
    await assert.rejects(preflightSuccessorPlan(f.input), /successor_preflight_/);
    assert.equal(reconstruction.snapshot.mock.calls.length, 1);
    assert.equal(reconstruction.institutions.mock.calls.length, 1);
  }
});

test('temporary source changes and new USDC custody refuse even with zero final balances and retired flags', async () => {
  const mutations = [
    f => { f.state.verifierHold = false; },
    f => { f.state.approver = f.input.plan.admin; },
    f => { f.state.usdc = 1n; },
    f => { f.state.incoming = [{ historical: 'incoming then outgoing, final balance zero' }]; },
    f => { f.state.sourceLogs = [{ address: f.input.plan.snapshot.state.eligibilityVerifier.verifier, blockNumber: '0x15' }]; },
    f => { f.state.sourceLogs = [{ address: f.input.deployment.contracts.bondPool.address, blockNumber: '0x15' }]; },
    ...[['AdministrativeHoldResumed', f => [f.input.plan.admin]],
      ['OperationalMinterUpdated', f => [ZeroAddress, f.input.plan.admin]],
      ['Transfer', f => [ZeroAddress, f.input.plan.admin, 1n]]].map(([name, args]) => f => {
        f.state.sourceLogs = [{ ...f.kernel.encodeEventLog(f.kernel.getEvent(name), args(f)),
          address: f.input.plan.predecessor, blockNumber: '0x15' }];
      }),
  ];
  for (const change of mutations) {
    const f = fixture(); change(f);
    await assert.rejects(preflightSuccessorPlan(f.input), /successor_preflight_/);
  }
  const f = fixture();
  f.state.sourceLogs = [{ ...f.kernel.encodeEventLog(f.kernel.getEvent('Transfer'),
    [f.input.plan.admin, f.input.plan.deployer, 1n]), address: f.input.plan.predecessor, blockNumber: '0x15' }];
  assert.equal((await preflightSuccessorPlan(f.input)).broadcast, false);
});

import { test, expect, vi, beforeEach } from 'vitest';
import { sha256, toUtf8Bytes } from 'ethers';
import { successorFixture } from './successor-plan.test.mjs';
import { buildSuccessorPlan } from './successor-plan.mjs';
import { permanentPointerPlan } from './permanent-pointer-plan.mjs';
import { reconstructSuccessorPlan } from './successor-preflight.mjs';
const readers = vi.hoisted(() => ({ snapshot: vi.fn(), institutions: vi.fn() }));
vi.mock('./snapshot.mjs', async original => ({ ...await original(), buildSuccessionSnapshot: readers.snapshot }));
vi.mock('./institution-snapshot.mjs', async original => ({ ...await original(), buildInstitutionSnapshot: readers.institutions }));
const digest = object => sha256(toUtf8Bytes(JSON.stringify(object)));
beforeEach(() => { readers.snapshot.mockReset(); readers.institutions.mockReset(); });
function fixture() {
  const facts = successorFixture();
  facts.pointerPlan = permanentPointerPlan('0x' + '11'.repeat(32));
  facts.rule.rule.pointer = facts.pointerPlan.pointer;
  facts.rule.ruleHash = sha256(toUtf8Bytes('Provian Recourse Pool membership rule\n' + JSON.stringify(facts.rule.rule) + '\n'));
  facts.artifacts.ProvianPVT9 = facts.artifacts.ProvianRecourseKernel;
  facts.deployment.successorKernel = { pvt9Kernel: { block: 1 } };
  const plan = buildSuccessorPlan(facts), operators = Object.fromEntries(['deployer', 'nonce', 'identityAttestor', 'submitter', 'batchApprover'].map(key => [key, facts[key]]));
  const finalized = { number: 30, hash: '0x' + '30'.repeat(32) };
  const port = { finalizedBlock: vi.fn(async () => finalized), blockHash: vi.fn(async n => n === 20 ? facts.snapshot.blockHash : finalized.hash),
    // Reconstruction must not enforce a fresh authority nonce/root. Those
    // rotate when registering retirement before this same plan is published.
    call: vi.fn(async () => { throw Error('unexpected_authority_read'); }) };
  readers.snapshot.mockImplementation(async input => {
    expect(input.predecessor).toBe(facts.deployment.wiring.pvt);
    expect(input.block).toBe(20); expect(input.blockHash).toBe(facts.snapshot.blockHash);
    expect(input.deploymentBlock).toBe(1); expect(input.institutions).toHaveLength(5);
    return structuredClone(facts.snapshot);
  });
  readers.institutions.mockImplementation(async input => {
    expect(input.block).toBe(20); expect(input.deployment).toEqual(facts.deployment);
    return structuredClone(facts.institutions);
  });
  return { plan, pointerPlan: facts.pointerPlan, verifiedRule: facts.rule, operators, deployment: facts.deployment, artifacts: facts.artifacts, port, facts };
}
test('canonical reconstruction reads independent cutoff facts without requiring an unused authority', async () => {
  const f = fixture(), rebuilt = await reconstructSuccessorPlan(f);
  expect(rebuilt.plan).toEqual(f.plan); expect(rebuilt.institutions).toEqual(f.facts.institutions);
  expect(readers.snapshot).toHaveBeenCalledOnce(); expect(readers.institutions).toHaveBeenCalledOnce();
  expect(f.port.call).not.toHaveBeenCalled();
});
test.each(['component', 'retirement', 'address', 'balance', 'history', 'rule', 'operator'])('rehashed %s substitution is refused by independent reconstruction', async mode => {
  const f = fixture();
  if (mode === 'component') f.plan.components[0] = f.plan.pointerAuthority;
  if (mode === 'retirement') f.plan.retireAfterImport.push(f.plan.pointerAuthority);
  if (mode === 'address') f.plan.addresses.ProvianRecourseKernel = f.plan.pointerAuthority;
  if (mode === 'balance') f.plan.snapshot.balances[0].amount = '701';
  if (mode === 'history') f.plan.snapshot.history.pop();
  if (mode === 'rule') f.plan.ruleHash = '0x' + 'ff'.repeat(32);
  if (mode === 'operator') f.plan.submitter = f.plan.admin;
  delete f.plan.digest; f.plan.digest = digest(f.plan);
  await expect(reconstructSuccessorPlan(f)).rejects.toThrow(/plan_changed|operators_changed/);
});
test('cutoff reorganization during reconstruction invalidates its independent facts', async () => {
  const f = fixture(); let reads = 0;
  f.port.blockHash.mockImplementation(async n => n === 20 && ++reads > 1 ? '0x' + 'ff'.repeat(32) : n === 20 ? f.plan.cutoff.hash : '0x' + '30'.repeat(32));
  await expect(reconstructSuccessorPlan(f)).rejects.toThrow(/reorg/);
});

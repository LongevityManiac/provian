import { beforeEach, expect, test, vi } from 'vitest';
import { Interface, keccak256 } from 'ethers';
import { readPublicationProgress, readPublicationHistory, publicationOperationSlot } from './publication-recovery.mjs';
const checks = vi.hoisted(() => ({ plan: vi.fn(), outcome: vi.fn(), verify: vi.fn() }));
vi.mock('./pointer-publication.mjs', () => ({ preparePointerPublication: checks.plan }));
vi.mock('./publication-outcome.mjs', () => ({ inspectPublicationOutcome: checks.outcome,
  publicationGoal: (_plan, inputs) => ({ pointer: inputs.pin.address, authority: inputs.successor.pointerAuthority, revision: '1', componentsDigest: '0x' + '44'.repeat(32) }) }));
vi.mock('./hash-authority-durable.mjs', () => ({ verifyDurableHashAuthority: checks.verify }));
const a = n => `0x${n.toString(16).padStart(40, '0')}`, h = n => `0x${n.toString(16).padStart(64, '0')}`;
const abi = new Interface(['function nonce() view returns(uint256)', 'function keyCommitment() view returns(bytes32)',
  'function registerLegacyRetirements(address[],bytes32[])', 'function publish(uint256,address[10],bytes32[10])']);
beforeEach(() => { for (const check of Object.values(checks)) check.mockReset(); });
function fixture() {
  const state = { nonce: 2n, root: h(102), height: 120, changed: new Map(), calls: [], code: '0x6001', outcomeHeight: 121 };
  const rows = new Map(), plans = [];
  for (let index = 0; index < 3; index++) {
    const operation = { account: a(21), nonce: String(index), signingRoot: h(100 + index), nextCommitment: h(101 + index),
      target: a(20), callGas: '2000000', data: abi.encodeFunctionData(index === 0 ? 'registerLegacyRetirements' : 'publish',
        index === 0 ? [[a(1)], [h(1)]] : [0, Array.from({ length: 10 }, (_, i) => a(i + 30)), Array(10).fill(h(5))]) };
    const plan = { stage: index === 0 ? 'retire' : 'publish', hashAuthorityPlan: {
      account: operation.account, nonce: operation.nonce, currentRoot: operation.signingRoot, data: operation.data } };
    plans.push(plan);
    rows.set(publicationOperationSlot(a(21), index), { operation, verifiedBlock: { number: 110 + index, hash: h(110 + index) },
      nextItemId: 'saved-' + index, transaction: { to: a(21), data: '0xabcd' + index.toString(16).padStart(2, '0') } });
  }
  const inputs = { successor: { pointerAuthority: a(21) }, pointerPlan: { initialRoot: h(100) }, pin: { address: a(20) },
    artifacts: { ProvianHashAccount: { deployedBytecode: { object: '0x6001' } } }, callGas: '2000000',
    port: { finalizedBlock: async () => ({ number: state.height, hash: h(state.height) }), blockHash: async n => state.changed.get(n) ?? h(n),
      code: async () => state.code,
      call: async (address, data, checkpoint) => {
        expect(address).toBe(a(21)); const method = abi.parseTransaction({ data }).name; state.calls.push({ method, checkpoint });
        return abi.encodeFunctionResult(method, [method === 'nonce' ? state.nonce : state.root]);
      } } };
  checks.plan.mockImplementation(async input => {
    const block = await input.port.finalizedBlock(), index = block.number - 110;
    expect(input.stage).toBe(index === 0 ? 'retire' : 'publish'); expect(input.callGas).toBe('2000000');
    return structuredClone(plans[index]);
  });
  checks.verify.mockImplementation(async (record, plan, runtimeHash) => {
    expect(plan).toEqual(plans[Number(record.operation.nonce)].hashAuthorityPlan); expect(runtimeHash).toBe(keccak256('0x6001'));
    return structuredClone(record);
  });
  checks.outcome.mockImplementation(async plan => {
    expect(plan).toEqual(plans[0]); return { status: 'achieved', checkpoint: { number: state.outcomeHeight, hash: h(state.outcomeHeight) } };
  });
  const store = { read: vi.fn(async slot => structuredClone(rows.get(slot) ?? null)) };
  return { state, rows, plans, inputs, store, run: () => readPublicationProgress(inputs, store) };
}
test('reconstructs every consumed and unspent proof at its own canonical checkpoint without a vault', async () => {
  const f = fixture(), result = await f.run();
  expect(result.records).toHaveLength(3); expect(result.nonce).toBe('2'); expect(result.root).toBe(h(102));
  expect(result.current.record.operation.nonce).toBe('2'); expect(checks.verify).toHaveBeenCalledTimes(3);
  expect(f.state.calls.filter(row => row.checkpoint === h(121))).toHaveLength(2);
});
test('a crash after proof exposure but before any sponsor reservation still recovers consumed lineage', async () => {
  const f = fixture(); f.rows.delete(publicationOperationSlot(a(21), 2));
  const result = await f.run(); expect(result.records).toHaveLength(2); expect(result.current).toBeNull();
});
test.each(['missing', 'wrong-root', 'lineage', 'target', 'nonce', 'future', 'reconstruction', 'proof', 'code', 'superseded'])('%s negative control refuses', async mode => {
  const f = fixture(), saved = f.rows.get(publicationOperationSlot(a(21), 1));
  if (mode === 'missing') f.rows.delete(publicationOperationSlot(a(21), 1));
  if (mode === 'wrong-root') f.state.root = h(999);
  if (mode === 'lineage') saved.operation.signingRoot = h(999);
  if (mode === 'target') saved.operation.target = a(99);
  if (mode === 'nonce') saved.operation.nonce = '9';
  if (mode === 'future') saved.verifiedBlock = { number: 150, hash: h(150) };
  if (mode === 'reconstruction') checks.plan.mockRejectedValue(Error('plan_not_independently_reconstructed'));
  if (mode === 'proof') checks.verify.mockRejectedValue(Error('signature_invalid'));
  if (mode === 'code') f.state.code = '0x6002';
  if (mode === 'superseded') checks.outcome.mockResolvedValue({ status: 'superseded', checkpoint: { number: 121, hash: h(121) } });
  await expect(f.run()).rejects.toThrow();
});
test.each([110, 111, 112, 120, 121])('late reorg of checkpoint %s refuses after all verification awaits', async height => {
  const f = fixture(), base = f.inputs.port.call;
  f.inputs.port.call = async (...args) => {
    const result = await base(...args); if (args[2] === h(121)) f.state.changed.set(height, h(999)); return result;
  };
  await expect(f.run()).rejects.toThrow(/checkpoint_changed/);
});
test('authority advancement during semantic observation requires a fresh complete reconciliation', async () => {
  const f = fixture(), base = checks.outcome.getMockImplementation();
  checks.outcome.mockImplementation(async (...args) => { const result = await base(...args); f.state.nonce = 3n; return result; });
  await expect(f.run()).rejects.toThrow(/authority_advanced/);
});
test('a retained cancellation is authenticated and must preserve the original saved next seed', async () => {
  const f = fixture(), original = f.rows.get(publicationOperationSlot(a(21), 0)), cancel = structuredClone(original);
  cancel.operation.target = a(21); cancel.operation.data = '0x';
  f.rows.set(publicationOperationSlot(a(21), 0, true), cancel);
  const verify = checks.verify.getMockImplementation();
  checks.verify.mockImplementation(async (record, plan, runtime) => {
    if (record.operation.target !== a(21)) return verify(record, plan, runtime);
    expect(plan).toMatchObject({ target: a(21), data: '0x', callGas: '100000', value: '0', targetRuntimeHash: keccak256('0x6001') });
    return structuredClone(record);
  });
  expect((await f.run()).records[0].cancellation).toEqual(cancel);
  cancel.nextItemId = 'other'; await expect(f.run()).rejects.toThrow(/cancellation_successor_changed/);
});
test('historical recovery permits only authenticated cleanup material despite unknown current root and changed source', async () => {
  const f = fixture(); f.state.root = h(999); checks.outcome.mockRejectedValue(Error('source_changed'));
  const history = await readPublicationHistory(f.inputs, f.store);
  expect(history.records).toHaveLength(3); expect(checks.outcome).not.toHaveBeenCalled();
  expect(f.state.calls).toHaveLength(0);
  checks.verify.mockRejectedValue(Error('signature_invalid'));
  await expect(readPublicationHistory(f.inputs, f.store)).rejects.toThrow(/signature_invalid/);
});
test('historical recovery rechecks earlier pins after later records were read', async () => {
  const f = fixture(), original = f.store.read.getMockImplementation();
  f.store.read.mockImplementation(async slot => {
    const result = await original(slot); if (slot === publicationOperationSlot(a(21), 3)) f.state.changed.set(110, h(999)); return result;
  });
  await expect(readPublicationHistory(f.inputs, f.store)).rejects.toThrow(/checkpoint_changed/);
});

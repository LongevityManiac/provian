import { test, expect, vi, beforeEach } from 'vitest';
import { keccak256, zeroPadValue, toBeHex } from 'ethers';
import { HASH_ACCOUNT_ABI } from '../../provian-agent-sdk/dist/hash-account.js';
import { inspectDurableHashAuthority } from './hash-authority-inspection.mjs';
const checked = vi.hoisted(() => vi.fn());
// Real local signature validation is covered by hash-authority-durable tests;
// this suite isolates canonical chain evidence and outcome classification.
vi.mock('./hash-authority-durable.mjs', () => ({ verifyDurableHashAuthority: checked }));
const a = n => '0x' + n.toString(16).padStart(40, '0'), h = n => '0x' + n.toString(16).padStart(64, '0');
beforeEach(() => { checked.mockReset(); checked.mockImplementation(async record => structuredClone(record)); });
function fixture() {
  const plan = { account: a(1), target: a(2), nonce: '3', currentRoot: h(3), targetRuntimeHash: keccak256('0x6000') }, runtime = keccak256('0x6000');
  const record = { verifiedBlock: { number: 100, hash: h(100) }, operation: { nextCommitment: h(4) }, transaction: { data: '0x1234' } };
  const state = { nonce: 3n, root: h(3), success: true, target: a(2), wrapped: false, changedInput: false, orphan: -1, missing: false };
  const port = { finalizedBlock: async () => ({ number: 110, hash: h(110) }), blockHash: vi.fn(async n => n === state.orphan ? h(999) : h(n)),
    code: vi.fn(async () => '0x6000'), call: async (_target, data, pin) => {
      expect(pin).toBe(h(110)); const name = HASH_ACCOUNT_ABI.parseTransaction({ data }).name;
      return HASH_ACCOUNT_ABI.encodeFunctionResult(name, [name === 'nonce' ? state.nonce : state.root]);
    },
    logs: vi.fn(async (target, from, to, topics) => {
      expect(target).toBe(plan.account); expect(from).toBe(101); expect(to).toBe(110);
      expect(topics).toEqual([HASH_ACCOUNT_ABI.getEvent('Executed').topicHash, zeroPadValue(toBeHex(3), 32)]);
      return state.missing ? [] : [{ address: plan.account, blockNumber: '0x69', blockHash: h(105), transactionHash: h(500), removed: false,
        ...HASH_ACCOUNT_ABI.encodeEventLog(HASH_ACCOUNT_ABI.getEvent('Executed'), [3, state.target, state.success]) }];
    }),
    transaction: vi.fn(async hash => { expect(hash).toBe(h(500)); return { hash, blockHash: h(105), to: state.wrapped ? a(99) : plan.account,
      input: state.changedInput ? '0xabcd' : record.transaction.data }; }) };
  const execute = (success = true) => { state.nonce = 4n; state.root = h(4); state.success = success; };
  return { plan, record, port, state, execute, accountRuntimeHash: runtime };
}
test('unspent authority is read-only and does not infer absence of pending gas transactions', async () => {
  const f = fixture(), result = await inspectDurableHashAuthority(f);
  expect(result.state).toBe('unspent'); expect(result.execution).toBeNull();
  expect(f.port.logs).not.toHaveBeenCalled(); expect(f.port.transaction).not.toHaveBeenCalled(); expect(checked).toHaveBeenCalledOnce();
});
test.each([true, false])('exact direct sponsorship authenticates inner success=%s independently of the gas sender', async success => {
  const f = fixture(); f.execute(success);
  const result = await inspectDurableHashAuthority(f);
  expect(result.state).toBe(success ? 'succeeded' : 'target_failed');
  expect(result.authorityNonce).toBe('4'); expect(result.authorityRoot).toBe(h(4));
  expect(result.execution).toMatchObject({ transactionHash: h(500), exactDirectCall: true, success });
});
test('later authority operations do not erase an exact historical execution', async () => {
  const f = fixture(); f.execute(); f.state.nonce = 6n; f.state.root = h(6);
  expect((await inspectDurableHashAuthority(f)).state).toBe('succeeded');
});
test.each(['wrapper', 'calldata', 'target'])('%s cannot turn an Executed event into exact-operation success', async mode => {
  const f = fixture(); f.execute();
  if (mode === 'wrapper') f.state.wrapped = true;
  if (mode === 'calldata') f.state.changedInput = true;
  if (mode === 'target') f.state.target = a(99);
  const result = await inspectDurableHashAuthority(f);
  expect(result.state).toBe('consumed_other'); expect(result.execution.exactDirectCall).toBe(false);
});
test.each(['missing', 'root', 'runtime', 'target-runtime', 'transaction', 'removed', 'duplicate', 'wrong-nonce', 'original-reorg', 'execution-reorg', 'final-reorg'])('%s refuses outcome certification', async mode => {
  const f = fixture(); f.execute();
  if (mode === 'missing') f.state.missing = true;
  if (mode === 'root') f.state.root = h(99);
  if (mode === 'runtime') f.port.code.mockResolvedValue('0x6001');
  if (mode === 'target-runtime') f.port.code.mockImplementation(async target => target === f.plan.target ? '0x6001' : '0x6000');
  if (['removed', 'duplicate', 'wrong-nonce'].includes(mode)) {
    const logs = f.port.logs.getMockImplementation();
    f.port.logs.mockImplementation(async (...args) => {
      const rows = await logs(...args);
      if (mode === 'removed') rows[0].removed = true;
      if (mode === 'duplicate') rows.push(rows[0]);
      if (mode === 'wrong-nonce') Object.assign(rows[0], HASH_ACCOUNT_ABI.encodeEventLog(HASH_ACCOUNT_ABI.getEvent('Executed'), [4, f.plan.target, true]));
      return rows;
    });
  }
  if (mode === 'transaction') f.port.transaction.mockResolvedValue({ hash: h(500), blockHash: h(99), to: f.plan.account, input: f.record.transaction.data });
  if (mode.endsWith('reorg')) f.state.orphan = mode === 'original-reorg' ? 100 : mode === 'execution-reorg' ? 105 : 110;
  await expect(inspectDurableHashAuthority(f)).rejects.toThrow();
});
test('local proof refusal precedes all chain inspection', async () => {
  const f = fixture(); checked.mockRejectedValue(Error('signature_invalid'));
  await expect(inspectDurableHashAuthority(f)).rejects.toThrow(/signature_invalid/);
  expect(f.port.code).not.toHaveBeenCalled();
});

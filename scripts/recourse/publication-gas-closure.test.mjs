import { test, expect, beforeAll } from 'vitest';
import { Wallet, keccak256 } from 'ethers';
import { inspectPublicationGasClosure, validatePublicationGasVariants } from './publication-gas-closure.mjs';
const sponsor = new Wallet('0x' + '11'.repeat(32)), other = new Wallet('0x' + '22'.repeat(32));
const from = sponsor.address.toLowerCase(), to = other.address.toLowerCase(), h = n => '0x' + n.toString(16).padStart(64, '0');
const base = { type: 2, chainId: 8453, nonce: 7, value: 0, gasLimit: 100000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 };
let call, cancel;
beforeAll(async () => {
  const raw = await sponsor.signTransaction({ ...base, to, data: '0x1234' }); call = { kind: 'call', raw, hash: keccak256(raw) };
  const cancelRaw = await sponsor.signTransaction({ ...base, to: from, data: '0x' }); cancel = { kind: 'cancel', raw: cancelRaw, hash: keccak256(cancelRaw) };
});
function fixture() {
  const input = { from, nonce: 7, authorityTransaction: { to, data: '0x1234' }, variants: [call, cancel] };
  const state = { count: ['0x7', '0x7'], orphan: -1, chain: '0x2105' };
  const port = { finalizedBlock: async () => ({ number: 100, hash: h(100) }), blockHash: async n => n === state.orphan ? h(999) : h(n),
    rpcs: ['first', 'second'].map((operatorId, index) => ({ operatorId, request: async (method, params) => {
      if (method === 'eth_chainId') return state.chain;
      expect(method).toBe('eth_getTransactionCount'); expect(params).toEqual([from, '0x64']); return state.count[index];
    } })) };
  return { input, port, state };
}
test('signed original and gas cancellation remain open until their nonce is consumed at the shared finalized block', async () => {
  const f = fixture(); expect((await inspectPublicationGasClosure(f.input, f.port)).status).toBe('open');
  f.state.count = ['0x8', '0x8'];
  expect(await inspectPublicationGasClosure(f.input, f.port)).toMatchObject({ status: 'consumed', finalizedNonce: '8', retainedHashes: [call.hash, cancel.hash] });
});
test.each(['disagreement', 'wrong-chain', 'same-operator', 'current-reorg', 'prior-reorg'])('%s refuses gas closure', async mode => {
  const f = fixture(); f.state.count = ['0x8', '0x8'];
  if (mode === 'disagreement') f.state.count[1] = '0x7';
  if (mode === 'wrong-chain') f.state.chain = '0x1';
  if (mode === 'same-operator') f.port.rpcs[1].operatorId = f.port.rpcs[0].operatorId;
  if (mode === 'current-reorg') f.state.orphan = 100;
  if (mode === 'prior-reorg') f.state.orphan = 90;
  await expect(inspectPublicationGasClosure(f.input, f.port, { number: 90, hash: h(90) })).rejects.toThrow();
});
test.each(['sender', 'nonce', 'value', 'chain', 'call', 'cancel'])('retained %s substitution cannot release another gas reservation', async mode => {
  const f = fixture();
  const transaction = { ...base, to, data: '0x1234', ...(mode === 'nonce' ? { nonce: 8 } : mode === 'value' ? { value: 1 } : mode === 'chain' ? { chainId: 1 } : mode === 'call' ? { data: '0x5678' } : {}) };
  const raw = await (mode === 'sender' ? other : sponsor).signTransaction(transaction);
  f.input.variants = [{ kind: mode === 'cancel' ? 'cancel' : 'call', raw, hash: keccak256(raw) }];
  expect(() => validatePublicationGasVariants(f.input)).toThrow();
});
test('empty or duplicated variants cannot stand in for a retained signed gas attempt', () => {
  const f = fixture();
  expect(() => validatePublicationGasVariants({ ...f.input, variants: [] })).toThrow();
  expect(() => validatePublicationGasVariants({ ...f.input, variants: [call, call] })).toThrow();
});

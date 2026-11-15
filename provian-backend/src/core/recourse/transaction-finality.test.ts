import { Wallet, keccak256 } from 'ethers';
import { finalizedOwnerTransaction } from './transaction-finality';
import type { EconomicStateRpcLeg } from '../onchain/economic-state';

const blockHash = `0x${'ab'.repeat(32)}`;
const wallet = new Wallet(`0x${'12'.repeat(32)}`); // Public deterministic test key.
let raw: string, hash: string;
beforeAll(async () => {
  raw = await wallet.signTransaction({ type: 2, chainId: 8453, nonce: 3, to: `0x${'34'.repeat(20)}`,
    data: '0x1234', gasLimit: 100000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 });
  hash = keccak256(raw);
});
function leg(operatorId: string, change: string, status = 1): EconomicStateRpcLeg {
  return { operatorId, send: async (method, params) => {
    if (method === 'eth_chainId') return change === 'chain' ? '0x1' : '0x2105';
    if (method === 'eth_getTransactionReceipt') {
      expect(params).toEqual([hash]);
      if (change === 'missing') return null;
      return { transactionHash: change === 'hash' ? blockHash : hash, blockHash,
        status: `0x${status.toString(16)}`, blockNumber: '0x64',
        from: change === 'sender' ? `0x${'56'.repeat(20)}` : wallet.address,
        to: `0x${(change === 'target' ? '56' : '34').repeat(20)}`,
        providerSpecificField: operatorId };
    }
    if (method === 'eth_blockNumber') return change === 'pending' ? '0x6e' : change === 'deep' ? '0x1000' : '0x6f';
    if (method === 'eth_getBlockByNumber') {
      return { hash: change === 'reorg' ? hash : blockHash, transactions: change === 'omitted' ? [] : [hash] };
    }
    if (method === 'eth_getTransactionCount') {
      expect(params).toEqual([wallet.address, { blockHash, requireCanonical: true }]);
      return change === 'nonce' ? '0x3' : '0x4';
    }
    throw new Error(`unexpected:${method}`);
  } };
}
test.each([0, 1])('canonical twelve-confirmation status %s proves nonce consumption without granting recovery authority', async status => {
  expect(await finalizedOwnerTransaction(raw, [leg('a', '', status), leg('b', '', status)]))
    .toEqual({ transactionHash: hash, blockHash, block: 100, status });
});
test('a receipt with eleven confirmations is not yet done; twelve or more is', async () => {
  // Block 0x64 = 100. Head 0x6e = 110 gives 11 confirmations; 0x6f = 111 gives 12.
  await expect(finalizedOwnerTransaction(raw, [leg('a', 'pending'), leg('b', 'pending')])).rejects.toThrow('not_finalized');
  await expect(finalizedOwnerTransaction(raw, [leg('a', ''), leg('b', 'pending')])).rejects.toThrow('not_finalized');
  expect((await finalizedOwnerTransaction(raw, [leg('a', 'deep'), leg('b', '')]))?.status).toBe(1);
});
test.each(['chain', 'hash', 'sender', 'target', 'reorg', 'omitted', 'nonce', 'pending'])('refuses %s', async change => {
  await expect(finalizedOwnerTransaction(raw, [leg('a', change), leg('b', change)])).rejects.toThrow();
});
test('missing receipt stays unresolved; disagreement and same-operator results cannot release a nonce', async () => {
  expect(await finalizedOwnerTransaction(raw, [leg('a', 'missing'), leg('b', 'missing')])).toBeNull();
  await expect(finalizedOwnerTransaction(raw, [leg('a', 'missing'), leg('b', '')])).rejects.toThrow('disagreement');
  await expect(finalizedOwnerTransaction(raw, [leg('a', ''), leg('a', '')])).rejects.toThrow('not_independent');
});

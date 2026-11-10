import { createRecourseChainPort, snapshotRegisteredBalance, type RecourseChainPort } from './chain-ledger';
import type { RegisteredAddress, TransferEvent } from './ownership';

const address = `0x${'11'.repeat(20)}`;
const kernel = `0x${'22'.repeat(20)}`;
const hash = `0x${'ab'.repeat(32)}`;
const nextHash = `0x${'cd'.repeat(32)}`;
const binding: RegisteredAddress = { identity: hash, address, kernel, boundBlock: 100,
  boundBlockHash: hash, openingBalanceAtomic: '100', bindingDigest: hash, recoveryGeneration: 0 };
const transfer: TransferEvent = { block: 101, blockHash: nextHash, transactionHash: hash,
  logIndex: 0, from: kernel, to: address, amountAtomic: '20' };
function port(overrides: Partial<RecourseChainPort> = {}): RecourseChainPort {
  return { finalizedBlock: async () => 102, blockHash: async block => block === 100 ? hash : nextHash,
    balance: async () => 120n, transfers: async () => [transfer], ...overrides };
}

test('snapshot reconciles prospective transfers to the exact hash-pinned token balance', async () => {
  const balance = jest.fn(async () => 120n);
  const result = await snapshotRegisteredBalance(binding, 101, port({ balance }));
  expect(result.events).toHaveLength(1);
  expect(result.balanceAtomic).toBe('120');
  expect(result.receivedAtomic).toBe('20');
  expect(result.mintedAtomic).toBe('0');
  expect(balance).toHaveBeenCalledWith(kernel, address, nextHash);
});

test('omitted events cannot silently lower the registered balance', async () => {
  await expect(snapshotRegisteredBalance(binding, 101, port({ transfers: async () => [] })))
    .rejects.toThrow('recourse_ledger_incomplete');
});

test('bind block and terminal reorgs refuse the entire snapshot', async () => {
  await expect(snapshotRegisteredBalance(binding, 101, port({ blockHash: async () => nextHash })))
    .rejects.toThrow('recourse_snapshot_reorg');
  let calls = 0;
  await expect(snapshotRegisteredBalance(binding, 101, port({ blockHash: async block => {
    if (block === 100) return hash;
    return ++calls < 3 ? nextHash : hash;
  } }))).rejects.toThrow('recourse_snapshot_reorg');
});

test('an intermediate event on a noncanonical fork refuses even when final balance agrees', async () => {
  await expect(snapshotRegisteredBalance(binding, 102, port({ transfers: async () => [{ ...transfer, blockHash: hash }] })))
    .rejects.toThrow('recourse_snapshot_reorg');
});

test('opening snapshot does not read or reconstruct pre-bind transfers', async () => {
  const transfers = jest.fn(async () => [transfer]);
  expect((await snapshotRegisteredBalance(binding, 100, port({ transfers, balance: async () => 100n }))).balanceAtomic).toBe('100');
  expect(transfers).not.toHaveBeenCalled();
  await expect(snapshotRegisteredBalance(binding, 99, port())).rejects.toThrow('recourse_snapshot_range_invalid');
});

test('matching provider replies at an unfinalized height cannot authorize restoration', async () => {
  await expect(snapshotRegisteredBalance(binding, 101, port({ finalizedBlock: async () => 100 })))
    .rejects.toThrow('recourse_snapshot_not_finalized');
});

test('balance reads require independent operators, correct chain and matching word replies', async () => {
  const makeLeg = (operatorId: string, amount: bigint, chainId = '0x2105') => ({ operatorId,
    send: jest.fn(async (method: string) => method === 'eth_chainId' ? chainId : `0x${amount.toString(16).padStart(64, '0')}`) });
  expect(() => createRecourseChainPort([makeLeg('a', 100n), makeLeg('a', 100n)]))
    .toThrow('recourse_rpc_operators_not_independent');
  await expect(createRecourseChainPort([makeLeg('a', 100n), makeLeg('b', 101n)]).balance(kernel, address, hash))
    .rejects.toThrow('recourse_balance_rpc_disagreement');
  await expect(createRecourseChainPort([makeLeg('a', 100n), makeLeg('b', 100n, '0x1')]).balance(kernel, address, hash))
    .rejects.toThrow('recourse_rpc_chain_invalid');
  const legs = [makeLeg('a', 100n), makeLeg('b', 100n)] as const;
  expect(await createRecourseChainPort(legs).balance(kernel, address, hash)).toBe(100n);
  expect(legs[0].send.mock.calls[1][0]).toBe('eth_call');
});

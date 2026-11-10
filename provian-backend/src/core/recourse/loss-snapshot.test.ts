import { snapshotReportedLoss } from './loss-snapshot';
import type { RegisteredAddress, TransferEvent } from './ownership';
import type { RecourseChainPort } from './chain-ledger';
const identity = `0x${'11'.repeat(32)}`, tx = `0x${'22'.repeat(32)}`;
const kernel = `0x${'33'.repeat(20)}`, account = `0x${'44'.repeat(20)}`, other = `0x${'55'.repeat(20)}`;
const outside = `0x${'66'.repeat(20)}`;
const hash = (block: number) => `0x${block.toString(16).padStart(64, '0')}`;
const binding = (address: string, amount: string): RegisteredAddress => ({ identity, kernel, address, boundBlock: 9,
  boundBlockHash: hash(9), openingBalanceAtomic: amount, bindingDigest: identity, recoveryGeneration: 0 });
function fixture() {
  const events: TransferEvent[] = [{ block: 10, blockHash: hash(10), transactionHash: hash(777), logIndex: 0,
    from: outside, to: account, amountAtomic: '20' },
  { block: 10, blockHash: hash(10), transactionHash: tx, logIndex: 1, from: account, to: outside, amountAtomic: '40' },
  { block: 10, blockHash: hash(10), transactionHash: tx, logIndex: 2, from: account, to: outside, amountAtomic: '80' }];
  const chain: RecourseChainPort = { finalizedBlock: async () => 10, blockHash: async block => hash(block),
    balance: async (_kernel, address, blockHash) => address === other ? 50n : blockHash === hash(9) ? 100n : 0n,
    transfers: async (_kernel, address) => events.filter(event => event.from === address || event.to === address) };
  return { events, chain, bindings: [binding(account, '100'), binding(other, '50')] };
}
test('one multi-outflow transaction uses the full portfolio immediately before its first outflow', async () => {
  const { chain, bindings } = fixture();
  const result = await snapshotReportedLoss(identity, tx, 10, bindings, chain);
  expect(result.recordedBalanceAtomic).toBe('170');
  expect(result.lossAtomic).toBe('120');
  expect(result.outflows).toHaveLength(2);
  expect(result.firstOutflowLogIndex).toBe(1);
  expect((await snapshotReportedLoss(identity, tx, 10, [...bindings].reverse(), chain)).evidenceHash).toBe(result.evidenceHash);
});
test('missing logs, foreign identities and unfinalized blocks cannot become payment evidence', async () => {
  const { chain, bindings } = fixture();
  await expect(snapshotReportedLoss(identity, tx, 10, bindings, { ...chain, transfers: async () => [] })).rejects.toThrow('ledger_incomplete');
  await expect(snapshotReportedLoss(hash(88), tx, 10, bindings, chain)).rejects.toThrow('binding_invalid');
  await expect(snapshotReportedLoss(identity, tx, 10, bindings, { ...chain, finalizedBlock: async () => 9 })).rejects.toThrow('not_finalized');
});
test('an internal move does not anchor before incoming funds that precede the actual loss', async () => {
  const { chain, bindings } = fixture();
  const events: TransferEvent[] = [
    { block: 10, blockHash: hash(10), transactionHash: tx, logIndex: 0, from: account, to: other, amountAtomic: '10' },
    { block: 10, blockHash: hash(10), transactionHash: tx, logIndex: 1, from: outside, to: account, amountAtomic: '20' },
    { block: 10, blockHash: hash(10), transactionHash: tx, logIndex: 2, from: account, to: outside, amountAtomic: '110' },
  ];
  const result = await snapshotReportedLoss(identity, tx, 10, bindings, { ...chain,
    transfers: async (_kernel, address) => events.filter(event => event.from === address || event.to === address),
    balance: async (_kernel, address, blockHash) => blockHash === hash(9) ? address === account ? 100n : 50n : address === account ? 0n : 60n,
  });
  expect(result.firstOutflowLogIndex).toBe(2);
  expect(result.lossAtomic).toBe('110');
  expect(result.recordedBalanceAtomic).toBe('170');
  expect(result.outflows).toHaveLength(2);
});
test('returns in the loss transaction offset the loss without including untouched holdings', async () => {
  const { chain, bindings, events } = fixture();
  events.push({ block: 10, blockHash: hash(10), transactionHash: tx, logIndex: 3,
    from: outside, to: account, amountAtomic: '30' });
  const result = await snapshotReportedLoss(identity, tx, 10, bindings, { ...chain,
    balance: async (_kernel, address, blockHash) => address === other ? 50n : blockHash === hash(9) ? 100n : 30n });
  expect(result.lossAtomic).toBe('90');
  expect(result.recordedBalanceAtomic).toBe('170');
});
test('an unrelated transaction or a self portfolio transfer is not a loss', async () => {
  const { chain, bindings } = fixture();
  await expect(snapshotReportedLoss(identity, hash(88), 10, bindings, chain)).rejects.toThrow('outflow_missing');
  const self = { ...chain, transfers: async () => [], balance: async () => 100n };
  await expect(snapshotReportedLoss(identity, tx, 10, [bindings[0]], self)).rejects.toThrow('outflow_missing');
});

test('a loss later in the binding block is included, while an earlier outflow is refused', async () => {
  const { chain, bindings } = fixture();
  const sameBlock = { ...bindings[0], boundBlock: 10, boundBlockHash: hash(10), openingBalanceAtomic: '0', boundLogIndex: 0 };
  const result = await snapshotReportedLoss(identity, tx, 10, [sameBlock], chain);
  expect(result.lossAtomic).toBe('120');
  await expect(snapshotReportedLoss(identity, tx, 10, [{ ...sameBlock, boundLogIndex: 2 }], chain)).rejects.toThrow('outflow_missing');
});

test('an address bound after the first loss cannot inflate the earlier portfolio', async () => {
  const { chain, bindings } = fixture();
  bindings[1] = { ...bindings[1], boundBlock: 10, boundBlockHash: hash(10), boundLogIndex: 3 };
  const result = await snapshotReportedLoss(identity, tx, 10, bindings, chain);
  expect(result.recordedBalanceAtomic).toBe('120');
  expect(result.lossAtomic).toBe('120');
  expect(result.addresses.map(row => row.address)).toEqual([account]);
});

test('binding the recipient after a transfer does not retroactively make that transfer internal', async () => {
  const { chain, bindings } = fixture();
  bindings[1] = { ...bindings[1], boundBlock: 10, boundBlockHash: hash(10), boundLogIndex: 2 };
  const event: TransferEvent = { block: 10, blockHash: hash(10), transactionHash: tx,
    logIndex: 1, from: account, to: other, amountAtomic: '40' };
  const result = await snapshotReportedLoss(identity, tx, 10, bindings, { ...chain,
    transfers: async (_kernel, address) => address === account || address === other ? [event] : [],
    balance: async (_kernel, address, blockHash) => address === account ? blockHash === hash(9) ? 100n : 60n
      : blockHash === hash(9) ? 50n : 90n });
  expect(result.lossAtomic).toBe('40');
  expect(result.recordedBalanceAtomic).toBe('100');
  expect(result.addresses).toHaveLength(1);
});

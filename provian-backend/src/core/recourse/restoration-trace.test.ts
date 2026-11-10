import { traceRestoration, type TraceCheckpoint, type TracedTransfer } from './restoration-trace';
import type { LossSnapshot } from './loss-snapshot';
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const owner = address(1), thief = address(2), gift = address(3), buyer = address(4), clean = address(5);
function transfer(index: number, from: string, to: string, quantity: number, exchange = false): TracedTransfer {
  return { block: 100 + index, blockHash: hash(100 + index), transactionHash: hash(1000 + index),
    logIndex: 0, from, to, amountAtomic: String(quantity), receipt: exchange ? 'witnessed_exchange' : 'gratuitous', witnessHash: hash(9000 + index) };
}
function fixture(events: TracedTransfer[], closing: Array<[string, number]>, loss = 100): { snapshot: LossSnapshot; checkpoint: TraceCheckpoint } {
  const first = events[0];
  return { snapshot: { identity: hash(1), kernel: address(99), block: first.block, blockHash: first.blockHash,
    transactionHash: first.transactionHash, firstOutflowLogIndex: 0, recordedBalanceAtomic: '100', lossAtomic: String(loss),
    addresses: [{ address: owner, balanceAtomic: '100', bindingDigest: hash(2) }], outflows: [first], occurrence: hash(3), evidenceHash: hash(4) },
  checkpoint: { block: events[events.length - 1].block, blockHash: events[events.length - 1].blockHash, transfers: events, ownerAliases: [],
    accounts: closing.map(([account, quantity]) => ({ address: account, openingAtomic: account === owner ? '100' : '0',
      closingAtomic: String(quantity), outgoingSequence: '7' })) } };
}
test('follows gratuitous receipts, preserves a witnessed buyer and never replenishes a spent trail', () => {
  const { snapshot, checkpoint } = fixture([transfer(0, owner, thief, 100), transfer(1, thief, gift, 30),
    transfer(2, thief, buyer, 50, true), transfer(3, clean, thief, 200)], [[owner, 0], [thief, 220], [gift, 30], [buyer, 50]]);
  const result = traceRestoration(snapshot, checkpoint);
  expect(result.sources).toEqual([{ address: thief, amountAtomic: '20', outgoingSequence: '7' }, { address: gift, amountAtomic: '30', outgoingSequence: '7' }]);
  expect(result.shortfallAtomic).toBe('50'); expect(result.witnessedExchangeAtomic).toBe('50');
});
test('a later return reduces the loss and a burn cannot be reversed into new supply', () => {
  const { snapshot, checkpoint } = fixture([transfer(0, owner, thief, 100), transfer(1, thief, owner, 25),
    transfer(2, thief, address(0), 10)], [[owner, 25], [thief, 65]]);
  const result = traceRestoration(snapshot, checkpoint);
  expect(result.returnedAtomic).toBe('25'); expect(result.reversibleAtomic).toBe('65');
  expect(result.shortfallAtomic).toBe('10'); expect(result.destroyedAtomic).toBe('10');
});
test('custody obligations protect accounted balances while gratuitous surplus remains reversible', () => {
  const f = fixture([transfer(0, owner, thief, 100), transfer(1, thief, gift, 100)], [[owner, 0], [thief, 0], [gift, 100]]);
  const withObligation = (value: string): TraceCheckpoint => ({ ...f.checkpoint,
    accounts: f.checkpoint.accounts.map(row => row.address === gift ? { ...row, encumberedAtomic: value } : row) });
  expect(traceRestoration(f.snapshot, withObligation('80'))).toMatchObject({
    sources: [{ address: gift, amountAtomic: '20', outgoingSequence: '7' }], reversibleAtomic: '20', shortfallAtomic: '80' });
  expect(traceRestoration(f.snapshot, withObligation('0')).reversibleAtomic).toBe('100');
  expect(traceRestoration(f.snapshot, withObligation('100'))).toMatchObject({ sources: [], shortfallAtomic: '100' });
  expect(traceRestoration(f.snapshot, withObligation('101'))).toMatchObject({ sources: [], shortfallAtomic: '100' });
  expect(() => traceRestoration(f.snapshot, withObligation('-1'))).toThrow('amount_invalid');
  expect(traceRestoration(f.snapshot, withObligation('81')).evidenceHash).not.toBe(traceRestoration(f.snapshot, withObligation('80')).evidenceHash);
});
test('missing logs, duplicate logs, inconsistent blocks, absent recipient histories and unresolved exchanges cannot authorize sources', () => {
  const f = fixture([transfer(0, owner, thief, 100)], [[owner, 0], [thief, 100]]);
  expect(() => traceRestoration(f.snapshot, { ...f.checkpoint, transfers: [] })).toThrow('loss_missing');
  expect(() => traceRestoration(f.snapshot, { ...f.checkpoint, transfers: [...f.checkpoint.transfers, ...f.checkpoint.transfers] })).toThrow('event_invalid');
  expect(() => traceRestoration(f.snapshot, { ...f.checkpoint, blockHash: hash(999) })).toThrow('reorg');
  expect(() => traceRestoration(f.snapshot, { ...f.checkpoint, accounts: [] })).toThrow('recipient_history_missing');
  expect(traceRestoration(f.snapshot, { ...f.checkpoint, transfers: [{ ...f.checkpoint.transfers[0], receipt: 'unresolved' }] })).toMatchObject({sources:[],reversibleAtomic:'0',shortfallAtomic:'100'});
  expect(() => traceRestoration(f.snapshot, { ...f.checkpoint, accounts: f.checkpoint.accounts.map(row => ({ ...row, closingAtomic: '0' })) })).toThrow('history_incomplete');
});
test('mixing and repeated gratuitous transfers conserve the exact loss through cycles', () => {
  const f = fixture([transfer(0, owner, thief, 100), transfer(1, thief, gift, 60), transfer(2, gift, thief, 20),
    transfer(3, thief, thief, 10)], [[owner, 0], [thief, 60], [gift, 40]]);
  const result = traceRestoration(f.snapshot, f.checkpoint);
  expect(result.reversibleAtomic).toBe('100'); expect(result.shortfallAtomic).toBe('0');
  expect(traceRestoration(f.snapshot, { ...f.checkpoint, transfers: [...f.checkpoint.transfers].reverse(), accounts: [...f.checkpoint.accounts].reverse() }).evidenceHash).toBe(result.evidenceHash);
});
test('refund reductions allocate exact atomic amounts without rounding above any source balance', () => {
  for (let loss = 1; loss <= 100; loss++) {
    const f = fixture([transfer(0, owner, thief, 100), transfer(1, thief, gift, 49), transfer(2, thief, buyer, 1)],
      [[owner, 0], [thief, 50], [gift, 49], [buyer, 1]], loss);
    const result = traceRestoration(f.snapshot, f.checkpoint);
    const available = new Map(f.checkpoint.accounts.map(row => [row.address, BigInt(row.closingAtomic)]));
    expect(result.sources.reduce((sum, row) => sum + BigInt(row.amountAtomic), 0n)).toBe(BigInt(loss));
    for (const row of result.sources) expect(BigInt(row.amountAtomic) <= available.get(row.address)!).toBe(true);
    expect(result.shortfallAtomic).toBe('0');
  }
});

test('a return to a recovered destination or a newly bound same-owner address cannot be restored again', () => {
  for (const destination of [address(8), address(9)]) {
    const f = fixture([transfer(0, owner, thief, 100), transfer(1, thief, destination, 100)], [[owner, 0], [thief, 0]]);
    const result = traceRestoration(f.snapshot, { ...f.checkpoint, ownerAliases: [{ address: destination, evidenceHash: hash(900) }] });
    expect(result.returnedAtomic).toBe('100'); expect(result.reversibleAtomic).toBe('0');
    expect(result.shortfallAtomic).toBe('0'); expect(result.sources).toEqual([]);
  }
});

test('a same-transaction return to a later-bound owner alias is not a pool shortfall', () => {
  const destination = address(8);
  const first = transfer(0, owner, thief, 100);
  const refund = { ...transfer(1, thief, destination, 100), block: first.block,
    blockHash: first.blockHash, transactionHash: first.transactionHash, logIndex: 1 };
  const f = fixture([first, refund], [[owner, 0], [thief, 0]]);
  const result = traceRestoration(f.snapshot, { ...f.checkpoint, ownerAliases: [{ address: destination, evidenceHash: hash(900) }] });
  expect(result.returnedAtomic).toBe('100');
  expect(result.reversibleAtomic).toBe('0');
  expect(result.shortfallAtomic).toBe('0');
});

test.each(['unresolved','witnessed_exchange'] as const)('a later return from a %s trail reduces the remainder without exposing that recipient', receipt => {
  const first={...transfer(0,owner,thief,100),receipt};
  const f=fixture([first,transfer(1,thief,gift,60),transfer(2,gift,owner,25)],[[owner,25],[thief,40],[gift,35]]);
  expect(traceRestoration(f.snapshot,f.checkpoint)).toMatchObject({sources:[],reversibleAtomic:'0',returnedAtomic:'25',shortfallAtomic:'75'});
});

test.each(['gratuitous','witnessed_exchange'] as const)('a new witnessed purchase from the victim does not erase the loss of a %s trail', receipt => {
  const first={...transfer(0,owner,thief,100),receipt};
  const purchase=transfer(1,thief,owner,100,true);
  const f=fixture([first,purchase],[[owner,100],[thief,0]]);
  expect(traceRestoration(f.snapshot,f.checkpoint)).toMatchObject({sources:[],returnedAtomic:'0',shortfallAtomic:'100'});
});

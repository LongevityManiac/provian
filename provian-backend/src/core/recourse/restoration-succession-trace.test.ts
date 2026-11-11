import { traceRestorationSuccession as trace, type SuccessionTraceCheckpoint, type SuccessionTraceEvent } from './restoration-succession-trace';
import type { RestorationBalanceRef, RestorationBalanceBridge } from './restoration-bridge-ledger';
import type { LossSnapshot } from './loss-snapshot';
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`, h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const account = (kernel: number, address: number): RestorationBalanceRef => ({ kind: 'account', kernel: a(kernel), address: a(address) });
const entitlement = (origin: number): RestorationBalanceRef => ({ kind: 'entitlement', origin: a(origin), identity: h(2) });
function transfer(kernel: number, block: number, from: number, to: number, amount: number, receipt: 'gratuitous' | 'witnessed_exchange' | 'unresolved' = 'gratuitous'): SuccessionTraceEvent {
  return { kind: 'transfer', kernel: a(kernel), transfer: { block, blockHash: h(block), transactionHash: h(1000 + block), logIndex: 0,
    from: a(from), to: a(to), amountAtomic: String(amount), receipt, witnessHash: h(2000 + block) } };
}
function bridge(block: number, body: RestorationBalanceBridge): SuccessionTraceEvent {
  return { kind: 'bridge', block, blockHash: h(block), logIndex: body.kind === 'snapshot' ? null : 1, bridge: body, evidenceHash: h(3000 + block) };
}
function row(ref: RestorationBalanceRef, opening: number | undefined, closing: number): SuccessionTraceCheckpoint['balances'][number] {
  return { ref, ...(opening === undefined ? {} : { openingAtomic: String(opening) }), closingAtomic: String(closing),
    ...(ref.kind === 'account' ? { outgoingSequence: '7' } : {}) };
}
function fixture(): { snapshot: LossSnapshot; checkpoint: SuccessionTraceCheckpoint } {
  const loss = transfer(10, 100, 1, 2, 100); if (loss.kind !== 'transfer') throw Error('fixture');
  const snapshot: LossSnapshot = { identity: h(1), kernel: a(10), block: 100, blockHash: h(100), transactionHash: h(1100),
    firstOutflowLogIndex: 0, recordedBalanceAtomic: '100', lossAtomic: '100', addresses: [{ address: a(1), balanceAtomic: '100', bindingDigest: h(5) }],
    outflows: [loss.transfer], occurrence: h(6), evidenceHash: h(7) };
  const checkpoint: SuccessionTraceCheckpoint = { executionKernel: a(12), block: 140, blockHash: h(140), owners: [],
    generations: [{ kernel: a(10), from: 100, through: 110 }, { kernel: a(11), from: 111, through: 120 }, { kernel: a(12), from: 121, through: 140 }],
    events: [loss,
      bridge(110, { kind: 'snapshot', kernel: a(10), origin: a(20), sources: [{ ref: account(10, 2), amount: 100n }], destination: entitlement(20) }),
      transfer(11, 114, 0, 2, 20),
      bridge(120, { kind: 'snapshot', kernel: a(11), origin: a(21), sources: [{ ref: account(11, 2), amount: 20n }, { ref: entitlement(20), amount: 100n }], destination: entitlement(21) }),
      bridge(130, { kind: 'restoration', kernel: a(12), origin: a(21), sources: [{ ref: entitlement(21), amount: 120n }], destination: account(12, 9) }),
      transfer(12, 135, 0, 9, 7), transfer(12, 140, 9, 8, 60)],
    balances: [row(account(10, 1), 100, 0), row(account(10, 2), 0, 0), row(account(11, 2), 0, 0), row(entitlement(20), undefined, 0),
      row(entitlement(21), undefined, 0), row(account(12, 9), 0, 67), row(account(12, 8), 0, 60)] };
  return { snapshot, checkpoint };
}
test('two unclaimed breaks and later restoration conserve the theft separately from fresh issuance', () => {
  const { snapshot, checkpoint } = fixture();
  expect(trace(snapshot, checkpoint)).toMatchObject({ sources: [{ address: a(8), amountAtomic: '60', outgoingSequence: '7' },
    { address: a(9), amountAtomic: '40', outgoingSequence: '7' }], reversibleAtomic: '100', shortfallAtomic: '0' });
});
test('unissued entitlements are unreachable even when old and new kernels reuse an address', () => {
  const { snapshot, checkpoint } = fixture();
  const pending: SuccessionTraceCheckpoint = { ...checkpoint, block: 125, blockHash: h(125),
    generations: checkpoint.generations.map(g => g.kernel === a(12) ? { ...g, through: 125 } : g),
    events: checkpoint.events.slice(0, 4), balances: checkpoint.balances.map(value => value.ref.kind === 'entitlement' && value.ref.origin === a(21)
      ? { ...value, closingAtomic: '120' } : value.ref.kind === 'account' && value.ref.kernel === a(12) ? { ...value, closingAtomic: '0' } : value) };
  expect(trace(snapshot, pending)).toMatchObject({ sources: [], reversibleAtomic: '0', shortfallAtomic: '100' });
});
test('witnessed and unresolved exchange protection survives every carry and cannot become a reversal source', () => {
  for (const receipt of ['witnessed_exchange', 'unresolved'] as const) {
    const { snapshot, checkpoint } = fixture();
    const events = checkpoint.events.map((event, index) => index === 0 && event.kind === 'transfer' ? { ...event, transfer: { ...event.transfer, receipt } } : event);
    expect(trace(snapshot, { ...checkpoint, events })).toMatchObject({ sources: [], shortfallAtomic: '100', witnessedExchangeAtomic: receipt === 'witnessed_exchange' ? '100' : '0' });
  }
});
test('return by authenticated restoration to the owner offsets the loss once, including protected provenance', () => {
  const { snapshot, checkpoint } = fixture();
  const owners = [{ ref: account(12, 9), evidenceHash: h(66) }];
  expect(trace(snapshot, { ...checkpoint, owners })).toMatchObject({ sources: [], returnedAtomic: '100', shortfallAtomic: '0' });
});
test('custody obligations cap only current reachable balances without turning retired balances into sources', () => {
  const { snapshot, checkpoint } = fixture();
  const balances = checkpoint.balances.map(value => value.ref.kind === 'account' && value.ref.kernel === a(12) && value.ref.address === a(9)
    ? { ...value, encumberedAtomic: '60' } : value);
  expect(trace(snapshot, { ...checkpoint, balances })).toMatchObject({ reversibleAtomic: '67', shortfallAtomic: '33' });
});
test('a nonregistered retired holding remains accounted and cannot be reversed on the new kernel', () => {
  const { snapshot } = fixture(), retired: RestorationBalanceRef = { kind: 'retired', kernel: a(10), address: a(2) };
  const checkpoint: SuccessionTraceCheckpoint = { executionKernel: a(11), block: 120, blockHash: h(120), owners: [],
    generations: [{ kernel: a(10), from: 100, through: 110 }, { kernel: a(11), from: 111, through: 120 }],
    events: [transfer(10, 100, 1, 2, 100), bridge(110, { kind: 'snapshot', kernel: a(10), origin: a(20), sources: [{ ref: account(10, 2), amount: 100n }], destination: retired })],
    balances: [row(account(10, 1), 100, 0), row(account(10, 2), 0, 0), row(retired, undefined, 100)] };
  expect(trace(snapshot, checkpoint)).toMatchObject({ sources: [], shortfallAtomic: '100' });
});
test('ordinary balance import preserves provenance without pretending the import was a work mint or transfer', () => {
  const { snapshot } = fixture();
  const checkpoint: SuccessionTraceCheckpoint = { executionKernel: a(11), block: 120, blockHash: h(120), owners: [],
    generations: [{ kernel: a(10), from: 100, through: 110 }, { kernel: a(11), from: 111, through: 120 }],
    events: [transfer(10, 100, 1, 2, 100), bridge(115, { kind: 'succession', kernel: a(10), origin: a(20), sources: [{ ref: account(10, 2), amount: 100n }], destination: account(11, 2) })],
    balances: [row(account(10, 1), 100, 0), row(account(10, 2), 0, 0), row(account(11, 2), 0, 100)] };
  expect(trace(snapshot, checkpoint)).toMatchObject({ sources: [{ address: a(2), amountAtomic: '100', outgoingSequence: '7' }], shortfallAtomic: '0' });
});
test.each(['double-mint', 'discarded-tail', 'reused-entitlement', 'wrong-closing', 'missing-loss', 'missing-sequence', 'missing-recipient'])('%s refuses instead of inflating a reversal or pool shortfall', mode => {
  const { snapshot, checkpoint } = fixture(); let changed = checkpoint;
  if (mode === 'double-mint') changed = { ...checkpoint, events: [...checkpoint.events, transfer(12, 130, 0, 9, 120)] };
  if (mode === 'discarded-tail') changed = { ...checkpoint, events: [...checkpoint.events, transfer(10, 115, 2, 1, 1)] };
  if (mode === 'reused-entitlement') { const event = checkpoint.events[4]; if (event.kind !== 'bridge') throw Error('fixture'); changed = { ...checkpoint, events: [...checkpoint.events, { ...event, block: 131, blockHash: h(131) }] }; }
  if (mode === 'wrong-closing') changed = { ...checkpoint, balances: checkpoint.balances.map(row => ({ ...row, closingAtomic: '0' })) };
  if (mode === 'missing-loss') changed = { ...checkpoint, events: checkpoint.events.slice(1) };
  if (mode === 'missing-sequence') changed = { ...checkpoint, balances: checkpoint.balances.map(({ outgoingSequence: _sequence, ...row }) => row) };
  if (mode === 'missing-recipient') changed = { ...checkpoint, balances: checkpoint.balances.slice(0, -1) };
  expect(() => trace(snapshot, changed)).toThrow();
});

test('unreached clean incoming funds reconcile the recipient but never replenish its spent theft trail', () => {
  const { snapshot, checkpoint } = fixture();
  const events = [...checkpoint.events, transfer(12, 136, 7, 9, 20)];
  const balances = checkpoint.balances.map(value => value.ref.kind === 'account' && value.ref.kernel === a(12) && value.ref.address === a(9)
    ? { ...value, closingAtomic: '87' } : value);
  expect(trace(snapshot, { ...checkpoint, events, balances }).reversibleAtomic).toBe('100');
  expect(trace(snapshot, { ...checkpoint, events: [...events].reverse(), balances: [...balances].reverse() }).evidenceHash)
    .toBe(trace(snapshot, { ...checkpoint, events, balances }).evidenceHash);
});
test('historical real balances cannot become current sources even without a restoration', () => {
  const { snapshot } = fixture();
  const checkpoint: SuccessionTraceCheckpoint = { executionKernel: a(11), block: 120, blockHash: h(120), owners: [],
    generations: [{ kernel: a(10), from: 100, through: 110 }, { kernel: a(11), from: 111, through: 120 }], events: [transfer(10, 100, 1, 2, 100)],
    balances: [row(account(10, 1), 100, 0), row(account(10, 2), 0, 100), row(account(11, 2), 0, 0)] };
  expect(trace(snapshot, checkpoint)).toMatchObject({ sources: [], shortfallAtomic: '100' });
});
test('a reconciled ledger cannot silently substitute an absent original loss event', () => {
  const { snapshot, checkpoint } = fixture();
  expect(() => trace({ ...snapshot, outflows: snapshot.outflows.map(outflow => ({ ...outflow, logIndex: 5 })) }, checkpoint)).toThrow('loss_missing');
});
test('refund-net loss limits allocate only the exact outstanding amount across current sources', () => {
  const { snapshot, checkpoint } = fixture();
  const result = trace({ ...snapshot, lossAtomic: '60' }, checkpoint);
  expect(result.sources).toEqual([{ address: a(8), amountAtomic: '36', outgoingSequence: '7' }, { address: a(9), amountAtomic: '24', outgoingSequence: '7' }]);
});
test('new work after spending the entire recovered trail cannot taint an unrelated later recipient', () => {
  const { snapshot, checkpoint } = fixture();
  const later: SuccessionTraceCheckpoint = { ...checkpoint, block: 145, blockHash: h(145),
    generations: checkpoint.generations.map(g => g.kernel === a(12) ? { ...g, through: 145 } : g),
    events: [...checkpoint.events, transfer(12, 141, 9, 8, 40), transfer(12, 142, 0, 9, 100), transfer(12, 143, 9, 7, 100)],
    balances: [...checkpoint.balances.map(value => value.ref.kind === 'account' && value.ref.kernel === a(12)
      ? { ...value, closingAtomic: value.ref.address === a(9) ? '27' : '100' } : value), row(account(12, 7), 0, 100)] };
  expect(trace(snapshot, later).sources).toEqual([{ address: a(8), amountAtomic: '100', outgoingSequence: '7' }]);
});

test('observation of the current generation cannot invent a future break and turn reachable PVT into a pool shortfall', () => {
  const { snapshot, checkpoint } = fixture();
  const invented = bridge(140, { kind: 'snapshot', kernel: a(12), origin: a(99), sources: [{ ref: account(12, 8), amount: 60n }], destination: entitlement(99) });
  const balances = [...checkpoint.balances.map(value => value.ref.kind === 'account' && value.ref.kernel === a(12) && value.ref.address === a(8)
    ? { ...value, closingAtomic: '0' } : value), row(entitlement(99), undefined, 60)];
  expect(() => trace(snapshot, { ...checkpoint, balances, events: [...checkpoint.events, invented] })).toThrow('bridge_invalid');
});
